# Managed Runtime 工具契约 v2

[English](2026-09-24-managed-runtime-tool-contract.md) | [简体中文](2026-09-24-managed-runtime-tool-contract.zh-CN.md)

状态：契约与 Java 工具 transport 已实现；worker 处理器及 Broker transport 接入留待后续完成

相关：#12380（Managed Agent 分阶段交付）、[2026-09-22-managed-runtime-attestation-contract.md](2026-09-22-managed-runtime-attestation-contract.md) 的 attestation 契约，以及 #12380 上本契约所答复的对账讨论。

## 1. 问题

owned Managed Runtime worker 目前只提供 attestation。在工具执行路径可以评审之前，必须先为 TypeScript worker 与 Java transport 一次性固定三个操作——`execute`、`status`、`cancel`——的线上形态，并满足恢复设计要求的证据规则：

- Runtime 从不接触 Broker 的执行 id；它按原始 `reference`（`sessionId`、`promptId`、`callId`、`argsDigest`）识别调用。
- 查询绝不能证明调用没有运行。记录缺失、超时或租约过期都不是证据，因此 `status` 以 200 回答 `unknown`，而不是 404 或 500。
- `status` 只读：它绝不进入 prepare 路径，不挂接会话，也不执行任何东西。

## 2. 范围

范围内：三个操作在路由清单中的契约声明、共享 schema 与共享 conformance fixtures，由 TypeScript 契约测试与 Java fixture 消费方共同验证。这些声明固定未来的线路契约，但不会让尚未实现的路由变得可访问。Java `HttpRuntimeTransport` 按本契约实现 `execute`、`status`、`cancel`。

范围外：真正服务这些路由的 worker 处理器、raw HTTP gate 放行、将 `HttpRuntimeTransport` 接为 `RuntimeTransport`，以及 `not_started_proven` 结果（需要持久回执存储）。每个处理器与对应的 gate 放行必须在后续同一变更中落地。

## 3. 设计

### 3.1 路由

三个操作都在 `OWNED_MANAGED_RUNTIME_ROUTES` 中声明，沿用 attestation 的纪律：`POST` 精确路径、协议版本 2、封闭 JSON 请求体、双向 `no-store`、先鉴权后解析，以及 lease id 与 epoch 请求头。`execute` 的请求上限为 256 KiB，使工具调用的 `input` 放得下；`status` 与 `cancel` 的请求上限为 16 KiB。每个操作的响应上限均为 1 MiB。更大的工具输出走产物交付通道，绝不进入这些信封。

fixture 的请求头对象封闭为五个协议头。这约束的是 fixture 声明，不限制客户端或中间层添加的普通 HTTP 头。负面用例通过显式的省略或替换指令构造。

声明清单不是 raw gate allowlist。在真实工具处理器挂载之前，`ownedManagedRuntimeRouteGate` 只放行精确的 attestation 路由，并对 `execute`、`status`、`cancel` 返回 404，即使其后方挂载了 Express 处理器也不例外。未来增加处理器时，必须在同一变更中扩展 gate admission。

### 3.2 请求

每个请求都是封闭对象：

- `execute`：`protocolVersion`、`reference`、`toolName`、`input`。
- `status`：`protocolVersion`、`reference`，以及可选的非负 `afterSequence` 游标。
- `cancel`：`protocolVersion`、`reference`。

reference 是 harness 分配的原始调用身份；Runtime 不会得知任何 Broker 侧标识。

### 3.3 响应

每个成功响应都是封闭对象，携带 `protocolVersion` 与 `state`（`prepared`、`executing`、`cancel_requested`、`settled`、`unknown` 之一）：

- `unknown` 表示该 Runtime 没有这个 reference 的记录。它返回 200，且不构成未执行的证据。
- `state` 为 `settled` 时必须携带 `result`，其他状态禁止携带；其中包含 `executionStatus`（`not_started`、`success`、`error`、`cancelled`）、`responseParts`，以及可选的 `error`（`message` 必填，`type` 可选）。
- `status` 可以额外携带 `lastSequence`——Runtime 自己的进度游标。目前 Broker 的查询路径不消费该游标。

本切片只固定 `responseParts` 为数组，有意把元素结构推迟到 worker 处理器与 Broker 接入切片。后续必须从实际工具结果路径推导结构（`ToolCallResponseInfo.responseParts` 使用 SDK `Part[]`），并在提供结果之前补齐共享一致性覆盖。fixture 中的文本 part 仅作示例，不定义新的 part 格式。`settled` 下的 `not_started` 是 Runtime 明确给出的终态；记录缺失仍须返回 `unknown`，绝不能据此推导 `not_started`。

失败沿用共享分类：401 凭据、400/413 协议、409 身份、404 不兼容。JSON 错误保留共享的稳定错误码；gate 的不兼容 404 为空响应体。错误码中的 attestation 名称不代表工具上限为 16 KiB：错误消息使用对应操作及其上限。

### 3.4 Conformance fixtures

`managed-runtime-tool-v2.fixtures.json` 与 attestation 套件同构：三条路由、一份身份，以及每个路由的 canonical 请求与覆盖成功形态和负面纪律的用例。`status` 与 `cancel` 的 `unknown-is-ok` 用例固定证据规则。Java 消费方固定路由契约、每个结局分类与封闭请求/响应字段集。

共享 schema 强制每个路由使用精确的请求字段集，canonical 请求与逐用例的 body 覆写都受此约束。它还要求每个 `ok` 用例都携带响应 body，要求且仅允许 `settled` 状态携带 `result`，并只允许 `status` 使用 `lastSequence`。每个路由恰好有一个 suite，信封上限与错误码词汇表固定。用例覆盖五种状态、四种执行结局、封闭的错误对象，以及不带游标的 status 请求。TypeScript 变异测试通过删除必填字段或加入路由不允许的字段，证明这些约束确实生效，并把声明 manifest 钉在 fixture 路由上。raw HTTP 测试另行证明，在处理器落地之前，gate 会拒绝全部三条已声明的工具路由。

## 4. 验证

在 `packages/cli` 运行 `npx vitest run src/serve/managed-runtime-attestation-contract.test.ts`，并在 `packages/sdk-java/runtime-broker` 运行 `mvn test -Dtest=ManagedRuntimeAttestationConformanceTest`。TypeScript suite 校验共享 fixtures、schema 变异用例，以及 raw gate 对未实现工具路由的拒绝；Java suite 消费同一批契约文件。

### 4.1 Java transport

`HttpRuntimeTransport` 在发送前校验调用方 reference 的键集。`execute` 的调用方 map 包含四个身份字段及 `toolName`、`input`；线上请求将后两者与 `reference` 分开。`status` 和 `cancel` 只发送四个身份字段，也允许复用同一个调用方 map。`session` 参数为未来的服务适配层保留，不发送给 Runtime，也不替换原始调用身份。

这个调用方 map 是 transport 请求，不是新的持久化身份格式。Broker 保存的 reference 仍是四字段身份。接入物理分发之前，服务适配层必须单独取得 `toolName` 和 `input` 并组装 transport 请求，不能把载荷加入 `reference_json` 或改变执行幂等性。

超过对应路由上限的请求在发送前被拒绝：`execute` 为 256 KiB，`status` 与 `cancel` 为 16 KiB。响应上限为 1 MiB，且必须带 `no-store` 与 JSON 响应头。解析强制信封、result、error 为封闭对象，协议版本为 2，状态与执行结局属于契约枚举，错误字符串非空，且仅在 settled 时必须携带 result。`lastSequence` 为可选非负整数，仅允许出现在 `status`。`execute` 要求结算并返回 result map；`status` 与 `cancel` 返回校验后的线上 map。共享错误码保持不变，错误消息标明操作与适用上限。服务端失败可重试，其他 HTTP 失败为终态。

在 `packages/sdk-java/runtime-broker` 运行 `mvn test` 和 `mvn checkstyle:check`。HTTP fixture 回放验证 canonical 请求、成功与 unknown 应答、畸形 reference 和响应、逐路由请求上限，以及超过 16 KiB 直至 1 MiB 的工具结果。worker 在处理器落地前仍拒绝工具路由。

## 5. 后续工作

- 为三个路由挂载真实的 worker 处理器，并在同一变更中扩展 raw gate admission（execute 提取）。
- 完成会话操作并将 `HttpRuntimeTransport` 接为 `RuntimeTransport`。按 §4.1 所述从已保存的 reference 之外单独提供 `toolName`/`input`，并端到端覆盖真实 Broker 分发。
- `UNKNOWN` 执行对账器已在 #12655 落地。其 transport 必须先校验 status 线上信封，再投影为 `{state, result}`（仅 `settled` 携带 `result`）。去掉 `protocolVersion` 与 `lastSequence`；Broker 拒绝额外字段，目前没有游标消费方。
- 对 Runtime 报告仍在运行的执行是否发送物理取消，有意推迟。
