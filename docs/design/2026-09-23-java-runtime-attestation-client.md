# Java Runtime Attestation Client

[English](2026-09-23-java-runtime-attestation-client.md) | [简体中文](2026-09-23-java-runtime-attestation-client.zh-CN.md)

Status: implemented. Updated: 2026-09-23. The prerequisite contract is the [attestation contract](2026-09-22-managed-runtime-attestation-contract.md).

## Problem

The preview branch `feature/managed-agents-p0-p8` already sends `POST /internal/managed-runtime/v2/attest` and parses a `RuntimeAttestation` inside `HttpRuntimeTransport.attest`. That method shares a class with prepare, execute, cancel, and release, allows an 8 MiB response, and does not enforce the 16 KiB limit or the failure classes from the shared fixtures now on `main`. The merged worker rejects a request that omits `Cache-Control: no-store`.

## This Slice

Extract the attestation call from the preview and keep its arguments: `RuntimeLease`, `RuntimeProvisionRequest`, and `RuntimeProvisionSeed`. The body still carries the protocol version, provision request, and workspace scope.

The only additions are constraints from the contract that has already landed:

- Send `Cache-Control: no-store`. Without it the merged worker rejects the request.
- Cap the response at the route contract's 16 KiB instead of the 8 MiB tool-call limit.
- Classify `401/403`, `400/413`, `409`, and `404/405` as in the shared fixtures, and do not retry them. Connection failures and `5xx` stay retryable.
- A success response must be a closed object. Identity must match the preview broker's `validAttestation` comparison against the lease, the seed's gateway incarnation, the scope, and the provision request. A mismatch is rejected and not returned to the caller.

## Non-Goals

This slice does not implement prepare, execute, cancel, or release, and it does not add `attest` to `RuntimeTransport`. It does not change `RuntimeBrokerService`, perform reconcile, database CAS, or the in-process ready gate, attach Spring/Flyway, or launch the TypeScript worker. `RuntimeProvisionSeed` keeps its identity fields; durable encoding waits for reconcile.

## Verification

Tests read `managed-runtime-attestation-v2.fixtures.json`. The success case checks the path, Authorization, `no-store`, and body actually sent. Every fixture's expected status goes through the same response parser. Identity mismatch, an oversized response, 404, and a retryable 503 have separate failure cases.
