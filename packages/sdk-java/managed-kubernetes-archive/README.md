# Managed Kubernetes Java Archive

Cold source archive of the Kubernetes Runtime, Resident Workspace / Workspace CSI,
and Kubernetes Harness Pool discovery Java sources extracted from
`packages/managed-agent-server`.

This directory is intentionally **not** wired into Maven or CI builds: the
corresponding CSI/Resident database columns, configuration bindings, and Broker
hooks have been removed from `packages/managed-agent-server`. TypeScript worker
counterparts under `packages/cli` remain untouched.

## Archived Layout

- `runtime-kubernetes/` — former `qwen-managed-agent-runtime-kubernetes` Maven
  module (`KubernetesRuntimeProviderFactory`, `KubernetesHttpRuntimeClient`,
  `ResidentWorkspaceProvisioner`, `WorkspaceCsiRuntimeProvisioner`,
  `WorkspaceCsiResourceGuard`, `ResidentWorkspaceReclamation`).
- `adapters/` — `KubernetesHarnessDiscovery` (EndpointSlice watcher for Hosted
  Harness pools).
- `contracts/` — Kubernetes SPIs (`KubernetesRuntimeSupport`,
  `KubernetesRuntimeClient`, `KubernetesMaintenanceClient`,
  `WorkspaceCsiRuntimeSpec`, `KubernetesNames`), Resident/CSI domain contracts
  (`ResidentWorkspace*`, `WorkspaceCsi*`, `PrivateCsiSession`,
  `ResidentReclamation`, `Csi*`, `ManagedCsi*`, `WorkerArtifact`,
  `ProtectionIdentity`, `Receipt`), and `csi-native-file-declarations.json`.
- `control-plane/` — `ResidentWorkspaceRetirementService`.
- `persistence/` — `ResidentWorkspace*`, `WorkspaceCsi*`, `JdbcCsi*`,
  `CsiNativeToolReservation`, `CsiPackRecords`, and `ManagedLegacySessionGuard`.
- `server/` — `WorkspaceCsiApplicationController`, `ResidentWorkspaceRetirementMain`,
  and `WorkspaceCsi*Main` maintenance entrypoints.
- `verification/` — dedicated unit tests, MySQL integration tests, fixtures, and
  test resources for Kubernetes Runtime, Resident Workspace, CSI, and Kubernetes
  Harness discovery.
- `deploy/k2-resident/` — former `deploy/k2-resident/` deployment example
  (`application.example.yaml` plus bilingual README) for the `kubernetes-workspace`
  provisioner and the `csi-protection` / `resident-retirement` maintenance commands.
  Cross-links from `deploy/kubernetes/README*`, `docs/users/managed-agent-reference-deployment*`,
  and the `docs/design/2026-10-*` K2 design records now point here.

## Removed Schema Elements (`V1__managed_schema.sql`)

When restoring or adapting these classes in an external repository, note the
following schema elements that were removed from `V1__managed_schema.sql`:

- `ma_session`: `runtime_request_key`, generated `is_csi_guard`,
  `idx_ma_session_csi_guard`, and the `is_csi_guard` arm of the
  `ck_ma_session_boolean_values` CHECK constraint.
- `ma_operation`: `operation_kind = 'CSI_RETIREMENT'`, `progress_format`,
  `progress_version`, `progress_stage`, `settlement_deadline_ms`,
  `frozen_request_bytes`, `frozen_request_sha256`, `cut_bytes`, `cut_sha256`,
  `finalize_receipt_bytes`, `finalize_receipt_sha256`, generated
  `csi_retirement_target_key`, and `uk_ma_csi_retirement_target`.
- `ma_operation_work`: `work_kind` values `'CSI_WORKER_ACK'`,
  `'POD_DELETE_ATTEMPT'`, and `'POD_FINALIZER_ATTEMPT'`.
- `ma_tool_execution`: `native_authorization_json`.
- `ma_storage_owner`: `csi_phase`, `csi_revision`, `csi_reservation_id`,
  `csi_registration_key`, `csi_registration_revision`, and
  `csi_provision_request_id`.

## Restoring the archive

The archive is cold: it is not compiled, and the live modules no longer expose
the hooks its classes call. Restoring the archived code into a live build
requires re-adding (or adapting) at least the following SPI and constructor
hooks:

- `RuntimeProviderDependencies.csiReservations()` — the default SPI accessor
  returning `WorkspaceCsiReservations`, removed from
  `contracts/src/main/java/com/alibaba/qwen/code/runtimebroker/spi/RuntimeProviderDependencies.java`,
  together with the server-side override in `EmbeddedRuntimeBroker` that
  constructed `WorkspaceCsiReservationStore` and wired the
  `ResidentWorkspaceCatalog`.
- `NativeCsiExecutionRepository` — archived at
  `contracts/src/main/java/com/alibaba/qwen/code/runtimebroker/NativeCsiExecutionRepository.java`;
  `JdbcRuntimeBindingRepository` must implement it again (its `implements`
  clause and the CSI execution/batch methods were removed).
- `RuntimeBrokerOperations.prepareCsiExecution`, `readCsiBatch` and
  `closeResidentHarnessSession` — the CSI execution, batch-read and resident
  Harness close operations removed from
  `contracts/src/main/java/com/alibaba/qwen/code/runtimebroker/RuntimeBrokerOperations.java`.
- The `ManagedAgentSettings` Resident getters: the
  `RuntimeBroker.ResidentWorkspace` view, `getResidentWorkspaces()`,
  `getResidentKubernetesApiUrl()`, `getResidentKubernetesTokenFile()` and
  `getResidentKubernetesCaFile()`.
- The `ManagedAgentSettings.HarnessPool` Kubernetes discovery getters:
  `getKubernetesApiUrl()`, `getKubernetesTokenFile()`, `getKubernetesCaFile()`,
  `getNamespace()`, `getServiceName()`, `getServiceUid()` and `getPortName()`,
  plus the `HarnessPoolConnector` mTLS requirement for `discovery=kubernetes`.
- The removed schema columns, generated columns, indexes and CHECK arms listed
  in the Removed Schema Elements section above, including the `is_csi_guard`
  arm of `ck_ma_session_boolean_values`.

`csi-native-file-declarations.json` ALSO remains live at
`packages/managed-agent-server/contracts/src/main/resources/`, because the
active TypeScript test `packages/cli/src/serve/hosted-csi-tool-turn.test.ts`
reads it from there. The archive copy under `contracts/` is the snapshot taken
at archive time; the live copy is the source of truth for the TS worker.
