// Run with: node --test scripts/
// Fixtures mimic the real response shapes of Yahoo's v8 chart API and Stooq/FRED CSVs.
// They are generated in-memory and never written to the repo or shown on the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseYahooChart, parseCsvSeries, buildQuote, run, tuning } from './market-data.mjs';

tuning.retryMs = 0;
tuning.politeMs = 0;
const silent = () => {};

function yahooJson({ n, stepSec, endTs, base = 5000, gmtoffset = -14400, price, nulls = [] }) {
  const timestamp = [];
  const close = [];
  for (let i = 0; i < n; i++) {
    timestamp.push(endTs - (n - 1 - i) * stepSec);
    close.push(nulls.includes(i) ? null : base + Math.sin(i / 9) * 40 + i * 0.5);
  }
  return {
    chart: {
      error: null,
      result: [{
        meta: {
          symbol: '^GSPC', gmtoffset, regularMarketTime: endTs,
          regularMarketPrice: price ?? close[n - 1],
          chartPreviousClose: close[0], regularMarketDayHigh: base + 60, regularMarketDayLow: base - 60,
          fiftyTwoWeekHigh: base + 200, fiftyTwoWeekLow: base - 900,
          currentTradingPeriod: { regular: { start: endTs - 20_000, end: endTs + 5_000, gmtoffset } },
        },
        timestamp,
        indicators: { quote: [{ open: close, high: close, low: close, close, volume: close.map(() => 1) }] },
      }],
    },
  };
}

test('parseYahooChart drops null closes and rejects error payloads', () => {
  const p = parseYahooChart(yahooJson({ n: 10, stepSec: 300, endTs: 1_800_000_000, nulls: [2, 3] }));
  assert.equal(p.c.length, 8);
  assert.equal(p.t.length, 8);
  assert.throws(() => parseYahooChart({ chart: { error: { code: 'Not Found', description: 'nope' } } }), /Not Found/);
  assert.throws(() => parseYahooChart({}), /no price series/);
});

test('buildQuote uses the previous trading day as the reference close', () => {
  const day = 86_400;
  const end = Math.floor(Date.UTC(2026, 9, 5, 14, 30) / 1000); // "today" 10:30 NY
  const t = [end - 2 * day, end - day, end];
  const chart = { meta: { regularMarketPrice: 110, regularMarketTime: end, gmtoffset: -14400 }, t, c: [98, 100, 108] };
  const q = buildQuote({ id: 'x', symbol: 'X', name: 'X' }, chart);
  assert.equal(q.prev, 100);
  assert.equal(q.price, 110);
  assert.equal(q.change, 10);
  assert.equal(q.pct, 10);
});

test('buildQuote normalises a x10 yield quote', () => {
  const end = 1_800_000_000;
  const chart = { meta: { regularMarketPrice: 42.5, regularMarketTime: end, gmtoffset: 0 }, t: [end - 86_400 * 2, end - 86_400, end], c: [41, 42, 42.5] };
  const q = buildQuote({ id: 'tnx', symbol: '^TNX', name: 'US 10Y', kind: 'yield' }, chart);
  assert.equal(q.price, 4.25);
});

test('parseCsvSeries handles Stooq and FRED layouts (and FRED holidays)', () => {
  const stooq = 'Date,Open,High,Low,Close,Volume\n1950-01-03,16.66,16.66,16.66,16.66,1260000\n1950-01-04,16.85,16.85,16.85,16.85,1890000\n';
  const s = parseCsvSeries(stooq, 4);
  assert.deepEqual(s.c, [16.66, 16.85]);
  assert.equal(s.d[1] - s.d[0], 1);
  const fred = 'observation_date,SP500\n2025-01-01,.\n2025-01-02,5868.55\n';
  const f = parseCsvSeries(fred, 1);
  assert.deepEqual(f.c, [5868.55]);
  assert.throws(() => parseCsvSeries('Get your apikey at ...', 4), /Not a CSV/);
});

function mockFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => handler(String(url));
  return () => (globalThis.fetch = real);
}
const ok = (body, type = 'application/json') => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': type } });

test('run(): full happy path writes live.json and history.json', async () => {
  const now = Math.floor(Date.now() / 1000);
  const restore = mockFetch((url) => {
    if (url.includes('range=max')) return ok(yahooJson({ n: 2500, stepSec: 86_400, endTs: now, base: 3000 }));
    if (url.includes('range=1mo')) return ok(yahooJson({ n: 21, stepSec: 86_400, endTs: now }));
    if (url.includes('interval=5m')) return ok(yahooJson({ n: 78, stepSec: 300, endTs: now }));
    if (url.includes('interval=15m')) return ok(yahooJson({ n: 130, stepSec: 900, endTs: now }));
    return new Response('nope', { status: 404 });
  });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    const { changed } = await run(dir, silent);
    assert.equal(changed, true);
    const live = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
    const hist = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    assert.equal(hist.d.length, hist.c.length);
    assert.ok(hist.c.length >= 1000);
    assert.ok(live.quotes.length >= 10);
    assert.equal(live.quotes[0].id, 'spx');
    assert.ok(live.spx.intraday.c.length > 10 && live.spx.week.c.length > 10);
    assert.ok(live.spx.session.end > live.spx.session.start);
    // second run: history is fresh, live data identical -> no change
    const again = await run(dir, silent);
    assert.equal(again.changed, false);
  } finally { restore(); }
});

test('run(): Yahoo down -> history falls back to Stooq and S&P quote is derived (end-of-day)', async () => {
  const lines = ['Date,Open,High,Low,Close,Volume'];
  const today = Math.floor(Date.now() / 86_400_000);
  for (let i = 1600; i >= 0; i--) {
    const d = new Date((today - i) * 86_400_000).toISOString().slice(0, 10);
    const c = (3000 + (1600 - i) * 0.9).toFixed(2);
    lines.push(`${d},${c},${c},${c},${c},1`);
  }
  const restore = mockFetch((url) => {
    if (url.includes('yahoo')) return new Response('forbidden', { status: 403 });
    if (url.includes('stooq')) return ok(lines.join('\n'), 'text/csv');
    return new Response('nope', { status: 404 });
  });
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    const { changed } = await run(dir, silent);
    assert.equal(changed, true);
    const hist = JSON.parse(await readFile(join(dir, 'history.json'), 'utf8'));
    const live = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'));
    assert.equal(hist.source, 'stooq');
    assert.equal(live.source, 'stooq');
    assert.equal(live.quotes.length, 1);
    assert.equal(live.quotes[0].id, 'spx');
    assert.equal(live.spx, null);
  } finally { restore(); }
});

test('run(): everything down and nothing cached -> fails loudly instead of writing fake data', async () => {
  const restore = mockFetch(() => new Response('down', { status: 503 }));
  try {
    const dir = await mkdtemp(join(tmpdir(), 'md-'));
    await assert.rejects(run(dir, silent), /No market data/);
  } finally { restore(); }
});
