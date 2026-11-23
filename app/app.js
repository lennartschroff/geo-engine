// GEO Engine web app.
//
// Runs entirely in the browser: plain JavaScript, no framework, no build step,
// and the page's CSP forbids network requests. Demo data arrives via data.js
// (built from data/*.json). "My brand" mode keeps its setup and results in
// localStorage, as does per-mode user state (own questions, drafts, ticked
// audit items), so demo and own data never mix.

'use strict';

(() => {
  const CORE = window.GEO_CORE;

  // ---------- Mode / own-brand persistence ----------
  // mode is 'demo' | 'own' | null (null = first visit, nothing chosen yet).
  const MODE_KEY = 'geo-engine:mode';
  const OWN_KEY = 'geo-engine:own:v1';
  function loadMode() { try { return window.localStorage.getItem(MODE_KEY); } catch (e) { return null; } }
  function saveMode(m) { try { window.localStorage.setItem(MODE_KEY, m); } catch (e) { /* storage unavailable */ } }
  function loadOwn() {
    try { const raw = window.localStorage.getItem(OWN_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
  }
  function saveOwn(o) { try { window.localStorage.setItem(OWN_KEY, JSON.stringify(o)); } catch (e) { /* storage unavailable */ } }
  function emptyOwnData(brand, categories, questions) {
    return {
      brand, categories, questions, blocks: [], audit: [], pages: [],
      demo: { results: {}, cited_sources: [], trend: [], pieces: [], audit_meta: { date: '', pages: 0, posts: 0 } }
    };
  }

  // Monitoring part of an export from scripts/export_monitoring.py.
  function demoFromExport(parsed, prev) {
    return {
      results: parsed.results,
      cited_sources: Array.isArray(parsed.cited_sources) ? parsed.cited_sources : [],
      trend: Array.isArray(parsed.trend) && parsed.trend.length ? parsed.trend : (prev ? prev.trend : []),
      trend_ci: Array.isArray(parsed.trend_ci) ? parsed.trend_ci : [],
      answers: parsed.answers && typeof parsed.answers === 'object' ? parsed.answers : {},
      competitors: Array.isArray(parsed.competitors) ? parsed.competitors : [],
      pieces: prev ? prev.pieces : [],
      audit_meta: parsed.audit_meta || (prev ? prev.audit_meta : { date: '', pages: 0, posts: 0 }),
    };
  }
  const validSetup = x => x && x.brand && Array.isArray(x.brand.aliases) && Array.isArray(x.categories) && Array.isArray(x.questions) && x.questions.length > 0;
  // Ids a real run asked when the export was made: its run list, or the key questions.
  const runListFromSetup = st => Array.isArray(st.run_list) ? st.run_list.slice() : st.questions.filter(q => q.key).map(q => q.id);
  // Monitoring settings and the real target, bundled by build_web_data.py.
  const MON = (window.GEO_DATA && window.GEO_DATA.monitoring) || null;
  // Own brand set up from the bundled target (no export needed). Replaces any
  // previous own setup, like loading an export does.
  function useTarget() {
    const T = MON && MON.target;
    if (!T) return;
    own = emptyOwnData(T.brand, T.categories, T.questions);
    own.runList = T.questions.filter(q => q.key).map(q => q.id);
    saveOwn(own);
    try { window.localStorage.removeItem('geo-engine:v1:own'); } catch (e) { /* storage unavailable */ }
    mode = 'own'; saveMode('own');
    boot();
  }

  let mode = loadMode();
  let own = loadOwn();

  // ---------- Shared helpers & event wiring (used by every screen) ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Colours are CSS custom properties defined in styles.css, so the whole
  // look (including these inline styles) is set in one place.
  const C = {
    fg: 'var(--fg)', muted: 'var(--muted)', faint: 'var(--faint)', graphic: 'var(--graphic)',
    accent: 'var(--accent)', warn: 'var(--warn)', amber: 'var(--amber)', border: 'var(--border-strong)',
  };
  // Small line icons (stroke="currentColor", inherits color from surrounding
  // text) -- used instead of emoji throughout, matching the rest of the app's
  // monochrome, minimal visual language.
  const icon = (size, path) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-' + Math.round(size * 0.16) + 'px;flex-shrink:0">' + path + '</svg>';
  const iconEye = size => icon(size, '<path d="M2 12s3.4-6.5 10-6.5S22 12 22 12s-3.4 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>');
  const iconSliders = size => icon(size, '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/>');
  const iconCheck = size => icon(size, '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>');
  const iconCircle = size => icon(size, '<circle cx="12" cy="12" r="9"/>');
  // Navigation and UI icons, same 24px line style.
  const ICONS = {
    overview: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    questions: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/><path d="M9.8 9.6a2.3 2.3 0 0 1 4.4.9c0 1.6-2.2 2-2.2 3.2"/><circle cx="12" cy="16.6" r=".6" fill="currentColor"/>',
    sources: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    impact: '<path d="M3 17l5.5-5.5 4 4L21 7"/><path d="M15 7h6v6"/>',
    website: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3Z"/>',
    write: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="M13.5 6.5l4 4"/>',
    library: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5v-13Z"/><path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14V4Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7 14h10"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    up: '<path d="M18 15l-6-6-6 6"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="7.8" r=".7" fill="currentColor"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    sort: '<path d="M8 4v16M4 16l4 4 4-4M16 20V4M12 8l4-4 4 4"/>',
    run: '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5Z" fill="currentColor"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    globe2: '<path d="M4 5h8M8 3v2M5.5 5c1 3.5 3.5 6 6.5 7.5M10.5 5c-1 4-3.5 7-6.5 8.5"/><path d="M13 21l4-9 4 9M14.5 18h5"/>',
    swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h13"/><path d="M17 20l4-4-4-4"/><path d="M21 16H8"/>',
  };
  const ic = (name, size) => icon(size || 16, ICONS[name] || '');

  // ---------- Theme (shared by every screen, stored per browser) ----------
  // 'light' | 'dark' | null (null = follow the operating system).
  const THEME_KEY = 'geo-engine:theme';
  function loadTheme() { try { const t = window.localStorage.getItem(THEME_KEY); return t === 'light' || t === 'dark' ? t : null; } catch (e) { return null; } }
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
  }
  const prefersDark = () => !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const isDark = () => (loadTheme() || (prefersDark() ? 'dark' : 'light')) === 'dark';
  function toggleTheme() {
    const next = isDark() ? 'light' : 'dark';
    try { window.localStorage.setItem(THEME_KEY, next); } catch (e) { /* storage unavailable */ }
    applyTheme(next);
    return next;
  }
  applyTheme(loadTheme());

  // ---------- Tooltip: any element with data-tt gets a floating label ----------
  // Lives outside #app so re-renders never touch it. Text only (no HTML).
  const tt = document.createElement('div');
  tt.className = 'tt';
  tt.setAttribute('role', 'tooltip');
  document.body.appendChild(tt);
  let ttFor = null;
  function showTip(el) {
    const text = el.getAttribute('data-tt');
    if (!text) return;
    ttFor = el;
    tt.textContent = text;
    tt.classList.add('show');
    const r = el.getBoundingClientRect();
    const w = tt.offsetWidth, h = tt.offsetHeight;
    let x = r.left + r.width / 2 - w / 2;
    let y = r.top - h - 8;
    if (y < 8) y = r.bottom + 8;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    tt.style.left = Math.round(x) + 'px';
    tt.style.top = Math.round(y) + 'px';
  }
  function hideTip() { ttFor = null; tt.classList.remove('show'); }
  document.addEventListener('pointerover', e => { const el = e.target.closest && e.target.closest('[data-tt]'); if (el && el !== ttFor) showTip(el); else if (!el && ttFor) hideTip(); });
  document.addEventListener('focusin', e => { const el = e.target.closest && e.target.closest('[data-tt]'); if (el) showTip(el); else hideTip(); });
  document.addEventListener('scroll', hideTip, true);

  // ---------- Toasts: short confirmations, outside #app as well ----------
  const toasts = document.createElement('div');
  toasts.className = 'toasts';
  toasts.setAttribute('role', 'status');
  toasts.setAttribute('aria-live', 'polite');
  document.body.appendChild(toasts);
  function toast(text) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = icon(15, ICONS.check) + '<span></span>';
    el.lastChild.textContent = text;
    toasts.appendChild(el);
    setTimeout(() => { el.style.transition = 'opacity .2s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 220); }, 1800);
  }

  // One keyboard listener for the whole page; boot() points it at the
  // current screen's handler, so switching modes never stacks listeners.
  let onKey = null;
  document.addEventListener('keydown', e => { hideTip(); if (onKey) onKey(e); });

  const CH = window.GEO_CHARTS;
  const root = document.getElementById('app');
  // Views are rendered as HTML strings, so event listeners can't be attached
  // to elements directly. Each render fills a table of handlers; markup refers
  // to them by index (data-h-<type>="n"), and one listener per event type on
  // the root element looks the handler up.
  let handlers = [];
  const attr = (type, fn) => `data-h-${type}="${handlers.push(fn) - 1}"`;
  const click = fn => attr('click', fn);
  const EVENT_TYPES = ['click', 'change', 'input', 'keydown', 'dragstart', 'dragend', 'dragover', 'dragleave', 'drop'];
  for (const type of EVENT_TYPES) {
    root.addEventListener(type, event => {
      const target = event.target.closest(`[data-h-${type}]`);
      if (!target || !root.contains(target)) return;
      const handler = handlers[Number(target.getAttribute(`data-h-${type}`))];
      if (handler) handler(event, target);
    });
  }

  // ---------- Welcome screen (first visit only, always reachable again via the header toggle) ----------
  function renderWelcome() {
    handlers = [];
    root.innerHTML =
      '<div style="max-width:680px;margin:64px auto;padding:0 32px;display:flex;flex-direction:column;gap:32px">' +
      '<div class="head" style="gap:10px">' +
      '<span class="s13 muted" style="letter-spacing:.04em">GEO ENGINE</span>' +
      '<h1 style="font-size:28px">See how AI assistants talk about a brand</h1>' +
      '<p>Track mentions in ChatGPT, Claude and Gemini, find the gaps, and draft content that closes them.</p></div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap">' +
      '<div class="card" style="flex:1 1 280px;gap:16px">' +
      '<div style="display:flex;align-items:center;gap:10px;color:' + C.accent + '">' + iconEye(22) + '<h2>See a live example</h2></div>' +
      '<p class="s14 muted" style="margin:0">Contoso AI, a fictional AI consultancy — fully interactive demo data.</p>' +
      '<button class="btn" style="align-self:flex-start" ' + click(chooseDemo) + '>Open the demo →</button></div>' +
      '<div class="card" style="flex:1 1 280px;gap:16px">' +
      '<div style="display:flex;align-items:center;gap:10px;color:' + C.fg + '">' + iconSliders(22) + '<h2>Set up your own brand</h2></div>' +
      '<p class="s14 muted" style="margin:0">Takes about two minutes. Nothing leaves your browser.</p>' +
      '<button class="btn outline" style="align-self:flex-start" ' + click(chooseOwn) + '>Get started →</button></div></div>' +
      '<span class="small muted">You can switch between the two at any time from the menu.</span></div>';
  }
  function chooseDemo() { mode = 'demo'; saveMode('demo'); boot(); }
  function chooseOwn() { mode = 'own'; saveMode('own'); if (own) boot(); else renderSetup(); }

  // ---------- Setup wizard (first-time setup, and reopened later to edit) ----------
  let setupDraft = null; // ephemeral — not persisted; a half-filled form doesn't survive a refresh in v1
  function initSetupDraft() {
    const b = (own && own.brand) || {};
    const cats = (own && own.categories) || [];
    setupDraft = {
      name: b.name || '', domain: b.domain || '', aliases: (b.aliases || []).join(', '),
      topics: cats.length ? cats.map(c => ({ label: c.label_en, keywords: c.keywords.join(', ') })) : [{ label: '', keywords: '' }, { label: '', keywords: '' }],
      error: '', topicsMsg: ''
    };
  }
  // A plain-language numbered step, not a code block -- the exact command
  // (for whoever on the team is technical enough to run it) goes behind an
  // optional <details> disclosure passed in as `extra`, never shown by default.
  function stepRow(n, text, extra) {
    return '<div style="display:flex;gap:12px;align-items:flex-start">' +
      '<span style="flex-shrink:0;width:22px;height:22px;border-radius:11px;background:var(--soft);color:' + C.fg + ';font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center">' + n + '</span>' +
      '<div style="display:flex;flex-direction:column;gap:2px;min-width:0;padding-top:1px"><span class="s14">' + esc(text) + '</span>' + (extra || '') + '</div>' +
      '</div>';
  }
  function renderSetup() {
    if (!setupDraft) initSetupDraft();
    handlers = [];
    const d = setupDraft;
    const topicRows = d.topics.map((t, i) =>
      '<div style="display:flex;gap:8px;align-items:center">' +
      '<input type="text" style="flex:1 1 160px" aria-label="Topic ' + (i + 1) + ' name" value="' + esc(t.label) + '" placeholder="e.g. SEO services" ' + attr('input', e => { d.topics[i].label = e.target.value; }) + '>' +
      '<input type="text" style="flex:2 1 220px" aria-label="Topic ' + (i + 1) + ' keywords" value="' + esc(t.keywords) + '" placeholder="keywords, comma, separated" ' + attr('input', e => { d.topics[i].keywords = e.target.value; }) + '>' +
      '<button class="icon" aria-label="Remove topic ' + (i + 1) + '" ' + click(() => { d.topics.splice(i, 1); renderSetup(); }) + '>×</button></div>'
    ).join('');
    root.innerHTML =
      '<div style="max-width:640px;margin:56px auto;padding:0 32px;display:flex;flex-direction:column;gap:24px">' +
      '<button class="link" style="align-self:flex-start" ' + click(() => { mode = 'demo'; saveMode('demo'); setupDraft = null; boot(); }) + '>← Back to the demo</button>' +
      '<div class="head"><h1>Set up your brand</h1><p>Runs entirely in your browser — nothing is sent anywhere, no API key needed for this part.</p></div>' +
      (MON && MON.target ? '<div class="card" style="gap:10px"><span class="s14" style="font-weight:500">Use the monitoring target ' + esc(MON.target.brand.name) + '</span>' +
        '<span class="s13 muted">Brand, topics and questions from ' + esc(MON.target.path) + ', the folder the real monitoring runs against.</span>' +
        '<button class="btn sm" style="align-self:flex-start" ' + click(() => { setupDraft = null; useTarget(); }) + '>Use ' + esc(MON.target.brand.short) + ' →</button></div>' : '') +
      '<div class="card" style="gap:10px"><span class="s14" style="font-weight:500">Already have monitoring results?</span>' +
      '<span class="s13 muted">Load monitoring_export.json (from a monitoring run or the scheduled GitHub Action). It sets up the brand, topics, questions and results in one step.</span>' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><label for="su-export-file" class="btn sm plain" style="cursor:pointer">Load export…</label>' +
      '<input id="su-export-file" type="file" accept="application/json,.json" class="sr" ' + attr('change', loadExportSetup) + '></div></div>' +
      '<div class="card">' +
      '<label for="su-name">Company name</label><input id="su-name" type="text" value="' + esc(d.name) + '" placeholder="e.g. Lighthouse Marketing" ' + attr('input', e => { d.name = e.target.value; }) + '>' +
      '<label for="su-domain">Website domain</label><input id="su-domain" type="text" value="' + esc(d.domain) + '" placeholder="e.g. lighthouse-marketing.com" ' + attr('input', e => { d.domain = e.target.value; }) + '>' +
      '<label for="su-aliases">Also known as (comma-separated, optional)</label><input id="su-aliases" type="text" value="' + esc(d.aliases) + '" placeholder="e.g. Lighthouse, Lighthouse Marketing Inc." ' + attr('input', e => { d.aliases = e.target.value; }) + '>' +
      '</div>' +
      '<div class="card">' +
      '<div class="listhead"><h2>Topics you want to track</h2></div>' +
      '<p class="s13 muted">What does your business cover? Each topic becomes a set of starter questions you can refine later.</p>' +
      topicRows +
      '<button class="btn sm plain" style="align-self:flex-start" ' + click(() => { d.topics.push({ label: '', keywords: '' }); renderSetup(); }) + '>+ Add topic</button>' +
      '</div>' +
      '<div class="card">' +
      '<div class="listhead" style="min-height:0"><h2>Already have a website?</h2></div>' +
      stepRow(1, 'Scan it on your own computer — free, takes under a minute, nothing is sent to us.',
        '<details style="margin-top:2px"><summary class="s13" style="color:' + C.accent + ';cursor:pointer">Show me how (for a developer on your team)</summary>' +
        '<code class="mono s13" style="display:block;white-space:pre-wrap;background:var(--bg);border:1px solid var(--input);border-radius:6px;padding:10px 12px;margin-top:8px">python scripts/audit_crawl.py --base https://yoursite.com\npython scripts/suggest_topics.py</code></details>') +
      stepRow(2, 'Upload the file it creates.',
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px">' +
        '<label for="su-topics-file" class="btn sm plain" style="cursor:pointer">Choose file…</label>' +
        '<input id="su-topics-file" type="file" accept="application/json,.json" class="sr" ' + attr('change', loadTopicsFile) + '>' +
        (d.topicsMsg ? '<span class="s13" style="color:' + C.accent + '">' + esc(d.topicsMsg) + '</span>' : '') + '</div>') +
      '</div>' +
      (d.error ? '<span class="s13 warn">' + esc(d.error) + '</span>' : '') +
      '<button class="btn" style="align-self:flex-start" ' + click(submitSetup) + '>Generate my starter kit →</button>' +
      '</div>';
  }
  // Reads the JSON scripts/suggest_topics.py produces -- pure client-side
  // file read (FileReader), no network call, CSP-safe. Keeps any topic row
  // you've already started filling in; appends the suggestions after it.
  function loadTopicsFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed) || !parsed.length) throw new Error('empty');
        const rows = parsed
          .filter(t => t && t.label)
          .map(t => ({ label: String(t.label), keywords: Array.isArray(t.keywords) ? t.keywords.join(', ') : String(t.keywords || '') }));
        if (!rows.length) throw new Error('no usable rows');
        const kept = setupDraft.topics.filter(t => t.label.trim() || t.keywords.trim());
        setupDraft.topics = kept.concat(rows);
        setupDraft.error = '';
        setupDraft.topicsMsg = 'Loaded ' + rows.length + ' topic' + (rows.length === 1 ? '' : 's') + ' — review them below before generating your starter kit.';
      } catch (err) {
        setupDraft.topicsMsg = '';
        setupDraft.error = 'Could not read that file — expected the JSON scripts/suggest_topics.py produces.';
      }
      renderSetup();
    };
    reader.readAsText(file);
  }
  // Whole setup from a monitoring export (export_monitoring.py writes a
  // "setup" section: the target's brand, topics and questions). Question ids
  // come from the export, so old per-question state is cleared, as in submitSetup.
  function loadExportSetup(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed || !parsed.results || !validSetup(parsed.setup)) throw new Error('not a monitoring export with setup');
        own = emptyOwnData(parsed.setup.brand, parsed.setup.categories, parsed.setup.questions);
        own.runList = runListFromSetup(parsed.setup);
        own.demo = demoFromExport(parsed, null);
        saveOwn(own);
        try { window.localStorage.removeItem('geo-engine:v1:own'); } catch (err) { /* storage unavailable */ }
        setupDraft = null;
        boot();
      } catch (err) {
        setupDraft.error = 'Could not read that file — expected monitoring_export.json from scripts/export_monitoring.py.';
        renderSetup();
      }
    };
    reader.readAsText(file);
  }
  function submitSetup() {
    const d = setupDraft;
    const name = d.name.trim();
    const domain = d.domain.trim();
    const topics = d.topics
      .map(t => ({ label: t.label.trim(), keywords: t.keywords.split(',').map(s => s.trim()).filter(Boolean) }))
      .filter(t => t.label);
    if (!name) { d.error = 'Please enter a company name.'; renderSetup(); return; }
    if (!domain) { d.error = 'Please enter a website domain.'; renderSetup(); return; }
    if (!topics.length) { d.error = 'Add at least one topic.'; renderSetup(); return; }

    const usedIds = {};
    const categories = topics.map(t => {
      let id = CORE.slugify(t.label);
      let n = 2;
      while (usedIds[id]) { id = CORE.slugify(t.label) + '-' + n++; }
      usedIds[id] = true;
      return { id, label_en: t.label, label_de: t.label, keywords: t.keywords.length ? t.keywords : [t.label.toLowerCase()] };
    });
    const questions = CORE.generateQuestions(categories, { perCategory: 6, keyCount: Math.min(15, categories.length * 6) });
    const aliases = d.aliases.split(',').map(s => s.trim()).filter(Boolean);
    const brand = { name, short: name.split(' ')[0], domain, city: '', aliases: aliases.length ? aliases : [name] };

    own = emptyOwnData(brand, categories, questions);
    saveOwn(own);
    // Regenerating assigns question ids from scratch (q1, q2, ...) -- without
    // this, a draft/activation/audit-checkmark saved against the *old* set of
    // ids would silently reattach to whatever unrelated question happens to
    // get the same id this time. Clearing is the honest behavior: redoing
    // your topics means your old gap-tracking state doesn't carry over.
    try { window.localStorage.removeItem('geo-engine:v1:own'); } catch (e) { /* storage unavailable */ }
    setupDraft = null;
    boot();
  }

  // ---------- Main app ----------
  function boot() {
    const D = mode === 'own' ? own : window.GEO_DATA;
    const BRAND = D.brand;
    const ANSWERS = (D.demo && D.demo.answers) || {};
    const COMPETITORS = (D.demo && D.demo.competitors) || [];
    const BRAND_NAMES = (BRAND.aliases && BRAND.aliases.length ? BRAND.aliases : [BRAND.name || BRAND.short]).filter(Boolean);
    const STR = window.makeStrings(BRAND.short);
    const ENGINES = [{ id: 'claude', name: 'Claude' }, { id: 'gpt', name: 'ChatGPT' }, { id: 'gemini', name: 'Gemini' }];
    const TYPES = ['statement', 'definition', 'figure', 'case', 'quote', 'faq'];
    // Top-level nav is Overview + 2 groups, instead of 7 flat tabs: "Monitor" is
    // what the engines are doing (the read side), "Improve" is what to do about
    // it (the act side). Each group's children render as a second-level tab row.
    // Website (find the gap) and Write (close it) are the actual workflow;
    // Library is reference material you dip into, not a destination -- kept
    // last/rightmost so it's still one click away without competing with the
    // two active steps.
    const GROUPS = { monitor: ['questions', 'run', 'sources', 'impact'], improve: ['website', 'write', 'library'] };
    const GROUP_OF = {};
    Object.keys(GROUPS).forEach(g => GROUPS[g].forEach(id => { GROUP_OF[id] = g; }));
    const TYPE_FG = { statement: 'var(--type-statement)', definition: 'var(--type-definition)', figure: 'var(--type-figure)', case: 'var(--type-case)', quote: 'var(--type-quote)', faq: 'var(--type-faq)' };
    // Namespaced per mode so switching demo <-> own brand never mixes up
    // activations/custom questions/drafts/audit checkmarks between the two.
    const STORE_KEY = 'geo-engine:v1:' + mode;

    // ---------- Data preparation ----------
    const CATS = D.categories.map(c => ({ id: c.id, kw: c.keywords }));
    const QUESTIONS = D.questions.map(q => {
      const res = D.demo.results[q.id];
      return { id: q.id, text: q.text, tags: q.categories, key: q.key, custom: !!q.custom, comp: res ? res.competitor : null, r: res ? CORE.parseResult(res.r) : null };
    });
    const BASE_BLOCKS = D.blocks.map(b => ({ id: b.id, type: b.type, tags: b.categories, de: b.text_de, en: b.text_en, source: b.source, placeholder: b.placeholder }));
    // Like allQ() for questions: content blocks added in-browser (no terminal, no
    // API key, no backend — just localStorage) merge in alongside the bundled ones.
    const allBlocksList = () => BASE_BLOCKS.concat(state.customBlocks.map(cb => ({ id: cb.id, type: cb.type, tags: cb.categories, de: cb.text, en: cb.text, source: cb.source || null, placeholder: false })));

    // ---------- Helpers ----------
    const overlaps = CORE.overlaps;
    const pct = CORE.pct;
    const kwHit = CORE.kwHit;
    const DEFAULT_Q = (QUESTIONS[0] && QUESTIONS[0].id) || 'q1';
    const DEFAULT_CAT = (CATS[0] && CATS[0].id) || 'general';

    // ---------- State ----------
    const saved = load();
    const state = Object.assign({
      lang: 'en', tab: 'overview', scope: 'key', onlyGaps: false, srcFilter: 'all',
      libCat: 'all', libType: 'all', writeStep: 1, allBlocks: false, selectedQ: DEFAULT_Q,
      brief: '', newQ: '', newCat: DEFAULT_CAT, formMsg: '', copied: null,
      newBlockType: 'statement', newBlockText: '', newBlockCats: [], blockMsg: '', monitoringMsg: '', pagesMsg: '',
      importText: '', importSource: '', importCands: [], importMsg: '', polished: {}, factConfirm: {},
      active: {}, custom: [], customBlocks: [], drafts: {}, auditDone: {},
      // Redesign: overlays, filters, sorting. Not persisted.
      drawerQ: null, palette: false, palQuery: '', palSel: 0, help: false, navOpen: false, qSel: -1,
      qSearch: '', qTopic: 'all', qSort: 'default', qDir: 1, srcSearch: '', srcSort: 'cites', libSearch: '',
      fx: 'page'
    }, saved);
    let drag = null;

    function load() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        const v = raw ? JSON.parse(raw) : {};
        return {
          lang: v.lang === 'de' ? 'de' : 'en', active: v.active || {}, custom: Array.isArray(v.custom) ? v.custom : [],
          customBlocks: Array.isArray(v.customBlocks) ? v.customBlocks : [], drafts: v.drafts || {}, auditDone: v.auditDone || {},
          // Unreviewed suggestions survive a reload, so review work isn't lost.
          importCands: Array.isArray(v.importCands) ? v.importCands : [], importSource: typeof v.importSource === 'string' ? v.importSource : '',
          polished: v.polished && typeof v.polished === 'object' ? v.polished : {}, factConfirm: v.factConfirm && typeof v.factConfirm === 'object' ? v.factConfirm : {}
        };
      } catch (e) { return {}; }
    }
    function persist() {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ lang: state.lang, active: state.active, custom: state.custom, customBlocks: state.customBlocks, drafts: state.drafts, auditDone: state.auditDone, importCands: state.importCands, importSource: state.importSource, polished: state.polished, factConfirm: state.factConfirm }));
      } catch (e) { /* storage unavailable – state stays in memory */ }
    }
    // fx names the one element that should play its entrance animation on
    // this render ('page', 'drawer', 'palette', 'help'); render() clears it,
    // so later re-renders don't replay the animation.
    function set(patch) {
      if (patch.tab && patch.tab !== state.tab) Object.assign(patch, { fx: 'page', navOpen: false, drawerQ: null, qSel: -1 });
      Object.assign(state, patch); persist(); render();
    }

    // ---------- Domain logic ----------
    const L = () => STR[state.lang];
    // Topic labels come from categories.json (label_en/label_de).
    const CAT_BY_ID = Object.fromEntries(D.categories.map(c => [c.id, c]));
    const catLabel = id => { const c = CAT_BY_ID[id]; return (c && (state.lang === 'de' ? c.label_de : c.label_en)) || id; };
    const catLabels = tags => tags.map(catLabel).join(' · ');
    const blockText = b => state.lang === 'de' ? b.de : b.en;
    // Questions added in the browser that an export already brought back
    // (same id) are listed once.
    const allQ = () => QUESTIONS.concat(state.custom.filter(c => !QUESTIONS.some(q => q.id === c.id)));
    // Questions the last saved or exported run list contains start switched on.
    const SAVED_RUN = mode === 'own' && own && Array.isArray(own.runList) ? new Set(own.runList) : null;
    const isActive = q => state.active[q.id] === undefined ? (q.key || !!q.custom || !!(SAVED_RUN && SAVED_RUN.has(q.id))) : state.active[q.id];

    function status(q, eng) {
      if (!isActive(q)) return { k: 'inactive' };
      if (q.r) return { k: q.r[eng][0], p: q.r[eng][1] };
      return { k: 'notrun' };
    }
    const absentCount = q => ENGINES.filter(e => status(q, e.id).k === 'absent').length;
    const isGap = q => absentCount(q) > 0;
    const isHit = k => k === 'cited' || k === 'mentioned';

    function catStats(catId) {
      const qs = allQ().filter(q => isActive(q) && q.tags.indexOf(catId) !== -1);
      const gapQs = qs.filter(isGap).sort((a, b) => (b.key - a.key) || (absentCount(b) - absentCount(a)));
      let answers = 0, absent = 0, hits = 0, weight = 0;
      qs.forEach(q => ENGINES.forEach(e => {
        const k = status(q, e.id).k;
        if (k === 'absent' || isHit(k)) answers++;
        if (k === 'absent') absent++;
        if (isHit(k)) hits++;
      }));
      gapQs.forEach(q => { weight += absentCount(q) * (q.key ? 2 : 1); });
      const blocks = allBlocksList().filter(b => b.tags.indexOf(catId) !== -1);
      const missing = TYPES.filter(t => !blocks.some(b => b.type === t));
      return { qs, gapQs, answers, absent, hits, weight, blocks, missing, keyGaps: gapQs.filter(q => q.key).length };
    }

    const scoreDraft = CORE.scoreDraft;

    function openDraft(qid) { set({ tab: 'write', writeStep: 2, selectedQ: qid, allBlocks: false }); }
    function getDraft() { return (state.drafts[state.selectedQ] || []).slice(); }
    function setDraft(list) { const d = Object.assign({}, state.drafts); d[state.selectedQ] = list; set({ drafts: d }); }
    function dropAt(idx) {
      if (!drag) return;
      const list = getDraft();
      if (drag.kind === 'lib') {
        if (list.indexOf(drag.id) === -1) list.splice(idx, 0, drag.id);
      } else {
        const moved = list.splice(drag.index, 1)[0];
        if (drag.index < idx) idx--;
        list.splice(idx, 0, moved);
      }
      drag = null;
      setDraft(list);
    }

    // ---------- Render helpers ----------
    const tabBtn = (label, on_, fn) => '<button class="tab' + (on_ ? ' on' : '') + '"' + (on_ ? ' aria-current="page"' : '') + ' ' + click(fn) + '>' + esc(label) + '</button>';
    const stat = (n, l, color, big) => '<div class="stat"><span class="n' + (big ? ' big' : '') + '"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(n) + '</span><span class="l">' + esc(l) + '</span></div>';
    const track = (w, color) => '<div class="track"><div style="width:' + Math.max(0, Math.min(100, w)) + '%;' + (color ? 'background:' + color : '') + '"></div></div>';
    // Shown instead of a bare "no rows" message when you're set up with your own
    // brand but haven't run the local step that fills this tab yet — points at
    // the exact command, which runs on your machine with your own key (if any),
    // never touching this app's server (there isn't one).
    function ownHint(cmd, note) {
      const l = L();
      return '<div class="card" style="gap:10px"><span class="s14" style="font-weight:500">' + esc(l.emptyHintTitle) + '</span>' +
        '<code class="mono s13" style="display:block;white-space:pre-wrap;background:var(--bg);border:1px solid var(--input);border-radius:6px;padding:10px 12px">' + esc(cmd) + '</code>' +
        '<span class="s13 muted">' + esc(note) + '</span></div>';
    }
    function dot(st) {
      const l = L();
      const p = st.p ? '#' + st.p : '';
      const m = {
        cited: [C.accent, C.accent, l.dot.cited, p], mentioned: ['var(--bg)', C.accent, l.dot.mentioned, p],
        absent: [C.warn, C.warn, l.dot.absent, ''], notrun: ['var(--bg)', C.graphic, l.dot.notrun, ''],
        inactive: ['var(--bg)', 'var(--line)', l.dot.inactive, '']
      }[st.k];
      return '<span class="cell"><span class="dot" title="' + esc(m[2]) + '" style="background:' + m[0] + ';border-color:' + m[1] + '"></span>' +
        '<span class="mono small muted">' + esc(m[3]) + '</span><span class="sr">' + esc(m[2]) + '</span></span>';
    }

    // ---------- Views ----------
    // Shown instead of viewOverview right after setup, while there's still
    // nothing real to show a dashboard of. A checklist, not a confusing
    // "0% everywhere" chart. Steps through to viewOverview once any real
    // data exists (so this never becomes a permanent extra screen to navigate).
    function viewGettingStarted() {
      const l = L();
      const steps = [
        { done: true, title: l.gsStep1Title, text: l.gsStep1Text },
        { done: allBlocksList().length > 0, title: l.gsStep2Title, text: l.gsStep2Text, actionLabel: l.gsStep2Action, action: () => set({ tab: 'library' }) },
        { done: D.audit.length > 0 || D.pages.length > 0, title: l.gsStep3Title, text: l.gsStep3Text, actionLabel: l.gsStep3Action, action: () => set({ tab: 'website' }) },
        { done: Object.keys(D.demo.results).length > 0, title: l.gsStep4Title, text: l.gsStep4Text, actionLabel: l.gsStep4Action, action: () => set({ tab: 'sources' }) }
      ];
      const rows = steps.map(s =>
        '<div class="card" style="flex-direction:row;align-items:flex-start;gap:16px;padding:20px 24px">' +
        '<span style="flex-shrink:0;margin-top:1px;color:' + (s.done ? C.accent : C.faint) + '">' + (s.done ? iconCheck(20) : iconCircle(20)) + '</span>' +
        '<div style="display:flex;flex-direction:column;gap:4px;flex-grow:1;min-width:0">' +
        '<span style="font-weight:500' + (s.done ? ';color:' + C.muted : '') + '">' + esc(s.title) + '</span>' +
        '<span class="s14 muted">' + esc(s.text) + '</span></div>' +
        (s.action && !s.done ? '<button class="btn sm plain" style="flex-shrink:0" ' + click(s.action) + '>' + esc(s.actionLabel) + '</button>' : '') +
        '</div>'
      ).join('');
      return '<section><div class="head"><h1>' + esc(l.gsTitle(BRAND.short)) + '</h1><p>' + esc(l.gsSub) + '</p></div>' +
        '<div style="display:flex;flex-direction:column;gap:12px">' + rows + '</div></section>';
    }

    // Weekly visibility series shared by Overview and Impact. With real
    // weekly data (trend_ci from export_monitoring.py) each week is its
    // measured rate with a 95% range; the demo series instead ends on today's
    // key-question figure (TASKS.md D3).
    function trendData(ctx) {
      const l = L();
      const CI = Array.isArray(D.demo.trend_ci) && D.demo.trend_ci.length ? D.demo.trend_ci : null;
      const values = CI ? CI.map(w => w.rate) : D.demo.trend.length ? D.demo.trend.slice(0, -1).concat([ctx.nowPct]) : [ctx.nowPct];
      const labels = values.map((_, i) => CI ? CI[i].week.slice(5) : l.ui.week(i + 1));
      const markers = {};
      (D.demo.pieces || []).forEach(p => { if (p.week >= 1 && p.week <= values.length) markers[p.week - 1] = p.mark; });
      const tips = values.map((v, i) => {
        const piece = (D.demo.pieces || []).find(p => p.week === i + 1);
        return l.ui.trendTip(labels[i], v, CI ? CI[i].lo : null, CI ? CI[i].hi : null) + (piece ? '\n' + piece.mark + ': ' + piece[state.lang] : '');
      });
      return { CI, values, labels, markers, tips };
    }
    // Date of the newest stored answer, else the audit date.
    function dataDate() {
      let d = '';
      Object.keys(ANSWERS).forEach(k => (ANSWERS[k] || []).forEach(a => { if (a.date && a.date > d) d = a.date; }));
      return d || (D.demo.audit_meta && D.demo.audit_meta.date) || '';
    }
    function deltaBadge(n, l) {
      const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
      return '<span class="delta ' + cls + '" data-tt="' + esc(l.ui.vsPrev) + '">' + (n > 0 ? '↑ ' : n < 0 ? '↓ ' : '') + esc(l.ui.upPp(n)) + '</span>';
    }
    const infoTip = text => '<button class="info" aria-label="' + esc(text) + '" data-tt="' + esc(text) + '">' + ic('info', 14) + '</button>';

    function viewOverview(ctx) {
      const l = L();
      const T = trendData(ctx);
      const vals = T.values;
      const delta = vals.length > 1 ? vals[vals.length - 1] - vals[vals.length - 2] : 0;
      const keyQs = QUESTIONS.filter(q => q.key);
      const perEngine = ENGINES.map((e, i) => {
        const c = { cited: 0, mentioned: 0, absent: 0, other: 0 };
        keyQs.forEach(q => { const k = status(q, e.id).k; if (c[k] !== undefined) c[k]++; else c.other++; });
        return { e, i, c, pct: pct(c.cited + c.mentioned, keyQs.length) };
      });
      const citedTotal = perEngine.reduce((a, x) => a + x.c.cited, 0);
      const citedPct = pct(citedTotal, keyQs.length * ENGINES.length);
      const best = perEngine.slice().sort((a, b) => b.pct - a.pct)[0];
      const date = dataDate();

      const banner = '<div class="banner"><span class="pulse" aria-hidden="true"></span>' +
        (date ? '<span class="item"><b style="font-weight:600;color:var(--fg)">' + esc(l.ui.lastData(date)) + '</b></span><span class="sep"></span>' : '') +
        '<span class="item">' + esc(l.ui.kpiVis) + ' ' + deltaBadge(delta, l) + '<span class="muted">' + esc(l.ui.vsPrev) + '</span></span><span class="sep"></span>' +
        '<span class="item">' + esc(l.ui.bannerGaps(ctx.gapQs.length)) + '</span>' +
        (ctx.fullGapCount ? '<span class="sep"></span><span class="item warn">' + esc(l.ui.bannerKeyFull(keyQs.filter(q => absentCount(q) === 3).length)) + '</span>' : '') + '</div>';

      const tile = (label, tip, value, sub, side) => '<div class="kpi-tile"><div class="top"><span>' + esc(label) + ' ' + infoTip(tip) + '</span></div>' +
        '<div class="mid"><span class="n">' + value + '</span>' + (side || '') + '</div><span class="l">' + sub + '</span></div>';
      const kpis = '<div class="kpis">' +
        tile(l.ui.kpiVis, l.ui.kpiVisTip, ctx.nowPct + '<span style="font-size:18px;color:var(--muted)">%</span>', deltaBadge(delta, l) + ' <span>' + esc(l.ui.vsPrev) + '</span>', CH.sparkline(vals, { w: 104, h: 34 })) +
        tile(l.ui.kpiCited, l.ui.kpiCitedTip, citedPct + '<span style="font-size:18px;color:var(--muted)">%</span>', esc(l.ui.kpiCitedSub), '<div style="width:110px">' + CH.stackBar([{ value: citedTotal, color: 'var(--st-cited)', label: l.dot.cited }, { value: perEngine.reduce((a, x) => a + x.c.mentioned, 0), color: 'var(--st-mentioned)', label: l.dot.mentioned }, { value: perEngine.reduce((a, x) => a + x.c.absent, 0), color: 'var(--st-absent)', label: l.dot.absent }]) + '</div>') +
        tile(l.ui.kpiGaps, l.ui.kpiGapsTip, '<span class="warn">' + ctx.gapQs.length + '</span>', esc(l.fullGap(ctx.fullGapCount)),
          '<span class="small muted" style="white-space:nowrap">' + esc(l.ui.gapSplit(ctx.gapQs.filter(q => q.key).length, ctx.gapQs.filter(q => !q.key).length)) + '</span>') +
        tile(l.ui.kpiBest, l.ui.kpiVisTip, '<span style="display:inline-flex;align-items:center;gap:8px"><span class="swatch" style="width:12px;height:12px;border-radius:3px;background:var(--viz-' + (best.i + 1) + ')"></span>' + esc(best.e.name) + '</span>',
          esc(l.ui.kpiBestSub(best.e.name, best.pct))) +
        '</div>';

      const trend = '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.ui.trendTitle) + '</h2><span class="sub">' + esc(l.ui.trendSub) + '</span></div>' +
        '<button class="link" ' + click(() => set({ tab: 'impact' })) + '>' + esc(l.tabs.impact) + ic('arrow', 14) + '</button></div>' +
        '<div class="panel-b">' + CH.lineChart({ values: vals, labels: T.labels, ci: T.CI ? T.CI.map(c => ({ lo: c.lo, hi: c.hi })) : null, markers: T.markers, tips: T.tips, alt: T.CI ? l.impCiAlt(T.CI) : l.impAlt(vals[0], ctx.nowPct) }, { w: 660, h: 260 }) +
        (Object.keys(T.markers).length ? '<div class="legend" style="margin-top:6px"><span>' + esc(l.ui.trendMarkers) + '</span></div>' : '') + '</div></div>';

      const engines = '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.ui.enginesTitle) + '</h2><span class="sub">' + esc(l.ui.enginesSub) + '</span></div></div>' +
        '<div class="panel-b" style="display:flex;flex-direction:column;gap:18px"><div class="engines">' + perEngine.map(x =>
          '<div class="engine">' + CH.ring(x.pct, { size: 76, stroke: 8, color: 'var(--viz-' + (x.i + 1) + ')', label: x.e.name + ' ' + x.pct + '%' }) +
          '<span class="name"><span class="swatch" style="background:var(--viz-' + (x.i + 1) + ')"></span>' + esc(x.e.name) + '</span></div>').join('') + '</div>' +
        perEngine.map(x => '<div style="display:flex;flex-direction:column;gap:5px"><div class="small" style="display:flex;justify-content:space-between"><span style="color:var(--fg2);font-weight:500">' + esc(x.e.name) + '</span>' +
          '<span class="muted num">' + x.c.cited + ' · ' + x.c.mentioned + ' · ' + x.c.absent + '</span></div>' +
          CH.stackBar([{ value: x.c.cited, color: 'var(--st-cited)', label: l.dot.cited }, { value: x.c.mentioned, color: 'var(--st-mentioned)', label: l.dot.mentioned }, { value: x.c.absent, color: 'var(--st-absent)', label: l.dot.absent }, { value: x.c.other, color: 'var(--st-none)', label: l.dot.notrun }]) + '</div>').join('') +
        '<div class="legend">' + ['cited', 'mentioned', 'absent'].map(k => '<span><span class="swatch" style="background:var(--st-' + k + ')"></span>' + esc(l.dot[k]) + '</span>').join('') + '</div></div></div>';

      const heatRows = keyQs.map(q => '<button class="heat-q" data-tt="' + esc(q.text) + '" ' + click(() => openQuestion(q.id)) + '>' + esc(q.text) + '</button>' +
        ENGINES.map(e => { const st = status(q, e.id); return '<button class="heat-cell ' + st.k + '" aria-label="' + esc(e.name + ': ' + l.dot[st.k] + ' – ' + q.text) + '" data-tt="' + esc(l.ui.heatTip(q.text, e.name, l.dot[st.k] + (st.p ? ' · ' + l.ui.position + ' ' + st.p : ''))) + '" ' + click(() => openQuestion(q.id)) + '>' + (st.p ? st.p : st.k === 'absent' ? '–' : '') + '</button>'; }).join('')).join('');
      const heat = '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.ui.heatTitle) + '</h2><span class="sub">' + esc(l.ui.heatSub) + '</span></div>' +
        '<button class="link" ' + click(() => set({ tab: 'questions' })) + '>' + esc(l.tabs.questions) + ic('arrow', 14) + '</button></div>' +
        '<div class="panel-b"><div class="heat"><span class="heat-h">' + esc(l.ui.colQuestion) + '</span>' + ENGINES.map(e => '<span class="heat-h">' + esc(e.name) + '</span>').join('') + heatRows + '</div>' +
        '<div class="legend" style="margin-top:12px">' + ['cited', 'mentioned', 'absent'].map(k => '<span><span class="swatch" style="background:var(--st-' + k + ')"></span>' + esc(l.dot[k]) + '</span>').join('') + '<span>' + esc(l.legendNote) + '</span></div></div></div>';

      const gaps = ctx.gapQs.slice().sort((a, b) => (b.key - a.key) || (absentCount(b) - absentCount(a))).slice(0, 6);
      const nba = '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.ui.nbaTitle) + '</h2><span class="sub">' + esc(l.ui.nbaSub) + '</span></div></div>' +
        '<div class="nba">' + (gaps.length ? gaps.map((q, n) => '<div class="nba-item"><span class="nba-n">' + (n + 1) + '</span>' +
          '<div class="t"><button class="link" style="color:var(--fg);text-align:left;min-height:0;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%" ' + click(() => openQuestion(q.id)) + '>' + esc(q.text) + '</button>' +
          '<span class="small muted">' + esc((q.key ? l.keyQ + ' · ' : '') + catLabels(q.tags)) + '</span></div>' +
          '<span class="small warn" style="white-space:nowrap">' + esc(l.missingShort(absentCount(q))) + '</span>' +
          '<button class="btn sm outline" ' + click(() => openDraft(q.id)) + '>' + esc(l.close) + '</button></div>').join('')
          : '<div class="empty">' + ic('check', 22) + '<span>' + esc(l.ui.nbaEmpty) + '</span></div>') + '</div></div>';

      const topicRows = CATS.map(c => { const st = catStats(c.id); return { c, st, p: st.answers ? pct(st.hits, st.answers) : null }; })
        .sort((a, b) => (a.p === null) - (b.p === null) || a.p - b.p)
        .map(o => ({ label: catLabel(o.c.id), sub: o.st.gapQs.length ? l.ui.bannerGaps(o.st.gapQs.length) : '', value: o.p,
          color: o.p !== null && o.p < 34 ? 'var(--st-absent)' : 'var(--viz-1)', tip: o.p === null ? '' : l.ui.topicTip(catLabel(o.c.id), o.st.hits, o.st.answers) }));
      const topics = '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.visByTopic) + '</h2><span class="sub">' + esc(l.ui.topicsSub) + '</span></div></div>' +
        '<div class="panel-b" style="padding-top:6px;padding-bottom:6px">' + CH.barList(topicRows) + '</div></div>';

      const top = ctx.ranked[0];
      const callout = top ? '<div class="callout"><div style="display:flex;flex-direction:column;gap:2px"><span class="s13 muted">' + esc(l.recToday) + '</span><span style="font-size:16px;font-weight:600">' + esc(l.teaser(catLabel(top.c.id), top.st.gapQs.length)) + '</span></div>' +
        '<button class="btn" ' + click(() => set({ tab: 'write', writeStep: 1, brief: '' })) + '>' + ic('write', 15) + esc(l.writeCta.replace(/\s*→$/, '')) + '</button></div>' : '';

      return '<section><div class="page-head"><div class="head"><h1>' + esc(l.tabs.overview) + ' · ' + esc(BRAND.short) + '</h1><p>' + esc(l.ui.overviewSub) + '</p></div>' +
        '<div class="actions"><button class="btn" ' + click(() => set({ tab: 'write', writeStep: 1, brief: '' })) + '>' + ic('write', 15) + esc(l.ui.actWrite) + '</button></div></div>' +
        banner + kpis +
        '<div class="grid g-main">' + trend + engines + '</div>' +
        '<div class="grid g-main">' + nba + topics + '</div>' +
        heat + callout + '</section>';
    }

    // Sort weight for one engine's status: cited > mentioned > absent > none.
    const ST_RANK = { cited: 3, mentioned: 2, absent: 1, notrun: 0, inactive: -1 };
    const coverage = q => ENGINES.reduce((n, e) => n + (isHit(status(q, e.id).k) ? 1 : 0), 0);

    function viewQuestions() {
      const l = L();
      const inScope = q => state.scope === 'all' || (state.scope === 'key' && q.key) || (state.scope === 'more' && !q.key && !q.custom) || (state.scope === 'custom' && q.custom);
      const words = state.qSearch.toLowerCase().split(/\s+/).filter(Boolean);
      const scoped = allQ().filter(inScope);
      let rows = scoped.filter(q => (!state.onlyGaps || isGap(q)) && (state.qTopic === 'all' || q.tags.indexOf(state.qTopic) !== -1) &&
        words.every(w => (q.text + ' ' + catLabels(q.tags)).toLowerCase().indexOf(w) !== -1));
      const dir = state.qDir;
      const sorters = {
        text: (a, b) => a.text.localeCompare(b.text) * dir,
        cov: (a, b) => (coverage(a) - coverage(b)) * dir || (b.key - a.key),
      };
      ENGINES.forEach(e => { sorters[e.id] = (a, b) => (ST_RANK[status(a, e.id).k] - ST_RANK[status(b, e.id).k]) * dir || (b.key - a.key); });
      if (sorters[state.qSort]) rows = rows.slice().sort(sorters[state.qSort]);
      visibleQs = rows;
      const sortBtn = (id, label) => {
        const on = state.qSort === id;
        return '<button class="th' + (on ? ' on' : '') + '" aria-sort="' + (on ? (dir > 0 ? 'ascending' : 'descending') : 'none') + '" ' +
          click(() => set(on ? (dir > 0 ? { qDir: -1 } : { qSort: 'default', qDir: 1 }) : { qSort: id, qDir: id === 'text' ? 1 : -1 })) + '>' + esc(label) +
          (on ? ic(dir > 0 ? 'up' : 'down', 12) : '') + '</button>';
      };
      const count = f => allQ().filter(f).length;
      const scopes = [['key', l.ui.scopeKey, q => q.key], ['more', l.ui.scopeMore, q => !q.key && !q.custom], ['custom', l.ui.scopeCustom, q => q.custom], ['all', l.all, () => true]]
        .map(f => '<button class="' + (state.scope === f[0] ? 'on' : '') + '" aria-pressed="' + (state.scope === f[0]) + '" ' + click(() => set({ scope: f[0], qSel: -1 })) + '>' + esc(f[1]) + '<span class="c">' + count(f[2]) + '</span></button>').join('');
      const topicOpts = '<option value="all">' + esc(l.ui.allTopics) + '</option>' + CATS.map(c => '<option value="' + c.id + '"' + (state.qTopic === c.id ? ' selected' : '') + '>' + esc(catLabel(c.id)) + '</option>').join('');
      const opts = CATS.map(c => '<option value="' + c.id + '"' + (state.newCat === c.id ? ' selected' : '') + '>' + esc(catLabel(c.id)) + '</option>').join('');
      const body = rows.map((q, n) => {
        const act = isActive(q); const gap = isGap(q); const hasData = !!q.r;
        let label, fn, cls;
        if (!act) { label = l.actActivate; fn = () => toggleActive(q); cls = 'ghost'; }
        else if (gap) { label = l.actClose; fn = () => openDraft(q.id); cls = 'outline'; }
        else if (!hasData) { label = l.actWait; fn = null; cls = 'ghost'; }
        else { label = l.actExpand; fn = () => openDraft(q.id); cls = 'plain'; }
        const meta = (q.key ? l.metaKey : q.custom ? l.metaCustom : l.metaManual) + ' · ' + catLabels(q.tags) + (q.r && q.comp ? ' · ' + l.comp + q.comp : '');
        const sel = n === state.qSel || q.id === state.drawerQ;
        return '<div class="row qgrid qrow' + (sel ? ' sel' : '') + '" ' + click(e => { if (!e.target.closest('input, button')) { state.qSel = n; openQuestion(q.id); } }) + '>' +
          '<input type="checkbox"' + (act ? ' checked' : '') + ' aria-label="' + esc((act ? l.ariaOff : l.ariaOn) + q.text) + '" ' + attr('change', () => toggleActive(q)) + '>' +
          '<div style="display:flex;flex-direction:column;gap:2px;min-width:0"><button class="link qt" style="color:' + (act ? 'var(--fg)' : 'var(--muted)') + ';font-weight:500;text-align:left;min-height:0;display:block" ' + click(() => { state.qSel = n; openQuestion(q.id); }) + '>' + esc(q.text) + '</button>' +
          '<span class="small muted">' + esc(meta) + '</span></div>' +
          ENGINES.map(e => '<div>' + chip(status(q, e.id), true) + '</div>').join('') +
          '<div style="display:flex;justify-content:flex-end"><button class="btn sm ' + cls + '"' + (fn ? ' ' + click(fn) : ' disabled') + '>' + esc(label) + '</button></div></div>';
      }).join('');
      const empty = '<div class="empty">' + ic('search', 22) + '<b>' + esc(l.ui.noMatch) + '</b><span class="s13">' + esc(l.ui.noMatchSub) + '</span>' +
        '<button class="btn sm plain" ' + click(() => set({ qSearch: '', qTopic: 'all', onlyGaps: false, scope: 'all' })) + '>' + esc(l.ui.clear) + '</button></div>';
      return '<section><div class="page-head"><div class="head"><h1>' + esc(l.tabs.questions) + '</h1><p>' + esc(l.questionsSub) + '</p></div></div>' +
        '<div class="toolbar">' +
        '<div class="search">' + ic('search', 15) + '<label for="q-filter" class="sr">' + esc(l.ui.filterQ) + '</label><input id="q-filter" data-filter type="search" placeholder="' + esc(l.ui.filterQ) + '" value="' + esc(state.qSearch) + '" ' + attr('input', e => set({ qSearch: e.target.value, qSel: -1 })) + '></div>' +
        '<div class="seg" role="group" aria-label="Scope">' + scopes + '</div>' +
        '<label for="q-topic" class="sr">' + esc(l.topicLabel) + '</label><select id="q-topic" ' + attr('change', e => set({ qTopic: e.target.value, qSel: -1 })) + '>' + topicOpts + '</select>' +
        '<button class="toggle' + (state.onlyGaps ? ' on' : '') + '" aria-pressed="' + state.onlyGaps + '" ' + click(() => set({ onlyGaps: !state.onlyGaps, qSel: -1 })) + '>' + esc(l.onlyGaps) + '</button>' +
        '<span class="count-note">' + esc(l.ui.shown(rows.length, scoped.length)) + '</span></div>' +
        '<div class="table-wrap"><div class="scroll"><div style="min-width:820px">' +
        '<div class="qgrid h thead"><span></span>' + sortBtn('text', l.ui.colQuestion) + ENGINES.map(e => sortBtn(e.id, e.name)).join('') + '<span style="text-align:right">' + sortBtn('cov', l.ui.colCoverage) + '</span></div>' +
        (rows.length ? body : empty) + '</div></div></div>' +
        '<div class="legend">' +
        ['cited', 'mentioned', 'absent'].map(k => '<span>' + chip({ k }, true) + esc(l.dot[k]) + '</span>').join('') +
        '<span>' + esc(l.legendNote) + '</span><span style="margin-left:auto">' + '<kbd>J</kbd><kbd>K</kbd> · <kbd>↵</kbd> · <kbd>/</kbd></span></div>' +
        '<div class="card" style="gap:10px"><h2>' + esc(l.newQLabel) + '</h2><div class="form">' +
        '<label for="newq" class="sr">' + esc(l.newQLabel) + '</label><input id="newq" type="text" maxlength="300" value="' + esc(state.newQ) + '" placeholder="' + esc(l.newQPh) + '" ' + attr('input', e => { state.newQ = e.target.value; }) + ' ' + attr('keydown', e => { if (e.key === 'Enter') addQuestion(); }) + '>' +
        '<label for="newcat" class="sr">' + esc(l.topicLabel) + '</label><select id="newcat" ' + attr('change', e => { state.newCat = e.target.value; }) + '>' + opts + '</select>' +
        '<button class="btn" ' + click(() => addQuestion()) + '>' + esc(l.save) + '</button></div>' +
        '<span class="small" style="color:' + (state.formMsg === 'short' ? 'var(--warn)' : C.muted) + '">' + esc(state.formMsg === 'short' ? l.msg.short : l.formHint) + '</span></div></section>';
    }

    // ---------- Answer viewer (TASKS.md D1) ----------
    // Shown in the question drawer: each stored answer with brand and
    // competitor names highlighted.
    function answerItems(ans) {
      const l = L();
      const engineIdx = id => ENGINES.findIndex(e => e.id === id);
      return '<div class="answers">' + ans.map(a => {
        const i = engineIdx(a.engine);
        return '<div class="answer"><div class="small muted" style="display:flex;align-items:center;gap:6px">' +
          (i >= 0 ? '<span class="swatch" style="background:var(--viz-' + (i + 1) + ')"></span><b style="color:var(--fg);font-weight:600">' + esc(ENGINES[i].name) + '</b>' : esc(a.engine)) +
          '<span>· ' + esc(a.model === 'demo' ? l.answerDemo : a.model + ' · ' + a.date) + '</span></div>' +
          (a.variant > 0 && a.prompt ? '<div class="small" style="color:var(--fg2);margin-top:4px">' + esc(l.answerVariant) + ': ' + esc(a.prompt) + '</div>' : '') +
          '<p>' + CORE.highlightMentions(a.text, BRAND_NAMES, COMPETITORS) + '</p></div>';
      }).join('') + '</div>';
    }

    // ---------- Share of voice (TASKS.md D2) ----------
    function sovSection() {
      if (!Object.keys(ANSWERS).length || !COMPETITORS.length) return '';
      const l = L();
      const rows = CORE.shareOfVoice(ANSWERS, QUESTIONS, CATS.map(c => c.id), BRAND_NAMES, COMPETITORS)
        .filter(r => r.answers > 0)
        .map(r => ({ label: catLabel(r.cat), sub: l.sovAnswers(r.answers) + (r.top.length ? ' · ' + l.sovTop + r.top[0].name : ''), value: r.share }));
      return '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.sovTitle) + '</h2><span class="sub">' + esc(l.sovSub) + '</span></div></div>' +
        '<div class="panel-b" style="padding-top:6px;padding-bottom:6px">' + CH.barList(rows) + '</div></div>';
    }

    function toggleActive(q) { const a = Object.assign({}, state.active); a[q.id] = !isActive(q); set({ active: a }); }
    function addQuestion(stay) {
      const text = state.newQ.trim();
      if (text.length < 8) { set({ formMsg: 'short' }); return; }
      const q = { id: 'c' + Date.now().toString(36), text: text.slice(0, 300), tags: [state.newCat], key: false, custom: true, createdAt: new Date().toISOString() };
      set(Object.assign({ custom: state.custom.concat([q]), newQ: '', formMsg: '' }, stay === true ? {} : { scope: 'custom', onlyGaps: false }));
      toast(L().ui.toastQAdded);
    }

    // Reads the JSON scripts/export_monitoring.py produces (built from a real
    // monitoring/run.py run) -- pure client-side file read, no network call.
    // This is what makes a real monitoring run actually visible: run.py
    // writes to SQLite, export_monitoring.py turns that into this shape, and
    // this is where it gets loaded back into the running app. Replaces
    // own.demo wholesale (results/cited_sources/audit_meta); keeps any
    // existing trend/pieces since a single export has neither.
    function loadMonitoringFile(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!parsed || typeof parsed !== 'object' || !parsed.results) throw new Error('missing results');
          // An export with a setup section brings its own questions; result ids
          // refer to those, so they replace the current ones.
          if (validSetup(parsed.setup)) {
            own.brand = parsed.setup.brand; own.categories = parsed.setup.categories; own.questions = parsed.setup.questions;
            own.runList = runListFromSetup(parsed.setup);
          }
          own.demo = demoFromExport(parsed, own.demo);
          saveOwn(own);
          boot();
        } catch (err) {
          set({ monitoringMsg: 'error' });
        }
      };
      reader.readAsText(file);
    }

    function viewSources() {
      const l = L(); const S = D.demo.cited_sources;
      const max = S.length ? Math.max.apply(null, S.map(c => c.cites)) : 0;
      const words = state.srcSearch.toLowerCase().split(/\s+/).filter(Boolean);
      let rows = S.filter(c => (state.srcFilter === 'all' || c.present === false) &&
        words.every(w => (c.name + ' ' + (l.kinds[c.kind] || '') + ' ' + (l.acts[c.act] || '')).toLowerCase().indexOf(w) !== -1));
      if (state.srcSort === 'name') rows = rows.slice().sort((a, b) => a.name.replace(/^\W+/, '').localeCompare(b.name.replace(/^\W+/, '')));
      else rows = rows.slice().sort((a, b) => b.cites - a.cites);
      const body = rows.map(c => {
        const col = c.present === true ? 'var(--st-cited)' : c.present === false ? 'var(--st-absent)' : 'var(--st-none)';
        return '<div class="row sgrid"><div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span style="font-weight:500">' + esc(c.name) + '</span><span class="small muted">' + esc(l.srcMeta(c.qs)) + '</span></div>' +
          '<span><span class="badge" style="background:var(--soft);color:var(--fg2)">' + esc(l.kinds[c.kind]) + '</span></span>' +
          '<div style="display:flex;align-items:center;gap:10px" data-tt="' + esc(l.colCites + ': ' + c.cites) + '"><div class="bar-t" style="flex-grow:1"><div style="width:' + pct(c.cites, max) + '%;background:var(--viz-1)"></div></div><span class="mono s13" style="width:24px;text-align:right">' + c.cites + '</span></div>' +
          '<span class="s13" style="display:flex;align-items:center;gap:8px;color:' + (c.present === false ? 'var(--warn)' : 'var(--fg2)') + '"><span class="swatch" style="border-radius:50%;background:' + col + '"></span>' + esc(c.present === true ? l.yes : c.present === false ? l.no : l.na) + '</span>' +
          '<span class="s13" style="color:' + (c.present === false ? 'var(--fg)' : 'var(--muted)') + ';font-weight:' + (c.present === false ? 500 : 400) + '">' + esc(l.acts[c.act]) + '</span></div>';
      }).join('');
      // Where citations come from: total cites per source type, one hue.
      const byKind = {};
      S.forEach(c => { byKind[c.kind] = (byKind[c.kind] || 0) + c.cites; });
      const totalCites = S.reduce((a, c) => a + c.cites, 0);
      const kindRows = Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a]).map(k => ({ label: l.kinds[k] || k, value: pct(byKind[k], totalCites), tip: (l.kinds[k] || k) + ': ' + byKind[k] }));
      const yes = S.filter(c => c.present === true).length, no = S.filter(c => c.present === false).length;
      const panels = S.length ? '<div class="grid g-main">' +
        '<div class="panel"><div class="panel-h"><h2>' + esc(l.ui.srcKinds) + '</h2><span class="sub">' + esc(l.colCites) + '</span></div><div class="panel-b" style="padding-top:6px;padding-bottom:6px">' + CH.barList(kindRows) + '</div></div>' +
        '<div class="panel"><div class="panel-h"><h2>' + esc(l.ui.srcPresence) + '</h2></div><div class="panel-b" style="display:flex;align-items:center;gap:20px">' +
        CH.ring(pct(yes, S.length), { size: 96, stroke: 10, label: l.ui.srcPresence }) +
        '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px">' +
        '<span style="display:flex;gap:8px;align-items:center"><span class="swatch" style="background:var(--st-cited)"></span>' + esc(l.srcStatYes) + ' <b class="num">' + yes + '</b></span>' +
        '<span style="display:flex;gap:8px;align-items:center"><span class="swatch" style="background:var(--st-absent)"></span>' + esc(l.srcStatTargets) + ' <b class="num">' + no + '</b></span>' +
        '<button class="btn sm outline" style="align-self:flex-start;margin-top:4px" ' + click(() => set({ srcFilter: 'targets' })) + '>' + esc(l.srcOnlyTargets) + ic('arrow', 14) + '</button></div></div></div></div>' : '';
      const empty = '<div class="empty">' + ic('search', 22) + '<b>' + esc(l.ui.noMatch) + '</b><button class="btn sm plain" ' + click(() => set({ srcSearch: '', srcFilter: 'all' })) + '>' + esc(l.ui.clear) + '</button></div>';
      return '<section><div class="page-head"><div class="head"><h1>' + esc(l.tabs.sources) + '</h1><p>' + esc(l.srcSub) + '</p></div></div>' +
        '<div class="kpis">' + stat(S.length, l.srcStatTotal) + stat(yes, l.srcStatYes, 'var(--accent)') + stat(no, l.srcStatTargets, 'var(--warn)') + '</div>' +
        panels +
        (S.length ? '<div class="toolbar"><div class="search">' + ic('search', 15) + '<label for="src-filter" class="sr">' + esc(l.ui.filterSrc) + '</label><input id="src-filter" data-filter type="search" placeholder="' + esc(l.ui.filterSrc) + '" value="' + esc(state.srcSearch) + '" ' + attr('input', e => set({ srcSearch: e.target.value })) + '></div>' +
          '<div class="seg" role="group">' + [['all', l.srcAll, S.length], ['targets', l.srcOnlyTargets, no]].map(f => '<button class="' + (state.srcFilter === f[0] ? 'on' : '') + '" aria-pressed="' + (state.srcFilter === f[0]) + '" ' + click(() => set({ srcFilter: f[0] })) + '>' + esc(f[1]) + '<span class="c">' + f[2] + '</span></button>').join('') + '</div>' +
          '<div class="seg" role="group" aria-label="Sort">' + [['cites', l.colCites], ['name', l.colSource]].map(f => '<button class="' + (state.srcSort === f[0] ? 'on' : '') + '" aria-pressed="' + (state.srcSort === f[0]) + '" ' + click(() => set({ srcSort: f[0] })) + '>' + ic('sort', 12) + ' ' + esc(f[1]) + '</button>').join('') + '</div>' +
          '<span class="count-note">' + esc(l.ui.shown(rows.length, S.length)) + '</span></div>' : '') +
        (S.length ? '<div class="table-wrap"><div class="scroll"><div style="min-width:860px"><div class="sgrid h thead"><span>' + esc(l.colSource) + '</span><span>' + esc(l.colType) + '</span><span>' + esc(l.colCites) + '</span><span>' + esc(l.colPresent) + '</span><span>' + esc(l.colNext) + '</span></div>' +
          (rows.length ? body : empty) + '</div></div></div>'
          : mode === 'own' ? loadMonitoringCard() : '<div class="empty">' + esc(l.noRows) + '</div>') +
        sovSection() +
        '<span class="small muted">' + esc(l.srcNote) + '</span></section>';
    }

    function loadMonitoringCard() {
      const l = L();
      return ownHint('python monitoring/run.py --dry-run', l.srcHint) +
        '<div class="card" style="gap:10px;margin-top:12px">' +
        '<span class="s14" style="font-weight:500">' + esc(l.loadMonitoringTitle) + '</span>' +
        '<span class="s13 muted">' + esc(l.loadMonitoringHint) + '</span>' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<label for="src-monitoring-file" class="btn sm plain" style="cursor:pointer">' + esc(l.chooseFile) + '</label>' +
        '<input id="src-monitoring-file" type="file" accept="application/json,.json" class="sr" ' + attr('change', loadMonitoringFile) + '>' +
        (state.monitoringMsg === 'error' ? '<span class="s13 warn">' + esc(l.loadMonitoringError) + '</span>' : '') +
        '</div></div>';
    }

    // Reads either JSON built from a real scripts/audit_crawl.py crawl --
    // page scores (scripts/score_pages.py -> own.pages) or audit findings
    // (scripts/audit_findings.py -> own.audit), told apart by shape. Same
    // pure client-side FileReader pattern as loadMonitoringFile.
    function loadPageScoresFile(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (!Array.isArray(parsed)) throw new Error('not an array');
          const isFindings = parsed.length > 0 && parsed.every(x => x && x.priority && x.en && x.de);
          if (isFindings) own.audit = parsed; else own.pages = parsed;
          saveOwn(own);
          boot();
        } catch (err) {
          set({ pagesMsg: 'error' });
        }
      };
      reader.readAsText(file);
    }

    function viewWebsite() {
      const l = L(); const A = D.audit; const P = D.pages; const meta = D.demo.audit_meta;
      const prioCol = { high: ['var(--warn-soft)', 'var(--warn)'], mid: ['var(--amber-soft)', 'var(--amber)'], low: ['var(--soft)', 'var(--muted)'] };
      const order = { high: 0, mid: 1, low: 2 };
      const rows = A.slice().sort((a, b) => (!!state.auditDone[a.id] - !!state.auditDone[b.id]) || (order[a.priority] - order[b.priority])).map(a => {
        const done = !!state.auditDone[a.id]; const t = a[state.lang];
        return '<div class="row agrid" style="opacity:' + (done ? .55 : 1) + '">' +
          '<input type="checkbox"' + (done ? ' checked' : '') + ' aria-label="' + esc(l.doneAria + t[0]) + '" style="margin-top:3px" ' + attr('change', () => { const m = Object.assign({}, state.auditDone); m[a.id] = !done; set({ auditDone: m }); if (!done) toast(L().ui.toastSaved); }) + '>' +
          '<div style="display:flex;flex-direction:column;gap:6px;min-width:0"><span style="font-weight:550;text-decoration:' + (done ? 'line-through' : 'none') + '">' + esc(t[0]) + '</span><span class="s13" style="color:var(--fg2)">' + esc(t[1]) + '</span><span class="s13"><b style="font-weight:600">' + esc(l.todo) + ' </b>' + esc(t[2]) + '</span></div>' +
          '<div class="small" style="display:flex;flex-direction:column;gap:6px;align-items:flex-end"><span class="badge" style="background:' + prioCol[a.priority][0] + ';color:' + prioCol[a.priority][1] + '">' + esc(l.prio[a.priority]) + '</span><span class="muted">' + esc(l.effort[a.effort]) + '</span></div></div>';
      }).join('');
      const pages = P.slice().sort((a, b) => a.score - b.score).map(g => {
        const col = g.score < 50 ? 'var(--st-absent)' : 'var(--viz-1)';
        return '<div class="row pgrid"><div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span style="font-weight:500">' + esc(g[state.lang]) + '</span><span class="small muted" style="overflow-wrap:anywhere">' + esc(BRAND.domain + g.path) + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:10px;padding-top:4px"><div class="bar-t" style="flex-grow:1"><div style="width:' + g.score + '%;background:' + col + '"></div></div><span class="mono s13" style="width:26px;text-align:right">' + g.score + '</span></div>' +
          '<span style="display:flex;flex-wrap:wrap;gap:4px">' + g.missing.map(m => '<span class="badge" style="background:var(--soft);color:var(--fg2)">' + esc(l.miss[m]) + '</span>').join('') + '</span></div>';
      }).join('');
      const avg = P.length ? Math.round(P.reduce((x, g) => x + g.score, 0) / P.length) : 0;
      const doneN = A.filter(a => state.auditDone[a.id]).length;
      const panels = (P.length || A.length) ? '<div class="grid g-2">' +
        (P.length ? '<div class="panel"><div class="panel-h"><h2>' + esc(l.ui.webDist) + '</h2><span class="sub">' + esc(l.webStatAvg) + ': ' + avg + '</span></div><div class="panel-b">' +
          CH.histogram(P.map(g => g.score), { h: 110, tip: (lo, hi, n) => l.ui.webDistTip(lo, hi, n) }) + '</div></div>' : '') +
        (A.length ? '<div class="panel"><div class="panel-h"><h2>' + esc(l.ui.webProgress) + '</h2></div><div class="panel-b" style="display:flex;align-items:center;gap:20px">' +
          CH.ring(pct(doneN, A.length), { size: 96, stroke: 10, color: 'var(--good)', label: l.ui.webProgress }) +
          '<div style="display:flex;flex-direction:column;gap:6px;font-size:13px"><span><b class="num">' + doneN + '</b> / ' + A.length + ' ' + esc(l.webStatDone) + '</span>' +
          ['high', 'mid', 'low'].map(pr => { const n = A.filter(a => a.priority === pr && !state.auditDone[a.id]).length; return n ? '<span style="display:flex;align-items:center;gap:8px"><span class="badge" style="background:' + prioCol[pr][0] + ';color:' + prioCol[pr][1] + '">' + esc(l.prio[pr]) + '</span><span class="num">' + n + '</span></span>' : ''; }).join('') +
          '</div></div></div>' : '') + '</div>' : '';
      return '<section><div class="page-head"><div class="head"><h1>' + esc(l.webTitle) + '</h1><p>' + esc(l.webSub(meta.date, meta.pages, meta.posts)) + '</p></div></div>' +
        '<div class="kpis">' + stat(meta.pages + meta.posts, l.webStatPages) + stat(A.filter(a => a.priority === 'high' && !state.auditDone[a.id]).length, l.webStatHigh, 'var(--warn)') + stat(avg, l.webStatAvg) + stat(doneN + '/' + A.length, l.webStatDone, 'var(--good)') + '</div>' +
        panels +
        '<div class="panel"><div class="panel-h"><h2>' + esc(l.webActions) + '</h2></div>' + (rows ? '<div>' + rows + '</div>' : '<div class="panel-b">' + (mode === 'own' ? ownHint('python scripts/audit_crawl.py --base https://yoursite.com\npython scripts/audit_findings.py', l.webHint) + loadPageScoresCard('web-audit-file') : '<div class="empty">' + esc(l.noRows) + '</div>') + '</div>') + '</div>' +
        '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.webPages) + '</h2><span class="sub">' + esc(l.webPagesSub) + '</span></div></div>' +
        (pages ? '<div class="scroll"><div style="min-width:760px">' + pages + '</div></div>' : '<div class="panel-b">' + (mode === 'own' ? ownHint('python scripts/score_pages.py', l.webHint2) + loadPageScoresCard('web-pages-file') : '<div class="empty">' + esc(l.noRows) + '</div>') + '</div>') + '</div>' +
        '<span class="small muted">' + esc(l.webNote) + '</span></section>';
    }

    function loadPageScoresCard(inputId) {
      const l = L();
      return '<div class="card" style="gap:10px;margin-top:12px">' +
        '<span class="s14" style="font-weight:500">' + esc(l.loadPagesTitle) + '</span>' +
        '<span class="s13 muted">' + esc(l.loadPagesHint) + '</span>' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
        '<label for="' + inputId + '" class="btn sm plain" style="cursor:pointer">' + esc(l.chooseFile) + '</label>' +
        '<input id="' + inputId + '" type="file" accept="application/json,.json" class="sr" ' + attr('change', loadPageScoresFile) + '>' +
        (state.pagesMsg === 'error' ? '<span class="s13 warn">' + esc(l.loadPagesError) + '</span>' : '') +
        '</div></div>';
    }

    function viewImpact(ctx) {
      const l = L(); const pieces = D.demo.pieces;
      const T = trendData(ctx);
      const trend = T.values;
      const noise = T.CI && T.CI.length > 1 && CORE.intervalsOverlap(T.CI[T.CI.length - 2], T.CI[T.CI.length - 1]);
      const rows = pieces.map(p => {
        const ago = trend.length - p.week; const early = ago < 4;
        const qs = p.qs.map(id => { const q = QUESTIONS.find(x => x.id === id); return q ? q.text : id; }).join(' · ');
        const d = p.after - p.before;
        return '<div class="row igrid"><span class="mark">' + p.mark + '</span><div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span style="font-weight:500">' + esc(p[state.lang]) + '</span><span class="small muted">' + esc(l.pieceMeta(l.ptypes[p.type], ago)) + '</span></div>' +
          '<span class="s13" style="color:var(--fg2)">' + esc(qs) + '</span><span class="mono s13">' + p.before + '% → ' + p.after + '%</span>' +
          '<span>' + (early ? '<span class="delta flat">' + esc(l.tooEarly) + '</span>' : '<span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : 'flat') + '">' + esc(l.pp(d)) + '</span>') + '</span></div>';
      }).join('');
      const totalDelta = ctx.nowPct - trend[0];
      return '<section><div class="page-head"><div class="head"><h1>' + esc(l.tabs.impact) + '</h1><p>' + esc(l.impSub) + '</p></div></div>' +
        '<div class="kpis">' +
        '<div class="kpi-tile"><div class="top">' + esc(l.impStatNow) + '</div><div class="mid"><span class="n">' + ctx.nowPct + '%</span>' + CH.sparkline(trend, { w: 104, h: 34 }) + '</div></div>' +
        '<div class="kpi-tile"><div class="top">' + esc(l.impStatDelta) + '</div><div class="mid"><span class="n ' + (totalDelta >= 0 ? 'good' : 'warn') + '">' + esc(l.pp(totalDelta)) + '</span></div></div>' +
        '<div class="kpi-tile"><div class="top">' + esc(l.impStatCount) + '</div><div class="mid"><span class="n">' + pieces.length + '</span><span style="display:flex;gap:4px">' + pieces.map(p => '<span class="mark">' + p.mark + '</span>').join('') + '</span></div></div></div>' +
        '<div class="panel"><div class="panel-h"><div><h2>' + esc(l.impChart) + '</h2><span class="sub">' + esc(l.ui.trendSub) + '</span></div></div><div class="panel-b">' +
        (noise ? '<p class="s13 muted" style="margin:0 0 8px">' + esc(l.impNoise) + '</p>' : '') +
        CH.lineChart({ values: trend, labels: T.labels, ci: T.CI ? T.CI.map(c => ({ lo: c.lo, hi: c.hi })) : null, markers: T.markers, tips: T.tips, alt: T.CI ? l.impCiAlt(T.CI) : l.impAlt(trend[0], ctx.nowPct) }, { w: 1080, h: 300 }) +
        (Object.keys(T.markers).length ? '<div class="legend" style="margin-top:6px"><span>' + esc(l.ui.trendMarkers) + '</span></div>' : '') + '</div></div>' +
        '<div class="panel"><div class="panel-h"><h2>' + esc(l.impPieces) + '</h2></div><div class="scroll"><div style="min-width:760px">' +
        (rows || (mode === 'own' ? '<div class="panel-b">' + ownHint('python monitoring/run.py --dry-run', l.impHint) + '</div>' : '<div class="empty">' + esc(l.noRows) + '</div>')) + '</div></div></div>' +
        '<span class="small muted">' + esc(l.impNote) + '</span></section>';
    }

    function placeholderBadge() {
      return '<span class="badge" style="align-self:flex-start;background:var(--warn-soft);color:var(--warn)">' + esc(L().closeNow) + '</span>';
    }

    function libraryRow(o) {
      const l = L();
      return '<div class="row lgrid"><span class="mono small" style="color:' + TYPE_FG[o.b.type] + '">' + esc(l.types[o.b.type]) + '</span>' +
        '<div style="display:flex;flex-direction:column;gap:4px;min-width:0"><span>' + esc(blockText(o.b)) + '</span>' +
        (o.b.placeholder ? placeholderBadge() : '<span class="small muted">' + esc(o.b.source ? (o.b.source.charAt(0) === '/' ? BRAND.domain + o.b.source : L().importFrom + o.b.source) : '') + '</span>') + '</div>' +
        '<span class="s13" style="text-align:right;color:' + (o.cov ? C.warn : C.faint) + '">' + esc(o.cov ? l.openQs(o.cov) : '–') + '</span></div>';
    }

    // Library is reworked as a worklist, not a flat catalog: blocks that still
    // need real content (placeholders) are their own section, surfaced first
    // with a "Close now" badge, so there's something to act on rather than a
    // buried "[placeholder]" label mixed in among finished content.
    function viewLibrary(ctx) {
      const l = L();
      const blocksNow = allBlocksList();
      const coverage = b => ctx.gapQs.filter(q => overlaps(b.tags, q.tags)).length;
      const catTabs = [{ id: 'all' }].concat(CATS).map(c => tabBtn(c.id === 'all' ? l.all : catLabel(c.id), state.libCat === c.id, () => set({ libCat: c.id }))).join('');
      const typePills = ['all'].concat(TYPES).map(t => '<button class="pill' + (state.libType === t ? ' on' : '') + '" ' + click(() => set({ libType: t })) + '>' + esc(t === 'all' ? l.all : l.types[t]) + '</button>').join('');
      const words = state.libSearch.toLowerCase().split(/\s+/).filter(Boolean);
      const filtered = blocksNow.filter(b => (state.libCat === 'all' || b.tags.indexOf(state.libCat) !== -1) && (state.libType === 'all' || b.type === state.libType) &&
        words.every(w => (b.en + ' ' + b.de).toLowerCase().indexOf(w) !== -1))
        .map(b => ({ b, cov: coverage(b) }))
        .sort((x, y) => (y.cov - x.cov) || (TYPES.indexOf(x.b.type) - TYPES.indexOf(y.b.type)));
      const needsContent = filtered.filter(o => o.b.placeholder);
      const ready = filtered.filter(o => !o.b.placeholder);
      const withSource = blocksNow.filter(b => !b.placeholder).length;
      const typeOpts = TYPES.map(t => '<option value="' + t + '"' + (state.newBlockType === t ? ' selected' : '') + '>' + esc(l.types[t]) + '</option>').join('');
      const catPills = CATS.map(c => '<button class="pill' + (state.newBlockCats.indexOf(c.id) !== -1 ? ' on' : '') + '" ' + click(() => {
        const has = state.newBlockCats.indexOf(c.id) !== -1;
        set({ newBlockCats: has ? state.newBlockCats.filter(x => x !== c.id) : state.newBlockCats.concat([c.id]) });
      }) + '>' + esc(catLabel(c.id)) + '</button>').join('');
      return '<section><div class="head"><h1>' + esc(l.tabs.library) + '</h1><p>' + esc(l.libSub(blocksNow.length, withSource)) + '</p></div>' +
        '<div style="display:flex;flex-direction:column;gap:10px"><div class="toolbar"><div class="search">' + ic('search', 15) + '<label for="lib-filter" class="sr">' + esc(l.ui.filterLib) + '</label><input id="lib-filter" data-filter type="search" placeholder="' + esc(l.ui.filterLib) + '" value="' + esc(state.libSearch) + '" ' + attr('input', e => set({ libSearch: e.target.value })) + '></div>' +
        '<span class="count-note">' + esc(l.ui.shown(filtered.length, blocksNow.length)) + '</span></div>' +
        '<div class="tabs-row">' + catTabs + '</div><div style="display:flex;flex-wrap:wrap;gap:6px">' + typePills + '</div></div>' +
        (needsContent.length ? '<div class="panel"><div class="panel-h"><h2 class="warn">' + esc(l.libNeedsContent) + ' <span class="nav-count warn" style="margin-left:6px">' + needsContent.length + '</span></h2></div>' + needsContent.map(libraryRow).join('') + '</div>' : '') +
        '<div class="panel"><div class="panel-h"><h2>' + esc(state.libCat === 'all' ? l.libReady : l.libRec(catLabel(state.libCat))) + '</h2></div>' +
        (ready.length ? ready.map(libraryRow).join('') : '<div class="empty">' + esc(l.noRows) + '</div>') + '</div>' +
        '<div class="grid g-2" style="align-items:start">' +
        '<div class="card"><div class="listhead" style="min-height:0"><h2>' + esc(l.addBlockTitle) + '</h2></div>' +
        '<label for="newblocktype" class="sr">' + esc(l.blockTypeLabel) + '</label><select id="newblocktype" ' + attr('change', e => { state.newBlockType = e.target.value; }) + '>' + typeOpts + '</select>' +
        '<label for="newblocktext" class="sr">' + esc(l.blockTextLabel) + '</label><textarea id="newblocktext" rows="2" style="min-height:44px;padding:10px 14px;border:1px solid var(--input);border-radius:6px;font:inherit;resize:vertical" placeholder="' + esc(l.blockTextPh) + '" ' + attr('input', e => { state.newBlockText = e.target.value; }) + '>' + esc(state.newBlockText) + '</textarea>' +
        '<div style="display:flex;flex-direction:column;gap:6px"><span class="s13 muted">' + esc(l.blockCatLabel) + '</span><div style="display:flex;flex-wrap:wrap;gap:6px">' + catPills + '</div></div>' +
        '<button class="btn" style="align-self:flex-start" ' + click(addBlock) + '>' + esc(l.saveBlock) + '</button>' +
        '<span class="small" style="color:' + (state.blockMsg ? 'var(--accent-strong)' : C.muted) + '">' + esc(state.blockMsg ? l.msg[state.blockMsg] : l.blockFormHint) + '</span></div>' +
        importCard() + '</div></section>';
    }
    // ---------- Import: suggest blocks from your own content, then review ----------
    // Text never leaves the browser: pasted, or read from a local file with
    // FileReader. Suggestions are verbatim sentences (CORE.extractBlockCandidates);
    // nothing reaches the library until a person accepts it.
    function htmlToText(html) {
      const marked = String(html).replace(/<\/(p|h[1-6]|li|div|section|article|blockquote|tr|dd|dt)>/gi, '$&\n\n').replace(/<br\s*\/?>/gi, '\n');
      const doc = new DOMParser().parseFromString(marked, 'text/html');
      doc.querySelectorAll('script, style, noscript, nav, header, footer, form').forEach(n => n.remove());
      return ((doc.querySelector('main') || doc.body || doc.documentElement).textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n');
    }
    function loadImportFile(e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        const name = file.name.toLowerCase();
        const text = /\.html?$/.test(name) ? htmlToText(raw) : /\.(md|markdown)$/.test(name) ? CORE.textFromMarkdown(raw) : raw;
        state.importText = text.slice(0, 200000);
        state.importSource = file.name;
        suggestBlocks();
      };
      reader.readAsText(file);
    }
    function suggestBlocks() {
      const text = state.importText.trim();
      if (text.length < 40) { set({ importMsg: 'short' }); return; }
      const stamp = Date.now().toString(36);
      const cands = CORE.extractBlockCandidates(text, CATS.map(c => ({ id: c.id, keywords: c.kw })), 40)
        .map((c, i) => Object.assign({ id: 'imp' + stamp + i }, c));
      set({ importCands: cands, importSource: state.importSource || L().importPasted, importMsg: cands.length ? 'found' : 'none' });
    }
    function acceptCands(ids) {
      const take = state.importCands.filter(c => ids.indexOf(c.id) !== -1 && c.categories.length && c.text.trim().length >= 8);
      if (!take.length) { set({ importMsg: 'noCat' }); return; }
      const now = new Date().toISOString();
      const blocks = take.map((c, i) => ({ id: 'cb' + Date.now().toString(36) + i, type: c.type, text: c.text.trim().slice(0, 600), categories: c.categories.slice(), source: state.importSource, createdAt: now }));
      const left = state.importCands.filter(c => take.indexOf(c) === -1);
      set({ customBlocks: state.customBlocks.concat(blocks), importCands: left, importMsg: left.length ? 'accepted' : 'done', importAccepted: blocks.length });
    }
    function updateCand(id, patch, rerender) {
      const cands = state.importCands.map(c => c.id === id ? Object.assign({}, c, patch) : c);
      if (rerender) set({ importCands: cands }); else { state.importCands = cands; persist(); }
    }
    function importCard() {
      const l = L();
      const msg = state.importMsg === 'found' ? l.importFound(state.importCands.length)
        : state.importMsg === 'accepted' || state.importMsg === 'done' ? l.importAccepted(state.importAccepted || 0)
        : state.importMsg ? l.importMsgs[state.importMsg] : l.importHint;
      const rows = state.importCands.map((c, n) => {
        const typeOpts = TYPES.map(t => '<option value="' + t + '"' + (c.type === t ? ' selected' : '') + '>' + esc(l.types[t]) + '</option>').join('');
        const cur = c.categories[0] || '';
        const catOpts = '<option value=""' + (cur ? '' : ' selected') + '>' + esc(l.importTopicPh) + '</option>' +
          CATS.map(k => '<option value="' + k.id + '"' + (cur === k.id ? ' selected' : '') + '>' + esc(catLabel(k.id)) + '</option>').join('');
        return '<div class="cand"><div class="cand-controls">' +
          '<label for="imp-type-' + c.id + '" class="sr">' + esc(l.importTypeAria(n + 1)) + '</label><select id="imp-type-' + c.id + '" ' + attr('change', e => updateCand(c.id, { type: e.target.value }, true)) + '>' + typeOpts + '</select>' +
          '<label for="imp-cat-' + c.id + '" class="sr">' + esc(l.importTopicAria(n + 1)) + '</label><select id="imp-cat-' + c.id + '" ' + attr('change', e => updateCand(c.id, { categories: e.target.value ? [e.target.value].concat(c.categories.filter(x => x !== e.target.value)) : [] }, true)) + '>' + catOpts + '</select>' +
          '<button id="imp-ok-' + c.id + '" class="btn sm" ' + (cur ? '' : 'disabled ') + click(() => acceptCands([c.id])) + '>' + esc(l.importAccept) + '</button>' +
          '<button id="imp-no-' + c.id + '" class="btn sm plain" ' + click(() => set({ importCands: state.importCands.filter(x => x.id !== c.id), importMsg: '' })) + '>' + esc(l.importReject) + '</button></div>' +
          '<label for="imp-text-' + c.id + '" class="sr">' + esc(l.importTextAria(n + 1)) + '</label><textarea id="imp-text-' + c.id + '" rows="2" ' + attr('input', e => updateCand(c.id, { text: e.target.value }, false)) + '>' + esc(c.text) + '</textarea></div>';
      }).join('');
      const ready = state.importCands.filter(c => c.categories.length).map(c => c.id);
      return '<div class="card"><div class="listhead" style="min-height:0"><h2>' + esc(l.importTitle) + '</h2></div>' +
        '<label for="importtext" class="sr">' + esc(l.importTextLabel) + '</label><textarea id="importtext" rows="4" placeholder="' + esc(l.importPh) + '" ' + attr('input', e => { state.importText = e.target.value; state.importSource = ''; }) + '>' + esc(state.importText) + '</textarea>' +
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">' +
        '<button class="btn" ' + click(suggestBlocks) + '>' + esc(l.importSuggest) + '</button>' +
        '<label for="import-file" class="btn plain" style="cursor:pointer">' + esc(l.importFile) + '</label>' +
        '<input id="import-file" type="file" accept=".txt,.md,.markdown,.html,.htm,text/plain,text/markdown,text/html" class="sr" ' + attr('change', loadImportFile) + '></div>' +
        '<span class="small" role="status" style="color:' + (state.importMsg && state.importMsg !== 'noCat' && state.importMsg !== 'none' && state.importMsg !== 'short' ? 'var(--accent-strong)' : C.muted) + '">' + esc(msg) + '</span>' +
        (rows ? '<div class="cands"><div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center"><span class="s13 muted" style="flex:1 1 200px">' + esc(l.importReview(state.importSource)) + '</span>' +
          '<button class="btn sm" ' + (ready.length ? '' : 'disabled ') + click(() => acceptCands(ready)) + '>' + esc(l.importAcceptAll(ready.length)) + '</button>' +
          '<button class="btn sm plain" ' + click(() => set({ importCands: [], importMsg: '' })) + '>' + esc(l.importDiscardAll) + '</button></div>' + rows + '</div>' : '') +
        '</div>';
    }

    function addBlock() {
      const text = state.newBlockText.trim();
      if (text.length < 8) { set({ blockMsg: 'blockShort' }); return; }
      if (!state.newBlockCats.length) { set({ blockMsg: 'noCat' }); return; }
      const b = { id: 'cb' + Date.now().toString(36), type: state.newBlockType, text: text.slice(0, 600), categories: state.newBlockCats.slice(), createdAt: new Date().toISOString() };
      set({ customBlocks: state.customBlocks.concat([b]), newBlockText: '', newBlockCats: [], blockMsg: '' });
      toast(L().ui.toastBlock);
    }

    function viewWriteBrief(ctx) {
      const l = L();
      const ranked = ctx.ranked;
      const briefText = ' ' + state.brief.toLowerCase().trim() + ' ';
      let mode_ = 'default', pick = ranked[0];
      if (state.brief.trim()) {
        const scored = CATS.map(c => ({ c, hits: c.kw.filter(k => kwHit(briefText, k)).length, st: catStats(c.id) })).filter(x => x.hits > 0)
          .sort((a, b) => (b.hits - a.hits) || (b.st.weight - a.st.weight));
        if (scored.length) { mode_ = 'match'; pick = scored[0]; } else { mode_ = 'nomatch'; }
      }
      const st = pick.st;
      const reason = st.gapQs.length === 0 ? l.reasonNone : l.reason(st.gapQs.length, st.keyGaps, st.absent, st.answers, mode_ === 'default');
      const firstQ = st.gapQs[0] || st.qs[0];
      const qs = st.gapQs.slice(0, 4).map(q => '<button class="recq" ' + click(() => openDraft(q.id)) + '><span>' + esc(q.text) + '</span><span class="small warn" style="white-space:nowrap">' + esc(l.missingShort(absentCount(q))) + ' →</span></button>').join('');
      return '<section class="brief"><div style="display:flex;flex-direction:column;gap:14px"><label for="brief">' + esc(l.writeQ) + '</label>' +
        '<input id="brief" type="text" maxlength="200" value="' + esc(state.brief) + '" placeholder="' + esc(l.briefPh) + '" ' + attr('input', e => set({ brief: e.target.value })) + '>' +
        '<span class="s13 muted">' + esc(l.briefHint) + '</span></div>' +
        '<div class="card"><div style="display:flex;flex-direction:column;gap:4px"><span class="s13" style="color:' + (mode_ === 'nomatch' ? C.warn : C.muted) + '">' + esc(mode_ === 'match' ? l.kMatch : mode_ === 'nomatch' ? l.kNo : l.kDefault) + '</span><span style="font-size:24px;font-weight:500">' + esc(catLabel(pick.c.id)) + '</span></div>' +
        '<div style="display:flex;flex-direction:column;gap:4px"><span class="s13" style="font-weight:600">' + esc(l.why) + '</span><span>' + esc(reason) + '</span></div>' +
        (qs ? '<div style="display:flex;flex-direction:column"><span class="s13" style="font-weight:600;margin-bottom:6px">' + esc(l.closesGaps) + '</span>' + qs + '</div>' : '') +
        '<span class="s14" style="color:var(--fg2)">' + esc(l.inventory(st.blocks.length, st.missing.map(m => l.types[m]))) + '</span>' +
        '<button class="btn" style="align-self:flex-start" ' + click(() => openDraft(firstQ ? firstQ.id : state.selectedQ)) + '>' + esc(l.startDraft) + '</button></div></section>';
    }

    function viewStudio() {
      const l = L();
      const sel = allQ().find(q => q.id === state.selectedQ) || QUESTIONS[0];
      const ids = state.drafts[sel.id] || [];
      const blocksNow = allBlocksList();
      const draftBlocks = ids.map(id => blocksNow.find(b => b.id === id)).filter(Boolean);
      const n = draftBlocks.length;

      // Relevance is BM25 (see app/core.js) against the question's literal
      // text, not just whether block and question share a topic tag -- this
      // is the same kind of ranking a retrieval step in a real RAG pipeline
      // would do: which passage's actual wording best matches the query.
      // Both language variants of each block are concatenated into one
      // "document" so a German question can still match an English-authored
      // block (and vice versa) without needing translation.
      const relevanceMap = {};
      CORE.rankByRelevance(sel.text, blocksNow.map(b => ({ id: b.id, text: b.en + ' ' + b.de })))
        .forEach(r => { relevanceMap[r.id] = r.relevance; });
      const rel = b => relevanceMap[b.id] || 0;

      // Block ranking, fully rule-based (no AI, nothing to guess at):
      //   1. Blocks of a type the draft is still missing for the GEO score
      //      (figure/case/quote/faq -- exactly what scoreDraft() checks via
      //      has(type)) are surfaced first, since adding one directly raises
      //      the score.
      //   2. Within that, blocks are ranked by topic match: the fraction of
      //      the target question's own tags that the block shares with it.
      const neededTypes = ['figure', 'case', 'quote', 'faq'].filter(t => !draftBlocks.some(b => b.type === t));
      const sugg = blocksNow.map(b => ({ b, r: rel(b), fillsGap: neededTypes.indexOf(b.type) !== -1 }))
        .filter(o => state.allBlocks || o.r > 0)
        .sort((x, y) => (y.fillsGap - x.fillsGap) || (y.r - x.r))
        .map(o => {
          const b = o.b; const used = ids.indexOf(b.id) !== -1;
          const relText = o.r > 0 ? l.rel(Math.round(o.r * 100)) : l.relLow;
          return '<div class="sugg' + (used ? ' used' : '') + '" draggable="true" ' + attr('dragstart', e => { drag = { kind: 'lib', id: b.id }; try { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'copyMove'; } catch (err) { /* ignore */ } }) + ' ' + attr('dragend', clearDrag) + '>' +
            '<div class="small" style="display:flex;justify-content:space-between;gap:8px"><span class="mono" style="color:' + TYPE_FG[b.type] + '">' + esc(l.types[b.type]) + '</span><span class="muted">' + esc(o.fillsGap && !used ? l.closesScoreGap + ' · ' + relText : relText) + '</span></div>' +
            (b.placeholder ? placeholderBadge() : '') +
            '<span class="s14">' + esc(blockText(b)) + '</span>' +
            '<button class="link s13" style="align-self:flex-start;color:' + (used ? C.muted : C.accent) + '" aria-label="' + esc(used ? l.inDraft : l.ariaAdd) + '" ' + click(() => { if (!used) setDraft(getDraft().concat([b.id])); }) + '>' + esc(used ? l.inDraft : l.add) + '</button></div>';
        }).join('');

      const slotEvents = i => attr('dragover', (e, el) => { e.preventDefault(); markOver(el); }) + ' ' + attr('dragleave', (e, el) => el.classList.remove('over')) + ' ' + attr('drop', e => { e.preventDefault(); dropAt(i); });
      const draft = draftBlocks.map((b, i) =>
        '<div class="slot" ' + slotEvents(i) + '><div class="dblock" draggable="true" ' + attr('dragstart', e => { drag = { kind: 'draft', index: i }; try { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* ignore */ } }) + ' ' + attr('dragend', clearDrag) + '>' +
        '<div><span class="mono small" style="color:' + TYPE_FG[b.type] + '">' + String(i + 1).padStart(2, '0') + ' · ' + esc(l.types[b.type]) + '</span><span>' + esc(blockText(b)) + '</span></div>' +
        '<div style="display:flex;gap:2px;align-items:flex-start">' +
        '<button class="icon" aria-label="' + esc(l.up) + '" ' + click(() => { if (i === 0) return; const x = getDraft(); x.splice(i - 1, 0, x.splice(i, 1)[0]); setDraft(x); }) + '>↑</button>' +
        '<button class="icon" aria-label="' + esc(l.down) + '" ' + click(() => { const x = getDraft(); if (i >= x.length - 1) return; x.splice(i + 1, 0, x.splice(i, 1)[0]); setDraft(x); }) + '>↓</button>' +
        '<button class="icon" style="font-size:16px" aria-label="' + esc(l.remove) + '" ' + click(() => { const x = getDraft(); x.splice(i, 1); setDraft(x); }) + '>×</button></div></div></div>').join('');

      const sc = scoreDraft(draftBlocks, rel);
      const scoreColor = n === 0 ? C.faint : sc.score >= 70 ? C.accent : sc.score >= 40 ? C.amber : C.warn;
      const verdict = n === 0 ? l.verdict.empty : sc.score >= 70 ? l.verdict.good : sc.score >= 40 ? l.verdict.mid : l.verdict.low;
      const crit = l.crit.map((c, i) => '<div class="crit"><span style="color:' + (sc.met[i] ? C.accent : C.faint) + '">' + (sc.met[i] ? '✓' : '○') + '</span><div><span style="color:' + (sc.met[i] ? C.fg : C.muted) + '">' + esc(c[0]) + '</span>' +
        (!sc.met[i] && n > 0 ? '<span class="small muted">' + esc(c[1].replace('{p}', Math.round(sc.avgRel * 100))) + '</span>' : '') + '</div></div>').join('');
      const ph = draftBlocks.filter(b => b.placeholder).length;
      const statusLine = ENGINES.map(e => e.name + ' ' + l.dot[status(sel, e.id).k]).join(' · ');

      return '<section><div class="head"><button class="link" style="align-self:flex-start" ' + click(() => set({ writeStep: 1 })) + '>' + esc(l.changeTopic) + '</button>' +
        '<span class="s13 muted">' + esc(l.targetQ) + '</span><h1 style="font-size:26px">' + esc(sel.text) + '</h1><span class="s13 muted">' + esc(statusLine) + '</span></div>' +
        '<div class="studio"><div class="col-lib"><div class="listhead" style="min-height:0;padding-bottom:10px"><h2 style="font-size:15px">' + esc(l.matchingBlocks) + '</h2><button class="link s13" ' + click(() => set({ allBlocks: !state.allBlocks })) + '>' + esc(state.allBlocks ? l.onlyMatching : l.showAll) + '</button></div><div class="libscroll">' + (sugg || '<div class="muted s13" style="padding:16px 0">' + esc(l.noRows) + '</div>') + '</div></div>' +
        '<div class="col-draft"><div class="listhead" style="min-height:0;padding-bottom:10px"><h2 style="font-size:15px">' + esc(l.draftTitle) + '</h2><span class="s13 muted">' + esc(l.blocksN(n)) + '</span></div>' +
        '<div style="display:flex;flex-direction:column;padding-top:8px">' + draft +
        '<div class="dropzone" style="min-height:' + (n === 0 ? 240 : 56) + 'px" ' + attr('dragover', (e, el) => { e.preventDefault(); markOver(el); }) + ' ' + attr('dragleave', (e, el) => el.classList.remove('over')) + ' ' + attr('drop', e => { e.preventDefault(); dropAt(n); }) + '>' + esc(n === 0 ? l.dropEmpty : l.dropHere) + '</div>' +
        (n ? '<div class="actions-row" style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<button class="btn sm plain" ' + click(() => copyDraft(draftBlocks)) + '>' + esc(state.copied === 'text' ? l.copied : l.copy) + '</button>' +
          '<button class="btn sm plain" ' + click(() => copyMarkdown(draftBlocks, sel.text)) + '>' + esc(state.copied === 'markdown' ? l.copied : l.copyMd) + '</button>' +
          '<button class="btn sm plain" ' + click(() => copyHtml(draftBlocks, sel.text)) + '>' + esc(state.copied === 'html' ? l.copied : l.copyHtml) + '</button>' +
          '</div>' : '') +
        '</div></div>' +
        '<div class="col-score"><div style="padding-bottom:10px;border-bottom:1px solid var(--line)"><h2 style="font-size:15px">' + esc(l.scoreTitle) + '</h2></div>' +
        '<div style="display:flex;align-items:center;gap:14px">' + CH.ring(n === 0 ? null : sc.score, { size: 84, stroke: 9, color: scoreColor, unit: '', label: l.ui.scoreRing + ' ' + sc.score + '/100' }) + '<span class="muted s13">/ 100</span></div>' +
        '<span style="font-weight:500;color:' + scoreColor + '">' + esc(verdict) + '</span><div style="display:flex;flex-direction:column;gap:10px">' + crit + '</div>' +
        (ph ? '<span class="s13 warn">' + esc(l.ph(ph)) + '</span>' : '') + '</div></div>' +
        (n ? articlePanel(sel, draftBlocks) : '') + '</section>';
    }

    // ---------- Blocks -> readable article (compose, polish elsewhere, check) ----------
    function articlePanel(sel, draftBlocks) {
      const l = L();
      const items = draftItems(draftBlocks);
      const composed = CORE.composeArticle(items, sel.text, state.lang);
      const polished = (state.polished[sel.id] || '').trim();
      const current = polished || composed;
      const known = BRAND_NAMES.concat(COMPETITORS);
      const facts = polished ? CORE.checkFacts(composed, polished, known, [String(new Date().getFullYear())]) : null;
      const dropped = polished ? CORE.blockCoverage(items, polished).filter(c => c.dropped) : [];
      const clean = !facts || (facts.ok && !dropped.length);
      const confirmed = !!state.factConfirm[sel.id];
      const canExport = clean || confirmed;
      const flag = (label, list, fmt) => list.length ? '<div class="flags"><span class="s13" style="font-weight:500">' + esc(label) + '</span><ul>' + list.map(x => '<li>' + fmt(x) + '</li>').join('') + '</ul></div>' : '';
      const kind = x => esc(l.artKinds[x.kind] + ': ') + '<span class="mono">' + esc(x.value) + '</span>';
      const checks = CORE.citabilityChecks(current).map(c => '<div class="crit"><span style="color:' + (c.ok ? C.accent : C.warn) + '">' + (c.ok ? '✓' : '!') + '</span><div><span>' + esc(l.artChecks[c.id]) + '</span>' +
        (c.items && c.items.length ? '<span class="small muted">' + esc(c.items.slice(0, 2).map(t => t.length > 90 ? t.slice(0, 90) + '…' : t).join(' / ')) + '</span>' : '') + '</div></div>').join('');
      const factBlock = !facts ? '<p class="s13 muted">' + esc(l.artStep3Empty) + '</p>'
        : clean ? '<p class="s14" style="color:' + C.accent + '">✓ ' + esc(l.artFactsOk) + '</p>'
          : '<div role="status" class="factwarn"><span class="s14" style="font-weight:500;color:' + C.warn + '">' + esc(l.artFactsBad) + '</span>' +
            flag(l.artMissing, facts.missing, kind) + flag(l.artAdded, facts.added, kind) +
            flag(l.artDropped, dropped, x => esc(x.text.length > 120 ? x.text.slice(0, 120) + '…' : x.text)) +
            '<label class="s14" style="display:flex;gap:8px;align-items:center;min-height:44px;cursor:pointer"><input type="checkbox" id="factconfirm-' + esc(sel.id) + '"' + (confirmed ? ' checked' : '') + ' ' +
            attr('change', () => { const m = Object.assign({}, state.factConfirm); m[sel.id] = !confirmed; set({ factConfirm: m }); }) + '><span>' + esc(l.artConfirm) + '</span></label></div>';
      return '<div class="article"><div class="head"><h2>' + esc(l.artTitle) + '</h2><p class="s14 muted" style="margin:0">' + esc(l.artSub) + '</p></div>' +
        '<div class="artstep"><h3>' + esc(l.artStep1) + '</h3><p class="s13 muted">' + esc(l.artStep1Sub) + '</p><div class="preview">' + CORE.mdToHtml(composed) + '</div></div>' +
        '<div class="artstep"><h3>' + esc(l.artStep2) + '</h3><p class="s13 muted">' + esc(l.artStep2Sub) + '</p>' +
        '<button class="btn sm" style="align-self:flex-start" ' + click(() => copyToClipboard(CORE.buildPolishPrompt(composed, state.lang), 'prompt')) + '>' + esc(state.copied === 'prompt' ? l.copied : l.artCopyPrompt) + '</button>' +
        '<label for="polished-' + esc(sel.id) + '" class="s13" style="font-weight:500">' + esc(l.artPasteLabel) + '</label>' +
        '<textarea id="polished-' + esc(sel.id) + '" rows="8" placeholder="' + esc(l.artPastePh) + '" ' + attr('input', e => {
          const m = Object.assign({}, state.polished); m[sel.id] = e.target.value; const f = Object.assign({}, state.factConfirm); delete f[sel.id]; set({ polished: m, factConfirm: f });
        }) + '>' + esc(state.polished[sel.id] || '') + '</textarea>' +
        (polished ? '<button class="link s13" style="align-self:flex-start" ' + click(() => { const m = Object.assign({}, state.polished); delete m[sel.id]; set({ polished: m }); }) + '>' + esc(l.artClear) + '</button>' : '') + '</div>' +
        '<div class="artstep"><h3>' + esc(l.artStep3) + '</h3>' + factBlock + '<div style="display:flex;flex-direction:column;gap:10px">' + checks + '</div>' +
        '<span class="s13 muted">' + esc(l.artVersion(polished ? 'polished' : 'composed')) + '</span>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn sm" ' + (canExport ? '' : 'disabled ') + click(() => copyToClipboard(current, 'artmd')) + '>' + esc(state.copied === 'artmd' ? l.copied : l.artCopyMd) + '</button>' +
        '<button class="btn sm plain" ' + (canExport ? '' : 'disabled ') + click(() => copyToClipboard(CORE.articleToHtml(current, state.lang), 'arthtml')) + '>' + esc(state.copied === 'arthtml' ? l.copied : l.artCopyHtml) + '</button>' +
        '</div></div></div>';
    }

    function markOver(el) {
      root.querySelectorAll('.over').forEach(x => { if (x !== el) x.classList.remove('over'); });
      el.classList.add('over');
    }
    function clearDrag() { drag = null; root.querySelectorAll('.over').forEach(x => x.classList.remove('over')); }
    function draftItems(blocks) { return blocks.map(b => ({ type: b.type, text: blockText(b) })); }
    function copyToClipboard(text, kind) {
      const done = () => { set({ copied: kind }); toast(L().ui.toastCopied); setTimeout(() => set({ copied: null }), 1500); };
      try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) { /* clipboard unavailable */ }
    }
    function copyDraft(blocks) { copyToClipboard(blocks.map(blockText).join('\n\n'), 'text'); }
    function copyMarkdown(blocks, title) { copyToClipboard(CORE.toMarkdown(draftItems(blocks), title), 'markdown'); }
    function copyHtml(blocks, title) { copyToClipboard(CORE.toHtml(draftItems(blocks), title), 'html'); }

    // ---------- Focus preservation (see render) ----------
    const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';
    const focusLabel = el => (el.getAttribute('aria-label') || el.textContent || '').trim();
    function captureFocus() {
      const el = document.activeElement;
      if (!el || el === document.body || !root.contains(el) || el.classList.contains('skip')) return null;
      const all = Array.from(root.querySelectorAll(FOCUSABLE));
      return { id: el.id, caret: el.id ? el.selectionStart : null, label: focusLabel(el), index: all.indexOf(el) };
    }
    function restoreFocus(k) {
      if (!k) return;
      // Disabled controls can't take focus, so they're never a target.
      let el = k.id ? document.getElementById(k.id) : null;
      if (el && el.disabled) el = null;
      // Never the skip link: it is only meant for a deliberate first Tab press.
      const all = Array.from(root.querySelectorAll(FOCUSABLE)).filter(x => !x.disabled && !x.classList.contains('skip'));
      if (!el && k.label) {
        const same = all.filter(x => focusLabel(x) === k.label);
        el = same.length === 1 ? same[0] : same.find(x => all.indexOf(x) === k.index) || same[0];
      }
      if (!el && k.index >= 0) el = all[Math.min(k.index, all.length - 1)];
      if (!el) return;
      el.focus({ preventScroll: true });
      if (typeof k.caret === 'number' && el.setSelectionRange) { try { el.setSelectionRange(k.caret, k.caret); } catch (e) { /* not a text input */ } }
    }

    // Every view gets exactly one <h1> for screen-reader navigation; views
    // whose visible design has no page title get a visually hidden one.
    const withH1 = (html, title) => html.indexOf('<h1') === -1 ? '<h1 class="sr">' + esc(title) + '</h1>' + html : html;

    // ---------- Run: what the next monitoring run asks, and how to start it ----------
    const runListNow = () => allQ().filter(isActive);
    // Compared with the list saved last (Save button, export or target setup).
    function runDiff() {
      if (mode !== 'own' || !own) return { changed: false, added: 0, removed: 0, never: false };
      const now = new Set(runListNow().map(q => q.id));
      if (!Array.isArray(own.runList)) return { changed: true, added: now.size, removed: 0, never: true };
      const saved = new Set(own.runList);
      const added = [...now].filter(id => !saved.has(id)).length;
      const removed = [...saved].filter(id => !now.has(id)).length;
      return { changed: added + removed > 0, added, removed, never: false };
    }
    function saveRunList() {
      const qs = runListNow();
      const file = {
        _comment: 'Questions monitoring/run.py asks, saved from the GEO Engine app (Monitor > Run). Keep it in the target folder; delete it to go back to the settings.',
        saved: new Date().toISOString().slice(0, 10),
        questions: qs.map(q => Object.assign({ id: q.id, text: q.text, categories: q.tags }, q.custom ? { custom: true } : {}))
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'run_list.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      own.runList = qs.map(q => q.id);
      saveOwn(own);
      render();
      toast(L().ui.run.toastSaved);
    }
    // Next date the daily/weekly schedule fires (the Action wakes ~06:00 Berlin).
    function nextRun(sch) {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const d = new Date();
      d.setHours(6, 0, 0, 0);
      if (sch.frequency === 'daily') { if (d <= new Date()) d.setDate(d.getDate() + 1); return d; }
      if (sch.frequency !== 'weekly') return null;
      const want = days.indexOf(sch.weekday);
      while (d.getDay() !== want || d <= new Date()) d.setDate(d.getDate() + 1);
      return d;
    }

    function viewRun() {
      const l = L(); const R = l.ui.run;
      if (!MON) return '<section><div class="head"><h1>' + esc(l.tabs.run) + '</h1></div><div class="empty">' + esc(l.noRows) + '</div></section>';
      const T = MON.target;
      const list = runListNow();
      const grp = {
        key: list.filter(q => q.key), on: list.filter(q => !q.key && !q.custom), own: list.filter(q => q.custom)
      };
      const engines = MON.engines.filter(e => e.enabled);
      const wordings = 1 + MON.variants;
      const calls = list.length * wordings * MON.runs_per_question * engines.length;
      const usd = engines.reduce((a, e) => a + e.usd_per_call * list.length * wordings * MON.runs_per_question, 0);
      const over = calls > MON.budget.max_calls_per_run || usd > MON.budget.max_usd_per_run;
      const nx = nextRun(MON.schedule);
      const diff = runDiff();
      const off = allQ().length - list.length;

      const demo = mode === 'demo' && T ? '<div class="callout"><div style="display:flex;flex-direction:column;gap:2px"><span style="font-weight:600">' + esc(R.demoTitle) + '</span>' +
        '<span class="s13 muted">' + esc(R.demoText(T.path)) + '</span></div>' +
        (own ? '<button class="btn" ' + click(switchToOwn) + '>' + esc(R.openOwn(own.brand.short)) + '</button>'
          : '<button class="btn" ' + click(useTarget) + '>' + ic('run', 15) + esc(R.useTarget(T.brand.short)) + '</button>') + '</div>' : '';

      const tile = (label, value, sub, extra) => '<div class="kpi-tile"><div class="top">' + esc(label) + '</div><div class="mid"><span class="n">' + value + '</span>' + (extra || '') + '</div><span class="l">' + sub + '</span></div>';
      const kpis = '<div class="kpis">' +
        tile(R.kQuestions, list.length, esc(R.kSplit(grp.key.length, grp.on.length, grp.own.length))) +
        tile(R.kCalls, calls, esc(R.kCallsSub(list.length, MON.variants, engines.length))) +
        tile(R.kCost, esc(usd.toLocaleString(state.lang === 'de' ? 'de-DE' : 'en-US', { style: 'currency', currency: 'USD' })), esc(R.kCostSub)) +
        tile(R.kNext, nx ? esc(nx.toLocaleDateString(state.lang === 'de' ? 'de-DE' : 'en-GB', { day: 'numeric', month: 'short' })) : esc(MON.schedule.frequency === 'off' ? R.offShort : '–'),
          esc((nx ? nx.toLocaleDateString(state.lang === 'de' ? 'de-DE' : 'en-GB', { weekday: 'long' }) + ' · ' : '') + (R.every[MON.schedule.frequency] || ''))) + '</div>';

      const row = q => '<div class="row" style="display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:12px;align-items:center;padding:9px 18px">' +
        '<input type="checkbox" checked aria-label="' + esc(l.ariaOff + q.text) + '" ' + attr('change', () => toggleActive(q)) + '>' +
        '<div style="display:flex;flex-direction:column;min-width:0"><span>' + esc(q.text) + '</span><span class="small muted">' + esc(catLabels(q.tags)) + '</span></div>' +
        '<button class="icon" aria-label="' + esc(l.ui.answers + ': ' + q.text) + '" data-tt="' + esc(l.ui.answers) + '" ' + click(() => openQuestion(q.id)) + '>' + ic('chevron', 14) + '</button></div>';
      const section = (title, qs) => qs.length ? '<div class="nav-group" style="padding:12px 18px 4px">' + esc(title) + ' · ' + qs.length + '</div>' + qs.map(row).join('') : '';
      const status = mode !== 'own' ? '' : '<div class="banner" style="margin:0;border-radius:0;border-width:0 0 1px">' +
        (diff.changed ? '<span class="swatch" style="border-radius:50%;background:var(--amber)"></span><span class="item" style="color:var(--amber)">' + esc(diff.never ? R.neverSaved : R.changed(diff.added, diff.removed)) + '</span>'
          : '<span class="swatch" style="border-radius:50%;background:var(--good)"></span><span class="item good">' + esc(R.saved) + '</span>') + '</div>';
      const runList = '<div class="panel"><div class="panel-h"><div><h2>' + esc(R.listTitle) + '</h2><span class="sub">' + esc(R.listSub) + '</span></div></div>' + status +
        '<div>' + section(R.grpKey, grp.key) + section(R.grpOn, grp.on) + section(R.grpOwn, grp.own) + '</div>' +
        '<div class="panel-b" style="display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--line2)">' +
        (off ? '<span class="s13 muted">' + esc(R.more(off)) + ' · <button class="link" ' + click(() => set({ tab: 'questions', scope: 'more', onlyGaps: false })) + '>' + esc(R.showMore) + '</button></span>' : '') +
        '<div class="form"><label for="newq" class="sr">' + esc(l.newQLabel) + '</label><input id="newq" type="text" maxlength="300" value="' + esc(state.newQ) + '" placeholder="' + esc(R.addPh) + '" ' + attr('input', e => { state.newQ = e.target.value; }) + ' ' + attr('keydown', e => { if (e.key === 'Enter') addQuestion(true); }) + '>' +
        '<label for="newcat" class="sr">' + esc(l.topicLabel) + '</label><select id="newcat" ' + attr('change', e => { state.newCat = e.target.value; }) + '>' + CATS.map(c => '<option value="' + c.id + '"' + (state.newCat === c.id ? ' selected' : '') + '>' + esc(catLabel(c.id)) + '</option>').join('') + '</select>' +
        '<button class="btn plain" ' + click(() => addQuestion(true)) + '>' + esc(l.save) + '</button></div>' +
        (state.formMsg === 'short' ? '<span class="small warn">' + esc(l.msg.short) + '</span>' : '') + '</div></div>';

      const repo = MON.github_repo;
      const cmd = 'python monitoring/run.py\npython scripts/export_monitoring.py';
      const step = (n, title, text, body) => '<div style="display:flex;gap:12px;padding:14px 18px;border-top:1px solid var(--line2)">' +
        '<span class="nba-n">' + n + '</span><div style="display:flex;flex-direction:column;gap:8px;min-width:0;flex-grow:1"><span style="font-weight:600">' + esc(title) + '</span>' +
        '<span class="s13 muted">' + esc(text) + '</span>' + (body || '') + '</div></div>';
      const canSave = mode === 'own' && T;
      const start = '<div class="panel" style="position:sticky;top:68px"><div class="panel-h"><h2>' + esc(R.startTitle) + '</h2></div>' +
        (over ? '<div class="banner" style="margin:12px 18px 0;color:var(--warn)">' + esc(R.overBudget(MON.budget.max_calls_per_run, MON.budget.max_usd_per_run)) + '</div>' : '') +
        '<div style="padding-top:4px">' +
        (canSave ? step(1, R.s1, R.s1Text(T.path), '<button class="btn' + (diff.changed ? '' : ' plain') + '" style="align-self:flex-start" ' + click(saveRunList) + '>' + ic('download', 15) + esc(R.s1Btn) + '</button>') : '') +
        step(canSave ? 2 : 1, R.s2, R.s2Text, repo ? '<a class="btn" style="align-self:flex-start;text-decoration:none" target="_blank" rel="noopener noreferrer" href="https://github.com/' + esc(repo) + '/actions/workflows/monitoring.yml">' + ic('external', 15) + esc(R.s2Btn) + '</a>' : '') +
        step(canSave ? 3 : 2, R.s3, R.s3Text, '<code class="mono s13" style="display:block;white-space:pre-wrap;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:8px 10px">' + esc(cmd) + '</code>' +
          '<button class="btn sm plain" style="align-self:flex-start" ' + click(() => copyToClipboard(cmd, 'runcmd')) + '>' + ic('copy', 14) + esc(state.copied === 'runcmd' ? l.copied : R.copyCmd) + '</button>') +
        (mode === 'own' ? step(canSave ? 4 : 3, R.s4, R.s4Text, '<label for="run-results-file" class="btn sm plain" style="align-self:flex-start;cursor:pointer">' + ic('upload', 14) + esc(l.chooseFile) + '</label>' +
          '<input id="run-results-file" type="file" accept="application/json,.json" class="sr" ' + attr('change', loadMonitoringFile) + '>' +
          (state.monitoringMsg === 'error' ? '<span class="s13 warn">' + esc(l.loadMonitoringError) + '</span>' : '')) : '') +
        '</div><div class="panel-b" style="border-top:1px solid var(--line2);display:flex;flex-direction:column;gap:8px"><span class="small muted" style="font-weight:600;text-transform:uppercase;letter-spacing:.05em">' + esc(R.engines) + '</span>' +
        MON.engines.map(e => { const i = ENGINES.findIndex(x => x.id === e.id); return '<div class="s13" style="display:flex;align-items:center;gap:8px;' + (e.enabled ? '' : 'opacity:.5') + '"><span class="swatch" style="background:var(--viz-' + (i + 1) + ')"></span><b style="font-weight:500">' + esc(ENGINES[i].name) + '</b><span class="mono small muted">' + esc(e.model) + '</span><span class="muted" style="margin-left:auto">' + esc(e.enabled ? R.perCall(e.usd_per_call) : R.off) + '</span></div>'; }).join('') +
        '</div></div>';

      return '<section><div class="page-head"><div class="head"><h1>' + esc(l.tabs.run) + '</h1><p>' + esc(R.sub) + '</p></div></div>' +
        demo + kpis + '<div class="grid g-main" style="align-items:start">' + runList + start + '</div></section>';
    }

    // ---------- Shell helpers ----------
    const LOGO = '<svg width="18" height="18" viewBox="0 0 32 32" fill="none"><path d="M9 16a7 7 0 1 0 7-7" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><circle cx="16" cy="16" r="2.8" fill="currentColor"/></svg>';
    const MOD = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl ';
    function switchToDemo() { if (mode !== 'demo') { mode = 'demo'; saveMode('demo'); boot(); } }
    function switchToOwn() {
      if (mode !== 'own') { mode = 'own'; saveMode('own'); if (own) boot(); else renderSetup(); } else { initSetupDraft(); renderSetup(); }
    }
    function themeClick() { const t = toggleTheme(); render(); toast(L().ui.toastTheme(t)); }
    function openPalette() { set({ palette: true, palQuery: '', palSel: 0, help: false, navOpen: false, fx: 'palette' }); }
    function openQuestion(id) { set({ drawerQ: id, palette: false, fx: state.drawerQ ? null : 'drawer' }); }

    // Small numbers next to nav items: what needs attention on that page.
    function navCounts(ctx) {
      const l = L();
      const S = D.demo.cited_sources || [];
      const targets = S.filter(c => c.present === false).length;
      const high = D.audit.filter(a => a.priority === 'high' && !state.auditDone[a.id]).length;
      const ph = allBlocksList().filter(b => b.placeholder).length;
      return {
        questions: ctx.gapQs.length ? { n: ctx.gapQs.length, warn: true, tip: l.ui.bannerGaps(ctx.gapQs.length) } : null,
        run: runDiff().changed ? { n: '!', warn: true, tip: l.ui.run.navTip } : null,
        sources: targets ? { n: targets, tip: l.srcStatTargets + ': ' + targets } : null,
        website: high ? { n: high, warn: true, tip: l.webStatHigh + ': ' + high } : null,
        library: ph ? { n: ph, tip: l.libNeedsContent + ': ' + ph } : null,
      };
    }

    // Status chip for one engine's result: icon-like dot + label (+ rank).
    function chip(st, short) {
      const l = L();
      const k = st.k;
      const label = short ? (l.ui.chip[k] || '–') : l.dot[k];
      const sw = { cited: 'var(--st-cited)', mentioned: 'var(--st-mentioned)', absent: 'var(--st-absent)', notrun: 'var(--st-none)', inactive: 'var(--st-none)' }[k];
      return '<span class="chip ' + k + '"' + (short ? ' data-tt="' + esc(l.dot[k] + (st.p ? ' · ' + l.ui.position + ' ' + st.p : '')) + '"' : '') + '><span class="swatch" style="background:' + sw + ';border-radius:50%"></span>' + esc(label) +
        (st.p ? '<span class="p">#' + st.p + '</span>' : '') + '</span>';
    }

    // ---------- Overlays: question drawer, command palette, shortcut help ----------
    function overlays(fx) {
      let html = '';
      if (state.drawerQ) html += drawerHtml(fx === 'drawer');
      if (state.palette) html += paletteHtml(fx === 'palette');
      if (state.help) html += helpHtml(fx === 'help');
      return html;
    }

    // The list the drawer's prev/next buttons walk through: the rows visible on
    // the Questions page if that's where we are, otherwise all active questions.
    let visibleQs = [];
    function drawerList() { return state.tab === 'questions' && visibleQs.length ? visibleQs : allQ().filter(isActive); }

    function drawerHtml(enter) {
      const l = L();
      const q = allQ().find(x => x.id === state.drawerQ);
      if (!q) return '';
      const list = drawerList();
      const i = list.findIndex(x => x.id === q.id);
      const go = d => () => { const n = list[i + d]; if (n) set({ drawerQ: n.id, qSel: state.tab === 'questions' ? i + d : state.qSel }); };
      const act = isActive(q);
      const ans = ANSWERS[q.id] || [];
      const cards = ENGINES.map(e => '<div class="eng-card"><span class="name"><span class="swatch" style="background:var(--viz-' + (ENGINES.indexOf(e) + 1) + ')"></span>' + esc(e.name) + '</span>' + chip(status(q, e.id)) + '</div>').join('');
      const meta = '<dl class="kv"><dt>' + esc(l.ui.topics) + '</dt><dd>' + esc(catLabels(q.tags)) + '</dd>' +
        '<dt>' + esc(l.ui.kind) + '</dt><dd>' + esc(q.key ? l.metaKey : q.custom ? l.metaCustom : l.metaManual) + '</dd>' +
        (q.comp ? '<dt>' + esc(l.ui.compInstead) + '</dt><dd>' + esc(q.comp) + '</dd>' : '') + '</dl>';
      const gap = isGap(q);
      return '<div class="scrim' + (enter ? ' enter' : '') + '" ' + click(() => set({ drawerQ: null })) + '></div>' +
        '<aside class="drawer' + (enter ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-labelledby="drawer-title">' +
        '<div class="drawer-h"><div class="t"><span class="small muted">' + esc(q.key ? l.keyQ : l.tabs.questions) + (list.length ? ' · ' + (i + 1) + ' / ' + list.length : '') + '</span>' +
        '<h2 id="drawer-title">' + esc(q.text) + '</h2></div>' +
        '<div class="drawer-nav"><button class="icon-btn" aria-label="' + esc(l.ui.prevQ) + '" data-tt="' + esc(l.ui.prevQ + ' (K)') + '" ' + (i > 0 ? click(go(-1)) : 'disabled') + '>' + ic('up', 16) + '</button>' +
        '<button class="icon-btn" aria-label="' + esc(l.ui.nextQ) + '" data-tt="' + esc(l.ui.nextQ + ' (J)') + '" ' + (i < list.length - 1 ? click(go(1)) : 'disabled') + '>' + ic('down', 16) + '</button>' +
        '<button class="icon-btn" data-autofocus aria-label="' + esc(l.ui.close) + '" data-tt="' + esc(l.ui.close + ' (Esc)') + '" ' + click(() => set({ drawerQ: null })) + '>' + ic('x', 16) + '</button></div></div>' +
        '<div class="drawer-b"><div style="display:flex;flex-direction:column;gap:8px"><h3>' + esc(l.ui.status) + '</h3><div class="eng-cards">' + cards + '</div></div>' + meta +
        '<div style="display:flex;flex-direction:column;gap:10px"><h3>' + esc(l.ui.answers) + '</h3>' +
        (ans.length ? '<div class="legend"><span><mark class="m-brand">' + esc(l.answerKeyBrand) + '</mark></span><span><mark class="m-comp">' + esc(l.answerKeyComp) + '</mark></span></div>' + answerItems(ans)
          : '<p class="s13 muted" style="margin:0">' + esc(l.ui.noAnswers) + '</p>') + '</div></div>' +
        '<div class="drawer-f">' +
        (act ? '<button class="btn' + (gap ? '' : ' plain') + '" ' + click(() => openDraft(q.id)) + '>' + ic('write', 15) + esc(gap ? l.actClose : l.actExpand) + '</button>' : '') +
        '<button class="btn plain" ' + click(() => toggleActive(q)) + '>' + esc(act ? l.ui.toggleOff : l.actActivate) + '</button>' +
        '</div></aside>';
    }

    // Command palette: pages, actions and every question, filtered by words.
    function paletteItems() {
      const l = L();
      const words = state.palQuery.toLowerCase().split(/\s+/).filter(Boolean);
      const hit = t => words.every(w => t.toLowerCase().indexOf(w) !== -1);
      const pages = ['overview'].concat(GROUPS.monitor, GROUPS.improve).map(id => ({
        group: l.ui.palPages, icon: id, label: l.tabs[id], hint: GROUP_OF[id] ? l.groups[GROUP_OF[id]] : '', run: () => set({ tab: id, palette: false })
      }));
      const actions = [
        { icon: isDark() ? 'sun' : 'moon', label: isDark() ? l.ui.actLight : l.ui.actDark, hint: 'T', run: () => { set({ palette: false }); themeClick(); } },
        { icon: 'globe2', label: l.ui.actLang, hint: state.lang === 'en' ? 'DE' : 'EN', run: () => set({ lang: state.lang === 'en' ? 'de' : 'en', palette: false }) },
        { icon: 'write', label: l.ui.actWrite, run: () => set({ tab: 'write', writeStep: 1, brief: '', palette: false }) },
        mode === 'demo' ? { icon: 'swap', label: l.ui.actOwn, run: () => { state.palette = false; switchToOwn(); } } : { icon: 'swap', label: l.ui.actDemo, run: () => { state.palette = false; switchToDemo(); } },
        mode === 'own' ? { icon: 'library', label: l.ui.actSetup, run: () => { state.palette = false; switchToOwn(); } } : null,
        { icon: 'keyboard', label: l.ui.actHelp, hint: '?', run: () => set({ palette: false, help: true, fx: 'help' }) },
      ].filter(Boolean).map(a => Object.assign({ group: l.ui.palActions }, a));
      const qs = allQ().map(q => ({
        group: l.ui.palQuestions, icon: 'questions', label: q.text, hint: isGap(q) ? l.missingShort(absentCount(q)) : '', warn: isGap(q),
        run: () => set({ tab: 'questions', drawerQ: q.id, palette: false, fx: 'drawer' })
      }));
      const out = pages.concat(actions).filter(x => hit(x.label + ' ' + (x.hint || '')));
      return out.concat(qs.filter(x => words.length ? hit(x.label) : false).slice(0, 12));
    }
    function paletteHtml(enter) {
      const l = L();
      const items = paletteItems();
      const sel = Math.max(0, Math.min(state.palSel, items.length - 1));
      let lastGroup = '';
      const list = items.map((it, n) => {
        const head = it.group !== lastGroup ? '<div class="pal-group">' + esc(it.group) + '</div>' : '';
        lastGroup = it.group;
        return head + '<button class="pal-item' + (n === sel ? ' sel' : '') + '" role="option" id="pal-opt-' + n + '" aria-selected="' + (n === sel) + '" tabindex="-1" ' + click(it.run) + '>' +
          ic(it.icon, 16) + '<span class="t">' + esc(it.label) + '</span>' + (it.hint ? '<span class="hint' + (it.warn ? ' warn' : '') + '">' + esc(it.hint) + '</span>' : '') + '</button>';
      }).join('');
      return '<div class="scrim' + (enter ? ' enter' : '') + '" ' + click(() => set({ palette: false })) + '></div>' +
        '<div class="palette' + (enter ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-label="' + esc(l.ui.search) + '">' +
        '<div class="pal-in">' + ic('search', 18) + '<input id="pal-input" type="text" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-activedescendant="pal-opt-' + sel + '" autocomplete="off" spellcheck="false" placeholder="' + esc(l.ui.palPh) + '" value="' + esc(state.palQuery) + '" ' +
        attr('input', e => set({ palQuery: e.target.value, palSel: 0 })) + ' ' + attr('keydown', e => paletteKey(e, items, sel)) + '><span class="kbd">Esc</span></div>' +
        '<div class="pal-list" id="pal-list" role="listbox">' + (list || '<div class="empty">' + esc(l.ui.palEmpty) + '</div>') + '</div>' +
        '<div class="pal-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span>' + esc(l.ui.palNav) + '</span><span><span class="kbd">↵</span>' + esc(l.ui.palOpen) + '</span><span><span class="kbd">Esc</span>' + esc(l.ui.palClose) + '</span></div></div>';
    }
    function paletteKey(e, items, sel) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = items.length;
        if (n) set({ palSel: (sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (items[sel]) items[sel].run();
      }
    }

    function helpHtml(enter) {
      const l = L();
      const k = s => s.split(' ').map(x => '<kbd>' + esc(x) + '</kbd>').join('');
      const rows = [
        [l.ui.keySearch, k(MOD.trim() + ' K')], [l.ui.keyGo, k('G') + '<span class="small muted">' + esc(l.ui.keyThen) + '</span>' + k('O')],
        [l.ui.keyNav, k('J K')], [l.ui.keyOpen, k('↵')], [l.ui.keyFilter, k('/')], [l.ui.keyTheme, k('T')], [l.ui.keyEsc, k('Esc')], [l.ui.keyHelp, k('?')],
      ].map(r => '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>').join('');
      return '<div class="scrim' + (enter ? ' enter' : '') + '" ' + click(() => set({ help: false })) + '></div>' +
        '<div class="modal' + (enter ? ' enter' : '') + '" role="dialog" aria-modal="true" aria-labelledby="help-title">' +
        '<div style="display:flex;align-items:center;justify-content:space-between"><h2 id="help-title" style="font-size:16px">' + esc(l.ui.shortcuts) + '</h2>' +
        '<button class="icon-btn" data-autofocus aria-label="' + esc(l.ui.close) + '" ' + click(() => set({ help: false })) + '>' + ic('x', 16) + '</button></div>' +
        '<dl class="keys" style="margin:0">' + rows + '</dl></div>';
    }

    // ---------- Keyboard ----------
    const GO_KEYS = { o: 'overview', q: 'questions', m: 'run', s: 'sources', i: 'impact', w: 'website', r: 'write', l: 'library' };
    let gPressed = 0;
    onKey = e => {
      const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable]');
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (state.palette) set({ palette: false }); else openPalette(); return; }
      if (e.key === 'Escape') {
        if (state.palette) set({ palette: false });
        else if (state.help) set({ help: false });
        else if (state.drawerQ) set({ drawerQ: null });
        else if (state.navOpen) set({ navOpen: false });
        else if (typing && e.target.type === 'search') { e.target.blur(); }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || state.palette) return;
      const key = e.key.toLowerCase();
      if (gPressed && Date.now() - gPressed < 1200 && GO_KEYS[key]) { gPressed = 0; e.preventDefault(); set({ tab: GO_KEYS[key] }); return; }
      gPressed = key === 'g' ? Date.now() : 0;
      if (e.key === '?') { e.preventDefault(); set({ help: !state.help, fx: state.help ? null : 'help' }); return; }
      if (state.help) return;
      if (key === 't') { e.preventDefault(); themeClick(); return; }
      if (e.key === '/') {
        const f = root.querySelector('[data-filter]');
        e.preventDefault();
        if (f) f.focus(); else openPalette();
        return;
      }
      if (key === 'j' || key === 'k' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const d = key === 'j' || e.key === 'ArrowDown' ? 1 : -1;
        if (state.drawerQ) {
          const list = drawerList(); const i = list.findIndex(x => x.id === state.drawerQ); const n = list[i + d];
          if (n) { e.preventDefault(); set({ drawerQ: n.id, qSel: state.tab === 'questions' ? i + d : state.qSel }); }
        } else if (state.tab === 'questions' && visibleQs.length && (key === 'j' || key === 'k')) {
          e.preventDefault();
          set({ qSel: Math.max(0, Math.min(visibleQs.length - 1, state.qSel + d)) });
        }
        return;
      }
      if (e.key === 'Enter' && state.tab === 'questions' && !state.drawerQ && visibleQs[state.qSel] && !(e.target.closest && e.target.closest('button, a'))) {
        e.preventDefault(); openQuestion(visibleQs[state.qSel].id);
      }
    };

    // ---------- Root render ----------
    function render() {
      // Keep focus (and caret) across re-renders. Every click re-renders the
      // whole app, which used to drop keyboard focus back to <body> after any
      // button press -- keyboard users had to tab from the top again.
      // Inputs are matched by id; anything else by its label + position.
      const focusKey = captureFocus();
      handlers = [];
      const l = L();

      const keyQs = QUESTIONS.filter(q => q.key);
      let totalHits = 0;
      const kpis = ENGINES.map(e => { const h = keyQs.filter(q => isHit(status(q, e.id).k)).length; totalHits += h; return { name: e.name, pct: pct(h, keyQs.length) }; });
      const activeQs = allQ().filter(isActive);
      const ctx = {
        kpis, nowPct: pct(totalHits, keyQs.length * ENGINES.length),
        gapQs: activeQs.filter(isGap), fullGapCount: activeQs.filter(q => absentCount(q) === 3).length,
        ranked: CATS.map(c => ({ c, st: catStats(c.id) })).sort((a, b) => b.st.weight - a.st.weight)
      };

      const isFreshOwn = mode === 'own' && allBlocksList().length === 0 && D.audit.length === 0 && D.pages.length === 0 && Object.keys(D.demo.results).length === 0;
      const views = {
        overview: isFreshOwn ? viewGettingStarted : viewOverview, questions: viewQuestions, run: viewRun, sources: viewSources, website: viewWebsite, impact: viewImpact, library: viewLibrary,
        write: c => state.writeStep === 1 ? viewWriteBrief(c) : viewStudio(c)
      };
      document.documentElement.lang = state.lang;
      const fx = state.fx;
      state.fx = null;
      const curGroup = GROUP_OF[state.tab];
      const counts = navCounts(ctx);
      const navItem = id => '<button class="nav-item' + (state.tab === id ? ' on' : '') + '"' + (state.tab === id ? ' aria-current="page"' : '') + ' ' + click(() => set({ tab: id })) + '>' +
        ic(id) + '<span>' + esc(l.tabs[id]) + '</span>' +
        (counts[id] ? '<span class="nav-count' + (counts[id].warn ? ' warn' : '') + '" data-tt="' + esc(counts[id].tip) + '">' + counts[id].n + '</span>' : '') + '</button>';
      const nav = navItem('overview') + Object.keys(GROUPS).map(g => '<div class="nav-group">' + esc(l.groups[g]) + '</div>' + GROUPS[g].map(navItem).join('')).join('');
      // One compact control instead of three separate ones: clicking your own
      // brand's button when it's already active reopens the setup editor,
      // instead of a dedicated extra "Edit setup" link next to it.
      const modeSwitch = '<div class="lang" role="group" aria-label="Mode">' +
        '<button class="' + (mode === 'demo' ? 'on' : '') + '" aria-pressed="' + (mode === 'demo') + '" ' + click(switchToDemo) + '>' + esc(l.modeDemo) + '</button>' +
        '<button class="' + (mode === 'own' ? 'on' : '') + '" aria-pressed="' + (mode === 'own') + '" ' + click(switchToOwn) + '>' + esc(own ? own.brand.short : l.modeOwn) + '</button></div>';
      const langSwitch = '<div class="lang" role="group" aria-label="Language">' +
        '<button class="' + (state.lang === 'en' ? 'on' : '') + '" aria-pressed="' + (state.lang === 'en') + '" ' + click(() => set({ lang: 'en' })) + '>EN</button>' +
        '<button class="' + (state.lang === 'de' ? 'on' : '') + '" aria-pressed="' + (state.lang === 'de') + '" ' + click(() => set({ lang: 'de' })) + '>DE</button></div>';
      const themeLabel = isDark() ? l.ui.actLight : l.ui.actDark;
      const sidebar = '<aside class="side" id="sidenav" aria-label="' + esc(l.sections) + '">' +
        '<div class="side-brand"><span class="logo" aria-hidden="true">' + LOGO + '</span><div><b>' + esc(BRAND.short) + '</b><span>GEO Engine</span></div></div>' +
        '<button class="search-btn" ' + click(openPalette) + '>' + ic('search', 15) + '<span>' + esc(l.ui.search) + '</span><span class="kbd">' + MOD + 'K</span></button>' +
        '<nav class="nav">' + nav + '</nav>' +
        '<div class="side-foot">' + modeSwitch +
        '<button class="side-hint" ' + click(() => set({ help: true, fx: 'help' })) + '>' + ic('keyboard', 15) + '<span>' + esc(l.ui.shortcuts) + '</span><span class="kbd" style="margin-left:auto">?</span></button></div></aside>';
      const topbar = '<header class="topbar">' +
        '<button class="icon-btn menu-btn" aria-label="' + esc(l.ui.menu) + '" aria-controls="sidenav" aria-expanded="' + state.navOpen + '" ' + click(() => set({ navOpen: !state.navOpen })) + '>' + ic('menu', 18) + '</button>' +
        '<div class="crumbs">' + (curGroup ? '<span class="crumb-group">' + esc(l.groups[curGroup]) + '</span><span class="crumb-group">' + ic('chevron', 13) + '</span>' : '') + '<b>' + esc(l.tabs[state.tab]) + '</b></div>' +
        '<div class="right">' + langSwitch +
        '<button class="icon-btn" aria-label="' + esc(themeLabel) + '" data-tt="' + esc(themeLabel + ' (T)') + '" ' + click(themeClick) + '>' + ic(isDark() ? 'sun' : 'moon', 17) + '</button>' +
        '<button class="icon-btn" aria-label="' + esc(l.ui.search) + '" data-tt="' + esc(l.ui.search + ' (' + MOD + 'K)') + '" ' + click(openPalette) + '>' + ic('search', 17) + '</button></div></header>';
      root.innerHTML =
        '<a class="skip" href="#main">' + esc(state.lang === 'de' ? 'Zum Inhalt springen' : 'Skip to content') + '</a>' +
        '<div class="shell' + (state.navOpen ? ' nav-open' : '') + '">' + sidebar +
        '<div class="content">' + topbar +
        '<main id="main" tabindex="-1"><div' + (fx === 'page' ? ' class="page-in"' : '') + '>' + withH1(views[state.tab](ctx), l.tabs[state.tab]) + '</div></main></div></div>' +
        (state.navOpen ? '<div class="scrim" style="z-index:64" ' + click(() => set({ navOpen: false })) + '></div>' : '') +
        overlays(fx);

      // A freshly opened overlay takes focus; otherwise keep it where it was.
      if (fx === 'palette') { const i = document.getElementById('pal-input'); if (i) i.focus(); }
      else if (fx === 'drawer' || fx === 'help') { const c = root.querySelector('[data-autofocus]'); if (c) c.focus(); }
      else restoreFocus(focusKey);
      const sel = root.querySelector('.pal-item.sel, .qrow.sel');
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }

    render();
  }

  // ---------- Boot dispatch ----------
  if (mode === null) { renderWelcome(); }
  else if (mode === 'own' && !own) { renderSetup(); }
  else { boot(); }
})();
