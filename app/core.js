/*
 * GEO Engine – pure domain logic, shared between the browser app and tests.
 *
 * No DOM, no state, no I/O. Everything here is a pure function of its
 * arguments, which is what makes it worth separating from app.js: these are
 * the pieces that are easy to get subtly wrong (mention parsing, scoring)
 * and cheap to unit test in isolation.
 *
 * Loaded as a plain <script> in the browser (defines window.GEO_CORE) and as
 * a CommonJS module under Node for tests (module.exports) — no build step,
 * no bundler, matching the rest of the project.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.GEO_CORE = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Parses a demo-monitoring result string like "c2 m4 a" into per-engine
   * status. Codes: c<n> = cited at position n, m<n> = mentioned at
   * position n, a = absent. Engine order is fixed: claude, gpt, gemini.
   */
  function parseResult(str) {
    const one = x => (x[0] === 'c' ? ['cited', +x.slice(1)] : x[0] === 'm' ? ['mentioned', +x.slice(1)] : ['absent', 0]);
    const t = str.split(' ');
    return { claude: one(t[0]), gpt: one(t[1]), gemini: one(t[2]) };
  }

  /** Percentage of b that a is, rounded, 0 if b is falsy (avoids div-by-zero). */
  function pct(a, b) {
    return b ? Math.round((a / b) * 100) : 0;
  }

  /** True if any element of a is also in b. */
  function overlaps(a, b) {
    return a.some(t => b.indexOf(t) !== -1);
  }

  /**
   * Whole-word-ish keyword match (word-boundary for short/ambiguous
   * keywords, plain substring for longer ones where false positives are
   * less likely). `text` should already be lowercased and padded with
   * spaces by the caller.
   */
  function kwHit(text, kw) {
    if (kw.length <= 3) {
      return new RegExp('(^|[^a-zäöüß])' + kw.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '([^a-zäöüß]|$)').test(text);
    }
    return text.indexOf(kw) !== -1;
  }

  /**
   * Scores a draft (list of blocks) against the GEO checklist described in
   * README.md. `rel(block)` returns the block's topic relevance in [0, 1].
   * Weights sum to 100.
   */
  function scoreDraft(blocks, rel) {
    const n = blocks.length;
    const has = t => blocks.some(b => b.type === t);
    const avgRel = n ? blocks.reduce((a, b) => a + rel(b), 0) / n : 0;
    const met = [
      n > 0 && (blocks[0].type === 'statement' || blocks[0].type === 'definition'),
      has('figure'), has('case'), has('quote'), has('faq'),
      n > 0 && avgRel >= 0.6, n >= 3 && n <= 7
    ];
    const W = [20, 20, 15, 15, 10, 10, 10];
    return { met, avgRel, score: met.reduce((a, m, i) => a + (m ? W[i] : 0), 0) };
  }

  return { parseResult, pct, overlaps, kwHit, scoreDraft };
});
