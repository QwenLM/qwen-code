# 归档 Kubernetes Runtime、常驻 Workspace CSI 与 Kubernetes Harness 服务发现 Java 源码

[English](2026-11-13-managed-kubernetes-java-archive.md) | [简体中文](2026-11-13-managed-kubernetes-java-archive.zh-CN.md)

- **状态：** 已实现（Implemented）
- **日期：** 2026-11-13

## 问题背景

`packages/managed-agent-server` 此前同时包含 `runtime-kubernetes` 后端模块、跨模块耦合的常驻
Workspace / Workspace CSI 契约与数据库专属列、内部退役 HTTP/CLI 入口，以及基于 Kubernetes
`EndpointSlice` 的 Harness 池服务发现（`KubernetesHarnessDiscovery`）。当部署仅使用
`local-process`、`ssh-process`、`external-workspace` 或 `static` 运行时后端以及静态 Harness
池发现时，这些 Kubernetes 与 CSI 路径仍在主工程内保留了额外的数据库列、生成列索引、事务守卫
（`ManagedLegacySessionGuard`）、配置绑定与测试套件。

## 目标与范围边界

### 目标

1. 将与 Kubernetes Runtime（`runtime-kubernetes` / `kubernetes-workspace`）、常驻
   Workspace / Workspace CSI（`ResidentWorkspace*`、`WorkspaceCsi*`、`JdbcCsi*`、
   `ManagedCsi*`、`ManagedLegacySessionGuard`）及 Kubernetes Harness 池服务发现
   （`KubernetesHarnessDiscovery`）相关的全部 Java 生产源码、Java 测试与 Java 测试资源从
   `packages/managed-agent-server` 迁出至冷归档目录
   `packages/sdk-java/managed-kubernetes-archive/`。
2. 从 `V1__managed_schema.sql`、`ManagedSchemaContract`、`ManagedSchemaProjection` 与
   `ManagedSchemaRows` 中移除仅服务于 CSI / Resident / Kubernetes 的专属列、生成列、索引与
   `CHECK` 枚举分支。
3. 从 `ManagedAgentSettings`、`ManagedAgentProperties`、`configuration-descriptions.json`
   及自动生成的配置参考文档中移除对应的 Java 配置项。
4. 保持 `packages/managed-agent-server` 在剩余四个运行时后端模块（`runtime-local`、
   `runtime-external`、`runtime-ssh`、`runtime-static`）及 `static` Harness 池发现模式下干净编译与运行。

### 非目标

- 不修改或搬迁任何 TypeScript / JavaScript 代码（`packages/cli`、`packages/core`、
  `distribution/kubernetes` 或 `deploy/`）。
- 不将 `packages/sdk-java/managed-kubernetes-archive/` 接入 Maven 或 CI 构建
  （`packages/managed-agent-server` 依赖 `packages/sdk-java/qwencode`，且归档代码依赖的主工程
  CSI 钩子与 SQL 列已按设计一并移除）。

## 设计决策与理由

### 1. 在 `packages/sdk-java/managed-kubernetes-archive/` 下采用冷归档源码保留

`packages/managed-agent-server` 依赖需兼容 Java 11/17/21 的 `com.alibaba:qwencode-sdk`，而被剥离的
Kubernetes / CSI 类面向 Java 21、Spring Boot 以及已被精简的 `managed-agent-server` 内部模块与数据库列。
将迁出文件按原模块路径保存在 `packages/sdk-java/managed-kubernetes-archive/` 下（不放置顶层 `pom.xml`），
既完整保留了源码与历史参考，又不会引入 Maven 循环依赖或干扰 `packages/sdk-java` 构建。

### 2. 清理共享表专属列而非删除共用核心表

`ma_storage`、`ma_storage_owner`、`ma_runtime_slot`、`ma_runtime_binding`、
`ma_runtime_session`、`ma_tool_execution`、`ma_operation` 与 `ma_operation_work` 仍被
`local-process`、`ssh-process` 与 `external-workspace` 共同使用。本次仅移除 CSI / Kubernetes
专属列、生成列、索引与 `CHECK` 字面量：

- `ma_session`：`runtime_request_key`、`is_csi_guard`、`idx_ma_session_csi_guard`
- `ma_operation`：`'CSI_RETIREMENT'`、`progress_format`、`progress_version`、
  `progress_stage`、`settlement_deadline_ms`、`frozen_request_bytes`、
  `frozen_request_sha256`、`cut_bytes`、`cut_sha256`、`finalize_receipt_bytes`、
  `finalize_receipt_sha256`、`csi_retirement_target_key`、`uk_ma_csi_retirement_target`
- `ma_operation_work`：`'CSI_WORKER_ACK'`、`'POD_DELETE_ATTEMPT'`、`'POD_FINALIZER_ATTEMPT'`
- `ma_tool_execution`：`native_authorization_json`
- `ma_storage_owner`：`csi_phase`、`csi_revision`、`csi_reservation_id`、
  `csi_registration_key`、`csi_registration_revision`、`csi_provision_request_id`

### 3. 保留通用 Checkpoint 与规范化 JSON 辅助方法

非 CSI 组件（`ManagedCheckpointHistory`、`RuntimeToolMeasurements`、
`JdbcManagedExtensionRecordStore`、`ManagedActivityDiagnosticProjection` 与
`RuntimeBrokerHttpServer`）此前复用了挂在 `CsiNativeActivationProof` 上的严格 JSON/JSONL 解析、
资源引用摘要校验与 RFC 8785 规范化 JSON 序列化方法。这些通用方法现已内聚至 `contracts` 模块的
`ManagedCheckpointHistory` 与 `RuntimeToolMeasurements` 中，保持完全一致的边界限制与 Jackson 约束。

## 风险与约束

- 若外部环境仍配置 `qwen-managed-agent-runtime-kubernetes`、`provisioner=kubernetes-workspace`、
  `harness.pool.discovery=kubernetes` 或调用 `csi-*` / `resident-retirement` 运维入口，将按未知/不可用项
  fail-closed 拒绝。
- 后续若需在独立工程中恢复编译归档代码，需参照
  `packages/sdk-java/managed-kubernetes-archive/README.md` 补齐或适配上述已移除的数据库列与 SPI 钩子。

## 验证计划与验收标准

1. `packages/managed-agent-server` reactor 在移除 `runtime-kubernetes` 及全部归档类引用后完整编译全部生产与测试源码。
2. H2 聚焦验证套件（覆盖 schema catalog、模块架构、Runtime Provider 插件、配置绑定、checkpoint 历史、
   工具度量与 Harness 池发现）全部通过。
3. 两套 Checkstyle 规则（`checkstyle:check` 与 `checkstyle:check@runtime-broker-checkstyle`）零违规通过。
4. 配置参考文档生成校验（`scripts/generate-managed-agent-configuration-reference.mjs --check`）与
   CI workflow 元测试（`scripts/tests/sdk-java-workflow.test.js`、`scripts/tests/qwen-triage-workflow.test.js`）通过。
