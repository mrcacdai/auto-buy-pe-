'use strict';

/**
 * ============================================================
 *  config.js — Nạp và quản lý cấu hình của bot
 * ============================================================
 *  Nguồn cấu hình (ưu tiên cao -> thấp):
 *    1. data/server.json  — do lệnh /setipserver ghi xuống lúc đang chạy
 *    2. file .env         — cấu hình ban đầu
 *
 *  Mọi biến môi trường đều có giá trị an toàn mặc định.
 */

const path = require('path');
const dotenv = require('dotenv');

// Nạp .env theo đường dẫn thư mục gốc của bot (tránh lỗi khi chạy từ thư mục khác)
dotenv.config({ path: path.join(__dirname, '..', '.env') });
dotenv.config();

const fs = require('fs');

/** Thư mục gốc của project (thư mục chứa index.js) */
const BASE_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BASE_DIR, 'data');
const SERVER_FILE = path.join(DATA_DIR, 'server.json');

/** Đọc mục tiêu server Bedrock do /setipserver lưu lại (nếu có) */
function loadSavedServer() {
  try {
    const raw = fs.readFileSync(SERVER_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.host === 'string' && data.host) {
      return { host: data.host, port: Number.isInteger(data.port) ? data.port : 19132 };
    }
  } catch {
    /* chưa có file — dùng .env */
  }
  return null;
}

/** Ghi lại máy chủ mới do /setipserver đặt, để bot dùng cả sau khi khởi động lại */
function saveServer(host, port) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SERVER_FILE, JSON.stringify({ host, port, savedAt: new Date().toISOString() }, null, 2));
}

/** Giới hạn một số trong khoảng [min, max] */
function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const savedServer = loadSavedServer();

const config = {
  BASE_DIR,
  DATA_DIR,

  // ---- Discord ----
  discordToken: process.env.DISCORD_TOKEN || '',
  registerGuildId: (process.env.REGISTER_GUILD_ID || '').trim(),
  // Danh sách admin được phép dùng /setipserver; rỗng = ai có quyền Administrator cũng được
  adminDiscordIds: (process.env.ADMIN_DISCORD_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ---- Webhook admin ----
  adminWebhookUrl: (process.env.ADMIN_WEBHOOK_URL || '').trim(),

  // ---- Minecraft Bedrock ----
  username: (process.env.MC_USERNAME || 'PayBot').trim() || 'PayBot',
  authMode: (process.env.AUTH_MODE || 'offline').trim().toLowerCase() === 'online' ? 'online' : 'offline',
  // Ghim phiên bản (rỗng = tự dò qua ping)
  mcVersion: (process.env.MC_VERSION || '').trim(),
  // Backend RakNet (rỗng = mặc định của bedrock-protocol)
  raknetBackend: (process.env.MC_RAKNET_BACKEND || '').trim(),

  // Máy chủ mục tiêu: data/server.json (nếu có) đè lên giá trị trong .env
  server: savedServer || {
    host: (process.env.MC_HOST || '').trim(),
    port: clampInt(process.env.MC_PORT, 1, 65535, 19132),
  },

  // ---- Tinh chỉnh ----
  // Thời gian thu thập phản hồi lệnh trong game (/pay, /balance) trước khi chụp màn hình
  payCaptureMs: clampInt(process.env.PAY_CAPTURE_MS, 800, 20000, 3500),
  // Tên lệnh kinh tế trong game dùng cho /balance của Discord.
  // Tuỳ plugin kinh tế của server: EssentialsPE -> "balance", EconomyAPI (PocketMine) -> "mymoney",
  // Nukkit Essentials -> "money". Đổi qua BALANCE_COMMAND nếu server dùng tên khác.
  balanceCommand: ((process.env.BALANCE_COMMAND || 'balance').trim().replace(/^\//, '').replace(/\s+/g, '') || 'balance'),
  // Chờ vào server tối đa bao lâu trước khi báo lỗi cho lệnh /pay
  spawnTimeoutMs: clampInt(process.env.SPAWN_TIMEOUT_MS, 10000, 300000, 60000),
  // Bật render 3D (bị lỗi sẽ tự fallback về khung chat)
  render3d: (process.env.RENDER_3D || 'true').trim().toLowerCase() !== 'false',
  // In TOÀN BỘ chat của server (khung chat, vào/ra server, tin nhắn hệ thống) ra console
  chatConsole: (process.env.CHAT_CONSOLE || 'true').trim().toLowerCase() !== 'false',
  // Vẽ watermark (tên server/phiên bản/thời điểm chụp) lên ảnh chụp.
  // Mặc định TẮT để ảnh giống 100% ảnh F2 trong Minecraft PC.
  screenshotWatermark: (process.env.SCREENSHOT_WATERMARK || 'false').trim().toLowerCase() === 'true',
  // Hướng nhìn của bot khi chụp (độ): yaw quay ngang, pitch dọc (âm = hơi nhìn xuống)
  viewYaw: clampInt(process.env.VIEW_YAW, -180, 180, 0),
  viewPitch: clampInt(process.env.VIEW_PITCH, -89, 89, -12),

  // Thư mục cache token đăng nhập Microsoft (chế độ online)
  profilesFolder: path.join(DATA_DIR, 'profiles'),
};

/** Kiểm tra cấu hình bắt buộc, trả về danh sách lỗi (mảng rỗng = OK) */
function validateConfig() {
  const errors = [];
  if (!config.discordToken || config.discordToken.includes('dán_token')) {
    errors.push('Thiếu DISCORD_TOKEN trong file .env (token của Discord bot).');
  }
  if (!config.server.host) {
    errors.push('Thiếu MC_HOST trong file .env (hoặc hãy dùng lệnh /setipserver sau khi chạy).');
  }
  if (!config.adminWebhookUrl || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(config.adminWebhookUrl)) {
    errors.push('Thiếu hoặc sai ADMIN_WEBHOOK_URL (ảnh chụp sẽ không gửi đi được).');
  }
  return errors;
}

module.exports = { config, saveServer, validateConfig, BASE_DIR, DATA_DIR };
