# Question Radar (draft concept)

Status: exploring, on branch `radar`. Started 2026-11-23.

## The idea

Today GEO Engine answers "are we named for the questions people ask now?".
The Radar asks a second question: **which questions are just starting to
appear, and is anyone answering them well yet?** If a brand publishes a
solid, citable answer before a question becomes common, it has a head start
in two places:

- **Search-backed answers.** When an engine searches the web for a new
  question and finds only thin pages, it cites whatever is there. Being the
  best page early makes you the default source.
- **Future model versions.** Content that exists before a model's training
  cutoff can end up in what the model knows without searching. Content
  published after the topic peaks may miss that window.

We don't claim to predict the future. The Radar finds **early signals**,
ranks them, and then **checks its own hit rate** with the monitoring that
already runs. That last step is what makes it more than a guess.

## How it fits the existing app

```
signals ──> candidate questions ──> score ──> write content ──> watch list ──> monitoring
  │                                   │          (Write tab)      (run list)      │
  └───────────────────────────────────┴──────── hit rate: flagged early, cited later?
```

1. **Collect** candidate questions from signals (below).
2. **Score** each one: momentum, fit with the brand's topics, how weak
   today's answers are, whether competitors already cover it.
3. **Act:** send the best ones to the Write tab (block types, GEO score).
4. **Check:** add them to the run list. Monitoring shows when engines start
   naming and citing the brand, and whether competitors got there first.

## Signal sources, cheapest first

| # | Source | Cost | Status |
|---|--------|------|--------|
| 1 | **Search queries the engines run** while answering our questions. They break one prompt into several searches; those searches show what the engines think matters. | $0 extra: already in the responses we pay for | **Built (first draft)** for Claude and ChatGPT |
| 2 | **Weak-answer test:** send a candidate question once per engine. Hedging, no named providers, or only weak sources mean the slot is open. | 1 call per candidate per engine | Planned (H4) |
| 3 | **Questions from known future events:** regulation deadlines, standards, product launches in the brand's field. Entered by hand with a date. | $0 | Planned (H5) |
| 4 | **Community and search momentum:** Reddit, GitHub issues, Stack Overflow, Google Trends, "People also ask". | Free APIs with rate limits; some need keys | Later (H6) |

### What each engine exposes (checked 2026-11-23)

- **Claude:** the web search tool returns a `server_tool_use` block per
  search, with the query in `input.query`. Confirmed in the Anthropic API docs.
- **ChatGPT (Responses API):** a `web_search_call` output item per search,
  with the query under `action.query`. Written from the documented shape and
  covered by tests with mocks. **Not yet checked with a real call.**
- **Gemini:** grounding queries only exist when Google Search grounding is
  on, which needs a billed account (see TASKS.md C4b). Our runs use plain
  generation, so Gemini contributes no search queries for now.
- **Follow-up suggestions** ("people also ask" in the consumer apps) are
  not part of any of the three APIs. We'd have to generate them ourselves,
  which measures the model, not real users. Left out on purpose.

## First draft (what is built)

- `monitoring/run.py` stores the search queries of every answer in a new
  `search_queries` column (JSON list). Older databases get the column added;
  existing rows are kept.
- `monitoring/radar.py` reads the database and lists the search queries
  that came up, without any API call:
  - normalised and merged (case, spacing, punctuation)
  - counted: how many answers, which engines, which of our questions led there
  - first and last time seen
  - marked as **new** when no tracked question is close in wording
    (word overlap below a threshold). New ones are the candidates.
- Output: a table in the terminal or JSON (`--json`), for the app later.

```
python monitoring/radar.py --db monitoring/runs.sqlite
python monitoring/radar.py --json --min-count 2 > output/radar.json
```

## Scoring (proposal, not built)

A candidate's score, 0–100. The weights are a starting point, like the GEO
score, and not a validated measure:

| Part | Weight | Measured by |
|------|--------|-------------|
| Momentum | 30 | Times seen in the last 4 weeks compared with the 4 before |
| Spread | 20 | Number of engines and tracked questions that led to it |
| Open slot | 30 | Weak-answer test: no named providers, hedging, few or weak sources |
| Fit | 20 | Overlap with the brand's topics and library blocks |

## How we'll know it works

- **Hit rate:** of the candidates flagged in a month, how many later show up
  more often (momentum) or become tracked questions?
- **Head start:** for candidates the brand wrote content for, weeks from
  flag to first citation, and whether competitors were cited first.
- Both come from data that monitoring already stores, so the Radar can be
  judged after a few months of weekly runs. Until then, treat its ranking as
  a reading list, not a forecast.

## Risks and limits

- **Little data at first.** One weekly run of 15 questions gives a few dozen
  search queries. Patterns need several weeks.
- **API ≠ consumer app.** The searches an API model runs may differ from
  what ChatGPT or Gemini do in their apps (same limit as monitoring itself).
- **Engine searches aren't user demand.** They show what the engine thinks
  is relevant to a question we asked. They're a proxy for what people will
  need to know, not a count of people asking.
- **Cost.** Source 1 is free. The weak-answer test (source 2) adds calls; it
  goes through the existing cost estimate and budget caps, and needs a yes
  before the first real run.
- **Privacy.** Community sources (H6) must only collect public posts and
  store the question text, not usernames.

## Open questions for the owner

- Separate tab ("Radar" under Monitor), or a section on the Questions tab?
- Should candidates go straight into the run list, or wait for a person to
  approve them? (Proposal: a person approves; each one costs calls every week.)
- Which future events matter for `targets/geo-engine`? `[placeholder]`
