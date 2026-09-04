# Channel Named Sessions: Part 4B

## Status

Proposed. Parts 1, 2, 3A, 3B, and 4A are merged. This design is the final
planned delivery for issue #10103. It enables conversation reset for
worktree-isolated tasks, absorbs the review findings that Part 4A explicitly
deferred to Part 4B, and closes the issue's remaining acceptance gap: users
can `clear` their named tasks, and worktree tasks survive `close`/`clear`
without losing files.

Part 4A landed in #10643 (merge commit `37cb9ac161`). Its design deferred
selected-task reset for worktree tasks to this part, with an exit criterion
that this design satisfies directly:

> Its design must define an atomic or compensatable daemon operation that
> creates a fresh conversation while retaining the selected task's exact
> verified worktree, transfers marker/sidecar ownership safely, does not
> delete files, and fails closed on active, stale, foreign, ambiguous, or
> partial state.

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
ownership chain, spawns a fresh session (`S_new`) in the same registered root
workspace, relocates `S_new` into the same worktree, writes a new sidecar for
`S_new`, marks the old sidecar superseded, transfers the in-worktree ownership
marker from `S_old` to `S_new` with an atomic rename, and only then attests
`worktreeState: "persisted-v1"` for `S_new`. The response payload has the same
shape as the Part 4A create/load response, so the Channel worker validates it
through the existing exact-identity chain.

The old session is never deleted by reset. Its transcript and persisted record
remain in the daemon catalog, and its superseded sidecar makes any later
restore of `S_old` fail closed with a typed `worktree_session_superseded`
signal carrying the replacement session ID, which lets the Channel registry
self-heal if a crash interrupted a committed reset.

The daemon advertises a new capability `session_worktree_reset_v1`; the worker
checks it before sending a reset request, exactly as Part 4A gated creation on
`session_worktree_persistence_v1`.

Three review findings deferred from #10643 are Part 4B scope and are covered
here:

1. Missing-marker recovery (yiliang114 on `session.ts:4189`; chiga0 F1):
   restore distinguishes a missing marker from a tampered one, and reset is
   the sanctioned recovery path — adoption recreates the marker when the
   sidecar proves ownership.
2. Deferred-prompt restore attestation (yiliang114 on `session.ts:4201`;
   chiga0 F2/R1-2): the `hasUnlocatedRestoredPrompt` restore branch relocates
   and attests before firing the deferred prompt.
3. Reap-path worktree leak (yiliang114 on `session-archive.ts:656`): orphan
   session deletion now removes the owned worktree and branch when ownership
   is unambiguous and the checkout is clean.

Two smaller items ride along because they touch the same code: the
`createWorktreeSessionMarkerExclusive` empty-file leak on write failure
(chiga0 R1-1), and the `/session new --worktree` parser wart that routes a
missing task name into a confusing name-validation error (chiga0 F3).

## Goals

1. `/clear`, `/new`, and `/reset` on a selected worktree task produce a fresh
   conversation in the same verified worktree, with no file deletion.
2. Ownership transfer is compensatable: every crash window either leaves the
   old session authoritative or is completed by an idempotent retry or a
   typed superseded redirect. No window strands the task.
3. A missing ownership marker is recoverable through reset; a tampered marker
   is never recovered automatically.
4. Reset refuses a task that is running or waiting for permission, with an
   actionable message; the daemon re-verifies quiescence.
5. Absorb the three deferred review findings above without weakening any
   Part 4A fail-closed boundary.
6. Keep shared tasks, disabled `multiSession`, and all Part 2/3 behavior
   unchanged.

## Non-goals

- Deleting a task or its registry record. Task purge is a separate feature;
  names of closed tasks remain occupied, as in Part 2.
- Physical worktree deletion on close, clear, worker shutdown, or detach.
  The only new deletion path is the orphan-reap cleanup below.
- Automatic merge-back, push, rebase, or conflict resolution for worktree
  branches.
- Copying uncommitted root-checkout changes anywhere.
- Named worktrees for standalone Channels, webhooks, loops, group history,
  or non-`user` session scopes.
- Resetting a running or permission-pending task. The user cancels first.
- Changing Part 3 labels, permission correlation, cancellation, registry
  schema (stays version 1), transcripts, or audit hashes.
- The general stale-worktree sweep. Reap cleanup applies only to a session
  the daemon is already deleting as an orphan, never to named user worktrees
  that still have a persisted session.

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
  session ID, created with `O_EXCL | O_NOFOLLOW` plus inode pinning, read with
  the strict no-follow reader (`readWorktreeSessionMarkerStrict`), and
  git-ignored through the repository's common `info/exclude`.
- The sidecar is a per-session JSON file in daemon session storage
  (`sessionService.getWorktreeSessionPath(sessionId)`), holding `slug`,
  `worktreePath`, `worktreeBranch`, `originalCwd`, optional `workspaceCwd`,
  `originalBranch`, `originalHeadCommit`; the strict reader returns
  `missing | valid | invalid` without collapsing corruption into absence.
- `deleteDaemonSessionIfOrphan` removes the persisted session record when the
  session is provably orphaned, but never touches the worktree or branch —
  the leak yiliang114 flagged.
- The `hasUnlocatedRestoredPrompt` restore branch sets worktree metadata but
  skips relocation and never assigns `worktreeState`, so the Channel-side
  identity check fails on the next selection — chiga0 F2.
- `/session new --worktree` without a name falls through to
  `create('--worktree', 'shared')`, which the name validator rejects with a
  misleading message — chiga0 F3. (The claimed silent shared-task creation
  does not occur; `TASK_NAME_PATTERN` rejects a leading hyphen. Only the
  message is wrong.)

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

Reset of a worktree task that is running or waiting for permission fails
before any side effect:

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

### Listing and status

`/sessions`, `/sessions all`, `/session current`, and `/session use` output is
unchanged; reset does not alter names, isolation labels, or ordering beyond
the existing `lastSelectedAt` bump.

### Parser fix (F3)

`/session new --worktree` without a task name now returns the bounded usage
line instead of a task-name validation error.

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
- `worktree_reset_active` — the session has an active prompt or pending
  interactions.
- `worktree_reset_invalid_state` — stale, foreign, tampered, containment
  failure, or ambiguous ownership. Always non-destructive.
- `worktree_session_superseded` — see the redirect below. Also used by
  load/resume.

### Preconditions (all fail closed)

The route holds the existing per-session worktree-restore serialization
(`acquireWorktreeRestore`) keyed on `S_old` for the whole operation, and the
lock is widened so that every route-owned Part 4A worktree restore — not only
the deferred-prompt shape — takes it. A restore of `S_old` can therefore never
pass marker validation concurrently with a transfer that is about to flip the
marker. The runtime generation is captured before the first side effect and
re-asserted before the response, as in create/load.

1. `S_old` exists in the persisted catalog for this workspace runtime.
2. Strict sidecar read for `S_old` is `valid`, carries `workspaceCwd`
   realpath-matching the resolved root, an `originalCwd` within the accepted
   roots, and a contained `worktreePath` — the same checks as Part 4A restore.
3. Quiescence: the live bridge entry for `S_old`, if any, has no active
   prompt and no pending interactions (`getSessionSummary`: `hasActivePrompt`
   false, `pendingInteractionCount` zero — a parked deferred restore prompt
   counts as pending). A session unknown to the live bridge is dormant and
   therefore quiescent. Attached clients do not block reset: the worker's own
   client stays attached to an open task until reset succeeds, so the
   transfer severs `S_old`'s residual attaches instead of requiring none (see
   step 6). The Channel refuses busy tasks before any of this (`isBusy`
   covers running and permission-pending, and prompt resolution for the owner
   takes the same owner lock the manager holds across reset, so no new
   Channel prompt can be admitted mid-transfer); this daemon check is the
   server-side fence for any other caller.
4. Marker state is either `valid` naming `S_old`, or `missing`. `missing` is
   the recovery hatch: it is accepted only together with a valid sidecar and
   a catalog record, i.e. the ownership chain minus exactly one link.
   `invalid` (tampered, foreign, unreadable, unsafe type) rejects.
5. The worktree directory exists and realpath-resolves inside a managed
   worktree root.

If `S_old`'s sidecar already records `supersededBy: S_new`, a previous reset
crashed mid-transfer. The route then revalidates the recorded replacement:
when `S_new` exists in the catalog, its own sidecar is strict-valid for the
same worktree, and it is quiescent, the route completes the interrupted
transfer for that same `S_new` (idempotent resume). When `S_new` does not
validate, the route rolls the partial attempt back to the pre-transfer state —
remove `supersededBy` from `S_old`'s sidecar, delete `S_new`'s sidecar,
orphan-confirmed-remove `S_new` — and then proceeds with a fresh replacement.
Either way a retried `/clear` converges on exactly one owner instead of
piling up replacement sessions.

### Transfer protocol

Ordered steps, with the crash behavior of each:

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
   restore fails closed and a retry of the reset resumes and completes the
   transfer. This is the one window where the task is temporarily
   unrestorable, and retry is the documented repair.
5. Transfer the marker to `S_new` (primitive below). This is the point of no
   return.
   Crash before the rename: marker still names `S_old`; a retried reset
   resumes and completes. Crash after the rename: marker, both sidecars, and
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
newOwner)`:

1. Strict-read the marker. Require `valid` with `sessionId ===
expectedOwner`, or `missing` when `expectedOwner === null` (the recovery
   hatch). Any `invalid` state or owner mismatch fails closed.
2. Write `newOwner` to a sibling temporary file created with
   `O_EXCL | O_NOFOLLOW` and the existing inode-pinning checks, fsync it, then
   `rename` it over `.qwen-session` and fsync the directory. Rename is atomic
   and replaces whatever occupies the path — including a symlink swapped in
   after validation — without ever following it, so the verify-then-replace
   window cannot redirect the write outside the worktree.
3. The temporary file name is covered by the same `info/exclude` treatment as
   the marker so a mid-transfer `git add -A` cannot stage it.

A crash between 1 and 2 leaves the old marker intact; a crash during 2 leaves
either the old or the complete new content — never a partial file, so the
strict reader never sees a truncated marker from this primitive.

Also fix `createWorktreeSessionMarkerExclusive` (R1-1): unlink the freshly
created empty marker when the write or sync fails, so a failed create does
not permanently wedge the path with an `EEXIST`-raising empty file.

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
fail-closed behavior and is never auto-recovered. This resolves chiga0 F1's
permanent-bricking concern without weakening the tamper boundary.

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

### Deferred-prompt restore attestation (F2/R1-2)

In the restore route, the `hasUnlocatedRestoredPrompt` branch currently calls
`setSessionWorktree` and skips both relocation and the `persisted-v1`
assignment. Change it to perform the full sequence before the deferred prompt
is admitted: `changeSessionCwd` into the verified worktree (safe here because
the deferred prompt is parked, not in the prompt queue), require the returned
path to match, then `setSessionWorktree`, generation re-assert,
`persisted-v1`, and only then `fireDeferredRestoreAskUserQuestionPrompt`.
If relocation cannot complete, the restore fails closed and the deferred
prompt is discarded through the existing discard hook — matching every other
worktree restore failure.

### Reap-path worktree cleanup (deferred item 3)

When `deleteDaemonSessionIfOrphan` has definitively removed a persisted
session (`removal.kind !== 'error'`), and that session owned a worktree, the
daemon now attempts bounded cleanup:

1. Strict sidecar read for the removed session: must be `valid` and carry a
   `workspaceCwd` matching this runtime's root.
2. Strict marker read at the sidecar's worktree path: must be `valid` and
   name exactly the removed session. A missing or invalid marker preserves
   the worktree — ownership is no longer unambiguous.
3. Containment re-verified against the managed worktree root.
4. The checkout must be clean: `git status --porcelain` inside the worktree
   reports no tracked modifications and no untracked, non-ignored files. The
   ignored `.qwen-session` marker does not count. A dirty checkout is user
   work product; it is preserved and logged.
5. Only then `removeUserWorktree(slug, { deleteBranch: true })`.

Any failure, ambiguity, or doubt preserves the worktree and branch and logs
the session ID and slug for operator recovery. Reset, close, detach, registry
failure, and restore paths remain non-destructive; this cleanup exists only
inside a deletion the daemon had already committed to.

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
   isolation, target, timestamps preserved), commit the registry atomically,
   activate the new session with the task's stored cwd, and forget the old
   session — the same post-success steps as a shared reset.

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
manager also maps the typed `worktree_marker_missing` restore failure to the
bounded recovery message shown above; every other daemon failure keeps the
existing generic named-session message.

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
- The usage line for `/session new` is unchanged; the missing-name `--worktree`
  form returns the usage line (F3).
- Busy worktree reset returns the cancel-first message above.
- Restore-time marker-missing failure returns the recovery message above.

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

- busy worktree reset (cancel-first guidance);
- daemon without the reset capability;
- invalid or unavailable worktree state during reset (generic named-session
  failure with the existing narrow categories);
- marker missing at restore (recovery guidance: clear to recreate, or close);
- superseded task restoration (silent self-heal; surfaced only if the
  replacement fails validation, as a generic load failure).

## Implementation sequence

1. Core marker primitives: transfer-by-rename helper and the R1-1 unlink fix,
   with strict-reader tests for every crash window.
2. Daemon route `POST /session/:id/worktree-reset`: preconditions, resumable
   transfer protocol, rollback, capability registration.
3. Restore changes: superseded redirect, missing-marker typed failure, and
   the deferred-prompt relocation+attestation fix.
4. Reap-path cleanup with the ownership-and-clean-tree bar.
5. SDK route method and worker forwarding; bridge capability gate; router
   replace operation and superseded handling; manager reset; parser fix;
   messages.
6. Documentation updates (see below).
7. Focused tests at each layer, then repository build/typecheck/lint, the
   daemon-backed Channel E2E plan, and the required audit passes.

## Expected production scope

- `packages/core/src/services/gitWorktreeService.ts` (transfer primitive,
  R1-1 fix)
- `packages/core/src/services/worktreeSessionService.ts` (`supersededBy`)
- `packages/cli/src/serve/routes/session.ts` (new route, restore changes)
- `packages/cli/src/serve/capabilities.ts` (`session_worktree_reset_v1`)
- `packages/cli/src/serve/server/session-archive.ts` (reap cleanup)
- `packages/sdk-typescript/src/daemon/DaemonClient.ts` and
  `DaemonSessionClient.ts` (route method, replacement client)
- `packages/channels/base/src/ChannelAgentBridge.ts`,
  `DaemonChannelBridge.ts`, `SessionRouter.ts`, `named-session-manager.ts`,
  `ChannelBase.ts` (reset plumbing, capability gate, parser fix, messages)
- `packages/cli/src/commands/channel/daemon-worker.ts` (capability read)

Documentation updates: `docs/users/features/channels/overview.md` and
`docs/developers/daemon/15-channel-adapters.md` drop the "reset is deferred"
limitation and document cancel-first reset, file retention, and marker
recovery; `docs/developers/qwen-serve-protocol.md` and
`docs/developers/daemon/08-session-lifecycle.md` define the new route,
capability, typed errors, and the reap-cleanup bar.

Tests remain collocated. An E2E plan lands in `.qwen/e2e-tests/` during
implementation and is not committed.

## Verification plan

### Manager, router, command

- `/clear`, `/new`, `/reset` on a selected worktree task succeed on an idle
  task, keep name/cwd/isolation, and swap only the session ID.
- Busy (running or permission-pending) worktree reset rejects before any
  `ChannelBase` cleanup side effect; shared busy reset behavior unchanged.
- Reset response lacking `persisted-v1`, naming a different worktree, or
  naming the root detaches the new client and commits nothing.
- Superseded restore self-heals: registry moves to the replacement only after
  the replacement passes exact validation.
- `/session new --worktree` without a name returns usage.
- Cross-owner isolation, the eight-open-task cap, and case-insensitive name
  uniqueness are unchanged by the session-ID swap.

### Daemon route and transfer

- Full precondition matrix: unknown session, shared session, foreign
  workspace, wrong `originalCwd`, containment failure, active prompt, pending
  interaction, invalid marker, missing marker with valid sidecar (accepted),
  missing marker without catalog record (rejected), and residual attaches
  severed by the transfer rather than blocking it.
- Crash injection at every transfer step proves the documented outcome:
  pre-transfer crashes leave `S_old` authoritative; post-transfer crashes
  restore `S_new`; a retried reset completes a half-finished transfer exactly
  once.
- Controlled failure at steps 4–5 compensates to the exact pre-reset state.
- Marker transfer never follows a swapped-in symlink and never leaves a
  partial or empty marker; R1-1: failed exclusive create leaves no file.
- The worktree directory, its files (tracked, modified, untracked), and its
  branch are byte-identical across reset; only the marker content changes.

### Restore and reap

- Missing marker + valid sidecar: restore fails with the typed missing-marker
  signal; reset recovers; the recovery message reaches the chat.
- Invalid marker: restore and reset both fail closed; nothing is recreated.
- Deferred-prompt restore: relocation and `persisted-v1` precede the fired
  prompt; a Channel restore of that session passes identity validation
  afterwards.
- Reap cleanup: removes worktree+branch only for an unambiguously owned,
  contained, clean checkout whose session record was actually deleted; dirty
  checkout, missing/invalid marker, foreign workspace, and failed session
  removal each preserve everything and log.
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

### Destructive reap cleanup

Risk: the new reap cleanup is the only file-deleting path in Part 4B; a bug
could delete user work.

Control: deletion requires all of — the session record was actually deleted
first, a strict-valid sidecar for this runtime, a strict-valid marker naming
exactly that session, containment, and a clean `git status`. Each condition
alone is insufficient; any doubt preserves and logs. Dirty worktrees are
never touched, so uncommitted user work cannot be deleted by this path.

### Reset of a busy task

Risk: transferring ownership while a prompt executes in the worktree races
file writes and the marker flip.

Control: reset requires quiescence at both layers — the manager's `isBusy`
gate under the owner lock (no new Channel prompt can be admitted mid-reset
because prompt resolution takes the same lock) and the daemon's live-entry
check. The user cancels first; this is a documented, messaged difference
from shared tasks.

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

### Transfer ownership by unlink + exclusive create

Rejected. The window between unlink and re-create leaves the worktree
ownerless; a crash there forces reliance on the recovery hatch for a routine
operation. Temp-file + rename has no ownerless window and cannot leave a
partial marker.

### Reattach the old session ID to a fresh conversation

Rejected. Reusing the session ID conflates two conversations under one
transcript identity and breaks the daemon's per-session storage addressing.
A fresh ID keeps reset semantically identical to the shared-task reset the
rest of the system already models.

### Cancel-then-reset inside the daemon route

Rejected. Prompt cancellation is Channel-owned semantics with bounded
wind-down and wedged-turn handling; pushing it into the daemon route
duplicates that policy where it cannot observe the chat. Requiring
quiescence keeps one cancellation implementation.

### Delete the old session record during reset

Rejected. Shared reset retains the previous conversation in the daemon
catalog; worktree reset does the same. The superseded sidecar, not deletion,
is what prevents the old session from reclaiming the worktree.

## Exit criteria

Part 4B is complete when: a worktree task resets in place with files intact;
busy reset refuses cleanly; a missing marker is recoverable only through
reset; a tampered marker never recovers automatically; a half-finished
transfer is completed by retry and healed through the superseded redirect;
deferred-prompt restores attest before firing; orphan reap removes only
unambiguous, clean, owned worktrees; and the acceptance criteria of issue
#10103 — including per-task `clear` for both isolation modes — are all
satisfied so the issue can be closed.
