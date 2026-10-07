# Managed Runtime 工具契约 v2

[English](2026-09-24-managed-runtime-tool-contract.md) | [简体中文](2026-09-24-managed-runtime-tool-contract.zh-CN.md)

状态：契约、worker 处理器与 Java 工具 transport 已实现；Broker transport 经 `managed-runtime-provider/1` 接入（见 [2026-09-27-broker-provider-control.zh-CN.md](2026-09-27-broker-provider-control.zh-CN.md)）

相关：#12380（Managed Agent 分阶段交付）、[2026-09-22-managed-runtime-attestation-contract.md](2026-09-22-managed-runtime-attestation-contract.md) 的 attestation 契约，以及 #12380 上本契约所答复的对账讨论。

## 1. 问题

owned Managed Runtime worker 在 attestation 之外增加四个工具操作——`execute`、`status`、`cancel` 与 `acknowledge`。TypeScript worker 与 Java transport 共享同一份线上契约，并满足恢复设计要求的证据规则：

- Runtime 从不接触 Broker 的执行 id；它按原始 `reference`（`sessionId`、`promptId`、`callId`、`argsDigest`）识别调用。
- 查询绝不能证明调用没有运行。记录缺失、超时或租约过期都不是证据，因此 `status` 以 200 回答 `unknown`，而不是 404 或 500。
- `status` 只读：它绝不进入 prepare 路径，不挂接会话，也不执行任何东西。
- `acknowledge` 是调用方自己持久提交后的回执：调用方在自己的存储中结算该调用之后，可以告诉 Runtime 丢弃该调用的参数与结果负载。日志事实保留，重复派发仍然能被认出。从不确认的调用方不会让 Runtime 有任何变化。

## 2. 范围

范围内：路由清单声明、共享 schema 与 conformance fixtures，以及 worker 处理器和对应的 raw HTTP gate 放行。TypeScript 契约测试与 Java fixture 消费方共享契约；worker 测试覆盖已挂载的处理器。Java `HttpRuntimeTransport` 按本契约实现 `execute`、`status`、`cancel`。七字段的已准备 reference、会话动词和 provider 控制则改走 `managed-runtime-provider/1`：`acquire` 在 Broker 本地应答，`release` 和各项控制经 provider control 路由发送（见 [2026-09-27-broker-provider-control.zh-CN.md](2026-09-27-broker-provider-control.zh-CN.md)）。

范围外：~~将 `HttpRuntimeTransport` 接为 `RuntimeTransport`~~（已经由 `managed-runtime-provider/1` 落地）、Harness 侧工具接线，以及 `not_started_proven` 结果（需要持久回执存储）。

## 3. 设计

### 3.1 路由

四个操作都在 `OWNED_MANAGED_RUNTIME_ROUTES` 中声明，沿用 attestation 的纪律：`POST` 精确路径、协议版本 2、封闭 JSON 请求体、双向 `no-store`、先鉴权后解析，以及 lease id 与 epoch 请求头。`execute` 的请求上限为 256 KiB，使工具调用的 `input` 放得下；其余三个操作的请求上限为 16 KiB。每个操作的响应上限均为 1 MiB。鉴权通过后，每个应答还会在 `X-Qwen-Managed-Runtime-Incarnation` 中写明 worker 的 incarnation。任何请求都不携带 incarnation，因此客户端能把自己的 worker 的应答，与 worker 退出后占用该端口的进程的应答区分开；普通宿主 Managed 引擎不会从不带该头的应答中读取结果或状态。更大的工具输出走产物交付通道，绝不进入这些信封；该通道的契约见[Managed 工具结果契约](2026-09-26-managed-tool-result-contract.zh-CN.md)，它通过 Tool v3 启用，这些 v2 信封保持不变。

fixture 的请求头对象封闭为五个协议头。这约束的是 fixture 声明，不限制客户端或中间层添加的普通 HTTP 头。负面用例通过显式的省略或替换指令构造。

worker 已挂载全部声明的处理器。`ownedManagedRuntimeRouteGate` 只放行声明的方法与精确路径，包括 `execute`、`status`、`cancel` 与 `acknowledge`。未声明路径、错误方法、尾部斜杠与查询字符串返回空响应体的 404。

### 3.2 请求

每个请求都是封闭对象：

- `execute`：`protocolVersion`、`reference`、`toolName`、`input`。
- `status`：`protocolVersion`、`reference`，以及可选的非负 `afterSequence` 游标。
- `cancel`：`protocolVersion`、`reference`。
- `acknowledge`：`protocolVersion`、`reference`。

reference 是 harness 分配的原始调用身份；Runtime 不会得知任何 Broker 侧标识。

工具输入还必须能由 Runtime 的 JSON 编码器编码，以便比较调用身份。不可编码的输入（包括未超出字节上限但嵌套过深的输入）在创建日志条目前以 400 拒绝。日志保留编码后的输入，重试只比较字符串，不再重新编码已记录的数据。

### 3.3 响应

每个成功响应都是封闭对象，携带 `protocolVersion` 与 `state`（`prepared`、`executing`、`cancel_requested`、`settled`、`acknowledged`、`unknown` 之一）：

- `unknown` 表示该 Runtime 没有这个 reference 的记录。它返回 200，且不构成未执行的证据。reference 指向的记录不存在时，`acknowledge` 也这样作答。
- `acknowledged` 表示调用方的确认已落盘：Runtime 丢弃了该调用的负载，`status` 对该 reference 回答此状态。`acknowledge` 幂等：已确认的条目再次回答 `acknowledged`。
- `state` 为 `settled` 时必须携带 `result`，其他状态禁止携带；其中包含 `executionStatus`（`not_started`、`success`、`error`、`cancelled`）、`responseParts`，以及可选的 `error`（`message` 必填，`type` 可选）。
- `status` 可以额外携带 `lastSequence`——Runtime 自己的进度游标。目前 Broker 的查询路径不消费该游标。

本切片只固定 `responseParts` 为数组，有意把元素结构推迟到 worker 处理器与 Broker 接入切片。后续必须从实际工具结果路径推导结构（`ToolCallResponseInfo.responseParts` 使用 SDK `Part[]`），并在提供结果之前补齐共享一致性覆盖。fixture 中的文本 part 仅作示例，不定义新的 part 格式。`settled` 下的 `not_started` 是 Runtime 明确给出的终态；记录缺失仍须返回 `unknown`，绝不能据此推导 `not_started`。

失败沿用共享分类：401 凭据、400/413 协议、409 身份、404 不兼容。在 `managed-context/1` 的 boot v2 下，`execute` 还可能返回 409 `managed_context_unavailable`，其类别为 recovery；见 [Managed Context Worker](2026-09-26-managed-context-worker.zh-CN.md)。JSON 错误保留共享的稳定错误码；gate 的不兼容 404 为空响应体。含 attestation 名称的错误码由各路由共享；每个解析器执行对应路由的请求体上限。

### 3.4 Conformance fixtures

`managed-runtime-tool-v2.fixtures.json` 与 attestation 套件同构：四条路由、一份身份，以及每个路由的 canonical 请求与覆盖成功形态和负面纪律的用例。`status`、`cancel` 与 `acknowledge` 的 `unknown-is-ok` 用例固定证据规则。Java 消费方固定路由契约、每个结局分类与封闭请求/响应字段集。

共享 schema 强制每个路由使用精确的请求字段集，canonical 请求与逐用例的 body 覆写都受此约束。它还要求每个 `ok` 用例都携带响应 body，要求且仅允许 `settled` 状态携带 `result`，并只允许 `status` 使用 `lastSequence`。每个路由恰好有一个 suite，信封上限与错误码词汇表固定。用例覆盖六种状态、四种执行结局、封闭的错误对象，以及不带游标的 status 请求。TypeScript 变异测试通过删除必填字段或加入路由不允许的字段，证明这些约束确实生效，并把声明 manifest 钉在 fixture 路由上。raw HTTP 测试证明 gate 的精确放行，并向已挂载的 worker 处理器回放负面 fixtures。

## 4. 验证

在 `packages/cli` 运行 `npx vitest run src/serve/managed-runtime-attestation-contract.test.ts src/serve/managed-runtime-attestation-worker.test.ts src/serve/managed-runtime-tool-worker.test.ts`，并在 `packages/sdk-java/runtime-broker` 运行 `mvn test -Dtest=ManagedRuntimeAttestationConformanceTest`。TypeScript suite 校验共享 fixtures、schema 变异用例、gate 精确放行与真实工具执行；Java suite 消费同一批契约文件。

### 4.1 Java transport

`acknowledge` 不是 Broker 的操作：Java transport 不暴露也不发送它，worker 按 schema 声明作答。普通（`qwen serve`）Managed 宿主在自己的结果提交落盘之后调用它。Java conformance 消费方钉住新增的路由与新的状态词汇表，实现了它的 worker 保持兼容。

`HttpRuntimeTransport` 在发送前校验调用方 reference 的键集。`execute` 的调用方 map 包含四个身份字段及 `toolName`、`input`；线上请求将后两者与 `reference` 分开。`status` 和 `cancel` 只发送四个身份字段，也允许复用同一个调用方 map。`session` 参数为未来的服务适配层保留，不发送给 Runtime，也不替换原始调用身份。

这个调用方 map 是 transport 请求，不是新的持久化身份格式。Broker 保存的 reference 仍是四字段身份。接入物理分发之前，服务适配层必须单独取得 `toolName` 和 `input` 并组装 transport 请求，不能把载荷加入 `reference_json` 或改变执行幂等性。

超过对应路由上限的请求在发送前被拒绝：`execute` 为 256 KiB，`status` 与 `cancel` 为 16 KiB。响应上限为 1 MiB，且必须带 `no-store` 与 JSON 响应头。解析强制信封、result、error 为封闭对象，协议版本为 2，状态与执行结局属于契约枚举，错误字符串非空，且仅在 settled 时必须携带 result。`lastSequence` 为可选非负整数，仅允许出现在 `status`。`execute` 要求结算并返回 result map；`status` 与 `cancel` 返回校验后的线上 map。共享错误码保持不变，错误消息标明操作与适用上限。服务端失败可重试，其他 HTTP 失败为终态。

在 `packages/sdk-java/runtime-broker` 运行 `mvn test` 和 `mvn checkstyle:check`。HTTP fixture 回放验证 canonical 请求、成功与 unknown 应答、畸形 reference 和响应、逐路由请求上限，以及超过 16 KiB 直至 1 MiB 的工具结果。下文描述的 worker 处理器已提供这些路由。

## 5. 后续工作

- ~~完成会话操作并将 `HttpRuntimeTransport` 接为 `RuntimeTransport`。~~ 已经由 `managed-runtime-provider/1` 协议落地，见 [2026-09-27-broker-provider-control.zh-CN.md](2026-09-27-broker-provider-control.zh-CN.md)。§4.1 仍存的缺口：immediate `POST /executions` 路由仍然从已保存的 reference 读取 `toolName`/`input`，其调用方必须把工具参数持久化进 `reference_json`；请改用 deferred reserve/start 路径或 provider 协议。为 immediate 路由提供同样的负载分离仍为后续工作。
- `UNKNOWN` 执行对账器已在 #12655 落地。其 transport 必须先校验 status 线上信封，再投影为 `{state, result}`（仅 `settled` 携带 `result`）。去掉 `protocolVersion` 与 `lastSequence`；Broker 拒绝额外字段，目前没有游标消费方。
- 对 Runtime 报告仍在运行的执行是否发送物理取消，有意推迟。

## 6. Worker 实现

合入的 attestation worker 现在在 `attest` 旁边挂载了这四个工具路由。其执行器恰好准入首版的普通工具——`read_file`、`write_file`、`edit` 与前台 `run_shell_command`——运行在以已证明的工作区 cwd 为根的真实 `Config` 之上，checkpointing 关闭。[Hosted 搜索切片](2026-10-01-hosted-workspace-search-profile.zh-CN.md)还在不变的 worker 身份下准入 `glob`，需协调升级。在 `managed-context/1` 的 boot v2 下，每个新调用改为在其 Session 已安装的实际目录中运行，并须先通过激活 gate；见 [Managed Context Worker](2026-09-26-managed-context-worker.zh-CN.md)。准入发生在 Harness 侧；worker 执行时不再有审批门。Harness 准入必须包含工作区边界判定：worker 不会将工具路径或 shell 命令限制在工作区内。调用日志按构造只在内存中：worker 进程就是 Runtime 代数，重启即是新代数而非延续，对该进程从未见过的请求，`unknown` 才是诚实的应答。worker 禁用依赖对话的文件读取缓存：它没有内容仍在对话历史中的证据，且可能服务多个 Runtime 会话。任何先读后写要求由 Harness 准入负责。

契约之上的语义：

- `execute` 按 `reference.callId` 幂等：同一身份会并入在途调用或返回其已结算结果；同一 `callId` 携带不同摘要或负载则是 409 身份冲突。未准入的工具名同样是 409——它对本代数永远不合法。`run_shell_command` 的有效输入归一化为 `is_background: true` 时，在创建日志条目或启动进程之前被拒绝，包括不区分大小写的字符串 `"true"`；省略、布尔 false 或字符串 `"false"` 则仍以前台运行。通过协议准入后的参数校验或复制失败结算为错误，不执行命令。工具接收输入副本，参数归一化不会改变用于识别重试的原始负载。
- `status` 只读，对 Runtime 没有记录的 reference 以 200 回答 `unknown`；已知调用按其状态与日志的单调 `lastSequence` 应答。
- `cancel` 把 `prepared` 调用直接结算为 cancelled（不触碰工具），中止 `executing` 调用并回答 `cancel_requested`，此后幂等。Runtime 兑现的取消会把该调用结算为 `cancelled`——无论工具把中止表现为错误还是提前返回的结果。
- `acknowledge` 只作用于已结算的调用：丢弃日志条目的输入、编码输入与结果负载，保留 reference 与摘要，并把条目移入终态 `acknowledged`；此后同一 `callId` 的 `execute` 是 409 身份冲突，负载丢弃后 `status` 对该 reference 回答 `acknowledged`，重复 `acknowledge` 照答不误。条目保留含 `argsDigest` 的 reference，重复派发仍然对不上。尚未结算的既有条目（`prepared`、`executing`、`cancel_requested`）是 409 身份冲突，调用方只能在调用结算之后重试。未知的 reference 得到 200 的 `unknown` 应答。
- worker 保留 5 秒的 HTTP `requestTimeout`，它限制接收请求体的时间，不限制完整请求的执行时间。执行由工具自身的超时约束；headers 与 keep-alive 上限维持不变。
- 发布已结算结果之前，worker 按序列化后的 status 信封检查 1 MiB 响应上限。超大输出被替换为小型终态错误（保留 cancelled 状态），并供 execute 重试、status 与 cancel 共用。这表示调用已执行但输出不可用，绝不是 `not_started`，也不是允许再次执行。
- `prepared` 是内部日志状态：执行会同步进入 `executing`，因此 HTTP 调用方无法观察或取消 prepared 条目。

验证新增 `managed-runtime-tool-worker.test.ts`：在真实挂载的路由上用原始 HTTP 回放全部负面共享 fixture；行为用例覆盖在临时工作区真实执行 `read_file`、对未见过的 reference 回答 `unknown`、并入并发的重复 execute、以 409 拒绝同 callId 不同摘要的重试、拒绝未准入工具，以及取消一个在途的前台 shell 命令。额外回归用例验证后台 shell 被拒绝且不留日志条目（包含归一化后的字符串布尔值），验证省略 `is_background`、布尔或字符串 false 均可准入，并验证无效值不会启动命令。

仍为后续工作：Harness 侧 `RuntimeBackedTool` 接线、文件历史结算、对已准入工具集合的 capability digest 校验、合成模型 `managed-runtime-worker` 的图片输入支持，以及大输出的产物交付通道。普通 Managed 宿主的 worker 日志的负载由调用方的确认设界（§4.1）；无论是否被确认，每个条目的 reference 都作为识别重复的标志在 worker 的生命周期内保留；Broker 路径目前无任何调用方确认，Broker 驱动的一代 runtime 的日志设界仍是后续工作。
