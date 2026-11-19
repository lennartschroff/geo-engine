"""Crawl a website and record the signals that matter for AI citability.

For every page found (sitemap first, homepage links as a fallback) it stores
title, meta description, JSON-LD types, headings, word count, figures and
stale relative time phrases. For the site as a whole it checks which AI
crawlers get through, whether /llms.txt exists, and keeps robots.txt.

    python scripts/audit_crawl.py --base https://www.example.com
    python scripts/audit_crawl.py --base https://www.example.com --limit 10

Writes (all git-ignored):
    data/crawl-<date>.json          one record per page   -> score_pages.py, suggest_topics.py
    data/site-checks-<date>.json    crawler access etc.   -> audit_findings.py
    docs/audit-summary-<date>.md    short human-readable summary

Only crawl sites you own or have permission to audit.
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
TIMEOUT_S = 30
DEFAULT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"

# Published user-agent strings of the crawlers that feed AI assistants.
AI_CRAWLERS = {
    "GPTBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
    "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; "
                     "+https://openai.com/searchbot",
    "ChatGPT-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; "
                    "+https://openai.com/bot",
    "ClaudeBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Claude-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; "
                        "+https://www.anthropic.com)",
    "Claude-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; "
                   "+Claude-User@anthropic.com)",
    "PerplexityBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; "
                     "+https://perplexity.ai/perplexitybot)",
    "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
}

# "for over 10 years" / "seit mehr als 15 Jahren": true today, wrong next year.
RELATIVE_TIME = re.compile(
    r"\b(?:over|more than) \d+ years\b"
    r"|\bseit (?:über|mehr als) \d+ Jahren\b"
    r"|\büber \d+ Jahre",
    re.IGNORECASE,
)
# Numbers with two or more digits, optionally with a decimal part and %/+.
FIGURE = re.compile(r"\b\d{2,}(?:[.,]\d+)?\s?(?:%|percent|Prozent|\+)?")
LOC = re.compile(r"<loc>\s*([^<\s]+)\s*</loc>")
DROP_TAGS = ("script", "style", "noscript", "header", "footer", "nav")


def fetch(url: str, user_agent: str = DEFAULT_UA) -> requests.Response:
    return requests.get(url, headers={"User-Agent": user_agent}, timeout=TIMEOUT_S)


def urls_from_sitemaps(base: str, paths: list[str]) -> list[str]:
    """All <loc> URLs; a sitemap index is followed one level down."""
    found: list[str] = []
    for path in paths:
        xml = fetch(base + path).text
        locations = LOC.findall(xml)
        if "<sitemapindex" not in xml:
            found.extend(locations)
            continue
        for child in locations:
            found.extend(LOC.findall(fetch(child).text))
    return list(dict.fromkeys(found))


def discover_urls_via_links(base: str) -> list[str]:
    """Homepage plus every same-host link on it (for sites without a sitemap)."""
    home = base.rstrip("/") + "/"
    try:
        html = fetch(home).text
    except requests.RequestException as exc:
        print(f"Could not load {home}: {exc}", file=sys.stderr)
        return [home]
    host = urlsplit(home).netloc
    found = [home]
    for link in BeautifulSoup(html, "lxml").select("a[href]"):
        parts = urlsplit(urljoin(home, link["href"]))
        if parts.scheme not in ("http", "https") or parts.netloc != host:
            continue
        url = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
        if url not in found:
            found.append(url)
    return found


def schema_types(soup: BeautifulSoup) -> list[str]:
    """Sorted, unique @type values from all JSON-LD blocks (incl. @graph and type lists)."""
    seen: set[str] = set()
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            doc = json.loads(script.string or "null")
        except json.JSONDecodeError:
            continue
        if isinstance(doc, dict) and "@graph" in doc:
            doc = doc["@graph"]
        for node in doc if isinstance(doc, list) else [doc]:
            if not isinstance(node, dict):
                continue
            kind = node.get("@type")
            for value in kind if isinstance(kind, list) else [kind]:
                if value:
                    seen.add(str(value))
    return sorted(seen)


def meta_content(soup: BeautifulSoup, **attrs: str) -> str:
    tag = soup.find("meta", attrs=attrs)
    return (tag.get("content") or "").strip() if tag else ""


def inspect_page(url: str) -> dict:
    try:
        response = fetch(url)
    except requests.RequestException as exc:
        return {"url": url, "error": str(exc)}
    soup = BeautifulSoup(response.text, "lxml")
    record = {
        "url": url,
        "status": response.status_code,
        "title": soup.title.get_text(strip=True) if soup.title else "",
        "meta_description": meta_content(soup, name="description"),
        "schema_types": schema_types(soup),
        "published": meta_content(soup, property="article:published_time")[:10],
        "modified": meta_content(soup, property="article:modified_time")[:10],
    }
    for tag in soup(DROP_TAGS):
        tag.decompose()
    body = soup.find("main") or soup.body
    text = body.get_text(" ", strip=True) if body else ""
    headings = [h.get_text(" ", strip=True) for h in body.find_all(["h2", "h3"])] if body else []
    record.update({
        "h1": [h.get_text(" ", strip=True) for h in body.find_all("h1")] if body else [],
        "h2": headings[:15],
        "h2_count": len(headings),
        "question_headings": sum(h.endswith("?") for h in headings),
        "words": len(text.split()),
        "figures": len(FIGURE.findall(text)),
        "relative_time": sorted({m.group(0) for m in RELATIVE_TIME.finditer(text)}),
        "text": text[:6000],
    })
    return record


def crawler_access(url: str) -> dict[str, int]:
    return {name: fetch(url, ua).status_code for name, ua in AI_CRAWLERS.items()}


def summary_markdown(base: str, day: str, pages: list[dict], checks: dict) -> str:
    ok = [p for p in pages if "error" not in p]
    types = Counter(t for p in ok for t in p["schema_types"])
    lines = [
        f"# GEO audit {base} – {day}",
        "",
        f"- Pages checked: {len(ok)} (errors: {len(pages) - len(ok)})",
        f"- llms.txt: HTTP {checks['llms_txt_status']}",
        f"- Pages with FAQPage schema: {types.get('FAQPage', 0)}",
        f"- Pages without H1: {sum(not p['h1'] for p in ok)}",
        f"- Pages with 2+ question headings: {sum(p['question_headings'] >= 2 for p in ok)}",
        f"- Pages with relative time phrases: {sum(bool(p['relative_time']) for p in ok)}",
        "",
        "## Crawler access (HTTP status)",
        "",
        *(f"- {name}: {code}" for name, code in checks["crawler_access"].items()),
        "",
        "## robots.txt",
        "",
        "```",
        checks["robots_txt"].strip(),
        "```",
    ]
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="Site root, e.g. https://www.example.com")
    ap.add_argument("--sitemap", action="append", help="Sitemap path, repeatable. Default: /sitemap.xml")
    ap.add_argument("--access-url", help="Page used for the crawler access test. Default: the homepage")
    ap.add_argument("--limit", type=int, default=0, help="Crawl only the first N URLs")
    ap.add_argument("--workers", type=int, default=8, help="Parallel requests")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    day = datetime.date.today().isoformat()
    urls = urls_from_sitemaps(base, args.sitemap or ["/sitemap.xml"])
    if not urls:
        print("No sitemap entries found; using links from the homepage instead.", file=sys.stderr)
        urls = discover_urls_via_links(base)
    if args.limit:
        urls = urls[: args.limit]
    print(f"Crawling {len(urls)} URLs …", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pages = list(pool.map(inspect_page, urls))

    checks = {
        "base": base,
        "date": day,
        "crawler_access": crawler_access(args.access_url or base + "/"),
        "llms_txt_status": fetch(base + "/llms.txt").status_code,
        "robots_txt": fetch(base + "/robots.txt").text,
    }
    data_dir, docs_dir = ROOT / "data", ROOT / "docs"
    data_dir.mkdir(exist_ok=True)
    docs_dir.mkdir(exist_ok=True)
    (data_dir / f"crawl-{day}.json").write_text(json.dumps(pages, ensure_ascii=False, indent=1), encoding="utf-8")
    (data_dir / f"site-checks-{day}.json").write_text(json.dumps(checks, ensure_ascii=False, indent=1),
                                                      encoding="utf-8")
    report = summary_markdown(base, day, pages, checks)
    (docs_dir / f"audit-summary-{day}.md").write_text(report, encoding="utf-8")
    print(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
