#!/usr/bin/env bash
# Local pre-push check: mirrors what .github/workflows/ci.yml runs, so a
# broken push is caught before it leaves your machine instead of after.
#
# Usage: ./scripts/check.sh
# Requires requirements-dev.txt installed (pip install -r requirements-dev.txt)
# and Node available for the JS test suite.
set -uo pipefail
cd "$(dirname "$0")/.."

status=0
step() {
  local label="$1"
  shift
  echo ""
  echo "=== $label ==="
  if "$@"; then
    echo "OK: $label"
  else
    echo "FAILED: $label"
    status=1
  fi
}

step "ruff" ruff check .
step "validate data/*.json" python3 scripts/validate_data.py
step "pytest" pytest tests/ -q
step "node --test" node --test tests/core.test.js tests/charts.test.js tests/monitor.test.js
step "rebuild app/data.js" python3 scripts/build_web_data.py
if ! git diff --quiet -- app/data.js; then
  echo "FAILED: app/data.js is stale — rebuild changed it. Review and commit the rebuilt file."
  status=1
fi
step "monitoring dry-run smoke test" python3 monitoring/run.py --dry-run --questions q1,q2 --runs 1 --db /tmp/check-sh.sqlite
rm -f /tmp/check-sh.sqlite

echo ""
if command -v gitleaks > /dev/null 2>&1; then
  step "gitleaks" gitleaks detect --source . --no-banner
else
  echo "(gitleaks not installed locally — skipped; it still runs in CI on every push)"
fi

echo ""
if [ "$status" -eq 0 ]; then
  echo "All checks passed — safe to push."
else
  echo "One or more checks FAILED — see above before pushing."
fi
exit "$status"
