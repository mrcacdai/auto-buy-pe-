'use strict';

/**
 * ============================================================
 *  hud.js — Vẽ lớp giao diện (HUD) GIỐNG 100% ảnh F2 Minecraft PC
 * ============================================================
 *  Mô phỏng chính xác bố cục HUD khi bấm F2 trong Minecraft (Java):
 *   - Tâm ngắm (crosshair) ở giữa, blend "difference" như game thật
 *   - Tim + thanh đói phía trên thanh XP (2 bên), thanh XP xanh lá
 *   - Hotbar 9 ô dưới cùng, ô đang chọn có viền trắng đậm hơn
 *   - Khung chat dưới-trái: nền đen mờ PER-LINE (không bo góc),
 *     chữ có BÓNG (shadow lệch 2px) như font Minecraft
 *   - KHÔNG có watermark nào trên ảnh (đúng chuẩn F2).
 *     Bật SCREENSHOT_WATERMARK=true nếu muốn in tên server/phiên bản.
 *
 *  Tỷ lệ dựa trên GUI scale 2 của game (mỗi "pixel game" = 2 pixel ảnh).
 */

const fs = require('fs');
const { GlobalFonts } = require('@napi-rs/canvas');

// Đăng ký font có sẵn hỗ trợ tiếng Việt (DejaVu trên Linux, Arial trên Windows/macOS)
const FONT_CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 'MCPayUI'],
  ['/usr/share/fonts/dejavu/DejaVuSans.ttf', 'MCPayUI'],
  ['/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf', 'MCPayUI'],
  ['C:\\Windows\\Fonts\\arial.ttf', 'MCPayUI'],
  ['/System/Library/Fonts/Supplemental/Arial.ttf', 'MCPayUI'],
];
const FONT_BOLD_CANDIDATES = [
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'MCPayUI'],
  ['/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', 'MCPayUI'],
  ['C:\\Windows\\Fonts\\arialbd.ttf', 'MCPayUI'],
  ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', 'MCPayUI'],
];

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  fontsReady = true;
  try {
    for (const [file, family] of FONT_CANDIDATES) {
      if (fs.existsSync(file)) {
        GlobalFonts.registerFromPath(file, family);
        break;
      }
    }
    for (const [file, family] of FONT_BOLD_CANDIDATES) {
      if (fs.existsSync(file)) {
        GlobalFonts.registerFromPath(file, family);
        break;
      }
    }
  } catch {
    /* không đăng ký được thì dùng font hệ thống mặc định */
  }
}

/** Chuỗi font CSS dùng cho ctx.font */
function font(size, bold = false) {
  return `${bold ? 'bold ' : ''}${size}px "MCPayUI", "DejaVu Sans", "Segoe UI", Arial, sans-serif`;
}

/** Cắt bớt text quá dài để vừa panel (đo bằng measureText) */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) {
    text = text.slice(0, -1);
  }
  return `${text}…`;
}

/** Làm tối màu hex (#rrggbb) cho lớp bóng chữ — Minecraft đổ bóng 25% độ sáng */
function darken(hex, factor = 0.25) {
  const m = hex.replace('#', '');
  const r = Math.round(parseInt(m.slice(0, 2), 16) * factor);
  const g = Math.round(parseInt(m.slice(2, 4), 16) * factor);
  const b = Math.round(parseInt(m.slice(4, 6), 16) * factor);
  return `rgb(${r},${g},${b})`;
}

/**
 * Vẽ chữ kiểu Minecraft: lớp bóng tối lệch (+2,+2) trước, chữ màu sau.
 * @param {boolean} [bold]
 */
function drawMcText(ctx, text, x, y, color, size, bold = false) {
  ctx.font = font(size, bold);
  ctx.fillStyle = darken(color);
  ctx.fillText(text, x + 2, y + 2);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/* ------------------------------------------------------------------ */
/*  Tâm ngắm (crosshair) — blend difference như Java                    */
/* ------------------------------------------------------------------ */

function drawCrosshair(ctx, size) {
  const cx = Math.round(size.width / 2);
  const cy = Math.round(size.height / 2);
  const half = 9; // nửa chiều dài, tổng 18px = 9 "pixel game" × scale 2
  ctx.save();
  ctx.globalCompositeOperation = 'difference'; // đảo màu nền — y như crosshair Java
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(cx - half, cy - 1, half * 2, 2); // thanh ngang
  ctx.fillRect(cx - 1, cy - half, 2, half * 2); // thanh dọc
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/*  Khung chat dưới-trái — nền per-line, bóng chữ, kiểu Java            */
/* ------------------------------------------------------------------ */

const CHAT_COLORS = {
  cmd: '#FFFFFF',
  ok: '#FFFF55', // vàng nhạt — màu thông báo hệ thống
  err: '#FF5555', // đỏ — màu lỗi
  chat: '#FFFFFF',
};

function drawChatPanel(ctx, lines, size) {
  const fontSize = 16;
  const lineHeight = 18; // 9 "pixel game" × 2
  const gap = 1;
  const left = 8; // lệch 4 "pixel game" từ mép trái
  const bottom = size.height - 48; // phía trên hotbar
  const maxWidth = Math.min(760, size.width * 0.55);
  const maxLines = 10;

  ensureFonts();
  ctx.save();
  ctx.textBaseline = 'top';

  // Chuẩn bị dòng (lấy tối đa maxLines dòng cuối)
  const shown = lines.slice(-maxLines).map((line) => {
    ctx.font = font(fontSize, line.kind === 'cmd');
    const color = CHAT_COLORS[line.kind] ?? '#FFFFFF';
    return { text: fitText(ctx, line.text, maxWidth), color, bold: line.kind === 'cmd' };
  });

  // Dòng càng cũ càng mờ đi một chút (mô phỏng hiệu ứng fade của Java)
  let y = bottom - shown.length * (lineHeight + gap);
  for (let i = 0; i < shown.length; i++) {
    const line = shown[i];
    const ageFromBottom = shown.length - 1 - i;
    const alpha = ageFromBottom <= 2 ? 1 : Math.max(0.45, 1 - (ageFromBottom - 2) * 0.09);
    ctx.globalAlpha = alpha;

    // Nền đen mờ theo ĐÚNG chiều dài chữ (Java vẽ nền từng dòng, không bo góc)
    const w = ctx.measureText(line.text).width + 8;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fillRect(left - 2, y, w, lineHeight);

    drawMcText(ctx, line.text, left + 2, y + 1, line.color, fontSize, line.bold);
    y += lineHeight + gap;
  }
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/*  Hotbar + XP bar + tim + thanh đói                                   */
/* ------------------------------------------------------------------ */

/**
 * Vẽ 1 tim 9x9 (x2) tại (x, y). fill: 'full' | 'half' | 'empty'
 */
function drawHeart(ctx, x, y, mode) {
  const path = () => {
    ctx.beginPath();
    ctx.arc(x + 5, y + 6, 4.4, Math.PI * 0.95, Math.PI * 1.95);
    ctx.arc(x + 13, y + 6, 4.4, Math.PI * 1.05, Math.PI * 2.05);
    ctx.lineTo(x + 9, y + 17.5);
    ctx.closePath();
  };
  // Viền đen ngoài
  path();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#1a0a0a';
  ctx.stroke();
  // Ruột
  path();
  if (mode === 'empty') {
    ctx.fillStyle = '#3d3d3d';
  } else if (mode === 'half') {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, 9, 18); // nửa trái
    ctx.clip();
    ctx.fillStyle = '#e01f1f';
    ctx.fill();
    ctx.restore();
    path();
    ctx.fillStyle = '#3d3d3d';
  } else {
    ctx.fillStyle = '#e01f1f';
  }
  ctx.fill();
  // Điểm sáng trắng góc trên-trái (đặc trưng icon tim MC)
  if (mode !== 'empty') {
    ctx.fillStyle = mode === 'half' ? 'rgba(255,120,120,0.9)' : 'rgba(255,140,140,0.9)';
    ctx.fillRect(x + 3, y + 4, 2.5, 2.5);
  }
}

/**
 * Vẽ 1 miếng thịt nướng (drumstick) 9x9 (x2) tại (x, y).
 */
function drawHunger(ctx, x, y, mode) {
  const meat = () => {
    ctx.beginPath();
    ctx.arc(x + 11.5, y + 5.5, 4.6, 0, Math.PI * 2);
    ctx.arc(x + 7.5, y + 8.5, 3.4, 0, Math.PI * 2);
  };
  const bone = () => {
    ctx.beginPath();
    ctx.moveTo(x + 6.5, y + 10.5);
    ctx.lineTo(x + 3, y + 14.5);
    ctx.lineWidth = 3.2;
    ctx.strokeStyle = '#e8e2cf';
    ctx.lineCap = 'round';
  };
  // Viền
  meat();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#1a0d05';
  ctx.stroke();
  bone();
  ctx.stroke();
  // Ruột
  if (mode === 'empty') {
    meat();
    ctx.fillStyle = '#3d3d3d';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 6.5, y + 10.5);
    ctx.lineTo(x + 3, y + 14.5);
    ctx.strokeStyle = '#5a5a5a';
    ctx.stroke();
  } else {
    meat();
    ctx.fillStyle = '#a9662f';
    ctx.fill();
    // Sốt nâu đậm ở phần thịt trên
    ctx.fillStyle = 'rgba(80, 42, 15, 0.45)';
    ctx.fillRect(x + 9, y + 3, 5, 3);
    bone();
    ctx.stroke();
  }
}

function drawHotbar(ctx, size) {
  const S = 2; // GUI scale 2
  const barW = 182 * S; // 364
  const barH = 22 * S; // 44
  const left = Math.round((size.width - barW) / 2);
  const top = size.height - barH; // dính sát mép dưới như Java

  ctx.save();
  // Nền + viền xám đặc trưng của sprite hotbar
  ctx.fillStyle = 'rgba(12, 12, 12, 0.62)';
  ctx.fillRect(left, top, barW, barH);
  ctx.strokeStyle = '#8b8b8b';
  ctx.lineWidth = 2;
  ctx.strokeRect(left + 1, top + 1, barW - 2, barH - 2);

  // Vách ngăn giữa các ô (9 ô, mỗi ô 40px)
  ctx.strokeStyle = 'rgba(139, 139, 139, 0.85)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 9; i++) {
    const x = left + i * 40;
    ctx.beginPath();
    ctx.moveTo(x, top + 2);
    ctx.lineTo(x, top + barH - 2);
    ctx.stroke();
  }

  // Ô đang chọn: viền trắng toả ra ngoài ô (sprite selection 24x24 của Java)
  const sel = 0;
  const sx = left + sel * 40;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 4;
  ctx.strokeRect(sx - 2, top - 2, 44, barH + 4);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
  ctx.lineWidth = 2;
  ctx.strokeRect(sx - 4, top - 4, 48, barH + 8);
  ctx.restore();
}

function drawXpBar(ctx, size, { xp = 0.62, xpLevel = 27 }) {
  const S = 2;
  const barW = 182 * S;
  const barH = 5 * S; // 10
  const left = Math.round((size.width - barW) / 2);
  const top = size.height - 44 - barH; // nằm sát trên hotbar

  ctx.save();
  // Nền rỗng
  ctx.fillStyle = '#151515';
  ctx.fillRect(left, top, barW, barH);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = 2;
  ctx.strokeRect(left + 1, top + 1, barW - 2, barH - 2);
  // Thanh kinh nghiệm xanh lá
  const fillW = Math.round(barW * Math.min(1, Math.max(0, xp)));
  if (fillW > 0) {
    ctx.fillStyle = '#7efc20';
    ctx.fillRect(left + 2, top + 2, fillW - 4, barH - 4);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.fillRect(left + 2, top + 2, fillW - 4, 1);
  }
  // Cấp độ ở giữa, chữ xanh có bóng đen (đúng style số cấp Java)
  if (xpLevel > 0) {
    const text = String(xpLevel);
    ctx.font = font(17, true);
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(text).width;
    const tx = size.width / 2 - tw / 2;
    const ty = top - 20;
    for (const [dx, dy] of [[2, 2], [-1, 0], [0, -1], [1, 0], [0, 1]]) {
      ctx.fillStyle = '#0b2a00';
      ctx.fillText(text, tx + dx, ty + dy);
    }
    ctx.fillStyle = '#7efc20';
    ctx.fillText(text, tx, ty);
  }
  ctx.restore();
}

function drawStatusBars(ctx, size, { health = 20, hunger = 20, xp, xpLevel }) {
  const S = 2;
  const barW = 182 * S;
  const left = Math.round((size.width - barW) / 2);
  const iconSize = 18;
  const spacing = 16; // các icon cách nhau 8 "pixel game"
  const rowBottom = size.height - 44 - 10 - 4; // trên XP bar 4px
  const rowY = rowBottom - iconSize;

  // --- Tim (bên trái) ---
  const hearts = Math.round(health / 2); // 20 = 10 tim
  for (let i = 0; i < 10; i++) {
    const x = left + i * spacing;
    const mode = i + 1 <= hearts ? 'full' : i + 0.5 === hearts ? 'half' : 'empty';
    drawHeart(ctx, x, rowY, mode);
  }

  // --- Thanh đói (bên phải, vẽ phải sang trái như Java) ---
  const drumsticks = Math.round(hunger / 2);
  for (let i = 0; i < 10; i++) {
    const x = left + barW - iconSize - i * spacing;
    const mode = i + 1 <= drumsticks ? 'full' : i + 0.5 === drumsticks ? 'half' : 'empty';
    drawHunger(ctx, x, rowY, mode);
  }

  drawXpBar(ctx, size, { xp, xpLevel });
}

/* ------------------------------------------------------------------ */
/*  Watermark (tuỳ chọn — MẶC ĐỊNH TẮT để ảnh giống F2 100%)           */
/* ------------------------------------------------------------------ */

function drawWatermark(ctx, size, meta) {
  ctx.save();
  ensureFonts();
  ctx.textBaseline = 'top';
  ctx.font = font(17, true);

  const topLeft = `Server: ${meta.server || '—'}   •   Bot: ${meta.botName || 'Bot'}`;
  const topLeftWidth = ctx.measureText(topLeft).width + 20;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.roundRect(12, 12, topLeftWidth, 30, 6);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(topLeft, 22, 18);

  ctx.textAlign = 'right';
  const topRight = `Minecraft Bedrock • ${meta.version || 'latest'}`;
  const topRightWidth = ctx.measureText(topRight).width + 20;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.roundRect(size.width - topRightWidth - 12, 12, topRightWidth, 30, 6);
  ctx.fill();
  ctx.fillStyle = '#AAFFAA';
  ctx.fillText(topRight, size.width - 22, 18);
  ctx.textAlign = 'left';

  ctx.font = font(14);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
  ctx.fillText(meta.footer || new Date().toLocaleString('vi-VN', { hour12: false }), size.width - 16, size.height - 34);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/*  Tổng hợp                                                            */
/* ------------------------------------------------------------------ */

/**
 * Vẽ toàn bộ HUD chuẩn F2 lên canvas đã có nền (thế giới 3D hoặc gradient).
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} p
 * @param {Array<{text: string, kind: string}>} p.lines   Các dòng chat/kết quả
 * @param {{server?: string, version?: string, botName?: string, footer?: string,
 *          health?: number, hunger?: number, xp?: number, xpLevel?: number}} p.meta
 * @param {{width: number, height: number}} p.size
 * @param {boolean} [p.watermark=false] Bật watermark server/phiên bản (mặc định tắt)
 */
function drawHud(ctx, { lines = [], meta = {}, size, watermark = false }) {
  ensureFonts();

  // Thứ tự lớp giống Java: crosshair -> hotbar -> tim/đói/XP -> CHAT (trên cùng) -> watermark
  drawCrosshair(ctx, size);
  drawHotbar(ctx, size);
  drawStatusBars(ctx, size, meta);
  drawChatPanel(ctx, lines, size);
  if (watermark) drawWatermark(ctx, size, meta);
}

module.exports = { drawHud, ensureFonts, font, drawMcText };
