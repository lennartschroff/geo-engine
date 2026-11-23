"""Question Radar, first draft (docs/QUESTION_RADAR.md, TASKS.md Epic H).

Lists the web searches the engines ran while answering our tracked
questions (stored by run.py in the search_queries column), merged and
counted. A search that no tracked question covers is a candidate: a
sub-question the engines think matters, that we don't watch yet.

No API calls, no cost: it only reads the monitoring database.

How "covered" is decided: the share of the search's content words that
also appear in a tracked question. Below --new-below (default 0.6) the
search counts as new. A rule of thumb, like the GEO score, not a
validated measure; it can't see synonyms or translations.

Usage:
    python monitoring/radar.py
    python monitoring/radar.py --db monitoring/runs.sqlite --min-count 2
    python monitoring/radar.py --json > output/radar.json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monitoring.run_list import load_run_list  # noqa: E402

# Words that carry no topic in either language of the question set.
STOPWORDS = frozenset("""
a an and are as at be best by can do does for from how in is it of on or the to vs what which who why with
der die das den dem des ein eine einen einer und oder ist sind was wie welche welcher welches wer für mit
von zu im in am an auf bei gibt es
""".split())
WORD = re.compile(r"[^\W_]+", re.UNICODE)


def normalize(text: str) -> str:
    """Lowercase, unify unicode, drop punctuation, collapse spaces."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(WORD.findall(text))


def content_words(text: str) -> frozenset[str]:
    return frozenset(w for w in normalize(text).split() if w not in STOPWORDS and len(w) > 1)


def coverage(query: str, question_words: dict[str, frozenset[str]]) -> tuple[str | None, float]:
    """(id of the closest tracked question, share of the query's content
    words found in it). (None, 0.0) when there are no questions or the
    query has no content words."""
    words = content_words(query)
    if not words or not question_words:
        return None, 0.0
    best_id, best = None, 0.0
    for qid, qwords in question_words.items():
        share = len(words & qwords) / len(words)
        if share > best:
            best_id, best = qid, share
    return best_id, round(best, 2)


@dataclass
class Candidate:
    query: str                      # most common original spelling
    count: int                      # answers whose searches included it
    engines: list[str]
    questions: list[str]            # tracked question ids that led to it
    first_seen: str
    last_seen: str
    closest_question: str | None
    overlap: float
    new: bool
    variants: list[str] = field(default_factory=list)   # other spellings merged into this one
    spellings: Counter = field(default_factory=Counter, repr=False)
    key: frozenset = field(default_factory=frozenset, repr=False)


def load_rows(conn: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
    """(question_id, engine, timestamp, search_queries JSON) for rows that have
    searches. Empty for a database from before run.py stored them."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(runs)")}
    if "search_queries" not in cols:
        return []
    return conn.execute(
        "SELECT question_id, engine, timestamp, search_queries FROM runs "
        "WHERE search_queries IS NOT NULL AND search_queries != '[]' ORDER BY timestamp"
    ).fetchall()


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    return len(a & b) / len(a | b) if a | b else 0.0


def merge_similar(candidates: list[Candidate], threshold: float) -> list[Candidate]:
    """Greedy: most frequent first; a search joins the first group whose
    words it shares at least `threshold` of (Jaccard). Counts are added, so
    an answer that ran two near-identical searches counts twice."""
    groups: list[Candidate] = []
    for c in sorted(candidates, key=lambda c: (-c.count, c.query.casefold())):
        home = next((g for g in groups if jaccard(g.key, c.key) >= threshold), None)
        if home is None:
            groups.append(c)
            continue
        home.count += c.count
        home.spellings.update(c.spellings)
        home.engines += [e for e in c.engines if e not in home.engines]
        home.questions += [q for q in c.questions if q not in home.questions]
        home.first_seen = min(home.first_seen, c.first_seen)
        home.last_seen = max(home.last_seen, c.last_seen)
    return groups


def aggregate(rows, question_words: dict[str, frozenset[str]], new_below: float = 0.6,
              merge_at: float = 0.6) -> list[Candidate]:
    """Merge searches that differ only in case, punctuation or word order,
    then group near-duplicates (see merge_similar)."""
    by_key: dict[frozenset[str], Candidate] = {}
    for question_id, engine, timestamp, raw in rows:
        try:
            queries = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        # The same search twice in one answer counts once.
        seen_in_answer: set[frozenset[str]] = set()
        for q in queries:
            if not isinstance(q, str):
                continue
            key = content_words(q)
            if not key or key in seen_in_answer:
                continue
            seen_in_answer.add(key)
            c = by_key.get(key)
            if c is None:
                c = by_key[key] = Candidate(q.strip(), 0, [], [], timestamp, timestamp, None, 0.0, False, key=key)
            c.count += 1
            c.spellings[q.strip()] += 1
            if engine not in c.engines:
                c.engines.append(engine)
            if question_id not in c.questions:
                c.questions.append(question_id)
            c.first_seen = min(c.first_seen, timestamp)
            c.last_seen = max(c.last_seen, timestamp)
    groups = merge_similar(list(by_key.values()), merge_at)
    for c in groups:
        c.query = c.spellings.most_common(1)[0][0]
        c.variants = sorted({s for s in c.spellings if normalize(s) != normalize(c.query)}, key=str.casefold)
        c.closest_question, c.overlap = coverage(c.query, question_words)
        c.new = c.overlap < new_below
    return sorted(groups, key=lambda c: (not c.new, -c.count, -len(c.engines), c.query.casefold()))


def load_question_words(data_dir: str) -> dict[str, frozenset[str]]:
    """Tracked questions: questions.json plus the run list's own questions."""
    questions = json.loads((ROOT / data_dir / "questions.json").read_text(encoding="utf-8"))
    run_list = load_run_list(ROOT / data_dir) or []
    known = {q["id"]: q["text"] for q in questions}
    known.update({q["id"]: q["text"] for q in run_list})
    return {qid: content_words(text) for qid, text in known.items()}


def to_json(candidates: list[Candidate]) -> list[dict]:
    out = []
    for c in candidates:
        d = asdict(c)
        d.pop("spellings")
        d.pop("key")
        out.append(d)
    return out


def print_table(candidates: list[Candidate]) -> None:
    if not candidates:
        print("No search queries stored yet. They come from real runs of Claude (web search) and ChatGPT; "
              "try: python monitoring/run.py --dry-run, then run this again.")
        return
    new = sum(c.new for c in candidates)
    print(f"{len(candidates)} distinct searches, {new} not covered by a tracked question\n")
    print(f"{'new':<4}{'n':>3}  {'engines':<14}{'from':<12}{'overlap':>8}  query")
    for c in candidates:
        print(f"{'*' if c.new else '':<4}{c.count:>3}  {','.join(c.engines):<14}{','.join(c.questions)[:11]:<12}"
              f"{c.overlap:>8.2f}  {c.query}")
        for v in c.variants:
            print(f"{'':<41}  ~ {v}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "monitoring" / "runs.sqlite"), help="Monitoring database.")
    ap.add_argument("--target", help="Folder with questions.json. Default: the settings' target.")
    ap.add_argument("--min-count", type=int, default=1, help="Hide searches seen fewer times than this.")
    ap.add_argument("--new-below", type=float, default=0.6,
                    help="Overlap with the closest tracked question below which a search counts as new.")
    ap.add_argument("--merge-at", type=float, default=0.6,
                    help="Word overlap (Jaccard) at which two searches are grouped as one.")
    ap.add_argument("--only-new", action="store_true", help="Show only searches no tracked question covers.")
    ap.add_argument("--json", action="store_true", help="Print JSON instead of a table.")
    args = ap.parse_args(argv)

    if not Path(args.db).exists():
        print(f"No database at {args.db}. Run monitoring/run.py first.", file=sys.stderr)
        return 1
    settings = json.loads((ROOT / "data" / "monitoring_settings.json").read_text(encoding="utf-8"))
    data_dir = args.target or settings.get("target") or "data"

    conn = sqlite3.connect(args.db)
    try:
        rows = load_rows(conn)
    finally:
        conn.close()
    candidates = aggregate(rows, load_question_words(data_dir), args.new_below, args.merge_at)
    candidates = [c for c in candidates if c.count >= args.min_count and (c.new or not args.only_new)]

    if args.json:
        json.dump(to_json(candidates), sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        print(f"Target: {data_dir}")
        print_table(candidates)
    return 0


if __name__ == "__main__":
    sys.exit(main())
