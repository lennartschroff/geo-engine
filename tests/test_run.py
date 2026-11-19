"""Unit tests for monitoring/run.py's pure-ish helpers.

run_one()/call_claude() are not covered here (real network calls) -- those
were verified manually against the real Anthropic API, see TASKS.md C4a.
This covers the .env loader, which is easy to get subtly wrong and cheap to
verify without touching the network.
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import types
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import monitoring.run as run_module  # noqa: E402

ENV_TEST_KEY = "GEO_ENGINE_TEST_DOTENV_VAR"


class TestDetectLanguage:
    def test_umlaut_is_german(self):
        assert run_module.detect_language("Wie erkenne ich frühzeitig Trends?") == "de"

    def test_eszett_is_german(self):
        assert run_module.detect_language("Was muss ich groß planen?") == "de"

    def test_common_german_word_without_umlauts(self):
        assert run_module.detect_language("Was kostet eine RAG Implementierung") == "de"

    def test_plain_english_question(self):
        assert run_module.detect_language("Best consultancies for building production AI agents") == "en"

    def test_english_with_no_german_markers(self):
        assert run_module.detect_language("How to run an AI adoption sprint") == "en"

    def test_all_real_questions_classify_as_expected(self):
        # Spot-checks against data/questions.json rather than re-deriving the
        # whole file's expected answer -- a handful of known cases in each
        # language, not a brittle full-file assertion.
        assert run_module.detect_language("RAG-Anbieter in den USA") == "en"  # named entities only, no DE marker word
        assert run_module.detect_language("Wie baue ich eine Retrieval-Augmented-Generation-Pipeline auf?") == "de"


@pytest.fixture
def isolated_root(tmp_path, monkeypatch):
    """Points monitoring.run.ROOT at a scratch dir and cleans up the test env var."""
    monkeypatch.setattr(run_module, "ROOT", tmp_path)
    os.environ.pop(ENV_TEST_KEY, None)
    yield tmp_path
    os.environ.pop(ENV_TEST_KEY, None)


class TestLoadDotenv:
    def test_sets_a_plain_key_value(self, isolated_root):
        (isolated_root / ".env").write_text(f"{ENV_TEST_KEY}=plainvalue\n")
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "plainvalue"

    def test_strips_double_quotes(self, isolated_root):
        (isolated_root / ".env").write_text(f'{ENV_TEST_KEY}="quoted value"\n')
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "quoted value"

    def test_strips_single_quotes(self, isolated_root):
        (isolated_root / ".env").write_text(f"{ENV_TEST_KEY}='quoted value'\n")
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "quoted value"

    def test_does_not_strip_mismatched_quotes(self, isolated_root):
        (isolated_root / ".env").write_text(f"{ENV_TEST_KEY}='mismatched\"\n")
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "'mismatched\""

    def test_ignores_comments_and_blank_lines(self, isolated_root):
        (isolated_root / ".env").write_text(f"# a comment\n\n{ENV_TEST_KEY}=value\n")
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "value"

    def test_does_not_override_an_already_set_env_var(self, isolated_root, monkeypatch):
        monkeypatch.setenv(ENV_TEST_KEY, "from-real-environment")
        (isolated_root / ".env").write_text(f"{ENV_TEST_KEY}=from-dotenv-file\n")
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "from-real-environment"

    def test_missing_env_file_does_not_raise(self, isolated_root):
        run_module._load_dotenv()  # no .env written -- should just return quietly

    def test_value_containing_equals_sign_is_preserved(self, isolated_root):
        (isolated_root / ".env").write_text(f"{ENV_TEST_KEY}=part1=part2\n")
        run_module._load_dotenv()
        assert os.environ[ENV_TEST_KEY] == "part1=part2"


class TestLoadCompetitorNames:
    def test_reads_names_from_competitors_json(self, isolated_root):
        (isolated_root / "data").mkdir()
        (isolated_root / "data" / "competitors.json").write_text(
            json.dumps({"_comment": "placeholder", "names": ["Tailspin", "Fabrikam"]})
        )
        assert run_module.load_competitor_names() == ["Tailspin", "Fabrikam"]


class TestMainPersistsPartialResultsOnCrash:
    """A real run pays per API call made. If a later call in the loop raises
    (rate limit, network error, an unimplemented engine slipping through),
    rows already written for earlier calls must still be on disk -- not lost
    because main() only committed once at the very end.
    """

    def test_rows_written_before_a_crash_are_not_lost(self, isolated_root, monkeypatch, tmp_path):
        questions = [{"id": "q1", "text": "Q1", "key": True}, {"id": "q2", "text": "Q2", "key": True}]
        monkeypatch.setattr(run_module, "load_questions", lambda ids: questions)
        monkeypatch.setattr(run_module, "load_brand_aliases", lambda: ["Brand"])
        monkeypatch.setattr(run_module, "load_competitor_names", lambda: ["Competitor A"])

        call_count = {"n": 0}

        def fake_run_one(question, engine, run_index, brand_aliases, competitor_names, dry_run):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise RuntimeError("simulated API failure on the second call")
            return {
                "question_id": question["id"], "engine": engine, "model": "m", "run_index": run_index,
                "timestamp": "t", "language": "en", "mentioned": 0, "position": None,
                "cited_urls": "[]", "answer_text": "x",
            }

        monkeypatch.setattr(run_module, "run_one", fake_run_one)

        db_path = tmp_path / "runs.sqlite"
        monkeypatch.setattr(
            sys, "argv", ["run.py", "--dry-run", "--engines", "claude", "--runs", "1", "--db", str(db_path)]
        )

        with pytest.raises(RuntimeError):
            run_module.main()

        conn = sqlite3.connect(db_path)
        written = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        conn.close()
        assert written == 1  # the row from the first (successful) call must survive the second call's crash


class TestCallGemini:
    """call_gemini() makes a real network call, so these mock the google-genai
    client and only cover the pure logic around it: error messages and the
    defensive citation-extraction walk. The 429-on-free-tier path itself was
    verified for real against a live key (see call_gemini()'s docstring and
    TASKS.md) -- these tests just pin down the code's reaction to that error.
    """

    def test_missing_api_key_raises_clear_error(self, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="GEMINI_API_KEY"):
            run_module.call_gemini("Any question")

    def test_rate_limit_error_raises_clear_billing_message(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        fake_client = Mock()
        fake_client.interactions.create.side_effect = Exception(
            "429 too_many_requests: check your plan and billing details"
        )
        with patch("google.genai.Client", return_value=fake_client):
            with pytest.raises(RuntimeError, match="rate-limit|429|grounding"):
                run_module.call_gemini("Any question")

    def test_non_rate_limit_error_propagates_unchanged(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        fake_client = Mock()
        fake_client.interactions.create.side_effect = ValueError("something else broke")
        with patch("google.genai.Client", return_value=fake_client):
            with pytest.raises(ValueError, match="something else broke"):
                run_module.call_gemini("Any question")

    def test_extracts_answer_text_and_citations(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        annotation = types.SimpleNamespace(type="url_citation", url="https://example.com/a")
        block = types.SimpleNamespace(type="text", annotations=[annotation])
        step = types.SimpleNamespace(type="model_output", content=[block])
        interaction = types.SimpleNamespace(output_text="The answer.", steps=[step])
        fake_client = Mock()
        fake_client.interactions.create.return_value = interaction
        with patch("google.genai.Client", return_value=fake_client):
            result = run_module.call_gemini("Any question")
        assert result == {"answer_text": "The answer.", "cited_urls": ["https://example.com/a"]}

    def test_no_annotations_yields_empty_cited_urls(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        block = types.SimpleNamespace(type="text", annotations=[])
        step = types.SimpleNamespace(type="model_output", content=[block])
        interaction = types.SimpleNamespace(output_text="Plain answer, no search.", steps=[step])
        fake_client = Mock()
        fake_client.interactions.create.return_value = interaction
        with patch("google.genai.Client", return_value=fake_client):
            result = run_module.call_gemini("Any question")
        assert result == {"answer_text": "Plain answer, no search.", "cited_urls": []}

    def test_missing_steps_attribute_does_not_crash(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        interaction = types.SimpleNamespace(output_text="No steps at all.")
        fake_client = Mock()
        fake_client.interactions.create.return_value = interaction
        with patch("google.genai.Client", return_value=fake_client):
            result = run_module.call_gemini("Any question")
        assert result == {"answer_text": "No steps at all.", "cited_urls": []}
