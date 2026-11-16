'use strict';

/**
 * ============================================================
 *  shop/balances.js — Số dư cá nhân của thành viên (VNĐ)
 * ============================================================
 *  Nguồn gốc từ cơ chế của auto-buy, port sang bot Bedrock:
 *    • Lock theo userId — chống race condition / double-spend
 *    • Ghi file nguyên tử (tmp + rename)
 *    • Chặn số âm, NaN, số thực, trừ vượt số dư
 *    • Lịch sử biến động (audit trail) tối đa 5.000 dòng
 *
 *  Files:
 *    data/balances.json         { userId: số_dư }
 *    data/balance_history.json  [ { id, timestamp, userId, type, ... } ]
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const HISTORY_FILE = path.join(DATA_DIR, 'balance_history.json');

/** Khóa chống race condition theo userId */
const userLocks = new Map();

/** Đọc bảng số dư { userId: số_dư_VNĐ } */
function readBalances() {
  try {
    if (!fs.existsSync(BALANCES_FILE)) return {};
    return JSON.parse(fs.readFileSync(BALANCES_FILE, 'utf8')) || {};
  } catch (err) {
    console.error(`[Số dư] Lỗi đọc balances.json: ${err.message}`);
    return {};
  }
}

/** Ghi bảng số dư nguyên tử */
function writeBalances(balances) {
  const tmp = `${BALANCES_FILE}.tmp.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(balances, null, 2), 'utf8');
    fs.renameSync(tmp, BALANCES_FILE);
    return true;
  } catch (err) {
    console.error(`[Số dư] Lỗi ghi balances.json: ${err.message}`);
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

/** Ghi 1 dòng lịch sử biến động số dư (giữ tối đa 5.000 dòng) */
function logHistory(entry) {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      try {
        history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
      } catch {
        history = [];
      }
    }
    history.push({
      id: `TX_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    });
    if (history.length > 5000) history = history.slice(-5000);
    const tmp = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2), 'utf8');
    fs.renameSync(tmp, HISTORY_FILE);
  } catch (err) {
    console.error(`[Số dư] Lỗi ghi balance_history.json: ${err.message}`);
  }
}

/**
 * Chờ khóa của user khác nhả ra rồi giữ khóa.
 * @returns {Function} hàm gọi để nhả khóa
 */
async function acquireLock(userId) {
  while (userLocks.has(userId)) {
    await userLocks.get(userId);
  }
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  userLocks.set(userId, promise);
  return () => {
    userLocks.delete(userId);
    release();
  };
}

/** Số dư hiện tại của 1 thành viên (VNĐ) */
function getBalance(userId) {
  if (!userId) return 0;
  const balances = readBalances();
  const val = Number(balances[userId]);
  return Number.isFinite(val) && val > 0 ? Math.floor(val) : 0;
}

/**
 * Cộng số dư an toàn.
 * @param {string} userId  Discord User ID
 * @param {number} amount  Số VNĐ cộng (> 0)
 * @param {string} reason  CARD_DEPOSIT | ADMIN_REFUND | ROLLBACK_PAY_FAILED | BANK_DEPOSIT...
 * @param {object} meta    Thông tin thêm (serial, orderId...)
 */
async function addBalance(userId, amount, reason = 'CARD_DEPOSIT', meta = {}) {
  const numericAmount = Math.floor(Number(amount));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { success: false, error: 'Số tiền nạp không hợp lệ (phải là số nguyên > 0).' };
  }

  const release = await acquireLock(userId);
  try {
    const balances = readBalances();
    const oldBalance = balances[userId] ? Math.floor(Number(balances[userId])) : 0;
    const newBalance = oldBalance + numericAmount;

    balances[userId] = newBalance;
    if (!writeBalances(balances)) {
      return { success: false, error: 'Lỗi ghi cơ sở dữ liệu số dư.' };
    }

    logHistory({ userId, type: 'ADD', amount: numericAmount, oldBalance, newBalance, reason, meta });
    return { success: true, oldBalance, newBalance };
  } finally {
    release();
  }
}

/**
 * Trừ số dư an toàn — chặn trừ vượt số dư, chặn số dư âm.
 * @param {string} reason  BUY_MONEY | ADMIN_DEDUCT...
 */
async function deductBalance(userId, amount, reason = 'BUY_MONEY', meta = {}) {
  const numericAmount = Math.floor(Number(amount));
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return { success: false, error: 'Số tiền trừ không hợp lệ (phải là số nguyên > 0).' };
  }

  const release = await acquireLock(userId);
  try {
    const balances = readBalances();
    const oldBalance = balances[userId] ? Math.floor(Number(balances[userId])) : 0;

    if (oldBalance < numericAmount) {
      return {
        success: false,
        oldBalance,
        error: `Số dư không đủ! Hiện có ${oldBalance.toLocaleString('vi-VN')} VNĐ, cần ${numericAmount.toLocaleString('vi-VN')} VNĐ.`,
      };
    }

    const newBalance = oldBalance - numericAmount;
    if (newBalance < 0) {
      return { success: false, oldBalance, error: 'Phát hiện số dư âm — giao dịch bị hủy.' };
    }

    balances[userId] = newBalance;
    if (!writeBalances(balances)) {
      return { success: false, error: 'Lỗi ghi cơ sở dữ liệu số dư.' };
    }

    logHistory({ userId, type: 'DEDUCT', amount: numericAmount, oldBalance, newBalance, reason, meta });
    return { success: true, oldBalance, newBalance };
  } finally {
    release();
  }
}

/** Danh sách thành viên có số dư (tối đa `limit`, sắp theo số dư giảm dần) */
function listBalances(limit = 50) {
  const balances = readBalances();
  return Object.entries(balances)
    .map(([userId, amount]) => ({ userId, amount: Math.floor(Number(amount)) || 0 }))
    .filter((e) => e.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

/** Đọc lịch sử biến động (mới nhất trước) */
function readHistory(limit = 100) {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || [];
    return history.slice(-limit).reverse();
  } catch {
    return [];
  }
}

module.exports = {
  getBalance,
  addBalance,
  deductBalance,
  acquireLock,
  listBalances,
  readHistory,
};
