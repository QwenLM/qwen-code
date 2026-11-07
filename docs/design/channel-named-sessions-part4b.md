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
requirements element by element. It also deletes no user-visible state: the
one destructive candidate identified during this design's review
(orphan-reap worktree cleanup) was moved out to follow-up issue #11024, and
the transfer's own rollback removes only artifacts the reset created — the
replacement session's sidecar and record — never the worktree, its files,
its branch, the ownership marker, or the old session's state.

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
reset-pending barrier so no prompt — and no other operation that can write
the checkout or move the session cwd — can start on `S_old` mid-transfer,
spawns a fresh session (`S_new`) in the same registered root workspace,
relocates `S_new` into the same worktree, marks the old sidecar superseded,
writes a new sidecar for `S_new`, re-verifies quiescence, and flips the
in-worktree ownership marker from `S_old` to `S_new` last — with an atomic
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
   conversation in the same verified worktree, with no deletion of
   user-visible or pre-existing state anywhere in this part.
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

- Deleting any user-visible or pre-existing state: the worktree, its branch,
  the files within it, the ownership marker, or `S_old`'s sidecar,
  transcript, and record. The transfer's rollback may remove only artifacts
  the reset itself created — `S_new`'s sidecar and session record. The
  orphan-reap cleanup and the sibling `POST /sessions/delete` worktree leak
  are tracked in follow-up issue #11024.
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

In scope, contrary to an earlier draft of this section: the R8-1
create-rollback orphan fix, the R8-3 reattach-guard heal, the R1-1
marker-create leak fix, and the F3 parser fix all land in this PR alongside
the design (see the disposition table).

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
- `acquireWorktreeRestore` (renamed `acquireWorktreeOwnershipOp` by this part)
  is keyed per bridge instance (a `WeakMap`) and per session ID, and today
  covers only the deferred-prompt restore shape; the ordinary Part 4A worktree
  restore takes no such lock.
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
| chiga0 F2 / R1-2 + yiliang114 (under-attested active-prompt restore)                                                                               | branch never attests `persisted-v1`                                                                  | **This part**: removed where a deferral was available (that shape fails closed); kept, unattested, for a fired restore prompt (see "Deferred-prompt restore attestation")                              |
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
inconclusive delete and logs it. The block this PR changes is different in
kind, not a relaxation of that rule: it is the post-spawn generation-guard
catch, which runs before relocation is ever attempted — the session exists
there (and orphan-confirmed removal is attempted on it), but no session has
entered the worktree, so nothing can own the checkout regardless of how that
cleanup turned out. The `!spawnCompleted` "no session exists" rationale
belongs to the spawn-failed outer catch, a different block this PR does not
change.

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

Both worktree recovery messages — this one and the interrupted-transfer one
below — are state-dependent, because clearing always acts on the _selected_
task: the clear guidance is offered only when the task that failed is the
selected one. Aimed at any other task it would run a full ownership transfer
against a healthy one and destroy that conversation, so a failure on a task
that is not selected names that task and points at the two actions that reach
it — selecting it first, or `/session close <name>`, which closes without
loading the target:

```text
Task "feature-a" cannot verify its worktree because its ownership marker is
missing. Its files were not changed. Clearing now would reset the selected
task instead, so select this task first or close it with
/session close feature-a.
```

When no task name is available on the failure, the subject degrades to "The
task" and the remedy drops the command rather than risk naming the wrong task.
The name is the only text these messages interpolate outside the wrapper's
sanitizer, so it is bounded to 32 code points; the bounded-message rule is
unchanged — a task name is allowed, session IDs, paths, and daemon bodies are
not.

### Interrupted transfer

If a previous reset crashed after the sidecar pair was linked but before the
marker flipped, selecting or messaging the task reports the interrupted state
instead of a generic failure:

```text
Task "feature-a" was interrupted while being reset. Its files were not
changed. Clear the task again to finish the reset.
```

The same state dependence applies: that text is emitted only when the
interrupted task is the selected one. A failure on a task that is not
selected names it and points at selecting it or closing it, rather than at a
clear that would transfer a different, healthy task:

```text
Task "feature-a" was interrupted while being reset. Its files were not
changed. Clearing now would reset the selected task instead, so select this
task first or close it with /session close feature-a.
```

A retried `/clear` resumes the transfer and completes it. See the superseded
redirect section for how the daemon distinguishes this window. A crash that
left only the old sidecar's link — the replacement never gained its own
sidecar — is not this window: the pair disagrees, so the redirect target
carries no worktree attestation, selection reports the generic load failure,
and a retried `/clear` returns the same typed refusal instead of converging.
That state is left untouched for operator repair.

### Listing and status

`/sessions`, `/sessions all`, `/session current`, and `/session use` output is
unchanged; reset does not alter names, isolation labels, or ordering beyond
the existing `lastSelectedAt` bump.

## Daemon design

### New route: `POST /session/:id/worktree-reset`

Request body (every field optional): `{ cwd?, modelServiceId?, approvalMode?,
sourceType?, sourceId? }`. `cwd` is the wire field for the workspace root —
the SDK maps its `workspaceCwd` option onto it — and the route resolves it
through the same resolver as load/resume: an explicit `cwd` selects that
registered workspace, omitting it falls back to the daemon's advertised
primary workspace, and the worktree path itself is never accepted as a routing
input. The session ID in the path is the worktree owner to replace (`S_old`).

The response on success is the same session payload shape as create/load,
carrying `S_new`, the worktree metadata, and `worktreeState: "persisted-v1"`.
The route never reads `X-Qwen-Client-Id`, so `S_new` spawns unattached — but
the body is not registration-free: the fresh-transfer body's `clientId` is an
owner-style registration the bridge mints for that spawn (the replacement's
`attachCount` stays 0), and the idempotent-resume body omits it. A non-empty
client registration is what holds the daemon's idle cleanup off, so a caller
that does not keep using the minted id has to detach it or `S_new` never
becomes reap-eligible. Callers treat the response as the replacement's
identity and attach it through their normal flow; the Channel adopts the
returned client and calls `activateManagedSession`. SDK and bridge types
reuse the existing `DaemonSession` surface; no new response type is
introduced.

Typed failures (4xx, bounded, no paths or stack traces):

- `worktree_reset_unsupported` — target session has no Part 4A sidecar or is
  not worktree-isolated.
- `worktree_reset_active` — the session has an active prompt, a pending
  interaction, or a parked deferred restore prompt.
- `worktree_reset_invalid_state` — stale, foreign, tampered, containment
  failure, or ambiguous ownership. Non-destructive for what this request
  started: a partial transfer is rolled back before the caller sees it, while
  a pre-existing interrupted state is left untouched for operator repair.

Two further codes belong to the restore surface, not to this route, which
resolves both shapes itself and never returns them:

- `worktree_session_superseded` — load/resume of `S_old` after the flip; see
  the redirect below.
- `worktree_reset_interrupted` — load/resume of a replacement whose
  `supersedes`/`supersededBy` links agree while the marker never moved. The
  repair is retrying the reset against the superseded session, which rolls the
  interrupted transfer back or finishes it; see the superseded redirect
  section.

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
exclude their resets. The existing restore serialization (per bridge instance)
is widened the same way and renamed `acquireWorktreeOwnershipOp`: every
route-owned Part 4A worktree restore takes the worktree-keyed lock after its
sidecar pre-read, and this route holds it for the whole operation. A restore
of `S_old` can therefore never pass marker validation concurrently with a
transfer that is about to flip the marker, and two resets targeting the same
worktree can never both reach the flip. The runtime generation is captured
before the first side effect and re-asserted before the response, as in
create/load.

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
admit new work for a reset-pending session, returning the same typed
`worktree_reset_active` failure as the busy-task rejection — same meaning,
same fail-closed shape. The fence is not prompt-only: eight writers consult
it, each one able to reach the checkout or move the session cwd —
`sendPrompt`, `rewindSession` (whose file restore is relative to the session
cwd, and which is admitted precisely in the idle state this route requires),
`changeSessionCwd`, `branchSession`, `launchSessionForkAgent` (whose fork
runs its tools in that cwd), `executeShellCommand` (which runs in the
entry's effective cwd — for a relocated worktree session, the checkout
itself, so it is the strongest vector rather than a workspace-cwd one),
`controlSessionWorkflowTask` (whose action runs a saved workflow, or
restarts a live run, through the session's own tool registry in that cwd),
and `controlSessionGoal` (whose `resume` promotes a queued user turn and
queues a continuation, so it starts work that never passes the fenced
`sendPrompt` admission). Each consults the same id-keyed flag the route arms
before it chains onto the session's prompt queue or dispatches, so a refused
writer cannot wedge past the transfer when the route clears the flag.
`continueSession` is not a ninth gate: it drives an accepted continuation
through `sendPrompt` and is refused there. Those eight are the whole fence,
and the fence is not everything that reaches the child: the release and stop
paths stay usable mid-transfer by design (`cancelSessionTask`,
`clearSessionGoal`, `detachClient`, `killSession`), and
`enqueueBackgroundNotification` is unfenced as well: it is daemon-internal (a
sub-session's completion acknowledgement to its parent, which no HTTP route
calls) and enqueues a notification rather than starting a turn. This closes
the window in which a message resolved just before the reset — on the Channel
side, `resolve()` returns under the owner lock but the turn starts after it
is released — could begin executing in the worktree mid-transfer, and the
same window for any non-Channel caller (for whom the check would otherwise be
a point-in-time sample). Channel users never observe the barrier: the manager
holds the owner lock across the whole reset, so a concurrent message's
`resolve()` blocks and then resolves to the replacement session — no
chat-facing message for the barrier exists by decision, not omission. The
flag is cleared on every failure or compensation path and is subsumed by the
transfer on success — with two exceptions, both of which begin at the commit
point. When the sever step reports a surviving superseded session, the
barrier stays armed as the only fence left on that entry (see step 6). And
once the marker flip has committed ownership, releasing the barrier stops
being this request's to do: the route disarms its own release at the flip —
and equally on the committed resume path, and on the primitive's post-commit
tail failure, which reports the flip as done — so any failure in the
post-flip tail leaves the superseded entry fenced for the retry that finishes
the severance, instead of re-admitting a writer to a checkout the marker has
already handed to `S_new`. Past that point only a completed severance clears
the flag explicitly. Quiescence is additionally re-verified immediately
before the marker flip.

If `S_old`'s sidecar already records `supersededBy: S_new`, a previous reset
crashed mid-transfer. The route reads the marker before choosing its
recovery shape, because the marker is what says which side of the commit
point the crash landed on:

- **Marker names `S_new` — the transfer committed.** `S_new` is the
  authoritative owner and is never rolled back. When its catalog record,
  sidecar, and `supersedes` link revalidate and it is quiescent, the route
  completes the interrupted transfer for that same `S_new` and returns it —
  a crash after the rename resumes as a no-op (idempotent resume). When it
  is busy, the route fails closed with `worktree_reset_active`: a busy
  replacement is a session in use (for example one reached through the
  superseded redirect and prompted by another client), not an invalid one,
  and a later retry converges once it is idle. Any other revalidation
  failure (missing record, corrupt sidecar, mismatched link, tampered
  marker) fails closed for operator repair. Deleting the session the marker
  names would strand the task permanently: the marker would name a deleted
  session, restore of `S_old` would fail on marker mismatch, and a retried
  reset would fail precondition 4, which requires the marker to be `valid`
  naming `S_old` or `missing`.
- **Marker names `S_old`, or is missing while `S_new` is dormant —
  pre-commit.** `S_new` is provably non-authoritative, so the destructive
  rollback is correct here: orphan-confirmed-remove `S_new` first, then
  delete `S_new`'s sidecar, then remove `supersededBy` from `S_old`'s
  sidecar — and proceed with a fresh replacement only once that removal is
  confirmed. `false` from the removal (a client attached, so
  `requireZeroAttaches` bailed) fails closed with
  `worktree_reset_invalid_state` instead of proceeding to spawn: the links
  stay written, so a retry re-enters this same resume path and refuses again
  for as long as the removal stays unconfirmed, rather than leaving a live
  replacement inside the checkout with nothing on disk naming it while the
  fresh transfer spawns a second writer beside it. The link undo takes the
  forward link off first for the same reason the transfer writes the backward
  link first: a crash mid-rollback leaves the backward link alone — the shape
  a retry refuses for repair — rather than a forward link nothing scans for.
  Two conditions bound that proof. An absent marker alone proves nothing: a
  committed transfer whose git-excluded marker was later cleaned (a
  task-local `git clean -xdf`) reads exactly like the pre-commit crash shape,
  so a missing marker while `S_new` is still live on this daemon fails closed
  with `worktree_reset_invalid_state` before any destructive write instead of
  dismantling the committed owner and spawning a second one. And the rollback
  requires the link pair to agree — `S_new`'s sidecar present and naming
  `S_old` — because a backward link with no replacement sidecar (the crash
  window between the two sidecar writes) authorizes nothing; that shape is
  reported for operator repair, not rolled back.

Where the links agree, a retried `/clear` converges on exactly one owner
instead of piling up replacement sessions. The fail-closed shapes — an
invalid marker, a link pair that does not agree, a marker naming a third
session, a live replacement with no marker — are left untouched, and a retry
re-reads the same state and returns the same typed `409` rather than
converging, so they need operator repair instead of a retry loop. No recovery
path deletes the session the marker names.

### Transfer protocol

Ordered steps, with the crash behavior of each:

0. Preconditions pass; arm the reset-pending barrier on `S_old`.
   Every non-crash failure or compensation path before the marker flip
   clears the barrier explicitly; past the flip the release stops being this
   request's to do and only a completed severance clears it (see step 6 and
   the barrier paragraph above). A crash clears nothing — the barrier is
   in-memory bridge state and is discarded with the process, deliberately
   non-durable: durability of a mid-transfer state lives entirely in the
   marker and the sidecar pair, which the resume path reads.
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
3. Rewrite `S_old`'s sidecar adding `supersededBy: S_new` (atomic write). The
   backward link is written first so every pre-flip crash window leaves a
   state the resume path can classify: a crash here is a disagreeing link
   pair, which fails closed visibly, rather than a forward link nothing
   reads.
   Crash: the marker still names `S_old`; restore of `S_old` reports the
   superseded link with `S_new` as the redirect target, and `S_new` — which
   has no sidecar yet — restores as an ordinary root-workspace session with
   no worktree attestation, so an isolation-aware caller rejects that
   response and keeps its bookkeeping. A retried reset fails closed with
   `worktree_reset_invalid_state` because the pair disagrees, and leaves the
   interrupted state untouched for operator repair. Controlled failure:
   orphan-confirmed-remove `S_new` first, then remove `supersededBy` from
   `S_old`'s sidecar.
4. Write the sidecar for `S_new` via the existing atomic writer, carrying the
   worktree identity from `S_old`'s sidecar (`slug`, `worktreePath`,
   `worktreeBranch`, `originalCwd`, `originalBranch`, `originalHeadCommit`)
   plus this daemon's `workspaceCwd`, and a `supersedes: S_old` link.
   Crash: the pair now agrees while the marker still names `S_old`, so the
   redirect target is not yet authoritative — restore of `S_new` fails closed
   with the interrupted-transfer signal, and a retry of the reset takes the
   pre-commit recovery shape: roll the partial attempt back and proceed with
   a fresh replacement. This is the one window where the task is temporarily
   unrestorable and a retry is the documented repair; it is also why a caller
   must not persist the redirect target it was handed until a load of it
   succeeds, since that retry reaps it. Controlled failure:
   orphan-confirmed-remove `S_new` first, then delete the new sidecar and
   remove `supersededBy` from `S_old`'s sidecar.
5. Re-verify quiescence — a prompt admitted in the check-to-arm window and
   still winding down aborts the transfer here — then transfer the marker to
   `S_new` (primitive below). This is the point of no return.
   Crash before the commit: marker still names `S_old`; a retried reset takes
   the pre-commit recovery shape (rollback plus fresh replacement). Crash
   after the commit: marker, both sidecars, and the catalog agree that
   `S_new` owns the worktree; `S_old` restores as superseded and redirects,
   and a retried reset takes the committed recovery shape (no-op resume or
   fail-closed on a busy replacement — never rollback).
6. Re-assert the runtime generation. If `S_old` is live in the bridge, sever
   its residual client registrations and clear its in-memory worktree
   association, so the runtime view matches the transferred on-disk
   ownership; `S_old` remains persisted and superseded, never deleted. The
   sever reports whether `S_old` is actually gone, and the route acts on that
   report instead of assuming it: a child that still holds background work (a
   dev server started inside the checkout) refuses the idle close the last
   detach triggers, so the entry can survive — alive, cwd'd inside the
   checkout the marker just handed to `S_new`, and absent from the catalog
   once its worktree association is cleared. A survivor is surfaced, not
   papered over: the barrier stays armed on it as the only fence left, the
   daemon logs the hold, and the `200` body carries
   `supersededSessionLive: true` so the caller knows the old id is still live
   and re-attachable. That field is diagnostic surface only: no first-party
   caller reads it, and the channel worker reports the same success message
   either way, so nothing here depends on a consumer checking it — what
   keeps the survivor out of the checkout is the armed barrier and the
   on-disk sidecar link. It is published for external callers and operators
   who need to tell "the old id is gone" from "still live but fenced".
   Escalating to a kill is not an option — a close error becomes a channel
   kill, and `S_new` was spawned onto that same workspace-bound bridge. Set
   `persisted-v1` on the response and respond.

Controlled failure at steps 3–5 (no crash) compensates by removing `S_new`
first and then unwriting the links in the reverse of the write order —
orphan-confirmed-remove `S_new`, delete `S_new`'s sidecar, then remove
`supersededBy` from `S_old`'s sidecar — restoring the exact pre-reset state.
The removal goes first and has to be confirmed: `false` (a client attached,
so `requireZeroAttaches` bailed) abandons the link undo and rethrows, keeping
the pair on disk so a retry takes the resume path above and refuses for
repair, instead of leaving that survivor live inside the checkout with
nothing naming it while a second replacement is spawned beside it. The link
order matters for the same reason the forward one does: a crash mid-rollback
leaves the backward link alone, which a retry refuses for operator repair,
rather than a forward link nothing scans for. A failure at step 6 is past the
point of no return and does not compensate: the marker already names `S_new`,
the on-disk state is consistent, and the Channel — which never saw success —
heals its registry through the superseded redirect on the next selection.

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
     `createWorktreeSessionMarkerExclusive`, which stages the owner in a
     `.qwen-session.<12-hex>.tmp` sibling (`O_EXCL | O_NOFOLLOW`, inode
     pinned), writes and fsyncs it there, and publishes it with `link(2)`.
     The publishing link _is_ the compare-and-swap against absence: it fails
     `EEXIST` when the marker path is taken, so a concurrent transfer that
     gets there first loses instead of overwriting — the guarantee the
     `O_EXCL` create gave, without ever letting the marker path exist before
     its content is complete and fsynced.
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
content, so the strict reader never sees a truncated or empty marker from
this primitive. That holds because the foreign-uid refusal excludes the
in-place write path, the sibling temp excludes the `EXDEV` path, and the
commit-point re-check compares owner **and** file identity — leaving the
rename and the link publish as the only commits. One residual is stated
honestly: an in-place rewrite that preserves inode and ownership is
indistinguishable to any file-level check, but only a same-uid writer can do
that — the daemon itself or the local user — and for daemon writers the
worktree-keyed lock excludes it. Two concurrent transfers targeting one
worktree cannot both win: the worktree-keyed lock serializes them, and the
second-place finisher's owner re-check (or `EEXIST` from the publishing
link) fails closed regardless.

A 0-byte `.qwen-session` is consequently not a state the `missing` hatch can
produce. It is still classified `{state:'invalid', reason:'invalid marker
owner'}` by both strict readers and is still never auto-recovered: a
pre-existing empty marker — left by pre-fix code, by
`writeWorktreeSessionMarker`'s plain `fs.writeFile`, or by external
truncation — keeps the existing non-typed fail-closed behavior.

The window that replaces the create-then-fill one is the gap between the
publishing link and the removal of the staged sibling: there the marker holds
the correct owner but has `nlink === 2`, which both strict readers report as
`{state:'invalid', reason:'unsafe marker file type'}`. The same call closes
the gap by unlinking the sibling; a failure of that unlink surfaces as the
primitive's post-commit `WorktreeMarkerCommittedError`, so the flip stands
and is never compensated backwards. A crash inside the gap leaves a
valid-content marker plus a `.qwen-session.<hex>.tmp` sibling sharing its
inode. Operator repair is to remove the leftover sibling — never the marker —
which restores the marker to `valid`. It is not auto-recovered.

One portability consequence comes with the publish: the hatch now requires
hardlink support on the filesystem holding the worktree, where the previous
plain `O_EXCL` create worked anywhere. Where hardlinks are unavailable the
publish fails, the staged sibling is removed and no marker is created, so the
failure is fail-closed — the reset refuses with its typed
`worktree_reset_invalid_state` after rolling back what it started, rather
than corrupting. This is a documented boundary of the primitive, not a
defect, and it applies to the worktree-creation path that already committed
through the same exclusive create as well as to the hatch.

### Sidecar schema addition

`WorktreeSession` gains two optional fields:

```ts
supersededBy?: string; // on the old sidecar: the replacement that owns the worktree
supersedes?: string; // on the new sidecar: the session it replaced
```

The forward link is the redirect signal read on restore — read on its own,
before any marker or reverse-link read, so a redirect names a candidate owner
rather than a proven one (see the redirect section below). The reverse link
makes a reset retry's resume check bidirectional, so a `supersededBy` value
is only acted on when the session it names also claims to replace `S_old` for
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
the worktree-restore suppression behavior and to derive the ownership lock's
key. The superseded decision is deliberately not taken on that pre-read: a
concurrent pre-commit rollback would otherwise make the route redirect a
caller to a replacement the same daemon is about to delete. A Channel restore
re-reads the sidecar once the worktree-keyed lock is held — still before the
bridge load — and stops there with `409` code `worktree_session_superseded`
and the replacement session ID when that locked read finds a valid Part 4A
sidecar carrying `supersededBy`. Every caller receives the same typed
failure: a non-Channel restore gets it from the defense-in-depth check the
Part 4A validation repeats after the load, and simply fails closed on it, as
it does on any restore integrity error today. For the Channel this is the
self-healing channel for a reset that completed daemon-side but whose
registry commit never happened (worker crash between the reset response and
the registry write): the manager's load catches the typed signal, exact-loads
the replacement through the normal `loadManagedSession` path — requiring the
same root, the same canonical worktree path, and `persisted-v1` — and only
then commits the registry update `S_old → S_new` under the owner lock. A
failed validation of the replacement leaves the registry unchanged and the
task fail-closed. The same registry-write-failure window after a successful
reset heals through this path on the next selection or message.

One sub-case gets its own signal. If the redirect target's restore fails
because the marker still names `S_old` while the sidecar pair agrees
(`supersededBy: S_new` on the old, `supersedes: S_old` on the new), the
transfer crashed between steps 4 and 5. The daemon returns `409` with code
`worktree_reset_interrupted`, and the Channel maps it to the
interrupted-transfer message in the user-visible contract — the one window
whose documented repair is a retry gets a message that says so.

Note what the redirect does and does not prove. The classification reads the
`supersededBy` link alone, before any marker read, and that link is written
before the flip (step 3), so a redirect can name a session that is not the
owner yet: in the interrupted window above the target's own restore fails,
and in the step-3 window it succeeds with no worktree attestation at all.
Exact-loading the target and requiring `persisted-v1` plus the expected
canonical path is what keeps either shape out of the registry — a redirect is
an instruction to verify, not a title deed, and a caller that persists
`replacementSessionId` on the strength of the 409 alone can adopt an id the
retried reset then reaps.

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
unverifiable state.

The reachability premise that came with the removal was too wide, and round 4
corrects it. The reviewer-run E2E on #10643 did find the branch unreachable
for the shapes it exercised, but "raw non-Channel load has a known
`currentCwd`" does not hold for a cold restore: the bridge's cold-restore
response reports no `currentCwd` at all, and its `hasActivePrompt` counts the
restore `ask_user_question` prompt it admitted (`restorePromptAdmitted ||
promptActive || goalTurnActive`). Parking versus firing that prompt is what
decides the shape — a Channel restore parks it through the deferral above,
while a restore that asked for no deferral fires it and returns
`hasActivePrompt: true` with no recorded cwd. A supported non-Channel cold
restore of a Part 4A session whose transcript ends on an unanswered question
— with the daemon's opt-in `restoreAskUserQuestion` enabled, which is what
re-hangs it, and a client id supplied, which is what lets it fire — therefore
reaches the check with a live prompt inside the worktree the child restored
for itself, and an unconditional throw turns it into a 500 that kills the
session it just recovered.

The invariant is consequently narrower than a blanket "an unlocated active
prompt fails closed": a restore whose prompt was fired rather than parked is
not treated as outside its worktree. Parking is what makes an unlocated
prompt readable as inactive; a fired prompt is a live turn whose location the
response simply does not report. The fail-closed throw keeps its purpose for
a prompt the route cannot locate and that the restore did not fire.

The shipped shape gates the throw on the deferral having been available,
rather than parking the restore prompt for every Part 4A worktree restore:
the under-attesting branch stays removed for any restore that could have
deferred, and returns only for one that could not
(`hasActivePrompt && !attached && currentCwd === undefined &&
!deferRestoreAskUserQuestionPrompt`). A restore that asked for the deferral
and still reports an unlocated active prompt fails closed through the
existing `Active session is outside its worktree` check; a restore that never
asked for one keeps the pre-4B outcome — worktree metadata attached without
the `persisted-v1` attestation the route cannot earn, no relocation, no kill.
That retains R1-2's silent under-attestation for exactly this one shape,
deliberately: an isolation-aware caller rejects an unattested response at its
own identity gate, which is a recoverable refusal, while failing the restore
closed destroys a session the caller just recovered inside a checkout a
non-suppressed restore lets the child place itself in. A non-Channel
regression test pins it — no persisted source, a load response with an active
prompt and no `currentCwd`: `200`, worktree attached, no `changeSessionCwd`,
no kill — and goes red if the unconditional throw returns.

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

The load path learns the superseded redirect inside the router, not the
manager: when the daemon surfaces the typed `worktree_session_superseded`
error, `loadManagedSession` reads the replacement ID off it, exact-loads that
ID once (a second superseded response is a genuine failure, not another
hop), heals the route mappings that pointed at the superseded session, and
returns the healed ID alongside `loaded`. The manager's `loadTask` consumes
that ID for every registry write it makes — a heal that is folded into the
stored owner rather than rebuilt from the pre-heal snapshot — so `use`,
`close`, and lock resolution cannot clobber it.

The typed restore failures map to the bounded messages shown above on the
shared named-session error surface, which every selection, message, and
`/clear` path already reports through: `worktree_marker_missing` to the
recovery message and `worktree_reset_interrupted` to the interrupted-transfer
message. Both codes are produced only by the load/resume route, so they reach
that surface wrapped in the manager's generic load failure rather than the
reset call — the reset route resumes an interrupted transfer itself. A reset
refused because a session is busy keeps its own cancel-first wording, and
every other daemon failure keeps the existing generic named-session message.

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
- Restore-time marker-missing failure returns the recovery message above, and
  an interrupted transfer the retry message above — each in its selected-task
  or not-selected shape. The daemon error carries no task identity, so the
  manager threads the failing task's name to the message surface on the error
  it throws (`NamedSessionTaskError.taskName`); without it the message can
  neither name the task nor tell whether that task is the selected one, and
  falls back to the unnamed, clear-free wording.

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
- `S_old` after reset: its transcript and catalog record persist, and restore
  fails closed for every caller with the typed `worktree_session_superseded`
  redirect and the replacement ID. The pre-load stop that emits it is
  Channel-scoped, but the Part 4A validation every non-live restore runs
  repeats the check before it consults the marker, so a non-Channel caller
  receives the same typed code rather than the ordinary non-typed Part 4A
  integrity `409` — and simply fails closed on it. Every non-live Part 4A
  restore takes the worktree-keyed ownership lock for the same reason: the
  reset route is public, so a source-less restore must not attest exclusive
  ownership while a transfer moves it. `S_old` never reclaims the worktree.

## User-facing error classes

Bounded messages, no paths, session IDs, or daemon bodies — a task name is
allowed, and the two recovery classes below interpolate one:

- busy worktree reset (cancel-first guidance); the reset-pending barrier
  reuses the same typed `worktree_reset_active` refusal, and no chat-facing
  message exists for it by decision — the Channel owner lock keeps users out
  of the window, so only a non-Channel API caller can meet it;
- daemon without the reset capability;
- invalid or unavailable worktree state during reset (generic named-session
  failure with the existing narrow categories);
- marker missing at restore (recovery guidance: clear to recreate, or close)
  — offered only when the failed task is the selected one, since clearing
  always acts on the selection; otherwise the message names the failed task
  and points at selecting it first or closing it with `/session close`, which
  needs no load of the target;
- interrupted transfer (retry guidance: clear again to finish), under the
  same selected-task condition and with the same not-selected alternative;
- superseded task restoration otherwise heals silently, surfacing only if
  the replacement fails validation, as a generic load failure.

## Implementation sequence

1. Bridge deferred-prompt visibility (R8-2): one shared definition of
   prompt-in-progress covering the parked map, consumed by the coalescer and
   `getSessionSummary` — and explicitly not by the restore response's
   `hasActivePrompt`; the reset-pending barrier primitive (set, refuse
   admission, clear); the attach-severing and worktree-association clearing
   surfaces the transfer's step 6 needs, with severing reporting whether the
   superseded entry is actually gone so step 6 can surface a survivor.
2. Core marker primitive: a synchronous no-follow strict marker reader beside
   the async one (for the `assertCanCommit` re-check), then
   `transferWorktreeSessionMarkerOwner` with the foreign-uid refusal and the
   compare-and-swap commit shapes, and strict-reader tests for every crash
   window.
3. Daemon route `POST /session/:id/worktree-reset`: worktree-keyed
   serialization (widening the restore lock into
   `acquireWorktreeOwnershipOp`), preconditions, resumable transfer protocol,
   rollback, capability registration.
4. Restore changes: superseded redirect, interrupted-transfer signal,
   missing-marker typed failure, and the narrowing of the under-attesting
   `hasUnlocatedRestoredPrompt` branch to the restores that could not defer
   their prompt — every other unlocated active prompt fails closed.
5. SDK route method and worker forwarding; bridge capability gate; router
   replace operation and superseded handling; manager reset; messages.
6. Documentation updates (see below).
7. Focused tests at each layer, then repository build/typecheck/lint, the
   daemon-backed Channel E2E plan, and the required audit passes.

## Expected production scope

- `packages/acp-bridge/src/bridge.ts`, `bridgeTypes.ts`, and
  `bridgeErrors.ts` (deferred-prompt visibility in the summary and coalescer,
  the reset-pending barrier and its typed admission error, attach severing,
  worktree-association clearing)
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
- Recovery advice is state-dependent: with a second, healthy task selected, a
  marker-missing or interrupted failure on another task names that task,
  points at `/session close <name>`, and never tells the user to clear again
  — a following `/clear` still acts on the selection, which is exactly why
  the advice must not recommend one. The selected-task wording is pinned
  verbatim by its own cases.
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
  check and is cleared by every pre-flip failure path — past the flip the
  release belongs to a completed severance, not to the failing request; the
  pre-flip re-verify aborts a transfer whose prompt state changed. The same
  barrier refuses the other writers that can reach the checkout or move the
  session cwd — a rewind, a cwd change, a branch, a fork-agent launch, a
  shell command, a workflow-task action, or a goal control admitted
  mid-transfer must each reject with the same typed failure, and deleting any
  one guard must turn its test red.
- Two concurrent resets against sessions sharing one worktree (the
  post-transfer shape) cannot both win: the second fails the lock, the owner
  re-check, or the publishing link's `EEXIST`.
- Crash injection at every transfer step proves the documented outcome:
  pre-transfer crashes leave `S_old` authoritative; post-transfer crashes
  restore `S_new`; a retried reset completes a half-finished transfer exactly
  once, and a marker that already names `S_new` makes the resume a no-op. The
  backward-link-only window (step 3 crashed, no replacement sidecar) is
  pinned as fail-closed `worktree_reset_invalid_state` with the interrupted
  state untouched — the write order is what makes that window observable to
  the retry instead of invisible.
- Post-flip resume with a busy replacement: crash past the marker flip, make
  `S_new` busy (a client reached it through the superseded redirect), retry
  the reset of `S_old` — the route fails closed with `worktree_reset_active`
  and the marker, `S_new`'s sidecar, and `S_new`'s record all survive; a
  later retry once `S_new` is idle completes as a no-op resume. The
  destructive rollback must never run against the session the marker names.
- Controlled failure at steps 3–5 compensates to the exact pre-reset state.
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
  returns. Its fired-prompt counterpart is covered beside it: a non-Channel
  cold restore of a Part 4A session whose transcript ends on an unanswered
  question, whose load response reports an active prompt and no `currentCwd`,
  returns 200 with the worktree attached instead of a 500 that kills the
  session it just recovered.
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
and the route resumes a half-finished transfer on retry. The two sidecar
writes are ordered for the same reason: `supersededBy` on `S_old` lands
first, so no window leaves a forward link that nothing reads and a retry
cannot see. Every window is enumerated in the protocol above with its
outcome, including which ones a retry rolls back (an agreeing link pair) and
which ones fail closed for operator repair (a disagreeing pair, an invalid
marker, an ambiguous owner, a live replacement with no marker).

### Reset of a busy task

Risk: transferring ownership while a prompt executes in the worktree races
file writes and the marker flip.

Control: quiescence is enforced as a barrier plus a re-check, not a sample —
the bridge refuses new work on a reset-pending session from the precondition
gate until the flip, covering prompt admission and the seven other writers
that can reach the checkout or move the session cwd (`sendPrompt`,
`rewindSession`, `changeSessionCwd`, `branchSession`,
`launchSessionForkAgent`, `executeShellCommand`,
`controlSessionWorkflowTask`, `controlSessionGoal`), and quiescence is
re-verified immediately before the flip. A rewind is the reason the fence
cannot stop at prompts: it is admitted precisely in the idle state the route
requires, chains onto the same queue, and sets none of the flags the pre-flip
re-check reads — and so do the two control writers, a workflow action that
runs through the session's own tool registry in that cwd and a goal `resume`
that starts a turn never passing `sendPrompt`. A shell command is the
strongest of the eight — it runs in the entry's effective cwd, which for a
relocated worktree session is the checkout itself — so it is fenced too.
Those eight are the whole fence, and it is not a fence on everything that
reaches the child: the release and stop paths stay usable mid-transfer by
design (`cancelSessionTask`, `clearSessionGoal`, `detachClient`,
`killSession`), `continueSession` is refused transitively at the
`sendPrompt` admission it drives its continuation through rather than gated
itself, and the daemon-internal `enqueueBackgroundNotification` is ungated
because no HTTP route calls it and it enqueues a notification rather than
starting a turn. The Channel refuses busy tasks up front (`isBusy` covers
queued, running, and permission-pending states); the user cancels first. A
parked deferred restore prompt counts as busy once the visibility fix lands,
so a task stopped on a recovered question cannot be reset out from under the
question.

### Concurrent reset double-win

Risk: after a completed or crashed transfer, two sessions hold valid sidecars
naming the same worktree; two concurrent resets could both claim the marker.

Control: serialization is keyed on the canonical worktree path, the commit is
a compare-and-swap (owner re-check at the rename commit for the `valid`
shape, `EEXIST` from the publishing link for the `missing` shape), and a
superseded sidecar routes to the resume path rather than starting a
competing transfer. The second-place finisher fails closed in all shapes.

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
(`assertCanCommit`) or exclude by absence (`EEXIST` on the exclusive
publish).

### Transfer ownership by unlink + exclusive create

Rejected for the `valid`-owner shape. The window between unlink and re-create
leaves the worktree ownerless; a crash there forces reliance on the recovery
hatch for a routine operation. (For the `missing` shape an exclusive create
is exactly right and is what the primitive uses — staged in a sibling and
published by the link.)

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

Rejected during this design's review. It is the only path in the series that
deletes user-visible state, and review showed its correct shape (call-site
placement, `kind === 'removed'` gating, supersede-link refusal, the
safe-delete branch invariant) needs a dedicated review cycle rather than
riding beside a part whose contract is "no deletion of user-visible state".
It is fully specified in follow-up issue #11024.

## Exit criteria

Part 4B is complete when: a worktree task resets in place with files intact;
busy and deferred-prompt-parked reset refuse cleanly; a missing marker is
recoverable only through reset; a tampered marker never recovers
automatically; a half-finished transfer is completed by retry and healed
through the superseded redirect; the under-attesting restore branch is gone
and the deferred-prompt visibility fix closes R8-2; and no path deletes
user-visible or pre-existing state — rollback removes only the replacement
session's own sidecar and record.

Issue #10103 closes when the above holds **and** the remaining dispositions
in the table are satisfied: the four residual fixes (R8-1, R8-3, R1-1, F3),
included in this PR, and follow-up issue #11024 (reap cleanup, the sibling
delete path, and the `SessionRouter.ts:487` investigation) resolved or
explicitly accepted by a maintainer.
