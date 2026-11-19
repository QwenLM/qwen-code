# Worktree retention + snapshot/restore (P6)

[English](2026-11-17-worktree-retention-snapshots.md) | [简体中文](2026-11-17-worktree-retention-snapshots.zh-CN.md)

- Status: U1–U3 are implemented in this PR; U4/U5 remain tracked in #17237.
- Builds on: `2026-11-14-web-shell-codex-worktree-parity.md` D7 (snapshots are
  work archives), D3 (dirty carry), and `2026-11-17-worktree-carry-metadata.md`
  (R9-6, the sidecar `carriedEntries` field).
- Tracks: #17237 P6.

## Goal

Codex keeps the most recent managed worktrees and never loses work on cleanup:
archiving/deleting a chat snapshots its worktree before removal, reopening
offers restore, and a retention sweep keeps the most recent N. Today a managed
session worktree with dirty carried state is preserved forever by the
`worktreeHasWork` gate (R9-6 lets a _carried-only_ checkout be collected, but a
checkout with genuine session work still refuses deletion). P6 replaces that
refusal with snapshot-then-delete for managed session worktrees, so cleanup
preserves the work in an archive instead of stranding the checkout.

## Decomposition

P6 lands as five units on the #17237 branch; each is independently testable.

### U1 — Snapshot capture/restore service (core)

A snapshot service (`worktree-snapshot-service.ts`, core) that captures a
worktree to a self-contained archive and restores it:

- **Capture** `captureWorktreeSnapshot({worktreePath, snapshotDir, meta})`: a
  `tar.gz` of the worktree tree plus a JSON header beside it. The exclusion
  matches the has-work gate's _ignored-only_ geometry: a path under a
  regenerable directory name (`DISPOSABLE_IGNORED_ROOTS` — `node_modules`,
  `dist`, `coverage`) is excluded only when git reports it ignored, so a
  tracked or non-ignored file under those names is work and is archived
  (verify finding F3). The ignored entries are taken from the `!!` records of
  the gate's own `status --porcelain --ignored=matching -z` listing — the same
  command, so the two geometries cannot drift: a contents-matching rule
  (`packages/app/node_modules/**`) collapses one level deeper than
  `ls-files --directory` would, and a mismatch let the gate count work the
  archive then dropped (R6-1). The `.git` file/dir and the session marker are
  always excluded. Uses the `tar` dependency already in core; paths are
  relative to the worktree root.
  The header (`buildWorktreeSnapshotMeta`) records base commit (`worktreeBase`),
  HEAD commit, branch, dirty-state summary (tracked/untracked counts **and the
  list of deleted tracked paths**, including rename sources), session id,
  timestamp, schema version.
- **Restore** `restoreWorktreeSnapshot(snapshotPath, targetWorktreePath, meta)`:
  restore over a freshly recreated worktree (detached at the recorded HEAD, or
  on the recorded branch) without losing any archived content (verify finding
  F2), in three steps: (1) clear a conflicting HEAD target for each archived
  non-directory entry — node-tar replaces a file with a directory but not a
  directory with a file, so a dir→file replacement would otherwise silently drop
  the archived file; (2) re-apply the _pure_ deletions (paths absent from the
  archive) before extraction, so a deleted tracked file is not resurrected from
  HEAD — a deleted path the session recreated (present in the archive) is left
  for extraction to restore, and a deleted path that became a directory holds
  archived content and is left alone; (3) extract with `strict`, so a residual
  conflict fails loudly rather than silently dropping content. Restore is
  faithful to commits + dirty tracked + untracked content and to deletions; it
  does not restore ignored regenerable output, and it does not preserve index
  state (staged vs unstaged) — the contract is that no file content is lost.
  Paths are validated as safe relative paths, confined under the target root,
  and `.git`/the session marker are refused as deletion targets. A deleted path
  that is not valid UTF-8 makes `buildWorktreeSnapshotMeta` reject the capture
  (the caller preserves) rather than record a deletion that cannot be re-applied
  by name.
- **Format stability**: the header carries a schema version (currently 2); a
  reader refuses an unknown version rather than mis-restoring. Version 1 (no
  recorded deletions) is refused because it cannot faithfully restore a
  deletion. Capture is atomic (stage to a temp file, rename) so a crash
  mid-capture never leaves a half-written archive a later restore would trust.
  Each completed result carries `checkoutMatchesCapture`: capture compares
  actual tar bytes, owner-exec bits, symlink targets and HEAD/branch with the
  final checkout. When that flag is false, cleanup rejects removal while
  retaining both the completed archive and the late on-disk content. This
  catches an intermediate A/B/A file version even when the two external
  digests match. Any filesystem entry other than a regular file,
  directory or symlink (FIFO, socket, device and similar nodes) refuses capture
  rather than being silently omitted by node-tar. The repository's actual
  object format selects the matching SHA-1 or SHA-256 Git blob identity on
  both sides; unknown formats fail closed. Protected or unsupported tar
  entries make the result false instead of escaping through a parser callback.
  Only re-reading the private, locally generated archive disables the
  decompression-ratio cap that would reject valid highly compressible work;
  restore of external archives keeps its own limits.
- **Repository pinning + hardening**: capture and meta build first require the
  worktree's own `.git` (`fs.access`), so git cannot answer about an enclosing
  repository when the link is gone (verify finding F4); both run their git
  probes with `NO_EXEC_CONFIG` and `--no-optional-locks`, so a repository-configured
  `core.fsmonitor` hook is not executed (verify finding F5).
- Fail-closed: a capture error rejects (the caller must not delete the worktree
  without a durable snapshot); a restore error rejects without partial state
  where feasible.

Tests: snapshot content + ignored-only exclusions (tracked/non-ignored files
under `dist/` archived; ignored `node_modules` excluded; ignored non-disposable
work archived), restore fidelity (committed + dirty + untracked round-trip;
unstaged/staged deletion and rename source re-applied over a recreated HEAD),
atomic capture, unknown- and version-1 refusal, traversal-path refusal,
missing-`.git` capture rejection (no archive), and a `core.fsmonitor` exec canary.
Capture scans the real filesystem (tracking only `git status` would miss clean
tracked protected-path case variants) and refuses those variants before tar;
`ls-files -v` uses a 64 MiB capture buffer rather than truncating a large
index. Restore validates EVERY member lexically and through its nearest existing
parent, including Directory entries, before any removal or extraction; hardlink
targets must stay inside the root. A Directory member may replace a verified
tracked regular file: deeper realpath checks allow that explicit file/directory
boundary, and the file is removed only after every member has passed the guard.
Every planned file removal also resolves its final target: a nested Directory
member aliasing the top-level `.git` or session marker is refused before any
clearing, rather than trusting only the member's lexical path. Absolute and
parent-relative symlink targets
remain supported without treating a parent symlink as an extraction target:
archived symlinks are skipped during extraction and recreated only after all
other members, so an archive cannot materialize an escaping parent for a later
entry.

### U2 — `worktree.maxRetained` setting

Add `worktree.maxRetained` (number, default 15, `0` disables count-based
auto-deletion) to the worktree settings block (`settingsSchema.ts`). Schema
freshness gate updated; i18n label/description pre-added. The key is **declared
now but served/rendered/consumed when U4 lands**: the Web Shell settings drift
invariant requires every served key to have a rendered row, and the retention
sweep that reads the value is U4. Adding it to `WEB_SHELL_SETTINGS` before the
row and the consumer exist would break that invariant (and leave a setting
nothing reads), so U4 wires the allowlist entry, the UI row, and the sweep
together.

### U3 — Archive/delete trigger: snapshot-then-delete

When a managed session worktree is removed by session archive/delete
(`executeWorktreeCleanup` and the archive flow), capture a snapshot (U1) before
removal, then attempt removal — the snapshot preserves the dirty work, so the
`worktreeHasWork` refusal is lifted for **managed session worktrees only**;
tool/agent worktrees keep the existing refusal semantics. Archive takes the
coordinator lock before the worktree ownership lock, verifies ownership while
the sidecar is present, and after a confirmed move re-reads the archived
sidecar under that same lock. Cleanup proceeds only while it still names the
verified checkout; the chat record and archived sidecar survive. Delete
instead requires the ownership record to have been removed first. Removal is still
delegated to `removeUserWorktree`, which refuses a checkout carrying commits no
ref reaches (the default managed worktree is detached): in that case the
snapshot is written but the checkout is preserved (`unmerged commits`), so
"remove regardless of dirty state" holds for dirty content, not for unmerged
commits. A capture failure also falls back to preserve (fail-closed: never
delete without a durable snapshot); a state the snapshot cannot represent
faithfully — staged content differing from the worktree, a non-UTF-8 deleted
path, a staged edit or addition on a skip-worktree path, or a paused
merge/rebase/cherry-pick/revert/bisect — likewise refuses capture and preserves.
Removal is additionally conditional on the checkout still matching the captured
contents: before and after capture the reaper records each non-disposable
status path together with its status, raw-byte `hash-object --no-filters`
identity, and executable bit. It expands collapsed non-disposable ignored
directories and collapsed untracked nested repositories without following
links, and records symlink targets too. The first digest precedes the has-work
classification and carried-source verification. No
`git diff` runs, so textconv cannot execute. Disposable-output waivers apply
only to the original collapsed status entry: every child of a non-disposable
ignored directory counts because tar archives it. Marker temp waivers are
root-level only. An autosave rewriting bytes or retargeting a link mid-tar
therefore preserves instead of deleting work the archive could not cover. A
fresh pending-operation probe immediately before removal also refuses
operations launched after the metadata check, even when file bytes and HEAD
have not changed. The shared sparse-aware hidden-index probe runs just before
that pending probe: a late flag that hides a tracked edit from both digests
cannot authorize removal merely because their values match. A final
populated-gitlink probe also preserves a submodule initialized during capture:
its object store lives outside the checkout root and neither the archive nor
removal preserves it. The
sparse exemption uses `git sparse-checkout check-rules` to distinguish a
legitimate omission from an unexpected S hiding a deletion in an included
path. Exclusion alone is insufficient: a present S path may hide edited
bytes when `sparse.expectFilesOutsideOfPatterns=true` keeps status empty,
so only an actual absent path is exempt. Its leaf must be absent and its
nearest existing ancestor must be a directory. Other paths or probe
failures preserve the checkout. `ls-files` and `ls-files --stage` suppress
only the known sparse-index expansion advice, not other stderr. Path bytes
that cannot be recovered reliably from UTF-8 output also preserve, rather
than guessing an included or excluded spelling from replacement characters.
Each archive pair is uniquely named per capture
(`<sessionId>.<createdAt>.<pid>.worktree-snapshot.tar.gz`, header likewise) so
a reused session UUID can never overwrite an earlier snapshot; readers resolve
by the `<sessionId>.*.worktree-snapshot.*` prefix beside the sidecar (the chats
dir, or its `archive/` subdir for archived sessions — the reaper writes to the
sidecar's own directory), and a cleanup log line names the full path. The
reopen-restore affordance (U5) reads it back by that key.

### U4 — Retention sweep

A count-based sweep for managed session worktrees per repository: order by last
activity, keep the most recent `worktree.maxRetained`, snapshot-then-delete
(U3) oldest-first beyond the limit. Protect worktrees of active sessions and
pinned chats. `0` disables the count-based sweep. Distinct from the existing
age-based ephemeral agent sweep (`worktreeCleanup.ts`), which is unchanged.

Implementation notes (investigated):

- **Enumeration is sidecar-based, not `GitWorktreeService.listSessions`.** That
  static method enumerates the _legacy agent-session_ layout
  (`<baseDir>/<sessionId>/config.json` + `worktrees/`), not Web Shell session
  worktrees. The sweep must enumerate the session chats directory's
  `*.worktree.json` sidecars (the `WorktreeSession` records, via
  `SessionService.getWorktreeSessionPath` / the chats dir), filtered to the
  repository's managed root (`sidecar.originalCwd` / `worktreePath` containment).
- **Last activity** comes from the session record's updated timestamp (the
  persisted session metadata), not the worktree directory mtime; fall back to
  the sidecar/snapshot timestamp when the session record is gone. Sort
  descending, keep the first `maxRetained`, sweep the rest oldest-first.
- **Protection**: skip a worktree whose session is live on the bridge
  (`bridge.getSessionSummary` answers) or whose chat is pinned
  (session-organization `isPinned`). Active/pinned worktrees never count toward
  the deletion candidates.
- **Deletion** reuses the U3 snapshot-then-remove mechanics, but NOT
  `executeWorktreeCleanup` verbatim: that function's contract is "the session
  record and sidecar were already deleted" (the delete path). The sweep keeps
  the record and sidecar (the chat survives; only its worktree is reclaimed), so
  it needs a variant that snapshots, removes the checkout, and then records the
  removed-plus-snapshot state on the surviving sidecar (a `worktreeRemoved` flag
  plus the archive key) that U5 reads to offer restore. Calling the delete-only
  function unchanged would leave a sidecar naming a removed checkout with no
  record of the snapshot. The sweep takes the worktree ownership lock per
  candidate (`acquireWorktreeOwnershipOp`) so it cannot race a restore/reset.
- **Trigger**: a daemon periodic sweep (alongside the session reaper) reading
  `worktree.maxRetained` from the workspace settings; `0` short-circuits. Keep
  it fail-closed: any enumeration/read error skips the candidate, never deletes.
- Tests: count ordering keeps the most recent N, `0` disables, active/pinned
  protected, oldest-first snapshot-then-delete beyond the limit, enumeration
  error skips. Mutation: dropping the protection and dropping the count cap each
  kill a committed case.

### U5 — Restore affordance on reopen

Reopening a chat whose worktree was deleted offers restore: a route recreates
the worktree (detached at the recorded HEAD or on the recorded branch), calls
`restoreWorktreeSnapshot` (U1) to extract the archive and re-apply the recorded
deletions, then flips the sidecar back. Web Shell surfaces the affordance
(chat header / session overview). i18n. When multiple captures share a session
prefix, U5 must compare header `createdAt`, then archive `mtimeNs`, then the
full archive path lexicographically — never directory enumeration order. An
unreadable competing header refuses selection rather than silently picking an
older valid-looking archive.

## Acceptance (P6 overall)

- Archiving a chat deletes its worktree after snapshotting; reopening offers
  restore; the sweep keeps the most recent 15 (default).
- A dirty managed session worktree is deleted after snapshot (no permanent
  preserve); the snapshot restores commits + dirty + untracked content and
  tracked deletions faithfully. A session change to a carried path is
  snapshotted, never deleted bare (R9-6 content-aware gate).
- Tool/agent worktrees keep the existing refusal semantics.
- Active/pinned worktrees are protected; `0` disables count-based deletion.

## Out of scope

- P7 configurable worktree root (`worktree.root`) — separate unit, security-
  sensitive containment/shell-guard re-derivation.
- Managed (server) sessions' own worktree design alignment (follow-up).
