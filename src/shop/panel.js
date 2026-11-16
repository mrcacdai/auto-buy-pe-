'use strict';

/**
 * ============================================================
 *  shop/panel.js — PANEL BÁN TIỀN TRÊN DISCORD
 * ============================================================
 *  Cơ chế lấy từ auto-buy, port sang bot Bedrock (KHÔNG dùng mineflayer):
 *
 *  Lệnh slash:
 *    /panel  (admin) — đăng/cập nhật bảng bán tiền kèm nút "💸 Mua Tiền".
 *                      Bot nhớ vị trí tin nhắn và TỰ CẬP NHẬT giá/kho.
 *    /sodu         — xem số dư cá nhân (đã nạp qua thẻ cào).
 *    /gachthe      — nạp thẻ cào tự động vào số dư.
 *
 *  Nút & Modal:
 *    💸 Mua Tiền       -> modal: số tiền game, phương thức, IGN
 *      • Ngân hàng/Momo -> sinh QR VietQR + đơn hàng DHxxxxxx, chờ webhook
 *      • Card/Thẻ cào   -> trừ SỐ DƯ CÁ NHÂN và bot /pay NGAY trong game
 *    💳 Kiểm tra số dư -> xem nhanh số dư
 *
 *  An toàn:
 *    • Kho trừ bằng BigInt, không âm
 *    • Số dư cá nhân có lock chống double-spend, /pay lỗi thì HOÀN TIỀN
 *    • Bị khóa khi botOff hoặc bot đang nghỉ AFK
 */

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
} = require('discord.js');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const orders = require('./orders');
const balances = require('./balances');
const cardService = require('./cardService');
const { formatNumber, formatStock, parseGameAmount, parseVnd } = require('./format');
const { sendFeedbackThanks } = require('./feedback');
const { executeGamePay, isMcOnline, webLog, dmUser, notifyAdmin } = require('./payflow');
const afk = require('./afk');

const COLOR_OK = 0x57f287;
const COLOR_INFO = 0x5865f2;
const COLOR_ERR = 0xed4245;
const COLOR_WARN = 0xfaa61a;

/* ------------------------------------------------------------------ */
/*  Token IGN trong customId (customId tối đa 100 ký tự, phải hỗ trợ    */
/*  IGN đặc biệt như ".steve", "~Steve#123" nên dùng bảng tra ngắn)     */
/* ------------------------------------------------------------------ */

const ignTokens = new Map(); // token -> { ign, expires }

function putIgnToken(ign) {
  const token = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
  ignTokens.set(token, { ign, expires: Date.now() + 30 * 60 * 1000 });
  // dọn token hết hạn
  for (const [k, v] of ignTokens) {
    if (v.expires < Date.now()) ignTokens.delete(k);
  }
  return token;
}

function getIgnToken(token) {
  const entry = ignTokens.get(token);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.ign;
}

/* ------------------------------------------------------------------ */
/*  Định nghĩa slash command                                            */
/* ------------------------------------------------------------------ */

const panelCommand = new SlashCommandBuilder()
  .setName('panel')
  .setDescription('💰 Đăng bảng mua tiền in-game (Panel) — tự cập nhật giá/kho')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

const soduCommand = new SlashCommandBuilder()
  .setName('sodu')
  .setDescription('💳 Xem số dư cá nhân của bạn (đã nạp qua thẻ cào)');

const TELCOS = [
  { name: 'Viettel', value: 'VIETTEL' },
  { name: 'Vinaphone', value: 'VINAPHONE' },
  { name: 'Mobifone', value: 'MOBIFONE' },
  { name: 'Vietnamobile', value: 'VIETNAMOBILE' },
  { name: 'Zing', value: 'ZING' },
  { name: 'Gate', value: 'GATE' },
  { name: 'Garena', value: 'GARENA' },
];
const CARD_VALUES = [10000, 20000, 30000, 50000, 100000, 200000, 300000, 500000, 1000000];

const gachtheCommand = new SlashCommandBuilder()
  .setName('gachthe')
  .setDescription('💳 Gạch thẻ cào tự động — cộng tiền vào số dư cá nhân')
  .addStringOption((opt) =>
    opt.setName('telco').setDescription('Loại thẻ cào').setRequired(true).addChoices(...TELCOS)
  )
  .addIntegerOption((opt) =>
    opt
      .setName('amount')
      .setDescription('Mệnh giá thẻ')
      .setRequired(true)
      .addChoices(...CARD_VALUES.map((v) => ({ name: `${formatNumber(v)} VNĐ`, value: v })))
  )
  .addStringOption((opt) => opt.setName('code').setDescription('Mã thẻ cào (PIN sau lớp tráng bạc)').setRequired(true).setMaxLength(30))
  .addStringOption((opt) => opt.setName('serial').setDescription('Số serial in trên thẻ').setRequired(true).setMaxLength(30));

/** JSON đăng ký cho index.js gộp cùng 3 lệnh cũ */
function commandJson() {
  return [panelCommand.toJSON(), soduCommand.toJSON(), gachtheCommand.toJSON()];
}

/* ------------------------------------------------------------------ */
/*  Bảng Panel (embed + nút)                                            */
/* ------------------------------------------------------------------ */

/** Trạng thái bot dùng cho panel: 'online' | 'rest' | 'off' | 'connecting' */
function botStatus(ctx) {
  if (ctx.store.botOff) return { key: 'off', label: '🔴 ĐANG TẮT (botOff)' };
  const s = afk.getAfkStatus();
  if (s.enabled && s.resting) {
    const mins = Math.max(1, Math.round(s.remainingMs / 60000));
    return { key: 'rest', label: `💤 NGHỈ AFK (~${mins} phút nữa vào lại)` };
  }
  if (isMcOnline(ctx)) {
    return { key: 'online', label: `🟢 ONLINE @ \`${ctx.manager.serverLabel}\`` };
  }
  return { key: 'connecting', label: '🟡 ĐANG KẾT NỐI SERVER...' };
}

/** Dựng nội dung Panel (embed + hàng nút) */
function buildPanel(ctx) {
  const { baseAmount, basePrice, currency } = ctx.store.price;
  const stock = ctx.store.getStock();
  const status = botStatus(ctx);
  const isOut = stock <= 0n || status.key !== 'online';

  // --- Ảnh Panel: thumbnail và banner từ .env ---
  const thumbnailUrl = (process.env.PANEL_THUMBNAIL_URL || '').trim();
  const bannerUrl = (process.env.PANEL_BANNER_URL || '').trim();

  const embed = new EmbedBuilder()
    .setColor(status.key === 'online' ? (isOut ? 0xed4245 : 0x2b2d31) : COLOR_WARN)
    .setTitle('💰 Cửa Hàng Tiền In-Game — Minecraft Bedrock')
    .setDescription(
      [
        '```',
        `   MUA TIỀN GAME — GIAO TỰ ĐỘNG QUA BOT   `,
        '```',
        `🤖 **Trạng thái bot:** ${status.label}`,
      ].join('\n')
    )
    .addFields(
      {
        name: '🏷️ Giá bán',
        value: `\`${formatStock(baseAmount)}\` tiền game = **${formatNumber(basePrice)} ${currency}**`,
        inline: true,
      },
      {
        name: '📦 Kho hàng',
        value: stock <= 0n ? '`❌ Hết Hàng`' : `\`${formatStock(stock)}\` tiền game còn lại`,
        inline: true,
      },
      {
        name: '📋 Hướng dẫn mua',
        value: [
          '1️⃣ Bấm nút **💸 Mua Tiền** bên dưới',
          '2️⃣ Nhập số tiền game, phương thức & IGN',
          '• **Ngân hàng / Momo**: quét mã QR chuyển khoản',
          '• **Card / Thẻ cào**: nạp số dư bằng `/gachthe` rồi mua bằng số dư',
          '3️⃣ Bot **tự động `/pay`** tiền vào game cho bạn!',
        ].join('\n'),
      },
      {
        name: '⚠️ Lưu ý',
        value: [
          '🔴 Nhập ĐÚNG IGN — sai IGN không hoàn tiền',
          '🚫 Không spam hoặc tạo đơn sai mục đích',
          '💳 Nạp thẻ cào: dùng lệnh `/gachthe` • Xem số dư: `/sodu`',
        ].join('\n'),
      }
    )
    .setFooter({ text: `MC Bedrock Pay Bot • ${ctx.manager.serverLabel}` })
    .setTimestamp();

  // Đặt thumbnail (ảnh nhỏ góc phải) nếu có URL
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  // Đặt banner (ảnh lớn bên dưới) nếu có URL
  if (bannerUrl) embed.setImage(bannerUrl);

  const buyButton = new ButtonBuilder().setCustomId('buy_money');
  if (isOut) {
    buyButton
      .setLabel(status.key === 'online' ? '❌ Hết Hàng' : status.key === 'off' ? '🔴 Bot Đang Tắt' : '⏳ Tạm Dừng Bán')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true);
  } else {
    buyButton.setLabel('💸 Mua Tiền').setStyle(ButtonStyle.Success).setDisabled(false);
  }

  const row = new ActionRowBuilder().addComponents(
    buyButton,
    new ButtonBuilder().setCustomId('check_balance').setLabel('💳 Kiểm tra số dư').setStyle(ButtonStyle.Secondary)
  );

  return { embeds: [embed], components: [row] };
}

/** Cập nhật tin nhắn Panel đã đăng (nếu có lưu vị trí) */
async function updatePanel(ctx) {
  try {
    const ref = ctx.store.panelMessage;
    if (!ref?.channelId || !ref?.messageId) return false;

    const channel = await ctx.discord.channels.fetch(ref.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;
    const msg = await channel.messages.fetch(ref.messageId).catch(() => null);
    if (!msg) return false;

    // Chỉ sửa nếu bot là người gửi tin nhắn đó
    if (msg.author?.id !== ctx.discord.user?.id) return false;

    await msg.edit(buildPanel(ctx));
    return true;
  } catch (err) {
    console.warn(`[Shop] Lỗi updatePanel: ${err.message}`);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Lệnh /panel — đăng Panel và lưu vị trí                              */
/* ------------------------------------------------------------------ */

async function executePanel(ctx, interaction) {
  const payload = buildPanel(ctx);
  const reply = await interaction.reply({ ...payload, fetchReply: true });
  ctx.store.setPanelMessage(reply.channelId, reply.id);
  webLog(ctx, `📌 Panel đã đăng tại kênh <#${reply.channelId}> (tin nhắn ${reply.id}) — sẽ tự cập nhật giá/kho.`);
  return true;
}

/* ------------------------------------------------------------------ */
/*  Lệnh /sodu                                                          */
/* ------------------------------------------------------------------ */

async function executeSodu(ctx, interaction) {
  const balance = balances.getBalance(interaction.user.id);
  const { baseAmount, basePrice } = ctx.store.price;
  const convertible = balance > 0 ? (BigInt(balance) * BigInt(baseAmount)) / BigInt(basePrice) : 0n;

  const embed = new EmbedBuilder()
    .setColor(COLOR_INFO)
    .setTitle('💳 Số Dư Cá Nhân')
    .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
    .setDescription(
      [
        `Xin chào **${interaction.user.username}**, đây là số dư của bạn:`,
        '',
        `💵 **Số dư hiện có:** \`${formatNumber(balance)} VNĐ\``,
        convertible > 0n ? `💰 **Quy đổi tiền game:** \`~${formatStock(convertible)}\`` : '',
        '',
        `━━━━━━━━━━━━━━━━━━━━━━━━━━`,
        `💡 **Hướng dẫn:**`,
        `• Nạp thêm: dùng lệnh \`/gachthe\` (thẻ cào)`,
        `• Mua tiền game: bấm **💸 Mua Tiền** trên Panel, chọn phương thức \`card\` hoặc \`thẻ cào\``,
      ]
        .filter(Boolean)
        .join('\n')
    )
    .setFooter({ text: 'Số dư được lưu an toàn trên máy chủ bot' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

/* ------------------------------------------------------------------ */
/*  Lệnh /gachthe — nạp thẻ cào vào số dư                               */
/* ------------------------------------------------------------------ */

async function executeGachthe(ctx, interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!cardService.isConfigured()) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_WARN)
          .setTitle('⌨️ Chưa cấu hình thẻ cào')
          .setDescription(
            'Hệ thống thẻ cào chưa được cấu hình trên bot.\nVui lòng liên hệ quản trị viên hoặc thanh toán bằng **chuyển khoản QR** trên Panel.'
          ),
      ],
    });
  }

  const telco = interaction.options.getString('telco');
  const amount = interaction.options.getInteger('amount');
  const code = interaction.options.getString('code').trim();
  const serial = interaction.options.getString('serial').trim();

  if (!/^[a-zA-Z0-9]+$/.test(code) || !/^[a-zA-Z0-9]+$/.test(serial)) {
    return interaction.editReply({
      content: '❌ Mã thẻ (PIN) và số serial chỉ được chứa chữ cái và số, không chứa ký tự đặc biệt hoặc dấu cách.',
    });
  }

  const requestId = `CARD_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

  webLog(ctx, `[Gạch Thẻ] ${interaction.user.tag} nạp thẻ ${telco} ${formatNumber(amount)}đ (serial: ${serial})`);

  // Lưu thẻ chờ callback xác nhận
  if (interaction.client.pendingCards) {
    interaction.client.pendingCards.set(requestId, {
      requestId,
      userId: interaction.user.id,
      userTag: interaction.user.tag,
      telco,
      code,
      serial,
      amount,
      createdAt: Date.now(),
    });
  }

  const result = await cardService.sendCard({ telco, code, serial, amount, requestId });

  if (!result.success) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_ERR)
          .setTitle('❌ Gửi Thẻ Thất Bại')
          .setDescription(`Lỗi kết nối tới hệ thống gạch thẻ: \`${result.error}\`\nVui lòng thử lại sau ít phút hoặc báo quản trị viên.`)
          .setTimestamp(),
      ],
    });
  }

  const responseData = result.data ?? {};
  const statusCode = Number(responseData.status);
  const statusMsg = responseData.message || cardService.getStatusDescription(statusCode);

  /* ---- 99: đang chờ nhà mạng duyệt ---- */
  if (statusCode === 99) {
    const currentBalance = balances.getBalance(interaction.user.id);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_WARN)
          .setTitle('⏳ Thẻ Đang Chờ Xử Lý')
          .setDescription(
            [
              'Hệ thống đã tiếp nhận thẻ và gửi tới nhà mạng để thẩm định.',
              'Khi duyệt thành công, tiền sẽ **tự động cộng** vào số dư của bạn!',
              '',
              `**Nhà mạng:** \`${telco}\``,
              `**Mệnh giá khai báo:** \`${formatNumber(amount)} VNĐ\``,
              `**Số dư hiện tại:** \`${formatNumber(currentBalance)} VNĐ\``,
              `**Mã giao dịch:** \`${requestId}\``,
              '',
              `💡 *Dùng \`/sodu\` để kiểm tra số dư bất cứ lúc nào.*`,
            ].join('\n')
          )
          .setFooter({ text: 'Vui lòng không gửi lại thẻ nhiều lần' })
          .setTimestamp(),
      ],
    });
  }

  /* ---- 1: thành công đúng mệnh giá ---- */
  if (statusCode === 1) {
    const deposit = await balances.addBalance(interaction.user.id, amount, 'CARD_INSTANT', { telco, serial, requestId });
    const newBalance = deposit.success ? deposit.newBalance : balances.getBalance(interaction.user.id);
    webLog(ctx, `[Gạch Thẻ] ✅ ${interaction.user.tag} nạp thành công +${formatNumber(amount)}đ (số dư: ${formatNumber(newBalance)}đ)`);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_OK)
          .setTitle('✅ Nạp Thẻ Cào Thành Công!')
          .setDescription(
            [
              'Thẻ đã được gạch thành công và cộng vào số dư của bạn!',
              '',
              `**Nhà mạng:** \`${telco}\``,
              `**Mệnh giá nạp:** \`+${formatNumber(amount)} VNĐ\``,
              `**Số dư hiện tại:** \`${formatNumber(newBalance)} VNĐ\``,
              '',
              `👉 *Dùng số dư này mua tiền game qua nút **💸 Mua Tiền** trên Panel!*`,
            ].join('\n')
          )
          .setTimestamp(),
      ],
    });
  }

  /* ---- 2: thành công nhưng sai mệnh giá -> cộng theo số thực nhận ---- */
  if (statusCode === 2 && responseData.amount) {
    const realAmount = Number(responseData.amount) || amount;
    await balances.addBalance(interaction.user.id, realAmount, 'CARD_WRONG_PRICE', { telco, serial, requestId });
    const newBalance = balances.getBalance(interaction.user.id);
    webLog(ctx, `[Gạch Thẻ] ⚠️ ${interaction.user.tag} nạp thẻ sai mệnh giá: +${formatNumber(realAmount)}đ`);

    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_WARN)
          .setTitle('⚠️ Thẻ Sai Mệnh Giá — Đã Cộng Theo Giá Trị Thực')
          .setDescription(
            [
              `Thẻ của bạn **không đúng mệnh giá đã chọn** (${formatNumber(amount)} VNĐ).`,
              `Hệ thống đã cộng theo giá trị thực của thẻ:`,
              '',
              `**Cộng vào số dư:** \`+${formatNumber(realAmount)} VNĐ\``,
              `**Số dư hiện tại:** \`${formatNumber(newBalance)} VNĐ\``,
            ].join('\n')
          )
          .setTimestamp(),
      ],
    });
  }

  /* ---- Lỗi khác ---- */
  interaction.client.pendingCards?.delete(requestId);
  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setColor(COLOR_ERR)
        .setTitle('❌ Nạp Thẻ Không Thành Công')
        .setDescription(
          [
            'Hệ thống từ chối thẻ của bạn.',
            '',
            `**Trạng thái:** \`${statusMsg}\` (mã ${statusCode})`,
            `**Nhà mạng:** \`${telco}\``,
            `**Serial:** \`${serial}\``,
            `**Mệnh giá:** \`${formatNumber(amount)} VNĐ\``,
            '',
            `*Gợi ý: kiểm tra lại mã PIN/serial, hoặc thẻ đã từng sử dụng chưa.*`,
          ].join('\n')
        )
        .setTimestamp(),
    ],
  });
}

/* ------------------------------------------------------------------ */
/*  MUA BẰNG SỐ DƯ CÁ NHÂN                                              */
/* ------------------------------------------------------------------ */

async function executeBalancePurchase(ctx, interaction, vnd, ign) {
  const userId = interaction.user.id;
  const release = await balances.acquireLock(userId);

  try {
    const { baseAmount, basePrice } = ctx.store.price;

    const numericVnd = Math.floor(Number(vnd));
    if (!Number.isFinite(numericVnd) || numericVnd <= 0) {
      return interaction.reply({
        content: '❌ **Số tiền không hợp lệ!** Nhập số VNĐ hợp lệ (ví dụ: `10000`, `20k`, `50k`, `100k`...).',
        flags: MessageFlags.Ephemeral,
      });
    }

    const lock = afk.getBuyLock(ctx);
    if (lock) {
      return interaction.reply({ content: `⛔ ${lock}`, flags: MessageFlags.Ephemeral });
    }

    // 1. Kiểm tra số dư cá nhân
    const currentBalance = balances.getBalance(userId);
    if (currentBalance < numericVnd) {
      return interaction.reply({
        content: `❌ **Số dư của bạn không đủ!**\n💵 Hiện có: **${formatNumber(currentBalance)} VNĐ**\n💸 Cần: **${formatNumber(numericVnd)} VNĐ**\n👉 Dùng \`/gachthe\` để nạp thêm thẻ cào!`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 2. Quy đổi sang tiền game (BigInt — không mất chính xác)
    const gameMoney = (BigInt(numericVnd) * BigInt(Math.floor(baseAmount))) / BigInt(Math.floor(basePrice));
    if (gameMoney <= 0n) {
      return interaction.reply({
        content: `❌ **${formatNumber(numericVnd)} VNĐ** chưa đủ mua tối thiểu theo tỷ giá hiện tại (\`${formatStock(baseAmount)}\` = ${formatNumber(basePrice)} VNĐ).`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 3. Kiểm tra kho
    if (gameMoney > ctx.store.getStock()) {
      return interaction.reply({
        content: `❌ **Kho không đủ!**\nYêu cầu: **${formatStock(gameMoney)}**\nKho còn: **${formatStock(ctx.store.getStock())}**. Vui lòng liên hệ quản trị viên.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // 4. Bot Bedrock phải đang online
    if (!isMcOnline(ctx)) {
      return interaction.reply({
        content: '❌ **Bot in-game đang ngoại tuyến.** Vui lòng thử lại sau ít phút hoặc báo quản trị viên.',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 5. Trừ số dư an toàn TRƯỚC khi gửi lệnh (chống double-spend)
    const deduct = await balances.deductBalance(userId, numericVnd, 'BUY_MONEY', { ign, gameMoney: gameMoney.toString() });
    if (!deduct.success) {
      return interaction.reply({ content: `❌ ${deduct.error}`, flags: MessageFlags.Ephemeral });
    }

    webLog(ctx, `[Số dư] ${interaction.user.tag} mua ${formatStock(gameMoney)} bằng ${formatNumber(numericVnd)}đ — IGN: ${ign}`);

    // 6. Bot thực hiện /pay trong game
    const pay = await executeGamePay(ctx, ign, gameMoney);
    if (pay.state === 'failed' || pay.state === 'offline') {
      // HOÀN TIỀN TỰ ĐỘNG
      await balances.addBalance(userId, numericVnd, 'ROLLBACK_PAY_FAILED', { ign, gameMoney: gameMoney.toString() });
      webLog(ctx, `[Số dư] ❌ /pay ${ign} thất bại (${pay.state}) — đã hoàn ${formatNumber(numericVnd)}đ cho ${interaction.user.tag}`);
      return interaction.reply({
        content: '❌ **Chưa gửi được lệnh trong game.** Hệ thống đã **tự động hoàn tiền** vào số dư của bạn. Vui lòng thử lại sau!',
        flags: MessageFlags.Ephemeral,
      });
    }

    // 7. Thành công: trừ kho, lưu đơn, cập nhật panel
    ctx.store.deductStock(gameMoney);
    orders.saveOrder({
      orderId: orders.generateOrderId(),
      userId,
      userTag: interaction.user.tag,
      ign,
      gameMoney: gameMoney.toString(),
      amount: gameMoney.toString(),
      totalPrice: numericVnd,
      amountVnd: numericVnd,
      currency: ctx.store.price.currency,
      paymentMethod: 'Số dư thẻ cào',
      status: 'COMPLETED',
      completedAt: new Date().toISOString(),
      paidInfo: (pay.lines ?? []).find((l) => l.kind === 'ok')?.text?.slice(0, 200) ?? 'đã gửi lệnh',
    });
    updatePanel(ctx).catch(() => {});
    if (ctx.io) ctx.io.emit('configUpdate', ctx.store.data);

    const newBalance = balances.getBalance(userId);
    webLog(ctx, `[Số dư] ✅ ${interaction.user.tag} mua thành công ${formatStock(gameMoney)} — IGN: ${ign}`);

    // 8. Thông báo thành công kèm ảnh chụp tách nền /pay
    const fileName = `pay-balance-${Date.now()}.png`;
    let shotFile = null;
    let shotBuffer = null;
    try {
      const { renderPayCropScreenshot } = require('../screenshot');
      shotBuffer = await renderPayCropScreenshot({
        lines: pay.lines,
        ign,
        amount: formatStock(gameMoney),
      });
      if (shotBuffer) {
        shotFile = new AttachmentBuilder(shotBuffer, { name: fileName });
      }
    } catch (err) {
      console.warn(`[Shop] Render pay proof lỗi: ${err.message}`);
    }

    const successEmbed = new EmbedBuilder()
      .setColor(COLOR_OK)
      .setTitle('🎉 Mua Tiền Game Thành Công!')
      .setDescription(
        [
          'Giao dịch thanh toán bằng **Số Dư Thẻ Cào** đã hoàn tất!',
          '',
          `💰 **Số tiền nhận:** \`${formatStock(gameMoney)}\` (${formatNumber(Number(gameMoney))} in-game)`,
          `💵 **Đã trừ số dư:** \`-${formatNumber(numericVnd)} VNĐ\``,
          `💳 **Số dư còn lại:** \`${formatNumber(newBalance)} VNĐ\``,
          `🎮 **IGN nhận:** \`${ign}\``,
          `🤖 **Lệnh đã thực thi:** \`/pay ${ign} ${formatStock(gameMoney)}\``,
          '',
          `*Chúc bạn chơi game vui vẻ! Có vấn đề gì hãy liên hệ quản trị viên.*`,
        ].join('\n')
      )
      .setTimestamp();

    if (shotFile) {
      successEmbed.setImage(`attachment://${fileName}`);
    }

    const replyPayload = shotFile
      ? { embeds: [successEmbed], files: [shotFile], flags: MessageFlags.Ephemeral }
      : { embeds: [successEmbed], flags: MessageFlags.Ephemeral };
    await interaction.reply(replyPayload);

    const dmPayload = shotFile ? { embeds: [successEmbed], files: [shotFile] } : { embeds: [successEmbed] };
    dmUser(ctx, userId, dmPayload).catch(() => {});

    await notifyAdmin(
      ctx,
      {
        title: 'Đơn mua bằng số dư COMPLETED',
        fields: [
          { name: 'Người mua', value: `${interaction.user.tag} (${userId})` },
          { name: 'IGN', value: ign },
          { name: 'Tiền game', value: `${formatStock(gameMoney)} (${formatNumber(Number(gameMoney))})` },
          { name: 'VNĐ đã trừ', value: `-${formatNumber(numericVnd)} VNĐ` },
          { name: 'Số dư còn lại', value: `${formatNumber(newBalance)} VNĐ` },
        ],
      },
      shotBuffer
    );

    try {
      await sendFeedbackThanks(ctx, {
        userId,
        ign,
        gameMoney: formatStock(gameMoney),
        vnd: numericVnd,
        paymentMethod: 'Số Dư Thẻ Cào',
      });
    } catch {}
  } finally {
    release();
  }
}

/* ------------------------------------------------------------------ */
/*  ĐƠN HÀNG QR — CHUYỂN KHOẢN NGÂN HÀNG / MOMO                         */
/* ------------------------------------------------------------------ */

function getBankInfo() {
  let bin = String(process.env.BANK_BIN || '').trim();
  let account = String(process.env.BANK_ACCOUNT_NUMBER || '').trim();
  let name = String(process.env.BANK_ACCOUNT_NAME || '').trim();
  if (bin.includes('YOUR_')) bin = '';
  if (account.includes('YOUR_')) account = '';
  if (name.includes('YOUR_')) name = '';
  return { bin, account, name };
}

function isBankConfigured() {
  const { bin, account } = getBankInfo();
  return !!(bin && account);
}

/**
 * Tải ảnh mã QR và đảm bảo xuất ra định dạng PNG thực thụ (Discord không hỗ trợ nhúng SVG)
 * Hỗ trợ nguồn chính VietQR + nguồn dự phòng SePay QR
 */
async function fetchAndConvertQrPng(bin, account, name, amount, memo) {
  // 1. Thử VietQR
  const vietQrUrl =
    `https://img.vietqr.io/image/${bin}-${account}-compact2.png` +
    `?amount=${amount}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(name || 'MC SHOP')}`;

  try {
    const res = await fetch(vietQrUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'image/png,image/svg+xml,image/*,*/*',
      },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      // Nếu đã là chuẩn PNG (magic bytes 0x89 0x50 0x4E 0x47)
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return buf;
      }
      // VietQR thường trả SVG -> render sang PNG thực thụ qua canvas để Discord hiển thị
      try {
        const img = await loadImage(buf);
        const canvas = createCanvas(img.width || 540, img.height || 640);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return canvas.toBuffer('image/png');
      } catch (canvasErr) {
        console.warn(`[Shop/VietQR] Lỗi render SVG -> PNG: ${canvasErr.message}`);
      }
    }
  } catch (err) {
    console.warn(`[Shop/VietQR] Lỗi tải VietQR (${err.message}), chuyển sang nguồn dự phòng...`);
  }

  // 2. Nguồn dự phòng: SePay QR generator (trả trực tiếp file PNG)
  try {
    const bankMap = {
      '970422': 'MBBank',
      '970436': 'Vietcombank',
      '970407': 'Techcombank',
      '970415': 'VietinBank',
      '970418': 'BIDV',
      '970423': 'TPBank',
      '970405': 'Agribank',
      '970432': 'VPBank',
      '970441': 'VIB',
      '970416': 'ACB',
    };
    const bankName = bankMap[bin] || (bin === 'MB' ? 'MBBank' : bin);
    const sepayUrl = `https://qr.sepay.vn/img?acc=${encodeURIComponent(account)}&bank=${encodeURIComponent(bankName)}&amount=${amount}&des=${encodeURIComponent(memo)}`;

    const res = await fetch(sepayUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(6000),
    });

    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        return buf;
      }
      try {
        const img = await loadImage(buf);
        const canvas = createCanvas(img.width || 500, img.height || 500);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return canvas.toBuffer('image/png');
      } catch {}
    }
  } catch (err) {
    console.warn(`[Shop/SePayQR] Lỗi tải SePay QR: ${err.message}`);
  }

  return null;
}

async function createQrOrder(ctx, interaction, { amountBig, rawAmount, ign }) {
  const userId = interaction.user.id;
  const lock = afk.getBuyLock(ctx);
  if (lock) {
    return interaction.reply({ content: `⛔ ${lock}`, flags: MessageFlags.Ephemeral });
  }

  const stock = ctx.store.getStock();
  if (amountBig > stock) {
    return interaction.reply({
      content: `❌ Không đủ hàng! Còn lại: **${formatStock(stock)}** — bạn yêu cầu: **${formatStock(amountBig)}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (!isBankConfigured()) {
    return interaction.reply({
      content: '❌ **Chưa cấu hình tài khoản nhận chuyển khoản.** Vui lòng liên hệ quản trị viên hoặc dùng phương thức `card` (số dư thẻ cào).',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Defer ngay lập tức để không bị lỗi timeout 3s của Discord khi tải mã QR
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const { baseAmount, basePrice, currency } = ctx.store.price;
  const totalPrice = Number(ctx.store.priceFor(amountBig)); // VNĐ
  const orderId = orders.generateOrderId();

  const ignForMemo = ign.replace(/[^a-zA-Z0-9]/g, '');
  const memo = `muamon ${orderId} ${ignForMemo}`.trim();

  const { bin, account, name } = getBankInfo();

  // Lưu đơn (RAM + disk) để webhook/polling ngân hàng đối soát
  const orderData = {
    orderId,
    userId,
    userTag: interaction.user.tag,
    channelId: interaction.channelId,
    ign,
    ignForMemo,
    memo,
    gameMoney: amountBig.toString(),
    amount: amountBig.toString(),
    rawAmount,
    totalPrice,
    currency,
    paymentMethod: 'Ngân hàng / VietQR',
    status: 'PENDING_PAYMENT',
    createdAt: new Date().toISOString(),
  };
  orders.saveOrder(orderData);
  ctx.discord.pendingOrders.set(userId, orderData);

  // Hết hạn đơn sau ORDER_TIMEOUT_MINUTES phút
  const timeoutMin = Math.min(120, Math.max(5, Number.parseInt(process.env.ORDER_TIMEOUT_MINUTES, 10) || 15));
  setTimeout(async () => {
    const still = ctx.discord.pendingOrders.get(userId);
    if (still && still.orderId === orderId) {
      ctx.discord.pendingOrders.delete(userId);
      orders.updateOrderStatus(orderId, 'EXPIRED');
      webLog(ctx, `⏰ Đơn ${orderId} của ${interaction.user.tag} hết hạn sau ${timeoutMin} phút không thanh toán.`);
      await dmUser(ctx, userId, {
        content: `⏰ **Đơn \`${orderId}\` của bạn đã bị hủy do quá ${timeoutMin} phút không thanh toán.** Vui lòng tạo đơn mới nếu cần.`,
      }).catch(() => {});
    }
  }, timeoutMin * 60 * 1000);

  webLog(ctx, `🧾 Đơn mới ${orderId}: ${interaction.user.tag} — ${formatStock(amountBig)} tiền game — ${formatNumber(totalPrice)} ${currency} — IGN: ${ign}`);

  const bankDisplayName = bin === '970422' ? 'MBBank' : bin === '970436' ? 'Vietcombank' : `Ngân hàng (${bin})`;

  const embed = new EmbedBuilder()
    .setColor(COLOR_OK)
    .setTitle('📲 Mã QR Thanh Toán')
    .setDescription(
      [
        `**Số tiền mua:** \`${formatStock(amountBig)}\` tiền game`,
        `**Tổng thanh toán:** \`${formatNumber(totalPrice)} ${currency}\``,
        `**IGN của bạn:** \`${ign}\``,
        `**Mã đơn hàng:** \`${orderId}\``,
        '',
        '**Thông tin tài khoản:**',
        `• Ngân hàng: **${bankDisplayName}** (BIN: \`${bin}\`)`,
        `• Số tài khoản: \`${account}\``,
        name ? `• Chủ tài khoản: **${name}**` : '',
        '',
        '**Nội dung chuyển khoản (bắt buộc):**',
        `\`\`\`${memo}\`\`\``,
        '',
        '⚠️ **Bạn PHẢI chuyển ĐÚNG số tiền và ĐÚNG nội dung trên**, nếu không hệ thống không tự động đối soát được.',
        '',
        `⏳ Đơn tự hủy sau **${timeoutMin} phút**. Sau khi bot nhận được tiền, tiền game sẽ **tự động vào game** của bạn!`,
      ]
        .filter(Boolean)
        .join('\n')
    )
    .setFooter({ text: `Mã đơn ${orderId} • Quét mã QR bên dưới để thanh toán` })
    .setTimestamp();

  // Tải và chuẩn hóa ảnh QR sang file PNG thực thụ
  const pngBuffer = await fetchAndConvertQrPng(bin, account, name, totalPrice, memo);
  if (pngBuffer) {
    const attachment = new AttachmentBuilder(pngBuffer, { name: `qr-${orderId}.png` });
    embed.setImage(`attachment://qr-${orderId}.png`);
    return interaction.editReply({ embeds: [embed], files: [attachment] });
  }

  // Dự phòng khi mất kết nối tới các dịch vụ tạo QR ảnh
  const directVietQr = `https://img.vietqr.io/image/${bin}-${account}-compact2.png?amount=${totalPrice}&addInfo=${encodeURIComponent(memo)}&accountName=${encodeURIComponent(name || 'MC SHOP')}`;
  embed.setImage(directVietQr);
  return interaction.editReply({ embeds: [embed] });
}

/* ------------------------------------------------------------------ */
/*  Xử lý NÚT + MODAL                                                   */
/* ------------------------------------------------------------------ */

async function handleInteraction(ctx, interaction) {
  /* ---------- Slash commands của shop ---------- */
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'panel':
        return executePanel(ctx, interaction);
      case 'sodu':
        return executeSodu(ctx, interaction);
      case 'gachthe':
        return executeGachthe(ctx, interaction);
      default:
        return false; // không phải lệnh của shop
    }
  }

  /* ---------- Nút ---------- */
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id === 'buy_money') {
      const lock = afk.getBuyLock(ctx);
      if (lock) return interaction.reply({ content: `⛔ ${lock}`, flags: MessageFlags.Ephemeral });
      if (ctx.store.getStock() <= 0n) {
        return interaction.reply({ content: '❌ **Hiện kho đã hết hàng!** Vui lòng quay lại sau khi quản trị viên nạp thêm.', flags: MessageFlags.Ephemeral });
      }

      const modal = new ModalBuilder().setCustomId('buy_money_modal').setTitle('💰 Mua tiền in-game');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount')
            .setLabel('Số tiền game muốn mua')
            .setPlaceholder('Ví dụ: 100m, 2.5b, 500k')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('payment_method')
            .setLabel('Phương thức thanh toán')
            .setPlaceholder('Ngân hàng / Momo / Card (số dư thẻ cào)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ign')
            .setLabel('Tên nhân vật (IGN) nhận tiền')
            .setPlaceholder('< nếu dùng acc PE, thêm "." trước tên VD: .accounts1 >')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(64)
        )
      );
      return interaction.showModal(modal);
    }

    if (id === 'check_balance') {
      const balance = balances.getBalance(interaction.user.id);
      const { baseAmount, basePrice } = ctx.store.price;
      const convertible = balance > 0 ? (BigInt(balance) * BigInt(baseAmount)) / BigInt(basePrice) : 0n;
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_INFO)
            .setTitle('💳 Số dư của bạn')
            .setDescription(
              [
                `💵 **Số dư:** \`${formatNumber(balance)} VNĐ\``,
                convertible > 0n ? `💰 **Quy đổi:** \`~${formatStock(convertible)}\` tiền game` : '',
                '',
                `• Nạp thẻ cào: \`/gachthe\``,
              ]
                .filter(Boolean)
                .join('\n')
            ),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }

    if (id.startsWith('card_open_modal_')) {
      const ign = getIgnToken(id.replace('card_open_modal_', ''));
      if (!ign) {
        return interaction.reply({ content: '⌛ Phiên đã hết hạn, vui lòng bấm mua lại từ Panel.', flags: MessageFlags.Ephemeral });
      }
      const balance = balances.getBalance(interaction.user.id);
      const token = putIgnToken(ign);

      const modal = new ModalBuilder().setCustomId(`card_balance_modal_${token}`).setTitle('💳 Mua bằng số dư');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('amount_vnd')
            .setLabel(`Số tiền VNĐ (số dư: ${formatNumber(balance)}đ)`.slice(0, 45))
            .setPlaceholder('Ví dụ: 10000, 20k, 50k, 100000')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('ign')
            .setLabel('Tên nhân vật (IGN) nhận tiền')
            .setValue(ign.slice(0, 64))
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(64)
        )
      );
      return interaction.showModal(modal);
    }

    if (id.startsWith('card_instant_')) {
      // card_instant_<vnd>_<token>
      const rest = id.replace('card_instant_', '');
      const vnd = Number(rest.split('_')[0]);
      const token = rest.slice(rest.indexOf('_') + 1);
      const ign = getIgnToken(token);
      if (!ign || !Number.isFinite(vnd) || vnd <= 0) {
        return interaction.reply({ content: '⌛ Phiên đã hết hạn, vui lòng bấm mua lại từ Panel.', flags: MessageFlags.Ephemeral });
      }
      return executeBalancePurchase(ctx, interaction, vnd, ign);
    }

    return false;
  }

  /* ---------- Modal ---------- */
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'buy_money_modal') {
      const rawAmount = interaction.fields.getTextInputValue('amount');
      const paymentMethod = interaction.fields.getTextInputValue('payment_method');
      const ign = interaction.fields.getTextInputValue('ign').trim();

      const parsed = parseGameAmount(rawAmount);
      if (!parsed.ok) {
        return interaction.reply({ content: `❌ ${parsed.error}`, flags: MessageFlags.Ephemeral });
      }

      // ── Thanh toán bằng số dư thẻ cào ──
      if (/card|th[eẻ]\s*c[aà]o|s[oố]\s*d[uư]/i.test(paymentMethod)) {
        const balance = balances.getBalance(interaction.user.id);
        if (balance <= 0) {
          return interaction.reply({
            content: `❌ **Bạn chưa có số dư thẻ cào!**\n👉 Dùng lệnh \`/gachthe\` để nạp thẻ cào vào tài khoản trước khi mua.`,
            flags: MessageFlags.Ephemeral,
          });
        }

        const totalPrice = Number(ctx.store.priceFor(parsed.value));
        const token = putIgnToken(ign);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`card_open_modal_${token}`)
            .setLabel('💰 Nhập số tiền VNĐ muốn mua')
            .setStyle(ButtonStyle.Primary)
        );

        // Đủ tiền -> thêm nút mua luôn
        if (totalPrice <= balance) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`card_instant_${totalPrice}_${token}`)
              .setLabel(`⚡ Mua luôn ${formatStock(parsed.value)} (${formatNumber(totalPrice)}đ)`)
              .setStyle(ButtonStyle.Success)
          );
        }

        const embed = new EmbedBuilder()
          .setColor(COLOR_INFO)
          .setTitle('💳 Thanh Toán Bằng Số Dư Thẻ Cào')
          .setDescription(
            [
              `Chào **${interaction.user.username}**, bạn chọn thanh toán bằng **số dư thẻ cào**:`,
              '',
              `💵 **Số dư hiện có:** \`${formatNumber(balance)} VNĐ\``,
              `🏷️ **Tỷ giá:** \`${formatStock(ctx.store.price.baseAmount)}\` = \`${formatNumber(ctx.store.price.basePrice)} ${ctx.store.price.currency}\``,
              `🎮 **IGN:** \`${ign}\``,
              '',
              totalPrice <= balance
                ? `💡 *Bấm **⚡ Mua Luôn** để mua \`${formatStock(parsed.value)}\` với giá \`${formatNumber(totalPrice)} VNĐ\`, hoặc nhập số tiền VNĐ khác.*`
                : `💡 *Số dư (${formatNumber(balance)}đ) chưa đủ mua ${formatStock(parsed.value)} (${formatNumber(totalPrice)}đ). Bấm nút bên dưới để nhập số tiền bạn muốn chi!*`,
            ].join('\n')
          )
          .setFooter({ text: 'Số dư bảo mật — chỉ bạn nhìn thấy tin nhắn này' });

        return interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
      }

      // ── Chuyển khoản ngân hàng / Momo -> QR ──
      return createQrOrder(ctx, interaction, { amountBig: parsed.value, rawAmount: rawAmount.trim(), ign });
    }

    if (interaction.customId.startsWith('card_balance_modal_')) {
      const token = interaction.customId.replace('card_balance_modal_', '');
      const ignFromToken = getIgnToken(token);
      const rawVnd = interaction.fields.getTextInputValue('amount_vnd');
      const ign = interaction.fields.getTextInputValue('ign').trim();

      const parsedVnd = parseVnd(rawVnd);
      if (!parsedVnd) {
        return interaction.reply({
          content: '❌ **Số tiền VNĐ không hợp lệ!** Dùng định dạng: `10000`, `20k`, `50k`, `100k`...',
          flags: MessageFlags.Ephemeral,
        });
      }
      return executeBalancePurchase(ctx, interaction, parsedVnd, ign || ignFromToken || 'Không rõ');
    }

    return false;
  }

  return false;
}

module.exports = {
  commandJson,
  buildPanel,
  updatePanel,
  executePanel,
  executeSodu,
  executeGachthe,
  handleInteraction,
  isBankConfigured,
};
