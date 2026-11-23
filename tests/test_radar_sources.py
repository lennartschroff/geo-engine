"""monitoring/radar_sources.py with a fake HTTP function: no network."""
from __future__ import annotations

import gzip
import io
import json
import sqlite3
import sys
import urllib.error
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import monitoring.radar_sources as rs  # noqa: E402

NOW = datetime(2026, 11, 23, 12, 0, tzinfo=UTC)


def params(url):
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))


class FakeHttp:
    """Answers by host/path; records every URL asked for."""

    def __init__(self, handler):
        self.handler, self.urls, self.headers = handler, [], []

    def __call__(self, url, headers=None, **kw):
        self.urls.append(url)
        self.headers.append(headers or {})
        return self.handler(url, params(url))


class TestQuestions:
    @pytest.mark.parametrize("title", ["Does llms.txt replace sitemap.xml", "Ask HN: Anyone tracking AI citations",
                                       "Is GEO just SEO?", "Wie messe ich KI-Sichtbarkeit", "Which tool for this"])
    def test_question_like(self, title):
        assert rs.is_question(title)

    @pytest.mark.parametrize("title", ["Show HN: My GEO tool", "llms.txt directory", "Generative engine optimization"])
    def test_not_question_like(self, title):
        assert not rs.is_question(title)

    def test_clean_title(self):
        assert rs.clean_title("Ask HN: What&#39;s llms.txt for?") == "What's llms.txt for?"


class TestHackerNews:
    def test_posts_and_counts(self):
        def handler(url, p):
            if "search_by_date" in url:
                return {"nbHits": 12, "hits": [
                    {"objectID": 1, "title": "Ask HN: Does llms.txt help?", "points": 9, "num_comments": 4,
                     "created_at": "2026-11-01T10:00:00Z"},
                    {"objectID": 2, "title": "Show HN: llms.txt generator", "points": 50, "created_at": "2026-10-01"},
                ]}
            return {"nbHits": 2}
        http = FakeHttp(handler)
        posts, count = rs.hackernews("llms.txt", NOW, http)
        assert [p.title for p in posts] == ["Does llms.txt help?"]
        assert posts[0].url == "https://news.ycombinator.com/item?id=1" and posts[0].answers == 4
        assert (count.recent, count.baseline) == (2, 2.0)  # (12 - 2) / 5 windows

    def test_multi_word_term_is_a_phrase(self):
        http = FakeHttp(lambda url, p: {"nbHits": 0, "hits": []})
        rs.hackernews("answer engine optimization", NOW, http)
        assert params(http.urls[0])["query"] == '"answer engine optimization"'


class TestStackExchange:
    def test_posts_counts_and_backoff(self):
        slept = []

        def handler(url, p):
            if p.get("filter") == "total":
                return {"total": 3 if int(p["fromdate"]) > 1790000000 else 13}
            return {"backoff": 2, "items": [
                {"question_id": 7, "title": "What about `llms.txt`?", "link": "https://webmasters.example/q/7",
                 "creation_date": 1782604800, "score": 2, "view_count": 1079, "answer_count": 2, "is_answered": True},
            ]}
        posts, count = rs.stackexchange("llms.txt", "webmasters", NOW, FakeHttp(handler), slept.append)
        assert posts[0].source == "stackexchange:webmasters" and posts[0].views == 1079 and posts[0].answered is True
        assert (count.recent, count.baseline) == (3, 2.0)
        assert slept == [2]

    def test_api_error_raises(self):
        with pytest.raises(rs.SourceError, match="throttle"):
            rs.stackexchange("x", "webmasters", NOW, FakeHttp(lambda u, p: {"error_id": 502, "error_name": "throttle"}),
                             lambda s: None)


class TestGitHub:
    def test_counts_from_items_when_all_fit(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        items = [{"id": 1, "title": "How do I add llms.txt?", "html_url": "u1", "created_at": "2026-11-10T00:00:00Z",
                  "comments": 2, "reactions": {"total_count": 1}},
                 {"id": 2, "title": "Add llms.txt", "html_url": "u2", "created_at": "2026-08-01T00:00:00Z"}]
        http = FakeHttp(lambda u, p: {"total_count": 2, "items": items})
        posts, count = rs.github("llms.txt", NOW, http)
        assert len(http.urls) == 1 and "Authorization" not in http.headers[0]
        assert [p.post_id for p in posts] == ["1"] and posts[0].score == 1
        assert (count.recent, count.baseline) == (1, 0.2)

    def test_second_query_when_more_results_than_items(self, monkeypatch):
        monkeypatch.setenv("GITHUB_TOKEN", "t")
        http = FakeHttp(lambda u, p: {"total_count": 500, "items": []} if p["per_page"] == "100"
                        else {"total_count": 100})
        _, count = rs.github("geo", NOW, http)
        assert (count.recent, count.baseline) == (100, 80.0)
        assert http.headers[0]["Authorization"] == "Bearer t"


class TestWikipedia:
    def test_recent_baseline_and_weekly_series(self):
        days = [10] * 150 + [20] * 30
        http = FakeHttp(lambda u, p: {"items": [{"views": v} for v in days]})
        count = rs.wikipedia("en:Generative_engine_optimization", NOW, http)
        assert "/en.wikipedia/all-access/user/Generative_engine_optimization/daily/" in http.urls[0]
        assert (count.recent, count.baseline) == (600, 300.0)
        assert len(count.series) == 25 and count.series[-1] == 140


class TestHttp:
    def _resp(self, body: bytes, gz=False):
        class R(io.BytesIO):
            headers = {"Content-Encoding": "gzip"} if gz else {}
            def __enter__(self): return self
            def __exit__(self, *a): return False
        return R(gzip.compress(body) if gz else body)

    def test_gzip_and_user_agent(self, monkeypatch):
        seen = {}
        def fake_open(req, timeout, context):
            seen["ua"] = req.headers["User-agent"]
            return self._resp(b'{"ok": 1}', gz=True)
        monkeypatch.setattr(rs.urllib.request, "urlopen", fake_open)
        monkeypatch.delenv("RADAR_USER_AGENT", raising=False)
        assert rs.http_get_json("https://x.example/a") == {"ok": 1}
        assert seen["ua"] == rs.DEFAULT_USER_AGENT

    def test_retries_on_429_then_fails(self, monkeypatch):
        calls = []
        def fake_open(req, timeout, context):
            calls.append(1)
            raise urllib.error.HTTPError(req.full_url, 429, "slow down", {"Retry-After": "1"}, None)
        monkeypatch.setattr(rs.urllib.request, "urlopen", fake_open)
        slept = []
        with pytest.raises(rs.SourceError, match="HTTP 429"):
            rs.http_get_json("https://x.example/a", retries=2, sleep=slept.append)
        assert len(calls) == 3 and slept == [1.0, 1.0]


class TestCollect:
    def test_stores_posts_and_counts_and_survives_one_failure(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)

        def handler(url, p):
            if "algolia" in url:
                return {"nbHits": 5, "hits": [{"objectID": 9, "title": "How to rank in AI search?", "points": 3,
                                               "created_at": "2026-11-20T00:00:00Z"}]}
            if "github" in url:
                raise rs.SourceError("HTTP 403 for api.github.com")
            return {"items": [{"views": 5}] * 40}
        conn = sqlite3.connect(":memory:")
        logs = []
        cfg = {"terms": ["AI search"], "sources": {"hackernews": True, "github": True, "wikipedia": ["en:X"]}}
        summary = rs.collect(conn, cfg, NOW, FakeHttp(handler), sleep=lambda s: None, log=logs.append)
        assert summary["posts"] == 1 and summary["counts"] == 2 and len(summary["errors"]) == 2  # term + platform
        assert conn.execute("SELECT title, first_fetched FROM radar_posts").fetchall() == [
            ("How to rank in AI search?", "2026-11-23")]
        sources = {r[0] for r in conn.execute("SELECT source FROM radar_counts")}
        assert sources == {"hackernews", "wikipedia"}

    def test_refetch_updates_numbers_keeps_first_seen(self):
        conn = sqlite3.connect(":memory:")
        rs.ensure_tables(conn)
        p = rs.Post("hackernews", "1", "t", "Why?", "u", "2026-11-01", score=1)
        rs.store_posts(conn, [p], "2026-11-16")
        p.score = 7
        rs.store_posts(conn, [p], "2026-11-23")
        assert conn.execute("SELECT score, first_fetched, last_fetched FROM radar_posts").fetchone() == (
            7, "2026-11-16", "2026-11-23")
        rs.store_count(conn, rs.Count("wikipedia", "en:X", 5, 2.0, [1, 2]), "2026-11-23")
        assert json.loads(conn.execute("SELECT series FROM radar_counts").fetchone()[0]) == [1, 2]


class TestGitHubPlatform:
    def test_platform_count_windows(self, monkeypatch):
        monkeypatch.delenv("GITHUB_TOKEN", raising=False)
        http = FakeHttp(lambda u, p: {"total_count": 900 if ">=" in p["q"] else 2500})
        count = rs.github_all(NOW, http)
        assert (count.term, count.recent, count.baseline) == ("*", 900, 500.0)
        assert params(http.urls[1])["q"] == "is:issue created:2026-05-27..2026-10-23"
