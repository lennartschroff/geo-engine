"""Unit tests for scripts/score_pages.py."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from score_pages import CRITERIA_ORDER, score_page  # noqa: E402

BRAND = "Tailspin"


def make_page(**overrides) -> dict:
    base = {
        "url": "https://www.example.com/en/some-page/",
        "status": 200,
        "title": "Some page",
        "meta_description": "",
        "schema_types": [],
        "h1": [],
        "h2": [],
        "h2_count": 0,
        "question_headings": 0,
        "words": 0,
        "figures": 0,
        "relative_time": [],
        "text": "",
    }
    base.update(overrides)
    return base


class TestScorePage:
    def test_crawl_error_returns_none(self):
        assert score_page({"url": "x", "error": "timeout"}, BRAND) is None

    def test_page_meeting_nothing_scores_zero(self):
        s = score_page(make_page(), BRAND)
        assert s["score"] == 0
        assert set(s["missing"]) == set(CRITERIA_ORDER)

    def test_page_meeting_everything_scores_100(self):
        page = make_page(
            meta_description="A" * 60,
            figures=3,
            question_headings=2,
            schema_types=["FAQPage", "Organization"],
            words=800,
            h1=[f"What is {BRAND}?"],
            text="Read our case study about a client success story.",
        )
        s = score_page(page, BRAND)
        assert s["score"] == 100
        assert s["missing"] == []

    def test_meta_description_too_short_fails_def(self):
        s = score_page(make_page(meta_description="Too short."), BRAND)
        assert "def" in s["missing"]

    def test_h1_present_but_without_brand_fails_h1(self):
        s = score_page(make_page(h1=["Welcome to our services"]), BRAND)
        assert "h1" in s["missing"]

    def test_h1_with_brand_passes(self):
        s = score_page(make_page(h1=[f"{BRAND} Robotics — Warehouse automation"]), BRAND)
        assert "h1" not in s["missing"]

    def test_faq_schema_detection_is_case_sensitive_to_schema_org_type(self):
        s = score_page(make_page(schema_types=["Article"]), BRAND)
        assert "faq" in s["missing"]
        s2 = score_page(make_page(schema_types=["FAQPage"]), BRAND)
        assert "faq" not in s2["missing"]

    def test_german_case_study_keyword_detected(self):
        s = score_page(make_page(text="Lesen Sie unsere Fallstudie zu einem Kundenprojekt."), BRAND)
        assert "case" not in s["missing"]

    def test_path_extracted_from_url(self):
        s = score_page(make_page(url="https://www.example.com/en/warehouse-automation/"), BRAND)
        assert s["path"] == "/en/warehouse-automation/"

    def test_title_prefers_h1_over_meta_title(self):
        s = score_page(make_page(title="Meta title", h1=["Actual H1"]), BRAND)
        assert s["de"] == "Actual H1"
        assert s["en"] == "Actual H1"

    def test_title_falls_back_to_meta_title_when_no_h1(self):
        s = score_page(make_page(title="Meta title", h1=[]), BRAND)
        assert s["de"] == "Meta title"
