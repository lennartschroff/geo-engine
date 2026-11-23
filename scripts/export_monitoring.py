"""Exports monitoring/runs.sqlite into a JSON file shaped like
data/demo_monitoring.json, for loading into the app's own-brand mode via
the file picker on the Sources tab — this is what finally makes a real
monitoring run visible in the UI (see TASKS.md C5; monitoring/run.py
writes real rows, but nothing read them into the app until this script).

Takes the most recent run per (question_id, engine) as that engine's
current status — a documented simplification, not an average across runs.
Engines with no real data yet for a question get "n" (not run), distinct
from "a" (checked, confirmed absent) — see app/core.js parseResult().

"competitor" is the first competitor (data/competitors.json) named in the
latest original answer, re-detected from the stored answer text, or null.

Also exported (all optional in the schema, so older exports still load):
- "answers": latest answer text per question/engine/variant (TASKS.md D1),
  so the app can show it with brand/competitor mentions highlighted.
- "competitors": the names used for highlighting and share of voice (D2).
- "trend_ci": mention rate per ISO week with a 95% Wilson interval (D3);
  "trend" gets the same rates as plain numbers for the existing chart.
- "radar": Question Radar candidates, topic momentum and hit rate
  (monitoring/radar.py, TASKS.md Epic H), when there is anything on it.

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
from math import sqrt
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from monitoring.mention_detection import detect_mention  # noqa: E402
from monitoring.run_list import load_run_list  # noqa: E402

MAX_ANSWER_CHARS = 6000
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


def target_from_settings() -> str:
    path = ROOT / "data" / "monitoring_settings.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8")).get("target", "data")
    return "data"


def first_competitor(rows: list[sqlite3.Row], brand_aliases: list[str], competitors: list[str]) -> str | None:
    """First competitor named across these answers (claude, gpt, gemini order)."""
    for row in sorted(rows, key=lambda r: ENGINE_ORDER.index(r["engine"]) if r["engine"] in ENGINE_ORDER else 9):
        names = detect_mention(row["answer_text"], brand_aliases, competitors).providers_mentioned
        named = [n for n in names if n != "(brand)"]
        if named:
            return named[0]
    return None


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for k successes in n trials, as fractions.
    Better than the normal approximation at small n and rates near 0/100%,
    which is exactly this data (dozens of answers a week, low mention rates)."""
    if n == 0:
        return 0.0, 0.0
    p = k / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, centre - half), min(1.0, centre + half)


def build_trend(rows: list[sqlite3.Row]) -> list[dict]:
    """Mention rate per ISO week over all answers that week (all engines,
    original wording and variants), with a 95% interval -- answers vary run
    to run, so a week-over-week change only means something when the
    intervals don't overlap."""
    weeks: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for row in rows:
        iso = datetime.datetime.fromisoformat(row["timestamp"]).isocalendar()
        key = f"{iso.year}-W{iso.week:02d}"
        weeks[key][0] += int(row["mentioned"])
        weeks[key][1] += 1
    out = []
    for week in sorted(weeks):
        k, n = weeks[week]
        lo, hi = wilson(k, n)
        out.append({"week": week, "n": n, "k": k, "rate": round(100 * k / n),
                    "lo": round(100 * lo), "hi": round(100 * hi)})
    return out


def build_answers(rows: list[sqlite3.Row]) -> dict[str, list[dict]]:
    """Latest answer per (question, engine, variant), for the answer viewer."""
    latest: dict[tuple[str, str, int], sqlite3.Row] = {}
    for row in rows:
        variant = row["variant"] if "variant" in row.keys() else 0
        key = (row["question_id"], row["engine"], variant)
        if key not in latest or row["timestamp"] > latest[key]["timestamp"]:
            latest[key] = row
    out: dict[str, list[dict]] = defaultdict(list)
    for (qid, engine, variant), row in sorted(latest.items(), key=lambda kv: (
            kv[0][0], kv[0][2], ENGINE_ORDER.index(kv[0][1]) if kv[0][1] in ENGINE_ORDER else 9)):
        prompt = row["question_text"] if "question_text" in row.keys() else None
        text = row["answer_text"]
        out[qid].append({
            "engine": engine, "variant": variant, "model": row["model"], "date": row["timestamp"][:10],
            "prompt": prompt, "text": text[:MAX_ANSWER_CHARS] + ("…" if len(text) > MAX_ANSWER_CHARS else ""),
        })
    return dict(out)


def build_results(latest: dict[tuple[str, str], sqlite3.Row], own_domain: str,
                  brand_aliases: list[str] | None = None, competitors: list[str] | None = None) -> dict[str, dict]:
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
        comp = None
        if competitors:
            q_rows = [latest[(qid, e)] for e in ENGINE_ORDER if (qid, e) in latest]
            comp = first_competitor(q_rows, brand_aliases or [], competitors)
        results[qid] = {"competitor": comp, "r": " ".join(codes)}
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


def build_setup(brand: dict, categories: list[dict], questions: list[dict], run_list: list[dict] | None) -> dict:
    """Brand, topics and questions for the app. Custom questions from the run
    list (added on the app's Run page) are appended, and run_list names the ids
    a run asks, so the app shows them switched on."""
    known = {q["id"] for q in questions}
    extra = [{"id": q["id"], "text": q["text"], "categories": q["categories"], "key": False, "custom": True}
             for q in run_list or [] if q["id"] not in known]
    setup = {"brand": brand, "categories": categories, "questions": questions + extra}
    if run_list is not None:
        setup["run_list"] = [q["id"] for q in run_list]
    return setup


def build_radar(db_path: Path, data_dir: str) -> dict | None:
    """Question Radar section (monitoring/radar.py), or None when there is
    nothing on the radar yet. A radar problem must not stop the monitoring
    export, so errors only print a warning."""
    from monitoring.radar import export as radar_export

    conn = sqlite3.connect(db_path)
    try:
        section = radar_export(conn, data_dir)
    except Exception as e:  # noqa: BLE001
        print(f"[radar section skipped: {e}]", file=sys.stderr)
        return None
    finally:
        conn.close()
    return section if section["candidates"] or section["topics"] else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "monitoring" / "runs.sqlite"))
    ap.add_argument("--out", default=str(ROOT / "monitoring" / "monitoring_export.json"))
    ap.add_argument("--target", help="Folder with brand/competitors/questions.json. Default: the settings' target.")
    args = ap.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"No database at {db_path}. Run monitoring/run.py first.", file=sys.stderr)
        return 1

    target = ROOT / (args.target or target_from_settings())

    def load(name: str):
        return json.loads((target / name).read_text(encoding="utf-8"))

    brand = load("brand.json")
    own_domain = brand.get("domain", "")
    brand_aliases = brand.get("aliases", [])
    competitors = load("competitors.json")["names"]

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
    trend = build_trend(rows)
    export = {
        "_comment": "Exported from monitoring/runs.sqlite by scripts/export_monitoring.py — "
                    "real data, not demo data. 'r' codes: c=cited, m=mentioned, a=absent, n=not run for that engine.",
        "results": build_results(latest, own_domain, brand_aliases, competitors),
        "cited_sources": build_cited_sources(rows),
        "trend": [w["rate"] for w in trend],
        "trend_ci": trend,
        "answers": build_answers(rows),
        "competitors": competitors,
        # Brand, topics and questions the results refer to, so the app can
        # show them in own-brand mode (result ids only make sense with these).
        "setup": build_setup(brand, load("categories.json"), load("questions.json"), load_run_list(target)),
        "pieces": [],
        "audit_meta": {"date": datetime.date.today().isoformat(), "pages": 0, "posts": 0},
    }
    radar = build_radar(db_path, args.target or target_from_settings())
    if radar:
        export["radar"] = radar
    Path(args.out).write_text(json.dumps(export, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Exported {len(export['results'])} question(s), {len(export['cited_sources'])} source(s) -> {args.out}")
    print("Load this file in the app: Monitor -> Sources -> 'Load monitoring results'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
