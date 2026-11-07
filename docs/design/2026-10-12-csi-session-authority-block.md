# Private CSI Session and SQL authority extraction

[English](2026-10-12-csi-session-authority-block.md) | [简体中文](2026-10-12-csi-session-authority-block.zh-CN.md)

## Status and source

This is a proposed feature extraction for maintainer review. The source is
PR #13526 at `4088e2455c2c9cb922fe42987d8f29f3ed2a6c49`; the extraction starts
from main `18f80f56666a347a2b67b2ef98099cc58356b253`. It preserves the worker
and local-process boundary merged in #13899 and the publication locking fix
merged in #13894. The proposal branch remains unchanged. Validation results
must identify the extracted candidate they actually executed.

## Problem and current state

Main has the private descriptor-backed file worker and rejects this capability
from local-process runtimes. The worker's positive tests use explicit authority
fixtures. Main does not yet connect a persisted private Session, its original
activation and native journal to the worker's context and execution evidence.

The proposal contains that connection, mixed with Hosted execution, cold
recovery, application retirement and physical completion. Copying entire
shared files would also overwrite later main fixes. This extraction follows
the complete READY authorization chain and preserves ordinary behavior.

## Goals and boundaries

- Create a private Session through an explicit operator command and pin the
  original request, context, storage, profile and identity transactionally.
- Admit one original native writer and first activation; validate the committed
  journal and the resources that establish each finite file invocation.
- Persist exact SQL execution grants and authenticate worker context, history
  preparation and execution readback against the same original Session.
- Retain bounded resource-read ownership and its failure evidence.
- Preserve ordinary Session, publication, runtime and tool behavior.

Public CSI selection, Hosted runners, replacement writers, cold recovery,
DRAINING continuation, terminal cuts, finalization, physical stop/unpublish,
release and reuse remain outside this change. Private unsupported paths refuse
before changing ownership or invoking a worker. The native journal parser may
validate message, model-attempt and tool-result records because they are inputs
to file authorization; it does not introduce a Hosted execution entry point.

## Proposed changes

| Layer             | Changes and consumers                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private creation  | Explicit Session command, request-key persistence and registered storage/context qualification in the Managed Agent store. Ordinary selectors stay unchanged.                     |
| Original identity | Shared CSI boot/request identity, managed Session guard and Broker binding/Session repository checks. Every admission uses the selected original binding.                         |
| Native journal    | Managed Session Store commit preflight and acceptance plus activation/history proof. Resources, journal head, writer and activation remain one transactional authority.           |
| SQL execution     | Native tool reservation, complete batch membership, dispatch checkpoint and immutable grant persistence in binding/execution repositories. A reservation is not an authorization. |
| Worker transport  | Authenticated native readback route, context installation, history and finite file execution in the selected-Session adapter and HTTP transport.                                  |
| Resource reads    | Persist OPEN/RETURNED/UNKNOWN read ownership and recheck original writer, resource bytes/metadata and delivery bounds. Uncertain reads remain recorded.                           |
| Schema            | Fresh unpublished migrations for request pin, first activation, native authorization and resource-read ownership. Published migrations are unchanged.                             |

The principal affected areas are `packages/managed-agent-server` and
`packages/managed-agent-server`. Existing shared stores, transport,
schema and configuration receive only required CSI changes; new private
classes and their tests are extracted from the frozen source. Main's existing
workspace execution lease schema and later ordinary reader, collection,
definition, rename and cancellation behavior must survive the extraction.

## Decisions and constraints

### One original owner

The capability digest and configuration identify the private file profile.
Creation pins its canonical request key and context revision 1. Admission
requires the persisted original Session, binding generation, storage,
boot/Pod identity, lease and installed context to agree. Unknown, ambiguous,
changed, draining or replaced identities refuse; there is no primary-runtime
fallback. The supported writer and activation are the first original ones.
An expired writer cannot be replaced in this extraction.

### One SQL authority

Operations qualify the original connection and transaction. Lock ordering
starts with placement and retention, then the managed parent/native head and
original runtime/execution records. The adapter does not hold parent SQL locks
across worker I/O; it qualifies the same original before and after the call.
Both READ COMMITTED and warmed REPEATABLE READ must see conflicting current
state through locking reads.

Journal proof checks exact durable resource bytes, identities, chain,
references, checkpoint and complete accepted batch membership. It accepts the
native message and numeric encoding actually used by the producer. Worker
paths, input bytes and preparation evidence come from committed records, not
caller assertions. An immutable grant binds the original dispatch generation
and authorized journal revision/sequence. Retries cannot replace it with a
newer head or a new owner.

### Ordinary query budgets and compatibility

Existing ordinary Session locking reads check the generated `csi_guard` column directly, retaining refusal for a persisted request pin without reading the same Session twice. Mutations with no existing parent-row read retain the dedicated locking guard. Placement, retention and Session lock order remains unchanged.

MQ wake claims use the same durable legacy-mutation guard before inserting or advancing `journal_wake` progress and before scheduling Hosted activation. An expired private writer lease does not admit a legacy claim: both the private profile and a persisted request pin refuse without changing the Session, journal head or existing progress. Ordinary wake claims, redelivery deduplication and activation retain main's behavior.

Ordinary publication refuses private Sessions when allocating a read lease or PUT attempt. Session profile and request pin are fixed at creation; supported APIs never convert an ordinary Session into a private Session. Admitted leases continue checking expiration and retirement, and close only removes that lease. Admitted PUTs must record RETURNED or UNKNOWN without losing physical-write evidence to another admission check. These settlement operations do not need another journal-head lock. Collector guards and lock order remain intact. Main's budget assertions are unchanged: 4 statements for an empty materialization tick, 35 for a full batch and 17 for its tail, and 6 locked head reads in the exercised publication path.

Broker and Server share the identity implementation. The Spring adapter `com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiRuntimeIdentity` retains its public static `verify`, `boot` and `expectedPod` methods, delegating to Broker. The adapter is deprecated without duplicating validation logic. The added Broker API and feature still require maintainer review.

Integration with main retains ordinary Monitor control classification, exact watch ownership, exit-evidence settlement and hold-row fencing. Private CSI history dispatch still requires the original READY owner and its own control fence. Every generic control, including Monitor, refuses a private CSI Runtime before transport. These are separate existing paths; the integration adds no private Monitor or Hosted entry point.

Main's public Shell/MCP lifecycle uses protocol 2 while Files retains protocol 1. Ordinary close/delete capabilities follow main's profile-aware checks, and completion retains placement-before-retention-before-Session locking for both protocols. Private CSI still refuses close/delete and the new resource-drain path checks the persisted binding profile before cleanup admission, reconciliation or Session release. This adds no private lifecycle, DRAINING continuation, finalization or physical reuse qualification.

Ordinary projection completion derives its locking scope from the persisted result row and retains tenant, private guard, head, publication, public Session and result ordering. After reading the current result row, it checks LEASED state and claim generation first. Settled work returns false without parsing obsolete source JSON. Active claims still require complete stored-source, scope and caller-claim agreement before any write. Private refusal derives from the persisted owner and cannot borrow a foreign caller's tenant.

The two private operator repackage artifacts use `csi-session` and `csi-runtime` classifiers. The ordinary Server image selector explicitly excludes them and still requires one unclassified main JAR; this adds no private execution entry point to the image or Kubernetes deployment. Upgrade verification admits only the canonical active V1/V2 inventory while retaining row-by-row V1 Flyway history comparison. Concurrency tests observe the requested row lock within the exact current schema and table: MySQL uses `performance_schema.data_lock_waits`/`data_locks`, while MariaDB uses `information_schema.INNODB_LOCK_WAITS`/`INNODB_LOCKS`. Polling allows the InnoDB information-schema cache to refresh instead of retaining a pre-wait snapshot. The five-second deadline, blocked-future, refusal and no-effect assertions remain unchanged.

### READY scope and failure behavior

The adapter admits only READY work. Existing retirement evidence is a refusal,
not authority for DRAINING continuation. It never implements release or
declares physical completion. A failed or uncertain read keeps its durable
ownership evidence. Unsupported recovery and terminal operations are rejected.

The merged worker refuses prepare while an execution is active and execution
while preparation is active. A producer must stop issuing executions for that
Session before attempting preparation. This adapter does not spin or infer
that a generic worker 409 is safely retryable; original evidence and failure
state remain intact. A future automatic producer needs an explicit
retry-versus-retirement contract, including the existing shared error codes.

### Cancellation and durable outcome capacity

An authorized private execution cannot be cancelled through the shared Broker
route. The service refuses before requesting a durable cancellation, and the
JDBC repository enforces the same rule after original-owner qualification.
Unstarted, unauthorized cancellation and ordinary Runtime cancellation retain
their existing semantics.

The execution envelope remains bounded to 1 MiB. A native outcome contains
that exact envelope and converted model history, which can duplicate text and
error details. Outcomes up to 64 KiB retain `managed-tool-outcome`. Larger
outcomes use a `managed-tool-outcome-chunks` JSON manifest containing only
`parts`, in byte order, referencing `managed-tool-outcome-part` resources.
Parts are 60 KiB except for the final nonempty part. There must be 2–69 unique
parts, with a combined limit of 4 MiB; concatenation precedes UTF-8 parsing.
Each manifest and part remains under the existing 64 KiB inline bound.

The producer publishes every part and the manifest, uses the manifest as
`toolOutcomeRef` and its digest as the receipt's `contentDigest`. The HTTP
journal adapter includes the parts in the same transaction's resource census,
including when the manifest was previously committed. Native proof verifies
each part's kind, length and digest through that revision's SQL references,
then applies the existing closed-body, execution-envelope and history checks.
Missing, altered, duplicate, short, excessive or foreign parts refuse. This
format does not enable Hosted execution or complete the remaining end-to-end
execution qualification.

### Migration history

The active catalog is main's fresh 32-table `db/managed-schema` baseline.
Published V1 remains byte-for-byte unchanged. Additive V2 places the request pin
and generated private classification on `ma_session`, the original activation
revision on `ma_runtime_binding`, and immutable native authorization on
`ma_tool_execution`. The proposed legacy CSI migrations are removed; archived
migrations never enter the runtime or test classpath. No version is reserved
for an unmerged PR, and #13526 remains unchanged.

Initialization admits only the complete canonical V1 or V2 catalog. An
unversioned V1 database receives the same additive extension; a versioned V1
database upgrades through Flyway. Server baselining records the actual catalog
version before migrating, preserving existing V1 history and checksums. Partial,
foreign and legacy catalogs remain rejected.

Native resources retain binary tenant/session identities, computed scope and
resource keys, `MANAGED_SESSION` heads and `JOURNAL` ownership references.
Persistent reads use `ma_request_receipt` with namespace `SESSION_COMMAND`,
operation `CSI_RESOURCE_READ` and a separate hashed read scope. Its immutable
JSON evidence retains OPEN/RETURNED/UNKNOWN state independently of the transient
`ma_read_lease`. Ordinary receipt consumers remain separated by namespace,
operation and scope. Publication locking still acquires placement before
retention and session authority; generic consumers refuse private sessions.

The integrated main includes #13642's four canonical retention indexes. Its
terminal JDBC sweep keeps private capability families and Sessions with a
retained private pin, and treats persisted native authorization as a reference.
This is a cleanup refusal for existing historical evidence; it adds no private
release or terminal transition. Ordinary unreferenced terminal history still
expires under the main retention policy.

## Validation and acceptance criteria

1. Dry-run the global CLI, then use an owned SQL/API fallback where the private
   Java operator cannot be reached through the global CLI.
2. Verify private creation and exact replay, changed request refusal, original
   activation and renewal, and replacement-writer refusal.
3. Drive committed native intent/checkpoint/resources through actual SQL grant
   and authenticated worker readback. Missing members, altered bytes, foreign
   credentials, wrong context and stale authorization must refuse before file
   effects. Verify successful exact retries and retained history.
4. Exercise current-state fences with two independent database connections
   under both supported isolation levels; verify placement-before-retention.
5. Test resource reads, including unknown delivery, expired leases and changed
   metadata/bytes, without clearing ownership evidence.
6. Compare ordinary controls and run affected Java tests, static checks,
   migration checks, repository build/typecheck/bundle and relevant worker tests.
7. Perform two consecutive clean full-diff audits and independent review.

Positive private worker execution on Darwin requires an explicitly documented
Linux metadata/procfs translation. Such evidence is not native Linux CSI,
Kubernetes, SQL producer deployment or safe physical reuse qualification.
Tests against the original proposal do not qualify the extracted branch.

### Observed evidence and remaining acceptance work

The 16 native activation proof tests use the standard Surefire `Test` suffix, so ordinary Server test discovery includes them. Both Server CI lanes build their Node producer prerequisites before Maven runs. These H2-backed native proof tests do not replace the actual SQL grant-to-worker acceptance below.

The extraction has been externally marked Ready and still requires maintainer review. Before canonical schema integration, local build, typecheck, bundle, focused
Java and worker tests have passed. An independent owned MySQL 8.4 run applied
the then-current legacy migration inventory and observed real private CREATE/replay,
seven native journal commits and their replays, original activation/renewal,
replacement refusal, ordinary controls, authenticated adapter bind readback,
and current-state locking reads under both isolation levels. These earlier
results do not qualify the canonical V1/V2 adaptation. Independent
regressions also cover retained request pins and the worker-sized HTTP result
receive limit. Every report records its actual candidate and artifact hashes.

Canonical integration verification separately exercises real MySQL V1-to-V2
upgrades and baselining of unversioned V1/V2 catalogs, preserving V1 history,
ordinary rows and distinct binary tenant identities. Owned MySQL tests cover
private creation versus collection, current-row refusal under both isolation
levels, and original resource reads with durable OPEN/RETURNED/UNKNOWN receipts.
The read fixture supplies an original READY identity and explicit JDBC cleanup
faults; it does not launch an authenticated worker or mint a native SQL grant.
Ordinary materialization retains main's measured query budgets, including its
empty tick and snapshot-writing batches. These are schema and component
observations; the full acceptance limitation below still applies.

These observations do not complete criterion 3: an actual SQL execution grant,
authenticated execution readback and positive worker/retained-history effects
have not been exercised together. Resource delivery faults have H2 unit
coverage, not independent MySQL end-to-end qualification. Protocol fixtures
and pure proof tests must not be described as a real SQL grant or deployment.
The separate PR test report distinguishes these evidence levels. Maintainer
review and the remaining acceptance work are required before rollout.

## Risks, follow-up and open questions

This is a substantial cross-package feature and needs maintainer architecture
review under the repository's core infrastructure advisory. It does not grant
production rollout approval. The retained owner has no release path here;
operators must not mistake logical success for reusable storage.

Hosted integration, cold recovery, aggregate application/physical retirement,
safe release/reuse and producer fairness/error classification remain separate
work. In-place file mutation retains #13899's documented failure semantics;
crash-atomic replacement is not added. No new business or architecture choice
is required to preserve the declared private READY boundary during extraction.
