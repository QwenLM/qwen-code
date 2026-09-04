# Channel Named Sessions: Part 4B

## Status

Proposed. Parts 1, 2, 3A, 3B, and 4A are merged. This design is the final
planned delivery for issue #10103. It enables conversation reset for
worktree-isolated tasks and resolves the review findings whose dispositions
point at this part. The disposition of every standing Part 4A finding —
including the ones this part does **not** absorb — is recorded in
"Disposition of standing Part 4A findings" below; issue #10103 closes only
when those dispositions are also satisfied.

Part 4A landed in #10643 (merge commit `37cb9ac161`). Its design deferred
selected-task reset for worktree tasks to this part. The Part 4A exit
criterion opens with a start gate — "Part 4B may start only after Part 4A
proves exact creation and restart recovery" — and then requires:

> Its design must define an atomic or compensatable daemon operation that
> creates a fresh conversation while retaining the selected task's exact
> verified worktree, transfers marker/sidecar ownership safely, does not
> delete files, and fails closed on active, stale, foreign, ambiguous, or
> partial state.

The start gate was judged passed when Part 4A merged under human approval,
backed by the reviewer-run real-daemon verification on #10643 (Reviewer Plan
15/15, tamper matrix 17/17). This design satisfies the six transfer
requirements element by element. It also deletes nothing: the one destructive
candidate identified during this design's review (orphan-reap worktree
cleanup) was moved out to follow-up issue #11024, keeping this part's
contract literally "no deletion".

## Decision

Enable `/clear`, `/new`, and `/reset` for a selected worktree task. Resetting
a worktree task keeps its exact daemon-attested worktree — every file,
including uncommitted changes — and replaces only the conversation with a
fresh daemon session.

The primitive is a new daemon route:

```text
POST /session/:id/worktree-reset
```

Given an existing worktree-owning session (`S_old`), the daemon validates its
ownership chain under a worktree-keyed serialization lock, arms a
reset-pending barrier so no prompt can start on `S_old` mid-transfer, spawns
a fresh session (`S_new`) in the same registered root workspace, relocates
`S_new` into the same worktree, writes a new sidecar for `S_new`, marks the
old sidecar superseded, re-verifies quiescence, and flips the in-worktree
ownership marker from `S_old` to `S_new` last — with an atomic
compare-and-swap, never a blind overwrite. Only then does it attest
`worktreeState: "persisted-v1"` for `S_new`. The response payload has the
same shape as the Part 4A create/load response, so the Channel worker
validates it through the existing exact-identity chain.

The old session is never deleted by reset. Its transcript and persisted
record remain in the daemon catalog, and its superseded sidecar makes any
later restore of `S_old` fail closed with a typed `worktree_session_superseded`
signal carrying the replacement session ID, which lets the Channel registry
self-heal if a crash interrupted a committed reset.

The daemon advertises a new capability `session_worktree_reset_v1`; the
worker checks it before sending a reset request, exactly as Part 4A gated
creation on `session_worktree_persistence_v1`.

This part resolves these findings from the #10643 review record:

1. Missing-marker recovery (yiliang114 on `session.ts:4189`; chiga0 F1; and
   the review bot's R3-2, the standing Critical carried from round 1):
   restore distinguishes a missing marker from a tampered one, and reset is
   the sanctioned recovery path — the transfer recreates the marker only
   when the remaining chain proves ownership.
2. Deferred-prompt restore attestation (yiliang114 on `session.ts:4201`;
   chiga0 F2/R1-2): the under-attesting `hasUnlocatedRestoredPrompt` branch
   is removed so the genuinely-active-prompt shape fails closed through the
   existing active-session check. See "Deferred-prompt restore attestation"
   for why relocation is not the fix — the first revision of this document
   proposed relocating there, and review showed that premise was inverted.
3. Deferred restore-prompt visibility (R8-2, `bridge.ts:8462`): a parked
   deferred restore prompt sets neither `promptActive` nor any pending
   interaction, so it is invisible to `hasActivePrompt` and
   `pendingInteractionCount`. That invisibility affects both the
   coalesced-restore waiter (R8-2's report) and this part's quiescence check;
   the bridge surfaces the deferred state and both consumers are fixed
   together here.

Re-scoped during this design's review, with reasons recorded in
"Disposition of standing Part 4A findings":

- Orphan-reap worktree cleanup (yiliang114 on `session-archive.ts:656`,
  deferred to Part 4B on #10643) moves to follow-up issue #11024. It is the
  only file-deleting path in the series; its correct placement raised a
  protocol interaction with reset itself (a freshly transferred `S_new`
  legitimately satisfies every cleanup condition during the exact window the
  superseded redirect exists to heal); and nothing about `/clear` needs it.
- The create-rollback orphan (R8-1), the reattach-guard heal (R8-3), the
  exclusive-create empty-file leak (R1-1), and the `/session new --worktree`
  parser wart (F3) are live defects in `main` that do not depend on the
  transfer protocol; they are fixed directly in this PR (code and tests)
  rather than waiting for a follow-up.

## Goals

1. `/clear`, `/new`, and `/reset` on a selected worktree task produce a fresh
   conversation in the same verified worktree, with no file deletion
   anywhere in this part.
2. Ownership transfer is compensatable: every crash window either leaves the
   old session authoritative or is completed by an idempotent retry or a
   typed superseded redirect. No window strands the task.
3. A missing ownership marker is recoverable through reset; a tampered marker
   is never recovered automatically.
4. Reset refuses a task that is running, waiting for permission, or parked
   on a recovered question, with an actionable message; the daemon enforces
   quiescence as a barrier, not a point-in-time sample.
5. Resolve the in-scope review findings above without weakening any Part 4A
   fail-closed boundary.
6. Keep shared tasks, disabled `multiSession`, and all Part 2/3 behavior
   unchanged.

## Non-goals

- Deleting any file, directory, worktree, or branch. The orphan-reap
  cleanup and the sibling `POST /sessions/delete` worktree leak are tracked
  in follow-up issue #11024.
- Deleting a task or its registry record. Task purge is a separate feature;
  names of closed tasks remain occupied, as in Part 2.
- Automatic merge-back, push, rebase, or conflict resolution for worktree
  branches.
- Copying uncommitted root-checkout changes anywhere.
- Named worktrees for standalone Channels, webhooks, loops, group history,
  or non-`user` session scopes.
- Resetting a running or permission-pending task. The user cancels first.
- Changing Part 3 labels, permission correlation, cancellation, registry
  schema (stays version 1), transcripts, or audit hashes.
- The R8-1 create-rollback orphan fix, the R8-3 reattach-guard heal, the
  R1-1 marker-create leak fix, and the F3 parser fix — all land separately
  (see the disposition section).

## Verified baseline (from Part 4A)

- `POST /session` with `worktree: {}` creates a user worktree below the
  repository's managed root, spawns a session at the root, relocates it with
  `changeSessionCwd` under server-derived `allowedRoots`, creates the marker
  with `createWorktreeSessionMarkerExclusive`, persists the sidecar with
  `workspaceCwd`, and attests `persisted-v1` only after all three succeed
  (routes/session.ts creation branch).
- Restore re-validates strictly: sidecar `workspaceCwd` must realpath-match
  the route's root, `originalCwd` must be the root or repo top-level, the
  worktree path must be contained below a managed root, and the strict marker
  read must be `valid` and name the restored session ID. Failure is
  non-destructive: the just-attached client is detached or zero-attach-killed;
  transcript, sidecar, marker, branch, and worktree are retained.
- The Channel manager rejects worktree reset inside `reset()` before any
  `ChannelBase` cleanup side effect, with
  `Task "<name>" uses a worktree and cannot be cleared or reset yet. ...`.
- `SessionRouter.validateManagedSessionIdentity` is the Channel-side gate:
  it requires `worktreeState === 'persisted-v1'`, worktree metadata with an
  absolute path distinct from the root, and an exact match against the
  expected task cwd when given.
- The marker is `.qwen-session` at the worktree root, content is the owning
  session ID, created with `O_EXCL | O_NOFOLLOW` plus inode pinning, read
  with the strict no-follow reader (`readWorktreeSessionMarkerStrict`), and
  git-ignored through the repository's common `info/exclude`.
- The sidecar is a per-session JSON file in daemon session storage
  (`sessionService.getWorktreeSessionPath(sessionId)`), holding `slug`,
  `worktreePath`, `worktreeBranch`, `originalCwd`, optional `workspaceCwd`,
  `originalBranch`, `originalHeadCommit`; the strict reader returns
  `missing | valid | invalid` without collapsing corruption into absence.
- `deleteDaemonSessionIfOrphan` removes the persisted session record when the
  session is provably orphaned, but never touches the worktree or branch —
  the leak yiliang114 flagged. Its sibling `deleteDaemonSessions` (the
  `POST /sessions/delete` path) shares `deletePersistedSessionWithLease` and
  has the same leak.
- A deferred restore prompt is parked in
  `entry.deferredRestoreAskUserQuestionPrompts` and sets neither
  `promptActive`/`goalTurnActive` nor any entry in `pendingInteractions`, so
  `getSessionSummary`'s `hasActivePrompt` and `pendingInteractionCount` both
  read it as quiescent. The same invisibility exists in the coalesced-restore
  waiter branch (R8-2).
- The restore _response_'s `hasActivePrompt` is a separate computation from
  the summary's: `restorePromptAdmitted || promptActive || goalTurnActive`.
  The restore route reads that response object, not `getSessionSummary`. The
  distinction matters for this part because a parked prompt must keep reading
  `false` there — see "Deferred-prompt visibility".
- The restore route's `hasUnlocatedRestoredPrompt` branch (active prompt, no
  attachment, no recorded cwd) is therefore **not** the deferred-prompt
  shape: a parked prompt reads `hasActivePrompt: false` and flows through
  the `else` branch, which already relocates and attests `persisted-v1`. The
  branch is entered only when a cold-restored session genuinely has a live
  prompt — where `changeSessionCwd` chains onto the prompt queue and throws
  `CdWhilePromptActiveError`. The branch sets worktree metadata but skips
  relocation and never assigns `worktreeState`, so the Channel-side identity
  check fails on the next selection — chiga0 F2, with the branch's actual
  shape corrected per review.
- `/session new --worktree` without a name falls through to
  `create('--worktree', 'shared')`, which the name validator rejects with a
  misleading message — chiga0 F3. (The claimed silent shared-task creation
  does not occur; `TASK_NAME_PATTERN` rejects a leading hyphen. Only the
  message is wrong.)
- `acquireWorktreeRestore` is keyed per bridge instance (a `WeakMap`) and per
  session ID, and today covers only the deferred-prompt restore shape; the
  ordinary Part 4A worktree restore takes no such lock.
- `packages/core/src/utils/atomicFileWrite.ts` already provides
  `atomicWriteFile` with `noFollow: true` (an atomic replace that substitutes
  a regular file for whatever occupies the path, never following a swapped-in
  symlink), `renameWithRetry` (EPERM/EACCES backoff for Windows),
  `flush`, and an `assertCanCommit` hook invoked immediately before the
  rename commit.
- Two `atomicWriteFile` paths do **not** go through that rename, and both
  matter for a marker: an ownership-preserving fast path that writes the
  existing target in place — non-atomic, and symlink-following at write time —
  when the target's `uid` differs from the process's effective uid, and an
  `EXDEV` fallback that unlinks before an exclusive create. The `assertCanCommit`
  hook is synchronous (`() => void`), so it cannot await the async strict
  marker read.

## Disposition of standing Part 4A findings

Part 4A merged on a `land-with-residual-risk` recommendation under the
repository's five-round rule, so review findings stood at merge. Their
dispositions — none is silently dropped:

| Finding                                                                                                                                            | Shape                                                                                                | Disposition                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R3-2 / chiga0 F1 + yiliang114 (missing marker bricks the task)                                                                                     | restore fails closed with no recovery path                                                           | **This part**: typed `worktree_marker_missing` restore signal plus marker recreation through reset                                                                                                     |
| chiga0 F2 / R1-2 + yiliang114 (under-attested active-prompt restore)                                                                               | branch never attests `persisted-v1`                                                                  | **This part**: the branch is removed so the shape fails closed (see "Deferred-prompt restore attestation")                                                                                             |
| R8-2 (deferred prompt invisible to the coalesced restore)                                                                                          | waiter hangs or 500s a healthy session                                                               | **This part**: the bridge surfaces deferred restore-prompt state; the coalescer and this part's quiescence both consume it                                                                             |
| R8-1 (create rollback `!spawnCompleted` gate orphans the worktree)                                                                                 | permanent orphan when post-spawn cleanup is inconclusive                                             | **This PR**: the post-spawn failure block removes the unowned checkout regardless of the orphan-delete outcome, and the code comment states why that block differs from its two neighbours (see below) |
| R8-3 (reattach guard misreads a legitimately exited worktree)                                                                                      | permanent "lost durable worktree identity" loop after `exit_worktree` + restart                      | **This PR**: reattach heals on a resume response carrying no `worktree` object and keeps failing closed on a contradictory attestation, with a regression test                                         |
| R1-1 (exclusive marker create leaks an empty file on write failure)                                                                                | path wedged with `EEXIST`                                                                            | **This PR**: the exclusive create unlinks its own file on failure, with a regression test                                                                                                              |
| F3 (`/session new --worktree` without a name)                                                                                                      | misleading name-validation message                                                                   | **This PR**: the parser returns the usage line, with a regression test                                                                                                                                 |
| yiliang114 reap-path leak (`session-archive.ts:656`)                                                                                               | orphan session deletion leaks worktree + branch                                                      | **Follow-up issue #11024** (see below), not this part                                                                                                                                                  |
| `SessionRouter.ts:487` (generic load paths feed the persisted worktree cwd to the daemon; cold-start `restoreSessions` drops worktree-task routes) | deferred Critical, fails-closed, new-surface; its full text is truncated in the #10643 review record | **Follow-up issue #11024**, investigated there first because its truncated record must be reproduced before it can be designed against                                                                 |

The R8-1 row needs one distinction spelled out in this PR's code comment,
because the create route deliberately does the opposite two blocks away:
relocation failure removes the checkout "only when the session was
definitively removed" (a bridge timeout is caller-facing; relocation may
still land), and the post-relocation persistence failure preserves on an
inconclusive delete and logs it. The outer catch is different in kind, not a
relaxation of that rule: under `!spawnCompleted` no session exists, so
nothing can own the checkout, whereas both inner handlers may still have a
live session inside it.

Issue #11024 (the follow-up for the last two rows) also carries the
reap-cleanup requirements gathered during this design's review, so they
survive contact with implementation there rather than being re-derived:

- Place the deletion at the reap call site, as the create route does, never
  inside the shared `deleteDaemonSessionIfOrphan` primitive — the primitive's
  other call sites (ACP dispatch rollback, scheduled-task keepalive, this
  part's own reset rollback) must not be armed.
- Gate on `kind === 'removed'` (equivalently `mutationApplied`), not
  `!== 'error'`: the `notFound` shape means nothing was deleted.
- Refuse when the sidecar carries `supersedes`/`supersededBy` or when any
  other session's sidecar names the same worktree path — a freshly
  transferred replacement satisfies the naive ownership bar during exactly
  the window the superseded redirect exists to heal.
- Treat a superseded predecessor as the expected post-reset state and skip it
  without an operator log line, so the preserve-and-log signal keeps its
  meaning.
- Keep `removeUserWorktree`'s safe-delete default: never pass
  `forceDeleteBranch`, and log the `branchPreserved` outcome so "worktree
  removed, branch kept" is distinguishable from "worktree kept, ownership
  ambiguous".
- Require the ownership chain (strict-valid sidecar for this runtime, strict
  marker naming exactly the removed session, containment) plus a clean
  `git status --porcelain`; preserve and log on any doubt.
- Decide explicitly whether the sibling `POST /sessions/delete` path should
  gain the same cleanup; it leaks identically today.

## User-visible contract

### Resetting a worktree task

With a worktree task selected:

```text
/clear   →  Task "feature-a" reset with a fresh conversation. Its worktree
            files were kept.
```

`/new` and `/reset` behave identically, as they do for shared tasks. The task
keeps its name, its position in `/sessions`, and its exact worktree; the next
message starts a fresh conversation in that worktree.

Reset of a worktree task that is running, waiting for permission, or parked
on a recovered question fails before any side effect:

```text
Task "feature-a" is still running or waiting for permission. Cancel it with
/session cancel, then clear it again.
```

This is a deliberate difference from shared tasks, where `/clear` cancels an
in-flight turn. Transferring worktree ownership while a prompt may still be
executing in that directory is unsafe; cancellation first is the safe order.
The Part 4A rejection message is removed.

### Recovery through reset

When a worktree task's ownership marker is missing — the crash window between
relocation and marker write, or a task-local `git clean -fdx` — selecting or
messaging the task keeps failing closed, but with an actionable message:

```text
Task "feature-a" cannot verify its worktree because its ownership marker is
missing. Its files were not changed. Clear the task to restart it in the same
worktree, or close it.
```

`/clear` then recreates the marker for the replacement session. A marker that
exists but is invalid (tampered, wrong owner, unsafe file type) is never
recreated by any command; the task stays fail-closed for operator repair.

### Interrupted transfer

If a previous reset crashed between marking the old sidecar superseded and
flipping the marker, selecting or messaging the task reports the interrupted
state instead of a generic failure:

```text
Task "feature-a" was interrupted while being reset. Its files were not
changed. Clear the task again to finish the reset.
```

A retried `/clear` resumes the transfer and completes it. See the superseded
redirect section for how the daemon distinguishes this window.

### Listing and status

`/sessions`, `/sessions all`, `/session current`, and `/session use` output is
unchanged; reset does not alter names, isolation labels, or ordering beyond
the existing `lastSelectedAt` bump.

## Daemon design

### New route: `POST /session/:id/worktree-reset`

Request body: `{ workspaceCwd: string, sourceType?, sourceId? }`. The route
resolves the registered root workspace runtime exactly like the create route;
the worktree path itself is never accepted as a routing input. The session ID
in the path is the worktree owner to replace (`S_old`).

The response on success is the same session payload shape as create/load,
carrying `S_new`, its client registration, the worktree metadata, and
`worktreeState: "persisted-v1"`. SDK and bridge types reuse the existing
`DaemonSession` surface; no new response type is introduced.

Typed failures (4xx, bounded, no paths or stack traces):

- `worktree_reset_unsupported` — target session has no Part 4A sidecar or is
  not worktree-isolated.
- `worktree_reset_active` — the session has an active prompt, a pending
  interaction, or a parked deferred restore prompt.
- `worktree_reset_invalid_state` — stale, foreign, tampered, containment
  failure, or ambiguous ownership. Always non-destructive.
- `worktree_session_superseded` — see the redirect below. Also used by
  load/resume.
- `worktree_reset_interrupted` — a previous reset crashed mid-transfer;
  retrying resumes it. Also surfaced through load/resume, see the superseded
  redirect section.

### Deferred-prompt visibility (R8-2)

The bridge learns to surface a parked deferred restore prompt: a non-empty
`entry.deferredRestoreAskUserQuestionPrompts` counts as a prompt in progress
for exactly two consumers — the coalesced-restore waiter branch (R8-2's
report) and `getSessionSummary`'s `hasActivePrompt`, which is what this part's
quiescence precondition and the Channel's `isBusy` fallback read. One shared
visibility fix closes both the reported waiter hang/`CdWhilePromptActiveError`
and this part's quiescence blind spot.

The fix stops there deliberately. It must **not** feed the restore
_response_'s `hasActivePrompt`, which is computed separately as
`restorePromptAdmitted || promptActive || goalTurnActive` and is the value the
restore route reads. Widening it there would interact with the branch removal
below: a deferred worktree restore would start reporting an active prompt,
fall into the `else if (session.hasActivePrompt)` check with no recorded cwd,
and fail closed with `Active session is outside its worktree` — breaking the
deferred-restore path that works today and that #10643's reviewer verified end
to end. The two fixes are only compatible while the response value stays
unchanged, so "prompt in progress" is deliberately not unified across both
computations.

### Preconditions (all fail closed)

Serialization for this operation is keyed on the canonical worktree path, not
the session ID — after any completed or crashed transfer, two sessions hold
sidecars naming the same worktree, and per-session locks would not mutually
exclude their resets. The existing `acquireWorktreeRestore` serialization
(per bridge instance) is widened the same way: every route-owned Part 4A
worktree restore takes the worktree-keyed lock after its sidecar pre-read,
and this route holds it for the whole operation. A restore of `S_old` can
therefore never pass marker validation concurrently with a transfer that is
about to flip the marker, and two resets targeting the same worktree can
never both reach the flip. The runtime generation is captured before the
first side effect and re-asserted before the response, as in create/load.

Inside the lock, with the sidecar re-read and re-validated under the lock:

1. `S_old` exists in the persisted catalog for this workspace runtime.
2. Strict sidecar read for `S_old` is `valid`, carries `workspaceCwd`
   realpath-matching the resolved root, an `originalCwd` within the accepted
   roots, and a contained `worktreePath` — the same checks as Part 4A restore.
   A sidecar already carrying `supersededBy` is not a fresh precondition
   failure; it enters the resume path described below.
3. Quiescence, with the deferred-prompt visibility fix in place: the live
   bridge entry for `S_old`, if any, reports no active prompt (parked
   deferred prompts now count) and zero pending interactions. A session
   unknown to the live bridge is dormant and therefore quiescent. Attached
   clients do not block reset: the worker's own client stays attached to an
   open task until reset succeeds, so the transfer severs `S_old`'s residual
   attaches instead of requiring none (see step 6). The Channel refuses busy
   tasks before any of this (`isBusy` covers queued turns, running prompts,
   and pending permissions).
4. Marker state is either `valid` naming `S_old`, or `missing`. `missing` is
   the recovery hatch: it is accepted only together with a valid sidecar and
   a catalog record, i.e. the ownership chain minus exactly one link.
   `invalid` (tampered, foreign, unreadable, unsafe type) rejects.
5. The worktree directory exists and realpath-resolves inside a managed
   worktree root.

Quiescence is enforced as a barrier, not a sample. When the check passes, the
route marks the bridge entry for `S_old` reset-pending; the bridge refuses to
admit new prompts for a reset-pending session, returning the same typed
`worktree_reset_active` failure as the busy-task rejection — same meaning,
same fail-closed shape. This closes the window in which a message resolved
just before the reset — on the Channel side, `resolve()` returns under the
owner lock but the turn starts after it is released — could begin executing
in the worktree mid-transfer, and the same window for any non-Channel caller
(for whom the check would otherwise be a point-in-time sample). Channel users
never observe the barrier: the manager holds the owner lock across the whole
reset, so a concurrent message's `resolve()` blocks and then resolves to the
replacement session — no chat-facing message for the barrier exists by
decision, not omission. The flag is cleared on every failure or compensation
path and is subsumed by the transfer on success. Quiescence is additionally
re-verified immediately before the marker flip.

If `S_old`'s sidecar already records `supersededBy: S_new`, a previous reset
crashed mid-transfer. The route then revalidates the recorded replacement:
when `S_new` exists in the catalog, its own sidecar is strict-valid for the
same worktree, its `supersedes` link names `S_old`, and it is quiescent, the
route completes the interrupted transfer for that same `S_new` — a marker
that already names `S_new` short-circuits the transfer step, so a crash after
the commit point resumes as a no-op (idempotent resume). When `S_new` does
not validate, the route rolls the partial attempt back to the pre-transfer
state — remove `supersededBy` from `S_old`'s sidecar, delete `S_new`'s
sidecar, orphan-confirmed-remove `S_new` — and then proceeds with a fresh
replacement. Either way a retried `/clear` converges on exactly one owner
instead of piling up replacement sessions.

### Transfer protocol

Ordered steps, with the crash behavior of each:

0. Preconditions pass; arm the reset-pending barrier on `S_old`.
   Every non-crash failure or compensation path clears the barrier
   explicitly. A crash clears nothing — the barrier is in-memory bridge
   state and is discarded with the process, deliberately non-durable:
   durability of a mid-transfer state lives entirely in the marker and the
   sidecar pair, which the resume path reads.
1. Spawn `S_new` in the root workspace with the same thread-scope and source
   metadata conventions as a fresh worktree creation, minus worktree
   creation. No branch, no directory, no slug allocation.
   Crash: `S_old` fully authoritative; `S_new` is an ordinary orphan with no
   worktree metadata and no sidecar.
2. Relocate `S_new` into the verified worktree path through
   `changeSessionCwd` with server-derived `allowedRoots`, requiring the
   returned canonical path to equal the verified real path.
   Crash/failure: orphan-confirmed removal of `S_new` (the existing
   create-route rollback primitive); the marker still names `S_old`, which
   remains restorable. The worktree is never removed by reset rollback.
3. Write the sidecar for `S_new` via the existing atomic writer, carrying the
   worktree identity from `S_old`'s sidecar (`slug`, `worktreePath`,
   `worktreeBranch`, `originalCwd`, `originalBranch`, `originalHeadCommit`)
   plus this daemon's `workspaceCwd`, and a `supersedes: S_old` link.
   Crash: the marker still names `S_old`; `S_old` restores normally; the
   dangling `S_new` sidecar fails its marker check if probed. Controlled
   failure: delete the new sidecar and orphan-confirmed-remove `S_new`.
4. Rewrite `S_old`'s sidecar adding `supersededBy: S_new` (atomic write).
   Crash: restore of `S_old` now sees the superseded link; because the marker
   still names `S_old`, the redirect target is not yet authoritative, so
   restore fails closed with the interrupted-transfer signal and a retry of
   the reset resumes and completes the transfer. This is the one window where
   the task is temporarily unrestorable, and retry is the documented repair.
5. Re-verify quiescence — a prompt admitted in the check-to-arm window and
   still winding down aborts the transfer here — then transfer the marker to
   `S_new` (primitive below). This is the point of no return.
   Crash before the commit: marker still names `S_old`; a retried reset
   resumes and completes. Crash after the commit: marker, both sidecars, and
   the catalog agree that `S_new` owns the worktree; `S_old` restores as
   superseded and redirects.
6. Re-assert the runtime generation. If `S_old` is live in the bridge, sever
   its residual client attaches and clear its in-memory worktree association,
   so the runtime view matches the transferred on-disk ownership; `S_old`
   remains persisted and superseded, never deleted. Set `persisted-v1` on the
   response and respond.

Controlled failure at steps 4–5 (no crash) compensates: remove
`supersededBy` from `S_old`'s sidecar, delete `S_new`'s sidecar, and
orphan-confirmed-remove `S_new`, restoring the exact pre-reset state. A
failure at step 6 is past the point of no return and does not compensate:
the marker already names `S_new`, the on-disk state is consistent, and the
Channel — which never saw success — heals its registry through the superseded
redirect on the next selection.

A crash before step 3 can leave a replacement session that was relocated but
never gained a sidecar. That orphan has no worktree claim: it restores as an
ordinary root-workspace session and is eventually reaped like any orphan —
the same shape a crashed Part 4A creation can already leave. A retried reset
simply spawns a fresh replacement.

### Marker transfer primitive

New daemon-only helper in the core worktree service,
`transferWorktreeSessionMarkerOwner(worktreePath, expectedOwner | null,
newOwner)`. The transfer is a compare-and-swap on the current owner — never a
blind overwrite:

1. Strict-read the marker. Require `valid` with `sessionId ===
expectedOwner`, or `missing` when `expectedOwner === null` (the recovery
   hatch). Any `invalid` state or owner mismatch fails closed.
2. Refuse a foreign-owned marker — but only where ownership is observable.
   The comparison reads the marker's `uid` (both strict readers, the async
   one and the new synchronous one, surface it alongside the three-state
   result) against the daemon's effective uid, and it runs only where the
   platform reports one (`process.geteuid`). Where the platform reports none
   — Windows — `atomicWriteFile`'s `ownershipWouldChange()` is always false,
   so the in-place path this refusal guards against is unreachable by
   construction and nothing is refused. Where it does run, the refusal keeps
   `atomicWriteFile` on its rename path: the ownership-preserving fast path
   would otherwise write the marker in place, non-atomically and following a
   symlink swapped in after the check, and a crash mid-write would leave a
   truncated marker — which the strict reader reports as `invalid`, and an
   `invalid` marker is never auto-recovered. Failing closed on a
   foreign-owned marker is the same fail-closed shape as any other ambiguous
   ownership.
3. Commit by shape:
   - `valid` naming `expectedOwner`: rewrite through the existing
     `atomicWriteFile` with `noFollow: true`, whose rename atomically
     replaces whatever occupies the path — including a symlink swapped in
     after validation — without ever following it, and whose
     `renameWithRetry` covers the Windows EPERM/EACCES shape. The
     `assertCanCommit` hook re-reads the marker immediately before the rename
     commit and requires the same owner **and** the same file identity
     (`dev`/`ino`/`uid`) as the opening strict read, closing the window
     between the opening read and the commit — a foreign-owned replacement
     carrying the same owner content is caught there rather than written in
     place. Because that hook is synchronous (`() => void`), the re-check
     uses a new synchronous no-follow strict reader alongside the async one
     in the core worktree service — same checks, same three-state result.
     `atomicFileWrite.ts` itself is reused unchanged.
   - `missing`: commit through the existing
     `createWorktreeSessionMarkerExclusive`. `O_EXCL` _is_ the
     compare-and-swap against absence: a concurrent transfer that gets there
     first turns this create into `EEXIST`, which fails closed.
4. `atomicWriteFile`'s temporary file is a sibling named
   `.qwen-session.<hex>.tmp`. The transfer adds a `.qwen-session.*.tmp` rule
   beside the marker's existing `info/exclude` line so a crashed transfer's
   leftover temp file — which carries a session ID — cannot be staged by a
   task-local `git add -A`. The glob widens the repository's shared exclude
   in the main checkout as well; that widening is accepted deliberately (the
   pattern matches only transfer temp siblings of the marker), as Part 4A
   already accepted for the marker rule itself. The sibling placement also
   keeps the temp file on the marker's own filesystem, so `atomicWriteFile`'s
   `EXDEV` fallback — which unlinks before creating, the ownerless window
   rejected below — is unreachable here.

Either commit shape leaves the old marker fully intact or the complete new
content, so the strict reader never sees a truncated marker from this
primitive. That holds because the foreign-uid refusal excludes the in-place
write path, the sibling temp excludes the `EXDEV` path, and the commit-point
re-check compares owner **and** file identity — leaving the rename and the
exclusive create as the only commits. One residual is stated honestly: an
in-place rewrite that preserves inode and ownership is indistinguishable to
any file-level check, but only a same-uid writer can do that — the daemon
itself or the local user — and for daemon writers the worktree-keyed lock
excludes it. Two concurrent transfers targeting one worktree cannot both
win: the worktree-keyed lock serializes them, and the second-place
finisher's owner re-check (or `O_EXCL` create) fails closed regardless.

### Sidecar schema addition

`WorktreeSession` gains two optional fields:

```ts
supersededBy?: string; // on the old sidecar: the replacement that owns the worktree
supersedes?: string; // on the new sidecar: the session it replaced
```

The forward link is the redirect signal read on restore; the reverse link
makes a reset retry's resume check bidirectional, so a `supersededBy` value
can only ever point at a session that itself claims to replace `S_old` for
the same worktree. `isValidWorktreeSession` accepts both as optional strings.
Readers that do not know the fields ignore them. Only the daemon route writes
them; only the restore/reset paths read them. The registry, the marker
format, and the sidecar's versionless shape otherwise stay unchanged.

### Missing-marker restore signal

When a Channel restore reaches the ownership check and the strict marker read
is exactly `missing` — sidecar valid, workspace and containment proven, only
the marker absent — the route returns `409` with code
`worktree_marker_missing` instead of the generic integrity failure. Absence
is not evidence of tampering (the crash window, or a task-local
`git clean -fdx` removing the ignored file). The Channel maps this code to
the recovery message in the user-visible contract; reset is the recovery path
that recreates the marker. An `invalid` marker keeps the existing non-typed
fail-closed behavior and is never auto-recovered. This resolves the
permanent-bricking concern (chiga0 F1, bot R3-2) without weakening the tamper
boundary.

### Superseded redirect on load/resume

The restore route already strict-reads the sidecar before loading, to choose
the worktree-restore suppression behavior. When that pre-read finds a valid
Part 4A sidecar carrying `supersededBy`, the route stops before the bridge
load entirely and returns `409` with code `worktree_session_superseded` and
the replacement session ID. Every caller receives the same typed failure;
non-Channel callers simply fail closed on it, as they do on any restore
integrity error today. For the Channel this is the self-healing channel for a
reset that completed daemon-side but whose registry commit never happened
(worker crash between the reset response and the registry write): the
manager's load catches the typed signal, exact-loads the replacement through
the normal `loadManagedSession` path — requiring the same root, the same
canonical worktree path, and `persisted-v1` — and only then commits the
registry update `S_old → S_new` under the owner lock. A failed validation of
the replacement leaves the registry unchanged and the task fail-closed. The
same registry-write-failure window after a successful reset heals through
this path on the next selection or message.

One sub-case gets its own signal. If the redirect target's restore fails
because the marker still names `S_old` while the sidecar pair agrees
(`supersededBy: S_new` on the old, `supersedes: S_old` on the new), the
transfer crashed between steps 4 and 5. The daemon returns `409` with code
`worktree_reset_interrupted`, and the Channel maps it to the
interrupted-transfer message in the user-visible contract — the one window
whose documented repair is a retry gets a message that says so.

### Deferred-prompt restore attestation (F2/R1-2)

This section corrects the first revision of this document, which proposed
relocating in the `hasUnlocatedRestoredPrompt` branch on the premise that the
prompt there is parked. Review against the bridge code showed the premise is
inverted:

- A deferred (parked) restore prompt sets neither `promptActive` nor
  `goalTurnActive`, so it reads `hasActivePrompt: false` and flows through
  the `else` branch — which already relocates, requires the returned path to
  match, and attests `persisted-v1`. The deferred shape was never broken.
  (This is why the R8-2 visibility fix deliberately stops short of the
  restore response value: widening it there would push this working shape
  into the fail-closed branch below.)
- The branch is entered only when a cold-restored session genuinely has a
  live prompt (`hasActivePrompt && !attached && currentCwd === undefined`).
  Relocating there is impossible: `changeSessionCwd` chains onto the prompt
  queue and throws `CdWhilePromptActiveError` while a prompt is live, so the
  proposed sequence would hang the load until timeout and then fail it,
  discarding the recovered session — a regression against today's behavior,
  which returns the session merely unattested.

The Part 4A refusal to relocate this shape was therefore right on the merits
and stands. What remains wrong in `main` is chiga0's actual finding: the
branch silently under-attests (worktree metadata without `persisted-v1`), so
a later Channel load fails the identity check for reasons no signal names.

The fix is chiga0's second offered shape — fail closed instead of attesting
an unrelocated session: remove the `hasUnlocatedRestoredPrompt` branch so the
shape falls into the existing `else if (session.hasActivePrompt)` check,
which throws `Active session is outside its worktree` when `currentCwd` is
undefined, and the restore fails the integrity path like every other
unverifiable state. The reviewer-run E2E on #10643 found this branch
unreachable from real flows (in-flight restore, `kill -9` cold restore, and
raw non-Channel load all have a known `currentCwd`), so this is hardening
that removes a silent under-attestation, not the closure of an observed
failure — worth doing because R1-2 stands unanswered, and it does not claim
otherwise.

### Capability

Add `session_worktree_reset_v1` to the serve capability registry, advertised
only when the reset route and transfer primitive are present. The worker reads
it at startup beside `session_worktree_persistence_v1` and passes a
`sessionWorktreeReset` boolean into `DaemonChannelBridge`; the bridge rejects
a worktree reset request before invoking its session factory when the flag is
absent. A new worker against an old daemon therefore fails before any daemon
side effect; an old worker never sends the request.

## Channel design

### Manager reset

`NamedSessionManager.reset()` replaces the Part 4A rejection with:

1. Under the owner lock, resolve the selected open task as today.
2. If the task is shared, keep the exact current flow.
3. If the task is worktree-isolated, require `!isBusy(task.sessionId)` and
   throw the actionable busy message otherwise. Then call the new router
   operation below, swap `sessionId` in the task record (name, cwd,
   isolation, target, and creation timestamp preserved; the update and
   selection timestamps bump as they do on a shared reset), commit the
   registry atomically, activate the new session with the task's stored cwd,
   and forget the old session — the same post-success steps as a shared
   reset.

Registry schema stays version 1: only the task's `sessionId` value changes.

### Router

New `SessionRouter.replaceManagedWorktreeSession(target, workspaceCwd,
expectedCwd, oldSessionId)`:

- calls a new bridge method `resetWorktreeSession(oldSessionId, workspaceCwd,
options, bindingToken)`;
- validates the response through the existing
  `validateManagedSessionIdentity` with `expectedCwd` set to the task's stored
  cwd — an adoption that relocated anywhere else, or that lacks
  `persisted-v1`, detaches the new client and fails without publishing
  target/cwd/live-route state;
- on success records the new session's target and canonical cwd and returns
  the new session ID.

The load path learns the superseded redirect: when the bridge surfaces the
typed `worktree_session_superseded` error, `loadManagedSession` propagates it
with the replacement ID; the manager catches it, exact-loads the replacement,
and commits the registry update under the owner lock before continuing. The
manager also maps the typed restore failures to the bounded messages shown
above: `worktree_marker_missing` to the recovery message and
`worktree_reset_interrupted` to the interrupted-transfer message; every other
daemon failure keeps the existing generic named-session message.

### Bridge, worker, SDK

- `ChannelAgentBridge` gains an optional `resetWorktreeSession`; the daemon
  bridge implements it with a capability gate
  (`options.sessionWorktreeReset`) and forwards through the existing session
  factory pipeline with an added `worktreeReset: { sessionId }` request field.
- The daemon worker reads `session_worktree_reset_v1` from the capabilities
  envelope and passes the flag into `DaemonChannelBridge`, mirroring
  `sessionWorktreePersistence`.
- The SDK adds a `DaemonSessionClient.resetWorktree(...)` entry point that
  POSTs the new route and constructs a client for the returned replacement
  session; the worker's session factory branches to it when
  `worktreeReset` is present. The existing reattach identity guard applies to
  the replacement client unchanged.

### Command and messaging surface

- `doClear` is unchanged: the manager's reset either succeeds and the
  existing per-session cleanup retires `S_old` (non-destructive; no worktree
  path is ever passed to it), or throws before any side effect. The manager's
  reset return gains the task isolation so the acknowledgement can note that
  worktree files were kept.
- The worktree reset acknowledgement notes that files were kept.
- Busy worktree reset returns the cancel-first message above.
- Restore-time marker-missing failure returns the recovery message above.
- An interrupted transfer returns the retry message above.

## Compatibility

- `multiSession` absent or false: no change of any kind.
- Shared tasks: reset, create, load, close unchanged.
- Old daemon + new worker: missing `session_worktree_reset_v1` fails the
  reset request in the bridge before any daemon call; restore behavior is
  unchanged.
- New daemon + old worker: the worker never calls the route; Part 4A behavior
  unchanged.
- Part 4A registries: no schema change; the session-ID swap is a value change
  only. A registry committed after a completed reset points at `S_new`, whose
  sidecar and marker validate normally on any binary that understands
  `isolation: "worktree"`.
- Downgrade between reset and restart: an older worker reads the same
  registry and restores `S_new` through the Part 4A path; `supersededBy` is
  ignored by readers that predate it.
- `S_old` after reset: its transcript and catalog record persist; restore
  fails closed as superseded (Channel) or invalid (other callers); it never
  reclaims the worktree.

## User-facing error classes

Bounded messages, no paths, session IDs, or daemon bodies:

- busy worktree reset (cancel-first guidance); the reset-pending barrier
  reuses the same typed `worktree_reset_active` refusal, and no chat-facing
  message exists for it by decision — the Channel owner lock keeps users out
  of the window, so only a non-Channel API caller can meet it;
- daemon without the reset capability;
- invalid or unavailable worktree state during reset (generic named-session
  failure with the existing narrow categories);
- marker missing at restore (recovery guidance: clear to recreate, or close);
- interrupted transfer (retry guidance: clear again to finish);
- superseded task restoration otherwise heals silently, surfacing only if
  the replacement fails validation, as a generic load failure.

## Implementation sequence

1. Bridge deferred-prompt visibility (R8-2): one shared definition of
   prompt-in-progress covering the parked map, consumed by the coalescer and
   `getSessionSummary` — and explicitly not by the restore response's
   `hasActivePrompt`; the reset-pending barrier primitive (set, refuse
   admission, clear); the attach-severing and worktree-association clearing
   surfaces the transfer's step 6 needs.
2. Core marker primitive: a synchronous no-follow strict marker reader beside
   the async one (for the `assertCanCommit` re-check), then
   `transferWorktreeSessionMarkerOwner` with the foreign-uid refusal and the
   compare-and-swap commit shapes, and strict-reader tests for every crash
   window.
3. Daemon route `POST /session/:id/worktree-reset`: worktree-keyed
   serialization (widening `acquireWorktreeRestore`), preconditions,
   resumable transfer protocol, rollback, capability registration.
4. Restore changes: superseded redirect, interrupted-transfer signal,
   missing-marker typed failure, and removal of the under-attesting
   `hasUnlocatedRestoredPrompt` branch.
5. SDK route method and worker forwarding; bridge capability gate; router
   replace operation and superseded handling; manager reset; messages.
6. Documentation updates (see below).
7. Focused tests at each layer, then repository build/typecheck/lint, the
   daemon-backed Channel E2E plan, and the required audit passes.

## Expected production scope

- `packages/acp-bridge/src/bridge.ts` and `bridgeTypes.ts` (deferred-prompt
  visibility in the summary and coalescer, the reset-pending barrier, attach
  severing, worktree-association clearing)
- `packages/core/src/services/gitWorktreeService.ts` (transfer primitive,
  synchronous strict marker reader)
- `packages/core/src/services/worktreeSessionService.ts` (`supersededBy`,
  `supersedes`)
- `packages/core/src/utils/atomicFileWrite.ts` (reuse only; no change
  expected)
- `packages/cli/src/serve/routes/session.ts` (new route, restore changes)
- `packages/cli/src/serve/capabilities.ts` (`session_worktree_reset_v1`)
- `packages/sdk-typescript/src/daemon/DaemonClient.ts` and
  `DaemonSessionClient.ts` (route method, replacement client)
- `packages/channels/base/src/ChannelAgentBridge.ts`,
  `DaemonChannelBridge.ts`, `SessionRouter.ts`, `named-session-manager.ts`,
  `ChannelBase.ts` (reset plumbing, capability gate, messages)
- `packages/cli/src/commands/channel/daemon-worker.ts` (capability read)

Documentation updates: `docs/users/features/channels/overview.md` drops the
"reset is deferred" limitation (the only user-doc location carrying it) and
documents cancel-first reset, file retention, and marker recovery;
`docs/developers/qwen-serve-protocol.md` and
`docs/developers/daemon/08-session-lifecycle.md` define the new route,
capability, and typed errors.

Tests remain collocated. An E2E plan lands in `.qwen/e2e-tests/` during
implementation and is not committed.

## Verification plan

### Manager, router, command

- `/clear`, `/new`, `/reset` on a selected worktree task succeed on an idle
  task, keep name/cwd/isolation, and swap only the session ID.
- Busy (running, queued, or permission-pending) worktree reset rejects before
  any `ChannelBase` cleanup side effect; shared busy reset behavior
  unchanged.
- Reset response lacking `persisted-v1`, naming a different worktree, or
  naming the root detaches the new client and commits nothing.
- Superseded restore self-heals: registry moves to the replacement only after
  the replacement passes exact validation.
- An interrupted transfer surfaces the retry message, and the retried
  `/clear` completes the transfer.
- Cross-owner isolation, the eight-open-task cap, and case-insensitive name
  uniqueness are unchanged by the session-ID swap.

### Daemon route and transfer

- Full precondition matrix: unknown session, shared session, foreign
  workspace, wrong `originalCwd`, containment failure, active prompt, pending
  interaction, parked deferred prompt (rejected via the visibility fix),
  invalid marker, missing marker with valid sidecar (accepted), missing
  marker without catalog record (rejected), and residual attaches severed by
  the transfer rather than blocking it.
- The reset-pending barrier refuses a prompt admitted after the quiescence
  check and is cleared by every failure path; the pre-flip re-verify aborts a
  transfer whose prompt state changed.
- Two concurrent resets against sessions sharing one worktree (the
  post-transfer shape) cannot both win: the second fails the lock, the owner
  re-check, or the `O_EXCL` create.
- Crash injection at every transfer step proves the documented outcome:
  pre-transfer crashes leave `S_old` authoritative; post-transfer crashes
  restore `S_new`; a retried reset completes a half-finished transfer exactly
  once, and a marker that already names `S_new` makes the resume a no-op.
- Controlled failure at steps 4–5 compensates to the exact pre-reset state.
- Marker transfer never follows a swapped-in symlink, never leaves a partial
  or empty marker, and re-reads the owner at the commit point.
- A marker owned by a different uid than the daemon is refused rather than
  written in place, so `atomicWriteFile`'s non-atomic ownership-preserving
  path is never selected for a marker.
- The worktree directory, its files (tracked, modified, untracked), and its
  branch are byte-identical across reset; only the marker content changes.

### Restore and bridge

- Missing marker + valid sidecar: restore fails with the typed missing-marker
  signal; reset recovers; the recovery message reaches the chat.
- Invalid marker: restore and reset both fail closed; nothing is recreated.
- A restored session whose prompt is live and unlocated fails closed through
  the existing active-session check — no silent under-attestation — and the
  removed branch's shape is covered by a test that fails if the branch
  returns.
- Deferred-prompt visibility: a parked restore prompt reads as active in
  `getSessionSummary` and the coalescer; the R8-2 concurrent-restore probe
  (waiter observes the deferred state, no `CdWhilePromptActiveError` 500) is
  reproduced as a regression test.
- The same visibility fix leaves a deferred worktree restore reaching
  `persisted-v1` through the relocating branch — asserted directly, so a
  later widening of the restore response's `hasActivePrompt` fails the test
  instead of silently failing the restore.
- Superseded restore pre-empts the bridge load and carries the replacement
  ID; the interrupted sub-case carries `worktree_reset_interrupted`.
- Capability absent: the bridge rejects before the factory runs; old-daemon
  responses fail Channel validation without creating state.

### Concurrent E2E

Extend the Part 4A daemon-backed plan: create shared + worktree tasks, run
work, reset a worktree task mid-plan, verify the fresh conversation, the
intact files (including uncommitted changes), the unchanged task list, and
Part 3A labels; reset recovery after a simulated marker deletion; worker and
daemon restart before and after reset; reset rejection while a task runs,
then success after `/session cancel`.

### Repository checks

Focused package tests, then `npm run build`, `npm run typecheck`,
`npm run lint`; test-engineer daemon-backed E2E; the required self-audit
passes (two consecutive clean) before delivery.

## Risks and controls

### Transfer crash windows

Risk: a crash mid-transfer strands the task between two owners.

Control: the transfer is ordered so the marker — the single ownership
authority — flips last, the superseded sidecar makes the flip discoverable,
and the route resumes a half-finished transfer on retry. Every window is
enumerated in the protocol above with its outcome.

### Reset of a busy task

Risk: transferring ownership while a prompt executes in the worktree races
file writes and the marker flip.

Control: quiescence is enforced as a barrier plus a re-check, not a sample —
the bridge refuses new prompts on a reset-pending session from the
precondition gate until the flip, and quiescence is re-verified immediately
before the flip. The Channel refuses busy tasks up front (`isBusy` covers
queued, running, and permission-pending states); the user cancels first. A
parked deferred restore prompt counts as busy once the visibility fix lands,
so a task stopped on a recovered question cannot be reset out from under the
question.

### Concurrent reset double-win

Risk: after a completed or crashed transfer, two sessions hold valid sidecars
naming the same worktree; two concurrent resets could both claim the marker.

Control: serialization is keyed on the canonical worktree path, the commit is
a compare-and-swap (owner re-check at the rename commit for the `valid`
shape, `O_EXCL` for the `missing` shape), and a superseded sidecar routes to
the resume path rather than starting a competing transfer. The second-place
finisher fails closed in all shapes.

### Silent downgrade of the old session

Risk: after reset, a restore of `S_old` could fall back to the shared root
workspace and resume a stale conversation in the wrong directory.

Control: `S_old`'s sidecar is retained and marked superseded; its marker no
longer matches, so every restore path fails closed. The typed superseded
signal is the only redirect, and it requires the replacement to pass full
identity validation before the Channel registry moves.

### Recovery-hatch abuse

Risk: the missing-marker hatch could recreate ownership on a worktree that
was deliberately stripped.

Control: the hatch requires the conjunction of a strict-valid Part 4A
sidecar, a matching catalog record, containment, quiescence, and an invalid
(rather than absent) marker still fails closed. Recovery replaces the
conversation; it never repairs or trusts a tampered marker.

## Alternatives reviewed

### Extend `POST /session` creation with an adopt option

Rejected. The create route's invariants were hardened through nine review
rounds in #10643; threading adoption preconditions, a different rollback
contract (never remove the worktree), and the supersede step through it
obscures exactly the boundaries reviewers signed off. A dedicated route keeps
the new lifecycle operation explicit, shares implementation helpers without
sharing control flow, and fails closed on old daemons by absence.

### Reuse the existing shared reset for worktree tasks

Rejected — this is the Part 4A design's own rejection. Creating the
replacement session at the worktree path routes through an unregistered
workspace; creating it at the root strands the worktree's ownership on the
old session. Neither preserves exact recovery.

### Transfer ownership by blind temp-file rename without a commit-point check

Rejected during this design's review. A plain rename is not a
compare-and-swap: with the marker absent it degrades to last-writer-wins, and
even with the marker present it leaves the window between the opening strict
read and the rename unguarded. The commit must re-check the owner
(`assertCanCommit`) or exclude by absence (`O_EXCL`).

### Transfer ownership by unlink + exclusive create

Rejected for the `valid`-owner shape. The window between unlink and re-create
leaves the worktree ownerless; a crash there forces reliance on the recovery
hatch for a routine operation. (For the `missing` shape the exclusive create
is exactly right and is what the primitive uses.)

### Reattach the old session ID to a fresh conversation

Rejected. Reusing the session ID conflates two conversations under one
transcript identity and breaks the daemon's per-session storage addressing.
A fresh ID keeps reset semantically identical to the shared-task reset the
rest of the system already models.

### Cancel-then-reset inside the daemon route

Rejected. Prompt cancellation is Channel-owned semantics with bounded
wind-down and wedged-turn handling; pushing it into the daemon route
duplicates that policy where it cannot observe the chat. Requiring
quiescence keeps one cancellation implementation; the reset-pending barrier
refuses new admissions without cancelling anything.

### Delete the old session record during reset

Rejected. Shared reset retains the previous conversation in the daemon
catalog; worktree reset does the same. The superseded sidecar, not deletion,
is what prevents the old session from reclaiming the worktree.

### Land the orphan-reap worktree cleanup in this part

Rejected during this design's review. It is the only file-deleting path in
the series, and review showed its correct shape (call-site placement,
`kind === 'removed'` gating, supersede-link refusal, the safe-delete branch
invariant) needs a dedicated review cycle rather than riding beside a part
whose contract is "no deletion". It is fully specified in follow-up issue
#11024.

## Exit criteria

Part 4B is complete when: a worktree task resets in place with files intact;
busy and deferred-prompt-parked reset refuse cleanly; a missing marker is
recoverable only through reset; a tampered marker never recovers
automatically; a half-finished transfer is completed by retry and healed
through the superseded redirect; the under-attesting restore branch is gone
and the deferred-prompt visibility fix closes R8-2; and no path in the part
deletes a file.

Issue #10103 closes when the above holds **and** the remaining dispositions
in the table are satisfied: the four residual fixes (R8-1, R8-3, R1-1, F3),
included in this PR, and follow-up issue #11024 (reap cleanup, the sibling
delete path, and the `SessionRouter.ts:487` investigation) resolved or
explicitly accepted by a maintainer.
