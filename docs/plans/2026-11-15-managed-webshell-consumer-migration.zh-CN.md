# Managed Agent 切片 4b：WebShell 消费方迁移到 Public API 实施计划

[English](2026-11-15-managed-webshell-consumer-migration.md) | [简体中文](2026-11-15-managed-webshell-consumer-migration.zh-CN.md)

- 状态：**Implemented（2026-11-16：b0 `9aa0ffe001` / b1 `26f69b8064` / b2 `b5e062331e`）**
- 日期：2026-11-15
- 范围：`packages/managed-agent-server/**`（仅 b0 对齐批次）、`packages/web-shell/**`、`packages/cli/src/serve/**`、`scripts/**`
- 关联：落实 [切片 4/5 收敛设计](../design/2026-11-13-managed-agent-slices-4-5-convergence.zh-CN.md) 的 Step 4b；前置 [批4 Public 形状补齐计划](2026-11-15-managed-public-shape-enrichment.zh-CN.md) 已完成（提交 `3fdf1ed142`，OpenAPI 1.121.0）。
- 基线：分支 `feat/managed-agent-slice-4a-public-api-parity`，HEAD `3fdf1ed142`。

## 1. 目标与非目标

**目标**：把 web-shell 浏览器客户端、CLI 本地代理/引导、qualification 脚本从 WebShell RPC 表面（`/api/agent/web-shell/v1/**`，camelCase，POST .../query）切换到 Public REST 表面（`/v1/agents/**`，snake_case，Idempotency-Key 请求头），使 4c 可以删除 WebShell 表面而 UI 行为零回归。

**非目标**：

- 不删除任何 WebShell 服务端路由/record/schema（4c 的事）；b0 之后双表面并存且语义一致。
- 不改 `integration-tests/` 的 SSE 助手（它们测的是服务端双表面，4c 再迁）。
- 不改 data-agent 宿主仓库（S5-2）；不改 `managed-surface.txt`（b0 不加路由）。
- 不动 provider 视图模型与下游 ~100 个组件（边界适配吸收全部形状差异）。

## 2. 已锁定决策（2026-11-15 用户拍板）

| 编号   | 决策                                                                                                                                                                                                | 后果                                                                                                                                                                                                                                                                    |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-4b-1 | **服务端完整语义对齐**（b0）：PublicSession 新增 `latest_turn`；`publicTurn` 合成 `recovery_blocked`；既有 Public 能力标志补齐 WebShell 合取项（收紧过度广告）；4 条 worktree 路由补 OpenAPI 标签。 | Public 成为真语义超集，provider/下游零改动。收紧发生在 Public 尚无真实外部消费方时（data-agent 今天消费 WebShell DTO），修正的是非所有者看到按钮点击后 403 的过度广告。`active_turn` 语义不变（仅 ACTIVE turn），新字段 `latest_turn` 承载 WebShell `activeTurn` 语义。 |
| D-4b-2 | **生成器立即切 Public-only + 冻结 camelCase 类型**：把客户端代码引用的全部 `WebShell*` schema 从当前生成文件逐字冻结为客户端自有契约模块；别名与 provider 接口的引用改指冻结模块。                  | 4c 无 TS 类型工作；生成文件不膨胀；适配器对「Public wire 类型 → 冻结契约类型」做编译期检查映射。冻结名保留 `WebShell*` 历史名（零改名 churn），4c 可选改名。                                                                                                            |
| D-4b-3 | **三提交**：b0 服务端对齐 → b1 CLI 代理/脚本（纯增量，双前缀并存）→ b2 web-shell 生成器+客户端+全部单测/e2e。                                                                                       | 每步独立全绿可合入；b1 先行保证 b2 落地时真实浏览器链路（代理）已就绪。                                                                                                                                                                                                 |
| D-4b-4 | **边界适配在客户端内**：`java-managed-agent-client.ts` 的方法签名与返回类型（camelCase JavaAgent*/WebShell* 形状）不变；新增纯函数适配模块做 Public wire → 冻结契约的双向转换。                     | 13 个别名消费文件 + provider 接口 42 处引用只改 import 来源；~100 个下游视图模型文件零改动。                                                                                                                                                                            |
| D-4b-5 | **SSE 游标走 `after` query**（不用 Last-Event-ID 请求头）。                                                                                                                                         | CLI 代理无需新增头转发（现有签名 canonical 已覆盖 query）；客户端手写 SSE 循环本就显式传游标。                                                                                                                                                                          |

## 3. 已核实现状事实（实施时可直接引用，均经读码核实）

### 3.1 客户端与消费面

- 唯一 HTTP 边界：`packages/web-shell/client/components/managed/java-managed-agent-client.ts`（1482 行，`API_PREFIX='/api/agent/web-shell/v1'`，85 个公开方法）。**全部 85 个方法都有 Public 孪生路由，无缺口**；`readArtifactRange`/`openArtifactStream`/`artifactContent` 三个方法已经走 Public。
- 下游消费分层：`managed-agent-provider.ts`（视图模型接口，117 个文件 import）自身有 42 处生成 schema 引用；`JavaAgent*` DTO 别名只有 13 个文件消费；4 个 DTO 模块（extension/mcp-management/tool-result/side-query types）是生成 schema 的别名层，混用 `WebShell*` 与共享 `Managed*`/`Public*` 名。
- 时间戳约定：下游一律毫秒（`ManagedSessionNavigationRow.tsx:37-39` 直接 `new Date(updatedAt)`；event projector `at: event.createdAt`）。
- 能力标志：provider `toSessionSummary`（java-managed-agent-provider.ts:1121-1240）读 ~18 个 camelCase 布尔位 + `capabilities.diagnostics`（WebShell 派生字段 = tasks）+ `activeTurn.status==='recovery_blocked'` 推导 phase/recoveryBlocked/admittedAt。
- create 流程：provider `createSession`（:1029-1049）**要求 `result.turnId`**，不用 operationId；input 恒非空（`request.input ?? [{type:'input_text',text}]`）。submitPrompt/cancel 要求 `result.operationId`（Public TurnCommandAdmission 有 `operation_id` ✓）。
- `WebShellAdmission` 形状：`{sessionId, turnId?, status, replayed, operationId?, admissionStage?, deliveryState?}`——turnId/operationId 皆可选，允许从 PublicSession 合成。

### 3.2 形状差异总账

- **~37 个方法两侧 JSON 完全相同**（共享 record：SessionRecovery、ManagedDiagnostic*、ManagedExtension*、ManagedRuntimeSkill*、ManagedMcpManagement*、UserMessageSnapshot、PublicMcpCatalog、ToolResultResponse、ArtifactResponse、PublicSessionSkills），只改路径（个别改 verb/分支）。
- **~48 个方法需要形状适配**：snake→camel、信封映射、四个时间戳家族 ×1000。
- **时间戳审计（只有这四个家族是秒，其余全毫秒）**：
  | Public 字段 | WebShell 对应 | 证据 |
  | ---- | ---- | ---- |
  | `PublicSession.created_at/updated_at` | `createdAt/updatedAt` | ManagedAgentService.publicSession `/1000` vs webShellSession 原值 |
  | `PublicTurn.created_at/completed_at` | `WebShellTurn.submittedAt/completedAt`（注意改名） | publicTurn `/1000` vs webShellTurn 原值 |
  | `PublicEvent.created_at` | `WebShellEvent.createdAt` | publicEvent `/1000` |
  | `PublicItem.created_at/updated_at` | `WebShellItem.createdAt/updatedAt` | publicItem `/1000` |
  其余（PublicTask/ PublicTaskEvent/ PublicArtifact/ PermissionAction/ QuestionAction/ SideQuery/ PublicModelContext.observed_at/ SessionRecovery.nextRecheckAt/ client-files expires_at/ diagnostics 全部）两侧同值毫秒。序列号（sequence/revision/cursor）是无单位计数器，两侧同值。
- **部分 Public 路由请求体保持 camelCase**（不可 blanket-snake）：`RecoveryRecheckRequest{turnId}`、`ManagedMcpManagementCommand`、extension lookup `{kind,idempotencyKey}`/`{idempotencyKey}`、`SettingsCommand{expectedRevision,values}`、runtime-skill snapshot/import body、`UserMessageCommand`、`CreateSessionRequest.extensionPins`、extension octet-stream 的 query 参数 `packageDigest/manifest/metadata/extensionId`。`InputBlock.mime_type` 两侧皆 snake。
- **信封动物园**：`PublicList{object,data,has_more,next_cursor}`；`PublicItemList` 另加 `snapshot_through_sequence`（export/transcript-items 的 `items→data`）；`PublicTaskList` 另加 `active_child_count`；`PublicActionList` **无 object**；`SideQueryPage` 保留 `items`、无 has_more；worktree page 裸 `{data}`；`PublicWorkspaceList{object,data,default_workspace,has_more,next_cursor,capabilities}`（`workspaceDirectorySelection→directory_selection`）；workspace **create** 返回 `PublicWorkspaceSummary{workspace_id,…}` 而 list/get 返回 `{id,object:'agent.workspace',…}`；`PublicTranscript` 保留 `items/events`。
- **operation id 命名不一致**：`PublicCommandOperation.id`/`PublicContextCompressionOperation.id`/`PublicCwdOperation.id`，但 registration `PublicOperation.operation_id`、`PublicLifecycleOperation.operation_id`、extension `Operation.operationId`（camel 共享）。
- **replayed 位置**：rename/unarchive/create 移到 `X-Qwen-Idempotent-Replay` 响应头（CLI 代理 RESPONSE_HEADERS 已含 ✓）；action respond 新增该头；operations/admissions 仍在 body。
- **状态码两侧完全一致**（202/200 分布、错误信封 `{error:{code,message,request_id}}` 共享同一个 `ApiExceptionHandler`）。唯一行为差：create 幂等重放在会话已删除时 Public 404 vs WebShell 202 tombstone（见 §9）。
- **requestId 无 Public 对应**：请求里的 `requestId`（trace echo）直接丢弃；错误响应的 `request_id` 仍在（toHttpError 不受影响）。

### 3.3 SSE（服务端循环共享，差异只在 payload）

- `ManagedEventStreamService.stream()` 双表面共用：帧 `id:<sequence>`、`event:<type>`、心跳 `:keepalive`、resync 触发（游标低于 replay floor → 一帧无 id 的 `agent.session.resync_required` 后 complete）、`session.deleted` 终止、读授权复查——全部一致。
- 差异：data payload `PublicEvent`（snake、created_at 秒）vs `WebShellEvent`（camel、毫秒）；resync data `SessionResyncRequired{type,session_id,replay_floor_sequence,snapshot_through_sequence,action}` vs camel。事件名不变 → 客户端 corrupt-frame skip 策略（只跳 `item.output_text.delta`/`item.reasoning.delta`、连续 3 帧上限、skip 日志 1/50 限流）原样保留。
- 游标：WebShell POST body `afterSequence`；Public GET `after` query 或 `Last-Event-ID` 头（头优先，非法头 400 `invalid_event_cursor`）。**客户端今天从不发 Last-Event-ID**；重连由 `use-managed-session.ts:636-820` 驱动（bootstrap transcript.coveredSequence → lastEventId，逐帧推进，stream_gap 重读 transcript，3 次不前进 stall）。迁移：同一个数字传 `after=`（D-4b-5）。
- side-query 流：共享 1s 轮询 emitter，`event:snapshot`、`id:<resultRevision>`，**两侧都无游标参数**（afterRevision 仅客户端本地去重）；data 从 camel `Query` 变 snake `SideQuery`（时间戳毫秒不变）。客户端身份守卫（sessionId/queryId/resultRevision）在适配后的 camel 形状上运行 → 零改动。
- client-files 下行流：`event:request`、`id:<requestId>`（字符串），data `{requestId,payloadJson}` → `{request_id,payload_json}`；无游标，新流替换旧 emitter，500ms 服务端轮询 + 300s idle，bridge 250ms 重试 + ownsConnection 探针——全部一致，只改 verb/query/snake。

### 3.4 认证与代理

- `PublicSurface.covers()` 同时覆盖 `/v1/agents/**` 与 `/api/agent/web-shell/v1/**`——同一 SignatureAuthFilter/TrustedActorHeaderFilter/TenantContextFilter 链。**认证零服务端改动**。
- 浏览器从不签名：standalone 模式 bearer token（`/managed/boot` + `Authorization: Bearer`），gateway 模式 bearerAuth；签名在 CLI 代理 `signedManagedHeaders`（canonical 含 method/path/query/tenant/actor/timestamp/sha256(body)/**Idempotency-Key**，路径无关）。
- `mountManagedLocalWeb`（managed-local-web.ts）：mount 于 `['/api/agent/web-shell/v1', ARTIFACT_CONTENT]`；白名单正则只放行 WS 前缀 + 小写字母数字段；尾部 catch-all 对 `['/api/agent','/v1/agents','/internal/managed-session-store']` 404。转发请求头仅 content-type/accept/if-match/range；响应头白名单含 `x-qwen-idempotent-replay` ✓；body pipe（SSE 可用）；强制 no-store；重复 Idempotency-Key 头 400。
- `server.ts:2599-2605` 的 primary-listener guard 已含 `/v1/agents` ✓。
- Vite dev 代理已同时配 `MANAGED_AGENT_JAVA_ROUTE_PROXY='/api/agent/web-shell/v1'` 与 `MANAGED_AGENT_PUBLIC_ROUTE_PROXY='/v1/agents'`（同一 proxy 对象，vite-config.test.ts 钉住）→ dev 模式零改动。
- dev `?managedProvider=java` 走 trusted-header 直连（X-Qwen-Tenant-Id/X-Qwen-Actor-Id），Public 同样适用。

### 3.5 生成器与门禁

- `generate-managed-agent-api.mjs`：按 `tags.includes('WebShell')` 过滤、剥 planned op/param/property、剪不可达 schema、openapi-typescript 渲染；输出**已提交**的 `generated/managed-agent-api.ts`（7118 行）。
- **字节级 freshness 门禁**：`managed-agent-api.test.ts:12-17` 要求提交文件与新鲜渲染逐字节相等（web-shell 单测 lane）。批4 只改 Public only schema（WebShell 不可达）→ 生成文件未变 ✓。
- OpenAPI 标签盘点：Public Sessions 48 + Public Resources 63 = 111 op，无 planned；**4 条 Public worktree op 无标签**（sessionWorktreeOptions/Query/Inspect/Cleanup，OAS:8020-8235）→ b0 补 `Public Resources`。
- Public schema 的 planned property（生成器会剥）：`PublicSession.creation_operation_id/archived_at`、`PublicTurn.operation_id/admission_stage/delivery_state`、`SessionCapabilities.workspace_context`。
- `capability-parity.test.ts` 只读 `managed-surface.txt` + SERVE_CAPABILITY_REGISTRY，**对 4b 全程不敏感**（b0 不加路由，surface 文件不变）。

## 4. 批次 b0：服务端语义对齐（managed-agent-server，OpenAPI 1.121.0 → 1.122.0）

### 4.1 PublicSession.latest_turn（纯增量）

- `ApiModels.PublicSession` 追加 `@JsonProperty("latest_turn") PublicTurn latestTurn`（NON_NULL 省略）；`withRecovery`/`withWorktree` 携带。
- `publicSessions` 已读 `latestTurns`（批4 为 environment 事件引入）→ `latest_turn = publicTurn(latestTurns.get(id))`，零新查询。
- 语义：**最新 turn 不论状态**（镜像 WebShell activeTurn）；`active_turn` 保持仅 ACTIVE（既有 Public 消费方不受影响）。schema description 写明两者区别。
- OpenAPI：PublicSession 加 `latest_turn: {$ref: PublicTurn}`（optional，不进 required）。

### 4.2 publicTurn 合成 recovery_blocked（对齐已声明 enum）

照抄 webShellTurn 的状态公式（ManagedAgentService:1855-1860）：

```java
AgentStateStore.HARNESS_RECOVERY_BLOCKED.equals(turn.errorCode())
        && ("RUNNING".equals(turn.status()) || "ACCEPTED".equals(turn.status()))
        ? "recovery_blocked" : turn.status().toLowerCase(Locale.ROOT)
```

PublicTurn schema 的 status enum **已声明** recovery_blocked（OAS:12128-12138）——这是 mapper 对齐契约，不是新语义。影响 active_turn 与 latest_turn 两处。

### 4.3 既有能力标志补齐 WebShell 合取项（收紧）

在 `publicSession`/`publicSessions` 内（批4 已引入 lifecycleOwners/maySubmit/mayChangeContext/grants/executable，数据在手）：

| 标志                                  | 现状（保留 visible 等既有前缀） | 对齐后（= WebShell 公式）                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_close`                       | `visible && supportsClose`      | `visible && (workspace==null \|\| lifecycleOwner) && supportsClose`                                                                                                                                                                                 |
| `session_archive`/`session_unarchive` | `visible && retention`          | `visible && (workspace==null \|\| lifecycleOwner) && retention`                                                                                                                                                                                     |
| `session_delete`                      | `visible && supportsDelete`     | `visible && (workspace==null \|\| lifecycleOwner) && supportsDelete`                                                                                                                                                                                |
| `context_compression`                 | 非 actor 计算                   | `visible && approvalExecutable && compressionSupported && mayCompressContext(session,grants,executable,worktree) && compression.available()`（逐字镜像 webShellSession；candidateIds 需并入 `mayCompressShape` 会话，与 webShellSessions 完全一致） |
| `btw`/`recap`                         | `supportsSideQueries(session)`  | `(workspace==null \|\| maySubmit) && supportsSideQueries(session)`                                                                                                                                                                                  |

- `lifecycleOwner` 判定 = `session.workspace()==null || lifecycleOwners.contains(id)`（webShellSessions:1675 原样；unbound 恒 true）。
- **不加 `diagnostics`**：WebShell 的 diagnostics 是派生 accessor（=tasks），由客户端适配器映射 `diagnostics = tasks`，Public 契约保持干净。
- 批4 新增的 7 个 actor 标志不动（已与 WebShell 逐字一致）。
- OpenAPI：被对齐标志的 description 换为 WebShell 孪生的对应描述（sessionClose 等含 lifecycle owner 语义）；`SessionCapabilities.required` 不变。

### 4.4 标签与版本

- 4 条 worktree op 补 `"tags": ["Public Resources"]`。
- `info.version` 1.121.0 → 1.122.0；`check-contract-version` 校验。

### 4.5 b0 门禁更新

- `bothSurfacesReportTheSameSession`：加 `latest_turn ↔ activeTurn` 逐字段 parity（id↔turnId、created_at×1000↔submittedAt、status 含 recovery_blocked 合成）；既有 capabilities 字面量在该 unbound fixture 下值不变（unbound lifecycleOwner 恒 true），核对即可。
- `ManagedAgentSessionCapabilitiesTest`：批4 加的 Public 断言改为与 WebShell 完全相等（sessionClose/sessionDelete 现在含 owner 合取；contextCompression actor 作用域）；`publicAndWebShellViewsUseBindingCloseSupportAndKeepPrivateCsiUnavailable` 的 Public 期望值同步收紧。
- 四门禁 + 受影响套件 + Checkstyle 双 execution 全绿（§8）。
- **不加路由** → `managed-surface.txt` 不变，capture 只读校验即可。

## 5. 批次 b1：CLI 代理与脚本（packages/cli + scripts，纯增量）

### 5.1 managed-local-web.ts

- mount 前缀加 `'/v1/agents'`（保留 WS 前缀与 ARTIFACT_CONTENT，4c 再删 WS）。
- 白名单正则加 Public 分支。**已核实**：nodeId 是运维配置的任意有界字符串（`BrokerValues.requireId` 只查长度/非空），packageDigest 带裸 `sha256:` 前缀（Public publish 把 digest 移入路径），extensionId 为 `[a-z][a-z0-9-]{0,63}`。故 Public 段字符集放宽为 RFC 3986 unreserved + `:` + 百分号八位组（客户端对路径参数一律 encodeURIComponent）；**并前置 traversal 防护**：拒绝 `%2f`/`%5c`/`%2e`（任意大小写）与裸点段（`/./`、`/../`），否则上游规范化可把已签名路径解析进 `/internal`。测试用 `http.request` options 形式发原始路径（fetch 与 `http.request(url)` 会在客户端规范化点段、丢 fragment，测不到守卫）。
- catch-all 404 顺序不变（`/internal/managed-session-store` 与未列路径仍 404）；bare `/v1/agents`（无段）保持 404（客户端不用）。
- **不加 Last-Event-ID 转发**（D-4b-5：客户端用 after query；qualification 脚本直连 Java 不受代理限制）。
- Idempotency-Key 转发/签名/重复头 400、响应头白名单（含 x-qwen-idempotent-replay）、no-store、pipe——全部已就绪，零改动。

### 5.2 managed-local-serve.ts bootstrap

- `route = '/v1/agents/workspaces'`（:351），body `{display_name}`（snake），idempotencyKey 走 `signedManagedHeaders` 的 header 参数；响应 PublicWorkspaceSummary——核实 bootstrap 只读 ok/workspaceId 字段并适配（`workspace_id`）。

### 5.3 scripts/run-managed-harness-qualification.mjs + scripts/tests/managed-harness-qualification.test.js

- `workspaceFiles` 常量 → `/v1/agents/workspace-files`；workspace create → `POST /v1/agents/workspaces`（snake body + header key，读 `workspace_id`）。
- files query/read → GET + snake query（session_id/workspace_id/cwd_relative/directory/query/path/expected_scope_revision）；upload → POST `/workspace-files/uploads` + snake query；uploads query → GET `/workspace-files/uploads/{uploadId}`；响应字段 snake（scope_revision 等）。
- mock 测试的路由/HMAC canonical/payload 同步更新（canonical 验证逻辑本身不变）。

### 5.4 b1 测试

- `managed-local-web.test.ts`：既有 WS canonical 用例保留（代理仍放行 WS）；**新增** Public 路径用例（GET/POST/DELETE、query 签名、SSE pipe、Idempotency-Key 签名与重复头 400、白名单拒绝 /internal 与越界路径、nodeId 字符集）。
- `managed-web-serve.test.ts`：同步新增 Public 用例。
- `managed-local-serve.test.ts`：bootstrap create 期望改 Public。
- `node --test scripts/tests/managed-harness-qualification.test.js`。
- CLI vitest 需 worktree 已建 TS dist（globalSetup guard）：先在仓库根 `npm run build` 一次（b2 的 Playwright 也需要构建产物）；注意会话环境污染（必要时 `env -u QWEN_RUNTIME_DIR`）。

## 6. 批次 b2：web-shell 客户端迁移（packages/web-shell）

### 6.1 生成器切 Public-only

- 过滤改 `operation.tags?.some(t => t === 'Public Sessions' || t === 'Public Resources') && !isPlanned(operation)`；`webShellContract` 改名 `publicContract`（导出，测试同步）。
- planned 剥离与不可达剪枝逻辑不变。共享 schema（SessionRecovery、ManagedDiagnostic*、ManagedExtension*、ManagedRuntimeSkill*、ManagedMcpManagement*、UserMessage\*、PublicMcpCatalog、PublicToolResult/PublicArtifact/ToolResultResponse/ArtifactResponse、SideQuery 请求体等）由 Public op 可达 → 保留，**真实 casing 不动**（camel 的保持 camel）。
- 重生成并提交 `generated/managed-agent-api.ts`；freshness 测试改断 Public-only 语义 + 字节相等。
- **核实清单**：切换后生成文件里仍被客户端引用的共享名都在（尤其 `adapters/messageTypes.ts`、`ManagedActivityView.tsx` 用的 ManagedDiagnostic*/PublicToolResult）；消失的 `WebShell*` 名 = 冻结清单（§6.2）。

### 6.2 冻结 camelCase 契约模块

- 新文件 `client/components/managed/java-agent-contract-types.ts`：把客户端代码引用的**全部** `WebShell*` schema（请求+响应+嵌套，约 35-50 个类型）从当前生成文件（HEAD 3fdf1ed142 / OpenAPI 1.121.0 渲染产物）**逐字**拷贝为导出类型。文件头注释写明 provenance（冻结自哪个提交/契约版本、wire 已是 Public snake_case、本模块是客户端↔provider 的 camelCase 契约、4c 可选改名）。
- 冻结清单计算规则：grep 客户端代码全部 `Schemas['WebShell…']` 与生成文件 import 的 WebShell\* 名，减去切换后仍可达的名字。含请求类型（WebShellListRequest/WebShellCreateRequest/WebShellRenameRequest/WebShellTurnSubmitRequest/…）——**方法签名双向不变**（请求 camel进、响应 camel出）。
- 引用改指：`java-managed-agent-client.ts` 别名定义、`managed-agent-provider.ts` 42 处、4 个 DTO 模块的 WebShell* 别名 → 从冻结模块 import；共享名仍指生成文件。`index.tsx` 的 JavaAgent* re-export 不变。
- 验收：冻结类型与旧生成输出逐字一致（diff 核对）；typecheck 绿。

### 6.3 边界适配模块

- 新文件 `client/components/managed/java-managed-public-adapter.ts`：纯函数，签名 `(wire: Schemas['Public…']) => 冻结类型`，编译期检查每个字段映射。核心函数：
  - `publicSessionToJava`（PublicSession → WebShellSession 形状）：id→sessionId、last_event_id→lastSequence、created_at/updated_at ×1000、active_turn→activeTurn（**取 latest_turn**，id→turnId、created_at×1000→submittedAt、completed_at×1000→completedAt、error_code→errorCode）、capabilities snake→camel 全量 + `diagnostics = tasks`、workspace（PublicWorkspace→WorkspaceContext camel）、worktree（SessionWorktree snake→camel）、model_context/model_selection/lifecycle_operation snake→camel（observedAt 毫秒不动）、recovery 直传（camel 共享）、environment 直传（map 内部键两侧一致）、approval_mode/approval_revision/initial_approval_mode/plan_mode/plan_mode_supported snake→camel、compaction_revision/context_compression_operation_id snake→camel、metadata/title 直传。
  - `publicEventToJava`（×1000 created_at，snake→camel，data 直传）、`publicItemToJava`（×1000，content parts snake→camel）、`publicTurnToJava`。
  - 信封适配：PublicSessionList→WebShellSessionPage、PublicItemList→WebShellExportPage（data→items、snapshot_through_sequence→snapshotThroughSequence）、PublicTranscript→WebShellTranscript（covered_sequence/last_sequence/older_cursor/has_more snake→camel，items/events 逐条适配）、PublicTaskList→WebShellTaskPage（active_child_count→activeChildCount、id→taskId）、PublicActionList→WebShellActionPage、PublicArtifactList→WebShellArtifactPage（items 直传）、SideQueryPage→WebShellSideQueryPage（next_cursor→nextCursor）、PublicWorkspaceList→WebShellWorkspacePage（default_workspace→defaultWorkspace、capabilities snake→camel 含 directory_selection→workspaceDirectorySelection、item id→workspaceId）、PublicOperation oneOf→WebShellOperation union（各变体 id→operationId）、PublicCommandOperation→WebShellCommandOperation（action_resolution snake→camel）、TurnCommandAdmission→WebShellTurnAdmission、PublicSessionApproval/ApprovalChangeResult/SessionModels/ModelChangeResult/SessionOptions snake→camel、PublicToolDetails→WebShellToolDetails（shell_result→shellResult，NON_NULL 省略的 input/output 补 null 若冻结类型要求）、PublicFile*→WebShellWorkspaceFile*、PublicDirectory(Page)→WebShellWorkspaceDirectory(Page)、PublicNodePage→WebShellRuntimeNodePage、PublicOperation(registration)→WebShellWorkspaceCreateOperation（operation_id→operationId）、SessionWorktree*→WebShellSessionWorktree*、SideQuery→WebShellSideQuery（毫秒不动）、SessionResyncRequired→WebShellResyncRequired（camel）、PublicClientFiles\*→bridge camel 形状。
  - 请求适配：camel 请求 → Public query/body/header（按 §6.4 表；idempotencyKey body 字段 → Idempotency-Key 头；requestId 丢弃；保持 camel 的 body 原样传）。
- 适配模块独立单测：用**真实量级 epoch**（如 1790777114）做 wire fixture，断言 ×1000 与字段映射（防 createdAt:1 式双单位皆过的假绿）。

### 6.4 方法映射总表（85 个，实施 backbone）

约定：P = `/v1/agents`；hdr = Idempotency-Key 头；「直传」= 两侧 JSON 相同；适配函数见 §6.3。

**A. 直传组（37 个，只改路径/verb/分支）**

| 方法                                                     | Public 路由                                                                                                                                        | 备注                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| getRecovery                                              | GET P/sessions/{id}/recovery                                                                                                                       | SessionRecovery camel 共享                            |
| recheckRecovery                                          | POST P/sessions/{id}/recovery/recheck                                                                                                              | body {turnId} camel；202                              |
| getSessionSkills                                         | GET P/sessions/{id}/skills                                                                                                                         | JSON 全同                                             |
| getDiagnosticContextUsage                                | GET P/sessions/{id}/context-usage                                                                                                                  | 共享 JsonNode                                         |
| getDiagnosticStatistics                                  | GET P/sessions/{id}/stats                                                                                                                          | 同上                                                  |
| getActivityStatistics                                    | GET P/sessions/{id}/activity-stats                                                                                                                 | 同上                                                  |
| listActivity                                             | GET P/sessions/{id}/activity?kind=&cursor=&limit=                                                                                                  | kind 必填                                             |
| getDiagnosticResources                                   | GET P/sessions/{id}/resources                                                                                                                      | 同上                                                  |
| listDiagnosticAgentTrace                                 | GET P/sessions/{id}/agent-trace?cursor=&limit=                                                                                                     | 同上                                                  |
| getSessionMcp                                            | GET P/sessions/{id}/mcp-catalog                                                                                                                    | PublicMcpCatalog 共享                                 |
| queryMcpManagement                                       | GET P/sessions/{id}/mcp-management                                                                                                                 | requestId 丢弃                                        |
| submitMcpManagement                                      | POST P/sessions/{id}/mcp-management/commands                                                                                                       | hdr；body camel 直传                                  |
| getMcpManagementOperation                                | GET P/sessions/{id}/mcp-management/commands/{operationId}                                                                                          |                                                       |
| queryUserMessages                                        | GET P/sessions/{id}/user-messages                                                                                                                  | UserMessageSnapshot camel                             |
| commandUserMessages                                      | POST P/sessions/{id}/user-messages                                                                                                                 | hdr；raw Command camel                                |
| getToolResult                                            | GET P/sessions/{id}/items/{itemId}/tool-result                                                                                                     | ToolResultResponse 共享 snake                         |
| getArtifact                                              | GET P/sessions/{id}/artifacts/{artifactId}                                                                                                         | ArtifactResponse 共享                                 |
| readArtifactRange / openArtifactStream / artifactContent | 已 Public                                                                                                                                          | 零改动                                                |
| listExtensionPackages                                    | GET P/workspaces/{wid}/extensions                                                                                                                  |                                                       |
| getExtensionSettings                                     | GET P/workspaces/{wid}/extensions/{extId}/settings                                                                                                 |                                                       |
| importExtensionPackage                                   | POST P/workspaces/{wid}/extensions/imports?metadata&extensionId?                                                                                   | hdr 已有；query camel                                 |
| inspectExtensionPackage                                  | GET P/workspaces/{wid}/extensions/{extId}/packages/{packageRevision}/inspection?packageDigest=                                                     |                                                       |
| previewExtensionPackage                                  | POST P/workspaces/{wid}/extensions/imports/preview?metadata=                                                                                       |                                                       |
| lookupExtensionPackageOperation                          | POST P/workspaces/{wid}/extensions/operations/lookup                                                                                               | body {kind,idempotencyKey} camel（读操作无 hdr）      |
| lookupExtensionApplyOperation                            | POST P/sessions/{id}/extensions/operations/lookup                                                                                                  | body {idempotencyKey} camel                           |
| getRuntimeSkillCandidates                                | GET P/sessions/{id}/extensions/skills/candidates                                                                                                   |                                                       |
| snapshotRuntimeSkill                                     | POST P/sessions/{id}/extensions/skills/snapshot                                                                                                    | body camel                                            |
| importRuntimeSkill                                       | POST P/sessions/{id}/extensions/skills/imports                                                                                                     | hdr；body camel                                       |
| saveExtensionSettings                                    | POST P/workspaces/{wid}/extensions/{extId}/settings                                                                                                | hdr；{expectedRevision,values} camel                  |
| applyExtensionConfiguration                              | POST P/sessions/{id}/extensions                                                                                                                    | hdr；raw command camel（去 {sessionId,command} 包装） |
| resumeExtensionConfiguration                             | POST P/sessions/{id}/extensions/operations/{opId}/continue 或 /recover-previous                                                                    | 无 body                                               |
| getExtensionPackage                                      | GET P/workspaces/{wid}/extensions/{extId}/packages/{packageRevision}?packageDigest=                                                                |                                                       |
| publishExtensionPackage                                  | 有 extId → PUT P/workspaces/{wid}/extensions/{extId}/packages/{digest}?manifest=；无 → POST P/workspaces/{wid}/extensions?packageDigest=&manifest= | hdr 已有；100MiB 客户端守卫保留                       |
| queryExtensionConfiguration                              | 无 opId → GET P/sessions/{id}/extensions；有 → GET …/extensions/operations/{opId}                                                                  | 分支                                                  |

**B. 适配组（48 个）**

| 方法                           | Public 路由                                                                                              | 请求变化                                                                                                                             | 响应适配                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| listSessions                   | GET P/sessions?cursor=&limit=&archive_state=&title_query=                                                | body→query snake                                                                                                                     | PublicSessionList→WebShellSessionPage；行×1000                                                                                                            |
| getSession                     | GET P/sessions/{id}                                                                                      | path                                                                                                                                 | publicSessionToJava                                                                                                                                       |
| createSession                  | POST P/sessions                                                                                          | hdr；body snake（extensionPins 保持 camel；workspace:{workspace_id,cwd_relative}；worktree:{base_ref}）；requestId/metadata 处理见注 | **合成 WebShellAdmission**：sessionId=body.id、turnId=body.latest_turn?.id、status:'accepted'、replayed=X-Qwen-Idempotent-Replay 头；用 this.request 拿头 |
| renameSession                  | PATCH P/sessions/{id}                                                                                    | hdr；body {title}                                                                                                                    | 200 守卫保留；合成 WebShellRenameResult{sessionId:body.id,title:body.title,replayed:头}                                                                   |
| unarchiveSession               | POST P/sessions/{id}/unarchive                                                                           | hdr；无 body                                                                                                                         | publicSessionToJava（replayed 头如需）                                                                                                                    |
| lifecycleCommand close/archive | POST P/sessions/{id}/close、/archive                                                                     | hdr；无 body                                                                                                                         | PublicCommandOperation→WebShellCommandOperation（id→operationId）                                                                                         |
| lifecycleCommand delete        | DELETE P/sessions/{id}                                                                                   | hdr；无 body                                                                                                                         | 同上                                                                                                                                                      |
| submitTurn                     | POST P/sessions/{id}/events                                                                              | hdr；{type:'agent.session.input.message',input}（input 必填非空）                                                                    | TurnCommandAdmission→WebShellTurnAdmission                                                                                                                |
| cancelTurn                     | POST P/sessions/{id}/events                                                                              | hdr；{type:'agent.session.cancel',turn_id}                                                                                           | 同上                                                                                                                                                      |
| queryActions                   | GET P/sessions/{id}/actions?cursor=&limit=&include_children=                                             | body→query                                                                                                                           | PublicActionList→WebShellActionPage（毫秒不动）                                                                                                           |
| respondAction                  | POST P/sessions/{id}/actions/{actionId}/responses                                                        | hdr；response 对象去包装，answers 键 question_id/option_ids                                                                          | PublicCommandOperation→WebShellCommandOperation（action_resolution camel 化）                                                                             |
| queryOperation                 | GET P/sessions/{id}/operations/{operationId}                                                             | path                                                                                                                                 | PublicOperation oneOf→union（各变体 id→operationId）                                                                                                      |
| compressContext                | POST P/sessions/{id}/compress                                                                            | hdr；{expected_compaction_revision}                                                                                                  | PublicContextCompressionOperation→WebShell…（id→operationId）                                                                                             |
| listTasks                      | GET P/sessions/{id}/tasks?cursor=&limit=                                                                 | path+query                                                                                                                           | PublicTaskList→WebShellTaskPage（id→taskId，毫秒不动）                                                                                                    |
| getTask                        | GET P/sessions/{id}/tasks/{taskId}                                                                       | path                                                                                                                                 | PublicTask→WebShellTask                                                                                                                                   |
| listTaskEvents                 | GET P/sessions/{id}/tasks/{taskId}/events?after=&limit=                                                  | path+query                                                                                                                           | PublicList<PublicTaskEvent>→WebShellTaskEventPage                                                                                                         |
| cancelTask                     | POST P/sessions/{id}/tasks/{taskId}/cancel                                                               | hdr；无 body                                                                                                                         | PublicCommandOperation 适配                                                                                                                               |
| exportSnapshot                 | GET P/sessions/{id}/export?cursor=&limit=                                                                | path+query                                                                                                                           | PublicItemList→WebShellExportPage；items×1000                                                                                                             |
| getTranscript                  | GET P/sessions/{id}/transcript?cursor=&limit=                                                            | path+query                                                                                                                           | PublicTranscript→WebShellTranscript；items/events×1000                                                                                                    |
| getRecentTranscriptItems       | GET P/sessions/{id}/transcript/items?cursor=&limit=                                                      | path+query                                                                                                                           | PublicItemList→WebShellExportPage                                                                                                                         |
| listWorkspaces                 | GET P/workspaces?cursor=&limit=                                                                          | body→query                                                                                                                           | PublicWorkspaceList→WebShellWorkspacePage                                                                                                                 |
| getWorkspace                   | GET P/workspaces/{wid}                                                                                   | path                                                                                                                                 | PublicItem→WebShellWorkspace（id→workspaceId）                                                                                                            |
| createWorkspace                | POST P/workspaces                                                                                        | hdr；{display_name,source_workspace_id,cwd_relative,local_path}                                                                      | PublicWorkspaceSummary→WorkspaceSummary（workspace_id→workspaceId）                                                                                       |
| workspaceDirectories           | GET P/workspaces/directories?workspace_id=&cwd_relative= 或 local_path=                                  | body→query XOR                                                                                                                       | PublicDirectoryPage→WebShell…                                                                                                                             |
| listRuntimeNodes               | GET P/runtime-nodes                                                                                      | 无                                                                                                                                   | PublicNodePage→WebShellRuntimeNodePage                                                                                                                    |
| checkWorkspaceDirectory        | POST P/runtime-nodes/{nodeId}/check-directory                                                            | path+{path}                                                                                                                          | PublicDirectory→WebShellWorkspaceDirectory                                                                                                                |
| registerWorkspace              | POST P/workspaces/registrations                                                                          | hdr；{node_id,path,display_name}                                                                                                     | PublicOperation→WebShellWorkspaceCreateOperation（operation_id→operationId）；202                                                                         |
| getWorkspaceOperation          | GET P/workspaces/registrations/{operationId}                                                             | path                                                                                                                                 | 同上                                                                                                                                                      |
| queryWorkspaceFiles            | GET P/workspace-files?session_id=&workspace_id=&cwd_relative=&directory=&query=&expected_scope_revision= | body→query snake                                                                                                                     | PublicFileQueryResult→WebShell…                                                                                                                           |
| readWorkspaceFile              | GET P/workspace-files/content?…&path=                                                                    | body→query                                                                                                                           | PublicFileResult→WebShell…                                                                                                                                |
| uploadWorkspaceFile            | POST P/workspace-files/uploads?snake query                                                               | query 键 snake；octet-stream 不变                                                                                                    | PublicFileUploadResult→WebShell…                                                                                                                          |
| queryWorkspaceFileUpload       | GET P/workspace-files/uploads/{uploadId}                                                                 | path                                                                                                                                 | PublicFileUploadStatus→WebShell…                                                                                                                          |
| getSessionApproval             | GET P/sessions/{id}/approval                                                                             | path                                                                                                                                 | PublicSessionApproval→WebShell…                                                                                                                           |
| changeApproval                 | POST P/sessions/{id}/approval                                                                            | hdr；{approval_mode,expected_revision,plan_mode,permission_rules}                                                                    | PublicApprovalChangeResult→WebShell…                                                                                                                      |
| getSessionOptions              | GET P/session-options?agent_id=                                                                          | 必填 query                                                                                                                           | PublicSessionOptions→WebShell…                                                                                                                            |
| getSessionModels               | GET P/sessions/{id}/models                                                                               | path                                                                                                                                 | PublicSessionModels→WebShell…                                                                                                                             |
| changeModel                    | POST P/sessions/{id}/models                                                                              | hdr；{model_id,expected_revision}                                                                                                    | PublicModelChangeResult→WebShell…                                                                                                                         |
| getToolDetails                 | GET P/sessions/{id}/items/{itemId}/tool-details                                                          | path                                                                                                                                 | PublicToolDetails→WebShellToolDetails                                                                                                                     |
| worktreeOptions                | GET P/workspaces/{wid}/worktrees/options?cwd_relative=&base_ref=                                         | path+query（cwd_relative 可省默认 "."）                                                                                              | SessionWorktreeOptions→WebShell…（base_commit/current_branch snake）                                                                                      |
| listSessionWorktrees           | GET P/workspaces/{wid}/worktrees                                                                         | path                                                                                                                                 | SessionWorktreePage→WebShell…                                                                                                                             |
| inspectSessionWorktree         | GET P/workspaces/{wid}/worktrees/{worktreeId}                                                            | path                                                                                                                                 | SessionWorktreeInspection→WebShell…（can_cleanup/cleanup_blocker）                                                                                        |
| cleanupSessionWorktree         | POST P/workspaces/{wid}/worktrees/{worktreeId}/cleanup                                                   | hdr；无 body；202                                                                                                                    | SessionWorktree→WebShell…                                                                                                                                 |
| sideQueryContext               | GET P/sessions/{id}/side-queries/context                                                                 | path                                                                                                                                 | SideQueryContext→WebShell…                                                                                                                                |
| createSideQuery                | POST P/sessions/{id}/side-queries                                                                        | hdr；{kind,trigger?,question?,expected_content_version?,expected_main_input_boundary?}；200                                          | SideQuery→WebShellSideQuery（毫秒不动）                                                                                                                   |
| listSideQueries                | GET P/sessions/{id}/side-queries?cursor=&limit=                                                          | path+query                                                                                                                           | SideQueryPage→WebShell…（保留 items）                                                                                                                     |
| getSideQuery                   | GET P/sessions/{id}/side-queries/{queryId}                                                               | path                                                                                                                                 | SideQuery 适配                                                                                                                                            |
| cancelSideQuery                | POST P/sessions/{id}/side-queries/{queryId}/cancel                                                       | path；无 body 无 key；200                                                                                                            | 同上                                                                                                                                                      |
| streamSideQuery                | GET P/sessions/{id}/side-queries/{queryId}/events                                                        | path；afterRevision 仅本地去重                                                                                                       | 帧 data SideQuery→camel 后再过身份守卫/去重                                                                                                               |
| streamEvents                   | GET P/sessions/{id}/events?stream=true&after=                                                            | body afterSequence→after query                                                                                                       | 帧 PublicEvent→WebShellEvent（×1000）；resync→camel；skip 策略不变                                                                                        |
| clientFilesTransport           | base 改为 `${baseUrl}/v1/agents/sessions/{sessionId}`                                                    | 每会话 base（bridge 续接 /client-files/…）                                                                                           | 见 §6.6                                                                                                                                                   |

注：create 的 `metadata:{clientId}` Public 会持久化（WebShell 丢弃）——无害 widening，保留发送；`title`/`memoryStoreId`/`agentId` 映射 snake。

### 6.5 SSE 实施要点

- `streamEvents` 改 GET（accept: text/event-stream 已有），URL 带 `stream=true&after=<lastEventId>`；帧解析器（id/event/data/心跳/边界）零改动；`decodeEventFrame` 后插适配：PublicEvent→WebShellEvent（×1000 created_at），resync 帧→WebShellResyncRequired camel（provider 的 stream_gap.data 与合成占位帧形状不变）。
- id→sequence 覆盖逻辑保留（PublicEvent 有 sequence ✓）。
- 重连/resync/stall 逻辑在 use-managed-session，零改动。

### 6.6 client-files bridge（client/local-files/managed-client-files-bridge.ts）

- transport base 每会话化（§6.4）；bridge 的 `/client-files/{path}` 拼接保留。
- register：POST …/client-files/register body {connection_id}；ack snake→camel（server_id/generation/expires_at/tool_count/connection_id）。
- status：**GET** …/client-files?connection_id=；PublicStatus snake→camel；空绑定 200 空 body 语义不变。
- downlink：**GET** …/client-files/requests?generation=&connection_id=（两参必填）；帧 data {request_id,payload_json}→camel。
- responses：POST …/client-files/responses {generation,connection_id,rpc_request_id,response_json|error_code}；{settled} 不变；拒绝码读法不变。
- unregister：POST …/client-files/unregister {connection_id}。
- owned-fence/250ms 重试/300s idle/替换式重连全部不变。

### 6.7 provider 与下游零改动论证

- provider 读到的仍是冻结 camelCase 形状：时间戳毫秒（适配 ×1000）、capabilities camel + diagnostics（适配映射）、activeTurn = latest_turn 语义（含 recovery_blocked）、create 返回合成 admission（turnId 恒有：input 非空 → 初始 turn 必存在，重放时 latest_turn 是已结算初始 turn）。
- 唯一预期 provider 改动：**无**。若实施中发现残留缺口（如 stream_gap 消费方读 snake 字段），最小修复并记录。
- 下游 ~100 视图模型文件、event projector、use-managed-session：零改动。

## 7. 测试与夹具迁移（与 b2 同提交）

- **客户端单测**（java-managed-agent-client.test.ts ~60 URL 锚点、client-files.test.ts、provider.test.ts ~20 锚点、extension-import/mcp-management/tool-results/artifact-transport 测试）：fetch mock 改 emit **Public wire 形状**（snake、秒），断言客户端适配输出（camel、毫秒）与 Public URL/verb/header；gateway base-path 用例改 `/gateway/v1/agents/…`。
- **适配模块新单测**：真实量级 epoch fixture，逐字段断言（§6.3）。
- **bridge 测试**（managed-client-files-bridge.test.ts、useManagedLocalFilesBridge.test.tsx）：scripted HTTP peer 改 Public 路径/形状。
- **生成器测试**（managed-agent-api.test.ts）：publicContract 语义（Public-only、planned 剥离、可达剪枝）+ 字节 freshness。
- **ManagedStandaloneApp.test.tsx**：sessions/query 锚点 → GET /v1/agents/sessions；bearer/无签名头断言不变。
- **ManagedSessionsPage.test.tsx / ManagedLocalFilesControl.test.tsx**：bridge baseUrl 字符串更新。
- **vite-config.test.ts**：不变（双代理保留）。
- **Playwright 11 个 spec**：`page.route('**/v1/agents/**')` + snake payload + 秒时间戳 + 新路径后缀 dispatch；`e2e/fixtures/managed-workspace-w0d.tsx`（real provider + trusted headers）随客户端走；CI smoke 子集（ci.yml:2271,2623）必须绿。
- **夹具**：managed-agent-sse.test-fixtures.ts（扮演服务端的帧 → Public snake/秒）；managed-tool-result.java-fixture.json 与 diagnostics fixtures（共享 JSON 毫秒）不变；projector 测试输入是适配后 camel → 不变。
- **CLI/脚本测试**：见 §5.4（b1 已迁）。

## 8. 验证流水线与验收标准

### 8.1 每批次本地验证

- **b0**：隔离仓库 `/tmp/slice4a-b4-m2`（SDK 已装；新会话按 reference 记忆重建：`cp -Rc ~/.m2/repository /tmp/<task>-m2` + `mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install`）。在 packages/managed-agent-server：`mvn -Dtest='SurfaceRegistryGateTest,ManagedAgentApiContractTest,SurfaceAdmissionAcceptanceTest,ManagedSurfaceCaptureTest,ManagedAgentSessionCapabilitiesTest,ManagedExtensionRecordStoreTest,ManagedWorkspaceAdmissionTest' test` + `mvn checkstyle:check checkstyle:check@runtime-broker-checkstyle` + `node scripts/check-contract-version.js <(git show HEAD:…openapi.json) …openapi.json`（1.122.0）。
- **b1**：仓库根 `npm run build`（一次，供 CLI vitest dist guard 与 b2 Playwright）；`cd packages/cli && npx vitest run src/serve/managed-local-web.test.ts src/serve/managed-web-serve.test.ts src/serve/managed-local-serve.test.ts src/serve/capability-parity.test.ts`；`node --test scripts/tests/managed-harness-qualification.test.js`；CLI typecheck/lint。
- **b2**：`cd packages/web-shell && npm run generate:managed-agent-api && npm run test:ci`（含 freshness）；typecheck + lint + build；`npm run test:e2e:smoke`（Playwright smoke；本机无浏览器二进制则留 CI 并明示）；冻结类型与旧生成输出 diff 核对。
- 环境注意：qwen 会话内跑 TS 测试防父会话环境变量污染（必要时 `env -u QWEN_RUNTIME_DIR`）。

### 8.2 验收标准

1. 客户端/bridge/e2e/单测 mock 全部走 `/v1/agents/**`；`packages/web-shell/client` 无 `/api/agent/web-shell/v1` 运行时引用（注释除外）。
2. CLI 代理双前缀放行、签名 canonical 正确、SSE/Idempotency-Key/replay 头透传；bootstrap 与 qualification 脚本走 Public。
3. 生成文件 Public-only 且 freshness 绿；冻结类型与旧 WebShell 输出逐字一致；typecheck 全绿。
4. provider/下游视图模型零改动（diff 证明）；UI 行为 parity：时间戳渲染正常（真实 epoch 测试）、能力门控一致、SSE resume/resync/corrupt-skip 策略保留、client-files fence 保留。
5. 服务端 WebShell 表面完整保留（4c 删）；四门禁 + Checkstyle + contract-version 绿；managed-surface.txt 不变。
6. 完整 H2/SpotBugs/MySQL IT/Hosted profile、Playwright 全量、真实控制面 qualification 留 CI；CI 全绿前验收状态记待定。
7. 按 AGENTS.md 在 `.qwen/e2e-tests/` 写 E2E 测试计划（浏览器链路：create→stream→rename→approval→close；本地 dry-run = Playwright smoke + 代理单测；真实服务端 qualification 走 CI）。

## 9. 风险与开放项

1. **data-agent 宿主路由契约本仓不可证**（嵌入模式：注入自有 provider 或传 baseUrl；其 BFF/proxy 是否服务 `/v1/agents/**` 未知）。版本化 dist-managed-host bundle 解耦时序：4b 不阻塞，但**宿主升级 bundle 前必须确认**（注入 provider 模式不受影响直到其迁移 BFF；baseUrl 模式需服务 Public 路径——artifact-content 已是 Public，纯 WS-only 代理假设反证）。**4c 删 WebShell 硬阻塞于宿主迁移**（设计 S5-2 已锁定）。开放项：用户在 data-agent 仓库核实 ManagedRuntimeController 的挂载模式与代理路径。
2. **时间戳单位翻转是最高危静默回归**：适配只 ×1000 四家族；测试用真实量级 epoch（createdAt:1 式夹具双单位皆过，无防护力）。
3. **能力 casing/语义**：snake 泄漏 → undefined → canSend 全 false；服务端对齐 + 编译期检查适配兜底。
4. **代理白名单字符集**：nodeId 若含 `.`/`:` 需放宽（实施时核实 + 测试）。
5. **create 重放-after-delete**：Public 404 vs WebShell 202 tombstone——provider create 抛 404 错误（UI 错误提示），接受为边界行为并记录；不改 Public 语义。
6. **Public create 持久化 metadata/agentRevision**（WebShell 丢弃）：无害 widening，保留。
7. **requestId trace echo 丢弃**：X-Request-Id 改服务端生成；错误响应 request_id 仍在，toHttpError 不受影响。
8. **测试锚点面广**（~60 URL 断言 + 11 e2e spec + HMAC canonical + mock server）：与客户端同提交迁移，每批次全绿。

## 10. 提交计划

| 提交 | 内容                                                                                 | 消息（Conventional Commits）                                                                     |
| ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| b0   | §4 全部（Java + OpenAPI 1.122.0 + 门禁更新）                                         | `feat(managed-agent): align public session projection semantics with WebShell ahead of slice 4b` |
| b1   | §5 全部（CLI 代理双前缀 + bootstrap + qualification 脚本 + 测试）                    | `feat(cli): proxy and bootstrap the public managed agent surface for slice 4b`                   |
| b2   | §6 + §7 全部（生成器 Public-only + 冻结类型 + 客户端适配 + 全部 web-shell 测试/e2e） | `feat(web-shell): migrate the managed agent client to the public API`                            |

每提交独立全绿、可单独成 PR；不 push、不开 PR 除非用户指示。实施完成后更新本文档状态与切片 4/5 设计文档的 Step 状态（双语同步），并更新项目记忆。

## 11. 实施记录（2026-11-16）

- **b0** `9aa0ffe001`：§4 全部。820/820 Java 测试 + Checkstyle 0 violations + contract-version 1.122.0。另修复批4 遗留的 `Issue13181QueryBudgetTest` 陈旧预算 pin（public 页 unbound 3→6、bound 7→13、`ma_operation` 2→3；该套件不在批4 聚焦集内，批4 未 push 故 CI 未捕获）。
- **b1** `26f69b8064`：§5 全部。CLI vitest 235/235 + qualification mock 22/22 + typecheck/lint/Prettier。实施中发现并前置 `PUBLIC_TRAVERSAL` 守卫（拒 `%2f`/`%5c`/`%2e` 与裸点段，防上游规范化把签名路径解析进 `/internal`）。
- **b2** `b5e062331e`：§6+§7 全部，39 文件 +10325/−4683。web-shell 单测 574 文件 16106/16106；managed smoke 34/34（chromium，12 spec）+ 第 12 spec 非 smoke 用例 2/2；适配器新单测 18/18；tsc/ESLint/Prettier 全绿；W0D fixture test-compile 通过；106 个冻结类型与旧渲染逐字一致（程序化比对，仅 Prettier 引号/leading-pipe 格式差异）。
- **实施中的调整**：
  - rename 确认缺 title 时客户端返回 `''`（而非回退请求标题），保住 provider trim 守卫对异常确认的拒绝语义（WebShell 时代 title 必填）；测试改为 missing+empty 双探针。
  - 清单漏掉的第 12 个 managed e2e spec（`managed-local-files.spec.ts`，suffix dispatch 故未被 URL grep 命中）与 W0D Spring fixture 的 trusted-principal `urlPatterns`（补 `/v1/agents/*`）在 b2 一并迁移。
  - 两个非 managed e2e 失败（`web-shell.files` / `web-shell.remote-workspace-add`）经静态归因与 b2 无关：两 spec 仅 import `mockDaemon`（未改），b2 运行时改动全在 managed 专属模块且无模块级副作用——本机预存/环境问题。
  - mobile-webkit、Playwright 全量矩阵与真实控制面 qualification 留 CI（本机无 webkit 二进制）。
- **仍开放**：data-agent 宿主挂载模式/代理路径需宿主侧核实（升级 `dist-managed-host` bundle 前）；4c 硬阻塞于宿主迁移（S5-2）。
