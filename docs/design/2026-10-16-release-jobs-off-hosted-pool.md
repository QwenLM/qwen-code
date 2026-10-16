# Release Jobs Off the Hosted Pool

[English](2026-10-16-release-jobs-off-hosted-pool.md) | [简体中文](2026-10-16-release-jobs-off-hosted-pool.zh-CN.md)

## Problem and Scope

On 2026-10-15 both v0.25.2 release workflows completed validation but then
stalled in the GitHub-hosted runner queue: `Publish Release` waited 64
minutes (eligible 14:21, dispatched 15:25, after operators mass-cancelled
~300 queued runs by hand), the `Quality Checks` aggregate 53 minutes, and
`Audio Capture Prebuilds / collect prebuilds` 49 minutes. The hosted pool's
20-queue concurrency was saturated by ~146 queued automation jobs (`Qwen
Pull Request Review`, `Qwen Code CI`, `Qwen Triage`, …). GitHub Actions
dispatches hosted runners FIFO with no per-workflow priority, so releases
could only wait or have operators mass-cancel runs by hand.

This change reroutes the release lane's hosted stragglers onto ECS runners
without weakening the credential isolation that put `publish` on hosted
runners in the first place.

Out of scope: the per-platform `prebuild` matrix (its ubuntu-latest x64 lane
also queued ~46 minutes, but matrix `runner:` values are plain literals and
the cross-compilation story deserves its own change), `notify_failure`
(deliberately hosted — it must survive whatever broke the pool it reports
on), and the queued-automation flood itself.

## Current State

`release.yml` runs eight jobs on the `ecs-qwen-hk4-host` pool (prepare, the
quality lanes, workspace tests, both integration lanes) — machines that are
dual-labelled: the same `ecs-qwen-hk4-*` instances also serve PR CI under the
`ecs-qwen` label. Three jobs stay on `ubuntu-latest`:

- `publish` — comment: "Keep release credentials off the shared pool that
  runs PR code." It carries `secrets.CI_BOT_PAT` and npm OIDC trusted
  publishing.
- `quality` — a workspace-free gate that aggregates five check results.
- `notify_failure` — failure reporting, hosted on purpose.

`audio-capture-prebuilds.yml`'s `collect` job (artifact merge only, no
credentials) also runs on `ubuntu-latest`.

## Goals

- Release jobs no longer queue behind PR automation on the hosted pool.
- `publish` never lands on a machine that executes PR code.
- Merging this change alone changes nothing at runtime until operations
  provisions the dedicated runner and sets the opt-in variable.

## Proposed Solution

- `quality` moves to the `ecs-qwen-hk4-host` pool using the same conditional
  `runs-on` expression as the five checks it aggregates. It gains the
  `restore_release_workspace` wipe anchor (pool hygiene invariant: every
  pool-routed job wipes first) but stays exempt from the disk-floor gate
  because it never checks out and has no heavy steps. This takes effect on
  merge — those machines are idle by the time `quality` runs.
- `publish` and `collect` move to a new, release-only runner label
  `ecs-qwen-release-host`, gated by a new opt-in repository variable
  `ECS_RELEASE_HOST_RUNNER_ENABLED`:
  `${{ (github.repository == 'QwenLM/qwen-code' && vars.ECS_RELEASE_HOST_RUNNER_ENABLED == 'true') && fromJSON('["self-hosted", "linux", "x64", "ecs-qwen-release-host"]') || fromJSON('["ubuntu-latest"]') }}`
  With the variable unset (default), both jobs dispatch to `ubuntu-latest`
  exactly as before this change. Operations provisions dedicated machines
  carrying only the `ecs-qwen-release-host` label, then flips the variable.
- `publish` gains the `release_disk_floor_gate` anchor (after its checkout,
  before install), bringing it under the same ENOSPC fast-fail regime (#10035)
  as every other pool-routed job.
- `collect` gains a fail-closed `rm -rf prebuilds` step before the artifact
  merge: on a persistent workspace, `download-artifact` with
  `merge-multiple: true` merges into existing paths, so a leftover directory
  from a previous release would re-upload stale prebuilds. `rm` failing
  (e.g. root-owned leftovers) fails the job instead of publishing a dirty
  artifact.
- `.github/actionlint.yaml` registers the new label.

## Design Decisions and Rationale

- **Opt-in variable instead of the existing `MAINTAINER_ECS_RUNNER_DISABLED`
  escape hatch.** The escape hatch is an opt-OUT for a pool that already
  exists. `ecs-qwen-release-host` machines do not exist yet; flipping the
  default to "on" would strand `publish` queued forever on a label with zero
  runners. Opt-in keeps the merge safe and makes activation a one-line
  operations action.
- **A new label instead of reusing `ecs-qwen-hk4-host`.** Runner labels, not
  runner groups, are what the workflow file can select, and investigation on
  2026-10-15 showed the `ecs-qwen-hk4-host` machines are the same instances
  that run PR CI under `ecs-qwen` (release jobs and PR CI jobs both landed
  on `ecs-qwen-hk4-2/-23/-26/-28` that day). `publish` credentials on those
  machines would break the exact isolation the old comment demands.
- **`quality` rides the shared pool immediately.** It holds no secrets and no
  workspace: the worst a compromised sibling could do is influence a 3-second
  result check that publish re-verifies through `needs.*.result` wiring.
  Waiting for dedicated hardware would leave a 53-minute hosted-queue stall
  in the critical path of every release.
- **Test contracts updated, not weakened.** The pool-routed marker in
  `release-workflow.test.js` now recognizes both labels, so the
  wipe-everything and disk-floor invariants automatically extend to the new
  pool. `publish` is newly gated (it has a checkout and installs); `quality`
  is exempted by structure (no checkout → the gate has nothing to ride on),
  not by name.

## Constraints and Risks

- **Risk: the dedicated machine is a single point of serialization.**
  `collect` (≈5 s) and `publish` (≈16 min) share it once enabled; a release
  cannot start publishing before its artifacts are collected anyway, so the
  serialization matches the existing dependency chain. A second machine with
  the same label removes the risk without any workflow change.
- **Risk: operators flip the variable before registering the runner.**
  `publish` would queue indefinitely. The dispatch-time check is the runner
  registration itself; the timeout-minutes: 90 bound on `publish` turns a
  misconfiguration into a failed (and reported) run, not a stuck one.
- **Fork dispatches of `audio-capture-prebuilds.yml` keep working**: the
  repository condition in the expression falls back to `ubuntu-latest`
  outside `QwenLM/qwen-code`.

## Validation Plan

- `npx vitest run scripts/tests/release-workflow.test.js` — covers wipe
  ordering, disk-floor placement, the line-count ratchet, the aggregate
  contract, and the new routing assertions.
- `node scripts/lint.js --actionlint` and the alias-node delta check: the
  only new warnings are two alias references identical in shape to the
  existing seventy-one (local actionlint cannot resolve YAML aliases; CI's
  version handles them — baseline and change behave the same).
- The four other suites that parse `release.yml` (`ai-release-notes`,
  `install-script`, `package-scripts`, `workflow-size`) and
  `classify-release-notes.test.mjs` pass unchanged.
- Before enabling: register an `ecs-qwen-release-host` runner, then dispatch
  a dry-run release with `ECS_RELEASE_HOST_RUNNER_ENABLED=true` and confirm
  `publish` + `collect` land on it while `notify_failure` stays hosted.

## Acceptance Criteria

- With `ECS_RELEASE_HOST_RUNNER_ENABLED` unset, every release job dispatches
  exactly as before this change.
- With it set, `publish` and `collect` run on `ecs-qwen-release-host`
  machines only, `quality` on `ecs-qwen-hk4-host`, `notify_failure` on
  hosted, and no release job queues behind PR automation once the pools have
  capacity.
- `publish`'s `runs-on` cannot select any label shared with PR CI — pinned by
  the updated meta-test.

## Open Questions

- How many `ecs-qwen-release-host` machines to provision (one is enough to
  unblock; two removes the serialization) and which ECS instance profile
  they reuse.
- Whether the ubuntu-latest x64 `prebuild` matrix lane should follow onto the
  shared pool in a follow-up.
