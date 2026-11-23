"""Write app/data.js: the demo data from data/*.json as one JavaScript global,
plus the monitoring settings and the real target for the app's Run page.

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
sys.path.insert(0, str(ROOT))

from monitoring.run import ALL_ENGINES, DEFAULT_ENGINE_CONFIG, estimate_run_cost  # noqa: E402

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


def monitoring_info() -> dict:
    """What the app's Run page shows: the run settings, the estimated cost of
    one call per engine (same estimate run.py prints), and the real target's
    brand, topics and questions, so the run can be planned before any export."""
    settings = json.loads((ROOT / "data" / "monitoring_settings.json").read_text(encoding="utf-8"))
    cfgs = {e: {**DEFAULT_ENGINE_CONFIG[e], **settings["engines"].get(e, {})} for e in ALL_ENGINES}
    per_call = {e: round(estimate_run_cost(1, [e], 1, cfgs)[0].total_usd, 4) for e in ALL_ENGINES}
    info = {
        "schedule": {k: v for k, v in settings["schedule"].items() if k != "_comment"},
        "questions": settings["questions"],
        "runs_per_question": settings["runs_per_question"],
        "variants": settings["variants"]["per_question"] if settings["variants"]["enabled"] else 0,
        "engines": [{"id": e, "model": cfgs[e]["model"], "enabled": bool(cfgs[e]["enabled"]),
                     "usd_per_call": per_call[e]} for e in ALL_ENGINES],
        "budget": {k: v for k, v in settings["budget"].items() if k != "_comment"},
        "github_repo": settings.get("github_repo", ""),
        "target": None,
    }
    target = settings.get("target")
    tdir = ROOT / target if target else None
    if tdir and (tdir / "questions.json").exists():
        # run_list.json is deliberately left out: saving one would then also
        # require rebuilding data.js. The app tracks what it last saved itself.
        def load(name: str):
            return json.loads((tdir / name).read_text(encoding="utf-8"))

        info["target"] = {"path": target, "brand": load("brand.json"), "categories": load("categories.json"),
                          "questions": load("questions.json"), "competitors": load("competitors.json")["names"]}
    return info


def bundle() -> dict:
    data = {key: json.loads((ROOT / "data" / filename).read_text(encoding="utf-8")) for key, filename in SOURCES}
    data["monitoring"] = monitoring_info()
    return data


def render(data: dict) -> str:
    compact = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    header = "/* Built by scripts/build_web_data.py from data/*.json and the monitoring target. Edit those. */"
    return f"{header}\nwindow.GEO_DATA = {compact};\n"


def main() -> int:
    TARGET.write_text(render(bundle()), encoding="utf-8")
    print(f"{TARGET.relative_to(ROOT)}: {TARGET.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
