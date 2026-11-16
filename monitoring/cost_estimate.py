"""Cost estimation and spend guard for monitoring/run.py.

Per CLAUDE.md: "Estimate API cost before runs with many calls and ask
before running." This module does the arithmetic; run.py is responsible
for actually showing the estimate and getting confirmation.

The per-token prices below are PLACEHOLDERS (see CLAUDE.md: "Unknown facts
are marked [placeholder]"). Provider pricing changes and must be checked
against the current pricing page for each provider before trusting a
dollar figure from this module — don't wire this into a real paid run
without updating PRICING_USD_PER_1K_TOKENS first.
"""
from __future__ import annotations

from dataclasses import dataclass

# [placeholder] verify against each provider's current pricing page before a real run.
PRICING_USD_PER_1K_TOKENS: dict[str, dict[str, float]] = {
    "claude": {"input": 0.003, "output": 0.015},
    "gpt": {"input": 0.0025, "output": 0.01},
    "gemini": {"input": 0.00125, "output": 0.005},
}

# Rough defaults for a question + web-search-enabled answer. Real answers vary
# a lot — these exist so the estimate is in the right order of magnitude, not
# to be precise. [placeholder]
DEFAULT_INPUT_TOKENS = 400
DEFAULT_OUTPUT_TOKENS = 700


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
    pricing: dict[str, dict[str, float]] | None = None,
) -> CostEstimate:
    """Estimates total cost for num_questions x engines x runs_per_question calls."""
    pricing = pricing if pricing is not None else PRICING_USD_PER_1K_TOKENS
    per_engine_usd: dict[str, float] = {}
    for engine in engines:
        if engine not in pricing:
            raise ValueError(f"No pricing entry for engine {engine!r} — add one to PRICING_USD_PER_1K_TOKENS.")
        calls = num_questions * runs_per_question
        input_cost = input_tokens / 1000 * pricing[engine]["input"]
        output_cost = output_tokens / 1000 * pricing[engine]["output"]
        per_engine_usd[engine] = round(calls * (input_cost + output_cost), 4)

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
