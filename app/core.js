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
   * position n, a = absent (checked, not found), n = not run (never
   * queried for this engine — distinct from "a": a real monitoring export
   * can have real data for one engine and nothing yet for the others, and
   * those need to render as "not run" (notrun dot), not a false "absent").
   * Engine order is fixed: claude, gpt, gemini.
   */
  function parseResult(str) {
    const one = x => (
      x[0] === 'c' ? ['cited', +x.slice(1)] :
      x[0] === 'm' ? ['mentioned', +x.slice(1)] :
      x[0] === 'n' ? ['notrun', 0] :
      ['absent', 0]
    );
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

  // ---------- Block suggestions from your own content (Library import) ----------
  // Heuristics, not an LLM: they propose candidates, a person decides. Nothing
  // is invented -- every candidate is a sentence (or Q+A pair) taken verbatim
  // from the text the user supplied.

  /** Markdown -> plain text with paragraph breaks kept. */
  function textFromMarkdown(md) {
    return String(md || '')
      .replace(/```[\s\S]*?```/g, '\n')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')
      .replace(/^[ \t]*\d+\.[ \t]+/gm, '')
      .replace(/^[ \t]*>[ \t]?/gm, '')
      .replace(/(\*\*|__|\*|_|`)/g, '');
  }

  const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-ZÄÖÜ„"“0-9])/;
  const QUOTE_RE = /[„“"»«][^„“"»«]{25,}[“”"»«]/;
  const DEF_RE = /^[A-ZÄÖÜ][\w\-–()\/ ]{1,60}?\s(?:is|are|means|refers to|ist|sind|bezeichnet|bedeutet)\s/;
  const CASE_RE = /\b(client|customer|project|case study|kunde|kundin|kunden|projekt|fallstudie)\w*/i;
  const RESULT_RE = /\b(reduc|increas|sav|cut|improv|grew|doubl|halv|senk|steiger|spar|verkürz|reduzier|verdoppel|halbier|verbesser)\w*/i;
  const words = t => t.split(/\s+/).filter(Boolean).length;

  /** A sentence counts as a figure if it has a number that isn't just a year. */
  function hasFigure(t) {
    const nums = t.match(/\d+(?:[.,]\d+)?\s?(?:%|percent|Prozent)?/g) || [];
    return nums.some(n => /%|percent|Prozent/.test(n) || (!/^(19|20)\d{2}\s?$/.test(n) && /\d{2,}/.test(n)));
  }

  function classifySentence(t, leadsParagraph) {
    if (QUOTE_RE.test(t)) return 'quote';
    if (DEF_RE.test(t)) return 'definition';
    if (CASE_RE.test(t) && RESULT_RE.test(t)) return 'case';
    if (hasFigure(t)) return 'figure';
    if (leadsParagraph && words(t) >= 10) return 'statement';
    return null;
  }

  /**
   * Suggests content blocks from plain text.
   * categories: [{ id, keywords }] -- topics are pre-selected by keyword match.
   * Returns [{ type, text, categories }], at most `max`, in document order.
   */
  function extractBlockCandidates(text, categories, max) {
    const limit = max || 40;
    const paras = String(text || '').replace(/\r/g, '').split(/\n\s*\n|\n(?=[A-ZÄÖÜ][^\n]{0,200}\?\s*\n)/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const out = [];
    const seen = new Set();
    const topics = t => { const lc = ' ' + t.toLowerCase() + ' '; return (categories || []).filter(c => (c.keywords || []).some(k => kwHit(lc, String(k).toLowerCase()))).map(c => c.id); };
    const push = (type, t) => {
      const key = t.toLowerCase().replace(/\W+/g, ' ').trim();
      if (seen.has(key) || out.length >= limit) return;
      seen.add(key); out.push({ type, text: t, categories: topics(t) });
    };
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      // A short line ending in "?" followed by a paragraph = FAQ pair, stored
      // as "Question – Answer" (the format splitFaqText/toFaqJsonLd expect).
      if (p.endsWith('?') && p.length <= 200 && i + 1 < paras.length && !paras[i + 1].endsWith('?')) {
        const answer = paras[i + 1].split(SENTENCE_SPLIT).slice(0, 2).join(' ');
        if (words(answer) >= 5) { push('faq', p + ' – ' + answer.slice(0, 500)); i++; continue; }
      }
      p.split(SENTENCE_SPLIT).forEach((sent, j) => {
        const t = sent.trim();
        if (t.length < 40 || t.length > 400) return;
        const type = classifySentence(t, j === 0);
        if (type) push(type, t);
      });
    }
    return out;
  }

  // ---------- Answer viewer + share of voice (TASKS.md D1/D2) ----------
  // Name matching mirrors monitoring/mention_detection.py: case-insensitive,
  // hyphen and whitespace treated alike, whole words only.
  function nameRegex(name) {
    const parts = String(name).trim().split(/[\s\-]+/).filter(Boolean).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!parts.length) return null;
    return new RegExp('(?<![\\p{L}\\p{N}_])' + parts.join('[\\s\\-]+') + '(?![\\p{L}\\p{N}_])', 'giu');
  }

  /** All [start, end, kind, name] mention spans, longest match wins on overlap. */
  function findMentions(text, brandAliases, competitors) {
    const spans = [];
    const add = (names, kind) => (names || []).forEach(n => {
      const re = nameRegex(n); if (!re) return;
      let m; while ((m = re.exec(text))) spans.push([m.index, m.index + m[0].length, kind, n]);
    });
    add(brandAliases, 'brand'); add(competitors, 'competitor');
    spans.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
    const out = []; let end = -1;
    for (const s of spans) if (s[0] >= end) { out.push(s); end = s[1]; }
    return out;
  }

  /** Escaped HTML with brand mentions in <mark class="m-brand"> and competitors in <mark class="m-comp">. */
  function highlightMentions(text, brandAliases, competitors) {
    const t = String(text == null ? '' : text);
    let html = '', i = 0;
    for (const [start, end, kind] of findMentions(t, brandAliases, competitors)) {
      html += htmlEscape(t.slice(i, start)) + '<mark class="' + (kind === 'brand' ? 'm-brand' : 'm-comp') + '">' + htmlEscape(t.slice(start, end)) + '</mark>';
      i = end;
    }
    return html + htmlEscape(t.slice(i));
  }

  /**
   * Share of voice per topic: of all answers to that topic's questions, how
   * often the brand vs. each competitor is named (once per answer at most).
   * share = brand / (brand + all competitor mentions), null with no mentions.
   * answers: { questionId: [{ text }] }, questions: [{ id, tags }].
   */
  function shareOfVoice(answers, questions, categoryIds, brandAliases, competitors) {
    return categoryIds.map(cat => {
      const counts = { brand: 0 }; (competitors || []).forEach(c => { counts[c] = 0; });
      let n = 0;
      questions.filter(q => (q.tags || []).includes(cat)).forEach(q => (answers[q.id] || []).forEach(a => {
        n++;
        const seen = new Set(findMentions(a.text, brandAliases, competitors).map(s => s[2] === 'brand' ? 'brand' : s[3]));
        seen.forEach(k => { counts[k]++; });
      }));
      const total = Object.values(counts).reduce((x, y) => x + y, 0);
      const top = (competitors || []).map(name => ({ name, count: counts[name] })).filter(c => c.count > 0).sort((a, b) => b.count - a.count);
      return { cat, answers: n, brand: counts.brand, total, share: total ? Math.round(100 * counts.brand / total) : null, top };
    });
  }

  /** True when two 95% intervals overlap, i.e. the change may be noise (D3). */
  const intervalsOverlap = (a, b) => !!a && !!b && a.lo <= b.hi && b.lo <= a.hi;

  return {
    findMentions, highlightMentions, shareOfVoice, intervalsOverlap, textFromMarkdown, extractBlockCandidates,
    parseResult, pct, overlaps, kwHit, scoreDraft, splitFaqText, toFaqJsonLd, toMarkdown, toHtml, htmlEscape,
    QUESTION_TEMPLATES, generateForCategory, generateQuestions, slugify,
    tokenize, buildCorpusStats, idf, bm25Score, rankByRelevance,
  };
});
