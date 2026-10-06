# Durable original-worker ACK evidence for CSI retirement

[English](2026-10-03-csi-original-worker-ack.md) | [简体中文](2026-10-03-csi-original-worker-ack.zh-CN.md)

Status: ACK1_IMPLEMENTED_AND_LOCALLY_VERIFIED, CLOSED_LOCAL on 2026-10-03.
The parent completed two consecutive clean self-audits; independent scoped
source review found no confirmed findings. This is local component closure,
not formal SDK approval. Trusted CSI placement and ACK-2 persistence are now
implemented and undergoing qualification in the
[follow-up design](2026-10-03-csi-durable-worker-ack.md). The historical ACK-1
evidence below does not qualify that increment. This is the
next single-publication evidence component after [receipt/checkpoint
inspection](2026-10-02-csi-receipt-checkpoint-evidence.md) in
[K2c](2026-10-01-managed-kubernetes-k2.md). ACK here means a worker's result-receipt
acknowledgement, not the Alibaba Cloud Kubernetes product. The private CSI
provisioner creation gate in the ACK-1 baseline is addressed only by the trusted
follow-up adapter; public Hosted CSI selection remains disabled.

## Problem and current behavior

`ManagedToolExecutor.acknowledgeV3` validates an original settled entry and records
its exact receipt in memory. A missing entry returns `unknown`; restart does not
reconstruct the old generation's journal. `RuntimeBrokerService` reads the actual
publication receipt and sends it to the original lease, but does not install
durable confirmation after the RPC. The Hosted caller checks the returned
`settled` state; the outer HTTP `acknowledged: true` flag alone is insufficient.

The existing CSI drain route belongs to the boot-v3 worker's original Express app
and executor. It seals admission and reports conservative observations. The SQL
retirement journal separately preserves the original binding, lease/handle and
reservation while keeping the holder DRAINING. Neither a committed Session
receipt nor checkpoint coverage proves that this original worker received it.

Boot-v3 has no Java `runtimeBindingId` or `runtimeGeneration` field. The original
capture entry does have `bindingGeneration`. A new response must describe what
the worker actually knows; Java must establish the remaining publication and
binding relationship from its authoritative records.

## Scope and invariants

The intended result is one original publication's durable committed-receipt
acknowledgement. First deliver only the dedicated boot-v3 confirmation and exact
Java protocol/transport; append-only persistence is the later gated ACK-2 phase.
Do not extend the closed generic Tool v3 or boot-v2 schemas, create a global
retirement state machine, expose a public CSI selector, or add a user-facing
`covered`, `verified`, expected-Pod or raw-proof option.

No acknowledgement, failed RPC, missing entry, unresolved provenance or final
authority conflict leaves the retirement, binding and holder DRAINING, with the
active slot still owned by the original binding. Successful persistence preserves
that state and ownership. This component cannot declare
DRAINED, clear lifecycle blockers, release storage or delete Kubernetes objects.
One row is not evidence that all executions, Sessions or publications are covered.

A valid receipt ACK moves capture delivery from pending to committed and clears
`capture_uncommitted`; that is expected. It establishes only the original
receipt-acknowledgement fact. Shell, publication and MCP lifecycle blockers and
unknown history remain; ACK-1 still adds no durable SQL evidence.

Checkpoint coverage remains an independent native-authority observation. The
worker neither parses nor certifies checkpoints. This row contains no checkpoint
success flag and cannot make stale coverage eligible for a later release.

## Delivery phases

**ACK-1: worker confirmation and Java transport now.** Implement the bounded
boot-v3 route, synchronous original-entry confirmation, closed Java protocol,
HTTP transport and original-runtime wrapper. Verify actual Java-to-native HTTP
using the real executor. This is useful protocol/worker functionality without a
new database table, coordinator, command or purported durable evidence. Existing
retirement ownership and the CSI provisioning gate remain unchanged.

**ACK-2: trusted original provenance, then durable evidence.** First establish and
review how the coordinator obtains trustworthy persisted original Pod identity.
The [ACK-2 follow-up](2026-10-03-csi-durable-worker-ack.md) now implements the private authority plan, two-stage RPC/final transaction, append-only migration and real single-publication caller described below. Those parts were NOT_IMPLEMENTED in the historical ACK-1 baseline. Do not add an unreachable public method,
unsupported-only command/table stub or package-private fake-authority positive
and call it production persistence. D1–D6 are ACK-2 acceptance groups, separate from ACK-1 results; their current evidence and remaining qualification limits are recorded in the follow-up.

## Closed wire contract

ACK-1 implements `POST /internal/managed-runtime/csi/v1/acknowledge`, registered only on the
boot-v3 worker and included in its owned-route inventory. Ownership is the
original persisted-workspace worker, authenticated with that boot's token, lease
ID and epoch; there is no primary-runtime or replacement-worker fallback.

Both directions have these required keys; there are no optional keys:

| Key               | Value and authority                                                        |
| ----------------- | -------------------------------------------------------------------------- |
| `protocolVersion` | `1`                                                                        |
| `managedCsi`      | `"managed-csi/1"`                                                          |
| `workerAck`       | `"managed-csi-original-worker-ack/1"`, distinct from drain/status          |
| `retirementId`    | Canonical lowercase UUID, equal to the executor's existing seal            |
| `context`         | Original no-secret managed-context attestation tuple, defined below        |
| `storage`         | Original boot-v3 CSI tuple, defined below                                  |
| `pod`             | Exactly `uid`, `namespace`, `nodeName`; actual startup identity            |
| `reference`       | Exactly `sessionId`, `promptId`, `callId`, `argsDigest`                    |
| `acknowledgement` | Exactly `executionCallId`, `manifest`, `deliveryStatus`, `historyRevision` |

The response additionally requires `state: "ACKNOWLEDGED"` and `captureIdentity`.
The request must not contain either. `captureIdentity` has exactly the existing
`ToolResultExpectedIdentity` keys: `tenantId`, `sessionId`, `turnId`,
`executionCallId`, `callId`, `invocationDigest`, `bindingGeneration`, `captureId`,
`revision`. It comes from the original entry's capture sink identity, not request
echo. This first capture contract requires `revision: 1`.

`context` has exactly `protocolVersion: 3`, `managedContext: "managed-context/1"`,
`runtimeInstanceId`, `runtimeIncarnation`, `leaseId`, `epoch`, `provisionRequestId`,
`tenantId`, `workspaceId`, `workspaceGeneration`, `storageId`, `mountRoot`,
`capabilityDigest`, `isolationClass`. Reuse the existing context validator and
require workspace isolation. Do not emit `token` or an endpoint.

`storage` has exactly `clusterDomain`, `namespace`, `pvcUid`, `pvUid`, `driver`,
`volumeHandle`, `backendDomain`, `diskSerial`, `physicalKey`,
`registrationRevision`, `reservationId`, `reservationRevision`. Reuse the CSI
validator, including `driver: "diskplugin.csi.alibabacloud.com"` and physical-key
derivation. `reservationRevision` is the original boot's RESERVED revision, not
the later SQL DRAINING revision. Java checks both against their own authorities.

This slice accepts only `deliveryStatus: "committed"`, a complete original capture
and a non-null original manifest. The manifest uses the existing closed durable
reference (`resourceId`, `kind`, `schemaVersion`, `byteLength`, `digest`), with
`kind: "managed-tool-result-manifest"`, schema version 1 and length 1–65536 bytes.
`historyRevision` is the positive safe-integer receipt event sequence, not the
SQL journal revision. Keep both values separately in durable evidence.

Preserve existing field validation: canonical decimal strings for Java long
generations/revisions, safe integers for epoch and receipt sequence, stable-ID
UTF-8/NFC limits, exact digest syntax, and the original Pod UID/namespace/node-name
rules. Do not normalize malformed input into a match. Requests and responses are
bounded to 16 KiB; oversize tuples are unresolved, never truncated. Reuse bounded
JSON handling and closed semantic validators. Java must reject invalid UTF-8,
duplicate keys and trailing tokens; its existing Jackson dependency can supply
this dedicated strict reader without changing legacy context/V3 parsing. Error
bodies cannot be positive ACKs.

Every numeric field in this dedicated wire contract must use a canonical
positive JSON integer token matching `[1-9][0-9]*`, within its existing safe-integer
and field-specific bounds. This includes outer `protocolVersion`, context
`protocolVersion` and `epoch`, manifest `schemaVersion` and `byteLength`, receipt
`historyRevision`, and response capture `revision`. Reject fractions and exponent
tokens even when their mathematical value is an integer: `1.0` and `1e0` are
invalid, as is `5.0000000000000001`. Checking only the rounded JavaScript number
cannot enforce this policy. Decimal-string generation/revision fields remain
strings under their existing canonical rules.

Only the ACK route adds an Express `verify` callback with fatal UTF-8 decoding,
the existing native duplicate-key checker and Node 22 `JSON.parse` reviver
`context.source` inspection for the integer-token expression and safe-integer
bounds. Java scans integer tokens with its dedicated strict reader before closed
validation. Java also preflights its own encoded request through that reader
before `post`; a Map value that serializes as a noncanonical numeric token must
cause zero HTTP requests. Do not change generic V3/context JSON parsing.

## Worker confirmation

Add one CSI-specific synchronous executor operation around the existing ACK
checks. Require the same already-installed retirement seal before mutation; this
route does not implicitly seal or change the retirement ID. Require the original
V3 entry, exact reference, settled result, complete capture, actual capture
identity and matching committed receipt. A `not_started` result cannot qualify.

The CSI operation compares the closed receipt and manifest by their exact field
values, ignoring only JSON property order. The existing generic `acknowledgeV3`
uses `JSON.stringify`; leave that behavior unchanged. If an acknowledgement
already exists, require closed semantic equality with the request and actual
capture, and require the actual captured delivery status to be committed. This
includes acknowledgements saved directly by the native publisher's `accept`
path, whose manifest properties may be ordered differently. After the full
prospective-response bound check, return confirmation read-only: do not invoke
the generic setter or rewrite any entry fields. An existing ACK with a
noncommitted actual capture conflicts with 409. For the first ACK only, construct
the validated receipt using the actual entry's manifest field order before
calling the generic setter. Never rewrite the entry's manifest, acknowledgement
or result solely to make a string comparison pass.

Before calling the ACK setter, build the entire prospective positive response
from validated original facts, serialize it and check its UTF-8 byte length
against 16 KiB. This includes the extra capture identity, so a bounded request
alone is insufficient. Serialization or response-bound failure must leave both
acknowledgement and result unchanged. For a first ACK, only then call
`acknowledgeV3` and require its settled result and matching stored receipt. For
an existing qualified ACK, perform no mutation. Both paths emit the same
validated response bytes. Do not add fields or reread mutable entry data after
the bound check.

Perform those steps within one synchronous operation. Do not await a resolver
or publisher, prepare a capture, install a grant, create an entry or start a tool.

The same receipt may be confirmed again after an earlier ACK or a lost response.
A different receipt/reference/retirement conflicts. Missing, restarted, unknown,
incomplete or blocked state emits no positive confirmation. Malformed requests
use 400; original-identity/state conflicts use 409; authentication and body-limit
failures retain their existing 401/413 behavior. Every positive response has
`Cache-Control: no-store` and the JSON content type.

Do not require aggregate `QUIESCENT` before ACK. Shell, publication, provider and
MCP lifecycle blockers deliberately survive settled results and receipt acknowledgement;
requiring them to disappear would make this step wait for unrelated later proof.
ACK must not remove these lifecycle blockers or reset them via generic close. Existing
status, cancel, history controls and MCP release retain their original admission
rules; ordinary LOCAL close and generic V3 ACK remain compatible.

## Java protocol and transport (ACK-1)

Outside any SQL transaction, `RuntimeTransport` sends the dedicated request only
to the original lease. Its default implementation fails unsupported; HTTP
enforces `Redirect.NEVER`, the original auth headers, 16 KiB response limit,
strict decode and one bounded total deadline, including the response body.
`WorkspaceRuntimeTransport` explicitly forwards through its original-runtime
guard. No acquire/renew/replacement or new-work admission is introduced. A generic
V3 `settled`, `unknown`, outer `acknowledged` flag or drain response cannot pass
the dedicated protocol validator.

The dedicated strict reader promotes the existing `jackson-databind` 2.20.0
dependency in `packages/sdk-java/runtime-broker/pom.xml` from test scope to
production scope by removing its single scope line. Keep the existing version
pin and global legacy parser unchanged. Qualify the standalone Broker's resolved
2.20.0 classpath and the managed application's resolved 2.21.4 classpath
separately; passing one is not evidence for the other. Record the actual loaded
Jackson version and code-source location in each verification run.

The existing three-argument `context` guard assumes Session isolation, with the
request's isolation key equal to the Harness Session ID. Applying it unchanged
would reject a workspace-isolated CSI request whose isolation key is null. Add
one private `originalCsi` branch used only by dedicated ACK: the existing
three-argument calls delegate with `originalCsi=false`, preserving their guard;
only ACK requests the new branch. That branch requires workspace isolation with
a null isolation key, `kubernetes-workspace` kind, a DRAINING parent with
`drainRequested`, a READY original Runtime Session, and matching original request,
seed, lease, context, capture and Session pins. Reject any mismatch before
delegating. It does not authorize new work, change generic recovery admission,
or acquire ownership. Review every `context` caller so no old control, status,
cancel, generic ACK or release gains the new branch.

The protocol takes the explicit original boot/storage/Pod expectation required
for exact comparison. Its native HTTP fixture may supply synthetic boot/Pod
identity, but that demonstrates the protocol boundary only. ACK-1 does not
resolve that expectation from authoritative production CSI placement or expose a
new durable retirement command. The ACK-2 coordinator must supply qualified
identity; a returned Pod tuple cannot serve as its own expectation.

## Java authority and two-stage persistence (ACK-2)

This authority/persistence section was outside ACK-1 scope and is now implemented by the linked ACK-2 follow-up. Its private single-publication coordinator keeps store operations internal and requires trusted provenance. Its command accepts only original retirement and Session/
publication selectors; it loads registration, binding, original lease, receipt
and expected worker identity from trusted records. It accepts no endpoint, token,
Pod tuple, response JSON or success boolean from command input.

The coordinator first prepares an immutable authority plan on its own database
connection. It refuses ambient transactions and custom/different-DataSource
repositories. It validates the original DRAINING retirement/holder, registration,
active slot, immutable seed/handle/lease digest and attestation generation. The
original execution must be SETTLED and deferred-v3 with the actual persisted
authorization pair preceding the sealed binding version. Match the full Session,
turn, reference, request digest and publication scope.

Reuse the existing original-publication authorities to obtain the complete
Broker result, terminal/finish operation, REFERENCED admission outcome/manifest
and exact committed `tool.receipt`. Preserve full-result numeric semantics and
all nonnumeric fields. Validate resource bytes through the existing resource
authorities outside the final transaction. Ordinary receipt verification can
update verification/quarantine state; do not call this read-only snapshot work.
Before networking, finish and release all database transactions/locks.

The expected Pod tuple must come from trustworthy, persisted original CSI
placement/attestation provenance. The historical ACK-1 `WorkspaceCsiRuntimeProvisioner` could not provide that provenance; the ACK-2 follow-up adds trusted original identity without opening aggregate retirement. A null pre-create handle, K1 scratch
handle or worker-supplied Pod UID cannot qualify. The real ACK command and evidence insert path require that persisted boundary and its review. Component fixtures do not open production admission, and no optional
proof provider or caller approval flag bypasses this gap.

After a positive exact response, open a new short transaction and reacquire the
existing order on the same native JDBC connection:

1. Placement domain → active slot → original binding.
2. Registration alias → physical reservation/holder → retirement journal.
3. Original execution → tenant guard → original Session head → publication.
4. Existing original receipt/journal, finish-operation and resource-object locks
   in their publication authority's established order.
5. The single ACK evidence key, last, for idempotent insert/readback.

Reuse `WorkspaceCsiReservationStore.lockPublication` and the full original
SETTLED publication guard; do not introduce ACK-first or publication-first locks.
All mutable decision rows after a lock wait use current locking reads, including
quarantine, referenced receipt/admission and finish/object state. Revalidate the
plan's exact pins and response against those current rows. Original writer/
activation ownership and expiration checks retain the existing settlement rules
and run after waits; no new owner is acquired to make a stale plan pass. A newer
unrelated head revision need not equal the prepared head, but the original
receipt and original ownership must remain valid.

The final transaction performs no worker RPC or external resource I/O. Any late
change, expiry, quarantine, lost original identity or failed insert rolls back
without ACK evidence. A successful RPC followed by a failed commit is retried
against the same original worker and receipt. Worker memory may already be
acknowledged; that does not let Java skip the final authority checks.

## Migration and immutable idempotency (ACK-2)

ACK-1 did not create an ACK table or schema stub. ACK-2 adds
`workspace_csi_worker_ack` in V44 after the October 5 main integration (V43 in the
October 4 integration); reconfirm the next unused number before landing. Do not
rewrite the retirement identity (V42 here, V41 in the October 4 integration, V29
in the earlier snapshot), other applied migrations, or existing rows. Add one table, `managed_workspace_csi_worker_ack`:

| Column                     | Meaning                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `retirement_id`            | Canonical UUID; first primary-key component                       |
| `execution_call_id_hash`   | SHA-256 of exact validated UTF-8 ID; second primary-key component |
| `execution_call_id`        | Original ID; compare exactly after every hash-key read            |
| `evidence_json`            | Bounded closed immutable evidence document                        |
| `evidence_digest`          | SHA-256 of the saved document's exact UTF-8 bytes                 |
| `recorded_at_epoch_micros` | Database observation time as integer epoch microseconds           |

Use the existing binary-collation conventions and reject collation aliases after
lookup. No phase, mutable ACK boolean, retries counter, replacement identity or
secondary query index is needed. Use the existing database epoch calculation;
do not convert session-local `CURRENT_TIMESTAMP` through a mismatched JDBC time
zone. Recorded time is observation time, not worker-stop or receipt time.

The evidence document has exactly `schemaVersion: 1`, `original`, `confirmation`.
`confirmation` is the validated positive wire response. `original` has exactly
`retirementIdentityDigest`, `bindingId`, `bindingGeneration`, `sessionKey`,
`publicationId`, `publicationBindingDigest`, `authorizedDispatchGeneration`,
`authorizedBindingVersion`, `finishOperationId`, `terminalRef`, `outcomeRef`,
`receiptJournalRevision`, `receiptSequence`. `sessionKey` has exactly `tenantId`,
`workspaceId`, `sessionId`; resource refs keep the existing five fields. The
retirement digest binds the exact saved immutable retirement bytes, including
original handle/lease pins. SQL integer identity values use canonical decimal
strings in this document, checked against their authoritative ranges; receipt
sequence also equals the wire's exact safe-integer value. Limit saved evidence
to 32 KiB and fail closed rather than omit fields. Do not copy credentials.

Only the coordinator can reach the validated insert path; there is no public
`recordAck(true)` or caller-constructible proof submission API. On the first
success, insert and strictly decode/read back the complete row. Same key and
identical validated original/confirmation semantics return the first row without
changing its bytes or time. A different tuple under the same key conflicts.
Parse and compare the full closed document as well as its digest and indexed
IDs; a matching hash or reordered JSON alone is not authority. Corrupt JSON,
unknown schema, invalid Unicode, partial fields and raw-ID aliases fail closed.

A process/connection restart can read the saved row as a historical ACK fact,
without calling the worker or pretending the fact is current liveness. Retrying
an unsaved row requires a fresh valid RPC. A saved row cannot bypass a later
aggregate consumer's fresh original-identity, checkpoint and physical checks.
Do not backfill ACK rows from old REFERENCED publications.

## Affected files and delivery boundary

| Layer                                  | Planned files and consumers                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACK-1 worker protocol                  | `packages/cli/src/serve/managed-csi-envelope.ts`, `managed-csi-worker.ts`, `managed-runtime-tool-executor.ts`, `managed-runtime-attestation-worker.ts`; their focused collocated tests                                    |
| ACK-1 Java transport                   | Runtime-broker `ManagedCsiProtocol.java`, `RuntimeTransport.java`, `HttpRuntimeTransport.java` and focused protocol/transport tests; managed-agent-server `service/WorkspaceRuntimeTransport.java`                        |
| ACK-1 strict-reader dependency         | `packages/sdk-java/runtime-broker/pom.xml`: the existing `jackson-databind` dependency changes from test to production scope; separate standalone 2.20.0 and managed-application 2.21.4 verification                      |
| ACK-2 private coordinator and evidence | New managed-agent-server `store/WorkspaceCsiWorkerAckStore.java` and `store/WorkspaceCsiWorkerAckMain.java`, with package-private authority plumbing in the existing CSI reservation/publication stores only where needed |
| ACK-2 persistence                      | One new migration and its actual schema/migration test entry; new `WorkspaceCsiWorkerAckStoreTest.java`                                                                                                                   |
| ACK-1 shared contract                  | A bounded ACK fixture adjacent to the existing CSI fixtures, consumed independently by Java and TypeScript; no generic Tool v3 schema change                                                                              |

ACK-1 rows describe this historical increment. ACK-2 locations are now implemented by the linked follow-up, with real authority and evidence checks rather than placeholder files. In ACK-2, keep the
coordinator/store together unless an actual second consumer requires a
separate abstraction. Review all new read sites, the owned-route registry and
transport wrappers. No checkpoint parser, extra publisher proof interface or
public service route is required.

## Verification and acceptance

The test plan (local verification artifacts, not committed) separates
global CLI baseline, native worker HTTP, Java protocol, owned H2/MySQL persistence
and later production qualification. Obtain original execution, capture,
publication and receipt via production APIs; never mint a successful ACK with
SQL or a canned success response in the acceptance path. A transport-only mock
test is explicitly narrower evidence.

ACK-1 requires the real Java HTTP client and native worker executor, including
missing/unknown/blocked/not-started entries, changed tuple, wrong seal,
malformed/oversize/deadline failures, wrappers and compatibility. Synthetic
boot/Pod inputs are explicitly local protocol fixtures, not trusted production
provenance. No SQL ACK insert is implemented or tested in ACK-1; the existing
provisioner gate and unchanged durable schema are checked independently.

An implementation-stage native reproduction sent raw receipt sequence
`5.0000000000000001`, which was rounded to 5 and incorrectly returned HTTP 200
ACKNOWLEDGED while changing the entry's capture from pending to committed.
The retained reproduction is failure evidence, not post-fix verification. The
test plan requires raw-token rejection on both languages, no ACK mutation and
zero Java HTTP calls for malformed encoded requests, plus an actual native
auto-accept reordered-manifest retry and a separately labeled noncommitted
existing-ACK negative. The frozen local post evidence below verifies the two
reproduced numeric/property-order fixes; the original failure records remain
unchanged.

Acceptance also requires a real workspace/null-isolation-key wrapper positive,
rejection of wrong kind/state/session/request/seed/lease/context/capture pins,
and unchanged behavior for every old three-argument context consumer. Inspect
both resolved Jackson classpaths and execute the strict protocol positives and
negatives against each, including fractional numeric identities, duplicate keys,
invalid UTF-8/Unicode, trailing tokens and byte bounds. Neither the POM scope
change nor a test-only classpath establishes production qualification by itself.

ACK-2 D1–D6 qualification requires trustworthy provenance; current outcomes are recorded in the linked follow-up. They must
prove late expiry/quarantine and authority conflicts install zero rows, exact
retries, independent-process reload, concurrent insertion and rollback after an
actual ACK. MySQL tests must observe real lock waits and current rows under
repeatable read; H2 alone does not qualify that behavior. Check UTC/non-UTC clock
bounds. Do not substitute package-private fake authority for the real
coordinator's positive chain. Each phase preserves its own raw assertions,
source/class/dependency hashes, actual exits and owned cleanup.

Focused tests, build/typecheck/bundle and applicable lint/checkstyle have local
results below. Two clean root self-audits and independent exact-scope source
review completed for this component. No formal approval, CSI creation, real Linux mount,
cloud execution or physical release qualification is claimed.

Recorded ACK-1 verification on 2026-10-03:

| Evidence                                                      | Local result                                                                                                                       | Scope                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent build and focused checks                               | Build/typecheck/bundle/ESLint/Prettier exited 0; CLI 377 tests, Broker 74 tests, managed server 28 tests; Java Checkstyle exited 0 | Frozen component checks; separate from independent execution counts                                                                                           |
| Java → built native, Jackson 2.20.0                           | Three chains passed: 17 + 17 + 18 = 52 group executions                                                                            | Dedicated-first, ordinary-ACK-first and native autoaccept with reordered manifest; raw SHA `c605bf34d73408a7a9b845a0dbcf7b849e81579302d6b8d72cf5082732c88428` |
| Java → built native, managed dependencies with Jackson 2.21.4 | Same three chains passed: 17 + 17 + 18 = 52 group executions                                                                       | Actual loaded version/CodeSource checked; raw SHA `366245d7abcf68cf8633a81bf67c5726c3a5db786c4876cab93f528c31a481df`                                          |
| Integrity and cleanup                                         | All 15,978 frozen inputs unchanged per run; parent rechecked 60 owned PIDs absent and 18 ports closed                              | Owned temporary directories removed; parent readback is not another product execution                                                                         |
| Self-audit / code review                                      | Two clean root passes; independent scoped review found no confirmed findings                                                       | ACK-1 component only; no formal SDK approval, full K2 or ACK-2 acceptance                                                                                     |

The independent post report (local verification artifacts, not committed)
links both raw results and lists executed refusals and unexecuted broader plan
items. There are 104 group executions across two classpaths, not 104 unique
scenarios. Actual Java requests reached the original native executor; original
capture identity and the two causal fixes were checked. The noncommitted
existing-ACK control is explicitly manual, not a claimed natural transition.
The parent readback (local verification artifacts, not committed)
has SHA `b3a97ea3e7dceab15e04f456efceaf15ea37e9e1fc98175e86eac0bca5edf4ea`.

The post uses synthetic boot/Pod identity and local native capture. It does not
qualify trusted CSI provenance or container/Linux startup, and it opens no
database. Provisioner/migration checks are source observations only. Wrapper,
full per-field numeric/Unicode, response-overflow and network-lifecycle matrices
must retain their separate focused-test/review scope; they are not folded into
the independent post counts. Holder DRAINING and all ACK-2/MCP/stop-unpublish/
physical-release limits remain unchanged.

Local closure is recorded in the root self-audit (local verification artifacts, not committed) and independent scoped review (local verification artifacts, not committed). The review pins the pre-closure design/plan bytes; subsequent edits update status and links only, without a source or test change. Its conclusion covers this ACK-1 increment, not the accumulated worktree.

## Follow-up limits and unresolved prerequisite

Trusted persisted original CSI Pod/worker provenance and the durable coordinator
are implemented and undergoing qualification in the
[follow-up design](2026-10-03-csi-durable-worker-ack.md). Its evidence is separate
from ACK-1. No user-supplied proof configuration is accepted.

Later work must enumerate the complete original inventory, recheck receipt and
checkpoint coverage, and qualify complete MCP configuration/operation/release
history. Latest `released` or a resolved close promise cannot erase unknown
history or substitute for strict MCP drain. Authenticated worker ACK and local
QUIESCENT cannot prove original Pod/container/descendant termination or ordered,
trusted CSI NodeUnpublish. The CSI log reader remains qualification input only.
Only a later reviewed consumer may combine all qualified evidence and atomically
release the exact original holder. This slice performs none of those transitions.
