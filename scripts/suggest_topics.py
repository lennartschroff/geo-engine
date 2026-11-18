"""Suggests topics (for the app's Setup wizard) from a real site crawl.

The browser app cannot fetch your site itself (its CSP blocks all network
calls, on purpose — see README.md "Design decisions"). This script is the
honest version of "auto-fill topics from my website": it reads the crawl
scripts/audit_crawl.py already produces, and turns the site's own H2/H3
headings into candidate topics — no API key, no network call from the app,
runs entirely on your machine.

Output is a JSON file shaped for the Setup wizard's "Load topics from a
crawl" file picker: [{"label": "...", "keywords": ["..."]}, ...].

Usage:
    python scripts/audit_crawl.py --base https://www.example.com   # first
    python scripts/suggest_topics.py                                # then
    python scripts/suggest_topics.py --crawl data/crawl-2026-11-18.json --out my_topics.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Generic site-structure headings that aren't real topics -- EN + DE, since
# the rest of this project treats mixed-language content as normal.
STOPWORDS = {
    "contact", "about", "about us", "imprint", "privacy", "privacy policy", "terms",
    "terms of service", "newsletter", "careers", "jobs", "blog", "news", "faq", "faqs",
    "kontakt", "über uns", "impressum", "datenschutz", "datenschutzerklärung", "agb",
    "karriere", "aktuelles", "login", "sign in", "sign up", "cookie policy",
}
MAX_TOPICS = 12
MIN_LABEL_WORDS = 2


def clean_label(h: str) -> str:
    return h.strip().rstrip("?!.").strip()


def extract_topics(pages: list[dict]) -> list[dict]:
    """Ranks unique H2/H3 headings by how many pages they appear on."""
    counts: dict[str, int] = {}
    for page in pages:
        if "error" in page:
            continue
        seen_on_page = set()
        for h in page.get("h2", []):
            label = clean_label(h)
            key = label.lower()
            if not label or key in STOPWORDS or len(label.split()) < MIN_LABEL_WORDS:
                continue
            if key in seen_on_page:
                continue  # don't let a heading repeated within one page inflate its count
            seen_on_page.add(key)
            counts[label] = counts.get(label, 0) + 1

    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:MAX_TOPICS]
    return [{"label": label, "keywords": [label.lower()]} for label, _count in ranked]


def latest_crawl_file() -> Path | None:
    candidates = sorted((ROOT / "data").glob("crawl-*.json"))
    return candidates[-1] if candidates else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crawl", help="Path to a crawl-<date>.json from audit_crawl.py. Default: newest in data/.")
    ap.add_argument("--out", default=str(ROOT / "data" / "suggested_topics.json"))
    args = ap.parse_args()

    crawl_path = Path(args.crawl) if args.crawl else latest_crawl_file()
    if crawl_path is None or not crawl_path.exists():
        print("No crawl file found. Run scripts/audit_crawl.py first, or pass --crawl explicitly.", file=sys.stderr)
        return 1

    pages = json.loads(crawl_path.read_text(encoding="utf-8"))
    topics = extract_topics(pages)
    if not topics:
        print("No candidate topics found (headings may be too generic or missing).", file=sys.stderr)
        return 1

    Path(args.out).write_text(json.dumps(topics, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Found {len(topics)} candidate topic(s) from {crawl_path.name} -> {args.out}")
    print("Review these before loading them into the Setup wizard -- headings don't always make good topic labels.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
