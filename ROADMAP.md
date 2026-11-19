# Roadmap

The overview. Details and reasoning for each item are in [TASKS.md](TASKS.md).

## Done

**Monitoring**
- Questions sent to Claude, ChatGPT and Gemini, results stored in SQLite, one random rephrasing per question
- Mention detection with brand aliases, rank among named providers, cited domains
- Cost estimate and per-run cap before any real call; dry-run with recorded answers
- Weekly schedule in GitHub Actions; settings in one file
- Export into the app; real target `targets/geo-engine` monitors this project

**Analysis in the app**
- Full answers with highlighted brand and competitor names
- Share of voice per topic
- Weekly trend with 95% ranges

**Content**
- Website audit from a real crawl: page scores and a prioritised to-do list
- Library import from pasted text, `.txt`, `.md`, `.html` (Word and PDF via a script)
- Blocks to article: compose, polish in your own AI chat, fact-check before export
- Markdown and HTML export with FAQPage structured data

**Engineering**
- Tests for Python and JavaScript, JSON schemas, lint, CI, secret scanning
- Accessibility: WCAG AA contrast, keyboard use, screen-reader labels

## Next

- Check the first real monitoring runs for false matches on the generic name "GEO Engine"
- Publish answer-first articles about the monitored questions on the project's GitHub Pages site and follow the trend
- Short screen recording for the README

## Maybe later

- A hosted backend (for example FastAPI and SQLite) with accounts, for teams

## Limits to keep in mind

- API answers differ from what people see in the consumer apps.
- The GEO score and the page score are rules of thumb, not validated measures.
- Answers vary from run to run; only rates over several runs mean something.
