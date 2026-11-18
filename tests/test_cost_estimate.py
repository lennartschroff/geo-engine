"""Unit tests for monitoring/cost_estimate.py."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from monitoring.cost_estimate import (  # noqa: E402
    CallBudgetExceeded,
    check_call_budget,
    estimate_cost,
    needs_confirmation,
)

TEST_PRICING = {
    "claude": {"input": 0.01, "output": 0.01},
    "gpt": {"input": 0.01, "output": 0.01},
}
NO_SEARCH_COST: dict[str, float] = {}  # isolates token-only math from the search fee


class TestEstimateCost:
    def test_num_calls_is_questions_times_engines_times_runs(self):
        e = estimate_cost(15, ["claude", "gpt"], 3, pricing=TEST_PRICING, search_pricing=NO_SEARCH_COST)
        assert e.num_calls == 15 * 2 * 3

    def test_total_cost_matches_manual_calculation_token_only(self):
        # 1 question, 1 engine, 1 run, round token counts, no search fee -- exact check.
        e = estimate_cost(1, ["claude"], 1, input_tokens=1000, output_tokens=1000,
                           pricing=TEST_PRICING, search_pricing=NO_SEARCH_COST)
        # 1000/1000 * 0.01 (input) + 1000/1000 * 0.01 (output) = 0.02
        assert e.total_usd == pytest.approx(0.02)

    def test_scales_linearly_with_runs(self):
        once = estimate_cost(5, ["claude"], 1, pricing=TEST_PRICING, search_pricing=NO_SEARCH_COST)
        thrice = estimate_cost(5, ["claude"], 3, pricing=TEST_PRICING, search_pricing=NO_SEARCH_COST)
        assert thrice.total_usd == pytest.approx(once.total_usd * 3)

    def test_unknown_engine_raises(self):
        with pytest.raises(ValueError):
            estimate_cost(1, ["unknown-engine"], 1, pricing=TEST_PRICING)

    def test_per_engine_breakdown_sums_to_total(self):
        e = estimate_cost(10, ["claude", "gpt"], 2, pricing=TEST_PRICING)
        assert sum(e.per_engine_usd.values()) == pytest.approx(e.total_usd)

    def test_web_search_fee_is_added_per_search_per_call(self):
        search_pricing = {"claude": 0.01}
        e = estimate_cost(1, ["claude"], 1, input_tokens=0, output_tokens=0, searches_per_call=3,
                           pricing=TEST_PRICING, search_pricing=search_pricing)
        assert e.total_usd == pytest.approx(0.03)  # 3 searches * $0.01, no token cost

    def test_engine_with_no_search_pricing_entry_has_no_search_fee(self):
        e = estimate_cost(1, ["gpt"], 1, input_tokens=0, output_tokens=0, searches_per_call=5,
                           pricing=TEST_PRICING, search_pricing={"claude": 0.01})
        assert e.total_usd == 0.0

    def test_default_search_pricing_applies_when_not_overridden(self):
        # Uses the real WEB_SEARCH_USD_PER_SEARCH default ($0.01/search for claude).
        e = estimate_cost(1, ["claude"], 1, input_tokens=0, output_tokens=0, searches_per_call=1, pricing=TEST_PRICING)
        assert e.total_usd == pytest.approx(0.01)


class TestCheckCallBudget:
    def test_passes_when_under_cap(self):
        check_call_budget(10, max_calls=20)  # should not raise

    def test_passes_when_cap_is_none(self):
        check_call_budget(10_000, max_calls=None)  # should not raise

    def test_raises_when_over_cap(self):
        with pytest.raises(CallBudgetExceeded):
            check_call_budget(21, max_calls=20)

    def test_exactly_at_cap_is_allowed(self):
        check_call_budget(20, max_calls=20)  # should not raise


class TestNeedsConfirmation:
    def test_below_threshold_no_confirmation(self):
        e = estimate_cost(1, ["claude"], 1, pricing=TEST_PRICING, search_pricing=NO_SEARCH_COST)
        assert needs_confirmation(e, yes_threshold_usd=100) is False

    def test_above_threshold_needs_confirmation(self):
        e = estimate_cost(1, ["claude"], 1, input_tokens=1000, output_tokens=1000,
                           pricing=TEST_PRICING, search_pricing=NO_SEARCH_COST)
        assert needs_confirmation(e, yes_threshold_usd=0.01) is True
