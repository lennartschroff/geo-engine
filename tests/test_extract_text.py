"""Tests for scripts/extract_text.py (Library import helper)."""
from __future__ import annotations

import sys
import types
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import extract_text  # noqa: E402

DOC_XML = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Case study</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">We reduced handling time </w:t></w:r><w:r><w:t>by 38 percent.</w:t></w:r></w:p>
<w:p></w:p>
<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>line two</w:t><w:tab/><w:t>tabbed</w:t></w:r></w:p>
</w:body></w:document>"""


def make_docx(path: Path) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml", DOC_XML)
    return path


def test_docx_paragraphs_runs_breaks_and_tabs(tmp_path):
    text = extract_text.extract(make_docx(tmp_path / "c.docx"))
    assert text == "Case study\n\nWe reduced handling time by 38 percent.\n\nLine one\nline two tabbed\n"


def test_cli_writes_txt_next_to_input(tmp_path, monkeypatch, capsys):
    src = make_docx(tmp_path / "case.docx")
    monkeypatch.setattr(sys, "argv", ["extract_text.py", str(src)])
    assert extract_text.main() == 0
    assert (tmp_path / "case.txt").read_text(encoding="utf-8").startswith("Case study")


def test_not_a_zip_is_a_clean_error(tmp_path, monkeypatch):
    bad = tmp_path / "fake.docx"
    bad.write_text("not a zip")
    monkeypatch.setattr(sys, "argv", ["extract_text.py", str(bad)])
    assert extract_text.main() == 1


def test_unsupported_type(tmp_path):
    with pytest.raises(ValueError):
        extract_text.extract(tmp_path / "x.odt")


def test_pdf_without_pypdf_gives_install_hint(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "pypdf", None)  # import fails
    with pytest.raises(RuntimeError, match="pip install pypdf"):
        extract_text.extract(tmp_path / "x.pdf")


def test_pdf_pages_joined_and_broken_lines_mended(tmp_path, monkeypatch):
    # pypdf itself is mocked (optional dependency); this pins our handling of its output.
    pages = [types.SimpleNamespace(extract_text=lambda: "We delivered 140\nprojects in 2025.\nNext sentence."),
             types.SimpleNamespace(extract_text=lambda: ""),
             types.SimpleNamespace(extract_text=lambda: "Page three.")]
    fake = types.ModuleType("pypdf")
    fake.PdfReader = lambda path: types.SimpleNamespace(pages=pages)
    monkeypatch.setitem(sys.modules, "pypdf", fake)
    expected = "We delivered 140 projects in 2025.\nNext sentence.\n\nPage three.\n"
    assert extract_text.extract(tmp_path / "x.pdf") == expected
