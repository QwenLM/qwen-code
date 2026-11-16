# Archiving Kubernetes Runtime, Resident Workspace CSI, and Kubernetes Harness Discovery Java Sources

[English](2026-11-13-managed-kubernetes-java-archive.md) | [简体中文](2026-11-13-managed-kubernetes-java-archive.zh-CN.md)

- **Status:** Implemented
- **Date:** 2026-11-13

## Problem Statement

`packages/managed-agent-server` previously bundled the `runtime-kubernetes`
backend module alongside cross-cutting Resident Workspace / Workspace CSI
contracts, SQL persistence columns, internal retirement HTTP/CLI surfaces, and
Kubernetes `EndpointSlice` Harness pool discovery (`KubernetesHarnessDiscovery`).
Maintaining those Kubernetes and CSI paths inside `managed-agent-server` kept
extra database columns, generated indexes, transaction guards
(`ManagedLegacySessionGuard`), configuration bindings, and verification suites on
the critical path even when deployments run `local-process`, `ssh-process`,
`external-workspace`, or `static` runtime backends with static Harness pool
discovery.

## Goals and Scope Boundaries

### Goals

1. Move all Java sources, Java test suites, and Java test resources specific to
   Kubernetes Runtime (`runtime-kubernetes` / `kubernetes-workspace`), Resident
   Workspace / Workspace CSI (`ResidentWorkspace*`, `WorkspaceCsi*`, `JdbcCsi*`,
   `ManagedCsi*`, `ManagedLegacySessionGuard`), and Kubernetes Harness pool
   discovery (`KubernetesHarnessDiscovery`) out of `packages/managed-agent-server`
   into a cold source archive at `packages/sdk-java/managed-kubernetes-archive/`.
2. Remove the CSI/Resident/Kubernetes-only columns, generated columns, indexes,
   and `CHECK` enum values from `V1__managed_schema.sql`,
   `ManagedSchemaContract`, `ManagedSchemaProjection`, and `ManagedSchemaRows`.
3. Remove the corresponding Java configuration properties from
   `ManagedAgentSettings`, `ManagedAgentProperties`,
   `configuration-descriptions.json`, and generated configuration reference docs.
4. Keep `packages/managed-agent-server` building cleanly with four runtime
   backend modules (`runtime-local`, `runtime-external`, `runtime-ssh`, and
   `runtime-static`) and `static` Harness pool discovery.

### Non-Goals

- Modifying or moving TypeScript / JavaScript code (`packages/cli`,
  `packages/core`, `distribution/kubernetes`, or `deploy/`).
- Wiring `packages/sdk-java/managed-kubernetes-archive/` into Maven or CI builds
  (`packages/managed-agent-server` depends on `packages/sdk-java/qwencode`, and
  the archived classes target schema columns and hooks intentionally removed from
  `managed-agent-server`).

## Design Decisions and Rationale

### 1. Cold Source Archive Under `packages/sdk-java/managed-kubernetes-archive/`

`packages/managed-agent-server` depends on `com.alibaba:qwencode-sdk`, which
must compile across Java 11/17/21, whereas the extracted Kubernetes/CSI classes
target Java 21, Spring Boot, and internal `managed-agent-server` modules whose
CSI hooks and SQL columns are being removed. Preserving the extracted files
under `packages/sdk-java/managed-kubernetes-archive/` (without a top-level
`pom.xml`) retains full source history and reference implementations without
introducing circular Maven dependencies or perturbing `packages/sdk-java` builds.

### 2. Shared Schema Cleanup Rather Than Dropping Shared Tables

`ma_storage`, `ma_storage_owner`, `ma_runtime_slot`, `ma_runtime_binding`,
`ma_runtime_session`, `ma_tool_execution`, `ma_operation`, and
`ma_operation_work` remain active for `local-process`, `ssh-process`, and
`external-workspace`. Only CSI/Kubernetes-specific columns, generated columns,
indexes, and `CHECK` literals are removed:

- `ma_session`: `runtime_request_key`, `is_csi_guard`, `idx_ma_session_csi_guard`
- `ma_operation`: `'CSI_RETIREMENT'`, `progress_format`, `progress_version`,
  `progress_stage`, `settlement_deadline_ms`, `frozen_request_bytes`,
  `frozen_request_sha256`, `cut_bytes`, `cut_sha256`, `finalize_receipt_bytes`,
  `finalize_receipt_sha256`, `csi_retirement_target_key`,
  `uk_ma_csi_retirement_target`
- `ma_operation_work`: `'CSI_WORKER_ACK'`, `'POD_DELETE_ATTEMPT'`,
  `'POD_FINALIZER_ATTEMPT'`
- `ma_tool_execution`: `native_authorization_json`
- `ma_storage_owner`: `csi_phase`, `csi_revision`, `csi_reservation_id`,
  `csi_registration_key`, `csi_registration_revision`, `csi_provision_request_id`

### 3. Retaining Generic Checkpoint and Canonical JSON Helpers

Non-CSI components (`ManagedCheckpointHistory`, `RuntimeToolMeasurements`,
`JdbcManagedExtensionRecordStore`, `ManagedActivityDiagnosticProjection`, and
`RuntimeBrokerHttpServer`) previously called strict JSON/JSONL parsing,
resource-reference verification, and RFC 8785 canonical JSON serialization
helpers co-located on `CsiNativeActivationProof`. Those generic helpers now live
on `ManagedCheckpointHistory` and `RuntimeToolMeasurements` in `contracts` with
identical validation limits and Jackson constraints.

## Risks and Constraints

- External consumers that previously relied on `qwen-managed-agent-runtime-kubernetes`,
  `provisioner=kubernetes-workspace`, `harness.pool.discovery=kubernetes`, or the
  `csi-*` / `resident-retirement` admin entrypoints will fail closed if those
  options are configured.
- Restoring the archived sources into a live build later will require re-adding
  or adapting the removed schema columns and SPI hooks documented in
  `packages/sdk-java/managed-kubernetes-archive/README.md`.

## Validation Plan and Acceptance Criteria

1. `packages/managed-agent-server` reactor compiles all remaining modules and
   test sources without `runtime-kubernetes` or any reference to archived
   Kubernetes/Resident/CSI classes.
2. Focused H2 verification suites covering schema catalog, module architecture,
   runtime provider plugins, configuration binding, checkpoint history, tool
   measurements, and Harness pool discovery pass.
3. Both Checkstyle executions (`checkstyle:check` and
   `checkstyle:check@runtime-broker-checkstyle`) pass with zero violations.
4. Configuration reference generator check
   (`scripts/generate-managed-agent-configuration-reference.mjs --check`) and
   workflow meta-tests (`scripts/tests/sdk-java-workflow.test.js` and
   `scripts/tests/qwen-triage-workflow.test.js`) pass.
