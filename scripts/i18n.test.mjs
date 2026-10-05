// Run with: node --test scripts/i18n.test.mjs
// Keeps the Spanish site honest: every string the scripts can show has a Spanish entry, placeholders survive translation,
// the two HTML pages have the same structure (so every script hook exists in both), and the SEO plumbing is reciprocal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { SYMBOLS } from './market-data.mjs';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const ES = require('../assets/js/lang-es.js');

const SOURCES = ['assets/js/app.js', 'assets/js/market.js', 'assets/js/lab.js'];
const CALL = /(?<![\w$.])t\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g;
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

/** Every string literal passed to t() in the scripts. */
function usedKeys() {
  const keys = new Map();
  for (const f of SOURCES) {
    for (const m of read(f).matchAll(CALL)) {
      assert.ok(!(m[1].startsWith('`') && m[1].includes('${')), `${f}: t() needs a plain string; use {placeholders} instead of \${…}: ${m[1].slice(0, 60)}`);
      keys.set(Function(`"use strict"; return (${m[1]})`)(), f);
    }
  }
  return keys;
}
// names that market.js passes to t() as variables (they come from the data files, see scripts/market-data.mjs)
const DYNAMIC = SYMBOLS.map((s) => s.name);

test('every string the scripts can show has a Spanish translation', () => {
  const missing = [...usedKeys().keys(), ...DYNAMIC].filter((k) => !Object.prototype.hasOwnProperty.call(ES, k));
  assert.deepEqual(missing, [], `missing from assets/js/lang-es.js:\n${missing.join('\n')}`);
});

test('the Spanish dictionary has no stale or empty entries', () => {
  const used = new Set([...usedKeys().keys(), ...DYNAMIC]);
  const stale = Object.keys(ES).filter((k) => !used.has(k));
  assert.deepEqual(stale, [], `unused entries in lang-es.js:\n${stale.join('\n')}`);
  for (const [k, v] of Object.entries(ES)) assert.ok(typeof v === 'string' && v.length > 0, `empty translation: ${k}`);
});

test('translations keep exactly the placeholders of the English text', () => {
  for (const [k, v] of Object.entries(ES)) assert.equal(placeholders(v), placeholders(k), `placeholders differ for: ${k}`);
});

test('a translation is never a copy of the English unless it is a name, number or unit', () => {
  const same = Object.entries(ES).filter(([k, v]) => k === v).map(([k]) => k);
  const allowed = new Set(['S&P 500', 'Nasdaq-100', 'Dow Jones', 'Russell 2000', 'VIX', 'Bitcoin · IBIT', '1D', '5D', '1M', '6M', 'YTD', '{n} pts']);
  assert.deepEqual(same.filter((k) => !allowed.has(k)), [], 'untranslated entries');
});

test('percent signs follow Spanish typography (a non-breaking space before %) inside translations', () => {
  for (const [k, v] of Object.entries(ES)) assert.ok(!/\d%/.test(v), `"${v.slice(0, 70)}…" has a digit glued to %`);
});

test('t() picks the page language and fills placeholders', () => {
  const run = (lang, dict) => {
    const ctx = { window: { JB_ES: dict }, document: { documentElement: { lang, getAttribute: (a) => (a === 'data-root' && lang === 'es' ? '../' : null) } } };
    vm.runInNewContext(read('assets/js/i18n.js'), ctx);
    return ctx.window.JB;
  };
  const en = run('en', ES);
  assert.equal(en.t('{n} days ago', { n: 3 }), '3 days ago');
  assert.equal(en.locale, 'en-US');
  assert.equal(en.PC, '%');
  const es = run('es', ES);
  assert.equal(es.t('{n} days ago', { n: 3 }), 'hace 3 días');
  assert.equal(es.t('Something nobody translated'), 'Something nobody translated'); // falls back to English
  assert.equal(es.t('{a} change', { a: 'Oro' }), 'Variación de Oro');
  assert.equal(es.locale, 'es-ES');
  assert.equal(es.PC, ' %');
  assert.equal(es.root, '../');
});

/* ---------- the two pages ---------- */
const clean = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '<script></script>').replace(/<style[\s\S]*?<\/style>/g, '');
/** Tag sequence of <body> with only language-independent attributes: if both pages produce the same list, every id/class/data hook is in both. */
function skeleton(html) {
  const body = clean(html).split(/<body[^>]*>/)[1];
  const out = [];
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*)>/g)) {
    const [, close, tag, attrs] = m;
    if (tag === 'script') continue; // the script lists differ on purpose and are checked in their own test
    if (close) { out.push(`/${tag}`); continue; }
    const keep = [];
    for (const a of attrs.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      const [, name, value = ''] = a;
      if (name === 'id' || name === 'class' || name === 'role' || name === 'type' || name === 'for' || name === 'aria-controls' || name === 'tabindex') keep.push(`${name}=${value}`);
      else if (name.startsWith('data-') && !['data-count', 'data-decimals', 'data-prefix', 'data-suffix'].includes(name)) keep.push(`${name}`);
      else if (name === 'hidden' || name === 'download' || name === 'aria-pressed' || name === 'aria-expanded') keep.push(name);
      else if (name === 'href' && value.startsWith('#')) keep.push(`href=${value}`);
    }
    out.push(`${tag}${keep.length ? ` [${keep.join(' ')}]` : ''}`);
  }
  return out;
}
const EN_HTML = read('index.html');
const ES_HTML = read('es/index.html');

test('the Spanish page has the same structure as the English page', () => {
  const a = skeleton(EN_HTML);
  const b = skeleton(ES_HTML);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) assert.fail(`first structural difference at element #${i}:\n  en: ${a.slice(Math.max(0, i - 2), i + 3).join(' | ')}\n  es: ${b.slice(Math.max(0, i - 2), i + 3).join(' | ')}`);
  assert.ok(a.length > 400, 'skeleton looks too small to mean anything');
});

test('the Spanish page declares its language, loads the Spanish files and points at the site root with ../', () => {
  assert.match(ES_HTML, /<html lang="es"[^>]*data-root="\.\.\/"/);
  assert.match(EN_HTML, /<html lang="en"/);
  const order = [...ES_HTML.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['../assets/js/lang-es.js', '../assets/js/i18n.js', '../assets/js/books.js', '../assets/js/books-es.js', '../assets/js/app.js', '../assets/js/market.js', '../assets/js/risk-math.js', '../assets/js/lab.js']);
  const en = [...EN_HTML.matchAll(/<script src="([^"]+)" defer><\/script>/g)].map((m) => m[1]);
  assert.deepEqual(en, ['assets/js/i18n.js', 'assets/js/books.js', 'assets/js/app.js', 'assets/js/market.js', 'assets/js/risk-math.js', 'assets/js/lab.js']);
  const bad = [...clean(ES_HTML).matchAll(/(?:href|src|srcset)="(?!https?:|#|mailto:|\.\.\/)[^"]*"/g)].map((m) => m[0]);
  assert.deepEqual(bad, [], 'paths on the Spanish page must start with ../');
  for (const f of order) assert.ok(fs.existsSync(new URL(f.replace('../', ''), root)), `${f} does not exist`);
});

test('hreflang, canonical and the language switch are reciprocal', () => {
  const BASE = 'https://xulenn.github.io/Julen-Beltran/';
  for (const [html, self] of [[EN_HTML, BASE], [ES_HTML, `${BASE}es/`]]) {
    assert.ok(html.includes(`<link rel="canonical" href="${self}" />`), `canonical for ${self}`);
    assert.ok(html.includes(`<link rel="alternate" hreflang="en" href="${BASE}" />`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="es" href="${BASE}es/" />`));
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${BASE}" />`));
    assert.ok(html.includes(`<meta property="og:url" content="${self}" />`));
  }
  assert.match(EN_HTML, /id="lang-switch" href="es\/" hreflang="es"/);
  assert.match(ES_HTML, /id="lang-switch" href="\.\.\/\?lang=en" hreflang="en"/);
  assert.ok(ES_HTML.includes('assets/img/og-es.jpg') && fs.existsSync(new URL('assets/img/og-es.jpg', root)));
  const sitemap = read('sitemap.xml');
  assert.ok(sitemap.includes(`<loc>${BASE}</loc>`) && sitemap.includes(`<loc>${BASE}es/</loc>`), 'sitemap lists both pages');
});

test('the first-visit redirect only lives on the English page and respects a saved choice', () => {
  assert.ok(EN_HTML.includes("location.replace('es/'"), 'English page redirects Spanish browsers');
  assert.ok(!ES_HTML.includes('location.replace'), 'Spanish page never redirects');
  assert.ok(EN_HTML.includes("localStorage.getItem('lang')"));
  assert.ok(EN_HTML.includes('lang=en'), '?lang=en opts out');
});

/* ---------- the reading list ---------- */
test('every translated book matches the English entry (same number of notes and of bold lead-ins)', () => {
  const ctx = { window: {} };
  vm.runInNewContext(read('assets/js/books.js'), ctx);
  vm.runInNewContext(read('assets/js/books-es.js'), ctx);
  const books = ctx.window.BOOKS;
  const tr = ctx.window.BOOKS_I18N;
  const ids = new Set(books.map((b) => b.id));
  for (const id of Object.keys(tr)) assert.ok(ids.has(id), `unknown book id ${id}`);
  for (const b of books) {
    const t = tr[b.id];
    assert.ok(t && t.category, `no Spanish category for ${b.id}`);
    if (!b.notes) { assert.ok(!t.notes, `${b.id} has no English notes`); continue; }
    assert.equal(t.notes.length, b.notes.length, `${b.id}: number of notes`);
    t.notes.forEach((n, i) => {
      assert.equal((n.match(/<strong>/g) || []).length, (b.notes[i].match(/<strong>/g) || []).length, `${b.id} note ${i + 1}: bold segments`);
      assert.ok(n.startsWith('<p>') && n.endsWith('</p>'), `${b.id} note ${i + 1}: markup`);
    });
  }
});
