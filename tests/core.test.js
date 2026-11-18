// Unit tests for app/core.js's pure domain logic (GEO scoring, mention
// parsing, keyword matching). Uses Node's built-in test runner — no
// dependencies, no build step, consistent with the project's "zero
// dependencies in the frontend" design decision (see README.md).
//
// Run: node --test tests/core.test.js

'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const CORE = require('../app/core.js');

describe('parseResult', () => {
  test('parses cited/mentioned/absent codes in claude/gpt/gemini order', () => {
    assert.deepEqual(CORE.parseResult('c2 m4 a'), {
      claude: ['cited', 2],
      gpt: ['mentioned', 4],
      gemini: ['absent', 0],
    });
  });

  test('all absent', () => {
    assert.deepEqual(CORE.parseResult('a a a'), {
      claude: ['absent', 0],
      gpt: ['absent', 0],
      gemini: ['absent', 0],
    });
  });

  test('all cited at different positions', () => {
    assert.deepEqual(CORE.parseResult('c1 c3 c10'), {
      claude: ['cited', 1],
      gpt: ['cited', 3],
      gemini: ['cited', 10],
    });
  });
});

describe('pct', () => {
  test('rounds to nearest integer', () => {
    assert.equal(CORE.pct(1, 3), 33);
    assert.equal(CORE.pct(2, 3), 67);
  });

  test('returns 0 when denominator is 0 (no divide-by-zero)', () => {
    assert.equal(CORE.pct(5, 0), 0);
  });

  test('100% when a equals b', () => {
    assert.equal(CORE.pct(4, 4), 100);
  });
});

describe('overlaps', () => {
  test('true when any element is shared', () => {
    assert.equal(CORE.overlaps(['a', 'b'], ['b', 'c']), true);
  });

  test('false when no elements are shared', () => {
    assert.equal(CORE.overlaps(['a', 'b'], ['c', 'd']), false);
  });

  test('false for an empty array', () => {
    assert.equal(CORE.overlaps([], ['a']), false);
  });
});

describe('kwHit', () => {
  test('short keyword (<=3 chars) requires a word boundary', () => {
    assert.equal(CORE.kwHit(' ai in marketing ', 'ai'), true);
    assert.equal(CORE.kwHit(' said something ', 'ai'), false); // "ai" inside "said" must not match
  });

  test('long keyword matches as a plain substring', () => {
    assert.equal(CORE.kwHit(' vector database setup ', 'vector database'), true);
  });

  test('is case-sensitive on the input the caller already lowercased', () => {
    // kwHit itself does not lowercase — callers are expected to pass lowercased text.
    assert.equal(CORE.kwHit(' AI workshop ', 'ai'), false);
  });

  test('handles German umlauts in the word-boundary character class', () => {
    assert.equal(CORE.kwHit(' büro für ki ', 'ki'), true);
  });
});

describe('scoreDraft', () => {
  const rel = () => 1; // full topic relevance for every block in these tests

  test('empty draft scores 0', () => {
    const sc = CORE.scoreDraft([], rel);
    assert.equal(sc.score, 0);
    assert.deepEqual(sc.met, [false, false, false, false, false, false, false]);
  });

  test('opens with a statement, has every block type, 3-7 blocks -> full 100', () => {
    const blocks = [
      { type: 'statement' }, { type: 'figure' }, { type: 'case' },
      { type: 'quote' }, { type: 'faq' },
    ];
    const sc = CORE.scoreDraft(blocks, rel);
    assert.equal(sc.score, 100);
    assert.deepEqual(sc.met, [true, true, true, true, true, true, true]);
  });

  test('opening with a definition also satisfies the direct-answer criterion', () => {
    const sc = CORE.scoreDraft([{ type: 'definition' }, { type: 'figure' }, { type: 'case' }], rel);
    assert.equal(sc.met[0], true);
  });

  test('opening with a non-answer type fails the direct-answer criterion', () => {
    const sc = CORE.scoreDraft([{ type: 'quote' }, { type: 'figure' }, { type: 'case' }], rel);
    assert.equal(sc.met[0], false);
  });

  test('block count outside 3-7 fails the length criterion', () => {
    const two = CORE.scoreDraft([{ type: 'statement' }, { type: 'figure' }], rel);
    assert.equal(two.met[6], false);
    const eight = CORE.scoreDraft(Array(8).fill({ type: 'statement' }), rel);
    assert.equal(eight.met[6], false);
    const five = CORE.scoreDraft(Array(5).fill({ type: 'statement' }), rel);
    assert.equal(five.met[6], true);
  });

  test('low average relevance fails the topic-match criterion', () => {
    const lowRel = () => 0.3;
    const sc = CORE.scoreDraft([{ type: 'statement' }, { type: 'figure' }, { type: 'case' }], lowRel);
    assert.equal(sc.met[5], false);
    assert.equal(sc.avgRel, 0.3);
  });

  test('weights sum to 100', () => {
    // Documents the invariant the README's scoring table promises.
    const blocks = [{ type: 'statement' }, { type: 'figure' }, { type: 'case' }, { type: 'quote' }, { type: 'faq' }];
    const sc = CORE.scoreDraft(blocks, rel);
    assert.equal(sc.score, 20 + 20 + 15 + 15 + 10 + 10 + 10);
  });
});

describe('splitFaqText', () => {
  test('splits on the en-dash separator', () => {
    assert.deepEqual(CORE.splitFaqText('What is X? – X is a thing.'), {
      question: 'What is X?',
      answer: 'X is a thing.',
    });
  });

  test('text without the separator becomes the question with an empty answer', () => {
    assert.deepEqual(CORE.splitFaqText('No separator here'), {
      question: 'No separator here',
      answer: '',
    });
  });

  test('only splits on the first occurrence', () => {
    const r = CORE.splitFaqText('Q – A – with a dash in the answer too');
    assert.equal(r.question, 'Q');
    assert.equal(r.answer, 'A – with a dash in the answer too');
  });
});

describe('toFaqJsonLd', () => {
  test('returns null when there are no FAQ blocks', () => {
    assert.equal(CORE.toFaqJsonLd([{ type: 'statement', text: 'X is great.' }]), null);
  });

  test('builds valid FAQPage structure from FAQ blocks', () => {
    const jsonLd = CORE.toFaqJsonLd([
      { type: 'statement', text: 'Intro statement.' },
      { type: 'faq', text: 'What is X? – X is a thing.' },
    ]);
    assert.equal(jsonLd['@type'], 'FAQPage');
    assert.equal(jsonLd.mainEntity.length, 1);
    assert.equal(jsonLd.mainEntity[0]['@type'], 'Question');
    assert.equal(jsonLd.mainEntity[0].name, 'What is X?');
    assert.equal(jsonLd.mainEntity[0].acceptedAnswer.text, 'X is a thing.');
  });

  test('includes every FAQ block, ignoring non-FAQ blocks', () => {
    const jsonLd = CORE.toFaqJsonLd([
      { type: 'faq', text: 'Q1? – A1.' },
      { type: 'quote', text: 'Someone said something.' },
      { type: 'faq', text: 'Q2? – A2.' },
    ]);
    assert.equal(jsonLd.mainEntity.length, 2);
  });
});

describe('toMarkdown', () => {
  test('renders a title as an H1 when given', () => {
    const md = CORE.toMarkdown([{ type: 'statement', text: 'Hello.' }], 'My Title');
    assert.match(md, /^# My Title\n/);
  });

  test('omits the title line when none is given', () => {
    const md = CORE.toMarkdown([{ type: 'statement', text: 'Hello.' }]);
    assert.ok(!md.startsWith('#'));
  });

  test('renders a quote as a blockquote', () => {
    const md = CORE.toMarkdown([{ type: 'quote', text: 'A wise quote.' }]);
    assert.match(md, /^> A wise quote\.$/m);
  });

  test('renders an FAQ block as a heading plus answer paragraph', () => {
    const md = CORE.toMarkdown([{ type: 'faq', text: 'What is X? – X is a thing.' }]);
    assert.match(md, /^### What is X\?$/m);
    assert.match(md, /^X is a thing\.$/m);
  });

  test('plain block types render as a bare paragraph', () => {
    const md = CORE.toMarkdown([{ type: 'statement', text: 'A plain statement.' }]);
    assert.match(md, /^A plain statement\.$/m);
  });
});

describe('slugify', () => {
  test('lowercases and hyphenates', () => {
    assert.equal(CORE.slugify('Wärmepumpen'), 'heat-pumps');
  });

  test('strips accents', () => {
    assert.equal(CORE.slugify('Café Müller'), 'cafe-muller');
  });

  test('falls back to "topic" for an empty/unusable label', () => {
    assert.equal(CORE.slugify('!!!'), 'topic');
    assert.equal(CORE.slugify(''), 'topic');
  });

  test('truncates very long labels', () => {
    const slug = CORE.slugify('a'.repeat(100));
    assert.ok(slug.length <= 24);
  });
});

describe('generateForCategory / generateQuestions (parity with scripts/generate_questions.py)', () => {
  const CAT = { id: 'oi', label_en: 'Heat pumps', label_de: 'Wärmepumpen', keywords: ['heat pumps', 'air source'] };

  test('generates the requested count, each tagged with the category id', () => {
    const out = CORE.generateForCategory(CAT, 4, 0);
    assert.equal(out.length, 4);
    assert.ok(out.every(q => q.categories[0] === 'oi'));
  });

  test('is deterministic', () => {
    assert.deepEqual(CORE.generateForCategory(CAT, 6, 0), CORE.generateForCategory(CAT, 6, 0));
  });

  test('generateQuestions assigns sequential ids and marks the first keyCount as key/weekly', () => {
    const qs = CORE.generateQuestions([CAT], { perCategory: 4, keyCount: 2 });
    assert.equal(qs.length, 4);
    assert.deepEqual(qs.map(q => q.id), ['q1', 'q2', 'q3', 'q4']);
    assert.deepEqual(qs.map(q => q.key), [true, true, false, false]);
    assert.deepEqual(qs.map(q => q.schedule), ['weekly', 'weekly', 'manual', 'manual']);
  });

  test('keyCount larger than the generated total is clamped, not an error', () => {
    const qs = CORE.generateQuestions([CAT], { perCategory: 2, keyCount: 999 });
    assert.ok(qs.every(q => q.key === true));
  });
});

describe('toHtml', () => {
  test('is a complete, parseable HTML document with the title set', () => {
    const html = CORE.toHtml([{ type: 'statement', text: 'Hello.' }], 'My Title');
    assert.match(html, /<!doctype html>/);
    assert.match(html, /<title>My Title<\/title>/);
    assert.match(html, /<h1>My Title<\/h1>/);
  });

  test('embeds FAQPage JSON-LD when the draft has FAQ blocks', () => {
    const html = CORE.toHtml([{ type: 'faq', text: 'What is X? – X is a thing.' }], 'T');
    assert.match(html, /application\/ld\+json/);
    assert.match(html, /"@type":"FAQPage"/);
  });

  test('omits the JSON-LD script entirely when there are no FAQ blocks', () => {
    const html = CORE.toHtml([{ type: 'statement', text: 'Hello.' }], 'T');
    assert.ok(!html.includes('application/ld+json'));
  });

  test('escapes HTML-significant characters in block text', () => {
    const html = CORE.toHtml([{ type: 'statement', text: '<script>alert(1)</script>' }], 'T');
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;'));
  });

  test('renders a quote as a blockquote element', () => {
    const html = CORE.toHtml([{ type: 'quote', text: 'A wise quote.' }], 'T');
    assert.match(html, /<blockquote><p>A wise quote\.<\/p><\/blockquote>/);
  });
});
