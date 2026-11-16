'use strict';

/**
 * ============================================================
 *  web/routes/bank.js — WEBHOOK THANH TOÁN (Casso / Thẻ cào)
 * ============================================================
 *  A) POST /api/webhook/bank  — Casso (hoặc dịch vụ webhook ngân hàng
 *     tương tự) đẩy DANH SÁCH giao dịch về; hệ thống:
 *       1. Bỏ qua giao dịch đã xử lý (chống trùng tuyệt đối)
 *       2. Đối soát với đơn hàng đang chờ (RAM + data/orders.json):
 *            • khớp MÃ ĐƠN trong nội dung chuyển khoản (DHxxxxxx)  — chính xác nhất
 *            • hoặc cú pháp cũ "muamon <ign> <số>" / "muamon <số> <ign>"
 *            • hoặc IGN + từ khóa + số tiền khớp
 *       3. Không tìm thấy đơn -> thử tự nhận diện "muamon <ign> <số>"
 *          để tạo đơn trực tiếp (không cần đặt qua Discord)
 *       4. Khớp & đủ tiền -> bot Bedrock TỰ /pay trong game, cập nhật
 *          kho, DM người mua, log admin, cảm ơn kênh feedback
 *       5. Chưa /pay được -> hàng chờ tự thử lại (30 phút/lần, tối đa 5 lần)
 *
 *  B) POST /charge/callback — hệ thống thẻ cào gọi về khi duyệt thẻ:
 *       cộng tiền vào SỐ DƯ CÁ NHÂN của thành viên + DM thông báo.
 *
 *  Bảo mật: nếu cấu hình BANK_WEBHOOK_SECRET, URL phải kèm
 *  ?secret=... (hoặc body/header secret) mới được chấp nhận.
 */

const express = require('express');
const orders = require('../../src/shop/orders');
const balances = require('../../src/shop/balances');
const cardService = require('../../src/shop/cardService');
const { formatNumber, formatStock } = require('../../src/shop/format');
const { completeBankOrder, webLog, dmUser, notifyAdmin } = require('../../src/shop/payflow');

/** Chuẩn hóa nội dung CK: bỏ dấu tiếng Việt + ký tự đặc biệt, viết thường */
function normalizeDesc(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Đối soát 1 giao dịch với danh sách đơn chờ.
 * @returns {{ order: object, matchType: string } | null}
 */
function findMatchingPendingOrder(candidateOrders, actualDesc, receivedAmount) {
  for (const pending of candidateOrders) {
    const cleanIgn = String(pending.ignForMemo ?? (pending.ign ?? '')).toLowerCase().replace(/[^a-z0-9]/g, '');
    const orderIdClean = String(pending.orderId ?? pending.id ?? '').toLowerCase().replace(/[^a-z0-9]/g, ''); // dh839120
    const orderIdNumOnly = orderIdClean.replace(/^dh/, ''); // 839120

    const rawAmountClean = String(pending.rawAmount ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const numericAmountStr = pending.gameMoney ? String(pending.gameMoney) : '';

    const memoVariants = [
      `muamon${orderIdClean}`,
      `muamon${cleanIgn}${rawAmountClean}`,
      `muamon${rawAmountClean}${cleanIgn}`,
      `muamon${cleanIgn}${numericAmountStr}`,
    ].filter(Boolean);

    const expectedVnd = Number(pending.totalPrice ?? pending.amountVnd ?? 0);
    const amountMatches = expectedVnd > 0 && receivedAmount >= expectedVnd;

    // 1) Khớp mã đơn (chính xác nhất)
    const matchOrderId =
      (orderIdClean.length >= 8 && actualDesc.includes(orderIdClean)) ||
      (orderIdNumOnly.length >= 6 && actualDesc.includes(orderIdNumOnly));
    if (matchOrderId && amountMatches) {
      return { order: pending, matchType: `mã đơn: \`${orderIdClean}\`` };
    }

    // 2) Khớp cú pháp memo đầy đủ
    if (memoVariants.some((m) => actualDesc.includes(m)) && amountMatches) {
      return { order: pending, matchType: `cú pháp memo đơn \`${orderIdClean}\`` };
    }

    // 3) IGN + từ khóa + số tiền
    const hasIgn = cleanIgn.length >= 3 && actualDesc.includes(cleanIgn);
    const hasKeyword = /muamon|autobuy|muatien|pay/.test(actualDesc);
    if (hasIgn && hasKeyword && amountMatches) {
      return { order: pending, matchType: `IGN [${cleanIgn}] + từ khóa + số tiền` };
    }
    if (hasIgn && expectedVnd > 0 && receivedAmount === expectedVnd) {
      return { order: pending, matchType: `IGN [${cleanIgn}] + đúng số tiền` };
    }
  }
  return null;
}

/**
 * Tự nhận diện đơn từ nội dung CK: "muamon <ign> <số>" (hoặc ngược lại).
 * Xử lý cả trường hợp ngân hàng chèn khoảng trắng vào giữa số.
 * @returns {{ ign: string, rawAmount: string, amount: BigInt } | null}
 */
function parseMemoDirect(text) {
  if (!text) return null;
  const clean = String(text)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9.\s]/g, ' ')
    .trim();
  if (!/\bmuamon\b|\bmuatien\b|\bpay\b/i.test(clean)) return null;

  // Pattern 1: từ khóa <ign> <amount>
  const m1 = clean.match(/(?:muamon|muatien|pay)\s+([a-zA-Z0-9_.~]{2,32}?)\s+(\d+(?:\s*\d+)*\s*(?:k|m|b|t)?)(?:[^a-zA-Z0-9]|$)/i);
  if (m1) {
    const ign = m1[1].replace(/\s+/g, '');
    const rawAmount = m1[2].replace(/\s+/g, '');
    if (ign.length >= 3) {
      const parsed = require('../../src/shop/format').parseGameAmount(rawAmount);
      if (parsed.ok) return { ign, rawAmount, amount: parsed.value };
    }
  }

  // Pattern 2: từ khóa <amount> <ign> (CHÚ Ý: m[1] là SỐ TIỀN, m[2] là IGN)
  const m2 = clean.match(/(?:muamon|muatien|pay)\s+(\d+(?:\s*\d+)*\s*(?:k|m|b|t)?)\s+([a-zA-Z0-9_.~]{2,32}?)(?:(?:\s|$|tu:|ft))/i);
  if (m2) {
    const ign = m2[2].replace(/\s+/g, '');
    const rawAmount = m2[1].replace(/\s+/g, '');
    if (ign.length >= 3) {
      const parsed = require('../../src/shop/format').parseGameAmount(rawAmount);
      if (parsed.ok) return { ign, rawAmount, amount: parsed.value };
    }
  }

  return null;
}

/* ================================================================== */
/*  Xử lý giao dịch ngân hàng                                          */
/* ================================================================== */

async function processTransactions(ctx, transactions, io) {
  if (!Array.isArray(transactions) || transactions.length === 0) return;

  for (const tx of transactions) {
    const txId = orders.getTransactionId(tx);
    if (!txId) continue;

    const description = String(tx.description ?? tx.content ?? tx.remark ?? tx.desc ?? tx.memo ?? tx.addInfo ?? tx.message ?? '').trim();
    const rawAmountVal = tx.amount ?? tx.creditAmount ?? tx.transferAmount ?? tx.soTien ?? 0;
    const receivedAmount = Math.abs(parseFloat(rawAmountVal) || 0);
    const actualDesc = normalizeDesc(description);

    webLog(ctx, `🔔 Giao dịch đến: ${formatNumber(receivedAmount)} VNĐ — "${description.slice(0, 120)}"`);

    /* ---- 0. Chống trùng tuyệt đối ---- */
    if (orders.isProcessedTx(txId)) {
      webLog(ctx, `⚠️ Bỏ qua: giao dịch ${txId} đã xử lý trước đó.`);
      continue;
    }

    let alreadyDone = false;
    const allOrders = orders.readOrders();
    for (const ord of Object.values(allOrders)) {
      if (ord.status !== 'COMPLETED') continue;
      const ordId = String(ord.orderId ?? ord.id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const ordNum = ordId.replace(/^dh/, '');
      if (
        (ordId.length >= 8 && actualDesc.includes(ordId)) ||
        (ordNum.length >= 6 && actualDesc.includes(ordNum)) ||
        (ord.bankTxId && ord.bankTxId === txId)
      ) {
        webLog(ctx, `⚠️ Bỏ qua: giao dịch thuộc đơn [${ord.orderId}] ĐÃ HOÀN THÀNH trước đó.`);
        orders.markProcessedTx(txId);
        alreadyDone = true;
        break;
      }
    }
    if (alreadyDone) continue;

    /* ---- 1. Danh sách đơn đang chờ (RAM + disk) ---- */
    const candidates = [];
    const seen = new Set();
    for (const [, pending] of ctx.discord.pendingOrders ?? []) {
      const id = String(pending.orderId ?? '').toUpperCase();
      if (id) seen.add(id);
      candidates.push(pending);
    }
    for (const [key, ord] of Object.entries(allOrders)) {
      const id = String(ord.orderId ?? ord.id ?? key).toUpperCase();
      if (seen.has(id)) continue;
      const isPending = ord.status === 'PENDING_PAYMENT';
      const recentExpired =
        ord.status === 'EXPIRED' && ord.createdAt && Date.now() - new Date(ord.createdAt).getTime() < 2 * 60 * 60 * 1000;
      if (!isPending && !recentExpired) continue;
      candidates.push({ ...ord, orderId: id });
    }

    /* ---- 2. Tìm đơn khớp ---- */
    let match = findMatchingPendingOrder(candidates, actualDesc, receivedAmount);
    let order = match?.order ?? null;
    if (match) webLog(ctx, `🎯 Khớp đơn theo ${match.matchType}`);

    /* ---- 3. Không có đơn -> thử tự nhận diện và tạo đơn mới ---- */
    if (!order) {
      const direct = parseMemoDirect(description);
      if (direct) {
        const { baseAmount, basePrice, currency } = ctx.store.price;
        const expectedPrice = Number((direct.amount * BigInt(Math.floor(basePrice))) / BigInt(Math.floor(baseAmount)));
        if (receivedAmount >= expectedPrice) {
          const orderId = orders.generateOrderId();
          order = {
            orderId,
            userId: null,
            userTag: direct.ign,
            ign: direct.ign,
            ignForMemo: direct.ign.replace(/[^a-zA-Z0-9]/g, ''),
            gameMoney: direct.amount.toString(),
            amount: direct.amount.toString(),
            rawAmount: direct.rawAmount,
            totalPrice: expectedPrice,
            currency: currency || 'VNĐ',
            paymentMethod: 'Ngân hàng (tự nhận diện nội dung)',
            status: 'PENDING_PAYMENT',
            createdAt: new Date().toISOString(),
          };
          orders.saveOrder(order);
          webLog(ctx, `🎯 TỰ ĐỘNG TẠO ĐƠN từ nội dung CK: IGN=${direct.ign}, ${formatStock(direct.amount)}, nhận ${formatNumber(receivedAmount)} VNĐ — mã ${orderId}`);
        } else {
          webLog(ctx, `⚠️ Nhận diện được (${direct.ign} ${direct.rawAmount}) nhưng thiếu tiền: nhận ${formatNumber(receivedAmount)}, cần ${formatNumber(expectedPrice)}. Bỏ qua.`);
          continue;
        }
      }
    }

    if (!order) {
      webLog(ctx, `⚠️ Không tìm thấy đơn chờ nào khớp với nội dung trên — sẽ đợi khách tạo đơn trong 5 phút tới.`);
      continue;
    }

    /* ---- 4. Kiểm tra kho còn hàng không (vẫn giao, nhưng cảnh báo) ---- */
    const gameMoney = BigInt(order.gameMoney ?? order.amount ?? '0');
    if (gameMoney > ctx.store.getStock()) {
      await notifyAdmin(ctx, {
        title: '⚠️ Đơn có tiền NHƯNG kho không đủ',
        fields: [
          { name: 'Mã đơn', value: String(order.orderId) },
          { name: 'IGN', value: String(order.ign) },
          { name: 'Cần', value: formatStock(gameMoney) },
          { name: 'Kho còn', value: formatStock(ctx.store.getStock()) },
        ],
      });
    }

    /* ---- 5. Giao tiền ---- */
    const result = await completeBankOrder(ctx, order, {
      txId,
      receivedAmount,
      description,
      attempts: 0,
    });
    if (result === 'COMPLETED') {
      io?.emit('configUpdate', ctx.store.data);
    }
  }
}

/* ================================================================== */
/*  Router                                                             */
/* ================================================================== */

module.exports = function bankRouter({ config, manager, getContext, io }) {
  const router = express.Router();

  const checkSecret = (req) => {
    const secret = (process.env.BANK_WEBHOOK_SECRET || '').trim();
    if (!secret) return true;
    const provided =
      req.query.secret ?? req.headers['x-secret'] ?? req.headers['x-webhook-secret'] ?? req.body?.secret ?? '';
    return String(provided) === secret;
  };

  /** POST /bank — webhook ngân hàng (Casso...) */
  router.post('/bank', async (req, res) => {
    if (!checkSecret(req)) {
      return res.status(401).json({ error: 1, message: 'Sai secret' });
    }

    const ctx = getContext?.();
    if (!ctx) {
      return res.status(503).json({ error: 1, message: 'Shop chưa sẵn sàng' });
    }

    // Casso gửi { error: 0, data: [ {...}, ... ] } — cũng chấp nhận mảng trần hoặc 1 đối tượng
    let transactions = [];
    const body = req.body ?? {};
    if (Array.isArray(body)) transactions = body;
    else if (Array.isArray(body.data)) transactions = body.data;
    else if (Array.isArray(body.transactions)) transactions = body.transactions;
    else if (body.description !== undefined || body.amount !== undefined) transactions = [body];

    try {
      await processTransactions(ctx, transactions, io);
      res.json({ error: 0, message: 'OK' });
    } catch (err) {
      console.error(`[Webhook/Bank] Lỗi xử lý: ${err.message}`);
      res.status(200).json({ error: 0, message: 'OK (lỗi nội bộ đã ghi log)' }); // vẫn 200 để tránh Casso gửi lại vô hạn
    }
  });

  /**
   * Xử lý callback kết quả gạch thẻ cào từ hệ thống đối tác
   * Chuẩn theo tài liệu Postman: https://documenter.getpostman.com/view/5740908/TVYJ5Ggr
   * Hỗ trợ cả 2 phương thức:
   *   • POST JSON: { status, request_id, declared_value, value, amount, code, serial, telco, callback_sign }
   *   • GET query: ?status=1&request_id=...&callback_sign=...
   */
  const handleCardCallback = async (req, res) => {
    // Nếu có gửi secret trên URL/header thì kiểm tra; nếu không có secret thì xác thực bằng callback_sign
    const secret = (process.env.BANK_WEBHOOK_SECRET || '').trim();
    const providedSecret = req.query.secret ?? req.headers['x-secret'] ?? req.headers['x-webhook-secret'] ?? req.body?.secret;
    if (secret && providedSecret && String(providedSecret) !== secret) {
      return res.status(401).send('unauthorized');
    }

    const ctx = getContext?.();
    if (!ctx) return res.status(503).send('shop not ready');

    const data = req.method === 'GET' ? req.query : { ...(req.query || {}), ...(req.body || {}) };
    const requestId = String(data.request_id ?? data.card_request_id ?? data.requestId ?? '');
    const status = Number(data.status ?? data.callback_status ?? NaN);
    const serial = String(data.serial ?? '');
    const code = String(data.code ?? '');
    const callbackSign = String(data.callback_sign ?? data.sign ?? '');

    const pending = ctx.discord.pendingCards?.get(requestId);

    // Xác minh chữ ký đối tác callback_sign = md5(partner_key + code + serial)
    if (callbackSign && !cardService.verifyCallbackSign(code || pending?.code, serial || pending?.serial, callbackSign)) {
      webLog(ctx, `[Thẻ cào] ⚠️ Chữ ký callback KHÔNG hợp lệ (sign: ${callbackSign}) — bỏ qua.`);
      return res.status(401).send('bad sign');
    }

    // Thẻ không nằm trong danh sách chờ -> bỏ qua (đã xử lý hoặc không có trên bot)
    if (!pending) {
      webLog(ctx, `[Thẻ cào] Callback: nhận request ${requestId || 'không có mã'} nhưng không có trong danh sách chờ.`);
      return res.send('OK');
    }

    // Tính mệnh giá cộng vào số dư theo chuẩn tài liệu Postman:
    // status 1: đúng mệnh giá (ưu tiên pending.amount hoặc data.value/data.declared_value)
    // status 2: sai mệnh giá (lấy theo data.value hoặc data.amount thực tế)
    const declaredAmount = Number(data.declared_value ?? pending.amount ?? data.amount ?? 0);
    const realAmount = status === 2
      ? (Number(data.value ?? data.card_value ?? data.amount) || pending.amount)
      : (Number(data.value ?? data.declared_value ?? pending.amount) || pending.amount);

    webLog(ctx, `[Thẻ cào] Callback: request ${requestId} status ${status} (${cardService.getStatusDescription(status)}) amount ${formatNumber(realAmount)}đ`);

    ctx.discord.pendingCards.delete(requestId);

    if (status === 1 || status === 2) {
      const result = await balances.addBalance(pending.userId, realAmount, 'CARD_CALLBACK', {
        telco: pending.telco,
        serial: serial || pending.serial,
        requestId,
        status,
      });
      if (result.success) {
        webLog(ctx, `[Thẻ cào] ✅ Đã cộng ${formatNumber(realAmount)}đ cho ${pending.userTag} (số dư: ${formatNumber(result.newBalance)}đ)`);
        await dmUser(ctx, pending.userId, {
          embeds: [
            {
              color: 0x57f287,
              title: '✅ Nạp Thẻ Cào Thành Công',
              description: [
                `Thẻ của bạn đã được duyệt thành công!`,
                '',
                `**Nhà mạng:** \`${pending.telco}\``,
                `**Cộng vào số dư:** \`+${formatNumber(realAmount)} VNĐ\``,
                `**Số dư hiện tại:** \`${formatNumber(result.newBalance)} VNĐ\``,
                '',
                `👉 *Dùng số dư mua tiền game qua nút **💸 Mua Tiền** trên Panel!*`,
              ].join('\n'),
            },
          ],
        }).catch(() => {});
      }
    } else {
      webLog(ctx, `[Thẻ cào] ❌ Thẻ thất bại (${cardService.getStatusDescription(status)}) — không cộng số dư.`);
      await dmUser(ctx, pending.userId, {
        content: `❌ Thẻ cào của bạn (${pending.telco}, serial \`${pending.serial}\`) **không thành công**: ${cardService.getStatusDescription(status)}.`,
      }).catch(() => {});
    }

    res.send('OK');
  };

  /** POST callback thẻ cào (nhận tại /callback hoặc /charge/callback) */
  router.post(['/', '/callback'], handleCardCallback);

  /** GET callback thẻ cào, hoặc kiểm tra webhook còn sống */
  router.get(['/', '/callback', '/bank'], (req, res) => {
    if (req.query.request_id || req.query.status !== undefined) {
      return handleCardCallback(req, res);
    }
    res.json({ ok: true, service: 'mc-bedrock-pay-bot webhook' });
  });

  return router;
};

/* Hàm dùng chung cho polling (mbbankService.js) */
module.exports.processTransactions = processTransactions;

/* Hàm nội bộ dùng cho test/shop.test.js (không ảnh hưởng runtime) */
module.exports._test = { normalizeDesc, findMatchingPendingOrder, parseMemoDirect };
