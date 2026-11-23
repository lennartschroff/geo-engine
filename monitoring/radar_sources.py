"""Question Radar: collect real questions and topic momentum from public
sources (docs/QUESTION_RADAR.md, TASKS.md Epic H).

Free, official APIs only, no keys required:
- Hacker News (Algolia search API)
- Stack Exchange API (e.g. webmasters, stackoverflow); 300 requests a day
  without a key, set STACKEXCHANGE_KEY for more
- GitHub issue search; 10 searches a minute without a token, GITHUB_TOKEN
  (set automatically in GitHub Actions) raises that
- Wikimedia page views (daily views of named Wikipedia articles)

Per term and source we store:
- posts that read like questions (title, link, date, score, views,
  answers), without author names
- a count snapshot: posts in the last 30 days vs. the 30-day average of
  the 150 days before. That ratio is the term's momentum, available on the
  first run because the APIs filter by date.

What is sent out: the topic terms from the target's radar.json (validated
to never contain the brand name) and nothing else. The User-Agent is a
generic client name; Wikimedia asks for contact details in it, so set
RADAR_USER_AGENT in .env if you want to add yours.
"""
from __future__ import annotations

import gzip
import html
import json
import os
import re
import sqlite3
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

DEFAULT_USER_AGENT = "radar-collector/0.1 (python-urllib)"
WINDOW_DAYS = 30
LOOKBACK_DAYS = 180
BASELINE_WINDOWS = (LOOKBACK_DAYS - WINDOW_DAYS) / WINDOW_DAYS  # 5 windows of 30 days

QUESTION_START = re.compile(
    r"^(what|why|when|where|which|who|is|are|can|could|should|does|do|did|will|would|has|have|any|"
    r"wie|was|warum|wann|wo|welche|welcher|welches|wer|ist|sind|kann|können|sollte|gibt)\b",
    re.I,
)
# "How X showed Y" is a headline; "How to/do/can/much ..." asks something.
HOW_QUESTION = re.compile(
    r"^how (to|do|does|did|can|could|should|would|will|is|are|much|many|well|long|often|i|we|you)\b", re.I)
ASK_HN = re.compile(r"^(ask|tell) hn:\s*", re.I)


def _ssl_context() -> ssl.SSLContext:
    """certifi's CA bundle when installed (it comes with the API SDKs in
    requirements.txt): python.org builds on macOS ship without root
    certificates, so the system default fails there."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # pragma: no cover
        return ssl.create_default_context()


SSL_CONTEXT = _ssl_context()


class SourceError(RuntimeError):
    """One request failed (network, HTTP error, rate limit). The collector
    logs it and moves on to the next term/source."""


@dataclass
class Post:
    source: str          # hackernews | stackexchange:<site> | github
    post_id: str
    term: str
    title: str
    url: str
    created: str         # ISO date
    score: int = 0       # points / votes / reactions
    views: int = 0       # Stack Exchange only
    answers: int = 0     # answers / comments
    answered: bool | None = None  # Stack Exchange: has an upvoted or accepted answer


@dataclass
class Count:
    source: str
    term: str
    recent: int          # posts (or page views) in the last WINDOW_DAYS
    baseline: float      # average per WINDOW_DAYS over the LOOKBACK_DAYS before that
    series: list[int] = field(default_factory=list)  # optional weekly values, oldest first


def is_question(title: str) -> bool:
    if ASK_HN.match(title.strip()):  # every Ask HN post asks the community something
        return True
    t = title.strip()
    return t.endswith("?") or bool(QUESTION_START.match(t) or HOW_QUESTION.match(t))


def clean_title(title: str) -> str:
    return ASK_HN.sub("", html.unescape(title).strip())


def http_get_json(url: str, headers: dict | None = None, timeout: int = 20, retries: int = 2,
                  sleep: Callable[[float], None] = time.sleep) -> dict:
    """GET a JSON document. Handles gzip (Stack Exchange always compresses)
    and backs off on HTTP 429 using Retry-After (capped at 30 s)."""
    hdrs = {"User-Agent": os.environ.get("RADAR_USER_AGENT") or DEFAULT_USER_AGENT,
            "Accept": "application/json", "Accept-Encoding": "gzip"}
    hdrs.update(headers or {})
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as resp:  # noqa: S310 (fixed https hosts)
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip" or raw[:2] == b"\x1f\x8b":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < retries:
                wait = min(30.0, float(e.headers.get("Retry-After") or 5 * (attempt + 1)))
                sleep(wait)
                continue
            raise SourceError(f"HTTP {e.code} for {urllib.parse.urlsplit(url).netloc}") from e
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
            if attempt < retries:
                sleep(2.0 * (attempt + 1))
                continue
            raise SourceError(f"{type(e).__name__} for {urllib.parse.urlsplit(url).netloc}: {e}") from e
    raise SourceError("unreachable")  # pragma: no cover


def _ts(dt: datetime) -> int:
    return int(dt.timestamp())


def _split_counts(total: int, recent: int) -> tuple[int, float]:
    return recent, round(max(0, total - recent) / BASELINE_WINDOWS, 2)


# ---------- Hacker News (hn.algolia.com) ----------

def hackernews(term: str, now: datetime, http=http_get_json) -> tuple[list[Post], Count]:
    query = f'"{term}"' if " " in term else term
    since, recent_since = now - timedelta(days=LOOKBACK_DAYS), now - timedelta(days=WINDOW_DAYS)
    base = "https://hn.algolia.com/api/v1/"
    params = {"query": query, "tags": "story", "hitsPerPage": 100,
              "numericFilters": f"created_at_i>{_ts(since)}"}
    data = http(base + "search_by_date?" + urllib.parse.urlencode(params))
    total = int(data.get("nbHits") or 0)
    recent_params = dict(params, hitsPerPage=0, numericFilters=f"created_at_i>{_ts(recent_since)}")
    recent = int(http(base + "search?" + urllib.parse.urlencode(recent_params)).get("nbHits") or 0)
    posts = [
        Post("hackernews", str(h["objectID"]), term, clean_title(h.get("title") or ""),
             f"https://news.ycombinator.com/item?id={h['objectID']}", (h.get("created_at") or "")[:10],
             score=int(h.get("points") or 0), answers=int(h.get("num_comments") or 0))
        for h in data.get("hits", [])
        if h.get("title") and is_question(h["title"])
    ]
    return posts, Count("hackernews", term, *_split_counts(total, recent))


# ---------- Stack Exchange ----------

def stackexchange(term: str, site: str, now: datetime, http=http_get_json,
                  sleep: Callable[[float], None] = time.sleep) -> tuple[list[Post], Count]:
    since, recent_since = now - timedelta(days=LOOKBACK_DAYS), now - timedelta(days=WINDOW_DAYS)
    base = "https://api.stackexchange.com/2.3/search/advanced?"
    common = {"q": term, "site": site}
    key = os.environ.get("STACKEXCHANGE_KEY")
    if key:
        common["key"] = key

    def get(params):
        data = http(base + urllib.parse.urlencode({**common, **params}))
        if data.get("error_id"):
            raise SourceError(f"Stack Exchange {site}: {data.get('error_name')}")
        if data.get("backoff"):  # the API asks clients to pause before the next call
            sleep(min(30, int(data["backoff"])))
        return data

    items = get({"fromdate": _ts(since), "sort": "creation", "order": "desc", "pagesize": 100})
    total = int(get({"fromdate": _ts(since), "filter": "total"}).get("total") or 0)
    recent = int(get({"fromdate": _ts(recent_since), "filter": "total"}).get("total") or 0)
    posts = [
        Post(f"stackexchange:{site}", str(i["question_id"]), term, clean_title(i.get("title") or ""),
             i.get("link") or "", datetime.fromtimestamp(int(i["creation_date"]), UTC).date().isoformat(),
             score=int(i.get("score") or 0), views=int(i.get("view_count") or 0),
             answers=int(i.get("answer_count") or 0), answered=bool(i.get("is_answered")))
        for i in items.get("items", [])
        if i.get("title") and i.get("question_id") and i.get("creation_date")
    ]
    return posts, Count(f"stackexchange:{site}", term, *_split_counts(total, recent))


# ---------- GitHub issues and discussions search ----------

def github(term: str, now: datetime, http=http_get_json) -> tuple[list[Post], Count]:
    since, recent_since = now - timedelta(days=LOOKBACK_DAYS), now - timedelta(days=WINDOW_DAYS)
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    base = "https://api.github.com/search/issues?"

    def get(q, per_page):
        return http(base + urllib.parse.urlencode({"q": q, "per_page": per_page, "sort": "created", "order": "desc"}),
                    headers=headers)

    data = get(f'"{term}" is:issue created:>={since.date().isoformat()}', 100)
    items, total = data.get("items", []), int(data.get("total_count") or 0)
    cutoff = recent_since.date().isoformat()
    if total <= len(items):
        recent = sum(1 for i in items if (i.get("created_at") or "")[:10] >= cutoff)
    else:
        recent = int(get(f'"{term}" is:issue created:>={cutoff}', 1).get("total_count") or 0)
    posts = [
        Post("github", str(i["id"]), term, clean_title(i.get("title") or ""), i.get("html_url") or "",
             (i.get("created_at") or "")[:10], score=int((i.get("reactions") or {}).get("total_count") or 0),
             answers=int(i.get("comments") or 0))
        for i in items
        if i.get("title") and i.get("id") and is_question(i["title"])
    ]
    return posts, Count("github", term, *_split_counts(total, recent))


GITHUB_ALL = "*"  # term name of the platform-wide control count


def github_all(now: datetime, http=http_get_json) -> Count:
    """All GitHub issues, same windows: the platform's own growth. GitHub
    grows fast, so a term's raw growth there mostly reflects the platform;
    radar.load_topics divides it out."""
    headers = {"Accept": "application/vnd.github+json"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    since, recent_since = now - timedelta(days=LOOKBACK_DAYS), now - timedelta(days=WINDOW_DAYS)
    base = "https://api.github.com/search/issues?"

    def total(q):
        data = http(base + urllib.parse.urlencode({"q": q, "per_page": 1}), headers=headers)
        return int(data.get("total_count") or 0)

    day_before = (recent_since - timedelta(days=1)).date().isoformat()
    recent = total(f"is:issue created:>={recent_since.date().isoformat()}")
    before = total(f"is:issue created:{since.date().isoformat()}..{day_before}")
    return Count("github", GITHUB_ALL, recent, round(before / BASELINE_WINDOWS, 2))


# ---------- Wikipedia page views ----------

def wikipedia(article: str, now: datetime, http=http_get_json) -> Count:
    """article as 'en:Title_with_underscores'. Daily user views for the
    lookback period; recent = last 30 days, series = weekly sums."""
    lang, title = article.split(":", 1)
    end = (now - timedelta(days=1)).strftime("%Y%m%d")
    start = (now - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d")
    url = ("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/"
           f"{lang}.wikipedia/all-access/user/{urllib.parse.quote(title, safe='')}/daily/{start}/{end}")
    days = [int(i.get("views") or 0) for i in http(url).get("items", [])]
    recent = sum(days[-WINDOW_DAYS:])
    baseline = round(sum(days[:-WINDOW_DAYS]) / BASELINE_WINDOWS, 2) if len(days) > WINDOW_DAYS else 0.0
    series = [sum(days[i:i + 7]) for i in range(len(days) % 7, len(days), 7)]
    return Count("wikipedia", article, recent, baseline, series)


# ---------- Storage ----------

def ensure_tables(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS radar_posts (
            source TEXT NOT NULL, post_id TEXT NOT NULL, term TEXT NOT NULL, title TEXT NOT NULL,
            url TEXT NOT NULL, created TEXT NOT NULL, score INTEGER, views INTEGER, answers INTEGER,
            answered INTEGER, first_fetched TEXT NOT NULL, last_fetched TEXT NOT NULL,
            PRIMARY KEY (source, post_id)
        )""")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS radar_counts (
            fetched TEXT NOT NULL, source TEXT NOT NULL, term TEXT NOT NULL,
            recent INTEGER NOT NULL, baseline REAL NOT NULL, series TEXT,
            PRIMARY KEY (fetched, source, term)
        )""")
    conn.commit()


def store_posts(conn: sqlite3.Connection, posts: list[Post], today: str) -> int:
    for p in posts:
        conn.execute(
            "INSERT INTO radar_posts VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source, post_id) DO UPDATE SET "
            "title=excluded.title, score=excluded.score, views=excluded.views, answers=excluded.answers, "
            "answered=excluded.answered, last_fetched=excluded.last_fetched",
            (p.source, p.post_id, p.term, p.title, p.url, p.created, p.score, p.views, p.answers,
             None if p.answered is None else int(p.answered), today, today),
        )
    return len(posts)


def store_count(conn: sqlite3.Connection, c: Count, today: str) -> None:
    conn.execute("INSERT OR REPLACE INTO radar_counts VALUES (?,?,?,?,?,?)",
                 (today, c.source, c.term, c.recent, c.baseline, json.dumps(c.series) if c.series else None))


def collect(conn: sqlite3.Connection, config: dict, now: datetime | None = None, http=http_get_json,
            sleep: Callable[[float], None] = time.sleep, log: Callable[[str], None] = print) -> dict:
    """Fetch every term from every enabled source and store the results.
    One failing request is logged and skipped; the rest still runs."""
    now = now or datetime.now(UTC)
    today = now.date().isoformat()
    ensure_tables(conn)
    src = config.get("sources") or {}
    sites = src.get("stackexchange") or []
    gh_pause = 2.0 if os.environ.get("GITHUB_TOKEN") else 6.5  # stay under GitHub's search rate limit
    summary = {"posts": 0, "counts": 0, "errors": []}

    def run(label, fn, pause):
        try:
            result = fn()
        except SourceError as e:
            summary["errors"].append(f"{label}: {e}")
            log(f"[radar] {label}: {e}")
            return
        finally:
            sleep(pause)
        posts, count = result if isinstance(result, tuple) else ([], result)
        summary["posts"] += store_posts(conn, posts, today)
        store_count(conn, count, today)
        summary["counts"] += 1
        conn.commit()

    for term in config["terms"]:
        if src.get("hackernews", True):
            run(f"hackernews '{term}'", lambda t=term: hackernews(t, now, http), 0.3)
        for site in sites:
            run(f"stackexchange:{site} '{term}'", lambda t=term, s=site: stackexchange(t, s, now, http, sleep), 0.5)
        if src.get("github", True):
            run(f"github '{term}'", lambda t=term: github(t, now, http), gh_pause)
    if src.get("github", True):
        run("github platform count", lambda: github_all(now, http), gh_pause)
    for article in src.get("wikipedia") or []:
        run(f"wikipedia {article}", lambda a=article: wikipedia(a, now, http), 1.5)
    return summary
