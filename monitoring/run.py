"""Monitoring CLI (ROADMAP.md Milestone 1).

Sends the tracked questions to each engine, detects brand mentions, and
writes one row per (question, engine, run) to SQLite.

Real API calls are NOT implemented yet — see TASKS.md Epic C4, gated on:
  - which provider(s) to integrate first (your decision)
  - a weekly spend ceiling (your decision)
Calling this without --dry-run currently raises NotImplementedError. Use
--dry-run to exercise the whole pipeline (question selection, mention
detection, SQLite write) against recorded fixtures, at zero cost.

Usage:
    python monitoring/run.py --dry-run
    python monitoring/run.py --dry-run --questions q1,q2 --engines claude,gpt
    python monitoring/run.py --dry-run --db /tmp/test.sqlite
"""
from __future__ import annotations

import argparse
import json
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
    if not dry_run:
        raise NotImplementedError(
            "Real API calls are not implemented yet (TASKS.md C4) — pending your decision on "
            "which provider(s) to use and a spend cap. Use --dry-run to test the pipeline."
        )
    answer = load_fixture_answer(question["id"], engine)
    if answer is None:
        raise ValueError(f"No fixture answer for question={question['id']!r} engine={engine!r} in {FIXTURES_PATH.name}")

    result = detect_mention(answer["answer_text"], brand_aliases, COMPETITOR_NAMES)
    return {
        "question_id": question["id"],
        "engine": engine,
        "model": "fixture",
        "run_index": run_index,
        "timestamp": datetime.now(UTC).isoformat(),
        "language": None,  # TODO: not derivable from questions.json yet (text is mixed-language by design)
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

    question_ids = args.questions.split(",") if args.questions else None
    engines = args.engines.split(",")
    questions = load_questions(question_ids)
    if not questions:
        print("No matching questions found.", file=sys.stderr)
        return 1

    estimate = estimate_cost(len(questions), engines, args.runs)
    print(f"Questions: {len(questions)}  Engines: {engines}  Runs/question: {args.runs}")
    print(f"Estimated calls: {estimate.num_calls}  Estimated cost: ${estimate.total_usd:.4f} "
          f"({', '.join(f'{e}=${c:.4f}' for e, c in estimate.per_engine_usd.items())})")
    if not args.dry_run:
        print("[placeholder pricing — verify against current provider pricing before trusting this number]")

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
