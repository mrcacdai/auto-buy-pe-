'use strict';

/**
 * ============================================================
 *  minecraft.js — Quản lý kết nối Minecraft Bedrock (MCPE) 24/7
 * ============================================================
 *  Nhiệm vụ:
 *   - Duy trì phiên đăng nhập liên tục vào server Bedrock (tự kết nối lại
 *     khi mất kết nối / bị kick, dùng backoff ngày càng dài để không spam).
 *   - Tự dò phiên bản server qua RakNet ping (bedrock-protocol sẽ tự khớp
 *     protocol tương ứng khi ta KHÔNG truyền `version`).
 *   - Đăng nhập OFFLINE (tên người chơi) hoặc ONLINE (tài khoản Microsoft
 *     bằng luồng device-code, token được cache trong data/profiles).
 *   - Gửi lệnh trong game (`/pay`, `/balance`, ...) qua packet `command_request`,
 *     thu kết quả qua `command_output` + `text`.
 *   - Ghi nhận chunk thế giới (level_chunk) + vị trí spawn để chế độ
 *     render 3D vẽ lại khung cảnh quanh bot.
 *
 *  Lưu ý quan trọng về packet `command_request` (theo docs bedrock-protocol):
 *   - Từ 1.21.130 trở lên: `origin.player_entity_id` (li64) là BẮT BUỘC và
 *     `version` là CHUỖI (dùng 'latest').
 *   - Trên 1.26.x: `version` phải là chuỗi 'latest'; giá trị dạng số sẽ bị từ chối.
 *   - Dưới 1.21.130: origin KHÔNG chứa player_entity_id, version là varint
 *     (để trống như các ví dụ chính thức trước đây của thư viện).
 *   - Sai 1 trong 2 trường -> server trả packet_violation_warning rồi ngắt kết nối.
 */

const EventEmitter = require('events');
const { randomUUID } = require('crypto');
const bedrock = require('bedrock-protocol');
const { decodeLevelChunk } = require('./bedrockWorld');

const log = (...args) => console.log(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [MC]`, ...args);
const warn = (...args) => console.warn(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [MC]`, ...args);
/** In 1 dòng chat của server ra console (cmd) */
const chatLog = (...args) => console.log(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [CHAT]`, ...args);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bỏ mã màu §x của Minecraft khỏi chuỗi chat */
function stripMcCodes(text) {
  return String(text ?? '').replace(/§./g, '');
}

/**
 * Ghép 1 packet `text` của Bedrock thành 1 dòng chat dễ đọc.
 * type: raw | chat | json | tip | system | whisper | announcement | translation...
 */
function textPacketToLine(packet) {
  const type = packet?.type ?? 'raw';
  const source = packet?.source_name ? String(packet.source_name) : '';
  let message = String(packet?.message ?? '');

  // Packet dạng bản dịch: thay lần lượt %s / %1$s bằng tham số đi kèm
  if ((type === 'translation' || packet?.needs_translation) && Array.isArray(packet?.parameters)) {
    let i = 0;
    message = message.replace(/%(\d+\$)?s/g, () => {
      const value = packet.parameters[i++];
      return value === undefined ? '' : String(value);
    });
  }

  if (type === 'chat' && source) return `<${stripMcCodes(source)}> ${stripMcCodes(message)}`;
  if (type === 'whisper' && source) return `[PM] <${stripMcCodes(source)}> ${stripMcCodes(message)}`;
  return stripMcCodes(message);
}

/**
 * So sánh phiên bản kiểu "1.26.60" -> [1, 26, 60].
 * Trả về mảng số hoặc null nếu không đọc được.
 */
function parseVersion(version) {
  if (!version || typeof version !== 'string') return null;
  const m = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

/**
 * Có phải định dạng `command_request` mới (từ 1.21.130 trở lên) hay không?
 * Không biết phiên bản -> coi như mới (mặc định an toàn cho server 2026+).
 */
function usesNewCommandFormat(version) {
  const v = parseVersion(version);
  if (!v) return true;
  const [major, minor, micro] = v;
  if (major !== 1) return true;
  return minor > 21 || (minor === 21 && micro >= 130);
}

/** Chuyển entity id bất kỳ về BigInt an toàn cho field li64 */
function toBigId(value) {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === 'string' && value.trim() !== '') return BigInt(value.trim());
  } catch {
    /* bỏ qua */
  }
  return 0n;
}

class BedrockManager extends EventEmitter {
  /** @param {object} config Cấu hình toàn cục (src/config.js) */
  constructor(config) {
    super();
    this.config = config;
    this.client = null;
    this.state = 'idle'; // idle | connecting | online
    this.attempt = 0; // số lần thử kết nối lại liên tiếp (đặt lại = 0 khi spawn thành công)
    this.stopping = false; // cờ dừng có chủ đích (khi đổi server / tắt bot)
    this.reconnectTimer = null;
    this.watchdogTimer = null;

    this.target = { host: config.server.host, port: config.server.port };
    this.detected = { version: null, protocol: null, motd: null, playersOnline: null, playersMax: null };

    this.chatLog = []; // nhật ký chat gần nhất (cho debug)
    this.chunks = []; // cache chunk thô (ring buffer) cho render 3D
    this.chunkLimit = 160;
    this.spawnPosition = null; // { x, y, z } từ packet start_game
    this.lastScreenshotInfo = null;

    this._jobChain = Promise.resolve(); // hàng đợi tuần tự cho các lệnh /pay
    this._decodedCache = new WeakMap(); // cache kết quả giải mã từng subchunk (theo Buffer)
  }

  /* ------------------------------------------------------------------ */
  /*  Thông tin trạng thái — dùng cho embed Discord                      */
  /* ------------------------------------------------------------------ */

  get serverLabel() {
    return `${this.target.host}:${this.target.port}`;
  }

  stateInfo() {
    return {
      state: this.state,
      server: this.serverLabel,
      version: this.detected.version || this.config.mcVersion || 'tự động',
      username: this.config.username,
      authMode: this.config.authMode,
      chatLines: this.chatLog.length,
      chunks: this.chunks.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Ping server (dò phiên bản / kiểm tra trước khi đổi server)         */
  /* ------------------------------------------------------------------ */

  /** Trả về { version, protocol, motd, playersOnline, playersMax } hoặc null nếu không ping được */
  async probe(host = this.target.host, port = this.target.port, timeout = 5000) {
    try {
      const res = await bedrock.ping({ host, port, timeout });
      const info = {
        version: res?.version ?? null,
        protocol: res?.protocol ?? null,
        motd: res?.motd ?? null,
        playersOnline: res?.playersOnline ?? null,
        playersMax: res?.playersMax ?? null,
        raw: res?.raw ?? null,
      };
      // Một số phiên bản trả dữ liệu thô dạng chuỗi "MCPE;motd;protocol;version;..."
      if (!info.version && typeof res?.raw === 'string') {
        const f = res.raw.split(';');
        if (f.length >= 6) {
          info.motd = info.motd || f[1];
          info.protocol = info.protocol || f[2];
          info.version = f[3] || info.version;
          info.playersOnline = info.playersOnline ?? (Number(f[4]) || null);
          info.playersMax = info.playersMax ?? (Number(f[5]) || null);
        }
      }
      return info;
    } catch (err) {
      warn(`Ping ${host}:${port} thất bại: ${err.message}`);
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Vòng đời kết nối 24/7                                              */
  /* ------------------------------------------------------------------ */

  /** Bắt đầu kết nối (không chờ spawn). Lỗi sẽ tự thử lại với backoff. */
  start() {
    this.stopping = false;
    return this.connect();
  }

  async connect() {
    if (this.stopping) return;
    if (this.state === 'connecting' || this.state === 'online') return;

    this.state = 'connecting';
    const { host, port } = this.target;
    log(`Đang kết nối tới ${host}:${port} (auth: ${this.config.authMode})...`);

    // Ping trước để log phiên bản server (không bắt buộc — bedrock-protocol
    // tự ping lần nữa khi tạo client nếu ta không truyền `version`)
    const pong = await this.probe(host, port);
    if (pong) {
      this.detected = { ...this.detected, ...pong };
      log(`Server phản hồi: Minecraft Bedrock ${pong.version ?? '?'} (protocol ${pong.protocol ?? '?'})` +
        (pong.playersOnline != null ? ` — ${pong.playersOnline}/${pong.playersMax ?? '?'} người chơi` : ''));
    } else {
      warn('Không ping được server trước khi kết nối — vẫn thử đăng nhập...');
    }

    const options = {
      host,
      port,
      username: this.config.username,
      // offline: true -> bỏ qua xác minh Xbox Live (server phải cho phép)
      offline: this.config.authMode !== 'online',
      profilesFolder: this.config.profilesFolder, // cache token Microsoft
      conLog: null, // tắt log nhị phân mặc định của thư viện
      onMsaCode: (data) => this._onMsaCode(data), // đăng nhập Microsoft bằng device code
    };
    if (this.config.mcVersion) options.version = this.config.mcVersion; // ghim phiên bản nếu người dùng muốn
    if (this.config.raknetBackend) options.raknetBackend = this.config.raknetBackend;

    let client;
    try {
      client = bedrock.createClient(options);
    } catch (err) {
      this.state = 'idle';
      this.emit('connect_failed', `Không tạo được kết nối: ${err.message}`);
      return this._scheduleReconnect(err);
    }

    this.client = client;
    this._wireClient(client);

    // Watchdog: nếu 2 phút vẫn chưa spawn thì chủ động cắt và thử lại
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.state !== 'online' && !this.stopping) {
        warn('Quá 2 phút chưa spawn — cắt kết nối và thử lại.');
        try {
          client.close();
        } catch {
          /* bỏ qua */
        }
      }
    }, 120000);
  }

  /** Gắn các event handler cần thiết cho 1 client */
  _wireClient(client) {
    client.on('error', (err) => {
      // Lỗi có thể phục hồi — chỉ log, không thoát tiến trình
      warn(`Lỗi kết nối: ${err?.message ?? err}`);
      this.emit('mc_error', err?.message ?? String(err));
    });

    client.on('join', () => {
      log(`Đã đăng nhập & mã hoá xong — đang chờ thế giới tải (spawn)...`);
    });

    client.on('spawn', () => {
      this.state = 'online';
      this.attempt = 0;
      clearTimeout(this.watchdogTimer);
      log(`✅ Bot "${this.config.username}" đã spawn vào ${this.serverLabel}`);
      this.emit('spawn');
    });

    client.on('start_game', (packet) => {
      const pos = packet?.player_position;
      if (pos && Number.isFinite(pos.x)) {
        this.spawnPosition = { x: pos.x, y: pos.y, z: pos.z };
      }
      if (!this.detected.version && client.version) this.detected.version = client.version;
    });

    client.on('text', (packet) => {
      const line = textPacketToLine(packet);
      if (!line) return;
      this.chatLog.push(line);
      if (this.chatLog.length > 120) this.chatLog.shift();
      // Hiển thị MỌI chat/tin nhắn hệ thống của server ra console (CHAT_CONSOLE=true)
      if (this.config.chatConsole) chatLog(line);
      this.emit('chat', line);
    });

    // Thu thập chunk cho chế độ render 3D (ring buffer, không giải mã vội)
    client.on('level_chunk', (packet) => {
      try {
        const x = packet?.origin?.x;
        const z = packet?.origin?.z;
        if (!Number.isInteger(x) || !Number.isInteger(z)) return;
        const subs = Array.isArray(packet?.subchunks) ? packet.subchunks : [];
        if (!subs.length) return;
        // Nếu server bật caching, mảng con chỉ chứa hash 8 byte -> vô dụng cho render
        const looksLikeHashes = subs.every((b) => b && b.length <= 12);
        if (looksLikeHashes) return;

        const minY = Number.isFinite(packet?.origin?.y) ? packet.origin.y : 0;
        const entry = { x, z, minY, subs: subs.map((b) => Buffer.from(b)) };
        // Tránh trùng chunk (server có thể gửi lại khi cập nhật)
        this.chunks = this.chunks.filter((c) => c.x !== x || c.z !== z);
        this.chunks.unshift(entry);
        if (this.chunks.length > this.chunkLimit) this.chunks.length = this.chunkLimit;
      } catch {
        /* bỏ qua chunk lỗi */
      }
    });

    client.on('kick', (packet) => {
      const reason = stripMcCodes(packet?.reason ?? 'không rõ lý do');
      this.state = 'idle';
      log(`⛔ Bị kick khỏi server: ${reason}`);
      this.emit('kick', reason);
      this._scheduleReconnect(new Error(`Bị kick: ${reason}`));
    });

    client.on('close', () => {
      if (this.state === 'online' || this.state === 'connecting') {
        this.state = 'idle';
        log('Kết nối bị đóng.');
        this.emit('disconnect', 'Kết nối bị đóng');
        this._scheduleReconnect(new Error('Kết nối bị đóng'));
      }
    });
  }

  /** Lên lịch kết nối lại với backoff: 3s -> 6s -> 12s -> 24s -> ... tối đa 60s */
  _scheduleReconnect(err) {
    if (this.stopping) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(60000, 3000 * 2 ** Math.min(this.attempt, 5)) + Math.floor(Math.random() * 1500);
    this.attempt += 1;
    log(`Kết nối lại sau ${(delay / 1000).toFixed(1)}s (lần thử ${this.attempt})${err ? ` — ${err.message}` : ''}`);
    this.emit('reconnecting', { delay, attempt: this.attempt, reason: err?.message });
    this.reconnectTimer = setTimeout(() => this.connect().catch((e) => warn(`connect() lỗi: ${e.message}`)), delay);
  }

  /** Cắt kết nối hiện tại một cách "sạch sẽ" (dùng khi đổi server hoặc tắt bot) */
  async stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.watchdogTimer);
    try {
      this.client?.close();
    } catch {
      /* bỏ qua */
    }
    this.client = null;
    this.state = 'idle';
    await sleep(120);
    this.stopping = false;
  }

  /** Đổi máy chủ mục tiêu (do lệnh /setipserver gọi) rồi kết nối lại */
  async setServer(host, port) {
    await this.stop(); // có chủ đích — không kích hoạt auto-reconnect của phiên cũ
    this.target = { host, port };
    this.chatLog = [];
    this.chunks = [];
    this.spawnPosition = null;
    this.detected = { version: null, protocol: null, motd: null, playersOnline: null, playersMax: null };
    this.attempt = 0;
    return this.start();
  }

  /** Callback đăng nhập Microsoft (chế độ AUTH_MODE=online): in mã thiết bị ra console + gửi webhook */
  _onMsaCode(data) {
    const lines = [
      '🔐 CẦN ĐĂNG NHẬP MICROSOFT (chế độ online):',
      `   1️⃣  Mở trang: ${data.verification_uri || data.verificationUrl || 'https://www.microsoft.com/link'}`,
      `   2️⃣  Nhập mã:  ${data.user_code || '?'}`,
      `   ⏳  Mã có hiệu lực ~15 phút. Token sẽ được cache trong data/profiles cho các lần sau.`,
    ];
    const message = lines.join('\n');
    console.log(`\n${message}\n`);
    this.emit('msa_code', message);
  }

  /** Chờ client spawn (dùng trước khi gửi lệnh trong game) */
  waitForSpawn(timeoutMs = this.config.spawnTimeoutMs) {
    if (this.state === 'online') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener('spawn', onSpawn);
        this.removeListener('kick', onFail);
        this.removeListener('disconnect', onFail);
      };
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onFail = (reason) => {
        cleanup();
        reject(new Error(`Không vào được server: ${reason ?? 'mất kết nối'}`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Hết ${Math.round(timeoutMs / 1000)}s mà chưa spawn xong (trạng thái: ${this.state}).`));
      }, timeoutMs);
      this.once('spawn', onSpawn);
      this.once('kick', onFail);
      this.once('disconnect', onFail);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Gửi lệnh trong game                                                */
  /* ------------------------------------------------------------------ */

  /** Phiên bản Bedrock client đang dùng (chuỗi hoặc null nếu chưa rõ) */
  getClientVersion() {
    return this.detected.version || this.client?.version || this.client?.options?.version || this.config.mcVersion || null;
  }

  /** Gửi 1 packet command_request tương thích theo phiên bản server */
  _sendCommandRequest(command, uuid) {
    const client = this.client;
    if (!client) throw new Error('Chưa có kết nối Minecraft.');

    if (usesNewCommandFormat(this.getClientVersion())) {
      // Từ 1.21.130+: cần player_entity_id (li64) và version dạng chuỗi ('latest' trên 1.26.x)
      const newPayload = {
        command,
        origin: { type: 'player', uuid, request_id: '', player_entity_id: toBigId(client.entityId) },
        internal: false,
        version: 'latest',
      };
      try {
        client.write('command_request', newPayload);
        return 'new';
      } catch (err) {
        // Phòng thủ: nếu serialize lỗi (định nghĩa protocol khác dự kiến), thử dạng cũ
        warn(`Gửi command_request dạng mới lỗi (${err.message}) — thử dạng cũ...`);
        client.write('command_request', {
          command,
          origin: { type: 'player', uuid, request_id: '' },
          internal: false,
        });
        return 'legacy';
      }
    }

    // ≤ 1.21.124: không có player_entity_id, version là varint (để trống như ví dụ chính thức cũ)
    client.write('command_request', {
      command,
      origin: { type: 'player', uuid, request_id: '' },
      internal: false,
    });
    return 'legacy';
  }

  /**
   * Thực hiện lệnh /pay trong game và thu thập phản hồi của server.
   * @param {string} ign        Tên người chơi đã qua sanitizeIgn()
   * @param {string} amountStr  Số tiền dạng chữ số thuần, VD "1500000000"
   * @returns {Promise<Array<{kind: 'cmd'|'ok'|'err'|'chat', text: string}>>}
   */
  async pay(ign, amountStr) {
    return this._queueInGameCommand(`/pay ${ign} ${amountStr}`);
  }

  /**
   * Kiểm tra số dư trong game bằng lệnh kinh tế của server
   * (tên lệnh cấu hình qua BALANCE_COMMAND, mặc định "balance").
   * @param {string|null} [ign] Tên người chơi cần xem (bỏ trống = xem số dư của chính bot)
   * @returns {Promise<Array<{kind: 'cmd'|'ok'|'err'|'chat', text: string}>>}
   */
  async balance(ign = null) {
    const base = this.config.balanceCommand || 'balance';
    return this._queueInGameCommand(ign ? `/${base} ${ign}` : `/${base}`);
  }

  /** Xếp hàng lệnh chạy tuần tự — phản hồi các lệnh không lẫn vào nhau */
  _queueInGameCommand(command) {
    const run = this._jobChain.then(() => this._runCommand(command));
    this._jobChain = run.catch(() => {});
    return run;
  }

  async _runCommand(command) {
    await this.waitForSpawn();

    if (command.length > 512) {
      throw new Error(`Lệnh quá dài (${command.length}/512 ký tự). Server Bedrock giới hạn 512 ký tự.`);
    }

    const client = this.client;
    const uuid = randomUUID();
    const lines = [{ kind: 'cmd', text: command }];
    let gotOutput = false;
    let outputAt = 0;

    const onCommandOutput = (packet) => {
      if (packet?.origin?.uuid !== uuid) return;
      gotOutput = true;
      outputAt = Date.now();
      for (const item of packet?.output ?? []) {
        const text = stripMcCodes(item?.message);
        if (text) lines.push({ kind: item?.success === false ? 'err' : 'ok', text, raw: item?.message });
      }
    };
    const onText = (packet) => {
      const text = textPacketToLine(packet);
      if (text) {
        const lower = text.toLowerCase();
        const isSuccess = lower.includes('paid') || lower.includes('chuyển') || lower.includes('sent');
        const isError = lower.includes('error') || lower.includes('không đủ') || lower.includes('not enough') || lower.includes('không thể');
        const kind = isError ? 'err' : isSuccess ? 'ok' : 'chat';
        lines.push({ kind, text, raw: packet?.message || text });
      }
    };

    client.on('command_output', onCommandOutput);
    client.on('text', onText);

    try {
      log(`Gửi lệnh trong game: ${command}`);
      const used = this._sendCommandRequest(command, uuid);
      log(`Đã gửi (định dạng ${used})`);

      // Thu phản hồi: tối đa payCaptureMs; nếu đã có command_output thì dừng thêm 800ms nữa
      const deadline = Date.now() + this.config.payCaptureMs;
      while (Date.now() < deadline) {
        if (gotOutput && Date.now() - outputAt >= 800) break;
        await sleep(120);
      }
    } finally {
      client.removeListener('command_output', onCommandOutput);
      client.removeListener('text', onText);
    }

    if (lines.length === 1) {
      lines.push({
        kind: 'err',
        text: '(Không nhận được phản hồi từ server — có thể server đang tắt command feedback.)',
      });
    }
    log(`Nhận ${lines.length - 1} dòng phản hồi.`);
    return lines;
  }

  /* ------------------------------------------------------------------ */
  /*  Dữ liệu thế giới cho chế độ render 3D                              */
  /* ------------------------------------------------------------------ */

  /**
   * Lấy ảnh chụp "thế giới" quanh vị trí spawn của bot.
   * @param {number} radius bán kính (block) quanh bot
   * @returns {{ center: {x,y,z}|null, blocks: Array<{x,y,z,name}> }}
   */
  getWorldSnapshot(radius = 26) {
    const center = this.spawnPosition;
    if (!center) return { center: null, blocks: [] };

    const chunkX = Math.floor(center.x / 16);
    const chunkZ = Math.floor(center.z / 16);
    const ring = Math.ceil(radius / 16) + 1;

    const blocks = [];
    for (const chunk of this.chunks) {
      if (Math.abs(chunk.x - chunkX) > ring || Math.abs(chunk.z - chunkZ) > ring) continue;
      try {
        decodeLevelChunk(chunk, this._decodedCache, blocks);
      } catch (err) {
        warn(`Giải mã chunk ${chunk.x},${chunk.z} lỗi: ${err.message}`);
      }
      if (blocks.length > 120000) break; // chặn trần bộ nhớ/CPU
    }
    return { center, blocks };
  }
}

module.exports = { BedrockManager, parseVersion, usesNewCommandFormat, textPacketToLine, stripMcCodes };
