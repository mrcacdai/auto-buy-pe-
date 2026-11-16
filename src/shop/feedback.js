'use strict';

/**
 * ============================================================
 *  shop/feedback.js — Gửi lời cảm ơn sau đơn hàng
 * ============================================================
 *  Gửi vào kênh FEEDBACK_CHANNEL_ID (nếu cấu hình):
 *    "Cảm ơn <@member> đã mua 500m tiền game 💰"
 *  IGN được ẨN DANH: "kurimeee" -> "ku***e", "hkyba" -> "hk***a"
 */

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');

const COLOR_GOLD = 0xfaa61a;

/** Ẩn danh IGN: "kurimeee" -> "ku***e", "ab" -> "a***" */
function maskIgn(ign) {
  if (!ign || typeof ign !== 'string') return '******';
  const str = ign.trim();
  if (str.length <= 2) return str[0] + '***';
  if (str.length <= 4) return str.slice(0, 1) + '***' + str.slice(-1);
  return str.slice(0, 2) + '***' + str.slice(-1);
}

/**
 * Gửi lời cảm ơn vào kênh feedback. Im lặng nếu chưa cấu hình / lỗi.
 * @param {object} ctx   Context của shop (discord, config...)
 * @param {object} info  { userId, ign, gameMoney, vnd, paymentMethod }
 */
async function sendFeedbackThanks(ctx, { userId, ign, gameMoney, vnd, paymentMethod }) {
  const channelId = (process.env.FEEDBACK_CHANNEL_ID || '').trim();
  if (!channelId || !/^\d+$/.test(channelId)) return false;

  const { formatStock } = require('./format');
  try {
    const channel = await ctx.discord.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return false;

    // Cần quyền gửi tin nhắn trong kênh đó
    const me = channel.guild?.members?.me;
    if (me && !channel.permissionsFor(me).has(PermissionFlagsBits.SendMessages)) return false;

    const embed = new EmbedBuilder()
      .setColor(COLOR_GOLD)
      .setTitle('🎉 Cảm ơn bạn đã ủng hộ!')
      .setDescription(
        [
          `Cảm ơn <@${userId}> đã mua **${formatStock(gameMoney)}** tiền game! 💰`,
          '',
          `👤 **IGN nhận:** \`${maskIgn(ign)}\``,
          vnd ? `💵 **Giá trị đơn:** \`${Number(vnd).toLocaleString('vi-VN')} VNĐ\`` : '',
          paymentMethod ? `💳 **Thanh toán:** ${paymentMethod}` : '',
          '',
          `*Chúc bạn chơi game vui vẻ!* 🎮`,
        ]
          .filter(Boolean)
          .join('\n')
      )
      .setTimestamp();

    await channel.send({ embeds: [embed], allowedMentions: { users: [userId] } });
    return true;
  } catch (err) {
    console.warn(`[Feedback] Không gửi được lời cảm ơn: ${err.message}`);
    return false;
  }
}

module.exports = { sendFeedbackThanks, maskIgn };
