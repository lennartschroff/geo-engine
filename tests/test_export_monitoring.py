"""Unit tests for scripts/export_monitoring.py."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from export_monitoring import (  # noqa: E402
    build_answers,
    build_cited_sources,
    build_results,
    build_trend,
    latest_per_question_engine,
    wilson,
)

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

    def test_competitor_is_null_without_competitor_list(self):
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


V2_SCHEMA = SCHEMA.replace("answer_text TEXT", "answer_text TEXT, variant INTEGER, question_text TEXT")


def make_v2_db(rows):
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(V2_SCHEMA)
    for r in rows:
        conn.execute(
            "INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (r["question_id"], r["engine"], "m", 0, r["timestamp"], None, r["mentioned"], None, "[]",
             r.get("text", ""), r.get("variant", 0), r.get("prompt")),
        )
    return conn.execute("SELECT * FROM runs").fetchall()


class TestCompetitorDetection:
    def test_first_named_competitor_is_reported(self):
        rows = make_v2_db([{"question_id": "q1", "engine": "claude", "timestamp": "2026-11-23T06:00:00",
                            "mentioned": 0, "text": "Try Matomo or Umami; Matomo is popular."}])
        results = build_results(latest_per_question_engine(rows), "", ["Plausible"], ["Umami", "Matomo"])
        assert results["q1"]["competitor"] == "Matomo"


class TestWilson:
    def test_zero_trials(self):
        assert wilson(0, 0) == (0.0, 0.0)

    def test_known_value(self):
        lo, hi = wilson(10, 100)  # textbook: 5.5% .. 17.4%
        assert round(lo, 3) == 0.055 and round(hi, 3) == 0.174

    def test_bounds_stay_in_unit_interval(self):
        assert wilson(0, 5)[0] == 0.0 and wilson(5, 5)[1] == 1.0


class TestBuildTrend:
    def test_groups_by_iso_week_with_interval(self):
        rows = make_v2_db(
            [{"question_id": "q1", "engine": "claude", "timestamp": "2026-11-23T06:00:00+00:00", "mentioned": m}
             for m in (1, 0, 0, 0)]
            + [{"question_id": "q1", "engine": "claude", "timestamp": "2026-11-30T06:00:00+00:00", "mentioned": 1}]
        )
        trend = build_trend(rows)
        assert [t["week"] for t in trend] == ["2026-W48", "2026-W49"]
        assert trend[0]["rate"] == 25 and trend[0]["n"] == 4 and trend[0]["lo"] < 25 < trend[0]["hi"]


class TestBuildAnswers:
    def test_latest_per_engine_and_variant_with_prompt(self):
        rows = make_v2_db([
            {"question_id": "q1", "engine": "gemini", "timestamp": "2026-11-16T06", "mentioned": 0, "text": "old"},
            {"question_id": "q1", "engine": "gemini", "timestamp": "2026-11-23T06", "mentioned": 0, "text": "new"},
            {"question_id": "q1", "engine": "claude", "timestamp": "2026-11-23T06", "mentioned": 0, "text": "c"},
            {"question_id": "q1", "engine": "claude", "timestamp": "2026-11-23T06", "mentioned": 0, "text": "v",
             "variant": 1, "prompt": "Quick question: Q?"},
        ])
        out = build_answers(rows)["q1"]
        assert [(a["engine"], a["variant"], a["text"]) for a in out] == [
            ("claude", 0, "c"), ("gemini", 0, "new"), ("claude", 1, "v")]
        assert out[2]["prompt"] == "Quick question: Q?"


class TestExportMain:
    def test_export_uses_target_and_includes_setup(self, tmp_path, monkeypatch):
        import export_monitoring as em
        db = tmp_path / "r.sqlite"
        conn = sqlite3.connect(db)
        conn.execute(V2_SCHEMA)
        conn.execute("INSERT INTO runs VALUES ('q1','claude','m',0,'2026-11-23T06:00:00+00:00',NULL,1,1,"
                     "'[\"lennartschroff.github.io\"]','GEO Engine is an open-source tool. Peec too.',0,NULL)")
        conn.commit()
        conn.close()
        out = tmp_path / "out.json"
        monkeypatch.setattr(sys, "argv", ["x", "--db", str(db), "--out", str(out), "--target", "targets/geo-engine"])
        assert em.main() == 0
        data = json.loads(out.read_text())
        assert data["setup"]["brand"]["name"] == "GEO Engine"
        assert len(data["setup"]["questions"]) == 15
        assert data["results"]["q1"] == {"competitor": "Peec", "r": "c1 n n"}


class TestBuildSetup:
    QS = [{"id": "q1", "text": "A", "categories": ["x"], "key": True},
          {"id": "q2", "text": "B", "categories": ["x"], "key": False}]

    def test_without_run_list_setup_is_unchanged(self):
        from export_monitoring import build_setup
        s = build_setup({"name": "B"}, [], self.QS, None)
        assert s["questions"] == self.QS and "run_list" not in s

    def test_run_list_adds_custom_questions_and_ids(self):
        from export_monitoring import build_setup
        rl = [{"id": "q2", "text": "B", "categories": ["x"]}, {"id": "c1", "text": "Mine", "categories": ["x"]}]
        s = build_setup({"name": "B"}, [], self.QS, rl)
        assert [q["id"] for q in s["questions"]] == ["q1", "q2", "c1"]
        assert s["questions"][2]["custom"] is True and s["questions"][2]["key"] is False
        assert s["run_list"] == ["q2", "c1"]
