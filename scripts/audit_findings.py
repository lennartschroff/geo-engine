"""Turn a real site crawl into prioritized audit findings (TASKS.md F3b).

Reads the newest data/crawl-<date>.json and data/site-checks-<date>.json that
scripts/audit_crawl.py writes, and produces a list in the same shape as
data/audit_actions.json (id, priority, effort, status, en/de [title, finding,
action]). Load it in the app: Improve -> Website -> "Load file".

Every finding is computed from the crawl -- counts and example URLs, never
guessed facts about the company. Checks that need data the crawl doesn't
collect (e.g. consistency of company data on third-party sites) are left out
rather than invented. Priority/effort are a stated heuristic.

Usage:
    python scripts/audit_crawl.py --base https://www.example.com
    python scripts/audit_findings.py            # newest crawl + site checks in data/
    python scripts/audit_findings.py --crawl data/crawl-2026-11-16.json --checks data/site-checks-2026-11-16.json
"""
from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

TRAINING_BOTS = {"GPTBot", "ClaudeBot"}
ANSWER_BOTS = {"OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Googlebot"}
ORG_TYPES = {"Organization", "Corporation", "LocalBusiness", "ProfessionalService", "NGO"}
THIN_WORDS = 300  # [placeholder] heuristic, same spirit as score_pages.py's WORDS_THRESHOLD
STALE_YEARS = 3


def newest(pattern: str) -> Path | None:
    found = sorted((ROOT / "data").glob(pattern))
    return found[-1] if found else None


def examples(urls: list[str], n: int = 3) -> str:
    shown = ", ".join(urls[:n])
    return shown + (f" (+{len(urls) - n})" if len(urls) > n else "")


def robots_blocked_bots(robots_txt: str, bots: set[str]) -> list[str]:
    """Bots that robots.txt fully disallows (a 'Disallow: /' in a group naming them)."""
    blocked: set[str] = set()
    agents: list[str] = []
    in_rules = False
    for raw in robots_txt.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line or ":" not in line:
            continue
        key, _, value = line.partition(":")
        key, value = key.strip().lower(), value.strip()
        if key == "user-agent":
            if in_rules:
                agents, in_rules = [], False
            agents.append(value)
        elif key in ("disallow", "allow"):
            in_rules = True
            if key == "disallow" and value == "/":
                for a in agents:
                    blocked |= {b for b in bots if a.lower() == b.lower()}
    return sorted(blocked)


def finding(fid, priority, effort, en, de):
    return {"id": fid, "priority": priority, "effort": effort, "status": "open", "en": en, "de": de}


def build_findings(pages: list[dict], checks: dict | None, today: datetime.date) -> list[dict]:
    ok = [p for p in pages if "error" not in p and p.get("status", 200) < 400]
    broken = [p["url"] for p in pages if "error" in p or p.get("status", 200) >= 400]
    out: list[dict] = []

    if checks:
        access = checks.get("crawler_access", {})
        denied = sorted(b for b, code in access.items() if code in (401, 403, 429) or code >= 500)
        answer_denied = [b for b in denied if b in ANSWER_BOTS]
        training_denied = [b for b in denied if b in TRAINING_BOTS]
        if answer_denied:
            out.append(finding("f-bots-answer", "high", "low",
                ["AI search crawlers are blocked",
                 f"These crawlers get an error response from the server: {', '.join(answer_denied)}. They fetch pages "
                 "live for answers with web search, so blocked pages can't be cited.",
                 "Check the server, CDN or security plugin rules for these user agents and allow them."],
                ["KI-Such-Crawler werden blockiert",
                 f"Diese Crawler erhalten eine Fehlerantwort vom Server: {', '.join(answer_denied)}. Sie rufen Seiten "
                 "live für Antworten mit Websuche ab; blockierte Seiten können nicht zitiert werden.",
                 "Regeln in Server, CDN oder Sicherheits-Plugin für diese User-Agents prüfen und freigeben."]))
        if training_denied:
            out.append(finding("f-bots-training", "mid", "low",
                ["AI training crawlers are blocked",
                 f"{', '.join(training_denied)} get an error response. This mainly affects the models' base "
                 "knowledge, less so answers with web search.",
                 "Decide whether this is intentional. If not, remove the blocking rule."],
                ["KI-Trainings-Crawler werden blockiert",
                 f"{', '.join(training_denied)} erhalten eine Fehlerantwort. Das betrifft vor allem das Grundwissen "
                 "der Modelle, weniger Antworten mit Websuche.",
                 "Entscheiden, ob das gewollt ist. Falls nicht, die Sperre entfernen."]))
        robots_blocked = robots_blocked_bots(checks.get("robots_txt", ""), TRAINING_BOTS | ANSWER_BOTS)
        if robots_blocked:
            out.append(finding("f-robots", "high", "low",
                ["robots.txt shuts out AI crawlers",
                 f"robots.txt disallows the whole site for: {', '.join(robots_blocked)}.",
                 "Remove or narrow the 'Disallow: /' rules for crawlers you want to be cited by."],
                ["robots.txt sperrt KI-Crawler aus",
                 f"Die robots.txt sperrt die ganze Website für: {', '.join(robots_blocked)}.",
                 "'Disallow: /'-Regeln für Crawler entfernen oder einschränken, von denen man zitiert werden will."]))
        llms = checks.get("llms_txt_status")
        if llms != 200:
            out.append(finding("f-llms", "low", "low",
                ["No llms.txt",
                 f"/llms.txt returns HTTP {llms}. It's an emerging convention, not a standard, "
                 "and engines don't reliably use it yet.",
                 "Optional: publish a short llms.txt that lists your most important pages."],
                ["Keine llms.txt",
                 f"/llms.txt liefert HTTP {llms}. Das ist eine junge Konvention, kein Standard; "
                 "Engines nutzen sie noch nicht verlässlich.",
                 "Optional: eine kurze llms.txt mit den wichtigsten Seiten veröffentlichen."]))

    if not ok:
        return out

    if not any(ORG_TYPES & set(p.get("schema_types", [])) for p in ok):
        out.append(finding("f-org-schema", "high", "low",
            ["No organization schema",
             f"None of the {len(ok)} crawled pages has Organization structured data (JSON-LD).",
             "Add Organization JSON-LD to the home page: name, url, logo, description, foundingDate, address, "
             "sameAs (profiles), knowsAbout (core topics)."],
            ["Kein Organisations-Schema",
             f"Keine der {len(ok)} gecrawlten Seiten hat strukturierte Organisationsdaten (JSON-LD).",
             "Organization-JSON-LD auf der Startseite ergänzen: name, url, logo, description, foundingDate, address, "
             "sameAs (Profile), knowsAbout (Kernthemen)."]))

    faq_pages = [p["url"] for p in ok if "FAQPage" in p.get("schema_types", [])]
    q_pages = [p["url"] for p in ok if p.get("question_headings", 0) >= 2]
    if not faq_pages:
        out.append(finding("f-faq", "high", "mid",
            ["No FAQ structures",
             f"No page has FAQPage schema; {len(q_pages)} of {len(ok)} pages use at least two question headings.",
             "Add question-and-answer sections to the pages for your key topics and mark them up as FAQPage."],
            ["Keine FAQ-Strukturen",
             f"Keine Seite hat FAQPage-Schema; {len(q_pages)} von {len(ok)} Seiten nutzen mindestens zwei "
             "Frage-Überschriften.",
             "Frage-Antwort-Abschnitte auf den Seiten zu den Kernthemen ergänzen und als FAQPage auszeichnen."]))

    no_h1 = [p["url"] for p in ok if not p.get("h1")]
    if no_h1:
        out.append(finding("f-h1", "mid", "low",
            ["Pages without a main heading",
             f"{len(no_h1)} of {len(ok)} pages have no H1, e.g. {examples(no_h1)}.",
             "Give every page one H1 that states its topic plainly."],
            ["Seiten ohne Hauptüberschrift",
             f"{len(no_h1)} von {len(ok)} Seiten haben keine H1, z. B. {examples(no_h1)}.",
             "Jeder Seite genau eine H1 geben, die das Thema klar benennt."]))

    relative = [p for p in ok if p.get("relative_time")]
    if relative:
        phrases = '", "'.join(sorted({t for p in relative for t in p["relative_time"]})[:3])
        out.append(finding("f-relative-time", "mid", "low",
            ["Relative time statements go stale",
             f"{len(relative)} pages use phrases like \"{phrases}\", e.g. "
             f"{examples([p['url'] for p in relative])}.",
             "Replace them with fixed years (\"since 2011\")."],
            ["Relative Zeitangaben veralten",
             f"{len(relative)} Seiten verwenden Formulierungen wie \"{phrases}\", z. B. "
             f"{examples([p['url'] for p in relative])}.",
             "Durch feste Jahreszahlen ersetzen (\"seit 2011\")."]))

    no_figures = [p["url"] for p in ok if p.get("figures", 0) == 0]
    if len(no_figures) * 2 > len(ok):
        out.append(finding("f-figures", "mid", "mid",
            ["Few citable figures",
             f"{len(no_figures)} of {len(ok)} pages contain no figures at all. Concrete numbers are among the "
             "statements engines quote most readily.",
             "Add verified figures (projects, years, results) to the core pages, with their source."],
            ["Wenige zitierfähige Zahlen",
             f"{len(no_figures)} von {len(ok)} Seiten enthalten gar keine Zahlen. Konkrete Zahlen gehören zu den "
             "Aussagen, die Engines am ehesten übernehmen.",
             "Belegte Zahlen (Projekte, Jahre, Ergebnisse) mit Quelle auf den Kernseiten ergänzen."]))

    thin = [p["url"] for p in ok if p.get("words", 0) < THIN_WORDS]
    if thin:
        out.append(finding("f-thin", "low", "mid",
            ["Thin pages",
             f"{len(thin)} pages have fewer than {THIN_WORDS} words of main content, e.g. {examples(thin)}.",
             "Merge or expand pages that should rank for a topic; leave pure utility pages alone."],
            ["Dünne Seiten",
             f"{len(thin)} Seiten haben weniger als {THIN_WORDS} Wörter Hauptinhalt, z. B. {examples(thin)}.",
             "Seiten, die zu einem Thema gefunden werden sollen, zusammenlegen oder ausbauen; reine "
             "Service-Seiten so lassen."]))

    no_desc = [p["url"] for p in ok if not p.get("meta_description")]
    if no_desc:
        out.append(finding("f-meta", "low", "low",
            ["Missing meta descriptions",
             f"{len(no_desc)} of {len(ok)} pages have no meta description, e.g. {examples(no_desc)}.",
             "Write a one-sentence summary for each page; engines and search results use it as a snippet."],
            ["Fehlende Meta-Beschreibungen",
             f"{len(no_desc)} von {len(ok)} Seiten haben keine Meta-Beschreibung, z. B. {examples(no_desc)}.",
             "Für jede Seite eine Ein-Satz-Zusammenfassung schreiben; Engines und Suchergebnisse nutzen sie als "
             "Auszug."]))

    cutoff = today.replace(year=today.year - STALE_YEARS)
    stale = []
    for p in ok:
        dates = [d for d in (p.get("modified"), p.get("published")) if d and re.match(r"\d{4}-\d{2}-\d{2}", d)]
        if dates and max(datetime.date.fromisoformat(d[:10]) for d in dates) < cutoff:
            stale.append(p["url"])
    if stale:
        out.append(finding("f-stale", "low", "high",
            ["Outdated articles",
             f"{len(stale)} articles were last published or updated before {cutoff.year}, e.g. {examples(stale)}.",
             "Update the ones about current topics (with a visible date), redirect or retire the rest."],
            ["Veraltete Beiträge",
             f"{len(stale)} Beiträge wurden zuletzt vor {cutoff.year} veröffentlicht oder aktualisiert, "
             f"z. B. {examples(stale)}.",
             "Beiträge zu aktuellen Themen überarbeiten (mit sichtbarem Datum), den Rest umleiten oder entfernen."]))

    if broken:
        out.append(finding("f-broken", "mid", "low",
            ["Pages that fail to load",
             f"{len(broken)} URLs from the sitemap returned an error, e.g. {examples(broken)}.",
             "Fix or remove them from the sitemap."],
            ["Seiten, die nicht laden",
             f"{len(broken)} URLs aus der Sitemap lieferten einen Fehler, z. B. {examples(broken)}.",
             "Reparieren oder aus der Sitemap entfernen."]))

    order = {"high": 0, "mid": 1, "low": 2}
    out.sort(key=lambda f: order[f["priority"]])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--crawl", help="crawl-<date>.json from audit_crawl.py. Default: newest in data/.")
    ap.add_argument("--checks", help="site-checks-<date>.json from audit_crawl.py. Default: newest in data/.")
    ap.add_argument("--out", default=str(ROOT / "output" / "website" / "audit_findings.json"))
    args = ap.parse_args()

    crawl = Path(args.crawl) if args.crawl else newest("crawl-*.json")
    if not crawl or not crawl.exists():
        print("No crawl found. Run scripts/audit_crawl.py --base https://yoursite.com first.", file=sys.stderr)
        return 1
    checks_path = Path(args.checks) if args.checks else newest("site-checks-*.json")
    checks = json.loads(checks_path.read_text(encoding="utf-8")) if checks_path and checks_path.exists() else None
    if checks is None:
        print("[no site-checks file found -- crawler access, robots.txt and llms.txt checks are skipped]")

    pages = json.loads(crawl.read_text(encoding="utf-8"))
    findings = build_findings(pages, checks, datetime.date.today())
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(findings, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{len(findings)} finding(s) from {crawl.name} -> {out}")
    print("Load it in the app: Improve -> Website -> 'Load file'.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
