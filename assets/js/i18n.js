/* Tiny i18n layer shared by every script. The page language comes from <html lang>.
   English is the source language: t('English text {name}', { name }) returns that text on the English page and the
   matching entry of window.JB_ES (assets/js/lang-es.js) on the Spanish page. A missing entry falls back to English,
   and scripts/i18n.test.mjs fails the build if one is missing, so the fallback is only a safety net. */
(() => {
  'use strict';
  const lang = (document.documentElement.lang || 'en').toLowerCase().startsWith('es') ? 'es' : 'en';
  const dict = lang === 'es' ? window.JB_ES || {} : null;
  const t = (key, vars) => {
    const s = dict && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : s;
  };
  window.JB = Object.assign(window.JB || {}, {
    lang,
    locale: lang === 'es' ? 'es-ES' : 'en-US',
    root: document.documentElement.getAttribute('data-root') || '', // '../' on the Spanish page, which lives in /es/
    PC: lang === 'es' ? ' %' : '%', // Spanish puts a (non-breaking) space before the percent sign
    t,
  });
})();
