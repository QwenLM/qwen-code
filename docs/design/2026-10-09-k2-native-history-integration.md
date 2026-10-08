# K2: connect original history, worker admission and file execution

[English](2026-10-09-k2-native-history-integration.md) | [简体中文](2026-10-09-k2-native-history-integration.zh-CN.md)

Status: implementation design, 2026-10-09. Investigated source baseline:
`9582aac56085faa42d8c8fcde8f7157e9db64619`, Draft PR #13526.
The preceding increment implements derived original assistant-batch retention and
complete related-row qualification before current-batch partitioning. The boot-5/handle-3 authority propagation dependency is implemented and under
verification. Current native readback, schema-2 history/promotion, worker
admission/execution and completion below remain proposed and unaccepted. This increment refines the preparation contract
and adds explicit Broker dispatch and JDBC authorization refusals while original
native intent/checkpoint grants are absent. It does not implement preparation.
It refines the remaining connected composition in the [native file execution design](2026-10-07-k2-native-file-execution.md)
and [original batch reservation design](2026-10-08-k2-native-batch-reservation.md).
The full K2 objective, proposal #12380 and tracker #13395 remain open.

## 1. Current gap and required result

The actual private Hosted caller commits the complete original assistant,
durably reserves accepted Read/Write/Edit inputs and full definitions, and reads
the complete current allocation. It then stops with recovery required. Native
fresh acceptance and historical replay admit no file-history or tool-intent
operation. `commitResources` runs before native acceptance and refuses original
PUBLISHED allocation resources. The four-route boot-4/boot-5 worker has no production
composer, history preparation, executor or result-consumption caller.

Connect one original chain: READY Session and installed context → retained empty
history bind → native schema-2 intent with the entire accepted batch → worker
current original readback and retained preparation → native prepared → original
tool intents and dispatch checkpoint → immutable grants → actual file tools →
complete outcomes and tool-result messages → results-ready checkpoint → actual
Hosted consumption and completed history. Allocation, prepared history and SQL
SETTLED are different facts; none alone completes the turn or K2.

## 2. Bootstrap trust and private readback

Boot 4 and its version-2 original resource handle remain construction-only. Do
not add an optional authority URL to an invocation or reinterpret an old boot as
file admission. Introduce execution boot 5 with exactly `type`, `version`,
`managedCsi`, `identity`, `context`, `storage`, `authority`; keep `managed-csi/2`,
the original three-field profile identity, inner boot 2 and registered storage.
`authority` has exactly `protocolVersion: 1` and `origin`. The origin is a
deployment-configured canonical HTTPS origin; HTTP is restricted to owned
loopback qualification. Credentials, path, query, fragment and redirects are
forbidden. No caller-selected origin or global Harness token reaches the worker.
The canonical origin must equal the URL origin serialization: lowercase scheme
and ASCII DNS host with letter/digit/hyphen labels, canonical decimal IPv4 or
compressed lowercase IPv6 (the last label of a multi-label DNS host starts with
a letter), no trailing DNS dot, default port, leading-zero port or port zero;
explicit ports are 1–65535. IDNA `xn--` labels are unsupported in this private
bootstrap contract because Java URI and Node URL do not share IDNA validation.
The origin is limited to 2048 characters. Shared Java/CLI fixtures enforce the
same accepted and refused spellings. For HTTP, private `serve` additionally
requires the exact URI of its own bound listener, before starting that listener;
an arbitrary loopback qualification server cannot become the authority.

The version-3 private original resource handle retains the exact authority
tuple. The provisioning producer includes it in canonical boot bytes, the
immutable Secret, boot digest and handle identity. Every saved-handle, live API,
attestation, transport and restart comparison derives the same boot from the
original seed and retained authority tuple. A configured origin change cannot
rewrite or adopt the old Secret. Old handles have no authority anchor and refuse
new file admission. This implements the authority propagation dependency of the execution bootstrap
in the earlier design; it does not change the existing boot-4 construction contract.
Informational ready uses version 5 with exactly `type`, `version`, `managedCsi`,
`identity`, `context`; it does not echo credentials or establish the authority
origin. Existing CSI-v2 context/attestation/drain envelopes stay separate from
the new readback and execution contracts. Existing attestation responses do not
echo or independently attest the authority origin; the exact immutable Secret,
original handle and boot-digest comparison anchor that bootstrap field. Current
native readback and its action-specific admission are still required.

Use a separate `POST /internal/runtime-broker/csi/v1/native:read` handler. Its
credential is the original per-Runtime lease token, authenticated against the
encrypted persisted seed and current original lease, with constant-time
comparison. This credential authenticates only this private readback handler;
it does not pass the generic global-Bearer handler or grant Store writes. The
handler must neither call back to the requesting worker nor hold SQL locks
across HTTP. That avoids a worker → Broker → same worker cycle during readback.

The closed request contains `protocolVersion`, `requestId`, `action`, `identity`,
`context`, `installedContext` and `subject`. `context` repeats the original
non-secret boot incarnation, lease, epoch and provision identity. The installed
context repeats its original operation, fixed Session, digest and binding.
`subject` is null for bind, the original intent ref for prepare, or the original
execution call ID for execute; it supplies no membership, paths or new grant.
Actions are exactly `bind`, `prepare`, `execute`, each with separate qualification.
The `context` shape is the existing complete `ManagedContextAttestationResponse`:
`protocolVersion`, `managedContext`, `runtimeInstanceId`, `runtimeIncarnation`,
`leaseId`, `epoch`, `provisionRequestId`, `tenantId`, `workspaceId`,
`workspaceGeneration`, `storageId`, `mountRoot`, `capabilityDigest`,
`isolationClass`. `installedContext` is the existing closed installation request:
`protocolVersion`, `managedContext`, `operationId`, `sessionId`, `contextDigest`,
`binding`, including all seven original binding fields. Its operation ID is the
existing name UUID derived from the original Runtime Session. Broker derives
the expected binding from the persisted original owner, not from the request.

Readback is persisted-owner scoped inside the original selected Runtime. Under
the original parent, pin, native head and current SQL locks, compare the boot-5
authority/handle, profile, Session, provision seed, lease/incarnation/epoch,
original installed context and READY admission. Refuse missing, ambiguous,
expired, draining, replaced or removed authority. A prior signed response,
caller ref or supplied receipt cannot substitute for this current read.

The closed response has exactly `protocolVersion`, `requestId`, `action`,
`identity`, `context`, `installedContext`, `head`, `evidence`. `head` has exactly
`revision`, `sequence`, `digest`, copied from the qualified current native head.
An action-specific evidence object closes the union:

- Bind: exactly `kind: "ready"`. It adds no grant or physical bind claim.
- Prepare: exactly `kind: "intent"`, `intentRef`, `resources`, `members`. The
  original committed intent is one of the returned resources; members contain
  the original eleven-field execution references in accepted local ordinal
  order, including Read. A caller-provided subset cannot select this list.
- Execute: exactly `kind: "authorization"`, `executionReference`, `preparedRef`,
  `authorizationRevision`, `authorizationSequence`, `grant`, `resources`.
  `preparedRef` can be null only for a fully qualified read-only batch. The new private grant
  shape is specified below; the original input, declaration and any required
  prepared record are returned resources.

The new private grant has exactly `protocolVersion: 1`, `runtimeBindingId`,
`bindingGeneration`, `authorizedBindingVersion`, `executionCallId`,
`dispatchGeneration`, `authorizationRevision`, `authorizationSequence`,
`executionReference`, `intentRef`, `checkpointRef`, `preparedRef`, `identity`,
`context`, `installedContext`. Generation and binding-version counters are
canonical positive unsigned decimal strings; native revision and sequence are
safe positive integers. The execution reference is the original eleven-field
reference. Intent and checkpoint refs are the original native tool intent and
complete dispatch checkpoint, not worker-preparation admission. The nullable
prepared rule and all repeated fields must agree with the response and original
qualified authorization. Persist this exact joined authorization evidence when
authorizing dispatch; an existing two-column dispatch-generation/binding-version
marker alone is insufficient. This wire shape and persistence are planned,
not currently provided by the construction-only worker or generic Tool-v3 grant.

Each resource entry has exactly `reference` and `bytesBase64`. References use
existing closed resource metadata. A resource appears once, all listed resources
must be required by this action, and every required resource must be present.
Preserve exact original buffers rather than embedding parsed payload JSON.
Neither response membership nor grant may be supplied by the requesting worker.
Shared codec fixtures must cover all three exact shapes, duplicate/extra/missing
fields, action/kind disagreement and the nullable prepared rule before route and
worker integration. The response is an in-transaction evidence observation,
not a signed bearer capability that remains valid after the operation. The
worker must use it only in its retained joined operation and recheck its local
seal after the response arrives. Resource bytes retain the 64 KiB individual limit; complete
responses use a declared total byte/member bound and refuse overflow without
truncation: 16 KiB request, 8 MiB response and at most 4096 members, while the
native history resource remains capped at 64 KiB. Both sender and streamed
receiver enforce the byte bounds before JSON decoding. Original resources travel
as exact Base64 bytes; the structural counter grammar must not reject valid
arbitrary JSON numbers inside original model/tool payloads. The worker checks
every identity against boot and its installed
context before using evidence. Successful readback is admission for that joined
operation, not permission to execute other calls or to report RELEASED.

## 3. Original native history and resource promotion

Keep the existing schema-2 root, directory identity, retained preimage pins,
projection and `idle → intent → prepared → idle` grammar from the native file
design. Bind uses the actual retained backend's empty observation; startup and
attestation do not create the exclusive history directory. A lost bind response
joins the same retained promise. An arbitrary history projection cannot prove a
physical bind: subsequent worker use must match its original backend observation
and directory identity. Unbound or orphaned backend evidence blocks retirement.

Fresh acceptance and historical replay share one transition validator. Add
derived history and frozen-batch evidence to the existing native prefix, carried
through every input, message, model, activation and settlement transition. Keep
historical assistant/function identities after the current pending batch moves
on. These are derived from the original journal, not another persisted ledger.
Only a qualified completion can retire a pending batch; renewal, another model
attempt or schema-1 cleanup cannot erase it.

Before `commitResources`, a same-Connection private preflight reads the bounded
candidate and current prefix, locks original resource inventory before the fixed
Runtime Session and all potentially related execution rows, and validates the
entire intended transition. For intent, compare every accepted member including
Read with immutable original row fields, full assistant Parts, refs, raw input,
definition, request digest, function/part/local ordinal and mutation paths. Only
then promote those exact PUBLISHED/MYSQL_INLINE resources to REFERENCED. Existing
`commitResources` attaches the next revision and final native acceptance checks
the same transition against original associations. Any failure rolls back
promotion, associations, journal and head together; earlier accepted allocation
and PUBLISHED bytes survive. A referenced resource is never healed with a new ID.

The intent collector includes every invocation input/definition. Prepared adds
its original intent ref. History predecessors remain verified through their own
original revisions; do not recursively copy the whole chain into every new
transaction. Use the same finite closure rule in the HTTP resource collector,
recovery reader and checkpoint snapshot. Scope, state, metadata, bytes, hash and
original revision association remain mandatory.

## 4. Complete membership, replay and locking

Inventory related rows by original binding OR Harness owner OR Runtime Session,
in stable 100-row pages under the existing 4096-entry refusal bound. Include
every state. First validate each row's immutable original batch against the
derived historical prefix, then partition by original assistant UUID. Merely
filtering SQL to the current batch would conceal foreign/conflicting rows; merely
qualifying all historical rows as the current pending batch would prevent the
second legitimate batch.

Before freeze, only exact byte-qualified PREPARED current members qualify for
new intent. After freeze, a matching retry reads the original receipt and refs;
new or nonidentical membership refuses. State-aware current readers distinguish
unassociated PUBLISHED allocation from REFERENCED evidence with its exact native
association. They do not weaken the resource verifier to a two-state whitelist.
Terminal, UNKNOWN, abandoned or cancelled pre-intent members cannot disappear to
make a smaller successful intent.

Preserve lock order: original placement/retention/slot/binding/pin parent →
native head/journal and resource inventory → immutable retirement evidence →
fixed Runtime Session → complete stable execution order. Both fresh commit and
reservation use this same parent fence, so late insertion cannot race the
complete membership observation. All authoritative reads use locking current
reads on the original Connection, including in warmed REPEATABLE READ. Separate
transaction or cached admission is insufficient. No SQL lock spans worker I/O.
Re-read database time and validate writer/activation/admission after all possibly
blocking locks, immediately before acceptance or authorization. A lease valid
before waiting for resource/execution locks may have expired by then.

## 5. Worker preparation, grants and Hosted completion

Track a private operation before its first await. After current readback, check
the local seal again before bind, preimage I/O or invocation. Deduplicate prepare
by original intent resource ID and digest with one retained promise installed
before I/O. Matching retries join; changed identity conflicts. Failure retains
its original backup/orphan evidence and blocks, rather than copying again.
The executor receives the same composer history object that prepared the files.

The SQL and worker seals are separate barriers. Seal before worker start refuses
new I/O. Seal before native prepared acceptance leaves the original intent
unresolved. A pre-seal pending operation remains joined and visible to drain;
its observation cannot become a post-seal dispatch grant. Cancel, timeout, lost
identity or not-started result does not clear native preparation.

For each tool intent, join the original eleven-field SQL reference and immutable
resource bytes to the original native assistant and prepared history. The
complete `await_runtime` checkpoint freezes all accepted intents before any
dispatch. Read-only batches also freeze full allocation; they require no backup
intent. Derive local-to-cumulative ordinal mapping by execution/function/part and
assistant identity, preserving refusal gaps and older checkpoint items. Do not
equate the assistant batch UUID with the cumulative checkpoint batch ID.

Worker execution performs a fresh private readback for the original immutable
grant; three allowed names or an earlier preparation response are insufficient.
Keep finite lookup and all retained descriptor/path/inode checks at actual tool
use. Preserve raw complete inline results, durable outcome, message and
checkpoint coverage. Oversized/omitted results block settlement. Disable ordinary
ACK clearing and Runtime Session release for this profile. `consumed=false`
becomes true only through the actual subsequent Hosted model continuation, not
through SQL SETTLED. Keep interruption results and preparation as blockers.

Cold owner recovery reuses original calls, refs, bytes and current qualified
checkpoint. It cannot remint IDs, create another exclusive directory, adopt an
old boot without authority, or fabricate an idle tail. The fixed original
Runtime Session and storage holder remain until qualified retirement.

## 6. Affected components and implementation sequence

| Component            | Required consumers                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bootstrap            | `WorkspaceCsiRuntimeProvisioner`, `WorkspaceCsiRuntimeIdentity`, `ManagedCsiFilesProtocol`, container boot reader, CSI file envelope, transport, shared fixtures and restart comparison |
| Admission            | separate Broker HTTP authentication/route, Broker service, original JDBC/seed/lease/context/current prefix and complete allocation readers                                              |
| Native history       | `CsiNativeActivationProof`, `JdbcCsiActivationAdmission`, `CsiNativeToolReservation`, `ManagedSessionStore`, extension application and original resource association                    |
| Closure and recovery | HTTP nested-resource collection, `WorkspaceRecoveryReader`, original file checkpoint, CSI snapshot/inventory and schema-aware Hosted readers                                            |
| Execution            | private worker, retained composer/history, finite executor, original intent/checkpoint/grant, outcomes/results/consume and original Hosted harness callback                             |

Implement and verify the native schema/promotion and anchored readback as
dependencies of this connected chain. Then connect the actual producer and
worker preparation; follow with complete execution and consumption. Continue
through cold recovery, all-writer cut, DRAINED, physical stop, NodeUnpublish,
RELEASED, reuse and deployment/target qualification. A dependency finishing does
not replace that full objective or permit public Hosted/Spring CSI selection.

### 6.1 First connected delivery: original preparation

The next production boundary is the complete preparation chain, rather than a
standalone codec or validator. The actual private entry constructs
`RuntimeBrokerService(access, provider, access, ...)` with
`WorkspaceCsiRuntimeAccess`; changing ordinary Workspace transport does not
connect this path. Keep generic controls refused and admit only the closed
private history operation through this access and the Broker service.

The private `serve` entry reads `K2_RUNTIME_BROKER_ORIGIN` from deployment
configuration, validates the origin rules in section 2 and passes the retained
tuple to provisioning. The independent lease-authenticated readback handler on
the same owned server is still pending. Production HTTPS can front the
existing loopback listener; the global Hosted credential is not installed in
the worker. Reconciliation reconstructs boot from the saved handle, never from
the new process environment.

Use this order in `hosted-csi-session` initialization:

1. Acquire the original fixed Runtime Session and install its context.
2. Open the original native authority and commit its first activation.
3. Send private bind; the worker performs current original readback before
   invoking the retained composer for the first time.
4. Commit the initial schema-2 idle record from the returned actual empty
   observation, with the stable bind command and the actual domain receipt.
5. Start normal input/model processing. For a mutating assistant batch, allocate
   all accepted Read/Write/Edit members, commit the qualified intent and its
   original resource promotion, invoke private prepare, and commit prepared.

Before the first conversation record exists, the initial history projection has
no conversation parent. Its Session, cwd and version come from the original
authority; later projections follow the actual last conversation record.
Do not call the legacy schema-1 helper, which requires a conversation and
returns no receipt. The private helper returns the original
`{ receipt, recordRef, revision }` from `commitDomainRecord`. Its wrapper remains
authority-produced, and the single `domain.committed` event has no activation
subject. Initial checkpoint semantics are verified against the actual Harness
producer; adding history must not silently relax unrelated checkpoint fields.

### 6.2 Broker-to-worker history contract

For boot 5 only, add `POST /internal/managed-runtime/csi/v2/file-history`.
Authenticate with the original lease token. Its closed envelope is exactly
`protocolVersion: 2`, `managedCsi`, `identity`, `context`, `installedContext`,
`operation`; identity and the complete context tuples match section 2.
The operation is exactly `kind: "csi-file-history"`, `version: 1`, `action` for
bind or snapshot. Prepare additionally has `preparationRef`, the original
committed schema-2 intent ref. It accepts no caller paths, state or membership.
Broker forwards only after current original-owner qualification. The worker
performs its own fresh native readback for bind and prepare.

The successful response has the same six envelope fields plus `observation`.
The operation is echoed exactly; observation has exactly `state`,
`backupDirectory`, `retainedBackups`, derived from the retained composer.
It adds no authority wrapper, revision, native receipt, grant or retirement
claim. Validate the complete envelope and observation before committing history.
The request is bounded at 16 KiB and the complete response at 64 KiB; refuse
overflow without truncation before file effects where capacity is knowable.

Install the bind promise before awaiting readback. Matching bind retries join
that promise and the same descriptors; failure never opens a second directory.
Likewise, prepare joins by original intent ID and digest, and derives its full
membership and mutation paths from native readback. Snapshot only observes an
already retained composition. After a local or SQL seal it may still observe
that composition, but cannot construct a new backend, call prepare or acquire
fresh admission. A failed/incomplete observation remains a blocker and cannot
be committed as idle or used as retirement evidence. Close and drain join all
already admitted operations.
Broker snapshot qualification uses the original continuation fence, which may
permit the retained DRAINING owner; it never acquires a new Session or uses
READY-only bind/prepare admission. This exception is confined to observation of
the original retained composition, with no writes or fallback runtime.

### 6.3 Snapshot evolution and dispatch boundary

Snapshots are per prompt, not per assistant batch. The existing history service
extends the last snapshot for another batch in the same prompt. Prepared
validation preserves its prompt ID, timestamp and every existing backup entry,
while allowing only the new mutation paths to extend that last snapshot. Prior
snapshots remain unchanged. A new prompt appends one snapshot; the 100-snapshot
limit is checked before I/O. Existing retained backup pins remain byte-for-byte
unchanged, including when an already tracked path needs no new preimage. Current
file fingerprints may change only through the qualified execution/completion
chain; preparation cannot invent those effects.

The preparation delivery stops with a durable prepared blocker. Read-only
batches remain closed until full intent/checkpoint/grant admission exists.
Explicitly refuse private dispatch authorization/start/execute in both public
Broker entry paths and the JDBC mutation boundary while that grant is absent.
At the investigated baseline, `authorizeDispatch` checked original
READY/session/activation without joining a native tool intent or dispatch
checkpoint. The genuine eleven-field allocation already refused at claim with
`csi_execution_continuation_unavailable`; this was not an observed file execution
bypass. This increment adds `csi_file_dispatch_unavailable` at Broker dispatch
before claim and at JDBC authorization before marker writes. Generic profile
behavior remains unchanged. Historical continuation tests explicitly seed old
persisted markers; they cannot mint a new native grant or prove current dispatch.
Do not accept completed idle, clear preparation, consume results or release the
Runtime Session in this delivery.
Reject a private start before claiming dispatch, preserving the original
PREPARED row. The JDBC backstop rejects any already claimed private call before
writing authorization markers; a refusal is not evidence of execution absence
or permission to erase an existing UNKNOWN obligation.

When the later completion delivery opens model continuation, it must respect
the existing producer order: the next model attempt completes before
`consumeResults`. Permit that attempt only after complete results-ready closure,
retaining its unconsumed obligation. Waiting for consumption before allowing
that same attempt would deadlock the legitimate continuation.

## 7. Validation and acceptance

Before product edits, dry-run the global CLI and actual original current
producer with test-engineer. Record genuine gaps; do not synthesize a positive
assistant, intent, prepared history or grant. Reuse retained utilities only as
freshly hashed input, with new owned roots/processes/DBs and explicit fixture
boundaries. Pin actual Node chunks and Java origins before launch; retain
load-time-only limitations where complete prelaunch assurance is unavailable.

The connected positive run must produce actual Read/Write/Edit preimages,
original history revisions and resource promotion, full grants, real file
effects, raw results, outcome/message/checkpoint closure, consumption and the
qualified idle tail through the production caller. Negative groups cover
omitted Read, late insert, multi-page/second batches, foreign/changed identity,
resource fault rollback, response loss, corrupt history/bytes, capacity, seal
before prepare/dispatch and interrupted results. Real MySQL READ COMMITTED and
warmed REPEATABLE READ lock competitions are distinct from H2 or serialized
seals. Fresh Linux CSI/target-cluster evidence is distinct from POSIX fixtures.

Build/typecheck/bundle, focused TS and Java checks, independent verification,
two clean self-audits and the repository's native review workflow precede a
completed implementation report. Keep any native workflow restriction explicit;
CI or individual helper tests are not maintainer approval. Keep the same Draft
PR; no automatic Ready, merge, physical release or proposal closure.
