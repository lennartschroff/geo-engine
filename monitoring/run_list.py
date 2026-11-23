"""Run list: the exact questions a monitoring run asks.

The app's Run page saves run_list.json; put it in the target folder (e.g.
targets/geo-engine/run_list.json) and commit it. While the file exists,
monitoring/run.py asks exactly these questions instead of the settings'
question scope, so questions switched on or added in the app are really
monitored. Delete the file to go back to the settings.

Format:
    {"saved": "2026-11-23",
     "questions": [{"id": "q1", "text": "...", "categories": ["..."]},
                   {"id": "c1a2b3", "text": "...", "categories": ["..."], "custom": true}]}
"""
from __future__ import annotations

import json
from pathlib import Path

FILENAME = "run_list.json"


def load_run_list(target_dir: Path) -> list[dict] | None:
    """Questions from <target_dir>/run_list.json, or None if there is no file.

    Raises ValueError for a file that exists but can't be used, so a broken
    run list fails loudly instead of silently falling back to other questions.
    """
    path = Path(target_dir) / FILENAME
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    questions = data.get("questions") if isinstance(data, dict) else None
    if not isinstance(questions, list) or not questions:
        raise ValueError(f"{path}: expected a non-empty 'questions' list")
    out, seen = [], set()
    for i, q in enumerate(questions):
        if not isinstance(q, dict) or not str(q.get("id", "")).strip() or not str(q.get("text", "")).strip():
            raise ValueError(f"{path}: question {i + 1} needs an 'id' and a 'text'")
        if q["id"] in seen:
            raise ValueError(f"{path}: question id {q['id']!r} appears twice")
        seen.add(q["id"])
        cats = q.get("categories") or []
        out.append({"id": q["id"], "text": q["text"].strip(), "categories": list(cats),
                    "key": bool(q.get("key", False)), "custom": bool(q.get("custom", False))})
    return out
