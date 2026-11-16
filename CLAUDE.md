# Project context for AI coding assistants

## What this is
GEO Engine: a tool that tracks whether a brand is mentioned in ChatGPT, Claude and Gemini answers, shows cited sources, audits the brand's website and helps assemble citable content. The bundled data belongs to a fictional company (Tailspin Robotics).

## Layout
- `data/` – JSON source of truth (brand, categories, questions, blocks, audit, page scores, demo monitoring results)
- `app/` – static web app (vanilla JS). `app/data.js` is generated: run `python3 scripts/build_web_data.py` after editing `data/`.
- `scripts/` – Python utilities (`audit_crawl.py`, `build_web_data.py`)
- `monitoring/` – planned monitoring pipeline (see ROADMAP.md)

## Rules
- All code, comments, commit messages and docs in **English**. UI strings live in `app/i18n.js` (EN + DE).
- **Never put API keys in code, commits or the web app.** Keys are read from `.env` by local scripts only. The web app must keep `connect-src 'none'` in its CSP.
- Never invent facts about a real company. Unknown facts are marked `[placeholder]`.
- Estimate API cost before runs with many calls and ask before running.
- Prefer fixed years over relative time statements ("since 2011", not "for over 10 years").
- Do not commit crawl output or monitoring databases (git-ignored).

## Terms
- **Key questions:** the 15 most important prompts, run weekly.
- **Block types:** statement, definition, figure, case, quote, faq.
- **Status per engine:** cited (mentioned + linked), mentioned, absent.
- **GEO score (0–100):** direct answer first 20, figure 20, case 15, quote 15, FAQ 10, matches target question 10, 3–7 blocks 10.
