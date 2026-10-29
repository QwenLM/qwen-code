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
isolated build job below consumes whatever that mechanism selected.

## Optional isolated build handoff

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

The production build host must not run PR jobs. Artifact IDs and hashes cannot
make a shared persistent host trustworthy. The currently labelled hz1 runners
are not isolated, so this change does not enable the switch or modify runner
labels. Downstream migration is covered by the [downstream design](./2026-10-29-downstream-release-runners.md). Dedicated hosted capacity,
and fleet changes remain operational follow-ups under #15461 and #15465.

Changes reach the two release workflows, their workflow-pinned helpers,
focused workflow/packaging tests, and the workflow size ratchet. Public CLI
behavior and release artifact names remain compatible.

## Verification

Exercise fingerprint invalidation, rejected producer runs, complete and
incomplete payloads, lookup/download misses, exact-ref wiring, and the
five-target gate. Exercise the isolated build handoff with real temporary Git
repositories and tar archives, including unchanged version commits and
executable modes. Verify enabled/disabled routing, dry runs, skip-tests gates,
same-run reruns, publishing credentials, and failure reporting. Run focused
release suites, build, typecheck, and bundle. An actual Actions dry run and a
real npm release remain activation acceptance checks; local tests cannot
prove hosted scheduling capacity or npm's real OIDC exchange.
