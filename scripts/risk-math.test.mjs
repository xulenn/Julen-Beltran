// Run with: node --test scripts/risk-math.test.mjs
// Series below have answers that can be worked out by hand, plus brute-force cross-checks, so a
// regression in the Risk lab's maths shows up here instead of as a quietly wrong number on the site.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { percentile, holding, drawdowns, bestDays, erfc, Phi, tails, seasonality } = createRequire(import.meta.url)('../assets/js/risk-math.js');

const close = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} expected ${b}, got ${a}`);

// small seeded generator so the "random" tests are reproducible
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
function normal(r) { return Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); }
const series = (returns, start = 100) => { const c = [start]; for (const x of returns) c.push(c[c.length - 1] * (1 + x)); return { d: c.map((_, i) => i), c }; };

test('percentile interpolates linearly (same convention as numpy)', () => {
  const a = Float64Array.from([1, 2, 3, 4]);
  close(percentile(a, 0.5), 2.5);
  close(percentile(a, 0.1), 1.3);
  close(percentile(a, 0), 1);
  close(percentile(a, 1), 4);
});

test('erfc matches reference values, including far in the tail', () => {
  const ref = [[0, 1], [1, 0.15729920705028513], [2, 0.004677734981047266], [3, 2.209049699858544e-5], [5, 1.5374597944280347e-12], [-1, 1.8427007929497148]];
  for (const [x, v] of ref) assert.ok(Math.abs(erfc(x) - v) <= 1.5e-7 * Math.abs(v), `erfc(${x})`);
  close(Phi(0), 0.5, 2e-7); // the approximation is good to ~1.2e-7 relative
  assert.ok(Math.abs(Phi(1.959964) - 0.975) < 1e-6);
});

test('steady growth: every window returns the same annualized rate, nothing ever loses money', () => {
  const d = Array.from({ length: 365 * 30 }, (_, i) => i);
  const c = d.map((x) => 100 * Math.pow(1.1, x / 365.25));
  for (const H of [1, 5, 20]) {
    const h = holding(d, c, H);
    close(h.median, 0.1, 1e-9, `median ${H}y`);
    close(h.p10, 0.1, 1e-9);
    close(h.p90, 0.1, 1e-9);
    assert.equal(h.lossShare, 0);
  }
  assert.deepEqual(drawdowns(d, c), []);
});

test('steadily falling market: every window is a loss', () => {
  const d = Array.from({ length: 2000 }, (_, i) => i);
  const c = d.map((x) => 100 * Math.pow(0.9998, x));
  assert.equal(holding(d, c, 1).lossShare, 1);
  assert.ok(holding(d, c, 1).best < 0);
});

test('drawdowns: depth, trough and recovery dates, filtering, and an unrecovered decline', () => {
  // up to 100 (day 100), down to 50 (day 200), back to 100 (day 400), a 5% dip, up to 120 (day 600), down to 90 (day 700, never recovered)
  const pts = [[0, 80], [100, 100], [200, 50], [400, 100], [450, 95], [500, 100], [600, 120], [700, 90]];
  const d = [], c = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [x0, y0] = pts[k], [x1, y1] = pts[k + 1];
    for (let x = x0; x < x1; x++) { d.push(x); c.push(y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)); }
  }
  d.push(700); c.push(90);
  const eps = drawdowns(d, c, 0.1);
  assert.equal(eps.length, 2, 'the 5% dip is filtered out');
  assert.equal(eps[0].peak, 100); assert.equal(eps[0].trough, 200); assert.equal(eps[0].recovered, 400); close(eps[0].depth, -0.5);
  assert.equal(eps[1].peak, 600); assert.equal(eps[1].trough, 700); assert.equal(eps[1].recovered, null); close(eps[1].depth, -0.25);
  assert.equal(drawdowns(d, c, 0.04).length, 3, 'a lower threshold picks up the dip');
});

test('bestDays equals a brute-force calculation, and clustering is counted correctly', () => {
  const r = rng(7);
  const rets = Array.from({ length: 800 }, () => normal(r) * 0.01);
  const { d, c } = series(rets);
  const R = bestDays(d, c, null);
  const order = rets.map((_, k) => k).sort((a, b) => rets[b] - rets[a]);
  const worst = rets.map((_, k) => k).sort((a, b) => rets[a] - rets[b]).slice(0, 10);
  const brute = (N) => { let v = 10000; const skip = new Set(order.slice(0, N)); rets.forEach((x, k) => { if (!skip.has(k)) v *= 1 + x; }); return v; };
  [0, 5, 10, 20, 30].forEach((N, i) => close(R.values[i].v, brute(N), 1e-9, `N=${N}`));
  assert.equal(R.days, 800);
  assert.equal(R.clustered, order.slice(0, 10).filter((k) => worst.some((w) => Math.abs(w - k) <= 15)).length);
  // missing best days always costs money; missing more costs more
  for (let i = 1; i < R.values.length; i++) assert.ok(R.values[i].v < R.values[i - 1].v);
});

test('bestDays windowing: a "last N years" window only uses that span', () => {
  const d = Array.from({ length: 365 * 40 }, (_, i) => i);
  const c = d.map((x) => 100 * Math.pow(1.05, x / 365.25));
  const w10 = bestDays(d, c, 10);
  assert.ok(Math.abs(w10.years - 10) < 0.05);
  close(w10.values[0].v, 10000 * Math.pow(1.05, w10.years), 1e-6);
});

test('tails: a normal sample looks normal; a fat-tailed one does not', () => {
  const r = rng(42);
  const N = 120_000;
  const mk = (gen) => { const d = [0], c = [100]; for (let i = 1; i <= N; i++) { d.push(i); c.push(c[i - 1] * (1 + gen() / 100)); } return { d, c }; };
  const norm = tails(...Object.values(mk(() => normal(r))));
  assert.ok(Math.abs(norm.kurtosis) < 0.25, `kurtosis ${norm.kurtosis}`);
  const b3 = norm.beyond[0];
  assert.ok(Math.abs(b3.observed - b3.expected) / b3.expected < 0.12, `3σ ${b3.observed} vs ${b3.expected}`);
  assert.equal(norm.counts.reduce((a, b) => a + b, 0), N);
  close(norm.expected.reduce((a, b) => a + b, 0), N, 1e-6);

  // 97% quiet days, 3% days with 4x the volatility
  const fat = tails(...Object.values(mk(() => normal(r) * (r() < 0.03 ? 4 : 1))));
  assert.ok(fat.kurtosis > 3, `kurtosis ${fat.kurtosis}`);
  assert.ok(fat.beyond[1].observed > 10 * fat.beyond[1].expected, '4σ days are far more common than a bell curve predicts');
  assert.ok(fat.worst.r < -8 && fat.best.r > 8);
});

// Daily series whose month-end closes follow `ret(y, m)`, with deliberately noisy closes in between
// (the intermediate days must not influence a month-end to month-end return).
function monthlySeries(y0, y1, ret) {
  const d = [], c = [];
  let px = 100;
  for (let y = y0; y <= y1; y++) {
    for (let m = 0; m < 12; m++) {
      const endDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
      const days = [2, 15, endDay];
      const start = px;
      days.forEach((dd, k) => {
        d.push(Date.UTC(y, m, dd) / 86400000);
        if (k === days.length - 1) { if (!(y === y0 && m === 0)) px = start * (1 + ret(y, m)); c.push(px); }
        else c.push(start * (k ? 0.5 : 1.9)); // noise
      });
    }
  }
  return { d, c };
}

test('seasonality: month-end returns, first month dropped, latest month flagged and excluded from the stats', () => {
  const a = (m) => (m - 5.5) / 100; // each calendar month has its own mean: -5.5% .. +5.5%
  const wob = (y) => (y % 2 ? 0.01 : -0.01); // alternate years so the standard deviation is known
  const S = monthlySeries(1980, 1999, (y, m) => a(m) + wob(y));
  const R = seasonality(S.d, S.c);
  assert.equal(R.y0, 1980);
  assert.equal(R.y1, 1999);
  assert.equal(R.grid.length, 20);
  assert.equal(R.grid[0][0], null, 'January 1980 has no earlier month-end to measure from');
  assert.equal(R.monthly.length, 20 * 12 - 1);
  assert.equal(R.last.y, 1999);
  assert.equal(R.last.m, 11);
  assert.equal(R.last.partial, true);
  close(R.grid[1][3].r, a(3) + wob(1981), 1e-9, 'April 1981');
  assert.equal(R.grid[19][11].partial, true);
  R.months.forEach((x, m) => {
    const n = m === 0 ? 19 : m === 11 ? 19 : 20; // January 1980 and the partial December 1999 are out
    assert.equal(x.n, n, `n for month ${m}`);
    if (m !== 0 && m !== 11) {
      close(x.mean, a(m), 1e-9, `mean ${m}`);
      close(x.median, a(m), 1e-9, `median ${m}`);
      close(x.sd, 0.01 * Math.sqrt(20 / 19), 1e-9, `sd ${m}`);
      close(x.se, x.sd / Math.sqrt(20), 1e-12);
      close(x.hi - x.lo, 2 * 1.96 * x.se, 1e-12);
      close(x.best.r, a(m) + 0.01, 1e-9);
      close(x.worst.r, a(m) - 0.01, 1e-9);
      assert.equal(x.up, a(m) - 0.01 > 0 ? 1 : a(m) + 0.01 < 0 ? 0 : 0.5);
    }
  });
  assert.equal(R.all.n, 20 * 12 - 2);
  // the two excluded months are January 1980 (no return) and December 1999 (partial); the means cancel out to ~0
  assert.ok(Math.abs(R.all.mean) < 0.002);
});

test('seasonality: a month with a real edge stands out, an iid world does not', () => {
  // 40 years in which every December earns +4% and every other month is zero-mean noise with the same size
  const r = rng(7);
  const S = monthlySeries(1970, 2009, (y, m) => (m === 11 ? 0.04 : 0) + normal(r) * 0.01);
  const R = seasonality(S.d, S.c);
  assert.ok(R.months[11].mean > 0.035 && R.months[11].lo > R.all.mean, 'December clearly above the average');
  assert.ok(R.exceed >= 1);
  const quiet = monthlySeries(1970, 2009, () => normal(r) * 0.04);
  const Q = seasonality(quiet.d, quiet.c);
  assert.ok(Q.exceed <= 3, `a world with no seasonality flagged ${Q.exceed} months`);
  // every cell's colour bucket depends only on its own return
  assert.equal(Q.monthly.filter((e) => e.partial).length, 1);
});

test('seasonality: a gap in the data is not turned into a fake monthly return', () => {
  const S = monthlySeries(1990, 1993, () => 0.01);
  // delete all of March 1991 (day numbers inside that month)
  const lo = Date.UTC(1991, 2, 1) / 86400000, hi = Date.UTC(1991, 3, 1) / 86400000;
  const keep = S.d.map((x) => x < lo || x >= hi);
  const d = S.d.filter((_, i) => keep[i]), c = S.c.filter((_, i) => keep[i]);
  const R = seasonality(d, c);
  assert.equal(R.grid[1][2], null, 'March 1991 is missing');
  assert.equal(R.grid[1][3], null, 'April 1991 spans the gap, so it has no valid return either');
  assert.ok(R.grid[1][4] && Math.abs(R.grid[1][4].r - 0.01) < 1e-9);
});
