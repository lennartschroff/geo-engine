"""Unit tests for scripts/suggest_topics.py."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from suggest_topics import MAX_TOPICS, clean_label, extract_topics  # noqa: E402


def page(h2):
    return {"url": "https://example.com/x", "h2": h2}


class TestCleanLabel:
    def test_strips_question_mark(self):
        assert clean_label("What is RAG?") == "What is RAG"

    def test_strips_surrounding_whitespace(self):
        assert clean_label("  RAG Pipelines  ") == "RAG Pipelines"


class TestExtractTopics:
    def test_extracts_headings_as_topics(self):
        pages = [page(["Retrieval-Augmented Generation", "AI Agent Safety"])]
        topics = extract_topics(pages)
        labels = [t["label"] for t in topics]
        assert "Retrieval-Augmented Generation" in labels
        assert "AI Agent Safety" in labels

    def test_ranks_by_how_many_pages_a_heading_appears_on(self):
        pages = [
            page(["Enterprise AI Adoption", "Other Heading"]),
            page(["Enterprise AI Adoption"]),
            page(["Enterprise AI Adoption"]),
        ]
        topics = extract_topics(pages)
        assert topics[0]["label"] == "Enterprise AI Adoption"

    def test_filters_generic_boilerplate_headings(self):
        pages = [page(["Contact", "Imprint", "Privacy Policy", "Model Evaluation Services"])]
        labels = [t["label"] for t in extract_topics(pages)]
        assert "Contact" not in labels
        assert "Imprint" not in labels
        assert "Privacy Policy" not in labels
        assert "Model Evaluation Services" in labels

    def test_filters_single_word_headings(self):
        pages = [page(["Pricing", "AI Agent Workshops"])]
        labels = [t["label"] for t in extract_topics(pages)]
        assert "Pricing" not in labels
        assert "AI Agent Workshops" in labels

    def test_skips_pages_with_crawl_errors(self):
        pages = [{"url": "x", "error": "timeout"}]
        assert extract_topics(pages) == []

    def test_deduplicates_a_heading_repeated_within_one_page(self):
        pages = [page(["Enterprise AI Adoption", "Enterprise AI Adoption"])]
        topics = extract_topics(pages)
        matches = [t for t in topics if t["label"] == "Enterprise AI Adoption"]
        assert len(matches) == 1

    def test_caps_at_max_topics(self):
        pages = [page([f"Unique Topic Heading {i}" for i in range(MAX_TOPICS + 10)])]
        assert len(extract_topics(pages)) == MAX_TOPICS

    def test_each_topic_has_a_lowercase_keyword(self):
        pages = [page(["Model Evaluation Services"])]
        topics = extract_topics(pages)
        assert topics[0]["keywords"] == ["model evaluation services"]

    def test_empty_pages_list_returns_empty(self):
        assert extract_topics([]) == []
