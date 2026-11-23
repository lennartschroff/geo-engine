"""Question Radar (docs/QUESTION_RADAR.md, TASKS.md Epic H).

Finds questions while they are new and poorly answered, scores them, and
logs what it flagged so the hit rate can be checked later.

Signals, all stored in the monitoring database:
- engine:     web searches the engines ran while answering our questions
              (run.py, search_queries column). Free.
- community:  real questions from Hacker News, Stack Exchange and GitHub,
              plus topic momentum and Wikipedia page views
              (radar_sources.py, `collect`). Free.
- event:      dated events with expected questions (radar.json). Free.
- probe:      one answer per engine to a candidate, to measure whether
              the slot is still open (radar_probe.py, `probe`). Costs calls;
              estimate shown first, budget caps apply.

Score 0-100 = momentum 30 + demand 20 + open slot 30 + fit 20. A rule of
thumb like the GEO score, not a validated measure: the hit-rate log is
there to check it.

Usage:
    python monitoring/radar.py collect            # fetch community data (free)
    python monitoring/radar.py                    # show candidates
    python monitoring/radar.py --json             # same, as JSON for the app
    python monitoring/radar.py probe --top 5      # open-slot test (asks first)
    python monitoring/radar.py hits               # hit-rate log
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import sys
import unicodedata
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monitoring.radar_sources import is_question  # noqa: E402
from monitoring.run_list import load_run_list  # noqa: E402

WEIGHTS = {"momentum": 30, "demand": 20, "open": 30, "fit": 20}
RECENT_DAYS = 30
LOOKBACK_DAYS = 180
HIT_CHECK_DAYS = 56  # flags at least 8 weeks old count for the hit rate
SOURCE_WEIGHT = {"github": 0.5}  # GitHub search is noisy (file names, SEO spam)
MAX_EXPORT = 40

# Words that carry no topic in either language of the question set.
STOPWORDS = frozenset("""
a an and are as at be best by can do does for from how in is it of on or the to vs what which who why with
der die das den dem des ein eine einen einer und oder ist sind was wie welche welcher welches wer für mit
von zu im in am an auf bei gibt es
your my our you i we this that there their get using use
""".split())
WORD = re.compile(r"[^\W_]+", re.UNICODE)


# ---------- Text helpers ----------

def normalize(text: str) -> str:
    """Lowercase, unify unicode, drop punctuation, collapse spaces."""
    text = unicodedata.normalize("NFKC", text).casefold()
    return " ".join(WORD.findall(text))


def stem(word: str) -> str:
    """Plural s only ("tools" = "tool", "llms" = "llm"); enough for matching."""
    return word[:-1] if len(word) > 3 and word.endswith("s") and not word.endswith("ss") else word


def content_seq(text: str) -> tuple[str, ...]:
    """Content words in order, for phrase matching."""
    return tuple(stem(w) for w in normalize(text).split() if w not in STOPWORDS and len(w) > 1)


def content_words(text: str) -> frozenset[str]:
    return frozenset(content_seq(text))


def has_phrase(seq: tuple[str, ...], phrase: tuple[str, ...]) -> bool:
    n = len(phrase)
    return n > 0 and any(seq[i:i + n] == phrase for i in range(len(seq) - n + 1))


def jaccard(a: frozenset[str], b: frozenset[str]) -> float:
    return len(a & b) / len(a | b) if a | b else 0.0


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


def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


# ---------- Sightings: one signal pointing at a possible question ----------

@dataclass
class Sighting:
    text: str
    origin: str                    # engine | hackernews | stackexchange:<site> | github | event
    date: str                      # ISO date or timestamp
    engine: str | None = None
    question_id: str | None = None
    link: dict | None = None       # {"title", "url", "source"}
    engagement: float = 0.0
    answered: bool | None = None
    term: str | None = None
    event_date: str | None = None


@dataclass
class Candidate:
    query: str                      # most common original spelling
    count: int                      # sightings (answers or posts)
    engines: list[str]
    questions: list[str]            # tracked question ids whose answers led to it
    first_seen: str
    last_seen: str
    closest_question: str | None
    overlap: float
    new: bool
    variants: list[str] = field(default_factory=list)   # other spellings merged into this one
    origins: list[str] = field(default_factory=list)
    links: list[dict] = field(default_factory=list)
    engagement: float = 0.0
    answered: int = 0
    unanswered: int = 0
    recent: int = 0
    terms: list[str] = field(default_factory=list)
    event_date: str | None = None
    category: str | None = None
    score: int = 0
    parts: dict = field(default_factory=dict)
    open_measured: bool = False
    probe: dict = field(default_factory=dict)
    flagged_since: str | None = None
    spellings: Counter = field(default_factory=Counter, repr=False)
    key: frozenset = field(default_factory=frozenset, repr=False)

    @property
    def id(self) -> str:
        return key_id(self.key)


def key_id(key: frozenset[str]) -> str:
    return hashlib.sha1(" ".join(sorted(key)).encode("utf-8")).hexdigest()[:10]


def load_rows(conn: sqlite3.Connection) -> list[tuple[str, str, str, str]]:
    """(question_id, engine, timestamp, search_queries JSON) for rows that have
    searches. Empty for a database from before run.py stored them."""
    if not _has_column(conn, "runs", "search_queries"):
        return []
    return conn.execute(
        "SELECT question_id, engine, timestamp, search_queries FROM runs "
        "WHERE search_queries IS NOT NULL AND search_queries != '[]' ORDER BY timestamp"
    ).fetchall()


def _has_table(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return _has_table(conn, table) and column in {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def engine_sightings(rows) -> list[Sighting]:
    """The same search twice in one answer counts once."""
    out = []
    for question_id, engine, timestamp, raw in rows:
        try:
            queries = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            continue
        seen: set[frozenset[str]] = set()
        for q in queries if isinstance(queries, list) else []:
            if not isinstance(q, str) or not content_words(q) or content_words(q) in seen:
                continue
            seen.add(content_words(q))
            out.append(Sighting(q.strip(), "engine", timestamp, engine=engine, question_id=question_id))
    return out


def post_sightings(conn: sqlite3.Connection, now: datetime) -> list[Sighting]:
    """Community questions from the last LOOKBACK_DAYS, minus the noise:
    GitHub posts nobody reacted to, Hacker News posts with no points or
    comments (mostly self-promotion)."""
    if not _has_table(conn, "radar_posts"):
        return []
    since = (now - timedelta(days=LOOKBACK_DAYS)).date().isoformat()
    out = []
    for source, title, url, created, score, views, answers, answered, term in conn.execute(
        "SELECT source, title, url, created, score, views, answers, answered, term FROM radar_posts WHERE created >= ?",
        (since,),
    ):
        score, views, answers = score or 0, views or 0, answers or 0
        if not source.startswith("stackexchange") and not is_question(title):  # rule may be stricter than at fetch
            continue
        if source == "github" and score + answers == 0:
            continue
        if source == "hackernews" and score < 2 and answers == 0:
            continue
        out.append(Sighting(title, source, created, link={"title": title, "url": url, "source": source},
                            engagement=score + 2 * answers + views / 50,
                            answered=None if answered is None else bool(answered), term=term))
    return out


def event_sightings(config: dict, today: str) -> list[Sighting]:
    out = []
    for e in config.get("events") or []:
        for q in e["questions"]:
            out.append(Sighting(q, "event", today, link={"title": e["title"], "url": e["source"], "source": "event"},
                                event_date=e["date"]))
    return out


def merge_similar(candidates: list[Candidate], threshold: float) -> list[Candidate]:
    """Greedy: most frequent first; a candidate joins the first group whose
    words it shares at least `threshold` of (Jaccard)."""
    groups: list[Candidate] = []
    for c in sorted(candidates, key=lambda c: (-c.count, c.query.casefold())):
        home = next((g for g in groups if jaccard(g.key, c.key) >= threshold), None)
        if home is None:
            groups.append(c)
            continue
        home.count += c.count
        home.spellings.update(c.spellings)
        for attr in ("engines", "questions", "origins", "terms"):
            getattr(home, attr).extend(x for x in getattr(c, attr) if x not in getattr(home, attr))
        home.links.extend(c.links)
        home.engagement += c.engagement
        home.answered += c.answered
        home.unanswered += c.unanswered
        home.recent += c.recent
        home.first_seen = min(home.first_seen, c.first_seen)
        home.last_seen = max(home.last_seen, c.last_seen)
        home.event_date = home.event_date or c.event_date
    return groups


def group(sightings: list[Sighting], question_words: dict[str, frozenset[str]], new_below: float = 0.6,
          merge_at: float = 0.6, now: datetime | None = None) -> list[Candidate]:
    """Merge sightings that differ only in case, punctuation or word order,
    then group near-duplicates (merge_similar)."""
    recent_since = ((now or datetime.now(UTC)) - timedelta(days=RECENT_DAYS)).date().isoformat()
    by_key: dict[frozenset[str], Candidate] = {}
    for s in sightings:
        key = content_words(s.text)
        if not key:
            continue
        c = by_key.get(key)
        if c is None:
            c = by_key[key] = Candidate(s.text.strip(), 0, [], [], s.date, s.date, None, 0.0, False, key=key)
        c.count += 1
        c.spellings[s.text.strip()] += 1
        if s.engine and s.engine not in c.engines:
            c.engines.append(s.engine)
        if s.question_id and s.question_id not in c.questions:
            c.questions.append(s.question_id)
        if s.origin not in c.origins:
            c.origins.append(s.origin)
        if s.term and s.term not in c.terms:
            c.terms.append(s.term)
        if s.link:
            c.links.append(dict(s.link, engagement=s.engagement))
        c.engagement += s.engagement
        c.answered += s.answered is True
        c.unanswered += s.answered is False
        c.recent += s.date[:10] >= recent_since
        c.first_seen = min(c.first_seen, s.date)
        c.last_seen = max(c.last_seen, s.date)
        c.event_date = c.event_date or s.event_date
    groups = merge_similar(list(by_key.values()), merge_at)
    for c in groups:
        c.query = c.spellings.most_common(1)[0][0]
        c.variants = sorted({s for s in c.spellings if normalize(s) != normalize(c.query)}, key=str.casefold)
        c.closest_question, c.overlap = coverage(c.query, question_words)
        c.new = c.overlap < new_below
        seen_urls: set[str] = set()
        top = []
        for link in sorted(c.links, key=lambda x: -x.get("engagement", 0)):
            if link["url"] not in seen_urls:
                seen_urls.add(link["url"])
                top.append({k: link[k] for k in ("title", "url", "source")})
        c.links = top[:3]
    return sorted(groups, key=lambda c: (not c.new, -c.count, -len(c.engines), c.query.casefold()))


def aggregate(rows, question_words: dict[str, frozenset[str]], new_below: float = 0.6,
              merge_at: float = 0.6) -> list[Candidate]:
    """Engine searches only (the first draft's view)."""
    return group(engine_sightings(rows), question_words, new_below, merge_at)


# ---------- Momentum ----------

def momentum_from_counts(recent: float, baseline: float) -> float:
    """0.5 = steady. Each doubling of the recent rate over the baseline adds
    0.25. The +2 keeps tiny counts (0 vs 1) from swinging the score."""
    growth = (recent + 2) / (baseline + 2)
    return round(clamp(0.5 + math.log2(growth) / 4), 3)


def load_topics(conn: sqlite3.Connection, terms: list[str]) -> list[dict]:
    """Latest count snapshot per (source, term), combined per term. Wikipedia
    articles join the term with the same words, or stand alone."""
    if not _has_table(conn, "radar_counts"):
        return []
    rows = conn.execute("""
        SELECT c.source, c.term, c.recent, c.baseline, c.series, c.fetched FROM radar_counts c
        JOIN (SELECT source, term, MAX(fetched) AS f FROM radar_counts GROUP BY source, term) m
          ON c.source = m.source AND c.term = m.term AND c.fetched = m.f
    """).fetchall()
    topics: dict[str, dict] = {}
    term_words = {t: content_words(t) for t in terms}
    # GitHub's own growth (radar_sources.github_all): scale GitHub counts so a
    # term only counts as rising when it grows faster than GitHub itself.
    control = next(((r_, b_) for s_, t_, r_, b_, *_ in rows if s_ == "github" and t_ == "*"), None)
    gh_factor = control[1] / control[0] if control and control[0] and control[1] else 1.0
    for source, term, recent, baseline, series, fetched in rows:
        if source == "github" and term == "*":
            continue
        if source == "github" and gh_factor != 1.0:
            recent = round(recent * gh_factor)
        name = term
        if source == "wikipedia":
            article = content_words(term.split(":", 1)[-1].replace("_", " "))
            name = next((t for t, w in term_words.items() if w and (w == article)), term)
        t = topics.setdefault(name, {"term": name, "sources": [], "series": None, "fetched": fetched})
        t["sources"].append({"source": source, "recent": recent, "baseline": baseline,
                             **({"article": term} if source == "wikipedia" else {})})
        if series:
            t["series"] = json.loads(series)
        t["fetched"] = max(t["fetched"], fetched)
    out = []
    for t in topics.values():
        weights = [(s, SOURCE_WEIGHT.get(s["source"], 1.0) * clamp((s["recent"] + s["baseline"]) / 5))
                   for s in t["sources"]]
        total_w = sum(w for _, w in weights)
        if total_w:
            t["momentum"] = round(sum(momentum_from_counts(s["recent"], s["baseline"]) * w
                                      for s, w in weights) / total_w, 3)
            # The growth factor that momentum stands for (inverse of momentum_from_counts),
            # so one source with huge raw counts can't dominate the displayed figure.
            t["growth"] = round(2 ** ((t["momentum"] - 0.5) * 4), 2)
        else:
            t["momentum"], t["growth"] = None, None
        out.append(t)
    return sorted(out, key=lambda t: (t["momentum"] is None, -(t["momentum"] or 0), t["term"]))


# ---------- Scoring ----------

def keyword_sets(categories: list[dict], terms: list[str]) -> list[tuple[str | None, tuple[str, ...]]]:
    sets = [(c["id"], content_seq(k)) for c in categories for k in c.get("keywords", [])]
    sets += [(None, content_seq(t)) for t in terms]
    return [(cat, seq) for cat, seq in sets if seq]


def fit_of(c: Candidate, kw: list[tuple[str | None, tuple[str, ...]]]) -> tuple[float, str | None]:
    """Distinct topic keywords/terms the candidate contains as a phrase
    (adjacent, in order): 0 = off topic, 2+ = clearly on topic."""
    seqs = [content_seq(s) for s in (c.spellings or {c.query: 1})]
    hits = [(cat, phrase) for cat, phrase in kw if any(has_phrase(seq, phrase) for seq in seqs)]
    cats = Counter(cat for cat, _ in hits if cat)
    fit = clamp(len({phrase for _, phrase in hits}) / 2)
    if "engine" in c.origins:  # came from answers to our own questions: on topic by construction
        fit = max(fit, 0.5)
    if "event" in c.origins:
        fit = max(fit, 0.5)
    return round(fit, 3), (cats.most_common(1)[0][0] if cats else None)


def momentum_of(c: Candidate, topics: dict[str, dict], now: datetime, engine_history: bool = True) -> float:
    """Events: how close the date is. Otherwise 60 % the momentum of the
    topic terms it contains, 40 % its own recency (share of sightings in the
    last 30 days). Recency stays neutral while engine searches are its only
    source and there are no runs older than 30 days to compare with."""
    if c.event_date:
        days = (date.fromisoformat(c.event_date) - now.date()).days
        return 0.2 if days < 0 else 1.0 if days <= 90 else 0.7 if days <= 180 else 0.4

    def related(name: str) -> bool:
        words = content_words(name)
        return name in c.terms or bool(words and words <= c.key)

    found = [t["momentum"] for name, t in topics.items() if t.get("momentum") is not None and related(name)]
    term_m = max(found) if found else 0.5
    has_history = engine_history or any(o not in ("engine", "event") for o in c.origins)
    recency = clamp(0.4 + 0.6 * c.recent / c.count) if c.count and has_history else 0.5
    return round(0.6 * term_m + 0.4 * recency, 3)


def demand_of(c: Candidate) -> float:
    if c.origins == ["event"]:
        return 0.5
    engine_part = clamp(len(c.engines) / 2) * 0.5 + clamp(c.count / 6) * 0.5 if c.engines else 0.0
    community = clamp(math.log10(1 + c.engagement) / 2.5) if c.engagement else 0.0
    spread = 0.15 * max(0, len(c.origins) - 1)
    return round(clamp(max(engine_part, community) + spread), 3)


def open_estimate(c: Candidate) -> float:
    """Without a probe: a question people asked and nobody answered well is
    the clearest open slot we can see for free."""
    if c.unanswered:
        return 0.75
    if c.answered:
        return 0.4
    if "event" in c.origins:
        return 0.6
    if any(o != "engine" for o in c.origins):
        return 0.55
    return 0.5


def score(c: Candidate, topics: dict[str, dict], kw, now: datetime, probe_open: float | None = None,
          engine_history: bool = True) -> Candidate:
    fit, c.category = fit_of(c, kw)
    parts = {
        "momentum": momentum_of(c, topics, now, engine_history),
        "demand": demand_of(c),
        "open": probe_open if probe_open is not None else open_estimate(c),
        "fit": fit,
    }
    c.open_measured = probe_open is not None
    c.parts = {k: round(v * 100) for k, v in parts.items()}
    c.score = round(sum(parts[k] * WEIGHTS[k] for k in WEIGHTS))
    return c


# ---------- Hit-rate log ----------

def ensure_flags(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS radar_flags (
            key TEXT PRIMARY KEY, query TEXT NOT NULL, first_flagged TEXT NOT NULL, last_flagged TEXT NOT NULL,
            best_score INTEGER NOT NULL, last_score INTEGER NOT NULL, tracked_id TEXT, tracked_since TEXT
        )""")


def record_flags(conn: sqlite3.Connection, candidates: list[Candidate], min_score: int, today: str) -> int:
    """Log candidates at or above min_score (first date kept), and note when
    a flagged candidate becomes a tracked question."""
    ensure_flags(conn)
    n = 0
    for c in candidates:
        key = " ".join(sorted(c.key))
        if c.score >= min_score:
            conn.execute(
                "INSERT INTO radar_flags (key, query, first_flagged, last_flagged, best_score, last_score) "
                "VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET last_flagged=excluded.last_flagged, "
                "query=excluded.query, best_score=MAX(best_score, excluded.best_score), last_score=excluded.last_score",
                (key, c.query, today, today, c.score, c.score),
            )
            n += 1
        if not c.new and c.closest_question:
            conn.execute("UPDATE radar_flags SET tracked_id=?, tracked_since=? WHERE key=? AND tracked_id IS NULL",
                         (c.closest_question, today, key))
    conn.commit()
    return n


def hit_rate(conn: sqlite3.Connection, now: datetime) -> dict:
    """What happened to flagged candidates: still coming up 4+ weeks later,
    turned into a tracked question, and named in answers after that."""
    if not _has_table(conn, "radar_flags"):
        return {"flagged": 0, "checkable": 0, "seen_again": 0, "tracked": 0, "mentioned_after": 0, "items": []}
    cutoff = (now - timedelta(days=HIT_CHECK_DAYS)).date().isoformat()
    has_runs = _has_table(conn, "runs")
    items = []
    for key, query, first, last, best, _last_score, tracked_id, tracked_since in conn.execute(
            "SELECT * FROM radar_flags ORDER BY first_flagged"):
        mentioned = False
        if tracked_id and has_runs:
            mentioned = conn.execute(
                "SELECT 1 FROM runs WHERE question_id=? AND mentioned=1 AND substr(timestamp,1,10) >= ? LIMIT 1",
                (tracked_id, tracked_since)).fetchone() is not None
        seen_again = (date.fromisoformat(last) - date.fromisoformat(first)).days >= 28
        items.append({"id": key_id(frozenset(key.split())), "query": query, "first_flagged": first,
                      "last_flagged": last, "best_score": best, "tracked": tracked_id, "tracked_since": tracked_since,
                      "seen_again": seen_again, "mentioned_after": mentioned})
    checkable = [i for i in items if i["first_flagged"] <= cutoff]
    return {"flagged": len(items), "checkable": len(checkable),
            "seen_again": sum(i["seen_again"] for i in checkable),
            "tracked": sum(bool(i["tracked"]) for i in items),
            "mentioned_after": sum(i["mentioned_after"] for i in items), "items": items}


# ---------- Build ----------

def load_target(data_dir: str) -> tuple[dict, list[dict], dict[str, frozenset[str]]]:
    """(radar config, categories, tracked question words). Tracked questions:
    questions.json plus the run list's own questions."""
    tdir = ROOT / data_dir
    path = tdir / "radar.json"
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"terms": []}
    categories = json.loads((tdir / "categories.json").read_text(encoding="utf-8"))
    questions = json.loads((tdir / "questions.json").read_text(encoding="utf-8"))
    known = {q["id"]: q["text"] for q in questions}
    known.update({q["id"]: q["text"] for q in load_run_list(tdir) or []})
    return config, categories, {qid: content_words(text) for qid, text in known.items()}


def build(conn: sqlite3.Connection, config: dict, categories: list[dict], question_words: dict[str, frozenset[str]],
          now: datetime | None = None, new_below: float = 0.6, merge_at: float = 0.6) -> list[Candidate]:
    """All candidates, scored, best first. Drops community posts that don't
    touch the target's topics at all (search engines match loosely)."""
    from monitoring.radar_probe import load_probe_open  # local: radar_probe imports this module

    now = now or datetime.now(UTC)
    today = now.date().isoformat()
    terms = config.get("terms", [])
    rows = load_rows(conn)
    sightings = engine_sightings(rows) + post_sightings(conn, now) + event_sightings(config, today)
    engine_history = bool(rows) and rows[0][2][:10] < (now - timedelta(days=RECENT_DAYS)).date().isoformat()
    candidates = group(sightings, question_words, new_below, merge_at, now)
    topics = {t["term"]: t for t in load_topics(conn, terms)}
    kw = keyword_sets(categories, terms)
    probes = load_probe_open(conn, now)
    flags = {}
    if _has_table(conn, "radar_flags"):
        flags = {k: f for k, f in conn.execute("SELECT key, first_flagged FROM radar_flags")}
    out = []
    for c in candidates:
        p = probes.get(c.id)
        score(c, topics, kw, now, p["open"] if p else None, engine_history)
        if p:
            c.probe = p["engines"]
        if c.parts["fit"] == 0:
            continue
        c.flagged_since = flags.get(" ".join(sorted(c.key)))
        out.append(c)
    return sorted(out, key=lambda c: (not c.new, -c.score, c.query.casefold()))


def to_json(candidates: list[Candidate]) -> list[dict]:
    out = []
    for c in candidates:
        d = asdict(c)
        for k in ("spellings", "key"):
            d.pop(k)
        d["id"] = c.id
        out.append(d)
    return out


def export(conn: sqlite3.Connection, data_dir: str, now: datetime | None = None, limit: int = MAX_EXPORT) -> dict:
    """The radar section for the app (scripts/export_monitoring.py)."""
    now = now or datetime.now(UTC)
    config, categories, qwords = load_target(data_dir)
    candidates = build(conn, config, categories, qwords, now)
    new = [c for c in candidates if c.new][:limit]
    tracked = [c for c in candidates if not c.new and c.flagged_since]
    counts = Counter()
    for c in candidates:
        for o in c.origins:
            counts[o.split(":")[0]] += 1
    return {
        "generated": now.date().isoformat(),
        "weights": WEIGHTS,
        "origins": dict(counts),
        "topics": [{k: v for k, v in t.items() if k != "fetched"} for t in load_topics(conn, config.get("terms", []))],
        "candidates": [_slim(d) for d in to_json(new + tracked)],
        "hits": {k: v for k, v in hit_rate(conn, now).items() if k != "items"},
    }


def _slim(d: dict) -> dict:
    keep = ("id", "query", "score", "parts", "open_measured", "origins", "engines", "questions", "links", "count",
            "first_seen", "last_seen", "category", "new", "closest_question", "overlap", "flagged_since", "variants",
            "probe", "event_date", "unanswered")
    out = {k: d[k] for k in keep}
    out["first_seen"], out["last_seen"] = out["first_seen"][:10], out["last_seen"][:10]
    return out


# ---------- CLI ----------

def print_table(candidates: list[Candidate]) -> None:
    if not candidates:
        print("Nothing on the radar yet. Run `python monitoring/radar.py collect` (free) and/or a monitoring run.")
        return
    new = sum(c.new for c in candidates)
    print(f"{len(candidates)} candidates, {new} not covered by a tracked question\n")
    print(f"{'score':>5}  {'mom':>3} {'dem':>3} {'open':>4} {'fit':>3}  {'from':<22} question")
    for c in candidates:
        origins = ",".join(o.replace("stackexchange:", "se:") for o in c.origins)
        open_mark = "*" if c.open_measured else " "
        print(f"{c.score:>5}  {c.parts['momentum']:>3} {c.parts['demand']:>3} {c.parts['open']:>3}{open_mark} "
              f"{c.parts['fit']:>3}  {origins[:22]:<22} {'' if c.new else '(tracked) '}{c.query}")
        for v in c.variants[:3]:
            print(f"{'':<46}~ {v}")
    print("\n* open slot measured by a probe; otherwise estimated.")


def print_topics(topics: list[dict]) -> None:
    if not topics:
        return
    print("Topic momentum (last 30 days vs. 30-day average of the 150 days before):")
    for t in topics:
        m = "  –" if t["momentum"] is None else f"{round(t['momentum'] * 100):>3}"
        g = "" if t["growth"] is None else f"x{t['growth']:<5}"
        src = ", ".join(f"{s['source'].replace('stackexchange:', 'se:')} {s['recent']}/{s['baseline']:g}"
                        for s in t["sources"])
        print(f"  {m}  {g:<7} {t['term']:<34} {src}")
    print()


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", default="show", choices=["show", "collect", "probe", "hits"])
    ap.add_argument("--db", default=str(ROOT / "monitoring" / "runs.sqlite"), help="Monitoring database.")
    ap.add_argument("--target", help="Folder with questions.json and radar.json. Default: the settings' target.")
    ap.add_argument("--min-count", type=int, default=1, help="show: hide candidates seen fewer times than this.")
    ap.add_argument("--new-below", type=float, default=0.6,
                    help="Overlap with the closest tracked question below which a candidate counts as new.")
    ap.add_argument("--merge-at", type=float, default=0.6,
                    help="Word overlap (Jaccard) at which two candidates are grouped as one.")
    ap.add_argument("--only-new", action="store_true", help="show: only candidates no tracked question covers.")
    ap.add_argument("--limit", type=int, default=30, help="show: at most this many rows.")
    ap.add_argument("--json", action="store_true", help="show: print the app's radar section as JSON.")
    ap.add_argument("--top", type=int, default=5, help="probe: how many candidates to test.")
    ap.add_argument("--engines", help="probe: comma-separated engines. Default: enabled engines with a key.")
    ap.add_argument("--dry-run", action="store_true", help="probe: recorded answers instead of API calls.")
    ap.add_argument("--yes", action="store_true", help="probe: skip the cost confirmation.")
    args = ap.parse_args(argv)

    settings = json.loads((ROOT / "data" / "monitoring_settings.json").read_text(encoding="utf-8"))
    data_dir = args.target or settings.get("target") or "data"
    if args.command != "collect" and not Path(args.db).exists():
        print(f"No database at {args.db}. Run `python monitoring/radar.py collect` or monitoring/run.py first.",
              file=sys.stderr)
        return 1
    conn = sqlite3.connect(args.db)
    try:
        now = datetime.now(UTC)
        config, categories, qwords = load_target(data_dir)
        if args.command == "collect":
            if not config.get("terms"):
                print(f"No {data_dir}/radar.json with terms; nothing to collect.", file=sys.stderr)
                return 1
            from monitoring.radar_sources import collect
            print(f"Target: {data_dir}. Collecting {len(config['terms'])} terms from public sources (free)...")
            summary = collect(conn, config, now)
            candidates = build(conn, config, categories, qwords, now, args.new_below, args.merge_at)
            flagged = record_flags(conn, candidates, config.get("min_score", 60), now.date().isoformat())
            print(f"Stored {summary['posts']} posts and {summary['counts']} counts; "
                  f"{len(summary['errors'])} request(s) failed. {flagged} candidate(s) at or above "
                  f"{config.get('min_score', 60)} logged for the hit rate.")
            return 0
        if args.command == "probe":
            from monitoring.radar_probe import run_probe_cli
            return run_probe_cli(conn, args, settings, data_dir, config, categories, qwords, now)
        if args.command == "hits":
            h = hit_rate(conn, now)
            print(f"Flagged: {h['flagged']}  older than 8 weeks: {h['checkable']}  still coming up 4+ weeks later: "
                  f"{h['seen_again']}  became tracked: {h['tracked']}  brand named after tracking: "
                  f"{h['mentioned_after']}")
            for i in h["items"]:
                tracked = "tracked " + i["tracked"] if i["tracked"] else ""
                print(f"  {i['first_flagged']}  {i['best_score']:>3}  {tracked:<14}"
                      f"{'named' if i['mentioned_after'] else '':<6} {i['query']}")
            return 0
        if args.json:
            json.dump(export(conn, data_dir, now), sys.stdout, ensure_ascii=False, indent=2)
            print()
            return 0
        candidates = build(conn, config, categories, qwords, now, args.new_below, args.merge_at)
        candidates = [c for c in candidates if c.count >= args.min_count and (c.new or not args.only_new)]
        print(f"Target: {data_dir}")
        print_topics(load_topics(conn, config.get("terms", [])))
        print_table(candidates[: args.limit])
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
