# 外部 Files 会话的 Turn 级宿主动作支持

[English](2026-11-28-external-files-turn-host-actions.md) | [简体中文](2026-11-28-external-files-turn-host-actions.zh-CN.md)

状态：[QwenLM/qwen-code#18578](https://github.com/QwenLM/qwen-code/issues/18578) 的实现候选。日期：2026-11-28。

## 问题与现状

运行 `hosted-workspace-external-files/1` 会话的嵌入宿主服务需要模型在获授权的特定 Turn 中调用一个归属宿主的动作——例如把当前 Turn 刚写入的文本作为评论发布到启动该 Turn 的宿主任务上，并在结束当前 Turn 前拿到生成的评论 ID。宿主已经在自身可信运行上下文中持有任务身份、CLI 可执行程序和任务级凭据（task-scoped credential）；这些凭据和可执行程序既不应下发给外部 Workspace Worker，也不应出现在模型参数中。

在 `dev/managed-agent@0f496b8a` 上，`hosted-workspace-external-files/1` 的所有扩展入口均处于关闭状态：

1. 外部会话创建策略（`ExternalWorkspaceSessionPolicies`）拒绝挂载扩展包 pin，并关闭会话级 MCP 与 hooks。
2. `POST /session/:id/client-files`（`configuration-routes.ts`）对外部 profile 直接返回 `409 hosted_client_files_profile_unsupported`，因为 `client-files` 是面向浏览器的会话级目录授权中继（`SERVER_ID = "local-files"`），而非可信宿主动作接口。
3. `HostedWorkspaceToolTurn` 拒绝外部 Files 的可选通道，只声明 `read_file`、`write_file`、`edit`、`glob` 以及可选的只读内容 `skill` 工具。
4. `ManagedAgentService` 与 `qwen-managed-agent-spring-boot-starter` 均未暴露 Turn 级宿主工具注册/执行接口，也缺少按 `(turnId, callId)` 归因的持久化回执账本用于中断响应对账。

## 目标与非目标

### 目标

- 允许嵌入宿主在创建带初始输入的外部 Files 会话或在外部 Files 会话上提交 Turn 时，为该 Turn 注册强类型的宿主动作声明（`HostTurnActionSpec`）。
- 通过 Spring 管理的 `HostTurnActionExecutor` SPI Bean 在宿主 JVM 内执行获授权动作：不新增 Spring MVC Controller、不向外部 Worker 暴露凭据或可执行程序、不改变普通 `hosted-workspace-files/1` 会话行为。
- 将每次调用及其结算结果持久化绑定到 `(sessionId, turnId, callId)`，使中断后的重试请求幂等重放而不产生重复副作用，并支持宿主对中断投递进行对账。
- 将结构化输出（如 `commentId`）连同 `(turnId, callId)` 归因返回给发起调用的原 Turn，使模型能在结束该 Turn 前读取结果。

### 非目标

- 在 `hosted-workspace-external-files/1` 上开放 `client-files`、会话级 MCP、hooks、Plan 模式或子 Agent。
- 修改 `#15512` 跟踪的 `hosted-workspace-external-shell/1` 及其存储与发布（publication）契约。
- 在外部 Workspace Worker 上执行宿主 CLI，或在 Managed Agent 数据库中持久化原始宿主凭据。

## 方案设计

### 1. 宿主 Java 契约与 SPI（`qwen-managed-agent-contracts`）

新增 `com.alibaba.qwen.code.managedagent.contracts.hostaction` 包：

- `HostTurnActionSpec(name, description, inputSchema, contextRef)`：
  - `name`：`[A-Za-z_][A-Za-z0-9_-]{0,63}`，禁止与所有内置 Hosted Workspace/Harness 工具名重名或使用 `mcp_` 前缀。
  - `description`：非空白 UTF-8 文本，最大 4096 字节，除 `\n` 和 `\t` 外不含控制字符。
  - `inputSchema`：严格 JSON Schema 对象（`type: "object"`、显式类型化 `properties`、可选 `required`、`additionalProperties` 默认强制为 `false`），最大 16 KiB。
  - `contextRef`：可选的不透明宿主关联标识（最长 512 字符），仅保存在控制面 `ma_turn.host_actions_json` 中，绝不发送给 Harness、模型或外部 Worker。
- `HostTurnActionInvocation(tenantId, sessionId, turnId, promptId, callId, actionName, contextRef, arguments)`：当获授权 Turn 调用 `actionName` 时传给宿主执行器。
- `HostTurnActionResult(isError, text, output)`：返回给模型并写入持久化回执的结构化工具响应。
- `HostTurnActionExecutor`：由宿主通过 Spring `@Bean` 实现的函数式接口（经 `ObjectProvider<HostTurnActionExecutor>` 解析，同时兼容独立服务、显式导入 `ManagedAgentConfiguration` 以及 `qwen-managed-agent-spring-boot-starter` 父子上下文）。
- `HostTurnActionReceipt(sessionId, turnId, promptId, callId, actionName, state, result, createdAt, updatedAt)`：供宿主对账读取的持久化执行记录。

`ManagedAgentService` 在 `createWorkspaceSession` 与 `submitTurn` 上新增接受 `List<HostTurnActionSpec>` 的重载，并提供 `listTurnHostActionReceipts` 查询指定 Turn 下已记录的 `(turnId, callId)` 执行回执。

### 2. 准入门禁、Schema 与能力协商

- 通过 Harness 能力特性 token `hosted-turn-host-actions/1` 进行版本协商。
- 仅在以下条件同时满足时准入非空 `hostActions`：
  1. 会话生效的 `toolProfile` 为 `hosted-workspace-external-files/1`；
  2. Runtime Broker 已启用且存在可用的 `HostTurnActionExecutor` Bean；
  3. 协商得到的 Harness 能力包含 `hosted-turn-host-actions/1`。
- 将规范化后的 `hostActions` 纳入命令 `requestDigest`，使复用幂等键但篡改动作定义的重试以 `409 idempotency_conflict` 拒绝。
- 在插入 `ma_turn` 行的同一事务中将冻结后的规格写入可空列 `ma_turn.host_actions_json`（`OCTET_LENGTH(host_actions_json) <= 65536`），消除 `submitTurn` 返回 `turnId` 与异步 Turn 派发之间的竞态。
- 执行回执写入现有 `ma_request_receipt` 表的新命名空间 `ReceiptNamespace.HOST_TURN_ACTION`（`scope_kind = 'SESSION'`，`idempotency_key = turnId + ":" + callId`），保持 V1 基线 38 张表数量不变。

### 3. Broker 回调、幂等与中断对账

- `SubmitHarnessTurn` 在 `POST /session/:id/prompt` 上携带脱敏后的 `hostActions`（仅含 `name`、`description`、`inputSchema`，剥离 `contextRef`）。
- `RuntimeBrokerHttpServer` 暴露 `POST /internal/runtime-broker/v1/harness-sessions/{sessionId}/host-actions/execute`，使用 Broker Bearer Token 鉴权，并校验 `ma_session_head` 中活跃的 `(sessionId, writerId, writerGeneration)` writer 租约围栏。由于 `EmbeddedRuntimeBroker` 在 `ManagedAgentConfiguration` 内部运行独立的回环 HTTP 监听器，Starter 宿主继续保持零 Spring MVC `@RestController` Bean。
- `JdbcHostTurnActionStore` 校验会话 profile、活跃 Turn 状态、动作授权与 JSON Schema 参数，并在单调用串行锁及 `ma_request_receipt` 协调下执行：
  - 若同一 `(turnId, callId)` 已有结算回执（`COMPLETED` 或 `FAILED`）且 `requestDigest` 一致，直接重放已保存的 `HostTurnActionResult`，不再二次调用 `HostTurnActionExecutor`。
  - 若同一 `(turnId, callId)` 的 `requestDigest` 不一致，以 `409 runtime_idempotency_conflict` 拒绝。
  - 当宿主动作执行完成但 HTTP 响应中断时，`HostedWorkspaceBroker` 的自动重试会命中已结算回执并将原始 `commentId` 返回给当前 Turn。

### 4. TypeScript Harness Turn 通道（`packages/cli/src/serve/`）

- `turn.ts` 与 `takeover-routes.ts` 仅在 `hosted-workspace-external-files/1` 上接受 `hostActions`，将其写入 `input.accepted` 的 `managed-admission` 资源，在重复 Prompt 重放时校验一致性，并传入 `HostedWorkspaceToolTurn`。
- `HostedWorkspaceToolTurn` 在外部 Files 上继续关闭 `mcp`、`hooks`、`shell`、`publication` 与 `client-files`；仅在携带 `hostActions` 的 Turn 上声明对应 `FunctionDeclaration`；按 `inputSchema` 校验模型入参；纯宿主动作批次跳过外部 Worker 预热与挂载获取；除非命中显式 `permissionRules` 的 `deny` 或 `ask`，否则按宿主预授权直接放行；并将 `{ ...output, turnId, callId, executionStatus }` 随 `tool_result` 持久化提交。

## 设计决策与理由

1. **采用独立的 Turn 级窄通道而非放宽 `client-files`**：`client-files` 是绑定 `local-files` 与 WebShell Controller 的会话级浏览器 SSE 中继；宿主动作则是按 Turn 授权、服务端可信的强类型回调，必须支持无 Controller 的 Starter 嵌入模式，且不影响未授权 Turn。
2. **在 Turn 准入时绑定不透明 `contextRef`**：异步 Turn 派发可能在 `submitTurn` 向调用方返回生成的 `turnId` 之前启动。将 `contextRef` 在 `ma_turn` 同一事务落盘，可让宿主在首次回调时确定性定位任务、CLI 与凭据，同时避免凭据进入数据库或传输层。
3. **复用 `EmbeddedRuntimeBroker` 与 `ma_request_receipt`**：通过 `/internal/runtime-broker/v1/harness-sessions/{sessionId}/host-actions/execute` 回调复用了既有内部监听器和 writer-generation 围栏，无需新增端口或 Spring MVC Controller，同时完整保留 38 张表的 Schema 基线契约。

## 验证与验收标准

- **普通 Files 回归门禁**：`hosted-workspace-files/1` 以及未传 `hostActions` 的外部 Files Turn 工具列表完全不变；外部 profile 调用 `POST /session/:id/client-files` 仍返回 `409 hosted_client_files_profile_unsupported`；`hosted-workspace-external-shell/1` 拒绝传入 `hostActions`。
- **授权 Turn 端到端/集成验收**：在注册了评论动作的外部 Files Turn 中，模型可正常写入工作区文件、仅凭评论正文调用宿主动作、在宿主侧完成带任务/运行归因的真实回调，并在同一 Turn 内收到匹配的 `commentId`，且外部 Worker 不会收到该动作调用。
- **中断响应对账验收**：模拟宿主动作落盘后响应中断，相同 `(promptId, callId)` 的重放请求命中 `ma_request_receipt`，宿主执行器仅运行一次，原始 `commentId` 正常返回该 Turn，且可通过 `ManagedAgentService.listTurnHostActionReceipts` 读取已结算的 `HostTurnActionReceipt`。
