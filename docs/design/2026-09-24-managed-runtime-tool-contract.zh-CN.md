# Managed Runtime 工具契约 v2

[English](2026-09-24-managed-runtime-tool-contract.md) | [简体中文](2026-09-24-managed-runtime-tool-contract.zh-CN.md)

状态：契约、worker 处理器与 Java 工具 transport 已实现；Broker transport 接入仍为后续工作

相关：#12380（Managed Agent 分阶段交付）、[2026-09-22-managed-runtime-attestation-contract.md](2026-09-22-managed-runtime-attestation-contract.md) 的 attestation 契约，以及 #12380 上本契约所答复的对账讨论。

## 1. 问题

owned Managed Runtime worker 在 attestation 之外增加三个工具操作——`execute`、`status`、`cancel`。TypeScript worker 与 Java transport 共享同一份线上契约，并满足恢复设计要求的证据规则：

- Runtime 从不接触 Broker 的执行 id；它按原始 `reference`（`sessionId`、`promptId`、`callId`、`argsDigest`）识别调用。
- 查询绝不能证明调用没有运行。记录缺失、超时或租约过期都不是证据，因此 `status` 以 200 回答 `unknown`，而不是 404 或 500。
- `status` 只读：它绝不进入 prepare 路径，不挂接会话，也不执行任何东西。

## 2. 范围

范围内：路由清单声明、共享 schema 与 conformance fixtures，以及 worker 处理器和对应的 raw HTTP gate 放行。TypeScript 契约测试与 Java fixture 消费方共享契约；worker 测试覆盖已挂载的处理器。Java `HttpRuntimeTransport` 按本契约实现 `execute`、`status`、`cancel`。

范围外：将 `HttpRuntimeTransport` 接为 `RuntimeTransport`、Harness 侧工具接线，以及 `not_started_proven` 结果（需要持久回执存储）。

## 3. 设计

### 3.1 路由

三个操作都在 `OWNED_MANAGED_RUNTIME_ROUTES` 中声明，沿用 attestation 的纪律：`POST` 精确路径、协议版本 2、封闭 JSON 请求体、双向 `no-store`、先鉴权后解析，以及 lease id 与 epoch 请求头。`execute` 的请求上限为 256 KiB，使工具调用的 `input` 放得下；`status` 与 `cancel` 的请求上限为 16 KiB。每个操作的响应上限均为 1 MiB。更大的工具输出走产物交付通道，绝不进入这些信封。

fixture 的请求头对象封闭为五个协议头。这约束的是 fixture 声明，不限制客户端或中间层添加的普通 HTTP 头。负面用例通过显式的省略或替换指令构造。

worker 已挂载全部四个声明的处理器。`ownedManagedRuntimeRouteGate` 只放行声明的方法与精确路径，包括 `execute`、`status`、`cancel`。未声明路径、错误方法、尾部斜杠与查询字符串返回空响应体的 404。

### 3.2 请求

每个请求都是封闭对象：

- `execute`：`protocolVersion`、`reference`、`toolName`、`input`。
- `status`：`protocolVersion`、`reference`，以及可选的非负 `afterSequence` 游标。
- `cancel`：`protocolVersion`、`reference`。

reference 是 harness 分配的原始调用身份；Runtime 不会得知任何 Broker 侧标识。

工具输入还必须能由 Runtime 的 JSON 编码器编码，以便比较调用身份。不可编码的输入（包括未超出字节上限但嵌套过深的输入）在创建日志条目前以 400 拒绝。日志保留编码后的输入，重试只比较字符串，不再重新编码已记录的数据。

### 3.3 响应

每个成功响应都是封闭对象，携带 `protocolVersion` 与 `state`（`prepared`、`executing`、`cancel_requested`、`settled`、`unknown` 之一）：

- `unknown` 表示该 Runtime 没有这个 reference 的记录。它返回 200，且不构成未执行的证据。
- `state` 为 `settled` 时必须携带 `result`，其他状态禁止携带；其中包含 `executionStatus`（`not_started`、`success`、`error`、`cancelled`）、`responseParts`，以及可选的 `error`（`message` 必填，`type` 可选）。
- `status` 可以额外携带 `lastSequence`——Runtime 自己的进度游标。目前 Broker 的查询路径不消费该游标。

本切片只固定 `responseParts` 为数组，有意把元素结构推迟到 worker 处理器与 Broker 接入切片。后续必须从实际工具结果路径推导结构（`ToolCallResponseInfo.responseParts` 使用 SDK `Part[]`），并在提供结果之前补齐共享一致性覆盖。fixture 中的文本 part 仅作示例，不定义新的 part 格式。`settled` 下的 `not_started` 是 Runtime 明确给出的终态；记录缺失仍须返回 `unknown`，绝不能据此推导 `not_started`。

失败沿用共享分类：401 凭据、400/413 协议、409 身份、404 不兼容。JSON 错误保留共享的稳定错误码；gate 的不兼容 404 为空响应体。含 attestation 名称的错误码由各路由共享；每个解析器执行对应路由的请求体上限。

### 3.4 Conformance fixtures

`managed-runtime-tool-v2.fixtures.json` 与 attestation 套件同构：三条路由、一份身份，以及每个路由的 canonical 请求与覆盖成功形态和负面纪律的用例。`status` 与 `cancel` 的 `unknown-is-ok` 用例固定证据规则。Java 消费方固定路由契约、每个结局分类与封闭请求/响应字段集。

共享 schema 强制每个路由使用精确的请求字段集，canonical 请求与逐用例的 body 覆写都受此约束。它还要求每个 `ok` 用例都携带响应 body，要求且仅允许 `settled` 状态携带 `result`，并只允许 `status` 使用 `lastSequence`。每个路由恰好有一个 suite，信封上限与错误码词汇表固定。用例覆盖五种状态、四种执行结局、封闭的错误对象，以及不带游标的 status 请求。TypeScript 变异测试通过删除必填字段或加入路由不允许的字段，证明这些约束确实生效，并把声明 manifest 钉在 fixture 路由上。raw HTTP 测试证明 gate 的精确放行，并向已挂载的 worker 处理器回放负面 fixtures。

## 4. 验证

在 `packages/cli` 运行 `npx vitest run src/serve/managed-runtime-attestation-contract.test.ts src/serve/managed-runtime-attestation-worker.test.ts src/serve/managed-runtime-tool-worker.test.ts`，并在 `packages/sdk-java/runtime-broker` 运行 `mvn test -Dtest=ManagedRuntimeAttestationConformanceTest`。TypeScript suite 校验共享 fixtures、schema 变异用例、gate 精确放行与真实工具执行；Java suite 消费同一批契约文件。

### 4.1 Java transport

`HttpRuntimeTransport` 在发送前校验调用方 reference 的键集。`execute` 的调用方 map 包含四个身份字段及 `toolName`、`input`；线上请求将后两者与 `reference` 分开。`status` 和 `cancel` 只发送四个身份字段，也允许复用同一个调用方 map。`session` 参数为未来的服务适配层保留，不发送给 Runtime，也不替换原始调用身份。

这个调用方 map 是 transport 请求，不是新的持久化身份格式。Broker 保存的 reference 仍是四字段身份。接入物理分发之前，服务适配层必须单独取得 `toolName` 和 `input` 并组装 transport 请求，不能把载荷加入 `reference_json` 或改变执行幂等性。

超过对应路由上限的请求在发送前被拒绝：`execute` 为 256 KiB，`status` 与 `cancel` 为 16 KiB。响应上限为 1 MiB，且必须带 `no-store` 与 JSON 响应头。解析强制信封、result、error 为封闭对象，协议版本为 2，状态与执行结局属于契约枚举，错误字符串非空，且仅在 settled 时必须携带 result。`lastSequence` 为可选非负整数，仅允许出现在 `status`。`execute` 要求结算并返回 result map；`status` 与 `cancel` 返回校验后的线上 map。共享错误码保持不变，错误消息标明操作与适用上限。服务端失败可重试，其他 HTTP 失败为终态。

在 `packages/sdk-java/runtime-broker` 运行 `mvn test` 和 `mvn checkstyle:check`。HTTP fixture 回放验证 canonical 请求、成功与 unknown 应答、畸形 reference 和响应、逐路由请求上限，以及超过 16 KiB 直至 1 MiB 的工具结果。下文描述的 worker 处理器已提供这些路由。

## 5. 后续工作

- 完成会话操作并将 `HttpRuntimeTransport` 接为 `RuntimeTransport`。按 §4.1 所述从已保存的 reference 之外单独提供 `toolName`/`input`，并端到端覆盖真实 Broker 分发。
- `UNKNOWN` 执行对账器已在 #12655 落地。其 transport 必须先校验 status 线上信封，再投影为 `{state, result}`（仅 `settled` 携带 `result`）。去掉 `protocolVersion` 与 `lastSequence`；Broker 拒绝额外字段，目前没有游标消费方。
- 对 Runtime 报告仍在运行的执行是否发送物理取消，有意推迟。

## 6. Worker 实现

合入的 attestation worker 现在在 `attest` 旁边挂载了这三个路由。其执行器恰好准入首版的普通工具——`read_file`、`write_file`、`edit` 与前台 `run_shell_command`——运行在以已证明的工作区 cwd 为根的真实 `Config` 之上，checkpointing 关闭。在 `managed-context/1` 的 boot v2 下，每个新调用改为在其 Session 已安装的实际目录中运行，并须先通过激活 gate；见 [Managed Context Worker](2026-09-26-managed-context-worker.zh-CN.md)。准入发生在 Harness 侧；worker 执行时不再有审批门。Harness 准入必须包含工作区边界判定：worker 不会将工具路径或 shell 命令限制在工作区内。调用日志按构造只在内存中：worker 进程就是 Runtime 代数，重启即是新代数而非延续，对该进程从未见过的请求，`unknown` 才是诚实的应答。worker 禁用依赖对话的文件读取缓存：它没有内容仍在对话历史中的证据，且可能服务多个 Runtime 会话。任何先读后写要求由 Harness 准入负责。

契约之上的语义：

- `execute` 按 `reference.callId` 幂等：同一身份会并入在途调用或返回其已结算结果；同一 `callId` 携带不同摘要或负载则是 409 身份冲突。未准入的工具名同样是 409——它对本代数永远不合法。`run_shell_command` 的有效输入归一化为 `is_background: true` 时，在创建日志条目或启动进程之前被拒绝，包括不区分大小写的字符串 `"true"`；省略、布尔 false 或字符串 `"false"` 则仍以前台运行。通过协议准入后的参数校验或复制失败结算为错误，不执行命令。工具接收输入副本，参数归一化不会改变用于识别重试的原始负载。
- `status` 只读，对 Runtime 没有记录的 reference 以 200 回答 `unknown`；已知调用按其状态与日志的单调 `lastSequence` 应答。
- `cancel` 把 `prepared` 调用直接结算为 cancelled（不触碰工具），中止 `executing` 调用并回答 `cancel_requested`，此后幂等。Runtime 兑现的取消会把该调用结算为 `cancelled`——无论工具把中止表现为错误还是提前返回的结果。
- worker 保留 5 秒的 HTTP `requestTimeout`，它限制接收请求体的时间，不限制完整请求的执行时间。执行由工具自身的超时约束；headers 与 keep-alive 上限维持不变。
- 发布已结算结果之前，worker 按序列化后的 status 信封检查 1 MiB 响应上限。超大输出被替换为小型终态错误（保留 cancelled 状态），并供 execute 重试、status 与 cancel 共用。这表示调用已执行但输出不可用，绝不是 `not_started`，也不是允许再次执行。
- `prepared` 是内部日志状态：执行会同步进入 `executing`，因此 HTTP 调用方无法观察或取消 prepared 条目。

验证新增 `managed-runtime-tool-worker.test.ts`：在真实挂载的路由上用原始 HTTP 回放全部负面共享 fixture；行为用例覆盖在临时工作区真实执行 `read_file`、对未见过的 reference 回答 `unknown`、并入并发的重复 execute、以 409 拒绝同 callId 不同摘要的重试、拒绝未准入工具，以及取消一个在途的前台 shell 命令。额外回归用例验证后台 shell 被拒绝且不留日志条目（包含归一化后的字符串布尔值），验证省略 `is_background`、布尔或字符串 false 均可准入，并验证无效值不会启动命令。

仍为后续工作：Harness 侧 `RuntimeBackedTool` 接线、文件历史结算、对已准入工具集合的 capability digest 校验、日志保留上限、合成模型 `managed-runtime-worker` 的图片输入支持，以及大输出的产物交付通道。
