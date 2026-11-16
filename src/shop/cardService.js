'use strict';

/**
 * ============================================================
 *  shop/cardService.js — Gạch thẻ cào qua API đối tác (Card Partner API)
 * ============================================================
 *  Chuẩn theo tài liệu Postman: https://documenter.getpostman.com/view/5740908/TVYJ5Ggr
 *
 *  Endpoints:
 *    • POST/GET {CARD_DOMAIN}/chargingws/v2
 *    • GET {CARD_DOMAIN}/chargingws/v2/getfee?partner_id={PARTNER_ID}
 *
 *  Chữ ký (sign):
 *    • Gửi thẻ / Check: sign = md5(partner_key + code + serial)
 *    • Callback đối tác: callback_sign = md5(partner_key + code + serial)
 *
 *  Mã trạng thái trả về (status):
 *    • 1   = Thẻ thành công đúng mệnh giá
 *    • 2   = Thẻ thành công sai mệnh giá
 *    • 3   = Thẻ lỗi / Sai mã thẻ hoặc serial / Đã sử dụng
 *    • 4   = Hệ thống nhà mạng đang bảo trì
 *    • 99  = Thẻ đang chờ xử lý (Pending)
 *    • 100 = Gửi thẻ thất bại (có lý do đi kèm ở message)
 */

const crypto = require('crypto');

/**
 * Đọc và chuẩn hóa cấu hình từ .env (CARD_DOMAIN, CARD_PARTNER_ID, CARD_PARTNER_KEY)
 */
function getCardConfig() {
  let domain = (process.env.CARD_DOMAIN || '').trim().replace(/\/+$/, '');
  if (domain && !/^https?:\/\//i.test(domain)) {
    domain = `https://${domain}`;
  }
  // Loại bỏ hậu tố /chargingws/v2 nếu người dùng cấu hình cả đường dẫn vào CARD_DOMAIN
  domain = domain.replace(/\/chargingws\/v2\/?$/i, '').replace(/\/+$/, '');
  const partnerId = (process.env.CARD_PARTNER_ID || '').trim();
  const partnerKey = (process.env.CARD_PARTNER_KEY || '').trim();
  let callbackUrl = (process.env.CARD_CALLBACK_URL || '').trim();
  if (callbackUrl) {
    if (!/^https?:\/\//i.test(callbackUrl)) {
      callbackUrl = `https://${callbackUrl}`;
    }
    // Nếu chỉ nhập tên miền (ví dụ flat-eggs-eat.loca.lt), tự động gắn đường dẫn /charge/callback
    if (!callbackUrl.includes('/charge') && !callbackUrl.includes('/callback')) {
      callbackUrl = callbackUrl.replace(/\/+$/, '') + '/charge/callback';
    }
  }
  return { domain, partnerId, partnerKey, callbackUrl };
}

/** Đã cấu hình đủ để gọi API chưa */
function isConfigured() {
  const { domain, partnerId, partnerKey } = getCardConfig();
  return !!(domain && partnerId && partnerKey && !domain.includes('YOUR_'));
}

/** Chữ ký bảo mật: md5(partner_key + code + serial) */
function createSignature(partnerKey, code, serial) {
  return crypto
    .createHash('md5')
    .update(`${partnerKey}${code}${serial}`)
    .digest('hex');
}

/**
 * Gửi HTTP POST lên endpoint /chargingws/v2 với hỗ trợ cả JSON (chuẩn Postman) và URL-encoded fallback
 */
async function postCard({ telco, code, serial, amount, requestId, command = 'charging' }) {
  const { domain, partnerId, partnerKey, callbackUrl } = getCardConfig();
  const sign = createSignature(partnerKey, code, serial);
  const endpoint = `${domain}/chargingws/v2`;

  const cardPayload = {
    telco: String(telco).trim().toUpperCase(),
    code: String(code).trim(),
    serial: String(serial).trim(),
    amount: String(amount),
    request_id: String(requestId).trim(),
    partner_id: String(partnerId).trim(),
    sign,
    command: String(command).trim(),
  };

  if (callbackUrl) {
    cardPayload.callback_url = callbackUrl;
    cardPayload.url_callback = callbackUrl;
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
  };

  // 1. Gửi dạng application/json theo đúng tài liệu Postman (Headers: Content-Type: application/json)
  let lastError = null;
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(cardPayload),
      signal: AbortSignal.timeout(15000),
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {}

    if (json && (json.status !== undefined || json.trans_id !== undefined || json.message !== undefined)) {
      const msg = String(json.message || '').toLowerCase();
      // Nếu server cổng thẻ trả về lỗi do không đọc được JSON body (status 103/104 hoặc message thiếu dữ liệu), fallback sang urlencoded
      if (json.status === 103 || json.status === 104 || msg.includes('không có dữ liệu') || msg.includes('khong co du lieu')) {
        return await postCardForm(endpoint, cardPayload, headers);
      }
      return json;
    }

    // Nếu HTTP status không ok hoặc không parse được JSON, thử fallback sang urlencoded
    if (!res.ok || !json) {
      return await postCardForm(endpoint, cardPayload, headers);
    }
    return json;
  } catch (err) {
    lastError = err;
  }

  // 2. Dự phòng: gửi dạng application/x-www-form-urlencoded
  try {
    return await postCardForm(endpoint, cardPayload, headers);
  } catch (fallbackErr) {
    throw lastError || fallbackErr;
  }
}

/** Gửi dữ liệu dạng x-www-form-urlencoded */
async function postCardForm(endpoint, cardPayload, baseHeaders = {}) {
  const payload = new URLSearchParams();
  for (const [k, v] of Object.entries(cardPayload)) {
    payload.append(k, String(v));
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: payload.toString(),
    signal: AbortSignal.timeout(15000),
  });

  const text = await res.text();
  try {
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return { status: 100, message: `Phản hồi không đọc được từ hệ thống thẻ: ${text.slice(0, 200)}` };
  }
}

function formatError(err) {
  if (!err) return 'Lỗi không xác định';
  if (err.cause) {
    const causeMsg = err.cause.message || err.cause.code || String(err.cause);
    return `${err.message} (${causeMsg})`;
  }
  return err.message;
}

/**
 * Gửi thẻ lên hệ thống gạch thẻ.
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
async function sendCard(cardData) {
  if (!isConfigured()) {
    return {
      success: false,
      error: 'Chưa cấu hình API thẻ cào (CARD_DOMAIN, CARD_PARTNER_ID, CARD_PARTNER_KEY trong .env).',
    };
  }
  try {
    const data = await postCard({ ...cardData, command: 'charging' });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: formatError(err) };
  }
}

/**
 * Tra cứu trạng thái thẻ theo request_id (command = check)
 * @returns {Promise<{ success: boolean, data?: object, error?: string }>}
 */
async function checkCard(cardData) {
  if (!isConfigured()) {
    return { success: false, error: 'Chưa cấu hình API thẻ cào.' };
  }
  try {
    const data = await postCard({ ...cardData, command: 'check' });
    return { success: true, data };
  } catch (err) {
    return { success: false, error: formatError(err) };
  }
}

/**
 * Lấy bảng giá tẩy thẻ / chiết khấu từ hệ thống đối tác
 * GET {CARD_DOMAIN}/chargingws/v2/getfee?partner_id={PARTNER_ID}
 */
async function getCardFees() {
  if (!isConfigured()) {
    return { success: false, error: 'Chưa cấu hình API thẻ cào.' };
  }
  const { domain, partnerId } = getCardConfig();
  try {
    const res = await fetch(`${domain}/chargingws/v2/getfee?partner_id=${encodeURIComponent(partnerId)}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const data = JSON.parse(text.replace(/^\uFEFF/, ''));
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Xác minh chữ ký callback đối tác gửi về (callback_sign)
 * Chuẩn tài liệu Postman: callback_sign = md5(partner_key + code + serial)
 */
function verifyCallbackSign(code, serial, callbackSign) {
  if (!callbackSign) return false;
  const { partnerKey } = getCardConfig();
  if (!partnerKey) return false;
  return createSignature(partnerKey, code, serial).toLowerCase() === String(callbackSign).trim().toLowerCase();
}

/** Mô tả thân thiện của mã trạng thái (theo chuẩn tài liệu Postman) */
function getStatusDescription(status) {
  switch (Number(status)) {
    case 1:
      return 'Thẻ thành công đúng mệnh giá';
    case 2:
      return 'Thẻ thành công sai mệnh giá';
    case 3:
      return 'Thẻ lỗi / Sai mã thẻ hoặc serial / Đã sử dụng';
    case 4:
      return 'Hệ thống nhà mạng đang bảo trì';
    case 99:
      return 'Thẻ đang chờ xử lý trên hệ thống (Pending)';
    case 100:
      return 'Gửi thẻ thất bại';
    default:
      return `Trạng thái: ${status}`;
  }
}

module.exports = {
  sendCard,
  checkCard,
  getCardFees,
  verifyCallbackSign,
  createSignature,
  getStatusDescription,
  isConfigured,
  getCardConfig,
};
