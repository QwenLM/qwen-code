# Managed Runtime Tool Contract v2

[English](2026-09-24-managed-runtime-tool-contract.md) | [简体中文](2026-09-24-managed-runtime-tool-contract.zh-CN.md)

Status: contract landed; the worker handlers and the Java transport mount in
follow-up slices

Related: #12380 (Managed Agent staged delivery), the attestation contract in
[2026-09-22-managed-runtime-attestation-contract.md](2026-09-22-managed-runtime-attestation-contract.md),
and the reconciliation thread on #12380 that this contract answers.

## 1. Problem

The owned Managed Runtime worker serves only attestation today. Before a tool
execution path can be reviewed, the wire shape of its three operations —
`execute`, `status`, and `cancel` — must be fixed once for both the TypeScript
worker and the Java transport, with the evidence rules the recovery design
already demands:

- A Runtime never sees the Broker's execution id; it identifies a call by the
  original `reference` (`sessionId`, `promptId`, `callId`, `argsDigest`).
- A lookup must never prove a call did not run. A missing record, a timeout,
  or an expired lease is not evidence, so `status` answers `unknown` with 200
  rather than 404 or 500.
- `status` is read-only: it must never enter the prepare path, attach a
  session, or execute anything.

## 2. Scope

In scope: the route manifest entries, the shared schema, and the shared
conformance fixtures for the three operations, consumed by both the raw-HTTP
TypeScript gate test and the Java fixture consumer.

Out of scope: the worker handlers that serve these routes (they land with the
execute extraction that mounts them, per the manifest rule that a route joins
with its real handler in the same change), the Java `HttpRuntimeTransport`
implementation of `execute`/`status`/`cancel`, and a `not_started_proven`
outcome, which needs the durable receipt store.

## 3. Design

### 3.1 Routes

All three operations join `OWNED_MANAGED_RUNTIME_ROUTES` with the attestation
discipline: `POST` on an exact path, protocol version 2, closed JSON bodies,
`no-store` on both directions, bearer authentication before parsing, and the
lease id and epoch headers. `execute` accepts up to 256 KiB of request so a
tool call's `input` fits; every operation answers at most 1 MiB. Larger tool
outputs travel through the artifact delivery track, never through these
envelopes.

### 3.2 Requests

Every request is a closed object:

- `execute`: `protocolVersion`, `reference`, `toolName`, `input`.
- `status`: `protocolVersion`, `reference`, and an optional non-negative
  `afterSequence` cursor.
- `cancel`: `protocolVersion`, `reference`.

The reference is the original call identity the harness assigned; the Runtime
never learns any Broker-side identifier.

### 3.3 Responses

Every success is a closed object carrying `protocolVersion` and a `state` of
`prepared`, `executing`, `cancel_requested`, `settled`, or `unknown`:

- `unknown` means the Runtime holds no record of that reference. It is a 200,
  and it is not evidence of non-execution.
- `result` is present only when the state is `settled`; it carries
  `executionStatus` (`not_started`, `success`, `error`, or `cancelled`),
  `responseParts`, and an optional `error` with `message` and optional `type`.
- `status` additionally carries `lastSequence`, the Runtime's own progress
  cursor, so a caller reconciling after a gap can advance without replaying.

Failures keep the shared classification: 401 credentials, 400/413 protocol,
409 identity, 404 incompatible, each with a stable `code`.

### 3.4 Conformance fixtures

`managed-runtime-tool-v2.fixtures.json` mirrors the attestation suite: three
routes, one identity, and per-route canonical requests with cases covering the
success shapes and the negative discipline. `unknown-is-ok` cases pin the
evidence rule for `status` and `cancel`. The Java consumer pins the route
contract, every outcome classification, and the closed request/response field
sets; the TypeScript side validates the fixtures against the schema, pins the
manifest to the fixtures, and proves the owned-route gate admits exactly these
paths.

## 4. Validation

`npx vitest run src/serve/managed-runtime-attestation-contract.test.ts` in
`packages/cli` (54 tests) and `mvn test -Dtest=ManagedRuntimeAttestationConformanceTest`
in `packages/sdk-java/runtime-broker` (6 tests) both pass.

### 4.1 Java transport

`HttpRuntimeTransport` implements the three operations against the shared
fixtures. The reference map supplied by the caller carries the identity four
plus `toolName` and `input`; anything else is rejected client-side, and a
request larger than the route's 256 KiB limit never leaves the process.
Responses are read with the route's 1 MiB bound and parsed strictly: closed
field sets, protocol version 2, a state from the contract enum, a result only
with `settled`, and a non-negative integer `lastSequence`. `execute` requires
`settled` and returns the result map; `status` and `cancel` return the full
closed map. Failure statuses map to the shared classifications, with 5xx
retryable and everything else terminal. The fixture-driven tests replay the
shared success and `unknown` answers over a real HTTP server and pin the
rejection of unsettled executes, resultless settlements, results on
`unknown`, unknown states, and oversized inputs; `mvn test` in
`packages/sdk-java/runtime-broker` passes 122 tests.

## 5. Follow-up work

- Mount the real worker handlers for the three routes (execute extraction).
- The `UNKNOWN` execution reconciler consumes `status` (tracked on #12380).
- Whether a cancel of an execution the Runtime reports as still running sends
  the physical cancel is deliberately deferred.
