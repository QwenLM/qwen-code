# Relaxed Standalone Daemon Ownership

## Status

Proposed for [Issue #10810](https://github.com/QwenLM/qwen-code/issues/10810).
Once accepted, this decision supersedes the process-global cross-daemon
ownership requirement in the [standalone daemon sessions
contract](./standalone-daemon-sessions.md), which accompanies Issue #8908. All
other isolation, persistence, and lifecycle requirements remain in force. The
current implementation still enforces process-global Conversations ownership
until the source changes in this design are delivered.

This decision adopts Issue #10810's session-keyed concurrency boundary,
identity-qualified stale-writer recovery, legacy-owner migration guard, and
minimum Web Shell degradation. Backend and Web Shell implementation may land in
separate pull requests, but both are required in the same release. A proactive
`activeElsewhere` listing hint remains a follow-up.

## Decision

Allow every updated `qwen serve` process to lazily create its own Conversations
runtime for the shared Conversations root after the legacy compatibility check
passes. The daemon no longer acquires a user-global process owner before serving
standalone APIs. Every standalone session instead acquires the existing
cross-process session writer lease before it can write. The lease is forced for
every writer hosted by the Conversations runtime so Live and scheduled-task
sessions cannot bypass the same-session fence.
Conversations writers and standalone lifecycle operations use a hardened local
reclaim policy that recovers only an active record proven to come from a dead
or PID-reused process in the same local identity domain: the same hostname and,
on Linux, the same boot and PID namespace. A matching live process, including a
stalled process, remains fenced.

This intentionally aligns standalone startup with ordinary workspace startup:
multiple daemons may point at the same persistent workspace, while each daemon
keeps its own ACP bridge, child process, live-session index, caches, and runtime
generation.

This is a session-partitioned concurrent-use contract, not unrestricted
multi-master support. Updated daemons may concurrently list the shared catalog,
create sessions, and host different session IDs. Competing writers and
lifecycle mutations for the same session remain serialized by that session's
writer lease. The change does not add cross-daemon routing, a shared live-state
index, atomic multi-session operations, or distributed cache invalidation.

## Motivation

The current user-global owner record makes the first daemon that touches
standalone or Live block standalone access from every other live daemon. A Web
Shell connected to a second daemon therefore receives
`503 conversation_runtime_in_use` even when it only needs the shared catalog, a
new chat, or a different session.

Ordinary workspaces do not impose a process-global runtime owner. The simpler
and more consistent policy is to let each daemon serve independent sessions
while the existing session writer protocol protects the actual shared-write
boundary.

## Behavioral contract

- `GET /standalone/session-options` and every `/standalone/sessions` route may
  initialize the local daemon's Conversations runtime even when another updated
  daemon process is alive.
- Another updated daemon no longer causes `conversation_runtime_in_use`. During
  migration, a live legacy runtime-owner record still returns that error until
  the old daemon exits.
- If daemon A has session S loaded, daemon B may still list the shared catalog,
  create a new standalone session, and create, restore, or use a different
  session that is not held by another writer. Different session IDs may remain
  active in different daemons at the same time.
- A client remains attached to the daemon on which it created or restored an
  active session. Prompt, cancel, permission, status, heartbeat, detach, and
  SSE event routes are not forwarded to another daemon.
- Creating or restoring a standalone session acquires its session writer lease
  regardless of the user's `experimental.sessionWriterLease` setting. A second
  daemon attempting to open the same active session receives the existing
  `409 session_writer_conflict` response. Single-session rename or repair uses
  the same top-level response. Batch lifecycle routes keep their existing `200`
  result envelope but preserve any session-writer error kind in the affected
  item's `errors[]` entry. No new active-elsewhere error kind is added.
- Every other session hosted by the Conversations runtime, including Live and
  scheduled-task sessions, uses the same mandatory lease. This prevents
  background keepalive or task rehydration from silently restoring an already
  active transcript through a non-standalone source.
- Live discovery remains single-publisher, but a Live session on its elected
  daemon may coexist with different standalone sessions on another daemon.
  Standalone routes continue to reject Live records.
- An unsealed active lock left by a non-cooperative process exit is reclaimed
  only when the new daemon can prove that the record belongs to the same local
  identity domain and that the recorded process has exited or its PID has been
  reused. Foreign or incomplete identity remains fenced. A process with a
  matching live identity is never reclaimed based on age or inactivity.
- The lease owner is the ACP writer process, not merely its daemon parent. If a
  daemon parent dies but its child remains alive with the matching identity,
  other daemons remain fenced until that writer exits or is terminated.
- Normal switching of a persisted session to another daemon requires a
  cooperative writer handoff. An explicit per-session close or normal idle reap
  releases the lease; graceful managed-daemon shutdown seals it so the
  replacement can use the existing certified-takeover protocol. A
  non-cooperative exit is the narrow identity-qualified recovery exception.
  Both paths perform a cold restore, not hot migration.
- Daemons share persisted standalone sessions only when they resolve the same
  Conversations root and runtime base. Custom runtime bases retain the same
  storage separation they have for ordinary workspaces.
- Cross-process catalog changes are eventually visible through the existing
  persisted-session cache. Live state is merged only from the receiving
  daemon, so daemon B may list a session active in daemon A as persisted but
  inactive until a restore attempt returns `session_writer_conflict`. No
  cross-daemon cache or live-state invalidation is added.
- Source isolation remains unchanged. Standalone listing, restore, and lifecycle
  routes accept only top-level standalone records and continue to fail closed
  for Live-owned or otherwise foreign records.
- Concurrent background reconciliation of one deletion-journal entry is
  serialized by that session's lifecycle writer lease. A sweep that encounters
  `session_writer_conflict` treats the entry as being handled by another daemon,
  skips that UUID, and continues without converting contention into a
  compromised-record result.
- If two daemons simultaneously rehydrate the same scheduled-task-bound
  session, the mandatory writer lease admits exactly one resident session. The
  losing rehydration records the restore failure through the existing
  rehydration result and error-reporting path, then follows the existing
  keepalive backoff without firing that session's task.

Same-session exclusivity applies to the complete active-session lifetime, not
only to overlapping HTTP requests. A session that remains loaded in daemon A
cannot be continued or mutated through daemon B merely because daemon A is idle
between requests.

## Safety retained

Removing process ownership does not turn the Conversations root into an
ordinary user-selected workspace. The implementation retains:

- exact Conversations-root validation and directory identity checks;
- internal-runtime isolation and the prohibition on primary-runtime fallback;
- per-daemon runtime generation, activity drain, and terminal quarantine;
- per-session lifecycle coordination inside each daemon;
- durable standalone deletion journals and recovery checks;
- existing writer leases for lifecycle mutations;
- mandatory active-session writer leases throughout the Conversations runtime;
- identity-qualified recovery of provably stale same-domain active locks;
- the legacy runtime-owner compatibility check during migration;
- Live discovery's own single-publisher record and validation.

Daemon-local create admission, live owner indexes, lifecycle coordinators,
directory state, reconciliation singleflight, and cache invalidation are not
cross-process authorities. They may make remote live state appear inactive or
delay catalog freshness, but they do not decide write ownership. The
cross-process writer lease remains authoritative for each transcript and its
lifecycle, scheduled-task file mutations retain their existing cross-process
file lock, and deletion reconciliation acquires the affected session's lease.
The contract does not promise globally fresh live state, cross-daemon event
routing, or atomic operations spanning multiple session IDs.

## Implementation

### Replace the outer owner with a legacy compatibility check

`ConversationRuntimeManager` no longer accepts a long-lived
`ConversationRuntimeOwnership` dependency and no longer calls `acquire()` in
`ensure()`. Before creating its first local Conversations runtime, it instead
invokes an inspect-only compatibility check for the legacy runtime-owner
record. Runtime creation continues to revalidate the exact root before
publishing the daemon-local managed runtime.

The compatibility check reuses the existing owner-directory identity checks,
directory lock, strict version-1 record parser, PID liveness rule, exact-record
cleanup, durability sync, and handoff grace. A valid record whose PID is still
live returns `conversation_runtime_in_use`. A valid stale record is removed
under the directory lock and rechecked before the daemon proceeds. Malformed,
unsafe, or uncertain state preserves the current compromised or unavailable
failure. The check never writes a new owner record and does not participate in
Live discovery handoff.

The check is one-shot for that daemon generation. It is not repeated after the
Conversations runtime is published and therefore cannot detect a legacy owner
record created later. This proposal accepts that limitation under the
drain-and-cutover requirement below rather than adding owner polling or runtime
read-only degradation.

`createServeApp` constructs only that compatibility checker; it does not attach
a Conversations owner to `ServeAppLifecycleController`. The lifecycle
controller therefore has no Conversations ownership to release after shutdown;
its listener, app, host, and runtime drains remain unchanged. Once legacy
versions that write the record are outside the supported upgrade window, the
inspect-only check and owner artifacts may be removed in a follow-up.

### Require the writer lease for the Conversations runtime

Force the existing writer protocol at the runtime-provenance boundary, not at
the session-source boundary. When the daemon builds a workspace runtime whose
validated provenance is `live-conversation`, its bridge adds one private,
enable-only marker to that runtime's ACP child environment. Primary, secondary,
scratch, and other ordinary workspace bridges do not receive it.

The CLI entry point captures and deletes the private marker beside the existing
private parent capability before its first await or any environment-file load.
It accepts the marker only for ACP mode, only when that capability is present,
and only at the exact enable value. A sandbox relaunch carries the accepted
marker together with the private capability through the existing private child
environment; an ordinary relaunch does not. The entry point passes the result
to `runAcpAgent` as an internal boolean rather than asking the agent to read the
mutable process environment.

`runAcpAgent` folds that boolean into the existing process-start writer
snapshot. The effective value is true when either the trusted runtime marker
was accepted or the user's startup setting enabled the lease. Per-request
settings reloads continue to use that frozen value, so one ACP process never
mixes leased and legacy writers.

The accepted marker remains an immutable Conversations-runtime provenance
signal inside the ACP process. The same captured boolean drives both mandatory
writer leasing and the scheduled-task eligibility rule below; no second
environment marker or public setting is added.

For a trusted managed child carrying the Conversations marker, `runAcpAgent`
sets `reclaimPolicy: 'local'` and keeps `takeoverPolicy: 'certified'`. Other
trusted managed workspace children keep `reclaimPolicy: 'never'`; the marker
does not relax their container-safety contract. Before the Conversations path
selects `local`, Core hardens that policy with the host, boot, and PID-namespace
checks below.

The ACP bootstrap `Config` remains recording-disabled and is not a transcript
writer. The frozen value is merged into settings before each real session's
`loadCliConfig` call. This preserves the existing restore ordering that defers
transcript projection until writer acquisition and prevents a forced lease
from being applied only after a session has already read mutable state.

The daemon's shared child-environment overrides explicitly remove the marker by
default, then the `live-conversation` bridge replaces that undefined value with
the enable value. Add the key to the existing hard-coded project-environment
exclusions so a workspace `.env` or settings reload cannot reintroduce it. The
CLI entry point also deletes the key again immediately after initial settings
and environment loading so a user-level `.env` value cannot leak to tools or
later child processes. Together these rules prevent inherited shell and
file-loaded environments from marking primary and secondary runtimes while
retaining the accepted value only in immutable local state.

This makes standalone independent of user configuration without introducing a
public setting or command-line flag. Scoping the marker to one bridge preserves
ordinary workspace behavior and also covers every source that the dedicated
runtime can host, including standalone, Live, scheduled-task controller, and
scheduled-task run sessions. A source-based override would miss background
sessions whose persisted source is not `standalone`.

The default `runQwenServe` runtime factory owns this wiring. Its per-runtime
channel factory is produced by `createSpawnChannelFactory`, which merges the
factory's second argument into the actual child environment through
`scrubChildEnv`. `createSpawnChannelFactory` marks every returned factory with
a package-owned, immutable child-environment-forwarding capability;
`defaultSpawnChannelFactory` carries the same capability because that helper
creates it. The check uses the capability, not reference equality with the
default factory, because `runQwenServe` supplies a separately configured
factory to every runtime.

`createAcpSessionBridge` derives one private immutable mandatory-lease
attestation from the conjunction of two conditions: the frozen child-environment
overrides carry the exact Conversations marker, and the selected
`channelFactory` carries the forwarding capability. Immediately before each
spawn, the bridge combines the frozen overrides with the fresh private parent
capability in the factory-argument map, so an attested factory forwards both
values to the child. A marker-shaped override map paired with an unattested
custom factory that ignores the second argument does not attest.

`ConversationRuntimeManager` includes the bridge attestation in its
owned-runtime validation before it accepts an existing registered runtime or
publishes a new candidate. A missing or false attestation is a static runtime
contract violation: it rejects and disposes or quarantines the runtime as the
existing non-retryable `conversation_root_compromised`, and the runtime is never
exposed to standalone, Live, scheduled-task, lifecycle, or maintenance callers.

An embedded runtime factory supplied through `createServeApp` must either use a
factory returned by `createSpawnChannelFactory` or explicitly attest an
equivalent custom factory at the factory level through the trusted embedding
seam, then construct its bridge with the exact marker. An unattested custom
factory remains valid for ordinary bridges but fails Conversations publication;
setting `provenance: 'live-conversation'` or supplying a marker-shaped override
map alone is insufficient. A test fake may deliberately attest its factory
through the dedicated test seam without spawning a child, but publication tests
must still exercise the conjunction rather than infer it from the bridge
options' shape. This is a contract against accidental same-process miswiring,
not a security boundary against embedding code that already has authority to
construct arbitrary runtime objects.

The ACP session must acquire the lease during config initialization before it
reports successful creation or restore. It retains the lease until session
shutdown and uses the existing `session_writer_conflict`,
`session_writer_lost`, `session_transcript_changed`, and
`session_writer_unavailable` mappings.

`StandaloneSessionService` selects the same hardened `local` policy for its
parent-side lifecycle and maintenance acquisitions, including deletion-journal
reconciliation. This lets archive, unarchive, delete, repair, and recovery make
the same stale-owner decision as the ACP writer they fence. Generic workspace
lifecycle routes and other managed runtimes keep their existing `never` policy.

The lease protects one transcript and its lifecycle. It does not coordinate
session-list reads, random-ID generation, daemon-local managed-directory state,
SSE routing, or Live discovery. Those paths keep their existing persistence,
identity, and source-isolation checks; their daemon-local observations are not
used as proof that a remote writer is absent.

The fence covers only updated, cooperating writers hosted by the marked
Conversations runtime. A legacy daemon or another process that writes the same
transcript without acquiring the protocol lease can still bypass it. The lease
is an integrity protocol, not an operating-system access-control boundary.

### Reclaim only provably stale local active writers

Strengthen the existing `local` reclaim policy before selecting it for a
managed Conversations writer. On Linux, an active schema-version-2 record adds
an optional `pid_namespace_id` beside the existing hostname and
`process_start_identity`; the latter already contains the boot ID and process
start ticks. Writers record both identities when the platform exposes them. A
reader treats an older or newly written record without either identity as live
and never automatically reclaims it.

Reuse Core's `readPidNamespaceId()`, `readLocalBootId()`, and conservative PID
liveness behavior while preserving the writer lease's existing persisted
`process_start_identity` format. `EPERM` or `EACCES` remains live; only a PID
proved absent, a validated zombie, or a readable start-identity mismatch can
support the stale verdict after the identity-domain checks pass.

An active Linux record is eligible for stale recovery only when its hostname,
boot ID, and PID namespace exactly match the contender and one of these
conditions is proven inside that namespace: the PID no longer exists, or the
PID exists with a different process-start identity. The implementation reuses
the existing reclaim guard, exact-record reread, atomic stale-record move, and
transcript verification after that verdict. It never decides from lock age,
acquisition time, heartbeat absence, or daemon responsiveness.

Darwin and Windows keep their existing platform process-start probes and
require an exact hostname and a recorded start identity for managed local
recovery. A definitely absent PID with that recorded identity is stale; a live
PID is stale only when its current start identity is readable and differs. If
an identity needed for either verdict is unavailable, and on platforms without
a supported identity probe, the record remains live for reclaim purposes. PID
reuse may therefore cause a safe false conflict but never permits an unproven
takeover.

A PID with a matching live start identity remains `session_writer_conflict`,
including when its event loop is stalled. Foreign-host, foreign-boot,
foreign-namespace, identity-less, malformed, non-regular, and uncertain records
remain fail closed. The `local` policy applies only to unsealed active records;
sealed records still require certified transcript takeover. Any transition
claim, including a residual one, is never reclaimed based on process liveness.

A normal per-session close removes its exact active record. Graceful managed
shutdown durably seals the record, and another managed daemon can take it over
only after verifying the transcript proof. A non-cooperative exit from a
steady active state becomes recoverable on the next qualified local
acquisition. Ambiguous transition and storage failures still require an
authoritative external writer fence before manual cleanup.

Forcing the lease also makes graceful managed shutdown seal and hash every
active Conversations transcript. The implementation does not silently lengthen
the existing child-termination deadline. Measure representative maximum
active-session and transcript sizes against that budget as a performance
observation. If the timeout ends in process death while the primary record is
still a well-formed active record, qualified-successor reclaim is the recovery
path. Delivery must still prove that timeout and cancellation do not leave a
residual claim or uncertain transition, because those states continue to fail
closed.

### Retire owner writes without removing migration or state-directory safety

The behavior change stops constructing, acquiring, and releasing a long-lived
file owner, but retains the minimal inspect-and-retire path needed for old
versions. It does not delete the remaining owner implementation and focused
tests in the same change. Keeping that code for the first patch avoids mixing
the ownership-policy change with a large cleanup. A follow-up may remove it
after the migration window has closed and the new behavior has been validated.

Move the small subset of path creation and validation logic needed by
`StandaloneDeletionJournal` into that class. Do not add a replacement
ownership service or a standalone abstraction with only this one consumer. The
journal derives its state parent directly and retains private-directory
creation, identity validation, and durability checks; it has no owner record,
process liveness check, lock, grace period, acquire, or release operation.

`StandaloneDeletionJournal` validates that parent before entering its journal
subtree on every read, recovery, clear, and write path. Reads treat a missing
state directory as empty; the first write safely creates it. An existing unsafe
or replaced parent fails the journal operation closed, and the existing
journal-directory identity checks continue around each filesystem mutation.
This preserves the trust and bootstrap responsibilities that the old ownership
`acquire()` performed implicitly instead of accidentally making deletion
depend on Live discovery having run first.

The existing reconciliation singleflight remains daemon-local. Each journal
UUID still enters its session lifecycle lease before reading or mutating the
transcript. If a background sweep loses that acquisition to another daemon, it
skips the UUID and continues the triggering operation; it does not classify
ordinary lease contention as journal compromise. A direct lifecycle request
for that same session keeps the normal structured conflict response.

New daemons never create or replace
`conversations/runtime-owner.json`. They inspect it under the existing
`conversations/.runtime-owner.lock`: a live old-version owner keeps the current
`conversation_runtime_in_use` response, while an exactly revalidated stale
record is durably removed. The lock remains a transient guard for this
compatibility operation and is not held for the runtime lifetime.

The server retains `conversation_runtime_in_use` only for this old-version
migration case and for existing Live-specific mappings. Updated daemons do not
emit it merely because another updated daemon has mounted Conversations.
`conversation_runtime_unavailable`, `conversation_root_compromised`, and
daemon-local runtime-invariant failures remain unchanged.

### Keep Live discovery separate

Keep the ownership protocol in `live/discovery.ts` unchanged. Its owner record
selects one discoverable Live host and protects publication of that endpoint.
The removed Conversations owner currently performs the stable-base discovery
handoff as a side effect of runtime acquisition, while the publication path
performs that handoff only for non-stable target bases. Move that responsibility
to the Live publication path: immediately before `writeLiveDiscoveryFile()`,
call `handoffLiveDiscoveryOwner()` for every target base, including the stable
base. Conversations runtime initialization itself no longer participates in
Live discovery ownership.

A stale discovery record can therefore still be reclaimed through the existing
validated handoff before publication. An active foreign Live owner still blocks
publication, and failure to publish Live discovery does not disable standalone
routes on that daemon.

Live discovery remains single-publisher, while the Conversations writer lease
is session-scoped. A Live session on the elected publisher may therefore run at
the same time as a different standalone session on another daemon. If another
daemon reaches the same transcript, the writer lease rejects it; standalone
routes continue to reject Live-owned records regardless of lease availability.

### Harden scheduled-task activation without adding another lease

Keep scheduled-task persistence, keepalive, and boot rehydration. Scheduled-task
controller and run sessions inherit the mandatory writer lease from the
Conversations runtime before restore succeeds. A daemon that loses the lease
cannot make that bound session resident; boot rehydration records the failure,
and keepalive uses its existing retry backoff.

Multiple daemons may read the same scheduled-task file and simultaneously try
to restore the same bound session while otherwise idle. Lease acquisition
occurs before that session's scheduler can activate, so exactly one restore may
become resident and fire bound tasks. The losing restore must not execute or
book the task. Its conflict is retained in the existing rehydration result and
`onError` path, not appended as a scheduled-task run. Existing cross-process
task-file mutation locking and persisted `lastFiredAt` state remain unchanged.

This prevents duplication caused solely by concurrent restore. It does not
upgrade the scheduler to exactly-once delivery: the existing at-least-once
window after a prompt is dispatched but before its fired state is durably
persisted remains unchanged, including across a subsequent owner crash.

Unbound durable tasks need a separate admission rule because two keepalive
workers may initially mint different controller session IDs, so a session
writer lease cannot elect between them yet. In the marked Conversations ACP
runtime, install a scheduler eligibility predicate before durable loading that
refuses to fire any unbound durable task. The daemon keepalive remains the only
component that binds such a task. Its existing `updateCronTasks` transaction
rechecks the unbound state under the cross-process task-file lock, commits one
controller session ID, and tears down a losing orphan. Once that binding is
visible, only the matching bound session is eligible to fire the task. Ordinary
workspace schedulers retain the existing unbound lock-owner behavior.

The default `runQwenServe` path enables the daemon-managed binding worker. An
embedded host that opts into the Conversations marker without enabling that
worker leaves unbound Conversations tasks dormant; it must not fall back to
legacy lock-owner execution. Bound tasks continue to use their recorded session
ID and the session writer lease in either host shape.

Keep the existing product boundaries: durable cron jobs remain unsupported in
standalone sessions, and generic scheduled-task routes cannot create a new
session in the Conversations workspace. This change only fences existing
background writers; it does not add standalone scheduling functionality.

### Ship minimum Web Shell degradation in the same release

Do not add an `activeElsewhere` list field or a new client-side owner-discovery
protocol. Every daemon can list persisted standalone sessions after the outer
gate is removed, while an attempt to restore a session held by another daemon
continues to return the existing `409 session_writer_conflict`.

The backend and Web Shell work may land as separate pull requests, but the
release is incomplete until the client presents the resulting states locally:

- standalone list failures and the transitional
  `conversation_runtime_in_use` response render once in the Recents section,
  not through the global error toast on every navigation-triggered refetch;
- `session_writer_conflict` and `session_writer_unavailable` from opening a
  session render on the affected row or section with a retry action rather than
  as a global toast.

An `activeElsewhere` hint remains deferred because listing has no authoritative
cross-daemon live-state index. The client reacts to the existing attach-time
error contract instead.

### Do not add routing or coordination

The change adds no daemon-to-daemon proxy, redirect, shared owner index,
heartbeat, global lifecycle lock, or distributed cache invalidation. Existing
session routes continue to resolve owners only among runtimes inside the
receiving daemon.

No new setting or command-line flag is introduced. Supporting both exclusive
and relaxed ownership modes would retain the full old subsystem and create a
mixed-mode compatibility problem without serving the requested default.

## Error contract

| Condition                                                                        | Result                                                                                               |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Another updated daemon has a different session loaded                            | Listing, new-session creation, and operations on the different session continue                      |
| Another updated daemon has the session loaded for open, rename, or repair        | `409 session_writer_conflict` for that session                                                       |
| A batch archive or delete includes a session loaded by another updated daemon    | Existing `200` batch envelope with that item's `errors[].code` set to `session_writer_conflict`      |
| A well-formed active owner is provably dead in the same local identity domain    | Reclaim, authoritative transcript reload, then continue                                              |
| The active owner is live, stalled, foreign, or missing required reclaim identity | `409 session_writer_conflict` for that session                                                       |
| The writer record is malformed or non-regular, or a transition claim remains     | `503 session_writer_unavailable` for that session                                                    |
| A valid sealed record has matching transcript proof                              | Certified takeover, authoritative reload, then continue                                              |
| A sealed record's transcript proof no longer matches                             | `409 session_transcript_changed` for that session                                                    |
| A Conversations bridge lacks the mandatory-lease attestation                     | Reject and dispose or quarantine the runtime; non-retryable `503 conversation_root_compromised`      |
| A live legacy runtime-owner record exists                                        | `503 conversation_runtime_in_use` for the standalone surface during migration                        |
| Legacy ownership state is malformed, unsafe, or uncertain                        | Existing `conversation_runtime_ownership_compromised` or `conversation_runtime_unavailable` response |

For every writer-state row, a batch lifecycle route preserves the same error
kind in its existing `200` per-item result rather than changing the batch's
transport status.

The Web Shell renders list-level failures and the transitional runtime-owner
error in the Recents section. It renders same-session writer errors on the
affected session or section with retry, without sending navigation-triggered
refetch failures through the global toast path.

## Compatibility and rollout

The REST and SDK object shapes are unchanged. The daemon batch serializer must
stop collapsing session-writer errors into
`standalone_session_operation_failed` and preserve the existing writer error
kind in the affected item's string `code`; the SDK already accepts string batch
codes. `standalone_sessions_v1` and `standalone_session_options_v1` continue to
describe API support, and no capability is added for the concurrency guarantee.

Rollout is a drain-and-cutover, not a rolling mixed-version upgrade. Stop every
daemon version that can host standalone sessions without the mandatory lease,
confirm its sessions have closed, and only then start daemons with this change.
If this order is violated in the old-to-new direction, the new daemon honors a
live legacy runtime-owner record and returns
`503 conversation_runtime_in_use`; after the old daemon exits, the next runtime
initialization removes the stale exact record and proceeds without a restart.
This compatibility guard reduces the failure mode but does not make a rolling
mixed-version deployment supported.

The compatibility check is not repeated after runtime publication, so it cannot
detect the reverse direction: an old daemon started after updated daemons have
mounted Conversations finds no owner record, writes one, and may run an
unleased ACP writer beside leased writers. All daemons sharing one Conversations
root must therefore be upgraded together. The owner-record format is not
extended with a lease-aware marker because older strict readers would reject
the new shape as compromised.

The writer-lock schema-version-2 owner record accepts the optional
`pid_namespace_id`; updated Linux writers populate it when available and
updated reclaimers require it together with the existing start identity. A
pre-existing or new active record without the complete identity is compatible
for conflict detection but cannot be reclaimed automatically. The upgrade
preflight must drain those writers or, after an authoritative external writer
fence, clear residual records explicitly. Rollback must close or drain all
updated Conversations writers and confirm that no active, sealed, claim, or
identity-extended record remains before an older non-participating daemon
starts; graceful process exit alone may intentionally leave sealed handoff
records.

Release notes must state that:

- multiple daemons may expose standalone sessions for the same user;
- active sessions are daemon-local;
- different session IDs may be active concurrently across updated daemons,
  while a second writer or lifecycle mutation for the same session is fenced;
- same-session conflicts reuse `session_writer_conflict`, including in the
  existing per-item error of a batch lifecycle response;
- standalone sessions always use the writer lease, even when the experimental
  setting is absent or false;
- Live and scheduled-task writers in the Conversations runtime use it as well;
- simultaneous scheduled-task rehydration admits only one resident owner and
  does not provide exactly-once delivery beyond the scheduler's existing
  persistence semantics;
- an unbound task cannot fire from a Conversations session until the
  cross-process task-file transaction has committed its controller binding;
- standalone list and attach failures use the inline Web Shell treatment above
  instead of repeated global navigation toasts;
- a provably dead same-domain active writer is recovered automatically; on
  Linux that requires the same hostname, boot, and PID namespace, while a live
  or unverifiable writer stays fenced;
- a live old-version runtime owner present at first runtime creation still causes
  a transitional 503, but the one-shot check cannot detect an old daemon started
  later, so all daemons sharing a root require drain-and-cutover together;
- the lease provides a same-session conflict fence, not multi-master support.

## Verification

Unit tests cover server bootstrap without a long-lived legacy owner, live and
stale legacy-owner compatibility checks, strict malformed-owner failures,
runtime initialization without lifetime ownership, shutdown without owner
release, retained root/generation/quarantine failures, deletion-journal
state-parent creation and compromise detection, journal bootstrap without owner
acquisition, parent revalidation on journal read/recovery/write paths,
contention-as-skip during background reconciliation, and runtime-provenance
writer-lease selection.

The writer matrix covers the user setting off for a Conversations runtime, off
for an ordinary runtime, and on for all runtimes; Conversations selects
`local` while ordinary managed children retain `never`. It also covers marker
rejection without a private parent capability, capture before environment-file
loading, user-level and project-level environment scrubbing, sandbox
propagation, and isolation between primary, secondary, and Conversations bridge
child environments. Factory coverage verifies that both the default factory
and each configured factory returned by `createSpawnChannelFactory` carry the
forwarding capability and merge the bridge's second argument through
`scrubChildEnv`. Bridge-attestation coverage accepts the exact marker with such
a factory or a deliberately attested test fake, rejects the marker with an
unattested factory that ignores its second argument, and rejects a capable
factory when the marker is absent or wrong. Runtime-publication coverage accepts
the conforming Conversations bridge, rejects and disposes a non-conforming new
`live-conversation` candidate, and rejects and quarantines an equivalent
existing registered runtime with non-retryable
`conversation_root_compromised`. Standalone parent lifecycle and maintenance
acquisitions must select the same `local` policy. Scheduler coverage verifies
that the captured Conversations marker installs the unbound-durable-task skip
before loading or catch-up detection, allows a task after it is bound to that
session, and leaves ordinary workspace lock-owner behavior unchanged.

Core lease coverage records and validates the Linux PID namespace, treats a
missing reclaim identity as live, reclaims dead and PID-reused owners only in
the same hostname, boot, and namespace, and rejects matching live, stalled,
foreign-host, foreign-boot, foreign-namespace, legacy identity-less, malformed,
sealed, and residual-claim states. Darwin and Windows cover their corresponding
hostname and process-start rules. Existing concurrent-reclaimer, exact-record,
transcript-proof, and crashed-reclaimer tests remain in force.

Managed-shutdown coverage uses representative high active-session counts and
large transcripts to measure parallel sealing against the existing termination
deadline. It also verifies that a forced timeout retains the exact active lock
while the writer process is still live, never leaves a residual claim or
uncertain transition, and preserves the existing observable unclean-shutdown
outcome rather than releasing ownership ambiguously. After that exact process
exits, only a same-identity-domain contender may recover a well-formed active
record.

A two-process daemon integration test uses the same home, runtime base, and
Conversations root and verifies:

1. daemon A and daemon B both return `200` from
   `GET /standalone/session-options` and `GET /standalone/sessions`;
2. neither daemon returns `conversation_runtime_in_use` merely because the
   other process is alive;
3. a live legacy runtime-owner record returns
   `503 conversation_runtime_in_use`, and after its process exits the next
   request retires the stale record and returns `200` without restarting;
4. while daemon A keeps standalone session S active, daemon B can still list
   the catalog, create a new chat T, and restore and use a different persisted
   session without closing S;
5. while A keeps S active, B receives `409 session_writer_conflict` when it
   tries to restore, rename, or repair S; archive and delete keep their `200`
   batch envelope and report `session_writer_conflict` for S without inventing
   a new error kind;
6. after an explicit close releases A's lease, B restores S through
   ordinary acquisition; independently, after graceful shutdown seals another
   session owned by A, B restores it through certified takeover;
7. after A's lock-owning ACP writer is killed in a steady active state, B in the
   same local identity domain reclaims the lock, authoritatively reloads the
   transcript, and continues it without manual cleanup; killing only A's parent
   while that writer remains live still returns a conflict;
8. a matching live or stalled A, and records from a foreign host, boot, or PID
   namespace, remain `409 session_writer_conflict`; identity-less and residual
   claim states remain fail closed;
9. shutting down either daemon does not remove or invalidate the other's local
   runtime;
10. two otherwise idle daemons that simultaneously rehydrate the same
    scheduled-task-bound session elect one resident session through the writer
    lease; the loser records a restore failure and backs off, and only the
    winner fires the bound task for that slot;
11. two keepalive workers that observe the same unbound task may mint competing
    controller sessions, but no Conversations session fires it while unbound;
    the task-file transaction commits exactly one binding, cleans up the losing
    orphan, and only the bound controller becomes eligible to fire;
12. two daemons reconciling the same prepared deletion elect one lease holder;
    the contender skips that UUID without failing the unrelated triggering
    operation or reporting journal compromise;
13. a Live session on the elected Live daemon and a different standalone
    session on the other daemon remain usable concurrently, while standalone
    routes continue to reject the Live record;
14. root compromise and unavailable generations still fail closed without
    falling back to the primary workspace.

Live regression coverage verifies that Live discovery still has at most one
publisher, that the publication path performs the existing validated handoff
for the stable base as well as custom bases, and that a stale stable-base record
can be reclaimed after its previous owner exits. Standalone availability
remains independent of discovery publication failure and of which daemon
published the record. It also covers a Live-enabled daemon and a second daemon
serving a different standalone session at the same time.

Web Shell regression coverage verifies that switching sessions does not emit a
toast when standalone listing fails, that a transitional
`conversation_runtime_in_use` response appears once in the Recents section,
and that `session_writer_conflict` and `session_writer_unavailable` on open are
attached to the affected session or section with a retry action. It does not
require an `activeElsewhere` list field.

Tests must prove both sides of the boundary: different session IDs can be used
concurrently across updated daemons, while the same session remains exclusive
for its complete loaded lifetime. They must not imply globally fresh live
state, cross-daemon event routing, or atomic multi-session operations.

## Rejected alternatives

- **Daemon-to-daemon proxying:** preserves a single runtime owner but requires
  authenticated forwarding for all standalone and owner-routed session APIs,
  including SSE and permissions.
- **Client redirect to the owner:** introduces discovery, token, origin, and
  reconnect behavior and keeps the global owner that this change removes.
- **Per-daemon standalone storage:** is simple but prevents daemons from seeing
  the same persisted conversation catalog.
- **Relying on the user setting for writer leases:** permits one daemon with the
  setting disabled to bypass the fence, so it cannot protect shared standalone
  persistence.
- **Enabling the lease only for `sourceType=standalone`:** misses Live and
  scheduled-task sources hosted by the same Conversations runtime, including
  background rehydration that occurs without a standalone API request.
- **Adding `activeElsewhere` to listings now:** requires an authoritative shared
  live-state index or owner-discovery protocol. The minimum Web Shell behavior
  can use the existing attach-time error contract without adding that backend
  coordination.
- **A shared routing or global transaction plane:** daemon-to-daemon event
  routing, globally fresh live state, and atomic operations spanning sessions
  are different reliability contracts. They are unnecessary for concurrent
  use partitioned by the existing session writer lease.
- **Unqualified stale-writer reclaim:** PID, hostname, age, or inactivity alone
  cannot prove that a managed writer on shared storage is dead. Automatic
  recovery is limited to a matching local identity domain and stable process
  identity; every uncertain state remains fenced.
- **Keeping managed `never` plus manual unlock:** makes an ordinary
  non-cooperative writer death leave every loaded session unavailable until an
  operator discovers and removes internal lock files. Identity-qualified local
  recovery handles the common safe case automatically; manual recovery remains
  only for ambiguous transition or storage state after an external writer
  fence.
