'use strict';

/**
 * ============================================================
 *  chatRender.js — Chế độ ảnh chụp "khung chat"
 * ============================================================
 *  Vẽ 1 ảnh 1280x720 mô phỏng màn hình game Minecraft Bedrock:
 *  nền gradient tối + toàn bộ HUD (chat, hotbar, crosshair, watermark).
 *  Đây là chế độ dự phòng (fallback) luôn hoạt động được, kể cả khi
 *  bot chạy trên VPS không màn hình và chưa nhận được dữ liệu chunk.
 */

const { createCanvas } = require('@napi-rs/canvas');
const { drawHud } = require('./hud');

/**
 * @param {object} p
 * @param {Array<{text: string, kind: string}>} p.lines  Dòng chat/kết quả lệnh
 * @param {{server?: string, version?: string, botName?: string, footer?: string}} [p.meta]
 * @param {{width?: number, height?: number}} [p.size]
 * @param {boolean} [p.watermark=false] In tên server/phiên bản lên ảnh (mặc định tắt)
 * @returns {Promise<Buffer>} Ảnh PNG
 */
async function renderChatScreenshot({ lines = [], meta = {}, size, watermark = false }) {
  const width = size?.width ?? 1280;
  const height = size?.height ?? 720;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // ---- Nền gradient tối (mô phỏng màn hình game khi không có dữ liệu 3D) ----
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#20344a');
  sky.addColorStop(0.55, '#152335');
  sky.addColorStop(1, '#0b1520');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Vignette nhẹ ở 4 góc cho giống ảnh trong game
  const glow = ctx.createRadialGradient(width / 2, height / 2, height * 0.25, width / 2, height / 2, height * 0.95);
  glow.addColorStop(0, 'rgba(0,0,0,0)');
  glow.addColorStop(1, 'rgba(0,0,0,0.38)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // ---- HUD chuẩn F2 ----
  drawHud(ctx, { lines, meta, size: { width, height }, watermark });

  return canvas.encode('png');
}

module.exports = { renderChatScreenshot };
