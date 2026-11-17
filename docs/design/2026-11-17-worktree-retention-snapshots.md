# Worktree retention + snapshot/restore (P6)

- Status: proposed (#17237, after the R9-6 carry-metadata deliverable)
- Builds on: `2026-11-14-web-shell-codex-worktree-parity.md` D7 (snapshots are
  work archives), D3 (dirty carry), and `2026-11-17-worktree-carry-metadata.md`
  (R9-6, the sidecar `carriedPaths` field).
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
  `dist`, `coverage`) is excluded only when git reports it ignored
  (`ls-files --others --ignored --exclude-standard -z`), so a tracked or
  non-ignored file under those names is work and is archived (verify finding
  F3). The `.git` file/dir and the session marker are always excluded. Uses the
  `tar` dependency already in core; paths are relative to the worktree root.
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

### U2 — `worktree.maxRetained` setting

Add `worktree.maxRetained` (number, default 15, `0` disables count-based
auto-deletion) to the worktree settings block (`settingsSchema.ts`), served to
Web Shell like `defaultForNewSessions`. Schema freshness gate + capabilities
envelope baselines updated (the pinned-baseline rule). i18n label/description.

### U3 — Archive/delete trigger: snapshot-then-delete

When a managed session worktree is removed by session archive/delete
(`executeWorktreeCleanup` and the archive flow), capture a snapshot (U1) before
removal, then remove regardless of dirty state — the snapshot preserves the
work. This lifts the `worktreeHasWork` refusal for **managed session
worktrees only**; tool/agent worktrees keep the existing refusal semantics.
The snapshot path is recorded so reopen can find it (U5). A capture failure
falls back to the current preserve behavior (fail-closed: never delete without
a durable snapshot).

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
- **Deletion** reuses the U3 path: build a `WorktreeCleanupPlan` and call
  `executeWorktreeCleanup` (snapshot-then-delete, fail-closed). The sweep itself
  takes the worktree ownership lock per candidate (`acquireWorktreeOwnershipOp`)
  so it cannot race a restore/reset.
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
(chat header / session overview). i18n.

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
