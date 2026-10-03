# Managed Hooks runtime (H2)

[English](2026-09-30-managed-hooks-runtime.md) | [简体中文](2026-09-30-managed-hooks-runtime.zh-CN.md)

Status: implemented and locally validated; Linux cgroup execution validation
remains pending. This implements H2 of [#12827](https://github.com/QwenLM/qwen-code/issues/12827), following H1.
The references are section 5 of the
[extension runtime design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-extension-runtime.md)
and section 6 of the
[configuration design](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-config-extensions.md).

## Problem and scope

Hosted Sessions disable ambient Hooks. Legacy runners keep local processes,
callbacks and once state in memory, which cannot prove what happened after a
Harness replacement. H2 commits plans and execution identities before effects,
then reconciles the original owner after uncertainty. An after Hook failure
must not change a successful tool's receipt.

The implementation extends the existing private Hosted Workspace profiles and
adds the public read-only Hook catalog. Production AgentBundle enablement remains
separate, as in H1. It does not enable unrelated H3/H4 capabilities or start a
second main Agent loop. The native Hook dispatcher accepts every existing event;
producer availability continues to follow the selected profile.

## Records and planning

`hook_registration` pins a deployment catalog and immutable resource.
`hook_execution` records occurrence, ordinal, registration, plan, effective input,
original Runtime Session, cancellation intent, physical state and result reference.
Both use the existing `ExtensionRun` validator and `domain.committed` journal.
They do not create user task entries. TypeScript and Java consume shared positive
and negative fixtures and enforce resource closure, stable pins, unique ordinals,
and atomic consumption of once keys at intent.

These checks must not grow with a Session's Hook history. The once key, the
occurrence and ordinal, and the catalog pin never change across a record's
revisions, so the Session Store projects them into indexed columns when a record
first commits. Unique indexes on (Session, once key) and (Session, occurrence,
ordinal) refuse duplicates, including concurrent ones. The occurrence binding and
the catalog digest are compared with one committed record of the same key,
because admission keeps every record under a key in agreement. The Session
authority keeps the same keys in memory, so a reopened log replays its records in
linear time. Admission therefore no longer re-reads earlier records, and no
longer notices on each admission that one of them was damaged; every record and
its resource closure are verified when the Session is restored.

Each occurrence fixes its catalog and plan. Occurrences are admitted serially
within a Session so concurrent events cannot reserve the same once Hook; execution
inside each plan retains native parallel/sequential behavior. Repeated IDs with different semantic
input are rejected. Sequential execution persists each effective input and reuses
native prompt-context and tool-input accumulation. Parallel results aggregate in
plan order. Fail-open/fail-closed policy is applied before saving the result, also
when status reconciliation supplies the receipt. Failed or unknown once attempts
do not become eligible again.

With a ready catalog and no pending recovery, cancellation before a new occurrence
still saves its plan and cancelled result, without dispatching a child Hook or
consuming its once key. PreToolUse can then durably refuse every committed
assistant tool call, including later calls in the same batch, before the turn
ends as cancelled. An unknown prior effect or a failed journal write still blocks
this continuation.

Catalog replacement is an idempotent registration operation with an expected
registration count. Revisions increase within each catalog namespace. Retrying an
older operation acknowledges it without restoring an older effective catalog.
Removing a Hook from a new revision affects future occurrences only. Deployed
Session/agent entries carry explicit owner metadata; filtering precedes native
configuration deduplication so one agent cannot inherit another agent's handlers.

## Runtime ownership

Set `QWEN_MANAGED_HOOK_CONFIG` on the Tool Runtime process to a deployment-owned
JSON manifest. Its version is `1`; each catalog has `tenantId`, `workspaceId`,
`catalogId`, `catalogRevision`, a 64-character hexadecimal `definitionDigest`, and
`hooks`. Each Hook specifies its ID, event, matcher, execution policy and recipe.
Command/HTTP recipes and trusted function module paths stay at the Runtime;
the Harness receives planning metadata and prompt definitions. Function modules
export a versioned object with `callback` and optional `onHookSuccess`.
Unavailable handlers block accurately instead of evaluating serialized closures.
Function context uses the live Session history, with a durable snapshot for replay.
Only matching function plans store messages; large snapshots use immutable
60 KiB parts. The full control envelope is bounded at 8 MiB and checked before
network dispatch, without truncating messages or inventing an unknown outcome.
Snapshots, plans and reference metadata also share the Session Store’s existing
8 MiB transaction budget. Snapshot admission reserves 256 KiB for the plan, input,
chunk manifest and record closure; oversized snapshots become bounded stops before
publication. The commit includes the entire snapshot reference
closure; the Store rejects a missing manifest or part atomically.

The manifest is an explicit deployment catalog. It does not import the Harness
host's ambient user/project settings or arbitrary client callbacks. Source
metadata is sorted using the native registry; Session registrations retain their
native append behavior. Migrating Legacy settings into a deployment catalog must
preserve its already-resolved user/project merged fallback and trust decisions.

All worker Hook routes are **live-session-owner scoped**. Broker forwarding
validates tenant, workspace and Session, resolves the saved Runtime, and checks
workspace generation and the operation grant before new effects. Status and
cancel only inspect the original execution. Missing or replaced owners remain
unknown; no status request dispatches a replacement effect.
A Hook owner ID is fixed at construction from the already durable activation ID
and epoch. A new load installs a new activation, so it never reuses a released
Runtime Session ID. Recovery can therefore find even an owner acquired only for
a catalog request before the first Hook execution record. Earlier random owner
IDs remain recoverable through execution records; an old random owner with no
durable execution record requires operator recovery.
Only load activations name owners. Each lifecycle Hook operation installs a
`hook_operation` activation, and when it finishes it installs a restore
activation whose ID is derived from the activation the operation replaced. The
log always holds that activation, so the restore is recognized even when the
`hook_operation` activation failed to install. The restore keeps the default
activation subject, so the record format is unchanged, and the log refuses an
activation ID it already holds, so a derived ID cannot replay an earlier
install. Neither constructs a Hook session, so release skips both and its cost
does not grow with the number of Hook operations. A load always installs a
random activation ID, so it remains an owner even after a Hook operation that
failed or was never restored.
Parallel Hook executions in one Hook session share one acquisition, so they
make one release pass between them. A later load releases the earlier load
owners again; release is idempotent, so the repeat costs only a Broker round
trip. A restore recorded before restore IDs were derived is released like a
load, and the Broker answers that release with 404. A log written before this
change therefore still costs each later load one release per earlier Hook
operation.
Before a replacement Hook owner acquires the Workspace, it releases earlier
owners whose Hook records are all terminal, including owners reconciled through
status. Tool-result continuation uses the same acquisition path. Broker checks
still reject release while shared physical work is active. Only an explicit
`runtime_session_not_found` is accepted as an already absent owner. Detach also
releases settled earlier owners. An attached idle owner retains the Workspace
lease, as MCP does; changing that lifetime is a separate design task.

Commands reuse native output, timeout and TERM/KILL handling. Managed execution
requires Linux cgroup v2 delegation: set `QWEN_MANAGED_HOOK_CGROUP_ROOT` to a
writable domain with `cgroup.kill`. A clean launcher enters a fresh unit before
starting the command. Membership survives `setsid` and detached descendants;
completion requires `cgroup.events` to report no remaining processes. A background
descendant that outlives the command keeps the unit nonempty, so a command that
has already printed its output and exited still settles as `timeout` when its
Hook timeout expires; the unit is then killed and the output is not applied. Hook
commands must not leave background processes behind. Cancellation
sends TERM, then uses `cgroup.kill` if needed, and retains the owner when emptiness
cannot be proved. This is lifecycle isolation for deployment-owned trusted Hooks,
not a sandbox against scripts deliberately modifying the cgroup control plane.

Missing isolation, including macOS and Windows, returns
`managed_hook_command_isolation_unavailable` before command execution. The ledger
records `not_started_proven` with `handler_unavailable`, and cancellation can close
the blocked occurrence. For SessionStart, UserPromptSubmit and native
InstructionsLoaded before model execution, explicit cancellation
also settles the admitted turn identified by the Hook's durable input `prompt_id`
when no model attempt, tool intent/receipt or non-user message has followed
admission, and no Hook remains pending. An earlier SessionStart cancellation cannot
settle a later turn. For a refused PreToolUse child explicitly cancelled with
`not_started_proven`, recovery may also close the first committed tool-call batch:
all model attempts must have ended, at least one has committed output, no tool
intent/receipt, pending approval, file-history work or Hook may remain, and the
cancelled child's occurrence and input must match an original call in the sole
unsettled turn. Recovery persists a matching refusal for every missing call before
settling the turn as cancelled. Responses are split by the actual UTF-8 size of
each complete record, including metadata, to respect the 64 KiB inline limit;
each successful record becomes the parent of the next. A response that cannot
fit alone retains the recovery barrier without truncating its identity.
New batches check each cancellation response before committing the assistant
message, rejecting oversized calls before tool acquisition or dispatch.
Already committed responses are preserved across partial batches; failed
writes retain the barrier and retries do not duplicate them. This recovery is
serialized with turn and control admission and also runs on load for previously
cancelled records. Other model/tool continuations stay blocked. A process group
alone is never accepted as proof.
Environment inheritance is restricted to execution necessities and explicit
recipe entries. Async admission waits for the Runtime acknowledgement; it is not
a completion receipt. Normal acknowledged async work may coexist with later
turns; unknown work blocks new admission and retains its Runtime hold.

For a cancelled or timed-out trusted function Hook, Runtime waits up to one second
for its actual callback Promise to settle before issuing a terminal failure receipt.
A callback that never started is also safe to settle. Callback resolution or
rejection is completion evidence; an abort signal alone is not. A callback still
pending after the grace period keeps its unknown outcome and original Runtime
hold, with no replay. Native Legacy function-Hook cancellation remains unchanged.

Workspace Write/Edit backups and explicit rewind share the Session's Hook Runtime
owner, while snapshots retain the actual prompt identity. Acknowledged async Hooks
may coexist with history bind, prepare and snapshot; rewind and owner release still
require all Hook executions to settle. Rewind also excludes Hook catalog/model
operations and inactive activations. On cold load, pending file history is observed
through the original Runtime owner saved in the matching checkpoint tool inputs,
before earlier Hook owners are released. Missing or conflicting owner evidence
keeps recovery blocked; no new durable field is needed.
Shell receipt recovery also reads the original Runtime owner from its committed
tool input when acknowledging capture delivery; neither the prompt ID nor the
replacement Hook owner identifies that execution.

HTTP uses native URL/DNS, credential-variable and timeout policy. Redirects are
refused. The Runtime URL allowlist uses the same allowed-variable interpolation
as the HTTP runner; internal secrets and native SSRF checks remain enforced.
A local runner-construction failure before dispatch is a settled failure
under the saved fail policy. A received failure response can settle; a lost response after sending
remains unknown and cannot be retried automatically. Hook outputs are bounded.
For an in-flight managed HTTP Hook, user cancellation keeps the original request
and body read alive until the configured HTTP timeout so a complete response can
provide settlement evidence. The occurrence still ends as cancelled. Cancellation
before dispatch sends no request. Runtime shutdown aborts the transport immediately;
shutdown, timeout and disconnected or partial responses after dispatch remain
unknown. Native HTTP cancellation keeps its existing immediate-abort behavior.
Individual receipts and aggregate outputs use a 60 KiB bound. An oversized
initial plan (including event input, descriptors and snapshot references) saves a
bounded blocking receipt and a digest of the original semantic input. Recovery
returns that refusal without dispatch or once consumption, including when no
handlers matched; changed input for the same occurrence remains a conflict.
An oversized
individual receipt becomes a bounded failure under its saved fail-open/fail-closed
policy. An oversized aggregate or next sequential input instead stops the
occurrence with a durable blocking result, preserving completed child receipts;
later undispatched Hooks do not consume once keys. Recovery derives the same
result from the saved receipts without repeating effects.
Combined tool Hook context is checked against the existing history record limit;
if it cannot fit, orchestration stops with the original tool and Hook receipts
preserved, without writing or retrying an oversized history record.
Runtime concurrency is limited to 16 active operations and catalogs to 128 Hooks.
Concurrency refusals retain bounded failure receipts under the saved fail policy.
Runtime keeps at most 4096 operation receipts, including these refusals, without
eviction or replay. Once full, it returns an explicit blocking receipt before
installing grants, including a PermissionRequest deny regardless of fail policy;
the Harness persists that outcome. An immediate settled refusal is returned
before asynchronous admission can report success. This permanent capacity limit is distinct from
the temporary concurrency refusal. Capacity reclamation needs a durable
acknowledgement protocol and is deferred;
an unrecorded refusal whose response is lost remains unknown on lookup.

H2 explicitly accepts an unbounded availability loss for a genuine unknown.
An unknown SessionEnd or SessionDelete prevents DELETE from completing: it returns
503 and retains the attached Session and original Workspace owner. Retries observe
the same saved occurrence; they do not redispatch it. Detach also requires all
Hook effects to settle. The retained owner can block tools in other Sessions in
that Workspace; it does not block a different Workspace's Runtime worker.
Unknown operations count toward the worker's 16-operation admission limit and
retain their holds for its lifetime. All saved receipts, including settled ones,
count toward the 4096 lifetime limit. Neither timeout, user cancellation, DELETE
nor process replacement proves completion or permits replay. H2 provides no
administrative abandonment route; receipt reconciliation or durable fenced
reclamation is tracked in [#13133](https://github.com/QwenLM/qwen-code/issues/13133).
This is an accepted recovery limitation, not a bounded recovery or availability
guarantee, and does not declare the original review findings resolved.

## Model activation

Only the Harness runs prompt Hooks. In-turn Hooks use the turn's exclusive model
scope. Notification, expansion and closing events can acquire a `hook_operation`
activation without creating a user turn, task completion, tool loop or startup
Hook. Both subjects use the Session's monotonically increasing activation epoch.
The scope remains held until the provider call actually settles, even if the
provider ignores timeout cancellation. If installing a Hook activation fails after
release, the controller still restores the Session activation. If restoration
also fails, new prompts are rejected before admission until activation recovery.
HTTP journal commits retry a transient transport failure, 429 or 5xx response up
to three attempts, 250 ms apart, using the identical transaction identity, record
bytes, resources and writer scope. A replay must return the matching original
receipt before local authority advances. Permanent rejection, a mismatched
receipt or exhausted retries still stops writes and requires journal recovery;
no failure clears the write fence or installs a different speculative activation.

Model attempts and usage are associated with the original Hook operation and
originating turn when present. Budget accounting follows the existing Session
and turn budget semantics; Hook operations must not reset the original budget.
There is no new monetary-budget policy or independent Hook token pool.
Isolated model Config cleanup failures are logged separately and do not replace
an already returned Hook result or the primary operation error.

## Event integration

| Events                                                      | Producer and ordering                                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionStart, UserPromptSubmit                              | Hosted startup occurs once; original submit and effective model input remain distinct. A blocking before Hook prevents the model request.                                                                                         |
| UserPromptExpansion, Notification                           | Authenticated private operation route with stable caller occurrence. Expansion output is returned to its caller for submission.                                                                                                   |
| PermissionRequest, PreToolUse                               | Permission comes first. Modified arguments are validated again and require a new Action when the policy asks. No physical after event is fabricated for a refused call.                                                           |
| PostToolUse, PostToolUseFailure, PostToolBatch              | Native receipts are committed first. Physical success/error/cancel selects the event; batch waits for all results. Recovery adds Hook context without repeating tools or history.                                                 |
| MessageDisplay, Stop, StopFailure                           | Final display has its own stable occurrence; suppression affects returned parts. Stop may continue inference. Actual model API failure emits StopFailure.                                                                         |
| InstructionsLoaded, PreCompact, PostCompact                 | Existing native producers delegate to the durable dispatcher. Initial instruction events wait for model authentication; Hook recovery errors propagate through compaction.                                                        |
| PermissionDenied, SubagentStart/Stop, TodoCreated/Completed | The complete native event bridge preserves producer payloads, owner identities and Todo phases. These are emitted when their native capability runs; Hosted file/shell/MCP profiles do not fabricate AUTO, child or Todo actions. |
| SessionEnd, SessionDelete                                   | Explicit deletion drains prior operations, runs lifecycle Hooks, then releases Runtime/provider/writer ownership. Detach emits neither event.                                                                                     |

The dispatcher avoids loading or executing ambient Legacy Hooks in a Managed
Config. Explicit Hosted producers are excluded from duplicate native emission.
A reconstructed activation is not a new startup or user resume. Stop occurrences
use durable model attempt IDs. Only a blocking Stop activates the continuation
flag; an ordinary tool round does not. An explicit after/batch Hook stop ends
orchestration while preserving physical receipts and their unconsumed status,
and leaves the Session ready for another turn.

When the loaded catalog contains Stop or MessageDisplay, model text stays buffered
until their decisions complete. Discarded or suppressed drafts never become durable
text deltas. Sessions without either output policy retain incremental streaming.

## Interfaces and compatibility

Session creation/load accepts `hookCatalog: {catalogId, catalogRevision,
definitionDigest}` with a Hosted Workspace tool profile and Broker. The saved
initial pin is restored when omitted on load and must match when supplied; later
committed registrations remain authoritative. Workspace cold load verifies Hook
record resources and the complete function-message snapshot closure before
attachment, while retaining original-owner recovery barriers. Opening the
authority reads each record, and each resource a record names, once however many
revisions name it. The Workspace verification reuses that result and reads only
what it must inspect itself, such as plans and their message snapshots; the
authority keeps none of it once the Session is open.
Independent reads run in bounded batches.
Hook scope identifiers accept the existing Broker character grammar, including
leading punctuation. Session status reports `recoveryBlocked`, and load reports
`recoveryRequired`, while Hook operations block prompt admission. Reconciliation
clears this diagnostic when the saved operation actually settles.

Runtime-only takeover flags keep Hook Sessions on the existing Hook-aware load
reconciliation path. The Runtime-only continue/cancel routes refuse Hook Sessions
with `hosted_hook_recovery_required` before changing records or Runtime ownership;
they cannot settle a turn while ignoring its pending Hook effects or model scope.

Private Session/client-scoped routes provide `GET /session/:id/hooks`, registration
updates, Notification/expansion operations, and operation status/cancel. Mutations
cannot overlap a turn or another control operation. A prompt refused while a Hook
operation runs returns 409 `hosted_hook_operation_active`. Reusing a
Notification/expansion operation ID with different input returns 409
`hosted_hook_operation_conflict`, which a retry cannot resolve. The public
tenant/actor-scoped
`GET /v1/agents/sessions/{sessionId}/hook-catalog` projects only display metadata;
it exposes no recipes, credentials, module paths or handler references. Existing
Sessions without a Hook pin retain their current behavior.

Changed areas are Core Hook dispatch/activation/record validation, CLI Hosted
orchestration and Runtime execution, Java Broker transport and Session Store
projection, and their collocated tests. Migration V27 records the first admission
journal sequence as `first_sequence`, which later revisions preserve. The latest
settled catalog is chosen by this sequence, matching native registration order
even when an older registration settles later, independently of clocks or UUIDs.
Migration V28 adds the admission columns and indexes; V29 backfills them for records
written under V27 from their verified bodies. A record whose body is missing or
corrupt keeps no keys, and V29 blocks its Session as a missing resource does
(`BLOCKED_RESOURCE`), so no later admission can reuse a once key it consumed.
So does a record that repeats a once key or occurrence ordinal of its Session,
which only a write that bypassed admission can leave; other Sessions are
unaffected. Running a binary older than V28 against a migrated
database is unsupported: it writes Hook records without these keys, which the
Session Store's checks then cannot see, although the Session authority still
enforces them in memory.

## Validation and acceptance

The ignored working plan is `.qwen/e2e-tests/12827-h2.md`. Baseline uses global
`qwen`; verification uses the local bundle, deterministic model responses, real
processes and side-effect counters. Production transport coverage connects Hosted,
Java Session Store, Embedded Broker and a spawned Tool Runtime. Local SQL coverage
uses H2; it is not a claim of a MySQL deployment test. The current validation host
is macOS without a Linux container runtime. Linux cgroup descendant, cancellation
and async drain tests are conditional and have not been executed here; their setup
is recorded in `.qwen/e2e-tests/12827-h2-cgroup-validation.md`. Local transport E2E
uses trusted function handlers for side effects and separately verifies command
refusal before execution. It does not claim to verify Linux command drain.

Acceptance includes all four runners, ordered aggregation, once failure, async
admission/cancellation/drain, input reapproval, cold reconstruction, lost execute
and HTTP responses without duplicate effects, catalog replacement, owner isolation,
prompt activation and unchanged no-Hook behavior. Run `npm run build`,
`npm run typecheck`, `npm run bundle`, focused package tests and Java contract tests.
Two clean self-audit passes and independent review follow integration verification.
Unknown physical or model outcomes remain blocked with their original evidence;
passing a mocked event test alone does not establish a missing producer's support.

Explicit Runtime recovery and cancellation retain the owner proven by the original durable tool inputs, including a shared MCP owner, rather than assuming the prompt ID. Missing or conflicting ownership evidence refuses recovery before any Broker call. Raw Shell intents without routing evidence can use the prompt owner only when the saved definition has no shared Hook or MCP owner.

A Broker execution-unknown response remains an unknown outcome, distinct from a missing execution. Cancellation refuses this state before or after a cancel request; it cannot commit a cancelled result or release ownership based on unknown physical stopping. Passive recovery continues reporting the outcome as unknown.
