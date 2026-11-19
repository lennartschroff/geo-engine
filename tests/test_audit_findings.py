"""Unit tests for scripts/audit_findings.py (F3b)."""
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from audit_findings import build_findings, robots_blocked_bots  # noqa: E402

TODAY = datetime.date(2026, 11, 19)


def page(url, **kw):
    base = {"url": url, "status": 200, "title": "t", "meta_description": "d", "schema_types": ["Organization"],
            "published": "", "modified": "", "h1": ["H"], "h2": [], "h2_count": 0, "question_headings": 0,
            "words": 800, "figures": 3, "relative_time": [], "text": ""}
    base.update(kw)
    return base


GOOD_CHECKS = {"crawler_access": {b: 200 for b in ["GPTBot", "ClaudeBot", "OAI-SearchBot", "PerplexityBot"]},
               "llms_txt_status": 200, "robots_txt": "User-agent: *\nAllow: /\n"}


def ids(findings):
    return {f["id"] for f in findings}


class TestBuildFindings:
    def test_clean_site_has_no_findings(self):
        pages = [page("https://x.example/", schema_types=["Organization", "FAQPage"])]
        assert build_findings(pages, GOOD_CHECKS, TODAY) == []

    def test_blocked_answer_bot_is_high_priority(self):
        checks = dict(GOOD_CHECKS, crawler_access={"OAI-SearchBot": 403, "GPTBot": 403, "Googlebot": 200})
        f = build_findings([page("https://x.example/", schema_types=["Organization", "FAQPage"])], checks, TODAY)
        by_id = {x["id"]: x for x in f}
        assert by_id["f-bots-answer"]["priority"] == "high" and "OAI-SearchBot" in by_id["f-bots-answer"]["en"][1]
        assert by_id["f-bots-training"]["priority"] == "mid"
        assert f[0]["priority"] == "high"  # sorted by priority

    def test_page_level_findings_with_counts_and_examples(self):
        pages = [
            page("https://x.example/a", schema_types=[], h1=[], relative_time=["over 15 years"], figures=0,
                 words=100, meta_description="", published="2019-03-01"),
            page("https://x.example/b", schema_types=[], figures=0),
            {"url": "https://x.example/broken", "error": "timeout"},
        ]
        f = {x["id"]: x for x in build_findings(pages, None, TODAY)}
        assert set(f) == {"f-org-schema", "f-faq", "f-h1", "f-relative-time", "f-figures", "f-thin", "f-meta",
                          "f-stale", "f-broken"}
        assert "1 of 2 pages have no H1" in f["f-h1"]["en"][1]
        assert "over 15 years" in f["f-relative-time"]["de"][1]
        assert "before 2023" in f["f-stale"]["en"][1]

    def test_recently_modified_article_is_not_stale(self):
        pages = [page("https://x.example/a", schema_types=["Organization", "FAQPage"], published="2015-01-01",
                      modified="2026-01-10")]
        assert "f-stale" not in ids(build_findings(pages, GOOD_CHECKS, TODAY))

    def test_output_matches_the_app_audit_schema(self):
        pages = [page("https://x.example/a", schema_types=[], h1=[])]
        schema = json.loads((ROOT / "schemas" / "audit_actions.schema.json").read_text())
        errors = list(Draft7Validator(schema).iter_errors(build_findings(pages, dict(GOOD_CHECKS, llms_txt_status=404),
                                                                          TODAY)))
        assert errors == []


class TestRobots:
    def test_disallow_all_for_named_bot(self):
        txt = "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
        assert robots_blocked_bots(txt, {"GPTBot", "ClaudeBot", "PerplexityBot"}) == ["ClaudeBot", "GPTBot"]

    def test_partial_disallow_is_not_a_block(self):
        assert robots_blocked_bots("User-agent: GPTBot\nDisallow: /private/\n", {"GPTBot"}) == []

    def test_wildcard_group_is_not_counted_as_named_block(self):
        assert robots_blocked_bots("User-agent: *\nDisallow: /\n", {"GPTBot"}) == []
