"""Unit tests for monitoring/run.py's pure-ish helpers.

run_one()/call_claude() are not covered here (real network calls) -- those
were verified manually against the real Anthropic API, see TASKS.md C4a.
This covers the .env loader, which is easy to get subtly wrong and cheap to
verify without touching the network.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import monitoring.run as run_module  # noqa: E402

ENV_TEST_KEY = "GEO_ENGINE_TEST_DOTENV_VAR"


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
