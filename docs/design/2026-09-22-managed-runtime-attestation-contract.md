# Managed Runtime Attestation Contract Foundation

[English](2026-09-22-managed-runtime-attestation-contract.md) | [简体中文](2026-09-22-managed-runtime-attestation-contract.zh-CN.md)

Status: contract foundation and attestation-only worker shell implemented; Java Broker wiring remains follow-up work. Updated: 2026-09-23.

## Problem

The preview Managed Runtime worker registered `POST /internal/managed-runtime/v2/attest` in Express while its outer raw HTTP gate maintained a separate route expression. The route initially returned 404 before reaching Express because only one list had been updated. A private identity operation must not rely on reviewers keeping two route lists synchronized.

The TypeScript worker and the future Java transport also need one reviewable wire contract. Tests owned independently by each implementation can agree accidentally while accepting different methods, paths, headers, body shapes, limits, or failure classes.

## Current State

The upstream `main` branch contains the Hosted Harness protocol primitive from #12409 and the Runtime Broker state foundations, but it does not contain the Hosted profile, Java HTTP transport, Runtime provider, or Broker-to-Harness wiring from the preview branch. This change adds a hidden attestation-only worker command so the route contract runs in a real separately owned process without activating a public server mode or claiming Tool execution readiness.

The preview implementation remains useful evidence for the route set and the 404 failure, but it is not copied wholesale. Production activation must depend on this contract when those components are extracted.

## Goals

- Define the v2 attestation method and exact path once in a typed route manifest.
- Drive both the Express registration and the raw HTTP allow decision from that entry.
- Authenticate before parsing JSON, limit the request body to 16 KiB, reject unknown body fields, and return `Cache-Control: no-store` on every response.
- Store a language-neutral closed schema and positive and negative fixtures.
- Execute those fixtures through a real raw Node HTTP server and consume the same files from the Java Runtime Broker build.
- Start a minimal separately owned process from one bounded boot document on standard input, bind only to loopback, and publish a token-free ready record on standard output.
- Keep ordinary `qwen serve`, public APIs, and existing daemon routes unchanged until the Hosted profile is introduced.

## Non-Goals

This slice does not add the Hosted profile, Runtime provider, Java `RuntimeTransport`, Broker service integration, public Agent API, Session recovery, Tool execution, Kubernetes identity, or MySQL state. The worker shell serves identity proof only and does not claim that a production Runtime is ready after attestation. Reconcile, attestation, database CAS, and the process-local ready gate remain one ordered operation in the later Broker integration.

## Typed Route Manifest

`OWNED_MANAGED_RUNTIME_ROUTES` currently contains the one route implemented by this contract slice:

```text
POST /internal/managed-runtime/v2/attest
protocolVersion = 2
requestBodyLimitBytes = 16384
responseBodyLimitBytes = 16384
cacheControl = no-store
```

The Express registrar reads its method, path, protocol version, and body limit from this entry. The raw HTTP gate compares the incoming method and unmodified request URL against the same entry. Query strings, trailing slashes, case variants, other methods, and unregistered paths therefore fail with 404 before Express.

This manifest is intentionally not populated with preview-only health, v1 Tool, history, or v2 Tool routes. Each operation is added when its real handler is extracted, in the same change that registers it. This prevents a manifest entry from claiming that a route exists when `main` has no implementation.

## Attestation Request and Response

The request uses bearer authentication and exact lease headers:

```http
POST /internal/managed-runtime/v2/attest
Authorization: Bearer <per-generation-token>
X-Qwen-Managed-Lease-Id: <leaseId>
X-Qwen-Managed-Lease-Epoch: <positive epoch>
Content-Type: application/json
Cache-Control: no-store
```

The closed JSON body contains `protocolVersion`, `provisionRequestId`, `tenantId`, `workspaceId`, `workspaceGeneration`, `workspaceCwd`, `capabilityDigest`, and `isolationClass`. Unknown fields and malformed JSON return 400. Compressed requests are rejected, so the 16 KiB cap applies to wire bytes; a larger body returns 413. Invalid credentials return 401 before body parsing. Lease or immutable scope mismatches return 409. A successful response echoes the immutable scope and adds `runtimeInstanceId`, `runtimeIncarnation`, `leaseId`, and `epoch`.

The handler never returns the bearer token. Token comparison uses equal-length `timingSafeEqual`. The capability digest must use canonical lowercase `sha256:<64 hex>` syntax. Request and response payloads are closed so a v2 peer cannot silently introduce an identity field that the other implementation ignores.

## Shared Schema and Fixtures

The language-neutral files live beside the TypeScript contract under `packages/cli/src/serve/contracts/`:

- `managed-runtime-attestation-v2.schema.json` fixes the route metadata, closed request and response shapes, limits, and outcome classes.
- `managed-runtime-attestation-v2.fixtures.json` contains the canonical identity and cases for credential variants, every immutable identity mismatch, malformed and empty fields, exact error codes, unsupported media types, charsets and content encodings, oversized bodies, and exact-route rejection.

The TypeScript test materializes every case and sends it through `node:http` → the raw manifest gate → Express authentication and JSON parsing → the attestation handler. It checks status, classification, `no-store`, exact success body, and response size.

The Java attestation client reads these same files, sends the canonical request to a real HTTP endpoint, and classifies the response by status. It enforces the 16 KiB limit, the closed field set, and exact success-identity equality; 404 is not retryable. See the [Java client slice](2026-09-23-java-runtime-attestation-client.md). The client still does not implement acquire/execute, and it does not write the result into the Broker service.

## Attestation-only Worker Shell

The hidden `qwen managed-runtime-worker` command accepts exactly one JSON boot document on standard input. The closed document carries the v1 boot marker plus the immutable attestation identity, including the per-generation bearer token. Input is capped at 32 KiB, must close within 30 seconds, and fails startup on timeout or unknown fields. Keeping the token on standard input avoids exposing it in command arguments or a long-lived environment variable.

After validating the identity through the same attestation registrar, the process listens on an operating-system-assigned `127.0.0.1` port. The raw listener is wrapped by `ownedManagedRuntimeRouteGate`, so the only admitted operation is the manifest's exact attestation route. The process emits one closed v1 ready record containing its loopback URL and fencing identity, but never the token. `SIGINT` and `SIGTERM` close the listener before the process exits.

This shell is an executable ownership boundary for the next Java client and process provisioner. It does not load a model, Harness, tool manifest, Session, or workspace execution engine. Adding any Tool operation requires its real handler and route manifest entry in the same later change.

## Security and Failure Semantics

- The raw gate sees the original URL and rejects query variants instead of normalizing them into an allowed route.
- Authentication and lease headers are checked before JSON parsing, reducing unauthenticated parser exposure.
- Every route and outer-gate response carries `Cache-Control: no-store`, including 4xx responses.
- The boot credential is read once from size- and time-bounded standard input, and the ready record cannot disclose it. The shell binds only to IPv4 loopback in this phase.
- `401/403` classify as credential failure, `400/413` as protocol failure, `404/405` as incompatibility, and `409` as identity conflict. A future Broker must not interpret 404 as temporary readiness.
- Attestation verifies an application identity envelope; it is not TPM/TEE remote attestation. Cross-host traffic still requires TLS/mTLS or equivalent workload identity and network policy.

## Integration Order

The Hosted Runtime integration proceeds in this order:

1. this change starts the attestation-only process, wraps its listener with `ownedManagedRuntimeRouteGate`, and registers `registerManagedRuntimeAttestationRoute`;
2. make the Java attestation client emit and parse the shared fixture shape with a 16 KiB response cap;
3. reconcile physical identity before sending credentials, then commit the attestation result with the original database operation generation before opening the local ready gate;
4. extract each real owned Tool handler and add its route to the manifest in the same commit; and
5. add the Java Broker plus TypeScript worker process E2E and make the cross-language gate required in CI.

## Validation

The focused TypeScript suite must pass all fixture cases through a real TCP listener and start the hidden command as a child process from boot input through attestation and graceful termination. The Runtime Broker Maven suite must read the same fixtures and schema. Repository build and typecheck must remain green. Because the command is internal and no public profile launches it yet, there is no ordinary user-visible behavior change in this slice.

## Acceptance Criteria

- The route registrar and raw allow decision contain no duplicate attestation path literal.
- A query string, trailing slash, wrong method, or unknown path receives 404 at the raw gate.
- Missing credentials win over malformed JSON, proving authentication precedes parsing.
- Bodies over 16 KiB receive 413, compressed bodies and unsupported JSON charsets or content encodings fail as JSON protocol errors, and every response has `Cache-Control: no-store`.
- Unknown fields, wrong protocol version, and malformed digests fail as protocol errors; lease and immutable identity differences fail as conflicts.
- TypeScript and Java consume the same fixture file and agree on all five classifications.
- The worker rejects malformed, oversized, or non-closed boot input; binds a loopback ephemeral port; emits a token-free ready record; exposes only the manifest route; and terminates cleanly.
- No Hosted profile, Runtime provider, Broker transport, public API, or ordinary daemon behavior is introduced.

## Follow-Up Boundary

This change completes the independently reviewable A1 route source, TypeScript process mounting, and the schema/fixture portion of A2. The Java client now emits the shared canonical request and strictly parses the response. A2 still needs a required CI lane that runs both implementations together. Cross-language process E2E, restart/CAS, deployment identity, and fault injection remain later gates.
