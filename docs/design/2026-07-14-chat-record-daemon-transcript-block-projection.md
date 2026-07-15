# Append-only ChatRecord 到 DaemonTranscriptBlock 的共享投影内核

## 文档状态

- 状态：Implemented
- 日期：2026-07-14
- 实施日期：2026-07-15
- 范围：core、acp-bridge、cli、sdk-typescript、web-shell
- 目标输入：调用方已经从 JSONL 解析出的 append-only unknown records
- 目标输出：带 diagnostics 和完整性信息的 DaemonTranscriptBlock 投影

## 结论

实施结果：record preparation、ACP replay machine、live/replay pure builders、CLI Adapter、
provenance-aware compaction、SDK normalizer/reducer 以及 opt-in SDK facade 已落地。默认 daemon
browser bundle 保持 151 KiB budget；minified transcript browser bundle 为 67,730 bytes。分别导入
daemon 与 daemon/transcript 的产物合计 222,335 bytes，同时导入后的测量产物为 222,722 bytes
（额外 387 bytes 为组合模块包装开销），因此调用方应把 transcript subpath 视为显式 opt-in
成本。同步性能基线和 Web Worker 建议记录在 SDK README。

Web 调用方使用独立的 opt-in SDK subpath：

    import {
      projectChatRecordsToDaemonTranscript,
      type ChatRecordTranscriptProjection,
    } from "@qwen-code/sdk/daemon/transcript";

    const projection = projectChatRecordsToDaemonTranscript(records);
    const { blocks, diagnostics, complete, truncated } = projection;

该同步函数不启动 daemon、Express 或 ACP child，不访问文件系统、网络、DOM 或浏览器
storage，也不解析 JSONL 文本。它接收 JSON.parse 之后的原始 append-only records，并在
内部完成：

    runtime validation
      -> active leaf selection
      -> parentUuid chain reconstruction
      -> same-UUID fragment aggregation
      -> persisted transcript replay
      -> SessionUpdate normalization
      -> DaemonTranscriptBlock projection

共享 Implementation 分为三个有明确所有权的深 Module：

    packages/core/src/utils/transcript-records.ts
      -> package export @qwen-code/qwen-code-core/transcriptRecords
      -> browser-safe record preparation
      -> active chain、aggregation、gap、diagnostics

    packages/acp-bridge/src/transcript-replay.ts
      -> browser-safe replay machine
      -> shared pure SessionUpdate builders

    packages/sdk-typescript/src/daemon/ui/chat-record-transcript.ts
      -> SDK Adapter
      -> normalizer/reducer/finalize
      -> public projection Interface

CLI 的 HistoryReplayer 与 live MessageEmitter、ToolCallEmitter、PlanEmitter 都复用
acp-bridge 的 pure update builders。这样不会把漂移从 “CLI 对 Web” 转移成 “live 对
replay”：record 解释和 update 组装各自只有一个 Implementation。

SDK Adapter 把相同 SessionUpdate 包装成 id-less DaemonEvent，复用现有
normalizeDaemonEvent 和 transcript reducer，最终返回 blocks、diagnostics、complete 和
truncated。

## 背景

目标场景是将 qwen -p 生成的持久化 JSONL，例如：

    /root/.qwen/projects/-root--qwen-workspace/chats/<session-id>.jsonl

在 WebShell 中只读渲染。浏览器已经通过宿主、文件选择器或其他可信读取路径获得文件内容，
并负责把 JSONL 文本解析为 unknown records。之后的完整路径是：

    parsed append-only records
      -> shared record preparation
      -> shared transcript replay
      -> DaemonTranscriptBlock projection
      -> WebShellTranscript

调用方不需要理解 parentUuid tree、rewind 后的 active branch、同 UUID append fragments、
session artifact records 或 history gap。把这些持久化语义留在调用方会形成浅 Module：
Interface 看似只有一个函数，但正确使用它要求调用方重新实现 SessionService 的知识。

这里不使用 compactedReplay。它是 daemon 为 live session 维护的有界内存恢复窗口；本工具
处理调用方明确传入的持久化 records。离线投影默认不设 block 数量上限，但仍保留单 text
block 的安全上限，并通过 diagnostics/truncated 明确报告任何有损处理。

## 现状基线：daemon /load 如何重放 JSONL

当前 response-mode `/load` 不是把 JSONL 直接交给 SDK。完整链路是：

    SessionService.loadSession
      -> JSONL parse
      -> last non-artifact leaf
      -> buildOrderedUuidChain
      -> same-UUID aggregateRecords
      -> ResumedSessionData.conversation.messages

    QwenAgent.loadSession
      -> collectHistoryReplayUpdates
      -> HistoryReplayer
      -> MessageEmitter / ToolCallEmitter / PlanEmitter
      -> SessionUpdate[] in LOAD_REPLAY_META_KEY

    acp-bridge restoreSession
      -> extractLoadReplayResponse
      -> BridgeClient.seedSessionUpdates
      -> prepareSessionUpdateFrames
      -> EventBus.seedReplayEvents
      -> compactedReplay + liveJournal

    DaemonSessionClient.load
      -> replaySnapshot
      -> normalizeDaemonEvent
      -> reduceDaemonTranscriptEvents
      -> DaemonTranscriptState.blocks

stream-mode `/load` 的前半段仍由 HistoryReplayer 产生 SessionUpdate，只是 update 作为 ACP
notification 进入 pending restore EventBus，而不是装进 load response。两种模式最终都经过相同的
bridge frame preparation、normalizer 和 reducer。

现状有三个需要收敛的分叉：

- SessionService 与 SessionTranscriptReader 各有一份 aggregateRecords；
- SessionService 选择最后一个 non-artifact record 作为 leaf，SessionTranscriptReader 当前把最后
  一个结构有效 record 当 leaf，artifact 恰好位于文件尾时语义不同；
- JSONL replay 依赖 CLI emitter class，browser 端无法在不引入 Config 和 Node runtime 的情况下
  复用。

本设计不是另起一条 JSONL 到 blocks 的捷径，而是抽取上述链路中 browser-safe 的 record
preparation 和 SessionUpdate construction，再继续使用 daemon 已有的 normalization/reduction
末端。

## 目标

- 提供同步、纯内存、browser-safe 的 raw parsed records 到 transcript projection 函数。
- 将 active chain、same-UUID aggregation 和 history gap 收敛到一个 record preparation
  Module。
- CLI replay、daemon load 和 Web 离线投影共用 record 解释与 SessionUpdate 组装规则。
- live emitters 和 replay machine 共用 pure update builders，保持 live/replay Locality。
- 保留 timestamp、source record identity、parts 顺序、tool start/result 关联、分页状态和
  EOF dangling cleanup。
- 相同输入产生 deterministic projection；不依赖当前 Config 的字段使用确定性 fallback。
- 把持久化 JSON 当作不可信输入，区分调用错误、可恢复损坏和前向兼容未知值。
- 对所有跳过、歧义和截断给出结构化 diagnostic，不能把 partial projection 冒充完整结果。

## 非目标

- 不读取文件或解析 JSONL 文本。
- 不模拟 EventBus、SSE cursor、Last-Event-ID 或 compactedReplay。
- 不从 records 猜测未持久化的 permission、shell、user_shell、cancellation 等 live-only
  block。
- 不把 core 的 Node-only reader、provider 类型或完整运行时带入浏览器 bundle。
- 不保证缺少持久化 call id 时可以无歧义恢复并行同名 tool call。
- 不返回 session artifact store；artifacts 仍属于独立 sidechannel。
- 不把整个 CLI emitter class hierarchy 移入共享 leaf；只共享 pure update builders。

## Architecture

### 1. Record preparation Module

record preparation 的所有权属于 core 的持久化会话模型。新增 browser-safe leaf：

    packages/core/src/utils/transcript-records.ts
      -> @qwen-code/qwen-code-core/transcriptRecords

该 Module：

- 对 unknown records 做 runtime validation；
- 选择显式 leafUuid，或默认选择最后一个有效的非 artifact conversation record；
- 沿 parentUuid 从 leaf 走到 root；
- 遇到缺失 parent 时停止，不拼接早期孤岛，并产生 HistoryGap；
- 按 active chain 顺序聚合同 UUID fragments；
- 使用与 SessionService 当前一致的字段合并规则；
- 识别 cycle、冲突 parentUuid、损坏 record 和跳过的 artifact record；
- 返回新的 top-level records 和 parts arrays，不修改输入；已验证的嵌套 payload 按 readonly
  value 复用，不做无收益的 deep clone。

完整数组和流式索引的读取方式不同，因此共享的是同一组语义 primitives，而不是强迫
SessionTranscriptReader 把全文件载入内存：

    validateTranscriptRecord
    isTranscriptConversationRecord
    selectTranscriptLeaf
    walkTranscriptUuidChain(lookup)
    aggregateTranscriptRecordFragments

`prepareTranscriptRecords` 组合这些 primitives 处理 raw array；SessionService 直接使用组合函数；
SessionTranscriptReader 保留 byte-offset index 和分页读取，但使用同一 classifier、lookup-based
chain walker 和 aggregator。现有 buildOrderedUuidChain 合并进这组实现，不能保留成另一套 walk。

这样既删除两份 aggregateRecords，也修复 Reader 把文件尾 artifact 当 active leaf 的现状差异，
同时不牺牲它的流式索引和按页读取能力。

这个 leaf 只能 import browser-safe 的类型与纯函数，不能 import fs、path、Buffer、
ChatRecordingService class 或 provider runtime。

core 当前没有 exports map。实现时需要为 root、transcriptRecords、package.json 和既有
`./dist/*` deep import 明确保留 package exports；不能为了增加一个 browser leaf 意外封死仓库
已经记录为兼容路径的 `@qwen-code/qwen-code-core/dist/...`。

### 2. Transcript replay Module

SessionUpdate 语义属于 ACP，因此 replay machine 和 pure update builders 放在：

    packages/acp-bridge/src/transcript-replay.ts
      -> @qwen-code/acp-bridge/transcriptReplay

该 Module 隐藏：

- record type/subtype dispatch；
- message parts 顺序；
- text、thought、image 和 function call 转换；
- tool start/result/dangling state；
- Todo/plan、diff/content、usage 和 provenance；
- notification、cron、mid-turn message 和 slash-command result；
- source record metadata；
- 分页 replay state。

删除这个 Module 后，复杂度会重新分散到 CLI replay、live emitters 和 SDK projection，因此
它通过 deletion test，具备足够的 Depth。

### 3. Shared update builders

replay machine 不复制现有 MessageEmitter、ToolCallEmitter 和 PlanEmitter 的 update 组装
规则。acp-bridge leaf 提供仅供 Adapter 使用的 pure builders，例如：

    createUserMessageUpdate
    createAgentMessageUpdate
    createAgentThoughtUpdate
    createUsageUpdate
    createToolCallStartUpdate
    createToolCallResultUpdate
    createPlanUpdate

builders 只接收结构化参数并返回 SessionUpdate，不访问 Config、registry、i18n 或网络。

CLI live emitters：

    runtime input
      -> CLI metadata Adapter
      -> shared builder
      -> sendUpdate

HistoryReplayer：

    prepared ChatRecord
      -> replay machine
      -> shared builder
      -> sendUpdate

SDK offline projection：

    prepared ChatRecord
      -> replay machine
      -> shared builder
      -> id-less DaemonEvent
      -> normalizer/reducer

diff preview、Todo extraction、tool content transformation、usage-to-plan ordering和
provenance fallback 必须位于 shared builders 或其 private helpers 内。live emitter 只保留
异步发送和 runtime enrichment。

### 4. SDK projection Adapter

SDK facade 位于独立 opt-in entry：

    packages/sdk-typescript/src/daemon/ui/chat-record-transcript.ts
    packages/sdk-typescript/src/daemon/transcript.ts
    @qwen-code/sdk/daemon/transcript

它复用 daemon UI normalizer 和 reducer，但不进入默认 @qwen-code/sdk/daemon browser
bundle。调用方只需要安装 SDK，不直接依赖 core 或 acp-bridge subpath。

## Browser-safe package seams

新增两个内部 leaf export：

    @qwen-code/qwen-code-core/transcriptRecords
    @qwen-code/acp-bridge/transcriptReplay

约束：

- 运行时不 import Node builtin；
- 不访问 process、Buffer、DOM 或 storage；
- 对 provider 和 ACP package 尽量只做 type import；
- SDK transcript entry 把 Implementation 内联进发布 bundle；
- SDK 发布的 .d.ts 必须内联 public input/projection 类型，不能引用仅存在于
  devDependency 的 acp-bridge subpath；
- core、acp-bridge 和 SDK transcript bundle 都增加 Node-builtin guard。

## Record preparation Interface

公开 SDK facade 接收 readonly unknown[]。core leaf 内部验证后产生如下结构：

    export interface TranscriptRecordInput {
      readonly uuid: string;
      readonly parentUuid: string | null;
      readonly sessionId: string;
      readonly timestamp?: string;
      readonly type: "user" | "assistant" | "tool_result" | "system";
      readonly subtype?: string;
      readonly message?: {
        readonly role?: string;
        readonly parts?: readonly unknown[];
      };
      readonly usageMetadata?: unknown;
      readonly toolCallResult?: unknown;
      readonly systemPayload?: unknown;
    }

    export interface TranscriptReplayGapInput {
      readonly childUuid: string;
      readonly missingParentUuid: string;
    }

    export interface PreparedTranscriptRecords {
      readonly sessionId?: string;
      readonly records: readonly TranscriptRecordInput[];
      readonly gaps: readonly TranscriptReplayGapInput[];
      readonly diagnostics: readonly TranscriptProjectionDiagnostic[];
    }

### Validation policy

fatal 调用错误直接抛出 TranscriptProjectionInputError，并且不返回 partial result：

    export type TranscriptProjectionInputErrorCode =
      | "invalid_records"
      | "invalid_max_blocks"
      | "leaf_not_found"
      | "mixed_session_ids";

    export class TranscriptProjectionInputError extends TypeError {
      readonly code: TranscriptProjectionInputErrorCode;
    }

- records 不是数组；
- options.maxBlocks 不是正 safe integer；
- 显式 leafUuid 不存在；
- 两个或以上结构有效的不同 sessionId 混在同一次投影中。

SDK entry 统一导出该 error；core 内部 validation error 在 facade 边界映射，不能把内部 package
class 泄漏到 public .d.ts。除此之外，单条 record 损坏不得让整个投影抛错。

单条 record 或嵌套 payload 损坏时尽量保留可恢复历史并产生 diagnostic：

- 非对象、缺失 uuid、非法 parentUuid 或未知 record type：跳过；
- timestamp 非法：保留 record，但该 record 没有 serverTimestamp；
- duplicate UUID 的 parentUuid 冲突：沿用第一个 fragment，并报告冲突；
- parentUuid 缺失：停止 chain，报告 gap；
- parentUuid cycle：停止 chain，报告 cycle；
- 已识别 part 结构畸形：跳过该 part，并标记 projection 不完整；
- 未知前向兼容 subtype/part：跳过并产生 warning，不抛错；
- 已知但不产生 transcript 的 system subtype，例如 chat_compression、ui_telemetry、
  file_history_snapshot 和 artifact records，按既有语义跳过，不影响 complete。

空输入返回空 blocks，complete 为 true。只有 artifact records 的输入同样返回空 transcript，
并带 informational diagnostic。

显式 leafUuid 必须指向 conversation record；只命中 artifact record 等同于 leaf 不存在。artifact
records 不进入 UUID chain，也不参与 duplicate parent 冲突判断。

### Diagnostics

    export interface TranscriptProjectionDiagnostic {
      readonly code: string;
      readonly severity: "info" | "warning" | "error";
      readonly message: string;
      readonly affectsCompleteness: boolean;
      readonly recordIndex?: number;
      readonly recordId?: string;
      readonly path?: string;
    }

diagnostic message 不包含未脱敏的 args、result、token 或 credential。调用方应根据 code
分支，message 只用于日志和默认展示。

projection.complete 的定义：

- 没有 affectsCompleteness 为 true 的 diagnostic；
- 没有 block 或 text truncation；
- replay finalize 完成；
- 没有歧义 tool correlation。

第一版至少稳定以下 diagnostic code；code 是兼容契约，message 不是：

| code                            | affectsCompleteness | 含义                           |
| ------------------------------- | ------------------- | ------------------------------ |
| invalid_record                  | true                | 整条 record 被跳过             |
| invalid_timestamp               | false               | 内容保留，但无历史时间         |
| conflicting_parent_uuid         | true                | 同 UUID fragments 的父节点冲突 |
| history_gap                     | true                | active chain 缺少 parent       |
| parent_cycle                    | true                | active chain 出现环            |
| malformed_part                  | true                | 已知 part 损坏并被跳过         |
| unknown_record_or_part          | true                | 未知扩展可能包含可见内容       |
| ambiguous_tool_call_correlation | true                | tool result 无法唯一关联       |
| presentation_fallback           | false               | 展示 Adapter 失败后已降级      |
| transcript_blocks_truncated     | true                | maxBlocks 裁掉旧 blocks        |
| transcript_text_truncated       | true                | text block 超过字符上限        |

artifact-only 可以使用 info diagnostic，但不影响 complete。后续新增 code 不能改变既有 code 的
affectsCompleteness 语义。

## Replay emission Interface

共享层输出完整 SessionUpdate，并保留 projection provenance：

    import type { SessionUpdate } from "@agentclientprotocol/sdk";

    export interface TranscriptReplayEmission {
      readonly sourceRecordId: string;
      readonly sourceTimestamp?: string;
      readonly emissionOrdinal: number;
      readonly update: SessionUpdate;
    }

emission 对应单次 record projection，因此外层保持 singular sourceRecordId；写入 SessionUpdate
时转换成单元素 sourceRecordIds，供后续 compaction/upsert 安全合并。

    export interface TranscriptReplayUsageState {
      readonly promptTokens: number;
      readonly cachedTokens: number;
      readonly candidateTokens: number;
      readonly apiTimeMs: number;
    }

    export interface PendingTranscriptToolCall {
      readonly callId: string;
      readonly toolName: string;
      readonly sourceRecordId: string;
      readonly sourceTimestamp?: string;
    }

    export interface TranscriptReplayStateV1 {
      readonly v: 1;
      readonly pendingToolCalls: readonly PendingTranscriptToolCall[];
      readonly cumulativeUsage: TranscriptReplayUsageState;
    }

    export interface TranscriptReplayMachineOptions {
      readonly initialState?: TranscriptReplayStateV1;
      readonly gaps?: readonly TranscriptReplayGapInput[];
      readonly presentation?: TranscriptReplayPresentationAdapter;
      readonly onDiagnostic?: (
        diagnostic: TranscriptProjectionDiagnostic,
      ) => void;
    }

replay state 必须 versioned，snapshot 返回 detached copy。initialState 中 malformed pending
entry 被过滤并产生 diagnostic；非法或非 finite usage 重置为零并产生 diagnostic。未知 state
version 直接拒绝，避免以错误状态继续分页。

为兼容部署前已签发的 transcript cursor，缺少 v 但严格符合当前
`{ pendingToolCalls, cumulativeUsage }` 形状的 legacy state 直接提升为 v1；显式出现未知 v 时仍
拒绝。legacy 分支只解析这一个已发布形状，不演化成第二套 state schema。

## 增量 replay machine

    export interface TranscriptReplayMachine {
      project(
        record: TranscriptRecordInput,
      ): Iterable<TranscriptReplayEmission>;
      finalize(): Iterable<TranscriptReplayEmission>;
      snapshot(): TranscriptReplayStateV1;
    }

    export function createTranscriptReplayMachine(
      options?: TranscriptReplayMachineOptions,
    ): TranscriptReplayMachine;

project 返回惰性 iterator。CLI 每取得一条 emission 后立即 await sendUpdate，发送成功后才
请求下一条。这样 generator 中位于 yield 之后的状态变化只会在上一条发送成功后提交。

Interface 要明确以下迭代约束：

- Adapter 必须完整迭代每个 project 返回值；
- 普通 emission 发送失败后停止当前和后续 record；
- tool result 的 pending 解除时点保持与现有行为一致；
- tool start 只有发送成功后才进入 pending；
- usage 必须在相关 plan builder 读取累计值前提交；
- finalize 幂等，第二次调用返回空 iterator；
- finalize 的 CLI Adapter 必须逐条捕获发送错误并继续尝试剩余 dangling cleanup，最后保留
  第一个 cleanup error；
- replay error 与 cleanup error 同时存在时继续使用 AggregateError。

SDK Adapter 没有外部异步发送失败，可以完整消费 iterator。

## Tool call correlation

call id 规则按以下顺序：

1. functionCall.id、toolCallResult.callId 或 functionResponse.id 中的显式持久化 id；
2. 无显式 start id 时生成带保留前缀的稳定 synthetic id，包含 source record UUID 和 part
   index；
3. 无显式 result id 时，只在恰好存在一个同名 pending call 时关联；
4. 没有或存在多个同名 pending call 时不猜测，生成独立 result synthetic id，并产生
   ambiguous_tool_call_correlation diagnostic；
5. 未关联的 start 在 finalize 时按 dangling tool 处理。

synthetic id 使用 qwen-replay-tool: 前缀，并在 machine 内检查与显式 id、先前 synthetic id
的冲突；发生冲突时追加稳定 occurrence suffix。

稳定 fallback 只能保证 deterministic identity，不能保证无信息情况下的正确 correlation。

## Source record provenance

record identity 必须穿过 CLI、daemon 和 SDK，不能只存在于 emission 外层。一个 text block
通常来自一个 record，但一个 tool block 会同时吸收 start 和 result records，因此 wire event 和
block 使用有序去重数组。replay builders 在 SessionUpdate.\_meta 中增加：

    {
      qwenTranscript: {
        sourceRecordIds: ["..."]
      },
      timestamp: 1783958400000
    }

约束：

- sourceRecordIds 不是 EventBus ids，不能写入 event.id 或参与 Last-Event-ID；
- sourceTimestamp 在 Adapter Seam 转成有限 epoch ms，继续复用现有 timestamp 字段；
- history gap emission 使用 `[gap.childUuid]`，并沿用 child record timestamp；
- CLI HistoryReplayer 发送的 SessionUpdate 和 SDK offline Adapter 使用相同 metadata；
- live emitters 没有 persisted record context 时不写 qwenTranscript；
- normalizer 从 qwenTranscript 提升 sourceRecordIds，随后从展示用 meta 中移除内部 transport
  object；
- DaemonUiEventBase 和 DaemonTranscriptBlockBase 增加 optional readonly sourceRecordIds；
- reducer 只在 sourceRecordIds 相等且其他合并条件满足时合并 text/thought/image；
- tool block 继续以 toolCallId upsert，并按事件顺序 union sourceRecordIds；plan 和其他 upsert
  block 使用相同的稳定 union 规则；
- compaction engine 的 text slot key 同样包含 sourceRecordIds，禁止跨 record boundary 合并；
- compaction engine 合并同一 toolCallId 时必须稳定 union qwenTranscript.sourceRecordIds，不能让
  result metadata 覆盖 start provenance；
- sourceRecordIds 的比较和索引使用结构化 equality/Map，不能用未经转义的 delimiter join，避免
  恶意 UUID 制造 key collision；
- 没有 qwenTranscript 的 live events 保持当前 compaction 行为。

这使两种 daemon /load mode 和 offline projection 都保留同一 record 分段，conformance test
不需要依赖测试专用 activeRecordId context。

## 可变展示信息的 Adapter Seam

    export interface TranscriptReplayPresentationAdapter {
      resolveToolMetadata(
        toolName: string,
        args: Readonly<Record<string, unknown>>,
      ): TranscriptReplayToolMetadata;

      formatHistoryGap(gap: TranscriptReplayGapInput): string;
    }

- CLI Adapter 使用当前 Config/tool registry 解析 title、kind、locations，并使用 CLI i18n
  格式化 history gap。
- browser Adapter 使用确定性 fallback：title 为 tool name 加持久化 description 参数，
  kind 为 other，locations 为空，history gap 使用 SDK 固定文案。

Adapter 抛错时 replay machine 使用确定性 fallback 并产生 diagnostic，不能让展示 enrichment
终止整个 transcript。

provenance、Todo/diff/content、usage 和 call correlation 不属于该 Seam，必须由共享
Implementation 决定。

## CLI Adapter

HistoryReplayer 保留现有调用 Interface，但缩减为异步 Adapter：

    prepared records
      -> seed replay state
      -> machine.project(record)
      -> await sendUpdate(emission.update) in order
      -> machine.finalize() when requested
      -> copy machine.snapshot()
      -> clear active replay context

以下行为继续留在 CLI：

- Config/tool registry enrichment；
- CLI i18n history gap 文案；
- messageRewriter.interceptUpdate；
- sendUpdate 的异步失败处理；
- replay error 与 dangling cleanup error 的 AggregateError 组合；
- live-only goal、stop-hook 和其他非持久化事件。

load、paged transcript 和 export 需要采用同一 record preparation 与 replay machine，避免同一
JSONL 在不同入口得到不同 SessionUpdate。

## SDK transcript Interface

    export interface ChatRecordTranscriptOptions {
      readonly leafUuid?: string;
      readonly maxBlocks?: number;
    }

    export interface ChatRecordTranscriptProjection {
      readonly blocks: readonly DaemonTranscriptBlock[];
      readonly diagnostics: readonly TranscriptProjectionDiagnostic[];
      readonly complete: boolean;
      readonly truncated: boolean;
    }

    export function projectChatRecordsToDaemonTranscript(
      records: readonly unknown[],
      options?: ChatRecordTranscriptOptions,
    ): ChatRecordTranscriptProjection;

options.maxBlocks 缺省时离线投影不做 block count trimming。显式传入时必须是正 safe integer；
发生 trimming 时：

- truncated 为 true；
- complete 为 false；
- diagnostics 包含 transcript_blocks_truncated；
- tool/permission/parent indexes 继续遵循 reducer 的安全清理规则。

实现上，缺省值由 offline Adapter 显式传入 Number.MAX_SAFE_INTEGER；不修改在线
createDaemonTranscriptState 的 DEFAULT_MAX_BLOCKS，也不把 Infinity 放进 reducer state。

SDK Adapter 的事件路径：

    TranscriptReplayEmission
      -> id-less DaemonEvent(type = session_update)
      -> normalizeDaemonEvent
      -> reduceDaemonTranscriptEvents
      -> finalizeOfflineDaemonTranscriptState
      -> ChatRecordTranscriptProjection

事件没有 id，因为它不来自 EventBus。sourceTimestamp 作为 serverTimestamp，sourceRecordIds
作为独立 projection provenance。

离线 Adapter 使用固定 reducer clock 0，避免 Date.now 进入可观察字段。同一输入、options 和
presentation Adapter 必须产生 deep-equal projection；真实历史时间由 serverTimestamp
表达。

新增的 private `finalizeOfflineDaemonTranscriptState` 只做离线投影收尾，不从默认 daemon entry
导出：

- 将 active assistant/thought 的 streaming 设为 false；
- 清除 active text 指针；
- 不制造虚假 wire event 或可见 block；
- 不修改已终结 tool status。

单 text block 继续使用 SDK 的安全字符上限。发生字符截断时必须通过 reducer diagnostic hook
报告 transcript_text_truncated，并设置 truncated=true、complete=false；不能只依赖可见的
[truncated] 后缀。

为使 block/text truncation 可观察，DaemonTranscriptReducerOptions 增加 optional
`onTruncation(detail)`。detail 至少包含 kind、blockId，以及存在时的 sourceRecordIds；普通 store
不传 callback，offline Adapter 收集并去重为 projection diagnostics。不要通过扫描
`[truncated]` 文本猜测，因为用户原文可能包含同样后缀。

## Untrusted identifier safety

离线输入中的 uuid、call id 和 parent id 都是不可信字符串。接入前必须将 transcript reducer
中以下索引改为 Map 或 null-prototype object：

- blockIndexById；
- toolBlockByCallId；
- permissionBlockByRequestId；
- activeAssistantBlockByParent；
- activeThoughtBlockByParent；
- trimmed notification maps。

测试必须覆盖 `__proto__`、constructor、prototype、toString 和超长 id，确保不会破坏查找、
父子关系或 trimming cleanup。

## Artifacts

tool result builder 可以继续把持久化 artifacts 放在 SessionUpdate metadata 中，供 daemon
bridge 的 artifact sidechannel 使用。但 DaemonTranscriptBlock 没有 artifact 字段，SDK
offline projection 不返回 artifact store。

因此 conformance 分成两层：

- SessionUpdate conformance 包含 artifacts；
- DaemonTranscriptBlock conformance 明确忽略 artifact sidechannel。

如果未来 WebShellTranscript 需要 artifact 卡片，应新增独立 artifact projection，而不是把
artifact 偷塞进 transcript block。

## 一致性契约

### 强一致部分

CLI replay 与 SDK offline projection 共享 machine，因此以下内容必须一致：

- active chain 和 same-UUID aggregation；
- record/subtype 筛选与 update 顺序；
- message text/thought/image 的支持范围与 part 顺序；
- tool call id、start/result/dangling 状态；
- Todo/plan、diff/content、raw input/output；
- usage、task execution usage 与 plan stats 顺序；
- notification、cron、mid-turn message、slash command 和 gap 插入位置；
- timestamp、sourceRecordIds 和 replay diagnostics。

live emitters 与 replay machine 共享 update builders，因此同一种语义生成的 SessionUpdate
字段必须一致。

### 明确允许的 Adapter 差异

- CLI 当前 Config/tool registry 计算出的 tool title、kind 和 locations；
- CLI 当前 locale 下的 history gap 文案；
- CLI message rewrite 追加的派生消息；
- artifact sidechannel；
- live-only permission、shell、cancellation 和 session events。

如果产品要求 tool metadata 逐字段一致，必须在记录 tool call 时持久化 replay metadata，
并采用“持久化值优先、确定性 fallback”。不能用当前 registry 重算历史真相。

## Conformance tests

测试分六层：

1. core record preparation golden tests：raw append-only fixture 到 active chain、aggregation、
   gaps 和 diagnostics。
2. acp-bridge builder tests：live/replay 输入断言完整 SessionUpdate。
3. replay machine/compaction tests：顺序、versioned state、分页、synthetic id、ambiguous
   correlation、finalize，以及 text/tool compaction 的 sourceRecordIds 保留。
4. CLI Adapter regression tests：异步发送、message rewrite、partial failure、dangling cleanup
   和 AggregateError。
5. SDK projection tests：id-less event、sourceRecordIds、normalization、record 分段、truncation、
   malicious identifiers 和 deterministic blocks。
6. cross-package conformance：同一 raw fixture 走真实 CLI replay 与 SDK offline projection。

cross-package 路径：

    raw records
      -> SDK projectChatRecordsToDaemonTranscript
      -> sdkProjection

    raw records
      -> shared record preparation
      -> CLI HistoryReplayer
      -> captured SessionUpdate with qwenTranscript metadata
      -> SDK normalizer/reducer/finalize
      -> cliProjection

对 canonical projection 做 deep equality。canonicalizer 只忽略明确允许的 Adapter 差异，不能
删除 sourceRecordIds、timestamp、tool status、diagnostics 或 truncation。

另加 daemon integration fixtures，分别验证 response-mode 与 stream-mode /load 产生的 retained
replay 在未触发 window truncation 时与 offline projection 相同。测试必须跨过一个后续 turn
boundary，覆盖 bridge/compaction 对 qwenTranscript metadata 和 timestamp 的保留。

## 与 WebShellTranscript 结合

    import { useMemo } from "react";
    import {
      projectChatRecordsToDaemonTranscript,
    } from "@qwen-code/sdk/daemon/transcript";
    import { WebShellTranscript } from "@qwen-code/web-shell";

    function ReadonlyHistory({ records }: { records: readonly unknown[] }) {
      const projection = useMemo(
        () => projectChatRecordsToDaemonTranscript(records),
        [records],
      );

      return (
        <>
          {projection.complete ? null : (
            <TranscriptDiagnostics diagnostics={projection.diagnostics} />
          )}
          <WebShellTranscript blocks={projection.blocks} />
        </>
      );
    }

SDK 负责数据准备与投影，WebShell 只负责只读渲染。WebShellTranscript 不增加 records prop，
也不启动 provider/session/network。

## 同步性能契约

public facade 是同步 O(records + parts) 投影，并会完整扫描输入，即使显式 maxBlocks 最终只保留
尾部 blocks。maxBlocks 是输出内存限制，不是计算量限制。

实现前必须用小、中、大三档真实 fixture 建立时间和峰值内存基线，并在 SDK 文档记录推荐的
主线程上限。超过该上限的宿主应在 Web Worker 中调用同一个 browser-safe Interface，再把
projection 传给主线程。

第一版不额外提供 async/worker wrapper；出现第二个真实调用方后再决定是否增加该 Adapter，
避免建立只有一个 Adapter 的假 Seam。

## Bundle 与发布约束

转换器不进入默认 @qwen-code/sdk/daemon bundle。新增 package export：

    "./daemon/transcript": {
      "types": "./dist/daemon/transcript.d.ts",
      "import": "./dist/daemon/transcript.js",
      "require": "./dist/daemon/transcript.cjs"
    }

构建要求：

- 独立 browser ESM 和 Node CJS bundle；
- 独立 Node-builtin guard；
- 独立 size budget，并记录基线 commit 与测量命令；
- public .d.ts 不泄漏 core/acp-bridge devDependency；
- 同时 import daemon 和 daemon/transcript 的样例构建要测量重复代码成本；
- 不通过导入 package root 或依赖偶然 tree shaking 保证 browser safety。

默认 daemon 151 KiB budget 不因本功能上调。

## 迁移顺序

1. 在 core 增加 browser-safe transcript record preparation leaf，并让 SessionService 与
   SessionTranscriptReader 共用 classification、leaf selection、chain walk 和 aggregation。
2. 在 acp-bridge 增加 pure SessionUpdate builders，逐步让 live emitters 使用。
3. 增加 replay machine 和 golden tests。
4. 将 HistoryReplayer 改成 CLI Adapter，保持现有调用 Interface 和错误语义。
5. 增加 qwenTranscript metadata，并扩展 bridge、compaction、normalizer 和 reducer 的
   sourceRecordIds 处理。
6. 加固 reducer 的 untrusted identifier indexes 和 truncation diagnostics。
7. 在 SDK 增加 opt-in daemon/transcript facade 与独立发布物。
8. 增加 cross-package conformance 和 daemon integration fixture。
9. 将 WebShell 只读页面接到 projection.blocks，并展示 diagnostics。

每一步都必须先迁移现有消费者再删除旧 Implementation，避免某个阶段同时存在两套 active
chain、aggregation 或 update builder 规则。

## 预计代码规模

- core record preparation 与现有两处迁移：约 180–280 行生产代码；
- acp-bridge builders + replay machine：约 400–550 行；
- CLI HistoryReplayer Adapter：约 60–100 行；
- SDK projection facade、identity 和 diagnostics glue：约 140–220 行；
- reducer safety/truncation 支持：约 60–120 行；
- 其余主要是 fixtures、回归测试和 conformance tests。

这是 cross-package core change。实现前需按仓库 core triage gate 由 maintainer 确认范围；不应
为了压低行数保留重复的 aggregation 或 update builders。

## 有损范围

该投影只能恢复 records 中存在的信息。以下内容明确不可恢复或可能有损：

- permission、shell、user_shell、prompt_cancelled 等 live-only block；
- session artifact store；
- 当前 Config/registry/locale 的历史真值；
- 非支持的 binary/audio/fileData；
- 缺少 parentToolCallId 的旧 sidechain subagent nesting；
- 缺少显式 call id 且存在多个同名 pending tool 时的精确 correlation；
- 单 text block 超过安全字符上限的尾部内容；
- 调用方显式设置 maxBlocks 后被裁掉的旧 blocks；
- 输入损坏、未知扩展或断链导致跳过的内容。

所有会影响完整性的情况都必须产生 diagnostic，并使 complete=false；任何实际裁剪都必须同时
设置 truncated=true。
