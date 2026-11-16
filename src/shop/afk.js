'use strict';

/**
 * ============================================================
 *  shop/afk.js — Chu kỳ AFK: treo online rồi nghỉ định kỳ
 * ============================================================
 *  Cơ chế lấy từ auto-buy, port sang Bedrock:
 *    • Treo online AFK_ONLINE_MINUTES phút (mặc định 12h)
 *    • Rồi TỰ ĐỘNG out server nghỉ AFK_REST_MINUTES phút (mặc định 1h)
 *      — tránh bị server đánh dấu là bot online 24/7
 *    • Trong giờ nghỉ: KHÓA nút Mua trên Panel Discord
 *    • Hết giờ nghỉ: tự vào lại server (trừ khi admin đã /botoff)
 *
 *  Điều khiển bằng console CMD: /afk status | /afk rest | /afk resume
 *  Bật cơ chế bằng AFK_CYCLE=true trong .env (mặc định tắt).
 */

const { notifyText } = require('../webhook');

const state = {
  enabled: false,
  resting: false,
  phaseSince: null, // thời điểm bắt đầu pha hiện tại
  nextPhaseAt: null, // thời điểm chuyển pha kế tiếp
  timer: null,
  processing: false, // đang bận xử lý 1 đơn (chưa nghỉ giữa chừng được)
};

const config = () => ({
  onlineMin: Math.max(5, Number.parseInt(process.env.AFK_ONLINE_MINUTES, 10) || 720),
  restMin: Math.max(1, Number.parseInt(process.env.AFK_REST_MINUTES, 10) || 60),
});

function logLine(ctx, msg) {
  const line = `[AFK] ${new Date().toLocaleTimeString('vi-VN', { hour12: false })} — ${msg}`;
  console.log(line);
  if (ctx?.io) ctx.io.emit('log', line);
}

/** Bật chu kỳ AFK (gọi khi khởi động shop nếu AFK_CYCLE=true) */
function initAfkCycle(ctx) {
  state.enabled = true;
  const { onlineMin, restMin } = config();
  state.resting = false;
  state.phaseSince = Date.now();
  state.nextPhaseAt = Date.now() + onlineMin * 60 * 1000;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => enterRest(ctx), onlineMin * 60 * 1000);
  logLine(ctx, `Đã bật chu kỳ AFK: online ${onlineMin} phút → nghỉ ${restMin} phút.`);
  return state;
}

/** Cho bot out server để nghỉ ngay lập tức */
async function enterRest(ctx, manual = false) {
  if (state.resting) return state;
  const { restMin } = config();
  state.resting = true;
  state.phaseSince = Date.now();
  state.nextPhaseAt = Date.now() + restMin * 60 * 1000;
  clearTimeout(state.timer);

  logLine(ctx, `💤 ${manual ? 'Nghỉ theo yêu cầu' : 'Hết ca online'} — bot out server ${restMin} phút, khóa nút Mua.`);
  notifyText(ctx.config, `💤 Bot tạm out **${ctx.manager.serverLabel}** để nghỉ ${restMin} phút (chu kỳ AFK). Nút Mua bị khóa trong giờ này.`);

  try {
    await ctx.manager.stop(); // out sạch sẽ, tắt auto-reconnect tạm thời
  } catch (err) {
    logLine(ctx, `Lỗi khi out server: ${err.message}`);
  }

  state.timer = setTimeout(() => resumeOnline(ctx), restMin * 60 * 1000);
  updatePanelSafe(ctx);
  return state;
}

/** Kết thúc nghỉ, vào lại server */
async function resumeOnline(ctx, manual = false) {
  clearTimeout(state.timer);
  if (!state.resting && !manual) return state;

  const { onlineMin } = config();
  state.resting = false;
  state.phaseSince = Date.now();
  state.nextPhaseAt = Date.now() + onlineMin * 60 * 1000;

  // Admin đang chủ động tắt bot -> không tự vào lại
  if (ctx.store.botOff) {
    logLine(ctx, 'Bỏ qua vào lại server vì bot đang ở chế độ TẮT (/botoff).');
    return state;
  }

  logLine(ctx, `🟢 ${manual ? 'Kết thúc nghỉ theo yêu cầu' : 'Hết giờ nghỉ'} — bot vào lại server, mở khóa nút Mua.`);
  notifyText(ctx.config, `🟢 Hết giờ nghỉ AFK — bot đang vào lại **${ctx.manager.serverLabel}**.`);
  try {
    ctx.manager.start();
  } catch (err) {
    logLine(ctx, `Lỗi khi vào lại server: ${err.message}`);
  }
  updatePanelSafe(ctx);
  return state;
}

async function updatePanelSafe(ctx) {
  try {
    const panel = require('./panel');
    await panel.updatePanel(ctx);
  } catch {}
}

/** Trạng thái để hiển thị console / web panel / embed */
function getAfkStatus() {
  const { onlineMin, restMin } = config();
  return {
    enabled: state.enabled,
    resting: state.resting,
    processing: state.processing,
    phaseSince: state.phaseSince,
    nextPhaseAt: state.nextPhaseAt,
    remainingMs: Math.max(0, (state.nextPhaseAt ?? 0) - Date.now()),
    onlineMinutes: onlineMin,
    restMinutes: restMin,
  };
}

/** Khóa mua hay không — dùng chung cho mọi luồng mua hàng */
function getBuyLock(ctx) {
  if (ctx.store.botOff) return 'Bot đang ở chế độ TẮT (botOff). Liên hệ quản trị viên.';
  const status = getAfkStatus();
  if (status.enabled && status.resting) {
    const mins = Math.max(1, Math.round(status.remainingMs / 60000));
    return `Bot đang nghỉ AFK (còn ~${mins} phút nữa sẽ vào lại server). Vui lòng quay lại sau!`;
  }
  return null;
}

function shutdown() {
  clearTimeout(state.timer);
  state.enabled = false;
}

module.exports = {
  initAfkCycle,
  enterRest,
  resumeOnline,
  getAfkStatus,
  getBuyLock,
  setProcessing: (v) => {
    state.processing = !!v;
  },
  shutdown,
};
