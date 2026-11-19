"""Turn a .docx or .pdf into plain text for the Library import.

The app reads .txt/.md/.html directly in the browser (Library -> "Import
from your own content"). Word and PDF files need parsing the app can't do
without extra libraries, so this runs locally and writes a .txt you then load
there. Nothing is uploaded anywhere.

- .docx: standard library only (a .docx is a zip of XML). Paragraphs are kept.
- .pdf:  needs the optional `pypdf` package (pip install pypdf==6.21.4). Not in
         requirements.txt, because nothing else in the project needs it.

Usage:
    python scripts/extract_text.py case-study.docx            # -> case-study.txt next to it
    python scripts/extract_text.py talk.pdf --out talk.txt
"""
from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_text(path: Path) -> str:
    """Paragraph text from word/document.xml, one blank line between paragraphs.
    Tabs and line breaks inside a paragraph become spaces/newlines."""
    with zipfile.ZipFile(path) as z:
        root = ElementTree.fromstring(z.read("word/document.xml"))
    paras = []
    for p in root.iter(f"{W}p"):
        parts = []
        for node in p.iter():
            if node.tag == f"{W}t" and node.text:
                parts.append(node.text)
            elif node.tag == f"{W}tab":
                parts.append(" ")
            elif node.tag in (f"{W}br", f"{W}cr"):
                parts.append("\n")
        text = "".join(parts).strip()
        if text:
            paras.append(text)
    return "\n\n".join(paras) + "\n"


def pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise RuntimeError("Reading PDFs needs the optional 'pypdf' package: pip install pypdf==6.21.4") from e
    pages = [(page.extract_text() or "") for page in PdfReader(str(path)).pages]
    text = "\n\n".join(p.strip() for p in pages if p.strip())
    # PDF text often breaks lines mid-sentence; join lines that don't end a sentence.
    text = re.sub(r"(?<![.!?:\n])\n(?!\n)", " ", text)
    return text + "\n"


def extract(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".docx":
        return docx_text(path)
    if suffix == ".pdf":
        return pdf_text(path)
    raise ValueError(f"Unsupported file type {suffix!r}. Use .docx or .pdf (load .txt/.md/.html in the app directly).")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help=".docx or .pdf file")
    ap.add_argument("--out", help="Output .txt path. Default: same name, .txt, next to the input.")
    args = ap.parse_args()
    src = Path(args.file)
    if not src.exists():
        print(f"No such file: {src}", file=sys.stderr)
        return 1
    try:
        text = extract(src)
    except (RuntimeError, ValueError, zipfile.BadZipFile, KeyError) as e:
        print(f"Could not read {src.name}: {e}", file=sys.stderr)
        return 1
    out = Path(args.out) if args.out else src.with_suffix(".txt")
    out.write_text(text, encoding="utf-8")
    print(f"Wrote {len(text.split())} words to {out}")
    print("Load it in the app: Improve -> Library -> 'Import from your own content'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
