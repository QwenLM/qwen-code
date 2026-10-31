# Lint & Static ECS Routing for All Pull Requests

[English](2026-10-31-lint-ecs-fork-routing.md) | [简体中文](2026-10-31-lint-ecs-fork-routing.zh-CN.md)

Status: implemented in PR #15974 (2026-10-31). Decision owner: jinjing (maintainer); a second-maintainer confirmation of the risk acceptance is welcome and recorded as an open question below.

## Problem

The Lint & Static lane already ran on the self-hosted ECS pool for in-repo branches, fork PRs authored by OWNER/MEMBER/COLLABORATOR accounts, pushes to `main`, and the merge queue. Only fork PRs from contributors without write access still queued on GitHub-hosted runners. In a 60-PR sample (2026-10-31), 12 PRs (~20%) paid hosted queue time for a lane whose self-hosted path is fully provisioned and exercised daily.

## Current state (before this change)

`classify_pr`'s `pick_runner` step published one routing output, `ubuntu_runner`, consumed by every Linux lane (`test`, `lint_and_static`, the integration lanes). Its association gate kept untrusted fork PRs on `ubuntu-latest`. The gate was a traffic default, not an enforced wall: a `pull_request` run executes the PR's own workflow YAML, so a fork could rewrite `runs-on` to reach the pool anyway (subject to first-timer workflow approval). The lane itself was already fully self-hosted-capable: pre-installed Node, persistent npm cache, disk-floor gate, workspace hygiene, 90-minute pool timeout.

## Goals

- Route Lint & Static to the ECS pool for every pull request, removing the hosted queue for untrusted forks.
- Keep every other lane's association gate provably unchanged.
- Keep the maintainer kill switch (`MAINTAINER_ECS_RUNNER_DISABLED=true`) and `LINUX_RUNNER_FLEET=hosted` able to revert the lane to hosted in one variable flip; honor the ARM64 fleet selector.

## Non-goals

- No isolation fleet, dedicated fork label, or ephemeral hosts.
- No containerization of the lint lane (considered and rejected — see Design decisions).
- No routing changes to `test`, the integration lanes, the browser smoke, or the Windows/macOS lanes.
- No lint-specific hosted escape hatch beyond the global kill switch (pool utilization is 8–10%; the global switch is the documented recourse).

## Solution

`pick_runner` publishes a second output, `lint_runner`. It equals `ubuntu_runner` everywhere except `pull_request` events, where it routes to the selected fleet for every author association. `lint_and_static` reads `lint_runner` for both `runs-on` and `timeout-minutes`, so the ceiling always prices the pool the job lands on (90 minutes self-hosted, 45 hosted). `classify_pr`'s own runner and every other lane keep reading the association-gated `ubuntu_runner`.

Because the lane now executes untrusted fork code on persistent shared hosts, it also adopts the per-job HOME isolation the sibling lanes already pin on their PR-code steps:

- Job-level `HOME: ${{ runner.temp }}/qwen-lint-home`, created by a `Create per-job HOME` step before the hygiene steps write their global git config. PR-authored code can no longer plant `~/.gitconfig` (`core.hooksPath`, `core.fsmonitor`) or `~/.npmrc` state that a later trusted job on the same runner registration inherits.
- The self-hosted npm-cache step derives the runner account's real home via `getent passwd` and re-points `NPM_CONFIG_CACHE`, `XDG_DATA_HOME` (pnpm store lands on its Linux default path), and `COREPACK_HOME` at the shared locations, so installs stay warm. pnpm integrity-checks store reads against the lockfile; shared-store writes by PR code cannot silently swap a package.

## Design decisions and rationale

1. **Two outputs instead of relaxing the shared gate.** The divergence is explicit, pinned in both directions by `ci-runner-routing.test.mjs` (every association reaches the pool for lint; the shared output keeps its gate) and by literal `runs-on` pins in `ci-platform-lanes.test.js` (including `test`, whose pin the deleted lint==test equality used to carry transitively). "Simplifying" the outputs back into one fails the battery.
2. **Per-job HOME instead of a container.** `qwen-triage`'s `tmux-testing`/`verify` jobs wrap PR code in `container: node:22-bookworm`. That path was considered for this lane and rejected: the lane's own `Restore workspace ownership` step exists because containerised jobs leave root-owned residue on these hosts, a fourth containerised lane worsens exactly that problem, and the pnpm-store/bundle-cache behavior would need re-proving on the pool. Per-job HOME closes the automatic config-inheritance class (the R1-1 Critical) at a few lines of cost; it is not a sandbox, and the residual co-resident surface below stays accepted.
3. **Warm shared caches over cold per-job caches.** A cold pnpm store measured 892s installs vs 347s warm on this pool; paying that on every PR would defeat the queue-removal goal. pnpm 11 does not honor `npm_config_store_dir` env (probed), and the install step's command is pinned identical to `test`'s by the shared-prelude guard, so the store is re-pointed through the platform-standard `XDG_DATA_HOME` instead of a flag.
4. **Acceptance record.** The maintainer (jinjing) reviewed and accepted the shared-pool code-execution risk on 2026-10-31, with the Lint & Static lane as the sole boundary change. The acceptance covers PR code executing on the pool for this lane; the HOME isolation above was added in review round 2 to keep cross-job persistence out of what a fork run can leave behind.

## Constraints

- `pull_request` runs execute the PR's YAML; no `runs-on` trust clause is enforceable against a fork that rewrites it. The routing is a default, and GitHub's first-timer workflow approval remains the outer gate.
- The pool shares one OS user across runner registrations; jobs on the same host are not process-isolated.
- `lint_and_static` is a required status check; its only hosted fallbacks are the global kill switch and the fleet variable.

## Risks

- **Co-resident exposure is concretely reachable, not theoretical.** `publish-tmux` runs on this pool holding `CI_BOT_PAT`, uncontainerised and without a trust gate on its `runs-on`; same-UID processes can read `/proc/<pid>/environ`. A lint step spinning under its 90-minute ceiling can scan for such windows and retry across fork PRs. Accepted for this lane; the structural fix is an isolation fleet (non-goal).
- **Cloud metadata.** If a pool instance binds a RAM role, any job process can reach the metadata endpoint. Fleet-side hardening (metadata hardened mode) is recommended and independent of this workflow change.
- **Shared package stores.** PR code can write the shared pnpm store/npm cache; integrity verification against the frozen lockfile bounds this to denial-of-service (re-fetch), not silent package substitution.
- **`/tmp` inode exhaustion.** The pool's tmpfs `/tmp` has a ~1M inode ceiling that the disk-floor gate does not cover (it checks the workspace and `RUNNER_TEMP` mounts). A 2026-10-31 lint failure on `ecs-qwen-hz1-9` was this class. Follow-up: extend the floor gate to `os.tmpdir()` and clean host `/tmp` accumulation.

## Validation plan

- `node --test .github/scripts/ci-runner-routing.test.mjs`: the real `pick_runner` shell under the full association/event matrix, including the `GITHUB_OUTPUT` publish assertions.
- `scripts/tests/ci-platform-lanes.test.js`: literal `runs-on` pins for lint and test, timeout ceilings evaluated from each job's own routing output, the HOME-isolation guard (removing the HOME override or reverting the cache derivation reds it), and the shared-prelude drift guard with the documented cache-step field exemption.
- The PR's own CI exercises the plumbing on the pool (author is a collaborator, so `lint_runner == ubuntu_runner` on that run); the divergence itself is proven by the battery, and its first live end-to-end witness is the next untrusted fork PR.

## Acceptance criteria

- Every pull request's Lint & Static lands on the selected ECS fleet; Test and the integration lanes keep the association gate (pinned).
- Kill switch and hosted-fleet override revert the lane to hosted (pinned).
- The lane runs under a per-job `runner.temp` HOME with shared warm caches (pinned).
- Bilingual design record and the corrected `qwen-autofix.md` premise ship in the same PR.

## Open questions

- A second maintainer's confirmation of the risk acceptance (triage stage-3 deferred on this; it is a human decision, not a code change).
- First untrusted fork PR as the live end-to-end witness of the divergence.
- Follow-ups owned separately: disk-floor gate coverage of `/tmp` inodes; fleet metadata hardening; an isolation fleet if the accepted residual surface is ever revisited.
