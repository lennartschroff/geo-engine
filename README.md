# GEO Engine

**See how AI assistants talk about your brand, then fill the gaps with content they can cite.**

When people ask ChatGPT, Claude or Gemini *"Which agencies are good at X?"*, the answer is the new search result. GEO Engine is a working prototype for **generative engine optimization (GEO)**. It tracks whether a brand appears in those answers, shows which sources the engines rely on, and helps a marketing team put together content that closes the gaps.

> **Live demo:** https://lennartschroff.github.io/geo-engine/
> All data in the demo belongs to *Contoso AI*, a **fictional** AI engineering & advisory firm (the classic placeholder-company name used across Microsoft's own docs). The first screen you'll see offers a choice: browse that demo, or set up your own brand — entirely in your browser, nothing sent anywhere.

## What it does

| Area | What you get |
|---|---|
| **Overview** | Share of key questions where the brand is mentioned, broken down by engine and topic, plus the biggest gaps |
| **Questions** | 50 tracked prompts (15 weekly "key" questions) with status per engine: *cited*, *mentioned* or *missing*. You can add your own |
| **Sources** | Which domains the engines cite and whether the brand shows up there. This becomes a target list for PR and listings |
| **Website** | Audit of your own site: AI crawler access, structured data, FAQ structure, citable figures, stale time references |
| **Impact** | Visibility trend over time, with published content marked so you can see what moved the needle |
| **Library** | Reusable, citable content blocks (statements, definitions, figures, cases, quotes, FAQs) tagged by topic |
| **Write** | Pick a gap, drag blocks into a draft and get a live **GEO score** (0–100) with concrete tips |

### The GEO score

Each draft is checked against seven criteria that make content more likely to be picked up and cited by LLMs:

| Criterion | Weight |
|---|---|
| Opens with a direct answer (statement or definition) | 20 |
| Contains a verifiable figure | 20 |
| Contains a case example | 15 |
| Contains a named expert quote | 15 |
| Contains an FAQ block | 10 |
| Blocks match the target question (≥ 60 %) | 10 |
| 3–7 blocks: substantial but focused | 10 |

The weights are a heuristic based on published GEO research and practitioner guidance. They have not been validated, and the point of making them explicit is that they can be argued with.

## Architecture

```
data/        JSON source of truth: brand, topics, questions, content blocks, audit, demo results
app/         Static web app (vanilla JS, no framework, no build tooling)
scripts/     build_web_data.py  → bundles data/*.json into app/data.js
             audit_crawl.py     → crawls a website's sitemap and extracts GEO signals
             score_pages.py     → turns a crawl into data/page_scores.json
             suggest_topics.py  → turns a crawl's headings into candidate topics for the Setup wizard
monitoring/  run.py             → sends tracked questions to the engines, writes SQLite
             (real provider calls not wired in yet — --dry-run uses recorded fixtures;
             see TASKS.md Epic C)
```

Design decisions:

- **No backend, no API keys in the browser.** The web app is a static site with a strict Content Security Policy (`connect-src 'none'`), so it cannot make any network requests at all. Anything that talks to an LLM API runs as a local Python script and reads its keys from `.env`.
- **Zero dependencies in the frontend.** It opens straight from disk (`file://`) or from any static host.
- **Brand-agnostic.** Change `data/brand.json` and the content files, and the tool works for any company.
- **Bilingual UI (EN/DE).** The monitored questions are deliberately mixed-language, because that is how users actually ask.

## Run it locally

```bash
git clone https://github.com/<your-github-user>/geo-engine.git
cd geo-engine
python3 scripts/build_web_data.py   # regenerate app/data.js after editing data/
open app/index.html                  # or: python3 -m http.server -d app 8000
```

Website audit against a site you own:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/audit_crawl.py --base https://www.example.com --limit 10
python scripts/score_pages.py        # reads the newest data/crawl-*.json, writes data/page_scores.json
python3 scripts/build_web_data.py    # rebuild app/data.js to pick it up
```

## Development

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt   # adds pytest, ruff, jsonschema on top of requirements.txt

ruff check .                          # lint
python scripts/validate_data.py       # schema + cross-file reference checks for data/*.json
pytest tests/ -v                      # Python tests (audit_crawl.py logic)
node --test tests/core.test.js        # JS tests (app/core.js — GEO scoring, mention parsing)
```

All four run in CI (`.github/workflows/ci.yml`) on every push and pull request, along with a
check that `app/data.js` matches what `build_web_data.py` would regenerate. Run
`./scripts/check.sh` locally before pushing to catch the same issues earlier — it runs every
CI step plus `gitleaks` if you have it installed.

## Use it for your own brand

Any company can self-serve this with zero cost to anyone but themselves — no API key is
needed for steps 1-4, and for real monitoring (step 6) each user supplies
their own key in their own local `.env` (or their own repo secrets), never shared with anyone else.

1. Edit `data/brand.json` (name, domain, aliases used for mention detection).
2. Write `data/categories.json` for your market (topic id, EN/DE label, matching keywords) —
   this is real domain knowledge about your business that can't be auto-generated. Or skip the
   file editing entirely: open the app, choose "Set up my own brand," and either type topics
   in by hand or load candidates suggested from your own site's headings (run
   `audit_crawl.py` then `suggest_topics.py` locally first, then load the result in the wizard
   — the app itself never fetches your site; that step runs on your machine).
3. Run `python3 scripts/generate_questions.py` to get a starter `data/questions.json` from
   those categories via templates (zero cost, no API key, instant) — then edit the generated
   phrasing to match how your actual customers ask.
4. Replace `data/blocks.json` with real content blocks from your own site, papers and case
   studies, or build them in the app: *Improve → Library → Import from your own content* takes
   pasted text or a .txt/.md/.html file, suggests blocks (verbatim sentences: definitions,
   figures, cases, quotes, Q&A pairs) and saves only what you accept. For Word or PDF files, run
   `python3 scripts/extract_text.py file.docx` first (PDF needs `pip install pypdf==6.21.4`). Run `python3 scripts/audit_crawl.py --base <your site>` then
   `python3 scripts/score_pages.py` for a real website audit instead of the demo one.
5. Run `python3 scripts/build_web_data.py` to rebuild `app/data.js`.
6. Real monitoring: see [Run real monitoring](#run-real-monitoring) below.

## From blocks to a readable article

Blocks hold verified facts, but stacked blocks don't read well. In *Improve → Write*, once a
draft has blocks, three steps turn it into an article:

1. **Compose (no AI):** question as title, a direct answer first, then background, figures,
   an example, the quote and an FAQ. Block wording is unchanged.
2. **Polish (your own AI chat):** copy the prompt into ChatGPT, Claude or Gemini and paste the
   result back. The prompt asks for fluent, self-contained sentences and forbids adding or
   dropping facts. The app itself never sends anything (`connect-src 'none'`).
3. **Check:** every number (also written as a word, any format), acronym, brand/competitor name
   and quote from the blocks must still be there; new numbers or names are flagged as possibly
   invented; blocks the rewrite dropped are flagged; plus readability checks (answer first,
   sentence length, paragraphs that stand on their own, subheadings, a year). Export stays
   locked until the flags are fixed or you confirm you checked them. HTML export includes
   FAQPage JSON-LD built from the visible FAQ.

## Run real monitoring

**What gets monitored.** `target` in the settings points to a folder with `brand.json`,
`competitors.json`, `categories.json` and `questions.json`. It is `targets/geo-engine`: this project
itself, with 15 real questions (EN/DE) about checking AI visibility and GEO tools, and existing GEO
monitoring tools as competitors (names only). The public demo in `data/` stays on the fictional
Contoso AI. To see results: download `monitoring_export.json` from a run, open the app, choose
your own brand and *Load export* in the setup screen.

All settings live in `data/monitoring_settings.json`: cadence (default weekly, Monday),
question scope (the 15 key questions), runs per question (1), randomized rephrasings per
question (1, on), engines and models, and a hard budget cap per run.

**Keys.** Copy `.env.example` to `.env` and fill in only the engines you use:

| Engine | Variable | Free option |
|---|---|---|
| Claude (web search) | `ANTHROPIC_API_KEY` | no, paid per call |
| ChatGPT (web search) | `OPENAI_API_KEY` | no, needs prepaid credit |
| Gemini | `GEMINI_API_KEY` | yes: free tier, plain answers without citations (`grounding: false`) |

An enabled engine without a key is skipped with a message, so you can start with Gemini alone.

**Local run.**

```bash
python3 monitoring/run.py --dry-run      # zero cost, recorded fixtures
python3 monitoring/run.py                # real: prints a cost estimate, stops above the budget cap
python3 monitoring/run.py --yes          # real, skips the confirmation prompt
python3 scripts/export_monitoring.py     # -> monitoring/monitoring_export.json
```

Then in the app: *Monitor → Sources → Load monitoring results* and pick the export file.

**Scheduled run (GitHub Actions).** `.github/workflows/monitoring.yml` wakes daily and runs
only when the settings say a run is due. Add your keys under *Settings → Secrets and variables
→ Actions* with the same names as above. Each run keeps the database as a workflow artifact
("monitoring-results", 90 days) and continues it next time; nothing is committed to the repo.
On a public repository, anyone signed in to GitHub can download those artifacts, so they are
effectively public. GitHub also pauses scheduled workflows after 60 days without repository
activity.

## Deploy the demo (GitHub Pages)

Go to *Settings → Pages → Source: GitHub Actions*. The workflow in `.github/workflows/pages.yml` publishes `app/` on every push to `main`.

## Security

- `.env` is git-ignored, and API keys are only ever read by local scripts.
- A CI workflow (`gitleaks`) fails the build if a secret is committed.
- The web app has no network access by design (see CSP in `app/index.html`).

See [SECURITY.md](SECURITY.md).

## Case study

See [docs/CASE_STUDY.md](docs/CASE_STUDY.md) for the problem, approach, scoring rationale and learnings.

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

MIT
