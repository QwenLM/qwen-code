# Lint & Static on the ECS pool for every pull request

[English](2026-10-31-lint-static-ecs-routing.md) | [简体中文](2026-10-31-lint-static-ecs-routing.zh-CN.md)

Decision taken 2026-10-31 by jinjing (maintainer). Scope: `.github/workflows/ci.yml` runner routing.
Retracts the "collaborator-authored — the same trust class ci.yml's pick_runner
routes onto this pool" premise formerly stated in
[`qwen-autofix.md` §38](../../.github/workflows/qwen-autofix.md) (rewritten in
the same PR); [`autofix-gate-runner-isolation.md`](./autofix-gate-runner-isolation.md)
remains the reference for the pool's shared-HOME property.

## What changed

`classify_pr`'s `pick_runner` publishes two routings instead of one, both
assigned from a single resolved fleet ladder:

| Output          | Admits                                                                                            | Read by                                                               |
| --------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ubuntu_runner` | same-repo heads, `OWNER` / `MEMBER` / `COLLABORATOR` authors, `merge_group`, `push` — else hosted | `test`, `integration_no_ak`, `integration_cli`, `web_shell_e2e_smoke` |
| `lint_runner`   | every `pull_request`, untrusted forks included; otherwise identical to `ubuntu_runner`            | `lint_and_static`                                                     |

Fallback priority: `MAINTAINER_ECS_RUNNER_DISABLED=true` overrides everything,
including manual dispatch. `LINUX_RUNNER_FLEET=hosted` forces pull requests,
merge groups and pushes to hosted, but a `workflow_dispatch` run whose
`linux_runner` input explicitly selects `self-hosted` / `self-hosted-arm64`
still reaches the pool — the dispatch branch is evaluated first. During a pool
outage, use the kill switch, not the fleet variable, to guarantee hosted.

`test_windows` and the macOS lanes are out of scope: they read no classifier
output.

## Why the untrusted-fork lane is acceptable

The lane's job is "the checks whose verdict depends only on the tree". Routing
it to the fleet at all is a throughput decision: a hosted round trip per PR
delays the checks that gate merge. The trust cost is that PR code —
`pnpm install` lifecycle scripts and lint/static tooling — now runs on the
shared pool for a fork author nobody has vetted.

## Isolation boundary (and its holes)

`lint_and_static`'s first step publishes `HOME` / `USERPROFILE` via
`GITHUB_ENV`, pointing at
`${RUNNER_TEMP}/qwen-lint-home-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}` —
run-unique, cleared with `rm -rf` before creation, and reclaimed by an
`always()` cleanup step before the failure collector. Job-level `env` cannot
read the `runner` context (GitHub rejects the whole workflow file), and
`RUNNER_TEMP` survives across jobs on this pool, so a fixed directory name
would hand a fork's `~/.npmrc` / `~/.gitconfig` to the next job on the
registration — including the `test` lane, which pins its own constant
`qwen-ci-home` (a pre-existing property, separately owned).

The pin closes the **HOME-relative (automatic) write class**: config that git,
npm and pnpm resolve through `~`/`$HOME`. It does not stop a job that writes
the account's real home by absolute path; that remains in the accepted
residual surface below. Limits that stay accepted:

- **Package caches are cold.** npm and pnpm stores live under the per-run
  HOME, so each run installs from the registry; yamllint is re-pipped into
  `$HOME/.local` and the corepack shim is re-downloaded per run. The measured
  cold install (~900 s) is what the 90/45 ceiling already prices. Only the
  linter-archive cache stays shared and warm: `XDG_CACHE_HOME` points at
  `${RUNNER_TOOL_CACHE}/qwen-ci-cache`, and lint.js SHA-256-verifies every
  archive on each cache hit before extraction, rejecting and re-fetching
  tampered entries. `COREPACK_HOME` stays inside the run-unique HOME:
  corepack does not re-verify extracted entries on cache hit (reproduced on
  0.34.6 and 0.36.0 — a tampered pnpm entry executes with the recorded hash
  unchanged), so a shared corepack home is a cross-job poisoning channel.
- **`$GITHUB_WORKSPACE` is still shared.** The pre-checkout "Restore workspace
  ownership" step and the checkout itself reduce, but cannot eliminate,
  residue a co-resident job leaves behind. The lane's only credential is the
  read-only `GITHUB_TOKEN` (`contents: read`, `pull-requests: read`), bound to
  the freshness, contract and test-growth steps — harvesting the residue
  yields no write credential.

Steps that need the real home (none today) would have to be re-gated.

### Why not a container

`qwen-triage`'s `tmux-testing`/`verify` jobs wrap PR code in
`container: node:22-bookworm`. That path was considered for this lane and
rejected: the lane's own "Restore workspace ownership" step exists because
containerised jobs leave root-owned residue on these hosts, a fourth
containerised lane worsens exactly that problem, and the pnpm-store/bundle-cache
behavior would need re-proving on the pool. Per-run HOME closes the automatic
config-inheritance class at a few lines of cost; it is not a sandbox, and the
residual surface below stays accepted.

## Residual risks (accepted)

- **Co-resident exposure is concretely reachable, not theoretical.** For
  example, `publish-tmux` runs on this pool holding `CI_BOT_PAT`,
  uncontainerised and without a trust gate on its `runs-on`; same-UID
  processes can read `/proc/<pid>/environ`. It is one example, not a census:
  `serve-ab-publish`, `web-shell-visuals-cleanup` and `qwen-autofix`'s
  `issue-autofix` also carry bot PATs on ECS pools, and `web_shell_e2e_smoke`
  reaches the self-hosted ARM64 fleet off `ubuntu_runner` (write-access fork
  authors included) with no per-job HOME — pre-existing surfaces this PR does
  not change. A lint step spinning under its 90-minute ceiling can scan for
  such windows and retry across fork PRs. The structural fix is an isolation
  fleet — out of scope here.
- **The association gate is throughput policy, not an enforceable trust
  boundary.** A `pull_request` run executes the PR's own workflow file, so any
  fork can put any lane — `test` included — on the pool in the same diff it
  opens (ci.yml's `test_windows` comment records the same fact). GitHub's
  first-timer workflow approval is the outer gate. The single-lane scope of
  this decision describes the default routing, not a fence.
- **Cloud metadata.** If a pool instance binds a RAM role, any job process can
  reach the metadata endpoint. Fleet-side hardened mode is recommended,
  independent of this workflow change.
- **`/tmp` inode exhaustion.** The pool's tmpfs `/tmp` has a ~1M inode ceiling
  the disk-floor gate does not cover (it checks the workspace and
  `RUNNER_TEMP` mounts). A 2026-10-31 lint failure on `ecs-qwen-hz1-9` was this
  class. Follow-up: extend the floor gate to `os.tmpdir()` and clean host
  `/tmp` accumulation.

## Kill switch

`MAINTAINER_ECS_RUNNER_DISABLED=true` — all Linux lanes, including this one,
fall back to `ubuntu-latest`, each with its own hosted ceiling: lint 45
minutes, test 120, web-shell smoke 60, no-AK integration 30.

## Tests

`.github/scripts/ci-runner-routing.test.mjs` (in `HELPER_TESTS`, so it gates
every full-profile PR) pins: the producer binding
(`classify_pr.outputs.lint_runner` ← `pick_runner`), the full association /
event matrix against the real selector shell, the single-lane scope of
`lint_runner` (a superset must update this record), the run-unique HOME
published from the first step with clear-before-create and shared verified
caches, the cleanup step preceding the collector, and both outputs agreeing
on one fleet ladder for unmodeled fleet values.
`scripts/tests/ci-platform-lanes.test.js` pins the `runs-on` literals (lint on
`lint_runner`, test on `ubuntu_runner`) and evaluates each lane's timeout from
its own routing output; note that suite runs after the merge queue, which is
why the load-bearing HOME guard lives in the routing battery.

## Decision record and open questions

- Acceptance: jinjing reviewed and accepted the shared-pool code-execution
  risk on 2026-10-31, with Lint & Static as the sole default-routing change —
  noting that the association gate is not enforceable against a fork that
  rewrites the workflow YAML, so the acceptance covers the residual surface
  above, not a one-lane fence. A second maintainer's confirmation is welcome
  (triage stage-3 deferred on exactly this); it is a human decision, not a
  code change.
- The PR's own CI exercises the routing plumbing on the pool (the author is a
  collaborator, so both outputs agree on that run); the fork divergence is
  proven by the routing battery, and its first live end-to-end witness is the
  next untrusted fork PR.
- Follow-ups owned separately: warm shared pnpm store under the per-run HOME
  (e.g. via `XDG_DATA_HOME` at a content-verified shared path) to recover the
  ~900 s cold-install cost; disk-floor gate coverage of `/tmp` inodes; fleet
  metadata hardening; the `test` lane's constant `qwen-ci-home` persistence;
  an isolation fleet if the accepted residual surface is ever revisited.
