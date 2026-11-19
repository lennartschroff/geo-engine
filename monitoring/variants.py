"""Randomized rephrasings of a tracked question (zero cost, no LLM call).

Real users never type the exact tracked wording, and engine answers are
sensitive to phrasing. Asking one random variant next to the original each
run shows whether visibility holds up beyond one fixed prompt.

Variants are built from small hand-written templates: a framing sentence
(how a real user might lead in) plus optional synonym swaps. They keep the
meaning of the question and never add brand names or "please name
providers" style nudges, which would inflate the mention rate.

The variant text is stored with each result (runs.question_text), so any
answer can be traced back to the exact prompt that produced it.
"""
from __future__ import annotations

import random
import re

FRAMES = {
    "en": [
        "I'm looking into this for my company: {q}",
        "Can you help me with this? {q}",
        "Quick question: {q}",
        "My team needs advice on this. {q}",
        "{q} I'd like a short, practical answer.",
        "{q} What would you recommend?",
    ],
    "de": [
        "Ich recherchiere das gerade für mein Unternehmen: {q}",
        "Kannst du mir dabei helfen? {q}",
        "Kurze Frage: {q}",
        "Mein Team braucht dazu eine Einschätzung. {q}",
        "{q} Ich hätte gern eine kurze, praxisnahe Antwort.",
        "{q} Was würdest du empfehlen?",
    ],
}

# (pattern, replacement) pairs, applied each with 50% probability. Whole
# words only, meaning-preserving.
SYNONYMS = {
    "en": [
        (r"\bbest\b", "top"),
        (r"\bTop\b", "Leading"),
        (r"\bfirms\b", "companies"),
        (r"\bconsultancies\b", "consulting firms"),
        (r"\bagencies\b", "service providers"),
        (r"\bHow to\b", "What's the best way to"),
    ],
    "de": [
        (r"\bBeratungen\b", "Beratungsfirmen"),
        (r"\bAnbieter\b", "Dienstleister"),
        (r"\bGute\b", "Empfehlenswerte"),
        (r"\bführend\b", "am stärksten"),
    ],
}


def _as_sentence(text: str) -> str:
    """Search-style prompts ("Top LLM consulting firms in the US") get a
    question mark so they read naturally inside a framing sentence."""
    text = text.strip()
    return text if text[-1:] in "?.!" else text + "?"


def make_variant(text: str, language: str, rng: random.Random) -> str:
    lang = language if language in FRAMES else "en"
    q = text.strip()
    for pattern, repl in SYNONYMS[lang]:
        if rng.random() < 0.5:
            q = re.sub(pattern, repl, q)
    frame = rng.choice(FRAMES[lang])
    if not frame.startswith("{q}") and q[:1].isupper() and not re.match(r"[A-Z]{2,}", q):
        # Mid-sentence after a lead-in, lower-case the first letter (but keep
        # acronyms like "RAG-Anbieter" and German nouns, which stay capitalized).
        if lang == "en":
            q = q[0].lower() + q[1:]
    return frame.format(q=_as_sentence(q))


def make_variants(text: str, language: str, count: int, rng: random.Random | None = None) -> list[str]:
    """Up to `count` distinct variants, none identical to the original."""
    rng = rng or random.Random()
    seen = {text.strip()}
    out: list[str] = []
    for _ in range(count * 20):  # bounded retries; the template space is small
        if len(out) >= count:
            break
        v = make_variant(text, language, rng)
        if v not in seen:
            seen.add(v)
            out.append(v)
    return out
