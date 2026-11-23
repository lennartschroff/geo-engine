"""Tests for monitoring/radar.py (Question Radar, first draft). No network."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import monitoring.radar as radar  # noqa: E402
import monitoring.run as run_module  # noqa: E402

QUESTIONS = {
    "q1": radar.content_words("Which consultancies help with LLMs in production?"),
    "q2": radar.content_words("What does a RAG pipeline consist of?"),
}


def rows(*items):
    """(question_id, engine, timestamp, [queries]) -> rows as stored."""
    return [(q, e, t, json.dumps(qs)) for q, e, t, qs in items]


class TestNormalize:
    def test_case_punctuation_and_spaces(self):
        assert radar.normalize("  RAG-Pipeline:   Kosten?! ") == "rag pipeline kosten"

    def test_keeps_umlauts_and_digits(self):
        assert radar.normalize("Übersicht 2027") == "übersicht 2027"

    def test_content_words_drop_stopwords_both_languages(self):
        assert radar.content_words("What is the best tool for RAG") == {"tool", "rag"}
        assert radar.content_words("Was ist die beste Beratung für RAG") == {"beste", "beratung", "rag"}


class TestCoverage:
    def test_covered_search_points_to_closest_question(self):
        qid, share = radar.coverage("RAG pipeline", QUESTIONS)
        assert qid == "q2" and share == 1.0

    def test_unrelated_search_has_low_overlap(self):
        qid, share = radar.coverage("EU AI Act obligations 2027", QUESTIONS)
        assert share == 0.0 and qid is None

    def test_no_questions(self):
        assert radar.coverage("anything", {}) == (None, 0.0)


class TestAggregate:
    def test_merges_case_and_word_order_and_counts_answers(self):
        data = rows(
            ("q1", "claude", "2026-11-02", ["EU AI Act obligations", "eu ai act OBLIGATIONS"]),
            ("q2", "gpt", "2026-11-09", ["obligations EU AI act"]),
        )
        [c] = radar.aggregate(data, QUESTIONS)
        assert c.count == 2  # the repeat within one answer counts once
        assert c.engines == ["claude", "gpt"] and c.questions == ["q1", "q2"]
        assert (c.first_seen, c.last_seen) == ("2026-11-02", "2026-11-09")
        assert c.new is True

    def test_groups_near_duplicates_and_keeps_variants(self):
        data = rows(
            ("q2", "claude", "t1", ["RAG vs long context 1M tokens"]),
            ("q2", "claude", "t2", ["RAG vs long context 1M tokens"]),
            ("q2", "gpt", "t3", ["rag vs long-context models 1M tokens"]),
        )
        [c] = radar.aggregate(data, QUESTIONS)
        assert c.count == 3 and c.query == "RAG vs long context 1M tokens"
        assert c.variants == ["rag vs long-context models 1M tokens"]

    def test_merge_can_be_turned_off(self):
        data = rows(("q2", "claude", "t", ["RAG vs long context", "RAG vs long context models"]))
        assert len(radar.aggregate(data, QUESTIONS, merge_at=1.01)) == 2

    def test_new_ones_first_then_by_count(self):
        data = rows(
            ("q2", "claude", "t", ["RAG pipeline"]),
            ("q2", "gpt", "t", ["RAG pipeline", "vector database pricing"]),
            ("q1", "gpt", "t", ["LLM consultancy references"]),
        )
        out = radar.aggregate(data, QUESTIONS)
        assert [c.new for c in out] == [True, True, False]
        assert out[-1].query == "RAG pipeline" and out[-1].closest_question == "q2"

    def test_bad_json_and_non_strings_are_skipped(self):
        data = [("q1", "claude", "t", "not json"), ("q1", "claude", "t", json.dumps([None, 3, "", "real one"]))]
        [c] = radar.aggregate(data, QUESTIONS)
        assert c.query == "real one"


class TestDatabase:
    def test_reads_rows_written_by_run_py(self, tmp_path):
        conn = sqlite3.connect(tmp_path / "r.sqlite")
        run_module.ensure_schema(conn)
        conn.execute(
            "INSERT INTO runs (question_id, engine, model, run_index, timestamp, mentioned, cited_urls, "
            "answer_text, search_queries) VALUES ('q1','claude','m',0,'t',0,'[]','a',?)",
            (json.dumps(["geo tools"]),),
        )
        conn.execute(
            "INSERT INTO runs (question_id, engine, model, run_index, timestamp, mentioned, cited_urls, "
            "answer_text, search_queries) VALUES ('q1','gemini','m',0,'t',0,'[]','a','[]')"
        )
        assert radar.load_rows(conn) == [("q1", "claude", "t", '["geo tools"]')]

    def test_old_database_without_column_gives_no_rows(self, tmp_path):
        conn = sqlite3.connect(tmp_path / "old.sqlite")
        conn.execute("CREATE TABLE runs (question_id TEXT, engine TEXT, timestamp TEXT)")
        assert radar.load_rows(conn) == []

    def test_main_json_end_to_end(self, tmp_path, capsys):
        db = tmp_path / "r.sqlite"
        conn = sqlite3.connect(db)
        run_module.ensure_schema(conn)
        conn.execute(
            "INSERT INTO runs (question_id, engine, model, run_index, timestamp, mentioned, cited_urls, "
            "answer_text, search_queries) VALUES ('q1','claude','m',0,'t',0,'[]','a',?)",
            (json.dumps(["Contoso AI pricing 2027"]),),
        )
        conn.commit()
        conn.close()
        assert radar.main(["--db", str(db), "--target", "data", "--json"]) == 0
        [c] = json.loads(capsys.readouterr().out)
        assert c["query"] == "Contoso AI pricing 2027" and c["count"] == 1 and "spellings" not in c

    def test_main_missing_db(self, tmp_path):
        assert radar.main(["--db", str(tmp_path / "nope.sqlite")]) == 1
