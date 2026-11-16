"""Unit tests for the pure extraction logic in scripts/audit_crawl.py.

These test the regexes and the schema.org extractor in isolation, with no
network access — the parts of the crawler that are cheap to get wrong and
easy to verify without hitting a real site.
"""
from __future__ import annotations

import sys
from pathlib import Path

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import audit_crawl as ac  # noqa: E402


class TestRelativeTime:
    def test_matches_german_seit_mehr_als(self):
        text = "Wir arbeiten seit mehr als 15 Jahren in diesem Markt."
        assert ac.RELATIVE_TIME.search(text)

    def test_matches_german_ueber_jahre(self):
        text = "Mit über 20 Jahren Erfahrung."
        assert ac.RELATIVE_TIME.search(text)

    def test_matches_english_over_years(self):
        assert ac.RELATIVE_TIME.search("We've been doing this for over 10 years.")

    def test_matches_english_more_than_years(self):
        assert ac.RELATIVE_TIME.search("More than 5 years of experience.")

    def test_does_not_match_fixed_year(self):
        text = "Founded in 2011. Serving clients since 2011."
        assert not ac.RELATIVE_TIME.search(text)

    def test_does_not_match_unrelated_number(self):
        assert not ac.RELATIVE_TIME.search("We have 20 employees.")


class TestFigureRegex:
    def test_matches_percentage(self):
        assert ac.FIGURE.findall("Conversion rose by 23%.")

    def test_matches_plain_number(self):
        matches = ac.FIGURE.findall("We ran 42 workshops last year.")
        assert any("42" in m for m in matches)

    def test_matches_plus_suffix(self):
        assert ac.FIGURE.findall("Over 500+ participants.")

    def test_ignores_single_digit(self):
        # \d{2,} requires at least two digits
        assert not ac.FIGURE.findall("We have 5 offices.")


class TestSchemaTypes:
    def test_extracts_single_type(self):
        html = """
        <script type="application/ld+json">{"@type": "FAQPage"}</script>
        """
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == ["FAQPage"]

    def test_extracts_from_graph(self):
        html = """
        <script type="application/ld+json">
        {"@graph": [{"@type": "Organization"}, {"@type": "WebPage"}]}
        </script>
        """
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == ["Organization", "WebPage"]

    def test_handles_type_as_list(self):
        html = """
        <script type="application/ld+json">{"@type": ["Article", "FAQPage"]}</script>
        """
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == ["Article", "FAQPage"]

    def test_ignores_malformed_json(self):
        html = '<script type="application/ld+json">{not valid json}</script>'
        soup = BeautifulSoup(html, "lxml")
        assert ac.schema_types(soup) == []

    def test_no_ld_json_returns_empty(self):
        soup = BeautifulSoup("<html><body><p>hi</p></body></html>", "lxml")
        assert ac.schema_types(soup) == []
