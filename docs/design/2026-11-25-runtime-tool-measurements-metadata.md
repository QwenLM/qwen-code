# Runtime Tool Measurements Metadata

[English](2026-11-25-runtime-tool-measurements-metadata.md) | [简体中文](2026-11-25-runtime-tool-measurements-metadata.zh-CN.md)

Status: implemented locally; CI acceptance pending

Investigation baseline: `f38f6fe7c3e`

## Problem

The v4 tool-result `diagnostics` member has a closed four-key shape, but Java code constructs and consumes it through `Map<String, Object>`. Readers use string keys even though `RuntimeToolMeasurements` already defines and checks the envelope. This obscures the protocol and spreads casts across transport, reconciliation, and persistence.

The whole tool result must not become a fixed DTO: its content and the `measurements` payload remain dynamic JSON.

## Goals and non-goals

- Introduce one named `RuntimeToolMeasurements.Metadata` value for `protocolVersion`, `executionProtocol`, `measurements`, and `resultDigest`.
- Make attachment, acknowledgement, reconciliation, and persistence consume the typed value.
- Preserve the dynamic outer result and dynamic `measurements` payload.
- Preserve historical result JSON, digest calculation, error codes, and idempotent attachment behavior.

This change does not modify HTTP wire schemas, SQL, TypeScript, OpenAPI, or the shape of tool results. It does not add new validation to the values returned by `metadata(result)`; that method retains its current four-key-only check.

## Design

`Metadata` is a nested record with a `wireValue()` projection. Its components retain JSON values without coercing them during legacy reads, so a persisted value is not rejected merely because this refactor introduces Java field types. Values created by `attach` still have the established types: integer protocol fields and a lowercase hexadecimal digest string.

`wireValue()` emits the same four keys in the same order and uses `BrokerValues.immutableMap`, preserving recursive JSON immutability when the value is attached to a result. `metadata(result)` reads the closed key set and exposes named accessors instead of returning the raw map.

`ToolExecutionRecord.withMeasurements`, `ToolExecutionRepository.attachMeasurements`, and their JDBC implementations accept `Metadata`. Equality and idempotency continue to use `BrokerValues.sameJsonMap` over wire projections rather than record `equals`, because JSON numeric subtypes may differ after persistence.

`HttpRuntimeTransport.acknowledgeV4` reads `resultDigest()` and `RuntimeExecutionReconciler` passes `metadata(observed)` into the typed repository boundary. No consumer receives the record as a serialized object directly.

## Compatibility constraints

- `measurements` remains present even when null; the key is never omitted.
- `attach` still computes the digest over `{executionProtocol,result,measurements}` before constructing metadata.
- `metadata(result)` does not add protocol-version, digest-format, or payload-type validation.
- `withMeasurements` still rejects conflicting metadata and is idempotent for the same JSON values.
- Only `wireValue()` crosses back into result JSON or persistence.

## Files affected

Production changes are limited to `RuntimeToolMeasurements`, `ToolExecutionRecord`, `ToolExecutionRepository`, `JdbcToolExecutionRepository`, `JdbcToolExecutionObservations`, `RuntimeExecutionReconciler`, and `HttpRuntimeTransport`.

Existing v4 transport and reconciler tests are updated for named accessors. A focused value test covers explicit null, legacy value passthrough, closed keys, and immutable wire snapshots. Both Checkstyle executions and affected v4 transport/reconciliation tests form the local evidence; full Java, MySQL, Hosted, and fault profiles remain CI acceptance work.

## Implementation evidence

The focused suite passed 229/229 tests and compiled all production and verification test sources. Both Checkstyle executions reported zero violations for every module, including verification. The separate class-size run still reports the two pre-existing violations in `AgentSessionPolicies` and `AgentTurnExecution`; neither class is changed by this slice, and the failure is not counted as a pass. Full Java, MySQL, Hosted, fault, and archived profiles remain pending CI.

The complete production/test diff was audited for wire equality, JSON numeric comparison, null handling, and signature coverage. No TypeScript or SQL change was made.

## Acceptance criteria

1. All four metadata fields have named Java accessors and the dynamic result/payload types are unchanged.
2. Existing result JSON, digest bytes, error codes, and idempotent attachment behavior are preserved.
3. Focused v4 transport/reconciliation tests and both Checkstyle executions pass, or unrun evidence is explicitly reported as pending.
4. The complete small diff is audited before opening a separate PR.
