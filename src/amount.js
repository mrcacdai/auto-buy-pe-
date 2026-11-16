'use strict';

/**
 * ============================================================
 *  amount.js — Tiện ích xử lý IGN và số tiền cho lệnh /pay
 * ============================================================
 *  - parseAmount():  "5m"  -> 5.000.000       (M = triệu)
 *                    "1.5b" -> 1.500.000.000   (B = tỷ)
 *                    ".5m"  -> 500.000, "2k" -> 2.000, "1t" -> 1.000.000.000.000
 *  - Dùng BigInt nên không mất chính xác với số lớn (giới hạn 2^63 - 1,
 *    tương đương giới hạn số nguyên 64-bit của Minecraft Bedrock).
 *  - sanitizeIgn(): chấp nhận MỌI ký tự tên người chơi (kể cả tiền tố
 *    đặc biệt như ".steve", "~Steve", "u.r_max"...), chỉ chặn ký tự
 *    xuống dòng / tab để không thể nhét thêm lệnh vào chuỗi.
 */

/** Số mũ thập phân tương ứng từng hậu tố: k=10^3, m=10^6, b=10^9, t=10^12 */
const SUFFIX_EXPONENT = { k: 3, m: 6, b: 9, t: 12 };

/** Giới hạn số nguyên 64-bit có dấu của Bedrock: 9.223.372.036.854.775.807 */
const MAX_I64 = 9223372036854775807n;

/** Định dạng BigInt thành chuỗi có dấu phẩy ngăn cách hàng nghìn: 1500000000n -> "1,500,000,000" */
function formatNumber(value) {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Đọc số tiền từ chuỗi người dùng gõ trên Discord.
 * @param {string} raw   VD: "5m", "1.5B", ".5m", "1,000,000", "1000000"
 * @returns {{ ok: true,  value: BigInt, display: string, input: string }}
 *        | {{ ok: false, error: string }}
 */
function parseAmount(raw) {
  const input = String(raw ?? '').trim();

  if (!input) {
    return { ok: false, error: 'Số tiền đang để trống. Ví dụ hợp lệ: `5m`, `1.5b`, `1000000`.' };
  }

  // Bỏ các ký tự trang trí hay gặp: dấu phẩy ngăn cách, gạch dưới, khoảng trắng, ký hiệu tiền tệ
  const cleaned = input.toLowerCase().replace(/[$,_\s]/g, '');

  // Chấp nhận: [số nguyên hoặc số thập phân] + [hậu tố k/m/b/t tuỳ chọn]
  const match = cleaned.match(/^([0-9]*\.?[0-9]+)([kmbt])?$/);
  if (!match) {
    return {
      ok: false,
      error: `\`${input}\` không phải số tiền hợp lệ. Ví dụ hợp lệ: \`5m\`, \`1.5b\`, \`.5m\`, \`2k\`, \`1000000\`.`,
    };
  }

  const [, numberPart, suffix] = match;
  const [intPart, fracPart = ''] = numberPart.split('.');
  const shift = suffix ? SUFFIX_EXPONENT[suffix] : 0;

  // Dịch dấu phẩy thập phân sang phải `shift` chữ số bằng CHUỖI (tránh sai số float).
  //  - "1.5" + b(9 chữ số)  -> "1" + "5".padEnd(9,'0')  -> "1500000000"
  //  - ".5"  + m(6 chữ số)  -> ""  + "5".padEnd(6,'0')  -> "500000"
  // Phần thập phân dư quá `shift` chữ số sẽ bị CẮT BỎ (làm tròn xuống).
  const frac = fracPart.slice(0, shift).padEnd(shift, '0');
  const digits = (intPart || '0') + frac;

  let value;
  try {
    value = BigInt(digits);
  } catch {
    return { ok: false, error: `Không đọc được số từ \`${input}\`.` };
  }

  if (value <= 0n) {
    return { ok: false, error: 'Số tiền phải lớn hơn 0.' };
  }
  if (value > MAX_I64) {
    return { ok: false, error: `Số tiền vượt giới hạn 64-bit (tối đa ${formatNumber(MAX_I64)}).` };
  }

  return { ok: true, value, display: formatNumber(value), input };
}

/**
 * Làm sạch tên người chơi (IGN).
 * Chấp nhận mọi ký tự — kể cả tiền tố đặc biệt như ".steve" —
 * chỉ chặn xuống dòng/tab/ký tự NUL để chống chèn thêm lệnh (command injection).
 * @param {string} raw
 * @returns {{ ok: true, ign: string } | { ok: false, error: string }}
 */
function sanitizeIgn(raw) {
  const ign = String(raw ?? '').trim();

  if (!ign) {
    return { ok: false, error: 'Tên người chơi (IGN) đang để trống.' };
  }
  if (/[\r\n\t\u0000]/.test(ign)) {
    return { ok: false, error: 'IGN không được chứa ký tự xuống dòng hoặc tab.' };
  }
  if (ign.length > 64) {
    return { ok: false, error: `IGN quá dài (${ign.length} ký tự, tối đa 64).` };
  }

  return { ok: true, ign };
}

module.exports = { parseAmount, sanitizeIgn, formatNumber, MAX_I64 };
