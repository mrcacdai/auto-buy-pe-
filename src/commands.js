'use strict';

/**
 * ============================================================
 *  commands.js — 3 slash command Discord: /pay, /balance, /setipserver
 * ============================================================
 *  /pay <ign> <amount>
 *    - ign:    CHẤP NHẬN MỌI KÝ TỰ (kể cả tiền tố đặc biệt ".steve")
 *    - amount: tự phân tích hậu tố -> "5m" = 5.000.000, "1.5b" = 1.500.000.000
 *    -> Bot gửi lệnh /pay trong game bằng tài khoản Bedrock đang online,
 *       chụp màn hình kết quả và:
 *        + trả embed + ảnh trong kênh Discord
 *        + gửi ảnh tới webhook admin
 *
 *  /balance [ign]
 *    - Xem số dư trong game (bỏ trống ign = số dư của chính bot).
 *      Tên lệnh kinh tế trong game đổi được qua BALANCE_COMMAND trong .env
 *      (một số plugin dùng /money, /mymoney... thay vì /balance).
 *      Kết quả: embed kèm phản hồi của server + ảnh chụp + webhook admin.
 *
 *  /setipserver <ip> [port]
 *    - Đổi máy chủ Bedrock mà bot đang online tới (dành cho admin),
 *      ping thử trước để báo phiên bản server, lưu lại vào data/server.json
 *      để bot nhớ cả sau khi khởi động lại.
 */

const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const { parseAmount, sanitizeIgn, formatNumber } = require('./amount');
const { saveServer } = require('./config');
const { takeScreenshot } = require('./screenshot');
const { notifyScreenshot, notifyText } = require('./webhook');

const COLOR_OK = 0x57f287; // xanh lá
const COLOR_INFO = 0x5865f2; // tím Discord
const COLOR_ERR = 0xed4245; // đỏ

/* ------------------------------------------------------------------ */
/*  Định nghĩa slash command                                           */
/* ------------------------------------------------------------------ */

const payCommand = new SlashCommandBuilder()
  .setName('pay')
  .setDescription('Chuyển tiền trong game tới người chơi Minecraft (vd: /pay .steve 5m)')
  .addStringOption((opt) =>
    opt
      .setName('ign')
      .setDescription('Tên người chơi nhận tiền — chấp nhận mọi ký tự, kể cả ".steve"')
      .setRequired(true)
      .setMaxLength(64)
  )
  .addStringOption((opt) =>
    opt
      .setName('amount')
      .setDescription('Số tiền — hỗ trợ hậu tố k/m/b/t: 5m = 5.000.000, 1.5b = 1,5 tỷ')
      .setRequired(true)
      .setMaxLength(32)
  );

const balanceCommand = new SlashCommandBuilder()
  .setName('balance')
  .setDescription('Xem số dư trong game của bot hoặc của một người chơi bất kỳ')
  .addStringOption((opt) =>
    opt
      .setName('ign')
      .setDescription('Tên người chơi cần xem — bỏ trống để xem số dư của chính bot')
      .setRequired(false)
      .setMaxLength(64)
  );

const setIpCommand = new SlashCommandBuilder()
  .setName('setipserver')
  .setDescription('Đổi máy chủ Minecraft Bedrock mà bot sẽ online (chỉ admin)')
  .addStringOption((opt) =>
    opt
      .setName('ip')
      .setDescription('IP hoặc domain của server Bedrock (vd: play.example.net)')
      .setRequired(true)
      .setMaxLength(200)
  )
  .addIntegerOption((opt) =>
    opt.setName('port').setDescription('Cổng server (mặc định 19132)').setMinValue(1).setMaxValue(65535)
  );

/** JSON payload để đăng ký lên Discord */
function buildCommandJson() {
  return [payCommand.toJSON(), balanceCommand.toJSON(), setIpCommand.toJSON()];
}

/* ------------------------------------------------------------------ */
/*  Trợ giúp                                                           */
/* ------------------------------------------------------------------ */

/** Kiểm tra người gọi lệnh có phải admin không (danh sách ID trong .env, hoặc quyền Administrator) */
function isAdmin(interaction, config) {
  if (config.adminDiscordIds.length > 0) {
    return config.adminDiscordIds.includes(interaction.user.id);
  }
  return Boolean(interaction.inGuild() && interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
}

/** Gửi embed lỗi nhanh (khi chưa defer) */
function quickError(interaction, message) {
  return interaction.reply({
    embeds: [new EmbedBuilder().setColor(COLOR_ERR).setTitle('❌ Lệnh thất bại').setDescription(message)],
    ephemeral: true,
  });
}

/** Gộp các dòng phản hồi in-game thành 1 khối text an toàn cho embed Discord */
function commandLinesToText(lines) {
  const body = (lines ?? [])
    .map((l) => (l.kind === 'cmd' ? `» ${l.text}` : l.text))
    .join('\n')
    .replace(/```/g, '``\u200b`') // chống phá codeblock trong embed
    .trim();
  if (!body) return '(server không gửi phản hồi)';
  return body.length > 980 ? `${body.slice(0, 980)}…` : body;
}

/** Ghép meta cho ảnh chụp màn hình */
function screenshotMeta(manager, extra = {}) {
  const info = manager.stateInfo();
  return {
    server: info.server,
    version: manager.detected.version || info.version,
    botName: info.username,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/*  /pay                                                               */
/* ------------------------------------------------------------------ */

async function handlePay(interaction, manager, config) {
  // 1) Đọc & kiểm tra tham số
  const ignResult = sanitizeIgn(interaction.options.getString('ign', true));
  if (!ignResult.ok) return quickError(interaction, ignResult.error);

  const amountResult = parseAmount(interaction.options.getString('amount', true));
  if (!amountResult.ok) return quickError(interaction, amountResult.error);

  // 2) Chờ xử lý (quá trình vào server + gửi lệnh có thể mất vài giây)
  await interaction.deferReply();

  try {
    // 3) Gửi lệnh /pay trong game, thu phản hồi
    const lines = await manager.pay(ignResult.ign, amountResult.value.toString());

    // 4) Chụp màn hình tách nền in-game /pay
    const shot = await takeScreenshot({
      lines,
      meta: screenshotMeta(manager),
      world: manager.getWorldSnapshot(26),
      render3dEnabled: config.render3d,
      camera: { yaw: config.viewYaw, pitch: config.viewPitch },
      watermark: config.screenshotWatermark,
      isPay: true,
      ign: ignResult.ign,
      amount: amountResult.display,
    });

    const info = manager.stateInfo();
    const fileName = `pay-${Date.now()}.png`;
    const embed = new EmbedBuilder()
      .setColor(COLOR_OK)
      .setTitle('💸 Lệnh /pay đã được gửi trong game')
      .setDescription(`Bot đã thực hiện lệnh tại **${info.server}** (Bedrock ${manager.detected.version ?? 'auto'})`)
      .addFields(
        { name: '👤 Người nhận (IGN)', value: `\`${ignResult.ign}\``, inline: true },
        { name: '💰 Số tiền', value: `\`${amountResult.display}\``, inline: true },
        { name: '🎮 Tài khoản bot', value: `\`${info.username}\``, inline: true }
      )
      .setImage(`attachment://${fileName}`)
      .setFooter({ text: `Chế độ ảnh: ${shot.mode === 'payCrop' ? 'tách nền chat in-game' : shot.mode === '3d' ? 'thế giới 3D' : 'khung chat'} • ảnh cũng đã được gửi tới webhook admin` })
      .setTimestamp();

    const file = new AttachmentBuilder(shot.buffer, { name: fileName });
    await interaction.editReply({ embeds: [embed], files: [file] });

    // 5) Gửi ảnh về webhook admin (yêu cầu số 4)
    await notifyScreenshot(
      config,
      shot.buffer,
      `💸 **/pay** \`${ignResult.ign}\` — **${amountResult.display}**\n` +
        `🖥️ \`${info.server}\` • Bedrock ${manager.detected.version ?? 'auto'} • bot \`${info.username}\`\n` +
        `👮 Thực hiện bởi <@${interaction.user.id}>`
    );
  } catch (err) {
    const info = manager.stateInfo();
    const embed = new EmbedBuilder()
      .setColor(COLOR_ERR)
      .setTitle('❌ Không thực hiện được lệnh /pay')
      .setDescription(`\`\`\`${String(err.message).slice(0, 500)}\`\`\``)
      .addFields(
        { name: '👤 Người nhận', value: `\`${ignResult.ign}\``, inline: true },
        { name: '💰 Số tiền', value: `\`${amountResult.display}\``, inline: true },
        { name: '📡 Trạng thái bot', value: `\`${info.state}\` tại \`${info.server}\``, inline: true }
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    await notifyText(config, `❌ /pay ${ignResult.ign} ${amountResult.display} thất bại: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  /balance                                                           */
/* ------------------------------------------------------------------ */

async function handleBalance(interaction, manager, config) {
  // ign là TUỴ CHỌN — bỏ trống để xem số dư của chính tài khoản bot
  const rawIgn = interaction.options.getString('ign');
  let ign = null;
  if (rawIgn) {
    const ignResult = sanitizeIgn(rawIgn);
    if (!ignResult.ok) return quickError(interaction, ignResult.error);
    ign = ignResult.ign;
  }

  await interaction.deferReply();

  try {
    // 1) Gửi lệnh kinh tế trong game (BALANCE_COMMAND, mặc định /balance)
    const lines = await manager.balance(ign);

    // 2) Chụp màn hình (3D nếu có dữ liệu chunk, fallback về khung chat)
    const shot = await takeScreenshot({
      lines,
      meta: screenshotMeta(manager),
      world: manager.getWorldSnapshot(26),
      render3dEnabled: config.render3d,
      camera: { yaw: config.viewYaw, pitch: config.viewPitch },
      watermark: config.screenshotWatermark,
    });

    const info = manager.stateInfo();
    const target = ign ?? `${info.username} (bot)`;
    const embed = new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle('💰 Số dư trong game')
      .setDescription(`Bot đã hỏi server **${info.server}** (Bedrock ${manager.detected.version ?? 'auto'})`)
      .addFields(
        { name: '👤 Người chơi', value: `\`${target}\``, inline: true },
        { name: '🎮 Tài khoản bot', value: `\`${info.username}\``, inline: true },
        { name: '📡 Phản hồi server', value: `\`\`\`\n${commandLinesToText(lines)}\n\`\`\``, inline: false }
      )
      .setFooter({ text: `Chế độ ảnh: ${shot.mode === '3d' ? 'thế giới 3D' : 'khung chat'} • ảnh cũng đã được gửi tới webhook admin` })
      .setTimestamp();

    const file = new AttachmentBuilder(shot.buffer, { name: `balance-${Date.now()}.png` });
    await interaction.editReply({ embeds: [embed], files: [file] });

    // 3) Gửi ảnh về webhook admin (đồng bộ với /pay)
    await notifyScreenshot(
      config,
      shot.buffer,
      `💰 **/balance** \`${target}\`\n` +
        `🖥️ \`${info.server}\` • Bedrock ${manager.detected.version ?? 'auto'} • bot \`${info.username}\`\n` +
        `👮 Thực hiện bởi <@${interaction.user.id}>`
    );
  } catch (err) {
    const info = manager.stateInfo();
    const embed = new EmbedBuilder()
      .setColor(COLOR_ERR)
      .setTitle('❌ Không kiểm tra được số dư')
      .setDescription(`\`\`\`${String(err.message).slice(0, 500)}\`\`\``)
      .addFields(
        { name: '👤 Người chơi', value: `\`${ign ?? info.username}\``, inline: true },
        { name: '📡 Trạng thái bot', value: `\`${info.state}\` tại \`${info.server}\``, inline: true }
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    await notifyText(config, `❌ /balance ${ign ?? info.username} thất bại: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  /setipserver                                                       */
/* ------------------------------------------------------------------ */

async function handleSetIp(interaction, manager, config) {
  if (!isAdmin(interaction, config)) {
    return quickError(interaction, '🔒 Chỉ admin mới được đổi máy chủ.');
  }

  // Chấp nhận nhiều kiểu nhập: "1.2.3.4", "1.2.3.4:19132", "play.example.net"
  let host = String(interaction.options.getString('ip', true)).trim();
  let port = interaction.options.getInteger('port') ?? null;

  // Người dùng có thể gộp "ip:port" trong 1 ô — tách ra
  if (host.includes(':') && !host.includes(']')) {
    const [h, p] = host.split(':');
    if (/^\d+$/.test(p ?? '')) {
      host = h;
      port = Number(p);
    }
  }
  host = host.replace(/^udp:\/\//, '').replace(/\/+$/, '');

  if (!/^[a-zA-Z0-9.\-_]+(\.[a-zA-Z0-9.\-_]+)*$/.test(host) || host.length < 3) {
    return quickError(interaction, 'IP/domain không hợp lệ. Ví dụ: `play.example.net` hoặc `127.0.0.1`.');
  }
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    return quickError(interaction, 'Port phải là số nguyên từ 1 đến 65535.');
  }

  await interaction.deferReply();
  const finalPort = port ?? 19132;

  try {
    // 1) Ping thử server mới trước khi đổi
    const pong = await manager.probe(host, finalPort, 6000);

    // 2) Lưu cấu hình + kết nối lại
    saveServer(host, finalPort);
    await manager.setServer(host, finalPort);

    const embed = new EmbedBuilder()
      .setColor(COLOR_INFO)
      .setTitle('🖥️ Đã đổi máy chủ Minecraft Bedrock')
      .addFields(
        { name: '🌐 Địa chỉ mới', value: `\`${host}:${finalPort}\``, inline: true },
        {
          name: '📦 Phiên bản server',
          value: pong?.version ? `Bedrock \`${pong.version}\` (protocol \`${pong.protocol ?? '?'}\`)` : '⚠️ Không ping được (bot vẫn sẽ thử kết nối)',
          inline: true,
        },
        { name: '👥 Người chơi', value: pong?.playersOnline != null ? `${pong.playersOnline}/${pong.playersMax ?? '?'}` : '—', inline: true },
        { name: '🔔 Trạng thái', value: 'Bot đang kết nối tới máy chủ mới... sẽ có thông báo trên webhook khi vào xong.', inline: false }
      )
      .setFooter({ text: `Người đặt: ${interaction.user.tag} • Cấu hình đã lưu vào data/server.json` })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
    await notifyText(config, `🖥️ Admin <@${interaction.user.id}> đã đổi máy chủ bot sang \`${host}:${finalPort}\``);
  } catch (err) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_ERR)
          .setTitle('❌ Đổi máy chủ thất bại')
          .setDescription(`\`\`\`${String(err.message).slice(0, 500)}\`\`\``),
      ],
    });
  }
}

module.exports = { buildCommandJson, handlePay, handleBalance, handleSetIp, formatNumber };
