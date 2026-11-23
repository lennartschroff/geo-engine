"""Monitoring CLI (ROADMAP.md Milestone 1).

Sends the tracked questions (plus optional randomized variants, see
monitoring/variants.py) to each engine, detects brand mentions, and writes
one row per (question, variant, engine, run) to SQLite.

Defaults come from data/monitoring_settings.json (engines, models, runs per
question, variants, budget caps); CLI flags override them for one run.
All three engines are implemented: "claude" (Anthropic web search), "gpt"
(OpenAI Responses API web_search tool) and "gemini" (plain generation by
default; Google Search grounding is opt-in because it needs a billed
account). Keys are read from a local .env or the environment -- never
shared, never sent anywhere but each provider's own API. An enabled engine
whose key is missing is skipped with a message, not a crash.

Use --dry-run to exercise the whole pipeline against recorded fixtures at
zero cost; real runs always print a cost estimate first, abort if it
exceeds the settings' budget caps, and require --yes above
--yes-threshold-usd.

Gemini caveat, found by testing (2026-11-19), not documentation: on the
free tier (no billing account linked), Google Search grounding returned
HTTP 429 immediately, while plain (non-grounded) calls worked fine.

Usage:
    python monitoring/run.py --dry-run
    python monitoring/run.py --dry-run --questions q1,q2 --engines claude,gpt --variants 0
    python monitoring/run.py --questions q1,q2,q3 --engines claude --runs 1 --yes
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sqlite3
import sys
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from monitoring.cost_estimate import check_call_budget, estimate_cost, needs_confirmation  # noqa: E402
from monitoring.mention_detection import detect_mention, normalize_domains  # noqa: E402
from monitoring.run_list import FILENAME as RUN_LIST_FILE  # noqa: E402
from monitoring.run_list import load_run_list  # noqa: E402
from monitoring.variants import make_variants  # noqa: E402

ALL_ENGINES = ["claude", "gpt", "gemini"]
FIXTURES_PATH = ROOT / "monitoring" / "fixtures" / "sample_answers.json"
SETTINGS_PATH = ROOT / "data" / "monitoring_settings.json"
API_KEY_ENV = {"claude": "ANTHROPIC_API_KEY", "gpt": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}

# Fallbacks when a call_* function is used without a settings dict (tests,
# ad-hoc use). Kept identical to data/monitoring_settings.json's defaults.
DEFAULT_ENGINE_CONFIG = {
    "claude": {"enabled": True, "model": "claude-sonnet-5", "max_searches": 2},
    "gpt": {"enabled": False, "model": "gpt-5-mini", "reasoning_effort": "low"},
    "gemini": {"enabled": True, "model": "gemini-3.5-flash-lite", "grounding": False, "free_tier": True},
}


def load_settings(path: Path | None = None) -> dict:
    return json.loads((path or SETTINGS_PATH).read_text(encoding="utf-8"))


def _load_dotenv() -> None:
    """Minimal .env loader (no new dependency): KEY=VALUE lines, '#' comments.
    Strips one layer of matching quotes around the value (KEY="value" and
    KEY='value' are both common .env conventions) -- without this, a quoted
    key would silently include the literal quote characters and fail auth.
    """
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def _fail(message: str) -> int:
    """Print a fatal error and return exit code 1. On GitHub Actions, also emit
    an ::error:: annotation so the reason appears in the run summary and the
    failure email, not only in the job log (which needs a login to read)."""
    print(message, file=sys.stderr)
    if os.environ.get("GITHUB_ACTIONS") == "true":
        print("::error title=Monitoring run failed::" + message.replace("\n", " "))
    return 1


def call_claude(question_text: str, cfg: dict | None = None) -> dict:
    """One real call to Claude (default claude-sonnet-5) with web search enabled.

    Returns {"answer_text": str, "cited_urls": list[str]}. Raises RuntimeError
    with a clear message if the API key is missing or the call fails — never
    silently returns a fake result.
    """
    try:
        import anthropic
    except ImportError as e:
        raise RuntimeError("The 'anthropic' package isn't installed — run: pip install -r requirements.txt") from e

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is not set — add it to .env (see .env.example).")

    cfg = cfg or DEFAULT_ENGINE_CONFIG["claude"]
    tools = []
    if cfg["max_searches"] > 0:
        tools = [{"type": "web_search_20250305", "name": "web_search", "max_uses": cfg["max_searches"]}]
    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=cfg["model"],
        max_tokens=1024,
        # Thinking defaults to on (adaptive) on claude-sonnet-5 when omitted, and
        # thinking tokens are billed as output tokens even though never shown --
        # a real cost driver for a simple "ask, maybe search, check the answer"
        # task like this one, confirmed by real spend exceeding the estimate on
        # the first test run. Disabled explicitly (accepted on Sonnet 5).
        thinking={"type": "disabled"},
        messages=[{"role": "user", "content": question_text}],
        tools=tools,
    )

    answer_text = "".join(block.text for block in response.content if block.type == "text")
    cited_urls = [
        result.url
        for block in response.content
        if block.type == "web_search_tool_result" and isinstance(block.content, list)
        for result in block.content
        if getattr(result, "type", None) == "web_search_result"
    ]
    return {"answer_text": answer_text, "cited_urls": cited_urls}


def call_gemini(question_text: str, cfg: dict | None = None) -> dict:
    """One real call to Gemini (default gemini-3.5-flash-lite) via the
    google-genai SDK's interactions API.

    Returns {"answer_text": str, "cited_urls": list[str]}.

    cfg["grounding"] toggles Google Search grounding. It defaults to off:
    tested against a real free-tier key (2026-11-19), a grounded call
    returned HTTP 429 immediately while a plain call to the same model with
    the same key succeeded -- grounding needs a linked billing account.
    Without grounding there are no citations (cited_urls stays empty), but
    brand mentions are still detected, at $0 on the free tier.

    The citation-extraction path (annotations on a successful grounded
    response) is written from the documented response shape and couldn't be
    verified for real for the reason above; it's defensive (falls back to
    an empty list rather than crashing).
    """
    try:
        from google import genai
    except ImportError as e:
        raise RuntimeError("The 'google-genai' package isn't installed — run: pip install -r requirements.txt") from e

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is not set — add it to .env (see .env.example).")

    cfg = cfg or DEFAULT_ENGINE_CONFIG["gemini"]
    kwargs = {"model": cfg["model"], "input": question_text}
    if cfg["grounding"]:
        kwargs["tools"] = [{"type": "google_search"}]
    client = genai.Client(api_key=api_key)
    try:
        interaction = client.interactions.create(**kwargs)
    except Exception as e:
        if "429" in str(e) or "too_many_requests" in str(e).lower():
            hint = (
                "With grounding on, this happened immediately on a free-tier key in testing (2026-11-19) -- "
                "Google Search grounding appears to need billing. Set engines.gemini.grounding to false in "
                "data/monitoring_settings.json."
                if cfg["grounding"]
                else "This is the free-tier rate limit; retry later or lower the number of calls."
            )
            raise RuntimeError(f"Gemini returned a rate-limit error (429). {hint} "
                               "See https://aistudio.google.com/docs/rate-limits.") from e
        raise

    answer_text = interaction.output_text
    cited_urls = []
    for step in getattr(interaction, "steps", None) or []:
        if getattr(step, "type", None) != "model_output":
            continue
        for block in getattr(step, "content", None) or []:
            if getattr(block, "type", None) != "text":
                continue
            for ann in getattr(block, "annotations", None) or []:
                if getattr(ann, "type", None) == "url_citation" and getattr(ann, "url", None):
                    cited_urls.append(ann.url)
    return {"answer_text": answer_text, "cited_urls": cited_urls}


def call_gpt(question_text: str, cfg: dict | None = None) -> dict:
    """One real call to OpenAI (default gpt-5-mini) via the Responses API
    with the web_search tool.

    Returns {"answer_text": str, "cited_urls": list[str]}. Citations are the
    message's url_citation annotations (documented response shape, OpenAI
    web search guide, checked 2026-11-19). Written and unit-tested against
    a mocked client; NOT yet verified with a real call -- the first real
    run is gated on your approval of its cost (see TASKS.md C4c).
    """
    try:
        from openai import OpenAI
    except ImportError as e:
        raise RuntimeError("The 'openai' package isn't installed — run: pip install -r requirements.txt") from e

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set — add it to .env (see .env.example).")

    cfg = cfg or DEFAULT_ENGINE_CONFIG["gpt"]
    client = OpenAI(api_key=api_key)
    response = client.responses.create(
        model=cfg["model"],
        input=question_text,
        tools=[{"type": "web_search"}],
        # Reasoning tokens are billed as output. "low" keeps cost down while
        # staying above "minimal", which the web_search tool doesn't support.
        reasoning={"effort": cfg["reasoning_effort"]},
    )

    cited_urls = []
    for item in getattr(response, "output", None) or []:
        if getattr(item, "type", None) != "message":
            continue
        for block in getattr(item, "content", None) or []:
            for ann in getattr(block, "annotations", None) or []:
                if getattr(ann, "type", None) == "url_citation" and getattr(ann, "url", None):
                    cited_urls.append(ann.url)
    return {"answer_text": response.output_text, "cited_urls": cited_urls}


ENGINE_CALLS = {"claude": call_claude, "gpt": call_gpt, "gemini": call_gemini}


# Heuristic EN/DE detection for the question text (README's own design is a
# deliberately mixed-language question set) — looks for German umlauts or a
# few common German function words. Not a real language detector; good
# enough since individual questions are almost always unambiguously one or
# the other, just not reliably tagged as such anywhere in questions.json.
GERMAN_WORDS = (
    "wie|was|welche|welcher|welches|für|ist|sind|und|mit|den|der|die|das|ein|eine|ich|"
    "gute|guter|anbieter|beratung|im"
)
GERMAN_MARKERS = re.compile(rf"[äöüßÄÖÜ]|(?<![\wäöü])({GERMAN_WORDS})(?![\wäöü])", re.I)


def detect_language(text: str) -> str:
    return "de" if GERMAN_MARKERS.search(text) else "en"


def load_questions(question_ids: list[str] | None, scope: str = "key", data_dir: str = "data") -> list[dict]:
    """Questions for this run. Order of precedence: --questions ids, then the
    target's run_list.json (saved from the app's Run page), then the
    settings' scope ("key" = the 15 key questions, anything else = all)."""
    questions = json.loads((ROOT / data_dir / "questions.json").read_text(encoding="utf-8"))
    run_list = load_run_list(ROOT / data_dir)
    if question_ids:
        wanted = set(question_ids)
        extra = [q for q in (run_list or []) if q["id"] not in {x["id"] for x in questions}]
        return [q for q in questions + extra if q["id"] in wanted]
    if run_list is not None:
        return run_list
    if scope == "key":
        questions = [q for q in questions if q.get("key")]  # default: the 15 key questions
    return questions


def load_brand_aliases(data_dir: str = "data") -> list[str]:
    brand = json.loads((ROOT / data_dir / "brand.json").read_text(encoding="utf-8"))
    return brand["aliases"]


def load_competitor_names(data_dir: str = "data") -> list[str]:
    """Named providers to rank the brand against (TASKS.md C5a).

    Reads data/competitors.json so a real deployment can maintain its own
    real competitor list without editing code -- see that file's _comment.
    """
    competitors = json.loads((ROOT / data_dir / "competitors.json").read_text(encoding="utf-8"))
    return competitors["names"]


def load_fixture_answer(question_id: str, engine: str) -> dict | None:
    fixtures = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))
    # Fixtures exist for a few demo questions; every other question falls back
    # to "_default", so a dry run works for any question set, real targets too.
    return fixtures.get(question_id, {}).get(engine) or fixtures.get("_default", {}).get(engine)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS runs (
            question_id TEXT NOT NULL,
            engine TEXT NOT NULL,
            model TEXT NOT NULL,
            run_index INTEGER NOT NULL,
            timestamp TEXT NOT NULL,
            language TEXT,
            mentioned INTEGER NOT NULL,
            position INTEGER,
            cited_urls TEXT NOT NULL,
            answer_text TEXT NOT NULL
        )
    """)
    # Added with question variants (2026-11-19). ALTER for databases created
    # before that, so existing real results are kept, not recreated.
    existing = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
    if "variant" not in existing:
        conn.execute("ALTER TABLE runs ADD COLUMN variant INTEGER NOT NULL DEFAULT 0")
    if "question_text" not in existing:
        conn.execute("ALTER TABLE runs ADD COLUMN question_text TEXT")
    conn.commit()


def run_one(
    question: dict,
    engine: str,
    run_index: int,
    brand_aliases: list[str],
    competitor_names: list[str],
    dry_run: bool,
    engine_cfg: dict | None = None,
    prompt_text: str | None = None,
    variant: int = 0,
) -> dict:
    """prompt_text is the text actually sent (a variant, or the original
    question when None); variant is 0 for the original, 1..n for variants."""
    prompt = prompt_text or question["text"]
    engine_cfg = engine_cfg or DEFAULT_ENGINE_CONFIG[engine]
    if dry_run:
        answer = load_fixture_answer(question["id"], engine)
        if answer is None:
            raise ValueError(f"No fixture answer for {question['id']!r}/{engine!r} in {FIXTURES_PATH.name}")
        model = "fixture"
    else:
        answer = ENGINE_CALLS[engine](prompt, engine_cfg)
        model = engine_cfg["model"]

    result = detect_mention(answer["answer_text"], brand_aliases, competitor_names)
    return {
        "question_id": question["id"],
        "engine": engine,
        "model": model,
        "run_index": run_index,
        "timestamp": datetime.now(UTC).isoformat(),
        "language": detect_language(question["text"]),
        "mentioned": int(result.mentioned),
        "position": result.position,
        "cited_urls": json.dumps(normalize_domains(answer["cited_urls"])),
        "answer_text": answer["answer_text"],
        "variant": variant,
        "question_text": prompt,
    }


def estimate_run_cost(num_prompts: int, engines: list[str], runs: int, engine_cfgs: dict):
    """Per-engine estimate, since engines differ in search use and pricing.
    Returns (CostEstimate-like totals, notes)."""
    from monitoring.cost_estimate import CostEstimate

    per_engine: dict[str, float] = {}
    notes: list[str] = []
    calls = 0
    tokens_in = tokens_out = 0
    for engine in engines:
        cfg = engine_cfgs[engine]
        if engine == "claude":
            searches = cfg["max_searches"]
            input_tokens = 15000 if searches else 300
            output_tokens = 1000
        elif engine == "gpt":
            searches = 2  # the model decides; 2 is a conservative planning number
            input_tokens, output_tokens = 15000, 2000  # search content + reasoning tokens
        else:  # gemini
            searches = 0
            input_tokens, output_tokens = (2000 if cfg["grounding"] else 100), 800
        if engine == "gemini" and cfg.get("free_tier"):
            est = estimate_cost(num_prompts, [engine], runs, input_tokens, output_tokens, 0,
                                pricing={"gemini": {"input": 0.0, "output": 0.0}})
            notes.append("gemini: free tier, $0 (rate-limited, not billed)")
        else:
            est = estimate_cost(num_prompts, [engine], runs, input_tokens, output_tokens, searches)
        if engine in DEFAULT_ENGINE_CONFIG and cfg["model"] != DEFAULT_ENGINE_CONFIG[engine]["model"]:
            notes.append(f"{engine}: model {cfg['model']!r} differs from the priced default "
                         f"{DEFAULT_ENGINE_CONFIG[engine]['model']!r} -- the dollar figure may be off")
        per_engine[engine] = est.total_usd
        calls += est.num_calls
        tokens_in += est.total_input_tokens
        tokens_out += est.total_output_tokens
    total = CostEstimate(calls, tokens_in, tokens_out, round(sum(per_engine.values()), 4), per_engine)
    return total, notes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="Use recorded fixtures instead of real API calls.")
    ap.add_argument("--db", default=str(ROOT / "monitoring" / "runs.sqlite"), help="SQLite output path.")
    ap.add_argument("--settings", help="Settings file. Default: data/monitoring_settings.json.")
    ap.add_argument("--target", help="Folder with brand/competitors/questions.json. Default: settings' target.")
    ap.add_argument("--questions", help="Comma-separated question ids. Default: settings' question scope.")
    ap.add_argument("--engines", help="Comma-separated engines. Default: engines enabled in settings.")
    ap.add_argument("--runs", type=int, help="Runs per prompt per engine. Default: settings.")
    ap.add_argument("--variants", type=int, help="Randomized variants per question (0 = off). Default: settings.")
    ap.add_argument("--seed", type=int, help="Seed for variant randomization (reproducible runs).")
    ap.add_argument("--yes", action="store_true", help="Skip the cost confirmation prompt.")
    ap.add_argument("--max-calls", type=int, help="Hard cap on total API calls. Default: settings' budget.")
    ap.add_argument("--yes-threshold-usd", type=float, default=1.0, help="Est. cost above which --yes is required.")
    args = ap.parse_args()

    _load_dotenv()
    settings = load_settings(Path(args.settings) if args.settings else None)
    engine_cfgs = {e: {**DEFAULT_ENGINE_CONFIG[e], **settings["engines"].get(e, {})} for e in ALL_ENGINES}
    question_ids = args.questions.split(",") if args.questions else None
    engines = args.engines.split(",") if args.engines else [e for e in ALL_ENGINES if engine_cfgs[e]["enabled"]]
    unknown = set(engines) - set(ALL_ENGINES)
    if unknown:
        return _fail(f"Unknown engine(s): {sorted(unknown)}. Known: {ALL_ENGINES}")
    runs = args.runs if args.runs is not None else settings["runs_per_question"]
    if args.variants is not None:
        n_variants = args.variants
    else:
        n_variants = settings["variants"]["per_question"] if settings["variants"]["enabled"] else 0
    max_calls = args.max_calls if args.max_calls is not None else settings["budget"]["max_calls_per_run"]

    # The real target (e.g. targets/geo-engine) or the bundled demo data in data/.
    data_dir = args.target or settings.get("target") or "data"
    print(f"Target: {data_dir}")
    try:
        questions = load_questions(question_ids, settings["questions"], data_dir=data_dir)
    except ValueError as e:
        return _fail(f"Can't use the run list: {e}")
    if not question_ids and (ROOT / data_dir / RUN_LIST_FILE).exists():
        print(f"Questions from {data_dir}/{RUN_LIST_FILE} (saved on the app's Run page)")
    if not questions:
        return _fail("No matching questions found.")

    if not args.dry_run:
        missing = [e for e in engines if not os.environ.get(API_KEY_ENV[e])]
        if missing:
            print(f"[skipping {missing}: no API key set ({', '.join(API_KEY_ENV[e] for e in missing)})]")
            engines = [e for e in engines if e not in missing]
        if not engines:
            return _fail(f"No engines left to run: none of the enabled engines has an API key "
                         f"({', '.join(API_KEY_ENV[e] for e in missing)} missing). On GitHub, add them under "
                         "Settings -> Secrets and variables -> Actions.")

    # Variants are drawn once per question and shared by all engines, so
    # engines answer the exact same prompts and stay comparable.
    rng = random.Random(args.seed)
    prompts: list[tuple[dict, int, str]] = []
    for q in questions:
        prompts.append((q, 0, q["text"]))
        lang = detect_language(q["text"])
        for i, text in enumerate(make_variants(q["text"], lang, n_variants, rng), start=1):
            prompts.append((q, i, text))

    estimate, notes = estimate_run_cost(len(prompts), engines, runs, engine_cfgs)
    print(f"Questions: {len(questions)}  Variants/question: {n_variants}  Engines: {engines}  Runs/prompt: {runs}")
    print(f"Estimated calls: {estimate.num_calls}  Estimated cost: ${estimate.total_usd:.4f} "
          f"({', '.join(f'{e}=${c:.4f}' for e, c in estimate.per_engine_usd.items())})")
    if not args.dry_run:
        for note in notes:
            print(f"[{note}]")
        print("Token counts are planning estimates (claude measured 2026-11-18); real cost depends on "
              "answer length and how many searches each engine decides to run.")

    try:
        check_call_budget(estimate.num_calls, max_calls)
    except Exception as e:  # CallBudgetExceeded
        return _fail(f"Aborting: {e}")

    if not args.dry_run:
        max_usd = settings["budget"]["max_usd_per_run"]
        if estimate.total_usd > max_usd:
            return _fail(f"Aborting: estimated ${estimate.total_usd:.4f} exceeds "
                         f"budget.max_usd_per_run=${max_usd:.2f} in the settings file.")
        if needs_confirmation(estimate, args.yes_threshold_usd) and not args.yes:
            print(f"Estimated cost ${estimate.total_usd:.4f} exceeds threshold ${args.yes_threshold_usd:.2f}. "
                  f"Re-run with --yes to proceed.", file=sys.stderr)
            return 1

    brand_aliases = load_brand_aliases(data_dir=data_dir)
    competitor_names = load_competitor_names(data_dir=data_dir)
    conn = sqlite3.connect(args.db)
    ensure_schema(conn)
    written = 0
    failed: list[str] = []
    for q, variant, text in prompts:
        for engine in engines:
            if engine in failed:
                continue
            for run_index in range(runs):
                try:
                    row = run_one(q, engine, run_index, brand_aliases, competitor_names, args.dry_run,
                                  engine_cfg=engine_cfgs[engine], prompt_text=text, variant=variant)
                except Exception as e:  # any provider/SDK error, not just our RuntimeErrors
                    if args.dry_run:
                        raise
                    # One engine failing (rate limit, outage) must not stop the others:
                    # stop calling that engine for the rest of this run, keep going.
                    print(f"[{engine} failed, skipping it for the rest of this run: {e}]", file=sys.stderr)
                    if os.environ.get("GITHUB_ACTIONS") == "true":
                        print(f"::warning title={engine} failed::{str(e).replace(chr(10), ' ')[:500]}")
                    failed.append(engine)
                    break
                conn.execute(
                    "INSERT INTO runs (question_id, engine, model, run_index, timestamp, language, mentioned, "
                    "position, cited_urls, answer_text, variant, question_text) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (row["question_id"], row["engine"], row["model"], row["run_index"], row["timestamp"],
                     row["language"], row["mentioned"], row["position"], row["cited_urls"], row["answer_text"],
                     row["variant"], row["question_text"]),
                )
                # Commit per row, not once at the end: a real run pays per API call made, so a
                # later call crashing must not lose the real money already spent on earlier rows.
                conn.commit()
                written += 1
    conn.close()
    print(f"Wrote {written} row(s) to {args.db}")
    if failed:
        if not written:
            return _fail(f"Every engine failed, nothing was saved: {failed}. See the warnings above for each error.")
        print(f"Engines that failed during this run: {failed}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
