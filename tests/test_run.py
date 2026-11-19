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
        assert run_module.detect_language("RAG-Anbieter in den USA") == "de"
        assert run_module.detect_language("Gute KI-Beratung in Austin") == "de"
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
        monkeypatch.setattr(run_module, "load_questions", lambda ids, scope="key", data_dir="data": questions)
        monkeypatch.setattr(run_module, "load_brand_aliases", lambda data_dir="data": ["Brand"])
        monkeypatch.setattr(run_module, "load_competitor_names", lambda data_dir="data": ["Competitor A"])

        call_count = {"n": 0}

        def fake_run_one(question, engine, run_index, brand_aliases, competitor_names, dry_run, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 2:
                raise RuntimeError("simulated API failure on the second call")
            return {
                "question_id": question["id"], "engine": engine, "model": "m", "run_index": run_index,
                "timestamp": "t", "language": "en", "mentioned": 0, "position": None,
                "cited_urls": "[]", "answer_text": "x", "variant": 0, "question_text": "Q",
            }

        monkeypatch.setattr(run_module, "run_one", fake_run_one)

        db_path = tmp_path / "runs.sqlite"
        monkeypatch.setattr(
            sys, "argv",
            ["run.py", "--dry-run", "--engines", "claude", "--runs", "1", "--variants", "0", "--db", str(db_path)],
        )

        with pytest.raises(RuntimeError):
            run_module.main()

        conn = sqlite3.connect(db_path)
        written = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        conn.close()
        assert written == 1  # the row from the first (successful) call must survive the second call's crash


GROUNDED = {"model": "gemini-test", "grounding": True, "free_tier": False}


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
            result = run_module.call_gemini("Any question", GROUNDED)
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

    def test_grounding_off_sends_no_tools(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        fake_client = Mock()
        fake_client.interactions.create.return_value = types.SimpleNamespace(output_text="Plain.")
        with patch("google.genai.Client", return_value=fake_client):
            run_module.call_gemini("Q", {"model": "m", "grounding": False, "free_tier": True})
        assert "tools" not in fake_client.interactions.create.call_args.kwargs

    def test_grounding_on_sends_google_search_tool(self, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "test-key")
        fake_client = Mock()
        fake_client.interactions.create.return_value = types.SimpleNamespace(output_text="x")
        with patch("google.genai.Client", return_value=fake_client):
            run_module.call_gemini("Q", GROUNDED)
        assert fake_client.interactions.create.call_args.kwargs["tools"] == [{"type": "google_search"}]


class TestCallGpt:
    """Mocked: covers request shape and citation extraction. Not yet verified
    against the real API (first real run is gated on cost approval)."""

    def _response(self, text, urls):
        anns = [types.SimpleNamespace(type="url_citation", url=u) for u in urls]
        block = types.SimpleNamespace(type="output_text", annotations=anns)
        msg = types.SimpleNamespace(type="message", content=[block])
        call = types.SimpleNamespace(type="web_search_call")
        return types.SimpleNamespace(output_text=text, output=[call, msg])

    def test_missing_api_key_raises_clear_error(self, monkeypatch):
        monkeypatch.delenv("OPENAI_API_KEY", raising=False)
        with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
            run_module.call_gpt("Q")

    def test_extracts_answer_and_citations(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        fake = Mock()
        fake.responses.create.return_value = self._response("Answer.", ["https://a.com/x", "https://b.org"])
        with patch("openai.OpenAI", return_value=fake):
            result = run_module.call_gpt("Q", {"model": "gpt-test", "reasoning_effort": "low"})
        assert result == {"answer_text": "Answer.", "cited_urls": ["https://a.com/x", "https://b.org"]}
        kwargs = fake.responses.create.call_args.kwargs
        assert kwargs["model"] == "gpt-test"
        assert kwargs["tools"] == [{"type": "web_search"}]
        assert kwargs["reasoning"] == {"effort": "low"}

    def test_response_without_output_items_does_not_crash(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", "test-key")
        fake = Mock()
        fake.responses.create.return_value = types.SimpleNamespace(output_text="Just text.")
        with patch("openai.OpenAI", return_value=fake):
            assert run_module.call_gpt("Q")["cited_urls"] == []


def _settings(**over):
    s = json.loads(run_module.SETTINGS_PATH.read_text(encoding="utf-8"))
    s.update(over)
    return s


class TestMainWithSettings:
    @pytest.fixture
    def env(self, tmp_path, monkeypatch):
        questions = [{"id": "q1", "text": "Best AI consultancies", "key": True}]
        monkeypatch.setattr(run_module, "load_questions", lambda ids, scope="key", data_dir="data": questions)
        monkeypatch.setattr(run_module, "load_brand_aliases", lambda data_dir="data": ["Brand"])
        monkeypatch.setattr(run_module, "load_competitor_names", lambda data_dir="data": [])
        monkeypatch.setattr(run_module, "_load_dotenv", lambda: None)
        for key in run_module.API_KEY_ENV.values():
            monkeypatch.delenv(key, raising=False)
        return tmp_path

    def _run(self, monkeypatch, env, settings, *extra):
        path = env / "settings.json"
        path.write_text(json.dumps(settings))
        db = env / "runs.sqlite"
        monkeypatch.setattr(sys, "argv", ["run.py", "--settings", str(path), "--db", str(db), *extra])
        code = run_module.main()
        rows = []
        if db.exists():
            conn = sqlite3.connect(db)
            conn.row_factory = sqlite3.Row
            rows = [dict(r) for r in conn.execute("SELECT * FROM runs")]
            conn.close()
        return code, rows

    def test_variants_add_one_prompt_per_question_shared_across_engines(self, monkeypatch, env):
        code, rows = self._run(monkeypatch, env, _settings(), "--dry-run", "--engines", "claude,gemini", "--seed", "3")
        assert code == 0
        assert sorted((r["engine"], r["variant"]) for r in rows) == [
            ("claude", 0), ("claude", 1), ("gemini", 0), ("gemini", 1)]
        texts = {r["engine"]: r["question_text"] for r in rows if r["variant"] == 1}
        assert texts["claude"] == texts["gemini"] != "Best AI consultancies"

    def test_variants_disabled_in_settings(self, monkeypatch, env):
        s = _settings(variants={"enabled": False, "per_question": 1})
        code, rows = self._run(monkeypatch, env, s, "--dry-run", "--engines", "claude")
        assert [r["variant"] for r in rows] == [0]

    def test_engines_default_to_enabled_ones(self, monkeypatch, env):
        code, rows = self._run(monkeypatch, env, _settings(), "--dry-run", "--variants", "0")
        enabled = sorted(e for e, c in _settings()["engines"].items() if c["enabled"])
        assert sorted(r["engine"] for r in rows) == enabled

    def test_real_run_skips_engines_without_key(self, monkeypatch, env):
        code, rows = self._run(monkeypatch, env, _settings(), "--engines", "claude,gemini", "--yes")
        assert code == 1 and rows == []  # no keys at all -> nothing to run, no calls made

    def test_budget_cap_aborts_before_any_call(self, monkeypatch, env):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        called = Mock()
        monkeypatch.setitem(run_module.ENGINE_CALLS, "claude", called)
        s = _settings(budget={"max_usd_per_run": 0.001, "max_calls_per_run": 100})
        code, rows = self._run(monkeypatch, env, s, "--engines", "claude", "--yes")
        assert code == 1 and not called.called

    def test_one_failing_engine_does_not_stop_the_others(self, monkeypatch, env):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
        monkeypatch.setenv("GEMINI_API_KEY", "k")
        monkeypatch.setitem(run_module.ENGINE_CALLS, "claude", Mock(side_effect=Exception("529 overloaded")))
        monkeypatch.setitem(run_module.ENGINE_CALLS, "gemini",
                            Mock(return_value={"answer_text": "Brand is good.", "cited_urls": []}))
        code, rows = self._run(monkeypatch, env, _settings(), "--engines", "claude,gemini", "--yes")
        assert code == 2  # partial success
        assert {r["engine"] for r in rows} == {"gemini"} and len(rows) == 2
        assert all(r["mentioned"] == 1 for r in rows)


class TestSchemaMigration:
    def test_old_database_gets_new_columns_and_keeps_rows(self, tmp_path):
        conn = sqlite3.connect(tmp_path / "old.sqlite")
        conn.execute("""CREATE TABLE runs (question_id TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
            run_index INTEGER NOT NULL, timestamp TEXT NOT NULL, language TEXT, mentioned INTEGER NOT NULL,
            position INTEGER, cited_urls TEXT NOT NULL, answer_text TEXT NOT NULL)""")
        conn.execute("INSERT INTO runs VALUES ('q1','claude','m',0,'t','en',1,1,'[]','a')")
        run_module.ensure_schema(conn)
        row = conn.execute("SELECT question_id, variant, question_text FROM runs").fetchone()
        assert row == ("q1", 0, None)


class TestKeysFlowFromDotenv:
    """F4: a key written to .env is what makes an engine run -- end to end
    through main(), with the provider call mocked."""

    def test_key_in_dotenv_enables_engine(self, isolated_root, monkeypatch, tmp_path):
        for key in run_module.API_KEY_ENV.values():
            monkeypatch.delenv(key, raising=False)
        (isolated_root / ".env").write_text("GEMINI_API_KEY=from-dotenv\n")
        one_q = [{"id": "q1", "text": "Q one"}]
        monkeypatch.setattr(run_module, "load_questions", lambda ids, scope="key", data_dir="data": one_q)
        monkeypatch.setattr(run_module, "load_brand_aliases", lambda data_dir="data": ["Brand"])
        monkeypatch.setattr(run_module, "load_competitor_names", lambda data_dir="data": [])
        seen = {}

        def fake_gemini(text, cfg):
            seen["key"] = os.environ.get("GEMINI_API_KEY")
            return {"answer_text": "x", "cited_urls": []}

        monkeypatch.setitem(run_module.ENGINE_CALLS, "gemini", fake_gemini)
        db = tmp_path / "r.sqlite"
        monkeypatch.setattr(sys, "argv", ["run.py", "--engines", "claude,gemini", "--variants", "0", "--db", str(db)])
        try:
            assert run_module.main() == 0
        finally:
            os.environ.pop("GEMINI_API_KEY", None)
        assert seen["key"] == "from-dotenv"  # claude had no key and was skipped, gemini ran


class TestTarget:
    def test_loaders_read_the_target_folder(self, isolated_root):
        tdir = isolated_root / "targets" / "x"
        tdir.mkdir(parents=True)
        (tdir / "brand.json").write_text(json.dumps({"aliases": ["Real Brand"]}))
        (tdir / "competitors.json").write_text(json.dumps({"names": ["Rival"]}))
        qs = [{"id": "q1", "text": "T", "key": True}, {"id": "q2", "text": "U"}]
        (tdir / "questions.json").write_text(json.dumps(qs))
        assert run_module.load_brand_aliases(data_dir="targets/x") == ["Real Brand"]
        assert run_module.load_competitor_names(data_dir="targets/x") == ["Rival"]
        assert [q["id"] for q in run_module.load_questions(None, "key", data_dir="targets/x")] == ["q1"]

    def test_settings_target_is_used_and_cli_overrides_it(self, monkeypatch, tmp_path):
        seen = []
        one_q = [{"id": "q1", "text": "Q"}]
        monkeypatch.setattr(run_module, "load_questions",
                            lambda ids, scope="key", data_dir="data": seen.append(data_dir) or one_q)
        monkeypatch.setattr(run_module, "load_brand_aliases", lambda data_dir="data": ["B"])
        monkeypatch.setattr(run_module, "load_competitor_names", lambda data_dir="data": [])
        settings = _settings(target="targets/geo-engine")
        path = tmp_path / "s.json"
        path.write_text(json.dumps(settings))
        base = ["run.py", "--dry-run", "--settings", str(path), "--engines", "claude", "--variants", "0",
                "--db", str(tmp_path / "r.sqlite")]
        monkeypatch.setattr(sys, "argv", base)
        run_module.main()
        monkeypatch.setattr(sys, "argv", base + ["--target", "data"])
        run_module.main()
        assert seen == ["targets/geo-engine", "data"]
