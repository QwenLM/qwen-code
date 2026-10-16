# Reliable deletion of ACTIVE Workspace Sessions (L3)

[English](workspace-session-active-delete-l3.md) | [简体中文](workspace-session-active-delete-l3.zh-CN.md)

## 1. Status and scope

Implemented locally on `codex/workspace-session-l3`, 2026-10-03. Linux physical
acceptance remains pending. This implements L3 of
[#13164](https://github.com/QwenLM/qwen-code/issues/13164), on main after
reliable close #13135, L1/L2 #13194, O4 retirement #13084 and H2 Hooks #13129.
It admits deletion of idle `hosted-workspace-files/1` Sessions through the
existing public and WebShell routes. Shell/MCP profiles, buttons, physical
erasure, new roles and abandoning unknown effects remain out of scope.

| Operation              | Lifecycle Hooks                | Result                                       |
| ---------------------- | ------------------------------ | -------------------------------------------- |
| ACTIVE close           | SessionEnd                     | CLOSED, retained data                        |
| ACTIVE delete          | SessionEnd, then SessionDelete | Reliable stop, atomic retirement and DELETED |
| CLOSED/ARCHIVED delete | None, including deferred Hooks | Existing L2 metadata deletion                |
| Detach                 | None                           | Attachment cleanup                           |

The current-readable creator remains the mutation authority. An accepted,
running, cancelling or approval-waiting Turn rejects admission with
`409 turn_active`. Idempotency, actor isolation and tombstone visibility retain
their L2 semantics. Once means reusing committed outcomes and never redispatching
an attempt that might have begun, not guaranteed eventual completion.

### Why close followed by L2 delete is insufficient

Reliable close settles SessionEnd and permanently stops the original Runtime.
L2 deletion of CLOSED/ARCHIVED Sessions intentionally runs no Hooks. Composing
those operations therefore cannot settle SessionDelete on the original Runtime
after End and before shutdown. Restoring a replacement worker to run Delete
would violate the no-replay boundary. L3 reuses reliable close's stop machinery
and L2's atomic retirement transaction, but settles both required events before
permanent draining. One delete operation remains DELETING throughout recovery;
it does not publish a separate successful CLOSE and later attempt an unrelated
L2 operation. The effects receipt lets successors skip committed Hook outcomes
without treating a missing Harness or an HTTP response as completion evidence.

## 2. Protocol and evidence

Add private `POST /session/:id/lifecycle`, carrying Session scope, operationId,
kind (`close` or `delete`) and claimGeneration. It settles only the required
Hooks and returns references to committed H2 records, retaining the attachment,
writer and owner until Java accepts those effects. Java validates authoritative
Session-store records; HTTP success alone is not proof.

Operations save a lifecycle protocol version and an intermediate effects receipt.
The receipt binds Session and operation identity to required event occurrences,
plans and committed result references, or verified no-Hook evidence. The public
receipt_id continues to be issued only by final completion.

The receipt is not a substitute for worker-stop evidence. Final completion checks
the permanent fence, writer exclusion, all original Runtime resources and
matching binding/generation/handle stop proofs. RELEASED alone is insufficient;
historical bindings without verifiable stop or never-started evidence block.

The public routes and 202 operation responses remain unchanged. Advertise
session_delete/sessionDelete for supported ACTIVE files Sessions independently
of archive/unarchive. Capability denotes support, not authorization or idle
state. Keep the aggregate session_lifecycle unchanged.

## 3. Execution and recovery

Admission saves CLOSING/DELETING and a durable LIFECYCLE_ONLY fence together.
Ordinary warm, acquire, tool execution, input and other control mutations are
excluded. Only the current operation and live claim may obtain lifecycle writer
and execution authority in the original Workspace scope. This authority still
requires private authentication and current execution authorization. Use the
existing lock hierarchy to prevent authorization/admission races.

The placement guard precedes retention, Session and journal locks. Checking only
the journal head or a missing fence row cannot exclude concurrent fence
insertion; writer mutations and ordinary execution authorization must share
admission's lock order. A tool-result receipt takes the placement guard before
its original-result, publication tenant and journal locks, including receipt
replay; its nested journal commit must not acquire placement in reverse order.
Offline storage migration, including an ABORTED operation replay, follows the
same placement-before-retention order as cleanup authorization for another
Session in the tenant. This does not relax the stopped-writer/no-new-dispatch
migration prerequisite.
An ordinary journal transaction definitively refused with
`workspace_lifecycle_admission_closed` before any uncertain commit response
does not stop the cached Session's writes; current lifecycle authority is still
required for subsequent settlement. An uncertain earlier response retains the
write-failure fence.
The pre-L3 Store already obtains the publication tenant
lock through its Session lock helper. L3 adds the placement guard and ordinary
authorization request, so its incremental contention and request cost require
measurement. Drain lookups and mutations use the existing hashed primary key,
with original identity checks, so their locking reads do not scan other tenants'
fences. The key encoding is shared with the Broker; no new index is required.
This protects persisted Session admission on every hosted
attachment, including one without local lifecycle state; it does not grant
every Session L3 delete support. A definite Store lifecycle-fence rejection
returns 409. Unexpected Store, transport or writer-authority failures return
503 and admit no execution. Authenticated cancellation of an admitted Turn is a
local abort and does not require ordinary Store authorization; the local
lifecycle fence still excludes cancellation. Protocol-zero close retains its
scoped exception. Ordinary attachment mutations validate client identity before
Store authorization or writer renewal; the legacy close control route retains
its explicit missing-client exception. Lifecycle claims use database millisecond
time and keep their non-retryable 409 through the Broker boundary. A DELETE
classified before a concurrent CLOSE completes is reclassified under the locked
Session state, preserving CLOSED/ARCHIVED deletion as L2.

Settle earlier operations, excluding this operation's lifecycle occurrences from
generic cancellation. Stable occurrence IDs derive from Session, operation and
event. Reuse H2 catalog, plan, dispatch intent and results. SessionDelete starts
only after SessionEnd's children have committed their outcomes, including async
Hooks; a settled plan marker alone is insufficient. Cold load restores saved state without a user
Turn or startup Hook. Reuse a verifiable original Runtime; a replacement
generation never replays effects. First initialization is permitted only when
no Runtime has ever been created and authorization is valid.
Plan identities use fixed compact JSON bytes, independent of application JSON
formatting. Recovery rejects pending, failed or cancelled local Session routes
without waiting for ordinary acquisition or propagating its outcome.

A successor lifecycle load may adopt an existing idle files attachment only
after its normalized Store descriptor matches the original grant and the Store
accepts the current claim on the original writer. It returns the original client
identity without reopening the Session or replaying Hooks. Busy, foreign and
refused claims retain the attachment and its previous authority. Client identity
is checked before disclosing the local lifecycle fence, preserving the explicit
legacy close exception. Cancelling a never-dispatched original execution may
settle its durable cancellation through a drain fence without invoking the worker;
new dispatch remains excluded. Typed transactional claim refusals retain their
409 code and roll back all journal mutations. Confirmed lifecycle detach removes
only the captured attachment and prompt state; a late response cannot clear a
replacement's heartbeat or prompt watermark.

Before a new lifecycle Hook leaves intent, restore its saved original Broker
owner by binding and generation. A surviving Harness attachment cannot infer
that a restarted Broker still has that owner. Failed attestation leaves the
child intent retryable without dispatch; current authority is checked again
before dispatch. Already unknown outcomes remain blocked and are not replayed.

Before each new side-effect dispatch, check current ACL, mount and identity.
After revocation, lookup and settlement of already dispatched work continue;
undispatched Hooks stay recovery_blocked until authority returns. Unknown effects
retain ownership and do not become cancellation or completion proofs. This
inherits H2's potentially indefinite blocking, tracked separately in #13133.

Precheck authority before both plan and child dispatch, and recheck inside the
journal commit transaction. A definite transactional authorization refusal leaves
the writer authority retryable without consuming journal sequences. A missing
response, or a refusal after an uncertain request, retains the write failure fence.
The guard checks every Hook revision, including multiple revisions in one commit:
leaving intent for a possibly started outcome requires authorization, while
not_started_proven and original dispatched-result settlement remain available.
Lifecycle settlement cannot change an already recorded Runtime identity.

After validating and saving the effects receipt, upgrade the fence monotonically
to DRAINING. Detach without Hooks, release owners, seal the writer, then use the
reliable-close drain/stop protocol. A successor skips Hooks when the effects
receipt is saved, otherwise reconstructs progress from the same H2 occurrences.
Harness 404, lease expiry and worker disappearance cannot establish completion.
A confirmed same-boot detach 404 stops the SDK attachment heartbeat; refusals and
ambiguous responses retain it. Receipt recovery selects the exact occurrence and
resource through their existing primary keys, preserving raw identity and byte
validation without scanning other tenants or looping over historical candidates.

Receipt recovery may skip the Harness lifecycle request entirely. Detach must
therefore validate its operation authority against Session Store even when the
live attachment has no local lifecycle state. Store authorization checks the
current claim, original writer, saved effects and DRAINING fence; a rejected
claim leaves the attachment and its prior authority intact. A successor without
a cached attachment addresses the original Session ID with its current claim;
it does not load a Runtime or dispatch Hooks to recover a client ID. Missing
authority still requires the original client ID, and a supplied wrong client ID
is rejected. Cleanup authorization accepts only the same writer identity, token
and generation, including an expired or already sealed writer; it does not renew
that writer. Hook dispatch still requires an active, unexpired writer. Ordinary
detach still requires ordinary execution authorization.

After that cleanup authorization, stop activation renewal and seal the original
writer without appending an activation release record. Expired or sealed writers
cannot append, and an already-started renewal remains constrained by the Store
fence and writer seal. The historical activation may still read as active; it is
not evidence of a normal release. Completion relies on the permanent fence,
effects receipt, writer seal and original Runtime stop proofs. Ordinary and
legacy close continue to record activation release before sealing.

Final completion requires the live delivery claim, effects receipt, permanent
fence, no live writer or unsettled execution, and verifiable original stop
proofs. CLOSE commits CLOSED. DELETE commits O4 retirement, DELETED, operation
completion and the terminal event atomically. Shared files and other Sessions'
holders remain intact.

For a never-initialized Session, acquire the tenant-retention, public Session and
journal-head exclusion in writer order, and prove no completed bootstrap, live
writer, journal or Hook dispatch records. Save never-initialized no-Hook evidence.
With a header, inspect the original definition/catalog instead. Either case
still checks the complete Runtime binding set after the permanent fence.

Admission scans and JSON-parses the complete journal to prove there are no
accepted, unsettled Turns. Its cost grows with retained history while the
transaction holds its locks; bounded admission latency is not established.
The current product initializes the compaction watermark to zero and has no
production path that advances it. Existing cold recovery also rejects nonzero
watermarks; L3 rejects them with `workspace_lifecycle_journal_unverified`.
Future compaction requires durable idle-state evidence before L3 can
accept those Sessions; this PR does not implement compaction recovery.

## 4. Compatibility and rollout

Add lifecycle migration V51 after the existing V35 tool-profile, V36–V39
journal/query, V40 creator, V41–V44 CSI/dispatch, V45 H3 task-journal, V46
W2 directory-change, V47 H5 channel route/delivery and V48–V50 W1c storage
migration/index/identity migrations; preserve those migrations and V32. The
unmerged lifecycle SQL is unchanged when its version moves from V48 to V51.
Main's `/2` search profiles coexist with L3, but lifecycle
admission still requires `hosted-workspace-files/1`. H5 channel contracts and
persistence do not enable channel execution or lifecycle effects. Keep W2's
directory/revision operation fields alongside the lifecycle protocol field.
Its read-only probe and settlement remain separate from lifecycle Hook effects,
drain and detach; the Session-row admission barrier serializes the operations.
Runtime resolution retains the lifecycle claim on its actual resolved scope.
W2 admission and commit take placement first and refuse `session_context_busy`
while any same-tenant/Harness Runtime Session lacks confirmed RELEASED state.
Hook owners can outlive a completed Turn; their immutable original context must
remain available for L3 effects and release. Neighbor holders are unaffected,
and no replacement Runtime or context reinstall is introduced. The existence
read adds scan cost without a fixed latency guarantee.
This integration preserves
H3 background Shell/Monitor behavior and does not add lifecycle support for
CSI, Shell or MCP profiles. The shared Harness closes its Monitor wake
scheduler only after detach authorization succeeds, so a refused detach leaves
the live Session and its scheduler intact. The synchronous closing/busy fence
still prevents a wake from starting while authorization is pending.
G3 generation adoption also covers lifecycle settlement and detach. A call
that discovers a new Harness generation invalidates the stale client and
attachment and still returns the generation error. The existing delivery retry
renegotiates with the same operation and current claim; it does not redispatch
within the discovering call, enable ordinary recovery or cancellation takeover,
replace the original Runtime, or clear an unknown outcome. The new Harness boot
is not stop evidence for the original Runtime; effects receipts, writer seals
and original-handle stop proofs remain required.
Historical admitted operations retain their original protocol and evidence,
without new Hook identities.
Operation reads before the lifecycle migration treat an absent protocol column
as legacy protocol-zero; a present protocol-one value remains unchanged.
This projection compatibility does not grant execution or bypass schema upgrades.
Live protocol-zero close attachments retain their legacy DELETE and original
Hook control path only while their persisted close claim is valid. Ordinary
execution remains fenced; the exception cannot authorize L3 or MCP execution.
Legacy claim validity compares database epoch milliseconds on both sides,
independent of JVM, JDBC and database session time zones.
Upgrade every Spring coordinator/Store first, then the Hosted Harnesses. There
is no separate L3 enable switch. A new Harness against an old Store lacking
ordinary execution authorization refuses all hosted Turns, including private
Sessions; it must not treat a missing authorization route as permission.
During the Store-first mixed-version interval, ordinary Turns remain available,
but ACTIVE Workspace close and delete are unavailable until the Harnesses
advertise the new lifecycle capability. Schedule this temporary loss of close
availability as part of the rollout. A missing protocol capability rejects
admission rather than falling back to legacy DELETE. Do not
roll back to old coordinators while L3 operations remain unfinished. L2
CLOSED/ARCHIVED deletion remains independent of Harness availability.

The configured Store writer-credential policy applies before lifecycle or
ordinary writer state is read. Lifecycle loads carry the provisioned credential
and transport policy unchanged. Cleanup still requires the original writer and
current claim; an expired or SEALED cleanup grant does not bypass credential
validation. A credential-policy change may leave recovery blocked and cannot
justify a replacement writer or Runtime.

Implementation order: protocol and fences; scoped authority and receipts;
close semantics; ACTIVE delete admission and capability; recovery validation.
Synchronize canonical OpenAPI and related bilingual designs.

## 5. Validation and acceptance

Cover both HTTP surfaces, replay/actor isolation, every active Turn state, empty
Sessions, absent catalogs and empty Hook plans. Assert close End=1/Delete=0,
ACTIVE delete End=1/Delete=1, and detach/L2 Hook=0. Inject lost replies and crashes
around dispatch, result commit, receipt, detach, stop and tombstone. A second
server must resume without duplicate effects; stale claims cannot advance.

Exercise ACL/mount revocation between Hooks, restoration, unknown effects,
unverifiable identity, historical missing stop proof, and ordinary admission
races. Real MySQL checks transaction rollback and concurrency. Real Linux checks
Harness/workers, host/boot/PID identity, retained shared files and neighbor
holders. Simulation is reported separately from physical validation.

Run build, typecheck, bundle, focused TS/Java tests and the E2E plan, then two
clean self-audit passes and independent review. Results and environment limits
are recorded in `.qwen/e2e-tests/workspace-session-active-delete-l3.md`.
