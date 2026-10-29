# Downstream release runners

[简体中文](./2026-10-29-downstream-release-runners.zh-CN.md)

## Problem

CLI publication fans out into concurrent VSCode, SDK, desktop, managed-runtime,
OSS, Chrome and finalization jobs. Hosted queue delays recur at each stage.
The main release optimization alone does not remove those waits.

## Design

Reuse ECS_RELEASE_HOST_RUNNER_ENABLED and ecs-qwen-release-host. Keep default
hosted execution when the switch is unset. Do not create a pool per workflow or
serialize independent releases with a global concurrency group: GitHub replaces
older pending runs in such groups. A small isolated pool can queue independent
jobs normally. Size it from actual queue and execution times; one runner slot
does not make downstream work intrinsically serial.

The runners carrying the release-only label are ARM64, so every release-only
label is architecture-free. An "x64" component does not fall back to hosted —
it never matches, and the job queues until its timeout. Only genuinely
architecture-independent work is routed here.

Before checkout, fetch the preflight from the immutable workflow revision using
the job token, outside the persistent workspace. One composite action owns that
logic for every routed job, referenced as `$/.github/actions/...` so it resolves
at the running commit: a `./` reference would need a prior checkout and, on a
persistent machine, would execute whatever action tree the previous job left on
disk. The preflight canonicalises and wipes the workspace, refusing paths that
resolve through a symlinked component or outside the runner workspace, then
isolates Git, npm, gh, Docker and Maven state in runner temp and asserts
Node 22. Routed jobs use preinstalled Node 22 and job-local npm/OSS tools.

Release credentials must never run on hosts shared with untrusted PR jobs.
A label alone is not a security boundary; the release-labelled runner processes
still carry the shared pool label today, so enabling the switch requires
machine-level isolation first, not just labels and a workspace wipe.

Route VSCode prepare/publish and the universal build leg, finalize, desktop
publication, Chrome build/publication, GHCR builds and the audio prebuild
collector to this pool. Keep already migrated read-only preparation jobs. Keep
macOS/Windows builds and desktop Ubuntu 22.04 native builds on their existing
runners to preserve signing, toolchains and glibc compatibility. The VSCode
route keys on `matrix.universal`, not `matrix.os`: the universal leg packages
with `--omit=optional` and carries no native node-pty, while the native
linux-x64 leg resolves native dependencies for the host it builds on and stays
hosted.

The three OSS mirrors and the managed-runtime publisher are **not** routed here.
They download and execute a hardcoded linux-amd64 ossutil, so the ARM64 pool
would fail on exec format even if the label matched. Selecting that binary and
its checksum per `runner.arch` is a separate change with its own verification.

SDK uses an optional ECS producer and its existing hosted publisher. YAML
anchors share the build steps with the single-job hosted fallback, so disabling
ECS adds no hosted queue. Pin the producer source SHA and transfer the final npm
tarball, including its versioned manifest, in a same-run artifact. Return release
metadata through job outputs.
After tests, restore the selected CLI and its metadata before packing without
lifecycle scripts. Publish exactly that tarball without scripts and with npm
provenance on hosted. Retry identical npm bytes safely; reject different bytes.
Keep dry-run side-effect-free and report producer failures independently.

npm trusted publishing and provenance require a cloud-hosted runner, so the
final npm publication stays on GitHub-hosted runners by contract, not by
convenience. Moving a provenance publisher to a self-hosted runner breaks the
release rather than speeding it up.

Manual Python/Java SDK publishers and the mixed Live Host npm publisher are not
CLI release fanout migrations. Their platform/authentication contracts remain
unchanged.

## Audio prebuild reuse

Specified separately in [audio prebuild reuse](./2026-10-29-audio-prebuild-reuse.md),
which this change builds on. That mechanism is independent of
ECS_RELEASE_HOST_RUNNER_ENABLED and takes effect with the switch unset; the
isolated build job here consumes the same reused artifact when one was
selected.

## Validation and rollout

Update workflow contract tests and add preflight/tarball fixtures. Run workflow
lint, focused tests, build, typecheck and bundle. Review the full diff. No real
publication, runner mutation or switch enablement is part of this local change.

Enabling the switch requires, in order: release-labelled runner processes that
no longer share a pool with PR work, on a host that never runs PR code; the
tooling those jobs assume (Node 22, corepack/pnpm, gh, GNU realpath, unzip, zip,
jq, Docker for the image builds); and a real Actions dry run. Native desktop
migration needs a compatible image first. Audio reuse needs none of this.

## Affected files

Release workflows under .github/workflows, the shared preflight action under
.github/actions, shared scripts under .github/scripts, workflow tests under
scripts/tests, and the workflow size baseline.

## Open questions

Isolated capacity and live dry-run results are operational checks; there is no
automatic hosted fallback after an enabled ECS job starts failing. Making the
OSS mirrors and managed-runtime publisher arch-aware is deferred, so that part
of the fanout keeps paying the hosted queue until then.
