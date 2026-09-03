# E2E: build once, unpack on every leg

Design note for the `build` job in `.github/workflows/e2e.yml`: one hosted
runner builds and bundles the commit, and the eleven test legs download the
result instead of each rebuilding it.

## Context

Every leg of the E2E workflow — six Linux shards on the shared ECS pool, two
macOS shards, the OpenTUI interactive leg and two nightly isolated legs — ran
`npm ci`, `npm run build` and `npm run bundle` on its own runner before
touching a test. On a hosted VM that is 4–8 minutes; on a busy pool host the
build step alone took 10–17 minutes (run 33718808438: 10–17 minutes of build
before 12–39 minutes of tests). The six pool shards therefore spent more of the
shared hosts rebuilding one commit than testing it, and E2E was 11% of the
pool's slot-minutes over a 21-hour sample. Each push to `main` starts a fresh
run, so this repeats many times a day.

## Decision

- A `build` job on `ubuntu-latest` installs (with `QWEN_SKIP_PREPARE=1`),
  builds, bundles, and packs the outputs with
  `.github/scripts/e2e-build-pack.sh`: the bundle (`dist/`), every workspace
  `dist/` under `packages/` and `integrations/` (node_modules pruned), and an
  `e2e-build.sha` stamp of the commit. The archive is one gzip tarball
  uploaded as the `e2e-build` artifact with one day of retention.
- Every leg gains `needs: [build]`, keeps its own `npm ci` (node_modules,
  native modules, and the `generate` step that `prepare` still runs), and
  replaces its build and bundle steps with a download plus
  `.github/scripts/e2e-build-unpack.sh`, which refuses an archive stamped with
  a different commit and checks that `dist/cli.js` arrived.
- The docker sandbox image is unchanged: it builds inside Docker from the
  checkout under the per-host locks, so it is not part of the archive.
- The build job carries the same fork gate as the legs, so a skipped build
  skips them for the same reason instead of failing them on a missing
  artifact.

## Why a hosted builder

The build is platform-independent JavaScript; the platform-specific parts are
native modules that each leg's own `npm ci` installs. A hosted VM builds it in
about four minutes with no pool contention, and the ECS legs then pay a
download rather than a build. Building on the pool would put the one job the
whole run waits on behind the same queue that made the legs slow.

## Measured locally

- The archive from a build of `a8248eaed3` is 85 MB gzip-compressed, 14,408
  files; packing takes 16 s.
- A clean worktree at the same commit, installed with `QWEN_SKIP_PREPARE=1`
  (no `dist/` anywhere), unpacks it and runs the no-AK integration gate from
  the restored bundle. The unpack step refuses an archive whose stamp does not
  match `GITHUB_SHA` and extracts nothing.
- `.github/scripts/e2e-build.test.mjs` covers the pack and unpack contracts
  (workspace dist/ selection, node_modules pruning, mode preservation, stamp
  check) and runs in the CI helper-test step.

## Alternatives considered

- **Uploading the directories with `upload-artifact` directly.** The artifact
  store does not keep file modes and would upload 14k objects per run; a
  tarball is one object and keeps modes.
- **A host-shared build cache on the pool.** Rejected earlier (#10129) for the
  shared mutable state it introduces between concurrent jobs on one host.
- **Only wiring the six Linux shards.** The macOS, OpenTUI and nightly legs
  build the same JavaScript, so they consume the same archive; leaving them
  out would keep three more builds per run for no gain in signal.

## Follow-ups

- Trim the archive to the workspace `dist/` trees the tests actually resolve
  if download time on the pool turns out to matter.
- Cancel superseded runs on `main` once the queue is enabled, so a burst of
  merges builds and tests only the newest commit.
