# Lint & Static on the ECS pool for every pull request

Decision taken 2026-10-31. Scope: `.github/workflows/ci.yml` runner routing.
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

## Kill switch

`MAINTAINER_ECS_RUNNER_DISABLED=true` — all Linux lanes, including this one,
fall back to `ubuntu-latest` with the tighter 45-minute ceiling.

## Tests

`scripts/tests/ci-platform-lanes.test.js` pins: every job whose `runs-on`
reads `lint_runner` must pin a `runner.temp` HOME, `test` must keep reading
`ubuntu_runner`, and each lane's `timeout-minutes` must only reference the
output its own `runs-on` reads.
