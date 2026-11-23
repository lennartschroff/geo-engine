# Question Radar

Status: built end to end on branch `radar` (2026-11-23). Tasks: TASKS.md Epic H.

## The idea

Monitoring answers "are we named for the questions people ask now?". The
Radar asks a second question: **which questions are just starting to come
up, and does anyone answer them well yet?** A brand that publishes a solid,
citable answer before a question becomes common gets a head start in two
places:

- **Search-backed answers.** When an engine searches for a new question and
  finds only thin pages, it cites whatever is there. Being the best page
  early makes you the default source.
- **Future model versions.** Content that exists before a training cutoff
  can end up in what a model knows without searching.

The Radar doesn't claim to predict anything. It finds **early signals**,
ranks them, and **logs what it flagged**, so its hit rate can be checked
with the monitoring that already runs.

## The loop

```
collect (free) ─┐
engine searches ├─> candidates ─> score ─> app: Track / Write ─> run list ─> monitoring
events          ┘                  │                                            │
probe (paid) ──────────────────────┘           hit-rate log: flagged → tracked → brand named
```

| Step | Command / place | Cost |
|------|-----------------|------|
| Collect public questions and topic momentum | `python monitoring/radar.py collect` (weekly in the scheduled Action) | free |
| Engine searches | stored by `monitoring/run.py` in `search_queries` | already paid |
| Show candidates | `python monitoring/radar.py` (`--json` for the app's format) | free |
| Measure open slots | `python monitoring/radar.py probe --top 5` | 1 call per candidate and engine; estimate shown, budget caps apply |
| Hit rate | `python monitoring/radar.py hits` | free |
| App | `scripts/export_monitoring.py` adds a `radar` section; Monitor → Radar | – |

Settings per target: `targets/<name>/radar.json` (terms, sources, events,
`min_score`), checked by `scripts/validate_data.py`. Terms are sent to the
public APIs, so they must never be a brand alias (enforced).

## Signals

| Origin | Source | What we keep |
|--------|--------|--------------|
| engine | Claude `server_tool_use` / ChatGPT `web_search_call` queries | the search text, engine, question it came from |
| hackernews | hn.algolia.com search API | question-like titles, points, comments |
| stackexchange | api.stackexchange.com (e.g. webmasters, stackoverflow) | titles, views, answers, answered or not |
| github | GitHub issue search | question-like titles with at least one reaction or comment |
| wikipedia | Wikimedia page views | daily views of listed articles (momentum only) |
| event | `radar.json` events with a source URL | expected questions and date |

No author names are stored. Gemini reports its searches only with grounding,
which needs billing, so it adds no engine searches for now.

## Score (0–100)

| Part | Weight | Measured by |
|------|--------|-------------|
| Momentum | 30 | Topic terms: last 30 days vs. the 30-day average of the 150 days before (each doubling +0.25 around a steady 0.5), plus the candidate's own recency. Events: closeness of the date. |
| Demand | 20 | Engines and answers that ran the search; points, comments, views. |
| Open slot | 30 | Probe: named providers (60 %), cited sources (40 %), hedging → at least 0.8, brand already named → at most 0.3. Without a probe: unanswered Stack Exchange question 0.75, answered 0.4, otherwise 0.5–0.6. |
| Fit | 20 | Topic keywords and radar terms found as phrases; engine searches at least 0.5. Candidates with fit 0 are dropped. |

A rule of thumb like the GEO score, not a validated measure. The hit-rate
log exists to check it.

## Lessons from the first real collection (2026-11-23)

- **GitHub grows on its own.** Every term looked like it was rising on GitHub
  (about ×1.7) while all GitHub issues grew ×1.84 in the same windows.
  The collector now stores a platform-wide count and divides it out.
- **Search engines match loosely.** Hacker News returned unrelated posts and
  GitHub returned SEO-agency spam. Phrase matching, an engagement minimum
  and a stricter question test ("How X showed Y" is a headline) fixed both.
- **Niche topics are quiet.** For GEO, Stack Exchange has almost no recent
  questions; Hacker News and Wikipedia carry most of the signal. Expect a
  short candidate list at first; it grows with weekly engine searches.
- **Wikimedia rate-limits anonymous clients.** Keep the article list short;
  set `RADAR_USER_AGENT` with contact details in `.env` if you want to.

## In the app: a foresight scan with your own key

Anyone using the app (not only developers) can fill the Radar from
*Monitor → Radar → Scan now*. It is one request to the first connected
assistant (Gemini first, as it is free), sent from the browser with the
visitor's own key, like the checks on the Runs page.

The request is a small **horizon scan** in the strategic-foresight sense:

- **Drivers of change (STEEP):** technology, market, society, regulation,
  environment. Each question names its driver, what is changing, and an
  observable sign that it is starting.
- **Three horizons**, drawn as the rings of a trend radar:
  *act now* (asked already, good answers are rare), *prepare* (growing,
  likely common within 6–12 months), *watch* (an early, weak signal).
  Slices are the brand's topics.
- **Confidence** (likely / possible / uncertain) instead of a score, since
  nothing is measured.

Measured candidates from `radar.py` keep their score; their horizon comes
from the parts (`app/core.js` `radarHorizon`: demand ≥ 60 → act now,
momentum ≥ 60 → prepare, otherwise watch).

The scan is the assistant's judgement, not data, and the page says so.
The loop closes the same way as for measured candidates: *Track* adds the
question to the brand's checks, and later checks show whether assistants
start naming the brand for it ("Did it pay off?").

## Limits

- API answers differ from the consumer apps (same as monitoring).
- Engine searches show what an engine thinks is relevant, not how many
  people ask. Community counts are a proxy for demand, not a measure.
- Momentum needs weekly history to become meaningful; the hit rate needs
  8+ weeks after the first flags.
- Probes cost money (except Gemini's free tier, which is often overloaded).

## Open

- Events for `targets/geo-engine`: none yet, each needs a source `[placeholder]`.
- First real probe: Claude, 5 candidates ≈ $0.25, waiting for approval.
