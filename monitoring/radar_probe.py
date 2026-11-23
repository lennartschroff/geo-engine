"""Question Radar: open-slot test (docs/QUESTION_RADAR.md, TASKS.md H4).

Asks each engine a candidate question once and measures how well it is
answered today: how many providers are named, how many sources cited, and
whether the answer hedges. Few names, few sources or hedging = the slot is
open, so content published now has a good chance to become the answer.

Reuses monitoring/run.py: the same engine calls, cost estimate and budget
caps. A real probe prints the estimate first and needs --yes above
--yes-threshold (default $1). --dry-run uses recorded answers at $0.
Results go to the radar_probes table, kept apart from the runs table so
probes don't count as monitoring results.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from datetime import UTC, datetime, timedelta

from monitoring import run as run_mod
from monitoring.cost_estimate import check_call_budget, needs_confirmation
from monitoring.mention_detection import detect_mention, normalize_domains

REPROBE_AFTER_DAYS = 28
PROBE_VALID_DAYS = 90

# Phrases that signal the engine has no solid answer. English and German,
# like the question set. A heuristic: it misses hedges it doesn't list.
HEDGE = re.compile(
    r"\b(i (?:don't|do not|couldn't|could not) (?:have|find)|i'm not aware|i am not aware|not aware of any|"
    r"no (?:specific|reliable|widely recognized|well-known|established)|there (?:is|are) no (?:single|clear|specific)|"
    r"hard to say|limited information|as of my (?:last|knowledge)|i (?:can't|cannot) (?:verify|confirm)|"
    r"keine (?:konkreten|verlässlichen|spezifischen|bekannten)|nicht bekannt|ist mir nicht bekannt|"
    r"kann ich nicht (?:bestätigen|sagen))",
    re.I,
)


def ensure_probe_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS radar_probes (
            candidate_id TEXT NOT NULL, query TEXT NOT NULL, engine TEXT NOT NULL, model TEXT NOT NULL,
            timestamp TEXT NOT NULL, named INTEGER NOT NULL, brand INTEGER NOT NULL, cited INTEGER NOT NULL,
            hedged INTEGER NOT NULL, providers TEXT NOT NULL, answer_text TEXT NOT NULL
        )""")
    conn.commit()


def assess(answer_text: str, cited_urls: list[str], brand_aliases: list[str], competitors: list[str]) -> dict:
    m = detect_mention(answer_text, brand_aliases, competitors)
    providers = [p for p in m.providers_mentioned if p != "(brand)"]
    return {"named": len(m.providers_mentioned), "brand": m.mentioned, "cited": len(normalize_domains(cited_urls)),
            "hedged": bool(HEDGE.search(answer_text)), "providers": providers}


def open_score(a: dict) -> float:
    """1 = wide open, 0 = well covered. Named providers weigh 60 %, cited
    sources 40 %. A hedging answer counts as at least 0.8 open. If the brand
    is already named, the slot is taken (by us): at most 0.3."""
    score = 1 - 0.6 * min(1, a["named"] / 3) - 0.4 * min(1, a["cited"] / 4)
    if a["hedged"]:
        score = max(score, 0.8)
    if a["brand"]:
        score = min(score, 0.3)
    return round(score, 3)


def load_probe_open(conn: sqlite3.Connection, now: datetime) -> dict[str, dict]:
    """Latest probe per candidate and engine (last PROBE_VALID_DAYS days):
    {candidate_id: {"open": mean over engines, "engines": {engine: {...}}}}."""
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='radar_probes'").fetchone() is None:
        return {}
    since = (now - timedelta(days=PROBE_VALID_DAYS)).isoformat()
    latest: dict[str, dict[str, dict]] = {}
    for cid, engine, ts, named, brand, cited, hedged in conn.execute(
            "SELECT candidate_id, engine, timestamp, named, brand, cited, hedged FROM radar_probes "
            "WHERE timestamp >= ? ORDER BY timestamp", (since,)):
        a = {"named": named, "brand": bool(brand), "cited": cited, "hedged": bool(hedged), "date": ts[:10]}
        a["open"] = round(open_score(a) * 100)
        latest.setdefault(cid, {})[engine] = a
    return {cid: {"open": round(sum(a["open"] for a in e.values()) / len(e) / 100, 3), "engines": e}
            for cid, e in latest.items()}


def recently_probed(conn: sqlite3.Connection, now: datetime) -> set[str]:
    ensure_probe_table(conn)
    since = (now - timedelta(days=REPROBE_AFTER_DAYS)).isoformat()
    return {r[0] for r in conn.execute("SELECT DISTINCT candidate_id FROM radar_probes WHERE timestamp >= ?", (since,))}


def probe(conn: sqlite3.Connection, candidates, engines: list[str], engine_cfgs: dict, brand_aliases: list[str],
          competitors: list[str], dry_run: bool, log=print) -> int:
    """One call per candidate and engine. An engine that fails is skipped
    for the rest of the probe; rows already written are kept."""
    ensure_probe_table(conn)
    written, failed = 0, set()
    for c in candidates:
        for engine in engines:
            if engine in failed:
                continue
            try:
                if dry_run:
                    answer, model = run_mod.load_fixture_answer("radar-probe", engine), "fixture"
                else:
                    answer = run_mod.ENGINE_CALLS[engine](c.query, engine_cfgs[engine])
                    model = engine_cfgs[engine]["model"]
            except Exception as e:  # provider/SDK errors: keep the other engines going
                log(f"[{engine} failed, skipping it for the rest of this probe: {e}]")
                failed.add(engine)
                continue
            a = assess(answer["answer_text"], answer.get("cited_urls") or [], brand_aliases, competitors)
            conn.execute(
                "INSERT INTO radar_probes VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (c.id, c.query, engine, model, datetime.now(UTC).isoformat(), a["named"], int(a["brand"]),
                 a["cited"], int(a["hedged"]), json.dumps(a["providers"]), answer["answer_text"]),
            )
            conn.commit()
            written += 1
    return written


def run_probe_cli(conn, args, settings, data_dir, config, categories, qwords, now) -> int:
    from monitoring.radar import build

    run_mod._load_dotenv()
    cfgs = {e: {**run_mod.DEFAULT_ENGINE_CONFIG[e], **settings["engines"].get(e, {})} for e in run_mod.ALL_ENGINES}
    engines = args.engines.split(",") if args.engines else [e for e in run_mod.ALL_ENGINES if cfgs[e]["enabled"]]
    unknown = set(engines) - set(run_mod.ALL_ENGINES)
    if unknown:
        print(f"Unknown engine(s): {sorted(unknown)}", file=sys.stderr)
        return 1
    if not args.dry_run:
        engines = [e for e in engines if os.environ.get(run_mod.API_KEY_ENV[e])]
        if not engines:
            print("No engine with an API key set; nothing to probe.", file=sys.stderr)
            return 1

    skip = recently_probed(conn, now)
    pool = [c for c in build(conn, config, categories, qwords, now) if c.new and c.id not in skip]
    chosen = pool[: args.top]
    if not chosen:
        print("No new candidates left to probe (each is probed at most every 4 weeks).")
        return 0

    estimate, notes = run_mod.estimate_run_cost(len(chosen), engines, 1, cfgs)
    real = f"estimated ${estimate.total_usd:.4f} (real API calls)"
    cost = "dry run with recorded answers, $0" if args.dry_run else real
    print(f"Probing {len(chosen)} candidate(s) on {engines}: {estimate.num_calls} call(s), {cost}")
    for c in chosen:
        print(f"  {c.score:>3}  {c.query}")
    try:
        check_call_budget(estimate.num_calls, settings["budget"]["max_calls_per_run"])
    except Exception as e:  # CallBudgetExceeded
        print(f"Aborting: {e}", file=sys.stderr)
        return 1
    if not args.dry_run:
        for note in notes:
            print(f"[{note}]")
        if estimate.total_usd > settings["budget"]["max_usd_per_run"]:
            print(f"Aborting: estimate exceeds budget.max_usd_per_run=${settings['budget']['max_usd_per_run']:.2f}.",
                  file=sys.stderr)
            return 1
        if needs_confirmation(estimate, 1.0) and not args.yes:
            print("Estimated cost is above $1.00. Re-run with --yes to proceed.", file=sys.stderr)
            return 1
        if not args.yes and sys.stdin.isatty():
            if input("Start the probe? [y/N] ").strip().lower() not in ("y", "yes"):
                print("Cancelled; no calls made.")
                return 0

    brand = json.loads((run_mod.ROOT / data_dir / "brand.json").read_text(encoding="utf-8"))
    competitors = json.loads((run_mod.ROOT / data_dir / "competitors.json").read_text(encoding="utf-8"))["names"]
    n = probe(conn, chosen, engines, cfgs, brand["aliases"], competitors, args.dry_run)
    print(f"Stored {n} probe answer(s). `python monitoring/radar.py` now shows measured open slots (*).")
    return 0
