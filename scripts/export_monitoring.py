"""Exports monitoring/runs.sqlite into a JSON file shaped like
data/demo_monitoring.json, for loading into the app's own-brand mode via
the file picker on the Sources tab — this is what finally makes a real
monitoring run visible in the UI (see TASKS.md C5; monitoring/run.py
writes real rows, but nothing read them into the app until this script).

Takes the most recent run per (question_id, engine) as that engine's
current status — a documented simplification, not an average across runs.
Engines with no real data yet for a question get "n" (not run), distinct
from "a" (checked, confirmed absent) — see app/core.js parseResult().

"competitor" is always null: run.py's mention_detection.detect_mention() ranks
the brand against data/competitors.json (TASKS.md C5a) but doesn't persist
*which* competitor was mentioned per row (only its rank), so there's nothing
to surface here yet. Populating this field means adding a column to
runs.sqlite for the matched competitor name, not just a config change.

Usage:
    python monitoring/run.py --questions q1,q2,q3 --engines claude --runs 1 --yes
    python scripts/export_monitoring.py   # reads monitoring/runs.sqlite by default
"""
from __future__ import annotations

import argparse
import datetime
import json
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
ENGINE_ORDER = ["claude", "gpt", "gemini"]

# Minimal, best-effort domain -> "kind" classification for cited_sources.
# Not exhaustive — an unlisted domain defaults to "portal". [heuristic]
KNOWN_KINDS = {
    "wikipedia.org": "wiki",
    "linkedin.com": "social",
    "reddit.com": "community",
    "twitter.com": "social",
    "x.com": "social",
}


def latest_per_question_engine(rows: list[sqlite3.Row]) -> dict[tuple[str, str], sqlite3.Row]:
    """Picks the most recent row (by timestamp) per (question_id, engine)."""
    latest: dict[tuple[str, str], sqlite3.Row] = {}
    for row in rows:
        key = (row["question_id"], row["engine"])
        if key not in latest or row["timestamp"] > latest[key]["timestamp"]:
            latest[key] = row
    return latest


def build_results(latest: dict[tuple[str, str], sqlite3.Row], own_domain: str) -> dict[str, dict]:
    results: dict[str, dict] = {}
    question_ids = sorted({qid for qid, _ in latest})
    for qid in question_ids:
        codes = []
        for engine in ENGINE_ORDER:
            row = latest.get((qid, engine))
            if row is None:
                codes.append("n")
                continue
            if not row["mentioned"]:
                codes.append("a")
                continue
            cited_urls = json.loads(row["cited_urls"])
            is_cited = bool(own_domain) and any(own_domain in url for url in cited_urls)
            codes.append(f"{'c' if is_cited else 'm'}{row['position']}")
        results[qid] = {"competitor": None, "r": " ".join(codes)}
    return results


def build_cited_sources(rows: list[sqlite3.Row]) -> list[dict]:
    per_domain: dict[str, dict] = defaultdict(lambda: {"cites": 0, "qs": set()})
    for row in rows:
        for url in json.loads(row["cited_urls"]):
            domain = urlparse(url if "//" in url else "//" + url).hostname
            if not domain:
                continue
            per_domain[domain]["cites"] += 1
            per_domain[domain]["qs"].add(row["question_id"])
    sources = [
        {
            "name": domain, "kind": KNOWN_KINDS.get(domain, "portal"),
            "cites": d["cites"], "qs": len(d["qs"]), "present": None, "act": "analyze",
        }
        for domain, d in per_domain.items()
    ]
    sources.sort(key=lambda s: -s["cites"])
    return sources


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "monitoring" / "runs.sqlite"))
    ap.add_argument("--out", default=str(ROOT / "monitoring" / "monitoring_export.json"))
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"No database at {db_path}. Run monitoring/run.py first.", file=sys.stderr)
        return 1

    brand = json.loads((ROOT / "data" / "brand.json").read_text(encoding="utf-8"))
    own_domain = brand.get("domain", "")

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM runs").fetchall()
    conn.close()

    if not rows:
        print("No rows in the database yet.", file=sys.stderr)
        return 1

    # Status per question comes from the original wording (variant 0) so it
    # stays comparable week to week; randomized variants (monitoring/variants.py)
    # still count toward cited_sources and stay in the database for analysis.
    originals = [r for r in rows if "variant" not in r.keys() or r["variant"] == 0]
    latest = latest_per_question_engine(originals or rows)
    export = {
        "_comment": "Exported from monitoring/runs.sqlite by scripts/export_monitoring.py — "
                    "real data, not demo data. 'r' codes: c=cited, m=mentioned, a=absent, n=not run for that engine.",
        "results": build_results(latest, own_domain),
        "cited_sources": build_cited_sources(rows),
        "trend": [],
        "pieces": [],
        "audit_meta": {"date": datetime.date.today().isoformat(), "pages": 0, "posts": 0},
    }
    Path(args.out).write_text(json.dumps(export, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Exported {len(export['results'])} question(s), {len(export['cited_sources'])} source(s) -> {args.out}")
    print("Load this file in the app: Monitor -> Sources -> 'Load monitoring results'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
