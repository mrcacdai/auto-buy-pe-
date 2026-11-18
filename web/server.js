'use strict';

/**
 * ============================================================
 *  web/server.js — WEB PANEL QUẢN TRỊ (Express + Socket.io)
 * ============================================================
 *  Cơ chế lấy từ auto-buy, port sang bot Bedrock:
 *
 *    GET  /                    → giao diện quản trị (web/public)
 *    GET  /api/status          → trạng thái bot + shop
 *    GET  /api/config          → cấu hình shop hiện tại
 *    POST /api/config          → sửa giá/kho (tự cập nhật Panel Discord)
 *    POST /api/server          → đổi IP server Bedrock (ping + lưu)
 *    POST /api/reconnect       → kết nối lại Minecraft
 *    POST /api/botoff /boton   → tắt/bật bot mua
 *    POST /api/chat            → gửi chat/lệnh vào game
 *    GET  /api/orders          → 50 đơn hàng mới nhất
 *    GET  /api/balances        → số dư thành viên + lịch sử
 *    POST /api/balance         → admin cộng/trừ số dư thành viên
 *    POST /api/webhook/bank    → WEBHOOK Casso/bank: tự động /pay
 *    POST /charge/callback     → callback hệ thống thẻ cào
 *
 *  Socket.io events:
 *    'log'          → mọi dòng console của bot (realtime)
 *    'chat'         → mọi chat/tin nhắn trong server Minecraft
 *    'configUpdate' → cấu hình shop vừa thay đổi
 *
 *  Bảo mật: nếu đặt PANEL_PASSWORD trong .env, mọi /api/* (trừ webhook)
 *  đều yêu cầu khóa — gửi qua ?key=... hoặc header x-panel-key.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server: SocketIOServer } = require('socket.io');
const { saveServer } = require('../src/config');

/** Patch console để MỌI log của bot đẩy realtime lên Web Panel */
function patchConsole(io) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  let emitting = false;

  const wrap = (level) => {
    return (...args) => {
      original[level](...args);
      if (emitting || !io) return;
      try {
        emitting = true;
        const line = args
          .map((a) => (typeof a === 'string' ? a : require('util').inspect(a, { depth: 2, maxArrayLength: 5 })))
          .join(' ');
        io.emit('log', { level, line: line.slice(0, 800), at: new Date().toISOString() });
      } catch {
        /* không bao giờ để log làm rơi bot */
      } finally {
        emitting = false;
      }
    };
  };

  console.log = wrap('log');
  console.warn = wrap('warn');
  console.error = wrap('error');
}

async function startWebPanel({ config, manager, getContext }) {
  const app = express();
  const server = http.createServer(app);
  const io = new SocketIOServer(server, { cors: { origin: '*' } });

  patchConsole(io);

  const webPort = Math.max(0, Number.parseInt(process.env.WEB_PORT, 10) || 0);
  if (webPort === 0) {
    return { io: null, app, server: null }; // tắt web panel
  }

  const panelPassword = (process.env.PANEL_PASSWORD || '').trim();

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  /* ---------- Khóa bảo mật panel (nếu đặt PANEL_PASSWORD) ---------- */
  app.use((req, res, next) => {
    // Webhook ngân hàng/thẻ cào KHÔNG dùng mật khẩu panel (chúng có secret riêng)
    if (req.path.startsWith('/api/webhook') || req.path.startsWith('/charge') || req.path.startsWith('/callback')) return next();
    if (req.path.startsWith('/api')) {
      if (!panelPassword) return next();
      const key = req.query.key || req.headers['x-panel-key'];
      if (key !== panelPassword) {
        return res.status(401).json({ error: 'unauthorized' });
      }
      return next();
    }
    next(); // file tĩnh (html/css/js) — nội dung không nhạy cảm
  });

  app.use(express.static(path.join(__dirname, 'public')));

  /* ---------- Trạng thái tổng hợp ---------- */
  app.get('/api/status', (req, res) => {
    const ctx = getContext?.() ?? null;
    const afk = ctx ? require('../src/shop/afk').getAfkStatus() : null;
    res.json({
      bot: manager.stateInfo(),
      mcState: manager.state,
      server: manager.serverLabel,
      detected: manager.detected,
      discordReady: ctx?.discord?.isReady?.() ?? false,
      botOff: ctx?.store?.botOff ?? null,
      afk,
      bankConfigured: !!(process.env.BANK_BIN && process.env.BANK_ACCOUNT_NUMBER),
      mbbankConfigured: !!(process.env.MBBANK_TOKEN || process.env.BYTEMART_MBBANK_TOKEN),
      mbbankStatus: require('../src/shop/mbbankService').getStatus(),
      cardConfigured: (process.env.CARD_DOMAIN && process.env.CARD_PARTNER_ID && process.env.CARD_PARTNER_KEY) || false,
      stock: ctx?.store?.getStock?.().toString() ?? null,
      price: ctx?.store?.price ?? null,
      pendingOrders: ctx?.discord?.pendingOrders?.size ?? 0,
      uptimeSec: Math.floor(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    });
  });

  /* ---------- Cấu hình shop ---------- */
  app.get('/api/config', (req, res) => {
    const ctx = getContext?.();
    if (!ctx) return res.status(503).json({ error: 'shop-not-ready' });
    res.json(ctx.store.data);
  });

  app.post('/api/config', async (req, res) => {
    try {
      const ctx = getContext?.();
      if (!ctx) return res.status(503).json({ error: 'shop-not-ready' });
      const { baseAmount, basePrice, currency, stock } = req.body ?? {};

      if (baseAmount !== undefined && String(baseAmount).trim() !== '') {
        let v = Number(baseAmount);
        if (!Number.isFinite(v)) {
          const m = String(baseAmount).trim().toLowerCase().match(/^([0-9]*\.?[0-9]+)([kmbt])$/);
          if (m) v = Number(m[1]) * { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2]];
        }
        ctx.store.setPrice({ baseAmount: v });
      }
      if (basePrice !== undefined && String(basePrice).trim() !== '') {
        ctx.store.setPrice({ basePrice: Number(basePrice) });
      }
      if (currency !== undefined) ctx.store.setPrice({ currency });
      if (stock !== undefined && String(stock).trim() !== '') {
        let okSet = false;
        const m = String(stock).trim().toLowerCase().match(/^([+-])?\s*([0-9]*\.?[0-9]+)([kmbt])?$/);
        if (m) {
          const exp = { k: 3, m: 6, b: 9, t: 12 }[m[3] ?? ''] ?? 0;
          const [intPart, fracPart = ''] = m[2].split('.');
          const frac = fracPart.slice(0, exp).padEnd(exp, '0');
          const value = BigInt((intPart || '0') + frac);
          const old = ctx.store.getStock();
          const next = m[1] === '+' ? old + value : m[1] === '-' ? old - value : value;
          okSet = ctx.store.setStock(next);
        } else {
          okSet = ctx.store.setStock(String(stock));
        }
        if (!okSet) return res.status(400).json({ success: false, error: 'Kho không hợp lệ' });
      }

      io.emit('configUpdate', ctx.store.data);
      console.log(`[WebPanel] Đã cập nhật cấu hình: giá ${JSON.stringify(ctx.store.price)}, kho ${ctx.store.data.stock}`);

      // Tự cập nhật Panel Discord
      const panel = require('../src/shop/panel');
      const ok = await panel.updatePanel(ctx);
      if (ok) io.emit('log', { level: 'log', line: '[WebPanel] ✅ Đã tự cập nhật Panel Discord.' });

      res.json({ success: true, config: ctx.store.data });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ---------- Đổi server Minecraft PC (Java) ---------- */
  app.post('/api/server', async (req, res) => {
    try {
      const { host, port } = req.body ?? {};
      if (!host || typeof host !== 'string') {
        return res.status(400).json({ success: false, error: 'Thiếu host' });
      }
      const portNum = Number.parseInt(port, 10) || 25565;

      console.log(`[WebPanel] Yêu cầu đổi server -> ${host}:${portNum} (đang ping thử...)`);
      const pong = await manager.probe(host, portNum);
      if (!pong) {
        return res.status(400).json({ success: false, error: `Không ping được ${host}:${portNum} — kiểm tra lại IP/port.` });
      }

      saveServer(host, portNum); // lưu để khởi động lại vẫn nhớ (hàm có sẵn của bot gốc)
      await manager.setServer(host, portNum);
      io.emit('configUpdate', { server: { host, port: portNum } });
      res.json({ success: true, detected: pong });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ---------- Kết nối lại / tắt / bật bot ---------- */
  app.post('/api/reconnect', async (req, res) => {
    try {
      console.log('[WebPanel] Yêu cầu kết nối lại Minecraft...');
      await manager.stop();
      manager.start();
      res.json({ success: true, message: 'Đang kết nối lại server Minecraft...' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/botoff', async (req, res) => {
    try {
      const ctx = getContext?.();
      if (!ctx) return res.status(503).json({ error: 'shop-not-ready' });
      ctx.store.setBotOff(true);
      await manager.stop();
      const panel = require('../src/shop/panel');
      panel.updatePanel(ctx).catch(() => {});
      io.emit('configUpdate', ctx.store.data);
      console.log('[WebPanel] 🛑 Đã TẮT bot mua (botOff) từ Web Panel.');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/boton', async (req, res) => {
    try {
      const ctx = getContext?.();
      if (!ctx) return res.status(503).json({ error: 'shop-not-ready' });
      ctx.store.setBotOff(false);
      manager.start();
      const panel = require('../src/shop/panel');
      panel.updatePanel(ctx).catch(() => {});
      io.emit('configUpdate', ctx.store.data);
      console.log('[WebPanel] 🟢 Đã BẬT lại bot mua từ Web Panel.');
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ---------- Gửi chat/lệnh vào game ---------- */
  app.post('/api/chat', async (req, res) => {
    try {
      const { message } = req.body ?? {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ success: false, error: 'Thiếu nội dung' });
      }
      const ctx = getContext?.();
      if (!ctx) return res.status(400).json({ success: false, error: 'Shop chưa sẵn sàng' });

      const { sendToGame } = require('../src/shop');
      const lines = await sendToGame(ctx, message.slice(0, 500));
      console.log(`[WebPanel] ➤ Đã gửi vào game: ${message}`);
      res.json({ success: true, lines });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  /* ---------- Đơn hàng & số dư ---------- */
  app.get('/api/orders', (req, res) => {
    res.json({ orders: require('../src/shop/orders').listOrders(50) });
  });

  app.get('/api/balances', (req, res) => {
    const shopBalances = require('../src/shop/balances');
    res.json({
      balances: shopBalances.listBalances(100),
      history: shopBalances.readHistory(60),
    });
  });

  app.post('/api/balance', async (req, res) => {
    try {
      const { userId, amount, action } = req.body ?? {};
      const shopBalances = require('../src/shop/balances');
      if (!userId || !/^\d{15,21}$/.test(String(userId))) {
        return res.status(400).json({ success: false, error: 'userId không hợp lệ' });
      }
      let v = Number(amount);
      if (!Number.isFinite(v) || v <= 0) {
        const m = String(amount).trim().toLowerCase().match(/^([0-9]*\.?[0-9]+)(k|tr|m)?$/);
        if (!m) return res.status(400).json({ success: false, error: 'Số tiền không hợp lệ' });
        v = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] ? 1e6 : 1);
      }
      const result =
        action === 'deduct'
          ? await shopBalances.deductBalance(String(userId), v, 'ADMIN_DEDUCT', { by: 'web-panel' })
          : await shopBalances.addBalance(String(userId), v, 'ADMIN_TOPUP', { by: 'web-panel' });
      if (!result.success) return res.status(400).json(result);
      console.log(`[WebPanel] 💳 Admin ${action === 'deduct' ? 'trừ' : 'cộng'} ${v} VNĐ cho ${userId} (còn ${result.newBalance})`);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ---------- Quét thủ công MBBank (ByteMart) ---------- */
  app.post('/api/mbbank/sync', async (req, res) => {
    try {
      const ctx = getContext?.();
      if (!ctx) return res.status(503).json({ success: false, error: 'Shop chưa sẵn sàng' });
      const mbbankService = require('../src/shop/mbbankService');
      const count = await mbbankService.pollOnce(ctx, io);
      res.json({ success: true, count, status: mbbankService.getStatus() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ---------- Thống kê (★ v3 — cho trang Thống kê của panel mới) ---------- */
  app.get('/api/stats', (req, res) => {
    try {
      const all = Object.values(require('../src/shop/orders').readOrders());
      const now = Date.now();
      const days = [];
      for (let i = 13; i >= 0; i--) {
        days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
      }
      const byDayMap = Object.fromEntries(days.map((d) => [d, { revenue: 0, count: 0 }]));
      const byStatus = {};
      const methodMap = new Map();
      const buyerMap = new Map();
      let revenue = 0;
      let revenueToday = 0;
      const today = days[days.length - 1];

      for (const o of all) {
        const status = String(o.status ?? 'UNKNOWN');
        byStatus[status] = (byStatus[status] ?? 0) + 1;
        const price = Number(o.totalPrice ?? o.amountVnd ?? 0) || 0;
        const day = String(o.createdAt ?? '').slice(0, 10);
        if (o.status === 'COMPLETED') {
          revenue += price;
          if (day === today) revenueToday += price;
          if (byDayMap[day]) {
            byDayMap[day].revenue += price;
            byDayMap[day].count += 1;
          }
          const method = String(o.paymentMethod ?? '—').slice(0, 40) || '—';
          const m = methodMap.get(method) ?? { method, count: 0, revenue: 0 };
          m.count += 1;
          m.revenue += price;
          methodMap.set(method, m);
          const buyer = String(o.ign ?? o.userTag ?? o.userId ?? '—').slice(0, 32) || '—';
          const b = buyerMap.get(buyer) ?? { buyer, total: 0, count: 0 };
          b.total += price;
          b.count += 1;
          buyerMap.set(buyer, b);
        }
      }

      res.json({
        totals: { orders: all.length, completed: byStatus.COMPLETED ?? 0, revenue, revenueToday },
        byStatus,
        byDay: days.map((d) => ({ day: d, revenue: byDayMap[d].revenue, count: byDayMap[d].count })),
        byMethod: [...methodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 6),
        topBuyers: [...buyerMap.values()].sort((a, b) => b.total - a.total).slice(0, 5),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /* ---------- Webhook ngân hàng + thẻ cào ---------- */
  const bankRouter = require('./routes/bank');
  const bankMiddleware = bankRouter({ config, manager, getContext, io });
  app.use('/api/webhook', bankMiddleware);
  app.use('/charge', bankMiddleware);
  app.use('/callback', bankMiddleware);

  /* ---------- Socket.io ---------- */
  io.on('connection', (socket) => {
    // Chống truy cập lạ khi đặt mật khẩu: client phải gửi key qua auth
    if (panelPassword && socket.handshake?.auth?.key !== panelPassword) {
      socket.emit('log', { level: 'warn', line: '[WebPanel] ⚠️ Kết nối chưa có khóa — chỉ xem được trạng thái giới hạn.' });
    }
    const ctx = getContext?.();
    if (ctx) socket.emit('configUpdate', ctx.store.data);
  });

  return new Promise((resolve) => {
    server.listen(webPort, () => {
      console.log(`\n🌐 Web Panel đang chạy tại http://localhost:${webPort}${panelPassword ? ' (có mật khẩu)' : ''}\n`);
      resolve({ io, app, server });
    });
  });
}

module.exports = { startWebPanel };
