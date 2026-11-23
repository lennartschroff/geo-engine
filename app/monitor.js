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
      const body = { model: cfg.model, max_tokens: 1024, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: prompt }] };
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
    const o = Object.assign({ fetch: (u, i) => fetch(u, i), sleep: s => new Promise(r => setTimeout(r, s * 1000)), onRetry: null, signal: null }, opts);
    for (let attempt = 0; ; attempt++) {
      try { return await callOnce(engine, cfg, prompt, key, o.fetch); } catch (err) {
        if (attempt >= RETRY_WAITS.length || !isTransient(err) || (o.signal && o.signal.aborted)) throw err;
        if (o.onRetry) o.onRetry(err, RETRY_WAITS[attempt]);
        await o.sleep(RETRY_WAITS[attempt]);
      }
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

  // ---------- Onboarding: suggested questions for a new brand ----------
  // The prompt asks for JSON only; the answer is parsed defensively because
  // models sometimes wrap it in prose or code fences.
  function suggestPrompt(c, lang) {
    const where = c.where ? (lang === 'de' ? ' in ' : ' in ') + c.where : '';
    return [
      'A company wants to see how AI assistants talk about it.',
      'Company: ' + c.name + (c.website ? ' (' + c.website + ')' : '') + '. It offers: ' + c.offer + where + '.',
      'Reply with JSON only, no other text, in this shape:',
      '{"topics":[{"label":"...","keywords":["..."]}],"questions":[{"text":"...","topic":"..."}],"competitors":["..."]}',
      'topics: 2 to 4 short topic names for what the company offers, each with 3 to 6 lowercase keywords.',
      'questions: 10 questions a potential customer would type into ChatGPT when looking for such a provider. Do not name ' + c.name + ' in them. "topic" is one of the topic labels.',
      'competitors: up to 6 real companies that offer the same' + where + '. Names only. Leave the list empty if you are not sure they exist.',
      'Write topics and questions in ' + (lang === 'de' ? 'German' : 'English') + '.',
    ].join('\n');
  }
  function parseSuggestions(text) {
    const t = String(text || '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a === -1 || b <= a) return null;
    let j;
    try { j = JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
    const str = x => typeof x === 'string' ? x.trim() : '';
    const topics = (Array.isArray(j.topics) ? j.topics : []).map(x => ({ label: str(x && x.label), keywords: (Array.isArray(x && x.keywords) ? x.keywords : []).map(str).filter(Boolean).slice(0, 8) }))
      .filter(x => x.label).slice(0, 5);
    const questions = (Array.isArray(j.questions) ? j.questions : []).map(x => ({ text: str(x && x.text).slice(0, 300), topic: str(x && x.topic) }))
      .filter(x => x.text.length >= 8).slice(0, 15);
    const competitors = [...new Set((Array.isArray(j.competitors) ? j.competitors : []).map(str).filter(x => x && x.length <= 60))].slice(0, 8);
    if (!questions.length) return null;
    return { topics, questions, competitors };
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

  return {
    suggestPrompt, parseSuggestions, templateQuestions,
    ENGINE_ORDER, RETRY_WAITS, normalize, findFirstMention, detectMention, normalizeDomain, normalizeDomains,
    request, parse, isTransient, callEngine, makeRow, wilson, isoWeek, buildTrend, buildResults, buildAnswers, buildCitedSources, summarize,
  };
});
