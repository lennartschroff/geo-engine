# Security

## How keys are handled

- **Never in git.** Keys belong in a local `.env` (ignored by git) or in GitHub repository secrets. `.env.example` lists the variable names with empty values.
- **Never in the browser.** The web app has no way to send data: its Content Security Policy sets `connect-src 'none'`, and all its data is bundled into the page.
- **Only where they're used.** `monitoring/run.py` reads keys from the environment when it starts and never prints, logs or stores them.
- **Checked automatically.** `.github/workflows/secret-scan.yml` runs gitleaks on every push and pull request.
- **No third-party content in git.** Crawl results (`data/crawl-*.json`, `data/site-checks-*.json`, `docs/audit-summary-*.md`) and monitoring databases are ignored by git.

## Before pushing

```bash
git status          # .env must not be listed
git diff --cached   # look at what you're about to commit
./scripts/check.sh  # CI checks, plus gitleaks if installed
```

## If a key was exposed

1. Revoke it at once in the provider's console (Anthropic, OpenAI or Google AI Studio). Removing the commit doesn't help: the key remains in the history and in any copy.
2. Create a new key and keep it in `.env` or a repository secret only.
3. Look at the provider's usage page for calls you didn't make.

## Sensible provider settings

- Give each key a monthly spending limit.
- Use a key just for this project, so revoking it affects nothing else.

## Reporting a problem

Use GitHub's private reporting: *Security → Report a vulnerability*.
