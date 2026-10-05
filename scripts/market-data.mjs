#!/usr/bin/env node
// Market data fetcher for the S&P 500 section of the site.
//
//   node scripts/market-data.mjs <outDir>
//
// Writes two small JSON files into <outDir>:
//   live.json     ticker quotes + S&P 500 intraday (1D / 5D) — refreshed on every run
//   history.json  S&P 500 daily closes, full history     — refreshed at most once a day
//
// The GitHub Action in .github/workflows/market-data.yml runs this on a schedule and
// publishes <outDir> to the `data` branch, which the site reads. No API keys needed.
//
// Principles: never write fabricated data, never replace good data with worse data.
// If a source fails the previous file (if any) is kept and the page shows its real age.

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const HISTORY_MAX_AGE_H = 20;

export const SYMBOLS = [
  { id: 'spx', symbol: '^GSPC', name: 'S&P 500' },
  { id: 'ndx', symbol: '^IXIC', name: 'Nasdaq' },
  { id: 'dji', symbol: '^DJI', name: 'Dow Jones' },
  { id: 'rut', symbol: '^RUT', name: 'Russell 2000' },
  { id: 'ibex', symbol: '^IBEX', name: 'IBEX 35' },
  { id: 'sx5e', symbol: '^STOXX50E', name: 'Euro Stoxx 50' },
  { id: 'vix', symbol: '^VIX', name: 'VIX' },
  { id: 'tnx', symbol: '^TNX', name: 'US 10Y', kind: 'yield' },
  { id: 'eurusd', symbol: 'EURUSD=X', name: 'EUR/USD', digits: 4 },
  { id: 'gold', symbol: 'GC=F', name: 'Gold' },
  { id: 'btc', symbol: 'BTC-USD', name: 'Bitcoin' },
];

export const tuning = { retryMs: 800, politeMs: 150 }; // tests set these to 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 2) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// ---------------------------------------------------------------- HTTP

async function getText(url, { tries = 3, accept = '*/*' } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await sleep(tuning.retryMs * (i + 1));
    }
  }
  throw lastErr;
}

async function yahooChart(symbol, range, interval) {
  let lastErr;
  for (const host of YAHOO_HOSTS) {
    const url =
      `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}` +
      `?range=${range}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
    try {
      return parseYahooChart(JSON.parse(await getText(url, { accept: 'application/json', tries: 2 })));
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- parsers (pure, unit-tested)

/** Yahoo v8 chart JSON -> { meta, t: epoch seconds[], c: closes[] } with null closes dropped. */
export function parseYahooChart(json) {
  const err = json?.chart?.error;
  if (err) throw new Error(`Yahoo error: ${err.code || ''} ${err.description || ''}`);
  const r = json?.chart?.result?.[0];
  if (!r || !Array.isArray(r.timestamp) || !r.indicators?.quote?.[0]?.close) {
    throw new Error('Yahoo response has no price series');
  }
  const closes = r.indicators.quote[0].close;
  const t = [];
  const c = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (isNum(closes[i]) && closes[i] > 0 && isNum(r.timestamp[i])) {
      t.push(r.timestamp[i]);
      c.push(closes[i]);
    }
  }
  if (!c.length) throw new Error('Yahoo series is empty');
  return { meta: r.meta || {}, t, c };
}

const dayOf = (ms) => Math.floor(ms / 86_400_000);

/** CSV (Stooq: Date,Open,High,Low,Close,Volume | FRED: DATE,SP500) -> { d: day numbers[], c: closes[] } */
export function parseCsvSeries(text, closeCol) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/date/i.test(lines[0])) throw new Error('Not a CSV price file');
  const d = [];
  const c = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(',');
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cols[0]);
    const v = Number(cols[closeCol]);
    if (!m || !Number.isFinite(v) || v <= 0) continue; // FRED uses "." for holidays
    d.push(dayOf(Date.UTC(+m[1], +m[2] - 1, +m[3])));
    c.push(v);
  }
  return { d, c };
}

/** Build one ticker quote from a short daily Yahoo series. */
export function buildQuote(def, chart) {
  const { meta, t } = chart;
  let { c } = chart;
  let price = isNum(meta.regularMarketPrice) ? meta.regularMarketPrice : c[c.length - 1];
  // ^TNX has historically been quoted as yield x10; normalise to percent.
  const scale = def.kind === 'yield' && price > 20 ? 0.1 : 1;
  price *= scale;
  c = c.map((x) => x * scale);

  const time = isNum(meta.regularMarketTime) ? meta.regularMarketTime : t[t.length - 1];
  const off = isNum(meta.gmtoffset) ? meta.gmtoffset : 0;
  const dayKey = (ts) => Math.floor((ts + off) / 86_400);
  const today = dayKey(time);
  let prev = null;
  for (let i = t.length - 1; i >= 0; i--) {
    if (dayKey(t[i]) < today) {
      prev = c[i];
      break;
    }
  }
  if (prev == null) prev = (meta.chartPreviousClose ?? meta.previousClose ?? c[0]) * scale;
  const digits = def.digits ?? 2;
  const spark = c.slice(-30);
  return {
    id: def.id,
    symbol: def.symbol,
    name: def.name,
    kind: def.kind || 'price',
    price: round(price, digits),
    prev: round(prev, digits),
    change: round(price - prev, digits),
    pct: round(((price - prev) / prev) * 100, 3),
    time,
    spark: spark.map((x) => round(x, digits)),
    digits,
  };
}

function series(chart, digits = 2) {
  return { t: chart.t, c: chart.c.map((x) => round(x, digits)) };
}

function validateHistory(h, source) {
  if (!h || h.c.length < 1000) throw new Error(`${source}: history too short (${h?.c.length ?? 0})`);
  const ageDays = Date.now() / 86_400_000 - h.d[h.d.length - 1];
  if (ageDays > 12) throw new Error(`${source}: history is stale (${ageDays.toFixed(0)} days old)`);
  for (let i = 1; i < h.d.length; i++) {
    if (h.d[i] <= h.d[i - 1]) throw new Error(`${source}: dates not increasing at index ${i}`);
  }
  return h;
}

// ---------------------------------------------------------------- sources

async function historyFromYahoo() {
  const ch = await yahooChart('^GSPC', 'max', '1d');
  const d = [];
  const c = [];
  for (let i = 0; i < ch.t.length; i++) {
    const day = dayOf(ch.t[i] * 1000);
    if (d.length && day <= d[d.length - 1]) {
      c[c.length - 1] = ch.c[i]; // same day twice (live bar): keep the latest
      continue;
    }
    d.push(day);
    c.push(ch.c[i]);
  }
  return validateHistory({ d, c: c.map((x) => round(x, 2)) }, 'yahoo');
}

async function historyFromStooq() {
  const text = await getText('https://stooq.com/q/d/l/?s=%5Espx&i=d');
  const h = parseCsvSeries(text, 4);
  return validateHistory({ d: h.d, c: h.c.map((x) => round(x, 2)) }, 'stooq');
}

async function historyFromFred() {
  const text = await getText('https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500');
  const h = parseCsvSeries(text, 1);
  return validateHistory({ d: h.d, c: h.c.map((x) => round(x, 2)) }, 'fred');
}

async function fetchHistory(log) {
  const sources = [
    ['yahoo', historyFromYahoo],
    ['stooq', historyFromStooq],
    ['fred', historyFromFred],
  ];
  for (const [name, fn] of sources) {
    try {
      const h = await fn();
      log(`history: ${name} ok (${h.c.length} points, last close ${h.c[h.c.length - 1]})`);
      return { source: name, ...h };
    } catch (err) {
      log(`history: ${name} failed — ${err.message}`);
    }
  }
  return null;
}

// ---------------------------------------------------------------- main

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const stable = (o) => JSON.stringify(o, (k, v) => (k === 'generated' ? undefined : v));

export async function run(outDir, log = console.log) {
  await mkdir(outDir, { recursive: true });
  const prevLive = await readJson(join(outDir, 'live.json'));
  const prevHist = await readJson(join(outDir, 'history.json'));
  const now = new Date();
  let changed = false;

  // ---- history (S&P 500 daily) — at most once a day, or when missing
  let hist = prevHist;
  const histAgeH = prevHist ? (now - new Date(prevHist.generated)) / 3_600_000 : Infinity;
  if (!prevHist || histAgeH > HISTORY_MAX_AGE_H || process.env.FORCE_HISTORY) {
    const fresh = await fetchHistory(log);
    if (fresh) {
      hist = {
        v: 1,
        symbol: '^GSPC',
        name: 'S&P 500',
        source: fresh.source,
        generated: now.toISOString(),
        d: fresh.d,
        c: fresh.c,
      };
      // Never replace a longer history with a shorter one from a fallback source.
      if (prevHist && prevHist.d.length > hist.d.length + 50) {
        log(`history: keeping previous (${prevHist.d.length} pts) over ${hist.source} (${hist.d.length} pts)`);
        hist = prevHist;
      } else {
        // Always persist a fresh pull (it carries the new `generated` stamp that gates the
        // next refresh); this happens at most once a day, so publishing it is cheap.
        await writeFile(join(outDir, 'history.json'), JSON.stringify(hist));
        changed = true;
      }
    }
  } else {
    log(`history: fresh enough (${histAgeH.toFixed(1)} h old), skipping`);
  }

  // ---- live quotes
  const quotes = [];
  let source = 'yahoo';
  for (const def of SYMBOLS) {
    try {
      const ch = await yahooChart(def.symbol, '1mo', '1d');
      quotes.push(buildQuote(def, ch));
      log(`quote: ${def.symbol} ${quotes[quotes.length - 1].price}`);
    } catch (err) {
      log(`quote: ${def.symbol} failed — ${err.message}`);
      const old = prevLive?.quotes?.find((q) => q.id === def.id);
      if (old) quotes.push(old); // keep last known, with its own (real) timestamp
    }
    await sleep(tuning.politeMs);
  }

  // ---- S&P 500 intraday
  let spx = prevLive?.spx || null;
  try {
    const day = await yahooChart('^GSPC', '1d', '5m');
    const week = await yahooChart('^GSPC', '5d', '15m');
    const m = day.meta;
    const reg = m.currentTradingPeriod?.regular;
    spx = {
      session: reg ? { start: reg.start, end: reg.end } : null,
      dayHigh: round(m.regularMarketDayHigh),
      dayLow: round(m.regularMarketDayLow),
      high52: round(m.fiftyTwoWeekHigh),
      low52: round(m.fiftyTwoWeekLow),
      intraday: series(day),
      week: series(week),
    };
    log(`intraday: ${day.c.length} x 5m, ${week.c.length} x 15m`);
  } catch (err) {
    log(`intraday: failed — ${err.message}`);
  }

  // ---- if Yahoo gave us nothing for the S&P but we have history, derive an end-of-day quote
  if (!quotes.some((q) => q.id === 'spx') && hist && hist.c.length > 2) {
    const n = hist.c.length;
    const price = hist.c[n - 1];
    const prev = hist.c[n - 2];
    quotes.unshift({
      id: 'spx', symbol: '^GSPC', name: 'S&P 500', kind: 'price',
      price, prev, change: round(price - prev), pct: round(((price - prev) / prev) * 100, 3),
      time: Math.floor(hist.d[n - 1] * 86_400 + 21 * 3600), // ~close, informational only
      spark: hist.c.slice(-30), digits: 2,
    });
    source = hist.source;
  }

  if (!quotes.length && !hist) throw new Error('No market data could be fetched from any source');

  const live = { v: 1, generated: now.toISOString(), source, quotes, spx };
  if (stable(prevLive) !== stable(live)) {
    await writeFile(join(outDir, 'live.json'), JSON.stringify(live));
    changed = true;
  }
  log(changed ? 'result: data changed' : 'result: no change');
  return { changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2] || 'out';
  run(out)
    .then(async ({ changed }) => {
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
