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

### 4.1 Java transport

`HttpRuntimeTransport` 按共享 fixtures 实现三个操作。调用方提供的 reference map 携带身份四元组外加 `toolName` 与 `input`；其他任何键在客户端即被拒绝，超过路由 256 KiB 上限的请求根本不会发出。响应按路由的 1 MiB 上限读取并严格解析：封闭字段集、协议版本 2、状态必须属于契约枚举、`result` 仅随 `settled` 出现、`lastSequence` 为非负整数。`execute` 要求 `settled` 并返回 result map；`status` 与 `cancel` 返回完整封闭 map。失败状态映射到共享分类，5xx 可重试、其余终态。fixture 驱动的测试在真实 HTTP 服务器上回放共享的 success 与 `unknown` 应答，并固定以下拒绝行为：未结算的 execute、无 result 的结算、`unknown` 携带 result、未知状态、超大输入；在 `packages/sdk-java/runtime-broker` 运行 `mvn test` 通过 122 个测试。

## 5. 后续工作

- 为三个路由挂载真实的 worker 处理器（execute 提取）。
- `UNKNOWN` 执行对账器消费 `status`（在 #12380 跟踪）。
- 对 Runtime 报告仍在运行的执行是否发送物理取消，有意推迟。
