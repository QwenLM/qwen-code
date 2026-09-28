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
`turnKind` (`bootstrap` or `continuation`). Every successful response repeats
the version, protocol and Session and contains `result`; void results are null.
Existing bearer, lease and epoch headers fence the selected physical Runtime.

The operation is a closed discriminated union. Public Broker controls are
`manifest`, `begin-turn`, `prepare`, `confirmation`, `confirm`, `preflight`,
`bind-history`, `checkpoint` and `history`. Transport-only operations are
`acquire`, `release`, `execute`, `status` and `cancel`. Execute cannot enter
through the public Broker control route and bypass its execution journal.
Identity, references, modification, media, confirmation and history values
reuse the existing Managed Tool contracts. Foreign Session references and
unknown fields are refused before dispatch. Unsupported versions and operations
fail explicitly; there is no legacy-route fallback.

Tool selection or construction failures return `400 managed_runtime_tool_invalid`;
unsupported provider profiles return `501 managed_runtime_provider_unsupported`.
The Broker preserves known provider error status/code pairs and reasons up to
4096 characters only from a closed JSON error response with no-store headers
and no content encoding. The TypeScript client retains the bounded reason.
This diagnostic evidence does not establish whether execution started.

Control requests and responses are bounded at 8 MiB for history and 1 MiB for
other operations. Tool arguments also have the existing core limit of 256 KiB
of canonical JSON; fitting the outer envelope does not bypass that limit.
Acquisition and release are idempotent for the same complete
Session identity. Reusing a Runtime Session for another Harness or turn kind
is a conflict. Release refuses running work, cancels preparations that have not
been reserved, and permanently closes admission without clearing the current
turn's status/cancellation evidence. Starting a new turn retains the runtime's
existing eviction policy; earlier dispatched invocations remain in the durable
Broker journal. Broker HTTP observation keeps its existing READY Session
requirement; release does not erase the persisted evidence. A durable Broker
reservation must be explicitly cancelled before release.

## Runtime and persistence

The worker owns one Managed Tool runtime per acquired provider Session and
reuses its manifest, preparation, approval and preflight semantics. Arguments
remain in the worker's prepared invocation. The Broker stores only the prepared
reference; execution forwards that reference to the original worker. Missing
prepared state cannot recreate or replay an invocation. New work rechecks the
resolved Workspace and activation; cleanup and observation use original state.
Legacy raw-tool calls retain their separate protocol and cannot enter a Session
owned by the provider protocol.

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
codes alone do not prove that execution never started. Existing immediate Tool
v2 behavior stays available independently.

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

After release, the private worker route retains status/cancellation evidence
for the current turn and any bound file-history state; earlier turns' invocation
entries remain subject to eviction. The Broker HTTP surface and provider client
do not expose these observations for a released Session. The worker currently
retains the Session's Config, tools and runtime until worker shutdown, so memory
can grow with released provider Sessions. Reducing that retention while
preserving private observation semantics is follow-up work.
