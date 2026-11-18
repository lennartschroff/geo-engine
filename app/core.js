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

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function htmlEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  /**
   * FAQ blocks are authored as "Question – Answer" (en dash). Splits on the
   * first " – " separator; if a block doesn't follow that convention, the
   * whole text becomes the question with an empty answer rather than
   * guessing or throwing.
   */
  function splitFaqText(text) {
    const sep = ' – ';
    const idx = text.indexOf(sep);
    if (idx === -1) return { question: text, answer: '' };
    return { question: text.slice(0, idx).trim(), answer: text.slice(idx + sep.length).trim() };
  }

  /**
   * Builds schema.org FAQPage JSON-LD from the faq-type blocks in a draft.
   * Returns null if the draft has no FAQ blocks (nothing to mark up).
   */
  function toFaqJsonLd(items) {
    const faqs = items.filter(it => it.type === 'faq').map(it => splitFaqText(it.text));
    if (!faqs.length) return null;
    return {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faqs.map(f => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer }
      }))
    };
  }

  /** Renders a draft (list of {type, text}) as Markdown. `title` is optional. */
  function toMarkdown(items, title) {
    const lines = [];
    if (title) lines.push('# ' + title, '');
    items.forEach(it => {
      if (it.type === 'quote') {
        lines.push('> ' + it.text, '');
      } else if (it.type === 'faq') {
        const f = splitFaqText(it.text);
        lines.push('### ' + f.question, '', f.answer, '');
      } else {
        lines.push(it.text, '');
      }
    });
    return lines.join('\n').trim() + '\n';
  }

  /**
   * Renders a draft as a standalone HTML document, with FAQPage JSON-LD in
   * <head> when the draft has FAQ blocks.
   */
  function toHtml(items, title) {
    const jsonLd = toFaqJsonLd(items);
    const body = items.map(it => {
      if (it.type === 'quote') return '<blockquote><p>' + htmlEscape(it.text) + '</p></blockquote>';
      if (it.type === 'faq') {
        const f = splitFaqText(it.text);
        return '<h3>' + htmlEscape(f.question) + '</h3>\n<p>' + htmlEscape(f.answer) + '</p>';
      }
      return '<p>' + htmlEscape(it.text) + '</p>';
    }).join('\n');
    const head = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>' + htmlEscape(title || '') + '</title>\n' +
      (jsonLd ? '<script type="application/ld+json">' + JSON.stringify(jsonLd) + '</script>\n' : '') + '</head>\n<body>\n';
    const titleHtml = title ? '<h1>' + htmlEscape(title) + '</h1>\n' : '';
    return head + titleHtml + body + '\n</body>\n</html>\n';
  }

  // ---------- Starter-kit generation (ported from scripts/generate_questions.py) ----------
  // Kept in exact parity with the Python version so the in-browser setup wizard
  // and the local CLI script produce the same shape of output. See that file's
  // docstring for the design rationale (zero cost, no API key, deterministic).
  const QUESTION_TEMPLATES = [
    ['Which agencies are leading in {label}?', 'Welche Agenturen sind führend in {label}?'],
    ['How do I get started with {label}?', 'Wie starte ich mit {label}?'],
    ['What is {kw}?', 'Was ist {kw}?'],
    ['What are the benefits of {label}?', 'Was sind die Vorteile von {label}?'],
    ['How much does {label} typically cost?', 'Was kostet {label} normalerweise?'],
    ['Which companies specialize in {kw}?', 'Welche Unternehmen sind auf {kw} spezialisiert?'],
  ];

  function fillTemplate(tpl, label, kw) {
    return tpl.replace('{label}', label).replace('{kw}', kw);
  }

  /** Generates `count` question texts for one category, starting at template index `startIndex`. */
  function generateForCategory(cat, count, startIndex) {
    const kw = (cat.keywords && cat.keywords[0]) || cat.label_en;
    const out = [];
    for (let i = 0; i < count; i++) {
      const pair = QUESTION_TEMPLATES[(startIndex + i) % QUESTION_TEMPLATES.length];
      const isEven = (startIndex + i) % 2 === 0;
      const text = isEven ? fillTemplate(pair[0], cat.label_en, kw) : fillTemplate(pair[1], cat.label_de, kw);
      out.push({ text, categories: [cat.id] });
    }
    return out;
  }

  /**
   * Generates a full starter questions.json-shaped array from a list of
   * categories ({id, label_en, label_de, keywords}). Deterministic: same
   * input always produces the same output, no randomness.
   */
  function generateQuestions(categories, opts) {
    opts = opts || {};
    const perCategory = opts.perCategory || 6;
    const keyCount = opts.keyCount != null ? opts.keyCount : 15;

    let raw = [];
    categories.forEach((cat, i) => { raw = raw.concat(generateForCategory(cat, perCategory, i)); });

    const kc = Math.min(keyCount, raw.length);
    return raw.map((q, idx) => ({
      id: 'q' + (idx + 1),
      nr: idx + 1,
      text: q.text,
      categories: q.categories,
      key: idx < kc,
      schedule: idx < kc ? 'weekly' : 'manual',
    }));
  }

  /** Slugifies a label into a short lowercase id usable as a category id. */
  function slugify(label) {
    return String(label).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'topic';
  }

  // ---------- BM25 text relevance ----------
  // This is the actual algorithm underneath most search engines and the
  // first-pass retrieval step in many retrieval-augmented-generation
  // pipelines (before or alongside embeddings) — not an invented heuristic.
  // Deterministic: same corpus + same query always gives the same ranking.
  // Rationale: an AI answer engine doesn't retrieve a whole page for a
  // query, it retrieves the *passage* whose wording best matches the
  // question — so "is this content relevant" should be measured the same
  // way a retrieval system would measure it (shared, rare/distinctive
  // words), not by whether someone tagged it with the same topic id.
  const TOKEN_RE = /[^\p{L}\p{N}]+/u;
  function tokenize(text) {
    return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .split(TOKEN_RE).filter(t => t.length > 1);
  }

  /** Document frequency + average length for a tokenized corpus. */
  function buildCorpusStats(tokenizedDocs) {
    const N = tokenizedDocs.length;
    const df = {};
    tokenizedDocs.forEach(tokens => {
      new Set(tokens).forEach(t => { df[t] = (df[t] || 0) + 1; });
    });
    const totalLen = tokenizedDocs.reduce((a, d) => a + d.length, 0);
    return { N, df, avgdl: N ? totalLen / N : 0 };
  }

  function idf(term, stats) {
    const n = stats.df[term] || 0;
    return Math.log((stats.N - n + 0.5) / (n + 0.5) + 1);
  }

  /** Standard BM25 (k1=1.5, b=0.75 — the usual defaults; not tuned per corpus). */
  function bm25Score(queryTokens, docTokens, stats, k1, b) {
    k1 = k1 == null ? 1.5 : k1;
    b = b == null ? 0.75 : b;
    const tf = {};
    docTokens.forEach(t => { tf[t] = (tf[t] || 0) + 1; });
    const dl = docTokens.length;
    let score = 0;
    new Set(queryTokens).forEach(t => {
      const f = tf[t] || 0;
      if (!f) return;
      score += idf(t, stats) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (dl / (stats.avgdl || 1))));
    });
    return score;
  }

  /**
   * Ranks `docs` ({id, text}) by BM25 relevance to `queryText`, with each
   * score normalized to [0, 1] relative to the best-scoring doc in this set
   * (0 if nothing in the set matches at all) — "how good a match is this,
   * relative to the best match available," which is what a 0-100% figure
   * actually means to someone reading it, since raw BM25 scores aren't
   * bounded and aren't comparable across different queries/corpora.
   */
  function rankByRelevance(queryText, docs) {
    const queryTokens = tokenize(queryText);
    const tokenized = docs.map(d => tokenize(d.text));
    const stats = buildCorpusStats(tokenized);
    const raw = docs.map((d, i) => bm25Score(queryTokens, tokenized[i], stats, 1.5, 0.75));
    const max = Math.max(0, ...raw);
    return docs
      .map((d, i) => Object.assign({}, d, { relevance: max > 0 ? raw[i] / max : 0 }))
      .sort((a, b) => b.relevance - a.relevance);
  }

  return {
    parseResult, pct, overlaps, kwHit, scoreDraft, splitFaqText, toFaqJsonLd, toMarkdown, toHtml, htmlEscape,
    QUESTION_TEMPLATES, generateForCategory, generateQuestions, slugify,
    tokenize, buildCorpusStats, idf, bm25Score, rankByRelevance,
  };
});
