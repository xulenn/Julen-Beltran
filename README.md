# Julen Beltran — personal site

Live at **https://xulenn.github.io/Julen-Beltran/** (served by GitHub Pages from `main`).

Hand-written HTML, CSS and JavaScript — no framework, no build step, no chart library.

## Layout

```
index.html              the page
assets/css/main.css     all styles (light/dark themes, responsive)
assets/js/app.js        UI: theme, nav, reveals, reading shelf, ⌘K command palette
assets/js/market.js     the S&P 500 section: ticker, canvas chart, stats, calculator
assets/js/books.js      reading-list data and notes
assets/img, fonts, docs optimised images, self-hosted fonts (OFL), CVs and portfolio report
scripts/                market-data fetcher + tests
.github/workflows/      scheduled data refresh
```

## How the live S&P 500 data works

GitHub Pages is static, so the browser can't call market-data APIs directly (CORS and rate limits).
Instead:

1. `.github/workflows/market-data.yml` runs every ~10 minutes while US markets are open (and once after the close).
2. It runs `scripts/market-data.mjs`, which reads Cboe's public delayed-quote JSON and writes
   `live.json`, `history.json` and `sessions.json`.
3. The files are force-pushed as a single commit to the **`data`** branch, so `main` history never grows and
   Pages is not rebuilt on every refresh.
4. The page fetches them from `raw.githubusercontent.com/<repo>/data/…` (the URL is in the
   `market-data-base` meta tag in `index.html`).

Things worth knowing:

- Data is **delayed ~15 minutes**. The page shows the real timestamp and warns if the data is stale.
- The source is an **unofficial endpoint** (the JSON behind cboe.com's quote pages). Yahoo, Stooq and FRED were tried
  first and all fail from GitHub's runners (429 / bot check / timeouts). If Cboe changes its format, the job fails
  loudly (the unit tests in `scripts/market-data.test.mjs` pin the format) and the page keeps showing the last good data.
- Nothing is ever fabricated: if data can't be loaded the section says so.
- GitHub pauses scheduled workflows after 60 days without repository activity — re-enable it from the Actions tab.
- Run it locally: `node scripts/market-data.mjs out` (Node 18+). Tests: `node --test scripts/market-data.test.mjs`.

## Editing content

- Text and structure: `index.html`.
- Books and notes: `assets/js/books.js`.
- CVs and the portfolio PDF: replace the files in `assets/docs/` (keep the names, or update the links).
