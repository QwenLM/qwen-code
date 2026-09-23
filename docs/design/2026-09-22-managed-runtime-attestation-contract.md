# Managed Runtime Attestation Contract Foundation

[English](2026-09-22-managed-runtime-attestation-contract.md) | [简体中文](2026-09-22-managed-runtime-attestation-contract.zh-CN.md)

Status: contract foundation implemented; production Hosted Runtime wiring remains follow-up work. Date: 2026-09-22.

## Problem

The preview Managed Runtime worker registered `POST /internal/managed-runtime/v2/attest` in Express while its outer raw HTTP gate maintained a separate route expression. The route initially returned 404 before reaching Express because only one list had been updated. A private identity operation must not rely on reviewers keeping two route lists synchronized.

The TypeScript worker and the future Java transport also need one reviewable wire contract. Tests owned independently by each implementation can agree accidentally while accepting different methods, paths, headers, body shapes, limits, or failure classes.

## Current State

The upstream `main` branch contains the Hosted Harness protocol primitive from #12409 and the Runtime Broker state foundations, but it does not contain the Hosted profile, owned Runtime worker, Java HTTP transport, Runtime provider, or Broker-to-Harness wiring from the preview branch. This change therefore provides a mountable contract boundary without activating a new server mode.

The preview implementation remains useful evidence for the route set and the 404 failure, but it is not copied wholesale. Production activation must depend on this contract when those components are extracted.

## Goals

- Define the v2 attestation method and exact path once in a typed route manifest.
- Drive both the Express registration and the raw HTTP allow decision from that entry.
- Authenticate before parsing JSON, limit the request body to 16 KiB, reject unknown body fields, and return `Cache-Control: no-store` on every response.
- Store a language-neutral closed schema and positive and negative fixtures.
- Execute those fixtures through a real raw Node HTTP server and consume the same files from the Java Runtime Broker build.
- Keep ordinary `qwen serve`, public APIs, and existing daemon routes unchanged until the Hosted profile is introduced.

## Non-Goals

This slice does not add the Hosted profile, Runtime provider, Java `RuntimeTransport`, Broker service integration, public Agent API, Session recovery, Tool execution, Kubernetes identity, or MySQL state. It does not claim that a production Runtime is ready after attestation. Reconcile, attestation, database CAS, and the process-local ready gate remain one ordered operation in the later Broker integration.

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

The Java Runtime Broker test reads these exact repository files with Jackson. It pins route metadata, limits, closed field sets, fixture uniqueness, and the shared status classification. No Java production validator is added yet because `main` has no Java HTTP transport consumer; publishing one now would create an unused API. The future transport PR must move the fixture assertions into its real request emission and response parser while continuing to read the same files.

## Security and Failure Semantics

- The raw gate sees the original URL and rejects query variants instead of normalizing them into an allowed route.
- Authentication and lease headers are checked before JSON parsing, reducing unauthenticated parser exposure.
- Every route and outer-gate response carries `Cache-Control: no-store`, including 4xx responses.
- `401/403` classify as credential failure, `400/413` as protocol failure, `404/405` as incompatibility, and `409` as identity conflict. A future Broker must not interpret 404 as temporary readiness.
- Attestation verifies an application identity envelope; it is not TPM/TEE remote attestation. Cross-host traffic still requires TLS/mTLS or equivalent workload identity and network policy.

## Integration Order

The Hosted Runtime follow-up must:

1. extract each real owned worker handler and add its route to the manifest in the same commit;
2. wrap the owned listener with `ownedManagedRuntimeRouteGate` and register attestation with `registerManagedRuntimeAttestationRoute`;
3. make the Java `RuntimeTransport` emit and parse the shared fixture shape with a 16 KiB response cap;
4. reconcile physical identity before sending credentials, then commit the attestation result with the original database operation generation before opening the local ready gate; and
5. add the real TypeScript worker plus Java Broker process E2E and make the cross-language gate required in CI.

## Validation

The focused TypeScript suite must pass all fixture cases through a real TCP listener. The Runtime Broker Maven suite must read the same fixtures and schema. Repository build and typecheck must remain green. Because the contract is not mounted in a shipped profile, there is no user-visible E2E change in this slice.

## Acceptance Criteria

- The route registrar and raw allow decision contain no duplicate attestation path literal.
- A query string, trailing slash, wrong method, or unknown path receives 404 at the raw gate.
- Missing credentials win over malformed JSON, proving authentication precedes parsing.
- Bodies over 16 KiB receive 413, compressed bodies and unsupported JSON charsets or content encodings fail as JSON protocol errors, and every response has `Cache-Control: no-store`.
- Unknown fields, wrong protocol version, and malformed digests fail as protocol errors; lease and immutable identity differences fail as conflicts.
- TypeScript and Java consume the same fixture file and agree on all five classifications.
- No Hosted profile, Runtime provider, Broker transport, public API, or ordinary daemon behavior is introduced.

## Follow-Up Boundary

This change completes the independently reviewable A1 route source and the schema/fixture portion of A2. A2 is complete only when the concrete Java transport consumes the shared fixtures for request emission and strict response parsing and a required CI lane runs both implementations. Process E2E, restart/CAS behavior, deployment identity, and fault injection remain later acceptance gates.
