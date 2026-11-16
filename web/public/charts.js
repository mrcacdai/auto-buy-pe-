/* ═══════════════════════════════════════════════════════════════
   BedrockPay — Nova Panel v3 · Charts (SVG thuần, không thư viện)
   Charts.area(el, [{label, value}], opts)  — biểu đồ vùng có tooltip
   Charts.donut(el, [{label, value, color}], opts) — biểu đồ vành khuyên
   Charts.bars(el, [{label, value, display}]) — thanh ngang
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const Charts = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const STATUS_COLORS = {
    COMPLETED: '#34d399',
    PENDING_PAYMENT: '#fbbf24',
    PROCESSING: '#22d3ee',
    WAITING_RETRY: '#a78bfa',
    EXPIRED: '#64748b',
    FAILED: '#f87171',
  };
  let tipEl = null;

  function tip() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'chart-tip';
      tipEl.style.display = 'none';
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }

  function showTip(evt, html) {
    const el = tip();
    el.innerHTML = html;
    el.style.display = 'block';
    const pad = 14;
    const rect = el.getBoundingClientRect();
    let x = evt.clientX + pad;
    let y = evt.clientY - rect.height - pad;
    if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
    if (y < 8) y = evt.clientY + pad;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function hideTip() {
    if (tipEl) tipEl.style.display = 'none';
  }

  const uid = (() => {
    let n = 0;
    return (p) => `${p}-grad-${++n}`;
  })();

  /* ═══════════ AREA ═══════════ */
  function area(el, data, opts = {}) {
    el.innerHTML = '';
    if (!data || !data.length) {
      el.innerHTML = `<div style="display:grid;place-items:center;height:100%;color:rgba(255,255,255,.3);font-size:.8rem;font-weight:600;">${opts.emptyText ?? '—'}</div>`;
      return;
    }
    const W = 600;
    const H = 200;
    const padX = 8;
    const padTop = 14;
    const padBottom = 22;
    const values = data.map((d) => Math.max(0, Number(d.value) || 0));
    const max = Math.max(...values, 1);
    const innerW = W - padX * 2;
    const innerH = H - padTop - padBottom;
    const step = data.length > 1 ? innerW / (data.length - 1) : 0;

    const pts = values.map((v, i) => ({
      x: padX + (data.length > 1 ? i * step : innerW / 2),
      y: padTop + innerH - (v / max) * innerH,
      d: data[i],
    }));

    const lineD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L${pts[pts.length - 1].x.toFixed(1)},${padTop + innerH} L${pts[0].x.toFixed(1)},${padTop + innerH} Z`;
    const gradId = uid('area');

    const gridYs = [0.25, 0.55, 0.85].map((f) => padTop + innerH * f);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML = `
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#22d3ee" stop-opacity="0.34"/>
          <stop offset="100%" stop-color="#22d3ee" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridYs.map((y) => `<line x1="${padX}" y1="${y}" x2="${W - padX}" y2="${y}" stroke="rgba(255,255,255,0.06)" stroke-width="1" vector-effect="non-scaling-stroke"/>`).join('')}
      <path d="${areaD}" fill="url(#${gradId})"/>
      <path d="${lineD}" fill="none" stroke="#22d3ee" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 6px rgba(34,211,238,.55))"/>
      <circle id="area-dot" r="4" fill="#67e8f9" stroke="#05070a" stroke-width="2" style="display:none"/>
    `;
    el.appendChild(svg);

    // Nhãn trục X (tối đa 7 nhãn)
    if (opts.showX !== false && data.length > 1) {
      const labelEvery = Math.ceil(data.length / 7);
      const xLabels = document.createElement('div');
      xLabels.style.cssText = 'display:flex;justify-content:space-between;margin-top:-16px;padding:0 2px;';
      data.forEach((d, i) => {
        if (i % labelEvery !== 0 && i !== data.length - 1) return;
        const s = document.createElement('span');
        s.textContent = d.label ?? '';
        s.style.cssText = 'font-size:.6rem;font-weight:600;color:rgba(255,255,255,.32);font-family:var(--mono)';
        xLabels.appendChild(s);
      });
      el.appendChild(xLabels);
    }

    // Vùng bắt chuột (hình học thật, không bóp méo)
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;inset:0;';
    el.style.position = 'relative';
    el.appendChild(overlay);

    const dot = svg.querySelector('#area-dot');
    overlay.addEventListener('mousemove', (evt) => {
      const rect = el.getBoundingClientRect();
      const fx = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));
      const idx = data.length > 1 ? Math.round(fx * (data.length - 1)) : 0;
      const p = pts[idx];
      dot.setAttribute('cx', String(p.x));
      dot.setAttribute('cy', String(p.y));
      dot.style.display = 'block';
      const val = opts.format ? opts.format(p.d) : String(p.d.value);
      showTip(evt, `${val}<small>${p.d.tip ?? p.d.label ?? ''}</small>`);
    });
    overlay.addEventListener('mouseleave', () => {
      dot.style.display = 'none';
      hideTip();
    });
  }

  /* ═══════════ DONUT ═══════════ */
  function donut(el, segments, opts = {}) {
    el.innerHTML = '';
    const total = segments.reduce((s, x) => s + x.value, 0);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 42 42');
    const R = 16.915;
    if (total === 0) {
      svg.innerHTML = `<circle cx="21" cy="21" r="${R}" fill="none" stroke="rgba(255,255,255,0.07)" stroke-width="3.4"/>`;
      el.appendChild(svg);
    } else {
      let offset = 25;
      const parts = segments
        .filter((s) => s.value > 0)
        .map((s) => {
          const frac = s.value / total;
          const dash = Math.max(0, frac * 100 - 0.6);
          const seg = `<circle cx="21" cy="21" r="${R}" fill="none" stroke="${s.color}" stroke-width="3.4"
            stroke-dasharray="${dash.toFixed(2)} ${(100 - dash).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
            style="filter:drop-shadow(0 0 3px ${s.color}66)"><title>${s.label}: ${s.value}</title></circle>`;
          offset -= frac * 100;
          return seg;
        })
        .join('');
      svg.innerHTML = `<circle cx="21" cy="21" r="${R}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="3.4"/>${parts}`;
      el.appendChild(svg);
    }
    const center = document.createElement('div');
    center.className = 'donut-center';
    center.innerHTML = `<div><b>${opts.centerValue ?? total}</b><span>${opts.centerLabel ?? ''}</span></div>`;
    el.appendChild(center);
  }

  /* ═══════════ BARS ═══════════ */
  function bars(el, rows, opts = {}) {
    el.innerHTML = '';
    if (!rows.length) {
      el.innerHTML = `<p class="hint" style="text-align:center;padding:1.4rem 0;">${opts.emptyText ?? '—'}</p>`;
      return;
    }
    const max = Math.max(...rows.map((r) => Math.max(0, Number(r.value) || 0)), 1);
    rows.forEach((r, i) => {
      const pct = Math.max(2, ((Number(r.value) || 0) / max) * 100);
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = `
        <span class="bar-label" title="${r.label}">${r.label}</span>
        <div class="bar-track"><div class="bar-fill ${i % 2 ? 'alt' : ''}" style="width:0%"></div></div>
        <span class="bar-value">${r.display ?? r.value}</span>`;
      el.appendChild(row);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          row.querySelector('.bar-fill').style.width = `${pct}%`;
        });
      });
    });
  }

  return { area, donut, bars, STATUS_COLORS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = { Charts };
