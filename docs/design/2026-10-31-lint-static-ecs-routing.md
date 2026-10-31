# Lint & Static on the ECS pool for every pull request

[English](2026-10-31-lint-static-ecs-routing.md) | [简体中文](2026-10-31-lint-static-ecs-routing.zh-CN.md)

Decision taken 2026-10-31 by jinjing (maintainer). Scope: `.github/workflows/ci.yml` runner routing.
Supersedes the "collaborator-only" premise in
[`autofix-gate-runner-isolation.md`](./autofix-gate-runner-isolation.md) for
this one lane.

## What changed

`classify_pr`'s `pick_runner` publishes two routings instead of one:

| Output          | Admits                                                                                            | Read by                                                               |
| --------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `ubuntu_runner` | same-repo heads, `OWNER` / `MEMBER` / `COLLABORATOR` authors, `merge_group`, `push` — else hosted | `test`, `integration_no_ak`, `integration_cli`, `web_shell_e2e_smoke` |
| `lint_runner`   | every `pull_request`, untrusted forks included; otherwise identical to `ubuntu_runner`            | `lint_and_static`                                                     |

Both outputs fall back to `["ubuntu-latest"]` when the kill switch
(`vars.MAINTAINER_ECS_RUNNER_DISABLED=true`) or `LINUX_RUNNER_FLEET=hosted` is
set — the switch is read in `pick_runner`, so it reverts every lane to hosted.

`test_windows` and the macOS lanes are out of scope: they read no classifier
output.

## Why the untrusted-fork lane is acceptable

The lane's job is "the checks whose verdict depends only on the tree". Routing
it to the fleet at all is a throughput decision: a hosted round trip per PR
delays the checks that gate merge. The trust cost is that PR code —
`pnpm install` lifecycle scripts and lint/static tooling — now runs on the
shared pool for a fork author nobody has vetted.

## Isolation boundary (and its holes)

`lint_and_static` pins `HOME` / `USERPROFILE` to
`${{ runner.temp }}/qwen-ci-home` at job level, so fork-written
`~/.gitconfig`, `~/.npmrc` and `~/.cache/qwen-code/npm` die with the job
instead of being inherited by the next trusted job on that host. Two limits
stay accepted:

- **Caches are cold.** npm and pnpm stores now live under the per-job HOME, so
  each run installs from the registry. The measured cold install (~900 s) is
  what the 90/45 ceiling already prices.
- **`$GITHUB_WORKSPACE` is still shared.** The pre-checkout "Restore workspace
  ownership" step and the checkout itself reduce, but cannot eliminate,
  residue a co-resident job leaves behind. This lane has no secret-bearing
  step, which is what keeps that residue from being worth a token.

Steps that need the real home (none today) would have to be re-gated.

### Why not a container

`qwen-triage`'s `tmux-testing`/`verify` jobs wrap PR code in
`container: node:22-bookworm`. That path was considered for this lane and
rejected: the lane's own "Restore workspace ownership" step exists because
containerised jobs leave root-owned residue on these hosts, a fourth
containerised lane worsens exactly that problem, and the pnpm-store/bundle-cache
behavior would need re-proving on the pool. Per-job HOME closes the automatic
config-inheritance class at a few lines of cost; it is not a sandbox, and the
residual surface below stays accepted.

## Residual risks (accepted)

- **Co-resident exposure is concretely reachable, not theoretical.**
  `publish-tmux` runs on this pool holding `CI_BOT_PAT`, uncontainerised and
  without a trust gate on its `runs-on`; same-UID processes can read
  `/proc/<pid>/environ`. A lint step spinning under its 90-minute ceiling can
  scan for such windows and retry across fork PRs. The structural fix is an
  isolation fleet — out of scope here.
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
fall back to `ubuntu-latest` with the tighter 45-minute ceiling.

## Tests

`scripts/tests/ci-platform-lanes.test.js` pins: every job whose `runs-on`
reads `lint_runner` must pin a `runner.temp` HOME, `test` must keep reading
`ubuntu_runner`, and each lane's `timeout-minutes` must only reference the
output its own `runs-on` reads.

## Decision record and open questions

- Acceptance: jinjing reviewed and accepted the shared-pool code-execution
  risk on 2026-10-31, with Lint & Static as the sole boundary change. A second
  maintainer's confirmation is welcome (triage stage-3 deferred on exactly
  this); it is a human decision, not a code change.
- The PR's own CI exercises the routing plumbing on the pool (the author is a
  collaborator, so both outputs agree on that run); the fork divergence is
  proven by the routing battery, and its first live end-to-end witness is the
  next untrusted fork PR.
- Follow-ups owned separately: warm shared caches under the per-job HOME
  (e.g. re-pointing the pnpm store via `XDG_DATA_HOME` at the runner account's
  real home) to recover the ~900 s cold-install cost; disk-floor gate coverage
  of `/tmp` inodes; fleet metadata hardening; an isolation fleet if the
  accepted residual surface is ever revisited.
