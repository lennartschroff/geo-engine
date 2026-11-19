"""Unit tests for scripts/generate_questions.py."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from generate_questions import TEMPLATES, generate_for_category  # noqa: E402

CATEGORY = {
    "id": "hp",
    "label_de": "Wärmepumpen",
    "label_en": "Heat pumps",
    "keywords": ["heat pumps", "air source"],
}

CATEGORY_NO_KEYWORDS = {"id": "x", "label_de": "X-Thema", "label_en": "X topic", "keywords": []}


class TestGenerateForCategory:
    def test_generates_requested_count(self):
        out = generate_for_category(CATEGORY, count=4, start_index=0)
        assert len(out) == 4

    def test_every_question_tagged_with_the_category_id(self):
        out = generate_for_category(CATEGORY, count=3, start_index=0)
        assert all(q["categories"] == ["hp"] for q in out)

    def test_alternates_language_by_position(self):
        out = generate_for_category(CATEGORY, count=4, start_index=0)
        # even start_index+i -> English template, odd -> German template.
        assert "Heat pumps" in out[0]["text"] or "heat pumps" in out[0]["text"]
        assert "Wärmepumpen" in out[1]["text"]  # German label capitalization

    def test_is_deterministic_across_repeated_calls(self):
        a = generate_for_category(CATEGORY, count=6, start_index=0)
        b = generate_for_category(CATEGORY, count=6, start_index=0)
        assert a == b

    def test_wraps_around_template_list_for_large_counts(self):
        out = generate_for_category(CATEGORY, count=len(TEMPLATES) + 2, start_index=0)
        assert len(out) == len(TEMPLATES) + 2
        # No crash / no index error wrapping past the template list.

    def test_falls_back_to_label_when_no_keywords(self):
        out = generate_for_category(CATEGORY_NO_KEYWORDS, count=1, start_index=2)  # index 2 -> "What is {kw}?" (EN)
        assert "X topic" in out[0]["text"]

    def test_start_index_shifts_which_templates_are_used(self):
        a = generate_for_category(CATEGORY, count=1, start_index=0)
        b = generate_for_category(CATEGORY, count=1, start_index=1)
        assert a[0]["text"] != b[0]["text"]
