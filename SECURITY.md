# Security Policy

## Supported versions

Until TEAMYRA reaches a stable 1.x release, security fixes are applied to the latest `main` branch and the newest published release only.

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

TEAMYRA is designed to reuse provider-native authentication. Credentials and provider session state must not be committed, bundled into installers, copied into logs, or included in bug reports. If credentials are exposed, revoke/rotate them with the provider immediately.

## Dependency auditing

CI gates the shipped runtime dependency graph with `npm audit --omit=dev --audit-level=high`. A full npm audit may also report advisories in build-only tooling such as electron-builder; those are tracked separately because they are not included in the installed runtime. Build-tool advisories must still be reviewed before releases, and TEAMYRA should move to a fixed stable upstream version when one is available rather than silently suppressing findings.

## Release integrity

Stable Windows releases must be code-signed. The release workflow refuses tagged stable publication when signing credentials are unavailable and verifies the generated installer's Authenticode signature before upload/publish.
