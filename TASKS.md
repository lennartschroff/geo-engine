# Task backlog

Granular, checkable work items that implement [ROADMAP.md](ROADMAP.md). Organized as
epics → issues, the way you'd file these as GitHub Issues (one issue per `- [ ]` line
below is a reasonable split if you want to track them there instead).

Legend: **Size** S = under an hour, M = a session, L = multi-session. **Risk** —
how reversible / how much it touches running behavior.

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
- [ ] **C4.** Wire real provider calls into `monitoring/run.py` (currently raises
  `NotImplementedError` outside `--dry-run`, on purpose). Needs: which provider(s)
  (OpenAI/Anthropic/Gemini, one or all three), API keys in `.env`, and a verified
  (not placeholder) pricing table in `cost_estimate.py`.
  **Gate: review cost estimate with you before the first real run.** — *L, medium —
  real API spend, real external calls*
- [ ] **C5.** Export: SQLite → `data/monitoring.json`, point the app at it instead of
  `demo_monitoring.json`. **Gate: you review the generated data before it replaces
  the demo file.** — *S, medium — changes what the live demo shows*
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
  the Tailspin^Hcontoso demo and your own setup without mixing their state
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
- [ ] **F3.** File import: a drag-and-drop/file-picker in the app so the output of
  the local scripts above (crawl results, monitoring runs) loads straight into the
  running app via `FileReader` — no rebuild, no redeploy. Still the real gap between
  "guided to run a command" and "see the result without touching a terminal again."
  — *M, none (client-side file read only)*
- [ ] **F4.** Revisit once C4 exists: document exactly how a new user's own `.env` keys
  flow into `monitoring/run.py`, so "connect your own API, you're ready to go" is a
  literal, tested instruction, not just an architectural claim.

---

## Epic D — Product features (depend on Epic C data)
- [ ] **D1.** Answer viewer: full engine answer text with brand/competitor mentions
  highlighted. — *M*
- [ ] **D2.** Competitor share-of-voice per topic. — *M*
- [ ] **D3.** Trend view with confidence intervals (answers vary run to run — don't
  show single-run noise as a trend). — *M*
- [ ] **D4.** Draft export to Markdown/HTML incl. `FAQPage` JSON-LD. — *S*
- [x] **D5.** `audit_crawl.py` output feeds `page_scores.json` automatically instead of
  the hand-maintained static file. — *M*
- [ ] **D6.** Block extraction suggestions from PDFs/transcripts/blog posts. — *L*

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
  design call, not a mechanical one. Left as a flagged follow-up rather than
  changed without your eyes on it.
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
