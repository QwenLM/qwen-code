# Worktree carry metadata: let the reaper exclude the carried overlay (R9-6)

[English](2026-11-17-worktree-carry-metadata.md) | [简体中文](2026-11-17-worktree-carry-metadata.zh-CN.md)

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

Record the carried overlay in the sidecar **with its carry-time content
identities**, and let the has-work gate waive a carried path only while its
current state still matches that identity. A path-only exemption (the prepared
gate's geometry) is unsafe for an _attached_ session worktree: the session keeps
working after creation, so a further edit, stage, or delete of a carried path is
new work the source checkout does not hold, and path equality alone cannot tell
it from the original carried copy. This was measured as a data-loss path by the
independent `/verify-pr` round on #17533 (finding F1) and is the reason the
sidecar records identities, not just paths.

The prepared-worktree gate (`removePreparedUserWorktree`) keeps its path-only
exemption unchanged: a prepared worktree is never attached, and its
`atBase`/`checkoutMatches` gates prove no session work happened, so the same
geometry is safe there. `createUserWorktree` therefore returns both
`carriedPaths: string[]` (for the preparation journal / prepared gate) and
`carriedEntries: CarriedEntry[]` (for the session sidecar / managed gate).

### D1 — Sidecar field

Add an optional `carriedEntries?: CarriedEntry[]` to `WorktreeSession`, where
`CarriedEntry = { path: string; hash: string | null; executable: boolean }`.
`hash` is the raw on-disk blob hash of the carried content (`git hash-object
--no-filters`); `hash === null` records a carried deletion (the carry removed the
path); `executable` is the carried file's exec bit so a mode-only change is
detectable. Non-regular carried entries (symlinks, directories) get no content
identity: a carried untracked symlink falls to the general symlink waiver (it
holds no data in this checkout), while any other non-regular carried entry reads
as work, the conservative direction.

Optional for back-compat: sidecars written before the field existed (and
worktrees created without `carryDirtyState`) omit it, and readers treat absent as
"no recorded overlay" — the has-work gate then behaves exactly as today. The
runtime shape check (`isValidWorktreeSession`) accepts the field only when every
entry has a string `path`, a `string | null` `hash`, and a boolean `executable`;
a wrong-typed value corrupts the sidecar like any other field. The 64 KiB sidecar
read cap bounds the record: because the identities enlarge the overlay, a writer
(`fitSidecarToReadCap`) drops `carriedEntries` when the serialized record would
exceed the cap, so the binding stays readable instead of being orphaned — the
reaper then treats the overlay as work and snapshots it (the safe direction); the
carry itself is untouched. The journal-backed creation path still bounds the
overlay with `maxCarriedPathsBytes` (`CARRIED_PATHS_MAX_BYTES`).

A companion `carriedFrom?: string` records the checkout the overlay was carried
FROM when it differs from `originalCwd`: the branch-worktree route and the
handoff capture the session's own checkout (`dirtyStateSource`), which a `/cd`
into a sibling checkout makes differ from the workspace root that `originalCwd`
must keep naming for the ownership-checked routes. The reaper's source-side
check (D4) reads `carriedFrom ?? originalCwd`; verifying `originalCwd` when the
two differ could authorize deleting the overlay's last copy (R5-14). The two
routes record it unconditionally (it may equal `originalCwd`); `POST /session`
and legacy sidecars omit it, and the fallback names the right checkout there.
A non-string value corrupts the sidecar like any other field. Relocation writes
preserve it with the rest of the sidecar.

### D2 — Writers persist the overlay

Every creation path that calls `createUserWorktree` with `carryDirtyState`
records the returned `carriedEntries` in the sidecar it writes:

- `POST /session` (daemon default worktree),
- the branch-worktree route (`POST /session/:id/branch` with `worktree`),
- the handoff (`to=worktree`).

`EnterWorktreeTool` also creates worktrees but never enables `carryDirtyState`,
so it is a no-carry writer and records nothing. The branch-worktree route and
the handoff additionally record `carriedFrom` (their `dirtyStateSource`
checkout); `POST /session` carries from its own root, which `originalCwd`
already names, so it records no `carriedFrom`.

`createUserWorktree` computes the identities right after the carry applies
(`computeCarriedIdentities`: absent paths become null-hash deletions, regular
files are hashed in batches). A computation failure leaves `carriedEntries`
absent — the gate then treats the overlay as work and snapshots it — without
affecting `carriedPaths`, which the prepared rollback still uses. Relocation
writes (handoff, reset) preserve an existing `carriedEntries` rather than dropping
it. A writer that creates without carry records nothing (absent), not an empty
array.

### D3 — The has-work gate waives only pristine carried content

`worktreeHasWork` gains an optional second argument
`carriedEntries?: readonly CarriedEntry[]`. Before either probe, the shared
predicate refuses hidden index bits (`hasHiddenIndexBit`, `ls-files -v`), so the
default no-carry path (core retention sweep, legacy sidecars, no-carry creations)
is protected too. assume-unchanged (lowercase tag, never set by sparse-checkout)
always refuses; skip-worktree (`S`) refuses only when `core.sparseCheckout` is
not enabled — sparse-checkout legitimately stamps `S` on every out-of-cone path,
so refusing it unconditionally would strand every worktree of a sparse repository
(the prepared-worktree gate applies the same carve-out). When `carriedEntries` is
present, the probe is a single collapsed `status --porcelain
--untracked-files=all --ignored=matching -z` (non-ignored untracked files stay
file-level so a carried path matches exactly; ignored entries collapse to
directories, the base predicate's geometry, so a large `node_modules` does not
enumerate file-level and overflow the capture buffer) and computes the carried
paths' _current_ identities once. A carried entry is waived only when
`carriedEntryMatches` holds:

- carried content (`hash !== null`): status is exactly ` M` (unstaged tracked
  edit) or `??` (untracked), the path is a regular file, and its current blob
  hash and exec bit equal the carried ones;
- carried deletion (`hash === null`): status is exactly ` D` (unstaged deletion)
  and the path is still absent.

Any other state of a carried path — staged (`M `, `A `, `D `), a deletion of
carried content, a restored carried deletion, a symlink replacement, or any
content/mode drift — is new work and preserves the checkout (the reaper snapshots
it). Rename/copy records refuse outright. Non-carried entries keep the existing
session-marker / disposable-output / symlink waivers. The exemption is exact-path,
not prefix. The content comparison uses `git hash-object --no-filters` (with a
`--` separator so a dash-leading path is not parsed as an option) at both carry
and cleanup, so the identity is the RAW on-disk blob hash. `--no-filters` is
deliberate: the path's clean filter (`eol`/`text` normalization) could otherwise
normalize an edit away, making a changed carried file hash identically and read
pristine — the data-loss path this avoids (R4-1/R5-5). A mode-only change is
caught by the exec-bit field. Every carried entry is also verified against its
current identity even when `git status` does not list it (a carried untracked
file the session deleted leaves no status record, R5-8). A pristine carried-only
checkout is collected without an archive only while the source checkout still
holds the overlay content-for-content; otherwise it is snapshotted (R5-2).

### D4 — The reaper passes the sidecar's overlay

`executeWorktreeCleanup` calls
`worktreeHasWork(plan.lockKey, sidecar.carriedEntries)`. A pristine carried-only
checkout reads clean; before collecting it without a snapshot the reaper also
verifies the carry SOURCE checkout (`sidecar.carriedFrom ?? sidecar.originalCwd`)
still holds the overlay content-for-content, and snapshots instead when it does
not or cannot be read (R5-2/R5-14). A checkout with genuine session work —
including a session change to a carried path — reads as work and is snapshotted
then deleted (P6 U3). The core retention sweep (`worktreeCleanup.ts`) is
unchanged in this deliverable.

## Acceptance

- A session worktree whose only content is the pristine carried overlay is
  collected by the orphan reaper after the session is deleted (regression
  reproducing S8).
- A pristine carried-only checkout is snapshotted instead when the carry source
  no longer holds the overlay or cannot be read — including when the source is
  a sibling checkout recorded in `carriedFrom` while `originalCwd` (the decoy)
  still matches the carry-time identities (R5-2/R5-14).
- A session change to a carried path is snapshotted, not deleted bare: staging a
  carried edit, deleting a carried file, a further unstaged edit of a carried
  tracked or untracked file, and a mode-only change each read as work (F1 cells).
- A pristine carried deletion reads clean; restoring or staging it reads as work.
- A session edit hidden under assume-unchanged or skip-worktree reads as work.
- A checkout with any non-carried work (a late-arriving ignored file, a populated
  directory beyond the carried files) reads as work and is snapshotted then
  deleted (P6 U3) — never deleted bare. States the snapshot cannot represent
  faithfully (staged content differing from the worktree, a hidden index bit, an
  initialized submodule) refuse capture and preserve the checkout instead.
- Sidecars without the field behave exactly as today (back-compat).
- A wrong-typed `carriedEntries` corrupts the sidecar (shape check).
- Mutation witnesses: dropping the reaper's `carriedEntries` argument, widening
  the exemption to a prefix match, and dropping the content-identity comparison
  each kill a committed case.

## Out of scope (later #17237 phases)

- P6 retention sweep (U4) and restore-on-reopen (U5), design D7: the
  count-based `worktree.maxRetained` sweep and the affordance that reads the
  snapshot back. Snapshot-before-delete (U3) **ships in this PR** (D4); the
  sweep and the restore reader are the remaining P6 units. Until U5 lands, the
  archive is keyed by `sessionId` beside the sidecar (the chats dir, or its
  `archive/` subdir for archived sessions) and named in the cleanup log; until
  U4 lands, nothing prunes it.
- P7 configurable worktree root (`worktree.root`).
