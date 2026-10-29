# Reduce release runner queues

[English](2026-10-28-release-queue-optimization.md) | [简体中文](2026-10-28-release-queue-optimization.zh-CN.md)

The v0.26.3 Linux x64 audio prebuild waited 74 minutes to execute for 50
seconds. Collection waited another ten minutes. Release validation already
runs on ECS, but native builds repeat for every release and the final publish
job still rebuilds the entire application on GitHub-hosted capacity.

## Audio prebuild reuse

Specified separately in [audio prebuild reuse](./2026-10-29-audio-prebuild-reuse.md),
which this change builds on: the fingerprint, provenance and retention rules, the
selection-versus-consumption split and the miss fallbacks all live there. The
ECS build job below consumes whatever that mechanism selected.

## Optional ECS build handoff

Keep final npm publishing on GitHub-hosted runners: npm OIDC trusted
publishing and provenance do not support ordinary self-hosted runners. When
`ECS_RELEASE_HOST_RUNNER_ENABLED` is true, a separate job on the architecture
agnostic `ecs-qwen-release-host` label prepares the version commit, builds the
bundle and workspace outputs, and builds/verifies standalone archives.

The job has read-only repository access and no publishing credentials. It
passes the exact version commit and build outputs in a same-run artifact,
using tar to preserve executable modes. The hosted publisher imports that
commit, installs dependencies, and retains existing pnpm/npm publication and
package lifecycle checks. Recreating the version commit independently is
incorrect because the bundle embeds its commit SHA.

With the switch unset, skip the new job and keep the current hosted build
path; this avoids adding a hosted queue before infrastructure is ready.
Retain production environment protection, tag-specific publish concurrency,
the immutable-version guard, workflow-pinned helpers, dry-run semantics, and
the PAT-backed release event that starts downstream workflows. Build failures
and audio failures must reach the existing failure reporter.

## Scope and activation

Reserve a small number of runner processes on existing ECS machines for release
scheduling. Start with hz1-17 and hz1-18: retain `ecs-qwen-release-host` and remove
`ecs-qwen` so ordinary shared-pool jobs do not consume those slots. Other runner
processes on the machine remain in service; no machine reinstall or exclusive
host is required by the chosen deployment model.

Labels and workspace cleanup are not a machine-level security boundary. PR code
on a sibling runner can affect the shared host, including release artifacts and
credentials. This deployment accepts that shared-host trust tradeoff; it must
not be described as host isolation. Keep npm publication hosted and retain the
existing workflow/environment protection and artifact checks.

Enable the switch only after the build/publish split is on main, runner labels
and tooling are verified, and active releases are accounted for. Validate the
main and downstream dry-runs separately. See the [downstream design](./2026-10-29-downstream-release-runners.md)
and tracking issues #15461 and #15465.

Changes reach the two release workflows, their workflow-pinned helpers,
focused workflow/packaging tests, and the workflow size ratchet. Public CLI
behavior and release artifact names remain compatible.

## Verification

Exercise fingerprint invalidation, rejected producer runs, complete and
incomplete payloads, lookup/download misses, exact-ref wiring, and the
five-target gate. Exercise the ECS build handoff with real temporary Git
repositories and tar archives, including unchanged version commits and
executable modes. Verify enabled/disabled routing, dry runs, skip-tests gates,
same-run reruns, publishing credentials, and failure reporting. Run focused
release suites, build, typecheck, and bundle. An actual Actions dry run and a
real npm release remain activation acceptance checks; local tests cannot
prove hosted scheduling capacity or npm's real OIDC exchange.
