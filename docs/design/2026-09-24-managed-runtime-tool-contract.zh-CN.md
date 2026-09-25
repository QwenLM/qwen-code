# Managed Runtime 工具契约 v2

[English](2026-09-24-managed-runtime-tool-contract.md) | [简体中文](2026-09-24-managed-runtime-tool-contract.zh-CN.md)

状态：契约已落地；worker 处理器与 Java transport 在后续切片挂载

相关：#12380（Managed Agent 分阶段交付）、[2026-09-22-managed-runtime-attestation-contract.md](2026-09-22-managed-runtime-attestation-contract.md) 的 attestation 契约，以及 #12380 上本契约所答复的对账讨论。

## 1. 问题

owned Managed Runtime worker 目前只提供 attestation。在工具执行路径可以评审之前，必须先为 TypeScript worker 与 Java transport 一次性固定三个操作——`execute`、`status`、`cancel`——的线上形态，并满足恢复设计要求的证据规则：

- Runtime 从不接触 Broker 的执行 id；它按原始 `reference`（`sessionId`、`promptId`、`callId`、`argsDigest`）识别调用。
- 查询绝不能证明调用没有运行。记录缺失、超时或租约过期都不是证据，因此 `status` 以 200 回答 `unknown`，而不是 404 或 500。
- `status` 只读：它绝不进入 prepare 路径，不挂接会话，也不执行任何东西。

## 2. 范围

范围内：三个操作的路由清单条目、共享 schema 与共享 conformance fixtures，由 TypeScript 的 raw-HTTP 门测试与 Java fixture 消费方共同验证。

范围外：真正服务这些路由的 worker 处理器（按路由清单规则，它们随挂载真实处理器的 execute 提取一起落地）、`HttpRuntimeTransport` 的 `execute`/`status`/`cancel` 实现，以及 `not_started_proven` 结果（需要持久回执存储）。

## 3. 设计

### 3.1 路由

三个操作都加入 `OWNED_MANAGED_RUNTIME_ROUTES`，沿用 attestation 的纪律：`POST` 精确路径、协议版本 2、封闭 JSON 请求体、双向 `no-store`、先鉴权后解析，以及 lease id 与 epoch 请求头。`execute` 的请求上限为 256 KiB，使工具调用的 `input` 放得下；每个操作的响应上限均为 1 MiB。更大的工具输出走产物交付通道，绝不进入这些信封。

### 3.2 请求

每个请求都是封闭对象：

- `execute`：`protocolVersion`、`reference`、`toolName`、`input`。
- `status`：`protocolVersion`、`reference`，以及可选的非负 `afterSequence` 游标。
- `cancel`：`protocolVersion`、`reference`。

reference 是 harness 分配的原始调用身份；Runtime 不会得知任何 Broker 侧标识。

### 3.3 响应

每个成功响应都是封闭对象，携带 `protocolVersion` 与 `state`（`prepared`、`executing`、`cancel_requested`、`settled`、`unknown` 之一）：

- `unknown` 表示该 Runtime 没有这个 reference 的记录。它返回 200，且不构成未执行的证据。
- 仅当 `state` 为 `settled` 时才携带 `result`；其中包含 `executionStatus`（`not_started`、`success`、`error`、`cancelled`）、`responseParts`，以及可选的 `error`（`message` 必填，`type` 可选）。
- `status` 额外携带 `lastSequence`——Runtime 自己的进度游标——使断线后对账的调用方可以前进而不重放。

失败沿用共享分类：401 凭据、400/413 协议、409 身份、404 不兼容，各带稳定的 `code`。

### 3.4 Conformance fixtures

`managed-runtime-tool-v2.fixtures.json` 与 attestation 套件同构：三条路由、一份身份，以及每个路由的 canonical 请求与覆盖成功形态和负面纪律的用例。`status` 与 `cancel` 的 `unknown-is-ok` 用例固定证据规则。Java 消费方固定路由契约、每个结局分类与封闭请求/响应字段集；TypeScript 侧用 schema 校验 fixtures、把 manifest 钉在 fixtures 上，并证明 owned-route 门恰好放行这些路径。

## 4. 验证

在 `packages/cli` 运行 `npx vitest run src/serve/managed-runtime-attestation-contract.test.ts`（54 个测试），在 `packages/sdk-java/runtime-broker` 运行 `mvn test -Dtest=ManagedRuntimeAttestationConformanceTest`（6 个测试），均通过。

## 5. 后续工作

- 为三个路由挂载真实的 worker 处理器（execute 提取）。
- 在 `HttpRuntimeTransport` 实现 `execute`、`status`、`cancel`。
- `UNKNOWN` 执行对账器消费 `status`（在 #12380 跟踪）。
- 对 Runtime 报告仍在运行的执行是否发送物理取消，有意推迟。

## 6. Worker 实现

合入的 attestation worker 现在在 `attest` 旁边挂载了这三个路由。其执行器恰好准入首版的普通工具——`read_file`、`write_file`、`edit` 与前台 `run_shell_command`——运行在以已证明的工作区 cwd 为根的真实 `Config` 之上，checkpointing 关闭。准入发生在 Harness 侧；worker 执行时不再有审批门。调用日志按构造只在内存中：worker 进程就是 Runtime 代数，重启即是新代数而非延续，对该进程从未见过的请求，`unknown` 才是诚实的应答。

契约之上的语义：

- `execute` 按 `reference.callId` 幂等：同一身份会并入在途调用或返回其已结算结果；同一 `callId` 携带不同摘要或负载则是 409 身份冲突。未准入的工具名同样是 409——它对本代数永远不合法。
- `status` 只读，对 Runtime 没有记录的 reference 以 200 回答 `unknown`；已知调用按其状态与日志的单调 `lastSequence` 应答。
- `cancel` 把 `prepared` 调用直接结算为 cancelled（不触碰工具），中止 `executing` 调用并回答 `cancel_requested`，此后幂等。Runtime 兑现的取消会把该调用结算为 `cancelled`——无论工具把中止表现为错误还是提前返回的结果。
- worker 的 HTTP `requestTimeout` 已停用，因为 `execute` 调用会持有连接直到结算；工具自身的超时管工具本身。headers 与 keep-alive 上限维持不变。

验证新增 `managed-runtime-tool-worker.test.ts`：在真实挂载的路由上用原始 HTTP 回放全部负面共享 fixture；行为用例覆盖在临时工作区真实执行 `read_file`、对未见过的 reference 回答 `unknown`、并入并发的重复 execute、以 409 拒绝同 callId 不同摘要的重试、拒绝未准入工具，以及取消一个在途的前台 shell 命令。

仍为后续工作：Harness 侧 `RuntimeBackedTool` 接线、文件历史结算、对已准入工具集合的 capability digest 校验、日志保留上限，以及大输出的产物交付通道。
