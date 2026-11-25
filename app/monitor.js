/*
 * GEO Engine in-browser monitoring: ask the AI assistants straight from the
 * visitor's browser, with the visitor's own API keys.
 *
 * The browser counterpart of monitoring/run.py + mention_detection.py +
 * scripts/export_monitoring.py, kept to the same rules so a run started here
 * and one started on GitHub give the same results. Keys go only to the
 * provider's own API (the page's CSP allows exactly those three hosts) and
 * are never written anywhere else.
 *
 * Loaded as a plain <script> (window.GEO_MONITOR) and as a CommonJS module
 * under Node for tests (tests/monitor.test.js). The network part takes a
 * fetch function as a parameter, so tests run without any network.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.GEO_MONITOR = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ENGINE_ORDER = ['claude', 'gpt', 'gemini'];
  const MAX_ANSWER_CHARS = 6000;
  const KNOWN_KINDS = { 'wikipedia.org': 'wiki', 'linkedin.com': 'social', 'reddit.com': 'community', 'twitter.com': 'social', 'x.com': 'social' };

  // ---------- Mention detection (same rules as mention_detection.py) ----------
  const normalize = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, ' ').trim();
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function findFirstMention(text, name) {
    const n = normalize(name);
    if (!n) return null;
    const m = new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRe(n) + '(?![\\p{L}\\p{N}_])', 'u').exec(normalize(text));
    return m ? m.index : null;
  }
  // { mentioned, position (1-based rank among named providers), providers }
  function detectMention(text, brandAliases, competitors) {
    const hits = [];
    let brand = null;
    (brandAliases || []).forEach(a => { const i = findFirstMention(text, a); if (i !== null && (brand === null || i < brand)) brand = i; });
    if (brand !== null) hits.push(['__brand__', brand]);
    (competitors || []).forEach(c => { const i = findFirstMention(text, c); if (i !== null) hits.push([c, i]); });
    hits.sort((a, b) => a[1] - b[1]);
    const names = hits.map(h => h[0]);
    if (brand === null) return { mentioned: false, position: null, providers: names };
    return { mentioned: true, position: names.indexOf('__brand__') + 1, providers: names.map(n => n === '__brand__' ? '(brand)' : n) };
  }
  function normalizeDomain(url) {
    try {
      const u = new URL(/\/\//.test(url) ? url : 'https://' + url);
      return u.hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) { return ''; }
  }
  const normalizeDomains = urls => [...new Set((urls || []).map(normalizeDomain).filter(Boolean))];

  // ---------- Provider requests and responses ----------
  // request(engine, cfg, prompt, key) -> { url, init } for fetch().
  function request(engine, cfg, prompt, key) {
    const json = body => JSON.stringify(body);
    if (engine === 'claude') {
      const body = { model: cfg.model, max_tokens: cfg.max_tokens || 1024, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] };
      if (cfg.max_searches > 0) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: cfg.max_searches }];
      return { url: 'https://api.anthropic.com/v1/messages', init: { method: 'POST', body: json(body), headers: {
        'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
        // Anthropic requires this opt-in for calls made from a browser.
        'anthropic-dangerous-direct-browser-access': 'true' } } };
    }
    if (engine === 'gemini') {
      const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
      if (cfg.grounding) body.tools = [{ google_search: {} }];
      return { url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(cfg.model) + ':generateContent',
        init: { method: 'POST', body: json(body), headers: { 'content-type': 'application/json', 'x-goog-api-key': key } } };
    }
    if (engine === 'gpt') {
      const body = { model: cfg.model, input: prompt, tools: [{ type: 'web_search' }], reasoning: { effort: cfg.reasoning_effort || 'low' } };
      return { url: 'https://api.openai.com/v1/responses', init: { method: 'POST', body: json(body), headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + key } } };
    }
    throw new Error('Unknown engine ' + engine);
  }
  // parse(engine, responseJson) -> { answer_text, cited_urls }
  function parse(engine, r) {
    if (engine === 'claude') {
      const blocks = r.content || [];
      return {
        answer_text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
        cited_urls: blocks.filter(b => b.type === 'web_search_tool_result' && Array.isArray(b.content))
          .flatMap(b => b.content.filter(x => x.type === 'web_search_result' && x.url).map(x => x.url)),
      };
    }
    if (engine === 'gemini') {
      const c = (r.candidates || [])[0] || {};
      return {
        answer_text: ((c.content && c.content.parts) || []).map(p => p.text || '').join(''),
        cited_urls: (((c.groundingMetadata || {}).groundingChunks) || []).map(g => g.web && g.web.uri).filter(Boolean),
      };
    }
    if (engine === 'gpt') {
      const parts = (r.output || []).filter(o => o.type === 'message').flatMap(o => o.content || []).filter(c => c.type === 'output_text');
      return {
        answer_text: parts.map(p => p.text).join(''),
        cited_urls: parts.flatMap(p => (p.annotations || []).filter(a => a.type === 'url_citation' && a.url).map(a => a.url)),
      };
    }
    throw new Error('Unknown engine ' + engine);
  }

  // Same transient rules as run.py: overload, 5xx, timeouts are retried.
  const TRANSIENT_STATUS = [500, 502, 503, 504, 529];
  const TRANSIENT_WORDS = ['overloaded', 'high demand', 'service_unavailable', 'unavailable', 'timed out', 'timeout'];
  const RETRY_WAITS = [10, 30];
  const REQUEST_TIMEOUT_MS = 120000;
  function isTransient(err) {
    if (err && TRANSIENT_STATUS.indexOf(err.status) !== -1) return true;
    const t = String((err && err.message) || err).toLowerCase();
    return TRANSIENT_WORDS.some(w => t.indexOf(w) !== -1);
  }
  // Error with the provider's own message and the HTTP status. A 401/403 means
  // the key is wrong, which the UI turns into a plain-language hint.
  async function callOnce(engine, cfg, prompt, key, fetchFn) {
    const req = request(engine, cfg, prompt, key);
    let res;
    try { res = await fetchFn(req.url, req.init); } catch (e) {
      const err = new Error('Network error: ' + (e && e.message ? e.message : e)); err.status = 0; throw err;
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* non-JSON error page */ }
    if (!res.ok) {
      const msg = body && body.error ? (body.error.message || JSON.stringify(body.error)) : 'HTTP ' + res.status;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return parse(engine, body || {});
  }
  async function callEngine(engine, cfg, prompt, key, opts) {
    const o = Object.assign({ fetch: (u, i) => fetch(u, i), sleep: s => new Promise(r => setTimeout(r, s * 1000)), onRetry: null, signal: null, timeoutMs: REQUEST_TIMEOUT_MS }, opts);
    for (let attempt = 0; ; attempt++) {
      // A provider that never answers would otherwise keep the page waiting
      // forever. A timeout counts as temporary, so it is retried like a 503.
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      let timer;
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          if (ac) ac.abort();
          const e = new Error('Request timed out after ' + Math.round(o.timeoutMs / 1000) + ' s'); e.status = 0; reject(e);
        }, o.timeoutMs);
      });
      const fetchFn = (u, i) => o.fetch(u, ac ? Object.assign({}, i, { signal: ac.signal }) : i);
      try { return await Promise.race([callOnce(engine, cfg, prompt, key, fetchFn), timeout]); } catch (err) {
        if (attempt >= RETRY_WAITS.length || !isTransient(err) || (o.signal && o.signal.aborted)) throw err;
        if (o.onRetry) o.onRetry(err, RETRY_WAITS[attempt]);
        await o.sleep(RETRY_WAITS[attempt]);
      } finally { clearTimeout(timer); }
    }
  }

  // One stored answer, in the same shape as a runs.sqlite row.
  function makeRow(question, engine, model, prompt, answer, brandAliases, competitors, when) {
    const m = detectMention(answer.answer_text, brandAliases, competitors);
    return {
      question_id: question.id, engine, model, timestamp: (when || new Date()).toISOString(),
      mentioned: m.mentioned ? 1 : 0, position: m.position, cited_urls: normalizeDomains(answer.cited_urls),
      answer_text: answer.answer_text, variant: 0, question_text: prompt,
    };
  }

  // ---------- Rows -> what the app shows (same as export_monitoring.py) ----------
  function wilson(k, n, z) {
    z = z || 1.96;
    if (!n) return [0, 0];
    const p = k / n, d = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / d;
    const h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)];
  }
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const y = d.getUTCFullYear();
    const w = Math.ceil(((d - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
    return y + '-W' + String(w).padStart(2, '0');
  }
  function buildTrend(rows) {
    const weeks = {};
    rows.forEach(r => { const w = isoWeek(new Date(r.timestamp)); weeks[w] = weeks[w] || [0, 0]; weeks[w][0] += r.mentioned ? 1 : 0; weeks[w][1]++; });
    return Object.keys(weeks).sort().map(w => {
      const [k, n] = weeks[w]; const [lo, hi] = wilson(k, n);
      return { week: w, n, k, rate: Math.round(100 * k / n), lo: Math.round(100 * lo), hi: Math.round(100 * hi) };
    });
  }
  const engineIdx = e => { const i = ENGINE_ORDER.indexOf(e); return i === -1 ? 9 : i; };
  function latestBy(rows, keyFn) {
    const out = {};
    rows.forEach(r => { const k = keyFn(r); if (!out[k] || r.timestamp > out[k].timestamp) out[k] = r; });
    return out;
  }
  function buildResults(rows, ownDomain, brandAliases, competitors) {
    const latest = latestBy(rows.filter(r => !r.variant), r => r.question_id + '|' + r.engine);
    const qids = [...new Set(Object.values(latest).map(r => r.question_id))].sort();
    const out = {};
    qids.forEach(qid => {
      const codes = ENGINE_ORDER.map(e => {
        const r = latest[qid + '|' + e];
        if (!r) return 'n';
        if (!r.mentioned) return 'a';
        const cited = !!ownDomain && r.cited_urls.some(u => u.indexOf(ownDomain) !== -1);
        return (cited ? 'c' : 'm') + r.position;
      });
      let comp = null;
      ENGINE_ORDER.some(e => {
        const r = latest[qid + '|' + e];
        if (!r) return false;
        const named = detectMention(r.answer_text, brandAliases, competitors).providers.filter(n => n !== '(brand)');
        if (named.length) { comp = named[0]; return true; }
        return false;
      });
      out[qid] = { competitor: comp, r: codes.join(' ') };
    });
    return out;
  }
  function buildAnswers(rows) {
    const latest = latestBy(rows, r => r.question_id + '|' + r.engine + '|' + (r.variant || 0));
    const out = {};
    Object.values(latest).sort((a, b) => a.question_id.localeCompare(b.question_id) || (a.variant || 0) - (b.variant || 0) || engineIdx(a.engine) - engineIdx(b.engine))
      .forEach(r => {
        (out[r.question_id] = out[r.question_id] || []).push({
          engine: r.engine, variant: r.variant || 0, model: r.model, date: r.timestamp.slice(0, 10), prompt: r.question_text,
          text: r.answer_text.length > MAX_ANSWER_CHARS ? r.answer_text.slice(0, MAX_ANSWER_CHARS) + '…' : r.answer_text,
        });
      });
    return out;
  }
  function buildCitedSources(rows) {
    const per = {};
    rows.forEach(r => r.cited_urls.forEach(d => {
      if (!d) return;
      per[d] = per[d] || { cites: 0, qs: new Set() };
      per[d].cites++; per[d].qs.add(r.question_id);
    }));
    return Object.keys(per).map(d => ({ name: d, kind: KNOWN_KINDS[d] || 'portal', cites: per[d].cites, qs: per[d].qs.size, present: null, act: 'analyze' }))
      .sort((a, b) => b.cites - a.cites);
  }
  // Everything the app's monitoring views read, from stored rows.
  function summarize(rows, brand, competitors) {
    const trend = buildTrend(rows);
    return {
      results: buildResults(rows, brand.domain || '', brand.aliases || [], competitors || []),
      cited_sources: buildCitedSources(rows),
      trend: trend.map(w => w.rate),
      trend_ci: trend,
      answers: buildAnswers(rows),
      competitors: competitors || [],
    };
  }

  // ---------- Onboarding: personas first, then their questions ----------
  // Who asks matters: a Bavarian farmer asks in German, an investor maybe in
  // English. So the guide first suggests personas (each with the language it
  // would ask in), then questions per persona in that language. Both prompts
  // ask for JSON only; answers are parsed defensively because models sometimes
  // wrap them in prose or code fences.
  const LANG_NAMES = { de: 'German', en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', sv: 'Swedish', da: 'Danish', cs: 'Czech', tr: 'Turkish' };
  const langName = code => LANG_NAMES[code] || code;
  function jsonFrom(text) {
    const t = String(text || '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }
  const str = (x, n) => typeof x === 'string' ? x.trim().slice(0, n || 300) : '';
  const langCode = x => { const c = str(x, 12).toLowerCase().slice(0, 2); return /^[a-z]{2}$/.test(c) ? c : ''; };

  function personaPrompt(c, lang) {
    const where = c.where ? ' in ' + c.where : '';
    return [
      'A company wants to see how AI assistants like ChatGPT talk about it.',
      'Company: ' + c.name + (c.website ? ' (' + c.website + ')' : '') + '. It offers: ' + c.offer + where + '.',
      'Reply with JSON only, no other text, in this shape:',
      '{"personas":[{"name":"...","who":"...","language":"de"}],"topics":[{"label":"...","keywords":["..."]}],"competitors":["..."]}',
      'personas: 2 to 4 kinds of people who would ask an AI assistant about what this company offers (customers, partners, investors, ...). "name": 2 to 5 words. "who": one short sentence. "language": the ISO 639-1 code of the language this persona would most likely type in, given where they are.',
      'topics: 2 to 4 short topic names for what the company offers, each with 3 to 6 lowercase keywords.',
      'competitors: up to 6 real companies that offer the same' + where + '. Names only. Leave the list empty if you are not sure they exist.',
      'Write "name", "who" and the topics in ' + langName(lang) + '.',
    ].join('\n');
  }
  function parsePersonas(text) {
    const j = jsonFrom(text);
    if (!j) return null;
    const seen = new Set();
    const personas = (Array.isArray(j.personas) ? j.personas : []).map(x => ({ name: str(x && x.name, 60), who: str(x && x.who, 200), lang: langCode(x && x.language) || 'en' }))
      .filter(x => x.name && !seen.has(x.name.toLowerCase()) && seen.add(x.name.toLowerCase())).slice(0, 5)
      .map((x, i) => Object.assign({ id: 'p' + (i + 1) }, x));
    const topics = (Array.isArray(j.topics) ? j.topics : []).map(x => ({ label: str(x && x.label, 60), keywords: (Array.isArray(x && x.keywords) ? x.keywords : []).map(k => str(k, 40)).filter(Boolean).slice(0, 8) }))
      .filter(x => x.label).slice(0, 5);
    const competitors = [...new Set((Array.isArray(j.competitors) ? j.competitors : []).map(x => str(x, 60)).filter(Boolean))].slice(0, 8);
    if (!personas.length) return null;
    return { personas, topics, competitors };
  }
  function questionsPrompt(c, personas, topics) {
    const where = c.where ? ' in ' + c.where : '';
    return [
      'A company wants to see how AI assistants like ChatGPT talk about it.',
      'Company: ' + c.name + (c.website ? ' (' + c.website + ')' : '') + '. It offers: ' + c.offer + where + '.',
      'Its topics: ' + ((topics || []).map(t => t.label).join('; ') || c.offer) + '.',
      'People who ask about it (id: who, language):',
      personas.map(p => '- ' + p.id + ': ' + p.name + (p.who ? ' (' + p.who + ')' : '') + ', writes in ' + langName(p.lang)).join('\n'),
      'Write 3 to 5 questions per person that they would type into ChatGPT when looking for such a provider or information. Write each question in that person\'s language, the way they would really ask. Do not name ' + c.name + ' in them.',
      'Reply with JSON only, no other text, in this shape:',
      '{"questions":[{"text":"...","persona":"p1","topic":"..."}]}',
      '"persona" is the person\'s id, "topic" one of the topics above.',
    ].join('\n');
  }
  function parseQuestions(text, personas) {
    const j = jsonFrom(text);
    if (!j) return null;
    const byId = {}; (personas || []).forEach(p => { byId[p.id] = p; });
    const seen = new Set();
    const questions = (Array.isArray(j.questions) ? j.questions : []).map(x => {
      const p = byId[str(x && x.persona, 12)] || (personas || [])[0] || null;
      return { text: str(x && x.text), topic: str(x && x.topic, 60), persona: p ? p.id : null, lang: p ? p.lang : '' };
    }).filter(x => x.text.length >= 8 && !seen.has(normalize(x.text)) && seen.add(normalize(x.text))).slice(0, 25);
    return questions.length ? questions : null;
  }
  // Without an AI: one plain persona in the interface language.
  function templatePersonas(lang) {
    return [{ id: 'p1', name: lang === 'de' ? 'Kunden' : 'Customers', who: '', lang: lang === 'de' ? 'de' : 'en' }];
  }
  // Without an AI: plain questions from what the person typed.
  function templateQuestions(c, lang) {
    const o = c.offer, w = c.where ? ' in ' + c.where : '';
    return (lang === 'de' ? [
      'Wer sind die besten Anbieter für ' + o + w + '?', 'Welchen Anbieter für ' + o + w + ' kannst du empfehlen?',
      'Worauf sollte ich bei ' + o + ' achten?', 'Was kostet ' + o + w + '?', 'Welche Firmen sind bekannt für ' + o + '?',
    ] : [
      'Who are the best providers of ' + o + w + '?', 'Which ' + o + ' company would you recommend' + w + '?',
      'What should I look for when choosing ' + o + '?', 'How much does ' + o + ' cost' + w + '?', 'Which companies are known for ' + o + '?',
    ]).map(text => ({ text, topic: o }));
  }

  // ---------- Radar: a horizon scan for questions that are starting to come up ----------
  // Strategic foresight in one request: look for change (technology, market,
  // society, regulation, environment), name the observable signal, and sort
  // each future question into a horizon. The answer is the AI's judgement, not
  // measured data; the app says so and lets monitoring check it later.
  const DRIVERS = ['technology', 'market', 'society', 'regulation', 'environment'];
  const HORIZONS = ['now', 'next', 'later'];
  // 12 questions with two sentences each need more room than a normal answer.
  const RADAR_SCAN_TOKENS = 4000;
  function radarScanPrompt(c, lang) {
    const known = (c.questions || []).slice(0, 15);
    return [
      'You do horizon scanning (strategic foresight) for a company that wants AI assistants to recommend it.',
      'Company: ' + c.name + (c.website ? ' (' + c.website + ')' : '') + '. It offers: ' + (c.offer || '-') + (c.where ? ' in ' + c.where : '') + '.',
      'Its topics: ' + ((c.topics || []).join('; ') || '-') + '.',
      known.length ? 'Questions it already tracks (do not repeat them):\n- ' + known.join('\n- ') : '',
      (c.personas || []).length ? 'People who ask about it: ' + c.personas.map(p => p.name + ' (writes in ' + langName(p.lang) + ')').join('; ') + '. Write each question in the language of the person who would ask it.' : '',
      'Find questions that potential customers are starting to ask AI assistants like ChatGPT, or will likely ask soon, because something is changing.',
      'Look at five drivers of change: technology, market, society, regulation, environment.',
      'Sort each question into a horizon: "now" = already asked, but good answers are still rare; "next" = growing, likely common within 6 to 12 months; "later" = an early, weak signal that may or may not grow.',
      'Reply with JSON only, no other text, in this shape:',
      '{"signals":[{"question":"...","topic":"...","horizon":"now|next|later","driver":"technology|market|society|regulation|environment","change":"...","signal":"...","confidence":"high|medium|low"}],"trends":[{"term":"...","direction":"up|flat|down","why":"..."}]}',
      'signals: 12 questions, about 4 per horizon. "question" as a customer would type it; do not name ' + c.name + '. "topic" is one of the company\'s topics. "change": one short sentence on what is changing. "signal": one short sentence on an observable sign that it is starting. "confidence": how sure you are that the question will matter.',
      'trends: 3 to 6 short topic terms (2 to 4 words) that are moving in this market.',
      'Keep "change" and "signal" under 20 words each.',
      'Do not invent numbers, studies, laws, dates or company names. If you are unsure, say so with a low confidence.',
      ((c.personas || []).length ? 'Write changes, signals and trends in ' : 'Write questions, changes, signals and trends in ') + langName(lang === 'de' ? 'de' : 'en') + '.',
    ].filter(Boolean).join('\n');
  }
  // Short, stable id from the question text, so a rescan keeps what was tracked or dismissed.
  function textId(t) {
    let h = 2166136261;
    for (const ch of normalize(t)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return 'ai' + (h >>> 0).toString(36);
  }
  // Complete {...} objects inside the array that follows "name": in a JSON
  // text that may be cut off (an answer that hit the length limit).
  function salvageArray(t, name) {
    const at = t.indexOf('"' + name + '"');
    if (at === -1) return [];
    const out = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = t.indexOf('[', at) + 1; i > 0 && i < t.length; i++) {
      const ch = t[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') { if (depth++ === 0) start = i; }
      else if (ch === '}') { if (--depth === 0) { try { out.push(JSON.parse(t.slice(start, i + 1))); } catch (e) { /* skip a broken one */ } } }
      else if (ch === ']' && depth === 0) break;
    }
    return out;
  }
  function parseRadarScan(text, topicIds, when) {
    const t = String(text || '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1) return null;
    let j;
    try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { j = { signals: salvageArray(t, 'signals'), trends: salvageArray(t, 'trends') }; }
    const str = (x, n) => typeof x === 'string' ? x.trim().slice(0, n || 300) : '';
    const pick = (x, list, dflt) => list.includes(String(x).toLowerCase()) ? String(x).toLowerCase() : dflt;
    const topicOf = label => { const n = normalize(label); const hit = (topicIds || []).find(x => normalize(x.label) === n); return hit ? hit.id : null; };
    const day = (when || new Date().toISOString()).slice(0, 10);
    const seen = new Set();
    const candidates = (Array.isArray(j.signals) ? j.signals : []).map(x => {
      const query = str(x && x.question);
      if (query.length < 8 || seen.has(normalize(query))) return null;
      seen.add(normalize(query));
      return {
        id: textId(query), query, horizon: pick(x.horizon, HORIZONS, 'later'), driver: pick(x.driver, DRIVERS, null),
        change: str(x.change, 240), signal: str(x.signal, 240), confidence: pick(x.confidence, ['high', 'medium', 'low'], 'low'),
        category: topicOf(str(x.topic)), origins: ['ai'], score: null, new: true, first_seen: day, count: 1,
      };
    }).filter(Boolean).slice(0, 20);
    const MOM = { up: 0.8, flat: 0.5, down: 0.2 };
    const topics = (Array.isArray(j.trends) ? j.trends : []).map(x => ({ term: str(x && x.term, 60), momentum: MOM[pick(x && x.direction, Object.keys(MOM), 'flat')], growth: null, why: str(x && x.why, 200), series: [] }))
      .filter(x => x.term).slice(0, 8);
    if (!candidates.length) return null;
    return { generated: day, source: 'ai', candidates, topics };
  }

  return {
    radarScanPrompt, parseRadarScan, salvageArray, textId, DRIVERS, HORIZONS, RADAR_SCAN_TOKENS,
    personaPrompt, parsePersonas, questionsPrompt, parseQuestions, templatePersonas, templateQuestions, LANG_NAMES,
    ENGINE_ORDER, RETRY_WAITS, normalize, findFirstMention, detectMention, normalizeDomain, normalizeDomains,
    request, parse, isTransient, callEngine, makeRow, wilson, isoWeek, buildTrend, buildResults, buildAnswers, buildCitedSources, summarize,
  };
});
