"""Generates a starter data/questions.json from data/categories.json.

Zero cost, no API key, no crawling — pure template substitution. This is
the on-ramp for a new company adopting the tool: write your own
categories.json (the topic/keyword taxonomy is real domain knowledge that
can't be templated away), then run this to get a full starter question
set instead of hand-writing 50 questions.

Output is deliberately mixed-language (EN/DE), matching the existing
questions.json and README.md's stated design: "the monitored questions
are deliberately mixed-language, because that is how users actually ask."
Language per generated question alternates deterministically (not
randomly), so re-running this script on unchanged input is reproducible.

Usage:
    python scripts/generate_questions.py                                   # overwrite data/questions.json
    python scripts/generate_questions.py --per-category 4 --key-count 15
    python scripts/generate_questions.py --categories my_categories.json --out my_questions.json
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Each entry is (english_template, german_template). {label} is substituted with
# the category's label_en/label_de; {kw} is substituted with the category's
# first keyword as-is (keywords lists already mix languages in categories.json,
# so this is a deliberate simplification, not a translation).
TEMPLATES: list[tuple[str, str]] = [
    ("Which agencies are leading in {label}?", "Welche Agenturen sind führend in {label}?"),
    ("How do I get started with {label}?", "Wie starte ich mit {label}?"),
    ("What is {kw}?", "Was ist {kw}?"),
    ("What are the benefits of {label}?", "Was sind die Vorteile von {label}?"),
    ("How much does {label} typically cost?", "Was kostet {label} normalerweise?"),
    ("Which companies specialize in {kw}?", "Welche Unternehmen sind auf {kw} spezialisiert?"),
]


def generate_for_category(cat: dict, count: int, start_index: int) -> list[dict]:
    kw = cat["keywords"][0] if cat["keywords"] else cat["label_en"]
    out = []
    for i in range(count):
        en_t, de_t = TEMPLATES[(start_index + i) % len(TEMPLATES)]
        # Alternate language by position so a full run isn't all-English then
        # all-German — deterministic (even index -> EN phrasing, odd -> DE),
        # not random, so re-runs on the same input are reproducible.
        if (start_index + i) % 2 == 0:
            text = en_t.format(label=cat["label_en"], kw=kw)
        else:
            text = de_t.format(label=cat["label_de"], kw=kw)
        out.append({"text": text, "categories": [cat["id"]]})
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--categories", default=str(ROOT / "data" / "categories.json"))
    ap.add_argument("--out", default=str(ROOT / "data" / "questions.json"))
    ap.add_argument("--per-category", type=int, default=6, help="Questions to generate per category.")
    ap.add_argument("--key-count", type=int, default=15, help="How many of the generated questions are 'key' (weekly).")
    args = ap.parse_args()

    categories = json.loads(Path(args.categories).read_text(encoding="utf-8"))
    if not categories:
        print("No categories found — nothing to generate.", file=sys.stderr)
        return 1

    raw: list[dict] = []
    for i, cat in enumerate(categories):
        raw.extend(generate_for_category(cat, args.per_category, start_index=i))

    key_count = min(args.key_count, len(raw))
    questions = []
    for nr, q in enumerate(raw, start=1):
        questions.append({
            "id": f"q{nr}",
            "nr": nr,
            "text": q["text"],
            "categories": q["categories"],
            "key": nr <= key_count,
            "schedule": "weekly" if nr <= key_count else "manual",
        })

    Path(args.out).write_text(json.dumps(questions, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"Generated {len(questions)} questions ({key_count} key) from {len(categories)} categories -> {args.out}")
    print("These are templated starters — review and rewrite the phrasing to match how your actual customers ask.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
