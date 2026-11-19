"""Cost estimation and spend guard for monitoring/run.py.

Per CLAUDE.md: "Estimate API cost before runs with many calls and ask
before running." This module does the arithmetic; run.py is responsible
for actually showing the estimate and getting confirmation.

Pricing for "claude" is verified against Anthropic's own docs as of
2026-11-18 (platform.claude.com/docs — Haiku 4.5 token pricing, and the
web search tool's pricing page: "$10 USD per 1,000 searches" in addition
to token costs). "gpt" (gpt-5-mini + web_search) verified against
OpenAI's pricing page on 2026-11-19. "gemini" is still [placeholder]; on
the free tier run.py estimates it at $0 anyway.
"""
from __future__ import annotations

from dataclasses import dataclass

PRICING_USD_PER_1K_TOKENS: dict[str, dict[str, float]] = {
    # claude-sonnet-5, verified 2026-11-18. Chosen over the cheaper Haiku 4.5
    # for the first real run because Sonnet 5 is unambiguously confirmed
    # (both in Anthropic's pricing table and in the web search tool's
    # supported-models list) — Haiku 4.5's web-search support was only
    # listed for a dated snapshot, not the bare model id, which wasn't worth
    # risking a failed first real call over a cost difference this run's
    # token counts make negligible (the web search fee below dominates).
    "claude": {"input": 0.002, "output": 0.01},
    # gpt-5-mini, verified 2026-11-19 on OpenAI's pricing page: $0.25 / $2.00
    # per 1M tokens. Search content tokens are billed at these input rates.
    "gpt": {"input": 0.00025, "output": 0.002},
    "gemini": {"input": 0.00125, "output": 0.005},  # [placeholder]
}

# Web search is billed per search, on top of token costs -- not a per-token
# rate, so it isn't in PRICING_USD_PER_1K_TOKENS above. $10 per 1,000
# searches = $0.01/search. Verified 2026-11-18. Only "claude" has this;
# other engines' search tools (if/when wired in) will need their own entry.
WEB_SEARCH_USD_PER_SEARCH: dict[str, float] = {
    "claude": 0.01,
    "gpt": 0.01,  # OpenAI web_search tool: $10 per 1k calls, verified 2026-11-19
}

# Defaults for a question + web-search-enabled claude-sonnet-5 answer.
# input_tokens was [placeholder] at 400 until a real test call on 2026-11-18
# measured 22,250 input tokens for a 2-search question (search result content
# loaded into context is the dominant cost, far more than the question text
# itself) — raised to 15000 as a realistic planning number, still rough since
# some questions trigger 0 searches and others more, but no longer a guess
# off by 55x. output_tokens (1163 measured, no thinking) raised to 1000 to
# match. See monitoring/run.py's call_claude(): thinking is explicitly
# disabled, since thinking tokens are billed as output even when hidden, and
# a first test run without this disabled cost noticeably more than estimated.
DEFAULT_INPUT_TOKENS = 15000
DEFAULT_OUTPUT_TOKENS = 1000
DEFAULT_SEARCHES_PER_CALL = 2


@dataclass
class CostEstimate:
    num_calls: int
    total_input_tokens: int
    total_output_tokens: int
    total_usd: float
    per_engine_usd: dict[str, float]


def estimate_cost(
    num_questions: int,
    engines: list[str],
    runs_per_question: int,
    input_tokens: int = DEFAULT_INPUT_TOKENS,
    output_tokens: int = DEFAULT_OUTPUT_TOKENS,
    searches_per_call: int = DEFAULT_SEARCHES_PER_CALL,
    pricing: dict[str, dict[str, float]] | None = None,
    search_pricing: dict[str, float] | None = None,
) -> CostEstimate:
    """Estimates total cost for num_questions x engines x runs_per_question calls.

    Each call is assumed to use `searches_per_call` web searches (billed per
    search, separate from token cost — see WEB_SEARCH_USD_PER_SEARCH) in
    addition to `input_tokens`/`output_tokens`. An engine with no entry in
    `search_pricing` is assumed to have no separate search fee (0).
    """
    pricing = pricing if pricing is not None else PRICING_USD_PER_1K_TOKENS
    search_pricing = search_pricing if search_pricing is not None else WEB_SEARCH_USD_PER_SEARCH
    per_engine_usd: dict[str, float] = {}
    for engine in engines:
        if engine not in pricing:
            raise ValueError(f"No pricing entry for engine {engine!r} — add one to PRICING_USD_PER_1K_TOKENS.")
        calls = num_questions * runs_per_question
        input_cost = input_tokens / 1000 * pricing[engine]["input"]
        output_cost = output_tokens / 1000 * pricing[engine]["output"]
        search_cost = searches_per_call * search_pricing.get(engine, 0.0)
        per_engine_usd[engine] = round(calls * (input_cost + output_cost + search_cost), 4)

    num_calls = num_questions * len(engines) * runs_per_question
    return CostEstimate(
        num_calls=num_calls,
        total_input_tokens=num_calls * input_tokens,
        total_output_tokens=num_calls * output_tokens,
        total_usd=round(sum(per_engine_usd.values()), 4),
        per_engine_usd=per_engine_usd,
    )


class CallBudgetExceeded(Exception):
    """Raised when a run would exceed --max-calls."""


def check_call_budget(num_calls: int, max_calls: int | None) -> None:
    """Hard cap: raises if num_calls would exceed max_calls. None = no cap."""
    if max_calls is not None and num_calls > max_calls:
        raise CallBudgetExceeded(
            f"{num_calls} calls would exceed --max-calls={max_calls}. Reduce scope or raise the cap explicitly."
        )


def needs_confirmation(estimate: CostEstimate, yes_threshold_usd: float) -> bool:
    """True if the estimated cost is high enough that --yes should be required."""
    return estimate.total_usd > yes_threshold_usd
