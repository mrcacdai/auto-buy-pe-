'use strict';

/**
 * ============================================================
 *  index.js (screenshot) — Điều phối chế độ chụp màn hình
 * ============================================================
 *  Thứ tự ưu tiên (đúng yêu cầu "cả hai + fallback"):
 *    1. RENDER_3D bật  -> thử dựng ảnh thế giới 3D isometric
 *    2. Thất bại       -> tự động vẽ ảnh khung chat (luôn thành công)
 *
 *  Cả hai chế độ đều phủ lớp HUD có khung chat nên kết quả lệnh /pay
 *  LUÔN hiển thị trên ảnh dù theo cách nào.
 */

const { renderChatScreenshot } = require('./chatRender');
const { render3dScreenshot } = require('./render3d');

const warn = (...args) => console.warn(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [Shot]`, ...args);

/**
 * Tạo ảnh chụp màn hình.
 * @param {object} p
 * @param {Array<{text: string, kind: string}>} p.lines   Dòng lệnh + phản hồi server
 * @param {{server?: string, version?: string, botName?: string, footer?: string}} [p.meta]
 * @param {{center?: {x,y,z}, blocks?: Array}|null} [p.world] Dữ liệu thế giới (tuỳ chọn)
 * @param {boolean} [p.render3dEnabled=true]
 * @param {{yaw?: number, pitch?: number, fov?: number}} [p.camera] Hướng nhìn bot khi render 3D
 * @param {boolean} [p.watermark=false] In tên server/phiên bản lên ảnh (mặc định tắt — ảnh F2 "sạch")
 * @returns {Promise<{buffer: Buffer, mode: '3d'|'chat'}>}
 */
async function takeScreenshot({ lines = [], meta = {}, world = null, render3dEnabled = true, camera = null, watermark = false }) {
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

module.exports = { takeScreenshot };
