"""Tests for monitoring/variants.py and monitoring/schedule.py."""
from __future__ import annotations

import random
import sys
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from monitoring.schedule import is_due  # noqa: E402
from monitoring.variants import make_variant, make_variants  # noqa: E402


class TestVariants:
    @pytest.mark.parametrize("text,lang", [
        ("Best consultancies for building production AI agents", "en"),
        ("Wie baue ich eine Retrieval-Augmented-Generation-Pipeline auf?", "de"),
        ("RAG-Anbieter in den USA", "en"),
    ])
    def test_variant_differs_and_keeps_core_terms(self, text, lang):
        for seed in range(30):
            v = make_variant(text, lang, random.Random(seed))
            assert v != text
            if lang == "de":
                core = "Retrieval-Augmented-Generation-Pipeline"
            else:
                core = "RAG" if "RAG" in text else "AI agents"
            assert core in v

    def test_same_seed_is_reproducible(self):
        a = make_variants("Top LLM consulting firms in the US", "en", 2, random.Random(7))
        b = make_variants("Top LLM consulting firms in the US", "en", 2, random.Random(7))
        assert a == b and len(a) == 2 and a[0] != a[1]

    def test_different_seeds_vary(self):
        outs = {make_variant("Top LLM consulting firms in the US", "en", random.Random(s)) for s in range(20)}
        assert len(outs) > 5

    def test_german_question_gets_german_frame(self):
        v = make_variant("Was ist ein KI-Agent im Unternehmenskontext?", "de", random.Random(1))
        assert not any(w in v for w in ("Quick question", "my company", "help me", "recommend", "practical"))

    def test_search_style_prompt_gets_question_mark(self):
        for seed in range(20):
            v = make_variant("Top LLM consulting firms in the US", "en", random.Random(seed))
            assert "US?" in v

    def test_no_brand_nudging(self):
        for seed in range(50):
            v = make_variant("Best AI consultancies", "en", random.Random(seed)).lower()
            assert "name specific" not in v and "providers if" not in v

    def test_zero_variants(self):
        assert make_variants("Anything", "en", 0) == []


WEEKLY_MON = {"frequency": "weekly", "weekday": "monday"}


class TestSchedule:
    def test_weekly_monday(self):
        assert is_due(WEEKLY_MON, date(2026, 11, 23))  # a Monday
        assert not is_due(WEEKLY_MON, date(2026, 11, 24))

    def test_daily(self):
        assert is_due({"frequency": "daily", "weekday": "monday"}, date(2026, 11, 25))

    def test_biweekly_only_even_iso_weeks(self):
        s = {"frequency": "biweekly", "weekday": "monday"}
        mondays = [date(2026, 11, 16), date(2026, 11, 23), date(2026, 11, 30), date(2026, 12, 7)]
        due = [is_due(s, d) for d in mondays]
        assert due in ([True, False, True, False], [False, True, False, True])

    def test_monthly_first_weekday(self):
        s = {"frequency": "monthly", "weekday": "monday"}
        assert is_due(s, date(2026, 12, 7))  # first Monday of Dec 2026
        assert not is_due(s, date(2026, 12, 14))

    def test_unknown_frequency_raises(self):
        with pytest.raises(ValueError):
            is_due({"frequency": "hourly", "weekday": "monday"}, date(2026, 11, 23))
