# GEO Engine: case study

## The problem

People increasingly ask ChatGPT, Claude and Gemini questions that used to go to a
search engine — "which agencies are good at X", "how do I do Y". For a brand, that
answer is the new SERP. Being present (or absent) in it isn't observable through any
existing analytics stack: it requires actually asking the engines, tracking whether
you're mentioned and cited, and understanding *why* — which sources they lean on,
and whether your own content gives them anything citable in the first place.

GEO Engine is a working prototype for that loop: **monitor → find the gap → close it
with content built to be cited.**

## Approach

**Static-first, not SaaS-first.** The first design decision was architectural, not
visual: no backend, no accounts, no server costs, ever. The app is a static page
with a CSP that blocks all network requests (`connect-src 'none'`) — it is
*structurally* incapable of leaking anything, because it can't talk to anything.
Anything that costs money or needs a provider API key runs as a local script that
reads its key from the user's own `.env`. This wasn't a constraint worked around
later — it's the reason the tool can be handed to any company at zero ongoing cost
to whoever built it.

**Self-service over hand-holding.** The second iteration added an in-app setup flow:
pick "see the demo" or "set up my own brand," fill in a name and a few topics, and
get a working starter kit — categories, generated questions, an empty but functional
app — entirely in the browser, in under two minutes, with no terminal and no API key.
The harder, real-data steps (crawling your own site, running real engine queries)
stay as local commands you run with your own key, surfaced as copy-paste guidance
inside the empty states rather than buried in a README.

**Heuristics stated as heuristics.** The GEO score (0–100) that grades a content
draft — direct answer first, a verifiable figure, a case, a quote, an FAQ block,
topic match, length — is explicitly a stated set of weights based on published GEO
guidance, not a validated measurement. The README says so. The UI doesn't present it
as more certain than it is. The same discipline applies to the website audit's page
scores: each criterion (answer-first, figures, question headings, FAQ schema, depth,
H1, a linked case) is a heuristic proxy, documented as one in the code, not asserted
as ground truth.

## Scoring rationale

The GEO score's seven criteria and their weights:

| Criterion | Weight | Why |
|---|---|---|
| Opens with a direct answer | 20 | Models prefer to lift a sentence that already answers the question |
| Contains a verifiable figure | 20 | Checkable numbers are what gets quoted verbatim |
| Case example | 15 | Ties the brand to the topic as a named entity, not just a claim |
| Named expert quote | 15 | A human, named source reads as more citable than an anonymous claim |
| FAQ block | 10 | Mirrors how people actually phrase the question to the engine |
| Matches the target question (≥60%) | 10 | Penalizes well-written but off-topic content |
| 3–7 blocks | 10 | Enough substance to be useful, not so much it dilutes the direct answer |

These weights are arguable by design — the point of writing them down explicitly is
that they *can* be argued with, not that they're final.

## What's real vs. what's demo

Everything that doesn't require money or a provider relationship is real:
mention-detection logic, URL normalization, the question-template generator, the
website crawler and its scoring, the GEO scoring rubric itself — all have unit
tests, all run the same whether you're looking at the bundled demo or your own
brand. What's still demo data is specifically the *content* of monitoring runs
(engine answers, citation counts, visibility trend) — because producing that for
real means spending real money against a real provider API, which is gated behind
an explicit decision (which provider, what budget) rather than done silently.

## Learnings

- **A brand-agnostic data model pays for itself later.** The original demo content
  (a different fictional company, a different industry) swapped out cleanly because
  nothing in the app logic ever referenced it by name — only through `data/*.json`.
- **"No backend" is a feature to say out loud, not just an implementation detail.**
  Once there's a real monitoring pipeline that needs a provider API key, "your key
  never leaves your machine" becomes the actual pitch, not a footnote.
- **An unvalidated heuristic presented honestly is more trustworthy than a precise
  number presented without caveats.** Marketing teams can tell the difference, and
  the stated-weights approach survives that scrutiny better than a black-box score
  would.

## Open, by design

`TASKS.md` in the repo tracks exactly what's built, what's gated on a real decision
(provider choice, spend cap), and what's deliberately not done (an npm/ESLint
toolchain, for instance — a decision explained inline, not an oversight).
