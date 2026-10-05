/* Risk lab — five questions about risk, answered from the daily S&P 500 history in the browser.
   Reads the same series as the chart (market.js publishes it as window.JB.history).
   Price only: no dividends, no inflation adjustment. */
(() => {
  'use strict';
  const grid = document.getElementById('lab-grid');
  if (!grid) return;
  const $ = (id) => document.getElementById(id);
  // i18n (assets/js/i18n.js): t() maps the English text to the page language; LOCALE/PC drive number and date formats
  const t = window.JB?.t || ((s, v) => (v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m)) : s));
  const LANG = window.JB?.lang || 'en';
  const LOCALE = window.JB?.locale || 'en-US';
  const PC = window.JB?.PC || '%';
  if (!window.RiskMath) { // a cached page can pair this script with an older risk-math.js
    const w = $('lab-wait');
    if (w) w.textContent = t('The risk lab could not load its calculations. Try reloading the page.');
    return;
  }
  const DAY = 86_400_000;
  const MIN = '−';

  /* ---------- formatting ---------- */
  const nfc = {};
  const nf = (d) => (nfc[d] ||= new Intl.NumberFormat(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: LANG === 'es' ? 'always' : true }));
  const sgn = (v) => (v > 0 ? '+' : v < 0 ? MIN : '');
  const pct = (v, d = 1) => `${sgn(Number(v.toFixed(d)))}${nf(d).format(Math.abs(v))}${PC}`;
  const plain = (v, d = 0) => `${nf(d).format(v)}${PC}`; // unsigned percentage
  const money = (v) => (LANG === 'es' ? `${nf(0).format(Math.round(v))}\u00a0$` : `$${nf(0).format(Math.round(v))}`);
  const UTC = { timeZone: 'UTC' };
  const fDay = new Intl.DateTimeFormat(LOCALE, { ...UTC, year: 'numeric', month: 'short', day: 'numeric' });
  const fShort = new Intl.DateTimeFormat(LOCALE, { ...UTC, month: 'short', day: 'numeric' });
  const fMonth = new Intl.DateTimeFormat(LOCALE, { ...UTC, year: 'numeric', month: 'short' });
  const fYear = new Intl.DateTimeFormat(LOCALE, { ...UTC, year: 'numeric' });
  const day = (n) => fDay.format(n * DAY);
  const dayShort = (n) => fShort.format(n * DAY);
  const month = (n) => fMonth.format(n * DAY);
  const year = (n) => fYear.format(n * DAY);
  function duration(days) {
    if (days < 60) return days === 1 ? t('1 day') : t('{n} days', { n: days });
    if (days < 730) return t('{n} months', { n: Math.round(days / 30.44) });
    return t('{n} years', { n: nf(1).format(days / 365.25) });
  }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };

  const { percentile, holding, drawdowns, bestDays, tails, seasonality } = window.RiskMath;

  /* ---------- 01 · time in the market ---------- */
  let HOLD = [];
  const yearsLabel = (n) => (n === 1 ? t('1 year') : t('{n} years', { n }));
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
    head.append(el('span'), el('span'), el('span', 'rp-h-loss', t('Lost money')));
    const axis = el('div', 'rp-axis');
    axis.setAttribute('aria-hidden', 'true');
    ticks.forEach((v) => { const s = el('span', '', `${v > 0 ? '+' : v < 0 ? MIN : ''}${Math.abs(v)}${PC}`); s.style.left = at(v); axis.append(s); });
    head.replaceChild(axis, head.children[1]);
    host.append(head);

    const rows = HOLD.map((h) => {
      const row = el('div', 'rp-row');
      row.tabIndex = 0;
      row.dataset.years = h.years;
      row.setAttribute('aria-label', readoutText(h));
      row.append(el('span', 'rp-label', yearsLabel(h.years)));
      const track = el('div', 'rp-track');
      ticks.forEach((v) => { const g = el('i', v === 0 ? 'rp-g zero' : 'rp-g'); g.style.left = at(v); track.append(g); });
      const wh = el('i', 'rp-whisk'); wh.style.left = at(frac(h.worst)); wh.style.width = `${((frac(h.best) - frac(h.worst)) / (hi - lo)) * 100}%`;
      const bx = el('i', 'rp-box'); bx.style.left = at(frac(h.p10)); bx.style.width = `${((frac(h.p90) - frac(h.p10)) / (hi - lo)) * 100}%`;
      const md = el('i', 'rp-med'); md.style.left = at(frac(h.median));
      track.append(wh, bx, md);
      const loss = el('span', 'rp-loss', h.lossShare === 0 ? t('Never') : plain(h.lossShare * 100, h.lossShare < 0.1 ? 1 : 0));
      loss.append(el('small', '', h.lossShare === 0 ? t('in any window') : t('of windows')));
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
    tbl.append(el('caption', '', t('Holding-period outcomes for the S&P 500 (annualized, price only)')));
    const thead = tbl.createTHead().insertRow();
    [t('Holding period'), t('Windows'), t('Lost money'), t('Median a year'), t('10th percentile'), t('90th percentile'), t('Worst a year'), t('Best a year')].forEach((label) => { const th = el('th', '', label); th.scope = 'col'; thead.append(th); });
    const tb = tbl.createTBody();
    HOLD.forEach((h) => {
      const tr = tb.insertRow();
      [yearsLabel(h.years), nf(0).format(h.windows), plain(h.lossShare * 100, 1), pct(h.median * 100), pct(h.p10 * 100), pct(h.p90 * 100), pct(h.worst * 100), pct(h.best * 100)].forEach((cell) => { tr.insertCell().textContent = cell; });
    });
    const clip = el('div', 'sr-only'); // a bare <table> ignores the 1px sizing trick, so clip it in a wrapper
    clip.append(tbl);
    host.append(clip);
  }
  function readoutText(h) {
    return t('{label}: {windows} possible start dates. Median {median} a year; the middle 80% ended between {p10} and {p90} a year. Worst {worst} a year (starting {wd}), best {best} a year (starting {bd}). {loss}', {
      label: yearsLabel(h.years), windows: nf(0).format(h.windows), median: pct(h.median * 100), p10: pct(h.p10 * 100), p90: pct(h.p90 * 100),
      worst: pct(h.worst * 100), wd: day(h.worstStart), best: pct(h.best * 100), bd: day(h.bestStart),
      loss: h.lossShare === 0 ? t('None of these windows lost money.') : t('{p} of them lost money.', { p: plain(h.lossShare * 100, 1) }),
    });
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
      const c4 = tr.insertCell(); c4.textContent = e.recovered ? duration(e.recovered - e.trough) : t('Still recovering');
    });
    const years = (lastDay - firstDay) / 365.25;
    const rec = eps.filter((e) => e.recovered).map((e) => e.recovered - e.trough).sort((a, b) => a - b);
    const med = rec.length ? percentile(Float64Array.from(rec), 0.5) : null;
    const bears = eps.filter((e) => e.depth <= -0.2).length;
    $('lab-dd-take').textContent = [
      t('Since {year} the index has fallen 10% or more from a peak {n} times — about once every {every} years — and {bears} of those became bear markets (−20% or worse).', { year: year(firstDay), n: eps.length, every: nf(1).format(years / eps.length), bears }),
      med != null ? t('The typical decline took {d} to recover from the low.', { d: duration(Math.round(med)) }) : '',
    ].join(' ');
  }

  /* ---------- 03 · missing the best days ---------- */
  const PERIODS = [{ id: '10', label: t('10Y'), years: 10 }, { id: '20', label: t('20Y'), years: 20 }, { id: '30', label: t('30Y'), years: 30 }, { id: 'all', label: t('All'), years: null }];
  let bdPeriod = '20';
  function renderBestDays(d, c) {
    const P = PERIODS.find((p) => p.id === bdPeriod);
    const R = bestDays(d, c, P.years);
    const full = R.values[0].v;
    const list = $('lab-bd');
    list.replaceChildren();
    R.values.forEach((row) => {
      const li = el('li', row.N === 0 ? 'full' : '');
      li.append(el('span', 'bd-name', row.N === 0 ? t('Fully invested') : t('Missed the {n} best days', { n: row.N })));
      const tr = el('span', 'bd-track');
      const f = el('i', 'bd-fill'); f.style.width = `${(row.v / full) * 100}%`;
      tr.append(f);
      const val = el('span', 'bd-val', money(row.v));
      if (row.N) val.append(el('small', '', pct((row.v / full - 1) * 100, 0)));
      li.append(tr, val);
      list.append(li);
    });
    const v10 = R.values.find((x) => x.N === 10).v;
    $('lab-bd-take').textContent = t("Over the {period}, {start} grew to {full}. Sit out just the 10 best days and it ends at {v10} — {delta}. {k} of those 10 best days landed within 15 trading days of one of the 10 worst, which is why you can't dodge the bad days and keep the good ones.", {
      period: P.years ? t('last {n} years', { n: P.years }) : t('whole period since {year}', { year: year(R.start) }),
      start: money(10000), full: money(full), v10: money(v10), delta: pct((v10 / full - 1) * 100, 0), k: R.clustered,
    });
    $('lab-bd-foot').textContent = t('{n} trading days from {date}; price index only, so dividends are excluded and every figure is lower than a total-return version would be.', { n: nf(0).format(R.days), date: day(R.start) });
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
      t.textContent = `${v > 0 ? '+' : v < 0 ? MIN : ''}${Math.abs(v)}${PC}`;
      root.append(t);
    });
    const yl = svg('text', { x: 0, y: 11, class: 'ft-axis' });
    yl.textContent = t('days (log scale)');
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
      const range = b === 0 ? t('{a} or lower', { a: pct(lo + T.W, 1).replace('+', '') }) : b === T.B - 1 ? t('{a} or higher', { a: pct(lo, 1) }) : t('{a} to {b}', { a: pct(lo, 1), b: pct(lo + T.W, 1) });
      const label = t('{range}: {n} days (a bell curve predicts {x})', { range, n: nf(0).format(cnt), x: nf(cnt < 20 ? 1 : 0).format(T.expected[b]) });
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
    T.beyond.forEach((b) => tile(t('Beyond {k}σ (±{pct})', { k: b.k, pct: plain(b.k * T.sd, 1) }), t('{n} days', { n: nf(0).format(b.observed) }), t('a bell curve predicts {x}', { x: b.expected < 1 ? nf(2).format(b.expected) : nf(0).format(b.expected) })));
    tile(t('Worst day'), pct(T.worst.r, 1), day(T.worst.date));
    const b4 = T.beyond[1];
    $('lab-ft-take').textContent = t('Daily moves are small — a standard deviation of {sd} — but the extremes are far more common than a bell curve allows. A fall or jump of 4σ ({s4}) should turn up about once in {every} years. It has happened {n} times in {years} years. Risk models that assume normality understate exactly the days that matter.', {
      sd: plain(T.sd, 2), s4: plain(4 * T.sd, 1), every: nf(0).format(T.years / b4.expected), n: nf(0).format(b4.observed), years: nf(0).format(T.years),
    });
  }

  /* ---------- 05 · seasonality ---------- */
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const monthNames = (style) => Array.from({ length: 12 }, (_, m) => new Intl.DateTimeFormat(LOCALE, { ...UTC, month: style }).format(Date.UTC(2001, m, 15)));
  const MON = monthNames('short').map(cap).map((x) => x.replace(/\.$/, '')); // Jan … Dec / Ene … Dic
  const MONTH = monthNames('long').map((x) => (LANG === 'es' ? x : cap(x))); // Spanish month names stay lower-case inside a sentence
  const EDGES = [-6, -3, -1, 0, 1, 3, 6]; // colour steps in %; four per side, so 0 sits between the two palest
  const bin = (r) => { const v = r * 100; let b = 0; while (b < EDGES.length && v >= EDGES[b]) b++; return b; };
  let SEAS = null;
  let sel = null; // { i: row, m: month }
  let hm = null;  // geometry + overlay nodes of the rendered heat map
  let seDays = null; // last trading day in the data, for the "to date" wording

  function seasonRead(e) {
    const mo = SEAS.months[e.m];
    const read = $('lab-se-read');
    read.replaceChildren();
    read.append(el('strong', '', `${MON[e.m]} ${e.y}: ${pct(e.r * 100, 1)}`));
    let note = '';
    if (e === SEAS.worst) note = t('The worst month in the data.') + ' ';
    else if (e === SEAS.bestM) note = t('The best month in the data.') + ' ';
    if (e.partial) note += t('This month is still in progress (to {date}), so it is faded and left out of the averages.', { date: dayShort(seDays) }) + ' ';
    else note += t('The average {month} since {y0} is {mean}; {p} of them were up.', { month: MONTH[e.m], y0: SEAS.y0, mean: pct(mo.mean * 100, 1), p: plain(mo.up * 100) }) + ' ';
    read.append(' ', el('span', '', note.trim()));
  }
  function seasonSelect(i, m) {
    const e = SEAS.grid[i] && SEAS.grid[i][m];
    if (!e || !hm) return;
    sel = { i, m };
    hm.sel.setAttribute('x', hm.ml + m * hm.cw + 0.5);
    hm.sel.setAttribute('y', hm.mt + i * hm.ch + 0.5);
    hm.sel.setAttribute('width', hm.cw - 1);
    hm.sel.setAttribute('height', hm.ch - 1);
    hm.sel.style.display = '';
    seasonRead(e);
  }
  function renderSeasonHeat() {
    const host = $('lab-se-hm');
    const rows = SEAS.grid.length;
    const W = Math.max(260, Math.round(host.clientWidth));
    const ml = 32, mt = 17, gap = 1.5;
    const cw = (W - ml) / 12;
    const ch = W < 420 ? 11.5 : 13.5;
    const H = Math.ceil(mt + rows * ch);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
    for (let m = 0; m < 12; m++) {
      const t = svg('text', { x: ml + (m + 0.5) * cw, y: 11, class: 'hm-axis', 'text-anchor': 'middle' });
      t.textContent = W < 380 ? MON[m][0] : MON[m];
      root.append(t);
    }
    SEAS.grid.forEach((row, i) => {
      const yr = SEAS.y0 + i;
      if (yr % 5 === 0) {
        const t = svg('text', { x: ml - 7, y: mt + (i + 0.5) * ch + 3.5, class: 'hm-axis', 'text-anchor': 'end' });
        t.textContent = yr;
        root.append(t);
      }
      row.forEach((e, m) => {
        if (!e) return;
        root.append(svg('rect', { x: (ml + m * cw + gap / 2).toFixed(2), y: (mt + i * ch + gap / 2).toFixed(2), width: (cw - gap).toFixed(2), height: (ch - gap).toFixed(2), rx: 2, class: `hm hm${bin(e.r)}${e.partial ? ' part' : ''}` }));
      });
    });
    const col = svg('rect', { class: 'hm-col', x: 0, y: mt - 1, width: cw, height: rows * ch + 1, rx: 3 });
    col.style.display = 'none';
    const selR = svg('rect', { class: 'hm-sel', rx: 3 });
    selR.style.display = 'none';
    root.append(col, selR);
    host.replaceChildren(root);
    hm = { W, ml, mt, cw, ch, rows, sel: selR, col };
    if (sel) seasonSelect(sel.i, sel.m);
  }
  function wireSeasonHeat() {
    const host = $('lab-se-hm');
    const at = (e) => {
      const r = host.getBoundingClientRect();
      const x = (e.clientX - r.left) * (hm.W / r.width);
      const y = (e.clientY - r.top) * (hm.W / r.width);
      const m = Math.floor((x - hm.ml) / hm.cw), i = Math.floor((y - hm.mt) / hm.ch);
      return m >= 0 && m < 12 && i >= 0 && i < hm.rows ? { i, m } : null;
    };
    const go = (e) => { const c = at(e); if (c && SEAS.grid[c.i][c.m]) seasonSelect(c.i, c.m); };
    host.addEventListener('pointermove', go);
    host.addEventListener('pointerdown', go);
    host.addEventListener('keydown', (e) => {
      // left/right walk through time (December wraps to the next January); up/down stay in the same month
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 }[e.key];
      const flat = (k) => (k >= 0 && k < SEAS.grid.length * 12 ? SEAS.grid[Math.floor(k / 12)][k % 12] : null);
      if (step == null && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const cur = sel ? sel.i * 12 + sel.m : 0;
      let k = cur + (step || 0);
      if (e.key === 'Home') { k = 0; while (k < SEAS.grid.length * 12 && !flat(k)) k++; }
      if (e.key === 'End') { k = SEAS.grid.length * 12 - 1; while (k > 0 && !flat(k)) k--; }
      if (flat(k)) seasonSelect(Math.floor(k / 12), k % 12);
    });
    host.addEventListener('focus', () => { if (!sel) seasonSelect(SEAS.worst.i, SEAS.worst.m); });
  }
  function renderSeasonMonths() {
    const S = SEAS;
    const list = $('lab-se-months');
    list.replaceChildren();
    const a = Math.floor(Math.min(0, ...S.months.map((x) => x.lo)) * 100), b = Math.ceil(Math.max(...S.months.map((x) => x.hi)) * 100);
    const p = (v) => `${((v * 100 - a) / (b - a)) * 100}%`;
    S.months.forEach((x) => {
      const li = el('li', 'se-row');
      li.dataset.m = x.m;
      const sr = el('span', 'sr-only', t('{month}: average {mean}, 95% range {lo} to {hi}. Up in {p} of {n} years. Best {best} ({by}), worst {worst} ({wy}).', {
        month: cap(MONTH[x.m]), mean: pct(x.mean * 100, 1), lo: pct(x.lo * 100, 1), hi: pct(x.hi * 100, 1), p: plain(x.up * 100), n: x.n,
        best: pct(x.best.r * 100, 1), by: x.best.y, worst: pct(x.worst.r * 100, 1), wy: x.worst.y,
      }));
      const name = el('span', 'se-m', MON[x.m]);
      const tr = el('div', 'se-track');
      const z = el('i', 'se-zero'); z.style.left = p(0);
      const av = el('i', 'se-avg'); av.style.left = p(S.all.mean);
      const bar = el('i', `se-bar ${x.mean >= 0 ? 'pos' : 'neg'}`);
      bar.style.left = p(Math.min(0, x.mean)); bar.style.width = `${(Math.abs(x.mean) * 100 / (b - a)) * 100}%`;
      const ci = el('i', 'se-ci'); ci.style.left = p(x.lo); ci.style.width = `${((x.hi - x.lo) * 100 / (b - a)) * 100}%`;
      tr.append(z, av, bar, ci);
      const val = el('span', 'se-val', pct(x.mean * 100, 1));
      const up = el('span', 'se-up', plain(x.up * 100));
      [name, tr, val, up].forEach((n) => n.setAttribute('aria-hidden', 'true'));
      li.append(sr, name, tr, val, up);
      li.addEventListener('pointerenter', () => { if (!hm) return; hm.col.setAttribute('x', hm.ml + x.m * hm.cw); hm.col.style.display = ''; li.classList.add('is-on'); });
      li.addEventListener('pointerleave', () => { if (hm) hm.col.style.display = 'none'; li.classList.remove('is-on'); });
      list.append(li);
    });
  }
  function renderSeasonExtremes() {
    const host = $('lab-se-ext');
    host.replaceChildren();
    const done = SEAS.monthly.filter((e) => !e.partial);
    const mk = (title, rows) => {
      const box = el('div');
      box.append(el('p', 'label', title));
      const ol = el('ol');
      rows.forEach((e) => {
        const li = el('li');
        const sw = el('i'); sw.style.background = `var(--dv${bin(e.r)})`; sw.setAttribute('aria-hidden', 'true');
        const t = el('time', '', `${MON[e.m]} ${e.y}`);
        li.append(sw, t, el('b', '', pct(e.r * 100, 1)));
        li.addEventListener('pointerenter', () => seasonSelect(e.y - SEAS.y0, e.m));
        ol.append(li);
      });
      box.append(ol);
      host.append(box);
    };
    mk(t('Five worst months'), done.slice().sort((a, b) => a.r - b.r).slice(0, 5));
    mk(t('Five best months'), done.slice().sort((a, b) => b.r - a.r).slice(0, 5));
  }
  function renderSeasonScale() {
    const host = $('lab-se-scale');
    host.replaceChildren();
    for (let k = 0; k < 8; k++) { const i = el('i'); i.style.background = `var(--dv${k})`; host.append(i); }
    EDGES.forEach((v, k) => { const tick = el('span', '', v === 0 ? `0${PC}` : `${v > 0 ? '+' : MIN}${Math.abs(v)}${PC}`); tick.style.left = `${((k + 1) / 8) * 100}%`; host.append(tick); });
    host.append(el('span', 'se-cap', t('Monthly return')));
  }
  function renderSeasonTables() {
    // table twin for assistive tech: every month of every year
    const S = SEAS;
    const tbl = el('table');
    tbl.append(el('caption', '', t('S&P 500 monthly price returns by year and month')));
    const head = tbl.createTHead().insertRow();
    [t('Year'), ...MON].forEach((label) => { const th = el('th', '', label); th.scope = 'col'; head.append(th); });
    const tb = tbl.createTBody();
    S.grid.forEach((row, i) => {
      const tr = tb.insertRow();
      const th = el('th', '', String(S.y0 + i)); th.scope = 'row'; tr.append(th);
      row.forEach((e) => { tr.insertCell().textContent = e ? pct(e.r * 100, 1) + (e.partial ? t(' (month to date)') : '') : '—'; });
    });
    const clip = el('div', 'sr-only');
    clip.append(tbl);
    $('lab-se-months').after(clip);
  }
  function startSeasonality(d, c) {
    SEAS = seasonality(d, c);
    seDays = d[d.length - 1];
    let w = null, b = null;
    SEAS.grid.forEach((row, i) => row.forEach((e, m) => { if (!e || e.partial) return; e.i = i; if (!w || e.r < w.r) w = e; if (!b || e.r > b.r) b = e; }));
    SEAS.worst = w; SEAS.bestM = b;
    SEAS.last.i = SEAS.grid.length - 1;
    const S = SEAS;
    const byMean = S.months.slice().sort((x, y) => y.mean - x.mean);
    const hi = byMean[0], lo = byMean[11];
    const moe = (S.months.reduce((a, x) => a + 1.96 * x.se, 0) / 12) * 100;
    const up = (x) => plain(x.up * 100);
    const edge = S.exceed === 0 ? t('No month sits more than two standard errors from the all-month average, and with twelve months to choose from, about one would do that by luck alone.')
      : S.exceed === 1 ? t('Only one month sits more than two standard errors from the all-month average, and with twelve months to choose from, about one would do that by luck alone.')
      : t('Only {n} of the 12 months sit more than two standard errors from the all-month average, and with twelve months to choose from, about one would do that by luck alone.', { n: S.exceed });
    $('lab-se-take').textContent = `${t('Since {y0}, the average month has returned {mean} and {up} of months were up. Calendar months do differ — {hi} has averaged {himean} (up in {hiup} of years) and {lo} {lomean} (up in {loup}). But each month has only about {n} observations, so each average carries a margin of error of roughly ±{moe} points.', {
      y0: S.y0, mean: pct(S.all.mean * 100, 2), up: plain(S.all.up * 100), hi: MONTH[hi.m], himean: pct(hi.mean * 100, 1), hiup: up(hi), lo: MONTH[lo.m], lomean: pct(lo.mean * 100, 1), loup: up(lo), n: S.months[0].n, moe: nf(1).format(moe),
    })} ${edge}`;
    const first = S.grid[0].findIndex((e) => e);
    const extra = first > 0 ? t('; {y0} starts in {mon} because the data begins on {date}', { y0: S.y0, mon: MON[first], date: day(d[0]) }) : '';
    $('lab-se-foot').textContent = t("Month-end to month-end closes, price only. {mon} {y} (to {to}) is shown faded and left out of the averages{extra}. Bars show each month's average, the thin line its 95% range (±1.96 standard errors), and the dashed tick the average of all months. A seasonal pattern that held in the past is not a forecast.", { mon: MON[S.last.m], y: S.last.y, to: dayShort(seDays), extra });
    renderSeasonScale();
    renderSeasonMonths();
    renderSeasonHeat();
    renderSeasonExtremes();
    wireSeasonHeat();
    renderSeasonTables();
    seasonSelect(S.worst.i, S.worst.m);
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
    window.JB.lab = { holding, drawdowns, bestDays, tails, seasonality, results: { HOLD, eps, TAILS } };

    $('lab-wait').hidden = true;
    grid.hidden = false; // show first: the charts measure their own width
    $('lab-span').textContent = t('{n} trading days since {year}', { n: nf(0).format(d.length), year: year(d[0]) });
    renderHolding();
    const h1 = HOLD[0], hL = HOLD[HOLD.length - 1];
    const h5 = HOLD.find((h) => h.years === 5), h3 = HOLD.find((h) => h.years === 3);
    $('lab-hold-take').textContent = t('Since {year}, {p1} of 1-year windows lost money. Stretch the holding period to {years} years and {tail} — the worst {years}-year stretch still returned {worst} a year (it started at the {peak} peak). The median stays near {med} a year throughout; what time buys you is a narrower range of outcomes.', {
      year: year(d[0]), p1: plain(h1.lossShare * 100), years: hL.years, tail: hL.lossShare === 0 ? t('none ever did') : t('only {p} did', { p: plain(hL.lossShare * 100) }),
      worst: pct(hL.worst * 100), peak: month(hL.worstStart), med: plain(HOLD.find((h) => h.years === 10).median * 100),
    });
    const overlap = h5 && h3 && h5.lossShare > h3.lossShare ? t(' — which is how the 5-year loss rate ({p5}) can exceed the 3-year one ({p3})', { p5: plain(h5.lossShare * 100), p3: plain(h3.lossShare * 100) }) : '';
    $('lab-hold-foot').textContent = t("Every possible start date is a window, so windows overlap heavily and there are far fewer independent observations than the counts suggest{extra}. Past outcomes don't guarantee future ones.", { extra: overlap });
    renderDrawdowns(null, eps, d[0], d[d.length - 1]);
    buildPeriodSwitch(d, c);
    renderBestDays(d, c);
    renderTails();
    renderTailStats();
    startSeasonality(d, c);
    window.JB.lab.results.SEAS = SEAS;

    // charts that depend on width
    let raf = 0;
    new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { renderTails(); }); }).observe($('lab-ft'));
    let hmW = $('lab-se-hm').clientWidth;
    new ResizeObserver(() => { const w = $('lab-se-hm').clientWidth; if (w && Math.abs(w - hmW) > 1) { hmW = w; renderSeasonHeat(); } }).observe($('lab-se-hm'));
    let lastNarrow = $('lab-hold').clientWidth < 560;
    new ResizeObserver(() => { const nw = $('lab-hold').clientWidth < 560; if (nw !== lastNarrow) { lastNarrow = nw; renderHolding(); } }).observe($('lab-hold'));
  }
  // computing 50 years of rolling windows is cheap on a laptop but not on a throttled phone: wait until the section is near
  const startWhenNear = () => { const near = window.JB && window.JB.whenNear; const host = document.getElementById('lab'); if (near && host) near(host, start); else start(); };
  if (window.JB && window.JB.history) startWhenNear();
  document.addEventListener('jb:history', startWhenNear, { once: true });
  document.addEventListener('jb:market-error', () => { if (!started) $('lab-wait').textContent = t("The risk lab needs the daily market history, which couldn't be loaded right now. The rest of the page works fine without it."); });
})();
