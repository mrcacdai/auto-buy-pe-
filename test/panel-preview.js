'use strict';

/**
 * ============================================================
 *  test/panel-preview.js — XEM TRƯỚC PANEL MỚI KHÔNG CẦN BOT
 * ============================================================
 *  Server giả lập toàn bộ API của web panel (Express + Socket.io)
 *  với dữ liệu mẫu, để bạn xem trước giao diện Nova Panel v3:
 *
 *      node test/panel-preview.js
 *      → mở http://localhost:3100
 *
 *  Có đầy đủ: trạng thái, cấu hình giá/kho, đổi server (giả),
 *  botoff/boton, đơn hàng 14 ngày, số dư + lịch sử, thống kê,
 *  console live (log + chat giả). KHÔNG đụng vào data/ thật.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server: SocketIOServer } = require('socket.io');

const PORT = Number(process.env.MOCK_PORT || 3100);
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || '').trim(); // đặt để thử màn hình khóa
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(express.json());

/* Khóa panel giống web/server.js: mọi /api/* yêu cầu ?key= hoặc x-panel-key */
if (PANEL_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      const key = req.query.key || req.headers['x-panel-key'];
      if (key !== PANEL_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  });
}

app.use(express.static(path.join(__dirname, '..', 'web', 'public')));

/* ═══════════ DỮ LIỆU MẪU ═══════════ */
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (arr) => arr[rnd(0, arr.length - 1)];

const IGNS = ['kurimeee', '.steve', '~Steve#123', 'DuyProVn', 'MinhBedrock', 'tanphat2011', 'KaitoKid', 'LunaMC', ' HungVn ', 'ZeroTwo'];
const METHODS = ['QR Ngân hàng (VietQR)', 'Số dư cá nhân', 'Thẻ cào (Viettel)', 'Ngân hàng (tự nhận diện nội dung)'];
const STATUSES = ['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'PENDING_PAYMENT', 'WAITING_RETRY', 'EXPIRED', 'FAILED'];

const store = {
  price: { baseAmount: 1000000, basePrice: 10000, currency: 'VND' },
  stock: '2350000000',
  botOff: false,
};

/* ~46 đơn trải đều 14 ngày, nặng về 4-5 ngày gần nhất */
function seedOrders() {
  const orders = [];
  const now = Date.now();
  for (let i = 0; i < 46; i++) {
    const skew = Math.pow(Math.random(), 1.6);
    const createdAt = new Date(now - skew * 13 * 86400000 - rnd(0, 20) * 3600000).toISOString();
    const gameMoney = BigInt(pick([1000000, 2000000, 5000000, 10000000, 20000000, 50000000, 100000000]));
    const totalPrice = Number((gameMoney * BigInt(store.price.basePrice)) / BigInt(store.price.baseAmount));
    const status = pick(STATUSES);
    orders.push({
      orderId: `DH${rnd(100000, 999999)}`,
      createdAt,
      userId: String(rnd(10 ** 17, 10 ** 18)),
      userTag: `${pick(['kuri', 'duy', 'minh', 'tan', 'luna', 'zero'])}#${rnd(1000, 9999)}`,
      ign: pick(IGNS).trim(),
      gameMoney: gameMoney.toString(),
      totalPrice: status === 'COMPLETED' || status === 'WAITING_RETRY' ? totalPrice : totalPrice,
      paymentMethod: pick(METHODS),
      status,
    });
  }
  return orders.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
const orders = seedOrders();
const startedAt = Date.now();

const balances = {};
for (let i = 0; i < 9; i++) balances[String(rnd(10 ** 17, 10 ** 18))] = rnd(1, 90) * 10000;
const history = [];
const HIST_TYPES = ['ADMIN_TOPUP', 'CARD_CALLBACK', 'BUY_GAME_MONEY', 'ADMIN_DEDUCT', 'ORDER_REFUND'];
for (let i = 0; i < 24; i++) {
  const type = pick(HIST_TYPES);
  history.push({
    id: `h${i}`,
    timestamp: new Date(startedAt - rnd(0, 13) * 86400000 - rnd(0, 86400) * 1000).toISOString(),
    userId: Object.keys(balances)[rnd(0, Object.keys(balances).length - 1)],
    type,
    amount: rnd(1, 60) * 10000,
    reason: type,
  });
}
history.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

/* ═══════════ /api/stats (giống web/server.js) ═══════════ */
function computeStats() {
  const now = Date.now();
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  const byDayMap = Object.fromEntries(days.map((d) => [d, { revenue: 0, count: 0 }]));
  const byStatus = {};
  const methodMap = new Map();
  const buyerMap = new Map();
  let revenue = 0;
  let revenueToday = 0;
  const today = days[days.length - 1];
  for (const o of orders) {
    const status = String(o.status ?? 'UNKNOWN');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const price = Number(o.totalPrice ?? 0) || 0;
    const day = String(o.createdAt ?? '').slice(0, 10);
    if (o.status === 'COMPLETED') {
      revenue += price;
      if (day === today) revenueToday += price;
      if (byDayMap[day]) {
        byDayMap[day].revenue += price;
        byDayMap[day].count += 1;
      }
      const method = String(o.paymentMethod ?? '—');
      const m = methodMap.get(method) ?? { method, count: 0, revenue: 0 };
      m.count += 1;
      m.revenue += price;
      methodMap.set(method, m);
      const buyer = String(o.ign ?? '—');
      const b = buyerMap.get(buyer) ?? { buyer, total: 0, count: 0 };
      b.total += price;
      b.count += 1;
      buyerMap.set(buyer, b);
    }
  }
  return {
    totals: { orders: orders.length, completed: byStatus.COMPLETED ?? 0, revenue, revenueToday },
    byStatus,
    byDay: days.map((d) => ({ day: d, revenue: byDayMap[d].revenue, count: byDayMap[d].count })),
    byMethod: [...methodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6),
    topBuyers: [...buyerMap.values()].sort((a, b) => b.total - a.total).slice(0, 5),
  };
}

/* ═══════════ API ═══════════ */
app.get('/api/status', (req, res) => {
  res.json({
    bot: { state: 'online' },
    mcState: 'online',
    server: 'play.novapanel.vn:19132',
    detected: { version: '1.21.51', protocol: '818' },
    discordReady: true,
    botOff: store.botOff,
    afk: { enabled: false, resting: false },
    bankConfigured: true,
    cardConfigured: true,
    stock: store.stock,
    price: store.price,
    pendingOrders: orders.filter((o) => o.status === 'PENDING_PAYMENT').length,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
  });
});

app.get('/api/config', (req, res) => res.json({ price: store.price, stock: store.stock, botOff: store.botOff }));

app.post('/api/config', (req, res) => {
  const { baseAmount, basePrice, currency, stock } = req.body ?? {};
  if (baseAmount !== undefined && Number(baseAmount) > 0) store.price.baseAmount = Math.floor(Number(baseAmount));
  if (basePrice !== undefined && Number(basePrice) > 0) store.price.basePrice = Math.floor(Number(basePrice));
  if (currency) store.price.currency = String(currency).slice(0, 8);
  if (stock !== undefined && String(stock).trim() !== '') {
    const m = String(stock).trim().toLowerCase().match(/^([+-])?\s*([0-9]*\.?[0-9]+)([kmbt])?$/);
    if (!m) return res.status(400).json({ success: false, error: 'Kho không hợp lệ' });
    const exp = { k: 3, m: 6, b: 9, t: 12 }[m[3] ?? ''] ?? 0;
    const [intPart, fracPart = ''] = m[2].split('.');
    const value = BigInt((intPart || '0') + fracPart.slice(0, exp).padEnd(exp, '0'));
    const old = BigInt(store.stock);
    store.stock = (m[1] === '+' ? old + value : m[1] === '-' ? old - value : value).toString();
  }
  io.emit('configUpdate', store);
  res.json({ success: true, config: store });
});

app.post('/api/server', (req, res) => {
  const { host, port } = req.body ?? {};
  if (!host) return res.status(400).json({ success: false, error: 'Thiếu host' });
  setTimeout(() => res.json({ success: true, detected: { version: '1.21.51', protocol: '818', players: rnd(3, 40) } }), 700);
});

app.post('/api/reconnect', (req, res) => res.json({ success: true, message: 'Đang kết nối lại server Minecraft...' }));

app.post('/api/botoff', (req, res) => {
  store.botOff = true;
  io.emit('configUpdate', store);
  res.json({ success: true });
});
app.post('/api/boton', (req, res) => {
  store.botOff = false;
  io.emit('configUpdate', store);
  res.json({ success: true });
});

app.post('/api/chat', (req, res) => {
  const { message } = req.body ?? {};
  if (!message) return res.status(400).json({ success: false, error: 'Thiếu nội dung' });
  io.emit('log', { level: 'log', line: `[Mock] ➤ Đã gửi vào game: ${message}`, at: new Date().toISOString() });
  setTimeout(() => {
    io.emit('chat', { line: `<Mock> ${message}`, at: new Date().toISOString() });
    if (message.startsWith('/balance')) {
      io.emit('log', { level: 'log', line: '[Mock] 💰 Số dư của bot: 12,500,000 tiền game', at: new Date().toISOString() });
    }
  }, 600);
  res.json({ success: true, lines: 1 });
});

app.get('/api/orders', (req, res) => res.json({ orders: orders.slice(0, 50) }));

app.get('/api/balances', (req, res) =>
  res.json({
    balances: Object.entries(balances)
      .map(([userId, amount]) => ({ userId, amount }))
      .sort((a, b) => b.amount - a.amount),
    history: history.slice(0, 60),
  })
);

app.post('/api/balance', (req, res) => {
  const { userId, amount, action } = req.body ?? {};
  if (!userId || !/^\d{15,21}$/.test(String(userId))) {
    return res.status(400).json({ success: false, error: 'userId không hợp lệ (15-21 chữ số)' });
  }
  let v = Number(amount);
  if (!Number.isFinite(v) || v <= 0) {
    const m = String(amount).trim().toLowerCase().match(/^([0-9]*\.?[0-9]+)(k|tr|m)?$/);
    if (!m) return res.status(400).json({ success: false, error: 'Số tiền không hợp lệ' });
    v = Number(m[1]) * (m[2] === 'tr' || m[2] === 'm' ? 1e6 : m[2] === 'k' ? 1e3 : 1);
  }
  balances[userId] = Math.max(0, (balances[userId] ?? 0) + (action === 'deduct' ? -v : v));
  history.unshift({
    id: `h${Date.now()}`,
    timestamp: new Date().toISOString(),
    userId,
    type: action === 'deduct' ? 'ADMIN_DEDUCT' : 'ADMIN_TOPUP',
    amount: v,
    reason: action === 'deduct' ? 'ADMIN_DEDUCT' : 'ADMIN_TOPUP',
  });
  res.json({ success: true, newBalance: balances[userId] });
});

app.get('/api/stats', (req, res) => res.json(computeStats()));

/* ═══════════ CONSOLE GIẢ ═══════════ */
const FAKE_LOGS = [
  () => `[MC] 💬 Chat: <${pick(IGNS).trim()}> ai bán 50m không ?`,
  () => `[Shop] Đơn ${pick(orders).orderId} đã hoàn tất — đã /pay ${rnd(1, 50)}m cho khách.`,
  () => `[MC] ❤️ Health: ${rnd(14, 20)}/20 · 🍗 Food: ${rnd(16, 20)}/20 · ping ${rnd(18, 90)}ms`,
  () => `[Discord] Panel tự cập nhật: giá ${store.price.baseAmount} = ${store.price.basePrice}${store.price.currency}, kho ${store.stock}.`,
  () => `[Casso] 🔔 Giao dịch đến: ${(rnd(1, 20) * 10000).toLocaleString('en-US')}đ — "muamon DH${rnd(100000, 999999)}"`,
  () => `[AFK] Chu kỳ hoạt động bình thường — online liên tục.`,
  () => `[MC] ⚠️ Server lag ${(rnd(3, 9) * 100)}ms — thử lại packet sau 2s.`,
];
setInterval(() => io.emit('log', { level: Math.random() < 0.12 ? 'warn' : 'log', line: pick(FAKE_LOGS)(), at: new Date().toISOString() }), 3800);
setInterval(() => io.emit('chat', { line: `<${pick(IGNS).trim()}> ${pick(['bán 100m ai mua k', 'server gì vui thế', 'ad ơi mở bán đi', 'gg', 'pay rồi nha check giúp'])}`, at: new Date().toISOString() }), 7600);

server.listen(PORT, () => {
  console.log(`\n🧪 PREVIEW PANEL — http://localhost:${PORT}  (dữ liệu mẫu, không đụng data thật)${PANEL_PASSWORD ? ' — đang BẬT khóa panel: ' + PANEL_PASSWORD : ''}\n`);
});
