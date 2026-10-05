/* Risk maths for the "Risk lab" section: pure functions over a daily price series.
   `d` = day numbers (days since 1970-01-01), `c` = closing prices, both ascending.
   Loaded as a classic script in the browser (window.RiskMath) and via require() in the unit tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RiskMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
    const percentile = (sorted, p) => {
      const pos = (sorted.length - 1) * p;
      const lo = Math.floor(pos);
      const hi = Math.ceil(pos);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    };
    const firstGE = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };

    /** Every possible start date: what happened if you held for `years`? (annualized, overlapping windows) */
    function holding(d, c, years) {
      const n = d.length;
      const off = Math.round(years * 365.25);
      const anns = [];
      let losses = 0;
      let worst = { a: Infinity, i: -1 };
      let best = { a: -Infinity, i: -1 };
      let j = 0;
      for (let i = 0; i < n; i++) {
        const target = d[i] + off;
        if (j < i) j = i;
        while (j < n && d[j] < target) j++;
        if (j >= n) break;
        const g = c[j] / c[i];
        const a = Math.pow(g, 365.25 / (d[j] - d[i])) - 1;
        anns.push(a);
        if (g < 1) losses++;
        if (a < worst.a) worst = { a, i };
        if (a > best.a) best = { a, i };
      }
      const sorted = Float64Array.from(anns).sort();
      return {
        years, windows: anns.length, lossShare: losses / anns.length,
        median: percentile(sorted, 0.5), p10: percentile(sorted, 0.1), p90: percentile(sorted, 0.9),
        worst: worst.a, worstStart: d[worst.i], best: best.a, bestStart: d[best.i],
      };
    }

    /** Peak-to-trough declines, deepest first. `recovered` is the first close back at the old peak. */
    function drawdowns(d, c, minDepth = 0.1) {
      const out = [];
      let peak = c[0], pi = 0, trough = c[0], ti = 0, inDd = false;
      for (let i = 1; i < c.length; i++) {
        if (c[i] >= peak) {
          if (inDd) out.push({ peak: d[pi], trough: d[ti], recovered: d[i], depth: trough / peak - 1, peakPx: peak, troughPx: trough });
          peak = c[i]; pi = i; trough = c[i]; ti = i; inDd = false;
        } else {
          inDd = true;
          if (c[i] < trough) { trough = c[i]; ti = i; }
        }
      }
      if (inDd) out.push({ peak: d[pi], trough: d[ti], recovered: null, depth: trough / peak - 1, peakPx: peak, troughPx: trough });
      return out.filter((e) => e.depth <= -minDepth).sort((a, b) => a.depth - b.depth);
    }

    /** $10,000 invested over the window, with and without its N best days. */
    function bestDays(d, c, years) {
      const n = d.length;
      const s = years ? firstGE(d, d[n - 1] - Math.round(years * 365.25)) : 0;
      const r = [];
      for (let i = s + 1; i < n; i++) r.push(c[i] / c[i - 1] - 1);
      const idx = r.map((_, k) => k);
      const order = idx.slice().sort((a, b) => r[b] - r[a]);
      const worst = idx.slice().sort((a, b) => r[a] - r[b]).slice(0, 10);
      const logs = r.map(Math.log1p);
      const total = logs.reduce((a, b) => a + b, 0);
      const value = (N) => 10000 * Math.exp(total - order.slice(0, N).reduce((a, k) => a + logs[k], 0));
      const best10 = order.slice(0, 10);
      return {
        start: d[s], days: r.length, years: (d[n - 1] - d[s]) / 365.25,
        values: [0, 5, 10, 20, 30].map((N) => ({ N, v: value(N) })),
        clustered: best10.filter((k) => worst.some((w) => Math.abs(w - k) <= 15)).length,
        best: order.slice(0, 3).map((k) => ({ date: d[s + 1 + k], r: r[k] })),
      };
    }

    /** Complementary error function (Numerical Recipes erfcc, relative error < 1.2e-7 everywhere). */
    function erfc(x) {
      const z = Math.abs(x);
      const t = 1 / (1 + 0.5 * z);
      const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
      return x >= 0 ? r : 2 - r;
    }
    const Phi = (x) => 0.5 * erfc(-x / Math.SQRT2);

    /** Distribution of daily returns versus a normal curve with the same mean and standard deviation. */
    function tails(d, c) {
      const x = [];
      for (let i = 1; i < c.length; i++) x.push((c[i] / c[i - 1] - 1) * 100);
      const N = x.length;
      const mu = x.reduce((a, b) => a + b, 0) / N;
      const sd = Math.sqrt(x.reduce((a, b) => a + (b - mu) ** 2, 0) / (N - 1));
      const beyond = (k) => ({ k, observed: x.filter((v) => Math.abs(v - mu) > k * sd).length, expected: N * erfc(k / Math.SQRT2) });
      const m2 = x.reduce((a, b) => a + (b - mu) ** 2, 0) / N;
      const m4 = x.reduce((a, b) => a + (b - mu) ** 4, 0) / N;
      // 32 bins of 0.5% from -8% to +8%; anything beyond is folded into the end bins
      const W = 0.5, LO = -8, B = 32;
      const counts = new Array(B).fill(0);
      for (const v of x) counts[Math.max(0, Math.min(B - 1, Math.floor((v - LO) / W)))]++;
      const expected = counts.map((_, b) => {
        const a = b === 0 ? -Infinity : LO + b * W;
        const z = b === B - 1 ? Infinity : LO + (b + 1) * W;
        return N * (Phi((z - mu) / sd) - Phi((a - mu) / sd));
      });
      let wi = 0, bi = 0;
      for (let i = 1; i < x.length; i++) { if (x[i] < x[wi]) wi = i; if (x[i] > x[bi]) bi = i; }
      return { N, mu, sd, kurtosis: m4 / (m2 * m2) - 3, beyond: [3, 4, 5].map(beyond), W, LO, B, counts, expected, worst: { r: x[wi], date: d[wi + 1] }, best: { r: x[bi], date: d[bi + 1] }, years: (d[d.length - 1] - d[0]) / 365.25 };
    }

  return { percentile, firstGE, holding, drawdowns, bestDays, erfc, Phi, tails };
});
