/* ═══════════════════════════════════════════════════════════════
   BedrockPay — Nova Panel v3 · App logic
   Giữ 100% chức năng panel cũ (REST + Socket.io) và thêm:
   thống kê, tìm kiếm/lọc/xuất CSV, VI/EN, ⌘K palette, glow toggle.
   ═══════════════════════════════════════════════════════════════ */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);

  /* ═══════════ STATE ═══════════ */
  const LANG_KEY = 'bedrockpay.lang';
  const GLOW_KEY = 'bedrockpay.glow';
  const KEY_STORAGE = 'mcbot.panelKey';

  // Luôn xóa key trong storage khi khởi động để đảm bảo tự động đăng xuất khi refresh hoặc out web
  try {
    localStorage.removeItem(KEY_STORAGE);
    sessionStorage.removeItem(KEY_STORAGE);
  } catch {}

  const state = {
    lang: localStorage.getItem(LANG_KEY) || 'vi',
    glow: localStorage.getItem(GLOW_KEY) !== 'off',
    panelKey: '', // Chỉ lưu trong RAM trang hiện tại — tự động mất khi refresh hoặc đóng web
    status: null,
    orders: [],
    balances: [],
    history: [],
    section: 'dashboard',
    orderFilter: { q: '', status: 'all', sort: 'time_desc', page: 1, pageSize: 10 },
    balSearch: '',
    onlyChat: false,
    autoScroll: true,
    chatHist: [],
    chatIdx: -1,
    socketOnline: false,
    consoleLines: 0,
  };

  const t = (key, vars) => I18N.t(state.lang, key, vars);
  const locale = () => (state.lang === 'vi' ? 'vi-VN' : 'en-GB');
  const debounce = (fn, ms) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), ms);
    };
  };

  /* ═══════════ API (giữ cơ chế khóa PANEL_PASSWORD của panel cũ) ═══════════ */
  function api(path, options = {}) {
    const sep = path.includes('?') ? '&' : '?';
    const url = state.panelKey ? `${path}${sep}key=${encodeURIComponent(state.panelKey)}` : path;
    return fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    }).then(async (res) => {
      if (res.status === 401) {
        showKeyMask(true);
        throw new Error(state.panelKey ? t('toasts.wrongKey') : (t('key.title') || 'Yêu cầu mật khẩu'));
      }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
      return json;
    });
  }

  /* ═══════════ TOAST ═══════════ */
  const toastEl = $('toast');
  let toastTimer = null;
  function toast(msg, type = '') {
    toastEl.textContent = msg;
    toastEl.className = `toast show ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = 'toast'), 3500);
  }

  /* ═══════════ ĐỊNH DẠNG ═══════════ */
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
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtUptime(sec) {
    const m = Math.floor((sec ?? 0) / 60);
    if (m < 60) return t('uptime.min', { n: m });
    return t('uptime.hour', { h: Math.floor(m / 60), m: m % 60 });
  }
  const STATUS_KEY = (s) => `st.${s}`;
  function statusTag(o) {
    const s = String(o.status ?? '—');
    return `<span class="tag-status st-${s}">${t(STATUS_KEY(s))}</span>`;
  }
  const orderVnd = (o) => Number(o.totalPrice ?? o.amountVnd ?? 0);
  const orderGame = (o) => o.gameMoney ?? o.amount ?? '0';

  /* ═══════════ i18n áp dụng ═══════════ */
  function applyI18n() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
    document.querySelectorAll('[data-i18n-title]').forEach((el) => (el.title = t(el.dataset.i18nTitle)));
    document.querySelectorAll('#langSwitch .lang-opt, #langSwitch2 .lang-opt').forEach((b) => {
      b.classList.toggle('active', b.dataset.lang === state.lang);
    });
    $('pageTitle').textContent = t(`title.${state.section}`);
    $('glowState').textContent = state.glow ? t('set.glowOn') : t('set.glowOff');
  }

  function setLang(lang) {
    if (lang === state.lang) return;
    state.lang = lang;
    localStorage.setItem(LANG_KEY, lang);
    applyI18n();
    refreshStatus().catch(() => {});
    renderOrdersFull();
    renderOrdersMini();
    renderBalances();
    renderHistory();
    loadStats().catch(() => {});
    toast(t('toasts.langChanged'), 'ok');
  }

  /* ═══════════ ĐIỀU HƯỚNG ═══════════ */
  function showSection(id) {
    state.section = id;
    document.querySelectorAll('.nav-item').forEach((i) => i.classList.toggle('active', i.dataset.section === id));
    document.querySelectorAll('.section').forEach((s) => s.classList.toggle('active', s.id === `section-${id}`));
    $('pageTitle').textContent = t(`title.${id}`);
    closeSidebar();
    if (id === 'orders') loadOrders().catch(() => {});
    if (id === 'balances') loadBalances().catch(() => {});
    if (id === 'stats') loadStats().catch(() => {});
    if (id === 'settings') updateSysInfo();
  }

  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebarBackdrop').classList.remove('show');
  }

  /* ═══════════ TRẠNG THÁI (giữ nguyên API /api/status cũ) ═══════════ */
  async function refreshStatus() {
    try {
      const st = await api('/api/status');
      state.status = st;

      // Pills
      const connecting = st.mcState === 'connecting';
      setPill('pillMC', st.mcState === 'online', connecting ? 'mc.connecting' : st.mcState === 'online' ? 'mc.online' : 'mc.offline', connecting);
      setPill('pillDiscord', !!st.discordReady, st.discordReady ? 'dc.ready' : 'dc.not');
      const shopOk = !st.botOff && !(st.afk?.enabled && st.afk?.resting);
      const shopKey = st.botOff ? 'shop.off' : st.afk?.enabled && st.afk.resting ? 'shop.resting' : 'shop.selling';
      setPill('pillShop', shopOk, shopKey);

      // Sidebar
      $('sideServer').textContent = st.server ?? t('side.notConnected');
      $('sideVersion').textContent = st.detected?.version ? `Java ${st.detected.version}` : 'Minecraft PC (Java)';
      const dot = $('sideDot');
      dot.className = `server-dot ${st.mcState === 'online' ? 'online' : connecting ? 'connecting' : ''}`;
      $('sideUptime').textContent = fmtUptime(st.uptimeSec);

      // KPI dashboard
      $('dashBot').textContent =
        st.mcState === 'online' ? t('state.online') : connecting ? t('state.connecting') : st.botOff ? t('state.botOff') : t('state.offline');
      $('dashBotSub').textContent = fmtUptime(st.uptimeSec);
      $('dashStock').textContent = st.stock != null ? fmtStock(st.stock) : '—';
      $('dashPrice').textContent = st.price ? `${fmtStock(st.price.baseAmount)} = ${fmtNumber(st.price.basePrice)} ${st.price.currency}` : '—';
      $('dashPending').textContent = String(st.pendingOrders ?? 0);
      $('dashPendingSub').textContent = t(shopKey);
      $('stockDisplay').textContent = st.stock != null ? fmtStock(st.stock) : '0';
      $('serverPreview').textContent = t('server.current', {
        server: st.server ?? '—',
        version: st.detected?.version ?? 'auto',
        protocol: st.detected?.protocol ?? '?',
      });
      const afkLabel = st.afk?.enabled ? (st.afk.resting ? t('shop.resting') : t('shop.selling')) : t('shop.off');
      $('ctrlStatus').textContent = `MC: ${st.mcState} | botOff: ${st.botOff ? '✔' : '✖'} | AFK: ${afkLabel} | ${fmtUptime(st.uptimeSec)}`;
      if (st.price) {
        $('baseAmount').placeholder = st.price.baseAmount;
        $('basePrice').placeholder = st.price.basePrice;
        $('currency').placeholder = st.price.currency;
        updatePricePreview();
      }
      updateSysInfo();
    } catch (e) {
      console.warn('refreshStatus:', e.message);
    }
  }

  function setPill(id, ok, labelKey, warn = false) {
    const el = $(id);
    el.classList.toggle('ok', !!ok);
    el.classList.toggle('warn', !ok && warn);
    el.classList.toggle('bad', !ok && !warn);
    el.querySelector('span:last-child').textContent = t(labelKey);
  }

  function updateSysInfo() {
    const st = state.status;
    if (!st) return;
    $('sysUptime').textContent = fmtUptime(st.uptimeSec);
    $('sysStarted').textContent = st.startedAt ? fmtDateTime(st.startedAt) : '—';
    $('sysMc').textContent = st.detected?.version ? `Java ${st.detected.version}` : 'auto';
    setSysOk('sysBank', !!st.bankConfigured);
    setSysOk('sysCard', !!st.cardConfigured);
  }
  function setSysOk(id, ok) {
    const el = $(id);
    el.textContent = ok ? t('set.configured') : t('set.notConfigured');
    el.style.color = ok ? 'var(--ok)' : 'var(--text-3)';
  }

  /* ═══════════ FORM: GIÁ ═══════════ */
  function updatePricePreview() {
    const a = Number($('baseAmount').value || $('baseAmount').placeholder || 0);
    const p = Number($('basePrice').value || $('basePrice').placeholder || 0);
    const cur = $('currency').value || $('currency').placeholder || 'VND';
    if (a > 0 && p > 0) {
      $('pricePreview').textContent = t('price.preview', { amount: fmtStock(BigInt(Math.floor(a))), price: fmtNumber(p), currency: cur });
    }
  }
  ['baseAmount', 'basePrice', 'currency'].forEach((id) => $(id).addEventListener('input', updatePricePreview));

  $('priceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {
      baseAmount: $('baseAmount').value || undefined,
      basePrice: $('basePrice').value || undefined,
      currency: $('currency').value || undefined,
    };
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
      toast(t('toasts.savedPrice'), 'ok');
      refreshStatus();
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  });

  /* ═══════════ FORM: KHO ═══════════ */
  $('stockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const stock = $('stockInput').value.trim();
    if (!stock) return toast(t('toasts.enterStock'), 'err');
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ stock }) });
      toast(t('toasts.savedStock'), 'ok');
      $('stockInput').value = '';
      refreshStatus();
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  });
  $('stockChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    $('stockInput').value = chip.textContent.trim();
    $('stockInput').focus();
  });

  /* ═══════════ FORM: ĐỔI SERVER ═══════════ */
  $('serverForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const host = $('serverHost').value.trim();
    const port = $('serverPort').value.trim() || 25565;
    if (!host) return toast(t('toasts.enterHost'), 'err');
    try {
      const res = await api('/api/server', { method: 'POST', body: JSON.stringify({ host, port }) });
      toast(t('toasts.changedServer', { host, port, version: res.detected?.version ?? 'auto' }), 'ok');
      $('serverHost').value = '';
      refreshStatus();
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  });

  /* ═══════════ NÚT ĐIỀU KHIỂN (reconnect / botoff / boton / balance) ═══════════ */
  async function bindAction(ids, path, okKey) {
    ids.forEach((btnId) => {
      const btn = $(btnId);
      if (!btn) return;
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await api(path, { method: 'POST', body: '{}' });
          toast(t(okKey), 'ok');
          setTimeout(refreshStatus, 1500);
        } catch (err) {
          toast(`✖ ${err.message}`, 'err');
        } finally {
          setTimeout(() => (btn.disabled = false), 1500);
        }
      });
    });
  }
  bindAction(['btnReconnect', 'btnReconnect2'], '/api/reconnect', 'toasts.reconnecting');
  bindAction(['btnBotOff', 'btnBotOff2'], '/api/botoff', 'toasts.botOffDone');
  bindAction(['btnBotOn', 'btnBotOn2'], '/api/boton', 'toasts.botOnDone');

  [['btnBalance'], ['btnBalance2']].forEach(([btnId]) => {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await api('/api/chat', { method: 'POST', body: JSON.stringify({ message: '/balance' }) });
        toast(t('toasts.sentBalance'), 'ok');
        showSection('console');
      } catch (err) {
        toast(`✖ ${err.message}`, 'err');
      }
    });
  });

  /* ═══════════ ĐƠN HÀNG ═══════════ */
  async function loadOrders() {
    try {
      const data = await api('/api/orders');
      state.orders = data.orders ?? [];
      renderOrdersFull();
      renderOrdersMini();
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  }

  function filteredOrders() {
    const f = state.orderFilter;
    let list = [...state.orders];
    const q = f.q.trim().toLowerCase();
    if (q) {
      list = list.filter((o) =>
        [o.orderId, o.id, o.ign, o.userTag, o.userId].some((v) => String(v ?? '').toLowerCase().includes(q))
      );
    }
    if (f.status !== 'all') list = list.filter((o) => o.status === f.status);
    const priceOf = (o) => orderVnd(o);
    switch (f.sort) {
      case 'time_asc':
        list.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
        break;
      case 'money_desc':
        list.sort((a, b) => priceOf(b) - priceOf(a));
        break;
      case 'money_asc':
        list.sort((a, b) => priceOf(a) - priceOf(b));
        break;
      default:
        list.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    }
    return list;
  }

  function renderOrdersFull() {
    const list = filteredOrders();
    const f = state.orderFilter;
    const pages = Math.max(1, Math.ceil(list.length / f.pageSize));
    if (f.page > pages) f.page = pages;
    const pageList = list.slice((f.page - 1) * f.pageSize, f.page * f.pageSize);
    const tbody = document.querySelector('#ordersTable tbody');
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="empty">${t('orders.empty')}</td></tr>`;
    } else {
      tbody.innerHTML = pageList
        .map(
          (o) => `<tr>
          <td>${o.orderId ?? o.id ?? '—'}</td>
          <td class="dim">${fmtDateTime(o.createdAt)}</td>
          <td>${o.userTag ?? o.userId ?? '—'}</td>
          <td>${o.ign ?? '—'}</td>
          <td class="num">${fmtStock(orderGame(o))}</td>
          <td class="num">${fmtNumber(orderVnd(o))}</td>
          <td class="dim">${o.paymentMethod ?? '—'}</td>
          <td>${statusTag(o)}</td>
        </tr>`
        )
        .join('');
    }
    $('ordersCount').textContent = t('orders.showing', { shown: list.length, total: state.orders.length });
    renderPager(pages);
  }

  function renderPager(pages) {
    const f = state.orderFilter;
    const wrap = $('ordersPager');
    const nums = [];
    const start = Math.max(1, Math.min(f.page - 2, pages - 4));
    for (let p = start; p <= Math.min(pages, start + 4); p++) nums.push(p);
    wrap.innerHTML = `
      <span class="pager-info">${t('pager.page', { p: f.page, n: pages })}</span>
      <button ${f.page <= 1 ? 'disabled' : ''} data-p="${f.page - 1}">${t('pager.prev')}</button>
      ${nums.map((p) => `<button class="${p === f.page ? 'active' : ''}" data-p="${p}">${p}</button>`).join('')}
      <button ${f.page >= pages ? 'disabled' : ''} data-p="${f.page + 1}">${t('pager.next')}</button>`;
  }
  $('ordersPager').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-p]');
    if (!btn || btn.disabled) return;
    state.orderFilter.page = Number(btn.dataset.p);
    renderOrdersFull();
  });

  function renderOrdersMini() {
    const tbody = document.querySelector('#ordersTableMini tbody');
    const list = [...state.orders]
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
      .slice(0, 5);
    if (!list.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="empty">${t('orders.empty')}</td></tr>`;
      return;
    }
    tbody.innerHTML = list
      .map(
        (o) => `<tr>
        <td>${o.orderId ?? o.id ?? '—'}</td>
        <td>${o.userTag ?? o.userId ?? '—'}</td>
        <td>${o.ign ?? '—'}</td>
        <td class="num">${fmtStock(orderGame(o))}</td>
        <td class="num">${fmtNumber(orderVnd(o))}</td>
        <td class="dim">${o.paymentMethod ?? '—'}</td>
        <td>${statusTag(o)}</td>
      </tr>`
      )
      .join('');
  }

  $('orderSearch').addEventListener(
    'input',
    debounce((e) => {
      state.orderFilter.q = e.target.value;
      state.orderFilter.page = 1;
      renderOrdersFull();
    }, 220)
  );
  $('orderStatus').addEventListener('change', (e) => {
    state.orderFilter.status = e.target.value;
    state.orderFilter.page = 1;
    renderOrdersFull();
  });
  $('orderSort').addEventListener('change', (e) => {
    state.orderFilter.sort = e.target.value;
    renderOrdersFull();
  });
  $('btnRefreshOrders').addEventListener('click', loadOrders);
  $('btnRefreshOrders2').addEventListener('click', loadOrders);

  /* ---- Xuất CSV ---- */
  $('btnExportCsv').addEventListener('click', () => {
    const list = filteredOrders();
    if (!list.length) return toast(t('toasts.nothingToExport'), 'err');
    const esc = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const rows = [
      ['order_id', 'created_at', 'buyer', 'user_id', 'ign', 'game_money', 'price_vnd', 'method', 'status'].join(','),
      ...list.map((o) =>
        [o.orderId ?? o.id, o.createdAt, o.userTag, o.userId, o.ign, String(orderGame(o)), orderVnd(o), o.paymentMethod, o.status]
          .map(esc)
          .join(',')
      ),
    ];
    const blob = new Blob(['\uFEFF' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = `orders-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t('toasts.csvDone', { n: list.length }), 'ok');
  });

  /* ═══════════ SỐ DƯ ═══════════ */
  async function loadBalances() {
    try {
      const data = await api('/api/balances');
      state.balances = data.balances ?? [];
      state.history = data.history ?? [];
      renderBalances();
      renderHistory();
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  }

  function renderBalances() {
    const tbody = document.querySelector('#balancesTable tbody');
    const q = state.balSearch.trim().toLowerCase();
    const all = state.balances;
    const list = q ? all.filter((b) => String(b.userId).toLowerCase().includes(q)) : all;
    $('balTotalMembers').textContent = fmtNumber(all.length);
    $('balTotalVnd').textContent = `${fmtNumber(all.reduce((s, b) => s + (Number(b.amount) || 0), 0))} ₫`;
    tbody.innerHTML = list.length
      ? list.map((b) => `<tr><td class="num">${b.userId}</td><td class="num">${fmtNumber(b.amount)} VNĐ</td></tr>`).join('')
      : `<tr><td colspan="2" class="empty">${t('bal.empty')}</td></tr>`;
  }

  function renderHistory() {
    const tbody = document.querySelector('#historyTable tbody');
    const list = state.history.slice(0, 30);
    tbody.innerHTML = list.length
      ? list
          .map(
            (h) => `<tr>
          <td class="dim">${fmtDateTime(h.timestamp)}</td>
          <td class="num">${h.userId ?? '—'}</td>
          <td>${h.type ?? ''} ${h.reason ? `<span class="dim">(${h.reason})</span>` : ''}</td>
          <td class="num" style="color:${h.type === 'ADD' ? 'var(--ok)' : 'var(--bad)'}">${h.type === 'ADD' ? '+' : '-'}${fmtNumber(h.amount)}</td>
          <td class="dim">${h.reason ?? ''}</td>
        </tr>`
          )
          .join('')
      : `<tr><td colspan="5" class="empty">${t('bal.noHistory')}</td></tr>`;
  }

  $('balSearch').addEventListener(
    'input',
    debounce((e) => {
      state.balSearch = e.target.value;
      renderBalances();
    }, 200)
  );

  async function adjustBalance(action) {
    const userId = $('balUserId').value.trim();
    const amount = $('balAmount').value.trim();
    if (!userId || !amount) return toast(t('toasts.fillBalance'), 'err');
    try {
      await api('/api/balance', { method: 'POST', body: JSON.stringify({ userId, amount, action }) });
      toast(t(action === 'deduct' ? 'toasts.balanceDeduct' : 'toasts.balanceAdd', { user: userId }), 'ok');
      $('balUserId').value = '';
      $('balAmount').value = '';
      loadBalances();
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  }
  $('btnBalAdd').addEventListener('click', () => adjustBalance('add'));
  $('btnBalDeduct').addEventListener('click', () => adjustBalance('deduct'));

  /* ═══════════ CONSOLE ═══════════ */
  const consoleEl = $('console');
  const miniEl = $('miniConsole');

  function appendConsole(line, opts = {}) {
    const isChat = opts.chat === true;
    if (state.onlyChat && !isChat) return;
    const p = document.createElement('p');
    p.className = `log-line ${isChat ? 'log-chat' : opts.sent ? 'log-sent' : opts.level === 'warn' ? 'log-warn' : opts.level === 'error' ? 'log-error' : ''}`;
    p.textContent = line;
    consoleEl.appendChild(p);
    while (consoleEl.childElementCount > 400) consoleEl.removeChild(consoleEl.firstChild);
    state.consoleLines = consoleEl.childElementCount;
    $('consoleCount').textContent = t('console.lines', { n: state.consoleLines });
    if (state.autoScroll) consoleEl.scrollTop = consoleEl.scrollHeight;

    if (state.section === 'dashboard' && miniEl) {
      const m = document.createElement('p');
      m.className = `log-line ${isChat ? 'log-chat' : 'log-system'}`;
      m.textContent = line.length > 150 ? `${line.slice(0, 150)}…` : line;
      miniEl.appendChild(m);
      while (miniEl.childElementCount > 40) miniEl.removeChild(miniEl.firstChild);
      miniEl.scrollTop = miniEl.scrollHeight;
    }
  }

  $('onlyChat').addEventListener('change', (e) => (state.onlyChat = e.target.checked));
  $('autoScroll').addEventListener('change', (e) => (state.autoScroll = e.target.checked));
  $('clearConsole').addEventListener('click', () => {
    consoleEl.innerHTML = '<p class="log-line log-system">—</p>';
    state.consoleLines = 1;
    $('consoleCount').textContent = t('console.lines', { n: 1 });
  });

  $('chatForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('chatInput');
    const message = input.value.trim();
    if (!message) return;
    input.value = '';
    try {
      await api('/api/chat', { method: 'POST', body: JSON.stringify({ message }) });
      appendConsole(t('console.sentEcho', { msg: message }), { sent: true });
      state.chatHist.push(message);
      if (state.chatHist.length > 30) state.chatHist.shift();
      state.chatIdx = -1;
    } catch (err) {
      if (state.panelKey) toast(`✖ ${err.message}`, 'err');
    }
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!state.chatHist.length) return;
      state.chatIdx = state.chatIdx < 0 ? state.chatHist.length - 1 : Math.max(0, state.chatIdx - 1);
      $('chatInput').value = state.chatHist[state.chatIdx];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.chatIdx < 0) return;
      state.chatIdx += 1;
      if (state.chatIdx >= state.chatHist.length) {
        state.chatIdx = -1;
        $('chatInput').value = '';
      } else {
        $('chatInput').value = state.chatHist[state.chatIdx];
      }
    }
  });

  /* ═══════════ SOCKET.IO REALTIME (giữ event 'log' | 'chat' | 'configUpdate') ═══════════ */
  function setSocketBadges(online) {
    state.socketOnline = online;
    [ $('liveBadge'), $('consoleLive') ].forEach((el) => {
      if (!el) return;
      el.classList.toggle('off', !online);
      el.textContent = online ? '● LIVE' : '● OFF';
    });
  }

  const socket = io({ auth: { key: state.panelKey } });
  socket.on('connect', () => setSocketBadges(true));
  socket.on('disconnect', () => setSocketBadges(false));
  socket.on('log', (payload) => {
    const { level, line } = typeof payload === 'string' ? { level: 'log', line: payload } : payload;
    appendConsole(line, { level });
  });
  socket.on('chat', (payload) => {
    const line = typeof payload === 'string' ? payload : payload?.line ?? '';
    if (line) appendConsole(line, { chat: true });
  });
  const onConfigUpdate = debounce(() => refreshStatus(), 400);
  socket.on('configUpdate', onConfigUpdate);

  /* ═══════════ THỐNG KÊ (mới — /api/stats) ═══════════ */
  async function loadStats() {
    let stats;
    try {
      stats = await api('/api/stats');
    } catch {
      return; // bot cũ chưa có endpoint này — im lặng
    }
    $('stTotalOrders').textContent = fmtNumber(stats.totals.orders);
    $('stCompleted').textContent = fmtNumber(stats.totals.completed);
    $('stRevenue').textContent = `${fmtNumber(stats.totals.revenue)} ₫`;
    $('stRevenueToday').textContent = `${fmtNumber(stats.totals.revenueToday)} ₫`;

    // Dashboard mini chart + trang thống kê
    const dayData = (stats.byDay ?? []).map((d) => ({
      label: d.day.slice(8, 10) + '/' + d.day.slice(5, 7),
      tip: d.day,
      value: d.revenue,
    }));
    const fmtVnd = (d) => `${fmtNumber(d.value)} ₫`;
    Charts.area($('dashRevChart'), dayData, { format: fmtVnd, emptyText: t('stats.noData') });
    $('revToday').textContent = `${fmtNumber(stats.totals.revenueToday)} ₫`;
    Charts.area($('revChart'), dayData, { format: fmtVnd, emptyText: t('stats.noData') });

    // Donut trạng thái
    const segs = Object.entries(stats.byStatus ?? {})
      .map(([k, v]) => ({ label: t(STATUS_KEY(k)), value: v, color: Charts.STATUS_COLORS[k] ?? '#94a3b8' }))
      .sort((a, b) => b.value - a.value);
    Charts.donut($('statusDonut'), segs, { centerValue: fmtNumber(stats.totals.orders), centerLabel: t('stats.total') });
    $('statusLegend').innerHTML = segs.length
      ? segs
          .map(
            (s) => `<div class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}<b>${fmtNumber(s.value)}</b></div>`
          )
          .join('')
      : `<p class="hint">${t('stats.noData')}</p>`;

    // Phương thức thanh toán
    Charts.bars(
      $('methodBars'),
      (stats.byMethod ?? []).map((m) => ({ label: m.method, value: m.revenue, display: `${fmtNumber(m.revenue)} ₫ · ${m.count}×` })),
      { emptyText: t('stats.noMethod') }
    );

    // Top buyers
    $('topBuyers').innerHTML = (stats.topBuyers ?? []).length
      ? stats.topBuyers
          .map(
            (b, i) => `<div class="buyer-row">
          <span class="buyer-rank">${i + 1}</span>
          <div><div class="buyer-name">${b.buyer}</div><div class="buyer-meta">${b.count} ${t('stats.ordersUnit')}</div></div>
          <span class="buyer-total">${fmtNumber(b.total)} ₫</span>
        </div>`
          )
          .join('')
      : `<p class="hint" style="text-align:center;padding:1rem 0;">${t('stats.noBuyers')}</p>`;
  }
  $('btnRefreshStats').addEventListener('click', () => loadStats());

  /* ═══════════ CÀI ĐẶT: ngôn ngữ / glow / khóa ═══════════ */
  document.querySelectorAll('#langSwitch .lang-opt, #langSwitch2 .lang-opt').forEach((btn) => {
    btn.addEventListener('click', () => setLang(btn.dataset.lang));
  });

  function applyGlow() {
    document.documentElement.dataset.glow = state.glow ? 'on' : 'off';
    $('glowToggle').classList.toggle('active', state.glow);
    $('setGlow').checked = state.glow;
    $('glowState').textContent = state.glow ? t('set.glowOn') : t('set.glowOff');
  }
  function toggleGlow() {
    state.glow = !state.glow;
    localStorage.setItem(GLOW_KEY, state.glow ? 'on' : 'off');
    applyGlow();
    toast(state.glow ? t('toasts.glowOn') : t('toasts.glowOff'), 'ok');
  }
  $('glowToggle').addEventListener('click', toggleGlow);
  $('setGlow').addEventListener('change', toggleGlow);

  /* ═══════════ ĐĂNG XUẤT & KHÓA TRUY CẬP (mask 401) ═══════════ */
  function logout() {
    state.panelKey = '';
    try {
      localStorage.removeItem(KEY_STORAGE);
      sessionStorage.removeItem(KEY_STORAGE);
    } catch {}
    if (socket) {
      socket.auth = { key: '' };
      socket.disconnect();
    }
    showKeyMask(true, false);
    toast(t('toasts.loggedOut'), 'ok');
  }

  // Tự động xóa key khi người dùng làm mới trang hoặc rời khỏi web
  window.addEventListener('beforeunload', () => {
    state.panelKey = '';
    try {
      localStorage.removeItem(KEY_STORAGE);
      sessionStorage.removeItem(KEY_STORAGE);
    } catch {}
  });

  window.addEventListener('pagehide', () => {
    state.panelKey = '';
    try {
      localStorage.removeItem(KEY_STORAGE);
      sessionStorage.removeItem(KEY_STORAGE);
    } catch {}
  });

  $('logoutBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    logout();
  });

  $('sideLogoutBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    closeSidebar();
    logout();
  });

  function showKeyMask(show, wrong = false) {
    $('keyMask').style.display = show ? 'grid' : 'none';
    $('keyErr').style.display = wrong ? 'block' : 'none';
    if (show) {
      setTimeout(() => $('keyInput').focus(), 50);
    }
  }

  async function handleLogin() {
    const candidate = $('keyInput').value.trim();
    if (!candidate) {
      $('keyErr').textContent = t('key.wrong');
      $('keyErr').style.display = 'block';
      $('keyInput').focus();
      return;
    }

    $('keyBtn').disabled = true;
    try {
      const res = await fetch(`/api/status?key=${encodeURIComponent(candidate)}`);
      if (res.status === 401) {
        $('keyErr').textContent = t('key.wrong');
        $('keyErr').style.display = 'block';
        $('keyInput').focus();
        $('keyInput').select();
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      // Đăng nhập thành công — lưu vào bộ nhớ RAM trang, không lưu localStorage/sessionStorage
      state.panelKey = candidate;
      try {
        localStorage.removeItem(KEY_STORAGE);
        sessionStorage.removeItem(KEY_STORAGE);
      } catch {}

      $('keyErr').style.display = 'none';
      showKeyMask(false);
      $('keyInput').value = '';

      // Tái kết nối socket
      if (socket) {
        socket.auth = { key: state.panelKey };
        socket.disconnect().connect();
      }

      refreshStatus();
      loadOrders();
      loadStats();

      toast(t('toasts.keySaved'), 'ok');
    } catch (err) {
      $('keyErr').textContent = err.message || 'Lỗi kết nối';
      $('keyErr').style.display = 'block';
    } finally {
      $('keyBtn').disabled = false;
    }
  }

  $('keyBtn').addEventListener('click', handleLogin);
  $('keyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleLogin();
  });

  $('keyForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const candidate = $('setKey').value.trim();
    if (!candidate) return;
    try {
      const res = await fetch(`/api/status?key=${encodeURIComponent(candidate)}`);
      if (res.status === 401) {
        toast(t('toasts.wrongKey'), 'err');
        return;
      }
      state.panelKey = candidate;
      try {
        localStorage.removeItem(KEY_STORAGE);
        sessionStorage.removeItem(KEY_STORAGE);
      } catch {}
      if (socket) {
        socket.auth = { key: state.panelKey };
        socket.disconnect().connect();
      }
      toast(t('toasts.keySaved'), 'ok');
      $('setKey').value = '';
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  /* ═══════════ COMMAND PALETTE ⌘K ═══════════ */
  const cmdk = $('cmdk');
  const cmdkInput = $('cmdkInput');
  const cmdkList = $('cmdkList');
  let cmdkSel = 0;
  let cmdkItems = [];

  function cmdkBuild() {
    const nav = [
      ['dashboard', '🏠'], ['stats', '📊'], ['config', '⚙️'], ['orders', '🧾'],
      ['balances', '💳'], ['console', '🖥️'], ['settings', '🛠️'],
    ].map(([id, icon]) => ({
      icon,
      label: t(`title.${id}`),
      group: 'cmdk.groupNav',
      run: () => showSection(id),
    }));
    const actions = [
      ['🔄', t('cmdk.reconnect'), () => bindClick('btnReconnect')],
      ['🛑', t('cmdk.botoff'), () => bindClick('btnBotOff')],
      ['🟢', t('cmdk.boton'), () => bindClick('btnBotOn')],
      ['💰', t('cmdk.balance'), () => bindClick('btnBalance')],
      ['📤', t('cmdk.export'), () => { showSection('orders'); $('btnExportCsv').click(); }],
      ['✨', t('cmdk.glow'), toggleGlow],
      ['🌐', t('cmdk.lang'), () => setLang(state.lang === 'vi' ? 'en' : 'vi')],
      ['♻️', t('cmdk.refresh'), () => { refreshStatus(); loadOrders(); }],
      ['🕹️', t('cmdk.legacy'), () => window.open('/legacy/index.html', '_blank')],
      ['🔒', t('cmdk.logout'), logout],
    ].map(([icon, label, run]) => ({ icon, label, group: 'cmdk.groupActions', run }));
    return [...nav, ...actions];
  }

  function bindClick(id) {
    $(id)?.click();
  }

  function cmdkRender() {
    const q = cmdkInput.value.trim().toLowerCase();
    cmdkItems = cmdkBuild().filter((it) => !q || it.label.toLowerCase().includes(q));
    cmdkSel = Math.min(cmdkSel, Math.max(0, cmdkItems.length - 1));
    if (!cmdkItems.length) {
      cmdkList.innerHTML = `<div class="cmdk-empty">${t('cmdk.empty')}</div>`;
      return;
    }
    let html = '';
    let lastGroup = '';
    cmdkItems.forEach((it, i) => {
      const g = t(it.group);
      if (g !== lastGroup) {
        html += `<div style="font-size:.64rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--text-3);padding:.55rem .9rem .25rem;">${g}</div>`;
        lastGroup = g;
      }
      html += `<div class="cmdk-item ${i === cmdkSel ? 'sel' : ''}" data-i="${i}">
        <span class="cmdk-icon">${it.icon}</span><span>${it.label}</span></div>`;
    });
    cmdkList.innerHTML = html;
  }

  function cmdkOpen() {
    cmdk.style.display = 'grid';
    cmdkInput.value = '';
    cmdkSel = 0;
    cmdkRender();
    setTimeout(() => cmdkInput.focus(), 30);
  }
  function cmdkClose() {
    cmdk.style.display = 'none';
  }
  $('cmdkBtn').addEventListener('click', cmdkOpen);
  cmdk.addEventListener('click', (e) => {
    if (e.target === cmdk) cmdkClose();
    const item = e.target.closest('.cmdk-item');
    if (item) {
      cmdkClose();
      cmdkItems[Number(item.dataset.i)].run();
    }
  });
  cmdkInput.addEventListener('input', () => {
    cmdkSel = 0;
    cmdkRender();
  });
  cmdkInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdkSel = Math.min(cmdkSel + 1, cmdkItems.length - 1);
      cmdkRender();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdkSel = Math.max(cmdkSel - 1, 0);
      cmdkRender();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cmdkItems[cmdkSel]) {
        cmdkClose();
        cmdkItems[cmdkSel].run();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      cmdk.style.display === 'grid' ? cmdkClose() : cmdkOpen();
    } else if (e.key === 'Escape' && cmdk.style.display === 'grid') {
      cmdkClose();
    }
  });

  /* ═══════════ MOBILE SIDEBAR ═══════════ */
  $('menuBtn').addEventListener('click', () => {
    $('sidebar').classList.toggle('open');
    $('sidebarBackdrop').classList.toggle('show');
  });
  $('sidebarBackdrop').addEventListener('click', closeSidebar);
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      showSection(item.dataset.section);
    });
  });

  /* ═══════════ KHỞI ĐỘNG (giữ nhịp refresh 8s/30s của panel cũ) ═══════════ */
  applyGlow();
  applyI18n();
  refreshStatus();
  loadOrders();
  loadStats();
  setSocketBadges(state.socketOnline);
  setInterval(refreshStatus, 8000);
  setInterval(loadOrders, 30000);
  setInterval(() => loadStats(), 90000);
})();
