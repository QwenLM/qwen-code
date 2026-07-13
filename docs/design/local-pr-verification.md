# Local PR verification

## Motivation

The pre-commit hook is intentionally fast: it formats and lints only staged
files. The legacy `npm run preflight` command is broader, but it runs Prettier
in write mode and omits several PR CI checks. Neither is the final local PR
gate.

Use three levels of feedback:

1. During development, run focused tests from the affected package.
2. Keep the existing pre-commit hook for fast staged-file feedback.
3. After committing and before the first PR push or an update push, run
   `npm run verify:pr`.

There is no repository pre-push hook. The full gate includes network access
and the full workspace test suite, so it remains an explicit developer action.

## Interface and guards

```bash
npm run verify:pr
npm run verify:pr -- --base origin/release/<branch>
npm run verify:pr -- --profile auto
```

The default base is `origin/main`, and the default profile is `full`. Full is
intentionally conservative. `--profile auto` is an opt-in optimization that
reuses the CI changed-file classifier.

Before validation starts, the command requires Node 22.x, a caller working
tree with no staged, unstaged, or untracked files, a resolvable base commit and
merge base, and at least one committed change between that merge base and
`HEAD`.

For profiles that run commands, the gate creates an owned detached temporary
worktree at the exact `HEAD`, runs validation there, and removes it afterward.
Commands that install, build, or generate files therefore do not change the
caller's tracked checkout. Developers do not need to create a separate worktree
themselves. A docs-only auto profile finishes after the same caller guards
without creating the temporary worktree.

Installation forces lifecycle scripts to run so the build and bundle cannot
be skipped by caller npm settings, while disabling Husky setup to avoid
changing the linked worktrees' shared hook configuration.

## Profiles

- `full` runs the complete deterministic local gate and is always selected
  unless `auto` is requested.
- `docs_only` is selected by `auto` only when every changed path is classified
  as documentation. It performs the caller guards and skips validation
  commands.
- `github_ci_only` is selected by `auto` only when every changed path belongs
  to the CI safety-helper set. It sets up linters, runs actionlint and yamllint,
  and runs the associated Node helper tests.

Mixed or unrecognized changes select `full`.

## Full validation

The full profile runs these categories in fail-fast order:

- clean installation in the fresh detached checkout: `npm ci` invokes the
  repository `prepare` script, which runs the build and bundle;
- critical runtime dependency audit, lockfile validation, and desktop
  workspace isolation;
- ESLint, actionlint, shellcheck, yamllint, and a read-only Prettier check of
  regular files changed by the PR that still exist at `HEAD`;
- i18n validation, read-only settings-schema freshness, type checking, and the
  serve fast-path bundle-closure check;
- all workspace unit tests plus script tests, with an isolated temporary home,
  CI settings, and the known model credentials and default auth selection
  removed;
- no-AK integration tests and the web-shell Playwright smoke test on a
  dynamically allocated localhost port.

Install Chromium once before using the web-shell smoke test:

```bash
npx playwright install chromium
```

Linux developers may need `npx playwright install --with-deps chromium`.

When the PR changes `packages/sdk-python/` or its CI workflow, the full profile
also requires `uv` and creates isolated Python 3.10, 3.11, and 3.12
environments. Each version installs the SDK development dependencies and runs
Ruff lint and format checks, Mypy, and Pytest.

The existing sensitive-keyword no-op is intentionally not part of this gate.

## Failures and remote boundaries

The gate stops at the first failed step. Output includes the step and a
copyable command before execution; validation failures also report the exact
`HEAD`, selected base and profile, and a rerun command. It preserves a child's
numeric exit code or relays its terminating signal after cleanup. The gate
always attempts to remove the temporary worktree on success or failure.
Cleanup failures are reported, including separately when a validation failure
already exists.

This gate does not replace remote CI. It cannot reproduce ECS runner load or
cache behavior, Windows and macOS merge-queue jobs, integrations that use real
secrets, GitHub permissions and artifact handling, review bots, or every
residual test flake. Remote checks remain authoritative for those surfaces.
