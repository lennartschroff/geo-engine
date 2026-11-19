/*
 * GEO Engine – client-side dashboard.
 *
 * Pure static app: no build step, no framework, no network calls (enforced by
 * the CSP in index.html). Demo data comes from data.js (generated from the
 * JSON files in /data by scripts/build_web_data.py). A visitor can instead
 * set up their own brand entirely in the browser (see the Welcome/Setup
 * screens below) — that data lives only in this browser's localStorage and
 * never touches any server. User state (custom questions, activations,
 * drafts, audit checkmarks) also lives in localStorage, namespaced per mode
 * so switching between the demo and your own brand doesn't mix them up.
 */
'use strict';

(function () {
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

  let mode = loadMode();
  let own = loadOwn();

  // ---------- Shared helpers & event wiring (used by every screen) ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // faint was #9A9DA5 (2.71:1 on white, failed WCAG AA). It's used for text
  // (dashes, "too early" labels), so it now equals muted (5.0:1 on white,
  // 4.7:1 on the --soft card background). graphic (#8A877F, 3.6:1) is for
  // non-text marks like the "not run" dot outline, which need 3:1 (WCAG 1.4.11).
  const C = { fg: '#16181D', muted: '#6B6F78', faint: '#6B6F78', graphic: '#8A877F', accent: '#1F4FD1', warn: '#C2410C', amber: '#B45309', border: '#CFCCC4' };
  // Small line icons (stroke="currentColor", inherits color from surrounding
  // text) -- used instead of emoji throughout, matching the rest of the app's
  // monochrome, minimal visual language.
  const icon = (size, path) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-' + Math.round(size * 0.16) + 'px;flex-shrink:0">' + path + '</svg>';
  const iconEye = size => icon(size, '<path d="M2 12s3.4-6.5 10-6.5S22 12 22 12s-3.4 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>');
  const iconSliders = size => icon(size, '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/>');
  const iconCheck = size => icon(size, '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9"/>');
  const iconCircle = size => icon(size, '<circle cx="12" cy="12" r="9"/>');

  const root = document.getElementById('app');
  let handlers = [];
  const on = fn => { handlers.push(fn); return handlers.length - 1; };
  const attr = (evt, fn) => 'data-on-' + evt + '="' + on(fn) + '"';
  const click = fn => attr('click', fn);
  ['click', 'change', 'input', 'dragstart', 'dragend', 'dragover', 'dragleave', 'drop', 'keydown'].forEach(evt => {
    root.addEventListener(evt, e => {
      const el = e.target.closest('[data-on-' + evt + ']');
      if (!el || !root.contains(el)) return;
      const fn = handlers[+el.getAttribute('data-on-' + evt)];
      if (fn) fn(e, el);
    });
  });

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
      '<span class="small muted">You can switch between the two at any time from the header.</span></div>';
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
    const GROUPS = { monitor: ['questions', 'sources', 'impact'], improve: ['website', 'write', 'library'] };
    const GROUP_OF = {};
    Object.keys(GROUPS).forEach(g => GROUPS[g].forEach(id => { GROUP_OF[id] = g; }));
    const TYPE_FG = { statement: '#1A3A9C', definition: '#3A3D45', figure: '#16181D', case: '#9A3412', quote: '#5B2A86', faq: '#1F5C55' };
    // Namespaced per mode so switching demo <-> own brand never mixes up
    // activations/custom questions/drafts/audit checkmarks between the two.
    const STORE_KEY = 'geo-engine:v1:' + mode;

    // ---------- Data preparation ----------
    const CATS = D.categories.map(c => ({ id: c.id, kw: c.keywords }));
    const QUESTIONS = D.questions.map(q => {
      const res = D.demo.results[q.id];
      return { id: q.id, text: q.text, tags: q.categories, key: q.key, comp: res ? res.competitor : null, r: res ? CORE.parseResult(res.r) : null };
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
      lang: 'en', tab: 'overview', scope: 'key', onlyGaps: false, srcFilter: 'all', openAnswers: null,
      libCat: 'all', libType: 'all', writeStep: 1, allBlocks: false, selectedQ: DEFAULT_Q,
      brief: '', newQ: '', newCat: DEFAULT_CAT, formMsg: '', copied: null,
      newBlockType: 'statement', newBlockText: '', newBlockCats: [], blockMsg: '', monitoringMsg: '', pagesMsg: '',
      importText: '', importSource: '', importCands: [], importMsg: '', polished: {}, factConfirm: {},
      active: {}, custom: [], customBlocks: [], drafts: {}, auditDone: {}
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
    function set(patch) { Object.assign(state, patch); persist(); render(); }

    // ---------- Domain logic ----------
    const L = () => STR[state.lang];
    // Topic labels come from categories.json (label_en/label_de).
    const CAT_BY_ID = Object.fromEntries(D.categories.map(c => [c.id, c]));
    const catLabel = id => { const c = CAT_BY_ID[id]; return (c && (state.lang === 'de' ? c.label_de : c.label_en)) || id; };
    const catLabels = tags => tags.map(catLabel).join(' · ');
    const blockText = b => state.lang === 'de' ? b.de : b.en;
    const allQ = () => QUESTIONS.concat(state.custom);
    const isActive = q => state.active[q.id] === undefined ? (q.key || !!q.custom) : state.active[q.id];

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
        cited: [C.accent, C.accent, l.dot.cited, p], mentioned: ['#fff', C.accent, l.dot.mentioned, p],
        absent: [C.warn, C.warn, l.dot.absent, ''], notrun: ['#fff', C.graphic, l.dot.notrun, ''],
        inactive: ['#fff', '#E6E4DE', l.dot.inactive, '']
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

    function viewOverview(ctx) {
      const l = L();
      const kpis = ctx.kpis.map(k => '<div class="kpi"><span style="color:#3A3D45">' + k.name + '</span>' + track(k.pct) + '<span class="mono" style="text-align:right">' + k.pct + '%</span></div>').join('');
      const gaps = ctx.gapQs.slice().sort((a, b) => (b.key - a.key) || (absentCount(b) - absentCount(a))).slice(0, 5).map(q =>
        '<div class="gap"><div><span>' + esc(q.text) + '</span><span class="small muted">' + esc((q.key ? l.keyQ + ' · ' : '') + catLabels(q.tags)) + '</span></div>' +
        '<span class="s13 warn" style="white-space:nowrap">' + esc(l.missingOf(absentCount(q))) + '</span>' +
        '<button class="btn sm outline" ' + click(() => openDraft(q.id)) + '>' + esc(l.close) + '</button></div>').join('');
      const bars = CATS.map(c => { const st = catStats(c.id); return { c, p: st.answers ? pct(st.hits, st.answers) : -1 }; })
        .sort((a, b) => a.p - b.p)
        .map(o => { const col = o.p < 0 ? C.faint : o.p < 34 ? C.warn : C.accent; return '<div class="catbar"><span>' + esc(catLabel(o.c.id)) + '</span>' + track(Math.max(o.p, 0), col) + '<span class="mono s13" style="text-align:right;color:' + col + '">' + (o.p < 0 ? '–' : o.p + '%') + '</span></div>'; }).join('');
      const top = ctx.ranked[0];
      return '<section style="gap:56px"><div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">' +
        '<div class="stat"><span class="l">' + esc(l.visKey) + '</span><span class="n big">' + ctx.nowPct + '%</span><span class="l">' + esc(l.visSub) + '</span></div>' +
        '<div class="stat"><span class="l">' + esc(l.openGaps) + '</span><span class="n big warn">' + ctx.gapQs.length + '</span><span class="l">' + esc(l.fullGap(ctx.fullGapCount)) + '</span></div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;justify-content:center">' + kpis + '</div></div>' +
        '<div class="split"><div class="main"><div class="listhead"><h2>' + esc(l.biggestGaps) + '</h2><button class="link" ' + click(() => set({ tab: 'questions' })) + '>' + esc(l.allQuestions) + '</button></div>' + (gaps || '<div class="muted" style="padding:16px 0">' + esc(l.noRows) + '</div>') + '</div>' +
        '<div class="side"><div class="listhead" style="align-items:flex-end"><h2>' + esc(l.visByTopic) + '</h2></div>' + bars + '</div></div>' +
        (top ? '<div class="callout"><div style="display:flex;flex-direction:column;gap:2px"><span class="s13 muted">' + esc(l.recToday) + '</span><span style="font-size:18px;font-weight:500">' + esc(l.teaser(catLabel(top.c.id), top.st.gapQs.length)) + '</span></div>' +
        '<button class="btn" ' + click(() => set({ tab: 'write', writeStep: 1, brief: '' })) + '>' + esc(l.writeCta) + '</button></div>' : '') + '</section>';
    }

    function viewQuestions() {
      const l = L();
      const inScope = q => state.scope === 'all' || (state.scope === 'key' && q.key) || (state.scope === 'more' && !q.key && !q.custom) || (state.scope === 'custom' && q.custom);
      const rows = allQ().filter(q => inScope(q) && (!state.onlyGaps || isGap(q)));
      const scopes = [['key', l.scopeKey], ['more', l.scopeMore], ['custom', l.scopeCustom(state.custom.length)], ['all', l.all]]
        .map(f => tabBtn(f[1], state.scope === f[0], () => set({ scope: f[0] }))).join('');
      const opts = CATS.map(c => '<option value="' + c.id + '"' + (state.newCat === c.id ? ' selected' : '') + '>' + esc(catLabel(c.id)) + '</option>').join('');
      const body = rows.map(q => {
        const act = isActive(q); const gap = isGap(q); const hasData = !!q.r;
        let label, fn, cls;
        if (!act) { label = l.actActivate; fn = () => toggleActive(q); cls = 'ghost'; }
        else if (gap) { label = l.actClose; fn = () => openDraft(q.id); cls = ''; }
        else if (!hasData) { label = l.actWait; fn = null; cls = 'ghost'; }
        else { label = l.actExpand; fn = () => openDraft(q.id); cls = 'plain'; }
        const meta = (q.key ? l.metaKey : q.custom ? l.metaCustom : l.metaManual) + ' · ' + catLabels(q.tags) + (q.r && q.comp ? ' · ' + l.comp + q.comp : '');
        const ans = ANSWERS[q.id] || [];
        const open = state.openAnswers === q.id && ans.length > 0;
        const ansBtn = ans.length ? '<button id="ansbtn-' + esc(q.id) + '" class="link small" style="align-self:flex-start" aria-expanded="' + open + '" aria-controls="ans-' + esc(q.id) + '" ' +
          click(() => set({ openAnswers: open ? null : q.id })) + '>' + esc(open ? l.hideAnswers : l.showAnswers(ans.length)) + '</button>' : '';
        return '<div class="row"><div class="qgrid">' +
          '<input type="checkbox"' + (act ? ' checked' : '') + ' aria-label="' + esc((act ? l.ariaOff : l.ariaOn) + q.text) + '" ' + attr('change', () => toggleActive(q)) + '>' +
          '<div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span style="color:' + (act ? C.fg : C.muted) + '">' + esc(q.text) + '</span><span class="small muted">' + esc(meta) + '</span>' + ansBtn + '</div>' +
          ENGINES.map(e => dot(status(q, e.id))).join('') +
          '<div style="display:flex;justify-content:flex-end"><button class="btn sm ' + cls + '"' + (fn ? ' ' + click(fn) : ' disabled') + '>' + esc(label) + '</button></div>' +
          '</div>' + (open ? answerPanel(q, ans) : '') + '</div>';
      }).join('');
      return '<section><div class="head"><h1>' + esc(l.tabs.questions) + '</h1><p>' + esc(l.questionsSub) + '</p></div>' +
        '<div style="display:flex;flex-direction:column;gap:8px"><div class="form">' +
        '<label for="newq" class="sr">' + esc(l.newQLabel) + '</label><input id="newq" type="text" maxlength="300" value="' + esc(state.newQ) + '" placeholder="' + esc(l.newQPh) + '" ' + attr('input', e => { state.newQ = e.target.value; }) + ' ' + attr('keydown', e => { if (e.key === 'Enter') addQuestion(); }) + '>' +
        '<label for="newcat" class="sr">' + esc(l.topicLabel) + '</label><select id="newcat" ' + attr('change', e => { state.newCat = e.target.value; }) + '>' + opts + '</select>' +
        '<button class="btn" ' + click(addQuestion) + '>' + esc(l.save) + '</button></div>' +
        '<span class="small" style="color:' + (state.formMsg ? '#1A3A9C' : C.muted) + '">' + esc(state.formMsg ? l.msg[state.formMsg] : l.formHint) + '</span></div>' +
        '<div class="subtabs"><div style="display:flex;flex-wrap:wrap;gap:4px">' + scopes + '</div>' +
        '<label class="s14" style="display:flex;align-items:center;gap:8px;color:#3A3D45;min-height:44px;cursor:pointer"><input type="checkbox"' + (state.onlyGaps ? ' checked' : '') + ' ' + attr('change', () => set({ onlyGaps: !state.onlyGaps })) + '><span>' + esc(l.onlyGaps) + '</span></label></div>' +
        '<div class="scroll"><div style="min-width:760px"><div class="qgrid h"><span></span><span></span><span>Claude</span><span>ChatGPT</span><span>Gemini</span><span></span></div>' +
        (rows.length ? body : '<div class="muted" style="padding:24px 0">' + esc(l.noRows) + '</div>') + '</div></div>' +
        '<div class="legend">' +
        '<span><span class="dot" style="background:' + C.accent + ';border-color:' + C.accent + '"></span>' + esc(l.dot.cited) + '</span>' +
        '<span><span class="dot" style="background:#fff;border-color:' + C.accent + '"></span>' + esc(l.dot.mentioned) + '</span>' +
        '<span><span class="dot" style="background:' + C.warn + ';border-color:' + C.warn + '"></span>' + esc(l.dot.absent) + '</span>' +
        '<span><span class="dot" style="background:#fff;border-color:' + C.graphic + '"></span>' + esc(l.noData) + '</span>' +
        '<span>' + esc(l.legendNote) + '</span></div></section>';
    }

    // ---------- Answer viewer (TASKS.md D1) ----------
    function answerPanel(q, ans) {
      const l = L();
      const engineName = id => (ENGINES.find(e => e.id === id) || { name: id }).name;
      const items = ans.map(a =>
        '<div class="answer"><div class="small muted">' + esc(engineName(a.engine)) + ' · ' + esc(a.model === 'demo' ? l.answerDemo : a.model + ' · ' + a.date) + '</div>' +
        (a.variant > 0 && a.prompt ? '<div class="small" style="color:var(--fg2)">' + esc(l.answerVariant) + ': ' + esc(a.prompt) + '</div>' : '') +
        '<p>' + CORE.highlightMentions(a.text, BRAND_NAMES, COMPETITORS) + '</p></div>').join('');
      return '<div class="answers" id="ans-' + esc(q.id) + '">' +
        '<div class="small muted"><mark class="m-brand">' + esc(l.answerKeyBrand) + '</mark> <mark class="m-comp">' + esc(l.answerKeyComp) + '</mark></div>' + items + '</div>';
    }

    // ---------- Share of voice (TASKS.md D2) ----------
    function sovSection() {
      if (!Object.keys(ANSWERS).length || !COMPETITORS.length) return '';
      const l = L();
      const rows = CORE.shareOfVoice(ANSWERS, QUESTIONS, CATS.map(c => c.id), BRAND_NAMES, COMPETITORS)
        .filter(r => r.answers > 0)
        .map(r => '<div class="catbar"><span>' + esc(catLabel(r.cat)) + '<span class="small muted" style="display:block">' + esc(l.sovAnswers(r.answers)) +
          (r.top.length ? ' · ' + esc(l.sovTop + r.top[0].name) : '') + '</span></span>' +
          track(r.share || 0, C.accent) + '<span class="mono s13" style="text-align:right">' + (r.share === null ? '–' : r.share + '%') + '</span></div>').join('');
      return '<div style="display:flex;flex-direction:column;gap:12px"><h2>' + esc(l.sovTitle) + '</h2><span class="s13 muted">' + esc(l.sovSub) + '</span>' + rows + '</div>';
    }

    function toggleActive(q) { const a = Object.assign({}, state.active); a[q.id] = !isActive(q); set({ active: a }); }
    function addQuestion() {
      const text = state.newQ.trim();
      if (text.length < 8) { set({ formMsg: 'short' }); return; }
      const q = { id: 'c' + Date.now().toString(36), text: text.slice(0, 300), tags: [state.newCat], key: false, custom: true, createdAt: new Date().toISOString() };
      set({ custom: state.custom.concat([q]), newQ: '', scope: 'custom', onlyGaps: false, formMsg: 'saved' });
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
      const rows = S.filter(c => state.srcFilter === 'all' || c.present === false).map(c => {
        const col = c.present === true ? C.accent : c.present === false ? C.warn : null;
        return '<div class="row"><div class="sgrid"><div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span>' + esc(c.name) + '</span><span class="small muted">' + esc(l.srcMeta(c.qs)) + '</span></div>' +
          '<span class="s13" style="color:#3A3D45">' + esc(l.kinds[c.kind]) + '</span>' +
          '<div style="display:flex;align-items:center;gap:10px">' + track(pct(c.cites, max), C.fg) + '<span class="mono s13" style="width:24px;text-align:right">' + c.cites + '</span></div>' +
          '<span class="s13" style="display:flex;align-items:center;gap:8px;color:' + (c.present === false ? C.warn : '#3A3D45') + '"><span class="dot" style="background:' + (col || '#fff') + ';border-color:' + (col || C.border) + '"></span>' + esc(c.present === true ? l.yes : c.present === false ? l.no : l.na) + '</span>' +
          '<span class="s14" style="color:' + (c.present === false ? C.fg : C.muted) + ';font-weight:' + (c.present === false ? 500 : 400) + '">' + esc(l.acts[c.act]) + '</span></div></div>';
      }).join('');
      return '<section><div class="head"><h1>' + esc(l.tabs.sources) + '</h1><p>' + esc(l.srcSub) + '</p></div>' +
        '<div class="stats">' + stat(S.length, l.srcStatTotal) + stat(S.filter(c => c.present === true).length, l.srcStatYes, C.accent) + stat(S.filter(c => c.present === false).length, l.srcStatTargets, C.warn) + '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #E6E4DE">' + tabBtn(l.srcAll, state.srcFilter === 'all', () => set({ srcFilter: 'all' })) + tabBtn(l.srcOnlyTargets, state.srcFilter === 'targets', () => set({ srcFilter: 'targets' })) + '</div>' +
        '<div class="scroll"><div style="min-width:820px"><div class="sgrid small muted" style="padding:0 0 8px"><span>' + esc(l.colSource) + '</span><span>' + esc(l.colType) + '</span><span>' + esc(l.colCites) + '</span><span>' + esc(l.colPresent) + '</span><span>' + esc(l.colNext) + '</span></div>' +
        (S.length ? rows : mode === 'own' ? loadMonitoringCard() : '<div class="muted" style="padding:24px 0">' + esc(l.noRows) + '</div>') + '</div></div>' +
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
      const prioCol = { high: ['#FBEBDD', '#9A3412'], mid: ['#F1EFEA', '#3A3D45'], low: ['#FFFFFF', C.muted] };
      const rows = A.map(a => {
        const done = !!state.auditDone[a.id]; const t = a[state.lang];
        return '<div class="row agrid" style="opacity:' + (done ? .5 : 1) + '">' +
          '<input type="checkbox"' + (done ? ' checked' : '') + ' aria-label="' + esc(l.doneAria + t[0]) + '" style="margin-top:3px" ' + attr('change', () => { const m = Object.assign({}, state.auditDone); m[a.id] = !done; set({ auditDone: m }); }) + '>' +
          '<div style="display:flex;flex-direction:column;gap:6px;min-width:0"><span style="font-weight:500;text-decoration:' + (done ? 'line-through' : 'none') + '">' + esc(t[0]) + '</span><span class="s14" style="color:#3A3D45">' + esc(t[1]) + '</span><span class="s14"><b style="font-weight:600">' + esc(l.todo) + ' </b>' + esc(t[2]) + '</span></div>' +
          '<div class="small" style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="badge" style="background:' + prioCol[a.priority][0] + ';color:' + prioCol[a.priority][1] + '">' + esc(l.prio[a.priority]) + '</span><span class="muted">' + esc(l.effort[a.effort]) + '</span></div></div>';
      }).join('');
      const pages = P.map(g => {
        const col = g.score < 50 ? C.warn : C.accent;
        return '<div class="row pgrid"><div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span>' + esc(g[state.lang]) + '</span><span class="small muted" style="overflow-wrap:anywhere">' + esc(BRAND.domain + g.path) + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:10px;padding-top:4px">' + track(g.score, col) + '<span class="mono s13" style="width:26px;text-align:right;color:' + col + '">' + g.score + '</span></div>' +
          '<span class="s13" style="color:#3A3D45">' + esc(g.missing.map(m => l.miss[m]).join(' · ')) + '</span></div>';
      }).join('');
      const avg = P.length ? Math.round(P.reduce((x, g) => x + g.score, 0) / P.length) : 0;
      return '<section style="gap:40px"><div class="head"><h1>' + esc(l.webTitle) + '</h1><p>' + esc(l.webSub(meta.date, meta.pages, meta.posts)) + '</p></div>' +
        '<div class="stats">' + stat(meta.pages + meta.posts, l.webStatPages) + stat(A.filter(a => a.priority === 'high' && !state.auditDone[a.id]).length, l.webStatHigh, C.warn) + stat(avg, l.webStatAvg) + stat(A.filter(a => state.auditDone[a.id]).length + '/' + A.length, l.webStatDone, C.accent) + '</div>' +
        '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px">' + esc(l.webActions) + '</h2>' + (rows || (mode === 'own' ? ownHint('python scripts/audit_crawl.py --base https://yoursite.com\npython scripts/audit_findings.py', l.webHint) + loadPageScoresCard('web-audit-file') : '<div class="muted" style="padding:16px 0">' + esc(l.noRows) + '</div>')) + '</div>' +
        '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:4px">' + esc(l.webPages) + '</h2><p class="s13 muted" style="margin:0 0 12px">' + esc(l.webPagesSub) + '</p><div class="scroll"><div style="min-width:760px">' +
        (pages || (mode === 'own' ? ownHint('python scripts/score_pages.py', l.webHint2) + loadPageScoresCard('web-pages-file') : '<div class="muted" style="padding:16px 0">' + esc(l.noRows) + '</div>')) + '</div></div></div>' +
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
      // With real weekly data (trend_ci from export_monitoring.py) the chart
      // shows each week's measured rate with its 95% range instead of
      // overwriting the last bar with today's key-question figure (TASKS.md D3).
      const CI = Array.isArray(D.demo.trend_ci) && D.demo.trend_ci.length ? D.demo.trend_ci : null;
      const trend = CI ? CI.map(w => w.rate) : D.demo.trend.length ? D.demo.trend.slice(0, -1).concat([ctx.nowPct]) : [ctx.nowPct];
      const yMax = CI ? Math.max(60, ...CI.map(w => w.hi)) : 60;
      const noise = CI && CI.length > 1 && CORE.intervalsOverlap(CI[CI.length - 2], CI[CI.length - 1]);
      const bars = trend.map((v, i) => {
        const piece = pieces.find(p => p.week === i + 1);
        return '<div>' + (piece ? '<span class="mark">' + piece.mark + '</span>' : '') + '<span class="mono muted" style="font-size:11px">' + v + '%</span><div class="col" style="position:relative;height:' + Math.round(v / yMax * 160) + 'px;background:' + (i === trend.length - 1 ? C.accent : '#C9D6F7') + '">' +
          (CI ? '<span class="ci" style="bottom:' + Math.round((CI[i].lo - v) / yMax * 160) + 'px;height:' + Math.max(1, Math.round((CI[i].hi - CI[i].lo) / yMax * 160)) + 'px"></span>' : '') + '</div></div>';
      }).join('');
      const rows = pieces.map(p => {
        const ago = trend.length - p.week; const early = ago < 4;
        const qs = p.qs.map(id => { const q = QUESTIONS.find(x => x.id === id); return q ? q.text : id; }).join(' · ');
        return '<div class="row igrid"><span class="mark">' + p.mark + '</span><div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span>' + esc(p[state.lang]) + '</span><span class="small muted">' + esc(l.pieceMeta(l.ptypes[p.type], ago)) + '</span></div>' +
          '<span class="s13" style="color:#3A3D45">' + esc(qs) + '</span><span class="mono s14">' + p.before + '% → ' + p.after + '%</span>' +
          '<span class="s14" style="font-weight:600;color:' + (early ? C.faint : C.accent) + '">' + esc(early ? l.tooEarly : l.pp(p.after - p.before)) + '</span></div>';
      }).join('');
      return '<section style="gap:40px"><div class="head"><h1>' + esc(l.tabs.impact) + '</h1><p>' + esc(l.impSub) + '</p></div>' +
        '<div class="stats">' + stat(ctx.nowPct + '%', l.impStatNow) + stat(l.pp(ctx.nowPct - trend[0]), l.impStatDelta, C.accent) + stat(pieces.length, l.impStatCount) + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:16px"><h2>' + esc(l.impChart) + '</h2><span class="sr">' + esc(CI ? l.impCiAlt(CI) : l.impAlt(trend[0], ctx.nowPct)) + '</span>' + (noise ? '<span class="s13 muted">' + esc(l.impNoise) + '</span>' : '') +
        '<div class="chart" aria-hidden="true">' + bars + '</div><div class="xlabels" aria-hidden="true">' + trend.map((_, i) => '<span>' + (CI ? esc(CI[i].week.slice(5)) : l.week(i + 1)) + '</span>').join('') + '</div></div>' +
        '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px">' + esc(l.impPieces) + '</h2><div class="scroll"><div style="min-width:760px">' + (rows || (mode === 'own' ? ownHint('python monitoring/run.py --dry-run', l.impHint) : '<div class="muted" style="padding:16px 0">' + esc(l.noRows) + '</div>')) + '</div></div></div>' +
        '<span class="small muted">' + esc(l.impNote) + '</span></section>';
    }

    function placeholderBadge() {
      return '<span class="badge" style="background:#FBEBDD;color:#9A3412">' + esc(L().closeNow) + '</span>';
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
      const filtered = blocksNow.filter(b => (state.libCat === 'all' || b.tags.indexOf(state.libCat) !== -1) && (state.libType === 'all' || b.type === state.libType))
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
        '<div class="card"><div class="listhead" style="min-height:0"><h2>' + esc(l.addBlockTitle) + '</h2></div>' +
        '<label for="newblocktype" class="sr">' + esc(l.blockTypeLabel) + '</label><select id="newblocktype" ' + attr('change', e => { state.newBlockType = e.target.value; }) + '>' + typeOpts + '</select>' +
        '<label for="newblocktext" class="sr">' + esc(l.blockTextLabel) + '</label><textarea id="newblocktext" rows="2" style="min-height:44px;padding:10px 14px;border:1px solid var(--input);border-radius:6px;font:inherit;resize:vertical" placeholder="' + esc(l.blockTextPh) + '" ' + attr('input', e => { state.newBlockText = e.target.value; }) + '>' + esc(state.newBlockText) + '</textarea>' +
        '<div style="display:flex;flex-direction:column;gap:6px"><span class="s13 muted">' + esc(l.blockCatLabel) + '</span><div style="display:flex;flex-wrap:wrap;gap:6px">' + catPills + '</div></div>' +
        '<button class="btn" style="align-self:flex-start" ' + click(addBlock) + '>' + esc(l.saveBlock) + '</button>' +
        '<span class="small" style="color:' + (state.blockMsg ? '#1A3A9C' : C.muted) + '">' + esc(state.blockMsg ? l.msg[state.blockMsg] : l.blockFormHint) + '</span></div>' +
        importCard() +
        '<div style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #E6E4DE">' + catTabs + '</div><div style="display:flex;flex-wrap:wrap;gap:6px">' + typePills + '</div></div>' +
        (needsContent.length ? '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px;color:' + C.warn + '">' + esc(l.libNeedsContent) + ' (' + needsContent.length + ')</h2>' + needsContent.map(libraryRow).join('') + '</div>' : '') +
        '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px">' + esc(state.libCat === 'all' ? l.libReady : l.libRec(catLabel(state.libCat))) + '</h2>' +
        (ready.length ? ready.map(libraryRow).join('') : '<div class="muted" style="padding:16px 0">' + esc(l.noRows) + '</div>') + '</div></section>';
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
        '<span class="small" role="status" style="color:' + (state.importMsg && state.importMsg !== 'noCat' && state.importMsg !== 'none' && state.importMsg !== 'short' ? '#1A3A9C' : C.muted) + '">' + esc(msg) + '</span>' +
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
      set({ customBlocks: state.customBlocks.concat([b]), newBlockText: '', newBlockCats: [], blockMsg: 'blockSaved' });
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
        '<span class="s14" style="color:#3A3D45">' + esc(l.inventory(st.blocks.length, st.missing.map(m => l.types[m]))) + '</span>' +
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
        '<div class="col-score"><div style="padding-bottom:10px;border-bottom:1px solid #E6E4DE"><h2 style="font-size:15px">' + esc(l.scoreTitle) + '</h2></div>' +
        '<div style="display:flex;align-items:baseline;gap:8px"><span class="score" style="color:' + scoreColor + '">' + sc.score + '</span><span class="muted">/ 100</span></div>' +
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
      const done = () => { set({ copied: kind }); setTimeout(() => set({ copied: null }), 1500); };
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

      const curGroup = GROUP_OF[state.tab];
      const tabs = [tabBtn(l.tabs.overview, state.tab === 'overview', () => set({ tab: 'overview' }))]
        .concat(Object.keys(GROUPS).map(g => tabBtn(l.groups[g], curGroup === g, () => { if (curGroup !== g) set({ tab: GROUPS[g][0] }); })))
        .join('');
      const subnav = curGroup
        ? '<nav class="subtabs" style="margin-bottom:8px" aria-label="' + esc(l.groups[curGroup]) + '"><div style="display:flex;flex-wrap:wrap;gap:4px">' +
          GROUPS[curGroup].map(id => tabBtn(l.tabs[id], state.tab === id, () => set({ tab: id }))).join('') + '</div></nav>'
        : '';
      const isFreshOwn = mode === 'own' && allBlocksList().length === 0 && D.audit.length === 0 && D.pages.length === 0 && Object.keys(D.demo.results).length === 0;
      const views = {
        overview: isFreshOwn ? viewGettingStarted : viewOverview, questions: viewQuestions, sources: viewSources, website: viewWebsite, impact: viewImpact, library: viewLibrary,
        write: c => state.writeStep === 1 ? viewWriteBrief(c) : viewStudio(c)
      };
      document.documentElement.lang = state.lang;
      // One compact control instead of three separate ones: clicking your own
      // brand's button when it's already active reopens the setup editor,
      // instead of a dedicated extra "Edit setup" link next to it.
      const modeSwitch = '<div class="lang" role="group" aria-label="Mode">' +
        '<button class="' + (mode === 'demo' ? 'on' : '') + '" aria-pressed="' + (mode === 'demo') + '" ' + click(() => { if (mode !== 'demo') { mode = 'demo'; saveMode('demo'); boot(); } }) + '>' + esc(l.modeDemo) + '</button>' +
        '<button class="' + (mode === 'own' ? 'on' : '') + '" aria-pressed="' + (mode === 'own') + '" ' + click(() => {
          if (mode !== 'own') { mode = 'own'; saveMode('own'); if (own) boot(); else renderSetup(); } else { initSetupDraft(); renderSetup(); }
        }) + '>' + esc(own ? own.brand.short : l.modeOwn) + '</button></div>';
      root.innerHTML =
        '<a class="skip" href="#main">' + esc(state.lang === 'de' ? 'Zum Inhalt springen' : 'Skip to content') + '</a>' +
        '<header><div class="bar"><div class="brand"><b>' + esc(BRAND.short) + '</b><span class="s13 muted">GEO Engine</span></div>' +
        '<nav class="tabs" aria-label="' + esc(l.sections) + '">' + tabs + '</nav>' +
        '<div class="right">' + modeSwitch +
        '<div class="lang" role="group" aria-label="Language">' +
        '<button class="' + (state.lang === 'en' ? 'on' : '') + '" aria-pressed="' + (state.lang === 'en') + '" ' + click(() => set({ lang: 'en' })) + '>EN</button>' +
        '<button class="' + (state.lang === 'de' ? 'on' : '') + '" aria-pressed="' + (state.lang === 'de') + '" ' + click(() => set({ lang: 'de' })) + '>DE</button></div></div></div></header>' +
        '<main id="main" tabindex="-1">' + subnav + withH1(views[state.tab](ctx), l.tabs[state.tab]) + '</main>';

      restoreFocus(focusKey);
    }

    render();
  }

  // ---------- Boot dispatch ----------
  if (mode === null) { renderWelcome(); }
  else if (mode === 'own' && !own) { renderSetup(); }
  else { boot(); }
})();
