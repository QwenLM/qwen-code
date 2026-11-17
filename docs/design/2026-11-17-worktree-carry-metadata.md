# Worktree carry metadata: let the reaper exclude the carried overlay (R9-6)

- Status: proposed (first deliverable of #17237)
- Builds on: `2026-11-14-web-shell-codex-worktree-parity.md` (D3 dirty carry, D6 handoff, D7 snapshots)
- Tracks: #17237 "Carry metadata for the reaper (R9-6, deferred from #17228)"
- Related: #17228 review comments 6900008905 / 4579730709

## Problem

`createUserWorktree(..., { carryDirtyState: true })` copies the source
checkout's dirty overlay into the new managed worktree and returns the exact
overlay paths as `carriedPaths` (`gitWorktreeService.ts`,
`[...dirtyState.trackedFiles, ...createdUntracked]`). Two consumers already
use that set:

- the prepared-worktree cleanliness gate exempts exactly those paths
  (`exempt = new Set(carriedPaths ?? [])`) so a never-attached prepared
  worktree holding only the carried copy can still be finalized;
- the branch-worktree route persists it in the preparation journal
  (`branch-worktree-preparation.ts`), whose reader refuses oversized records.

But the set never reaches the **session sidecar** (`WorktreeSession` in
`worktreeSessionService.ts`) and is never consulted by the **orphan reaper**
(`worktree-orphan-cleanup.ts`). `executeWorktreeCleanup` gates preservation on
`worktreeHasWork(plan.lockKey)`, whose signature takes only a path. A session
worktree whose _only_ content is the carried overlay therefore reads as "has
uncommitted work" and is preserved forever instead of collected. Reproduced at
#17228 head `8bdb8bb549` (round-9 cell S8): `DELETE` → `204`, the checkout
survives, the sidecar names no `carriedPaths`.

The leak is fail-safe (a checkout preserved rather than deleted), which is why
#17228 deferred it; the fix widens the sidecar contract and is scheduled in
#17237.

## Decision

Record the carried overlay in the sidecar and let the has-work gate exempt it,
mirroring the prepared-worktree gate's exact-path exemption.

### D1 — Sidecar field

Add an optional `carriedPaths?: string[]` to `WorktreeSession`. Optional for
back-compat: sidecars written before the field existed (and worktrees created
without `carryDirtyState`) simply omit it, and readers treat absent as "no
recorded overlay" — the has-work gate then behaves exactly as today. The
runtime shape check (`isValidWorktreeSession`) accepts the field only when it
is an array of strings; a wrong-typed value corrupts the sidecar like any other
field. The existing 64 KiB sidecar cap already bounds the record; the creation
paths that carry bound the overlay with `maxCarriedPathsBytes`
(`CARRIED_PATHS_MAX_BYTES`) so the journal and the sidecar stay readable.

### D2 — Writers persist the overlay

Every creation path that calls `createUserWorktree` with `carryDirtyState`
records the returned `carriedPaths` in the sidecar it writes:

- `POST /session` (daemon default worktree),
- the branch-worktree route (`POST /session/:id/branch` with `worktree`),
- `EnterWorktreeTool`.

Relocation writes (handoff, reset) preserve an existing `carriedPaths` rather
than dropping it: the overlay still describes the checkout's carried content
until the session commits or cleans it. A writer that creates without carry
records nothing (absent), not an empty array, so "absent" and "carried nothing"
stay distinguishable from "carried these paths".

### D3 — The has-work gate exempts the recorded overlay

`worktreeHasWork` gains an optional second argument
`carriedPaths?: readonly string[]`. When it is absent or empty the predicate is
byte-for-byte the current behavior (the core retention sweep and canary callers
pass nothing). When present, the probe switches to file-level raw output
(`status --porcelain --untracked-files=all -z`, the same form the prepared gate
uses so untracked directories are not collapsed and non-ASCII paths are not
C-quoted) and waives an entry whose path is exactly in the carried set, in
addition to the existing session-marker / disposable-output / symlink waivers.
Any entry outside the carried set — a late-arriving ignored file, a nested
marker-like name, a tracked edit the session made after creation — still counts
as work and preserves the checkout. Rename/copy records refuse (the carry
applies the stash without `--index`, so the overlay never contains them; one
means the index was touched inside the worktree).

The exemption is exact-path, not prefix: a carried file `a/b.txt` does not waive
an unrelated `a/c.txt`, and a directory the session populated beyond the carried
files still reads as work. This matches the prepared gate's `exempt.has(p)`
geometry and keeps the waiver narrow.

### D4 — The reaper passes the sidecar's overlay

`executeWorktreeCleanup` calls
`worktreeHasWork(plan.lockKey, sidecar.carriedPaths)`. A carried-only checkout
now reads clean and is collected; a checkout with genuine session work is still
preserved. The core retention sweep (`worktreeCleanup.ts`) is left unchanged in
this deliverable — it does not have the session sidecar in scope today; wiring
it is part of P6 (D7), which reads the sidecar for snapshot-then-delete.

## Acceptance

- A session worktree whose only content is the carried overlay is collected by
  the orphan reaper after the session is deleted (regression reproducing S8:
  before the fix `DELETE` leaves the checkout; after, the checkout is removed).
- A checkout with any non-carried work (a tracked edit after creation, a
  late-arriving ignored file, a populated directory beyond the carried files)
  is still preserved.
- Sidecars without the field behave exactly as today (back-compat).
- A wrong-typed `carriedPaths` corrupts the sidecar (shape check).
- Mutation witnesses: dropping the reaper's `carriedPaths` argument, and
  widening the exemption to a prefix match, each kill a committed case.

## Out of scope (later #17237 phases)

- P6 retention + snapshot/restore (design D7): `worktree.maxRetained`,
  snapshot-before-delete, restore on reopen; the retention sweep reads the
  sidecar (and `carriedPaths`) there.
- P7 configurable worktree root (`worktree.root`).
