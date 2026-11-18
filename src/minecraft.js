'use strict';

/**
 * ============================================================
 *  minecraft.js — Quản lý kết nối Minecraft PC (Java Edition) 24/7
 * ============================================================
 *  Nhiệm vụ:
 *   - Duy trì phiên đăng nhập liên tục vào server Minecraft Java (MC PC)
 *     qua giao thức TCP (mặc định cổng 25565), tự kết nối lại khi mất
 *     kết nối / bị kick với backoff tăng dần.
 *   - Tự dò phiên bản server qua SLP ping (mineflayer tự khớp protocol
 *     tương ứng khi để trống MC_VERSION).
 *   - Đăng nhập ONLINE (tài khoản Microsoft bản quyền MC PC bằng mã thiết bị
 *     device-code, token được cache trong data/profiles) hoặc OFFLINE (crack).
 *   - Gửi lệnh trong game (`/pay`, `/balance`, ...) qua `bot.chat()`,
 *     thu phản hồi qua sự kiện `message` (giữ nguyên mã màu § để vẽ ảnh).
 *   - Đọc block xung quanh bot phục vụ chế độ render 3D.
 */

const EventEmitter = require('events');
const mineflayer = require('mineflayer');
const mc = require('minecraft-protocol');
const { Vec3 } = require('vec3');

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
 * Chuyển đối tượng JSON chat component / ChatMessage / chuỗi của Java Edition thành text đọc được.
 */
function formatChatComponent(input) {
  if (input == null) return '';
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return formatChatComponent(JSON.parse(trimmed));
      } catch {
        return stripMcCodes(input);
      }
    }
    return stripMcCodes(input);
  }
  if (typeof input.toString === 'function' && input.toString !== Object.prototype.toString) {
    const s = input.toString();
    if (s && s !== '[object Object]') return stripMcCodes(s);
  }
  if (Array.isArray(input)) {
    return input.map(formatChatComponent).join('');
  }
  if (typeof input === 'object') {
    let out = '';
    if (typeof input.text === 'string') out += input.text;
    else if (typeof input.translate === 'string') {
      out += input.translate;
      if (Array.isArray(input.with) && input.with.length) {
        out += ` (${input.with.map(formatChatComponent).filter(Boolean).join(', ')})`;
      }
    }
    if (Array.isArray(input.extra)) {
      out += input.extra.map(formatChatComponent).join('');
    }
    return stripMcCodes(out);
  }
  return stripMcCodes(String(input));
}

/**
 * So sánh phiên bản kiểu "1.21.4" -> [1, 21, 4].
 * Trả về mảng số hoặc null nếu không đọc được.
 */
function parseVersion(version) {
  if (!version || typeof version !== 'string') return null;
  const m = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

class JavaManager extends EventEmitter {
  /** @param {object} config Cấu hình toàn cục (src/config.js) */
  constructor(config) {
    super();
    this.config = config;
    this.bot = null;
    this.client = null; // alias trỏ tới this.bot để tương thích ngược
    this.activeUsername = null; // tên IGN thật sau khi đăng nhập Microsoft
    this.state = 'idle'; // idle | connecting | online
    this.attempt = 0; // số lần thử kết nối lại liên tiếp (đặt lại = 0 khi spawn thành công)
    this.stopping = false; // cờ dừng có chủ đích (khi đổi server / tắt bot)
    this.reconnectTimer = null;
    this.watchdogTimer = null;

    this.target = { host: config.server.host, port: config.server.port };
    this.detected = { version: null, protocol: null, motd: null, playersOnline: null, playersMax: null };

    this.chatLog = []; // nhật ký chat gần nhất (cho debug)
    this.spawnPosition = null; // { x, y, z } từ bot.entity.position
    this.lastScreenshotInfo = null;

    this._jobChain = Promise.resolve(); // hàng đợi tuần tự cho các lệnh /pay
    this._reconnectScheduledForBot = false;
  }

  /* ------------------------------------------------------------------ */
  /*  Thông tin trạng thái — dùng cho embed Discord & Web Panel          */
  /* ------------------------------------------------------------------ */

  get serverLabel() {
    return `${this.target.host}:${this.target.port}`;
  }

  stateInfo() {
    return {
      state: this.state,
      server: this.serverLabel,
      version: this.detected.version || this.bot?.version || this.config.mcVersion || 'tự động',
      username: this.activeUsername || this.bot?.username || this.config.username,
      authMode: this.config.authMode,
      edition: 'java',
      chatLines: this.chatLog.length,
      chunks: 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Ping server Java (TCP SLP ping)                                    */
  /* ------------------------------------------------------------------ */

  /** Trả về { version, protocol, motd, playersOnline, playersMax } hoặc null nếu không ping được */
  async probe(host = this.target.host, port = this.target.port, timeout = 5000) {
    try {
      const res = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`Ping timed out (${timeout}ms)`));
          }
        }, timeout);

        mc.ping({ host, port }, (err, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(result);
        });
      });

      const info = {
        version: res?.version?.name ?? null,
        protocol: res?.version?.protocol ?? null,
        motd: formatChatComponent(res?.description) || null,
        playersOnline: res?.players?.online ?? null,
        playersMax: res?.players?.max ?? null,
        raw: res ?? null,
      };
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
    this._reconnectScheduledForBot = false;
    const { host, port } = this.target;
    const authType = this.config.authMode === 'online' ? 'microsoft' : 'offline';
    log(`Đang kết nối tới ${host}:${port} (MC PC / Java • auth: ${authType})...`);

    // Ping trước để log phiên bản server & số người chơi
    const pong = await this.probe(host, port);
    if (pong) {
      this.detected = { ...this.detected, ...pong };
      log(
        `Server phản hồi: Minecraft Java ${pong.version ?? '?'} (protocol ${pong.protocol ?? '?'})` +
          (pong.playersOnline != null ? ` — ${pong.playersOnline}/${pong.playersMax ?? '?'} người chơi` : '')
      );
    } else {
      warn('Không ping được server trước khi kết nối — vẫn thử đăng nhập...');
    }

    const options = {
      host,
      port,
      username: this.config.username,
      auth: authType,
      profilesFolder: this.config.profilesFolder, // cache token Microsoft
      version: this.config.mcVersion || false, // false = tự động khớp phiên bản server Java
      hideErrors: false,
      onMsaCode: (data) => this._onMsaCode(data), // đăng nhập Microsoft bằng device code
    };

    let bot;
    try {
      bot = mineflayer.createBot(options);
    } catch (err) {
      this.state = 'idle';
      this.emit('connect_failed', `Không tạo được kết nối: ${err.message}`);
      return this._scheduleReconnect(err);
    }

    this.bot = bot;
    this.client = bot;
    this._wireBot(bot);

    // Watchdog: nếu 2 phút vẫn chưa spawn (và không đang chờ nhập mã Microsoft) thì cắt và thử lại
    this._resetWatchdog(120000);
  }

  _resetWatchdog(ms) {
    clearTimeout(this.watchdogTimer);
    this.watchdogTimer = setTimeout(() => {
      if (this.state !== 'online' && !this.stopping) {
        warn(`Quá ${Math.round(ms / 1000)}s chưa spawn — cắt kết nối và thử lại.`);
        try {
          this.bot?.end('Watchdog timeout');
        } catch {
          /* bỏ qua */
        }
      }
    }, ms);
  }

  /** Gắn các event handler cần thiết cho 1 mineflayer bot */
  _wireBot(bot) {
    bot.on('error', (err) => {
      if (bot !== this.bot) return;
      warn(`Lỗi kết nối: ${err?.message ?? err}`);
      this.emit('mc_error', err?.message ?? String(err));
    });

    bot.on('login', () => {
      if (bot !== this.bot) return;
      if (bot.username) this.activeUsername = bot.username;
      if (bot.version) this.detected.version = bot.version;
      log(`Đã đăng nhập tài khoản MC PC "${this.activeUsername || this.config.username}" (Java ${bot.version || 'auto'}) — đang chờ spawn...`);
      // Đăng nhập xong -> đặt lại watchdog chờ spawn bình thường (2 phút)
      this._resetWatchdog(120000);
    });

    bot.on('spawn', () => {
      if (bot !== this.bot) return;
      if (bot.username) this.activeUsername = bot.username;
      if (bot.version) this.detected.version = bot.version;

      const pos = bot.entity?.position;
      if (pos && Number.isFinite(pos.x)) {
        this.spawnPosition = { x: pos.x, y: pos.y, z: pos.z };
      }

      const wasOnline = this.state === 'online';
      this.state = 'online';
      this.attempt = 0;
      clearTimeout(this.watchdogTimer);

      if (!wasOnline) {
        log(`✅ Bot "${this.activeUsername || this.config.username}" đã spawn vào ${this.serverLabel} (Java ${bot.version || 'auto'})`);
        this.emit('spawn');
      } else {
        log(`🔄 Bot chuyển thế giới / respawn tại ${this.serverLabel}`);
      }
    });

    bot.on('message', (jsonMsg, position) => {
      if (bot !== this.bot) return;
      // Bỏ qua thanh action bar (game_info) để tránh spam console
      if (position === 'game_info') return;

      const plain = stripMcCodes(typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : String(jsonMsg ?? '')).trim();
      if (!plain) return;

      let raw = plain;
      try {
        if (typeof jsonMsg?.toMotd === 'function') {
          raw = jsonMsg.toMotd().trim() || plain;
        }
      } catch {
        raw = plain;
      }

      this.chatLog.push(plain);
      if (this.chatLog.length > 120) this.chatLog.shift();
      if (this.config.chatConsole) chatLog(plain);

      this.emit('chat', plain);
      this.emit('chat_detail', { text: plain, raw, position });
    });

    bot.on('kicked', (reason) => {
      if (bot !== this.bot) return;
      const text = formatChatComponent(reason) || 'không rõ lý do';
      this.state = 'idle';
      clearTimeout(this.watchdogTimer);
      log(`⛔ Bị kick khỏi server: ${text}`);
      this.emit('kick', text);
      if (!this._reconnectScheduledForBot) {
        this._reconnectScheduledForBot = true;
        this._scheduleReconnect(new Error(`Bị kick: ${text}`));
      }
    });

    bot.on('end', (reason) => {
      if (bot !== this.bot) return;
      clearTimeout(this.watchdogTimer);
      if (this.stopping) return;

      const wasActive = this.state === 'online' || this.state === 'connecting';
      this.state = 'idle';

      if (!this._reconnectScheduledForBot) {
        this._reconnectScheduledForBot = true;
        const msg = reason ? `Kết nối bị đóng (${reason})` : 'Kết nối bị đóng';
        if (wasActive) {
          log(`${msg}.`);
          this.emit('disconnect', msg);
        }
        this._scheduleReconnect(new Error(msg));
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
    const oldBot = this.bot;
    this.bot = null;
    this.client = null;
    if (oldBot) {
      try {
        oldBot.removeAllListeners();
        oldBot.quit('Bot stopping');
      } catch {
        try {
          oldBot.end();
        } catch {
          /* bỏ qua */
        }
      }
    }
    this.state = 'idle';
    await sleep(120);
    this.stopping = false;
  }

  /** Đổi máy chủ mục tiêu (do lệnh /setipserver hoặc Web Panel gọi) rồi kết nối lại */
  async setServer(host, port) {
    await this.stop();
    this.target = { host, port };
    this.chatLog = [];
    this.spawnPosition = null;
    this.detected = { version: null, protocol: null, motd: null, playersOnline: null, playersMax: null };
    this.attempt = 0;
    return this.start();
  }

  /** Callback đăng nhập Microsoft (chế độ AUTH_MODE=online): in mã thiết bị ra console + gửi webhook */
  _onMsaCode(data) {
    // Kéo dài watchdog lên 15 phút để người dùng có đủ thời gian mở trình duyệt nhập mã
    this._resetWatchdog(15 * 60 * 1000);
    const lines = [
      '🔐 CẦN ĐĂNG NHẬP MICROSOFT (Tài khoản Minecraft PC / Java):',
      `   1️⃣  Mở trang: ${data.verification_uri || data.verificationUrl || 'https://www.microsoft.com/link'}`,
      `   2️⃣  Nhập mã:  ${data.user_code || '?'}`,
      `   ⏳  Mã có hiệu lực ~15 phút. Token sẽ được cache trong data/profiles cho các lần sau.`,
    ];
    const message = lines.join('\n');
    console.log(`\n${message}\n`);
    this.emit('msa_code', message);
  }

  /** Chờ bot spawn (dùng trước khi gửi lệnh trong game) */
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
  /*  Gửi chat & lệnh trong game                                         */
  /* ------------------------------------------------------------------ */

  /** Phiên bản Java client đang dùng */
  getClientVersion() {
    return this.bot?.version || this.detected.version || this.config.mcVersion || null;
  }

  /** Gửi 1 dòng chat thường vào server Java */
  async sendChat(text) {
    await this.waitForSpawn();
    if (!this.bot) throw new Error('Chưa có kết nối Minecraft.');
    const msg = String(text ?? '').trim();
    if (!msg) return [{ kind: 'cmd', text: '' }];
    this.bot.chat(msg);
    return [{ kind: 'cmd', text: msg }];
  }

  /**
   * Thực hiện lệnh /pay trong game và thu thập phản hồi của server.
   * @param {string} ign        Tên người chơi đã qua sanitizeIgn()
   * @param {string} amountStr  Số tiền dạng chữ số thuần, VD "1500000000"
   * @returns {Promise<Array<{kind: 'cmd'|'ok'|'err'|'chat', text: string, raw?: string}>>}
   */
  async pay(ign, amountStr) {
    return this._queueInGameCommand(`/pay ${ign} ${amountStr}`);
  }

  /**
   * Kiểm tra số dư trong game bằng lệnh kinh tế của server
   * (tên lệnh cấu hình qua BALANCE_COMMAND, mặc định "balance").
   * @param {string|null} [ign] Tên người chơi cần xem (bỏ trống = xem số dư của chính bot)
   * @returns {Promise<Array<{kind: 'cmd'|'ok'|'err'|'chat', text: string, raw?: string}>>}
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

    if (command.length > 256) {
      throw new Error(`Lệnh quá dài (${command.length}/256 ký tự). Server Minecraft Java giới hạn 256 ký tự.`);
    }

    const bot = this.bot;
    if (!bot) throw new Error('Chưa có kết nối Minecraft.');

    const lines = [{ kind: 'cmd', text: command }];
    let gotRelevant = false;
    let relevantAt = 0;

    const onChatDetail = ({ text, raw }) => {
      if (!text) return;
      const lower = text.toLowerCase();
      const isError =
        lower.includes('error') ||
        lower.includes('không đủ') ||
        lower.includes('not enough') ||
        lower.includes('insufficient') ||
        lower.includes('không thể') ||
        lower.includes('cannot') ||
        lower.includes('not found') ||
        lower.includes('offline') ||
        lower.includes('invalid') ||
        lower.includes('unknown command');
      const isSuccess =
        !isError &&
        (lower.includes('paid') ||
          lower.includes('chuyển') ||
          lower.includes('sent') ||
          lower.includes('đã gửi') ||
          lower.includes('balance') ||
          lower.includes('số dư') ||
          lower.includes('$'));

      const kind = isError ? 'err' : isSuccess ? 'ok' : 'chat';
      lines.push({ kind, text, raw: raw || text });

      if (isSuccess || isError) {
        gotRelevant = true;
        relevantAt = Date.now();
      }
    };

    this.on('chat_detail', onChatDetail);

    try {
      log(`Gửi lệnh trong game (Java): ${command}`);
      bot.chat(command);

      // Thu phản hồi: tối đa payCaptureMs; nếu đã nhận dòng phản hồi khớp thì đợi thêm 700ms cho các dòng phụ
      const deadline = Date.now() + this.config.payCaptureMs;
      while (Date.now() < deadline) {
        if (gotRelevant && Date.now() - relevantAt >= 700) break;
        await sleep(120);
      }
    } finally {
      this.removeListener('chat_detail', onChatDetail);
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
   * Lấy ảnh chụp khối (block) quanh vị trí hiện tại của bot cho render 3D.
   * @param {number} radius bán kính (block) quanh bot
   * @returns {{ center: {x,y,z}|null, blocks: Array<{x,y,z,name}> }}
   */
  getWorldSnapshot(radius = 16) {
    const bot = this.bot;
    const pos = bot?.entity?.position || this.spawnPosition;
    if (!bot || !pos || !Number.isFinite(pos.x)) return { center: null, blocks: [] };

    const center = { x: pos.x, y: pos.y, z: pos.z };
    const cx = Math.floor(pos.x);
    const cy = Math.floor(pos.y);
    const cz = Math.floor(pos.z);

    // Giới hạn bán kính hợp lý để quét tức thì, không làm lag event loop
    const rXZ = Math.min(14, Math.max(6, Math.floor(radius)));
    const rY = 7;

    const blocks = [];
    for (let dx = -rXZ; dx <= rXZ; dx++) {
      for (let dz = -rXZ; dz <= rXZ; dz++) {
        for (let dy = -rY; dy <= rY; dy++) {
          try {
            const b = bot.blockAt(new Vec3(cx + dx, cy + dy, cz + dz));
            if (b && b.name && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
              blocks.push({ x: cx + dx, y: cy + dy, z: cz + dz, name: b.name });
            }
          } catch {
            /* bỏ qua chunk chưa tải */
          }
          if (blocks.length > 60000) return { center, blocks };
        }
      }
    }
    return { center, blocks };
  }
}

module.exports = {
  JavaManager,
  BedrockManager: JavaManager, // alias giữ tương thích với toàn bộ import cũ
  parseVersion,
  formatChatComponent,
  stripMcCodes,
};
