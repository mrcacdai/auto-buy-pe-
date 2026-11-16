'use strict';

/**
 * ============================================================
 *  index.js (screenshot) — Điều phối chế độ chụp màn hình
 * ============================================================
 *  1. Chế độ Pay Crop:
 *     - Tách sạch background từ ảnh Minecraft thật, thay đoạn chat server
 *       trả về khi bot thực hiện /pay.
 *  2. Chế độ 3D / Chat F2:
 *     - RENDER_3D bật -> thử dựng ảnh thế giới 3D isometric
 *     - Thất bại       -> tự động vẽ ảnh khung chat HUD F2
 */

const { renderChatScreenshot } = require('./chatRender');
const { render3dScreenshot } = require('./render3d');
const { renderPayCropScreenshot, extractPayResponseLine } = require('./payCropRender');

const warn = (...args) => console.warn(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [Shot]`, ...args);

/**
 * Tạo ảnh chụp màn hình.
 * @param {object} p
 * @param {Array<{text: string, kind: string}>} p.lines   Dòng lệnh + phản hồi server
 * @param {{server?: string, version?: string, botName?: string, footer?: string}} [p.meta]
 * @param {{center?: {x,y,z}, blocks?: Array}|null} [p.world] Dữ liệu thế giới (tuỳ chọn)
 * @param {boolean} [p.render3dEnabled=true]
 * @param {{yaw?: number, pitch?: number, fov?: number}} [p.camera] Hướng nhìn bot khi render 3D
 * @param {boolean} [p.watermark=false] In tên server/phiên bản lên ảnh
 * @param {boolean} [p.isPay=false] Sử dụng chế độ ảnh tách nền /pay
 * @param {string} [p.ign] Tên người nhận (cho chế độ /pay)
 * @param {string} [p.amount] Số tiền (cho chế độ /pay)
 * @returns {Promise<{buffer: Buffer, mode: 'payCrop'|'3d'|'chat'}>}
 */
async function takeScreenshot({
  lines = [],
  meta = {},
  world = null,
  render3dEnabled = true,
  camera = null,
  watermark = false,
  isPay = false,
  ign = '',
  amount = '',
}) {
  if (isPay) {
    try {
      const buffer = await renderPayCropScreenshot({ lines, ign, amount });
      return { buffer, mode: 'payCrop' };
    } catch (err) {
      warn(`Render Pay Crop thất bại (${err.message}) — fallback về khung chat.`);
    }
  }

  if (render3dEnabled && world?.center && Array.isArray(world.blocks)) {
    try {
      const buffer = await render3dScreenshot({ world, lines, meta, camera: camera ?? {} });
      return { buffer, mode: '3d' };
    } catch (err) {
      warn(`Render 3D thất bại (${err.message}) — tự động chuyển sang chế độ khung chat.`);
    }
  }

  const buffer = await renderChatScreenshot({ lines, meta, watermark });
  return { buffer, mode: 'chat' };
}

module.exports = {
  takeScreenshot,
  renderPayCropScreenshot,
  extractPayResponseLine,
};
