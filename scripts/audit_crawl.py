"""GEO website audit.

Crawls every URL in a site's sitemap(s), extracts signals that matter for
generative engine optimization (GEO) and checks whether AI crawlers are allowed
to fetch the site.

Usage:
    pip install -r requirements.txt
    python scripts/audit_crawl.py --base https://www.example.com
    python scripts/audit_crawl.py --base https://www.example.com --limit 10   # quick test

Output:
    data/crawl-<date>.json          raw signals per page
    docs/audit-summary-<date>.md    short summary

Only crawl sites you own or are allowed to audit.
"""
from __future__ import annotations

import argparse
import collections
import datetime
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
BOT_UAS = {
    "GPTBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot",
    "OAI-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot",
    "ChatGPT-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
    "ClaudeBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "Claude-SearchBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)",
    "Claude-User": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)",
    "PerplexityBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
}
# Relative time statements ("for over 15 years") go stale; fixed years don't.
RELATIVE_TIME = re.compile(r"(seit (über|mehr als) \d+ Jahren|über \d+ Jahre|(over|more than) \d+ years)", re.I)
FIGURE = re.compile(r"\b\d{2,}(?:[.,]\d+)?\s?(?:%|Prozent|percent|\+)?")


def get(url: str, ua: str = BROWSER_UA) -> requests.Response:
    return requests.get(url, headers={"User-Agent": ua}, timeout=30)


def sitemap_urls(base: str, sitemaps: list[str]) -> list[str]:
    urls: list[str] = []
    for path in sitemaps:
        xml = get(base + path).text
        locs = re.findall(r"<loc>([^<]+)</loc>", xml)
        # A sitemap index points to further sitemaps – follow one level.
        if "<sitemapindex" in xml:
            for sub in locs:
                urls += re.findall(r"<loc>([^<]+)</loc>", get(sub).text)
        else:
            urls += locs
    return list(dict.fromkeys(urls))


def schema_types(soup: BeautifulSoup) -> list[str]:
    types: list[str] = []
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "{}")
        except json.JSONDecodeError:
            continue
        nodes = data.get("@graph", [data]) if isinstance(data, dict) else data
        for node in nodes if isinstance(nodes, list) else []:
            if isinstance(node, dict):
                t = node.get("@type")
                types += t if isinstance(t, list) else [t]
    return sorted({str(t) for t in types if t})


def parse(url: str) -> dict:
    try:
        r = get(url)
    except requests.RequestException as e:
        return {"url": url, "error": str(e)}
    s = BeautifulSoup(r.text, "lxml")

    def meta(prop: str) -> str:
        tag = s.find("meta", attrs={"property": prop})
        return (tag.get("content", "") if tag else "")[:10]

    title = s.title.get_text(strip=True) if s.title else ""
    md = s.find("meta", attrs={"name": "description"})
    types = schema_types(s)
    published, modified = meta("article:published_time"), meta("article:modified_time")
    for t in s(["script", "style", "noscript", "header", "footer", "nav"]):
        t.decompose()
    main = s.find("main") or s.body
    h1 = [x.get_text(" ", strip=True) for x in main.find_all("h1")] if main else []
    h2 = [x.get_text(" ", strip=True) for x in main.find_all(["h2", "h3"])] if main else []
    text = main.get_text(" ", strip=True) if main else ""
    return {
        "url": url, "status": r.status_code, "title": title,
        "meta_description": md.get("content", "").strip() if md else "",
        "schema_types": types, "published": published, "modified": modified,
        "h1": h1, "h2": h2[:15], "h2_count": len(h2),
        "question_headings": sum(1 for x in h2 if x.endswith("?")),
        "words": len(text.split()), "figures": len(FIGURE.findall(text)),
        "relative_time": sorted({m.group(0) for m in RELATIVE_TIME.finditer(text)}),
        "text": text[:6000],
    }


def crawler_access(url: str) -> dict[str, int]:
    return {name: get(url, ua).status_code for name, ua in BOT_UAS.items()}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", required=True, help="Site root, e.g. https://www.example.com")
    ap.add_argument("--sitemap", action="append", help="Sitemap path (repeatable). Default: /sitemap.xml")
    ap.add_argument("--access-url", help="Page used for the crawler access test. Default: --base")
    ap.add_argument("--limit", type=int, default=0, help="Only crawl the first N URLs")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    base = args.base.rstrip("/")
    today = datetime.date.today().isoformat()
    urls = sitemap_urls(base, args.sitemap or ["/sitemap.xml"])
    if args.limit:
        urls = urls[: args.limit]
    print(f"Checking {len(urls)} URLs …", file=sys.stderr)
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        rows = list(ex.map(parse, urls))

    access = crawler_access(args.access_url or base + "/")
    llms = get(base + "/llms.txt").status_code
    robots = get(base + "/robots.txt").text

    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "docs").mkdir(exist_ok=True)
    (ROOT / "data" / f"crawl-{today}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")

    ok = [r for r in rows if "error" not in r]
    schema = collections.Counter(t for r in ok for t in r["schema_types"])
    lines = [
        f"# GEO audit {base} – {today}", "",
        f"- Pages checked: {len(ok)} (errors: {len(rows) - len(ok)})",
        f"- llms.txt: HTTP {llms}",
        f"- Pages with FAQPage schema: {schema.get('FAQPage', 0)}",
        f"- Pages without H1: {sum(1 for r in ok if not r['h1'])}",
        f"- Pages with at least 2 question headings: {sum(1 for r in ok if r['question_headings'] >= 2)}",
        f"- Pages with relative time statements: {sum(1 for r in ok if r['relative_time'])}",
        "", "## Crawler access (HTTP status)", "",
        *[f"- {k}: {v}" for k, v in access.items()],
        "", "## robots.txt", "", "```", robots.strip(), "```",
    ]
    (ROOT / "docs" / f"audit-summary-{today}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
