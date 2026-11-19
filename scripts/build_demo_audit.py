"""Builds the demo's website audit from an invented crawl (no real website involved).

Input:  data/demo_site/crawl.json -- a hand-written crawl of the fictional
        contoso-ai.example site (pages + site-level checks).
Output: data/page_scores.json and data/audit_actions.json, produced by the
        same scoring code that handles a real crawl (score_pages.score_page,
        audit_findings.build_findings).

Usage:
    python scripts/build_demo_audit.py
    python scripts/build_web_data.py      # then rebuild app/data.js
"""
from __future__ import annotations

import datetime
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from audit_findings import build_findings  # noqa: E402
from score_pages import score_page  # noqa: E402


def main() -> int:
    site = json.loads((ROOT / "data" / "demo_site" / "crawl.json").read_text(encoding="utf-8"))
    brand_short = json.loads((ROOT / "data" / "brand.json").read_text(encoding="utf-8"))["short"]
    scored = []
    for page in site["pages"]:
        s = score_page(page, brand_short)
        s["en"] = page["title"].split(" | ")[0]
        s["de"] = page["title_de"]
        scored.append(s)
    scored.sort(key=lambda s: s["score"])
    findings = build_findings(site["pages"], site, datetime.date.fromisoformat(site["date"]))
    for name, payload in (("page_scores.json", scored), ("audit_actions.json", findings)):
        text = json.dumps(payload, ensure_ascii=False, indent=1) + "\n"
        (ROOT / "data" / name).write_text(text, encoding="utf-8")
    print(f"{len(scored)} page scores, {len(findings)} findings from the invented demo crawl")
    return 0


if __name__ == "__main__":
    sys.exit(main())
