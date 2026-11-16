/*
 * GEO Engine – client-side dashboard.
 *
 * Pure static app: no build step, no framework, no network calls (enforced by
 * the CSP in index.html). Data comes from data.js, which is generated from the
 * JSON files in /data by scripts/build_web_data.py. User state (custom
 * questions, activations, drafts, audit checkmarks) lives in localStorage.
 */
'use strict';

(function () {
  const D = window.GEO_DATA;
  const CORE = window.GEO_CORE;
  const BRAND = D.brand;
  const STR = window.makeStrings(BRAND.short);
  const ENGINES = [{ id: 'claude', name: 'Claude' }, { id: 'gpt', name: 'ChatGPT' }, { id: 'gemini', name: 'Gemini' }];
  const TYPES = ['statement', 'definition', 'figure', 'case', 'quote', 'faq'];
  // Top-level nav is Overview + 2 groups, instead of 7 flat tabs: "Monitor" is
  // what the engines are doing (the read side), "Improve" is what to do about
  // it (the act side). Each group's children render as a second-level tab row.
  const GROUPS = { monitor: ['questions', 'sources', 'impact'], improve: ['website', 'library', 'write'] };
  const GROUP_OF = {};
  Object.keys(GROUPS).forEach(g => GROUPS[g].forEach(id => { GROUP_OF[id] = g; }));
  const TYPE_FG = { statement: '#1A3A9C', definition: '#3A3D45', figure: '#16181D', case: '#9A3412', quote: '#5B2A86', faq: '#1F5C55' };
  const C = { fg: '#16181D', muted: '#6B6F78', faint: '#9A9DA5', accent: '#1F4FD1', warn: '#C2410C', amber: '#B45309', border: '#CFCCC4' };
  const STORE_KEY = 'geo-engine:v1';

  // ---------- Data preparation ----------
  const CATS = D.categories.map(c => ({ id: c.id, kw: c.keywords }));
  const QUESTIONS = D.questions.map(q => {
    const res = D.demo.results[q.id];
    return { id: q.id, text: q.text, tags: q.categories, key: q.key, comp: res ? res.competitor : null, r: res ? CORE.parseResult(res.r) : null };
  });
  const BLOCKS = D.blocks.map(b => ({ id: b.id, type: b.type, tags: b.categories, de: b.text_de, en: b.text_en, source: b.source, placeholder: b.placeholder }));

  // ---------- Helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const overlaps = CORE.overlaps;
  const pct = CORE.pct;
  const kwHit = CORE.kwHit;

  // ---------- State ----------
  const saved = load();
  const state = Object.assign({
    lang: 'en', tab: 'overview', scope: 'key', onlyGaps: false, srcFilter: 'all',
    libCat: 'all', libType: 'all', writeStep: 1, allBlocks: false, selectedQ: 'q3',
    brief: '', newQ: '', newCat: 'ai', formMsg: '', copied: false,
    active: {}, custom: [], drafts: {}, auditDone: {}
  }, saved);
  let drag = null;

  function load() {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      const v = raw ? JSON.parse(raw) : {};
      return { lang: v.lang === 'de' ? 'de' : 'en', active: v.active || {},custom: Array.isArray(v.custom) ? v.custom : [], drafts: v.drafts || {}, auditDone: v.auditDone || {} };
    } catch (e) { return {}; }
  }
  function persist() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ lang: state.lang, active: state.active, custom: state.custom, drafts: state.drafts, auditDone: state.auditDone }));
    } catch (e) { /* storage unavailable – state stays in memory */ }
  }
  function set(patch) { Object.assign(state, patch); persist(); render(); }

  // ---------- Domain logic ----------
  const L = () => STR[state.lang];
  const catLabel = id => L().cats[id] || id;
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
    const blocks = BLOCKS.filter(b => b.tags.indexOf(catId) !== -1);
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

  // ---------- Event wiring ----------
  // Handlers are registered during render and referenced via data-on-<event>.
  let handlers = [];
  const on = fn => { handlers.push(fn); return handlers.length - 1; };
  const attr = (evt, fn) => 'data-on-' + evt + '="' + on(fn) + '"';
  const click = fn => attr('click', fn);

  const root = document.getElementById('app');
  ['click', 'change', 'input', 'dragstart', 'dragend', 'dragover', 'dragleave', 'drop', 'keydown'].forEach(evt => {
    root.addEventListener(evt, e => {
      const el = e.target.closest('[data-on-' + evt + ']');
      if (!el || !root.contains(el)) return;
      const fn = handlers[+el.getAttribute('data-on-' + evt)];
      if (fn) fn(e, el);
    });
  });

  // ---------- Render helpers ----------
  const tabBtn = (label, on_, fn) => '<button class="tab' + (on_ ? ' on' : '') + '" ' + click(fn) + '>' + esc(label) + '</button>';
  const stat = (n, l, color, big) => '<div class="stat"><span class="n' + (big ? ' big' : '') + '"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(n) + '</span><span class="l">' + esc(l) + '</span></div>';
  const track = (w, color) => '<div class="track"><div style="width:' + Math.max(0, Math.min(100, w)) + '%;' + (color ? 'background:' + color : '') + '"></div></div>';
  function dot(st) {
    const l = L();
    const p = st.p ? '#' + st.p : '';
    const m = {
      cited: [C.accent, C.accent, l.dot.cited, p], mentioned: ['#fff', C.accent, l.dot.mentioned, p],
      absent: [C.warn, C.warn, l.dot.absent, ''], notrun: ['#fff', C.border, l.dot.notrun, ''],
      inactive: ['#fff', '#E6E4DE', l.dot.inactive, '']
    }[st.k];
    return '<span class="cell"><span class="dot" title="' + esc(m[2]) + '" style="background:' + m[0] + ';border-color:' + m[1] + '"></span>' +
      '<span class="mono small muted">' + esc(m[3]) + '</span><span class="sr">' + esc(m[2]) + '</span></span>';
  }

  // ---------- Views ----------
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
      '<div class="split"><div class="main"><div class="listhead"><h2>' + esc(l.biggestGaps) + '</h2><button class="link" ' + click(() => set({ tab: 'questions' })) + '>' + esc(l.allQuestions) + '</button></div>' + gaps + '</div>' +
      '<div class="side"><div class="listhead" style="align-items:flex-end"><h2>' + esc(l.visByTopic) + '</h2></div>' + bars + '</div></div>' +
      '<div class="callout"><div style="display:flex;flex-direction:column;gap:2px"><span class="s13 muted">' + esc(l.recToday) + '</span><span style="font-size:18px;font-weight:500">' + esc(l.teaser(catLabel(top.c.id), top.st.gapQs.length)) + '</span></div>' +
      '<button class="btn" ' + click(() => set({ tab: 'write', writeStep: 1, brief: '' })) + '>' + esc(l.writeCta) + '</button></div></section>';
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
      return '<div class="row"><div class="qgrid">' +
        '<input type="checkbox"' + (act ? ' checked' : '') + ' aria-label="' + esc((act ? l.ariaOff : l.ariaOn) + q.text) + '" ' + attr('change', () => toggleActive(q)) + '>' +
        '<div style="display:flex;flex-direction:column;gap:1px;min-width:0"><span style="color:' + (act ? C.fg : '#8A8E98') + '">' + esc(q.text) + '</span><span class="small muted">' + esc(meta) + '</span></div>' +
        ENGINES.map(e => dot(status(q, e.id))).join('') +
        '<div style="display:flex;justify-content:flex-end"><button class="btn sm ' + cls + '"' + (fn ? ' ' + click(fn) : ' disabled') + '>' + esc(label) + '</button></div>' +
        '</div></div>';
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
      '<span><span class="dot" style="background:#fff;border-color:' + C.border + '"></span>' + esc(l.noData) + '</span>' +
      '<span>' + esc(l.legendNote) + '</span></div></section>';
  }

  function toggleActive(q) { const a = Object.assign({}, state.active); a[q.id] = !isActive(q); set({ active: a }); }
  function addQuestion() {
    const text = state.newQ.trim();
    if (text.length < 8) { set({ formMsg: 'short' }); return; }
    const q = { id: 'c' + Date.now().toString(36), text: text.slice(0, 300), tags: [state.newCat], key: false, custom: true, createdAt: new Date().toISOString() };
    set({ custom: state.custom.concat([q]), newQ: '', scope: 'custom', onlyGaps: false, formMsg: 'saved' });
  }

  function viewSources() {
    const l = L(); const S = D.demo.cited_sources;
    const max = Math.max.apply(null, S.map(c => c.cites));
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
      '<div class="scroll"><div style="min-width:820px"><div class="sgrid small muted" style="padding:0 0 8px"><span>' + esc(l.colSource) + '</span><span>' + esc(l.colType) + '</span><span>' + esc(l.colCites) + '</span><span>' + esc(l.colPresent) + '</span><span>' + esc(l.colNext) + '</span></div>' + rows + '</div></div>' +
      '<span class="small muted">' + esc(l.srcNote) + '</span></section>';
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
    const avg = Math.round(P.reduce((x, g) => x + g.score, 0) / P.length);
    return '<section style="gap:40px"><div class="head"><h1>' + esc(l.webTitle) + '</h1><p>' + esc(l.webSub(meta.date, meta.pages, meta.posts)) + '</p></div>' +
      '<div class="stats">' + stat(meta.pages + meta.posts, l.webStatPages) + stat(A.filter(a => a.priority === 'high' && !state.auditDone[a.id]).length, l.webStatHigh, C.warn) + stat(avg, l.webStatAvg) + stat(A.filter(a => state.auditDone[a.id]).length + '/' + A.length, l.webStatDone, C.accent) + '</div>' +
      '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px">' + esc(l.webActions) + '</h2>' + rows + '</div>' +
      '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:4px">' + esc(l.webPages) + '</h2><p class="s13 muted" style="margin:0 0 12px">' + esc(l.webPagesSub) + '</p><div class="scroll"><div style="min-width:760px">' + pages + '</div></div></div>' +
      '<span class="small muted">' + esc(l.webNote) + '</span></section>';
  }

  function viewImpact(ctx) {
    const l = L(); const pieces = D.demo.pieces;
    const trend = D.demo.trend.slice(0, -1).concat([ctx.nowPct]);
    const bars = trend.map((v, i) => {
      const piece = pieces.find(p => p.week === i + 1);
      return '<div>' + (piece ? '<span class="mark">' + piece.mark + '</span>' : '') + '<span class="mono muted" style="font-size:11px">' + v + '%</span><div class="col" style="height:' + Math.round(v / 60 * 160) + 'px;background:' + (i === trend.length - 1 ? C.accent : '#C9D6F7') + '"></div></div>';
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
      '<div style="display:flex;flex-direction:column;gap:16px"><h2>' + esc(l.impChart) + '</h2><span class="sr">' + esc(l.impAlt(trend[0], ctx.nowPct)) + '</span>' +
      '<div class="chart" aria-hidden="true">' + bars + '</div><div class="xlabels" aria-hidden="true">' + trend.map((_, i) => '<span>' + l.week(i + 1) + '</span>').join('') + '</div></div>' +
      '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px">' + esc(l.impPieces) + '</h2><div class="scroll"><div style="min-width:760px">' + rows + '</div></div></div>' +
      '<span class="small muted">' + esc(l.impNote) + '</span></section>';
  }

  function viewLibrary(ctx) {
    const l = L();
    const coverage = b => ctx.gapQs.filter(q => overlaps(b.tags, q.tags)).length;
    const catTabs = [{ id: 'all' }].concat(CATS).map(c => tabBtn(c.id === 'all' ? l.all : catLabel(c.id), state.libCat === c.id, () => set({ libCat: c.id }))).join('');
    const typePills = ['all'].concat(TYPES).map(t => '<button class="pill' + (state.libType === t ? ' on' : '') + '" ' + click(() => set({ libType: t })) + '>' + esc(t === 'all' ? l.all : l.types[t]) + '</button>').join('');
    const list = BLOCKS.filter(b => (state.libCat === 'all' || b.tags.indexOf(state.libCat) !== -1) && (state.libType === 'all' || b.type === state.libType))
      .map(b => ({ b, cov: coverage(b) }))
      .sort((x, y) => (y.cov - x.cov) || (TYPES.indexOf(x.b.type) - TYPES.indexOf(y.b.type)))
      .map(o => '<div class="row lgrid"><span class="mono small" style="color:' + TYPE_FG[o.b.type] + '">' + esc(l.types[o.b.type]) + '</span>' +
        '<div style="display:flex;flex-direction:column;gap:4px;min-width:0"><span>' + esc(blockText(o.b)) + '</span><span class="small muted">' + esc(o.b.source ? BRAND.domain + o.b.source : '[placeholder]') + '</span></div>' +
        '<span class="s13" style="text-align:right;color:' + (o.cov ? C.warn : C.faint) + '">' + esc(o.cov ? l.openQs(o.cov) : '–') + '</span></div>').join('');
    const withSource = BLOCKS.filter(b => !b.placeholder).length;
    return '<section><div class="head"><h1>' + esc(l.tabs.library) + '</h1><p>' + esc(l.libSub(BLOCKS.length, withSource)) + '</p></div>' +
      '<div style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #E6E4DE">' + catTabs + '</div><div style="display:flex;flex-wrap:wrap;gap:6px">' + typePills + '</div></div>' +
      '<div style="display:flex;flex-direction:column"><h2 style="margin-bottom:8px">' + esc(state.libCat === 'all' ? l.libAll : l.libRec(catLabel(state.libCat))) + '</h2>' + list + '</div></section>';
  }

  function viewWriteBrief(ctx) {
    const l = L();
    const ranked = ctx.ranked;
    const briefText = ' ' + state.brief.toLowerCase().trim() + ' ';
    let mode = 'default', pick = ranked[0];
    if (state.brief.trim()) {
      const scored = CATS.map(c => ({ c, hits: c.kw.filter(k => kwHit(briefText, k)).length, st: catStats(c.id) })).filter(x => x.hits > 0)
        .sort((a, b) => (b.hits - a.hits) || (b.st.weight - a.st.weight));
      if (scored.length) { mode = 'match'; pick = scored[0]; } else { mode = 'nomatch'; }
    }
    const st = pick.st;
    const reason = st.gapQs.length === 0 ? l.reasonNone : l.reason(st.gapQs.length, st.keyGaps, st.absent, st.answers, mode === 'default');
    const firstQ = st.gapQs[0] || st.qs[0];
    const qs = st.gapQs.slice(0, 4).map(q => '<button class="recq" ' + click(() => openDraft(q.id)) + '><span>' + esc(q.text) + '</span><span class="small warn" style="white-space:nowrap">' + esc(l.missingShort(absentCount(q))) + ' →</span></button>').join('');
    return '<section class="brief"><div style="display:flex;flex-direction:column;gap:14px"><label for="brief">' + esc(l.writeQ) + '</label>' +
      '<input id="brief" type="text" maxlength="200" value="' + esc(state.brief) + '" placeholder="' + esc(l.briefPh) + '" ' + attr('input', e => set({ brief: e.target.value })) + '>' +
      '<span class="s13 muted">' + esc(l.briefHint) + '</span></div>' +
      '<div class="card"><div style="display:flex;flex-direction:column;gap:4px"><span class="s13" style="color:' + (mode === 'nomatch' ? C.warn : C.muted) + '">' + esc(mode === 'match' ? l.kMatch : mode === 'nomatch' ? l.kNo : l.kDefault) + '</span><span style="font-size:24px;font-weight:500">' + esc(catLabel(pick.c.id)) + '</span></div>' +
      '<div style="display:flex;flex-direction:column;gap:4px"><span class="s13" style="font-weight:600">' + esc(l.why) + '</span><span>' + esc(reason) + '</span></div>' +
      (qs ? '<div style="display:flex;flex-direction:column"><span class="s13" style="font-weight:600;margin-bottom:6px">' + esc(l.closesGaps) + '</span>' + qs + '</div>' : '') +
      '<span class="s14" style="color:#3A3D45">' + esc(l.inventory(st.blocks.length, st.missing.map(m => l.types[m]))) + '</span>' +
      '<button class="btn" style="align-self:flex-start" ' + click(() => openDraft(firstQ ? firstQ.id : state.selectedQ)) + '>' + esc(l.startDraft) + '</button></div></section>';
  }

  function viewStudio() {
    const l = L();
    const sel = allQ().find(q => q.id === state.selectedQ) || QUESTIONS[0];
    const rel = b => b.tags.filter(t => sel.tags.indexOf(t) !== -1).length / sel.tags.length;
    const ids = state.drafts[sel.id] || [];
    const draftBlocks = ids.map(id => BLOCKS.find(b => b.id === id)).filter(Boolean);
    const n = draftBlocks.length;

    const sugg = BLOCKS.map(b => ({ b, r: rel(b) })).filter(o => state.allBlocks || o.r > 0).sort((x, y) => y.r - x.r).map(o => {
      const b = o.b; const used = ids.indexOf(b.id) !== -1;
      return '<div class="sugg' + (used ? ' used' : '') + '" draggable="true" ' + attr('dragstart', e => { drag = { kind: 'lib', id: b.id }; try { e.dataTransfer.setData('text/plain', b.id); e.dataTransfer.effectAllowed = 'copyMove'; } catch (err) { /* ignore */ } }) + ' ' + attr('dragend', clearDrag) + '>' +
        '<div class="small" style="display:flex;justify-content:space-between;gap:8px"><span class="mono" style="color:' + TYPE_FG[b.type] + '">' + esc(l.types[b.type]) + '</span><span class="muted">' + esc(o.r > 0 ? l.rel(Math.round(o.r * 100)) : l.relLow) + '</span></div>' +
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
      '<div class="studio"><div class="col-lib"><div class="listhead" style="min-height:0;padding-bottom:10px"><h2 style="font-size:15px">' + esc(l.matchingBlocks) + '</h2><button class="link s13" ' + click(() => set({ allBlocks: !state.allBlocks })) + '>' + esc(state.allBlocks ? l.onlyMatching : l.showAll) + '</button></div><div class="libscroll">' + sugg + '</div></div>' +
      '<div class="col-draft"><div class="listhead" style="min-height:0;padding-bottom:10px"><h2 style="font-size:15px">' + esc(l.draftTitle) + '</h2><span class="s13 muted">' + esc(l.blocksN(n)) + '</span></div>' +
      '<div style="display:flex;flex-direction:column;padding-top:8px">' + draft +
      '<div class="dropzone" style="min-height:' + (n === 0 ? 240 : 56) + 'px" ' + attr('dragover', (e, el) => { e.preventDefault(); markOver(el); }) + ' ' + attr('dragleave', (e, el) => el.classList.remove('over')) + ' ' + attr('drop', e => { e.preventDefault(); dropAt(n); }) + '>' + esc(n === 0 ? l.dropEmpty : l.dropHere) + '</div>' +
      (n ? '<div class="actions-row" style="margin-top:12px"><button class="btn sm plain" ' + click(() => copyDraft(draftBlocks)) + '>' + esc(state.copied ? l.copied : l.copy) + '</button></div>' : '') +
      '</div></div>' +
      '<div class="col-score"><div style="padding-bottom:10px;border-bottom:1px solid #E6E4DE"><h2 style="font-size:15px">' + esc(l.scoreTitle) + '</h2></div>' +
      '<div style="display:flex;align-items:baseline;gap:8px"><span class="score" style="color:' + scoreColor + '">' + sc.score + '</span><span class="muted">/ 100</span></div>' +
      '<span style="font-weight:500;color:' + scoreColor + '">' + esc(verdict) + '</span><div style="display:flex;flex-direction:column;gap:10px">' + crit + '</div>' +
      (ph ? '<span class="s13 warn">' + esc(l.ph(ph)) + '</span>' : '') + '</div></div></section>';
  }

  function markOver(el) {
    root.querySelectorAll('.over').forEach(x => { if (x !== el) x.classList.remove('over'); });
    el.classList.add('over');
  }
  function clearDrag() { drag = null; root.querySelectorAll('.over').forEach(x => x.classList.remove('over')); }
  function copyDraft(blocks) {
    const text = blocks.map(blockText).join('\n\n');
    const done = () => { set({ copied: true }); setTimeout(() => set({ copied: false }), 1500); };
    try { navigator.clipboard.writeText(text).then(done, () => {}); } catch (e) { /* clipboard unavailable */ }
  }

  // ---------- Root render ----------
  function render() {
    // Keep focus and caret on text inputs across re-renders.
    const focused = document.activeElement && document.activeElement.id;
    const caret = focused && document.activeElement.selectionStart;
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
    const views = {
      overview: viewOverview, questions: viewQuestions, sources: viewSources, website: viewWebsite, impact: viewImpact, library: viewLibrary,
      write: c => state.writeStep === 1 ? viewWriteBrief(c) : viewStudio(c)
    };
    document.documentElement.lang = state.lang;
    root.innerHTML =
      '<header><div class="bar"><div class="brand"><b>' + esc(BRAND.short) + '</b><span class="s13 muted">GEO Engine</span></div>' +
      '<nav class="tabs" aria-label="' + esc(l.sections) + '">' + tabs + '</nav>' +
      '<div class="right"><span class="small muted">' + esc(l.demo) + '</span><div class="lang" role="group" aria-label="Language">' +
      '<button class="' + (state.lang === 'en' ? 'on' : '') + '" aria-pressed="' + (state.lang === 'en') + '" ' + click(() => set({ lang: 'en' })) + '>EN</button>' +
      '<button class="' + (state.lang === 'de' ? 'on' : '') + '" aria-pressed="' + (state.lang === 'de') + '" ' + click(() => set({ lang: 'de' })) + '>DE</button></div></div></div></header>' +
      '<main>' + subnav + views[state.tab](ctx) + '</main>';

    if (focused) {
      const el = document.getElementById(focused);
      if (el) { el.focus(); if (typeof caret === 'number' && el.setSelectionRange) el.setSelectionRange(caret, caret); }
    }
  }

  render();
})();
