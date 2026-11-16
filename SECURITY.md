# Security

## Principles

1. **No secrets in the repository.** API keys live only in a local `.env` file, which is git-ignored. `.env.example` contains empty placeholders.
2. **No secrets in the browser.** The web app is fully static and runs under a Content Security Policy with `connect-src 'none'`. It cannot send data anywhere, even if someone modifies the bundled data.
3. **Local-only API access.** Scripts that query OpenAI, Anthropic or Google read keys from environment variables at runtime and never log, print or persist them.
4. **Automated checks.** Every push runs `gitleaks` (see `.github/workflows/secret-scan.yml`).
5. **No third-party content in git.** Crawl output (`data/crawl-*.json`, `docs/audit-summary-*.md`) and monitoring databases are git-ignored.

## Before every push

```bash
git status            # .env must not appear
git diff --cached     # check what you are about to commit
```

Optional local guard (requires [gitleaks](https://github.com/gitleaks/gitleaks)):

```bash
gitleaks detect --source . --verbose
```

## If a key leaks

1. **Revoke the key immediately** in the provider console (OpenAI, Anthropic, Google AI Studio). Deleting the commit is not enough, because the key stays in the git history and in forks.
2. Create a new key and put it in `.env` only.
3. Check the provider's usage dashboard for unexpected calls.

## Recommended provider settings

- Set a **monthly spend limit** on every API key.
- Use a separate key for this project so it can be revoked without side effects.

## Reporting

Please report vulnerabilities privately through GitHub's *Security → Report a vulnerability*.
