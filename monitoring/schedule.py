"""Decides whether a scheduled monitoring run is due today.

GitHub Actions cron can't read a settings file, so the workflow wakes up
daily and asks this script. Stateless on purpose (no "last run" bookkeeping):
the answer depends only on today's date and data/monitoring_settings.json.

Usage (in .github/workflows/monitoring.yml):
    python monitoring/schedule.py            # prints due=true|false
    python monitoring/schedule.py --date 2026-11-23
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def is_due(schedule: dict, today: date) -> bool:
    frequency = schedule["frequency"]
    if frequency == "daily":
        return True
    on_weekday = today.weekday() == WEEKDAYS.index(schedule["weekday"])
    if frequency == "weekly":
        return on_weekday
    if frequency == "biweekly":
        return on_weekday and today.isocalendar().week % 2 == 0
    if frequency == "monthly":
        return on_weekday and today.day <= 7
    raise ValueError(f"Unknown schedule frequency {frequency!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--date", help="ISO date to check instead of today (UTC).")
    args = ap.parse_args()
    settings = json.loads((ROOT / "data" / "monitoring_settings.json").read_text(encoding="utf-8"))
    today = date.fromisoformat(args.date) if args.date else date.today()
    print(f"due={'true' if is_due(settings['schedule'], today) else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
