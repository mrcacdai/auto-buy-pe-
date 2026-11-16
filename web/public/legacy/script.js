/* ═══════════════════════════════════════════════════════════
   MC Bedrock Pay Bot — Web Panel logic (Socket.io + REST)
   ═══════════════════════════════════════════════════════════ */
'use strict';

/* ---------- Khóa truy cập (PANEL_PASSWORD) ---------- */
const KEY_STORAGE = 'mcbot.panelKey';
try {
  localStorage.removeItem(KEY_STORAGE);
  sessionStorage.removeItem(KEY_STORAGE);
} catch {}
let panelKey = '';

window.addEventListener('beforeunload', () => {
  try {
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {}
});
window.addEventListener('pagehide', () => {
  try {
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {}
});

function api(path, options = {}) {
  const sep = path.includes('?') ? '&' : '?';
  const url = panelKey ? `${path}${sep}key=${encodeURIComponent(panelKey)}` : path;
  return fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  }).then(async (res) => {
    if (res.status === 401) {
      document.getElementById('keyMask').style.display = 'grid';
      throw new Error('Sai mật khẩu panel');
    }
    return res.json();
  });
}

/* ---------- Toast ---------- */
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = 'toast'), 3500);
}

/* ---------- Điều hướng sidebar ---------- */
const SECTION_TITLES = {
  dashboard: '📊 Tổng Quan',
  config: '⚙️ Cấu Hình',
  orders: '🧾 Đơn Hàng',
  balances: '💳 Số Dư',
  console: '🖥️ Console',
};
document.querySelectorAll('.nav-item').forEach((item) => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.remove('active'));
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    item.classList.add('active');
    const id = item.dataset.section;
    document.getElementById(`section-${id}`).classList.add('active');
    document.getElementById('pageTitle').textContent = SECTION_TITLES[id] ?? '';
    if (id === 'orders') loadOrders();
    if (id === 'balances') loadBalances();
  });
});

/* ---------- Định dạng ---------- */
function fmtNumber(n) {
  return Number(n ?? 0).toLocaleString('en-US');
}
function fmtStock(v) {
  let num;
  try {
    num = typeof v === 'bigint' ? v : BigInt(String(v ?? '0') || '0');
  } catch {
    return '0';
  }
  const sign = num < 0n ? '-' : '';
  const abs = num < 0n ? -num : num;
  for (const [size, s] of [[1000000000000n, 't'], [1000000000n, 'b'], [1000000n, 'm'], [1000n, 'k']]) {
    if (abs >= size) {
      const whole = abs / size;
      const frac = ((abs % size) * 100n) / size;
      const fracStr = frac === 0n ? '' : `.${frac.toString().padStart(2, '0').replace(/0+$/, '')}`;
      return `${sign}${whole}${fracStr}${s}`;
    }
  }
  return `${sign}${abs}`;
}
const STATUS_VI = {
  COMPLETED: '✅ Hoàn thành',
  PENDING_PAYMENT: '⏳ Chờ CK',
  PROCESSING: '🔄 Đang xử lý',
  WAITING_RETRY: '🔁 Chờ giao lại',
  EXPIRED: '⏰ Hết hạn',
  FAILED: '❌ Thất bại',
};

/* ---------- Trạng thái ---------- */
let lastStatus = null;
async function refreshStatus() {
  try {
    const st = await api('/api/status');
    lastStatus = st;

    // Pills
    setPill('pillMC', st.mcState === 'online', st.mcState === 'online' ? 'Minecraft: Online' : st.mcState === 'connecting' ? 'Minecraft: Đang vào...' : 'Minecraft: Offline');
    setPill('pillDiscord', st.discordReady, st.discordReady ? 'Discord: Online' : 'Discord: Chưa vào');
    const shopOk = !st.botOff && (!st.afk?.enabled || !st.afk?.resting);
    setPill('pillShop', shopOk, st.botOff ? 'Shop: Đang tắt' : st.afk?.enabled && st.afk.resting ? 'Shop: Nghỉ AFK' : 'Shop: Đang bán');

    // Sidebar + dashboard
    document.getElementById('sideServer').textContent = st.server ?? '—';
    document.getElementById('sideVersion').textContent = st.detected?.version ? `Bedrock ${st.detected.version}` : 'Minecraft Bedrock';
    document.getElementById('sideDot').style.background = st.mcState === 'online' ? '#3fb950' : st.mcState === 'connecting' ? '#f0883e' : '#f85149';
    document.getElementById('dashBot').textContent =
      st.mcState === 'online' ? 'Online' : st.mcState === 'connecting' ? 'Đang vào...' : st.botOff ? 'Đang tắt' : 'Offline';
    document.getElementById('dashStock').textContent = st.stock != null ? fmtStock(st.stock) : '—';
    document.getElementById('dashPrice').textContent =
      st.price ? `${fmtStock(st.price.baseAmount)} = ${fmtNumber(st.price.basePrice)} ${st.price.currency}` : '—';
    document.getElementById('dashPending').textContent = String(st.pendingOrders ?? 0);
    document.getElementById('stockDisplay').textContent = st.stock != null ? fmtStock(st.stock) : '0';
    document.getElementById('serverPreview').textContent = `Server hiện tại: ${st.server} — phiên bản ${st.detected?.version ?? 'auto'} (protocol ${st.detected?.protocol ?? '?'})`;
    document.getElementById('ctrlStatus').textContent =
      `Trạng thái: ${st.mcState} | botOff: ${st.botOff ? 'CÓ' : 'không'} | AFK: ${st.afk?.enabled ? (st.afk.resting ? 'đang nghỉ' : 'đang online') : 'tắt'} | uptime ${Math.floor((st.uptimeSec ?? 0) / 60)} phút`;
    if (st.price) {
      document.getElementById('baseAmount').placeholder = st.price.baseAmount;
      document.getElementById('basePrice').placeholder = st.price.basePrice;
      document.getElementById('currency').placeholder = st.price.currency;
      updatePricePreview();
    }
  } catch (e) {
    console.warn('refreshStatus:', e.message);
  }
}

function setPill(id, ok, label) {
  const el = document.getElementById(id);
  el.classList.toggle('ok', !!ok);
  el.classList.toggle('warn', !ok && (lastStatus?.mcState === 'connecting'));
  el.querySelector('span:last-child').textContent = label;
}

function updatePricePreview() {
  const a = Number(document.getElementById('baseAmount').value || document.getElementById('baseAmount').placeholder || 0);
  const p = Number(document.getElementById('basePrice').value || document.getElementById('basePrice').placeholder || 0);
  const cur = document.getElementById('currency').value || document.getElementById('currency').placeholder || 'VND';
  if (a > 0 && p > 0) {
    document.getElementById('pricePreview').textContent = `${fmtStock(BigInt(Math.floor(a)))} tiền game = ${fmtNumber(p)} ${cur}`;
  }
}
['baseAmount', 'basePrice', 'currency'].forEach((id) => document.getElementById(id).addEventListener('input', updatePricePreview));

/* ---------- Forms ---------- */
document.getElementById('priceForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    baseAmount: document.getElementById('baseAmount').value || undefined,
    basePrice: document.getElementById('basePrice').value || undefined,
    currency: document.getElementById('currency').value || undefined,
  };
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    toast('✅ Đã cập nhật giá + tự cập nhật Panel Discord', 'ok');
    refreshStatus();
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
});

document.getElementById('stockForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const stock = document.getElementById('stockInput').value.trim();
  if (!stock) return toast('Nhập số kho mới (VD: 1b, 500m, +50m, -20m)', 'err');
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ stock }) });
    toast('✅ Đã cập nhật kho hàng', 'ok');
    document.getElementById('stockInput').value = '';
    refreshStatus();
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
});

document.getElementById('serverForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const host = document.getElementById('serverHost').value.trim();
  const port = document.getElementById('serverPort').value.trim() || 19132;
  if (!host) return toast('Nhập IP/domain server', 'err');
  try {
    const res = await api('/api/server', { method: 'POST', body: JSON.stringify({ host, port }) });
    toast(`✅ Đã đổi sang ${host}:${port} — Bedrock ${res.detected?.version ?? 'auto'}`, 'ok');
    document.getElementById('serverHost').value = '';
    refreshStatus();
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
});

/* ---------- Nút điều khiển ---------- */
async function bindAction(btnId, path, okMsg) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await api(path, { method: 'POST', body: '{}' });
      toast(okMsg, 'ok');
      setTimeout(refreshStatus, 1500);
    } catch (err) {
      toast(`❌ ${err.message}`, 'err');
    } finally {
      setTimeout(() => (btn.disabled = false), 1500);
    }
  });
}
bindAction('btnReconnect', '/api/reconnect', '🔄 Đang kết nối lại server...');
bindAction('btnReconnect2', '/api/reconnect', '🔄 Đang kết nối lại server...');
bindAction('btnBotOff', '/api/botoff', '🛑 Đã tắt bot mua (botoff)');
bindAction('btnBotOff2', '/api/botoff', '🛑 Đã tắt bot mua (botoff)');
bindAction('btnBotOn', '/api/boton', '🟢 Đã bật bot mua');
bindAction('btnBotOn2', '/api/boton', '🟢 Đã bật bot mua');

document.getElementById('btnBalance').addEventListener('click', async () => {
  try {
    const res = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: '/balance' }) });
    toast('💰 Đã gửi /balance vào game — xem kết quả ở Console', 'ok');
    showSection('console');
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
});

function showSection(id) {
  document.querySelector(`.nav-item[data-section="${id}"]`)?.click();
}

/* ---------- Đơn hàng ---------- */
async function loadOrders() {
  try {
    const data = await api('/api/orders');
    renderOrders('ordersTable', data.orders ?? []);
    renderOrders('ordersTableMini', (data.orders ?? []).slice(0, 5));
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
}

function renderOrders(tableId, orders) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">Chưa có đơn hàng</td></tr>`;
    return;
  }
  tbody.innerHTML = orders
    .map(
      (o) => `<tr>
        <td>${o.orderId ?? o.id ?? '—'}</td>
        ${tableId === 'ordersTable' ? `<td>${o.createdAt ? new Date(o.createdAt).toLocaleString('vi-VN') : '—'}</td>` : ''}
        <td>${o.userTag ?? o.userId ?? '—'}</td>
        <td>${o.ign ?? '—'}</td>
        <td>${fmtStock(o.gameMoney ?? o.amount)}</td>
        <td>${fmtNumber(o.totalPrice ?? o.amountVnd)}</td>
        <td>${o.paymentMethod ?? '—'}</td>
        <td><span class="tag-status st-${o.status}">${STATUS_VI[o.status] ?? o.status}</span></td>
      </tr>`
    )
    .join('');
}
document.getElementById('btnRefreshOrders').addEventListener('click', loadOrders);
document.getElementById('btnRefreshOrders2').addEventListener('click', loadOrders);

/* ---------- Số dư ---------- */
async function loadBalances() {
  try {
    const data = await api('/api/balances');
    const bBody = document.querySelector('#balancesTable tbody');
    bBody.innerHTML = (data.balances ?? []).length
      ? data.balances
          .map((b) => `<tr><td>${b.userId}</td><td>${fmtNumber(b.amount)} VNĐ</td></tr>`)
          .join('')
      : `<tr><td colspan="2" class="empty">Chưa có ai nạp</td></tr>`;

    const hBody = document.querySelector('#historyTable tbody');
    hBody.innerHTML = (data.history ?? []).length
      ? data.history
          .slice(0, 30)
          .map(
            (h) => `<tr>
              <td>${h.timestamp ? new Date(h.timestamp).toLocaleString('vi-VN') : '—'}</td>
              <td>${h.userId ?? '—'}</td>
              <td>${h.type ?? ''} ${h.reason ? `(${h.reason})` : ''}</td>
              <td>${h.type === 'ADD' ? '+' : '-'}${fmtNumber(h.amount)}</td>
              <td>${h.reason ?? ''}</td>
            </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="empty">Chưa có lịch sử</td></tr>`;
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
}

async function adjustBalance(action) {
  const userId = document.getElementById('balUserId').value.trim();
  const amount = document.getElementById('balAmount').value.trim();
  if (!userId || !amount) return toast('Nhập đủ User ID và số tiền', 'err');
  try {
    await api('/api/balance', { method: 'POST', body: JSON.stringify({ userId, amount, action }) });
    toast(`${action === 'deduct' ? '➖ Đã trừ' : '➕ Đã cộng'} số dư cho ${userId}`, 'ok');
    document.getElementById('balUserId').value = '';
    document.getElementById('balAmount').value = '';
    loadBalances();
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
}
document.getElementById('btnBalAdd').addEventListener('click', () => adjustBalance('add'));
document.getElementById('btnBalDeduct').addEventListener('click', () => adjustBalance('deduct'));

/* ---------- Console ---------- */
const consoleEl = document.getElementById('console');
const miniEl = document.getElementById('miniConsole');
let onlyChat = false;
document.getElementById('onlyChat').addEventListener('change', (e) => (onlyChat = e.target.checked));
document.getElementById('clearConsole').addEventListener('click', () => {
  consoleEl.innerHTML = '<p class="log-line log-system">Đã xóa.</p>';
});

function appendConsole(line, opts = {}) {
  const isChat = opts.chat === true;
  if (onlyChat && !isChat) return;
  const p = document.createElement('p');
  p.className = `log-line ${isChat ? 'log-chat' : opts.level === 'warn' ? 'log-warn' : opts.level === 'error' ? 'log-error' : ''}`;
  p.textContent = `${isChat ? '💬 ' : ''}${line}`;
  consoleEl.appendChild(p);
  while (consoleEl.childElementCount > 400) consoleEl.removeChild(consoleEl.firstChild);
  consoleEl.scrollTop = consoleEl.scrollHeight;

  if (miniEl) {
    const m = document.createElement('p');
    m.className = `log-line ${isChat ? 'log-chat' : 'log-system'}`;
    m.textContent = line.length > 150 ? line.slice(0, 150) + '…' : line;
    miniEl.appendChild(m);
    while (miniEl.childElementCount > 40) miniEl.removeChild(miniEl.firstChild);
    miniEl.scrollTop = miniEl.scrollHeight;
  }
}

/* ---------- Gửi chat/lệnh vào game ---------- */
document.getElementById('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  try {
    await api('/api/chat', { method: 'POST', body: JSON.stringify({ message }) });
    appendConsole(`➤ Bạn gửi vào game: ${message}`);
  } catch (err) {
    toast(`❌ ${err.message}`, 'err');
  }
});

/* ---------- Socket.io realtime ---------- */
const socket = io({ auth: { key: panelKey } });
socket.on('log', (payload) => {
  const { level, line } = typeof payload === 'string' ? { level: 'log', line: payload } : payload;
  appendConsole(line, { level });
});
socket.on('chat', (payload) => {
  const line = typeof payload === 'string' ? payload : payload?.line ?? '';
  if (line) appendConsole(line, { chat: true });
});
socket.on('configUpdate', () => refreshStatus());

/* ---------- Khóa truy cập ---------- */
document.getElementById('keyBtn').addEventListener('click', async () => {
  const candidate = document.getElementById('keyInput').value.trim();
  if (!candidate) return;
  try {
    const res = await fetch(`/api/status?key=${encodeURIComponent(candidate)}`);
    if (res.status === 401) {
      toast('Sai mật khẩu panel', 'err');
      return;
    }
    panelKey = candidate;
    try {
      localStorage.removeItem(KEY_STORAGE);
      sessionStorage.removeItem(KEY_STORAGE);
    } catch {}
    document.getElementById('keyMask').style.display = 'none';
    if (socket) {
      socket.auth = { key: panelKey };
      socket.disconnect().connect();
    }
    refreshStatus();
    toast('Đăng nhập thành công', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
});
document.getElementById('keyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('keyBtn').click();
});

/* ---------- Khởi động ---------- */
refreshStatus();
loadOrders();
setInterval(refreshStatus, 8000);
setInterval(loadOrders, 30000);
