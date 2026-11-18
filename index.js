'use strict';

/**
 * ============================================================
 *  index.js — Điểm khởi động của MC Bedrock Pay Bot
 * ============================================================
 *  Kiến trúc:
 *    Discord (/pay, /balance, /setipserver)
 *        │
 *        ▼
 *    BedrockManager (src/minecraft.js)  ←— giữ 1 phiên online 24/7 vào
 *        │                               server Bedrock, tự reconnect
 *        ▼
 *    Gửi lệnh trong game (/pay, /balance) → thu phản hồi → chụp màn hình
 *        │
 *        ├──> Embed + ảnh trong kênh Discord
 *        └──> Ảnh + thông báo gửi tới webhook admin
 *
 *  Chạy:  node index.js   (hoặc `npm start`)
 */

const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');

const { config, validateConfig } = require('./src/config');
const { JavaManager } = require('./src/minecraft');
const { buildCommandJson, handlePay, handleBalance, handleSetIp } = require('./src/commands');
const { notifyText } = require('./src/webhook');

/* ---------------- Cửa hàng + Panel (tính năng bổ sung) ----------------
 * Lấy từ auto-buy: Panel Discord bán tiền, số dư cá nhân, QR ngân hàng,
 * thẻ cào, webhook bank, web panel, chu kỳ AFK...
 * KHÔNG dùng mineflayer (acc Java) — mọi thứ chạy trên BedrockManager gốc.
 * Tắt toàn bộ bằng SHOP_ENABLED=false — bot trở về đúng bản cũ.
 */
const SHOP_ENABLED = (process.env.SHOP_ENABLED || 'true').trim().toLowerCase() !== 'false';
let shop = null;
let startWebPanel = null;
if (SHOP_ENABLED) {
  try {
    shop = require('./src/shop');
    ({ startWebPanel } = require('./web/server'));
  } catch (err) {
    // Thiếu dependency (express/socket.io...) — bot vẫn chạy đúng bản gốc
    console.error(`[Shop] ⚠️ Không nạp được shop, chạy như bản gốc (npm install để bật shop): ${err.message}`);
  }
}

const log = (...args) => console.log(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [Bot]`, ...args);
const warn = (...args) => console.warn(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [Bot]`, ...args);

/* ---------------- 1. Kiểm tra cấu hình ---------------- */

const configErrors = validateConfig();
if (configErrors.length > 0) {
  console.error('\n❌ Cấu hình chưa đủ. Hãy mở file .env (copy từ .env.example) và sửa:\n');
  for (const err of configErrors) console.error(`   • ${err}`);
  console.error('\nSau đó chạy lại: node index.js\n');
  process.exit(1);
}

/* ---------------- 2. Tạo manager Minecraft ---------------- */

const manager = new JavaManager(config);

manager.on('spawn', () => {
  const info = manager.stateInfo();
  log(`Minecraft online: ${info.username} @ ${info.server} (Java ${manager.detected.version ?? 'auto'})`);
  notifyText(config, `✅ Bot \`${info.username}\` đã vào server Minecraft PC (Java) **${info.server}** (${manager.detected.version ?? 'auto'}).`);
});

manager.on('kick', (reason) => {
  log(`Kick: ${reason}`);
  notifyText(config, `⛔ Bot bị kick khỏi **${manager.serverLabel}**: ${reason}`);
});

manager.on('disconnect', () => {
  notifyText(config, `🔌 Mất kết nối với **${manager.serverLabel}** — đang tự kết nối lại...`);
});

manager.on('reconnecting', ({ delay, attempt }) => {
  if (attempt === 1) return; // bớt spam
  log(`Thử kết nối lại lần ${attempt} sau ${(delay / 1000).toFixed(0)}s...`);
});

manager.on('msa_code', (message) => {
  // Đăng nhập Microsoft online mode: gửi hướng dẫn mã thiết bị tới webhook admin
  notifyText(config, message);
});

manager.on('mc_error', (message) => warn(`Minecraft lỗi: ${message}`));

// Bật kết nối 24/7 (tự reconnect vĩnh viễn)
manager.start();

/* ---------------- 2.1 Web Panel quản trị (Express + Socket.io) ---------------- */

let webPanel = null; // { io, app, server }
let shopRuntime = null; // { ctx, handlesCommand, sendToGame, shutdown } của src/shop

if (SHOP_ENABLED && startWebPanel) {
  startWebPanel({ config, manager, getContext: () => shopRuntime?.ctx ?? null })
    .then((panel) => {
      webPanel = panel;
      // Shop có thể đã khởi động trước khi web panel sẵn sàng -> gắn io vào context
      if (shopRuntime?.ctx && panel.io) shopRuntime.ctx.io = panel.io;
    })
    .catch((err) => {
      warn(`Web Panel khởi động thất bại (bot vẫn chạy bình thường): ${err.message}`);
    });
}

/* ---------------- 3. Discord client ---------------- */

const discord = new Client({
  intents: [GatewayIntentBits.Guilds], // slash command không cần MessageContent
});

discord.once(Events.ClientReady, async (client) => {
  log(`Discord đăng nhập thành công: ${client.user.tag}`);

  // Đăng ký slash command:
  //   - Có REGISTER_GUILD_ID trong .env -> đăng ký riêng cho server đó (hiện NGAY)
  //   - Không có -> đăng ký toàn cục (mất tới ~1 giờ để hiện ở mọi server)
  try {
    // Lệnh gốc (/pay, /balance, /setipserver) + lệnh shop (/panel, /sodu, /gachthe)
    const commands = [...buildCommandJson(), ...(SHOP_ENABLED ? shopCommandJson() : [])];
    if (config.registerGuildId) {
      await client.application.commands.set(commands, config.registerGuildId);
      log(`Đã đăng ký ${commands.length} slash command cho guild ${config.registerGuildId}.`);
    } else {
      await client.application.commands.set(commands);
      log(`Đã đăng ký ${commands.length} slash command toàn cục (global) — có thể mất tới 1 giờ để hiện.`);
    }
  } catch (err) {
    warn(`Đăng ký slash command thất bại: ${err.message}`);
  }

  /* ---------------- 3.1 Khởi động Shop + Panel ---------------- */
  if (SHOP_ENABLED) {
    try {
      shopRuntime = await shop.startShop({
        discord: client,
        manager,
        config,
        io: webPanel?.io ?? null,
      });
    } catch (err) {
      warn(`Shop khởi động thất bại (các lệnh /pay /balance /setipserver vẫn chạy bình thường): ${err.message}`);
    }
  }

  client.user.setPresence({
    activities: [{ name: `/pay • /balance • ${manager.serverLabel}`, type: 3 }], // type 3 = WATCHING
    status: 'online',
  });
  manager.on('spawn', () => {
    discord.user?.setPresence({ activities: [{ name: `/pay • /balance • ${manager.serverLabel}`, type: 3 }], status: 'online' });
  });
});

discord.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    switch (interaction.commandName) {
      case 'pay':
        await handlePay(interaction, manager, config);
        break;
      case 'balance':
        await handleBalance(interaction, manager, config);
        break;
      case 'setipserver':
        await handleSetIp(interaction, manager, config);
        break;
      default:
        // Lệnh của shop (/panel, /sodu, /gachthe) do src/shop xử lý —
        // không trả "lệnh không xác định" ở đây để tránh trùng phản hồi.
        if (shopRuntime?.handlesCommand?.(interaction.commandName)) break;
        await interaction.reply({ content: '❓ Lệnh không xác định.', ephemeral: true });
    }
  } catch (err) {
    warn(`Lỗi xử lý /${interaction.commandName}: ${err}`);
    const payload = {
      embeds: [new EmbedBuilder().setColor(0xed4245).setDescription(`❌ Lỗi không mong muốn: \`${String(err.message ?? err).slice(0, 300)}\``)],
      ephemeral: true,
    };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
});

discord.login(config.discordToken).catch((err) => {
  console.error('\n❌ Đăng nhập Discord thất bại — kiểm tra lại DISCORD_TOKEN trong .env');
  console.error(`   Chi tiết: ${err.message}\n`);
  process.exit(1);
});

/* ---------------- 4. Tắt bot gọn gàng ---------------- */

async function shutdown(signal) {
  log(`Nhận ${signal} — đang tắt bot...`);
  try {
    await notifyText(config, `🛑 Bot đang tắt (${signal}).`);
    shopRuntime?.shutdown?.();
    try {
      webPanel?.server?.close();
    } catch {}
    discord.destroy();
    await manager.stop();
  } finally {
    process.exit(0);
  }
}

/** JSON đăng ký của 3 lệnh shop (nạp lười — không ảnh hưởng bot gốc khi lỗi) */
function shopCommandJson() {
  try {
    return require('./src/shop/panel').commandJson();
  } catch (err) {
    warn(`Không nạp được lệnh shop: ${err.message}`);
    return [];
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => warn(`unhandledRejection: ${reason}`));
process.on('uncaughtException', (err) => {
  warn(`uncaughtException: ${err}`);
  // Không tắt tiến trình — bot 24/7 phải sống sót qua lỗi đơn lẻ
});
