"""Monitoring CLI (ROADMAP.md Milestone 1).

Sends the tracked questions to each engine, detects brand mentions, and
writes one row per (question, engine, run) to SQLite.

Real API calls: only "claude" is implemented so far (TASKS.md C4), using
claude-sonnet-5 with the web search tool, reading ANTHROPIC_API_KEY from a
local .env — never shared, never sent anywhere but Anthropic's API. "gpt"
and "gemini" still raise NotImplementedError outside --dry-run. Use
--dry-run to exercise the whole pipeline against recorded fixtures at zero
cost; real runs always print a cost estimate first and require --yes above
the configured threshold (see cost_estimate.py).

Usage:
    python monitoring/run.py --dry-run
    python monitoring/run.py --dry-run --questions q1,q2 --engines claude,gpt
    python monitoring/run.py --questions q1,q2,q3 --engines claude --runs 1 --yes
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monitoring.cost_estimate import check_call_budget, estimate_cost, needs_confirmation  # noqa: E402
from monitoring.mention_detection import detect_mention, normalize_domains  # noqa: E402

ALL_ENGINES = ["claude", "gpt", "gemini"]
FIXTURES_PATH = ROOT / "monitoring" / "fixtures" / "sample_answers.json"
CLAUDE_MODEL = "claude-sonnet-5"
CLAUDE_MAX_SEARCHES = 2


def _load_dotenv() -> None:
    """Minimal .env loader (no new dependency): KEY=VALUE lines, '#' comments.
    Strips one layer of matching quotes around the value (KEY="value" and
    KEY='value' are both common .env conventions) -- without this, a quoted
    key would silently include the literal quote characters and fail auth.
    """
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def call_claude(question_text: str) -> dict:
    """One real call to claude-sonnet-5 with web search enabled.

    Returns {"answer_text": str, "cited_urls": list[str]}. Raises RuntimeError
    with a clear message if the API key is missing or the call fails — never
    silently returns a fake result.
    """
    try:
        import anthropic
    except ImportError as e:
        raise RuntimeError("The 'anthropic' package isn't installed — run: pip install -r requirements.txt") from e

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set — add it to .env (see .env.example).")

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=1024,
        # Thinking defaults to on (adaptive) on claude-sonnet-5 when omitted, and
        # thinking tokens are billed as output tokens even though never shown --
        # a real cost driver for a simple "ask, maybe search, check the answer"
        # task like this one, confirmed by real spend exceeding the estimate on
        # the first test run. Disabled explicitly (accepted on Sonnet 5).
        thinking={"type": "disabled"},
        messages=[{"role": "user", "content": question_text}],
        tools=[{"type": "web_search_20250305", "name": "web_search", "max_uses": CLAUDE_MAX_SEARCHES}],
    )

    answer_text = "".join(block.text for block in response.content if block.type == "text")
    cited_urls = [
        result.url
        for block in response.content
        if block.type == "web_search_tool_result" and isinstance(block.content, list)
        for result in block.content
        if getattr(result, "type", None) == "web_search_result"
    ]
    return {"answer_text": answer_text, "cited_urls": cited_urls}

# Heuristic EN/DE detection for the question text (README's own design is a
# deliberately mixed-language question set) — looks for German umlauts or a
# few common German function words. Not a real language detector; good
# enough since individual questions are almost always unambiguously one or
# the other, just not reliably tagged as such anywhere in questions.json.
GERMAN_MARKERS = re.compile(r"[äöüßÄÖÜ]|(?<![\wäöü])(wie|was|welche|welcher|welches|für|ist|sind)(?![\wäöü])", re.I)


def detect_language(text: str) -> str:
    return "de" if GERMAN_MARKERS.search(text) else "en"


# [placeholder] no maintained competitor list exists yet (see ROADMAP.md).
# These match the fictional names already used in data/demo_monitoring.json,
# just so dry-run mentions/rank logic has something real to rank against.
COMPETITOR_NAMES = ["Competitor A", "Competitor B", "Competitor C", "Competitor D"]


def load_questions(question_ids: list[str] | None) -> list[dict]:
    questions = json.loads((ROOT / "data" / "questions.json").read_text(encoding="utf-8"))
    if question_ids:
        wanted = set(question_ids)
        questions = [q for q in questions if q["id"] in wanted]
    else:
        questions = [q for q in questions if q.get("key")]  # default: the 15 key questions
    return questions


def load_brand_aliases() -> list[str]:
    brand = json.loads((ROOT / "data" / "brand.json").read_text(encoding="utf-8"))
    return brand["aliases"]


def load_fixture_answer(question_id: str, engine: str) -> dict | None:
    fixtures = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
    return fixtures.get(question_id, {}).get(engine)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            question_id TEXT NOT NULL,
            engine TEXT NOT NULL,
            model TEXT NOT NULL,
            run_index INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            language TEXT,
            mentioned INTEGER NOT NULL,
            position INTEGER,
            cited_urls TEXT NOT NULL,
            answer_text TEXT NOT NULL
        )
    """)
    conn.commit()


def run_one(question: dict, engine: str, run_index: int, brand_aliases: list[str], dry_run: bool) -> dict:
    if dry_run:
        answer = load_fixture_answer(question["id"], engine)
        if answer is None:
            raise ValueError(f"No fixture answer for {question['id']!r}/{engine!r} in {FIXTURES_PATH.name}")
        model = "fixture"
    elif engine == "claude":
        answer = call_claude(question["text"])
        model = CLAUDE_MODEL
    else:
        raise NotImplementedError(
            f"Real API calls for engine={engine!r} are not implemented yet (TASKS.md C4). "
            "Only 'claude' is wired in so far. Use --dry-run, or --engines claude."
        )

    result = detect_mention(answer["answer_text"], brand_aliases, COMPETITOR_NAMES)
    return {
        "question_id": question["id"],
        "engine": engine,
        "model": model,
        "run_index": run_index,
        "timestamp": datetime.now(UTC).isoformat(),
        "language": detect_language(question["text"]),
        "mentioned": int(result.mentioned),
        "position": result.position,
        "cited_urls": json.dumps(normalize_domains(answer["cited_urls"])),
        "answer_text": answer["answer_text"],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="Use recorded fixtures instead of real API calls.")
    ap.add_argument("--db", default=str(ROOT / "monitoring" / "runs.sqlite"), help="SQLite output path.")
    ap.add_argument("--questions", help="Comma-separated question ids. Default: the 15 key questions.")
    ap.add_argument("--engines", default=",".join(ALL_ENGINES), help="Comma-separated engines.")
    ap.add_argument("--runs", type=int, default=3, help="Runs per question per engine.")
    ap.add_argument("--yes", action="store_true", help="Skip the cost confirmation prompt.")
    ap.add_argument("--max-calls", type=int, default=None, help="Hard cap on total API calls; aborts if exceeded.")
    ap.add_argument("--yes-threshold-usd", type=float, default=1.0, help="Est. cost above which --yes is required.")
    args = ap.parse_args()

    _load_dotenv()
    question_ids = args.questions.split(",") if args.questions else None
    engines = args.engines.split(",")
    questions = load_questions(question_ids)
    if not questions:
        print("No matching questions found.", file=sys.stderr)
        return 1

    estimate = estimate_cost(len(questions), engines, args.runs, searches_per_call=CLAUDE_MAX_SEARCHES)
    print(f"Questions: {len(questions)}  Engines: {engines}  Runs/question: {args.runs}")
    print(f"Estimated calls: {estimate.num_calls}  Estimated cost: ${estimate.total_usd:.4f} "
          f"({', '.join(f'{e}=${c:.4f}' for e, c in estimate.per_engine_usd.items())})")
    if not args.dry_run:
        non_claude = set(engines) - {"claude"}
        if non_claude:
            print(f"[pricing for {sorted(non_claude)} is still placeholder — not implemented, would raise below]")
        print("Token-count assumptions are still rough; the per-token and per-search unit prices for "
              "claude-sonnet-5 are verified (2026-11-18). Real cost depends on actual answer length.")

    try:
        check_call_budget(estimate.num_calls, args.max_calls)
    except Exception as e:  # CallBudgetExceeded
        print(f"Aborting: {e}", file=sys.stderr)
        return 1

    if not args.dry_run:
        if needs_confirmation(estimate, args.yes_threshold_usd) and not args.yes:
            print(f"Estimated cost ${estimate.total_usd:.4f} exceeds threshold ${args.yes_threshold_usd:.2f}. "
                  f"Re-run with --yes to proceed.", file=sys.stderr)
            return 1

    brand_aliases = load_brand_aliases()
    conn = sqlite3.connect(args.db)
    ensure_schema(conn)
    written = 0
    for q in questions:
        for engine in engines:
            for run_index in range(args.runs):
                row = run_one(q, engine, run_index, brand_aliases, args.dry_run)
                conn.execute(
                    "INSERT INTO runs (question_id, engine, model, run_index, timestamp, language, mentioned, "
                    "position, cited_urls, answer_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (row["question_id"], row["engine"], row["model"], row["run_index"], row["timestamp"],
                     row["language"], row["mentioned"], row["position"], row["cited_urls"], row["answer_text"]),
                )
                written += 1
    conn.commit()
    conn.close()
    print(f"Wrote {written} row(s) to {args.db}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
