"""Write app/data.js: the demo data from data/*.json as one JavaScript global.

Why a script file instead of fetching JSON at runtime: the app's Content
Security Policy forbids every network request (connect-src 'none'), and a
<script src> also works when index.html is opened directly from disk.

    python scripts/build_web_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# key in window.GEO_DATA -> source file in data/
SOURCES = (
    ("brand", "brand.json"),
    ("categories", "categories.json"),
    ("questions", "questions.json"),
    ("blocks", "blocks.json"),
    ("audit", "audit_actions.json"),
    ("pages", "page_scores.json"),
    ("demo", "demo_monitoring.json"),
)
TARGET = ROOT / "app" / "data.js"


def bundle() -> dict:
    return {key: json.loads((ROOT / "data" / filename).read_text(encoding="utf-8")) for key, filename in SOURCES}


def render(data: dict) -> str:
    compact = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return "/* Built by scripts/build_web_data.py from data/*.json. Edit those files, not this one. */\n" \
           f"window.GEO_DATA = {compact};\n"


def main() -> int:
    TARGET.write_text(render(bundle()), encoding="utf-8")
    print(f"{TARGET.relative_to(ROOT)}: {TARGET.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
