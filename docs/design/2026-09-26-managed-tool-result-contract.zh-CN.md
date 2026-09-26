# Managed 工具结果契约(O1a)

[English](2026-09-26-managed-tool-result-contract.md) | [简体中文](2026-09-26-managed-tool-result-contract.zh-CN.md)

状态:契约已定义;尚无 worker、存储或 Broker 使用它。更新日期:2026-09-26。本文是 [#12723](https://github.com/QwenLM/qwen-code/issues/12723) 的 O1a 切片,属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 O1 阶段。下文的"参考设计"指该提案的[工具结果与持久产物设计](https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-tool-result-artifacts.zh-CN.md)第 11 节及其依赖的各节,版本为 #12723 固定的提交。

## 问题

Managed Runtime 可能被回收,Harness 也可能被替换。此时工具的完整输出最多只留在 Runtime 本地的文件里,而上限 1 MiB 的 Tool v2 结果装不下它。O1 让完整输出可以持久保存、按引用访问,并与 UI 显示的预览、模型消费的消息相互独立。

与 attestation、Tool v2 和 `managed-context/1` 契约一样,O1a 在任何实现之前先定下结构与规则。O1b 在本地 Session 资源存储上实现流式发布与按区间读取,O1c 在 worker 上捕获前台 Shell 输出。

## 现状

以下事实来自 `main` 的 `89b057befd`。

- **`ToolResult`。** `packages/core/src/tools/tools.ts` 区分了 `llmContent`、`returnDisplay`、`persistedOutputFiles`、`resultFilePaths` 和 `artifacts`。
- **截断。** `packages/core/src/tools/truncation.ts` 中的 `persistAndTruncateToolResult` 把超长文本转存到本地私有文件。单文件超过 50 MiB 或会话累计超过 500 MiB 时不再落盘,写入失败时只剩预览。因此有预览并不能证明完整字节还在。
- **Session 资源。** `packages/core/src/managed-runtime/managed-session-resources.ts` 中的 `LocalManagedSessionResourceStore` 整块发布 `Buffer`、整文件读取,读取时校验长度和 SHA-256。它没有流式发布,也没有按区间读取。资源通过 `DurableRef` 引用:`resourceId`、`kind`、`schemaVersion`、`byteLength` 和不带前缀的小写十六进制 SHA-256 `digest`。
- **Session 回执。** Managed Session 事件 `tool.receipt` 携带 `executionCallId`、`toolOutcomeRef`、`resultRef`、`resources` 和 `historyRevision`。
- **Tool v2。** `managed-runtime-tool-v2.schema.json` 把已结算的 `result` 封闭为 `executionStatus`、`responseParts` 和可选的 `error`,每个响应上限 1 MiB。worker 会把更大的结果替换为一个小的终态错误。
- **路由闸门。** worker 的所有路由都经过 `ownedManagedRuntimeRouteGate`,它只放行其 boot 版本的路由:boot v1 下是 `OWNED_MANAGED_RUNTIME_ROUTES`,boot v2 下是 `MANAGED_CONTEXT_WORKER_ROUTES`(W0c-1,#12732);对其他路径,它在任何处理器运行前返回空的 404。

## 目标

- 定义 `ToolResultManifestV1`:描述一次执行所捕获输出的资源,包含身份、相互独立的状态、捕获范围和有序的内容描述。
- 定义列出大流不可变分段的分段页,以及页和 manifest 的大小上限。
- 定义分段身份、幂等发布与封存,摘要由接收方计算。
- 定义 manifest 修订如何扩展一个打开的流,以及最终修订不可变。
- 决定对端如何启用,并证明旧对端在任何副作用之前就被拒绝。
- 用一份 TypeScript 与 Java 共同读取的共享 schema 和 fixture 文件固定以上全部内容。

## 非目标

- **实现。** 没有存储发布分段,没有 worker 捕获输出,也没有挂载任何路由。这些由 O1b 和 O1c 完成。
- **托管存储。** 对象存储和共享卷适配器、配额、背压、发布保持和回执对账属于 O2。
- **投影。** Java 结果与 Artifact 元数据、公开的区间读取和下载 API、WebShell 工具卡片属于 O3。
- **生命周期。** 基于引用的清理、后台 Shell 与 Monitor、MCP 与媒体适配器属于 O4。
- **运行参数。** 参考设计第 6 节的数值(8 KiB 预览、4 MiB 分段、两个在途分段)是测试输入。本契约只固定接收方强制执行的上限。

## 决策

这里回答 #12723 的四个问题。第一个决定启用方式,属于本契约;其余三个是 O1b 和 O1c 的计划。

1. **启用方式:新的工具契约版本。** 对端通过调用 Tool v3 启用。Tool v3 是一组新路由,携带带版本的结果信封;Tool v2 不增加任何字段。未实现它的 worker 在任何处理器运行前,就以闸门的空 404 回应每个 v3 路径,因此旧对端在任何副作用之前就被拒绝。其他方案更弱:
   - 在 `managed-context` 的 boot 与 ready 协商中加一项能力,会把结果捕获与 Workspace 上下文绑在一起,要改动 worker 自 W0c-1 起已经提供的 boot v2,而且仍需要新路由来携带信封。
   - 在 Tool v2 旁另设资源路由,会让旧 worker 先经 v2 执行;Broker 事后才发现没有捕获。

   这些路由使用协议版本 3,即自有路由族的下一个版本;`managed-context/1` 的两个路由也使用它。两者靠路径和协议 token 区分,worker 只在实现了相应协议时才提供对应路由。

2. **存储归属:独立接口。** O1b 把流式发布与按区间读取放在一个新接口之后,由本地适配器实现,与 `LocalManagedSessionResourceStore` 并列,使用同一资源根目录。#12693 的持久 Session 权威及其 HTTP 适配器所实现的 `ManagedSessionResourceStore` 保持不变,直到 O2 需要远程分段。
3. **完整性:前台 Shell 默认要求完整。** O1c 以 `complete_required` 准入前台 Shell:缺失字节会阻止结果被接受和模型继续。契约中存在 `best_effort`,但只有工具的准入明确指定时才使用。无论哪种策略,部分捕获都不会被标为完整;副作用发生后捕获失败,也绝不会再次执行工具。
4. **顺序。** O1a 与 O1b 不涉及 worker,先落地。O1c 修改 worker,排在 W0c 之后;W0c 的第一个切片 W0c-1(#12732)已经落地。

## 取值规则

| 规则        | 取值                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| id          | Managed Session 稳定 ID 规则:非空字符串,至多 512 个 UTF-8 字节,形式良好,NFC 规范化,不含 C0、DEL 或 C1 字符。          |
| token       | `[a-z0-9_-]{1,128}`。只允许小写,以免大小写不敏感的文件系统在本地适配器的路径中把两个 token 合并。                     |
| digest      | 64 个小写十六进制字符,是所描述字节的 SHA-256,与 `DurableRef` 相同。                                                   |
| generation  | 1 到 2^63−1 的规范十进制文本,即 W0a 对 `workspaceGeneration` 的规则。                                                 |
| count       | 0 到 2^53−2 的 JSON 整数,即 Managed Session 的序号规则。修订号和历史修订号从 1 开始。                                 |
| durable ref | `DurableRef` 的五个字段,遵循 Session 记录规则:`resourceId` 与 `kind` 是 id,`schemaVersion` 与 `byteLength` 是 count。 |

## 工具结果 manifest

manifest 是 kind 为 `managed-tool-result-manifest`、schema 版本为 1 的 Session 资源。其内容是一个至多 64 KiB 的 UTF-8 JSON 对象(64 KiB 是持久 Session 存储内联保存的最大资源),恰好包含以下键。

| 键                  | 规则                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `toolResult`        | `"managed-tool-result/1"`,即协议 token                                                       |
| `type`              | `"manifest"`                                                                                 |
| `tenantId`          | id                                                                                           |
| `sessionId`         | id:Managed Session,而不是 Runtime Session                                                    |
| `turnId`            | id                                                                                           |
| `executionCallId`   | id:Session 回执将要指明的 `tool.intent` 身份                                                 |
| `callId`            | id:模型的调用 ID                                                                             |
| `invocationDigest`  | id:原始引用的 `argsDigest`,与 Runtime 收到的完全一致                                         |
| `bindingGeneration` | generation:执行该调用的 Runtime 绑定代数                                                     |
| `captureId`         | token:每次执行捕获一个;分段以它为键                                                          |
| `revision`          | 从 1 开始的 count                                                                            |
| `executionStatus`   | `success`、`error`、`cancelled` 或 `unknown`                                                 |
| `exitCode`          | −2^31 到 2^32−1 的整数,或 null;`executionStatus` 为 `unknown` 时为 null                      |
| `signal`            | `SIG` 后接 1 到 16 个 `[A-Z0-9]` 字符,或 null;`executionStatus` 为 `unknown` 时为 null       |
| `captureScope`      | `process_pty`、`process_pipes` 或 `tool_native`                                              |
| `capturePolicy`     | `complete_required` 或 `best_effort`                                                         |
| `captureStatus`     | `pending`、`complete`、`partial` 或 `unavailable`                                            |
| `captureReason`     | null,或 `quota_exhausted`、`size_limit`、`producer_lost`、`storage_failed`、`cancelled` 之一 |
| `upstreamTruncated` | 布尔值                                                                                       |
| `contents`          | 至多 32 个内容描述组成的数组                                                                 |

- **身份。** 没有哪个字段能单独标识一个结果;尤其 `callId` 只在其 Session 内唯一。读取方把完整身份与它期望的执行比较,任一字段不符即为冲突结果,绝不作为替代品使用。
- **执行状态。** 它是物理结果,与捕获的情况无关。从未开始的调用没有可捕获的内容,也没有 manifest,因此这里没有 `not_started`。`unknown` 表示捕获不知道结果,例如进程仍在运行时。
- **退出。** `tool_native` 没有进程,因此 `exitCode` 和 `signal` 都为 null。两种进程范围下至多设置其中一个:进程要么以退出码结束,要么被信号终止;结果未知时两者都为 null。无符号 32 位退出码是 Windows 的退出状态。
- **范围。** `captureScope` 说明"完整"承诺的是什么。`process_pty` 是单一顺序的一份 PTY 记录。`process_pipes` 分开保存标准输出和标准错误,各自保持字节顺序,两者之间没有顺序。`tool_native` 是工具自身产生的结果。完整从不承诺上游来源返回了全部内容;`upstreamTruncated` 记录的是来源自己报告了截断,它本身绝不会使捕获变为部分。
- **没有来源版本。** manifest 没有 `sourceVersion`。生产方如果要保留某个版本(它自己适配器的版本,或 MCP server 等上游来源的版本),就把它写进自己的 `result` 流,而 manifest 已经描述了这个流。manifest 只保存读取方定位字节、判断其完整性所需的内容,因此以后的生产方也不需要为此新增 manifest 键。

### 内容描述

`contents` 的每一项是恰好包含以下键的对象:`streamId`(token,在 manifest 内唯一)、`role`、`mimeType`、`state`、`byteLength`(count)、`digest`、`missingRanges` 和 `body`。

- **角色。** `stdout`、`stderr`、`pty`、`result` 或 `attachment`。`stdout`、`stderr`、`pty` 和 `result` 各至多出现一次。`process_pty` 没有 `stdout` 或 `stderr`;`process_pipes` 没有 `pty`;`tool_native` 三者都没有。
- **MIME 类型。** 由 `[a-z0-9.+-]` 字符组成的小写 `type/subtype`,每部分以字母或数字开头,后面可跟 `;` 和可打印 ASCII 参数,至多 255 个字符。它描述字节,不承诺字节能被解码。
- **状态。** 仍可能有字节到达时为 `open`;观察到流结束且每个字节都已保存后为 `sealed`;捕获停止且有字节缺失时为 `incomplete`。
- **已保存字节。** 一个流保存连续前缀 `[0, byteLength)`。任何状态下 `digest` 都恰是这些字节的 SHA-256;对已封存的流,它就是最终摘要。
- **缺失区间。** 每项是恰好包含 `start` 和 `end` 的对象,表示源字节偏移,`end` 未知时为 null。由于已保存的字节是前缀,v1 的流至多有一个缺失区间,它从 `byteLength` 开始,已知的 `end` 大于 `start`。只有 `incomplete` 的流可以有缺失区间,此时空列表表示缺失部分未知。
- **内容体。** 恰好包含一个键的对象:
  - `ref`:整个流作为一个资源,kind 为 `managed-tool-result-content`、schema 版本为 1,其 `byteLength` 和 `digest` 与描述相同。`open` 的流不允许使用它,因为资源无法增长。
  - `pages`:至多 64 个页引用组成的数组。每项是恰好包含 `ref`(kind 为 `managed-tool-result-page`、schema 版本为 1、1 到 262144 字节的资源)、`segmentCount`(1 到 1024)和 `byteLength`(`segmentCount` 到 `segmentCount` × 16 MiB)的对象。各页的 `byteLength` 之和等于描述的 `byteLength`,当且仅当流为空时列表为空。

### 捕获状态

`captureStatus` 由内容描述决定,manifest 必须写明它们所蕴含的状态:

| 状态          | 内容描述                                                                | `captureReason` |
| ------------- | ----------------------------------------------------------------------- | --------------- |
| `pending`     | 至少一个为 `open`                                                       | null            |
| `complete`    | 至少一个,且全部为 `sealed`                                              | null            |
| `unavailable` | 没有 `open`,且每一个都是未保存任何字节的 `incomplete`(包括没有描述)     | 必需            |
| `partial`     | 其他情况:没有 `open`,至少一个为 `incomplete`,且有已保存字节或已封存的流 | 必需            |

`capturePolicy` 不改变这些规则。它告诉 Session 权威:`partial` 或 `unavailable` 的捕获是阻止接受(`complete_required`),还是可以连同原因一起被接受(`best_effort`)。

## 分段页

页是 kind 为 `managed-tool-result-page`、schema 版本为 1 的 Session 资源。其内容是一个至多 256 KiB 的 UTF-8 JSON 对象,恰好包含以下键:`toolResult`、`type: "page"`、`captureId`、`streamId`、`firstOrdinal`(count)、`offset`(count)和 `segments`;`segments` 是 1 到 1024 个对象组成的数组,每个对象恰好包含 `byteLength`(1 到 16777216)和 `digest`。页的最后一个序号(`firstOrdinal` 加分段数减一)至多为 65535,`offset` 加上各分段的字节数是一个 count。

- **位置。** 描述的第 `i` 页携带 manifest 的 `captureId` 和描述的 `streamId`。它的 `firstOrdinal` 是之前各页 `segmentCount` 之和,`offset` 是之前各页 `byteLength` 之和,分段数等于其引用的 `segmentCount`,分段长度之和等于其引用的 `byteLength`。读取方在信任一页之前先检查位置,因此放错位置读到的页会被拒绝。
- **上限。** 数量上限保证每页都在 256 KiB 以内,但不保证每个 manifest 都在 64 KiB 以内:manifest 只能在不超过该上限的前提下填满各列表,可能超出的生产方应改用更大的分段。占满 64 页的单个流可达 1 TiB。只要存储分配的页 ID 较短(例如 UUID),无论身份字段取什么值都能放下。JSON 转义可能使 ID 的大小翻倍,因此 64 个带 512 字节 ID 的页引用可能放不下;分配较长资源 ID 的托管存储(O2)需要考虑这一点。

## 分段发布

分段不可变,由 `captureId`、`streamId` 和 `ordinal`(小于 65536 的 count,即 64 页 × 1024 分段)标识。存储按 Session 保存分段;本契约固定三个操作,本地适配器(O1b)和托管适配器(O2)都必须给出相同的回答。接收方根据收到的字节计算每个长度和摘要。调用方提供的摘要只是用来比较的预期值,从不被记录。

- **发布** `{captureId, streamId, ordinal, bytes, digest?}`,字节数为 1 到 16 MiB。接收方按顺序检查:
  1. 结构与上述规则;否则为 `managed_tool_result_invalid`。
  2. 给出的 `digest` 与收到字节的摘要不同,为 `managed_tool_result_digest_mismatch`。接收方不让这些字节出现在任何读取中;O1b 把它们隔离。
  3. 已有字节的身份:长度和摘要相同时返回原结果,否则为 `managed_tool_result_conflict`。
  4. 已封存流中序号不小于分段数的,为 `managed_tool_result_conflict`。
  5. 接收方保存分段并返回 `{ordinal, byteLength, digest}`。
- **封存** `{captureId, streamId, segmentCount, byteLength, digest}`,`segmentCount` 为 0 到 65536。
  1. 结构;否则为 `managed_tool_result_invalid`。
  2. 已封存的流:三个值相同时返回原结果,其他任何值为 `managed_tool_result_conflict`。
  3. 已保存的分段必须恰好是小于 `segmentCount` 的各序号;缺少或多出一个都为 `managed_tool_result_conflict`。
  4. 收到的分段长度之和必须等于 `byteLength`,拼接后的哈希必须等于 `digest`;否则为 `managed_tool_result_digest_mismatch`。
  5. 接收方封存该流并返回 `{segmentCount, byteLength, digest}`。
- **前缀** `{captureId, streamId}` 为已校验前缀(从序号 0 起连续保存的最长分段序列)返回 `{segmentCount, byteLength, digest, sealed}`。它是生产方发布 manifest 修订所依据的游标。未知的流返回空前缀。

分段可以乱序到达;空缺补齐后前缀随之增长。被拒绝的操作不记录任何内容,因此缺失分段到达后重试可以成功。之后以相同字节再次发布同一身份会返回原结果,封存之后也是如此。

## manifest 修订

流打开期间,生产方可以发布新修订,让读取方看到已校验前缀的增长。修订 `n` 的后继必须满足以下全部条件,否则为冲突结果。

- 它是 `pending` manifest 的修订 `n + 1`。`complete`、`partial` 或 `unavailable` 的修订是最终修订,没有后继。
- 所有身份字段、`captureScope` 和 `capturePolicy` 不变。
- 只有在 `executionStatus` 为 `unknown` 时,`executionStatus`、`exitCode` 和 `signal` 才能改变。
- `upstreamTruncated` 可以变为 true,但不能再变回 false。
- 之前的描述保持位置、`streamId`、`role` 和 `mimeType`;新描述可以追加在其后。
- 原为 `sealed` 或 `incomplete` 的描述保持不变。
- `open` 的描述保留 `pages` 内容体,`byteLength` 保持或增长,长度不变时 `digest` 也不变。之前的页保持不变,只有最后一页可以被一个位置相同、分段数不少于且字节数不少于它的页替换。替换页必须以被替换页的每个分段原样开头;由于 manifest 只持有页的引用,读取方需在两页上检查这一点。

## Tool v3 与结果信封

Tool v3 是在 Tool v2 基础上增加 token、捕获请求和带版本的结果信封,再加上确认操作。它的路由在共享 fixtures 中声明,但不在任何 boot 版本的路由列表中,因此在 O1c 挂载处理器之前,闸门不会放行其中任何一个。

| 键            | 路径                                       | 请求上限 | 响应上限 |
| ------------- | ------------------------------------------ | -------- | -------- |
| `execute`     | `/internal/managed-runtime/v3/execute`     | 256 KiB  | 1 MiB    |
| `status`      | `/internal/managed-runtime/v3/status`      | 16 KiB   | 1 MiB    |
| `cancel`      | `/internal/managed-runtime/v3/cancel`      | 16 KiB   | 1 MiB    |
| `acknowledge` | `/internal/managed-runtime/v3/acknowledge` | 16 KiB   | 1 MiB    |

每个路由都是 `POST`,协议版本为 3,双向都带 `Cache-Control: no-store`,并使用 Tool v2 的请求头:bearer token 以及 lease ID 和 epoch。每个请求体都携带 `toolResult: "managed-tool-result/1"`。

- **请求。** 每个都是封闭的:
  - `execute`:`protocolVersion`、`toolResult`、`reference`、`toolName`、`input` 和 `capture`。`capture` 封闭为 `tenantId`、`sessionId`、`turnId`、`executionCallId`(id)、`bindingGeneration`(generation)和 `capturePolicy`:即 Runtime 无法自行得出的 manifest 身份。worker 把 `tenantId` 与其 boot 文档比较。
  - `status`:`protocolVersion`、`toolResult`、`reference`,以及可选的 count `afterSequence`。
  - `cancel`:`protocolVersion`、`toolResult`、`reference`。
  - `acknowledge`:`protocolVersion`、`toolResult`、`reference` 和 `receipt`;`receipt` 封闭为 `executionCallId`、`manifest`(manifest 引用或 null)、`deliveryStatus`(`committed` 或 `blocked`)和 `historyRevision`(committed 时为从 1 开始的 count,blocked 时为 null)。
  - `reference`、`toolName` 和 `input` 沿用 Tool v2 的规则,但 `reference.callId` 和 `reference.argsDigest` 还必须满足 id 规则,因为 manifest 会把它们重复为 `callId` 和 `invocationDigest`。
- **响应。** 每个都封闭为 `protocolVersion`、`toolResult`、`state`(Tool v2 的五种状态)、仅当状态为 `settled` 时出现的 `result`,以及只出现在 `status` 上的 `lastSequence`。`acknowledge` 只回答 `settled`(带确认后的 `deliveryStatus`)或 `unknown`。
- **结果信封。** 已结算的 `result` 封闭为 `executionStatus`(Tool v2 的四个值)、`responseParts`、可选且与 Tool v2 结构相同的 `error`,以及 `capture`:
  - 当且仅当调用未开始时,`capture` 为 null。否则它封闭为 `captureStatus`、`captureReason`、`manifest`、`previewTruncated` 和 `deliveryStatus`。
  - `captureStatus` 为 `complete`、`partial` 或 `unavailable`:调用只在捕获结束后才结算,因此绝不是 `pending`。当且仅当它为 `complete` 时,`captureReason` 为 null。
  - `manifest` 引用最终修订(kind 为 `managed-tool-result-manifest`、schema 版本为 1、1 到 65536 字节)。除非捕获为 `unavailable`,否则必须提供。
  - `previewTruncated` 只说明 `responseParts` 显示的内容少于捕获的内容。一次完整的 100 MiB 捕获也可以有截断的预览。
  - `deliveryStatus` 在确认之前为 `pending`,之后为确认的状态。只有 Session 回执能使它变为 `committed`。
  - 引用了 manifest 时,其最终修订必须一致:`executionStatus`、`captureStatus` 和 `captureReason` 相同,且不是 `pending`。
- **确认。** Session 权威在提交或阻止结果之后进行确认。worker 把回执与引用所指的调用比较:该调用必须已开始并已结算,回执的 `executionCallId` 和 `manifest` 引用必须与它完全一致。然后它以带有确认后 `deliveryStatus` 的状态响应作答。重复的相同回执得到相同的回答。尚未结算或未开始的调用、不一致的回执,以及对已确认调用的任何其他回执,都为 `managed_tool_result_conflict`。worker 没有记录的引用,与 `status` 一样以 200 返回 `unknown`。只有在收到 `committed` 确认之后,Runtime 才能丢弃其 spool。

### 在任何副作用之前拒绝

需要捕获的 Broker 对该调用只使用 v3,之后对它的每次 status、cancel 和确认也都使用 v3,绝不经 v2 重试。没有 v3 的 worker,无论哪个 boot 版本,其闸门都在处理器运行前以空 404 回应每个 v3 路径,Broker 把它归类为不兼容,因此什么都不会执行。v2 与 v3 的请求结构互斥,因此发到 v3 路由的 v2 请求体、发到 v2 路由的 v3 请求体,都会在日志条目产生前以 400 被拒绝。Broker 也拒绝 v3 路由上 v2 结构的回答,因为 v3 响应要求 token 和协议版本 3。未被准入捕获的调用继续原样使用 Tool v2。

## 错误

| 状态 | 代码                                    | 类别         | 何时                                                             |
| ---- | --------------------------------------- | ------------ | ---------------------------------------------------------------- |
| 401  | `managed_runtime_unauthorized`          | credentials  | bearer token 缺失或错误                                          |
| 400  | `managed_runtime_attestation_invalid`   | protocol     | 路由请求体、请求头或协议版本错误                                 |
| 413  | `managed_runtime_attestation_too_large` | protocol     | 请求体超过上限                                                   |
| 409  | `managed_runtime_identity_conflict`     | identity     | lease 请求头或 `capture.tenantId` 与 boot 不同,或复用了 `callId` |
| 409  | `managed_tool_result_conflict`          | identity     | 确认与调用或与之前的确认不一致                                   |
| 404  | 无                                      | incompatible | worker 不提供的路由                                              |
| —    | `managed_tool_result_invalid`           | protocol     | 违反结构或规则的存储操作                                         |
| —    | `managed_tool_result_conflict`          | identity     | 与已保存分段或封存不一致的存储操作                               |
| —    | `managed_tool_result_digest_mismatch`   | integrity    | 收到的字节与预期的长度或摘要不符                                 |

最后三项是存储结果;分段跨网络传输时,由 O2 为它们指定 HTTP 状态。与 `managed-context/1` 客户端一样,v3 客户端根据状态和代码共同对拒绝分类。冲突或完整性拒绝绝不会换用其他字节重试,也绝不会让 Harness 接受另一次执行的输出或再次执行工具。

## 安全

- 契约不携带任何文件系统路径。读取方只通过 Session 资源和分段身份访问字节,本地适配器的每个路径都由 token 推导。
- 摘要由接收方计算。调用方的摘要只用于比较,从不被记录。
- 原始输出可能包含机密。manifest 不携带任何原始输出,本文也不会让任何资源公开:公开的 Artifact ID 和下载授权属于 O3。
- 身份按字符串精确比较。

## 共享 schema 与 fixtures

`packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json` 和 `.fixtures.json` 承载本契约。它们放在 `core` 中,因为 O1b 的存储和 O1c 的 worker 都使用重放它们的模块。

- 协议 token、资源 kind、上限、Tool v3 路由和错误表。
- manifest、页、页位置、manifest 修订和页修订的用例,有效与无效兼有,每个无效用例针对一条规则。
- 分段发布序列,带每一步的预期结果,字节以 base64 表示。
- 结果信封的单独用例,以及与 manifest 对照的用例。
- 规范的 Tool v3 请求与响应,以及由 schema 判定的请求与响应用例。

schema 固定每种记录的结构以及它能清晰表达的规则,包括角色的范围规则和内容描述所蕴含的状态。它无法表达 UTF-8 字节上限、NFC、形式良好的 UTF-16、流 ID 唯一、列表求和、依赖另一字段的上限,以及两个字段或两条记录之间的比较;TypeScript 测试列出 schema 与模块意见不一的每个用例。用例和每个摘要由一个独立于两种语言的实现生成。

- **TypeScript。** `packages/core/src/managed-runtime/managed-tool-result.ts` 校验 manifest、页、页位置、修订和结果信封,并包含一个重放发布序列的参考分段账本。在 O1b 之前没有代码导入它;O1b 会把这个账本保留为其分段存储接口的内存实现,就像 Broker 在 JDBC 仓库之外保留内存仓库一样。
- **准入。** 一个 CLI 测试按每个 boot 版本的路由集合,把规范的 v3 请求经已发布的路由闸门发给会记录调用的处理器,检查每个都以空 404 回应,且没有处理器运行。它与 Java 测试一样从 core 的源码目录读取 fixtures,使这份文件保持唯一副本。
- **Java。** `runtime-broker` 中的一致性测试固定 token、kind、上限、路由、封闭键集合和错误表,并根据 fixture 字节重新计算每个分段、封存与前缀摘要。

## 受影响的文件

- `packages/core/src/managed-runtime/contracts/managed-tool-result-v1.schema.json` 和 `.fixtures.json`(新增)。
- `packages/core/src/managed-runtime/managed-tool-result.ts` 及其测试(新增)。
- `packages/cli/src/serve/managed-tool-result-admission.test.ts`(新增)。
- `packages/sdk-java/runtime-broker` 中的 `ManagedToolResultConformanceTest`(新增),以及该模块的 `README.md` 和 `QWEN.md`。
- 本设计文档的两种语言版本(新增),以及 Tool v2 契约文档:其中关于产物交付通道的说明现在指向本文。

worker、路由清单、存储、provisioner、transport 和 CI workflow 均不变。

## 验证计划

- **TypeScript:** 用严格模式 Ajv 按 schema 校验 fixtures;每个用例和序列都经模块重放;用每个用例检查 schema;测量最大记录是否在上限之内。
- **准入:** 两个 boot 版本下,已发布的闸门都在任何处理器之前拒绝每个 v3 路由。
- **Java:** 一致性测试固定键集合、路由、常量和错误表,并重新计算每个摘要。
- **变异检查:** 依次变异模块的每项检查并重跑测试。

## 验收标准

- fixtures 中每种畸形结构都被模块拒绝;schema 能表达相应规则时,也被 schema 拒绝。
- 以相同字节重新发布分段返回原结果,同一身份下的不同字节冲突,封存前后都如此。
- 封存记录接收方对收到字节计算的摘要,并拒绝不一致。
- 旧对端在路由准入时、任何处理器运行之前被拒绝。
- Tool v2、`managed-context/1` 以及所有 worker、存储和 Broker 行为不变。

## 开放问题

1. 后台生产方(O4)应当每校验一个分段就发布一个修订,还是合并修订?契约两者都允许;参考设计会合并进度事件。
2. Hook 的结果是否应成为一种内容角色?参考设计列出了它,但 O1 没有生产方产生它,因此 v1 未包含。

## 后续工作

| 切片 | 范围                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1b  | 在独立接口之后实现本地分段存储,采用账本的操作与结果:发布、封存、前缀和按区间读取;100 MiB 流的内存有界;隔离损坏或冲突的分段;用 fixture 序列重放验证。                                                                                               |
| O1c  | W0c 之后在 worker 上实现 Tool v3,并与 boot v2 下的 Tool v2 调用使用同一个激活闸门:在截断前把前台 Shell 输出捕获到有界 spool,字节仍可校验时复用 `persistedOutputFiles`;结果信封;确认;Java v3 transport;请求头规范的路由 fixtures;100 MiB 保存测试。 |
