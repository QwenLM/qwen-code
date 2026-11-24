# Audio prebuild reuse

[简体中文](./2026-10-29-audio-prebuild-reuse.zh-CN.md)

## Problem

Every release rebuilds the native audio prebuilds for all five targets, even
when nothing that affects those binaries changed. The build itself is short;
the wait is not. For v0.26.3 the Linux x64 prebuild waited 74 minutes for a
hosted runner to execute for 50 seconds, and the collection step queued again
after it. Because `publish` depends on that collection, the whole release sits
behind it.

Audio prebuilds are a good reuse candidate precisely because they are
expensive to schedule and cheap to verify: five native `.node` files whose
inputs are fully described by the repository at a known commit.

## Design

A release fingerprints its audio build inputs, looks for an artifact from an
earlier successful official `main` release with the same fingerprint, and
reuses it instead of rebuilding.

### What the fingerprint covers

The content identity (git blob OID) of everything that can change the built
binaries: `packages/audio-capture`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`.pnpmfile.mjs`, `.npmrc`, the root `package.json`'s `packageManager` pin, plus
the contents of the producing workflow and this helper. Hashing the workflow is
what makes the Node pin and the `prebuildify --target` arguments part of the
key.

Two deliberate exclusions: `packages/audio-capture/package.json`'s `version`
field, because a version bump is packaging metadata that no part of the native
build reads, and everything in the root `package.json` except `packageManager`.
Without the first exclusion no release could ever reuse another's prebuilds.

A ref with no `pnpm-lock.yaml` produces an empty key and never reuses — older
refs have no frozen native dependency graph to match against.

### What makes an artifact trustworthy

Reuse means executing bytes built by an earlier run, so provenance is checked
rather than assumed. A candidate must be named for the exact fingerprint, be
unexpired, come from a run whose repository and head repository are both this
repository, and come from a _completed, successful_ run of `release.yml` on
`main` triggered by `workflow_dispatch` or `schedule`. That excludes fork PRs,
`workflow_run` producers, and direct dispatches of the audio workflow.

Transport integrity is already covered: the pinned `download-artifact` compares
the artifact digest and fails on mismatch.

### Retention: selection vs consumption

Selection requires at least 48 hours of remaining retention, so a chosen
artifact outlives the rest of the release. The downstream consumer requires
only that the artifact has not expired.

These must differ. Re-applying the selection margin against a later clock
rejects an artifact the release has already committed to: an artifact with
48h1m remaining passes in `prepare` and then fails two minutes later with
47h59m still available — after `prepare` skipped the native matrix, leaving no
fallback.

### Failure handling

Fingerprinting, lookup, trial download and validation are non-fatal, and the
reuse ID is only published after a _trial download and payload validation_
succeed:

- lookup API failure → no candidate
- fingerprint or temporary-directory failure → no key, so the native matrix runs
- download failure → acceptance skipped (keyed on `outcome`, since
  `continue-on-error` rewrites `conclusion`)
- payload validation failure → the step fails before writing the output
- reusable upload failure → the current release proceeds; future reuse may miss

An empty reuse ID runs the full native matrix. Fresh builds now pin Node and
the prebuildify target to 22.22.3 and use filtered, frozen pnpm dependencies
when a lockfile exists; only older refs retain the npm install path. Linux on hosted and ECS runners
builds run that same frozen install inside `node:22.22.3-bookworm`, preserving
the existing glibc baseline. The trial bytes are discarded and re-downloaded
by the consumer.

Both the ECS build job and the hosted publisher independently recompute the
fingerprint from their own checkout, re-verify the source run, download by
artifact ID, and validate the payload again. That verification is fatal — by
then the native matrix was skipped, so a bad artifact must stop the release
rather than ship. A download failure or artifact deletion at this stage also
stops the release; it does not restart the skipped matrix.

Validation checks exactly the five target directories, each containing only
nonempty regular `.node` files and no symlinks. It is a shape check, not a
platform check; the provenance and digest checks above carry the trust.

### Collector hygiene

The collector merges per-platform artifacts on a possibly persistent workspace,
where `download-artifact`'s `merge-multiple` merges into existing paths, so a
stale `prebuilds/` tree would leak into the artifact it uploads.

It uses the shared release-runner preflight already on main, which canonicalises
and wipes the workspace and refuses paths resolving through a symlinked
component or outside the runner workspace. This change preserves that action
and its cleanup implementation.

The action fetches the cleanup and disk-floor scripts at the workflow SHA into
the runner's temporary directory before checkout. It isolates Git/npm/Docker/gh
state, provides a job-local npm prefix, asserts Node 22 and checks disk space.
The cleanup script itself does not depend on Node.

The collector uses the existing pre-installed Node preflight on self-hosted
runners and pins hosted `setup-node` to 22.22.3 before the validator. Native
compilation always uses Node 22.22.3. The collector remains architecture-free;
the Linux build legs retain their matching x64 or arm64 release-runner labels.

### Relationship to the release host switch

Audio reuse works with `ECS_RELEASE_HOST_RUNNER_ENABLED` either enabled or unset.
The decision happens in `prepare`. With the switch unset, the existing hosted
publisher builds and consumes the audio payload. When enabled, the ECS producer
consumes it before handing release outputs to the hosted publisher, which also
verifies the audio source and payload. npm publication remains hosted in both
cases, preserving the split already merged in #15832.

This change neither alters runner routing nor enables the switch. A cache hit
skips the native matrix; a miss follows the existing hosted/ECS routing.

## Validation

Fingerprint, provenance, retention and payload behaviour are covered by unit
tests with direct witnesses, including the retention boundary that motivated
the selection/consumption split. The workflow wiring — non-fatal lookup,
`outcome`-keyed acceptance, matrix skip, publisher re-verification, collector
ordering and the architecture-free label — is pinned by contract tests.
The latest review adds regression-sensitive wiring assertions and fixes the
retention test's clock; these additions await CI and were not run locally.

A branch release dry-run can verify the miss path, all five native payloads and
publisher consumption without publishing. Reuse provenance is checked at the
run level: repository, `head_branch`, event, workflow path and successful
conclusion. `head_branch` identifies the dispatch branch, not the built
`inputs.ref`. A run dispatched on a feature branch cannot seed an eligible
candidate; one dispatched on `main` with `inputs.ref` pointing at a feature
branch can. The fingerprint pins the audio build inputs, not the source
commit's membership in `main`. A successful eligible run must first retain a
keyed artifact; a later run with the same key can exercise reuse.
Record the switch state and actual runners used by each dry run. A hosted run
does not verify ECS execution, and a miss does not verify reuse.

## Affected files

`.github/scripts/audio-prebuilds.mjs`, the audio and release workflows, the
shared release-runner preflight it reuses, workflow tests under `scripts/tests`,
and the workflow size baseline.

## Open questions

Runner image updates under unchanged labels do not change the fingerprint.
N-API stabilises the Node ABI, not glibc or toolchain linkage, so this reuses a
verified binary rather than guaranteeing that a fresh build would be
bit-for-bit identical. Linux on hosted and ECS runners uses a versioned Bookworm container tag, not
an immutable image digest; macOS and Windows hosted images also continue to evolve. Pinning those
environments completely is outside this change.
