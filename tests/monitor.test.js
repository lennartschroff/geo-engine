// Unit tests for app/monitor.js (in-browser monitoring). No network: the
// provider calls get a fake fetch. Run: node --test tests/monitor.test.js
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../app/monitor.js');

describe('detectMention (same rules as mention_detection.py)', () => {
  test('rank among named providers, brand by any alias', () => {
    const r = M.detectMention('Try Peec or Otterly. GEO Engine is open source.', ['GEO Engine', 'lennartschroff/geo-engine'], ['Peec', 'Otterly']);
    assert.deepEqual(r, { mentioned: true, position: 3, providers: ['Peec', 'Otterly', '(brand)'] });
  });
  test('hyphens and case are ignored, but not inside longer words', () => {
    assert.equal(M.detectMention('tailspin-robotics leads', ['Tailspin Robotics'], []).mentioned, true);
    assert.equal(M.detectMention('Tailspinner is different', ['Tailspin'], []).mentioned, false);
  });
  test('umlauts are word characters', () => {
    assert.equal(M.detectMention('Mündlich', ['Mü'], []).mentioned, false);
  });
  test('not mentioned keeps the competitors it found', () => {
    assert.deepEqual(M.detectMention('Peec is good', ['Brand'], ['Peec']), { mentioned: false, position: null, providers: ['Peec'] });
  });
});

describe('domains', () => {
  test('normalized and deduplicated', () => {
    assert.deepEqual(M.normalizeDomains(['https://www.Example.com/a?x=1', 'http://example.com/', 'sub.example.com', 'not a url']),
      ['example.com', 'sub.example.com']);
  });
});

describe('provider requests and responses', () => {
  test('Claude: browser opt-in header, web search tool, text and search results parsed', () => {
    const { url, init } = M.request('claude', { model: 'claude-sonnet-5', max_searches: 1 }, 'Q?', 'k');
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(init.headers['x-api-key'], 'k');
    assert.equal(JSON.parse(init.body).tools[0].max_uses, 1);
    const out = M.parse('claude', { content: [
      { type: 'server_tool_use' },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com/x' }] },
      { type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] });
    assert.deepEqual(out, { answer_text: 'Hello world', cited_urls: ['https://a.com/x'] });
  });
  test('Claude without searches sends no tools', () => {
    assert.equal(JSON.parse(M.request('claude', { model: 'm', max_searches: 0 }, 'Q', 'k').init.body).tools, undefined);
  });
  test('Gemini: key in a header, never in the URL; grounding chunks become citations', () => {
    const { url, init } = M.request('gemini', { model: 'gemini-3.5-flash-lite', grounding: false }, 'Q?', 'secret');
    assert.ok(!url.includes('secret'));
    assert.equal(init.headers['x-goog-api-key'], 'secret');
    assert.equal(JSON.parse(init.body).tools, undefined);
    const out = M.parse('gemini', { candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: 'https://b.org' } }] } }] });
    assert.deepEqual(out, { answer_text: 'AB', cited_urls: ['https://b.org'] });
  });
  test('ChatGPT: output_text parts and url citations', () => {
    const out = M.parse('gpt', { output: [{ type: 'web_search_call' }, { type: 'message', content: [
      { type: 'output_text', text: 'Hi', annotations: [{ type: 'url_citation', url: 'https://c.net' }] }] }] });
    assert.deepEqual(out, { answer_text: 'Hi', cited_urls: ['https://c.net'] });
  });
});

describe('callEngine retries like run.py', () => {
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const fail = (status, message) => ({ ok: false, status, json: async () => ({ error: { message } }) });
  test('overload is retried, then succeeds', async () => {
    const replies = [fail(529, 'Overloaded'), fail(503, 'high demand'), ok({ content: [{ type: 'text', text: 'done' }] })];
    const waits = [];
    const out = await M.callEngine('claude', { model: 'm', max_searches: 0 }, 'Q', 'k', { fetch: async () => replies.shift(), sleep: async s => waits.push(s) });
    assert.equal(out.answer_text, 'done');
    assert.deepEqual(waits, M.RETRY_WAITS);
  });
  test('a wrong key fails at once with its status', async () => {
    await assert.rejects(M.callEngine('claude', { model: 'm', max_searches: 0 }, 'Q', 'k', { fetch: async () => fail(401, 'invalid x-api-key'), sleep: async () => { throw new Error('no wait'); } }),
      e => e.status === 401 && /invalid/.test(e.message));
  });
});

describe('summarize (same as export_monitoring.py)', () => {
  const brand = { domain: 'lennartschroff.github.io', aliases: ['GEO Engine'] };
  const t = '2026-11-23T10:00:00.000Z';
  const row = (q, e, text, urls, when) => M.makeRow({ id: q }, e, 'm', 'Q', { answer_text: text, cited_urls: urls }, brand.aliases, ['Peec'], new Date(when || t));
  test('status codes: cited, mentioned, absent, not run; competitor named first', () => {
    const rows = [
      row('q1', 'claude', 'Peec and GEO Engine.', ['https://lennartschroff.github.io/geo-engine/']),
      row('q1', 'gemini', 'GEO Engine.', []),
      row('q2', 'claude', 'Peec only.', ['https://peec.ai']),
    ];
    const s = M.summarize(rows, brand, ['Peec']);
    assert.deepEqual(s.results.q1, { competitor: 'Peec', r: 'c2 n m1' });
    assert.deepEqual(s.results.q2, { competitor: 'Peec', r: 'a n n' });
    assert.deepEqual(s.cited_sources.map(x => [x.name, x.cites]), [['lennartschroff.github.io', 1], ['peec.ai', 1]]);
    assert.equal(s.trend_ci[0].week, '2026-W48');
    assert.equal(s.trend_ci[0].rate, 67);
  });
  test('the newest answer per question and engine wins', () => {
    const rows = [row('q1', 'claude', 'GEO Engine', [], '2026-11-01T00:00:00Z'), row('q1', 'claude', 'nothing', [], '2026-11-20T00:00:00Z')];
    assert.equal(M.summarize(rows, brand, []).results.q1.r, 'a n n');
  });
  test('wilson interval matches the Python version', () => {
    const [lo, hi] = M.wilson(2, 30);
    assert.equal(Math.round(lo * 100), 2);
    assert.equal(Math.round(hi * 100), 21);
  });
});

describe('onboarding: personas and their questions', () => {
  test('personas: JSON inside prose and fences, language codes cleaned, duplicates and junk dropped', () => {
    const text = 'Sure!\n```json\n' + JSON.stringify({
      personas: [{ name: 'Landwirt in Bayern', who: 'Owns farmland.', language: 'DE' }, { name: 'landwirt in bayern', language: 'de' }, { name: '', language: 'en' }, { name: 'Investor', language: 'english' }],
      topics: [{ label: 'Agri-PV', keywords: ['agri-pv', ' solar '] }, { label: '' }],
      competitors: ['Next2Sun', 'Next2Sun', ''],
    }) + '\n```';
    assert.deepEqual(M.parsePersonas(text), {
      personas: [{ id: 'p1', name: 'Landwirt in Bayern', who: 'Owns farmland.', lang: 'de' }, { id: 'p2', name: 'Investor', who: '', lang: 'en' }],
      topics: [{ label: 'Agri-PV', keywords: ['agri-pv', 'solar'] }],
      competitors: ['Next2Sun'],
    });
    assert.equal(M.parsePersonas('{"personas":[]}'), null);
    assert.equal(M.parsePersonas('I cannot help with that.'), null);
  });
  test('questions: tied to a persona and its language, unknown persona falls back to the first', () => {
    const P = [{ id: 'p1', name: 'Landwirt', lang: 'de' }, { id: 'p2', name: 'Investor', lang: 'en' }];
    const text = JSON.stringify({ questions: [
      { text: 'Kann ich meine Ackerfläche für Agri-PV verpachten?', persona: 'p1', topic: 'Agri-PV' },
      { text: 'What returns do agrivoltaic projects offer?', persona: 'p2' },
      { text: 'Wer plant Agri-PV-Anlagen in Bayern?', persona: 'p9' },
      { text: 'short', persona: 'p1' },
      { text: 'kann ich meine ackerfläche für agri-pv verpachten', persona: 'p1' },
    ] });
    assert.deepEqual(M.parseQuestions(text, P), [
      { text: 'Kann ich meine Ackerfläche für Agri-PV verpachten?', topic: 'Agri-PV', persona: 'p1', lang: 'de' },
      { text: 'What returns do agrivoltaic projects offer?', topic: '', persona: 'p2', lang: 'en' },
      { text: 'Wer plant Agri-PV-Anlagen in Bayern?', topic: '', persona: 'p1', lang: 'de' },
    ]);
    assert.equal(M.parseQuestions('{"questions":[]}', P), null);
  });
  test('prompts: persona languages are spelled out, the company is never put into questions', () => {
    const c = { name: 'Acme', offer: 'agri-PV', where: 'Bavaria' };
    assert.match(M.personaPrompt(c, 'de'), /ISO 639-1/);
    assert.match(M.personaPrompt(c, 'de'), /in German\.$/);
    const q = M.questionsPrompt(c, [{ id: 'p1', name: 'Landwirt', who: 'Hat Flächen', lang: 'de' }, { id: 'p2', name: 'Investor', lang: 'en' }], [{ label: 'Agri-PV' }]);
    assert.match(q, /- p1: Landwirt \(Hat Flächen\), writes in German/);
    assert.match(q, /- p2: Investor, writes in English/);
    assert.match(q, /Do not name Acme/);
  });
  test('templates without an AI: one persona, plain questions in both languages', () => {
    assert.deepEqual(M.templatePersonas('de'), [{ id: 'p1', name: 'Kunden', who: '', lang: 'de' }]);
    const en = M.templateQuestions({ offer: 'tax advice', where: 'Munich' }, 'en');
    assert.equal(en[0].text, 'Who are the best providers of tax advice in Munich?');
    assert.ok(M.templateQuestions({ offer: 'Steuerberatung', where: '' }, 'de')[0].text.startsWith('Wer sind die besten Anbieter für Steuerberatung?'));
  });
});

describe('radar scan', () => {
  const company = { name: 'Acme', website: 'acme.example', offer: 'bike repair', where: 'Berlin', topics: ['Repair', 'E-bikes'], questions: ['Who fixes bikes fast?'] };
  test('prompt names the company, its topics, the drivers and the language', () => {
    const p = M.radarScanPrompt(company, 'de');
    assert.match(p, /Acme \(acme\.example\)/);
    assert.match(p, /Repair; E-bikes/);
    assert.match(p, /Who fixes bikes fast\?/);
    assert.match(p, /regulation/);
    assert.match(p, /in German/);
  });
  test('with personas, each question is written in its asker\'s language', () => {
    const p = M.radarScanPrompt(Object.assign({}, company, { personas: [{ name: 'Landwirt', lang: 'de' }, { name: 'Investor', lang: 'en' }] }), 'en');
    assert.match(p, /Landwirt \(writes in German\); Investor \(writes in English\)/);
    assert.match(p, /Write changes, signals and trends in English\./);
  });
  test('parses signals into radar candidates, defensively', () => {
    const txt = 'Here you go:\n```json\n' + JSON.stringify({
      signals: [
        { question: 'Can I get my e-bike battery repaired instead of replaced?', topic: 'e-bikes', horizon: 'NEXT', driver: 'regulation', change: 'Right-to-repair rules.', signal: 'Repair cafés list batteries.', confidence: 'medium' },
        { question: 'Can I get my e-bike battery repaired instead of replaced?', topic: 'E-bikes', horizon: 'now' },
        { question: 'short', horizon: 'now' },
        { question: 'Which bike shop does same-day repairs near me?', topic: 'Unknown', horizon: 'soon', driver: 'vibes', confidence: 'sure' },
      ],
      trends: [{ term: 'battery repair', direction: 'up', why: 'x' }, { term: '', direction: 'up' }],
    }) + '\n```';
    const r = M.parseRadarScan(txt, [{ id: 'repair', label: 'Repair' }, { id: 'e-bikes', label: 'E-bikes' }], '2026-11-23T10:00:00Z');
    assert.equal(r.candidates.length, 2);
    const [a, b] = r.candidates;
    assert.equal(a.horizon, 'next'); assert.equal(a.driver, 'regulation'); assert.equal(a.category, 'e-bikes');
    assert.equal(a.confidence, 'medium'); assert.deepEqual(a.origins, ['ai']); assert.equal(a.score, null); assert.equal(a.first_seen, '2026-11-23');
    assert.equal(b.horizon, 'later'); assert.equal(b.driver, null); assert.equal(b.category, null); assert.equal(b.confidence, 'low');
    assert.equal(a.id, M.textId('can I get my e-bike battery repaired instead of replaced'));
    assert.deepEqual(r.topics.map(t => [t.term, t.momentum]), [['battery repair', 0.8]]);
  });
  test('nothing usable gives null', () => {
    assert.equal(M.parseRadarScan('sorry, no'), null);
    assert.equal(M.parseRadarScan('{"signals":[]}'), null);
  });
});

describe('request timeout', () => {
  test('a provider that never answers times out, is retried, then gives up', async () => {
    let calls = 0; const waits = [];
    const hang = () => { calls++; return new Promise(() => {}); };
    await assert.rejects(
      M.callEngine('gemini', { model: 'm' }, 'q', 'k', { fetch: hang, sleep: s => { waits.push(s); return Promise.resolve(); }, timeoutMs: 20 }),
      /timed out/);
    assert.equal(calls, 3);
    assert.deepEqual(waits, M.RETRY_WAITS);
  });
});

describe('radar scan: cut-off answers', () => {
  test('keeps every complete signal from an answer that hit the length limit', () => {
    const full = JSON.stringify({ signals: [
      { question: 'First complete question here?', horizon: 'now', change: 'a "quoted" {brace}' },
      { question: 'Second complete question here?', horizon: 'next' },
      { question: 'Third question that gets cut', horizon: 'la' },
    ] });
    const cut = '```json\n' + full.slice(0, full.indexOf('Third') + 10);
    const r = M.parseRadarScan(cut, []);
    assert.deepEqual(r.candidates.map(c => c.query), ['First complete question here?', 'Second complete question here?']);
    assert.equal(r.candidates[0].change, 'a "quoted" {brace}');
    assert.deepEqual(r.topics, []);
  });
  test('the scan may use more output tokens than a normal check', () => {
    const body = JSON.parse(M.request('claude', { model: 'm', max_tokens: M.RADAR_SCAN_TOKENS }, 'p', 'k').init.body);
    assert.equal(body.max_tokens, 4000);
    assert.equal(JSON.parse(M.request('claude', { model: 'm' }, 'p', 'k').init.body).max_tokens, 1024);
  });
});

describe('brand aliases', () => {
  test('the legal form is dropped as a second name', () => {
    assert.deepEqual(M.brandAliases('DoppelErnte GmbH'), ['DoppelErnte GmbH', 'DoppelErnte']);
    assert.deepEqual(M.brandAliases('Muster GmbH & Co. KG'), ['Muster GmbH & Co. KG', 'Muster']);
    assert.deepEqual(M.brandAliases('Acme Inc.'), ['Acme Inc.', 'Acme']);
    assert.deepEqual(M.brandAliases('Laufwerk'), ['Laufwerk']);
    assert.deepEqual(M.brandAliases('AG'), []);
    assert.deepEqual(M.brandAliases('Agrar AG', ['agrar', 'Agrar-Tech']), ['Agrar AG', 'Agrar', 'Agrar-Tech']);
  });
  test('redetect counts answers that use the short name', () => {
    const rows = [{ answer_text: '## 3. **DoppelErnte**\nDoppelErnte wird als Experte beschrieben. Next2Sun auch.', mentioned: 0, position: null }];
    const r = M.redetect(rows, M.brandAliases('DoppelErnte GmbH'), ['Next2Sun']);
    assert.equal(r[0].mentioned, 1); assert.equal(r[0].position, 1);
  });
});
