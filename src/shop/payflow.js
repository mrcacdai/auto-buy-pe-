'use strict';

/**
 * ============================================================
 *  shop/payflow.js — Luồng chi tiền trong game (dùng chung)
 * ============================================================
 *  • executeGamePay()    : gửi /pay qua BedrockManager, phân loại kết quả
 *  • completeBankOrder() : hoàn tất 1 đơn đã nhận tiền (QR/webhook/retry)
 *  • processRetriesDue() : vòng lặp thử lại các đơn chưa xác nhận
 *
 *  KHÔNG dùng mineflayer (Java) — mọi lệnh chạy qua tài khoản Bedrock
 *  đang online 24/7 của bot (BedrockManager có sẵn hàng đợi tuần tự).
 */

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const orders = require('./orders');
const { formatNumber, formatStock } = require('./format');
const { sendFeedbackThanks } = require('./feedback');

const COLOR_OK = 0x57f287;
const COLOR_WARN = 0xfaa61a;
const COLOR_ERR = 0xed4245;

/* ------------------------------------------------------------------ */
/*  Gửi lệnh /pay trong game                                            */
/* ------------------------------------------------------------------ */

/**
 * Gửi lệnh /pay trong game và phân loại kết quả.
 * @returns {Promise<{state:'verified'|'sent'|'failed'|'offline', lines: Array}>}
 *    verified : server xác nhận lệnh thành công (có dòng "ok")
 *    sent     : đã gửi, không nhận được phản hồi rõ (coi như thành công,
 *               hệ thống retry sẽ kiểm tra lại bằng /balance nếu cần)
 *    failed   : server trả lỗi rõ ràng
 *    offline  : bot chưa vào được server Bedrock
 */
async function executeGamePay(ctx, ign, amountBig) {
  const amountStr = BigInt(amountBig).toString();
  try {
    const lines = await ctx.manager.pay(ign, amountStr);
    const hasOk = lines.some((l) => l.kind === 'ok');
    const hasErr = lines.some((l) => l.kind === 'err');

    // "ok" = server xác nhận thành công; "err" kèm không có "ok" = lỗi rõ ràng
    if (hasOk) return { state: 'verified', lines };
    if (hasErr && !hasOk) return { state: 'failed', lines };
    return { state: 'sent', lines };
  } catch (err) {
    return { state: 'offline', lines: [], error: err.message };
  }
}

/** Kiểm tra bot Bedrock đã online chưa */
function isMcOnline(ctx) {
  return ctx.manager.state === 'online';
}

/* ------------------------------------------------------------------ */
/*  Thông báo                                                           */
/* ------------------------------------------------------------------ */

function webLog(ctx, msg) {
  const line = `[Shop] ${new Date().toLocaleTimeString('vi-VN', { hour12: false })} — ${msg}`;
  console.log(line);
  if (ctx.io) ctx.io.emit('log', line);
}

/** Gửi embed log tới webhook admin (kèm ảnh chụp nếu có) */
async function notifyAdmin(ctx, embed, shotBuffer = null) {
  try {
    const { notifyText, notifyScreenshot } = require('../webhook');
    if (shotBuffer) {
      const parts = [`📋 **${embed.title}**`, ...embed.fields.map((f) => `• ${f.name}: ${String(f.value).replace(/`/g, '')}`)];
      await notifyScreenshot(ctx.config, shotBuffer, parts.join('\n').slice(0, 1900));
      return;
    }
    const parts = [`📋 **${embed.title}**`, ...embed.fields.map((f) => `• ${f.name}: ${String(f.value).replace(/`/g, '')}`)];
    await notifyText(ctx.config, parts.join('\n').slice(0, 1900));
  } catch {}
}

/** DM cho người mua (im lặng nếu không DM được) */
async function dmUser(ctx, userId, payload) {
  try {
    if (!userId) return false;
    const user = await ctx.discord.users.fetch(userId).catch(() => null);
    if (!user) return false;
    await user.send(payload);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Hoàn tất đơn hàng đã nhận tiền                                      */
/* ------------------------------------------------------------------ */

/**
 * Thực hiện /pay cho 1 đơn đã ĐƯỢC thanh toán (chuyển khoản, retry...).
 * Cập nhật trạng thái đơn, kho, thông báo người mua + admin + feedback.
 * @param {object} order Đơn hàng (đã có ign, gameMoney, totalPrice, userId...)
 * @param {object} info  { txId?, receivedAmount?, description?, silent? }
 * @returns {Promise<'COMPLETED'|'WAITING_RETRY'|'OFFLINE_QUEUED'>}
 */
async function completeBankOrder(ctx, order, info = {}) {
  const orderId = order.orderId || order.id;
  const gameMoney = BigInt(order.gameMoney ?? order.amount ?? '0');
  const vnd = Number(order.totalPrice ?? order.amountVnd ?? 0);
  const ign = order.ign;

  orders.updateOrderStatus(orderId, 'PROCESSING');

  // Bot chưa online -> đưa vào hàng đợi retry (đơn đã được thanh toán nên bảo lưu 100%)
  if (!isMcOnline(ctx)) {
    orders.addRetry({ ...order, orderId, attempts: Number(info.attempts ?? 0) }, 2); // thử lại sau 2 phút khi bot online
    orders.updateOrderStatus(orderId, 'WAITING_RETRY', { waitReason: 'Bot Bedrock đang offline' });
    webLog(ctx, `⏳ Đơn ${orderId} (${ign}) chờ bot vào server rồi sẽ tự /pay ${formatStock(gameMoney)}.`);
    return 'OFFLINE_QUEUED';
  }

  webLog(ctx, `🔄 Đang gửi /pay ${ign} ${formatStock(gameMoney)} cho đơn ${orderId}...`);
  const result = await executeGamePay(ctx, ign, gameMoney);

  /* ---------- Lỗi rõ ràng từ server -> retry sau 30 phút ---------- */
  if (result.state === 'failed' || result.state === 'offline') {
    const retry = orders.addRetry({ ...order, orderId, attempts: Number(info.attempts ?? 0) }, 30);
    orders.updateOrderStatus(orderId, 'WAITING_RETRY', {
      waitReason: result.state === 'offline' ? 'Bot Bedrock offline' : 'Server từ chối lệnh /pay',
      lastError: result.error ?? (result.lines ?? []).map((l) => l.text).join(' | ').slice(0, 300),
    });
    orders.markProcessedTx?.(info.txId);

    webLog(ctx, `⚠️ Đơn ${orderId}: chưa /pay được (${result.state}) — hẹn thử lại lần ${retry.attempts} sau 30 phút.`);

    const reasonText =
      result.state === 'offline'
        ? 'Bot Bedrock đang offline, sẽ tự động thử lại.'
        : 'Server Minecraft chưa nhận lệnh, sẽ tự động thử lại sau 30 phút.';
    await dmUser(ctx, order.userId, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_WARN)
          .setTitle('⏳ Đã nhận thanh toán — tiền game sẽ được giao sau')
          .setDescription(
            [
              `Hệ thống **đã nhận được thanh toán** của bạn cho đơn \`${orderId}\`!`,
              '',
              `💰 **Số tiền game:** \`${formatStock(gameMoney)}\``,
              `🎮 **IGN nhận:** \`${ign}\``,
              `⏳ **Trạng thái:** ${reasonText}`,
              '',
              `*Đơn của bạn được bảo lưu 100%. Bot sẽ tự động giao tiền — không cần làm gì thêm.*`,
            ].join('\n')
          )
          .setTimestamp(),
      ],
    });
    await notifyAdmin(ctx, {
      title: 'Đơn chờ giao lại (WAITING_RETRY)',
      fields: [
        { name: 'Mã đơn', value: orderId },
        { name: 'Người mua', value: order.userTag ?? order.userId ?? '—' },
        { name: 'IGN', value: ign },
        { name: 'Tiền game', value: formatStock(gameMoney) },
        { name: 'VNĐ', value: `${formatNumber(vnd)} ${order.currency ?? 'VNĐ'}` },
        { name: 'Lý do', value: result.state },
      ],
    });
    return 'WAITING_RETRY';
  }

  /* ---------- Thành công ---------- */
  const paidLine = (result.lines ?? []).find((l) => l.kind === 'ok');
  orders.updateOrderStatus(orderId, 'COMPLETED', {
    completedAt: new Date().toISOString(),
    bankTxId: info.txId ?? null,
    paidInfo: paidLine?.text?.slice(0, 200) ?? 'đã gửi lệnh',
    receivedAmount: info.receivedAmount ?? null,
  });
  if (info.txId) orders.markProcessedTx(info.txId);
  orders.removeRetry(orderId);

  // Trừ kho (không xuống dưới 0) + cập nhật Panel Discord
  const stockAfter = ctx.store.deductStock(gameMoney);
  if (stockAfter < gameMoney) {
    await notifyAdmin(ctx, {
      title: '⚠️ Kho sắp/không đủ hàng',
      fields: [{ name: 'Kho còn', value: formatStock(stockAfter) }],
    });
  }
  try {
    const panel = require('./panel');
    await panel.updatePanel(ctx);
  } catch {}

  if (ctx.io) ctx.io.emit('configUpdate', ctx.store.data);

  webLog(ctx, `✅ Đơn ${orderId}: ĐÃ /pay ${formatStock(gameMoney)} cho ${ign} (${formatNumber(vnd)} ${order.currency ?? 'VNĐ'}).`);

  // Thông báo thành công cho người mua kèm ảnh chụp tách nền /pay
  const fileName = `pay-${orderId}.png`;
  let shotFile = null;
  let shotBuffer = null;
  try {
    const { renderPayCropScreenshot } = require('../screenshot');
    shotBuffer = await renderPayCropScreenshot({
      lines: result.lines,
      ign,
      amount: formatStock(gameMoney),
    });
    if (shotBuffer) {
      shotFile = new AttachmentBuilder(shotBuffer, { name: fileName });
    }
  } catch (err) {
    console.warn(`[Shop] Render pay proof lỗi: ${err.message}`);
  }

  const successEmbed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('🎉 Mua Tiền Game Thành Công!')
    .setDescription(
      [
        `Giao dịch của bạn đã hoàn tất — tiền game đã được chuyển in-game!`,
        '',
        `🆔 **Mã đơn:** \`${orderId}\``,
        `💰 **Số tiền nhận:** \`${formatStock(gameMoney)}\` (${formatNumber(Number(gameMoney))} in-game)`,
        `🎮 **IGN nhận:** \`${ign}\``,
        `🤖 **Lệnh đã chạy:** \`/pay ${ign} ${formatStock(gameMoney)}\``,
        paidLine ? `🖥️ **Server xác nhận:** \`${paidLine.text.slice(0, 120)}\`` : '',
        '',
        `*Chúc bạn chơi game vui vẻ! Có vấn đề gì hãy liên hệ quản trị viên.*`,
      ]
        .filter(Boolean)
        .join('\n')
    )
    .setTimestamp();

  if (shotFile) {
    successEmbed.setImage(`attachment://${fileName}`);
  }

  const dmPayload = shotFile ? { embeds: [successEmbed], files: [shotFile] } : { embeds: [successEmbed] };
  await dmUser(ctx, order.userId, dmPayload);

  if (!info.silent) {
    await notifyAdmin(
      ctx,
      {
        title: 'Đơn hàng COMPLETED',
        fields: [
          { name: 'Mã đơn', value: orderId },
          { name: 'Người mua', value: order.userTag ?? order.userId ?? '—' },
          { name: 'IGN', value: ign },
          { name: 'Tiền game', value: `${formatStock(gameMoney)} (${formatNumber(Number(gameMoney))})` },
          { name: 'Thanh toán', value: `${formatNumber(vnd)} ${order.currency ?? 'VNĐ'}` },
          { name: 'Phương thức', value: order.paymentMethod ?? 'Ngân hàng' },
          ...(info.description ? [{ name: 'Nội dung CK', value: info.description.slice(0, 200) }] : []),
        ],
      },
      shotBuffer
    );
  }

  // Lời cảm ơn vào kênh feedback
  try {
    await sendFeedbackThanks(ctx, {
      userId: order.userId,
      ign,
      gameMoney: formatStock(gameMoney),
      vnd,
      paymentMethod: order.paymentMethod ?? 'Chuyển khoản ngân hàng',
    });
  } catch {}

  return 'COMPLETED';
}

/* ------------------------------------------------------------------ */
/*  Vòng lặp thử lại các đơn chờ                                        */
/* ------------------------------------------------------------------ */

/** Xử lý các đơn đến hạn thử lại (gọi định kỳ mỗi phút từ shop/index.js) */
async function processRetriesDue(ctx) {
  const list = orders.readRetries();
  const now = Date.now();
  let changed = false;

  for (const item of list) {
    if (item.nextAttemptAt > now) continue;

    // Bot chưa online -> giữ đơn trong hàng chờ, KHÔNG tính là 1 lần thử
    // (bot có thể offline hàng giờ mà đơn khách đã trả tiền vẫn phải bảo lưu)
    if (!isMcOnline(ctx)) continue;

    if (item.attempts > 5) {
      // Quá 5 lần — đánh dấu FAILED và bàn giao cho admin
      orders.updateOrderStatus(item.orderId, 'FAILED', { failReason: `Thử ${item.attempts} lần chưa được` });
      orders.removeRetry(item.orderId);
      changed = true;
      webLog(ctx, `❌ Đơn ${item.orderId} thất bại sau ${item.attempts} lần thử — CẦN ADMIN XỬ LÝ THỦ CÔNG.`);
      await notifyAdmin(ctx, {
        title: '❌ Đơn FAILED — cần xử lý thủ công',
        fields: [
          { name: 'Mã đơn', value: item.orderId },
          { name: 'Người mua', value: item.userTag },
          { name: 'IGN', value: item.ign },
          { name: 'Tiền game', value: formatStock(item.gameMoney) },
          { name: 'VNĐ', value: formatNumber(item.amountVnd) },
        ],
      });
      await dmUser(ctx, item.userId, {
        content: `❌ Đơn \`${item.orderId}\` của bạn chưa thể giao tiền tự động sau nhiều lần thử. Quản trị viên sẽ xử lý thủ công — bạn sẽ được thông báo sớm nhất!`,
      });
      continue;
    }

    const order = orders.getOrder(item.orderId);
    if (!order || order.status === 'COMPLETED' || order.status === 'EXPIRED') {
      orders.removeRetry(item.orderId);
      changed = true;
      continue;
    }

    changed = true;
    orders.removeRetry(item.orderId); // remove trước để không xử lý trùng
    await completeBankOrder(ctx, order, { silent: false, attempts: item.attempts });
    break; // mỗi chu kỳ chỉ xử lý 1 đơn để khỏi dồn lệnh /pay
  }

  return changed;
}

module.exports = { executeGamePay, isMcOnline, completeBankOrder, processRetriesDue, webLog, dmUser, notifyAdmin };
