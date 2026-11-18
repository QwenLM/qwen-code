# Managed Agent Server 切片 4 与 5 实施方案设计

[English](2026-11-13-managed-agent-slices-4-5-convergence.md) | [简体中文](2026-11-13-managed-agent-slices-4-5-convergence.zh-CN.md)

- 状态：**进行中（Step 4c；4a/4b 已完成）**
- 日期：2026-11-13
- 范围：`packages/managed-agent-server/**`、`packages/web-shell/**`、`packages/cli/src/serve/**`、`integration-tests/**`、`.github/workflows/**`、`scripts/**`
- 关联：落实投产前收敛方案中的切片 4 与切片 5；在 Step 5a 同步修订 [Managed Agent Server Maven modules](2026-10-29-managed-agent-maven-modules.zh-CN.md)。

## 问题陈述

在第一梯队投产前收敛合入后（`#17044`、`#17047`、`#17058`、`#17064`、`#17072`、`#17075`），`managed-agent-server` 仍存在两项主要结构性重复：

1. **双外部 API 表面并存（`Public` `/v1/agents/**`与`WebShell` `/api/agent/web-shell/v1/**`）。** `SurfaceRegistry` 声明了 92 条 `PUBLIC_*` 路由与 92 条 `WEBSHELL_*` 路由，背后由 `ApiModels` 中 22 个 `Public*`（`snake_case`）与 67 个 `WebShell*`（`camelCase`）记录以及 145 个 `WebShell*` OpenAPI schema 支撑。其中 63 条 `WEBSHELL_*` 路由已有 1:1 的 `PUBLIC_*` 孪生路由，但有 29 条 `WEBSHELL_*` 路由完全缺失 `/v1/agents/**` 对应接口（23 条）或仅非对称重叠（6 条），且 `PublicSession` 缺少交互态投影字段（`title`、`environment`、`approval_mode`、`model_selection`、`model_context`、`lifecycle_operation` 及交互能力布尔位）。
2. **微模块碎片化与单实现接口镜像。** Maven 反应堆拆分为 14 个模块，其中 7 个 `runtime-*` 模块未隔离任何专属第三方 SDK，`persistence` 与 `control-plane` 又被人为隔开并通过 `contracts` 通信，在 `ClassSizeRatchetTest` 与 `ModuleArchitectureTest` 推动下派生出 24 个只读 `*Settings` 镜像接口与约 28 个模块内单实现 `*Store`/`*Repository` 接口。

## 已锁定决策

| 编号 | 决策                                                                                                                                                                      | 后果                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S4-1 | 按 `4a -> 4b -> 4c -> 5a -> 5b` 分阶段推进，每步独立可验证、可合入。                                                                                                      | 避免难以评审的跨语言大爆炸 diff；Step 4a 对 `/v1/agents/**` 纯增不破。                       |
| S4-2 | `/v1/agents/**` 统一采用 REST + `snake_case` + `Idempotency-Key` 请求头；Turn 提交、取消与 SSE 事件流直接复用现有 `POST/GET /v1/agents/sessions/{sessionId}/events`。     | 不把 WebShell 的 `POST .../query` `camelCase` RPC 形态搬进 `/v1/agents/**`。                 |
| S5-1 | 直接删除 `ClassSizeRatchetTest`（及 `class-size-ratchet.properties`），并将 `runtime-external` 连同其余 `runtime-*` 模块一并归并入 `runtime-broker`，保留外部运行时能力。 | 消除类拆分导致的接口增殖，同时避免打断在途 `external-workspace` 开发（`#15684`、`#16023`）。 |
| S5-2 | 本轮不修改上层 `data-agent` 仓库，在本文中附上精确的宿主迁移对照表。                                                                                                      | `qwen-code` 先干净落地；`data-agent` 在升级嵌入式预览依赖版本时按表同步更新 import 与 DTO。  |

## 现状（基于 `7fb3668355` 核实）

- **路由：** `SurfaceRegistry` 共 208 个条目（`92` `PUBLIC`、`92` `WEBSHELL`、`24` `INTERNAL`）。
- **OpenAPI（`v1.117.0`）：** 168 个路径（`76` `/v1/**`、`92` `/api/agent/web-shell/v1/**`），315 个 schema（`145` `WebShell*`、`42` `Public*`）。
- **`qwen-code` 内 WebShell 下游消费方：** `packages/web-shell`（40 个文件；`generate-managed-agent-api.mjs` 按 `tags.includes('WebShell')` 过滤）、`packages/cli`（4 个本地代理文件）、`integration-tests`（2 个 SSE 辅助文件）、`scripts`（2 个验收脚本）、`verification/src/test`（41 个 Java 测试文件）。
- **Maven 模块：** 14 个模块（`contracts`、`control-plane`、`persistence`、`runtime-broker`、`runtime-http`、`runtime-host`、`runtime-local`、`runtime-external`、`runtime-kubernetes`、`runtime-ssh`、`runtime-static`、`adapters`、`server`、`verification`）。

## 目标与非目标

### 目标

- 在 Step 4a 使 `/v1/agents/**` 成为 `/api/agent/web-shell/v1/**` 的完整交互超集，Step 4b 切换前端与 TS 消费方，Step 4c 彻底删除 WebShell API 表面。
- 在 Step 5a 将 14 模块反应堆收敛为 6 个模块（`contracts`、`runtime-broker`、`control-plane`、`adapters`、`server`、`verification`），并在 Step 5b 消除 24 个 `*Settings` 镜像接口及模块内单实现仓储接口。
- 完整保留所有安全鉴权、持久化恢复、fencing 与宿主嵌入隔离不变量。

### 非目标

- 不修改 SQL 表结构（`V1__managed_schema.sql`）、Runtime Broker 传输协议代际（`v2`/`v3`/`v4`）或 `RuntimeBrokerHttpServer`。
- 本轮不直接改动 `data-agent` 仓库。

## 提议方案

### 分阶段实施计划

1. **Step 4a —— Public API 契约纯增补齐（`packages/managed-agent-server`、`packages/cli` 对齐门禁）：**
   - 扩充 `CreateSessionRequest`、`PublicSession`、`SessionCapabilities`、`PublicTaskList` 及 `WorkspaceDiscoveryController` 的 Public DTO（`snake_case`）。
   - 新增 25 条 REST 风格 `/v1/agents/**` 接口以覆盖全部 WebShell 独有及非对称能力（见下表），保持完全一致的 `RuleClass`、`Capability`、`TenantContext`（`actorId()` / `requireActorId()`）及 Service 层水平鉴权。
   - 递增 `managed-agent-public-api.openapi.json` 版本号（`1.117.0 -> 1.118.0`），在 `SurfaceRegistry` 注册 25 条路由，重生成 `managed-surface.txt`，并更新 `ManagedAgentApiContractTest` 与 `SurfaceAdmissionAcceptanceTest`。
   - **已完成（2026-11-15/16）**：批1–3（`b0c4c8fe34` / `5596d351d7` / `66054808ae`，1.118.0→1.120.0）+ 批4 形状补齐（`3fdf1ed142`，1.121.0）+ b0 语义对齐（`9aa0ffe001`，1.122.0：`latest_turn`、`recovery_blocked` 合成、能力合取对齐、worktree 标签）。
2. **Step 4b —— 消费方切换（`packages/web-shell`、`packages/cli`、`integration-tests`、`scripts`）：**
   - 将 `generate-managed-agent-api.mjs` 从 `WebShell` 切到 `Public` 操作集（`Public Sessions` / `Public Resources`），把 `java-managed-agent-client.ts`、`managed-client-files-bridge.ts`、单测、Playwright 夹具、CLI 本地代理与 SSE 集成辅助脚本迁移至 `/v1/agents/**`。
   - **已完成（2026-11-16）**：b1（`26f69b8064`，CLI 代理双前缀 + bootstrap + qualification 脚本）+ b2（`b5e062331e`，生成器 Public-only + 106 个冻结契约类型 + 85 方法边界适配 + 12 个 Playwright spec + 全部单测）。`integration-tests` 的 SSE 助手测试服务端双表面，按实施计划在 4c 迁移。详见 [4b 实施计划与记录](../plans/2026-11-15-managed-webshell-consumer-migration.zh-CN.md)。
3. **Step 4c —— 删除 WebShell 表面（`packages/managed-agent-server`、`packages/cli`）：**
   - 删除全部 92 条 `/api/agent/web-shell/v1/**` Controller 映射（`WebShellAgentController`、`WebShellSkillsController`、`ManagedToolDetailsController` WebShell 路由及双表面 WebShell 分支）、92 个 `WEBSHELL_*` `SurfaceRegistry` 常量、`ApiModels` 中 67 个 `WebShell*` record 与 145 个 `WebShell*` OpenAPI schema，并将 `verification/src/test` 中剩余 Java 测试迁至 `/v1/agents/**`。
4. **Step 5a —— Maven 模块合并（14 -> 6 个模块）与类大小棘轮移除：**
   - 将 `persistence` 并入 `control-plane`；将 `runtime-http`、`runtime-host`、`runtime-local`、`runtime-external`、`runtime-kubernetes`、`runtime-ssh`、`runtime-static` 并入 `runtime-broker`（合并 `META-INF/services/...RuntimeProviderFactory`）。
   - 删除 `ClassSizeRatchetTest` 与 `class-size-ratchet.properties`。
   - 同步更新 `ModuleArchitectureTest`、`ManagedAgentPackagingIT`、`RuntimeProviderPluginsTest`、`.github/workflows/{sdk-java,verify-maven-repo,sdk-java-flyway-open-prs}.yml`、`scripts/check-flyway-open-prs.js` 及工作流元测试；修订 `2026-10-29-managed-agent-maven-modules(.zh-CN).md`。
5. **Step 5b —— 消除 `*Settings` 镜像与模块内单实现仓储接口：**
   - 用纯 Java 配置 POJO（在 `server` 中通过 Spring Boot `@ConfigurationProperties` 绑定）替代 `ManagedAgentSettings`（21 个接口）与 `SshSettings`（3 个接口），保持 `contracts` 零 Spring 依赖。
   - 收敛 `control-plane` 内部约 28 个单实现 `*Store`/`*Repository` 接口，保留跨模块端口（`adapters`、`runtime-broker`、`server`）与真实宿主 SPI（`ManagedExtensionSource`、`ExtensionArchiveStorage`、`ToolPublicationObjectStore`、`MemoryProvider`）。

### 29 条非 1:1 WebShell 路由到 Public 路由完整映射（Step 4a）

#### A. 由现有 `/v1/agents/**` 接口直接覆盖（4 条——无需新增路由）

| WebShell 条目           | 现有 Public 接口                                                         | 说明                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSHELL_TURN_SUBMIT`  | `POST /v1/agents/sessions/{sessionId}/events` (`PUBLIC_TURN_EVENTS`)     | `type = "agent.session.input.message"`，`Idempotency-Key` 请求头，返回 `202 CommandAdmission`。                                                            |
| `WEBSHELL_TURN_CANCEL`  | `POST /v1/agents/sessions/{sessionId}/events` (`PUBLIC_TURN_EVENTS`)     | `type = "agent.session.cancel"`，必填 `turn_id`，`Idempotency-Key` 请求头，返回 `202 CommandAdmission`。                                                   |
| `WEBSHELL_EVENT_STREAM` | `GET /v1/agents/sessions/{sessionId}/events` (`PUBLIC_EVENT_LIST`)       | `stream=true` 或 `Accept: text/event-stream`，游标走 `Last-Event-ID` 或 `after`，推送 `PublicEvent`（`created_at` 秒级时间戳）与 `SessionResyncRequired`。 |
| `WEBSHELL_SESSION_MCP`  | `GET /v1/agents/sessions/{sessionId}/mcp-catalog` (`PUBLIC_MCP_CATALOG`) | 已返回相同的 `PublicMcpCatalog` JSON；对 `owner_only` 与绑定 Workspace 的会话同样校验 actor 归属。                                                         |

#### B. Step 4a 新增的 25 条 `/v1/agents/**` Public 接口

| `SurfaceRegistry` 常量                | HTTP 方法与路径                                                   | `RuleClass`                    | `Capability`                   | 鉴权与请求/响应摘要                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------- | ------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_CLIENT_FILES_REGISTER`        | `POST /v1/agents/sessions/{sessionId}/client-files/register`      | `CLIENT_FILES_OPERATOR`        | `CLIENT_FILES_REGISTER`        | `requireActorId()`；body `{connection_id}` -> `200 PublicClientFilesRegistrationAck`（`snake_case`、`no-store`）                                                                        |
| `PUBLIC_CLIENT_FILES_UNREGISTER`      | `POST /v1/agents/sessions/{sessionId}/client-files/unregister`    | `CLIENT_FILES_OPERATOR`        | `CLIENT_FILES_UNREGISTER`      | `requireActorId()`；body `{connection_id}` -> `200 PublicClientFilesStatus`（`no-store`）                                                                                               |
| `PUBLIC_CLIENT_FILES_STATUS`          | `GET /v1/agents/sessions/{sessionId}/client-files`                | `CLIENT_FILES_ACTOR`           | `CLIENT_FILES_STATUS`          | `requireActorId()`；query `connection_id` -> `200 PublicClientFilesStatus`（`no-store`）                                                                                                |
| `PUBLIC_CLIENT_FILES_STREAM`          | `GET /v1/agents/sessions/{sessionId}/client-files/requests`       | `CLIENT_FILES_ACTOR`           | `CLIENT_FILES_STREAM`          | `requireActorId()`；query `generation`、`connection_id` -> `200 text/event-stream`                                                                                                      |
| `PUBLIC_CLIENT_FILES_RESPOND`         | `POST /v1/agents/sessions/{sessionId}/client-files/responses`     | `CLIENT_FILES_ACTOR`           | `CLIENT_FILES_RESPOND`         | `requireActorId()`；body `{generation, connection_id, rpc_request_id, response_json, error_code}` -> `200 {settled}`                                                                    |
| `PUBLIC_RUNTIME_NODE_LIST`            | `GET /v1/agents/runtime-nodes`                                    | `RUNTIME_NODE_ACCESS`          | `RUNTIME_NODE_LIST`            | `requireActorId()`；`200 PublicRuntimeNodeList`（`no-store`）                                                                                                                           |
| `PUBLIC_WORKSPACE_DIRECTORY_CHECK`    | `POST /v1/agents/runtime-nodes/{nodeId}/check-directory`          | `RUNTIME_NODE_ACCESS`          | `WORKSPACE_DIRECTORY_CHECK`    | `requireActorId()`；body `{path}` -> `200 PublicSshDirectory`（`no-store`）                                                                                                             |
| `PUBLIC_WORKSPACE_REGISTER`           | `POST /v1/agents/workspaces/registrations`                        | `RUNTIME_NODE_ACCESS`          | `WORKSPACE_REGISTER`           | `requireActorId()`，`Idempotency-Key` 请求头；body `{node_id, path, display_name}` -> `202 PublicWorkspaceRegistrationOperation`                                                        |
| `PUBLIC_WORKSPACE_REGISTRATION_GET`   | `GET /v1/agents/workspaces/registrations/{operationId}`           | `WORKSPACE_REGISTRATION_OWNER` | `WORKSPACE_REGISTRATION_GET`   | `requireActorId()`；`200 PublicWorkspaceRegistrationOperation`（`no-store`）                                                                                                            |
| `PUBLIC_WORKSPACE_CREATE`             | `POST /v1/agents/workspaces`                                      | `WORKSPACE_ALLOCATION`         | `WORKSPACE_CREATE`             | `requireActorId()`，`Idempotency-Key` 请求头；body `{display_name, source_workspace_id, cwd_relative, local_path}` -> `200 PublicWorkspaceSummary`                                      |
| `PUBLIC_WORKSPACE_DIRECTORIES`        | `GET /v1/agents/workspaces/directories`                           | `WORKSPACE_ALLOCATION`         | `WORKSPACE_DIRECTORIES`        | `requireActorId()`；query `workspace_id`、`cwd_relative`、`local_path` -> `200 PublicWorkspaceDirectoryList`                                                                            |
| `PUBLIC_WORKSPACE_FILES_QUERY`        | `GET /v1/agents/workspace-files`                                  | `WORKSPACE_FILES`              | `WORKSPACE_FILES_QUERY`        | `requireActorId()`；query `session_id`、`workspace_id`、`cwd_relative`、`directory`、`query`、`expected_scope_revision` -> `200`（`snake_case`、`no-store`）                            |
| `PUBLIC_WORKSPACE_FILES_READ`         | `GET /v1/agents/workspace-files/content`                          | `WORKSPACE_FILES`              | `WORKSPACE_FILES_READ`         | `requireActorId()`；query `session_id`、`workspace_id`、`cwd_relative`、`path`、`expected_scope_revision` -> `200`（`snake_case`、`no-store`）                                          |
| `PUBLIC_WORKSPACE_FILES_UPLOAD`       | `POST /v1/agents/workspace-files/uploads`                         | `WORKSPACE_FILES`              | `WORKSPACE_FILES_UPLOAD`       | `requireActorId()`；`application/octet-stream`，query `session_id`、`workspace_id`、`cwd_relative`、`path`、`expected_scope_revision`、`upload_id` -> `200`（`snake_case`、`no-store`） |
| `PUBLIC_WORKSPACE_FILES_UPLOAD_QUERY` | `GET /v1/agents/workspace-files/uploads/{uploadId}`               | `WORKSPACE_FILES`              | `WORKSPACE_FILES_UPLOAD_QUERY` | `requireActorId()`；`200`（`snake_case`、`no-store`）                                                                                                                                   |
| `PUBLIC_SESSION_OPTIONS`              | `GET /v1/agents/session-options`                                  | `SESSION_OPTIONS`              | `SESSION_OPTIONS`              | `requireActorId()`；query `agent_id` -> `200 PublicSessionOptions`（`no-store`）                                                                                                        |
| `PUBLIC_SESSION_MODELS`               | `GET /v1/agents/sessions/{sessionId}/models`                      | `READER_ACTOR`                 | `SESSION_MODELS`               | `requireActorId()`；`200 PublicSessionModels`                                                                                                                                           |
| `PUBLIC_SESSION_MODEL_CHANGE`         | `POST /v1/agents/sessions/{sessionId}/models`                     | `OPERATOR`                     | `SESSION_MODEL_CHANGE`         | `requireActorId()`，`Idempotency-Key` 请求头；body `{model_id, expected_revision}` -> `200 PublicModelChangeResult`                                                                     |
| `PUBLIC_SESSION_APPROVAL`             | `GET /v1/agents/sessions/{sessionId}/approval`                    | `READER_ACTOR`                 | `SESSION_APPROVAL`             | `requireActorId()`；`200 PublicSessionApproval`                                                                                                                                         |
| `PUBLIC_SESSION_APPROVAL_CHANGE`      | `POST /v1/agents/sessions/{sessionId}/approval`                   | `OWNER`                        | `SESSION_APPROVAL_CHANGE`      | `requireActorId()`，`Idempotency-Key` 请求头；body `{approval_mode, expected_revision, plan_mode, permission_rules}` -> `200 PublicApprovalChangeResult`                                |
| `PUBLIC_SESSION_SKILLS`               | `GET /v1/agents/sessions/{sessionId}/skills`                      | `READER_ACTOR`                 | `SESSION_SKILLS`               | `requireActorId()`；`200 PublicSessionSkills`（`no-store`）                                                                                                                             |
| `PUBLIC_TRANSCRIPT`                   | `GET /v1/agents/sessions/{sessionId}/transcript`                  | `READER`                       | `TRANSCRIPT_QUERY`             | `actorId()`；query `cursor`、`limit` -> `200 PublicTranscript`                                                                                                                          |
| `PUBLIC_TRANSCRIPT_ITEMS`             | `GET /v1/agents/sessions/{sessionId}/transcript/items`            | `READER`                       | `ITEM_LIST`                    | `actorId()`；query `cursor`、`limit` -> `200 PublicItemList`                                                                                                                            |
| `PUBLIC_SESSION_EXPORT`               | `GET /v1/agents/sessions/{sessionId}/export`                      | `READER`                       | `ITEM_LIST`                    | `actorId()`；query `cursor`、`limit` -> `200 PublicItemList`                                                                                                                            |
| `PUBLIC_TOOL_DETAILS_GET`             | `GET /v1/agents/sessions/{sessionId}/items/{itemId}/tool-details` | `READER_ACTOR`                 | `TOOL_RESULT_GET`              | `requireActorId()`；`200 PublicToolDetails`（`private, no-store`）                                                                                                                      |

### `PublicSession` 与请求模型补齐（Step 4a）

- **`CreateSessionRequest`：** 增加可选字段 `title`、`approval_mode`、`plan_mode`、`model_id`，并统一标注 `extension_pins`。
- **`PublicSession`：** 增加可选字段 `title`、`environment`、`approval_mode`、`approval_revision`、`initial_approval_mode`、`plan_mode`、`plan_mode_supported`、`model_context`（`PublicModelContext`）、`model_selection`（`PublicModelSelection`）及 `lifecycle_operation`（`PublicLifecycleOperation`），在 `ManagedAgentService.publicSessions(records, actorId)` 中复用与 `webShellSessions` 相同的批量查询填充；`created_at` / `updated_at` 保持现有 Public API 的秒级时间戳约定。
- **`SessionCapabilities`：** 增加 `workspace_turns`、`cwd_change`、`model_change`、`approval_mode_change`、`input_attachments`、`rename`、`client_files`。
- **`PublicTaskList`：** 在 `GET /v1/agents/sessions/{sessionId}/tasks` 返回 `PublicTaskList`（`object = "list"`、`data`、`next_cursor`、`has_more`、`active_child_count`）。
- **`WorkspaceDiscoveryController`：** 为 `PublicItem` 补齐 `default_cwd_relative` 与 `can_select_directory`，为 `PublicCapabilities` 补齐 `workspace_creation`、`approval_mode_selection`、`directory_selection` 与 `local_directory_import`（`approval_mode_selection` 镜像 WebShell 的 `approvalModeSelection`；早期稿误作 `workspace_listing`）。

## 安全与所有权不变量

- 每条新增 `/v1/agents/**` 路由均受 `PublicSurface.covers(...)` 保护，强制执行 `SignatureAuthFilter` / `TrustedActorHeaderFilter` 与 `TenantContextFilter`（校验 `X-Qwen-Tenant-Id` 与 `AuthenticatedTenantActor` 作用域，不匹配返回 `403 actor_scope_mismatch`）。
- 每条路由直接委托给既有 `control-plane` 服务方法，保留 Service 层水平所有权校验（`checkAccess` / Workspace 授权 / Session Owner / Creator-only 规则），跨租户或越权探测统一返回 `404`。
- Workspace 文件路由（`PUBLIC_WORKSPACE_FILES_*`）声明 `RuleClass.WORKSPACE_FILES`，严格限定在已解析的 Workspace/Session 授权范围内，绝不回退到主运行时。

## 上层宿主（`data-agent`）迁移清单（按 S5-2 延后执行）

当 `data-agent`（`releases/20261112155816552_...`）在 Step 4c 与 5b 完成后升级依赖时：

1. **DTO 替换（`ManagedRuntimeController`、`ManagedRuntimeService` 及测试）：** 将 `ApiModels.WebShellSession`、`WebShellPage`、`WebShellSessionCapabilities`、`WebShellSessionModels`、`WebShellModelOption`、`WebShellModelChangeResult`、`WebShellSessionApproval`、`WebShellApprovalChangeResult`、`WebShellSessionSkills`、`WebShellSkill`、`WebShellRenameResult`、`WebShellCommandOperation`、`WebShellEvent`、`WebShellTranscript` 替换为对应的 `Public*` 类型（`snake_case` JSON 属性，`PublicSession`/`PublicEvent` 为秒级时间戳）。
2. **打包脚本（`.aoneci/managed-sdk/*/assemble-preview.py`）：** 更新模块数断言（`13 -> 5` 个生产 jar）及 schema 路径（`persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql` -> `control-plane/src/main/resources/db/managed-schema/V1__managed_schema.sql`）。
3. **内部 import 更新（29 个 Java 文件）：** 同步更新 Step 5b 收敛的 `control-plane` 内部仓储类型路径（`ManagedAgentProperties` 与 `@Import(ManagedAgentConfiguration.class)` 保持兼容）。

## 风险与约束

- **10 分钟本地 Java 验证预算：** 先一次性完成 Step 4a 的全部源码、OpenAPI 与测试更新，再集中运行聚焦 Maven 检查（`SurfaceRegistryGateTest`、`ManagedSurfaceCaptureTest`、`ManagedAgentApiContractTest`、`SurfaceAdmissionAcceptanceTest`、Checkstyle）。
- **OpenAPI 版本唯一性：** 单调递增 `info.version`（`1.117.0 -> 1.118.0`），并通过 `check-contract-version` 校验。

## 验证计划与验收标准

- **Step 4a 本地验证：**
  - `ManagedSurfaceCaptureTest`（先 `-Dcapability.parity.capture=true` 捕获，再只读校验）、`SurfaceRegistryGateTest`、`ManagedAgentApiContractTest`、`SurfaceAdmissionAcceptanceTest` 以及全模块 `checkstyle:check`。
  - CLI 对齐测试：`cd packages/cli && npx vitest run src/serve/capability-parity.test.ts`。
  - 契约版本检查：`git diff HEAD` + `check-contract-version` 脚本校验。
- **完整门禁：** 完整单元/H2 套件、SpotBugs、MySQL 8.4 集成测试与 Hosted Profile 留归 CI 执行；在所需 CI 门禁全部通过前，验收状态记为待定。
