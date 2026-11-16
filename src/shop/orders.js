'use strict';

/**
 * ============================================================
 *  shop/orders.js — Quản lý đơn hàng mua tiền in-game
 * ============================================================
 *  • Mã đơn "DHxxxxxx" (6 chữ số, không trùng)
 *  • Lưu data/orders.json (ghi nguyên tử) với trạng thái:
 *      PENDING_PAYMENT -> đang chờ khách chuyển khoản (đơn QR)
 *      PROCESSING      -> đang thực hiện /pay trong game
 *      COMPLETED       -> đã thanh toán & đã /pay thành công
 *      WAITING_RETRY   -> đã nhận tiền nhưng chưa xác nhận được /pay, sẽ thử lại
 *      FAILED          -> thử lại nhiều lần vẫn thất bại — cần admin xử lý
 *      EXPIRED         -> quá hạn thanh toán, tự hủy
 *  • Chống xử lý TRÙNG giao dịch ngân hàng: processed_txs.json
 *    (dấu vân tay giao dịch cố định, không dùng random)
 *  • Hàng chờ "thử /pay lại" (retries.json) — xử lý khi server lag
 *    hoặc bot chưa online lúc khách thanh toán.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const TXS_FILE = path.join(DATA_DIR, 'processed_txs.json');
const RETRIES_FILE = path.join(DATA_DIR, 'retries.json');

/* ------------------------------------------------------------------ */
/*  Đơn hàng                                                            */
/* ------------------------------------------------------------------ */

function readOrders() {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')) || {};
  } catch (err) {
    console.error(`[Đơn hàng] Lỗi đọc orders.json: ${err.message}`);
    return {};
  }
}

function writeOrders(orders) {
  const tmp = `${ORDERS_FILE}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(orders, null, 2), 'utf8');
    fs.renameSync(tmp, ORDERS_FILE);
    return true;
  } catch (err) {
    console.error(`[Đơn hàng] Lỗi ghi orders.json: ${err.message}`);
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

/** Mã đơn mới "DH" + 6 chữ số, đảm bảo chưa tồn tại */
function generateOrderId(orders = readOrders()) {
  let id;
  do {
    id = `DH${Math.floor(100000 + Math.random() * 900000)}`;
  } while (orders[id]);
  return id;
}

/**
 * Lưu/cập nhật 1 đơn hàng. Loại bỏ trường không tuần tự hóa được
 * (interaction, discord client...) và chuyển BigInt -> chuỗi.
 */
function saveOrder(order) {
  const orders = readOrders();
  const id = order.orderId || order.id;
  const clean = {};
  for (const [k, v] of Object.entries(order)) {
    if (k === 'interaction' || k === 'client' || k === 'discord') continue;
    if (typeof v === 'bigint') clean[k] = v.toString();
    else if (v !== undefined) clean[k] = v;
  }
  orders[id] = clean;
  writeOrders(orders);
  return id;
}

function getOrder(orderId) {
  return readOrders()[String(orderId).toUpperCase()] ?? null;
}

function updateOrderStatus(orderId, status, extra = {}) {
  const orders = readOrders();
  const id = String(orderId).toUpperCase();
  if (!orders[id]) return false;
  orders[id].status = status;
  orders[id].statusAt = new Date().toISOString();
  for (const [k, v] of Object.entries(extra)) {
    if (typeof v === 'bigint') orders[id][k] = v.toString();
    else if (v !== undefined) orders[id][k] = v;
  }
  writeOrders(orders);
  return true;
}

/** Danh sách đơn mới nhất (mới trước) */
function listOrders(limit = 50) {
  const orders = readOrders();
  return Object.values(orders)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    .slice(0, limit);
}

/* ------------------------------------------------------------------ */
/*  Chống trùng giao dịch ngân hàng                                     */
/* ------------------------------------------------------------------ */

function readProcessedTxs() {
  try {
    if (!fs.existsSync(TXS_FILE)) return {};
    return JSON.parse(fs.readFileSync(TXS_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function isProcessedTx(txId) {
  if (!txId) return false;
  return !!readProcessedTxs()[txId];
}

function markProcessedTx(txId) {
  if (!txId) return;
  const txs = readProcessedTxs();
  txs[txId] = new Date().toISOString();
  // Giữ tối đa 2000 giao dịch gần nhất
  const keys = Object.keys(txs);
  if (keys.length > 2000) {
    keys.sort((a, b) => String(txs[a]).localeCompare(String(txs[b])));
    for (const k of keys.slice(0, keys.length - 2000)) delete txs[k];
  }
  const tmp = `${TXS_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(txs, null, 2), 'utf8');
    fs.renameSync(tmp, TXS_FILE);
  } catch (err) {
    console.error(`[Đơn hàng] Lỗi ghi processed_txs.json: ${err.message}`);
  }
}

/**
 * Mã định danh giao dịch: ưu tiên mã gốc của ngân hàng/Casso.
 * Không có thì tạo dấu vân tay CỐ ĐỊNH từ amount+desc+date (không random)
 * để webhook gửi lại nhiều lần vẫn nhận ra là cùng 1 giao dịch.
 */
function getTransactionId(tx) {
  if (!tx || typeof tx !== 'object') return '';
  const candidate =
    tx.id ?? tx.tranId ?? tx.refNo ?? tx.transactionId ?? tx.SeqNo ?? tx.seqNo ?? tx.transactionNumber ?? tx.transId ?? tx.docId;
  if (candidate !== undefined && candidate !== null && String(candidate).trim() !== '') {
    return `bank_${String(candidate).trim()}`;
  }
  let amount = tx.amount ?? tx.creditAmount ?? tx.transferAmount ?? 0;
  amount = Math.abs(parseFloat(amount) || 0);
  const desc = String(tx.description ?? tx.content ?? tx.memo ?? '').trim();
  const date = String(tx.transactionDate ?? tx.date ?? tx.time ?? tx.when ?? '').trim();
  return `tx_${amount}_${desc}_${date}`.replace(/[\s.]+/g, '_');
}

/* ------------------------------------------------------------------ */
/*  Hàng chờ thử /pay lại                                              */
/* ------------------------------------------------------------------ */

function readRetries() {
  try {
    if (!fs.existsSync(RETRIES_FILE)) return [];
    return JSON.parse(fs.readFileSync(RETRIES_FILE, 'utf8')) || [];
  } catch {
    return [];
  }
}

function writeRetries(list) {
  const tmp = `${RETRIES_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8');
    fs.renameSync(tmp, RETRIES_FILE);
  } catch (err) {
    console.error(`[Đơn hàng] Lỗi ghi retries.json: ${err.message}`);
  }
}

/** Đưa 1 đơn vào hàng chờ thử /pay lại (sau `delayMin` phút) */
function addRetry(entry, delayMin = 30) {
  const list = readRetries();
  const orderId = entry.orderId || `R${Date.now()}`;
  // Nếu đã có trong hàng chờ thì cập nhật thay vì thêm trùng;
  // số lần thử CARRY-OVER từ lần trước (tránh đặt lại về 0 rồi thử vô hạn)
  const existing = list.findIndex((r) => r.orderId === orderId);
  const baseAttempts = existing >= 0 ? list[existing].attempts : Number(entry.attempts ?? 0);
  const item = {
    orderId,
    userId: entry.userId ?? null,
    userTag: entry.userTag ?? 'không rõ',
    ign: entry.ign,
    gameMoney: String(entry.gameMoney ?? entry.amount ?? '0'),
    amountVnd: Number(entry.amountVnd ?? entry.totalPrice ?? 0),
    attempts: baseAttempts + 1,
    nextAttemptAt: Date.now() + delayMin * 60 * 1000,
    paymentMethod: entry.paymentMethod || 'Ngân hàng / VietQR',
  };
  if (existing >= 0) list[existing] = item;
  else list.push(item);
  writeRetries(list);
  return item;
}

function removeRetry(orderId) {
  const list = readRetries().filter((r) => r.orderId !== String(orderId).toUpperCase());
  writeRetries(list);
}

module.exports = {
  readOrders,
  generateOrderId,
  saveOrder,
  getOrder,
  updateOrderStatus,
  listOrders,
  isProcessedTx,
  markProcessedTx,
  getTransactionId,
  readRetries,
  writeRetries,
  addRetry,
  removeRetry,
};
