'use strict';

/**
 * ============================================================
 *  shop/format.js — Tiện ích định dạng số cho Shop
 * ============================================================
 *  • formatStock(x)  : tiền GAME (BigInt) -> "1.5b", "500m", "2k"
 *  • formatNumber(x) : số thường (VNĐ)    -> "1,000,000"
 *  • parseVnd("50k") : chuỗi VNĐ -> số (k = 1.000, tr = 1.000.000)
 *  Phân tích số tiền game dùng lại src/amount.js (BigInt, hỗ trợ k/m/b/t).
 */

const { parseAmount } = require('../amount');

/** Định dạng số thường có dấu phẩy: 1000000 -> "1,000,000" */
function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

/**
 * Định dạng tiền game thu gọn: 1500000000n -> "1.5b", 500000n -> "500k".
 * Nhận BigInt | số | chuỗi chữ số.
 */
function formatStock(value) {
  let num;
  try {
    num = typeof value === 'bigint' ? value : BigInt(String(value).trim() || '0');
  } catch {
    return '0';
  }
  const sign = num < 0n ? '-' : '';
  const abs = num < 0n ? -num : num;

  const units = [
    [1_000_000_000_000n, 't'],
    [1_000_000_000n, 'b'],
    [1_000_000n, 'm'],
    [1_000n, 'k'],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const whole = abs / size;
      const frac = ((abs % size) * 100n) / size; // 2 chữ số thập phân
      const fracStr = frac === 0n ? '' : `.${frac.toString().padStart(2, '0').replace(/0+$/, '')}`;
      return `${sign}${whole}${fracStr}${suffix}`;
    }
  }
  return `${sign}${abs}`;
}

/**
 * Phân tích số tiền game người dùng nhập trên Discord/console.
 * @returns {{ ok: true, value: BigInt, display: string } | { ok: false, error: string }}
 */
function parseGameAmount(raw) {
  const parsed = parseAmount(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: parsed.value, display: parsed.display };
}

/**
 * Phân tích số tiền VNĐ: "50000", "50k", "20.000", "1,000,000", "1.5tr".
 * @returns {number|null} số VNĐ nguyên, hoặc null nếu không hợp lệ
 */
function parseVnd(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!str) return null;

  const m = str.match(/^(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(k|tr|m)?$/);
  if (!m) return null;

  const numStr = m[1];
  const suffix = m[2];
  let num;
  if (!suffix && /^\d{1,3}([.,]\d{3})+$/.test(numStr)) {
    // "20.000", "1,000,000" — dấu chấm/phẩy là dấu ngăn cách hàng nghìn
    num = parseFloat(numStr.replace(/[.,]/g, ''));
  } else {
    // "1.5tr", "2,5k" — dấu chấm/phẩy là dấu thập phân
    num = parseFloat(numStr.replace(',', '.'));
  }
  if (!Number.isFinite(num) || num <= 0) return null;

  const mult = suffix === 'k' ? 1e3 : suffix === 'tr' || suffix === 'm' ? 1e6 : 1;
  return Math.floor(num * mult);
}

module.exports = { formatNumber, formatStock, parseGameAmount, parseVnd };
