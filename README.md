# GEO Engine

**Find out whether ChatGPT, Claude and Gemini mention a brand, which sources they rely on, and what content would get it cited.**

More and more people ask an AI assistant instead of a search engine: *"Which tools can check whether ChatGPT mentions my brand?"* Whoever the answer names wins the lead. GEO Engine is an open-source tool for this kind of **generative engine optimization (GEO)**: it measures how often a brand shows up in AI answers, lists the pages the engines cite, audits the brand's own website, and helps turn verified facts into articles that assistants can quote.

> **Live demo:** https://lennartschroff.github.io/geo-engine/
> The demo uses *Contoso AI*, an invented company (Contoso is Microsoft's standard placeholder name). On the first screen you can open the demo or set up your own brand. Setup happens in your browser; nothing is uploaded.

## Screens

| Screen | Purpose |
|---|---|
| **Overview** | How often the brand is named on the key questions, per engine and per topic, and where the largest gaps are |
| **Questions** | The tracked prompts (15 key questions checked weekly, more on demand) with a status per engine: cited with link, named, or not named. Each result opens the full answer with brand and competitor names highlighted |
| **Sources** | The domains the engines cite, whether the brand appears there, and share of voice per topic |
| **Impact** | Weekly mention rate with a 95% range, so normal run-to-run noise isn't mistaken for a trend |
| **Website** | An audit of the brand's own site: AI crawler access, structured data, question headings, figures, outdated time phrases |
| **Library** | Reusable content blocks (key statements, definitions, figures, cases, quotes, FAQs). New blocks can be suggested from pasted text or files |
| **Write** | Pick a gap, assemble blocks into a draft with a live GEO score, turn it into an article and fact-check the polished version |

### How the GEO score works

A draft earns points for the properties that make text easy for language models to quote:

| Property | Points |
|---|---|
| The answer comes first (key statement or definition) | 20 |
| A figure someone can check | 20 |
| A concrete case | 15 |
| A quote with a named person | 15 |
| An FAQ | 10 |
| The blocks fit the target question (at least 60%) | 10 |
| Between 3 and 7 blocks | 10 |

The weights are a judgement call informed by published GEO research. They are written down so they can be questioned, not because they are proven.

## How it is built

```
data/         demo data (fictional Contoso AI) and monitoring settings, validated against schemas/
targets/      real monitoring targets; targets/geo-engine monitors this project itself
app/          the web app: plain JavaScript, no framework, no build step
scripts/      build_web_data.py     data/*.json -> app/data.js
              audit_crawl.py        crawl a site, record citability signals
              score_pages.py        crawl -> page scores
              audit_findings.py     crawl -> prioritised to-do list
              suggest_topics.py     crawl headings -> topic ideas for the setup screen
              export_monitoring.py  monitoring results -> file the app can load
              extract_text.py       .docx / .pdf -> text for the Library import
monitoring/   run.py                ask the engines, detect mentions, store results in SQLite
```

Principles:

- **The browser never talks to a server.** The page's Content Security Policy sets `connect-src 'none'`. Everything that calls an AI provider runs as a Python script on your machine or in your own GitHub Actions, with keys from `.env` or repository secrets.
- **Nothing to install for the app.** Open `app/index.html` from disk or host the folder anywhere.
- **Any brand.** A brand is a handful of JSON files (or the setup screen in the app).
- **English and German.** The interface switches languages, and the tracked questions mix both because real users do.

## Try it locally

```bash
git clone https://github.com/lennartschroff/geo-engine.git
cd geo-engine
python3 -m http.server -d app 8000      # then open http://localhost:8000
```

After editing anything in `data/`, rebuild the bundle with `python3 scripts/build_web_data.py`.

Keyboard: `Cmd/Ctrl+K` opens search and commands, `g` then a letter jumps to a page (`o` Overview, `q` Questions, `s` Sources, `i` Impact, `w` Website, `r` Write, `l` Library), `j`/`k` and `Enter` step through questions, `/` focuses the filter, `t` switches light and dark mode, `?` lists all shortcuts.

To audit a website you own:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python scripts/audit_crawl.py --base https://www.example.com --limit 10
python scripts/audit_findings.py     # to-do list    -> output/website/audit_findings.json
python scripts/score_pages.py        # page scores   -> data/page_scores.json
```

Load either result in the app under *Content → Website*.

## Development

```bash
pip install -r requirements-dev.txt   # requirements.txt plus pytest, ruff, jsonschema
ruff check .
python scripts/validate_data.py       # schemas and cross-file references, incl. targets/
pytest tests/
node --test tests/core.test.js tests/charts.test.js
./scripts/check.sh                    # everything CI runs, plus gitleaks if installed
```

CI (`.github/workflows/ci.yml`) runs the same checks on every push and pull request and fails if `app/data.js` is out of date.

## Set it up for your own brand

No API key is needed until you want real monitoring data.

1. Open the app, choose **My brand**, and enter the name, domain and topics. Topic ideas can come from your own site: run `audit_crawl.py` and `suggest_topics.py`, then load the result in the setup screen.
2. Starter questions are generated from the topics (`scripts/generate_questions.py` does the same for the JSON files). Reword them the way your customers actually ask.
3. Fill the Library with real facts: type them in, or use *Import from your own content* with pasted text or a `.txt`, `.md` or `.html` file. Every suggestion is a sentence from your text, and only what you accept is saved. For Word or PDF, convert first with `python3 scripts/extract_text.py file.docx` (PDF needs `pip install pypdf==6.21.4`).
4. Audit your website as shown above.
5. For real visibility data, see [Real monitoring](#real-monitoring).

## From blocks to an article

Blocks keep facts precise, but a stack of blocks doesn't read well. Under *Content → Write*:

1. **Compose:** the app arranges the blocks into an article without AI: the question as title, the answer first, then background, figures, an example, the quote and an FAQ. No wording changes.
2. **Polish:** copy the prepared prompt into ChatGPT, Claude or Gemini and paste the result back. The prompt asks for natural, self-contained sentences and forbids adding or removing facts. The app itself sends nothing.
3. **Check:** the app compares the polished text with the blocks. Numbers (in any format, also spelled out), acronyms, brand and competitor names and quotes must all survive; new numbers or names are flagged as possibly invented; dropped blocks are flagged; readability checks look for an answer up front, short sentences, paragraphs that stand alone, subheadings and a year. Export unlocks once the flags are fixed or you confirm you've checked them. The HTML export carries FAQPage structured data matching the visible FAQ.

## Real monitoring

**Target.** The `target` setting names a folder with `brand.json`, `competitors.json`, `categories.json` and `questions.json`. It is `targets/geo-engine`: this project, with 15 English and German questions about AI visibility and GEO tools, and existing GEO tools as competitors (names only). The demo in `data/` stays fictional.

**Settings** live in `data/monitoring_settings.json`: how often (`off` by default: runs start only by hand; `daily`, `weekly`, `biweekly` and `monthly` run automatically), which questions, runs per question (1), random rephrasings per question (1), engines and models, and a cost cap per run.

**Keys.** Copy `.env.example` to `.env` and add only the engines you want:

| Engine | Variable | Free? |
|---|---|---|
| Claude, with web search | `ANTHROPIC_API_KEY` | no, billed per call |
| ChatGPT, with web search | `OPENAI_API_KEY` | no, needs prepaid credit |
| Gemini | `GEMINI_API_KEY` | yes on the free tier, without cited sources (`grounding: false`) |

Engines without a key are skipped, so Gemini alone is a free start.

**On your machine:**

```bash
python3 monitoring/run.py --dry-run      # free, uses recorded test answers
python3 monitoring/run.py                # real calls: shows a cost estimate, stops above the cap
python3 monitoring/run.py --yes          # real calls without the confirmation prompt
python3 scripts/export_monitoring.py     # -> monitoring/monitoring_export.json
python3 monitoring/radar.py collect      # Question Radar: public questions + topic momentum (free)
python3 monitoring/radar.py              # show candidates; `probe --top 5` measures open slots (asks first)
```

**On GitHub:** `.github/workflows/monitoring.yml` wakes up daily and only runs when the settings say a run is due. To start one by hand, open *Actions → Scheduled monitoring → Run workflow* (the app's *Monitor → Run* page links there) and pick `test` (the first key question once per engine, about $0.05) or `full` (the whole run list). Temporary provider errors (overload, 5xx, timeouts) are retried twice before an engine is skipped for the run. Add the keys under *Settings → Secrets and variables → Actions*. Results are kept as a workflow artifact ("monitoring-results", 90 days) that each run picks up and extends; nothing is committed. On a public repository anyone signed in to GitHub can download those artifacts. GitHub pauses scheduled workflows after 60 days without activity in the repository.

**Which questions:** the 15 key questions, unless the target folder holds a `run_list.json`. Save one on the app's *Monitor → Run* page (questions switched on or added there included), put it in the target folder and commit it; `run.py` then asks exactly those.

**Seeing the results:** download `monitoring_export.json`, open the app, choose *My brand* and load it on *Monitor → Run* (or *Load export* on the setup screen).

## Publishing the demo

In the repository settings, set *Pages → Source* to *GitHub Actions*. `.github/workflows/pages.yml` then publishes `app/` after every push to `main`.

## Security

API keys only ever live in `.env` or repository secrets and are read by local scripts or Actions, never by the web app. A gitleaks check runs on every push. Details: [SECURITY.md](SECURITY.md).

## More

- [docs/CASE_STUDY.md](docs/CASE_STUDY.md): the problem, the approach, the scoring rationale and what was learned
- [ROADMAP.md](ROADMAP.md) and [TASKS.md](TASKS.md): what's done and what's next

## License

MIT
