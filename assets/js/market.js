/* S&P 500 live chart — hand-written canvas, no libraries.
   Data comes from the `data` branch of this repo (see scripts/market-data.mjs and
   .github/workflows/market-data.yml). Nothing here ever invents a number: if the data
   can't be loaded the section says so. */
(() => {
  'use strict';
  const root = document.getElementById('mk');
  if (!root) return;

  const $ = (s, r = document) => r.querySelector(s);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const BASE = (document.querySelector('meta[name="market-data-base"]')?.content || '').replace(/\/?$/, '/');
  const DAY = 86_400_000;
  const MIN = '−'; // U+2212, a real minus sign

  /* ---------- colours (the section is always dark) ---------- */
  const C = {
    line: '#efe9dd',
    grid: 'rgba(255,255,255,.075)',
    axis: '#8f9084',
    text: '#b5aea1',
    surface: '#0e1511',
    cross: 'rgba(239,233,221,.45)',
    ref: 'rgba(239,233,221,.28)',
    up: '#5fd0a0',
    down: '#f08a6b',
    s1: '#3987e5', // compare mode: categorical slots 1 and 2, validated for this surface
    s2: '#d95926',
  };
  const MONO = '500 11px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
  const SANS = '600 12px Inter, system-ui, sans-serif';

  /* ---------- formatting ---------- */
  const nfCache = {};
  const nf = (d) => (nfCache[d] ||= new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const sign = (v) => (v > 0 ? '+' : v < 0 ? MIN : '');
  const fmtPrice = (v) => nf(2).format(v);
  const fmtPct = (v, d = 1) => `${sign(Math.round(v * 10 ** d) ? v : 0)}${nf(d).format(Math.abs(v))}%`;
  const fmtDelta = (v, d = 2) => `${sign(v)}${nf(d).format(Math.abs(v))}`;
  const fmtAxisPrice = (v) => (Number.isInteger(v) || Math.abs(v) >= 100 ? nf(0).format(v) : nf(2).format(v));
  const fmtUsd = (v) => `$${nf(0).format(Math.round(v))}`;
  const UTC = { timeZone: 'UTC' };
  const NY = { timeZone: 'America/New_York' };
  const F = {
    dayLong: new Intl.DateTimeFormat('en-US', { ...UTC, year: 'numeric', month: 'short', day: 'numeric' }),
    dayShort: new Intl.DateTimeFormat('en-US', { ...UTC, month: 'short', day: 'numeric' }),
    month: new Intl.DateTimeFormat('en-US', { ...UTC, month: 'short' }),
    monthYear: new Intl.DateTimeFormat('en-US', { ...UTC, month: 'short', year: 'numeric' }),
    year: new Intl.DateTimeFormat('en-US', { ...UTC, year: 'numeric' }),
    etTime: new Intl.DateTimeFormat('en-US', { ...NY, hour: 'numeric', minute: '2-digit' }),
    etHour: new Intl.DateTimeFormat('en-US', { ...NY, hour: 'numeric' }),
    etDay: new Intl.DateTimeFormat('en-US', { ...NY, weekday: 'short' }),
    etStamp: new Intl.DateTimeFormat('en-US', { ...NY, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    etParts: new Intl.DateTimeFormat('en-US', { ...NY, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }),
  };
  const nyParts = (ms) => Object.fromEntries(F.etParts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  const nyDayNumber = (ms) => { const p = nyParts(ms); return Math.floor(Date.UTC(+p.year, +p.month - 1, +p.day) / DAY); };

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }

  /* ---------- state ---------- */
  const E = {
    price: $('#mk-price'), delta: $('#mk-delta'), asof: $('#mk-asof'), state: $('#mk-state'),
    ranges: $('#mk-ranges'), modes: $('#mk-modes'), logBtn: $('#mk-log'), tableBtn: $('#mk-table-btn'),
    tableWrap: $('#mk-table-wrap'), table: $('#mk-table'), chart: $('#mk-chart'), canvas: $('#mk-canvas'),
    tip: $('#mk-tip'), overlay: $('#mk-overlay'), overlayMsg: $('#mk-overlay-msg'), retry: $('#mk-retry'),
    live: $('#mk-live'), stats: $('#mk-stats'),
    calc: $('#calc'), amount: $('#calc-amount'), year: $('#calc-year'), cres: $('#calc-result'), ccanvas: $('#calc-canvas'),
    ticker: $('#ticker'), track: $('#ticker-track'), mini: $('#mini-market'),
    asset: $('#mk-asset'), cmpBtn: $('#mk-cmp-btn'), cmpWrap: $('#mk-cmp-wrap'), cmpSel: $('#mk-cmp'), legend: $('#mk-legend'),
  };
  const ctx = E.canvas.getContext('2d');
  const S = {
    live: null, hist: null, sess: null,
    sym: 'spx', cmp: null, hists: {}, prevMode: 'price', prevLog: false,
    range: '1Y', mode: 'price', log: false,
    view: null, hover: -1, progress: 1, anim: 0, dpr: 1, w: 0, h: 0, geo: null,
  };

  /* ---------- loading ---------- */
  async function fetchJSON(name) {
    const res = await fetch(`${BASE}${name}?t=${Math.floor(Date.now() / 300_000)}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    return res.json();
  }
  const validHist = (h) => h && Array.isArray(h.d) && Array.isArray(h.c) && h.d.length === h.c.length && h.d.length > 50;
  const validLive = (l) => l && Array.isArray(l.quotes);

  async function load(first) {
    if (first) setState('loading');
    const [live, hist, sess] = await Promise.allSettled([fetchJSON('live.json'), fetchJSON('history.json'), fetchJSON('sessions.json')]);
    if (live.status === 'fulfilled' && validLive(live.value)) S.live = live.value;
    if (hist.status === 'fulfilled' && validHist(hist.value)) prepareHistory(hist.value);
    if (sess.status === 'fulfilled' && sess.value?.sessions) S.sess = sess.value;
    if (!S.live && !S.hist) { setState('error'); document.dispatchEvent(new CustomEvent('jb:market-error')); return; }
    if (!S.histRaw) document.dispatchEvent(new CustomEvent('jb:market-error')); // the risk lab needs the daily history
    S.synthetic = Boolean(S.live?.synthetic || S.hist?.synthetic);
    applyLive();
    buildAssets();
    if (first) { buildRanges(); initCalc(); }
    setState('ready');
    redraw(true);
  }

  /** Typed arrays for speed, plus today's live price appended when the nightly history lags behind. */
  function prepareHistory(h) {
    const d = Array.from(h.d);
    const c = Array.from(h.c);
    S.hist = h;
    S.histRaw = { d, c };
    S.hists.spx = S.histRaw;
    window.JB = window.JB || {};
    window.JB.history = { d, c }; // the risk lab (lab.js) reads the same series
    document.dispatchEvent(new CustomEvent('jb:history'));
  }
  /** Daily series for an asset as typed arrays, with today's live price appended when the nightly history lags. */
  function histArrays(id = S.sym) {
    const raw = S.hists[id];
    if (!raw) return null;
    const { d, c } = raw;
    const q = quote(id);
    let dd = d, cc = c;
    if (q && q.time) {
      const qDay = nyDayNumber(q.time * 1000);
      if (qDay > d[d.length - 1]) { dd = d.concat(qDay); cc = c.concat(q.price); }
      else if (qDay === d[d.length - 1]) { cc = c.slice(0, -1).concat(q.price); dd = d; }
    }
    const xs = new Float64Array(dd.length);
    const ys = new Float64Array(dd.length);
    for (let i = 0; i < dd.length; i++) { xs[i] = dd[i] * DAY; ys[i] = cc[i]; }
    return { d: dd, xs, ys };
  }
  const quote = (id) => S.live?.quotes?.find((q) => q.id === id) || null;
  const spxQuote = () => quote('spx');
  const symName = (id) => quote(id)?.name || (id === 'spx' ? 'S&P 500' : id);
  const symDigits = (id) => quote(id)?.digits ?? 2;
  const fmtSym = (id, v) => nf(symDigits(id)).format(v);

  /** The S&P 500 history ships with the page data; every other asset is fetched the first time it is picked. */
  async function ensureHist(id) {
    if (S.hists[id]) return true;
    try {
      const h = await fetchJSON(`hist-${id}.json`);
      if (!validHist(h)) return false;
      S.hists[id] = { d: Array.from(h.d), c: Array.from(h.c) };
      return true;
    } catch (e) { return false; }
  }

  function setState(st) {
    root.dataset.state = st;
    E.overlay.hidden = st === 'ready';
    E.retry.hidden = st !== 'error';
    if (st === 'loading') E.overlayMsg.textContent = 'Loading the latest prices…';
    if (st === 'error') E.overlayMsg.textContent = "Couldn't load market data right now. The page works fine without it.";
  }
  E.retry.addEventListener('click', () => load(true));

  /* ---------- header, hero widget, ticker ---------- */
  function isOpenNow(q) {
    if (!q) return false;
    const p = nyParts(Date.now());
    const mins = +p.hour * 60 + +p.minute;
    const weekday = !['Sat', 'Sun'].includes(p.weekday);
    return weekday && mins >= 570 && mins < 960 && Date.now() / 1000 - q.time < 25 * 60;
  }

  function applyLive() {
    const q = quote(S.sym);
    const hist = S.hists[S.sym];
    let price = q?.price;
    let change = q?.change;
    let pct = q?.pct;
    let when = q ? q.time * 1000 : null;
    if (price == null && hist) { // no live quote: fall back to the last daily close
      const n = hist.c.length;
      price = hist.c[n - 1];
      change = price - hist.c[n - 2];
      pct = (change / hist.c[n - 2]) * 100;
      when = hist.d[n - 1] * DAY;
    }
    if (price == null) return;
    E.price.textContent = fmtSym(S.sym, price);
    const open = isOpenNow(q);
    const dir = change > 0 ? 'up' : change < 0 ? 'down' : '';
    E.delta.replaceChildren();
    const main = document.createElement('span');
    main.className = dir;
    main.textContent = `${change > 0 ? '▲' : change < 0 ? '▼' : '•'} ${fmtDelta(change, symDigits(S.sym))} (${fmtPct(pct, 2)})`;
    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = open ? 'today' : 'last session';
    E.delta.append(main, lbl);

    E.state.hidden = false;
    E.state.classList.toggle('open', open);
    E.state.textContent = S.synthetic ? 'Sample data' : open ? 'Market open' : 'Market closed';

    const parts = [];
    parts.push(q ? `${F.etStamp.format(when)} ET` : `Close of ${F.dayLong.format(when)}`);
    parts.push(q ? 'delayed ~15 min' : 'end-of-day data');
    if (S.live?.generated) parts.push(`refreshed ${ago(Date.parse(S.live.generated))}`);
    if (S.synthetic) parts.push('SAMPLE DATA — not real prices');
    const ageDays = (Date.now() - when) / DAY;
    if (!S.synthetic && !open && ageDays > 4) parts.push(`⚠ last data is ${Math.round(ageDays)} days old`);
    E.asof.textContent = parts.join(' · ');

    renderMini(spxQuote());
    renderTicker();
  }

  const dirClass = (q) => (q.change > 0 ? (q.invert ? 'down' : 'up') : q.change < 0 ? (q.invert ? 'up' : 'down') : '');
  const dirColor = (cls) => (cls === 'up' ? C.up : cls === 'down' ? C.down : C.axis);

  function sparkSvg(values, w, h, color) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('aria-hidden', 'true');
    if (!values || values.length < 2) return svg;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * (w - 2) + 1).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', `M${pts.join('L')}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
    return svg;
  }
  const sparkWithPrice = (q) => {
    const s = (q.spark || []).slice();
    if (s.length && Math.abs(s[s.length - 1] - q.price) > 1e-9) s.push(q.price); // history can lag a day behind the quote
    return s;
  };

  function renderMini(q) {
    if (!E.mini || !q) return;
    const cls = dirClass(q);
    $('[data-mm-price]', E.mini).textContent = fmtPrice(q.price);
    const d = $('[data-mm-delta]', E.mini);
    d.textContent = `${q.change > 0 ? '▲' : q.change < 0 ? '▼' : '•'} ${fmtPct(q.pct, 2)}`;
    d.className = `mm-delta ${cls}`;
    const old = $('[data-mm-spark]', E.mini);
    const fresh = sparkSvg(sparkWithPrice(q), 120, 32, dirColor(cls));
    fresh.setAttribute('class', 'mm-spark');
    fresh.setAttribute('data-mm-spark', '');
    fresh.setAttribute('preserveAspectRatio', 'none');
    old.replaceWith(fresh);
    E.mini.hidden = false;
  }

  function renderTicker() {
    const qs = (S.live?.quotes || []).filter((q) => Number.isFinite(q.price));
    if (!E.ticker || !qs.length) return;
    const frag = () => {
      const f = document.createDocumentFragment();
      qs.forEach((q) => {
        const cls = dirClass(q);
        const item = document.createElement('span');
        item.className = 'tk';
        const name = document.createElement('span');
        name.className = 'tk-name';
        name.textContent = q.name;
        const price = document.createElement('span');
        price.className = 'tk-price';
        price.textContent = nf(q.digits ?? 2).format(q.price);
        const chg = document.createElement('span');
        chg.className = `tk-chg ${cls}`;
        chg.textContent = `${q.change > 0 ? '▲' : q.change < 0 ? '▼' : '•'} ${fmtPct(q.pct, 2)}`;
        item.append(name, price, chg);
        if (q.spark && q.spark.length > 1) item.append(sparkSvg(sparkWithPrice(q), 52, 16, dirColor(cls)));
        f.append(item);
      });
      return f;
    };
    E.track.replaceChildren(frag());
    const clone = frag();
    clone.childNodes.forEach((n) => n.setAttribute('aria-hidden', 'true'));
    E.track.append(clone);
    E.ticker.hidden = false;
    if (reduced) E.ticker.tabIndex = 0; // reduced motion = a plain scrollable strip, so make it keyboard-reachable
    requestAnimationFrame(() => E.track.style.setProperty('--dur', `${Math.max(30, E.track.scrollWidth / 2 / 55)}s`));
  }

  /* ---------- ranges ---------- */
  const RANGE_DEFS = [
    { id: '1D', need: 'intraday' }, { id: '5D', need: 'week' },
    { id: '1M', m: 1 }, { id: '6M', m: 6 }, { id: 'YTD' }, { id: '1Y', m: 12 }, { id: '5Y', m: 60 }, { id: 'MAX', label: 'MAX' },
  ];
  const sessionDates = () => Object.keys(S.sess?.sessions || {}).sort();
  const available = (r) => {
    const spxOnly = S.sym === 'spx' && !S.cmp; // intraday data exists for the S&P 500 only
    if (r.need === 'intraday') return spxOnly && Boolean(S.live?.spx?.intraday?.t?.length > 10 && S.live?.spx?.session);
    if (r.need === 'week') return spxOnly && sessionDates().length >= 2;
    return Boolean(S.hists[S.sym]) && (!S.cmp || Boolean(S.hists[S.cmp]));
  };

  function buildRanges() {
    E.ranges.replaceChildren();
    const defs = RANGE_DEFS.filter(available);
    if (!defs.some((r) => r.id === S.range)) S.range = defs.some((r) => r.id === '1Y') ? '1Y' : defs[defs.length - 1]?.id;
    defs.forEach((r) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.range = r.id;
      b.textContent = r.label || r.id;
      E.ranges.append(b);
    });
    syncRadios(E.ranges, 'range', S.range);
  }

  function syncRadios(container, attr, value) {
    container.querySelectorAll('button').forEach((b) => {
      const on = b.dataset[attr] === value;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    });
  }
  function radioGroup(container, attr, set) {
    container.addEventListener('click', (e) => {
      const b = e.target.closest('button[role=radio]');
      if (b) set(b.dataset[attr]);
    });
    container.addEventListener('keydown', (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      const btns = [...container.querySelectorAll('button[role=radio]')];
      const i = btns.findIndex((b) => b.getAttribute('aria-checked') === 'true');
      const nxt = btns[(i + keys[e.key] + btns.length) % btns.length];
      e.preventDefault();
      nxt.focus();
      set(nxt.dataset[attr]);
    });
  }
  radioGroup(E.ranges, 'range', (id) => { S.range = id; syncRadios(E.ranges, 'range', id); redraw(true); });
  radioGroup(E.modes, 'mode', (id) => { if (S.cmp) return; S.mode = id; syncRadios(E.modes, 'mode', id); syncLogBtn(); redraw(true); });
  E.logBtn.addEventListener('click', () => { if (S.mode !== 'price' || S.cmp) return; S.log = !S.log; syncLogBtn(); redraw(true); });
  E.tableBtn.addEventListener('click', () => {
    const on = E.tableBtn.getAttribute('aria-pressed') !== 'true';
    E.tableBtn.setAttribute('aria-pressed', String(on));
    E.tableWrap.hidden = !on;
    if (on) renderTable();
  });
  function syncLogBtn() {
    const ok = S.mode === 'price' && !S.cmp;
    E.logBtn.setAttribute('aria-pressed', String(ok && S.log));
    E.logBtn.disabled = !ok;
    E.logBtn.style.opacity = ok ? '' : '.4';
  }
  syncLogBtn();

  /* ---------- asset switcher + compare ---------- */
  const histIds = () => (Array.isArray(S.live?.histories) && S.live.histories.length ? S.live.histories : ['spx']);
  function buildAssets() {
    const ids = histIds();
    const fill = (sel, list, current) => {
      sel.replaceChildren(...list.map((id) => { const o = document.createElement('option'); o.value = id; o.textContent = symName(id); return o; }));
      if (list.includes(current)) sel.value = current;
    };
    fill(E.asset, ids, S.sym);
    E.asset.disabled = ids.length < 2;
    E.cmpBtn.hidden = ids.length < 2;
    if (S.cmp && !ids.includes(S.cmp)) S.cmp = null;
    fill(E.cmpSel, ids.filter((id) => id !== S.sym), S.cmp);
    E.cmpWrap.hidden = !S.cmp;
    E.cmpBtn.setAttribute('aria-pressed', String(Boolean(S.cmp)));
    syncModeUI();
  }
  function syncModeUI() {
    E.modes.querySelectorAll('button').forEach((b) => {
      const locked = Boolean(S.cmp) && b.dataset.mode !== 'pct';
      b.setAttribute('aria-disabled', String(locked));
      b.disabled = locked;
    });
    syncRadios(E.modes, 'mode', S.mode);
    syncLogBtn();
  }
  async function setSymbol(id) {
    if (id === S.sym) return;
    root.dataset.busy = '1';
    if (!(await ensureHist(id))) { root.dataset.busy = ''; E.asset.value = S.sym; window.JB?.toast?.('That asset could not be loaded right now'); return; }
    S.sym = id;
    if (S.cmp === id) S.cmp = histIds().find((x) => x !== id) || null;
    if (S.cmp && !(await ensureHist(S.cmp))) S.cmp = null;
    buildAssets();
    buildRanges();
    applyLive();
    redraw(true);
  }
  async function setCompare(id) {
    if (id && !(await ensureHist(id))) { window.JB?.toast?.('That asset could not be loaded right now'); buildAssets(); return; }
    const entering = id && !S.cmp;
    const leaving = !id && S.cmp;
    if (entering) { S.prevMode = S.mode; S.prevLog = S.log; S.mode = 'pct'; S.log = false; }
    if (leaving) { S.mode = S.prevMode; S.log = S.prevLog; }
    S.cmp = id || null;
    buildAssets();
    buildRanges();
    redraw(true);
  }
  E.asset.addEventListener('change', () => setSymbol(E.asset.value));
  E.cmpSel.addEventListener('change', () => setCompare(E.cmpSel.value));
  E.cmpBtn.addEventListener('click', () => {
    if (S.cmp) return setCompare(null);
    const prefer = ['gld', 'ndx', 'vix', 'dji', 'tlt'].find((id) => id !== S.sym && histIds().includes(id));
    return setCompare(prefer || histIds().find((id) => id !== S.sym));
  });

  /* ---------- views (one per range) ---------- */
  const bsearchLE = (arr, v) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  const bsearchNearest = (xs, x) => {
    let lo = 0, hi = xs.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] < x) lo = m; else hi = m; }
    return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
  };

  /** Merge two daily series onto the dates both have a close for. */
  function align(a, b) {
    const d = [], ya = [], yb = [];
    let j = 0;
    for (let i = 0; i < a.d.length; i++) {
      while (j < b.d.length && b.d[j] < a.d[i]) j++;
      if (j >= b.d.length) break;
      if (b.d[j] === a.d[i]) { d.push(a.d[i]); ya.push(a.ys[i]); yb.push(b.ys[j]); }
    }
    return { d, ya: Float64Array.from(ya), yb: Float64Array.from(yb) };
  }

  function dailyView(range) {
    const a = histArrays(S.sym);
    if (!a) return null;
    let d = a.d, ya = a.ys, yb = null;
    if (S.cmp) {
      const b = histArrays(S.cmp);
      if (!b) return null;
      const al = align(a, b);
      if (al.d.length < 20) return null;
      d = al.d; ya = al.ya; yb = al.yb;
    }
    const n = d.length;
    let start = 0;
    if (range !== 'MAX') {
      const last = new Date(d[n - 1] * DAY);
      let cutoff;
      if (range === 'YTD') cutoff = Date.UTC(last.getUTCFullYear() - 1, 11, 31) / DAY;
      else {
        const months = RANGE_DEFS.find((r) => r.id === range).m;
        cutoff = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() - months, last.getUTCDate()) / DAY;
      }
      start = Math.max(0, bsearchLE(d, cutoff));
    }
    const xs = Float64Array.from(d.slice(start), (x) => x * DAY);
    const ys = ya.subarray(start);
    const ys2 = yb ? yb.subarray(start) : null;
    return {
      kind: 'daily', range, xs, ys, ys2, base: ys[0], base2: ys2 ? ys2[0] : null, baseLabel: null, domain: [xs[0], xs[xs.length - 1]],
      label: (i) => F.dayLong.format(xs[i]), ticks: timeTicks,
    };
  }

  function intradayView() {
    const s = S.live?.spx;
    if (!s?.intraday) return null;
    let xs = Float64Array.from(s.intraday.t, (t) => t * 1000);
    let ys = Float64Array.from(s.intraday.c);
    const end = s.session.end * 1000;
    // The last 1-minute bar is not the official close: finish the line on the latest quote so the
    // chart, the header and the stat tiles all tell the same story.
    const q = spxQuote();
    if (q && q.time * 1000 > xs[xs.length - 1] + 30_000 && nyDayNumber(q.time * 1000) === nyDayNumber(xs[0])) {
      const x = Math.min(q.time * 1000, end);
      if (x > xs[xs.length - 1]) { xs = Float64Array.from([...xs, x]); ys = Float64Array.from([...ys, q.price]); }
    }
    const base = Number.isFinite(s.prev) ? s.prev : ys[0];
    return {
      kind: 'intraday', range: '1D', xs, ys, base, baseLabel: Number.isFinite(s.prev) ? 'Prev close' : null,
      domain: [s.session.start * 1000, s.session.end * 1000],
      label: (i) => `${F.etStamp.format(xs[i])} ET`, ticks: hourTicks,
    };
  }

  function weekView() {
    const dates = sessionDates().slice(-5);
    const t = [];
    const c = [];
    const starts = [];
    dates.forEach((dt) => { const s = S.sess.sessions[dt]; starts.push(t.length); s.t.forEach((x, i) => { t.push(x * 1000); c.push(s.c[i]); }); });
    const xs = Float64Array.from(t.map((_, i) => i));
    const ys = Float64Array.from(c);
    // reference = last daily close before the first session, when the history has it
    let base = ys[0];
    let baseLabel = null;
    const a = histArrays('spx');
    if (a) {
      const firstDay = nyDayNumber(t[0]);
      const i = bsearchLE(a.d, firstDay - 1);
      if (i >= 0) { base = a.ys[i]; baseLabel = 'Prior close'; }
    }
    return {
      kind: 'week', range: '5D', xs, ys, base, baseLabel, domain: [0, xs.length - 1], starts,
      label: (i) => `${F.etStamp.format(t[i])} ET`,
      dividers: starts.slice(1),
      ticks: () => starts.map((s, k) => ({ x: (s + (starts[k + 1] ?? xs.length - 1)) / 2, label: F.etDay.format(t[s]) })),
    };
  }

  function buildView() {
    const r = S.range;
    const v = r === '1D' ? intradayView() : r === '5D' ? weekView() : dailyView(r);
    if (!v) return null;
    if (v.ys2) v.pct2 = Float64Array.from(v.ys2, (y) => (y / v.base2 - 1) * 100);
    const n = v.xs.length;
    const peak0 = v.kind === 'daily' ? v.ys[0] : v.ys[0];
    v.pct = new Float64Array(n);
    v.dd = new Float64Array(n);
    let peak = peak0;
    for (let i = 0; i < n; i++) {
      v.pct[i] = (v.ys[i] / v.base - 1) * 100;
      if (v.ys[i] > peak) peak = v.ys[i];
      v.dd[i] = (v.ys[i] / peak - 1) * 100;
    }
    return v;
  }

  /* ---------- tick helpers ---------- */
  function niceNum(range, round) {
    const exp = Math.floor(Math.log10(range));
    const f = range / 10 ** exp;
    const nfr = round ? (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) : f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nfr * 10 ** exp;
  }
  function niceTicks(min, max, count = 5) {
    if (!(max > min)) return [min];
    const step = niceNum(niceNum(max - min, false) / (count - 1), true);
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function logTicks(min, max) {
    const out = [];
    const lo = Math.floor(Math.log10(min));
    const hi = Math.ceil(Math.log10(max));
    for (let e = lo; e <= hi; e++) for (const m of [1, 2, 3, 5, 7]) { const v = m * 10 ** e; if (v >= min && v <= max) out.push(v); }
    if (out.length > 8) return out.filter((v) => [1, 2, 5].includes(Math.round(v / 10 ** Math.floor(Math.log10(v)))));
    return out;
  }
  function timeTicks(x0, x1, maxTicks) {
    const spanDays = (x1 - x0) / DAY;
    const opts = [['d', 1, 1], ['d', 2, 2], ['d', 7, 7], ['m', 1, 30.4], ['m', 2, 60.8], ['m', 3, 91.3], ['m', 6, 182.6], ['y', 1, 365.25], ['y', 2, 730.5], ['y', 5, 1826], ['y', 10, 3652]];
    const pick = opts.find((o) => spanDays / o[2] <= maxTicks) || opts[opts.length - 1];
    const [unit, n] = pick;
    const out = [];
    const start = new Date(x0);
    if (unit === 'd') {
      let t = Math.ceil(x0 / DAY) * DAY;
      for (; t <= x1; t += n * DAY) out.push({ x: t, label: F.dayShort.format(t) });
    } else if (unit === 'm') {
      let y = start.getUTCFullYear();
      let m = start.getUTCMonth();
      for (let guard = 0; guard < 600; guard++) {
        const t = Date.UTC(y, m, 1);
        if (t > x1) break;
        if (t >= x0 && m % n === 0) out.push({ x: t, label: m === 0 || !out.length ? F.monthYear.format(t) : F.month.format(t) });
        m++;
        if (m > 11) { m = 0; y++; }
      }
    } else {
      for (let y = Math.ceil(start.getUTCFullYear() / n) * n; ; y += n) {
        const t = Date.UTC(y, 0, 1);
        if (t > x1) break;
        if (t >= x0) out.push({ x: t, label: String(y) });
      }
    }
    return out;
  }
  function hourTicks(x0, x1) {
    const out = [];
    for (let t = Math.ceil(x0 / 3_600_000) * 3_600_000; t <= x1; t += 3_600_000) out.push({ x: t, label: F.etHour.format(t) });
    return out;
  }

  /* ---------- downsampling (largest-triangle-three-buckets) ---------- */
  function lttb(xs, ys, threshold) {
    const n = xs.length;
    if (threshold >= n || threshold < 3) return null; // draw everything
    const out = [0];
    const every = (n - 2) / (threshold - 2);
    let a = 0;
    for (let i = 0; i < threshold - 2; i++) {
      const s = Math.floor((i + 1) * every) + 1;
      const e = Math.min(Math.floor((i + 2) * every) + 1, n);
      let ax = 0, ay = 0;
      for (let j = s; j < e; j++) { ax += xs[j]; ay += ys[j]; }
      ax /= e - s; ay /= e - s;
      const rs = Math.floor(i * every) + 1;
      const re = Math.floor((i + 1) * every) + 1;
      let best = -1, bi = rs;
      for (let j = rs; j < re; j++) {
        const area = Math.abs((xs[a] - ax) * (ys[j] - ys[a]) - (xs[a] - xs[j]) * (ay - ys[a]));
        if (area > best) { best = area; bi = j; }
      }
      out.push(bi);
      a = bi;
    }
    out.push(n - 1);
    return out;
  }

  /* ---------- drawing ---------- */
  function resize() {
    const r = E.chart.getBoundingClientRect();
    S.dpr = Math.min(window.devicePixelRatio || 1, 3);
    S.w = Math.max(1, Math.round(r.width));
    S.h = Math.max(1, Math.round(r.height));
    E.canvas.width = Math.round(S.w * S.dpr);
    E.canvas.height = Math.round(S.h * S.dpr);
  }

  const EVENTS = [
    ['1987-10-19', 'Black Monday'], ['2000-03-24', 'Dot-com peak'], ['2002-10-09', 'Dot-com low'], ['2007-10-09', 'Pre-crisis peak'],
    ['2009-03-09', 'Financial-crisis low'], ['2020-03-23', 'COVID low'], ['2022-10-12', '2022 low'],
  ];

  function plotSeries(v) {
    if (S.mode === 'pct') return v.pct;
    if (S.mode === 'dd') return v.dd;
    return S.log ? Float64Array.from(v.ys, Math.log) : v.ys;
  }

  function geometry(v) {
    const small = S.w < 520;
    const pl = 6;
    const pr = S.w - (small ? 58 : 66);
    const pt = 16;
    const pb = 30;
    const series = plotSeries(v);
    const series2 = v.pct2 || null;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < series.length; i++) { if (series[i] < min) min = series[i]; if (series[i] > max) max = series[i]; }
    if (series2) for (let i = 0; i < series2.length; i++) { if (series2[i] < min) min = series2[i]; if (series2[i] > max) max = series2[i]; }
    const baseP = S.mode === 'price' ? (S.log ? Math.log(v.base) : v.base) : S.mode === 'pct' ? 0 : 0;
    if (S.mode !== 'dd' && v.kind !== 'daily') { min = Math.min(min, baseP); max = Math.max(max, baseP); } // keep the reference line in view
    if (S.mode === 'pct') { min = Math.min(min, 0); max = Math.max(max, 0); }
    if (S.mode === 'dd') max = 0;
    const span = max - min || Math.abs(max) * 0.01 || 1;
    const pad = span * (S.mode === 'dd' ? 0.04 : 0.08);
    const y0 = S.mode === 'dd' ? max : max + pad;
    const y1 = min - pad;
    const [x0, x1] = v.domain;
    const sx = (x) => pl + ((x - x0) / (x1 - x0 || 1)) * (pr - pl);
    const sy = (y) => pt + ((y0 - y) / (y0 - y1 || 1)) * (S.h - pt - pb);
    return { pl, pr, pt, pb, series, series2, min, max, y0, y1, sx, sy, baseP, x0, x1 };
  }

  function yTicksFor(g) {
    if (S.mode === 'price' && S.log) return logTicks(Math.exp(g.y1), Math.exp(g.y0)).map((v) => ({ v: Math.log(v), label: fmtAxisPrice(v) }));
    const count = S.h < 340 ? 4 : 5;
    const t = niceTicks(g.y1, g.y0, count);
    if (S.mode === 'price') return t.map((v) => ({ v, label: fmtAxisPrice(v) }));
    return t.map((v) => ({ v, label: `${v > 0 ? '+' : v < 0 ? MIN : ''}${nf(Math.abs(v) >= 10 || v === 0 ? 0 : 1).format(Math.abs(v))}%` }));
  }

  function draw() {
    const v = S.view;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, S.w, S.h);
    if (!v) return;
    const g = geometry(v);
    S.geo = g;
    const { pl, pr, pt, pb, sx, sy } = g;
    const plotH = S.h - pt - pb;

    /* grid + y labels */
    ctx.lineWidth = 1;
    ctx.font = MONO;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const t of yTicksFor(g)) {
      const y = Math.round(sy(t.v)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(pr, y); ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.fillText(t.label, pr + 8, y);
    }

    /* x labels */
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'center';
    ctx.fillStyle = C.axis;
    const ticks = v.ticks(g.x0, g.x1, Math.max(2, Math.floor((pr - pl) / (v.kind === 'daily' ? 84 : 64))));
    let lastRight = -Infinity;
    for (const t of ticks) {
      const x = sx(t.x);
      const w = ctx.measureText(t.label).width;
      if (x - w / 2 < pl - 2 || x + w / 2 > S.w - 2 || x - w / 2 < lastRight + 10) continue;
      ctx.fillText(t.label, x, S.h - 9);
      ctx.strokeStyle = C.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, S.h - pb); ctx.lineTo(Math.round(x) + 0.5, S.h - pb + 4); ctx.stroke();
      lastRight = x + w / 2;
    }

    /* session dividers (5-day view) */
    if (v.dividers) {
      ctx.strokeStyle = C.grid;
      for (const d of v.dividers) { const x = Math.round(sx(d - 0.5)) + 0.5; ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, S.h - pb); ctx.stroke(); }
    }

    /* reference line */
    const refY = S.mode === 'price' ? sy(g.baseP) : S.mode === 'pct' ? sy(0) : null;
    if (refY != null && (v.baseLabel || S.mode === 'pct') && refY > pt && refY < S.h - pb) {
      ctx.strokeStyle = C.ref;
      ctx.beginPath(); ctx.moveTo(pl, Math.round(refY) + 0.5); ctx.lineTo(pr, Math.round(refY) + 0.5); ctx.stroke();
      if (v.baseLabel && S.mode === 'price') {
        ctx.font = MONO;
        ctx.textAlign = 'left';
        ctx.fillStyle = C.axis;
        ctx.fillText(`${v.baseLabel} ${fmtPrice(v.base)}`, pl + 4, refY - 7);
      }
    }

    /* line(s) + area, revealed left to right */
    const n = v.xs.length;
    const px = Float64Array.from(v.xs, (x) => sx(x));
    const target = Math.max(200, Math.round((pr - pl) * 2));
    const trace = (series) => {
      const idx = lttb(px, Float64Array.from(series, (y) => sy(y)), target);
      const count = idx ? idx.length : n;
      return { at: (k) => (idx ? idx[k] : k), count };
    };
    const path = (series, t) => { ctx.beginPath(); for (let k = 0; k < t.count; k++) { const i = t.at(k); const X = px[i]; const Y = sy(series[i]); k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); } };
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, pl + (S.w - pl) * S.progress, S.h);
    ctx.clip();
    if (!g.series2) {
      const t = trace(g.series);
      const baseline = S.mode === 'dd' ? sy(0) : S.mode === 'pct' ? sy(0) : S.h - pb;
      const grad = ctx.createLinearGradient(0, pt, 0, S.h - pb);
      grad.addColorStop(0, 'rgba(239,233,221,.16)');
      grad.addColorStop(1, 'rgba(239,233,221,0)');
      path(g.series, t);
      ctx.lineTo(px[t.at(t.count - 1)], baseline);
      ctx.lineTo(px[t.at(0)], baseline);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      path(g.series, t);
      ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = C.line; ctx.stroke();
    } else {
      // compare mode: two lines, no area fills, categorical slots 1 and 2
      [[g.series, C.s1], [g.series2, C.s2]].forEach(([ser, col]) => {
        path(ser, trace(ser));
        ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = col; ctx.stroke();
      });
    }
    ctx.restore();

    if (S.progress >= 1) {
      if (!g.series2 && S.sym === 'spx') annotate(v, g, n);
      else if (!g.series2) annotate(v, g, n, true);
      const lx = sx(v.xs[n - 1]);
      if (g.series2) {
        ring(lx, sy(g.series[n - 1]), 4, C.s1);
        ring(lx, sy(g.series2[n - 1]), 4, C.s2);
      } else {
        const ly = sy(g.series[n - 1]);
        ring(lx, ly, 4, C.line);
        const label = S.mode === 'price' ? fmtAxisPrice(v.ys[n - 1]) : fmtPct(S.mode === 'pct' ? v.pct[n - 1] : v.dd[n - 1], 1);
        badge(label, pr + 6, ly);
      }
      if (S.hover >= 0) drawHover(v, g);
    }
  }

  function ring(x, y, r, color) {
    ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fillStyle = C.surface; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  }
  function badge(text, x, y) {
    ctx.font = SANS;
    const w = ctx.measureText(text).width + 12;
    const h = 20;
    const yy = Math.min(Math.max(y, 16 + h / 2 - 2), S.h - 30 - h / 2 + 4);
    ctx.fillStyle = C.line;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, yy - h / 2, w, h, 6); else ctx.rect(x, yy - h / 2, w, h);
    ctx.fill();
    ctx.fillStyle = '#12160f';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, yy + 0.5);
  }

  /** Text with a thin dark halo so labels stay readable where the line crosses them. */
  function halo(text, x, y) {
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = C.surface;
    ctx.strokeText(text, x, y);
    ctx.fillStyle = C.text;
    ctx.fillText(text, x, y);
  }

  /** Selective direct labels: the trough in drawdown view, named events on long ranges, extremes on short ones. */
  function annotate(v, g, n, noEvents) {
    const { sx, sy, pl, pr, series } = g;
    ctx.font = MONO;
    const long = !noEvents && v.kind === 'daily' && v.xs[n - 1] - v.xs[0] > 4 * 365 * DAY;
    const put = (i, text, above) => {
      const x = sx(v.xs[i]);
      const y = sy(series[i]);
      const w = ctx.measureText(text).width;
      const tx = Math.min(Math.max(x, pl + w / 2 + 2), pr - w / 2);
      ctx.textAlign = 'center';
      ctx.textBaseline = above ? 'bottom' : 'top';
      halo(text, tx, above ? y - 8 : y + 8);
      ring(x, y, 2.5, C.line);
    };
    if (S.mode === 'dd') {
      let lo = 0;
      for (let i = 1; i < n; i++) if (series[i] < series[lo]) lo = i;
      if (lo !== n - 1 && series[lo] < -0.5) put(lo, `Max drawdown ${fmtPct(v.dd[lo], 1)}`, false);
      return;
    }
    if (long) {
      const days = Float64Array.from(v.xs, (x) => Math.round(x / DAY));
      let lastX = -1e9;
      EVENTS.forEach(([iso, text]) => {
        const day = Date.parse(iso) / DAY;
        if (day < days[0] || day > days[n - 1]) return;
        const i = bsearchLE(days, day);
        if (i < 0) return;
        const x = sx(v.xs[i]);
        const y = sy(series[i]);
        if (x - lastX < 96) return; // keep labels from colliding
        lastX = x;
        const low = /low|Monday/.test(text);
        ring(x, y, 3, C.line);
        ctx.textAlign = x > pr - 70 ? 'right' : x < pl + 50 ? 'left' : 'center';
        ctx.textBaseline = low ? 'top' : 'bottom';
        halo(text, x, low ? y + 9 : y - 9);
      });
      return;
    }
    if (v.kind === 'daily' && v.xs[n - 1] - v.xs[0] > 4 * 365 * DAY) return; // long ranges of non-S&P assets: no clutter
    let hi = 0, lo = 0;
    for (let i = 1; i < n; i++) { if (series[i] > series[hi]) hi = i; if (series[i] < series[lo]) lo = i; }
    const name = (i, kind) => `${kind} ${S.mode === 'price' ? fmtAxisPrice(v.ys[i]) : fmtPct(v.pct[i], 1)}`;
    if (hi !== n - 1 && hi !== lo) put(hi, name(hi, 'High'), true);
    if (lo !== n - 1 && lo !== hi && lo !== 0) put(lo, name(lo, 'Low'), false);
  }

  function drawHover(v, g) {
    const i = S.hover;
    const x = g.sx(v.xs[i]);
    ctx.strokeStyle = C.cross;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, g.pt); ctx.lineTo(Math.round(x) + 0.5, S.h - g.pb); ctx.stroke();
    if (g.series2) { ring(x, g.sy(g.series[i]), 4.5, C.s1); ring(x, g.sy(g.series2[i]), 4.5, C.s2); }
    else ring(x, g.sy(g.series[i]), 4.5, C.line);
  }

  /* ---------- redraw / animation ---------- */
  function redraw(animate) {
    resize();
    S.view = buildView();
    S.hover = -1;
    E.tip.hidden = true;
    renderLegend();
    renderStats();
    if (!E.tableWrap.hidden) renderTable();
    updateAria();
    cancelAnimationFrame(S.anim);
    if (animate && !reduced && S.view) {
      const t0 = performance.now();
      const dur = 650;
      root.dataset.busy = '1';
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        S.progress = 1 - Math.pow(1 - p, 3);
        draw();
        if (p < 1) S.anim = requestAnimationFrame(step); else root.dataset.busy = '';
      };
      S.progress = 0;
      S.anim = requestAnimationFrame(step);
    } else {
      S.progress = 1;
      draw();
    }
  }
  new ResizeObserver(() => { if (S.view) { resize(); draw(); } }).observe(E.chart);
  if (document.fonts?.ready) document.fonts.ready.then(() => S.view && draw());

  function updateAria() {
    const v = S.view;
    if (!v) return;
    const n = v.xs.length;
    const chg = (v.ys[n - 1] / v.base - 1) * 100;
    const name = { '1D': 'today', '5D': 'the last 5 sessions', '1M': 'the last month', '6M': 'the last 6 months', YTD: 'this year so far', '1Y': 'the last year', '5Y': 'the last 5 years', MAX: `since ${new Date(v.xs[0]).getUTCFullYear()}` }[v.range];
    if (v.ys2) {
      const chg2 = (v.ys2[n - 1] / v.base2 - 1) * 100;
      E.canvas.setAttribute('aria-label', `${symName(S.sym)} versus ${symName(S.cmp)}, percentage change over ${name}: ${symName(S.sym)} ${fmtPct(chg, 1)}, ${symName(S.cmp)} ${fmtPct(chg2, 1)}. Use the left and right arrow keys to read values.`);
      return;
    }
    E.canvas.setAttribute('aria-label', `${symName(S.sym)} ${S.mode === 'dd' ? 'drawdown' : S.mode === 'pct' ? 'percentage change' : 'price'} over ${name}: ${fmtPct(chg, 1)}, latest ${fmtSym(S.sym, v.ys[n - 1])}. Use the left and right arrow keys to read values.`);
  }

  /* ---------- hover, touch, keyboard ---------- */
  function setHover(i, announce) {
    if (!S.view || S.progress < 1) return;
    i = Math.max(0, Math.min(S.view.xs.length - 1, i));
    if (i === S.hover) return;
    S.hover = i;
    draw();
    showTip(i);
    if (announce) E.live.textContent = tipText(i);
  }
  function clearHover() {
    if (S.hover < 0) return;
    S.hover = -1;
    E.tip.hidden = true;
    draw();
  }
  function valueAt(i) {
    const v = S.view;
    return { price: v.ys[i], pct: v.pct[i], dd: v.dd[i] };
  }
  function tipText(i) {
    const v = S.view;
    if (v.ys2) return `${v.label(i)}: ${symName(S.sym)} ${fmtPct(v.pct[i], 2)}, ${symName(S.cmp)} ${fmtPct(v.pct2[i], 2)} since the start of the range`;
    const val = valueAt(i);
    return `${v.label(i)}: ${fmtPrice(val.price)}, ${fmtPct(val.pct, 2)} versus ${v.baseLabel ? v.baseLabel.toLowerCase() : 'the start of the range'}${S.mode === 'dd' ? `, ${fmtPct(val.dd, 2)} from the peak` : ''}`;
  }
  const tipNodes = (() => {
    const b = document.createElement('b');
    const d = document.createElement('span'); d.className = 't-date';
    const r1 = document.createElement('div'); r1.className = 't-row';
    const k1 = document.createElement('i'); const t1 = document.createElement('span'); r1.append(k1, t1);
    const r2 = document.createElement('div'); r2.className = 't-row';
    const k2 = document.createElement('i'); k2.style.opacity = '.4'; const t2 = document.createElement('span'); r2.append(k2, t2);
    E.tip.append(b, d, r1, r2);
    return { b, d, t1, t2, k1, k2 };
  })();
  function showTip(i) {
    const v = S.view;
    const g = S.geo;
    const val = valueAt(i);
    if (v.ys2) {
      // one tooltip, every series: value leads, name follows, a short line in the series colour is the key
      tipNodes.b.textContent = v.label(i);
      tipNodes.d.textContent = 'Change since the start of the range';
      tipNodes.k1.style.cssText = `background:${C.s1};opacity:1;height:3px`;
      tipNodes.k2.style.cssText = `background:${C.s2};opacity:1;height:3px`;
      tipNodes.t1.textContent = `${fmtPct(v.pct[i], 2)} ${symName(S.sym)} · ${fmtSym(S.sym, v.ys[i])}`;
      tipNodes.t2.textContent = `${fmtPct(v.pct2[i], 2)} ${symName(S.cmp)} · ${fmtSym(S.cmp, v.ys2[i])}`;
    } else {
      tipNodes.k1.style.cssText = '';
      tipNodes.k2.style.cssText = 'opacity:.4';
      tipNodes.b.textContent = S.mode === 'dd' ? fmtPct(val.dd, 2) : S.mode === 'pct' ? fmtPct(val.pct, 2) : fmtSym(S.sym, val.price);
      tipNodes.d.textContent = v.label(i);
      tipNodes.t1.textContent = S.mode === 'price' ? `Close ${fmtSym(S.sym, val.price)}` : `${symName(S.sym)} ${fmtSym(S.sym, val.price)}`;
      const chg = v.baseLabel ? `${fmtPct(val.pct, 2)} vs ${v.baseLabel.toLowerCase()}` : `${fmtPct(val.pct, 2)} since range start`;
      tipNodes.t2.textContent = S.mode === 'dd' ? `${fmtPct(val.dd, 2)} below peak` : chg;
    }
    E.tip.hidden = false;
    const x = g.sx(v.xs[i]);
    const w = E.tip.offsetWidth;
    let left = x + 16;
    if (left + w > S.w - 4) left = x - w - 16;
    E.tip.style.transform = `translate(${Math.max(4, left)}px, 6px)`;
  }
  const pointerIndex = (e) => {
    const r = E.canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const g = S.geo;
    const x = g.x0 + ((px - g.pl) / (g.pr - g.pl)) * (g.x1 - g.x0);
    return bsearchNearest(S.view.xs, x);
  };
  E.canvas.addEventListener('pointermove', (e) => { if (S.view && S.geo) setHover(pointerIndex(e)); });
  E.canvas.addEventListener('pointerdown', (e) => { if (S.view && S.geo) setHover(pointerIndex(e)); });
  E.canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') clearHover(); });
  E.canvas.addEventListener('blur', clearHover);
  E.canvas.addEventListener('focus', () => { if (S.view && S.hover < 0) setHover(S.view.xs.length - 1, true); });
  E.canvas.addEventListener('keydown', (e) => {
    if (!S.view) return;
    const n = S.view.xs.length;
    const step = e.shiftKey ? 10 : 1;
    const cur = S.hover < 0 ? n - 1 : S.hover;
    const moves = { ArrowLeft: cur - step, ArrowRight: cur + step, PageDown: cur - 25, PageUp: cur + 25, Home: 0, End: n - 1 };
    if (e.key in moves) { e.preventDefault(); setHover(moves[e.key], true); }
    else if (e.key === 'Escape') clearHover();
  });

  /* ---------- stat tiles ---------- */
  function tile(label, value, sub, cls, meter) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    const main = document.createElement('span');
    if (cls) main.className = cls;
    main.textContent = value;
    dd.append(main);
    if (sub) { const s = document.createElement('small'); s.textContent = sub; dd.append(s); }
    if (meter != null) {
      const m = document.createElement('div'); m.className = 'meter'; m.setAttribute('aria-hidden', 'true');
      const dot = document.createElement('i'); dot.style.left = `${Math.max(0, Math.min(1, meter)) * 100}%`;
      m.append(dot); dd.append(m);
    }
    wrap.append(dt, dd);
    return wrap;
  }

  function logReturnStats(ys) {
    let sum = 0, sum2 = 0;
    for (let i = 1; i < ys.length; i++) { const r = Math.log(ys[i] / ys[i - 1]); sum += r; sum2 += r * r; }
    const m = ys.length - 1;
    return Math.sqrt(Math.max(0, (sum2 - (sum * sum) / m) / (m - 1))) * Math.sqrt(252) * 100;
  }
  function maxDrawdown(ys) {
    let peak = ys[0], worst = 0;
    for (let i = 1; i < ys.length; i++) { if (ys[i] > peak) peak = ys[i]; worst = Math.min(worst, ys[i] / peak - 1); }
    return worst * 100;
  }
  function correlation(a, b) {
    const n = a.length - 1;
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (let i = 1; i <= n; i++) { const x = Math.log(a[i] / a[i - 1]); const y = Math.log(b[i] / b[i - 1]); sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y; }
    const cov = sab / n - (sa / n) * (sb / n);
    return cov / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
  }

  function renderCompareStats(v) {
    const n = v.xs.length;
    const A = symName(S.sym), B = symName(S.cmp);
    const pa = (v.ys[n - 1] / v.base - 1) * 100;
    const pb = (v.ys2[n - 1] / v.base2 - 1) * 100;
    const gap = pa - pb;
    const rho = correlation(v.ys, v.ys2);
    const years = (v.xs[n - 1] - v.xs[0]) / (365.25 * DAY);
    const from = F.dayLong.format(v.xs[0]);
    const dir = (x) => (x > 0 ? 'up' : x < 0 ? 'down' : '');
    E.stats.append(
      tile(`${A} change`, fmtPct(pa, 2), `${fmtSym(S.sym, v.ys[0])} → ${fmtSym(S.sym, v.ys[n - 1])}`, dir(pa)),
      tile(`${B} change`, fmtPct(pb, 2), `${fmtSym(S.cmp, v.ys2[0])} → ${fmtSym(S.cmp, v.ys2[n - 1])}`, dir(pb)),
      tile('Gap', `${fmtDelta(gap, 1)} pts`, `${gap >= 0 ? A : B} ahead since ${from}`),
      tile('Correlation', nf(2).format(rho).replace('-', MIN), `daily returns, ${nf(0).format(n - 1)} days`),
      tile(`${A} max drawdown`, fmtPct(maxDrawdown(v.ys), 1), 'peak to trough in range'),
      tile(`${B} max drawdown`, fmtPct(maxDrawdown(v.ys2), 1), 'peak to trough in range'),
      tile(`${A} volatility`, `${nf(1).format(logReturnStats(v.ys))}%`, 'annualized, daily returns'),
      tile(`${B} volatility`, `${nf(1).format(logReturnStats(v.ys2))}%`, years < 1 ? 'annualized, daily returns' : `over ${nf(years >= 10 ? 0 : 1).format(years)} years`),
    );
  }

  function renderLegend() {
    const v = S.view;
    E.legend.replaceChildren();
    E.legend.hidden = !(v && v.ys2);
    if (!v || !v.ys2) return;
    const n = v.xs.length;
    [[S.sym, C.s1, v.pct[n - 1]], [S.cmp, C.s2, v.pct2[n - 1]]].forEach(([id, col, p]) => {
      const li = document.createElement('li');
      const key = document.createElement('i');
      key.style.background = col;
      key.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.textContent = symName(id);
      const val = document.createElement('b');
      val.textContent = fmtPct(p, 1);
      li.append(key, name, val);
      E.legend.append(li);
    });
    const note = document.createElement('li');
    note.className = 'note';
    note.textContent = `Both start at 0% on ${F.dayLong.format(v.xs[0])}${S.range !== 'MAX' ? '' : ' — the first date both have data'}`;
    E.legend.append(note);
  }

  function renderStats() {
    const v = S.view;
    E.stats.replaceChildren();
    if (!v) return;
    if (v.ys2) return renderCompareStats(v);
    const n = v.xs.length;
    const end = v.ys[n - 1];
    const chg = end - v.base;
    const pct = (end / v.base - 1) * 100;
    let hi = 0, lo = 0, trough = 0;
    for (let i = 1; i < n; i++) { if (v.ys[i] > v.ys[hi]) hi = i; if (v.ys[i] < v.ys[lo]) lo = i; if (v.dd[i] < v.dd[trough]) trough = i; }
    let peakI = 0;
    for (let i = 0; i <= trough; i++) if (v.ys[i] >= v.ys[peakI]) peakI = i;
    const when = (i) => (v.kind === 'daily' ? F.dayLong.format(v.xs[i]) : v.kind === 'intraday' ? `${F.etTime.format(v.xs[i])} ET` : v.label(i).replace(' ET', ''));
    const dir = chg > 0 ? 'up' : chg < 0 ? 'down' : '';
    const tiles = [];
    tiles.push(tile('Change', fmtPct(pct, 2), `${fmtDelta(chg, symDigits(S.sym))} pts ${v.baseLabel ? `vs ${v.baseLabel.toLowerCase()}` : 'over the range'}`, dir));
    tiles.push(tile('Range high', fmtSym(S.sym, v.ys[hi]), when(hi)));
    tiles.push(tile('Range low', fmtSym(S.sym, v.ys[lo]), when(lo)));
    tiles.push(tile('Max drawdown', v.dd[trough] === 0 ? '0.0%' : fmtPct(v.dd[trough], 1), v.dd[trough] === 0 ? 'No decline from a peak' : `${when(peakI)} → ${when(trough)}`));

    // annualised return + volatility need daily data over a meaningful span
    const years = (v.xs[n - 1] - v.xs[0]) / (365.25 * DAY);
    if (v.kind === 'daily' && years >= 1) {
      const cagr = ((end / v.ys[0]) ** (1 / years) - 1) * 100;
      tiles.push(tile('Annualized return', fmtPct(cagr, 1), `price only, over ${nf(years >= 10 ? 0 : 1).format(years)} years`));
    } else tiles.push(tile('Annualized return', '—', 'ranges of 1 year or more'));
    if (v.kind === 'daily' && n > 20) {
      let sum = 0, sum2 = 0;
      for (let i = 1; i < n; i++) { const r = Math.log(v.ys[i] / v.ys[i - 1]); sum += r; sum2 += r * r; }
      const m = n - 1;
      const sd = Math.sqrt(Math.max(0, (sum2 - (sum * sum) / m) / (m - 1))) * Math.sqrt(252) * 100;
      tiles.push(tile('Volatility', `${nf(1).format(sd)}%`, 'annualized, daily returns'));
    } else tiles.push(tile('Volatility', '—', 'needs daily data'));

    // all-time high + 52-week range always come from the full history
    const a = histArrays(S.sym);
    if (a) {
      const m = a.ys.length;
      let ath = 0;
      for (let i = 1; i < m; i++) if (a.ys[i] >= a.ys[ath]) ath = i;
      const off = (a.ys[m - 1] / a.ys[ath] - 1) * 100;
      tiles.push(tile('Vs all-time high', off >= -0.005 ? 'At a record' : fmtPct(off, 1), `record close ${fmtSym(S.sym, a.ys[ath])} · ${F.dayLong.format(a.xs[ath])}`));
      const from = Math.max(0, bsearchLE(a.xs, a.xs[m - 1] - 365 * DAY));
      let h52 = -Infinity, l52 = Infinity;
      for (let i = from; i < m; i++) { if (a.ys[i] > h52) h52 = a.ys[i]; if (a.ys[i] < l52) l52 = a.ys[i]; }
      tiles.push(tile('52-week range', `${nf(0).format(l52)} – ${nf(0).format(h52)}`, `${nf(0).format(((a.ys[m - 1] - l52) / (h52 - l52 || 1)) * 100)}% of the way up`, '', (a.ys[m - 1] - l52) / (h52 - l52 || 1)));
    }
    E.stats.append(...tiles);
  }

  /* ---------- table twin ---------- */
  function renderTable() {
    const v = S.view;
    const body = E.table.tBodies[0];
    body.replaceChildren();
    const head = E.table.tHead.rows[0];
    head.replaceChildren();
    const cols = v && v.ys2 ? ['Date', `${symName(S.sym)} close`, `${symName(S.sym)} change`, `${symName(S.cmp)} close`, `${symName(S.cmp)} change`] : ['Date', 'Close', 'Change in range'];
    cols.forEach((t) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = t; head.append(th); });
    if (!v) return;
    const n = v.xs.length;
    const rows = Math.min(n, 40);
    const seen = new Set();
    for (let k = 0; k < rows; k++) {
      const i = Math.round((k / (rows - 1 || 1)) * (n - 1));
      if (seen.has(i)) continue;
      seen.add(i);
      const tr = body.insertRow();
      tr.insertCell().textContent = v.label(i);
      tr.insertCell().textContent = fmtSym(S.sym, v.ys[i]);
      tr.insertCell().textContent = fmtPct(v.pct[i], 2);
      if (v.ys2) { tr.insertCell().textContent = fmtSym(S.cmp, v.ys2[i]); tr.insertCell().textContent = fmtPct(v.pct2[i], 2); }
    }
  }

  /* ---------- "what if you had invested" calculator ---------- */
  function initCalc() {
    const a = histArrays('spx');
    if (!a || !E.calc) return;
    const firstYear = new Date(a.xs[0]).getUTCFullYear();
    const lastYear = new Date(a.xs[a.xs.length - 1]).getUTCFullYear();
    E.year.replaceChildren();
    for (let y = firstYear; y < lastYear; y++) { const o = document.createElement('option'); o.value = String(y); o.textContent = String(y); E.year.append(o); }
    E.year.value = String(Math.min(Math.max(2000, firstYear), lastYear - 1));
    E.calc.hidden = false;
    if (!initCalc.bound) {
      initCalc.bound = true;
      E.amount.addEventListener('input', updateCalc);
      E.year.addEventListener('change', updateCalc);
      new ResizeObserver(() => drawCalc()).observe(E.ccanvas.parentElement);
    }
    updateCalc();
  }
  const calcState = { xs: null, ys: null };
  function updateCalc() {
    const a = histArrays('spx');
    if (!a) return;
    const amount = Math.max(1, Math.min(1e9, parseFloat(E.amount.value) || 0));
    const year = parseInt(E.year.value, 10);
    const start = a.xs.findIndex((x) => new Date(x).getUTCFullYear() === year);
    if (start < 0 || !amount) { E.cres.textContent = 'Enter an amount and a starting year.'; return; }
    const m = a.ys.length;
    const mult = a.ys[m - 1] / a.ys[start];
    const years = (a.xs[m - 1] - a.xs[start]) / (365.25 * DAY);
    const cagr = (mult ** (1 / years) - 1) * 100;
    E.cres.replaceChildren();
    const lead = document.createElement('span');
    lead.textContent = `${fmtUsd(amount)} invested on ${F.dayLong.format(a.xs[start])} would be worth about`;
    const big = document.createElement('strong');
    big.textContent = fmtUsd(amount * mult);
    const tail = document.createElement('span');
    tail.textContent = `today — ${nf(mult >= 10 ? 1 : 2).format(mult)}× your money, or ${fmtPct(cagr, 1)} a year over ${nf(1).format(years)} years.`;
    E.cres.append(lead, big, tail);
    calcState.xs = a.xs.subarray(start);
    calcState.ys = Float64Array.from(a.ys.subarray(start), (y) => (amount * y) / a.ys[start]);
    drawCalc();
  }
  function drawCalc() {
    const cv = E.ccanvas;
    const box = cv.parentElement.getBoundingClientRect();
    if (!calcState.xs || box.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.round(box.width);
    const h = Math.round(Math.max(box.height, 200));
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.height = `${h}px`;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const xs = calcState.xs;
    const ys = calcState.ys;
    const pl = 4, pr = w - 8, pt = 26, pb = 24;
    let max = 0;
    for (let i = 0; i < ys.length; i++) if (ys[i] > max) max = ys[i];
    const min = Math.min(...ys);
    const lo = Math.min(min, ys[0]) * 0.9;
    const hi = max * 1.06;
    const sx = (x) => pl + ((x - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (pr - pl);
    const sy = (y) => pt + ((hi - y) / (hi - lo || 1)) * (h - pt - pb);
    const idx = lttb(Float64Array.from(xs, sx), Float64Array.from(ys, sy), Math.max(120, Math.round((pr - pl) * 1.5)));
    const at = (k) => (idx ? idx[k] : k);
    const cnt = idx ? idx.length : xs.length;
    const grad = c.createLinearGradient(0, pt, 0, h - pb);
    grad.addColorStop(0, 'rgba(239,233,221,.16)');
    grad.addColorStop(1, 'rgba(239,233,221,0)');
    c.beginPath();
    for (let k = 0; k < cnt; k++) { const i = at(k); k ? c.lineTo(sx(xs[i]), sy(ys[i])) : c.moveTo(sx(xs[i]), sy(ys[i])); }
    c.lineTo(sx(xs[xs.length - 1]), h - pb); c.lineTo(sx(xs[0]), h - pb); c.closePath();
    c.fillStyle = grad; c.fill();
    c.beginPath();
    for (let k = 0; k < cnt; k++) { const i = at(k); k ? c.lineTo(sx(xs[i]), sy(ys[i])) : c.moveTo(sx(xs[i]), sy(ys[i])); }
    c.lineWidth = 2; c.lineJoin = 'round'; c.strokeStyle = C.line; c.stroke();
    // start line + labels
    c.strokeStyle = C.ref; c.lineWidth = 1;
    c.beginPath(); c.moveTo(pl, Math.round(sy(ys[0])) + 0.5); c.lineTo(pr, Math.round(sy(ys[0])) + 0.5); c.stroke();
    c.font = MONO; c.fillStyle = C.axis; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText(String(new Date(xs[0]).getUTCFullYear()), pl, h - 6);
    c.textAlign = 'right'; c.fillText('today', pr, h - 6);
    const lx = sx(xs[xs.length - 1]);
    const ly = sy(ys[ys.length - 1]);
    c.beginPath(); c.arc(lx, ly, 6, 0, Math.PI * 2); c.fillStyle = C.surface; c.fill();
    c.beginPath(); c.arc(lx, ly, 4, 0, Math.PI * 2); c.fillStyle = C.line; c.fill();
    c.font = SANS; c.fillStyle = C.text; c.textAlign = 'right'; c.textBaseline = 'bottom';
    c.fillText(fmtUsd(ys[ys.length - 1]), Math.min(lx, pr), Math.max(ly - 10, 14));
  }

  /* ---------- go ---------- */
  load(true).catch(() => setState('error'));
  setInterval(() => { if (!document.hidden) load(false).catch(() => {}); }, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.live) applyLive(); });
})();
