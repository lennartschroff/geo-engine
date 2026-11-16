# Roadmap

The prototype covers the full user journey with demo data. These are the steps to turn it into a production-grade tool, roughly in order of impact.

## Milestone 1: Real data pipeline (core value)

- [ ] **Monitoring CLI** (`monitoring/run.py`): send the key questions to OpenAI, Anthropic and Gemini with web search enabled, 3 runs per question, and store `question_id, engine, model, run_index, timestamp, language, mentioned, position, cited_urls, answer_text` in SQLite.
- [ ] **Mention detection**: match brand aliases from `data/brand.json`, extract rank among named providers, and normalize cited URLs to domains.
- [ ] **Cost guard**: estimate tokens and cost before a run, require `--yes` above a threshold, and cap with `--max-calls`.
- [ ] **Dry-run / mock mode** with recorded fixtures so the pipeline can be tested without API keys.
- [ ] **Export** `monitoring/runs.sqlite` → `data/monitoring.json` and load it in the app instead of `demo_monitoring.json`.
- [ ] **Scheduling**: weekly GitHub Action (keys as encrypted repository secrets) or a local cron job.

## Milestone 2: Quality & engineering

- [ ] Unit tests for scoring, gap ranking and mention detection (`pytest`, plus a small JS test runner).
- [ ] JSON Schema for every file in `data/`, validated in CI.
- [ ] Linting and formatting: `ruff` for Python, `eslint`/`prettier` for JS.
- [ ] CI workflow: lint, test and build on every pull request.
- [ ] Accessibility pass (keyboard-only drag & drop alternative, contrast check).

## Milestone 3: Product features

- [ ] **Answer viewer**: show the full engine answer and highlight brand and competitor mentions.
- [ ] **Competitor tracking**: share of voice per competitor and topic.
- [ ] **Trend view from real runs** with confidence intervals (answers vary between runs).
- [ ] **Draft export** to Markdown / HTML including FAQPage JSON-LD.
- [ ] **AI-assisted drafting**: turn a block sequence into a readable text (local script, keys stay server-side).
- [ ] **Audit → app**: load `crawl-*.json` and compute page scores automatically instead of shipping them as static data.
- [ ] **Block extraction**: suggest new content blocks from PDFs, transcripts and blog posts.

## Milestone 4: Presentation

- [ ] Short screen recording / GIF of the draft studio in the README.
- [ ] Case-study write-up: the problem, approach, scoring rationale and learnings.
- [ ] Optional: hosted backend (e.g. FastAPI + SQLite) with authentication, for team use.

## Known limitations

- API answers are not identical to what users see in the consumer apps.
- The GEO score and page score are heuristics, not validated measures.
- Answers vary between runs, so only rates and trends are meaningful, not single results.
