#!/usr/bin/env node
// Market data fetcher for the S&P 500 section of the site.
//
//   node scripts/market-data.mjs <outDir>
//
// Source: Cboe's public delayed-quote CDN (the JSON behind cboe.com's own quote pages).
// It needs no API key and — unlike Yahoo, Stooq or FRED — answers requests from GitHub's
// runners. Data is delayed ~15 minutes. Files written to <outDir>:
//
//   live.json      ticker quotes + the S&P 500's latest session at 1-minute resolution
//   history.json   S&P 500 daily closes since 1975, plus 30-day sparklines for the ticker
//   hist-<id>.json daily closes for every other asset in the ticker (chart switcher + compare mode)
//   sessions.json  last few sessions at 5-minute resolution (feeds the 5-day view; Cboe only
//                  serves the latest session, so this file accumulates day by day)
//
// The GitHub Action in .github/workflows/market-data.yml runs this on a schedule and
// publishes <outDir> to the `data` branch, which the site reads.
//
// Principles: never write fabricated data, never replace good data with worse data. If a
// request fails, the previous value is kept and the page shows its real timestamp.

import { mkdir, readFile, writeFile, appendFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'https://cdn.cboe.com/api/global/delayed_quotes';
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HISTORY_MAX_AGE_H = 20;
const KEEP_SESSIONS = 6;
const RETRY_MISSING_AFTER_H = 1.5; // a missing per-asset file triggers a retry, but not on every 10-minute run

/** `scale` converts Cboe's value to the headline value (DJX is 1/100th of the Dow). */
export const SYMBOLS = [
  { id: 'spx', sym: '_SPX', name: 'S&P 500', digits: 2 },
  { id: 'ndx', sym: '_NDX', name: 'Nasdaq-100', digits: 2, noHistory: true },
  { id: 'dji', sym: '_DJX', name: 'Dow Jones', digits: 0, scale: 100 },
  { id: 'rut', sym: '_RUT', name: 'Russell 2000', digits: 2 },
  { id: 'vix', sym: '_VIX', name: 'VIX', digits: 2, invert: true },
  { id: 'gld', sym: 'GLD', name: 'Gold · GLD', digits: 2 },
  { id: 'tlt', sym: 'TLT', name: '20Y Treasuries · TLT', digits: 2 },
  { id: 'ibit', sym: 'IBIT', name: 'Bitcoin · IBIT', digits: 2 },
  { id: 'ezu', sym: 'EZU', name: 'Eurozone · EZU', digits: 2 },
  { id: 'ewp', sym: 'EWP', name: 'Spain · EWP', digits: 2 },
];

export const tuning = { retryMs: 800, politeMs: 120 }; // tests set these to 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 2) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

// ---------------------------------------------------------------- time (America/New_York)

const NY = 'America/New_York';
function tzOffsetMs(utcMs) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: NY, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}

/** 'YYYY-MM-DDTHH:MM:SS' wall-clock time in New York -> epoch seconds (DST-aware). */
export function etToEpoch(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s));
  if (!m) throw new Error(`Bad ET timestamp: ${s}`);
  const [Y, M, D, h, mi] = m.slice(1, 6).map(Number);
  const sec = Number(m[6] || 0);
  const wall = Date.UTC(Y, M - 1, D, h, mi, sec);
  let guess = wall - tzOffsetMs(wall);
  guess = wall - tzOffsetMs(guess); // second pass settles the DST edge cases
  return Math.floor(guess / 1000);
}

// ---------------------------------------------------------------- HTTP

async function getJson(path, { tries = 3 } = {}) {
  const url = `${BASE}/${path}`;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 403 || res.status === 404) throw Object.assign(new Error(`HTTP ${res.status} for ${path}`), { fatal: true });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await sleep(tuning.retryMs * (i + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- parsers (pure, unit-tested)

/** historical/<sym>.json -> { d: day numbers[], c: closes[] } (ascending, positive closes only) */
export function parseHistory(json) {
  const rows = json?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('History response has no rows');
  const d = [];
  const c = [];
  for (const r of rows) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r?.date ?? '');
    const close = Number(r?.close);
    if (!m || !Number.isFinite(close) || close <= 0) continue;
    const day = dayNum(+m[1], +m[2], +m[3]);
    if (d.length && day <= d[d.length - 1]) continue;
    d.push(day);
    c.push(close);
  }
  if (!c.length) throw new Error('History has no usable closes');
  return { d, c, upstream: json.timestamp ?? null };
}

/** quotes/<sym>.json -> { price, change, pct, prev, time }. The options chain is ignored. */
export function parseQuote(json) {
  const q = json?.data;
  const price = Number(q?.current_price);
  const change = Number(q?.price_change);
  const pct = Number(q?.price_change_percent);
  if (!q || !Number.isFinite(price) || price <= 0 || !Number.isFinite(change) || !Number.isFinite(pct)) {
    throw new Error('Quote response is missing price fields');
  }
  // `prev_day_close` is overwritten with today's close after the bell, so derive the
  // reference close from the change instead.
  return { price, change, pct, prev: price - change, time: etToEpoch(q.last_trade_time) };
}

/** intraday/<sym>.json -> { date, t: epoch s[], c: closes[] } for the most recent session only. */
export function parseIntraday(json) {
  const rows = json?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Intraday response has no rows');
  const latest = rows.reduce((a, r) => (r.datetime > a ? r.datetime : a), '').slice(0, 10);
  const t = [];
  const c = [];
  for (const r of rows) {
    if (!r.datetime?.startsWith(latest)) continue;
    const close = Number(r.price?.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const ts = etToEpoch(r.datetime);
    if (t.length && ts <= t[t.length - 1]) continue;
    t.push(ts);
    c.push(close);
  }
  if (t.length < 10) throw new Error(`Intraday session ${latest} has too few bars (${t.length})`);
  return { date: latest, t, c };
}

/** Keep one point per 5 minutes (plus the last) to keep archived sessions small. */
export function downsample5(t, c) {
  const ot = [];
  const oc = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] % 300 === 0 || i === t.length - 1 || i === 0) {
      ot.push(t[i]);
      oc.push(round(c[i], 2));
    }
  }
  return { t: ot, c: oc };
}

export function buildQuote(def, q, spark) {
  const k = def.scale ?? 1;
  const digits = def.digits ?? 2;
  return {
    id: def.id,
    symbol: def.sym.replace('_', '^'),
    name: def.name,
    price: round(q.price * k, digits),
    prev: round(q.prev * k, digits),
    change: round(q.change * k, digits),
    pct: round(q.pct, 3),
    time: q.time,
    digits,
    ...(def.invert ? { invert: true } : {}),
    spark: (spark || []).map((x) => round(x * k, digits)),
  };
}

// ---------------------------------------------------------------- main

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}
const stable = (o) => JSON.stringify(o, (key, v) => (key === 'generated' ? undefined : v));

export async function run(outDir, log = console.log) {
  await mkdir(outDir, { recursive: true });
  const prevLive = await readJson(join(outDir, 'live.json'));
  const prevHist = await readJson(join(outDir, 'history.json'));
  const prevSess = await readJson(join(outDir, 'sessions.json'));
  const now = new Date();
  const nowSec = Math.floor(now / 1000);
  let changed = false;
  let failures = 0;

  // ---- daily history (S&P 500 + every other asset) and sparklines — at most once a day
  const exists = (f) => access(join(outDir, f)).then(() => true, () => false);
  const histFile = (def) => (def.id === 'spx' ? 'history.json' : `hist-${def.id}.json`);
  const withHistory = SYMBOLS.filter((x) => !x.noHistory);
  const missing = [];
  for (const def of withHistory) if (!(await exists(histFile(def)))) missing.push(def.id);
  let hist = prevHist;
  const age = prevHist ? (now - new Date(prevHist.generated)) / 3_600_000 : Infinity;
  if (!prevHist || age > HISTORY_MAX_AGE_H || process.env.FORCE_HISTORY || (missing.length && age > RETRY_MISSING_AFTER_H)) {
    try {
      const h = parseHistory(await getJson('charts/historical/_SPX.json'));
      const sparks = { ...(prevHist?.sparks || {}) };
      for (const def of withHistory) {
        try {
          const s = def.id === 'spx' ? h : parseHistory(await getJson(`charts/historical/${def.sym}.json`));
          sparks[def.id] = s.c.slice(-30).map((x) => round(x, 4));
          if (def.id !== 'spx') {
            const k = def.scale ?? 1;
            await writeFile(join(outDir, histFile(def)), JSON.stringify({
              v: 1, id: def.id, symbol: def.sym.replace('_', '^'), name: def.name, source: 'cboe', generated: now.toISOString(),
              d: s.d, c: s.c.map((x) => round(x * k, 2)),
            }));
          }
        } catch (err) {
          log(`history ${def.sym}: ${err.message}${(await exists(histFile(def))) ? ' (keeping previous file)' : ''}`);
        }
        await sleep(tuning.politeMs);
      }
      hist = { v: 1, symbol: '^SPX', name: 'S&P 500', source: 'cboe', generated: now.toISOString(), upstream: h.upstream, d: h.d, c: h.c.map((x) => round(x, 2)), sparks };
      await writeFile(join(outDir, 'history.json'), JSON.stringify(hist));
      changed = true; // a fresh pull carries the `generated` stamp that gates the next one
      log(`history: ${h.c.length} daily closes, ${h.d.length ? new Date(h.d[0] * 86_400_000).toISOString().slice(0, 10) : '?'} → last ${h.c[h.c.length - 1]}`);
    } catch (err) {
      failures++;
      log(`history: failed — ${err.message}${prevHist ? ' (keeping previous)' : ''}`);
    }
  } else {
    log(`history: fresh enough (${age.toFixed(1)} h old)`);
  }
  // which assets can the chart switch to? (ids with a history file on disk)
  const histories = [];
  for (const def of withHistory) if (await exists(histFile(def))) histories.push(def.id);

  // ---- quotes
  const quotes = [];
  for (const def of SYMBOLS) {
    try {
      const q = parseQuote(await getJson(`quotes/${def.sym}.json`));
      const spark = hist?.sparks?.[def.id] ?? prevLive?.quotes?.find((x) => x.id === def.id)?.spark?.map((x) => x / (def.scale ?? 1));
      quotes.push(buildQuote(def, q, spark));
    } catch (err) {
      failures++;
      log(`quote ${def.sym}: failed — ${err.message}`);
      const old = prevLive?.quotes?.find((x) => x.id === def.id);
      if (old) quotes.push(old);
    }
    await sleep(tuning.politeMs);
  }
  log(`quotes: ${quotes.length}/${SYMBOLS.length}${quotes[0] ? `, S&P 500 ${quotes.find((x) => x.id === 'spx')?.price}` : ''}`);

  // ---- S&P 500 latest session
  let spx = prevLive?.spx ?? null;
  const sessions = { ...(prevSess?.sessions || {}) };
  try {
    const day = parseIntraday(await getJson('charts/intraday/_SPX.json'));
    const open = etToEpoch(`${day.date}T09:30:00`);
    const close = etToEpoch(`${day.date}T16:00:00`);
    const last = day.t[day.t.length - 1];
    const inProgress = nowSec - last < 1800 && nowSec < close + 1800;
    const spxQuote = quotes.find((x) => x.id === 'spx');
    spx = {
      date: day.date,
      session: { start: open, end: inProgress ? close : Math.max(last + 60, open + 3600) },
      prev: spxQuote ? spxQuote.prev : null,
      intraday: { t: day.t, c: day.c.map((x) => round(x, 2)) },
    };
    sessions[day.date] = downsample5(day.t, day.c);
    log(`intraday: ${day.date}, ${day.t.length} one-minute bars`);
  } catch (err) {
    failures++;
    log(`intraday: failed — ${err.message}`);
  }
  const keep = Object.keys(sessions).sort().slice(-KEEP_SESSIONS);
  const sessOut = { v: 1, generated: now.toISOString(), sessions: Object.fromEntries(keep.map((k) => [k, sessions[k]])) };
  if (stable(prevSess) !== stable(sessOut) && keep.length) {
    await writeFile(join(outDir, 'sessions.json'), JSON.stringify(sessOut));
    changed = true;
  }

  if (!quotes.length && !hist) throw new Error('No market data could be fetched');

  const live = { v: 1, generated: now.toISOString(), source: 'cboe', quotes, spx, histories };
  if (stable(prevLive) !== stable(live)) {
    await writeFile(join(outDir, 'live.json'), JSON.stringify(live));
    changed = true;
  }
  log(changed ? `result: data changed (${failures} request failure${failures === 1 ? '' : 's'})` : 'result: no change');
  return { changed, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2] || 'out')
    .then(async ({ changed }) => {
      if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
