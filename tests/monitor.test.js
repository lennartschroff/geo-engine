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
