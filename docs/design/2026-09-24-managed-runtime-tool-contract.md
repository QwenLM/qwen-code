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

In scope: contract declarations in the route manifest, the shared schema, and
the shared conformance fixtures for the three operations, consumed by both the
TypeScript contract tests and the Java fixture consumer. The declarations fix
the future wire contract; they do not make an unimplemented route reachable.

Out of scope: the worker handlers that serve these routes, admission through
the raw HTTP gate, the Java `HttpRuntimeTransport` implementation of
`execute`/`status`/`cancel`, and a `not_started_proven` outcome, which needs the
durable receipt store. Each handler and its gate admission land together in a
follow-up change.

## 3. Design

### 3.1 Routes

All three operations are declared in `OWNED_MANAGED_RUNTIME_ROUTES` with the
attestation discipline: `POST` on an exact path, protocol version 2, closed
JSON bodies, `no-store` on both directions, bearer authentication before
parsing, and the lease id and epoch headers. `execute` accepts up to 256 KiB of
request so a tool call's `input` fits; every operation answers at most 1 MiB.
Larger tool outputs travel through the artifact delivery track, never through
these envelopes.

The declaration list is not the raw gate allowlist. Until the real tool
handlers are mounted, `ownedManagedRuntimeRouteGate` admits only the exact
attestation route and returns 404 for `execute`, `status`, and `cancel`, even
if an Express handler is mounted behind it. A future handler change must
expand gate admission in the same change.

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
sets.

The shared schema enforces each route's exact request fields, for both the
canonical request and any per-case body override. It also requires every `ok`
case to carry a response body, forbids `result` unless the state is `settled`,
and permits `lastSequence` only on `status`. TypeScript mutation tests remove
required fields or add route-invalid fields to prove these constraints are
load-bearing, and pin the declared manifest to the fixture routes. The raw HTTP
test separately proves that the gate rejects all three declared tool routes
until their handlers land.

## 4. Validation

Run `npx vitest run src/serve/managed-runtime-attestation-contract.test.ts` in
`packages/cli` and
`mvn test -Dtest=ManagedRuntimeAttestationConformanceTest` in
`packages/sdk-java/runtime-broker`. The TypeScript suite validates the shared
fixtures, the schema mutation cases, and raw-gate rejection of unimplemented
tool routes. The Java suite consumes the same contract files.

## 5. Follow-up work

- Mount the real worker handlers for the three routes and expand raw-gate
  admission in the same change (execute extraction).
- Implement `execute`, `status`, and `cancel` in `HttpRuntimeTransport`.
- The `UNKNOWN` execution reconciler consumes `status` (tracked on #12380).
- Whether a cancel of an execution the Runtime reports as still running sends
  the physical cancel is deliberately deferred.
