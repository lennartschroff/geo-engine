# Security

## How keys are handled

- **Never in git.** Keys belong in a local `.env` (ignored by git) or in GitHub repository secrets. `.env.example` lists the variable names with empty values.
- **The project's keys never reach the browser.** The web app has no access to `.env` or repository secrets.
- **Visitors use their own keys.** To check from the app, a visitor pastes their own key. It stays in their browser (local storage with "Remember on this device", otherwise only until the tab closes) and is sent only to that provider's API. The Content Security Policy allows exactly three hosts, `api.anthropic.com`, `generativelanguage.googleapis.com` and `api.openai.com`, so the page can't send anything anywhere else. A saved key is as safe as the page and the browser profile: on a shared computer, untick "Remember on this device" or use "Forget all keys".
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
