"""Unit tests for scripts/export_monitoring.py."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from export_monitoring import build_cited_sources, build_results, latest_per_question_engine  # noqa: E402

SCHEMA = """
    CREATE TABLE runs (
        question_id TEXT, engine TEXT, model TEXT, run_index INTEGER,
        timestamp TEXT, language TEXT, mentioned INTEGER, position INTEGER,
        cited_urls TEXT, answer_text TEXT
    )
"""


def row(question_id, engine, timestamp, mentioned, position=None, cited_urls=None):
    """Shorthand for one runs-table row as a dict, with sensible defaults."""
    return {
        "question_id": question_id, "engine": engine, "timestamp": timestamp,
        "mentioned": mentioned, "position": position, "cited_urls": cited_urls or [],
    }


def make_db(rows):
    """In-memory SQLite DB with the given row dicts inserted, row_factory set."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(SCHEMA)
    for r in rows:
        conn.execute(
            "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?)",
            (r["question_id"], r["engine"], "claude-sonnet-5", 0,
             r["timestamp"], None, r["mentioned"], r["position"],
             json.dumps(r["cited_urls"]), ""),
        )
    conn.commit()
    return conn.execute("SELECT * FROM runs").fetchall()


class TestLatestPerQuestionEngine:
    def test_picks_the_most_recent_row(self):
        rows = make_db([
            row("q1", "claude", "2026-01-01T00:00:00", mentioned=0),
            row("q1", "claude", "2026-01-02T00:00:00", mentioned=1, position=1),
        ])
        latest = latest_per_question_engine(rows)
        assert latest[("q1", "claude")]["timestamp"] == "2026-01-02T00:00:00"

    def test_separates_different_engines(self):
        rows = make_db([
            row("q1", "claude", "t1", mentioned=1, position=2),
            row("q1", "gpt", "t1", mentioned=0),
        ])
        latest = latest_per_question_engine(rows)
        assert set(latest.keys()) == {("q1", "claude"), ("q1", "gpt")}


class TestBuildResults:
    def test_absent_engine_gets_a_code(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=0)])
        results = build_results(latest_per_question_engine(rows), own_domain="brand.example")
        assert results["q1"]["r"] == "a n n"

    def test_mentioned_but_not_cited_gets_m_code_with_position(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=1, position=3, cited_urls=["other.example"])])
        results = build_results(latest_per_question_engine(rows), own_domain="brand.example")
        assert results["q1"]["r"] == "m3 n n"

    def test_mentioned_and_cited_gets_c_code(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=1, position=1,
                             cited_urls=["brand.example", "other.example"])])
        results = build_results(latest_per_question_engine(rows), own_domain="brand.example")
        assert results["q1"]["r"] == "c1 n n"

    def test_missing_engine_entirely_gets_not_run(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=1, position=1)])
        results = build_results(latest_per_question_engine(rows), own_domain="")
        assert results["q1"]["r"] == "m1 n n"

    def test_competitor_is_always_null(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=0)])
        results = build_results(latest_per_question_engine(rows), own_domain="")
        assert results["q1"]["competitor"] is None

    def test_empty_own_domain_never_matches_as_cited(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=1, position=1, cited_urls=["anything.example"])])
        results = build_results(latest_per_question_engine(rows), own_domain="")
        assert results["q1"]["r"].startswith("m1")


class TestBuildCitedSources:
    def test_counts_citations_and_distinct_questions_per_domain(self):
        rows = make_db([
            row("q1", "claude", "t1", mentioned=0, cited_urls=["a.example"]),
            row("q2", "claude", "t1", mentioned=0, cited_urls=["a.example", "b.example"]),
        ])
        sources = build_cited_sources(rows)
        by_name = {s["name"]: s for s in sources}
        assert by_name["a.example"]["cites"] == 2
        assert by_name["a.example"]["qs"] == 2
        assert by_name["b.example"]["cites"] == 1
        assert by_name["b.example"]["qs"] == 1

    def test_known_domain_gets_classified_kind(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=0, cited_urls=["wikipedia.org"])])
        sources = build_cited_sources(rows)
        assert sources[0]["kind"] == "wiki"

    def test_unknown_domain_defaults_to_portal(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=0, cited_urls=["totally-unknown-site.example"])])
        sources = build_cited_sources(rows)
        assert sources[0]["kind"] == "portal"

    def test_sorted_by_cites_descending(self):
        rows = make_db([
            row("q1", "claude", "t1", mentioned=0, cited_urls=["rare.example"]),
            row("q2", "claude", "t1", mentioned=0, cited_urls=["common.example"]),
            row("q3", "claude", "t1", mentioned=0, cited_urls=["common.example"]),
        ])
        sources = build_cited_sources(rows)
        assert sources[0]["name"] == "common.example"

    def test_no_citations_returns_empty_list(self):
        rows = make_db([row("q1", "claude", "t1", mentioned=0, cited_urls=[])])
        assert build_cited_sources(rows) == []
