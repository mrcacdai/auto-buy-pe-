'use strict';

/**
 * ============================================================
 *  shop/mbbankService.js — TỰ ĐỘNG QUÉT LỊCH SỬ MBBANK (ByteMart API)
 * ============================================================
 *  Endpoint: https://api.bytemart.io.vn/historyapimbbank/<token>
 *  • Định kỳ quét lịch sử giao dịch từ tài khoản MBBank qua ByteMart
 *  • Tự động chuẩn hóa danh sách giao dịch và chuyển cho processTransactions()
 *  • Bỏ qua các giao dịch rút tiền / phí ngân hàng (debit)
 *  • Chống trùng lặp tuyệt đối qua processed_txs.json
 *  • Tự động /pay trong game khi phát hiện giao dịch khớp mã đơn
 */

const { webLog } = require('./payflow');
const { formatNumber } = require('./format');

const DEFAULT_API_BASE = 'https://api.bytemart.io.vn/historyapimbbank';
const DEFAULT_INTERVAL_SEC = 30;
const MIN_INTERVAL_SEC = 10;
const DEFAULT_TIMEOUT_MS = 30000; // 30s timeout để tránh lỗi khi MBBank/ByteMart phản hồi chậm lúc cao điểm

let pollTimer = null;
let isPolling = false;
let lastError = null;
let lastErrorTime = 0;
let lastSuccessTime = null;
let consecutiveErrors = 0;

/**
 * Trích xuất danh sách giao dịch từ nhiều cấu trúc JSON khác nhau
 */
function extractTransactions(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data.transactionHistoryList)) return data.transactionHistoryList;
  if (Array.isArray(data.data?.transactionHistoryList)) return data.data.transactionHistoryList;
  if (Array.isArray(data.transactions)) return data.transactions;
  if (Array.isArray(data.history)) return data.history;
  if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)) return [data.data];
  return [];
}

/**
 * Gọi API ByteMart lấy danh sách giao dịch MBBank
 * @param {string} token - Access token ByteMart MBBank
 * @param {string} [apiBase] - URL gốc API (mặc định DEFAULT_API_BASE)
 * @returns {Promise<Array<object>>}
 */
async function fetchTransactions(token, apiBase = DEFAULT_API_BASE) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) {
    throw new Error('Chưa cấu hình MBBank access token.');
  }

  const endpoint = `${apiBase.replace(/\/+$/, '')}/${encodeURIComponent(cleanToken)}`;
  const timeoutMs = parseInt(process.env.MBBANK_TIMEOUT_MS || process.env.MBBANK_TIMEOUT, 10) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Quá thời gian phản hồi từ API ByteMart/MBBank (${Math.round(timeoutMs / 1000)}s timeout)`));
  }, timeoutMs);

  try {
    const res = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Phản hồi không phải JSON: ${text.slice(0, 100)}`);
    }

    // ByteMart báo lỗi khi token sai/hết hạn: {"status":"false","msg":"Access_token khong ton tai!"}
    if (json.status === 'false' || json.status === false || json.error === 1 || json.error === true) {
      const msg = json.msg || json.message || json.error || 'Lỗi không xác định từ ByteMart';
      throw new Error(`ByteMart từ chối: ${msg}`);
    }

    const rawList = extractTransactions(json);

    // Lọc chỉ lấy giao dịch TIỀN VÀO (credit), bỏ qua giao dịch rút tiền / phí (debit)
    const validCredits = rawList.filter((tx) => {
      if (!tx || typeof tx !== 'object') return false;

      // Nếu có trường transactionType (chuẩn MBBank: CR = Credit, DR = Debit)
      if (tx.transactionType && String(tx.transactionType).toUpperCase() === 'DR') {
        return false;
      }

      const credit = parseFloat(tx.creditAmount ?? tx.amount ?? tx.transferAmount ?? tx.soTien ?? 0) || 0;
      const debit = parseFloat(tx.debitAmount ?? 0) || 0;

      // Nếu có debit > 0 và credit <= 0 -> là tiền ra
      if (tx.debitAmount !== undefined && debit > 0 && credit <= 0) {
        return false;
      }

      return credit > 0;
    });

    return validCredits;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError' || controller.signal.aborted) {
      if (controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw new Error(`Quá thời gian kết nối API ByteMart/MBBank (${Math.round(timeoutMs / 1000)}s timeout)`);
    }
    throw err;
  }
}

/**
 * Thực hiện 1 lần quét và xử lý đơn hàng
 */
async function pollOnce(ctx, io) {
  if (isPolling) return 0;
  isPolling = true;

  const token = (process.env.MBBANK_TOKEN || process.env.BYTEMART_MBBANK_TOKEN || '').trim();
  const apiBase = (process.env.MBBANK_API_URL || DEFAULT_API_BASE).trim();

  if (!token) {
    isPolling = false;
    return 0;
  }

  const hadErrorsBefore = consecutiveErrors > 0;

  try {
    const transactions = await fetchTransactions(token, apiBase);
    lastSuccessTime = new Date().toISOString();
    consecutiveErrors = 0;
    lastError = null;

    if (hadErrorsBefore && ctx) {
      console.log('[MBBank/ByteMart] 🟢 Kết nối API MBBank đã phục hồi bình thường.');
      webLog(ctx, '🟢 Kết nối API MBBank (ByteMart) đã phục hồi bình thường.');
    }

    if (transactions.length > 0) {
      const { processTransactions } = require('../../web/routes/bank');
      if (typeof processTransactions === 'function') {
        await processTransactions(ctx, transactions, io);
      }
    }

    return transactions.length;
  } catch (err) {
    consecutiveErrors += 1;
    let friendlyMsg = err.message;
    if (err.name === 'AbortError' || String(err.message).toLowerCase().includes('aborted')) {
      friendlyMsg = 'Quá thời gian chờ phản hồi từ API ByteMart/MBBank (Timeout) — bot sẽ tự thử lại ở lần quét kế tiếp.';
    }
    lastError = friendlyMsg;
    const now = Date.now();

    // Lỗi cấu hình (sai token / bị từ chối) -> thông báo ngay
    // Lỗi mạng / timeout -> chỉ thông báo lên webLog khi lặp lại liên tiếp >= 2 lần hoặc cách nhau > 5 phút
    const isConfigError = String(err.message).includes('từ chối') || String(err.message).includes('token');
    const shouldLogWeb = isConfigError || consecutiveErrors >= 2 || (now - lastErrorTime > 5 * 60 * 1000);

    console.warn(`[MBBank/ByteMart] ⚠️ Lỗi quét lịch sử (lần ${consecutiveErrors}): ${friendlyMsg}`);
    if (shouldLogWeb && ctx && now - lastErrorTime > 60 * 1000) {
      lastErrorTime = now;
      webLog(ctx, `⚠️ Lỗi quét lịch sử MBBank: ${friendlyMsg}`);
    }
    return 0;
  } finally {
    isPolling = false;
  }
}

/**
 * Khởi động vòng lặp polling tự động
 */
function startPolling(ctx, io) {
  const token = (process.env.MBBANK_TOKEN || process.env.BYTEMART_MBBANK_TOKEN || '').trim();
  if (!token) {
    console.log('[MBBank/ByteMart] ℹ️ Chưa cấu hình MBBANK_TOKEN (hoặc BYTEMART_MBBANK_TOKEN). Polling MBBank đang tắt.');
    return null;
  }

  let intervalSec = parseInt(process.env.MBBANK_POLL_INTERVAL, 10);
  if (!Number.isFinite(intervalSec) || intervalSec < MIN_INTERVAL_SEC) {
    intervalSec = DEFAULT_INTERVAL_SEC;
  }

  console.log(`[MBBank/ByteMart] 🟢 Khởi động quét lịch sử MBBank tự động mỗi ${intervalSec}s.`);
  if (ctx) {
    webLog(ctx, `🟢 Bật tự động quét lịch sử MBBank (ByteMart) mỗi ${intervalSec}s.`);
  }

  // Quét lần đầu sau 3 giây khi bot khởi động ổn định
  const initialTimer = setTimeout(() => {
    pollOnce(ctx, io).catch(() => {});
  }, 3000);

  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    pollOnce(ctx, io).catch(() => {});
  }, intervalSec * 1000);

  return {
    stop: () => {
      clearTimeout(initialTimer);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      console.log('[MBBank/ByteMart] 🛑 Đã dừng quét lịch sử MBBank.');
    },
    pollOnce: () => pollOnce(ctx, io),
  };
}

function getStatus() {
  const token = (process.env.MBBANK_TOKEN || process.env.BYTEMART_MBBANK_TOKEN || '').trim();
  return {
    enabled: !!token,
    configured: !!token,
    lastSuccessTime,
    lastError,
    consecutiveErrors,
  };
}

module.exports = {
  fetchTransactions,
  pollOnce,
  startPolling,
  getStatus,
  extractTransactions,
};
