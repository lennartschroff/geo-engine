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
- [ ] **A2.** Add a `scripts/check.sh` pre-push helper: rebuild data, run gitleaks if
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
- [ ] **B2.** `eslint` + `prettier` config + CI step for `app/*.js`. Decide rules once,
  apply `--fix` once, commit as its own PR so it doesn't mix with feature diffs.
  — *M, low — pure formatting/lint, no logic change*
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

- [ ] **C1.** Dry-run/mock mode: recorded fixture responses for each engine, so C2-C5
  can be built and tested with **zero API spend**. Build this first. — *M, none (no
  real calls)*
- [ ] **C2.** Mention detection: match `brand.json` aliases (case/diacritic-insensitive),
  extract rank among named providers, normalize cited URLs to bare domains. Pure
  logic — unit test against the fixtures from C1. — *M, none*
- [ ] **C3.** Cost estimator: token-count the 15 key questions × 3 engines × 3 runs,
  print projected cost, require `--yes` above a configurable threshold, hard-cap with
  `--max-calls`. — *S, none (guard logic only)*
- [ ] **C4.** `monitoring/run.py`: wires C1–C3 together, calls OpenAI/Anthropic/Gemini
  with web search enabled, writes `question_id, engine, model, run_index, timestamp,
  language, mentioned, position, cited_urls, answer_text` to SQLite.
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

## Epic D — Product features (depend on Epic C data)
- [ ] **D1.** Answer viewer: full engine answer text with brand/competitor mentions
  highlighted. — *M*
- [ ] **D2.** Competitor share-of-voice per topic. — *M*
- [ ] **D3.** Trend view with confidence intervals (answers vary run to run — don't
  show single-run noise as a trend). — *M*
- [ ] **D4.** Draft export to Markdown/HTML incl. `FAQPage` JSON-LD. — *S*
- [ ] **D5.** `audit_crawl.py` output feeds `page_scores.json` automatically instead of
  the hand-maintained static file. — *M*
- [ ] **D6.** Block extraction suggestions from PDFs/transcripts/blog posts. — *L*

---

## Epic E — Polish (any time, no dependencies)
- [x] **E0.** Navigation IA: collapsed 7 flat top-level tabs into Overview + 2 groups
  (Monitor: Questions/Sources/Impact · Improve: Website/Library/Write), each with a
  second-level tab row. Requested directly, not originally in this backlog.
- [ ] **E1.** Accessibility pass on the drag-and-drop draft studio: keyboard-only
  alternative, contrast check against WCAG AA. *Partial check done: reorder (↑/↓/×)
  and add-to-draft are already plain buttons with aria-labels, so keyboard users have
  a full equivalent to drag-and-drop already — a real contrast/focus-visibility audit
  is still open.* — *M*
- [ ] **E2.** Short screen recording/GIF of the draft studio for the README. — *S*
- [ ] **E3.** Case-study write-up: problem, approach, scoring rationale, learnings.
  — *S*

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
