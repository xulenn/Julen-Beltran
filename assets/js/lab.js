/* Risk lab — four questions about risk, answered from the daily S&P 500 history in the browser.
   Reads the same series as the chart (market.js publishes it as window.JB.history).
   Price only: no dividends, no inflation adjustment. */
(() => {
  'use strict';
  const grid = document.getElementById('lab-grid');
  if (!grid) return;
  const $ = (id) => document.getElementById(id);
  const DAY = 86_400_000;
  const MIN = '−';

  /* ---------- formatting ---------- */
  const nfc = {};
  const nf = (d) => (nfc[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? MIN : '');
  const pct = (v, d = 1) => `${sgn(Number(v.toFixed(d)))}${nf(d).format(Math.abs(v))}%`;
  const money = (v) => `$${nf(0).format(Math.round(v))}`;
  const UTC = { timeZone: 'UTC' };
  const fDay = new Intl.DateTimeFormat('en-US', { ...UTC, year: 'numeric', month: 'short', day: 'numeric' });
  const fMonth = new Intl.DateTimeFormat('en-US', { ...UTC, year: 'numeric', month: 'short' });
  const fYear = new Intl.DateTimeFormat('en-US', { ...UTC, year: 'numeric' });
  const day = (n) => fDay.format(n * DAY);
  const month = (n) => fMonth.format(n * DAY);
  const year = (n) => fYear.format(n * DAY);
  function duration(days) {
    if (days < 60) return `${days} days`;
    if (days < 730) return `${Math.round(days / 30.44)} months`;
    return `${nf(1).format(days / 365.25)} years`;
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  const { percentile, holding, drawdowns, bestDays, tails } = window.RiskMath;

  /* ---------- 01 · time in the market ---------- */
  let HOLD = [];
  function renderHolding(D) {
    const host = $('lab-hold');
    host.replaceChildren();
    const lo = Math.floor(Math.min(...HOLD.map((h) => h.worst)) * 10) * 10;
    const hi = Math.ceil(Math.max(...HOLD.map((h) => h.best)) * 10) * 10;
    const narrow = host.clientWidth < 560;
    const step = narrow ? 40 : 20;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
    const at = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
    const frac = (a) => a * 100;

    const head = el('div', 'rp-head');
    head.append(el('span'), el('span'), el('span', 'rp-h-loss', 'Lost money'));
    const axis = el('div', 'rp-axis');
    axis.setAttribute('aria-hidden', 'true');
    ticks.forEach((t) => { const s = el('span', '', `${t > 0 ? '+' : t < 0 ? MIN : ''}${Math.abs(t)}%`); s.style.left = at(t); axis.append(s); });
    head.replaceChild(axis, head.children[1]);
    host.append(head);

    const rows = HOLD.map((h) => {
      const row = el('div', 'rp-row');
      row.tabIndex = 0;
      row.dataset.years = h.years;
      row.setAttribute('aria-label', readoutText(h));
      row.append(el('span', 'rp-label', `${h.years} ${h.years === 1 ? 'year' : 'years'}`));
      const track = el('div', 'rp-track');
      ticks.forEach((t) => { const g = el('i', t === 0 ? 'rp-g zero' : 'rp-g'); g.style.left = at(t); track.append(g); });
      const wh = el('i', 'rp-whisk'); wh.style.left = at(frac(h.worst)); wh.style.width = `${((frac(h.best) - frac(h.worst)) / (hi - lo)) * 100}%`;
      const bx = el('i', 'rp-box'); bx.style.left = at(frac(h.p10)); bx.style.width = `${((frac(h.p90) - frac(h.p10)) / (hi - lo)) * 100}%`;
      const md = el('i', 'rp-med'); md.style.left = at(frac(h.median));
      track.append(wh, bx, md);
      const loss = el('span', 'rp-loss', h.lossShare === 0 ? 'Never' : `${nf(h.lossShare < 0.1 ? 1 : 0).format(h.lossShare * 100)}%`);
      loss.append(el('small', '', h.lossShare === 0 ? 'in any window' : 'of windows'));
      row.append(track, loss);
      host.append(row);
      return row;
    });

    const read = $('lab-hold-read');
    const select = (row) => {
      rows.forEach((r) => r.classList.toggle('is-on', r === row));
      read.textContent = readoutText(HOLD.find((h) => String(h.years) === row.dataset.years));
    };
    rows.forEach((r) => {
      r.addEventListener('pointerenter', () => select(r));
      r.addEventListener('focus', () => select(r));
      r.addEventListener('click', () => select(r));
    });
    select(rows.find((r) => r.dataset.years === '10') || rows[0]);

    // table twin for assistive tech
    const tbl = el('table');
    tbl.append(el('caption', '', 'Holding-period outcomes for the S&P 500 (annualized, price only)'));
    const thead = tbl.createTHead().insertRow();
    ['Holding period', 'Windows', 'Lost money', 'Median a year', '10th percentile', '90th percentile', 'Worst a year', 'Best a year'].forEach((t) => { const th = el('th', '', t); th.scope = 'col'; thead.append(th); });
    const tb = tbl.createTBody();
    HOLD.forEach((h) => {
      const tr = tb.insertRow();
      [`${h.years} years`, nf(0).format(h.windows), `${nf(1).format(h.lossShare * 100)}%`, pct(h.median * 100), pct(h.p10 * 100), pct(h.p90 * 100), pct(h.worst * 100), pct(h.best * 100)].forEach((t) => { tr.insertCell().textContent = t; });
    });
    const clip = el('div', 'sr-only'); // a bare <table> ignores the 1px sizing trick, so clip it in a wrapper
    clip.append(tbl);
    host.append(clip);
  }
  function readoutText(h) {
    return `${h.years} ${h.years === 1 ? 'year' : 'years'}: ${nf(0).format(h.windows)} possible start dates. Median ${pct(h.median * 100)} a year; the middle 80% ended between ${pct(h.p10 * 100)} and ${pct(h.p90 * 100)} a year. Worst ${pct(h.worst * 100)} a year (starting ${day(h.worstStart)}), best ${pct(h.best * 100)} a year (starting ${day(h.bestStart)}). ${h.lossShare === 0 ? 'None of these windows lost money.' : `${nf(1).format(h.lossShare * 100)}% of them lost money.`}`;
  }

  /* ---------- 02 · drawdowns ---------- */
  function renderDrawdowns(D, eps, firstDay, lastDay) {
    const top = eps.slice(0, 8);
    const max = Math.abs(top[0].depth);
    const body = $('lab-dd').tBodies[0];
    body.replaceChildren();
    top.forEach((e) => {
      const tr = body.insertRow();
      const c1 = tr.insertCell();
      c1.append(el('strong', 'down', pct(e.depth * 100)));
      const bar = el('i', 'dd-bar'); bar.style.setProperty('--w', `${(Math.abs(e.depth) / max) * 100}%`); bar.setAttribute('aria-hidden', 'true');
      c1.append(bar);
      const c2 = tr.insertCell();
      c2.textContent = `${month(e.peak)} → ${month(e.trough)}`;
      c2.title = `${day(e.peak)} (${nf(2).format(e.peakPx)}) → ${day(e.trough)} (${nf(2).format(e.troughPx)})`;
      const c3 = tr.insertCell(); c3.className = 'c-down'; c3.textContent = duration(e.trough - e.peak);
      const c4 = tr.insertCell(); c4.textContent = e.recovered ? duration(e.recovered - e.trough) : 'Still recovering';
    });
    const years = (lastDay - firstDay) / 365.25;
    const rec = eps.filter((e) => e.recovered).map((e) => e.recovered - e.trough).sort((a, b) => a - b);
    const med = rec.length ? percentile(Float64Array.from(rec), 0.5) : null;
    const bears = eps.filter((e) => e.depth <= -0.2).length;
    $('lab-dd-take').textContent = `Since ${year(firstDay)} the index has fallen 10% or more from a peak ${eps.length} times — about once every ${nf(1).format(years / eps.length)} years — and ${bears} of those became bear markets (−20% or worse). ${med != null ? `The typical decline took ${duration(Math.round(med))} to recover from the low.` : ''}`;
  }

  /* ---------- 03 · missing the best days ---------- */
  const PERIODS = [{ id: '10', label: '10Y', years: 10 }, { id: '20', label: '20Y', years: 20 }, { id: '30', label: '30Y', years: 30 }, { id: 'all', label: 'All', years: null }];
  let bdPeriod = '20';
  function renderBestDays(d, c) {
    const P = PERIODS.find((p) => p.id === bdPeriod);
    const R = bestDays(d, c, P.years);
    const full = R.values[0].v;
    const list = $('lab-bd');
    list.replaceChildren();
    R.values.forEach((row) => {
      const li = el('li', row.N === 0 ? 'full' : '');
      li.append(el('span', 'bd-name', row.N === 0 ? 'Fully invested' : `Missed the ${row.N} best days`));
      const tr = el('span', 'bd-track');
      const f = el('i', 'bd-fill'); f.style.width = `${(row.v / full) * 100}%`;
      tr.append(f);
      const val = el('span', 'bd-val', money(row.v));
      if (row.N) val.append(el('small', '', pct((row.v / full - 1) * 100, 0)));
      li.append(tr, val);
      list.append(li);
    });
    const v10 = R.values.find((x) => x.N === 10).v;
    $('lab-bd-take').textContent = `Over the ${P.years ? `last ${P.years} years` : `whole period since ${year(R.start)}`}, ${money(10000)} grew to ${money(full)}. Sit out just the 10 best days and it ends at ${money(v10)} — ${pct((v10 / full - 1) * 100, 0)}. ${R.clustered} of those 10 best days landed within 15 trading days of one of the 10 worst, which is why you can't dodge the bad days and keep the good ones.`;
    $('lab-bd-foot').textContent = `${nf(0).format(R.days)} trading days from ${day(R.start)}; price index only, so dividends are excluded and every figure is lower than a total-return version would be.`;
    document.querySelectorAll('#lab-bd-range button').forEach((b) => { b.setAttribute('aria-checked', String(b.dataset.id === bdPeriod)); b.tabIndex = b.dataset.id === bdPeriod ? 0 : -1; });
  }
  function buildPeriodSwitch(d, c) {
    const host = $('lab-bd-range');
    PERIODS.forEach((p) => {
      const b = el('button', '', p.label);
      b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.id = p.id;
      host.append(b);
    });
    host.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { bdPeriod = b.dataset.id; renderBestDays(d, c); } });
    host.addEventListener('keydown', (e) => {
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!k) return;
      e.preventDefault();
      const btns = [...host.querySelectorAll('button')];
      const i = btns.findIndex((b) => b.dataset.id === bdPeriod);
      const nb = btns[(i + k + btns.length) % btns.length];
      bdPeriod = nb.dataset.id; renderBestDays(d, c); nb.focus();
    });
  }

  /* ---------- 04 · fat tails ---------- */
  let TAILS = null;
  function renderTails() {
    const T = TAILS;
    const host = $('lab-ft');
    const W = Math.max(280, host.clientWidth);
    const H = W < 520 ? 250 : 320;
    const m = { l: 44, r: 10, t: 18, b: 34 };
    const pw = W - m.l - m.r;
    const ph = H - m.t - m.b;
    const maxC = Math.max(...T.counts);
    const yMax = Math.pow(10, Math.ceil(Math.log10(maxC)));
    const yMin = 0.5;
    const sy = (v) => m.t + ph - ((Math.log10(Math.max(v, yMin)) - Math.log10(yMin)) / (Math.log10(yMax) - Math.log10(yMin))) * ph;
    const sx = (v) => m.l + ((v - T.LO) / (T.B * T.W)) * pw;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });

    for (let p = 1; p <= yMax; p *= 10) {
      const y = Math.round(sy(p)) + 0.5;
      root.append(svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, class: 'ft-grid' }));
      const t = svg('text', { x: m.l - 8, y: y + 4, class: 'ft-axis', 'text-anchor': 'end' });
      t.textContent = nf(0).format(p);
      root.append(t);
    }
    [-8, -4, 0, 4, 8].forEach((v) => {
      const t = svg('text', { x: sx(v), y: H - 10, class: 'ft-axis', 'text-anchor': 'middle' });
      t.textContent = `${v > 0 ? '+' : v < 0 ? MIN : ''}${Math.abs(v)}%`;
      root.append(t);
    });
    const yl = svg('text', { x: 0, y: 11, class: 'ft-axis' });
    yl.textContent = 'days (log scale)';
    root.append(yl);

    // bars (columns: 4px rounded data end, square at the baseline, 2px gap)
    const bw = Math.min(24, pw / T.B - 2);
    T.counts.forEach((cnt, b) => {
      if (!cnt) return;
      const x = m.l + (b + 0.5) * (pw / T.B) - bw / 2;
      const y = sy(cnt);
      const base = sy(yMin);
      const h = Math.max(1, base - y);
      const r = Math.min(3, h, bw / 2);
      const lo = T.LO + b * T.W;
      const label = `${b === 0 ? `${pct(lo + T.W, 1).replace('+', '')} or lower` : b === T.B - 1 ? `${pct(lo, 1)} or higher` : `${pct(lo, 1)} to ${pct(lo + T.W, 1)}`}: ${nf(0).format(cnt)} days (a bell curve predicts ${nf(cnt < 20 ? 1 : 0).format(T.expected[b])})`;
      const bar = svg('path', { d: `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z`, class: 'ft-bar' });
      const tt = svg('title');
      tt.textContent = label;
      bar.append(tt);
      root.append(bar);
    });

    // normal curve with the same mean and standard deviation
    let dstr = '';
    let pen = false;
    T.expected.forEach((e, b) => {
      const x = m.l + (b + 0.5) * (pw / T.B);
      if (e < yMin) { pen = false; return; } // the curve leaves the plot where it predicts under half a day
      dstr += `${pen ? 'L' : 'M'}${x.toFixed(1)},${sy(e).toFixed(1)}`;
      pen = true;
    });
    root.append(svg('path', { d: dstr, class: 'ft-line' }));

    // ±3σ markers
    [-3, 3].forEach((k) => {
      const v = T.mu + k * T.sd;
      if (v < T.LO || v > T.LO + T.B * T.W) return;
      const x = Math.round(sx(v)) + 0.5;
      root.append(svg('line', { x1: x, x2: x, y1: m.t, y2: m.t + ph, class: 'ft-sigma' }));
      const t = svg('text', { x: x + (k < 0 ? -5 : 5), y: m.t + 11, class: 'ft-axis', 'text-anchor': k < 0 ? 'end' : 'start' });
      t.textContent = `${k > 0 ? '+' : MIN}3σ`;
      root.append(t);
    });
    host.replaceChildren(root);
  }

  function renderTailStats() {
    const T = TAILS;
    const dl = $('lab-ft-stats');
    dl.replaceChildren();
    const tile = (label, value, sub) => {
      const w = el('div');
      w.append(el('dt', '', label));
      const dd = el('dd');
      dd.append(el('span', '', value));
      dd.append(el('small', '', sub));
      w.append(dd);
      dl.append(w);
    };
    T.beyond.forEach((b) => tile(`Beyond ${b.k}σ (±${nf(1).format(b.k * T.sd)}%)`, `${nf(0).format(b.observed)} days`, `a bell curve predicts ${b.expected < 1 ? nf(2).format(b.expected) : nf(0).format(b.expected)}`));
    tile('Worst day', pct(T.worst.r, 1), day(T.worst.date));
    const b4 = T.beyond[1];
    $('lab-ft-take').textContent = `Daily moves are small — a standard deviation of ${nf(2).format(T.sd)}% — but the extremes are far more common than a bell curve allows. A fall or jump of 4σ (${nf(1).format(4 * T.sd)}%) should turn up about once in ${nf(0).format(T.years / b4.expected)} years. It has happened ${nf(0).format(b4.observed)} times in ${nf(0).format(T.years)}. Risk models that assume normality understate exactly the days that matter.`;
  }

  /* ---------- go ---------- */
  let started = false;
  function start() {
    const H = window.JB && window.JB.history;
    if (started || !H || !H.d || H.d.length < 1000) return;
    started = true;
    const { d, c } = H;
    HOLD = [1, 3, 5, 10, 20].map((y) => holding(d, c, y)).filter((h) => h.windows > 100);
    const eps = drawdowns(d, c);
    TAILS = tails(d, c);
    window.JB.lab = { holding, drawdowns, bestDays, tails, results: { HOLD, eps, TAILS } };

    $('lab-wait').hidden = true;
    grid.hidden = false; // show first: the charts measure their own width
    $('lab-span').textContent = `${nf(0).format(d.length)} trading days since ${year(d[0])}`;
    renderHolding();
    const h1 = HOLD[0], hL = HOLD[HOLD.length - 1];
    const h5 = HOLD.find((h) => h.years === 5), h3 = HOLD.find((h) => h.years === 3);
    $('lab-hold-take').textContent = `Since ${year(d[0])}, ${nf(0).format(h1.lossShare * 100)}% of 1-year windows lost money. Stretch the holding period to ${hL.years} years and ${hL.lossShare === 0 ? 'none ever did' : `only ${nf(0).format(hL.lossShare * 100)}% did`} — the worst ${hL.years}-year stretch still returned ${pct(hL.worst * 100)} a year (it started at the ${month(hL.worstStart)} peak). The median stays near ${nf(0).format(HOLD.find((h) => h.years === 10).median * 100)}% a year throughout; what time buys you is a narrower range of outcomes.`;
    $('lab-hold-foot').textContent = `Every possible start date is a window, so windows overlap heavily and there are far fewer independent observations than the counts suggest${h5 && h3 && h5.lossShare > h3.lossShare ? ` — which is how the 5-year loss rate (${nf(0).format(h5.lossShare * 100)}%) can exceed the 3-year one (${nf(0).format(h3.lossShare * 100)}%)` : ''}. Past outcomes don't guarantee future ones.`;
    renderDrawdowns(null, eps, d[0], d[d.length - 1]);
    buildPeriodSwitch(d, c);
    renderBestDays(d, c);
    renderTails();
    renderTailStats();

    // charts that depend on width
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderTails(); }); }).observe($('lab-ft'));
    let lastNarrow = $('lab-hold').clientWidth < 560;
    new ResizeObserver(() => { const nw = $('lab-hold').clientWidth < 560; if (nw !== lastNarrow) { lastNarrow = nw; renderHolding(); } }).observe($('lab-hold'));
  }
  // computing 50 years of rolling windows is cheap on a laptop but not on a throttled phone: wait until the section is near
  const startWhenNear = () => { const near = window.JB && window.JB.whenNear; const host = document.getElementById('lab'); if (near && host) near(host, start); else start(); };
  if (window.JB && window.JB.history) startWhenNear();
  document.addEventListener('jb:history', startWhenNear, { once: true });
  document.addEventListener('jb:market-error', () => { if (!started) $('lab-wait').textContent = "The risk lab needs the daily market history, which couldn't be loaded right now. The rest of the page works fine without it."; });
})();
