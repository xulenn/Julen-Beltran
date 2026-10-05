/* Site behaviour: theme, nav, reveals, counters, reading shelf, command palette.
   Vanilla JS, no dependencies. The market chart lives in market.js. */
(() => {
  'use strict';
  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EMAIL = 'julenbeltranperez@gmail.com';
  root.classList.add('ready'); // tells the CSS fallback that JS booted (see .js:not(.ready) .reveal)

  /* ---------- toast ---------- */
  const toastEl = $('#toast');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }
  window.JB = { toast, reduced };

  /* ---------- theme ---------- */
  const themeBtn = $('#theme-toggle');
  const effectiveTheme = () => {
    const t = root.getAttribute('data-theme');
    return t === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t;
  };
  themeBtn.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) { /* storage may be blocked */ }
    toast(next === 'dark' ? 'Dark theme' : 'Light theme');
  });

  /* ---------- nav: scrolled state, progress bar, mobile menu, scroll-spy ---------- */
  const nav = $('#nav');
  const burger = $('#nav-burger');
  const links = $('#nav-links');
  const progress = $('.progress');
  let ticking = false;
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const max = root.scrollHeight - innerHeight;
      progress.style.setProperty('--p', max > 0 ? Math.min(1, scrollY / max).toFixed(4) : 0);
      nav.classList.toggle('scrolled', scrollY > 24);
      ticking = false;
    });
  }
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  function setMenu(open) {
    links.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }
  burger.addEventListener('click', () => setMenu(!links.classList.contains('open')));
  links.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false); });
  document.addEventListener('click', (e) => { if (!nav.contains(e.target)) setMenu(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });

  const navLinks = new Map($$('.nav-links a').map((a) => [a.getAttribute('href').slice(1), a]));
  if ('IntersectionObserver' in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (!en.isIntersecting) return;
        navLinks.forEach((a) => { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
        const a = navLinks.get(en.target.id);
        if (a) { a.classList.add('is-active'); a.setAttribute('aria-current', 'true'); }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    $$('main > section[id]').forEach((s) => spy.observe(s));
  }

  /* ---------- reveal on scroll ---------- */
  const revealEls = $$('.reveal');
  if (reduced || !('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('in'));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e, i) => {
        e.target.style.setProperty('--d', `${Math.min(i, 5) * 80}ms`); // stagger what appears together
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    revealEls.forEach((el) => io.observe(el));
  }

  /* ---------- count-up numbers (final text is already in the HTML) ---------- */
  const counters = $$('[data-count]');
  function runCounter(el) {
    const to = parseFloat(el.dataset.count);
    const dec = parseInt(el.dataset.decimals || '0', 10);
    const pre = el.dataset.prefix || '';
    const suf = el.dataset.suffix || '';
    const t0 = performance.now();
    const dur = 1100;
    (function frame(now) {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = pre + (to * eased).toFixed(dec) + suf;
      if (p < 1) requestAnimationFrame(frame);
    })(t0);
  }
  if (!reduced && 'IntersectionObserver' in window) {
    const cio = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { runCounter(e.target); cio.unobserve(e.target); } });
    }, { threshold: 0.6 });
    counters.forEach((el) => cio.observe(el));
  }

  /* ---------- card spotlight ---------- */
  $$('.spot').forEach((el) => {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  });

  /* ---------- reading shelf ---------- */
  const shelf = $('#shelf');
  const books = window.BOOKS || [];
  const dlg = $('#book-modal');
  let lastFocus = null;

  function coverFallback(b) {
    const d = document.createElement('span');
    d.className = 'cover-fallback';
    d.style.setProperty('--h', b.hue);
    const t = document.createElement('b');
    t.textContent = b.title;
    if (b.lang) t.lang = b.lang;
    const a = document.createElement('small');
    a.textContent = b.author;
    d.append(t, a);
    return d;
  }

  function buildBook(b) {
    const li = document.createElement('li');
    li.className = 'book';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'book-btn';
    btn.dataset.id = b.id;
    const hasNotes = Array.isArray(b.notes) && b.notes.length > 0;
    btn.disabled = !hasNotes;

    const cover = document.createElement('span');
    cover.className = 'cover';
    const fb = coverFallback(b);
    cover.append(fb);
    if (b.isbn) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('load', () => {
        if (img.naturalWidth > 60) { cover.append(img); fb.hidden = true; } // Open Library can answer with a 1px placeholder
      });
      img.src = `https://covers.openlibrary.org/b/isbn/${b.isbn}-L.jpg?default=false`;
    }

    const cat = document.createElement('span');
    cat.className = 'book-cat';
    cat.textContent = b.category;
    const h3 = document.createElement('h3');
    h3.textContent = b.title;
    if (b.lang) h3.lang = b.lang;
    const au = document.createElement('p');
    au.className = 'book-author';
    au.textContent = b.author;
    const go = document.createElement('span');
    go.className = 'book-go';
    go.textContent = hasNotes ? 'Read my notes →' : 'Notes coming soon';

    btn.append(cover, cat, h3, au, go);
    li.append(btn);
    return li;
  }

  if (shelf && books.length) {
    shelf.replaceChildren(...books.map(buildBook));
    shelf.addEventListener('click', (e) => {
      const btn = e.target.closest('.book-btn');
      if (btn && !btn.disabled) openBook(btn.dataset.id);
    });
  }

  function openBook(id) {
    const b = books.find((x) => x.id === id);
    if (!b || !b.notes) return;
    $('#bm-cat').textContent = b.category;
    const title = $('#bm-title');
    title.textContent = b.title;
    if (b.lang) title.lang = b.lang;
    $('#bm-author').textContent = b.byline || b.author;
    $('#bm-body').innerHTML = b.notes.join(''); // notes are my own trusted content (assets/js/books.js)
    lastFocus = document.activeElement;
    dlg.showModal();
    root.style.overflow = 'hidden';
    $('.modal-in', dlg).scrollTop = 0;
  }
  dlg.addEventListener('close', () => { root.style.overflow = ''; if (lastFocus && lastFocus.focus) lastFocus.focus(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));

  const prev = $('#shelf-prev');
  const next = $('#shelf-next');
  function updateShelfNav() {
    prev.disabled = shelf.scrollLeft < 8;
    next.disabled = shelf.scrollLeft + shelf.clientWidth >= shelf.scrollWidth - 8;
  }
  function stepShelf(dir) {
    const card = $('.book', shelf);
    const w = card ? card.getBoundingClientRect().width + 24 : 220;
    shelf.scrollBy({ left: dir * w * 2, behavior: reduced ? 'auto' : 'smooth' });
  }
  prev.addEventListener('click', () => stepShelf(-1));
  next.addEventListener('click', () => stepShelf(1));
  shelf.addEventListener('scroll', () => requestAnimationFrame(updateShelfNav), { passive: true });
  addEventListener('resize', updateShelfNav);
  updateShelfNav();

  /* ---------- contact ---------- */
  $('#copy-email').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(EMAIL);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = EMAIL;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (err) { /* nothing else to try */ }
      ta.remove();
    }
    toast('Email address copied');
  });

  /* ---------- command palette (Ctrl/⌘ K) ---------- */
  const cmd = $('#cmdk');
  const cin = $('#cmdk-input');
  const clist = $('#cmdk-list');

  const goTo = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    history.replaceState(null, '', `#${id}`);
  };
  const download = (href) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
  };
  const open = (href) => window.open(href, '_blank', 'noopener');

  const items = [
    ...[['about', 'About'], ['markets', 'Live S&P 500'], ['lab', 'Risk lab'], ['education', 'Education'], ['experience', 'Experience'],
        ['portfolio', 'Portfolio case study'], ['projects', 'Projects & toolkit'], ['reading', 'Reading list'], ['contact', 'Contact']]
      .map(([id, label]) => ({ label: `Go to ${label}`, hint: 'Section', icon: 'i-arrow-down', kw: `${id} section`, run: () => goTo(id) })),
    { label: 'Download CV (English)', hint: 'File', icon: 'i-download', kw: 'resume cv english pdf', run: () => download('assets/docs/Julen_Beltran_CV_EN.pdf') },
    { label: 'Descargar CV (Español)', hint: 'File', icon: 'i-download', kw: 'resume cv spanish espanol pdf', run: () => download('assets/docs/Julen_Beltran_CV_ES.pdf') },
    { label: 'Read the portfolio report (PDF)', hint: 'File', icon: 'i-arrow-ur', kw: 'portfolio pdf report simulation', run: () => open('assets/docs/JP_Beltran_Portfolio_Summary.pdf') },
    { label: 'Email Julen', hint: 'Contact', icon: 'i-mail', kw: 'mail contact message', run: () => { location.href = `mailto:${EMAIL}`; } },
    { label: 'Copy email address', hint: 'Action', icon: 'i-copy', kw: 'email copy clipboard', run: () => $('#copy-email').click() },
    { label: 'Open LinkedIn', hint: 'Link', icon: 'i-linkedin', kw: 'linkedin social profile', run: () => open('https://www.linkedin.com/in/julenbeltran') },
    { label: 'Toggle light / dark theme', hint: 'Action', icon: 'i-moon', kw: 'theme dark light mode appearance', run: () => themeBtn.click() },
    { label: 'View the source on GitHub', hint: 'Link', icon: 'i-arrow-ur', kw: 'github code source repository', run: () => open('https://github.com/xulenn/Julen-Beltran') },
  ];

  let shown = items;
  let sel = 0;
  const svgIcon = (id) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ico');
    s.setAttribute('aria-hidden', 'true');
    const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    u.setAttribute('href', `#${id}`);
    s.append(u);
    return s;
  };
  function renderList() {
    clist.replaceChildren();
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'No matches';
      clist.append(li);
      cin.removeAttribute('aria-activedescendant');
      return;
    }
    shown.forEach((it, i) => {
      const li = document.createElement('li');
      li.id = `cmd-${i}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === sel));
      const label = document.createElement('span');
      label.textContent = it.label;
      const hint = document.createElement('small');
      hint.textContent = it.hint;
      li.append(svgIcon(it.icon), label, hint);
      li.addEventListener('pointermove', () => { if (sel !== i) { sel = i; paintSel(); } });
      li.addEventListener('click', () => runItem(it));
      clist.append(li);
    });
    cin.setAttribute('aria-activedescendant', `cmd-${sel}`);
  }
  function paintSel() {
    $$('li[role=option]', clist).forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    cin.setAttribute('aria-activedescendant', `cmd-${sel}`);
    const cur = $(`#cmd-${sel}`);
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function filterItems() {
    const q = cin.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    shown = q.length ? items.filter((it) => q.every((t) => `${it.label} ${it.kw}`.toLowerCase().includes(t))) : items;
    sel = 0;
    renderList();
  }
  function runItem(it) {
    cmd.close();
    setTimeout(it.run, 20);
  }
  function openPalette() {
    if (cmd.open) return;
    cin.value = '';
    filterItems();
    cmd.showModal();
    cin.focus();
  }
  cin.addEventListener('input', filterItems);
  cin.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(shown.length, 1); paintSel(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + shown.length) % Math.max(shown.length, 1); paintSel(); }
    else if (e.key === 'Home') { e.preventDefault(); sel = 0; paintSel(); }
    else if (e.key === 'End') { e.preventDefault(); sel = Math.max(shown.length - 1, 0); paintSel(); }
    else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); runItem(shown[sel]); }
  });
  cmd.addEventListener('click', (e) => { if (e.target === cmd) cmd.close(); });
  $('#cmdk-open').addEventListener('click', openPalette);
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      cmd.open ? cmd.close() : openPalette();
    }
  });
})();
