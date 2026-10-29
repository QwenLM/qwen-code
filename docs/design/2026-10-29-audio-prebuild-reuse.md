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

Every step that can fail on a cache miss is non-fatal, and the reuse ID is only
published after a _trial download and payload validation_ succeed:

- lookup API failure → no candidate
- fingerprint or temporary-directory failure → no key, so the native matrix runs
- download failure → acceptance skipped (keyed on `outcome`, since
  `continue-on-error` rewrites `conclusion`)
- payload validation failure → the step fails before writing the output

An empty reuse ID runs the full native matrix, which is today's behaviour. The
trial bytes are discarded and re-downloaded by the consumer, so the trial never
leaves state behind.

The publisher does not trust `prepare`'s decision: it recomputes the
fingerprint from its own checkout, re-verifies the source run, downloads by
artifact ID, and validates the payload again. That verification is fatal — by
then the native matrix was skipped, so a bad artifact must stop the release
rather than ship.

Validation checks exactly the five target directories, each containing only
nonempty regular `.node` files and no symlinks. It is a shape check, not a
platform check; the provenance and digest checks above carry the trust.

### Collector hygiene

The collector merges per-platform artifacts on a possibly persistent workspace,
where `download-artifact`'s `merge-multiple` merges into existing paths, so a
stale `prebuilds/` tree would leak into the artifact it uploads.

It now wipes through the shared release-runner preflight, which canonicalises
the workspace and refuses paths resolving through a symlinked component or
outside the runner workspace. The subtree `rm -rf` it replaces resolved through
whatever `packages` happened to be on the host: with a leftover symlink it
deleted an external tree and exited 0, and the following download wrote through
the same symlink.

The existing release workflow wipe anchor calls the same action, so workspace
containment and Git/npm/Docker/gh state isolation have one implementation. The
action downloads that script at the workflow SHA into the runner's temporary
directory before checkout; it never executes a stale workspace copy. Node setup
and the existing disk-floor gates remain separate from workspace cleanup.

The collector now uses the existing pre-installed Node preflight on self-hosted
runners and pins hosted `setup-node` to 22.22.3 before the validator. Native
compilation always uses Node 22.22.3. Workspace cleanup itself requires no Node
and adds no stricter version gate than the existing self-hosted preflight.

Its release-only label drops the `x64` component: the runners carrying
`ecs-qwen-release-host` are ARM64, and an architecture component in that label
does not fall back to hosted — it never matches, and the job queues until
timeout.

### Relationship to the release host switch

None of this depends on `ECS_RELEASE_HOST_RUNNER_ENABLED`. The reuse decision
happens in `prepare`, which already runs on its own pool, and the consumer is
the existing publisher. The switch stays unset and this change takes effect
anyway.

Publisher runner routing is unchanged, including its existing `x64` label.
The isolated build lane and hosted npm publication boundary belong to #15832;
this PR does not establish that enabling that lane is safe.

## Validation

Fingerprint, provenance, retention and payload behaviour are covered by unit
tests with direct witnesses, including the retention boundary that motivated
the selection/consumption split. The workflow wiring — non-fatal lookup,
`outcome`-keyed acceptance, matrix skip, publisher re-verification, collector
ordering and the architecture-free label — is pinned by contract tests, each
confirmed to fail against an injected regression.

Not covered locally: a real Actions run, so the first live reuse is a miss that
seeds the keyed artifact, and the first hit happens on the release after it.

## Affected files

`.github/scripts/audio-prebuilds.mjs`, the audio and release workflows, the
shared release-runner preflight it reuses, workflow tests under `scripts/tests`,
and the workflow size baseline.

## Open questions

Runner image updates under unchanged labels do not change the fingerprint.
N-API stabilises the Node ABI, not glibc or toolchain linkage, so this reuses a
verified binary rather than guaranteeing that a fresh build would be
bit-for-bit identical. A pinned build container would close that gap and is out
of scope here.
