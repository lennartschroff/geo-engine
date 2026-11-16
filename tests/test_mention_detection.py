"""Unit tests for monitoring/mention_detection.py — pure logic, no API calls."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from monitoring.mention_detection import (  # noqa: E402
    detect_mention,
    find_first_mention,
    normalize_domain,
    normalize_domains,
)

BRAND_ALIASES = ["Tailspin Robotics", "Tailspin"]
COMPETITORS = ["Competitor A", "Competitor B", "Competitor C"]


class TestFindFirstMention:
    def test_finds_exact_name(self):
        assert find_first_mention("We recommend Tailspin Robotics for this.", "Tailspin Robotics") == 13

    def test_case_insensitive(self):
        assert find_first_mention("we recommend TAILSPIN ROBOTICS", "Tailspin Robotics") is not None

    def test_hyphenated_variant_matches_spaced_name(self):
        assert find_first_mention("Try Tailspin-Robotics's tools.", "Tailspin Robotics") is not None

    def test_no_match_returns_none(self):
        assert find_first_mention("No relevant brand here.", "Tailspin Robotics") is None

    def test_does_not_match_inside_a_longer_word(self):
        # "Tailspin" must not match inside "Tailspinsurfing" or similar.
        assert find_first_mention("We discussed Tailspinsurfing techniques.", "Tailspin") is None

    def test_empty_name_returns_none(self):
        assert find_first_mention("anything", "") is None


class TestDetectMention:
    def test_brand_mentioned_first_gets_rank_1(self):
        text = "Tailspin Robotics leads the field, followed by Competitor A and Competitor B."
        r = detect_mention(text, BRAND_ALIASES, COMPETITORS)
        assert r.mentioned is True
        assert r.position == 1
        assert r.providers_mentioned[0] == "(brand)"

    def test_brand_mentioned_second_gets_rank_2(self):
        text = "Competitor A is often cited, with Tailspin Robotics as another strong option."
        r = detect_mention(text, BRAND_ALIASES, COMPETITORS)
        assert r.mentioned is True
        assert r.position == 2
        assert r.providers_mentioned == ["Competitor A", "(brand)"]

    def test_brand_absent(self):
        text = "Competitor A and Competitor B are the leading providers."
        r = detect_mention(text, BRAND_ALIASES, COMPETITORS)
        assert r.mentioned is False
        assert r.position is None
        assert r.providers_mentioned == ["Competitor A", "Competitor B"]

    def test_brand_absent_and_no_competitors_named(self):
        text = "There are many providers in this space worth researching."
        r = detect_mention(text, BRAND_ALIASES, COMPETITORS)
        assert r.mentioned is False
        assert r.position is None
        assert r.providers_mentioned == []

    def test_short_alias_still_detected_when_full_name_absent(self):
        text = "Tailspin is a solid choice here."
        r = detect_mention(text, BRAND_ALIASES, COMPETITORS)
        assert r.mentioned is True
        assert r.position == 1

    def test_earliest_alias_match_wins_the_position(self):
        # "Tailspin" (short alias) appears before "Tailspin Robotics" is spelled
        # out fully later — the brand's rank should reflect the earliest mention.
        text = "Competitor A, then Tailspin, then later Tailspin Robotics in detail."
        r = detect_mention(text, BRAND_ALIASES, COMPETITORS)
        assert r.position == 2  # Competitor A first, brand (via "Tailspin") second


class TestNormalizeDomain:
    def test_strips_scheme_and_path(self):
        assert normalize_domain("https://www.example.com/some/page?x=1") == "example.com"

    def test_strips_www(self):
        assert normalize_domain("http://www.example.com/") == "example.com"

    def test_lowercases(self):
        assert normalize_domain("https://Example.COM/Page") == "example.com"

    def test_bare_domain_without_scheme(self):
        assert normalize_domain("example.com/page") == "example.com"

    def test_preserves_subdomain(self):
        assert normalize_domain("https://blog.example.com/post") == "blog.example.com"


class TestNormalizeDomains:
    def test_deduplicates_cosmetic_variants(self):
        urls = [
            "https://www.example.com/a",
            "https://example.com/b",
            "http://EXAMPLE.com/",
        ]
        assert normalize_domains(urls) == ["example.com"]

    def test_preserves_first_seen_order(self):
        urls = ["https://b.example/x", "https://a.example/y", "https://b.example/z"]
        assert normalize_domains(urls) == ["b.example", "a.example"]

    def test_empty_list(self):
        assert normalize_domains([]) == []
