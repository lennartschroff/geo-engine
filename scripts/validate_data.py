"""Validate data/*.json against schemas/*.schema.json, plus cross-file references.

JSON Schema catches shape errors (wrong type, missing field, bad enum value).
It can't catch "this category id doesn't exist" across files, so a second pass
checks those foreign-key-like references explicitly.

Usage:
    python scripts/validate_data.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from jsonschema import Draft7Validator

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monitoring.run_list import FILENAME as RUN_LIST_FILE  # noqa: E402
from monitoring.run_list import load_run_list  # noqa: E402

DATA = ROOT / "data"
SCHEMAS = ROOT / "schemas"

FILES = {
    "brand": "brand.json",
    "competitors": "competitors.json",
    "categories": "categories.json",
    "questions": "questions.json",
    "blocks": "blocks.json",
    "audit_actions": "audit_actions.json",
    "page_scores": "page_scores.json",
    "demo_monitoring": "demo_monitoring.json",
    "monitoring_settings": "monitoring_settings.json",
}


def load(name: str):
    return json.loads((DATA / FILES[name]).read_text(encoding="utf-8"))


def schema_errors() -> list[str]:
    errors = []
    for key, filename in FILES.items():
        schema_path = SCHEMAS / f"{key}.schema.json"
        if not schema_path.exists():
            errors.append(f"{filename}: no schema at {schema_path.relative_to(ROOT)}")
            continue
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        instance = load(key)
        validator = Draft7Validator(schema)
        for err in validator.iter_errors(instance):
            path = "/".join(str(p) for p in err.absolute_path)
            errors.append(f"{filename}{'/' + path if path else ''}: {err.message}")
    return errors


def reference_errors() -> list[str]:
    errors = []
    categories = {c["id"] for c in load("categories")}
    questions = load("questions")
    blocks = load("blocks")
    demo = load("demo_monitoring")
    brand = load("brand")
    competitors = load("competitors")
    question_ids = {q["id"] for q in questions}

    brand_aliases_lower = {a.lower() for a in brand["aliases"]}
    overlap = {n for n in competitors["names"] if n.lower() in brand_aliases_lower}
    if overlap:
        errors.append(
            f"competitors.json/names: {sorted(overlap)} also appear in brand.json's aliases — "
            "mention_detection would double-count the brand as its own competitor"
        )

    for q in questions:
        unknown = set(q["categories"]) - categories
        if unknown:
            errors.append(f"questions.json/{q['id']}: unknown category id(s) {sorted(unknown)}")

    for b in blocks:
        unknown = set(b["categories"]) - categories
        if unknown:
            errors.append(f"blocks.json/{b['id']}: unknown category id(s) {sorted(unknown)}")

    for qid in demo.get("results", {}):
        if qid not in question_ids:
            errors.append(f"demo_monitoring.json/results/{qid}: no matching question id in questions.json")

    key_ids = {q["id"] for q in questions if q.get("key")}
    result_ids = set(demo.get("results", {}))
    missing_key_results = key_ids - result_ids
    if missing_key_results:
        errors.append(
            f"demo_monitoring.json/results: missing demo result(s) for key question(s) {sorted(missing_key_results)}"
        )

    for cand in demo.get("radar", {}).get("candidates", []):
        refs = set(cand.get("questions", [])) | ({cand["closest_question"]} if cand.get("closest_question") else set())
        unknown = refs - question_ids
        if unknown:
            errors.append(f"demo_monitoring.json/radar/{cand['id']}: unknown question id(s) {sorted(unknown)}")
        if cand.get("category") and cand["category"] not in categories:
            errors.append(f"demo_monitoring.json/radar/{cand['id']}: unknown category {cand['category']!r}")

    for piece in demo.get("pieces", []):
        unknown = set(piece.get("qs", [])) - question_ids
        if unknown:
            errors.append(f"demo_monitoring.json/pieces/{piece.get('mark')}: unknown question id(s) {sorted(unknown)}")

    return errors


TARGET_FILES = ["brand", "competitors", "categories", "questions"]


def target_errors() -> list[str]:
    """Real monitoring targets (targets/<name>/): same schemas, plus references."""
    errors = []
    for tdir in sorted(p for p in (ROOT / "targets").glob("*") if p.is_dir()):
        rel = tdir.relative_to(ROOT)
        loaded = {}
        for key in TARGET_FILES:
            path = tdir / FILES[key]
            if not path.exists():
                errors.append(f"{rel}/{FILES[key]}: missing")
                continue
            loaded[key] = json.loads(path.read_text(encoding="utf-8"))
            schema = json.loads((SCHEMAS / f"{key}.schema.json").read_text(encoding="utf-8"))
            for err in Draft7Validator(schema).iter_errors(loaded[key]):
                where = "/".join(str(x) for x in err.absolute_path)
                errors.append(f"{rel}/{FILES[key]}{'/' + where if where else ''}: {err.message}")
        if len(loaded) < len(TARGET_FILES):
            continue
        cats = {c["id"] for c in loaded["categories"]}
        for q in loaded["questions"]:
            unknown = set(q["categories"]) - cats
            if unknown:
                errors.append(f"{rel}/questions.json/{q['id']}: unknown category id(s) {sorted(unknown)}")
        # Optional run list saved from the app's Run page (monitoring/run_list.py).
        try:
            run_list = load_run_list(tdir)
        except (ValueError, json.JSONDecodeError) as e:
            errors.append(f"{rel}/{RUN_LIST_FILE}: {e}")
            run_list = None
        for q in run_list or []:
            unknown = set(q["categories"]) - cats
            if unknown:
                errors.append(f"{rel}/{RUN_LIST_FILE}/{q['id']}: unknown category id(s) {sorted(unknown)}")
        aliases = {a.lower() for a in loaded["brand"]["aliases"]}
        overlap = {n for n in loaded["competitors"]["names"] if n.lower() in aliases}
        if overlap:
            errors.append(f"{rel}/competitors.json: {sorted(overlap)} are also brand aliases")
        errors += radar_errors(tdir, rel, aliases)
    return errors


def radar_errors(tdir: Path, rel: Path, aliases: set[str]) -> list[str]:
    """Optional Question Radar settings (radar.json). Terms are sent to public
    search APIs, so the brand's own name must not be among them."""
    path = tdir / "radar.json"
    if not path.exists():
        return []
    radar = json.loads(path.read_text(encoding="utf-8"))
    schema = json.loads((SCHEMAS / "radar.schema.json").read_text(encoding="utf-8"))
    errors = []
    for err in Draft7Validator(schema).iter_errors(radar):
        where = "/".join(str(x) for x in err.absolute_path)
        errors.append(f"{rel}/radar.json{'/' + where if where else ''}: {err.message}")
    brand_terms = sorted(t for t in radar.get("terms", []) if isinstance(t, str) and t.lower() in aliases)
    if brand_terms:
        errors.append(f"{rel}/radar.json/terms: {brand_terms} are brand aliases; use topic terms instead")
    return errors


def main() -> int:
    errors = schema_errors() + reference_errors() + target_errors()
    if errors:
        print(f"{len(errors)} data validation error(s):\n")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("All data files valid: schema + cross-file references OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
