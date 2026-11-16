# GEO Engine

**See how AI assistants talk about your brand, then fill the gaps with content they can cite.**

When people ask ChatGPT, Claude or Gemini *"Which agencies are good at X?"*, the answer is the new search result. GEO Engine is a working prototype for **generative engine optimization (GEO)**. It tracks whether a brand appears in those answers, shows which sources the engines rely on, and helps a marketing team put together content that closes the gaps.

> **Live demo:** `https://<your-github-user>.github.io/geo-engine/` (enable GitHub Pages, see below)
> All data in the demo belongs to *Tailspin Robotics*, a **fictional** company.

![Overview](docs/overview.png)

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

![Draft studio](docs/studio.png)

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
monitoring/  (planned) scheduled prompt runs against the engine APIs → SQLite
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
```

## Use it for your own brand

1. Edit `data/brand.json` (name, domain, aliases used for mention detection).
2. Replace `data/blocks.json` with real content blocks from your own site, papers and case studies.
3. Adapt `data/questions.json` and `data/categories.json` to your market.
4. Run `python3 scripts/build_web_data.py`.

## Deploy the demo (GitHub Pages)

Go to *Settings → Pages → Source: GitHub Actions*. The workflow in `.github/workflows/pages.yml` publishes `app/` on every push to `main`.

## Security

- `.env` is git-ignored, and API keys are only ever read by local scripts.
- A CI workflow (`gitleaks`) fails the build if a secret is committed.
- The web app has no network access by design (see CSP in `app/index.html`).

See [SECURITY.md](SECURITY.md).

## Roadmap

See [ROADMAP.md](ROADMAP.md).

## License

MIT
