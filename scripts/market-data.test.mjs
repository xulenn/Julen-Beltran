// Run with: node --test scripts/market-data.test.mjs
// Fixtures mimic the real layout of Cboe's delayed-quote JSON (numbers as strings, ET wall-clock
// times, history from 1975). They are generated in memory and never written to the repo or shown
// on the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { etToEpoch, parseHistory, parseQuote, parseIntraday, downsample5, run, tuning, SYMBOLS } from './market-data.mjs';

tuning.retryMs = 0;
tuning.politeMs = 0;
const silent = () => {};
const iso = (sec) => new Date(sec * 1000).toISOString();

test('etToEpoch handles EDT, EST and both DST transition days', () => {
  assert.equal(iso(etToEpoch('2026-10-02T09:31:00')), '2026-10-02T13:31:00.000Z'); // EDT, UTC-4
  assert.equal(iso(etToEpoch('2026-12-15T09:31:00')), '2026-12-15T14:31:00.000Z'); // EST, UTC-5
  assert.equal(iso(etToEpoch('2026-03-08T09:31:00')), '2026-03-08T13:31:00.000Z'); // spring-forward day, already EDT
  assert.equal(iso(etToEpoch('2026-11-01T09:31:00')), '2026-11-01T14:31:00.000Z'); // fall-back day, already EST
  assert.throws(() => etToEpoch('nope'), /Bad ET/);
});

function historyJson({ from = '1975-01-02', to = '2026-10-02', start = 70 }) {
  const rows = [];
  let v = start;
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86_400_000) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    v *= 1 + Math.sin(t / 3e9) * 0.002 + 0.0004;
    rows.push({ date: new Date(t).toISOString().slice(0, 10), volume: '0.0', open: '0.000000', high: (v * 1.01).toFixed(6), low: (v * 0.99).toFixed(6), close: v.toFixed(6) });
  }
  return { timestamp: '2026-10-05 02:01:33', data: rows };
}

test('parseHistory reads string numbers, drops bad rows, keeps order', () => {
  const j = historyJson({ from: '2026-09-28', to: '2026-10-02' });
  j.data.splice(2, 0, { date: '2026-09-30', close: '0.000000' }, { date: 'garbage', close: '5' }, { date: '2026-09-29', close: '7000' });
  const h = parseHistory(j);
  assert.equal(h.d.length, 5);
  assert.ok(h.d.every((x, i) => i === 0 || x > h.d[i - 1]));
  assert.ok(h.c.every((x) => x > 0));
  assert.throws(() => parseHistory({ data: [] }), /no rows/);
});

const quoteJson = (price, change, pct, last = '2026-10-02T16:14:59') => ({
  timestamp: '2026-10-05 07:38:10',
  data: { symbol: '^SPX', current_price: price, price_change: change, price_change_percent: pct, prev_day_close: price, last_trade_time: last, options: [{ option: 'x' }] },
});

test('parseQuote derives the reference close from price_change (prev_day_close is overwritten after the bell)', () => {
  const q = parseQuote(quoteJson(7722.7202, 56.2702, 0.7286));
  assert.ok(Math.abs(q.prev - 7666.45) < 1e-6);
  assert.equal(iso(q.time), '2026-10-02T20:14:59.000Z');
  assert.throws(() => parseQuote({ data: { current_price: 'x' } }), /missing price/);
});

function intradayJson(date, n = 389) {
  const data = [];
  for (let i = 0; i < n; i++) {
    const mins = 9 * 60 + 31 + i;
    const hh = String(Math.floor(mins / 60)).padStart(2, '0');
    const mm = String(mins % 60).padStart(2, '0');
    const px = 7700 + Math.sin(i / 20) * 15;
    data.push({ datetime: `${date}T${hh}:${mm}:00`, sequence_number: i, price: { open: px, high: px + 1, low: px - 1, close: px }, volume: {} });
  }
  return { timestamp: `${date} 20:14:23`, data };
}

test('parseIntraday keeps only the latest session; downsample5 shrinks it and keeps the last bar', () => {
  const j = intradayJson('2026-10-02');
  j.data.unshift(...intradayJson('2026-10-01', 20).data);
  const day = parseIntraday(j);
  assert.equal(day.date, '2026-10-02');
  assert.equal(day.t.length, 389);
  const small = downsample5(day.t, day.c);
  assert.ok(small.t.length > 70 && small.t.length < 90);
  assert.equal(small.t[small.t.length - 1], day.t[day.t.length - 1]);
  assert.throws(() => parseIntraday(intradayJson('2026-10-02', 3)), /too few/);
});

function mockFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return () => (globalThis.fetch = real);
}
const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const bySym = (url) => /\/(?:quotes|historical)\/([^/.]+)\.json/.exec(url)?.[1];

function happyHandler({ date = '2026-10-02', failHistory = [], failQuote = [] } = {}) {
  return (url) => {
    const sym = bySym(url);
    if (url.includes('/charts/historical/')) return failHistory.includes(sym) ? new Response('no', { status: 403 }) : ok(historyJson({ to: '2026-10-02' }));
    if (url.includes('/charts/intraday/')) return ok(intradayJson(date));
    if (url.includes('/quotes/')) return failQuote.includes(sym) ? new Response('boom', { status: 500 }) : ok(quoteJson(sym === '_DJX' ? 511.77 : 7722.7202, sym === '_DJX' ? 2.5 : 56.2702, 0.7286));
    return new Response('nope', { status: 404 });
  };
}

test('run(): happy path writes live, history and sessions; Dow is scaled; Nasdaq-100 has no sparkline', async () => {
  const restore = mockFetch(happyHandler({ failHistory: ['_NDX'] }));
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    const { changed } = await run(dir, silent);
    assert.equal(changed, true);
    const live = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
    const hist = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    const sess = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'));
    assert.equal(hist.symbol, '^SPX');
    assert.equal(hist.d.length, hist.c.length);
    assert.ok(hist.c.length > 12_000);
    assert.equal(live.quotes.length, SYMBOLS.length);
    assert.equal(live.quotes[0].id, 'spx');
    assert.equal(live.quotes.find((q) => q.id === 'dji').price, 51177);
    assert.equal(live.quotes.find((q) => q.id === 'vix').invert, true);
    assert.equal(live.quotes.find((q) => q.id === 'ndx').spark.length, 0);
    assert.equal(live.quotes[0].spark.length, 30);
    assert.equal(live.spx.intraday.t.length, 389);
    assert.ok(live.spx.session.end > live.spx.session.start);
    assert.ok(sess.sessions['2026-10-02']);
    const again = await run(dir, silent);
    assert.equal(again.changed, false, 'second run with identical data must not republish');
  } finally { restore(); }
});

test('run(): a failing quote keeps the previously known value; first-run failure just omits it', async () => {
  let restore = mockFetch(happyHandler());
  const dir = await mkdtemp(join(tmpdir(), 'md-'));
  try { await run(dir, silent); } finally { restore(); }
  restore = mockFetch(happyHandler({ failQuote: ['GLD', '_RUT'] }));
  try {
    const { failures } = await run(dir, silent);
    assert.equal(failures, 2);
    const live = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
    assert.equal(live.quotes.length, SYMBOLS.length, 'previous GLD / RUT entries preserved');
  } finally { restore(); }
  restore = mockFetch(happyHandler({ failQuote: ['GLD'] }));
  try {
    const fresh = await mkdtemp(join(tmpdir(), 'md-'));
    await run(fresh, silent);
    const live = JSON.parse(await readFile(join(fresh, 'live.json'), 'utf8'));
    assert.equal(live.quotes.length, SYMBOLS.length - 1);
  } finally { restore(); }
});

test('run(): sessions accumulate across days and are capped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'md-'));
  for (const date of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']) {
    const restore = mockFetch(happyHandler({ date }));
    try { await run(dir, silent); } finally { restore(); }
  }
  const sess = JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8'));
  assert.deepEqual(Object.keys(sess.sessions), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']);
});

test('run(): everything down and nothing cached -> fails loudly instead of writing fake data', async () => {
  const restore = mockFetch(() => new Response('down', { status: 503 }));
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    await assert.rejects(run(dir, silent), /No market data/);
  } finally { restore(); }
});

test('run(): every asset with history gets its own file; Dow is scaled; Nasdaq-100 has none; live.json lists what is switchable', async () => {
  const restore = mockFetch(happyHandler({ failHistory: ['_NDX'] }));
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    await run(dir, silent);
    const live = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
    assert.deepEqual(live.histories.sort(), SYMBOLS.filter((s) => s.id !== 'ndx').map((s) => s.id).sort());
    const dji = JSON.parse(await readFile(join(dir, 'hist-dji.json'), 'utf8'));
    const gld = JSON.parse(await readFile(join(dir, 'hist-gld.json'), 'utf8'));
    assert.equal(dji.id, 'dji');
    assert.equal(dji.d.length, gld.d.length);
    assert.ok(Math.abs(dji.c[100] - gld.c[100] * 100) < 0.51, 'same synthetic source series, Dow = DJX x 100 (within rounding)');
    await assert.rejects(readFile(join(dir, 'hist-ndx.json'), 'utf8'), /ENOENT/);
  } finally { restore(); }
});

test('run(): a missing per-asset file is retried only after a cool-off, not on every run', async () => {
  const { rm, writeFile } = await import('node:fs/promises');
  const restore = mockFetch(happyHandler());
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    await run(dir, silent);
    await rm(join(dir, 'hist-gld.json'));
    await run(dir, silent); // history is fresh and the file was lost seconds ago: do not hammer the source
    await assert.rejects(readFile(join(dir, 'hist-gld.json'), 'utf8'), /ENOENT/);
    const h = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    h.generated = new Date(Date.now() - 2 * 3_600_000).toISOString(); // two hours old
    await writeFile(join(dir, 'history.json'), JSON.stringify(h));
    await run(dir, silent);
    const back = JSON.parse(await readFile(join(dir, 'hist-gld.json'), 'utf8'));
    assert.equal(back.id, 'gld');
  } finally { restore(); }
});
