'use strict';

/**
 * ============================================================
 *  webhook.js — Gửi thông báo + ảnh chụp tới Webhook admin
 * ============================================================
 */

const { WebhookClient, AttachmentBuilder } = require('discord.js');

const log = (...args) => console.log(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [Webhook]`, ...args);
const warn = (...args) => console.warn(`[${new Date().toLocaleString('vi-VN', { hour12: false })}] [Webhook]`, ...args);

let cachedWebhook = null;
let cachedUrl = '';

/** Tạo WebhookClient từ URL trong config hoặc .env (trả null nếu URL không hợp lệ/thiếu) */
function getWebhook(config) {
  const url = (config && config.adminWebhookUrl) || process.env.ADMIN_WEBHOOK_URL || '';
  if (!url) return null;
  if (cachedWebhook && cachedUrl === url) return cachedWebhook;
  try {
    cachedWebhook = new WebhookClient({ url });
    cachedUrl = url;
    return cachedWebhook;
  } catch (err) {
    warn(`URL webhook không hợp lệ: ${err.message}`);
    return null;
  }
}

/** Gửi 1 tin nhắn văn bản tới webhook admin (im lặng nếu lỗi — không làm rơi bot) */
async function notifyText(config, content) {
  const webhook = getWebhook(config);
  if (!webhook) return false;
  try {
    await webhook.send({ content, username: 'MC Pay Bot', allowedMentions: { parse: [] } });
    return true;
  } catch (err) {
    warn(`Gửi webhook thất bại: ${err.message}`);
    return false;
  }
}

/**
 * Gửi ảnh chụp màn hình tới webhook admin.
 * @param {object} config
 * @param {Buffer} buffer      Ảnh PNG
 * @param {string} caption     Nội dung tin nhắn kèm ảnh
 * @returns {Promise<boolean>}
 */
async function notifyScreenshot(config, buffer, caption) {
  const webhook = getWebhook(config);
  if (!webhook) {
    warn('Chưa cấu hình ADMIN_WEBHOOK_URL — bỏ qua gửi ảnh.');
    return false;
  }
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
      warn(`Buffer ảnh không hợp lệ: type=${typeof buffer}, length=${buffer?.length ?? 0}`);
      return false;
    }
    const file = new AttachmentBuilder(buffer, { name: `pay-${Date.now()}.png` });
    await webhook.send({ content: caption, files: [file], username: 'MC Pay Bot', allowedMentions: { parse: [] } });
    log(`Đã gửi ảnh chụp tới webhook admin (${buffer.length} bytes).`);
    return true;
  } catch (err) {
    warn(`Gửi ảnh tới webhook thất bại: ${err.message}`);
    return false;
  }
}

module.exports = { notifyText, notifyScreenshot };
