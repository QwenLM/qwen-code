# Broker Provider Control Contract

[English](2026-09-27-broker-provider-control.md) | [简体中文](2026-09-27-broker-provider-control.zh-CN.md)

Status: implemented. Tracks #12765; related to #12380 and #12831.

## Problem and scope

The Broker provider exposes manifest, turn preparation, tool preparation,
confirmation, preflight and file-history operations, but the production HTTP
transport rejects every control operation. The owned worker's Tool v2 journal
accepts a four-field reference and raw arguments; the provider uses a seven-field
prepared invocation reference. Treating these as the same protocol loses
approval, capability and invocation identity.

This change supplies an explicit provider protocol for the existing client,
Broker and owned worker. It preserves Tool v2/v3 and Workspace directory,
activation and storage ownership checks. Public Hosted admission, arbitrary
configuration loading, Shell output publication and restart recovery remain
separate work. #12831 owns the independently gated Workspace model/tool loop.

## Wire contract

The authenticated, no-store POST route
`/internal/managed-runtime/provider/v1/control` carries a closed envelope:
`protocolVersion: 1`, `providerProtocol: managed-runtime-provider/1`, `session`
and `operation`. Session contains `harnessSessionId`, `runtimeSessionId` and
`turnKind` (`bootstrap` or `continuation`). Both Session ids are checked
against an allow-list: 1 to 512 characters, each an ASCII letter, digit, `.`,
`_` or `-`. An id may not be `.` or `..`, and may not contain `..` anywhere.
The worker rejects any other id at the envelope, before it can become core's
session id or a file-history directory name. The Broker refuses the same ids
with 400 `runtime_broker_invalid_request`, the Harness Session id already at
`warm` and both at `acquire`: every Runtime Session is released through this
envelope, so an id the worker refuses would leave the Session stuck RELEASING
with its storage held. The UUID form is not required:
identity-bearing operations additionally require it through core's identity
check, while acquire, release and manifest stay available to opaque ids.
Every successful response repeats the version, protocol and Session and
contains `result`; void results are null, and `acquire`/`release` results
are exactly `true`. Existing bearer, lease and epoch headers fence the selected
physical Runtime.

The operation is a closed discriminated union. Public Broker controls are
`manifest`, `begin-turn`, `prepare`, `confirmation`, `confirm`, `preflight`,
`bind-history`, `checkpoint` and `history`. Transport-only operations are
`acquire`, `release`, `execute`, `status` and `cancel`. Execute cannot enter
through the public Broker control route and bypass its execution journal.
Identity, references, modification, media, confirmation and history values
reuse the existing Managed Tool contracts. This provider profile refuses a
`prepare` that carries `modification` with 400 `managed_runtime_tool_invalid`
before any invocation is journaled: core applies content modification only to
`notebook_edit`, and the profile exposes only `read_file`, `write_file`,
`edit` and `run_shell_command`. The shared provider corpus still lists that
shape as valid, because it pins the wire shape both sides accept, not what one
profile serves. A `run_shell_command` whose `directory` lies outside the
Session's workspace is refused the same way, since core's shell tool would ask
and a preapproved Session never asks. The worker checks again just before the
call runs, resolving the path afresh the way the kernel follows it, and settles
the call as an error if a link has since moved it out. `mediaContext` is
admitted for `read_file` only; it binds the
tool's model-facing description to the Harness's modalities, while the read
itself decides media delivery from this worker's own content-generator
modalities, which it does not have, so a media file is still answered with the
unsupported-type placeholder. Delivering media through the worker is follow-up
work. Foreign Session references and unknown fields are refused
before dispatch. The Broker also refuses, with 400
`runtime_control_operation_invalid`, an operation with an unpaired surrogate in
any key or string, which the JSON writer would otherwise send as `?`.
Unsupported versions and operations fail explicitly; there is
no legacy-route fallback.

Tool selection or construction failures return `400 managed_runtime_tool_invalid`;
unsupported provider profiles return `501 managed_runtime_provider_unsupported`.
The Broker preserves known provider error status/code pairs and reasons up to
4096 characters only from a closed JSON error response with no-store headers
and no content encoding. The TypeScript client retains the bounded reason.
This diagnostic evidence does not establish whether execution started.

Control requests and responses are bounded at 8 MiB for `bind-history`,
`checkpoint` and `history`, and 1 MiB for other operations. Tool arguments
also have the existing core limit of 256 KiB of canonical JSON; fitting the
outer envelope does not bypass that limit. An `execute`, `status` or `cancel`
result that would exceed its operation's response budget is fitted rather
than refused: the worker first evicts oldest progress events (announced
through `firstAvailableSeq`/`progressGap`), then cuts bulk text fields
head-and-tail with an inline notice and sets `truncated` on shell displays.
When even fully cut text could not fit beside what the cut cannot reach, a
structured display (such as an edit's file diff, which only feeds the UI), then
artifacts, which also only feed a client surface, and then hook results are
dropped before any text is cut, and content the cut
cannot reach at all (inline media) turns the model content into an explicit
stub.
The cut is measured in JSON-encoded UTF-8 bytes, the unit of the wire limit,
and removes whole code points, so a surrogate pair is never split; the notice
reports how many characters (code points) were omitted. When several fields
are over, they are cut to one common size, so no field is emptied while
another keeps most of its text. A settled execution
therefore always keeps a terminal observation, and release stays answerable.
An oversized operation the Broker itself cannot encode is refused
with a definitive, non-retryable 413 before anything is sent.
Acquisition and release are idempotent for the same complete
Session identity. Reusing a Runtime Session for another Harness or turn kind
is a conflict. Release refuses running work, cancels preparations that have not
been reserved, and permanently closes admission without clearing the current
turn's status/cancellation evidence (kept until the Session is retired, see
below). It also drops the process-global entries
core keeps under the Runtime Session id (its project directory, model and
model identity); worker shutdown drops them too. Starting a new turn retains
the runtime's existing eviction policy; earlier dispatched invocations remain
in the durable Broker journal. Broker HTTP can read owned terminal execution
receipts without a READY Session; live observation and file-history controls
still require READY. Repeating the cancellation of a prepared call that is
already settled answers from its receipt once the Session is not READY or the
binding generation it was prepared on can no longer answer. While that
generation may still hold the preparation, a Broker process without a live
Session for it answers a retryable 503 `runtime_reconciliation_required`, as
reconciliation does: the caller acquires the Session again, and the
cancellation is acknowledged once the worker confirms it. Another Harness's
Session under the same id in this process is a conflict (409
`runtime_session_conflict`). A repeat that the worker answers with `unknown`
(it forgets settled calls at the next turn) is refused like a first one, with
the non-retryable 409 `runtime_execution_cancel_unconfirmed`, and the receipt
stays readable. Release does not erase persisted evidence. A durable Broker
reservation must be explicitly cancelled before release.

## Runtime and persistence

The worker owns one Managed Tool runtime per acquired provider Session and
reuses its manifest, preparation, approval and preflight semantics. Arguments
remain in the worker's prepared invocation. The Broker stores only the prepared
reference; execution forwards that reference to the original worker. Missing
prepared state cannot recreate or replay an invocation. New work rechecks the
resolved Workspace and activation; cleanup and observation use original state.
Legacy raw-tool calls retain their separate protocol and cannot enter a Session
owned by the provider protocol. A refused acquisition removes its provisional
provider claim, so raw admission remains available; explicit release still
permanently closes admission. Worker status and cancellation return exactly
`{ state: 'unknown' }` when an invocation is no longer retained. A changed
reference for a retained invocation remains a conflict, and missing execution
state never permits replay.

Broker Session acquisition remains local for compatibility with raw Tool v2.
Before the first generic control, the transport explicitly acquires the worker
provider Session; repeated acquire calls are idempotent. History observation,
status and cancellation do not acquire or reopen a Session. Release obtains a
real worker acknowledgement, including for a raw-only Session. Workspace
release closes provider admission before deactivating and dropping storage
ownership.

Boot v1 uses the worker's fixed four-tool configuration with DEFAULT approval.
The caller must enforce the confirmation decision before execution; DEFAULT
does not make the private worker reject an execution that skips confirmation.
Boot v2 provider controls require the existing exact Workspace capability and
configuration profile, an installed context and activation. They preserve its
preapproved policy. Other opaque context configuration references cannot opt
into provider controls. Explicit file-history binding opts this protocol into
history tracking; the existing raw-tool profile retains its original behavior.

File-history binding fixes the owner and the resolved execution directory.
Client-provided paths never replace placement authority. Binding retries must
match; history must be bound before history-dependent work starts. Snapshot
and checkpoint return the existing versioned file-history state. Unsupported
configuration/profile combinations are rejected rather than silently applied.

The provider's reserve/start path requires durable Broker preparation. A
reservation creates a PREPARED execution without dispatch; start drives the
existing dispatch lease and same-reference idempotency. Cancellation before
start must settle without tool effects. Worker cancellation may first answer
`cancel_requested`; the Broker waits within its operation deadline for the
original invocation's `not_started` or `cancelled` result before acknowledging
prepared cancellation. UNKNOWN remains observation-only and
never becomes permission to replay. This includes the inherited conservative
handling of an HTTP rejection during dispatch: without authoritative execution
evidence it remains UNKNOWN, even when the worker's reason describes a refusal.
That state blocks release and can retain Workspace storage ownership. Error
codes alone do not prove that execution never started. The Broker's Runtime-loss
recovery may fence an uncertain execution as ABANDONED: it remains permanently
unknown, can be read through its persisted owner, and cannot be replayed.
Broker HTTP start, read and cancel ask the original worker about a provider
execution left UNKNOWN, as they do for a tool v3 one, so its retained result
settles the execution without a second dispatch, and a cancellation reaches the
invocation the worker is still running. The ask is best-effort: when the
original Runtime cannot be asked or cannot answer, whatever the reason, the
record keeps its own `runtime_broker_execution_unknown` answer rather than the
error of the attempt. Existing immediate Tool v2 behavior
stays available independently.

The raw reserve/start path from #12831 remains available on the same Broker
routes. It reserves a four-field reference and supplies the exact `payloadJson`
only at start. Provider reservations use seven-field references and reject a
start payload; raw reservations require one. The saved reference determines the
protocol, so retries cannot switch execution contracts.

## Ownership and consumers

All new worker operations belong to the selected Runtime and exact live Session
owner. Broker HTTP operations resolve the persisted Harness Session. Consumers
are `BrokerManagedRuntimeProvider`, `ManagedRuntimeBrokerClient`,
`RuntimeBrokerHttpServer`, `RuntimeBrokerService`, `HttpRuntimeTransport`,
`WorkspaceRuntimeTransport` and the owned worker. No operation falls back to a
primary daemon, global directory or another Runtime generation.

## Validation and acceptance

- Validate closed operation shapes, versions, identity and limits on both sides.
- Exercise all nine controls through real HTTP, including immutable approval
  decisions, changed arguments, foreign references and history ownership.
- Prove acquire, prepare, reserve, start, observation, cancellation and release
  with a real worker; no effect before start and no payload in stored references.
- Reject stale lease/epoch, unavailable context, repeated conflicting acquire,
  active release and mixed legacy/provider admission.
- Preserve existing worker, transport, Broker and Workspace tests. Run build,
  typecheck, bundle, focused unit tests, Java Checkstyle and independent E2E.
- Audit the complete diff twice and run a separate code review.

## Open boundaries

The worker journal is generation-local. A restarted worker cannot recover
prepared inputs or approvals from Broker reference rows. Recovery stays fail
closed. A successful private contract test does not enable public Workspace
turns or claim complete Hosted product readiness.

The immediate `POST /executions` route still reads `toolName`/`input` from
the stored reference, so its callers must keep tool arguments in
`reference_json` — the shape the tool contract's §4.1 forbids for durable
state. The deferred reserve/start path and this protocol are the
payload-separated routes; extending that separation to the immediate route is
follow-up work.

After release, until the Session is retired, the private worker route retains
status/cancellation evidence for the current turn and any bound file-history
state; earlier turns' invocation entries remain subject to eviction. After
release, Broker execution inspection can return persisted terminal receipts
without reopening the worker; private history and live invocation observations
remain unavailable through the closed provider tool client. Release drops the
process-global entries core keeps under the Runtime Session id. The worker keeps
the Config, tools, runtime and file history of up to eight released Sessions, so
status, cancellation and history still answer for them; when another is
released, the oldest one not being observed is retired (its runtime disposed,
its file history drained and its Config shut down) to a closed tombstone whose
calls answer `unknown`, the same tombstone a release that came before any
acquire leaves. The tombstone keeps a repeated release idempotent and a
re-acquire refused; tombstones, like the executor's closed-Session set, still
grow by one small entry per released Session.
