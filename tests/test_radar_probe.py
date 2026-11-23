"""Open-slot probe (monitoring/radar_probe.py): assessment, storage and the
cost gate. Engine calls are fakes; nothing goes over the network."""
from __future__ import annotations

import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import monitoring.radar as radar  # noqa: E402
import monitoring.radar_probe as rp  # noqa: E402
import monitoring.run as run_module  # noqa: E402

NOW = datetime(2026, 11, 23, tzinfo=UTC)


class TestAssess:
    def test_counts_names_sources_and_hedging(self):
        a = rp.assess("I'm not aware of any tool. Competitor A maybe.", ["https://a.example/x", "https://a.example/y"],
                      ["Contoso AI"], ["Competitor A", "Competitor B"])
        assert a == {"named": 1, "brand": False, "cited": 1, "hedged": True, "providers": ["Competitor A"]}

    def test_german_hedge(self):
        assert rp.assess("Dazu sind mir keine konkreten Anbieter bekannt.", [], [], [])["hedged"]

    @pytest.mark.parametrize("a,expected", [
        ({"named": 0, "cited": 0, "hedged": False, "brand": False}, 1.0),
        ({"named": 3, "cited": 4, "hedged": False, "brand": False}, 0.0),
        ({"named": 3, "cited": 4, "hedged": True, "brand": False}, 0.8),
        ({"named": 0, "cited": 0, "hedged": False, "brand": True}, 0.3),
    ])
    def test_open_score(self, a, expected):
        assert rp.open_score(a) == expected


def candidate(text):
    [c] = radar.group([radar.Sighting(text, "hackernews", "2026-11-20")], {}, now=NOW)
    return c


class TestProbe:
    def test_stores_rows_and_skips_failing_engine(self, monkeypatch):
        calls = []

        def ok(text, cfg):
            calls.append(text)
            return {"answer_text": "Competitor A and Competitor B.", "cited_urls": ["https://b.example"]}

        def broken(text, cfg):
            raise RuntimeError("rate limited")
        monkeypatch.setitem(run_module.ENGINE_CALLS, "claude", ok)
        monkeypatch.setitem(run_module.ENGINE_CALLS, "gpt", broken)
        conn = sqlite3.connect(":memory:")
        cs = [candidate("Is llms.txt worth it?"), candidate("How to get cited by AI search?")]
        cfgs = {"claude": {"model": "m1"}, "gpt": {"model": "m2"}}
        n = rp.probe(conn, cs, ["claude", "gpt"], cfgs, ["Brand"], ["Competitor A", "Competitor B"], False,
                     log=lambda m: None)
        assert n == 2 and len(calls) == 2
        loaded = rp.load_probe_open(conn, NOW)
        assert set(loaded) == {c.id for c in cs}
        assert loaded[cs[0].id]["engines"]["claude"]["named"] == 2
        assert loaded[cs[0].id]["open"] == pytest.approx(rp.open_score({"named": 2, "cited": 1, "hedged": False,
                                                                         "brand": False}), abs=0.01)
        assert rp.recently_probed(conn, NOW) == {c.id for c in cs}

    def test_dry_run_uses_fixtures(self):
        conn = sqlite3.connect(":memory:")
        assert rp.probe(conn, [candidate("Is llms.txt worth it?")], ["claude", "gemini"], {}, ["Brand"], [], True) == 2
        assert {r[0] for r in conn.execute("SELECT model FROM radar_probes")} == {"fixture"}


class TestCli:
    def _conn_with_candidates(self):
        conn = sqlite3.connect(":memory:")
        run_module.ensure_schema(conn)
        conn.execute("INSERT INTO runs (question_id, engine, model, run_index, timestamp, mentioned, cited_urls, "
                     "answer_text, search_queries) VALUES ('q1','claude','m',0,'2026-11-20',0,'[]','a',?)",
                     ('["llms.txt adoption statistics", "AI search ranking factors"]',))
        return conn

    def _args(self, **kw):
        return SimpleNamespace(**{"engines": "claude", "dry_run": False, "yes": False, "top": 5, **kw})

    def _settings(self, usd=3.0):
        return {"engines": {}, "budget": {"max_usd_per_run": usd, "max_calls_per_run": 100}}

    def _run(self, conn, args, settings, monkeypatch, called):
        monkeypatch.setattr(run_module, "_load_dotenv", lambda: None)
        monkeypatch.setitem(run_module.ENGINE_CALLS, "claude", lambda t, c: called.append(t) or
                            {"answer_text": "x", "cited_urls": []})
        return rp.run_probe_cli(conn, args, settings, "data", {"terms": []}, [], {}, NOW)

    def test_no_key_no_calls(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        called = []
        assert self._run(self._conn_with_candidates(), self._args(), self._settings(), monkeypatch, called) == 1
        assert called == []

    def test_budget_cap_aborts_before_calls(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        called = []
        assert self._run(self._conn_with_candidates(), self._args(yes=True), self._settings(usd=0.0001),
                         monkeypatch, called) == 1
        assert called == []

    def test_runs_with_yes_and_skips_recent(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        conn = self._conn_with_candidates()
        called = []
        assert self._run(conn, self._args(yes=True), self._settings(), monkeypatch, called) == 0
        assert len(called) == 2
        assert self._run(conn, self._args(yes=True), self._settings(), monkeypatch, called) == 0
        assert len(called) == 2  # probed less than 4 weeks ago: not asked again
