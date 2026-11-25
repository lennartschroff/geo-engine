# Task backlog

Granular, checkable work items that implement [ROADMAP.md](ROADMAP.md). Organized as
epics → issues, the way you'd file these as GitHub Issues (one issue per `- [ ]` line
below is a reasonable split if you want to track them there instead).

Legend: **Size** S = under an hour, M = a session, L = multi-session. **Risk** —
how reversible / how much it touches running behavior.

---

## Next session — pick up here

Left off 2026-11-25. First real use (DoppelErnte GmbH, a company the owner checked out of
interest, Claude only, 20 German questions from 4 personas) showed that the numbers are
there but the conclusions had to be pulled out by hand: no engine names the brand for
farmers, Claude reads doppelernte.de in 8 answers but names the company in 2, and the
most-cited source (Feldwerke) was missing from the competitor list. **Epic I** turns
those into features. Suggested order: I1 → I2 → I3 → I4 → I5, then I11 → I6 → I7.

### Previous session notes (2026-11-19)

Left off 2026-11-19. C5a done (`45ca45e`): `COMPETITOR_NAMES` moved to
`data/competitors.json`, schema-validated, cross-checked against brand aliases.
Same pass also fixed a real bug found by audit: `run.py` only committed to
SQLite once at the end of a run and only warned (didn't exclude) engines that
still raise `NotImplementedError` — so a real run could pay for `claude` calls
and then lose them all when `gpt` crashed the process. Now commits per row and
drops unimplemented engines before the cost estimate. In priority order:

1. **C6 — weekly schedule.** GitHub Action on a cron, API keys as encrypted repo
   secrets, so monitoring runs on its own instead of only when triggered by hand.
   **Needs your explicit go-ahead on cadence/cost before I add it** — recurring
   real spend.
2. **C4b follow-up decision needed from you:** Gemini's Google Search grounding
   returned a billing-gated 429 on your free-tier key (confirmed twice, see C4b
   notes below) — plain generation works, grounded citations don't. Decide: attach
   billing to unlock grounding, or leave Gemini on plain-generation-only / skip it
   in real runs for now. Nothing to build either way until you decide.
3. **`gpt` engine** — not started. Same pattern as `call_claude()`/`call_gemini()`,
   same cost-estimate gate before first real spend.
4. Explicitly declined for now: connecting Gemini to the webcrawler/topic-suggestion
   feature — not worth building since it wouldn't add anything the free (BM25 /
   heading-heuristic) path doesn't already cover.

---

## Epic I — Insights, several companies, reports (2026-11-25)
Goal: the app says what to do next, works for someone checking several companies, and
produces something to hand over. Everything here runs in the browser with data that is
already stored; nothing below makes extra API calls unless it says so.

**Insights from existing results**
- [x] **I1. Visibility per persona.** Overview tile and a table: named / asked per persona
  (e.g. "Farmers 0 of 5"), with language. Questions page: filter and chip per persona.
  Questions without a persona (older setups) go under "Without a group". — *S*
- [x] **I2. "Used, but not named."** Answers that cite the brand's own domain but don't
  name the brand. Count on the Overview, flag in the question drawer and on Sources
  ("doppelernte.de: cited in 8 answers, brand named in 2"). — *S*
- [x] **I3. Missed competitors.** Suggest names that appear in several answers but are
  neither the brand nor a listed competitor: bold list headings (`**Name**`), names with
  a legal form (GmbH, AG, …) and the most-cited domains. One click adds a competitor and
  recounts all stored answers (`redetect`). No AI call. — *M*
- [x] **I4. "What stands out" panel** on the Overview: the 3–5 strongest findings from
  I1–I3 plus the dominant cited sources and the weakest topic, in plain language, each
  with one action button. Rules in `core.js` with tests, wording in `i18n.js`. — *M*,
  depends on I1–I3
- [x] **I5. Write from a finding.** "Write about this" opens the brief with the question,
  a short summary of what the assistants answer today, the sources they cite and the
  competitors they name, so the draft answers the real gap. — *M*, depends on I4

**Several companies and handing results over**
- [x] **I6. Several companies side by side.** Store each company under its own id,
  switcher in the sidebar, "Add company" next to "Start over". Migrate today's single
  company without loss (test the migration with a stored copy first). Keys stay shared.
  — *M/L*, risk: storage migration
- [x] **I7. Report.** A print view (browser "Save as PDF") in EN/DE: summary, per-persona
  table, open gaps, top sources, missed competitors, next steps. No server, so no share
  link; the PDF is what gets passed on. — *M*, best after I4
- [x] **I11. Backup.** "Save as file" / "Load file" for a company's data (never the keys).
  Needed before I6 so a failed migration can be undone. — *S*

- [x] **I13. AI draft for an own brand.** (Done 2026-11-25: blocks straight into the studio, unknown facts as placeholders, own blocks editable in place.) The studio starts empty for a new company (no
  blocks yet). Offer "Write a first draft" with the visitor's key: the question, today's
  answers and sources, and `[placeholder]` wherever a fact about the company is unknown;
  never invent figures. — *M*, one API call per draft (shown first)

**Measuring more reliably**
- [ ] **I8. Repeat each question 1–3 times** (deferred 2026-11-25: triples the cost per check and needs results that count "2 of 3" in both the app and the Python export; revisit after a few weeks of single runs) per check (setting, default 1). Show "named in
  2 of 3 answers" instead of yes/no; cost estimate updates before starting. — *M*, more
  API calls per check (shown first)
- [x] **I9. Check-again reminder.** When the app opens 7+ days after the last check, a
  banner offers "Check again" so a weekly history builds up. — *S*
- [x] **I10. Nudge to a second assistant.** After the first check with one assistant,
  suggest connecting Gemini (free) so results are not one engine's view. — *S*

**Chores**
- [x] **I12.** Move `ci.yml` and `monitoring.yml` to the current action versions
  (`checkout@v7`, `setup-python@v7`), like `pages.yml`, before GitHub drops Node 20. — *S*

---

## Epic H — Question Radar (exploring, branch `radar`, 2026-11-23)
Concept and reasoning: [docs/QUESTION_RADAR.md](docs/QUESTION_RADAR.md). Status 2026-11-23: built end to end
(collect → score → probe → export → app Radar page → weekly Action). Open: H5 events need sourced dates;
first real Claude probe (~$0.25 for 5) awaits approval; Gemini free-tier probe hit 503 twice; doc needs a refresh.
- [x] **H1.** Store the engines' own web search queries per answer (`search_queries`
  column). Claude from `server_tool_use` blocks (documented shape); ChatGPT from
  `web_search_call` items (documented shape, mocked tests only — check on the first real
  run). Gemini: none while grounding is off. — *S*, no extra cost
- [x] **H2.** `monitoring/radar.py`: merge and count those queries, mark the ones no
  tracked question covers. Terminal table or `--json`. — *S*, no API calls
- [x] **H3.** Export radar candidates into `app/data.js` and show them (Monitor → Radar,
  or a section on Questions; owner decides). "Add to run list" button. — *M*
- [x] **H4.** Weak-answer test: one call per candidate per engine, score how open the
  slot is (no named providers, hedging, few sources). **Show the cost estimate and ask
  before the first real run.** — *M*
- [ ] **H5.** Future events list (`events.json`: date, topic, expected questions), entered
  by hand, feeding candidates N weeks ahead. — *S*
- [x] **H6.** Community/search momentum sources (Reddit, GitHub, Stack Overflow, Trends).
  Public posts only, store question text without usernames. — *L*
- [x] **H7.** Radar score (momentum 30, spread 20, open slot 30, fit 20) and a hit-rate
  report once there are 8+ weeks of runs. — *M*

---

## Epic G — Real monitoring of this project (2026-11-19)
- [x] **G1.** Name kept as "GEO Engine" (alternatives checked, user chose to keep it).
- [x] **G2.** `targets/geo-engine/`: brand (aliases "GEO Engine", "lennartschroff/geo-engine";
  cited = links to lennartschroff.github.io), 15 real EN/DE questions, 4 topics, competitors
  Peec, Otterly, Scrunch, AthenaHQ, Promptwatch, Mentionary (names only; Profound left out,
  ordinary word). Validated by `validate_data.py`.
- [x] **G3.** `run.py`/`export_monitoring.py` read the target from settings (`--target` overrides);
  export carries a `setup` section; the setup wizard loads it in one step.
- [ ] **G4.** "GEO Engine" is a generic phrase: after the first real runs, read the flagged
  mentions in the answer viewer and check for false matches.
- [ ] **G5.** Content: turn README/case study into Library blocks and publish a few
  answer-first articles (Write tab) on the GitHub Pages site, then watch the trend.

---

## Epic A — CI & safety nets
*Goal: make it hard to break the app without noticing. No behavior change.*

- [x] **A1.** Add `ci.yml`: run `scripts/build_web_data.py` on every `pull_request`, fail
  the check if `app/data.js` would differ from what's committed (catches "forgot to
  rebuild"). — *Size S, Risk: none (new workflow only)*
- [x] **A2.** Add a `scripts/check.sh` pre-push helper: rebuild data, run gitleaks if
  installed, print a go/no-go summary. Document it in `README.md`. — *S, none*
- [x] **A3.** Write JSON Schema for `brand.json`, `categories.json`, `questions.json`,
  `blocks.json`, `audit_actions.json`, `page_scores.json`, `demo_monitoring.json`.
  Validate in `ci.yml` with `jsonschema` (Python) or `ajv` (JS). — *M, none — pure
  validation, doesn't touch app logic*

**Acceptance for Epic A:** opening a PR that breaks a data file or forgets to rebuild
`data.js` shows a red check, before merge.

---

## Epic B — Engineering hygiene
*Goal: catch regressions in the logic that already exists.*

- [x] **B1.** `ruff` config + CI step for `scripts/*.py`. — *S, none*
- [x] **B2. Decided: not doing this.** Adding ESLint/Prettier means adding a Node/npm
  dev toolchain (package.json, node_modules, a lockfile) to a project whose explicit
  design decision is "zero dependencies, no build tooling" (README.md). The
  project already has lint-equivalent safety nets without that cost: `node --check`
  for syntax, `node --test` for behavior, and manual review on every app.js diff.
  Revisit only if app.js grows enough that style drift becomes a real problem —
  it hasn't yet at ~550 lines.
- [x] **B3.** Unit tests (pure functions, no DOM): GEO score calculation, gap ranking,
  `parseResult` mention-status parser — extract them from `app.js` into a small
  testable module if needed, or test via a headless JS runner (`node --test` is
  enough, no framework required). — *M, low*
- [x] **B4.** Unit tests for `audit_crawl.py`: `schema_types()`, `RELATIVE_TIME`,
  `FIGURE` regex, against fixture HTML snippets (`pytest`). — *M, low*
- [x] **B5.** Pin `requirements.txt` to exact versions (`requests==`, `beautifulsoup4==`,
  `lxml==`) instead of `>=`, so a future release can't silently change audit output.
  — *S, none*

**Acceptance for Epic B:** `pytest` and a JS test command both exist, run in CI, and
pass. Lint is clean.

---

## Epic C — Real monitoring pipeline (the core value gap)
*Goal: replace `demo_monitoring.json` with real data. Touches money (API calls) —
each task below gets its own PR and its own review before running against real keys.*

- [x] **C1.** Dry-run/mock mode: `monitoring/fixtures/sample_answers.json` +
  `monitoring/run.py --dry-run` exercises question selection, mention detection and
  the SQLite writer end to end at zero cost. Verified in CI.
- [x] **C2.** Mention detection: `monitoring/mention_detection.py` — matches
  `brand.json` aliases case-insensitively (and across hyphen/space variants),
  ranks the brand among named competitors by first-mention order, normalizes cited
  URLs to bare domains. 21 unit tests in `tests/test_mention_detection.py`.
- [x] **C3.** Cost estimator: `monitoring/cost_estimate.py` — `estimate_cost()`,
  `check_call_budget()` (`--max-calls`), `needs_confirmation()` (`--yes` threshold),
  wired into `run.py`. Per-token prices are explicitly marked `[placeholder]` —
  **verify against each provider's current pricing page before trusting a dollar
  figure from this in a real run.** 11 unit tests in `tests/test_cost_estimate.py`.
- [x] **C4a. `claude` engine: done and verified with real spend.**
  `monitoring/run.py`'s `call_claude()` calls `claude-sonnet-5` with the
  `web_search_20250305` tool, reading `ANTHROPIC_API_KEY` from a local `.env`.
  Verified against real questions from `data/questions.json`: real web
  searches ran, real citations extracted, mention detection correctly
  reported "not mentioned" (Contoso AI is fictional — a true negative, not a
  failure). Two real bugs found and fixed by that real test, not by unit
  tests: (1) Sonnet 5 runs "thinking" by default and thinking tokens are
  billed as output even though hidden — now explicitly disabled
  (`thinking={"type":"disabled"}`); (2) `DEFAULT_INPUT_TOKENS` was off by
  ~55x (400 vs a measured 22,250 for a 2-search call, dominated by search
  result content loaded into context) — corrected to 15000 in
  `cost_estimate.py`, with the real measurement documented inline.
  The DB's `language` column (was always `NULL`) is now filled via a small
  heuristic (`detect_language()` — umlauts/common DE words) — 100% correct
  against all 50 real questions in `data/questions.json`, not a real
  language detector but good enough for this deliberately mixed-language set.
- [x] **C4b. `gemini` engine: implemented, verified against a real free-tier
  key — grounded search is billing-gated, plain generation works.**
  `monitoring/run.py`'s `call_gemini()` calls `gemini-3.5-flash-lite` via the
  `google-genai` SDK's `client.interactions.create()`, with
  `tools=[{"type": "google_search"}]` for grounding, reading `GEMINI_API_KEY`
  from `.env`. Real findings, not from docs: (1) a plain (non-grounded) call
  to this model with this key succeeded and returned a correct, coherent
  answer; (2) the exact same call with Google Search grounding enabled
  returned HTTP 429 `too_many_requests` immediately, and again after a 60s
  wait — the error body explicitly says "check your plan and billing
  details," confirming free-tier Google Search grounding is billing-gated,
  not a transient rate limit. `call_gemini()` catches this and re-raises a
  clear `RuntimeError` naming the cause instead of a bare SDK traceback. The
  citation-extraction code (walking `interaction.steps` →
  `model_output`/`text` blocks → `.annotations` for `url_citation`) is
  implemented per the SDK's documented response shape but has not been
  exercised against a real successful grounded response, since grounding
  never succeeded in testing — covered instead by 6 unit tests in
  `tests/test_run.py::TestCallGemini` that mock the client and pin down the
  429 handling, the citation walk, and the defensive `getattr` fallbacks
  (missing `.steps`, empty `.annotations`). A real packaging bug was found
  and fixed along the way: installing `google-genai` pulled in `cryptography`
  (via `google-auth`) without a prebuilt wheel for this Python/platform
  combo, so pip tried to build it from source via Rust/maturin and failed;
  pinned `cryptography==48.0.1` (has a universal2 macOS wheel) in
  `requirements.txt` — verified the fix with a clean
  `pip install -r requirements.txt` after. `gpt` still raises
  `NotImplementedError` outside `--dry-run` — not started.
  **Gate: review cost estimate with you before the first real run.** —
  *L, medium — real API spend, real external calls*
- [x] **C5. Export + load done (`efe4fd8`); see F3b for the loader.** Remaining gate below is a decision, not code.
  Original note: C4a proved real API calls work and
  write real results to `monitoring/runs.sqlite` — but nothing reads that file
  into the app yet. Right now a real monitoring run is a dead end: the data
  exists, correctly, and is completely invisible in the UI. Export:
  SQLite → `data/monitoring.json`, point the app at it instead of
  `demo_monitoring.json`. **Gate: you review the generated data before it
  replaces the demo file.** — *S, medium — changes what the live demo shows*
- [x] **C5a.** `COMPETITOR_NAMES` moved out of `run.py` into `data/competitors.json`
  (schema-validated, `validate_data.py` rejects a name that collides with a brand
  alias). Still ships with the fictional demo placeholder names — replace them with
  your real brand's real competitors before a real run; nothing fabricated here,
  just made configurable instead of hardcoded. Found and fixed along the way: a real
  run only committed to SQLite once at the very end and didn't exclude engines that
  still raise `NotImplementedError`, so a real run could pay for `claude` calls and
  then lose all of them when `gpt` crashed the process. Now commits per row and
  drops unimplemented engines before the cost estimate.
- [ ] **C6.** Weekly schedule: GitHub Action with API keys as encrypted repo secrets.
  **Gate: you add the secrets yourself in Settings; I never see the keys.** — *M,
  medium — recurring spend, needs your explicit go-ahead on the cadence/cost*

**Acceptance for Epic C:** the Overview/Questions/Sources tabs show real engine
results, refreshed weekly, and you've approved the cost before every real run.

---

## Epic F — Self-service onboarding (any company, zero cost to you)
*Goal: lower the barrier from "hand-edit 3 JSON files" to a guided, zero-cost path —
every user brings their own API key for anything that costs money, never yours.*

- [x] **F1.** `scripts/generate_questions.py`: template-based starter `questions.json`
  from a hand-authored `categories.json`. Zero cost, no API key, deterministic
  output. 7 unit tests. Explicitly the "free templates" option, not an LLM-assisted
  generator — chosen over the alternatives for simplicity and zero cost to everyone.
- [x] **F2.** Onboarding wizard — built **in the app itself** (`app/app.js`: Welcome
  screen -> Setup wizard -> live app), not as a CLI script. Pivoted from the original
  plan because the actual ask was "help the user move through the platform," not
  "give them another terminal command." Brand + topics entered in the browser,
  starter questions generated instantly client-side (`CORE.generateQuestions`, the
  same logic as `generate_questions.py`, zero cost, no API key). Stored in
  localStorage only; a Demo / [your brand] toggle in the header switches between
  the Contoso demo and your own setup without mixing their state
  (`geo-engine:v1:<mode>` namespacing). Smoke-tested across 4 scenarios (first
  visit, demo, setup-pending, own-brand-populated).
- [x] **F2b.** In-browser content-block authoring (Library tab): add a block
  (type + text + topics) with zero backend, zero API key — closes the one real gap
  where "own brand" mode had literally no way to add content without hand-editing
  JSON. Merges with the bundled blocks via `allBlocksList()`, same localStorage
  pattern as custom questions.
- [x] **F2c.** Guided empty states: Website/Sources/Impact show the exact local
  command to run (`audit_crawl.py`, `score_pages.py`, `monitoring/run.py --dry-run`)
  instead of a bare "no data" message, when in own-brand mode with nothing loaded yet.
- [x] **F2d.** "Getting Started" checklist replaces the Overview dashboard right
  after setup, instead of landing on a confusing "0% everywhere" chart with nothing
  to show yet. 4 steps (brand done, add a block, audit your site, check visibility),
  each linking to the right tab. Reverts to the normal Overview automatically once
  any real data exists (`allBlocksList().length` / `D.audit`/`D.pages` /
  `D.demo.results` all empty is the only trigger) — verified it's not a permanent
  extra screen via a smoke-test scenario that adds one block and checks the
  checklist is gone.
- [x] **F2e.** Design pass: removed all emoji (Welcome screen, "Edit setup" link) —
  replaced with small inline-SVG line icons (`iconEye`, `iconSliders`, `iconGear`,
  `iconGrid`, `iconCheck`, `iconCircle`) matching the app's existing monochrome
  visual language instead of introducing a generic "AI chatbot" look. Added icons
  to the 3 main nav tabs for scannability. Fixed a responsive bug: `.right` in the
  header (mode toggle + edit-setup link + language toggle) had no `flex-wrap`, so
  at medium window widths it overflowed/squeezed instead of wrapping — this is
  what "looks weird when the screen isn't full width" was.
- [x] **F2f.** Replaced the setup wizard's placeholder example ("Acme Robotics" —
  too narrow/unclear a niche) with "Lighthouse Marketing", a generic B2B-services
  example anyone filling the form can immediately map to their own company.
- [x] **F3a.** `scripts/suggest_topics.py` + a file-picker in the Setup wizard:
  turns a real site crawl's H2/H3 headings into candidate topics (frequency-
  ranked, boilerplate headings like Contact/Imprint/Privacy filtered, EN+DE),
  loaded into the wizard via `FileReader` (no network call from the app — the
  crawl itself runs locally via `audit_crawl.py`, which the app can't do itself
  since its CSP blocks all network calls). 11 unit tests. This was explicitly
  requested as "autofill topics from my website" — the honest version of that,
  given the app has no network access by design.
- [x] **F3b (done 2026-11-19: monitoring, page scores and audit findings).** `scripts/audit_findings.py` turns a crawl
  plus the new `data/site-checks-<date>.json` into prioritized findings (crawler access, robots.txt, llms.txt,
  Organization/FAQ schema, H1, relative dates, figures, thin pages, meta descriptions, stale articles, broken
  URLs), counts and example URLs only. Loaded via the same Website file picker. Original note:
  "Load monitoring results" on Sources (loads `scripts/export_monitoring.py`'s
  output into `own.demo` — this is also C5, see Epic C) and "Already ran a real
  crawl?" on Website (loads `scripts/score_pages.py`'s output into `own.pages`)
  are both built, same `FileReader` pattern as F3a. **Still missing:** no script
  generates audit findings (`own.audit`, the a1-a10-style list) yet, so Website's
  action-items section stays empty in own-brand mode even after loading page
  scores — nothing to load there until such a script exists.
- [x] **F4.** README "Run real monitoring": which key per engine, what's free (Gemini
  without grounding), local run, scheduled run with repo secrets. Tested end to end:
  `tests/test_run.py::TestKeysFlowFromDotenv` (a key in `.env` enables that engine,
  engines without a key are skipped).

---

## Epic D — Product features (depend on Epic C data)
- [x] **D1.** Answer viewer: Questions tab -> "Answers (n)" under a question shows each
  engine's latest answer (and the rephrased variant prompt) with brand/competitor
  mentions highlighted. Data from `export_monitoring.py` (`answers`); demo has 4
  hand-written fictional answers, labelled as such.
- [x] **D2.** Share of voice per topic on Sources: brand mentions / all brand+competitor
  mentions, once per answer (`CORE.shareOfVoice`). Export now also fills the
  `competitor` field (was always null).
- [x] **D3.** Export writes weekly mention rate with a 95% Wilson interval
  (`trend_ci`); Impact draws the range on each bar and says "within normal
  variation" when the last two weeks' ranges overlap.
- [x] **D4.** Draft export to Markdown/HTML incl. `FAQPage` JSON-LD. Already shipped in
  `400c030` (Write tab -> copy Markdown / copy HTML); this box was just never ticked.
- [x] **D5.** `audit_crawl.py` output feeds `page_scores.json` automatically instead of
  the hand-maintained static file. — *M*
- [x] **D7.** Blocks -> readable article (2026-11-19): compose (no AI), polish in the user's
  own AI chat via a copied prompt, then a client-side fact check (numbers, names, quotes,
  dropped blocks) and readability checks gate the export. Tested with an honest rewrite (no
  false alarms) and a manipulated one (changed number, invented name both flagged). Possible
  next step: optional `scripts/polish_draft.py` with a Gemini free-tier key (note: free-tier
  inputs may be used by Google, so not for unpublished client material).
- [x] **D6.** Library import (2026-11-19): paste text or load .txt/.md/.html in the app,
  get verbatim block suggestions (`CORE.extractBlockCandidates`), review each one (type,
  topic, edit, accept/reject); accepted blocks keep their source file name. Word/PDF via
  `scripts/extract_text.py` (.docx stdlib; .pdf needs optional `pypdf`, not installed
  here -- PDF path is tested against a mocked pypdf only).

---

## Epic E — Polish (any time, no dependencies)
- [x] **E0.** Navigation IA: collapsed 7 flat top-level tabs into Overview + 2 groups
  (Monitor: Questions/Sources/Impact · Improve: Website/Library/Write), each with a
  second-level tab row. Requested directly, not originally in this backlog.
- [x] **E1.** Accessibility pass. Keyboard equivalent to drag-and-drop already existed
  (reorder via ↑/↓/×, add via a plain button, all with aria-labels). Added: an explicit
  `:focus-visible` outline (`app/styles.css`) instead of relying on each browser's
  inconsistent default — every interactive element now gets the same high-contrast
  ring. Ran the actual WCAG AA contrast numbers: `--fg`, `--fg2`, `--muted`, `--warn`,
  `--accent`, `--amber` all pass (5:1+) against white. **Known gap, not fixed:**
  `--faint` (#9A9DA5) is 2.71:1 — fails AA even for large text. It's used for
  de-emphasized text (empty-state dashes, "weak match" labels) — fixing it means
  picking a new color and reviewing the visual hierarchy it's part of, which is a
  design call, not a mechanical one. **Fixed 2026-11-19 (you asked for "make
  everything accessible"):** `--faint` text now uses the muted tone (5.0:1);
  a separate `--graphic` (#8A877F, 3.6:1) for non-text marks. Same pass: focus
  no longer jumps to the page top after every button press (whole-app
  re-render dropped it), skip link, `aria-current` on tabs, `aria-pressed` on
  the mode switch, labels on setup topic inputs, one `h1` per view, "Close
  now" badge contrast (4.45 -> AA). Verified with a headless-Chrome audit of
  every tab in EN+DE plus Welcome/Setup: 0 contrast failures, 0 unnamed
  controls, 0 console errors.
  — *M*
- [ ] **E2.** Short screen recording/GIF of the draft studio for the README. — *S*
- [x] **E3.** Case-study write-up: `docs/CASE_STUDY.md`, linked from README.md.

---

## Working agreement
- Each box becomes its own small PR/diff — reviewed by you before merge, as we've
  been doing.
- Anything in **Epic C** that spends real API money gets its cost estimate shown to
  you first, per `CLAUDE.md`'s own rule ("Estimate API cost before runs with many
  calls and ask before running").
- Order: **A → B → C1–C3 → (your go-ahead) → C4–C6 → D → E**. Nothing stops you from
  skipping ahead to a D/E item you want sooner — the dependencies noted above are the
  only hard ones.
