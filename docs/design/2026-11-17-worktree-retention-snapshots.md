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

A `WorktreeSnapshotService` (core) that captures a worktree to a self-contained
archive and restores it:

- **Capture** `captureSnapshot(worktreePath, header) -> snapshotPath`: a
  `tar.gz` of the worktree tree excluding the regenerable set
  (`DISPOSABLE_IGNORED_ROOTS` — `node_modules`, build output — the same set
  `worktreeHasWork` waives) and the `.git` file/dir and the session marker.
  Uses the `tar` dependency already in core. The archive stores paths relative
  to the worktree root. A JSON header rides alongside (or as the first archive
  entry): base commit (`worktreeBase`), HEAD commit, branch if any, dirty-state
  summary (tracked/untracked counts), session id, timestamp, schema version.
- **Restore** `restoreSnapshot(snapshotPath, targetWorktreePath)`: extract the
  archive over a freshly recreated worktree (detached at the recorded HEAD, or
  on the recorded branch). Restore is faithful to commits + dirty tracked +
  untracked content; it does not restore `node_modules` (regenerable).
- **Format stability**: the header carries a schema version; a reader refuses
  an unknown version rather than mis-restoring. Capture is atomic (stage to a
  temp file, rename) so a crash mid-capture never leaves a half-written archive
  that a later restore would trust.
- Fail-closed: a capture error rejects (the caller must not delete the worktree
  without a durable snapshot); a restore error rejects without partial state
  where feasible.

Tests: snapshot content + exclusions (no `node_modules`/`.git`/marker), restore
fidelity (committed + dirty tracked + untracked round-trip), atomic capture,
unknown-version refusal, capture-error rejection.

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

### U5 — Restore affordance on reopen

Reopening a chat whose worktree was deleted offers restore: a route recreates
the worktree (detached at the recorded HEAD or on the recorded branch), extracts
the snapshot (U1), flips the sidecar back. Web Shell surfaces the affordance
(chat header / session overview). i18n.

## Acceptance (P6 overall)

- Archiving a chat deletes its worktree after snapshotting; reopening offers
  restore; the sweep keeps the most recent 15 (default).
- A dirty managed session worktree is deleted after snapshot (no permanent
  preserve); the snapshot restores commits + dirty + untracked faithfully.
- Tool/agent worktrees keep the existing refusal semantics.
- Active/pinned worktrees are protected; `0` disables count-based deletion.

## Out of scope

- P7 configurable worktree root (`worktree.root`) — separate unit, security-
  sensitive containment/shell-guard re-derivation.
- Managed (server) sessions' own worktree design alignment (follow-up).
