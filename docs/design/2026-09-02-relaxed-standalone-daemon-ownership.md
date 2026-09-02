# Relaxed Standalone Daemon Ownership

## Status

Proposed for [Issue #10810](https://github.com/QwenLM/qwen-code/issues/10810).
Once accepted, this decision supersedes the process-global cross-daemon
ownership requirement in the [standalone daemon sessions
contract](./standalone-daemon-sessions.md), which accompanies Issue #8908. All
other isolation, persistence, and lifecycle requirements remain in force. The
current implementation still enforces process-global Conversations ownership
until the source changes in this design are delivered.

## Decision

Allow every `qwen serve` process to lazily create its own Conversations runtime
for the shared Conversations root. The daemon no longer acquires a user-global
process owner before serving standalone APIs. Every standalone session instead
acquires the existing cross-process session writer lease before it can write.
The lease is forced for every writer hosted by the Conversations runtime so
Live and scheduled-task sessions cannot bypass the same-session fence.

This intentionally aligns standalone startup with ordinary workspace startup:
multiple daemons may point at the same persistent workspace, while each daemon
keeps its own ACP bridge, child process, live-session index, caches, and runtime
generation.

This is a serialized-use contract, not multi-master support. Cross-daemon
concurrent access to the Conversations root is unsupported and is not detected
or fully coordinated by this change. The writer lease only fences competing
writers for the same session.

## Motivation

The current user-global owner record makes the first daemon that touches
standalone or Live block standalone access from every other live daemon. A Web
Shell connected to a second daemon therefore receives
`503 conversation_runtime_in_use` even when the two daemons are never used for
standalone at the same time.

Ordinary workspaces do not impose a process-global runtime owner. The simpler
and more consistent policy is to let the operator choose a daemon endpoint and
accept the same cross-process usage constraints for standalone.

## Behavioral contract

- `GET /standalone/session-options` and every `/standalone/sessions` route may
  initialize the local daemon's Conversations runtime even when another daemon
  process is alive.
- An active foreign daemon no longer causes
  `conversation_runtime_in_use`.
- A client remains attached to the daemon on which it created or restored an
  active session. Prompt, cancel, permission, status, heartbeat, detach, and
  SSE event routes are not forwarded to another daemon.
- Creating or restoring a standalone session acquires its session writer lease
  regardless of the user's `experimental.sessionWriterLease` setting. A second
  daemon attempting to open the same active session receives the existing
  `409 session_writer_conflict` response.
- Every other session hosted by the Conversations runtime, including Live and
  scheduled-task sessions, uses the same mandatory lease. This prevents
  background keepalive or task rehydration from silently restoring an already
  active transcript through a non-standalone source.
- Switching a persisted session to another daemon requires a cooperative
  writer handoff. An explicit per-session close or normal idle reap releases
  the lease; graceful managed-daemon shutdown seals it so the replacement can
  use the existing certified-takeover protocol. This is cold restore, not hot
  migration.
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
- Concurrent use by multiple daemons, including concurrent standalone and Live
  use of the same Conversations root, is outside the supported contract.

"Not concurrent" applies to the complete active-session lifetime, not only to
overlapping HTTP requests. A session that remains loaded in daemon A must not be
continued through daemon B merely because daemon A is idle between requests.

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
- Live discovery's own single-publisher record and validation.

These mechanisms can reject some accidental overlap, but they do not make the
new contract safe for general concurrent use. In particular, create admission,
live owner indexes, lifecycle coordinators, directory state, reconciliation
singleflight, and cache invalidation remain process-local.

## Implementation

### Remove the outer owner gate

`ConversationRuntimeManager` no longer accepts a
`ConversationRuntimeOwnership` dependency and no longer calls `acquire()` in
`ensure()`. Runtime creation continues to revalidate the exact root before
publishing the daemon-local managed runtime.

`createServeApp` no longer creates a file-backed Conversations owner, attaches
it to `ServeAppLifecycleController`, or passes it to the runtime manager.
`ServeAppLifecycleController` no longer releases Conversations ownership after
shutdown; its listener, app, host, and runtime drains remain unchanged.

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

The default `runQwenServe` runtime factory owns this wiring. An embedded runtime
factory supplied through `createServeApp` must honor the same
`live-conversation` provenance contract when it creates the bridge; test fakes
may model the resulting behavior without spawning a child.

The ACP session must acquire the lease during config initialization before it
reports successful creation or restore. It retains the lease until session
shutdown and uses the existing `session_writer_conflict`,
`session_writer_lost`, `session_transcript_changed`, and
`session_writer_unavailable` mappings.

The lease protects one transcript. It does not coordinate session-list reads,
random-ID creation admission, managed-directory state, deletion-journal scans,
SSE routing, or Live discovery. Those remain governed by the serialized-use
contract and existing daemon-local checks.

The fence covers only updated, cooperating writers hosted by the marked
Conversations runtime. A legacy daemon or another process that writes the same
transcript without acquiring the protocol lease can still bypass it. The lease
is an integrity protocol, not an operating-system access-control boundary.

### Keep abnormal-exit recovery fail closed

Do not change the managed writer's existing `reclaimPolicy: 'never'` or its
`takeoverPolicy: 'certified'`. A normal per-session close removes its exact
active record. Graceful managed shutdown durably seals the record, and another
managed daemon can take it over only after verifying the transcript proof.

A process crash, SIGKILL, event-loop stall, or storage failure before sealing
can leave an unsealed active record. A replacement then continues to return
`409 session_writer_conflict`; it does not infer death from PID visibility,
hostname, age, or inactivity. Recovery requires an authoritative external
writer fence and explicit operator cleanup after confirming that the previous
writer cannot still append.

This availability tradeoff is intentional. Automatically reclaiming a stale
record would turn the small ownership change into a new failure-detection and
split-brain protocol. It is unnecessary for the requested normal serialized
use and would weaken the transcript-integrity guarantee supplied by the lease.

Forcing the lease also makes graceful managed shutdown seal and hash every
active Conversations transcript. The implementation does not silently lengthen
the existing child-termination deadline. Delivery therefore requires proving
that representative maximum active-session and transcript sizes finish within
that budget; a timeout remains an unclean shutdown with retained locks, not an
automatic release.

### Detach ownership storage without removing state-directory safety

The behavior change stops constructing, acquiring, releasing, or otherwise
depending on the file-owner implementation, but does not delete that
implementation and its focused tests in the same change. Keeping dormant code
for the first patch avoids mixing the ownership-policy change with a large
cleanup. A follow-up may remove it after the new behavior has shipped and been
validated.

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

New daemons ignore existing `conversations/runtime-owner.json` and
`conversations/.runtime-owner.lock` artifacts. They do not delete, rewrite, or
acquire them: the record or lock may still belong to a running older daemon,
and touching it would falsify that daemon's safety contract. Once all older
daemons have exited, the artifacts are harmless legacy state.

The server no longer emits `conversation_runtime_in_use`. The wire value may be
retained temporarily in compatibility types, but it has no new-daemon emission
path. `conversation_runtime_unavailable`, `conversation_root_compromised`, and
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

This deliberately does not solve concurrent Live and standalone access from
different daemons. Operators relying on the serialized-use contract must keep
Live inactive on other daemons while standalone is in use.

### Keep scheduled-task logic unchanged

Do not change scheduled-task persistence, cron execution, keepalive, or boot
rehydration. Scheduled-task controller and run sessions inherit the mandatory
writer lease from the Conversations runtime before restore succeeds. A daemon
that loses the lease cannot make that bound session resident; boot rehydration
records the failure, and keepalive uses its existing retry backoff.

Keep the existing product boundaries: durable cron jobs remain unsupported in
standalone sessions, and generic scheduled-task routes cannot create a new
session in the Conversations workspace. This change only fences existing
background writers; it does not add standalone scheduling functionality.

### Keep the Web Shell contract unchanged

Do not add an `activeElsewhere` list field or a new client-side owner-discovery
protocol. Every daemon can list persisted standalone sessions after the outer
gate is removed, while an attempt to restore a session held by another daemon
continues to return the existing `409 session_writer_conflict`. The Web Shell
may surface that real attach conflict through its existing error path.

A quieter inline conflict treatment can be delivered independently as product
polish. It is not required for storage safety and does not belong in the
backend ownership change.

### Do not add routing or coordination

The change adds no daemon-to-daemon proxy, redirect, shared owner index,
heartbeat, global lifecycle lock, or distributed cache invalidation. Existing
session routes continue to resolve owners only among runtimes inside the
receiving daemon.

No new setting or command-line flag is introduced. Supporting both exclusive
and relaxed ownership modes would retain the full old subsystem and create a
mixed-mode compatibility problem without serving the requested default.

## Compatibility and rollout

The REST and SDK shapes are unchanged. `standalone_sessions_v1` and
`standalone_session_options_v1` continue to describe API support; no capability
is added for a weaker concurrency guarantee.

Rollout is a drain-and-cutover, not a rolling mixed-version upgrade. Stop every
daemon version that can host standalone sessions without the mandatory lease,
confirm its sessions have closed, and only then start daemons with this change.
Mixed old/new versions are unsupported: an old daemon still believes its owner
record is exclusive and may write without a lease, while a new daemon
intentionally ignores that owner record. Rollback must explicitly close or
drain all new Conversations writers and confirm that no active, sealed, or
claim record from the writer protocol remains before an older non-participating
daemon starts; graceful process exit alone may intentionally leave sealed
handoff records.

Release notes must state that:

- multiple daemons may expose standalone sessions for the same user;
- active sessions are daemon-local;
- callers are responsible for avoiding cross-daemon concurrent use;
- standalone sessions always use the writer lease, even when the experimental
  setting is absent or false;
- Live and scheduled-task writers in the Conversations runtime use it as well;
- the lease provides a same-session conflict fence, not multi-master support.

## Verification

Unit tests cover server bootstrap without constructing or acquiring the legacy
owner, runtime initialization without an ownership dependency, shutdown without
owner release, retained root/generation/quarantine failures, deletion-journal
state-parent creation and compromise detection, journal bootstrap without an
owner acquisition, parent revalidation on journal read/recovery/write paths,
and runtime-provenance writer-lease selection. The writer matrix covers the
user setting off for a Conversations runtime, off for an ordinary runtime, and
on for all runtimes, plus marker rejection without a private parent capability,
capture before environment-file loading, user-level and project-level
environment scrubbing, sandbox propagation, and isolation between primary,
secondary, and Conversations bridge child environments.

Managed-shutdown coverage uses representative high active-session counts and
large transcripts to verify that parallel sealing finishes before the existing
termination deadline. It also verifies that a forced timeout retains the exact
active lock and preserves the existing observable unclean-shutdown outcome
rather than releasing ownership ambiguously.

A two-process daemon integration test uses the same home, runtime base, and
Conversations root and verifies:

1. daemon A and daemon B both return `200` from
   `GET /standalone/session-options` and `GET /standalone/sessions`;
2. neither daemon returns `conversation_runtime_in_use` merely because the
   other process is alive;
3. stale legacy owner and owner-lock artifacts do not block either new daemon;
4. while daemon A keeps a standalone session active, daemon B receives
   `409 session_writer_conflict` when it tries to restore that session;
5. after an explicit close releases A's lease, B restores that session through
   ordinary acquisition; independently, after graceful shutdown seals another
   session owned by A, B restores it through certified takeover;
6. shutting down either daemon does not remove or invalidate the other's local
   runtime;
7. killing A without a cooperative writer terminal leaves the session fenced,
   and B receives `409 session_writer_conflict` rather than reclaiming it;
8. a scheduled-task session active in A cannot be rehydrated in B, and only A's
   scheduler fires its bound task;
9. root compromise and unavailable generations still fail closed without
   falling back to the primary workspace.

Live regression coverage verifies that Live discovery still has at most one
publisher, that the publication path performs the existing validated handoff
for the stable base as well as custom bases, and that a stale stable-base record
can be reclaimed after its previous owner exits. Standalone availability
remains independent of discovery publication failure and of which daemon
published the record.

No test may treat the same-session conflict as proof of general cross-daemon
safety. Different-session lifecycle and catalog operations remain outside the
concurrent-use contract.

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
- **Bundling new Web Shell ownership UI:** an `activeElsewhere` hint or inline
  conflict state requires a new product contract but does not strengthen the
  storage fence. Keep the backend decision independently reviewable and handle
  that optional presentation change separately.
- **Cross-process multi-master coordination:** would require durable create,
  lifecycle, recovery, owner-routing, and cache protocols. That is a different
  reliability contract and is unnecessary for serialized use.
- **Automatic stale-writer reclaim:** PID, hostname, age, or inactivity cannot
  prove that a managed writer on shared storage is dead. Keep explicit recovery
  rather than introduce a partial failure detector.
