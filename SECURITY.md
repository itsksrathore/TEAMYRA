# Security Policy

## Supported versions

TEAMYRA 1.x receives security fixes on the latest stable release and the current `main` branch.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's **Report a vulnerability** / private vulnerability reporting feature for this repository when available. Do not include secrets, access tokens, provider session files, private prompts, customer data, or exploit details in a public issue.

Include:

- affected TEAMYRA version or commit;
- operating system;
- affected provider/integration;
- reproduction steps with sensitive values removed;
- impact and any known mitigation.

If private vulnerability reporting is unavailable, contact the repository owner privately through their verified GitHub contact channel rather than opening a public issue.

## Credential handling

TEAMYRA is designed to reuse provider-native authentication. Credentials and provider session state must not be committed, bundled into installers, copied into logs, or included in bug reports. If credentials are exposed, revoke or rotate them with the provider immediately.

## Dependency auditing

CI gates the shipped runtime dependency graph with `npm audit --omit=dev --audit-level=high`. Build-tool advisories are reviewed separately because they are not necessarily included in the installed runtime.

## Release integrity

Stable Windows release automation supports code signing and Authenticode verification. Public stable binaries should be published only after the release verification checklist passes.
