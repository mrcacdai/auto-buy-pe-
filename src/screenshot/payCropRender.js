'use strict';

/**
 * ============================================================
 *  payCropRender.js — Render ảnh xác nhận /pay tách nền Minecraft
 * ============================================================
 *  Lấy background từ ảnh thực tế trong game (đã tách sạch chữ),
 *  nhận phản hồi chat server trả về khi bot thực hiện lệnh /pay,
 *  và render chữ mới lên ảnh với font Minecraft chuẩn từng pixel.
 */

const path = require('path');
const fs = require('fs');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');

const ASSETS_DIR = path.join(__dirname, 'assets');
const FONT_PATH = path.join(ASSETS_DIR, 'Minecraft.ttf');
const BG_PATH = path.join(ASSETS_DIR, 'pay_bg.png');

let fontRegistered = false;
function ensureFont() {
  if (fontRegistered) return;
  if (fs.existsSync(FONT_PATH)) {
    try {
      GlobalFonts.registerFromPath(FONT_PATH, 'MinecraftPay');
      fontRegistered = true;
    } catch (err) {
      console.warn(`[Screenshot] Không nạp được font Minecraft: ${err.message}`);
    }
  }
}

let cachedBg = null;
async function getBackground() {
  if (!cachedBg && fs.existsSync(BG_PATH)) {
    cachedBg = await loadImage(BG_PATH);
  }
  return cachedBg;
}

/** Làm tối màu hex (#rrggbb) 25% độ sáng cho lớp bóng chữ Minecraft */
function darken(hex) {
  const m = hex.replace('#', '');
  const r = Math.round(parseInt(m.slice(0, 2), 16) * 0.25);
  const g = Math.round(parseInt(m.slice(2, 4), 16) * 0.25);
  const b = Math.round(parseInt(m.slice(4, 6), 16) * 0.25);
  return `rgb(${r},${g},${b})`;
}

const COLOR_MAP = {
  '0': '#000000',
  '1': '#0000aa',
  '2': '#00aa00',
  '3': '#00aaaa',
  '4': '#aa0000',
  '5': '#aa00aa',
  '6': '#ffaa00',
  '7': '#aaaaaa',
  '8': '#555555',
  '9': '#5555ff',
  'a': '#55ff55',
  'b': '#55ffff',
  'c': '#ff5555',
  'd': '#ff55ff',
  'e': '#ffff55',
  'f': '#ffffff',
  'r': '#ffffff',
};

/**
 * Tách chuỗi thành các đoạn kèm màu sắc (hỗ trợ mã màu § và & của Minecraft).
 * Nếu không có mã màu, tự động bôi xanh ký hiệu $ và tô xám thông tin thuế (...) giống server Minecraft.
 */
function parseSegments(rawText) {
  if (!rawText) return [];

  // Trường hợp chuỗi có sẵn mã màu § hoặc &
  if (/[§&][0-9a-fk-or]/i.test(rawText)) {
    const segs = [];
    let curColor = '#ffffff';
    const parts = rawText.split(/([§&][0-9a-fk-or])/i);
    for (const p of parts) {
      if (!p) continue;
      if (/^[§&][0-9a-fk-or]$/i.test(p)) {
        const code = p[1].toLowerCase();
        if (COLOR_MAP[code]) curColor = COLOR_MAP[code];
      } else {
        segs.push({ text: p, color: curColor });
      }
    }
    return segs;
  }

  // Phân tách chuỗi thô:
  // - Nội dung thông thường màu trắng (#ffffff)
  // - Ký hiệu tiền tệ $ màu xanh lá (#55ff55)
  // - Phần thuế trong ngoặc (...) màu xám (#aaaaaa - §7), với ký hiệu $ bên trong vẫn màu xanh lá
  const segs = [];
  const parenParts = rawText.split(/(\([^)]+\))/g);
  for (const part of parenParts) {
    if (!part) continue;
    const isTax = /^\(.*\b(?:tax|thuế|\+).*\)$/i.test(part) || (/^\(/.test(part) && /\)$/.test(part));
    const defaultColor = isTax ? '#aaaaaa' : '#ffffff';

    const subParts = part.split(/(\$)/g);
    for (const sub of subParts) {
      if (!sub) continue;
      if (sub === '$') {
        segs.push({ text: '$', color: '#55ff55' });
      } else {
        segs.push({ text: sub, color: defaultColor });
      }
    }
  }

  return segs;
}

/**
 * Loại bỏ phần thông tin thuế (tax) nếu cần thiết (giữ lại làm tiện ích hỗ trợ).
 */
function stripTaxInfo(text) {
  if (!text) return '';
  return String(text)
    .replace(/\s*(?:[§&][0-9a-fk-or])*\s*\([^)]*(?:tax|thuế)[^)]*\)/gi, '')
    .replace(/(?:[§&][0-9a-fk-or])+\s*$/gi, '')
    .trim();
}

/**
 * Tìm dòng phản hồi hợp lý nhất từ mảng phản hồi in-game của server (giữ nguyên đầy đủ text)
 */
function extractPayResponseLine(lines, ign = '', amount = '') {
  if (!Array.isArray(lines) || lines.length === 0) {
    return ign ? `You paid ${ign} $ ${amount || ''}`.trim() : 'Payment completed successfully';
  }

  const nonCmd = lines.filter((l) => l.kind !== 'cmd');
  if (nonCmd.length === 0) {
    return ign ? `You paid ${ign} $ ${amount || ''}`.trim() : 'Payment completed successfully';
  }

  // Ưu tiên dòng có từ khóa thanh toán hoặc chứa IGN người nhận
  const ignLower = String(ign || '').toLowerCase();
  const keywords = ['paid', 'chuyển', 'đã gửi', 'sent', 'tax', '$', 'money', 'balance', 'thành công'];

  for (const line of nonCmd) {
    const textLower = String(line.text || '').toLowerCase();
    if (keywords.some((k) => textLower.includes(k)) || (ignLower && textLower.includes(ignLower))) {
      return (line.raw || line.text).trim();
    }
  }

  // Dòng ok hoặc chat cuối cùng
  const lastOkOrChat = [...nonCmd].reverse().find((l) => l.kind === 'ok' || l.kind === 'chat');
  if (lastOkOrChat) return (lastOkOrChat.raw || lastOkOrChat.text).trim();

  const lastLine = nonCmd[nonCmd.length - 1];
  return (lastLine.raw || lastLine.text || `You paid ${ign} $ ${amount || ''}`).trim();
}

/**
 * Render ảnh xác nhận /pay trên background Minecraft đã tách chữ.
 * In đầy đủ toàn bộ chữ server trả về (kèm tiền, thuế, tên...).
 * @param {object} p
 * @param {Array<{kind: string, text: string, raw?: string}>} [p.lines] Các dòng phản hồi in-game
 * @param {string} [p.text] Chuỗi phản hồi cần render (nếu chỉ định trực tiếp)
 * @param {string} [p.ign] Tên người nhận tiền
 * @param {string} [p.amount] Số tiền (dùng khi fallback)
 * @returns {Promise<Buffer>} Buffer PNG
 */
async function renderPayCropScreenshot({ lines = [], text = '', ign = '', amount = '' } = {}) {
  ensureFont();

  const displayText = (text || extractPayResponseLine(lines, ign, amount)).trim();
  const bg = await getBackground();

  const fontName = fontRegistered ? 'MinecraftPay' : 'Courier New, monospace';
  const fontSize = 18;

  // Đo chiều rộng chữ cần vẽ
  const measureCanvas = createCanvas(10, 10);
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = `${fontSize}px "${fontName}"`;

  const segs = parseSegments(displayText);
  let textWidth = 0;
  for (const seg of segs) {
    textWidth += measureCtx.measureText(seg.text).width;
  }

  const startX = 17;
  const startY = 17;
  const bgBaseW = bg ? bg.width : 493;
  const bgBaseH = bg ? bg.height : 56;
  const targetW = Math.max(bgBaseW, Math.ceil(startX + textWidth + 30));
  const targetH = bgBaseH;

  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // 1. Vẽ background
  if (bg) {
    if (targetW === bgBaseW) {
      ctx.drawImage(bg, 0, 0);
    } else {
      // Co giãn thông minh: giữ nguyên phần đầu, kéo dài phần giữa/cuối
      const leftW = Math.min(300, bgBaseW - 100);
      ctx.drawImage(bg, 0, 0, leftW, bgBaseH, 0, 0, leftW, bgBaseH);
      const extra = targetW - bgBaseW;
      ctx.drawImage(bg, leftW, 0, 130, bgBaseH, leftW, 0, 130 + extra, bgBaseH);
      const rightW = bgBaseW - (leftW + 130);
      ctx.drawImage(bg, leftW + 130, 0, rightW, bgBaseH, leftW + 130 + extra, 0, rightW, bgBaseH);
    }
  } else {
    // Fallback nền tối nếu thiếu file ảnh
    ctx.fillStyle = '#4a4d52';
    ctx.fillRect(0, 0, targetW, targetH);
  }

  // 2. Vẽ chữ Minecraft
  ctx.font = `${fontSize}px "${fontName}"`;
  ctx.textBaseline = 'top';

  // Lớp bóng chữ (offset lệch +2, +2)
  let curX = startX;
  for (const seg of segs) {
    ctx.fillStyle = darken(seg.color);
    ctx.fillText(seg.text, curX + 2, startY + 2);
    curX += ctx.measureText(seg.text).width;
  }

  // Lớp chữ màu phía trên
  curX = startX;
  for (const seg of segs) {
    ctx.fillStyle = seg.color;
    ctx.fillText(seg.text, curX, startY);
    curX += ctx.measureText(seg.text).width;
  }

  return canvas.encode('png');
}

module.exports = {
  renderPayCropScreenshot,
  extractPayResponseLine,
  stripTaxInfo,
};
