# Channel Named Sessions: Part 4A

## Status

Proposed. Part 1, Part 2, Part 3A, and Part 3B are merged. This design is the
first worktree-isolation delivery for issue #10103. It intentionally leaves
selected-task reset for Part 4B.

## Decision

Add opt-in worktree creation to daemon-managed named Channel tasks through the
existing command:

```text
/session new <name> --worktree
```

Part 4A forwards the daemon's existing `worktree: {}` session-creation option,
persists the daemon-reported worktree cwd in the version 1 named-session
registry, and preserves exact close, reopen, selection, ownership, and restart
behavior from Parts 2 and 3.

Enabling the Channel command is gated on a narrow daemon integrity slice. A
worktree create response is not successful until relocation, exclusive
no-follow marker creation, and sidecar persistence have all succeeded. Create
and load responses attest that verified state with
`worktreeState: "persisted-v1"`; a Channel worker requires that exact value.
This prevents an older daemon that returns worktree metadata but treats its
recovery files as best-effort from being accepted as restart-safe.

The daemon also advertises `session_worktree_persistence_v1`. The worker checks
that capability before it sends a worktree creation request, so discovering an
old daemon does not first create an inaccessible worktree. The capability is a
pre-side-effect compatibility gate; the per-response state remains necessary
to prove that this exact create/load completed its persistence checks.

Part 4A does not reset a worktree task. `/clear`, `/new`, and `/reset` fail
before cancellation or state mutation when the selected named task has
`isolation: "worktree"`. Part 4B will define how to replace the conversation
while retaining that exact worktree. Shared tasks keep their existing reset
behavior.

This is an explicitly staged subset of issue #10103. It does not claim the
issue's full clear acceptance criterion until Part 4B lands.

## Goals

1. Create an isolated daemon session for one exact owner and task without
   exposing the sender ID in the worktree slug.
2. Persist the actual worktree cwd returned by the daemon, not a path predicted
   by the Channel worker.
3. Reopen the exact daemon session after close or worker/daemon restart while
   keeping the worktree and transcript intact.
4. Preserve Part 3 concurrency, source attribution, permission correlation,
   and next-message selection semantics.
5. Keep shared tasks and disabled `multiSession` behavior unchanged.
6. Fail closed on unsupported daemons, missing or mismatched worktree metadata,
   stale sessions, foreign owners, malformed registries, and restore errors.
7. Make every worktree task acknowledged to a Channel recoverable after a
   process restart, without following or overwriting a repository-provided
   `.qwen-session` path.

## Non-goals

- Resetting or clearing a worktree task. That is Part 4B.
- Physically deleting a worktree on close, clear, worker shutdown, session
  detach, or registry failure.
- Automatic stale-worktree cleanup, branch deletion, merge-back, push, rebase,
  or conflict resolution.
- Copying uncommitted changes from the root checkout into a new worktree.
- User-supplied worktree slugs or paths. The task name is presentation and
  ownership data, not a filesystem identifier.
- Adding named worktrees to standalone Channels, webhooks, loops, group
  history, Channel memory, or non-`user` session scopes.
- Changing model text, transcripts, audit hashes, retry bodies, source labels,
  permission ownership, cancellation, or task concurrency.
- Depending on or merging the full Web Shell lifecycle work in PR #10226.
  Part 4A independently takes only the minimum daemon persistence and marker
  integrity behavior required before the existing API is safe for remote
  Channel creation; it does not add Web Shell UI or general cleanup behavior.

## Verified baseline

### Named-task authority

`NamedSessionManager` owns the version 1 workspace- and channel-scoped
registry. An owner remains exactly `(channelName, chatId, senderId)`. Each task
already stores its exact session ID, cwd, isolation, open/closed state,
timestamps, and original delivery target. `SessionRouter` keeps the selected
legacy route as a compatibility pointer and retains delivery metadata for
inactive live named sessions.

The manager is constructed for one daemon workspace cwd. Today a registry
copied from another workspace is recognized because every shared task cwd must
equal that root and is archived as stale. Once every task may instead carry a
worktree cwd, the registry needs one explicit root-scope value to preserve this
check. The manager's root remains the single routing authority for every task.

### Daemon worktree creation and restore

The TypeScript daemon SDK already accepts:

```ts
worktree?: { slug?: string };
```

Passing `{}` makes the daemon generate a collision-resistant slug. The slug is
independent of Channel owner and task data, so it does not expose a raw sender
ID or create a second user-controlled namespace.

`POST /session` already:

1. resolves the registered root workspace runtime;
2. requires a Git repository;
3. creates a user worktree below the repository's managed worktree root;
4. creates a thread-scoped daemon session;
5. relocates the session to the verified worktree path;
6. attempts to write the session marker and worktree sidecar; and
7. returns `workspaceCwd` and worktree `{ slug, path, branch }` metadata.

The current route catches and discards both recovery-file write failures, so a
successful response does not currently prove restart recovery. The current
marker writer also uses ordinary `writeFile`, which follows and overwrites a
pre-existing `.qwen-session` symlink checked out from the repository. Exposing
this path to a remotely initiated Channel command without a daemon-side gate
would be both a correctness and filesystem-integrity regression.

Load/resume uses the registered root workspace to find the exact session. The
daemon reads and validates its sidecar, checks realpath containment, relocates
the session into the worktree, and returns the restored metadata. A Channel
worker must not route a load through the unregistered worktree path.

Worktree creation starts from committed Git state. Uncommitted root-checkout
changes are not copied into the new worktree.

### Required daemon integrity slice

Before the Channel parser enables `--worktree`, the existing daemon route must
provide one narrow, reusable contract:

1. Add an exclusive marker-create primitive in the core worktree service. It
   opens `.qwen-session` with create-exclusive and no-follow semantics, verifies
   the opened object is a single-link regular file and still names the same
   inode, writes the session ID, syncs and closes it, and fails if any path was
   already present. It never replaces or adopts a marker.
2. Add a daemon-only strict marker reader. It performs a bounded, no-follow,
   single-link regular-file read with path/inode stability checks and returns a
   discriminated missing/valid/invalid result; symlinked, non-regular,
   oversized, unreadable, and identity-changing paths are invalid, not aliases
   for a legacy missing marker.
3. The daemon create route uses the exclusive primitive and awaits both the
   marker and atomic sidecar write. Newly written daemon sidecars record the
   registered workspace root separately as `workspaceCwd`. The route returns
   success only after both writes complete.
4. The daemon load/resume route requires a structurally valid sidecar, verified
   `workspaceCwd` equal to the server-resolved root workspace when that field is
   present, and accepts `originalCwd` only when it equals either that workspace
   root or its Git repository top-level. This preserves sidecars written by the
   existing tool/startup flows, where `originalCwd` is the repository root, and
   legacy daemon sidecars, where it is the registered workspace. Restore also
   requires realpath containment below one of those corresponding managed
   worktree roots, an exact marker owner equal to the restored storage session
   ID, successful relocation, and matching worktree metadata.
5. Create and load capture the resolved workspace runtime generation before
   their first side effect and assert that same generation remains open after
   relocation/persistence and immediately before the response. Starting,
   draining, replaced, removed, or generation-mismatched runtimes fail closed
   and never fall back to the primary runtime.
6. Advertise `session_worktree_persistence_v1` only when this complete contract
   is present.
7. Only after those checks does create/load return
   `worktreeState: "persisted-v1"` alongside worktree metadata.

The existing general marker reader and writer keep their current APIs and
marker adoption/deletion/transfer semantics in Part 4A. The only general-writer
change fixes placement of the best-effort Git ignore rule: it now resolves
`--git-common-dir` because Git does not honor a linked worktree rule written
under its per-worktree administrative directory. Changing any other marker
behavior for startup, the TUI, tools, agents, or workflow orchestration would
widen this delivery.
This separation is required because legacy exit paths may allow explicit
deletion when the existing reader returns `null`; collapsing a new invalid path
into that value would weaken their guard. The new exclusive creator and strict
reader each have exactly one production consumer: daemon worktree create and
restore in the existing session route.

If marker or sidecar persistence fails after relocation, the daemon invokes the
existing orphan-guarded session deletion. It removes the just-created worktree
and branch only when deletion confirms there is no other attached client. If
another client has attached or cleanup cannot be proven, it preserves the live
session and worktree, returns a bounded creation failure, and logs the exact
session ID for operator recovery. This is failed-create rollback before a
Channel task is acknowledged; it does not authorize deletion during close,
reset, detach, or registry failure.

Implementation must split relocation failure from post-relocation persistence
or generation failure. It must not route marker/sidecar errors through the
current `worktree cd failed` catch, whose unconditional worktree removal is safe
only when the session never entered that directory. Every failure after a
successful relocation uses the orphan-confirmed rule above.

### Current Channel gap

The Channel bridge session options and daemon-worker session factory do not
forward `worktree`. `ChannelAgentBridge.newSession()` returns only a session
ID, even though the attached daemon client already retains daemon session
metadata. `SessionRouter.createManagedSession()` consequently records the cwd
provided by the caller rather than the actual `worktree.path` reported by the
daemon.

The current registry validator accepts only `isolation: "shared"` and requires
every task cwd to equal the Channel workspace root. The command parser
recognizes any occurrence of `--worktree` only to return the deferred-Part-4
message.

## User-visible contract

### Command syntax

Accept only these creation forms:

```text
/session new <name>
/session new <name> --worktree
```

The flag is exact and case-sensitive. Misordered, duplicated, or extra
arguments use the existing bounded usage response. The existing task-name
validation, case-insensitive uniqueness, eight-open-task cap, and owner lock
apply before session creation.

Both acknowledgements identify the mode without exposing session IDs, paths,
slugs, or branches:

```text
Created and selected task "review" (shared workspace).
Created and selected task "feature-a" (worktree workspace).
```

`/sessions`, `/sessions all`, `/session current`, and `/session use` already
render the stored isolation value and therefore show `shared` or `worktree`.

### Selection, close, and reopen

Selecting a live worktree task changes only the compatibility route. Selecting
a dormant or closed worktree task exact-loads its persisted daemon session
through the root workspace and validates the returned worktree identity before
committing selection. Failed validation leaves the previous selection and
route unchanged.

Close keeps its Part 3 behavior: it rejects a busy task, persists the closed
record, detaches the client, retains the transcript and worktree, and selects
the most recently used remaining open task. Reopen never creates a replacement
when exact load fails.

### Clear/reset in Part 4A

When the selected task is a worktree task, `/clear`, `/new`, and `/reset`
return an actionable error such as:

```text
Task "feature-a" uses a worktree and cannot be cleared or reset yet. Continue
using the task or close it. Its files were not changed.
```

The rejection occurs inside the manager's serialized reset operation before a
new session is created. `ChannelBase` therefore returns before it clears group
history, bumps queue generations, removes permissions, cancels prompts, drops
buffers, changes the route, or discards a session.

Shared selected tasks continue through the existing create-persist-bind reset
and bounded cancellation path without new checks.

## Data model

### Isolation type

Expand the existing task isolation union from:

```ts
type NamedSessionIsolation = 'shared';
```

to:

```ts
type NamedSessionIsolation = 'shared' | 'worktree';
```

Use the shared type in public views and stored tasks. Do not duplicate the
worktree slug or branch in the Channel registry; the daemon sidecar is their
authority, and Channel commands do not need them.

### Cwd authority

For a shared task, stored `cwd` remains the Channel workspace root. For a
worktree task, stored `cwd` is the canonical actual worktree path returned by
the daemon after successful creation.

Do not add a per-task `workspaceCwd` field. Persist the manager root once at the
registry top level:

```ts
interface StoredRegistry {
  version: 1;
  workspaceCwd: string;
  owners: StoredOwner[];
}
```

The in-memory form and every newly written registry require `workspaceCwd`. A
legacy shared-only version 1 file may omit it; its existing per-task root
checks still establish the scope, and `readRegistry()` normalizes the in-memory
object to the current canonical root. The next successful owner commit writes
the top-level value. Reading alone does not rewrite the file.

Creation and load always pass the manager root to the daemon; the task cwd is
used only as an expected identity and as the selected route's actual cwd after
daemon validation. Registry version remains `1`: Part 2 deliberately
persisted an isolation field for this staged extension, and an additive root
scope does not reinterpret any legacy record. An older binary ignores the
unknown top-level field but rejects the new task enum value, failing closed
rather than silently treating a worktree task as shared.

### Registry validation

At registry-read time:

- a present file-level `workspaceCwd` must canonically equal the manager root;
- a missing file-level `workspaceCwd` is accepted only for a legacy registry
  in which every task is shared and passes the existing root-cwd check, then
  normalized in memory;
- shared tasks require the existing exact canonical workspace-root cwd;
- worktree tasks require a non-empty absolute cwd distinct from the workspace
  root; and
- owner, target, session-ID uniqueness, name, status, timestamp, and stale
  workspace checks remain unchanged.

If the registry is otherwise structurally valid but its top-level root (or a
legacy shared task cwd) belongs to another workspace, preserve the existing
stale-archive behavior. The Channel process does not use a persisted worktree
cwd to locate or create filesystem state. Realpath containment and worktree
ownership remain daemon responsibilities. A worktree record becomes
actionable only after the daemon loads the exact session and returns matching
metadata.

## Bridge and router contract

### Session creation option

Add the optional worktree creation request through the existing layers:

```text
NamedSessionManager.create(..., "worktree")
  -> SessionRouter.createManagedSession(rootCwd, worktree requested)
  -> ChannelAgentBridgeSessionOptions.worktree = {}
  -> DaemonChannelSessionFactoryRequest.worktree = {}
  -> DaemonSessionClient.createOrAttach(..., worktree: {})
```

The worker never derives or supplies a slug. It does not send a worktree option
while resuming an existing session; the daemon restores worktree state from
the session sidecar.

At worker startup, read the existing daemon capabilities envelope and pass a
`sessionWorktreePersistence` boolean into `DaemonChannelBridge`. A worktree
request is rejected inside the bridge before invoking its session factory when
that capability is absent. Keep this gate in the bridge rather than only in the
command parser so tests and future callers cannot bypass it. The exact
create/load response is still validated as described below.

### Returned session metadata

Extend the daemon SDK response and daemon-only Channel client interface with
optional `worktreeState: "persisted-v1"`. Extend `BridgeSessionInfo` with that
attestation and worktree `{ slug, path, branch }` metadata. The SDK client
already exposes a `worktree` getter; add the matching state getter.
`DaemonChannelBridge.listSessions()` exposes copied, read-only projections for
exact session lookup.

The SDK client's daemon-restart `reattach()` path is also part of this contract.
It currently refreshes only `clientId`. When the retained client was created or
loaded with `worktreeState: "persisted-v1"`, reattach must require the resumed
response to carry the same attestation and the same canonical worktree path
before accepting the new client ID. It then refreshes the cached worktree state
from that verified response. On mismatch it detaches the newly returned client
registration before throwing and leaves the cached identity unchanged. Missing
state, a changed path, or a shared fallback rejects reattach; the prompt is not
retried in the root workspace. Shared clients keep the existing client-ID-only
recovery behavior.

The optional daemon `currentCwd` response is not the worktree identity for
Part 4A. The creation route relocates the session after the bridge's initial
session object is formed, so that field is not guaranteed to be refreshed in
the response. The daemon-created and containment-validated `worktree.path` is
the stable reported execution root required by issue #10103.

Do not change `ChannelAgentBridge.newSession()` or `loadSession()` to return a
new object. Their string return type has many consumers, and the existing
session-info projection is sufficient for the daemon-only worktree path.

### Managed creation metadata

Keep `SessionRouter.createManagedSession()`'s existing string return type.
After creating a worktree session, the router validates daemon metadata and
records `worktree.path` in its existing session-ID-to-cwd map before returning
the exact session ID. The manager immediately reads that cwd through the
existing `getSessionCwd(sessionId)` method and requires it before staging the
registry record. Shared creation continues to record the requested root cwd
without requiring daemon-only metadata.

Worktree creation requires all of the following for the exact returned
session:

- the bridge exposes session information;
- `workspaceCwd` canonically equals the manager root;
- worktree metadata is present;
- `worktreeState` is exactly `"persisted-v1"`; and
- `worktree.path` is a non-empty absolute path distinct from the root.

If any condition fails, the router detaches the newly attached client, does not
publish target/cwd/live-route state, and reports a bounded unsupported-or-
invalid-daemon error. This prevents an old daemon that ignores the request from
silently creating a shared task. If the just-created session dies before the
manager reads its cwd, creation fails and no registry record is staged.

### Exact managed load

`SessionRouter.loadManagedSession()` receives the root workspace separately
from the stored expected task cwd. For a worktree task it calls
`bridge.loadSession(sessionId, rootCwd, ...)`, then applies the same exact
metadata and persistence-attestation checks and requires the returned worktree
path to match the canonical stored cwd.

If a newly loaded client fails validation, the router detaches it and leaves
all prior route, target, cwd, selection, and registry state unchanged. If the
session is already live, the router validates its existing exact session info
and stored routing cwd before rebinding.

For Channel-owned restores, daemon-side restore-integrity failure is
non-destructive. If the load attached to an already-live session, detach only
this request's client. If this request cold-restored a process, call
`killSession(..., { requireZeroAttaches: true })` to reap it only when nobody
else attached. Do not invoke `deleteDaemonSessionIfOrphan`: restore failure must
retain the transcript, sidecar, marker, branch, and worktree for exact
repair/retry. If an absent sidecar is indistinguishable from an ordinary shared
session at the route, the Channel bridge/SDK response validator performs the
same client detach before it rejects the missing attestation.

For Channel-owned restores with a Part 4A sidecar, or with sidecar state whose
ownership cannot be classified safely, the daemon route sets an internal ACP
metadata flag that suppresses the generic best-effort worktree restore
performed by the ACP agent. That best-effort path clears sidecars it deems
invalid, so suppressing it is what keeps Channel restore failure
non-destructive. The route then owns the strict sidecar, marker, containment,
and relocation checks. A persisted ask-user prompt is deferred until those
checks and any required relocation succeed, then fired exactly once; this
prevents the prompt from blocking relocation while preserving it on a valid
restore. A structurally valid legacy sidecar without the Part 4A `workspaceCwd`
attestation keeps the pre-existing generic best-effort restore behavior and may
return worktree metadata without `worktreeState`. It is never upgraded to
Part 4A isolation. The suppression and deferral are not applied to other load
and resume callers.

Shared loads otherwise retain current behavior. Part 4A does not reinterpret a
shared task if some independent in-session mechanism later changes its cwd.

## Creation flow and failure ordering

Worktree creation retains the Part 2 ordering:

1. validate owner, name, quota, and requested isolation under the owner lock;
2. request a new exact daemon session using the manager's root workspace and
   `worktree: {}`;
3. let the daemon relocate the session and confirm exclusive marker creation
   plus sidecar persistence before it returns success;
4. validate the exact daemon-returned root, worktree metadata, and
   `worktreeState: "persisted-v1"` attestation;
5. stage a task record with `isolation: "worktree"` and the returned cwd;
6. atomically persist the owner registry;
7. publish the in-memory registry/index; and
8. bind the selected compatibility route with the actual worktree cwd.

If daemon creation or metadata validation fails, no task or route is created.
The daemon may remove a failed create's session, worktree, and branch only
through the orphan-confirmed rollback defined above; uncertain or live state is
preserved.
If registry persistence fails after successful daemon creation, detach the
client and do not expose the task in chat. Preserve the existing Part 2
non-destructive rule: do not delete the daemon transcript, branch, or worktree.
The daemon catalog remains the operator recovery surface for this inaccessible
resource.

If route binding is invalidated by a concurrent bridge lifecycle change, use
the router's existing generation and binding-token cleanup. Never fall back to
a shared session or create an unrecorded replacement.

## Restart and recovery

The route file remains a compatibility pointer and may contain the actual
worktree cwd for the selected task. Daemon workers continue to restore routes
in lazy mode. Named inbound work resolves through `NamedSessionManager`, which
loads the exact selected task using the manager root rather than asking the
ordinary router path to replace a failed route.

After worker or bridge restart:

1. the version 1 registry rebuilds the task presentation index;
2. route entries remain dormant;
3. selecting or messaging an open worktree task exact-resumes its session
   through the root workspace;
4. the daemon validates its sidecar, exact marker ownership, containment,
   relocation, and worktree metadata, then attests `persisted-v1`;
5. the router compares returned metadata with the registry cwd and requires
   that attestation; and
6. only then is the route marked live and rebound.

If the Channel bridge still holds an SDK client across a daemon restart, the
first stale-client recovery performs the same attestation and exact-path check
inside SDK reattach before it retries admission. It must not rely on the
pre-restart cached attestation.

Missing sidecars, removed worktrees, path mismatches, containment failures,
wrong workspace roots, different session IDs, and daemon load errors all fail
closed. No fresh session is created and the previously selected task remains
selected where an operation attempted to switch tasks.

Legacy-route adoption remains shared-root-only. If the named registry is
absent and the compatibility route carries a non-root cwd, the manager does
not guess that it is a worktree task or adopt it under `default`; it detaches
that unknown route under the existing stale-route rule. A later normal message
may create a fresh shared `default` through the established Part 2 bootstrap,
but no worktree ownership, name, path, transcript, or presentation is inferred
from the route alone.

## Compatibility

- `multiSession` absent or false: no parser, bridge, registry, or output change.
- Named shared tasks: creation, load, close, reset, cwd validation, and output
  remain unchanged.
- New worker with an old daemon: the missing capability rejects a worktree
  request before daemon session creation. If capabilities drift or a daemon is
  replaced after startup, missing exact metadata or the `persisted-v1`
  attestation rejects the response. It never degrades to shared or assumes
  best-effort recovery is durable.
- New daemon with an old worker: no worktree option is sent.
- Non-Git workspace: creation fails without a task record or selected-route
  change.
- Existing version 1 registries containing only shared tasks load unchanged.
- Downgrade after creating worktree tasks: the older worker rejects the
  unsupported isolation value and fails closed.
- Part 3 labels remain presentation-only. The worktree path, slug, and branch
  never enter model prompts, transcripts, delivery labels, audit hashes,
  permission text, retry bodies, or chat output.

## User-facing error classes

Do not expose raw filesystem paths, daemon response bodies, stack traces, or
session IDs. Map worktree failures to bounded messages for:

- a non-Git workspace;
- daemon worktree creation failure;
- an incompatible daemon that did not return exact worktree metadata and the
  required persistence attestation;
- unavailable or invalid persisted worktree state during reopen; and
- Part 4A reset rejection.

The manager may preserve a narrow user-safe error category from the router;
all unknown failures retain the existing generic named-session message.

## Implementation sequence

1. Land the narrow daemon integrity slice: exclusive no-follow marker creation,
   a daemon-only strict no-follow marker reader, awaited marker/sidecar persistence,
   exact-owner restore validation, runtime-generation fencing, stage-correct
   failed-create rollback, the capability, and the `persisted-v1` response
   attestation.
2. Add the shared isolation and worktree-info types, daemon-client metadata and
   attestation projection, and worker forwarding. Verify every new option has a
   real caller and every read site.
3. Extend managed router creation/load to keep routing root and actual cwd
   separate, validate exact daemon metadata, and preserve current rollback.
4. Add the normalized registry-level workspace root, extend validation, and
   update manager create/load flows for `worktree` while keeping registry
   version 1.
5. Accept only the exact worktree command syntax and update acknowledgements.
6. Reject reset of a selected worktree task under the owner lock before any
   `ChannelBase` cleanup side effect.
7. Update the Channel user and daemon-adapter documentation with the
   shared-versus-worktree workflow, committed-state baseline, restart behavior,
   non-deletion contract, and temporary reset limitation.
8. Add focused daemon-integrity, manager, router, bridge, worker, base-command,
   compatibility, and restart tests.
9. Run the daemon-backed Channel E2E plan, repository build/typecheck/lint, and
   the required self-audit passes.

## Expected production scope

The implementation includes only the daemon and core changes needed to make a
remote worktree creation response safely restartable. Expected production
scope is:

- `packages/core/src/services/gitWorktreeService.ts`
- `packages/core/src/services/worktreeSessionService.ts`
- `packages/acp-bridge/src/bridgeTypes.ts`
- `packages/acp-bridge/src/bridge.ts`
- `packages/cli/src/acp-integration/acpAgent.ts`
- `packages/cli/src/serve/capabilities.ts`
- `packages/cli/src/serve/routes/session.ts`
- `packages/sdk-typescript/src/daemon/types.ts`
- `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`
- `packages/channels/base/src/ChannelAgentBridge.ts`
- `packages/channels/base/src/DaemonChannelBridge.ts`
- `packages/channels/base/src/SessionRouter.ts`
- `packages/channels/base/src/named-session-manager.ts`
- `packages/channels/base/src/ChannelBase.ts`
- `packages/cli/src/commands/channel/daemon-worker.ts`

Tests remain collocated with each changed implementation. An E2E plan belongs
under `.qwen/e2e-tests/` during implementation and is not committed.

The implementation also updates:

- `docs/users/features/channels/overview.md`
- `docs/developers/daemon/15-channel-adapters.md`
- `docs/developers/daemon/08-session-lifecycle.md`
- `docs/developers/qwen-serve-protocol.md`

User documentation recommends shared tasks for review or other coordinated
read-only work and `--worktree` for concurrent modifying work. It states that
new worktrees begin from committed state and that worktree reset is deferred,
while close and restart preserve the files.

The protocol and lifecycle documentation define the new capability and
per-response attestation, state that metadata alone is not restart-safety
proof, and document the exact create/load failure and rollback boundary for all
SDK callers rather than presenting it as Channel-only behavior.

The core marker change adds two daemon-only helpers: an exclusive creator and a
strict reader. The existing general reader/writer and all of their production
call sites retain their APIs and adoption/deletion/transfer semantics; the
general writer additionally places its best-effort ignore rule through
`--git-common-dir`, where Git honors it for linked worktrees. The daemon route
change is limited to create/load integrity and failed-create rollback. This
small cross-package/core feature still requires maintainer awareness under the
repository triage gate, and review must verify that both new helpers remain
route-only rather than inferring safety from their names.

If implementation requires a new daemon REST route, successful-lifecycle
worktree cleanup, general marker ownership transfer, registry version, task
ownership change, or broader Web Shell lifecycle behavior, stop and revise
this design instead of widening Part 4A.

## Verification plan

### Command and manager

- Exact shared and worktree creation syntax; reject reordered, duplicated, and
  extra arguments.
- Validate task names before daemon creation and preserve case-insensitive
  uniqueness and the eight-open-task cap across isolation modes.
- Persist returned worktree cwd and `isolation: "worktree"`; list/current/use
  display the mode without paths or IDs.
- Accept a legacy shared-only registry without `workspaceCwd`, normalize it on
  the next owner commit, and archive a structurally valid registry whose
  explicit root belongs to another workspace.
- Registry-write failure detaches the new client and exposes no task or route.
- Shared reset remains unchanged; worktree reset rejects before any manager or
  `ChannelBase` cleanup mutation.
- Owner A cannot list, select, close, cancel, approve, or reopen owner B's task
  even when task names match.

### Router and bridge

- Worker sends `worktree: {}` only for new worktree tasks and never on resume.
- Missing `session_worktree_persistence_v1` rejects inside the bridge before the
  session factory is called; shared creation remains available.
- Creation accepts matching root/worktree metadata only with the exact
  `persisted-v1` attestation and stores the actual cwd.
- Missing metadata, old-daemon shared fallback, mismatched root, mismatched
  worktree path, missing/unknown attestations, and dead-session races detach and
  fail without publishing maps.
- Exact load uses the root workspace, not the stored worktree path.
- Reopen accepts only the same exact session and canonical worktree path.
- Load mismatch or failure leaves the prior compatibility route unchanged.
- Bridge replacement invalidates stale create/load completions through the
  existing lifecycle generation and binding token.
- SDK reattach for an existing worktree client refreshes only after exact
  attestation/path agreement; missing sidecars, changed paths, and old-daemon
  responses detach the newly issued client and fail before prompt retry.
  Shared-client reattach is unchanged.

### Restart and lifecycle

- A clean daemon create awaits marker and sidecar persistence before returning
  `persisted-v1`; injected marker or sidecar failures never return success.
- A repository-provided marker file, symlink, directory, hard link, oversized
  file, or path-identity race fails without following or replacing it and
  cannot modify a target outside the worktree.
- Failed-create rollback removes the branch/worktree only after
  orphan-confirmed session deletion; a simulated second attachment or cleanup
  error preserves all uncertain live state.
- Runtime replacement or drain before the final create/load response fails
  closed. A post-relocation generation failure uses orphan-confirmed cleanup and
  never the relocation-only unconditional removal path.
- Close and reopen retain the same exact session, transcript, worktree path,
  and isolation.
- Worker restart restores the catalog lazily and reopens the exact worktree
  session on first use.
- Daemon restart restores only when sidecar, exact marker owner, containment,
  relocation, metadata, and `persisted-v1` attestation all agree before Channel
  binding.
- Restore-integrity failure detaches or zero-attach-reaps only the live client
  created by that attempt; it never deletes persisted transcript or worktree
  state, and a concurrent attachment prevents reaping.
- Missing, stale, foreign, removed, symlink-escaped, or mismatched worktree
  state fails closed and never creates a shared replacement.
- A missing registry never adopts a non-root compatibility route as a named
  worktree task; background delivery from that unknown route fails closed.
- Close, Channel-registry persistence failure, and Part 4A reset rejection never
  call a destructive daemon data or worktree deletion path. Only a daemon-local
  failed create may use the separately tested orphan-confirmed rollback.

### Concurrent E2E

Use a temporary Git repository and a daemon-managed Channel test transport:

1. create one shared review task and at least two worktree development tasks;
2. verify all three exact session IDs and distinct cwd values;
3. run overlapping prompts, switch selection, and confirm each late result
   keeps its Part 3 source label and edits only its own cwd;
4. verify uncommitted changes in the root checkout are absent from newly
   created worktrees;
5. close and reopen one worktree task without changing its files or path;
6. restart the worker and daemon and resume the same tasks lazily;
7. verify another owner in the same group can use the same task names but
   cannot address the first owner's sessions; and
8. verify disabled mode and unsupported Channel configurations remain
   unchanged or fail closed as before.

### Repository checks

Run focused tests from their package directories, then:

```bash
npm run build
npm run typecheck
npm run lint
```

Use the repository-required test engineer for baseline and post-fix daemon-
backed E2E verification. Complete the required broad diff audits, including
new untracked files, and require two consecutive clean passes before delivery.
Verify that user and developer command documentation no longer describes
worktree creation as wholly deferred and does not imply that Part 4A supports
worktree reset or deletion. Verify that protocol documentation lists the new
capability and response field and distinguishes the preflight gate from the
per-operation attestation.

## Risks and controls

### Duplicate cwd authority

Risk: storing both a task root and worktree cwd would permit drift and could
route a restore through an unregistered directory.

Control: persist the registry scope once, keep the manager root as the only
daemon routing cwd, and keep the task cwd as daemon-validated execution
identity. Never repeat the root per task or send the stored worktree path as
`workspaceCwd`.

### Silent fallback on old daemons

Risk: an old daemon may ignore the worktree field and create a shared session,
or may return worktree metadata while silently losing marker/sidecar writes.

Control: require `session_worktree_persistence_v1` before sending the request,
then require exact returned worktree metadata and the new
`worktreeState: "persisted-v1"` attestation before registry or route commit.
Capability alone and metadata alone are both deliberately insufficient.

### Repository-controlled marker path

Risk: committed repository content can pre-create `.qwen-session` as a symlink,
file, directory, or hard link. Ordinary marker writes could overwrite or follow
that path when a remote Channel user creates a task.

Control: daemon creation uses a create-exclusive, no-follow, inode-checked
marker primitive and fails on every existing path. Restore uses the separate
strict reader and exact session ownership; it never treats an unreadable,
symlinked, or non-regular path as a legacy missing marker or proof of ownership.

### Partial daemon persistence

Risk: relocation succeeds but marker or sidecar persistence fails, leaving an
unrecoverable session that the Channel registry records as restart-safe.

Control: the daemon withholds both HTTP success and the `persisted-v1`
attestation until all state is confirmed. On failure it uses orphan-confirmed
rollback, deleting the fresh worktree only when no other client can own it and
otherwise preserving uncertain state for operator recovery.

### Stale client state across daemon restart

Risk: the SDK Channel client survives a daemon restart and its automatic
reattach retains the pre-restart worktree metadata while refreshing only the
client ID. A missing sidecar could then resume the session in the root checkout
and retry the prompt there.

Control: a retained worktree client treats its cached state only as an expected
identity. Reattach requires a fresh `persisted-v1` response and the same
canonical worktree path before updating the client or retrying admission.
Failure never falls back to a shared cwd.

### Persisted path tampering or staleness

Risk: a copied or edited registry could contain a foreign path.

Control: the Channel registry never authorizes filesystem access. Exact daemon
session load, sidecar validation, realpath containment, returned-path match,
and owner-scoped registry lookup must all succeed before binding.

### Resource left after registry failure

Risk: daemon session creation succeeds but Channel registry persistence fails,
leaving an inaccessible worktree.

Control: detach and report the failure without destructive cleanup, matching
the established Part 2 recovery contract and issue #10103 non-deletion scope.
Operators can recover the exact session from the daemon catalog.

### Partial clear behavior

Risk: users expect `/clear` to work for every named task.

Control: reject worktree reset before side effects with an explicit message,
document the temporary Part 4A limitation, and keep issue #10103 incomplete
until Part 4B provides same-worktree conversation replacement.

## Alternatives reviewed

### Derive a worktree slug from owner or task name

Rejected. It exposes or correlates Channel identity, creates a second naming
and collision policy, and duplicates daemon slug validation. `{}` already
provides collision-resistant, non-identifying allocation.

### Store both root workspace cwd and actual cwd per task

Rejected. Repeating the same root on every task creates unnecessary drift and
migration surface. One registry-level root preserves stale-workspace detection
without making each task carry two routing candidates.

### Predict the worktree path from the generated slug

Rejected. The daemon owns repository-root resolution, slug validation,
creation, containment, and relocation. Channel persists only returned data.

### Pass the worktree path as daemon workspace cwd on reopen

Rejected. Worktree paths are not registered multi-workspace runtimes. Restore
must resolve the root runtime and let the daemon validate its sidecar.

### Change bridge create/load to return session objects

Rejected for Part 4A. It widens a stable interface and many mocks when the
existing exact session-info projection can expose the required metadata.

### Delete a newly created worktree after registry persistence failure

Rejected. It widens Part 4A into destructive lifecycle policy, differs from
Part 2's inaccessible-session contract, and can turn uncertain failure
recovery into data loss.

### Trust worktree metadata as proof of restart safety

Rejected. The daemon on `main` already returns `{ slug, path, branch }` while
swallowing marker and sidecar write failures. A versioned per-response
attestation is required to make mixed worker/daemon versions fail closed.

### Wait for or merge all of PR #10226

Rejected as a Part 4A dependency. That PR carries a broader Web Shell lifecycle
and unresolved review state. Part 4A specifies and tests only the exclusive
marker creation, route-only strict read, exact-owner restore, persistence gate, and
attestation it needs; it neither copies unrelated cleanup policy nor assumes
the PR's eventual shape.

### Ship existing reset behavior for worktree tasks

Rejected. It either tries to route daemon creation through an unregistered
worktree path, silently creates a different worktree, or loses marker/sidecar
ownership. All violate exact recovery or file-preservation semantics.

### Implement same-worktree reset in Part 4A

Rejected as a staging decision. It requires a new daemon lifecycle contract
and marker/sidecar transfer or replacement semantics. That work is separable
from creation, close, reopen, and restart isolation and belongs in Part 4B.

## Exit criteria for Part 4B

Part 4B may start only after Part 4A proves exact creation and restart recovery.
Its design must define an atomic or compensatable daemon operation that creates
a fresh conversation while retaining the selected task's exact verified
worktree, transfers marker/sidecar ownership safely, does not delete files, and
fails closed on active, stale, foreign, ambiguous, or partial state.
