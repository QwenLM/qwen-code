# K2-A2: the original native file execution chain

[English](2026-10-07-k2-native-file-execution.md) | [简体中文](2026-10-07-k2-native-file-execution.zh-CN.md)

Status: connected-composition design with the initial checkpoint gate locally
implemented and independently verified on owned MySQL, 2026-10-07. Implementation baseline:
`b0738214c5d09f00ac74b14f3d517f8a6e3fd4b4` in
[Draft PR #13526](https://github.com/QwenLM/qwen-code/pull/13526). Original SQL
execution continuation is implemented there; the normal file chain below is not.
This extends the [K2 completion design](2026-10-06-kubernetes-k2-retirement-handoff.md)
and claims neither full A2 nor aggregate retirement nor new cloud acceptance.

## 1. Problem and scope

At the implementation baseline, private `csi-files-retirement/1` CREATE and first
activation pin exist, but the generic worker constructs Shell/MCP/Hook/monitor/
provider components. The SQL reader accepts genesis/install/renew and one exact
empty initial checkpoint; it does not admit the connected file chain.
Removing a control refusal or allowing
arbitrary checkpoints would not connect those authorities safely.

The actual Hosted v2 chain is file-history preparation for Write/Edit → Broker
PREPARED → native `tool.intent` → `await_runtime` checkpoint → authorization /
worker execution → inline `managed-tool-outcome` → `message.committed` tool
result → `results_ready` → post-work file-history snapshot. Ordinary file work
has no Shell publication receipt. Qualify `HostedWorkspaceToolTurn`; the local
`ManagedRuntimeOutcomes` producer has a different receipt/outcome shape.

Support `read_file`, `write_file` and `edit` for the original Session, retained
inline resources and uncompacted history. Exclude import/restore/rewind,
Shell/glob/v3/provider/Hook/MCP/background/monitor/publication configuration.
Keep public CSI selectors disabled. K2-B physical stop/unpublish, K2-C release /
repeated handoff and K2-D deployment qualification remain required later work.

## 2. Closed worker identity and construction

The current slice adds only the legacy-entry refusal described below. Its
independent baseline observed the reserved digest reaching the old generic
factory and a local-process child before startup failure. The guard rejects
stdin/container readers, direct old worker/factory construction, and local
request creation, registration, provisioning, adoption, confirmation and
release before their side effects. Local operator registration/stop evidence
also refuses this private request. Ordinary profile digests retain their
existing path. The reusable managed-context data parser and CSI-v1 data schema
are unchanged; they do not grant execution. Boot4/CSI2 construction, new routes
and the connected file chain below remain planned.

Reserve outer boot version `4`, `managed-csi/2` and CSI v2 attestation/drain
routes. Wrap unchanged closed managed-context boot v2 and the registered storage
tuple; add a closed profile identity with `profile`, `sessionId` and
`capabilityDigest`. Require the exact `csi-files-retirement/1` manifest digest,
canonical CREATE Session UUID, session isolation and matching inner-context
digest. Echo this identity in v2 attestation/drain and compare immutable request,
Pod and registration identities in Java and TypeScript. Include it in the new
closed ready/context-install/receipt contracts too. The boot Session UUID names
the durable Harness owner. The first private profile explicitly chooses that
same value for its one Runtime Session, matching the existing SQL guard; those
are different identity roles and both must be verified. Its composer reuses that
fixed Runtime Session across turns, while execution turn/prompt IDs remain
separate. Legacy Hosted keeps its prompt-scoped Runtime Session IDs. Do not
broaden the SQL identity predicate or add a second pin to accommodate the legacy
composer accidentally. Old boot v3, managed-context/1 and CSI v1 records remain
closed and unchanged.

The outer key is `identity`. Its exact three fields come from the immutable
original provision request. The new wire contracts are separate from legacy
schemas; a protocol number alone never selects or authorizes this profile.

| Contract                       | Exact outer fields and fixed values                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Container boot                 | `type: "boot"`, `version: 4`, `managedCsi: "managed-csi/2"`, `identity`, unchanged boot-v2 `context`, unchanged 12-field `storage`                                                    |
| Informational ready            | `type: "ready"`, `version: 4`, `managedCsi: "managed-csi/2"`, `identity`, unchanged ready-v2 `context`                                                                                |
| Context attest/install/receipt | `protocolVersion: 2`, `managedCsi: "managed-csi/2"`, `identity`, unchanged closed managed-context-v3 request/response in `context`                                                    |
| Physical attestation request   | `protocolVersion: 2`, `managedCsi: "managed-csi/2"`, `identity`, `provisionRequestId`, `physicalKey`, `registrationRevision`, `reservationId`, `reservationRevision`                  |
| Physical attestation response  | `protocolVersion: 2`, `managedCsi: "managed-csi/2"`, `identity`, `context`, `storage`, `pod`, `mount`                                                                                 |
| Drain request                  | `protocolVersion: 2`, `managedCsi: "managed-csi/2"`, `identity`, `operation`, `retirementId`, `context`, `storage`, `pod`                                                             |
| Drain response                 | `protocolVersion: 2`, `managedCsi: "managed-csi/2"`, `identity`, `retirementId`, `context`, `storage`, `pod`, `state`, `workState`, `pendingStarts`, `pendingInvocations`, `blockers` |

Use `/internal/managed-runtime/csi/v2/context-attest`, `/context`, `/attest`
and `/drain`; the latter three are under the same CSI-v2 prefix. Kubernetes
qualification compares the actual Pod and both HTTP attestations. Ready stdout
is informational and must not become a second authority. Drain retains
seal/status, `state: "DRAINING"` and `workState: "BLOCKED" | "PENDING" |
"QUIESCENT"`; counts are native nonnegative safe integers and blockers are
unique sorted strings. This is worker observation, not aggregate DRAINED or
physical termination evidence.

Attestation and drain routes are selected-runtime scoped. Context installation
and the private history route are live-session-owner scoped within that exact
runtime. They authenticate the original lease/incarnation/epoch, then verify
the fixed owner and installed context; missing/draining/removed or mismatched
identity follows the stated refusal/observation rule without primary-runtime
fallback. No private route is a process-global generic control.

Before constructing the generic full-profile worker, legacy boot 1/2/3 and
local-process provisioning reject the reserved private manifest digest. The new
profile is container-only. It does not extend the old stdin boot reader or
enable CSI-v1 publication ACK. Other valid legacy profiles keep their existing
behavior. The private inner context fixes `cwd` to `.` and the registered private
configuration digest; caller-selected context cannot expand its capability.

Construct only the three file tools. Restrict executor lookup as well as tool
declarations; each invocation requires the original activation and context.
Installation must match boot Session/profile configuration. Reject unsupported
configuration before constructing its runtime, registering routes or starting
timers; ignoring environment settings is insufficient.

`read_file` can invoke PDF/vision helpers. Three tool names do not prove absence
of child processes. Qualify their joined lifetime and result retention, or
report an explicit lifecycle blocker if they are used. Do not silently narrow
an existing manifest's file formats while retaining its digest. The initial
positive scenario uses ordinary text files.

Explicitly connect the Session identity through the private CSI provisioner,
boot producer, saved Secret comparison, resume, attestation, installation and
transport. Another Session cannot reuse the mount or fall back to legacy local
resolution. CSI v1 publication ACK remains workspace-only: the file chain does
not create a publication/ACK. A later session-scoped publication ACK needs its
own closed contract and qualification.

## 3. File-history storage and admission

Backups currently use `Storage.getGlobalQwenDir()/file-history/<owner>`; Pod
`HOME=/tmp` makes this an emptyDir dependency. Pass an explicit backup root for
the private composition, retaining the default for legacy callers. Use a
reserved directory under the registered volume tied to the original Session.
Pin its directory identity, reject symlinks/replaced roots and deny lexical and
resolved file-tool access to that subtree. Do not redirect global `QWEN_HOME`.
Keep backup bytes until original finalize; unavailable, interrupted or
capacity-exhausted history blocks settlement. The later cut/finalize must cover
retained backup bytes as well as native history resources.
Write/Edit must require bound, prepared history; the legacy executor fallback
that executes a mutation without any history object is forbidden here.

Choose the fixed reserved prefix `.qwen-csi-file-history` and canonical owner
UUID leaf. The private backend is a concrete Linux directory-fd implementation,
not a caller-selected pathname or environment option. Open and retain the
original mount, reserved prefix and Session directory using
`O_DIRECTORY | O_NOFOLLOW`; compare the volume device/inode with the original
mount receipt. Append one validated component to `/proc/self/fd/<dirfd>` at a
time. Check named-directory identities and the original mount before/after I/O;
an observed mismatch makes the backend permanently blocked for this lifetime.
No replacement/adoption or non-Linux fallback is allowed. First empty bind may
create the Session directory under current original admission; track that
metadata I/O through drain. Existing nonempty/unknown directories are refused.

Copy raw preimage bytes from an opened ordinary-file descriptor into a unique
leaf with `O_CREAT | O_EXCL | O_NOFOLLOW`. Use the same descriptors for
stat/read/write/hash/chmod, handle short writes, then sync the file and directory
before publishing metadata. Never overwrite a retained leaf or unlink a failed
attempt. All backup reads verify the original content pin, not merely current
existence or a newly computed hash. Keep snapshots and orphan bytes until
qualified original finalize; a failed attempt remains a blocker. The legacy
`copyFile` path cannot provide this private contract because its operation is
not atomic and an error can remove the destination. These choices use the
documented [Linux directory-fd behavior](https://man7.org/linux/man-pages/man2/open.2.html)
and [Node 22 FileHandle operations](https://nodejs.org/docs/latest-v22.x/api/fs.html#class-filehandle);
they still require actual Linux testing.

Pass the same concrete backend from private factory → executor →
`ManagedRuntimeFileHistory` → `ManagedToolFileHistory` → `FileHistoryService`,
including the previous-history rollback constructor. Legacy callers omit it
and keep their original default. Private create, fingerprint, validation, diff,
snapshot and inventory reads use this backend; rewind/restore and orphan cleanup
refuse before destructive I/O. Wrappers borrow it; the original factory owns
its joinable tail and descriptor lifetime.

The ordinary tools also need descriptor-bound access. The existing injected
`FileSystemService` covers text I/O, but `read_file` format classification/media
reads, Write/Edit direct mkdir and atomic-write fallbacks also use pathnames.
Inventory and close these actual I/O sites before enabling the private worker.
A single realpath check or secure backup class does not protect a later tool
read/write. Deny reserved-prefix aliases and backup-inode hardlinks at actual
open/use boundaries. Preserve format/encoding semantics; keep any unqualified
helper lifecycle as an explicit blocker. This protects the declared filesystem
boundary, not a hostile actor that already controls the worker's memory, fd
table or mount namespace.

Hosted currently calls prepare before committing `pendingTurn`/`pendingMessageId`;
those fields are not preparation admission. For this profile, commit a versioned
exact preparation intent to the existing native file-history domain before
worker I/O. Bind original turn/message, invocation/input refs and sorted paths.
The original parent guard admits it in READY. Broker verifies those committed
bytes on the original connection, not a caller flag or cached context. Keep one
journal authority; hold no parent SQL lock across worker I/O.

Use a private file-history body `schemaVersion: 2`; durable resource refs,
`domain.committed` events and native markers retain version 1. Root fields are
exactly `operationId`, `revision`, `previousRecordRef`, `schemaVersion`,
`profile`, `runtimeSessionId`, `state`, `backupDirectory`, `retainedBackups`,
`preparation`, `record`. The authority supplies the first three. `state` retains
the closed owner/snapshots/files shape. `record` retains the ordinary
file-history reader projection and must mirror `state.snapshots`. Legacy body
schema 1 remains a separate branch, never private preparation evidence.

`backupDirectory` is exactly `volumeDevice`, `volumeInode`, `directoryDevice`,
`directoryInode`, using canonical unsigned decimal strings from the original
open descriptors. Each name-sorted `retainedBackups` member is exactly `name`,
`device`, `inode`, `byteLength`, `digest`, `mode`: a validated single leaf,
canonical device/inode strings, safe integral byte length/mode and bare
lowercase SHA-256 bytes digest. Every non-null retained snapshot backup has
exactly one original pin; no pin may change/disappear across revisions. Native
pins describe successfully authenticated preimages. A sealed worker inventory
separately observes all actual leaves, including unknown/incomplete orphan
attempts; it cannot replace the earlier pins by approving current bytes.

| History stage  | Exact preparation and transition                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Initial idle   | `preparation: null`, empty state/pins, revision 1 and null predecessor; original empty bind observation                                                                              |
| Intent         | `stage: "intent"`, `turnId`, `promptId`, `batchId`, `invocations`, `paths`; preserve previous idle state/directory/pins                                                              |
| Prepared       | Same immutable fields with `stage: "prepared"` and `intentRef`; immediate predecessor equals that original intent ref; append only authenticated backups and matching observed state |
| Completed idle | `preparation: null`; immediate predecessor is the corresponding prepared record; preserve retained evidence and prove the entire original batch's results/history                    |

Each invocation has exactly `executionCallId`, `callId`, `functionCallId`,
`toolName`, `partIndex`, `ordinal`, `requestDigest`, `inputRef`,
`toolDefinitionRef`. Include every admitted read/write/edit entry of the batch,
with unique identities and ascending original ordinal; verify part/function
identity against the committed assistant message. Input/definition refs are
unchanged closed durable refs. `requestDigest` hashes exact payload JSON UTF-8
bytes, with `sha256:` prefix; inputRef.digest hashes the enclosing input resource
and is a different value. Paths are the sorted deduplicated Write/Edit path
union derived from those exact original input bytes. Use JS default sort/Java
natural String order, not locale order. Bound the whole resource to the existing
64 KiB inline limit and snapshots to 100 before preimage I/O.

Allocate calls once, publish inputs/definitions and reserve accepted SQL
PREPARED rows **before** committing intent, then call prepare. Reservation is
not dispatch authorization. This avoids a later unresolved execution-identity
stage. File reservations retain the closed Tool-v2 deferred reference; do not
send `runtimeProtocol: 3`/`inputDigest`, which the current service limits to
Shell/Monitor. Read-only batches need no backup intent. Subsequent tool intent
and dispatch checkpoints require the committed prepared record for mutations.

Use stable commands `csi-file-history:bind:<owner>`, `:intent:<batchId>`,
`:prepared:<batchId>` and `:settled:<batchId>`, each committing one existing
file_history-domain event. Derive contentDigest from exact semantic fields,
excluding the authority wrapper and generated reader projection. Return the
actual domain receipt/ref. Recovered retries reuse durable calls/refs and compare
original semantic bytes; they never generate a new batch to escape uncertainty.
Add an explicit schema-2 nested-ref collector to both HTTP resource commit and
read-only snapshot closure for invocation input/definition refs and intentRef.
Do not recurse the whole previousRecordRef chain into every transaction.

Expose a narrow authenticated history branch independently of provider
lifecycle: initial empty bind, admitted prepare and snapshot in READY; no
rewind/restore. After worker seal, permit only an idle snapshot of already-bound
original history. Refuse a late prepare and retain its unresolved durable intent
as a blocker. Track preparations already running through completion and final
inventory; do not infer that a refused/failed RPC left files unchanged.

Use a separate closed `csi-file-history` operation, version 1: bind and snapshot
have only `kind`, `version`, `action`; prepare also has `preparationRef`. The
Broker finds that current committed intent and all its SQL PREPARED rows on the
original connection, compares assistant/input/path/resource membership and
derives the worker request. The caller cannot provide authoritative paths or a
prepared flag. Transport uses a separate authenticated CSI-v2 history route,
matching boot identity and installed original context; it does not construct a
ProviderWorker. Legacy raw-file-history requests remain unchanged.

Worker deduplication is an original-lifetime observation keyed by exact intent
resource ID/digest. Install its retained promise before the first await. Exact
retry joins that operation or returns its retained result; changed content
conflicts, and failure never starts another copy. Track it through seal and
inventory. SQL and worker admission are separate barriers: seal winning before
the initial worker start refuses it; seal winning before the native prepared
commit leaves the durable intent unresolved. The minimal branch grants neither
new prepare nor post-seal prepared authority. Only read-only observation of an
already-running preparation is permitted after worker seal. Cancel, timeout,
SQL not_started or lost worker identity cannot clear an unresolved intent.

Update schema-aware pending readers in Hosted load/resume/idle/cancel/history,
workspace read-only recovery, original file-checkpoint proof and native CSI
inventory. The existing cancelled-turn cleanup that writes schema 1 with
pendingTurn null is forbidden for schema 2. A parser dropping an unknown pending
field or a terminal reader checking only the newest record would lose the
obligation; fold and verify the whole same-domain revision chain.

## 4. Native journal and original continuation

Extend the strict reader to actual file transaction/resource shapes. Check UTF-8,
duplicate/trailing fields, original parent UUID/sequence chain, recursively
sorted-key events/commit digests, original writer generation 1 and activation
epoch 1, and resource identity/digest/size. Structural counters stay strict
native JSON integers; arbitrary tool/message payload numbers must follow the
actual producer canonical encoding, not an indiscriminate integer restriction.
Preserve bounded history and statement timeouts.

Replay the complete original history, retaining the original install and
same-identity renewal across non-activation transactions. Derive newest
checkpoint from qualified events and compare it with the head, replacing the
permanent NULL condition. Verify checkpoint identity, covered prefix, predecessor,
activation, tool batch, runtime bindings and referenced resources. Preserve
atomic resource/journal/head commit and read-only identical-command replay.

The first implementation gate admits only the actual initial `before_model`
checkpoint, once while READY. It has one `checkpoint.committed` event, no prior
checkpoint, a NULL boundary and the original activation subject. Its covered
sequence equals the current committed prefix; its definition/config revisions
and input digest equal the original header's definition/root refs and definition
digest. Validate the complete closed checkpoint with empty initial recording,
pending work, tool/runtime/attempt/approval groups and output/follow-up state.
Verify the state ref, full events hash and commit marker. Replay retains this
checkpoint across subsequent same-identity activation renewals, and checks the
derived resource ID against the journal head. A duplicate initial checkpoint,
later phase or unrelated event remains refused. This foundation does not qualify
the connected file chain; the table below describes subsequent target behavior.

| Operation                                                           | READY                                                                                | DRAINING                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Original activation renewal                                         | Exact existing renewal                                                               | Same original renewal with live writer/activation           |
| Initial checkpoint, input/model message, preparation intent         | Validate profile and native shapes                                                   | Refuse new work                                             |
| Tool intent / dispatch checkpoint                                   | Join exact original PREPARED execution/input; authorization is separately READY-only | Refuse new dispatch                                         |
| Result message / outcome checkpoint                                 | Join original intent/execution                                                       | Only already-authorized original work before immutable seal |
| Post-work history                                                   | Compare original admitted batch/snapshot                                             | Same pre-seal batch completion, no pending preparation/undo |
| Replacement activation, recovery, ordinary release, generic control | Preserve private refusal                                                             | Preserve private refusal                                    |

Use original parent → native history → immutable retirement identity → Runtime
Session → sorted execution locks on the original connection. Require original
Session, lease, owner, input, dispatch generation and authorization. Check every
multi-call batch member, including terminal history; one matching execution is
insufficient. Derive associations from original journal/input/checkpoint bytes
and Broker records, not `continuation=true` or phase labels. Missing, ambiguous,
orphan, UNKNOWN, unsupported or oversized evidence refuses and preserves the
holder. Qualify RC and warmed RR with real parent-lock waits.

## 5. Hosted completion and retention

Populate private digest/configuration in Hosted declarations, intent bindings,
transport and checkpoint runtime bindings. Legacy Workspace digest does not
authorize this profile. Keep complete inline results; oversized/omitted output
blocks retirement. Settlement qualification compares raw Broker result, normal
conversion, durable outcome/message and checkpoint coverage.
Disable ordinary v2 ACK clearing of input/result bytes for this profile;
until-finalize cannot be implemented by the legacy disposal acknowledgement.

`resolveAwaitRuntime` writes `consumed=false`; the real consumer sets true after
a subsequent Hosted model completion. The current file verifier requires that
consumption. Do not fake it from SQL SETTLED. Exercise actual consumption while
READY for the normal positive test. When seal interrupts execution, verify
original result persistence and report the remaining unconsumed/turn-lifecycle
blocker. Qualification of an already-admitted original Harness turn's
continuation remains part of A2 writer closure; a new turn cannot hide this gap.

Ordinary Hosted finish calls Broker release. The private profile must retain
original Runtime Session and holder for later retirement-close / cut / finalize,
without invoking legacy release or reporting physical closure. Retention and
generic recovery cannot remove these resources before qualified aggregate cut.
A SQL terminal state, QUIESCENT observation or successful file RPC is not
application settlement or volume release.

## 6. Implementation order and affected consumers

Implement and qualify one connected private composition. Independently green
parser, worker or SQL fixtures do not establish a normal file chain.

| Layer             | Existing consumers to change and verify                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Identity          | Java `ManagedCsiProtocol`, provisioner/identity/transport; TS CSI envelope, container boot, attestation/drain                            |
| Worker            | managed-context file composition, executor/factory/lookup, history route and backup service; exclude full-profile lifecycle construction |
| Native authority  | `CsiNativeActivationProof`, `JdbcCsiActivationAdmission`, Session Store commit/resource/read and original checkpoint proof               |
| Hosted            | `HostedWorkspaceToolTurn`, Broker client/profile declarations, preparation-intent producer and post-work history consumer                |
| Remaining closure | Managed Agent turn/Session/lifecycle and retention writers, overall deadline, retirement-close/finalize                                  |

Update both language designs and the E2E plan with implementation. Reserve wire
values before producer/consumer changes. No public selection/deployment change.

## 7. Validation and acceptance

Record global `qwen` baseline and actual native producer bytes at current
refusals. Then start real file-only HTTP worker on owned directories, use real
Hosted producer and SQL authority, and drive read/write/edit through admission,
file effects, raw result, messages/history and checkpoints. Use isolated MySQL
for atomic rollback and locking; H2 cannot prove its lock properties. Local
directory tests do not qualify Linux NVMe/CSI provenance or cloud handoff.

Cover wrong identity/digest/context/Pod, unknown fields/numeric forms, excluded
tool/routes, reserved backup subtree/symlinks, backup failure/capacity, identical
and conflicting replay, partial multi-call results, oversized/omitted output,
RC/warmed-RR seal races, late prepare, expired writer/activation and retained
original Session. Observe bytes and actual files, not only success returns.
Rebuild/typecheck/bundle, focused tests, independent verification, self-audit and
repository review precede the same Draft PR push.

Acceptance of the connected composition requires the complete READY chain and
specified DRAINING persistence / refusal boundaries. The initial checkpoint gate
alone is implementation progress. Remaining Harness writers, aggregate cut, original finalize,
physical stop, NodeUnpublish, atomic release and fresh repeated cloud handoff
still require production evidence. Local fixtures, CI green and review timeout
prove neither full K2 nor maintainer approval.
