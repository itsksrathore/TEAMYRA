# Support

## Before asking for help

1. Run `npm run teamyra -- doctor`.
2. Confirm the provider CLI works independently.
3. Run `python -m unittest discover -s tests -p "test_*.py"` and `npm run desktop:check` when reporting a development regression.
4. Check [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) for provider setup.

## Bug reports

Use GitHub Issues for reproducible TEAMYRA bugs. Include the TEAMYRA version/commit, Windows version, affected provider, expected behavior, actual behavior, and sanitized logs or reproduction steps.

Never post access tokens, cookies, provider auth files, customer data, private prompts, or other secrets.

## Feature requests

Feature requests are welcome when they describe a clear workflow problem. Please explain the user goal and expected behavior rather than only naming a library or implementation.

## Security

Do not use public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
