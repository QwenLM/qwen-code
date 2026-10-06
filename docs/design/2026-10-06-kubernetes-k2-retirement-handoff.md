# K2 completion: aggregate retirement and safe CSI handoff

[English](2026-10-06-kubernetes-k2-retirement-handoff.md) | [简体中文](2026-10-06-kubernetes-k2-retirement-handoff.zh-CN.md)

Status: completion design with a local K2-A1 prototype, updated 2026-10-07. K2-A2 through
K2-D remain proposed; no complete K2 or new cluster acceptance is claimed.
Implementation baseline: main `4bffa678bced8b14c25c85e3ba4226b7b752414d`, after
[PR #13289](https://github.com/QwenLM/qwen-code/pull/13289) merged as
`69d5db2ff2424da01ac6f14e4c484773aae7204c`. Track remaining work in
[issue #13395](https://github.com/QwenLM/qwen-code/issues/13395); keep
[proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380) open.
This is the completion plan for the
[original K2 design](2026-10-01-managed-kubernetes-k2.md), not a replacement for
its registration, mount-provenance or original-publication contracts.

## 1. Objective and first supported case

K2 must let an orderly original worker finish its work, relinquish its CSI
publication, and hand the same registered volume to a new runtime generation
without losing results or permitting simultaneous writers. Kubernetes is the
runtime substrate. Alibaba Cloud ACK is one qualification environment, not a
required runtime API; worker ACK means a result acknowledgement and is unrelated
to the name of that cloud service. CSI drivers and deployment protection still
require individual qualification.

The first positive acceptance case is deliberately narrow: one registered RWOP
filesystem volume, one original bare Pod with restart policy Never, one original
Runtime Session and durable Session activation, and a new explicitly versioned
file-only capability profile. It supports `read_file`, `write_file`, and
`edit`, with fully retained inline results and uncompacted Session history.
These are the current shared `ToolNames` identifiers. No Shell, worker provider,
Hook, MCP, background execution, restore, object-backed history or omitted
result qualifies in this first case.
The new worker runs on the same healthy Node; different-node handoff is a later
qualification, not an inference from this test.

This restriction describes a new profile, provisionally named
`csi-files-retirement/1`. Existing full-profile workers must continue reporting
their lifecycle blockers. Never reinterpret an existing capability digest or
silently downgrade a caller's requested capabilities. A request requiring an
unsupported capability fails before creating a Pod or mounting storage.

Normal CSI handoff, K1 LOST recovery (F2), and full Shell/MCP/provider lifecycle
support are distinct deliverables. F2 is not a prerequisite for implementing
orderly K2 retirement; node loss or uncertain execution still blocks this path.

## 2. What the baseline implements

| Authority                           | Implemented                                                                                                                  | Missing for K2 completion                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Registration and physical ownership | Trusted aliases share one physical-key ownership row; reserve before CREATE                                                  | Monotonic ownership revisions across repeated release/reservation cycles      |
| Original Pod                        | Trusted API identity, protected objects, pinned mount observations                                                           | Qualified source of physical stop and original-target unpublish evidence      |
| Retirement                          | Atomic dispatch seal and original immutable intent; retain slot and holder                                                   | Complete work inventory, aggregate `DRAINED`, and atomic `RELEASED`           |
| Worker                              | Original-generation seal, status, result/cancel/ACK; conservative `QUIESCENT` observation                                    | Final mutation barrier tied to a durable aggregate cut                        |
| Publication                         | Pre-seal authorization, original result/receipt settlement, one-publication checkpoint check, persistent original-worker ACK | Complete publication membership and aggregate proof; ACK is not physical stop |
| File tools                          | v2 Broker result persisted; Hosted writes outcome and journal/checkpoint state                                               | A v2 file-result settlement verifier independent of publication receipts      |
| Public selection                    | Local-process Workspace path                                                                                                 | Explicit CSI profile, identity, resolver and transport wiring                 |

Two baseline details determine the design. First, existing ACK requires the
original Runtime Session to be `READY` and the durable Session's original writer
and activation to remain active and unexpired. Collect ACKs before releasing
either authority. Second, the current CSI store only accepts initial
`RELEASED` revision 0, `RESERVED` revision 1, and `DRAINING` revision 2; its
retirement reader only accepts `DRAINING`. Handoff requires changing those
validators and their consumers together.

Baseline file results do not use the deferred-v3 publication ACK path.
`hosted-workspace-tool-turn.ts` persists a converted function response and
`managed-tool-outcome`, then calls `resolveAwaitRuntime`. Large results may
instead become an `outputOmitted` response. Neither a successful return from
that call nor a publication verifier invoked with an empty publication proves
that a file result is covered by the newest checkpoint.

Historical cloud runs establish only the behavior of their recorded revisions.
The cloud report at
[d24d3f5b](https://github.com/QwenLM/qwen-code/pull/13289#issuecomment-5971605565)
does not establish full K2 acceptance for the merged commit or this proposal.

## 3. Authority and progress model

Keep `managed_workspace_execution_lease` as the sole physical ownership
authority, the existing binding/active slot as placement authority, and
`managed_workspace_csi_retirement` as the retirement journal. Preserve its
original `identity_json` bytes: saved ACKs bind its digest. Do not create a
second execution, publication, receipt or ACK ledger.

Add revisioned progress and bounded evidence references around that original
identity. The proposed retirement phases are:

| Phase      | Meaning                                                                                                                            | Storage may be reassigned? |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `DRAINING` | New admission sealed; original settlement may continue. An optional immutable application cut records completed durable settlement | No                         |
| `DRAINED`  | Application cut committed, original worker finalized, Runtime Session closed; all allowed work is durably accounted for            | No                         |
| `RELEASED` | Qualified original stop and unpublish evidence accepted, and original binding/slot/physical holder released in one transaction     | Yes, by a new reservation  |

`BLOCKED` is a reported condition with stable reason codes, not a fourth phase
or a reason to undo the seal. Worker `QUIESCENT` is an observation, not journal
`DRAINED`. A saved worker ACK, Pod phase, lease expiry, zero active count or
timer expiration authorizes none of these transitions by itself.

An aggregate manifest binds: retirement/registration/reservation identity and
revisions; binding/generation; original runtime/lease/Pod handle digest;
profile and capability digests; the complete sorted membership; each execution
version/result digest; each Session head, activation and newest checkpoint;
publication/receipt/resource identities and ACK digests where applicable; the
sealed worker invocation/history inventory digest; and the original worker
finalization response. Store canonical bounded bytes and their digest, not user-supplied flags such as `allSettled=true`.

Separate the immutable application cut from the later worker finalization
receipt, so it does not contain a circular digest. Finalization references the
cut digest; `DRAINED` references both. Physical evidence references this same
retirement and original creation identity. Every retry returns the first
committed evidence for that identity or fails on conflict.

## 4. Seal admission and establish complete membership

Extend the existing binding fence to the production admission paths for new
Runtime Sessions, executions, publications, activations, turns and lifecycle
configuration. A retirement can finish original continuations, but cannot admit
a new turn while those continuations settle. Worker admission must enforce the
same distinction at the final asynchronous mutation/start boundary.

The first profile pins one Session and the capability/provision identity at
CREATE. Its isolation is `session` with that exact Session identity. Java warm-up
starts before Harness opening but is not awaited; failed, disabled or asynchronous
warm-up does not guarantee an original binding exists. TypeScript tool-turn
warm-up occurs after the durable Session has opened. Do not require an activation
in the initial provision request, and do not treat binding absence as a LOCAL
Session. A new-profile Session without its original binding remains unstarted;
writer admission refuses explicitly until that authority is available.

Use two additive pins on existing authorities: immutable
`managed_agent_session.runtime_request_key` at new-profile CREATE, and once-only
`qwen_runtime_binding.first_activation_journal_revision` in the transaction that
accepts its first activation. Reuse the persisted versioned `tool_profile`.
Validate activation ID, epoch and writer against the original journal
transaction; a derived cache is not another authority. Genesis/first writer can
precede this pin, but execution authorization cannot. Under the same parent
admission lock, prove no earlier execution was authorized, including historical
terminal records. Reject any later replacement activation for this profile.

Resolve the exact CREATE request on the caller's original connection in the
order placement domain → sorted request slots → binding history → durable
Session/retention/head. Check ambiguity and orphan authorities rather than
choosing the first Session match or assuming the current active binding is the
original one. Read the persisted Session profile even when no binding exists.
Use current locking reads for admission-sensitive membership under both MySQL
read-committed and repeatable-read; a prior consistent read or an isolation-key
index does not supply the parent fence. Legacy profiles keep their existing
contract.

Extend the currently workspace-only private CSI adapter and its ACK transport
checks explicitly for the new identity; retain the old `workspace`/null contract.
The public resolver must later consume the same identity, not convert a local
path or infer a Session from the current request.

Enumerate independently, then join by full original identity:

1. All Runtime Sessions for the binding/generation, including released records.
2. All seven Broker execution states, across all Sessions, not just active work.
3. Original publications and their admission/receipt/resource/ACK records,
   including records with no matching execution.
4. Durable Session heads, activations, journal/checkpoint and file-history tails.
5. Worker pending preparations, invocation history and configured or used
   provider/Hook/MCP/Shell/publication lifecycle records.

An orphan, unexpected second Session/activation, conflicting join, unsupported
record, missing page or exceeded bound yields a blocker. Zero executions cannot
prove zero publications or zero lifecycle activity. A genuinely empty Session
needs its own native initial-state/journal validation; absence of a selected
publication is not that validation.

Reuse repository inventory boundaries, but extend the JDBC readers to one fresh
consistent snapshot. Existing per-page `findByBinding` reads are not a snapshot.
Use deterministic sorting and a complete-manifest digest. Initial fixed bounds
are at most 100 rows/page and 4,096 entries per collection, retaining the current
checkpoint verifier's 32 MiB decoded/48 MiB JSON bounds. Overflow blocks; do not
truncate, sample or automatically increase limits.

The writer audit includes Broker Session/execution findOrCreate, admit and
authorize, asynchronous acquire completion and ordinary release; Session Store
acquire/renew/seal/recovery/commit/publish; Managed Session turn, lifecycle and
cwd/configuration mutations; and retention retirement/collector claim/confirm.
Every new-profile mutation takes the appropriate parent guard before child locks.
Exact original retries and required pre-cut settlement remain available; neither
an internal repository seam nor the old profile's legal writer takeover is a
claimed HTTP bypass.

Membership is only closed when every production writer participates in the
parent fence. Name and test those writers, including direct repository
`findOrCreate` callers and durable Session/retention mutation paths. Before
persisting the cut, re-enumerate under the corresponding locks and compare the
complete membership and revisions. A hash of an incomplete scan is not a fence.

## 5. Prove application settlement

### 5.1 Execution classification

| Original record                                | Required treatment                                                                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PREPARED`, never authorized                   | Cancel through the original fenced path; prove no dispatch authorization and persist the original not-started outcome and covering journal state |
| `DISPATCHING`, `EXECUTING`, `CANCEL_REQUESTED` | Wait for or cancel original work; do not manufacture a terminal result                                                                           |
| `SETTLED`, supported v2 file tool              | Validate the file-result path below                                                                                                              |
| `SETTLED`, deferred-v3 publication             | Validate original publication, exact receipt, newest checkpoint and persistent original-worker ACK                                               |
| `UNKNOWN`, `ABANDONED`                         | Block normal retirement, including when no active execution is counted                                                                           |
| Other mode, missing or conflicting result      | Block; do not replay on a new worker                                                                                                             |

A v2 dispatch with a lost answer is not made recoverable by this design. Its
uncertainty remains a blocker. A generic cancellation status also does not prove
that execution never started.

### 5.2 v2 file-result proof

Add a dedicated verifier alongside the existing native receipt/checkpoint
verifier. Export a bounded original Session snapshot without requiring a
publication. Match the complete original Broker result, execution identity,
request digest and terminal status to the exact Hosted conversion into
`managed-tool-outcome` and `tool_result`. Reuse or extract that deterministic
conversion; do not independently approximate it in Java.

Replay the native journal through its captured head and prove that the newest
checkpoint consumed the original result and full tool batch, no later tool or
pending history/undo work is uncovered, and the expected file-history snapshot
was committed. Validate resource bytes, hashes, references and quarantine state.
SQL journal revision and event sequence are different coordinates. Preserve the
native turn-completion checkpoint rules, including legitimate companion events;
do not require a checkpoint to cover its own later commit event.

For the first profile, omitted, object-backed, compacted or unsupported results
block. Declared file-tool errors can settle when the full original error result
and effects/history are accounted for; an error is not automatically proof of
no side effects. v2 results do not require a fabricated publication ACK. The
empty ACK obligation is established by independent publication enumeration.

### 5.3 Publication and lifecycle obligations

For every supported deferred-v3 publication, reuse the existing original-only
settlement, exact committed `tool.receipt`, newest native checkpoint and durable
ACK contracts. `FINISHED`, `REFERENCED`, or Broker `SETTLED` alone is insufficient.
Complete all ACK calls while the original Runtime Session is `READY` and the
original durable writer/activation is live. An inspected old ACK is historical
evidence and cannot bypass fresh authority/resource validation.

Do not clear existing capture, publisher, provider, Hook, MCP or Shell blockers
because one publication has been acknowledged. Existing full-profile workers
remain ineligible until their own complete lifecycle inventories and final
settlement contracts qualify. In particular, a latest MCP `released` record
does not replace the earlier configuration/operation/drain history. M5c's
ordinary-host process-group work may supply future Shell evidence; it does not
prove Kubernetes container stop or CSI unpublish.

### 5.4 Application cut and worker finalization

Use the following order, without holding database locks during RPC or replay:

1. Commit original retirement/seal; seal the original worker; keep original
   result/cancel/settlement routes available and renew the original writer as
   needed. Do not create a replacement activation to complete an old ACK.
2. Enumerate, finish original results, commit checkpoints and collect all
   required ACKs. Obtain a candidate worker observation with no pending starts,
   invocations, history tails or lifecycle blockers.
3. Through a new CSI retirement-close operation in the original Harness, stop
   new Session mutations and activation renewal, await already admitted
   continuations/renewals, then commit the native `releaseActivation` boundary
   with the original writer still valid. Do not call generic close: it also
   seals the journal before the coordinator can commit the cut.
4. Re-export and semantically verify the original history, including exactly
   that terminal activation boundary and its resources. In a fresh bounded
   transaction, lock and revalidate membership, original writer, current heads,
   results and resources. Commit the immutable application cut and atomically
   seal the journal/revoke its writer authority, recording the resulting sealed
   head pins. Retention, writer acquisition, activation replacement and ordinary
   release must honor the retirement fence. Keep Runtime Session `READY` for
   worker finalization.
5. Call a new versioned `finalize` operation on the original worker with the cut
   digest. It atomically compares the sealed invocation/history inventory with
   the cut and checks the final mutation barrier, waits/refuses if original tails
   remain, and permanently refuses subsequent mutations. Only original
   read/status/result and exact finalization retry remain available.
6. Revalidate and persist the finalization receipt, close the original Runtime
   Session through a narrow CSI repository operation, and mark `DRAINED` in one
   transaction. Retain the binding slot, handle and physical holder. Local
   Harness disposal stops renewal and releases local resources without appending
   another activation boundary or changing the cut's journal head.

Step 3 is allowed only after all original settlement and required ACKs succeed.
Its terminal boundary must bind the exact previously settled prefix; no ordinary
work suffix or replacement activation is accepted. The new cut verifier handles
this boundary explicitly instead of claiming the older result checkpoint covers
a later activation event. A crash between the boundary and cut resumes only
with the original valid writer; expiry or an incomplete boundary blocks, without
new activation or repeated live ACK. After the cut, a crash/conflict remains
`DRAINING` with the same cut; resume original finalization, never reopen the
Session or roll back to another manifest. If the worker cannot confirm it,
report the blocker and retain ownership. New protocol fixtures must reject a
different cut, Pod, generation or profile. Existing boot-v3/`managed-csi/1`
workers cannot be upgraded in place into this contract.

From the terminal boundary onward, use a narrowly scoped historical validator.
Existing live ACK helpers require an ACTIVE durable Session, live activation and
READY Runtime Session; those requirements intentionally cease during closure.
Before the cut, require the original writer and exact original native boundary;
after it, require the committed cut and resulting sealed head. Verify unchanged
committed receipt/resource/ACK pins and current quarantine without reacquiring a
writer. The semantic verifier runs in the trusted coordinator's pinned bundle,
never accepts a worker-supplied `matched` flag, and its output is revalidated
against current locked authorities.

Integrate Session close/archive/delete/cwd-change through their existing durable
lifecycle operation identity. The generic `SessionLifecycleCoordinator` closes
the Harness and waits for its writer to exit before Workspace close; it cannot
be reused unchanged for CSI. Route CSI through the sequence above and finish
the existing lifecycle operation only after the required retirement stage. Do
not add a competing Session lifecycle ledger.

## 6. Establish physical evidence

### 6.1 Required source and deployment qualification

After `DRAINED`, request normal deletion of the exact original bare Pod using
UID preconditions. Persist the stop intent before the request. Do not use
force-delete, delete-by-name replacement, lease expiry or Pod disappearance as
proof. Kubernetes explicitly says API deletion can precede actual termination
in the [Pod lifecycle documentation](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/).

The preferred source is a deployment-owned, narrowly scoped node/CSI evidence
collector integrated with the original container runtime and CSI plugin. It
must observe from before Pod creation and durable successful publication through
termination and unpublish. A general node-management agent, privileged tool
worker, worker hostPath or worker CRI socket is outside this design. A socket
mounted read-only is not a read-only container-runtime API.

The collector is a new trusted integration requirement, not an implemented
capability or an authorization to install privileged cluster software. Its
deployment owner and maintainer must qualify the source, confinement and pinned
driver/runtime images before the physical phase ships. If no trustworthy source
is available, implement the aggregate phase and keep physical release closed.
Do not substitute the current diagnostic `KubernetesCsiLogReader`.

Use authenticated collector-to-coordinator transport and durable append-only
source records outside the retiring Pod and volume. Bind the source principal
and version, Node UID/boot identity, runtime task/sandbox identity, original Pod
UID/container/image identity, plugin Pod/container/image incarnation, original
publish target, registration/physical key and publication cursor. Signing only
authenticates the collector; qualification must establish the truth and
completeness of its observations.

### 6.2 Stop and unpublish contracts

`OriginalStopped` proves that the original container and its contained
descendants have terminated, cannot restart or spawn further writers under the
qualified bare-Pod contract, and match the pre-recorded runtime/cgroup identity.
A Node UID without boot identity or a reused PID is insufficient. The initial
profile excludes escaping processes, extra containers and unsupported admission
mutations. Node loss, reboot, runtime replacement or observation gaps block.

`OriginalUnpublished` proves a successful `NodeUnpublishVolume` for the exact
original `volume_id` and `target_path`, correlated with its earlier successful
`NodePublishVolume`, after original writer termination. The
[pinned CSI specification](https://github.com/container-storage-interface/spec/blob/e6fc13ea4d529db12e211ef79c924ee3186c39d5/spec.md)
defines this target-scoped and idempotent operation. An empty-target retry,
unrelated target, `NodeUnstageVolume`, detach, or absence of a VolumeAttachment
cannot independently supply the missing original publication chain. Staging and
attachment may remain for same-node reuse.

Persist evidence before source retention can remove it. Qualify causal ordering
from the runtime/plugin integration; wall-clock timestamps alone cannot order
independent sources. Reject source substitution, truncation, gaps, unknown
parser versions and unsupported restarts. Resume only a verified contiguous
original stream after coordinator restart; a collector/plugin restart blocks
the initial qualification. Kubernetes log API returns only the latest rotated
segment, per its [logging documentation](https://kubernetes.io/docs/concepts/cluster-administration/logging/),
so repeated API identity checks plus matching prefixes do not prove complete
incarnation-bound event history.

## 7. Atomic release, retry and migration

Perform semantic replay and external resource/source verification before SQL
commit. Preserve the current lock order:

1. Tenant placement domain → active slot → original binding.
2. Registration alias → shared physical holder → retirement.
3. Original Runtime Session → sorted executions.
4. Tenant quota/retention → sorted durable Session heads → publications.
5. Receipt/finish/journal/resource authorities → ACK and retirement evidence.

Keep the existing ten-second SQL timeout and recheck deadlines against fresh
database time after lock waits. A timeout rolls back; it is not evidence of a
free volume. No Kubernetes, worker RPC or object I/O runs inside this transaction.

The final transaction rechecks the committed cut, finalization, original stop
and unpublish records, all original identity/revision pins, and current resource
quarantine/protection status. It then marks the retirement `RELEASED`, makes the
original binding terminal, clears only its active slot, and releases only its
physical holder atomically on the same connection. Add a narrow repository
method; do not loosen generic sealed-binding CAS or call its independent
transaction from inside a Workspace release transaction.

Do not clear original identity from historical retirement/evidence records.
Ownership revisions increase on every transition: initial released 0 → reserved
1 → draining 2 → released 3 → next reserved 4, and so on. Store and compare the
actual original reservation/drain revisions; remove fixed 1/2 assumptions from
all readers, snapshot exporters and ACK consumers in the same change. There is
no need to introduce an unused ownership `ACTIVE` phase.

A new reservation uses a fresh reservation UUID, runtime generation and Pod;
it cannot inherit an old ACK or release receipt. Cross-tenant aliases continue
to serialize on the same physical key. Do not place a wait under SQL locks or
automatically choose a different storage profile when busy.

Lost release replies return the committed original release receipt even if the
volume now belongs to someone else. Historical lookup must not require current
`DRAINING` ownership, but it also cannot mutate a new holder or submit new ACKs
for a released retirement. Missing original handles and ambiguous CREATE remain
blocked; “no handle” is not proof that no mount existed.

Add migrations using the next free version at implementation time. Preserve
legacy LOCAL rows, existing CSI identity bytes and ACK digests. Never backfill
`DRAINED`, `RELEASED` or positive evidence. Do not enable the new profile until
all coordinator writers/readers support its schema and revisions; drain old
coordinators before enabling it. Existing full-profile retirements remain
closed unless their complete evidence meets an explicitly supported contract.

## 8. Public wiring, ownership and diagnostics

Public selection is the final stage. A reviewed operator registration selects
the qualified CSI profile and deployment. Tenant input supplies an authorized
Workspace/storage reference, never a raw PVC/driver/handle, endpoint or proof.
`ManagedAgentProperties`, `EmbeddedRuntimeBroker`, Workspace resolution and
Hosted profile guards must agree on session isolation and capability identity.
The Java server must not resolve the remote Workspace through its host's local
filesystem. Preserve local-process behavior and reject unsupported CSI without
falling back to a primary/local runtime.

Update the current LOCAL-only `WorkspaceExecutionStore`,
`WorkspaceStorageKindGuard` and transport claim/release paths with a distinct
CSI branch, not a weakened LOCAL check. Also carry the explicit profile through
`ManagedAgentStore`, `QwenHostedHarnessConnector`, Hosted Session create/load,
`HostedWorkspaceBroker.acquire` and tool-intent construction. File-only creation
must reject Hook catalogs as well as unsupported tool requests.

| Surface                                           | Ownership and enforcement                                                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator registration and collector qualification | Deployment/registration scoped; no ordinary Session privilege                                                                                               |
| Workspace selection and file execution            | Selected-runtime scoped; match registered storage, Session, profile and generation                                                                          |
| Results, checkpoint settlement and ACK            | Live authority for original settlement/ACK; historical validation after terminal boundary, with original writer before cut and pinned sealed head afterward |
| Retirement advance and release                    | Persisted original Workspace/binding generation; privileged coordinator derives all endpoints and pins                                                      |
| Worker seal/finalize                              | Exact original runtime/Pod generation; no caller-selected replacement worker                                                                                |
| Physical evidence ingestion                       | Qualified deployment source scoped; never a tool/runtime HTTP privilege                                                                                     |

Start with private service/offline coordinator operations; no new public admin
HTTP route is needed for aggregate qualification. Suggested operations are
inspect and bounded advance-by-retirement-ID. One advance resumes at most the
next safe transition; the scheduler may retry the original ID. Callers cannot
submit manifests, credentials, success flags or target URLs.

Report phase, evidence stage, blocker codes, bounded counts and retryability.
Distinguish `pending_original_work`, `unsupported_profile`,
`unresolved_checkpoint`, `original_authority_expired`, `source_gap`,
`physical_stop_unproven`, `unpublish_unproven` and `release_conflict`.
Logs/audit may retain protected identity digests and source cursors; ordinary
errors must not expose bearer tokens, storage handles or raw file results.

## 9. Implementation slices and affected files

| Slice | Deliverable                                                                                        | Exit criterion                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| K2-A1 | Bounded complete snapshot, execution classification and v2 file/native checkpoint verifier         | Reproduce current gaps; stale/incomplete/orphan evidence refused; no release path added             |
| K2-A2 | New closed file profile, original-Session admission fence, application cut and worker finalization | Original normal file work reaches aggregate `DRAINED`; every existing full-profile blocker retained |
| K2-B  | Qualified pre-CREATE physical collector integration and stop/unpublish receipts                    | Real original-source evidence survives coordinator restart; substitution/gap tests fail closed      |
| K2-C  | Monotonic ownership cycles and atomic release/new reservation                                      | Two independent coordinators safely hand off the same volume; crash/race matrix passes              |
| K2-D  | Public Spring/Hosted selection for the qualified profile                                           | Public file flow and errors use the selected CSI runtime; full integration acceptance passes        |

K2-A1 can start immediately using existing authorities and fixtures; it does not
depend on a new cloud experiment. K2-B source qualification can be investigated
alongside K2-A, but K2-C positive acceptance depends on both. Keep F2 separate;
retain K1's existing LOST/tenant placement guard until independently qualified.

Expected implementation areas; K2-A1 currently changes the snapshot store, private evidence entry, native verifiers and shared result conversion:

- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/`: extend
  `WorkspaceCsiReservationStore`, `WorkspaceCsiCheckpointSnapshotStore`,
  `WorkspaceCsiWorkerAckStore` and publication/resource authorities; add a small
  aggregate coordinator and additive migration/evidence representation.
- `packages/sdk-java/runtime-broker/src/main/java/com/alibaba/qwen/code/runtimebroker/`: binding/Session/execution
  repository snapshot and same-connection transition boundaries,
  `WorkspaceExecutionProfile`, and exact original stop intent handling.
- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/service/`: CSI provisioner,
  identity, resource guard, Workspace resolver/transport and embedded Broker;
  Spring configuration and Hosted connector/store profile validation.
- `packages/core/src/managed-runtime/`: native file-result/checkpoint proof and
  synchronized capability contracts; retain existing receipt verifier semantics.
- `packages/cli/src/serve/`: `managed-context-worker.ts`,
  `managed-runtime-tool-executor.ts`, CSI envelope/routes, Hosted Session/Broker/
  tool-turn admission and deterministic file outcome conversion; shared Java/TS
  fixtures must cover the new protocol rather than loosening old fixtures.
- Deployment qualification adapter: exact packaging and privilege review belong
  to K2-B. Do not insert cloud-specific CLI calls into the generic Broker.

Construct/register only the new profile's allowed worker tools and routes.
Restrict executor lookup too; changing the model's advertised tool list is
insufficient. Existing unconditional Shell, provider, Hook, MCP and publisher
construction must not create hidden lifecycle obligations in this profile.
The qualified file-history subset remains available: current `raw-file-history`
uses the provider control route before entering provider lifecycle code. Retain
or extract only the authenticated file-history actions needed for file tools,
with the existing post-seal snapshot-only restriction. Disabling provider
lifecycle must not remove Write/Edit's history dependency.
Reserve explicit new wire versions and digests for changed closed envelopes in
both languages; existing boot and profile parsers continue rejecting extra fields.

### 9.1 Local K2-A1 progress

The local prototype exports a bounded SQL/native application observation from one
fresh MySQL repeatable-read, read-only consistent snapshot. It includes released
RuntimeSessions, all seven execution states, independent publication children,
persistent ACKs and native Session/resource references. Missing Session history
is an explicit blocker. Native v2 file proof reuses the live Hosted response
conversion and requires the original intent, model call, outcome, tool-result
message, consumed checkpoint and settled file history. Object-backed or exotic
response parts remain unqualified.

The private Java entry supports `inventory <retirement>` and
`file-checkpoint <retirement> <execution>`. The private TypeScript evidence entry
recognizes both snapshot formats and the inventory format. Its inventory output
is `observed`, with a digest, counts, per-execution observations and blockers;
exit zero means the observation was parsed, not admission closure or successful
retirement. This prototype has no release mutation, no new public profile and no
physical collector. Pending worker starts and full lifecycle membership are not
attested by this SQL/native observation. Raw output contains retained tool/history
data and belongs in the operator's private evidence directory.

Focused native tests cover consumed and atomic turn-complete evidence, wrong
model/definition/result, pending history, all execution states, orphan membership
and inconsistent resources. The required real MySQL 8.4 test verifies 102 members
and the old SEALED head across a concurrent commit, followed by 103 members and
the new ACTIVE head in a fresh snapshot. An independent test-engineer reproduced
and verified the JDBC temporal-mapping correction. Native fixtures use real
Session/journal/checkpoint APIs but synthetic Broker results and file fingerprints.
The SQL concurrency fixture's journal is mapping data. A separate real MySQL
Java-to-TypeScript round-trip commits native journal bytes through the production
Session Store, exports the original Java JSON and replays it in the built private
evidence entry: one execution matches without blockers, and object/ref/checksum/
semantic-journal contradictions fail closed. This preserved round-trip is not a
CI contract that regenerates golden output on every run. These tests qualify
snapshot/proof components only; they do not exercise an actual worker file
operation or satisfy K2 cloud handoff acceptance.

## 10. Verification and acceptance

These are planned tests, not results. Before behavioral implementation, use
`test-engineer` and the repository E2E workflow to reproduce each baseline gap
and prepare executable cases. Run package-focused tests, Java contracts, root
build/typecheck and applicable bundle, then self-audit and independent review
against the actual proposed commit.

| Group              | Required observation                                                                                                                                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Admission races    | New Session/turn/activation/dispatch loses to the seal at every asynchronous boundary; original settlement still works                                                                                                                                 |
| Membership         | Multi-page all-state scans, orphan publications, second Session/activation and concurrent insert/update cannot produce false empty/complete evidence                                                                                                   |
| File settlement    | Actual read/write/edit and declared errors; exact native conversion, complete tool batch and newest checkpoint; omitted result, pending history, compaction and resource quarantine block                                                              |
| Publication ACK    | Every original publication checked; ACK before Session/writer release; replacement Pod, stale writer, altered receipt and historical-only ACK cannot qualify                                                                                           |
| Finalization       | Activation-boundary/cut crashes and in-flight renewals preserve the original prefix; pending starts and history races refuse finalize; crash after application cut resumes the identical cut; expired original authority never manufactures settlement |
| Database           | Real MySQL independent connections/processes; lock waits, deadline rechecks, rollback, restart, corruption and all release crash boundaries; no half-released slot or holder                                                                           |
| Physical source    | Real original cgroup/task stop and target unpublish; wrong target/UID/boot/image, rotation, dropped events, collector/plugin restart and node loss block                                                                                               |
| Handoff            | Exact old volume contents visible to the new worker; old worker cannot write; concurrent same-volume aliases have one winner; repeated reservation cycles work                                                                                         |
| Public selection   | Qualified CSI profile only; two different volumes proceed independently; same-volume Sessions serialize; no local or primary fallback                                                                                                                  |
| Regression/upgrade | Existing LOCAL, K1 scratch, full profiles, migrations, old ACK bytes and historical reads preserved; mixed versions cannot enable release                                                                                                              |

The integrated positive experiment uses an isolated registered disposable volume,
two independent coordinator processes and durable MySQL outside the retiring
worker. Pin the exact commit, bundle/image digest, migrations, cluster/runtime/
CSI versions, collector version and all original object identities. Exercise
coordinator restart before/after cut, finalization, stop receipt, unpublish
receipt and release commit. Show the new worker's contents and independently
establish old-writer exclusion; a successful new mount alone is insufficient.

Operate only test-owned objects. Keep the PVC/PV for handoff; delete them only
during final cleanup with saved-UID checks and verified reclamation. Record
cleanup and evidence gaps. CI, fixtures, H2-in-worker tests, ordinary log probes
or old cloud runs cannot stand in for this integrated acceptance. Public enablement
requires maintainer review and all K2-A through K2-D gates.

## 11. Decisions and remaining qualification

Decisions in this proposal: reuse existing authorities; separate v2 file proof
from publication ACK; freeze only after original settlement; distinguish
`DRAINED` from physical release; release atomically; begin with an explicitly
versioned narrow profile; defer public wiring and F2. No new general storage
framework, operator/CRD or automatic uncertain-work recovery is proposed.

Before K2-B, the deployment owner and maintainers must choose and qualify the
actual node/runtime/plugin evidence source and its least-privilege integration.
Before K2-D, maintainers must approve the public configuration/profile API and
supported deployment matrix. These are implementation gates, not claims that
the present ACK cluster or another CSI driver already meets them. Cross-node
handoff, broader history/resource formats and Shell/provider/Hook/MCP profiles
need separate acceptance after the first normal file-only handoff.

The immediate next implementation after K2-A1 verification is K2-A2: qualify the
closed file profile and original-Session mutation fence, then persist the
application cut and exact worker finalization. No release gate is relaxed.
