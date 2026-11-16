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
