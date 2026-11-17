"""Turn scripts/audit_crawl.py's crawl output into data/page_scores.json.

Previously page_scores.json was hand-maintained demo data. This computes it
from a real crawl (the `data/crawl-<date>.json` that audit_crawl.py writes),
closing the loop described in ROADMAP.md Milestone 3 ("Audit -> app").

The 7 criteria mirror what the Website tab already documents to users
(app/i18n.js webPagesSub: "answer sentence up front, figures, question
headings, FAQ schema, depth, H1 and a linked case study"). Each is worth an
equal 1/7 of the 100-point score; this is a stated heuristic, not a
validated measure, same caveat as the GEO score in README.md.

Usage:
    python scripts/score_pages.py --crawl data/crawl-2026-11-16.json --base https://www.example.com
    python scripts/score_pages.py --base https://www.example.com   # auto-picks the newest data/crawl-*.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent

# [placeholder] crude EN/DE keyword heuristic for "links a case study" — there's
# no schema.org type that reliably marks this, so this is a text search, not a
# structural signal like the other 6 criteria.
CASE_STUDY_KEYWORDS = re.compile(
    r"case stud|success stor|fallstudie|kundenfall|referenzprojekt|anwenderbericht", re.I
)

WORDS_THRESHOLD = 500  # "deepen content" — [placeholder], not empirically derived
FIGURE_MIN = 1
QUESTION_HEADINGS_MIN = 2

CRITERIA_ORDER = ["def", "nums", "qh", "faq", "words", "h1", "case"]


def score_page(page: dict, brand_short: str) -> dict | None:
    """Scores one audit_crawl.py page record. Returns None for crawl errors."""
    if "error" in page:
        return None

    met = {
        # Heuristic proxy for "opens with a direct answer": audit_crawl doesn't
        # capture the page's first sentence separately, so a non-trivial meta
        # description (what search/AI snippets often surface) stands in for it.
        "def": bool(page.get("meta_description")) and len(page["meta_description"]) >= 50,
        "nums": page.get("figures", 0) >= FIGURE_MIN,
        "qh": page.get("question_headings", 0) >= QUESTION_HEADINGS_MIN,
        "faq": "FAQPage" in page.get("schema_types", []),
        "words": page.get("words", 0) >= WORDS_THRESHOLD,
        "h1": bool(page.get("h1")) and brand_short.lower() in " ".join(page["h1"]).lower(),
        "case": bool(CASE_STUDY_KEYWORDS.search(page.get("text", ""))),
    }
    missing = [c for c in CRITERIA_ORDER if not met[c]]
    score = round(100 * sum(met.values()) / len(CRITERIA_ORDER))

    title = (page.get("h1") or [page.get("title", "")])[0] or page.get("title", "")
    path = urlparse(page["url"]).path or "/"
    return {"de": title, "en": title, "path": path, "score": score, "missing": missing}


def latest_crawl_file() -> Path | None:
    candidates = sorted((ROOT / "data").glob("crawl-*.json"))
    return candidates[-1] if candidates else None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crawl", help="Path to a crawl-<date>.json from audit_crawl.py. Default: newest in data/.")
    ap.add_argument("--out", default=str(ROOT / "data" / "page_scores.json"), help="Output path.")
    args = ap.parse_args()

    crawl_path = Path(args.crawl) if args.crawl else latest_crawl_file()
    if crawl_path is None or not crawl_path.exists():
        print("No crawl file found. Run scripts/audit_crawl.py first, or pass --crawl explicitly.", file=sys.stderr)
        return 1

    pages = json.loads(crawl_path.read_text(encoding="utf-8"))
    brand_short = json.loads((ROOT / "data" / "brand.json").read_text(encoding="utf-8"))["short"]

    scored = [score_page(p, brand_short) for p in pages]
    scored = [s for s in scored if s is not None]
    scored.sort(key=lambda s: s["score"])

    Path(args.out).write_text(json.dumps(scored, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    skipped = len(pages) - len(scored)
    note = f" ({skipped} crawl error(s) skipped)" if skipped else ""
    print(f"Scored {len(scored)} page(s) from {crawl_path.name} -> {args.out}{note}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
