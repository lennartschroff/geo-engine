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

  test('"n" means not run, distinct from "a" (checked, absent)', () => {
    assert.deepEqual(CORE.parseResult('c2 n n'), {
      claude: ['cited', 2],
      gpt: ['notrun', 0],
      gemini: ['notrun', 0],
    });
  });

  test('all not run (e.g. a question with no real data for any engine yet)', () => {
    assert.deepEqual(CORE.parseResult('n n n'), {
      claude: ['notrun', 0],
      gpt: ['notrun', 0],
      gemini: ['notrun', 0],
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
    assert.equal(CORE.slugify('Heat Pumps'), 'heat-pumps');
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
  const CAT = { id: 'hp', label_en: 'Heat pumps', label_de: 'Wärmepumpen', keywords: ['heat pumps', 'air source'] };

  test('generates the requested count, each tagged with the category id', () => {
    const out = CORE.generateForCategory(CAT, 4, 0);
    assert.equal(out.length, 4);
    assert.ok(out.every(q => q.categories[0] === 'hp'));
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

describe('tokenize', () => {
  test('lowercases and strips punctuation', () => {
    assert.deepEqual(CORE.tokenize('What is RAG?'), ['what', 'is', 'rag']);
  });

  test('strips accents/diacritics', () => {
    assert.deepEqual(CORE.tokenize('café'), ['cafe']);
  });

  test('drops single-character tokens', () => {
    assert.deepEqual(CORE.tokenize('a b is OK'), ['is', 'ok']);
  });

  test('handles German umlauts', () => {
    assert.deepEqual(CORE.tokenize('Für Künstliche Intelligenz'), ['fur', 'kunstliche', 'intelligenz']);
  });
});

describe('bm25Score / rankByRelevance', () => {
  test('a document containing the query terms outscores one that does not', () => {
    const docs = [
      { id: 'match', text: 'Retrieval-augmented generation combines a language model with search.' },
      { id: 'nomatch', text: 'Our team ran a marathon last weekend for charity.' },
    ];
    const ranked = CORE.rankByRelevance('How do I build a retrieval augmented generation pipeline?', docs);
    assert.equal(ranked[0].id, 'match');
    assert.equal(ranked[0].relevance, 1);
    assert.equal(ranked[1].relevance, 0);
  });

  test('relevance is normalized to [0, 1] relative to the best match in the set', () => {
    const docs = [
      { id: 'a', text: 'red teaming exercise for an LLM agent' },
      { id: 'b', text: 'red teaming exercise for an LLM agent, extended with more context about agents' },
    ];
    const ranked = CORE.rankByRelevance('LLM red teaming exercise', docs);
    ranked.forEach(r => { assert.ok(r.relevance >= 0 && r.relevance <= 1); });
    assert.equal(Math.max(...ranked.map(r => r.relevance)), 1);
  });

  test('a term that appears in every document contributes little (low IDF)', () => {
    // "the" appears everywhere, so it shouldn't be what drives the ranking --
    // the distinctive shared word "rag" should decide it instead.
    const docs = [
      { id: 'rag', text: 'the the the the RAG pipeline the the the' },
      { id: 'other', text: 'the the the the the the the the the' },
    ];
    const ranked = CORE.rankByRelevance('the RAG pipeline', docs);
    assert.equal(ranked[0].id, 'rag');
  });

  test('no overlap at all with any document gives everything 0 relevance', () => {
    const docs = [{ id: 'x', text: 'completely unrelated content about gardening' }];
    const ranked = CORE.rankByRelevance('retrieval augmented generation', docs);
    assert.equal(ranked[0].relevance, 0);
  });

  test('is deterministic: same query and corpus always rank the same way', () => {
    const docs = [{ id: 'a', text: 'alpha beta gamma' }, { id: 'b', text: 'beta gamma delta' }];
    const r1 = CORE.rankByRelevance('beta gamma', docs);
    const r2 = CORE.rankByRelevance('beta gamma', docs);
    assert.deepEqual(r1.map(r => r.id), r2.map(r => r.id));
    assert.deepEqual(r1.map(r => r.relevance), r2.map(r => r.relevance));
  });

  test('empty query gives every document 0 relevance, not an error', () => {
    const docs = [{ id: 'a', text: 'some content' }];
    const ranked = CORE.rankByRelevance('', docs);
    assert.equal(ranked[0].relevance, 0);
  });

  test('empty corpus returns an empty ranking, not an error', () => {
    assert.deepEqual(CORE.rankByRelevance('anything', []), []);
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

describe('findMentions / highlightMentions (D1)', () => {
  test('matches case-insensitively and across hyphen/space, whole words only', () => {
    const spans = CORE.findMentions('Contoso-AI vs contoso ai; ContosoAI no', ['Contoso AI'], []);
    assert.equal(spans.length, 2);
  });
  test('longest match wins on overlap (alias "Contoso" inside "Contoso AI")', () => {
    const spans = CORE.findMentions('Try Contoso AI.', ['Contoso', 'Contoso AI'], []);
    assert.deepEqual(spans.map(s => s[3]), ['Contoso AI']);
  });
  test('escapes HTML and marks brand vs competitor', () => {
    const html = CORE.highlightMentions('<b>Acme</b> & Contoso', ['Contoso'], ['Acme']);
    assert.equal(html, '&lt;b&gt;<mark class="m-comp">Acme</mark>&lt;/b&gt; &amp; <mark class="m-brand">Contoso</mark>');
  });
  test('regex metacharacters in names are literal', () => {
    assert.equal(CORE.findMentions('We use C++ (and C+).', [], ['C++']).length, 1);
  });
});

describe('shareOfVoice (D2)', () => {
  const qs = [{ id: 'q1', tags: ['a'] }, { id: 'q2', tags: ['a', 'b'] }];
  const answers = { q1: [{ text: 'Contoso and Acme' }, { text: 'Acme, Acme, Beta' }], q2: [{ text: 'Contoso Contoso' }] };
  test('counts each name once per answer and computes the brand share', () => {
    const [a, b] = CORE.shareOfVoice(answers, qs, ['a', 'b'], ['Contoso'], ['Acme', 'Beta']);
    assert.equal(a.answers, 3);
    assert.equal(a.brand, 2);
    assert.equal(a.total, 5); // Contoso 2 + Acme 2 + Beta 1
    assert.equal(a.share, 40);
    assert.equal(a.top[0].name, 'Acme');
    assert.equal(b.share, 100);
  });
  test('null share when nothing is mentioned', () => {
    const [c] = CORE.shareOfVoice({ q1: [{ text: 'nothing' }] }, qs, ['a'], ['Contoso'], ['Acme']);
    assert.equal(c.share, null);
  });
});

describe('intervalsOverlap (D3)', () => {
  test('overlapping and disjoint ranges', () => {
    assert.equal(CORE.intervalsOverlap({ lo: 10, hi: 30 }, { lo: 25, hi: 40 }), true);
    assert.equal(CORE.intervalsOverlap({ lo: 10, hi: 20 }, { lo: 25, hi: 40 }), false);
    assert.equal(CORE.intervalsOverlap(null, { lo: 1, hi: 2 }), false);
  });
});

describe('extractBlockCandidates (Library import)', () => {
  const cats = [{ id: 'rag', keywords: ['rag', 'retrieval-augmented generation'] }, { id: 'agents', keywords: ['ki-agent', 'ai agent'] }];
  const types = text => CORE.extractBlockCandidates(text, cats).map(c => c.type);

  test('finds each block type in English text, verbatim', () => {
    const text = [
      'Retrieval-augmented generation is a method that grounds a language model in your own documents.',
      'We have delivered 140 AI projects, and 92% of clients extend their contract.',
      'For a logistics client we reduced support handling time by 38 percent within six months.',
      '"The pilot paid for itself before the second quarter was over", says the CFO of the company.',
      'What does a RAG pilot cost?',
      'A typical pilot takes six to eight weeks and depends on the data sources.',
    ].join('\n\n');
    const c = CORE.extractBlockCandidates(text, cats);
    assert.deepEqual(c.map(x => x.type), ['definition', 'figure', 'case', 'quote', 'faq']);
    assert.ok(c.every(x => text.replace(/\n\n/g, ' ').includes(x.text.split(' – ')[0])));
    assert.deepEqual(c[0].categories, ['rag']);
    assert.equal(c[4].text, 'What does a RAG pilot cost? – A typical pilot takes six to eight weeks and depends on the data sources.');
  });

  test('topic keywords match across hyphens', () => {
    const c = CORE.extractBlockCandidates('Retrieval-augmented generation is a method that grounds a model in your own documents.',
      [{ id: 'rag', keywords: ['retrieval augmented generation'] }, { id: 'agents', keywords: ['ki-agent'] }]);
    assert.deepEqual(c[0].categories, ['rag']);
    assert.deepEqual(CORE.extractBlockCandidates('Ein KI Agent ist ein System, das ein Sprachmodell mit Werkzeugen verbindet.',
      [{ id: 'agents', keywords: ['ki-agent'] }])[0].categories, ['agents']);
  });

  test('German text', () => {
    assert.deepEqual(types('Ein KI-Agent ist ein System, das ein Sprachmodell mit Werkzeugen verbindet.\n\n' +
      'Für eine Kundin senkte das Projekt die Bearbeitungszeit um 40 Prozent im ersten Quartal.'), ['definition', 'case']);
  });

  test('a year alone is not a figure; short fragments are ignored', () => {
    assert.deepEqual(types('Founded in 2011 in Berlin.\n\nWe have worked with banks and insurers since 2011 across Europe.'), ['statement']);
  });

  test('deduplicates and respects the limit', () => {
    const para = 'We have delivered 140 AI projects for clients in twelve countries so far.';
    assert.equal(CORE.extractBlockCandidates([para, para, para].join('\n\n'), cats).length, 1);
    const many = Array.from({ length: 60 }, (_, i) => 'Our team ran ' + (100 + i) + ' workshops with clients in many different industries.').join('\n\n');
    assert.equal(CORE.extractBlockCandidates(many, cats, 25).length, 25);
  });

  test('textFromMarkdown strips syntax but keeps text', () => {
    assert.equal(CORE.textFromMarkdown('# Title\n\n- **Bold** [link](https://x.y) `code`').trim(), 'Title\n\nBold link code');
  });
});

describe('Write: compose, polish prompt, fact check (answer-first articles)', () => {
  const items = [
    { type: 'statement', text: 'Contoso AI is an AI engineering firm in Austin that builds RAG systems.' },
    { type: 'figure', text: 'Contoso pipelines reach production within four to six weeks, with 3 to 8 knowledge sources.' },
    { type: 'case', text: 'In 2024, Contoso analyzed 40,000 support tickets for an insurer within four days.' },
    { type: 'quote', text: '“The pilot paid for itself before the second quarter was over”, says the CFO.' },
    { type: 'faq', text: 'When is RAG worth it? – When the underlying knowledge changes often.' },
  ];
  const names = ['Contoso AI', 'Contoso'];
  const md = CORE.composeArticle(items, 'How do I build a RAG pipeline?', 'en');

  test('compose: question as title, answer first, sections, FAQ, all text verbatim', () => {
    assert.ok(md.startsWith('# How do I build a RAG pipeline?\n\nContoso AI is an AI engineering firm'));
    ['## In figures', '## Example from practice', '> “The pilot', '## Frequently asked questions', '### When is RAG worth it?']
      .forEach(x => assert.ok(md.includes(x), x));
    items.filter(i => i.type !== 'faq').forEach(i => assert.ok(md.includes(i.text)));
    assert.equal(CORE.checkFacts(md, md, names).ok, true);
  });

  test('compose in German uses German headings', () => {
    assert.ok(CORE.composeArticle(items, 'Frage?', 'de').includes('## Häufige Fragen'));
  });

  test('prompt carries the rules and the article', () => {
    const p = CORE.buildPolishPrompt(md, 'en');
    assert.ok(p.includes('Do not add any fact') && p.endsWith(md));
    assert.ok(CORE.buildPolishPrompt(md, 'de').includes('Füge keine Tatsache'));
  });

  test('faithful rewrite passes: reformatted numbers and number words are the same fact', () => {
    const rw = 'Contoso AI builds RAG systems in Austin. Pipelines go live in 4 to 6 weeks using 3 to 8 sources. ' +
      'In 2024 Contoso analyzed 40.000 tickets in four days. "The pilot paid for itself before the second quarter was over", says the CFO.';
    assert.deepEqual(CORE.checkFacts(md, rw, names), { missing: [], added: [], ok: true });
  });

  test('changed number, invented name and altered quote are flagged', () => {
    const rw = 'Contoso AI, backed by NVIDIA, builds RAG systems in Austin. 4 to 6 weeks, 3 to 8 sources. ' +
      'In 2024 Contoso analyzed 45,000 tickets in four days. "The pilot paid for itself quickly", says the CFO.';
    const r = CORE.checkFacts(md, rw, names);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing.map(m => m.kind + ':' + m.value), ['number:40000', 'quote:The pilot paid for itself before the second quarter was over']);
    assert.deepEqual(r.added.map(m => m.kind + ':' + m.value), ['number:45000', 'name:NVIDIA']);
  });

  test('an allowed number (the current year) is not flagged as new', () => {
    const src = 'Contoso has 3 offices.';
    assert.equal(CORE.checkFacts(src, 'As of 2026, Contoso has 3 offices.', [], ['2026']).ok, true);
    assert.equal(CORE.checkFacts(src, 'Since 2019, Contoso has 3 offices.', [], ['2026']).ok, false);
  });

  test('two quotes close together are two quotes, not one', () => {
    const q = CORE.extractFacts('“First quote has five words” – A, X\n\n> “Second quote also has words” – B').quotes;
    assert.deepEqual(q, ['First quote has five words', 'Second quote also has words']);
  });

  test('a dropped block is caught by coverage even without numbers', () => {
    const rw = 'Contoso AI is an engineering firm in Austin building RAG systems.';
    const cov = CORE.blockCoverage(items, rw);
    assert.equal(cov[0].dropped, false);
    assert.equal(cov[4].dropped, true); // the FAQ answer vanished
  });

  test('citability checks', () => {
    const byId = a => Object.fromEntries(CORE.citabilityChecks(a).map(c => [c.id, c]));
    const good = byId(md);
    assert.equal(good.selfContained.ok, true);
    assert.equal(good.headings.ok, true);
    assert.equal(good.dated.ok, true);
    const bad = byId('# T\n\nShort.\n\nIt is great and this is a very long sentence that keeps going and going without any end in sight because nobody edited it at all for the reader, and then it adds even more clauses, commas and side remarks before it finally stops.');
    assert.equal(bad.answerFirst.ok, false);
    assert.equal(bad.selfContained.ok, false);
    assert.equal(bad.sentenceLength.ok, false);
    assert.equal(bad.dated.ok, false);
  });

  test('mdToHtml renders the article shapes and escapes HTML', () => {
    assert.equal(CORE.mdToHtml('# T\n\n## H\n\nA <b> **bold**\n\n> Q'),
      '<h1>T</h1>\n<h2>H</h2>\n<p>A &lt;b&gt; <strong>bold</strong></p>\n<blockquote><p>Q</p></blockquote>');
  });
});

describe('article HTML export', () => {
  const md = '# Why RAG?\n\nAnswer first.\n\n## Frequently asked questions\n\n### What does it cost?\n\nA pilot takes six weeks.\n\n### Not a question\n\nText.';
  test('faqFromMarkdown takes ### questions with their answer paragraph', () => {
    assert.deepEqual(CORE.faqFromMarkdown(md), [{ question: 'What does it cost?', answer: 'A pilot takes six weeks.' }]);
  });
  test('articleToHtml: title, lang, JSON-LD from the visible FAQ, script-safe', () => {
    const html = CORE.articleToHtml(md.replace('six weeks', 'six weeks </script>'), 'de');
    assert.ok(html.includes('<html lang="de">') && html.includes('<title>Why RAG?</title>'));
    assert.ok(html.includes('"@type":"FAQPage"') && html.includes('\\u003c/script>'));
    assert.equal((html.match(/<\/script>/g) || []).length, 1);
  });
  test('no FAQ, no JSON-LD', () => {
    assert.ok(!CORE.articleToHtml('# T\n\nText.', 'en').includes('ld+json'));
  });
});
