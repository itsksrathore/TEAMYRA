# Public Release Checklist

Use this checklist for each public TEAMYRA release.

## Source and tests
- [ ] Release commit is on `main`.
- [ ] Linux and Windows CI are green.
- [ ] Python unit tests pass.
- [ ] Desktop JavaScript syntax checks pass.
- [ ] Production/runtime dependency audit passes with `npm audit --omit=dev --audit-level=high`.
- [ ] Renderer build passes.
- [ ] `git diff --check` is clean.
- [ ] No runtime profiles, credentials, logs, jobs, memory, worktrees, or customer files are staged.

## Windows artifact
- [ ] Bundled `teamyra-core.exe` builds from a clean checkout.
- [ ] Packaged desktop runs without a separate Python installation.
- [ ] Claude, Codex, and Antigravity native-session detection still works.
- [ ] Core-backed desktop actions work from the installed app.
- [ ] Runtime state is stored under Electron user data, not the installation directory.
- [ ] Uninstall removes app files without silently deleting runtime data.

## Signing and update channel
- [ ] Repository secrets `WINDOWS_CSC_LINK` and `WINDOWS_CSC_KEY_PASSWORD` are configured.
- [ ] Stable `v*` tag workflow passes the signing-secret gate.
- [ ] Installer Authenticode status is `Valid`.
- [ ] GitHub Release contains the NSIS installer, blockmap, and `latest.yml`.
- [ ] Update metadata version matches the release tag.
- [ ] Update check/download/install is tested on a non-production machine before broad rollout.

## Documentation and security
- [ ] Release notes describe user-visible changes and known limitations.
- [ ] `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md` are present.
- [ ] Provider limitations are documented without claiming unsupported capabilities.
- [ ] No unresolved high-severity security or destructive-data-loss issue is known.
