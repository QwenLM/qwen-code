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
admission's lock order. The pre-L3 Store already obtains the publication tenant
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
scoped exception.

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

Before each new side-effect dispatch, check current ACL, mount and identity.
After revocation, lookup and settlement of already dispatched work continue;
undispatched Hooks stay recovery_blocked until authority returns. Unknown effects
retain ownership and do not become cancellation or completion proofs. This
inherits H2's potentially indefinite blocking, tracked separately in #13133.

Precheck authority before both plan and child dispatch, and recheck inside the
journal commit transaction. A definite transactional authorization refusal leaves
the writer authority retryable without consuming journal sequences. A missing
response, or a refusal after an uncertain request, retains the write failure fence.

After validating and saving the effects receipt, upgrade the fence monotonically
to DRAINING. Detach without Hooks, release owners, seal the writer, then use the
reliable-close drain/stop protocol. A successor skips Hooks when the effects
receipt is saved, otherwise reconstructs progress from the same H2 occurrences.
Harness 404, lease expiry and worker disappearance cannot establish completion.

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

Add lifecycle migration V40 after the existing V35 tool-profile and V36–V39
journal/query migrations; preserve those migrations and V32. Historical admitted operations retain their
original protocol and evidence, without new Hook identities.
Live protocol-zero close attachments retain their legacy DELETE and original
Hook control path only while their persisted close claim is valid. Ordinary
execution remains fenced; the exception cannot authorize L3 or MCP execution.
Legacy claim validity compares database epoch milliseconds on both sides,
independent of JVM, JDBC and database session time zones.
Upgrade all
coordinators and Harnesses before enabling new L3 admission. A missing protocol
capability rejects admission rather than falling back to legacy DELETE. Do not
roll back to old coordinators while L3 operations remain unfinished. L2
CLOSED/ARCHIVED deletion remains independent of Harness availability.

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
