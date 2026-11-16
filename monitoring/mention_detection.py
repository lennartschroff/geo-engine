"""Pure logic for detecting brand mentions in an engine's answer text.

No network access, no API keys — this is the part of the monitoring
pipeline (ROADMAP.md Milestone 1) that doesn't depend on which provider
you pick or what it costs, so it's built and tested independently of
that decision.

Given an answer's free text plus the list of "named providers" an answer
might mention (the brand's own aliases, from data/brand.json, plus known
competitor names), this module answers:

  - is the brand mentioned at all, and how (as a bare name, or with a link)?
  - what rank did it get among the providers the answer actually named,
    in order of first mention?
  - which domains did the answer cite, normalized so the same source
    isn't counted twice as "example.com" and "www.example.com/page"?
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from urllib.parse import urlparse

_WORD_CHARS = re.compile(r"[^\w]+", re.UNICODE)


def _normalize(name: str) -> str:
    """Lowercase, collapse whitespace/punctuation, for loose name matching."""
    return _WORD_CHARS.sub(" ", name.lower()).strip()


def find_first_mention(text: str, name: str) -> int | None:
    """Character index of the first mention of `name` in `text`, or None.

    Matches on a normalized form of both sides, so "Tailspin-Robotics"
    and "tailspin robotics" are treated as the same mention — _normalize()
    already collapses hyphens and whitespace to single spaces on both the
    name and the text, so a plain escaped match on the normalized forms is
    enough. Word-boundary anchors still apply to the normalized text, so
    "Tailspin" won't match inside an unrelated longer word.
    """
    normalized_name = _normalize(name)
    if not normalized_name:
        return None
    pattern = re.escape(normalized_name)
    norm_text = _normalize(text)
    m = re.search(r"(?<!\w)" + pattern + r"(?!\w)", norm_text)
    return m.start() if m else None


@dataclass
class MentionResult:
    mentioned: bool
    position: int | None  # 1-based rank among all providers mentioned, by first occurrence
    providers_mentioned: list[str] = field(default_factory=list)  # in order of first mention


def detect_mention(answer_text: str, brand_aliases: list[str], competitor_names: list[str]) -> MentionResult:
    """Detects whether the brand is mentioned and its rank among named providers.

    `brand_aliases` are tried in order; the brand counts as mentioned if any
    alias matches. Rank is 1-based position among *all* providers (brand +
    competitors) by first-mention order in the text — matching the c<n>/m<n>
    encoding already used in data/demo_monitoring.json.
    """
    candidates: dict[str, int] = {}

    brand_hit = None
    for alias in brand_aliases:
        idx = find_first_mention(answer_text, alias)
        if idx is not None and (brand_hit is None or idx < brand_hit):
            brand_hit = idx
    if brand_hit is not None:
        candidates["__brand__"] = brand_hit

    for name in competitor_names:
        idx = find_first_mention(answer_text, name)
        if idx is not None:
            candidates[name] = idx

    ordered = sorted(candidates.items(), key=lambda kv: kv[1])
    providers_mentioned = [name for name, _ in ordered]

    if "__brand__" not in candidates:
        return MentionResult(mentioned=False, position=None, providers_mentioned=providers_mentioned)

    rank = providers_mentioned.index("__brand__") + 1
    providers_mentioned = [n if n != "__brand__" else "(brand)" for n in providers_mentioned]
    return MentionResult(mentioned=True, position=rank, providers_mentioned=providers_mentioned)


def normalize_domain(url: str) -> str:
    """Normalizes a URL to a bare, lowercase domain without 'www.'.

    'https://www.Example.com/some/page?x=1' and 'http://example.com/' both
    normalize to 'example.com', so citation counts aren't split across
    cosmetic variants of the same source.
    """
    parsed = urlparse(url if "//" in url else "//" + url)
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host


def normalize_domains(urls: list[str]) -> list[str]:
    """Normalizes a list of URLs to deduplicated bare domains, order preserved."""
    seen: dict[str, None] = {}
    for url in urls:
        domain = normalize_domain(url)
        if domain:
            seen.setdefault(domain, None)
    return list(seen.keys())
