"""Question Radar scoring, topics, hit-rate log and export (monitoring/radar.py). No network."""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import monitoring.radar as radar  # noqa: E402
import monitoring.radar_sources as rs  # noqa: E402
import monitoring.run as run_module  # noqa: E402

NOW = datetime(2026, 11, 23, tzinfo=UTC)
CATS = [{"id": "geo", "keywords": ["generative engine optimization", "ai search"]},
        {"id": "tools", "keywords": ["tool", "open source"]}]
TERMS = ["llms.txt", "AI Overviews"]


def cand(text, **kw):
    s = radar.Sighting(text, kw.pop("origin", "hackernews"), kw.pop("date", "2026-11-20"), **kw)
    [c] = radar.group([s], {}, now=NOW)
    return c


class TestTextHelpers:
    def test_plural_stemming(self):
        assert radar.content_words("Tools for LLMs") == {"tool", "llm"}
        assert radar.content_words("class access") == {"class", "access"}

    def test_phrase_needs_adjacent_words_in_order(self):
        seq = radar.content_seq("How do I rank in AI search results")
        assert radar.has_phrase(seq, radar.content_seq("AI search"))
        assert not radar.has_phrase(radar.content_seq("AI agency for search"), radar.content_seq("AI search"))


class TestMomentum:
    @pytest.mark.parametrize("recent,baseline,expected", [(10, 10, 0.5), (22, 10, 0.75), (4, 10, 0.25), (0, 0, 0.5)])
    def test_from_counts(self, recent, baseline, expected):
        assert radar.momentum_from_counts(recent, baseline) == pytest.approx(expected, abs=0.01)

    def test_clamped(self):
        assert radar.momentum_from_counts(10_000, 0) == 1.0 and radar.momentum_from_counts(0, 10_000) == 0.0

    def test_events_by_distance(self):
        c = cand("What changes for llms.txt?", origin="event", event_date="2027-01-15")
        assert radar.momentum_of(c, {}, NOW) == 1.0
        c.event_date = "2026-01-01"
        assert radar.momentum_of(c, {}, NOW) == 0.2

    def test_recency_neutral_without_engine_history(self):
        c = cand("agent evaluation metrics", origin="engine", engine="claude", question_id="q1")
        assert radar.momentum_of(c, {}, NOW, engine_history=False) == 0.5
        assert radar.momentum_of(c, {}, NOW, engine_history=True) == pytest.approx(0.7)

    def test_rising_term_lifts_candidate(self):
        c = cand("Does llms.txt replace sitemap.xml?", date="2026-01-01")
        flat = radar.momentum_of(c, {}, NOW)
        rising = radar.momentum_of(c, {"llms.txt": {"momentum": 1.0}}, NOW)
        assert rising > flat


class TestScore:
    def test_fit_counts_distinct_phrases_and_picks_category(self):
        kw = radar.keyword_sets(CATS, TERMS)
        c = cand("Best open source tool for AI search?")
        fit, cat = radar.fit_of(c, kw)
        assert fit == 1.0 and cat == "tools"
        assert radar.fit_of(cand("Weather in Berlin?"), kw) == (0.0, None)

    def test_engine_searches_fit_at_least_half(self):
        c = cand("unrelated words", origin="engine", engine="gpt", question_id="q2")
        assert radar.fit_of(c, radar.keyword_sets(CATS, TERMS))[0] == 0.5

    def test_open_estimate_prefers_unanswered(self):
        se = "stackexchange:webmasters"
        assert radar.open_estimate(cand("Why no rich results?", origin=se, answered=False)) == 0.75
        assert radar.open_estimate(cand("Why no rich results?", origin=se, answered=True)) == 0.4

    def test_total_is_weighted_sum(self):
        c = radar.score(cand("Is llms.txt worth it for AI search?", engagement=40), {}, radar.keyword_sets(CATS, TERMS),
                        NOW, probe_open=0.9)
        p = {k: v / 100 for k, v in c.parts.items()}
        assert c.score == round(30 * p["momentum"] + 20 * p["demand"] + 30 * p["open"] + 20 * p["fit"])
        assert c.open_measured and c.parts["open"] == 90


def db_with_posts():
    conn = sqlite3.connect(":memory:")
    run_module.ensure_schema(conn)
    rs.ensure_tables(conn)
    posts = [
        rs.Post("hackernews", "1", "llms.txt", "Does llms.txt replace sitemap.xml?", "https://hn/1", "2026-11-10",
                score=12, answers=8),
        rs.Post("hackernews", "2", "llms.txt", "Can I get feedback on my llms.txt?", "https://hn/2", "2026-09-01",
                score=1, answers=0),  # noise: dropped
        # no reactions: dropped
        rs.Post("github", "3", "llms.txt", "How to add llms.txt?", "https://gh/3", "2026-11-01"),
        rs.Post("stackexchange:webmasters", "4", "AI Overviews", "Why are AI Overviews citing old pages?",
                "https://se/4", "2026-11-15", score=3, views=900, answers=0, answered=False),
        rs.Post("hackernews", "5", "llms.txt", "Weather in Berlin?", "https://hn/5", "2026-11-11", score=40),
    ]
    rs.store_posts(conn, posts, "2026-11-23")
    rs.store_count(conn, rs.Count("hackernews", "llms.txt", 20, 5.0), "2026-11-23")
    rs.store_count(conn, rs.Count("hackernews", "llms.txt", 1, 5.0), "2026-11-16")  # older snapshot: ignored
    rs.store_count(conn, rs.Count("wikipedia", "en:AI_Overviews", 3000, 6000.0, [1, 2, 3]), "2026-11-23")
    return conn


class TestTopicsAndBuild:
    def test_latest_snapshot_and_wikipedia_joins_its_term(self):
        topics = {t["term"]: t for t in radar.load_topics(db_with_posts(), TERMS)}
        assert topics["llms.txt"]["momentum"] > 0.5 and topics["llms.txt"]["sources"][0]["recent"] == 20
        assert topics["AI Overviews"]["momentum"] < 0.5 and topics["AI Overviews"]["series"] == [1, 2, 3]

    def test_build_drops_noise_and_off_topic(self):
        out = radar.build(db_with_posts(), {"terms": TERMS}, CATS, {}, NOW)
        texts = [c.query for c in out]
        assert "Does llms.txt replace sitemap.xml?" in texts and "Why are AI Overviews citing old pages?" in texts
        assert "Weather in Berlin?" not in texts and "How to add llms.txt?" not in texts
        assert all(c.links and c.links[0]["url"].startswith("https://") for c in out)

    def test_tracked_questions_sort_last(self):
        qwords = {"q9": radar.content_words("Does llms.txt replace sitemap.xml?")}
        out = radar.build(db_with_posts(), {"terms": TERMS}, CATS, qwords, NOW)
        assert out[-1].query == "Does llms.txt replace sitemap.xml?" and out[-1].new is False


class TestFlagsAndHitRate:
    def test_first_flag_date_kept_and_tracking_noted(self):
        conn = db_with_posts()
        out = radar.build(conn, {"terms": TERMS}, CATS, {}, NOW)
        assert radar.record_flags(conn, out, 0, "2026-09-01") == len(out)
        radar.record_flags(conn, out, 0, "2026-11-23")
        first = dict(conn.execute("SELECT query, first_flagged FROM radar_flags"))
        assert set(first.values()) == {"2026-09-01"}
        # The llms.txt question becomes a tracked question; the brand is then named in a run.
        qwords = {"q9": radar.content_words("Does llms.txt replace sitemap.xml?")}
        radar.record_flags(conn, radar.build(conn, {"terms": TERMS}, CATS, qwords, NOW), 101, "2026-11-23")
        conn.execute("INSERT INTO runs (question_id, engine, model, run_index, timestamp, mentioned, cited_urls, "
                     "answer_text) VALUES ('q9','claude','m',0,'2026-11-30T06:00:00',1,'[]','a')")
        h = radar.hit_rate(conn, datetime(2026, 12, 1, tzinfo=UTC))
        assert h["flagged"] == len(out) and h["checkable"] == len(out)
        assert h["tracked"] == 1 and h["mentioned_after"] == 1 and h["seen_again"] == len(out)

    def test_empty_database(self):
        assert radar.hit_rate(sqlite3.connect(":memory:"), NOW)["flagged"] == 0


class TestExport:
    def test_shape_for_the_app(self, monkeypatch, tmp_path):
        conn = db_with_posts()
        monkeypatch.setattr(radar, "load_target", lambda d: ({"terms": TERMS}, CATS, {}))
        out = radar.export(conn, "x", NOW)
        assert out["generated"] == "2026-11-23" and out["weights"] == radar.WEIGHTS
        assert out["origins"] == {"hackernews": 1, "stackexchange": 1}
        c = out["candidates"][0]
        assert {"id", "query", "score", "parts", "links", "origins", "first_seen"} <= set(c)
        assert len(c["first_seen"]) == 10
        json.dumps(out)  # serializable


class TestGitHubCorrection:
    def test_term_growth_divided_by_platform_growth(self):
        conn = sqlite3.connect(":memory:")
        rs.ensure_tables(conn)
        rs.store_count(conn, rs.Count("github", "llms.txt", 200, 100.0), "2026-11-23")
        assert radar.load_topics(conn, ["llms.txt"])[0]["momentum"] > 0.7  # x2 raw growth
        rs.store_count(conn, rs.Count("github", "*", 2000, 1000.0), "2026-11-23")  # GitHub itself grew x2
        [t] = radar.load_topics(conn, ["llms.txt"])
        assert t["term"] == "llms.txt" and t["sources"][0]["recent"] == 100 and t["momentum"] == 0.5
