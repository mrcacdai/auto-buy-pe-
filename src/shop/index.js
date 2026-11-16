'use strict';

/**
 * ============================================================
 *  shop/index.js — KHỞI ĐỘNG HỆ THỐNG SHOP + PANEL
 * ============================================================
 *  Gắn thêm lên bot Bedrock CŨ (không thay đổi logic /pay, /balance,
 *  /setipserver) các cơ chế lấy từ auto-buy:
 *
 *    1. Panel Discord  (/panel)  — bảng bán tiền + nút Mua + modal
 *    2. Số dư cá nhân  (/sodu, /gachthe)
 *    3. Đơn hàng QR + webhook ngân hàng (xử lý ở web/routes/bank.js)
 *    4. Chu kỳ AFK     (AFK_CYCLE=true)
 *    5. Lệnh console CMD: /stock /botoff /onbot /panel /afk /pay ...
 *    6. Chat in-game -> đẩy trực tiếp lên Web Panel qua Socket.io
 *
 *  Tắt toàn bộ: SHOP_ENABLED=false trong .env — bot trở về đúng bản gốc.
 */

const readline = require('readline');
const { ShopStore } = require('./store');
const balances = require('./balances');
const orders = require('./orders');
const panel = require('./panel');
const afk = require('./afk');
const mbbankService = require('./mbbankService');
const { processRetriesDue, webLog } = require('./payflow');
const { formatNumber, formatStock, parseGameAmount, parseVnd } = require('./format');

const SHOP_COMMANDS = ['panel', 'sodu', 'gachthe'];

/* ------------------------------------------------------------------ */
/*  Gửi tin nhắn/lệnh vào game (dùng cho console CMD + web panel)       */
/* ------------------------------------------------------------------ */

async function sendToGame(ctx, text) {
  if (ctx.manager.state !== 'online' || !ctx.manager.client) {
    throw new Error('Bot chưa vào server Minecraft.');
  }

  // Lệnh slash -> chạy qua hàng đợi lệnh có sẵn của bot gốc
  if (text.startsWith('/')) {
    return ctx.manager._queueInGameCommand(text);
  }

  // Chat thường -> gửi packet text trực tiếp (như người chơi gõ chat)
  const client = ctx.manager.client;
  try {
    client.write('text', {
      type: 'chat',
      needs_translation: false,
      source_name: ctx.manager.config.username,
      message: text,
      filtered_message: '',
    });
    return [{ kind: 'cmd', text: text }];
  } catch (err) {
    // Server không nhận packet chat -> dùng /say dự phòng
    return ctx.manager._queueInGameCommand(`/say ${text}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Lệnh console CMD (giống auto-buy)                                   */
/* ------------------------------------------------------------------ */

function printHelp() {
  console.log(
    [
      '',
      '━━━━━━━━ CÁC LỆNH CONSOLE ━━━━━━━━',
      '  /help                    — xem danh sách lệnh',
      '  /stock [số]              — xem/đặt kho tiền game (VD: /stock 500m, /stock +50m, /stock -20m, /stock 1b)',
      '  /botoff                  — tắt bot mua (out server, khóa nút Mua)',
      '  /onbot                   — bật lại bot mua (vào server, mở nút Mua)',
      '  /panel                   — cập nhật Panel Discord ngay lập tức',
      '  /afk status|rest|resume  — chu kỳ AFK: xem trạng thái / nghỉ ngay / vào lại ngay',
      '  /pay <ign> <số>          — trả tiền trong game (VD: /pay .steve 5m)',
      '  /balance [ign]           — xem số dư in-game',
      '  /naptien <userId> <số>   — cộng số dư VNĐ cho thành viên (VD: /naptien 123456789012345678 50k)',
      '  <tin nhắn> hoặc /lệnh    — gửi thẳng vào game (VD: /spawn hoặc hello mọi người)',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
    ].join('\n')
  );
}

async function handleConsoleCommand(ctx, input) {
  const [rawCmd, ...rest] = input.split(/\s+/);
  const cmd = rawCmd.toLowerCase();
  const arg = rest.join(' ');

  switch (cmd) {
    case '/help':
    case 'help':
      printHelp();
      return true;

    case '/stock':
    case 'stock': {
      if (!arg) {
        console.log(`[CMD] 📦 Kho hiện tại: ${formatStock(ctx.store.getStock())} (${formatNumber(Number(ctx.store.getStock()))} tiền game)`);
        return true;
      }
      const oldStock = ctx.store.getStock();
      let newStock = null;
      const m = arg.trim().match(/^([+-])?\s*([0-9]*\.?[0-9]+)([kmbt])?$/i);
      if (m) {
        const exp = { k: 3, m: 6, b: 9, t: 12 }[m[3]?.toLowerCase() ?? ''] ?? 0;
        const [intPart, fracPart = ''] = m[2].split('.');
        const frac = fracPart.slice(0, exp).padEnd(exp, '0');
        const value = BigInt((intPart || '0') + frac);
        newStock = m[1] === '+' ? oldStock + value : m[1] === '-' ? oldStock - value : value;
      }
      if (newStock === null || newStock < 0n) {
        console.log('[CMD] ❌ Số lượng không hợp lệ! VD: /stock 500m, /stock 1b, /stock +50m, /stock -20m, /stock 0');
        return true;
      }
      ctx.store.setStock(newStock);
      panel.updatePanel(ctx).catch(() => {});
      if (ctx.io) ctx.io.emit('configUpdate', ctx.store.data);
      console.log(`[CMD] 📦 Đã cập nhật kho: ${formatStock(oldStock)} ➔ ${formatStock(ctx.store.getStock())}`);
      return true;
    }

    case '/botoff':
    case 'botoff': {
      ctx.store.setBotOff(true);
      try {
        await ctx.manager.stop();
      } catch {}
      panel.updatePanel(ctx).catch(() => {});
      if (ctx.io) ctx.io.emit('configUpdate', ctx.store.data);
      console.log('[CMD] 🛑 Đã TẮT bot Minecraft và khóa nút Mua trên Panel Discord.');
      return true;
    }

    case '/onbot':
    case 'onbot': {
      ctx.store.setBotOff(false);
      try {
        ctx.manager.start();
      } catch {}
      panel.updatePanel(ctx).catch(() => {});
      if (ctx.io) ctx.io.emit('configUpdate', ctx.store.data);
      console.log('[CMD] 🟢 Đã BẬT lại bot Minecraft và mở nút Mua trên Panel Discord.');
      return true;
    }

    case '/panel':
    case 'panel': {
      const ok = await panel.updatePanel(ctx);
      console.log(ok ? '[CMD] ✅ Đã cập nhật Panel Discord.' : '[CMD] ⚠️ Chưa có Panel nào được lưu — dùng lệnh /panel trên Discord trước.');
      return true;
    }

    case '/afk':
    case 'afk': {
      const sub = (rest[0] || '').toLowerCase();
      if (sub === 'rest') {
        console.log('[CMD] 💤 Yêu cầu bot out server nghỉ ngay...');
        await afk.enterRest(ctx, true);
      } else if (sub === 'resume' || sub === 'on') {
        console.log('[CMD] 🟢 Yêu cầu kết thúc nghỉ, vào lại server ngay...');
        await afk.resumeOnline(ctx, true);
      } else {
        const s = afk.getAfkStatus();
        console.log('[CMD] ⏳ TRẠNG THÁI CHU KỲ AFK:');
        console.log(`      • Bật cơ chế: ${s.enabled ? 'CÓ' : 'KHÔNG (AFK_CYCLE=false)'}`);
        console.log(`      • Pha hiện tại: ${s.resting ? '💤 ĐANG NGHỈ (out server, khóa nút Mua)' : '🟢 ĐANG TREO ONLINE (đang mở bán)'}`);
        if (s.nextPhaseAt) {
          const mins = Math.round(s.remainingMs / 60000);
          console.log(`      • Chuyển pha lúc: ${new Date(s.nextPhaseAt).toLocaleTimeString('vi-VN')} (còn ~${mins} phút)`);
        }
        console.log('      • Gõ: /afk rest (nghỉ ngay) hoặc /afk resume (vào lại ngay)');
      }
      return true;
    }

    case '/pay':
    case 'pay': {
      const ign = rest[0];
      const amountRaw = rest.slice(1).join('');
      if (!ign || !amountRaw) {
        console.log('[CMD] ❌ Cú pháp: /pay <ign> <số_tiền> (VD: /pay Steve 10m)');
        return true;
      }
      const parsed = parseGameAmount(amountRaw);
      if (!parsed.ok) {
        console.log(`[CMD] ❌ ${parsed.error}`);
        return true;
      }
      console.log(`[CMD] 🔄 Đang gửi /pay ${ign} ${parsed.display} vào Minecraft...`);
      try {
        const lines = await ctx.manager.pay(ign, parsed.value.toString());
        for (const l of lines) console.log(`[CMD]    ${l.kind === 'err' ? '⚠️' : '•'} ${l.text}`);
        console.log(`[CMD] 🎉 Đã xử lý /pay ${ign} ${formatStock(parsed.value)}`);
      } catch (e) {
        console.log(`[CMD] ❌ Lỗi: ${e.message}`);
      }
      return true;
    }

    case '/balance':
    case 'balance': {
      const ign = rest[0] || null;
      try {
        const lines = await ctx.manager.balance(ign);
        for (const l of lines) console.log(`[CMD]    ${l.kind === 'err' ? '⚠️' : '•'} ${l.text}`);
      } catch (e) {
        console.log(`[CMD] ❌ Lỗi: ${e.message}`);
      }
      return true;
    }

    case '/naptien': {
      const userId = rest[0];
      const vnd = parseVnd(rest.slice(1).join(''));
      if (!userId || !/^\d{15,21}$/.test(userId) || !vnd) {
        console.log('[CMD] ❌ Cú pháp: /naptien <discord_user_id> <số_vnđ> (VD: /naptien 123456789012345678 50k)');
        return true;
      }
      const result = await balances.addBalance(userId, vnd, 'ADMIN_TOPUP', { by: 'console' });
      console.log(
        result.success
          ? `[CMD] ✅ Đã cộng ${formatNumber(vnd)} VNĐ cho ${userId} (số dư mới: ${formatNumber(result.newBalance)} VNĐ)`
          : `[CMD] ❌ ${result.error}`
      );
      return true;
    }

    default:
      return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Khởi động shop                                                      */
/* ------------------------------------------------------------------ */

async function startShop({ discord, manager, config, io }) {
  const store = new ShopStore();

  const ctx = {
    discord,
    manager,
    config,
    io: io ?? null,
    store,
  };

  // Map đơn hàng/thẻ chờ xử lý (gắn lên client như auto-buy để webhook dùng chung)
  discord.pendingOrders = discord.pendingOrders ?? new Map();
  discord.pendingCards = discord.pendingCards ?? new Map();

  /* ---- Tương tác Discord (nút, modal, /panel /sodu /gachthe) ---- */
  discord.on('interactionCreate', async (interaction) => {
    try {
      await panel.handleInteraction(ctx, interaction);
    } catch (err) {
      console.warn(`[Shop] Lỗi xử lý tương tác: ${err.message}`);
      const payload = { content: `❌ Lỗi shop: \`${String(err.message ?? err).slice(0, 300)}\``, flags: 64 };
      try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
      } catch {}
    }
  });

  /* ---- Chat in-game -> đẩy lên Web Panel ---- */
  const onChat = (line) => {
    if (ctx.io) ctx.io.emit('chat', { line, at: new Date().toISOString() });
  };
  manager.on('chat', onChat);

  /* ---- Bot vào server -> cập nhật panel + thông báo ---- */
  const onSpawn = () => {
    panel.updatePanel(ctx).catch(() => {});
  };
  manager.on('spawn', onSpawn);

  /* ---- Vòng lặp xử lý đơn chờ retry (mỗi 60 giây) ---- */
  const retryTimer = setInterval(() => {
    processRetriesDue(ctx).catch((e) => console.warn(`[Shop] Lỗi retry: ${e.message}`));
  }, 60 * 1000);

  /* ---- Tự động quét lịch sử MBBank qua ByteMart API ---- */
  const mbbankPolling = mbbankService.startPolling(ctx, io);

  /* ---- Tự làm mới Panel Discord mỗi 2 phút ---- */
  const panelTimer = setInterval(() => {
    panel.updatePanel(ctx).catch(() => {});
  }, 2 * 60 * 1000);

  /* ---- Chu kỳ AFK ---- */
  if ((process.env.AFK_CYCLE || 'false').trim().toLowerCase() === 'true') {
    afk.initAfkCycle(ctx);
  }

  /* ---- Tự đăng Panel khi khởi động (nếu cấu hình kênh) ---- */
  const autoChannel = (process.env.SHOP_PANEL_CHANNEL_ID || '').trim();
  if (autoChannel && /^\d+$/.test(autoChannel) && !store.panelMessage) {
    setTimeout(async () => {
      try {
        const channel = await discord.channels.fetch(autoChannel);
        if (channel?.isTextBased()) {
          const reply = await channel.send(panel.buildPanel(ctx));
          store.setPanelMessage(reply.channelId, reply.id);
          webLog(ctx, `📌 Panel đã TỰ ĐĂNG tại kênh <#${reply.channelId}> (SHOP_PANEL_CHANNEL_ID).`);
        }
      } catch (err) {
        console.warn(`[Shop] Không tự đăng được Panel: ${err.message}`);
      }
    }, 5000);
  }

  /* ---- Lệnh console CMD ---- */
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) return;
    try {
      const handled = await handleConsoleCommand(ctx, input);
      if (handled) return;
      // Tin nhắn thường -> gửi vào game
      const result = await sendToGame(ctx, input);
      for (const l of result ?? []) console.log(`[CMD] ➤ ${l.text}`);
    } catch (e) {
      console.log(`[CMD] ❌ ${e.message}`);
    }
  });

  webLog(ctx, `🛒 Shop đã sẵn sàng — kho ${formatStock(store.getStock())}, tỷ giá ${formatStock(store.price.baseAmount)} = ${formatNumber(store.price.basePrice)} ${store.price.currency}.`);
  printHelp();

  return {
    ctx,
    handlesCommand: (name) => SHOP_COMMANDS.includes(name),
    sendToGame: (text) => sendToGame(ctx, text),
    shutdown: () => {
      clearInterval(retryTimer);
      clearInterval(panelTimer);
      mbbankPolling?.stop?.();
      afk.shutdown();
      try {
        rl.close();
      } catch {}
      manager.removeListener('chat', onChat);
      manager.removeListener('spawn', onSpawn);
      console.log('[Shop] Đã dừng shop.');
    },
  };
}

module.exports = { startShop, sendToGame };
