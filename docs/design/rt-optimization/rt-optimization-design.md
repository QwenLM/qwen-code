---
description: "Qwen Code agent loop RT optimization design. Reduce response latency by cutting unnecessary LLM rounds and improving routing decisions."
---

# Qwen Code Agent Loop RT 优化技术方案

## 1. 背景与问题定义

### 1.1 现状

Qwen Code 的 Agent Loop 为严格串行模型：

```
User Prompt → [LLM 决策] → Tool Execution → [LLM 决策] → Tool Execution → ... → [LLM 回复] → Idle
               ~3-4s          ~Xms-Ns          ~3-4s          ~Xms-Ns            ~3-4s
```

每一轮 LLM 调用（含网络 RTT + 模型推理）约 3-4s，是端到端 RT 的主要成本。

### 1.2 实测数据

测试场景："我有哪些工作空间"（3 轮 agent loop，2 次工具调用，单次采样）

| 阶段                        | 耗时      | 占比 |
| --------------------------- | --------- | ---- |
| LLM Round 1（决策调 skill） | 3.8s      | 28%  |
| Skill 执行                  | 1ms       | <1%  |
| LLM Round 2（决策调 shell） | 3.0s      | 22%  |
| Shell 执行                  | 2.5s      | 19%  |
| LLM Round 3（文字总结）     | 3.8s      | 28%  |
| 框架开销（状态同步、渲染）  | 0.3s      | 3%   |
| **总计**                    | **13.4s** | 100% |

**结论**：LLM 调用占 78%，工具执行 19%，框架 3%。优化的核心是**减少 LLM 调用次数**和**降低单次 LLM 调用延迟**。

> 注：单次采样、单一场景。19% 工具执行是 shell 慢调用支配，read-heavy 场景下工具执行可降至 <5%。方案落地前需补 ≥3 类场景（写操作、跨工具推理、错误恢复）的基线。

### 1.3 当前架构关键约束

| 约束                | 代码位置                                                                                   | 说明                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| 工具结果无后置控制  | `tools.ts` `ToolResult` 接口 (L422)                                                        | 仅有 `llmContent`/`returnDisplay`/`error`，无法表达"跳过 LLM"                    |
| 结果无条件回传 LLM  | `useGeminiStream.ts` `handleCompletedTools` (L2038) → `submitQuery(ToolResult, …)` (L2355) | 所有 gemini-initiated 工具结果都回传                                             |
| Stream 完毕后才调度 | `useGeminiStream.ts` `processGeminiStreamEvents` (L1365)                                   | stream 循环结束后才 `scheduleToolCalls`，无增量调度                              |
| 模型层选择无策略层  | `client.ts` `modelOverride ?? getModel()` (L1305, L1598)                                   | 基础设施已贯通至 `turn.run(model, …)` (L1707)，但调用方仅在 skill 显式指定时使用 |

### 1.4 已就绪的基础设施（本方案大量复用）

| 能力                                           | 位置                                                   | 现状                                                                   |
| ---------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| `fastModel` 配置 + `/model --fast <id>`        | `config.ts:684`, `1987`, `2021`                        | 已就绪                                                                 |
| `SendMessageOptions.modelOverride`             | `client.ts:142` → `1598` → `turn.run`                  | 端到端贯通至 `geminiChat.sendMessageStream(model, …)`                  |
| 钩子层 `modelOverrideRef`（承载 skill 选模型） | `useGeminiStream.ts:376`, `2225`, `1841`               | 已贯通                                                                 |
| fast-model **非流式** side query 先例          | `services/toolUseSummary.ts:108`（via `runSideQuery`） | 已上线，证明 fast 模型配置健全；但**非流式路径**                       |
| fast-model **流式** 先例                       | `followup/speculation.ts:224`                          | 已上线，但**用的是 forked chat**（`createForkedChat`），与主 chat 隔离 |

**关键空白**：**没有任何生产代码**在主 chat 上以 fast model 跑 streaming。本方案 D2 是首个 case，需先做验证实验（详见 §3.2 前置条件）。

---

## 2. 设计原则

1. **通用性**：方案不绑定特定 tool/skill
2. **向后兼容**：现有工具无需修改即可继续工作
3. **渐进式 + 显式信号**：策略默认 conservative，由工具作者通过显式字段 opt-in 优化
4. **可回滚**：所有优化通过 feature flag 控制；用户级别可强制关闭
5. **诚实的权衡**：明确标注质量风险、成本风险和适用边界

---

## 3. 优化方案

### 3.1 方向一：工具后置执行指令（ToolResult Post-Execution Directive）

#### 问题

当前 `ToolResult` 不包含任何关于"接下来该怎么做"的信息。无论工具结果是否自解释，都无条件触发一轮 LLM。

#### 设计

扩展 `ToolResult` 接口（`packages/core/src/tools/tools.ts` L422）：

```typescript
export interface ToolResult {
  llmContent: PartListUnion;
  returnDisplay: ToolResultDisplay;
  error?: { message: string; type?: ToolErrorType };

  // 新增：后置执行指令
  postExecution?: {
    /**
     * 工具结果不回传 LLM，直接作为最终回复展示给用户。
     * 适用于结果完全自包含、不需要模型再解读的场景。
     * 是 ToolResult 局部属性。
     */
    skipLlmRound?: boolean;

    /**
     * 工具结果"自包含、可直接展示给用户"——即 `returnDisplay` 已经是
     * 用户期望看到的最终形态，不需要模型加工。
     * 是 ToolResult 局部属性，**不**预测"下一轮是否 summary"。
     * 与方向三（展示解耦）联动：true → 进入 Summarizing 状态允许用户输入。
     */
    resultIsTerminal?: boolean;
  };
}
```

> **设计修正**：早期版本曾把单一 `selfExplanatory` 字段同时承担"工具产物属性"和"对话流预测信号"两份职责，但二者并不重合（例：用户 prompt 是"读 X 然后修 Y"，read_file 输出自包含，但下一轮显然不是 summary）。**预测信号属于对话流全局属性**，不应通过工具字段表达——D2 改为完全用对话流启发式（见 §3.2）。

#### 行为变更

`handleCompletedTools` 中新增判断：

```
工具批次完成
  → 检查 batch 中所有工具的 postExecution.skipLlmRound
  → 全部为 true?
    → YES: markToolsAsSubmitted, 不调 submitQuery, 直接 idle
    → NO: 保持现有行为 (submitQuery)
```

**重要约束**：`skipLlmRound` 仅在**当前 batch 的所有工具都声明 skip** 时才生效。混合 batch 仍然回传。

#### 历史不变量

跳过 LLM 后历史形如：`user → function_call → function_response → <无 assistant>`。

- 复核 `repairOrphanedToolUseTurnsInHistory`（session-load 时调用）是否容忍此形态
- 复核 auto-compaction 在缺少 assistant 文本时的行为
- PR #4176 刚关闭过 tool_use↔tool_result 不变量，落地前需补单测覆盖"skip 后下一轮 user message"的 alternation
- Qwen / OpenAI 风格 API 容忍；Anthropic 严格 alternation —— 后续若支持 Anthropic 直连需要兜底（向 history 注入空 assistant text）

> **统一修复点**：此处和 §3.3（D3 中途打断 Summarizing）破坏的是**同一个历史不变量**。修复方案二选一（注入空 assistant / 接受 Qwen 容忍），两个方向必须使用相同选择。

#### 信号生态（Phase 2 工作）

| 工具                                  | `skipLlmRound`       | `resultIsTerminal` | 备注                                                            |
| ------------------------------------- | -------------------- | ------------------ | --------------------------------------------------------------- |
| `read_file`                           | 配合 query-only 场景 | true               | 文件内容即答案                                                  |
| `cat`（via shell）                    | 视场景               | true               | 同 read_file                                                    |
| `grep` / `glob` / `ls`                | false                | **false（默认）**  | 结果常需模型挑选/排序/总结；skill 层在已知"纯查询"场景显式 true |
| `git status` / `git log`（via shell） | false                | true               | 输出已格式化                                                    |
| Skill 工具                            | 各 skill 自决        | 各 skill 自决      | 查询类 skill 倾向 true                                          |
| MCP 工具                              | 默认 false           | 默认 false         | 通过 allowlist 显式 opt-in                                      |

第三方/MCP 工具不可信任，默认不打标；通过 `config.toolPostExecAllowlist` 显式启用。

> `grep/glob/ls` 默认 false 是从严选择：避免 D2/D3 在需要模型总结排序的场景误判。

#### 适用与不适用

- **适用**：终态查询（read/cat/print 类型）、自包含结果（skill 已格式化输出）
- **不适用**：多步任务中间步骤、写操作确认、需解读的复杂日志

#### 风险与缓解

| 风险                                       | 严重度 | 缓解                                       |
| ------------------------------------------ | ------ | ------------------------------------------ |
| 工具错误设置 skipLlmRound 导致多步任务中断 | 中     | batch 级语义 + llmContent 仍在历史中可恢复 |
| 第三方工具滥用                             | 中     | MCP 默认禁用，allowlist 显式开启           |
| 历史不变量破坏                             | 中     | 落地前补单测；session-load 重放覆盖        |
| 用户预期不一致（期望总结但没有）           | 低     | setting `alwaysSummarize: true` 可覆盖     |

#### 收益

终态查询场景节省 3-4s（跳过最后一轮 LLM）。

---

### 3.2 方向二：summary 轮 fast-model 路由策略

#### 定位

**本方向不引入新管道，但需要扩展 GeminiChat 接口以支持运行时模型切换**。

§1.4 的基础设施提供了 fast 模型配置和 modelOverride 端到端贯通，但**主 chat 上跑 fastModel + streaming 没有先例**，需要：

- 决策函数：何时把 `config.getFastModel()` 作为 override 传下去
- 安全回退：`GeminiChat.retryStreamWithModel` 新接口（处理 chat 内部状态）
- 实验验证：主 chat 切换 fast/primary 不破坏 compaction / history-recording

#### 应用范围

D2 仅作用于：

- **useGeminiStream**（TUI 主路径）—— `sendMessageStream` 调用点 L1841
- **ACP Session**（IDE 集成路径）—— `acp-integration/session/Session.ts:1182`，Phase 3 同步改造

D2 **不作用于**以下路径，避免在非交互或独立上下文里引入额外失败模式：

- **Subagent 运行时**（`agents/runtime/agent-core.ts:614`）：子 agent 已带独立模型配置
- **Cron 触发 turn**（`SendMessageType.Cron`, client.ts:127）：非交互，无 RT 紧迫性
- **Notification turn**（`SendMessageType.Notification`, client.ts:129）：同上

#### 核心难点

`submitQuery` 调用时**我们并不知道**模型看完结果后是发起新工具还是直接出文字。如果用 fast model 调而模型实际还要调工具——后果是**静默的**：fast 可能调错工具或参数错，错误不会有明显信号。

**任何工具级别的字段都无法可靠预测**"下一轮是否 summary"，因为它取决于对话流（user prompt + 累计上下文），不是工具产物的局部属性。例：

```
用户："读 utils.ts 然后把里面的 console.log 都改成 logger.info"
  → Tool 1: read_file → 结果自包含
  → 但下一轮显然不是 summary
```

因此 D2 完全用**对话流启发式**预测，不依赖工具字段。

#### 决策函数：对话流启发式 + 否决

```typescript
import { Kind, MUTATOR_KINDS } from '../tools/tools.js';

function selectContinuationTier(
  turn: Turn,
  userPrompt: string,
  batch: ToolCall[],
): 'fast' | 'primary' {
  // ===== 用户级别强制开关（最高优先级） =====
  const userPref = config.getSummaryTierStrategy();
  if (userPref === 'always_primary') return 'primary';
  if (userPref === 'always_fast') return 'fast'; // 仍受运行时保险约束

  // ===== 用户意图否决 =====
  // 1. user prompt 含动作动词 → 下一轮大概率还要调工具
  if (requestImpliesFurtherAction(userPrompt)) return 'primary';

  // 2. 本轮已有 mutator 工具 → 大概率有验证/读后续
  if (batch.some((c) => MUTATOR_KINDS.includes(c.tool.kind))) return 'primary';

  // 3. 本轮或历史有未解决 error → 模型需要 primary 诊断
  if (hasUnresolvedError(turn.toolResults, batch)) return 'primary';

  // ===== 输出复杂度否决 =====
  // 4. user prompt 要求深度分析（解释/对比/为什么类）
  if (needsDeepReasoning(userPrompt)) return 'primary';

  // 5. 工具调用 ≥3 个不同工具 → 跨结果叙述靠 primary
  if (needsCrossResultReasoning(turn)) return 'primary';

  // 6. 工具输出过长 → 长内容总结靠 primary
  if (estimateTotalToolOutputTokens(turn) > 4000) return 'primary';

  // ===== 模型可行性否决 =====
  // 7. fast 模型 context window 不够 → 切到 fast 会触发 compression
  //    （compression 自身要 LLM 调用，反而拖慢且增加成本）
  if (wouldTriggerCompression(turn.history, config.getFastModel()))
    return 'primary';

  // ===== 多语言兜底 =====
  if (!isPromptLanguageSupported(userPrompt)) return 'primary';

  // ===== Session 状态兜底 =====
  if (turn.justCompacted || turn.justCleared) return 'primary';

  return 'fast';
}
```

八个否决项含义：

- **`requestImpliesFurtherAction`**：动作动词（`改|删|加|替换|修复|实现|新建|create|fix|change|add|remove|implement|write|update`）→ 多步任务
- **`MUTATOR_KINDS` 命中**：本轮已经写过 → 大概率紧跟一次读/校验。**复用 `tools.ts:806` 已有的 `MUTATOR_KINDS = [Edit, Delete, Move, Execute]`**（每个 Tool 实例的 `kind: Kind` 属性是权威分类，不要重新发明 `isWriteTool`）
- **`hasUnresolvedError(turnResults, currentBatch)`**：判定二段——
  - **当前批次任何 error → 总是未解决**（不假设并行批次能自我纠错）
  - **历史按 `(toolName, args fingerprint)` 去重，最后一次仍 error 视为未解决**（仅按 toolName 在同名不同参数下会判错）
  - shell 等需正确填 `ToolResult.error`（前置数据质量依赖）
- **`needsDeepReasoning`**：含"分析/解释/为什么/对比/诊断"类关键词
- **`needsCrossResultReasoning`**：distinct 工具调用 ≥3（同工具同参数视为同一次）
- **输出 tokens > 4000**：经验阈值，**待 fast 模型基线实测后调整**
- **`wouldTriggerCompression`**：fast 模型 context window 通常小于 primary，相同 history 在 fast 上会更早触发 `tryCompress`（geminiChat.ts:1418）—— compression 自身需要一次 LLM 调用，可能**反向恶化 RT 和成本**。预算估算：`estimateHistoryTokens(history) > fastModelContextWindow × COMPACTION_THRESHOLD` 即视为会触发
- **未支持语言**：仅检测中英文关键词，其他语言（日韩等）默认 primary
- **session 状态突变**：刚 `/compact` 或 `/clear` 后第一次 continuation → primary 重建 mental model

否决方向**偏向 primary**（宁可多 2s 不要降质）。

#### 关键实现：`GeminiChat.retryStreamWithModel`

**问题**：直接 abort + 调 `client.sendMessageStream` 会破坏 chat 状态：

1. `geminiChat.ts:1428` 在 stream 启动时就 push `userContent` 到 history；重起会**再 push 一次**导致 history 出现重复 `function_response`
2. `sendPromise` 锁（`geminiChat.ts:1392, 1398`）—— abort 后需要确保 `streamDoneResolver` 被调用
3. `pendingPartialState` 等 PR #4176 引入的不变量 marker 需要正确清理
4. Telemetry span 的 model 属性需要更新

**新增接口**（`packages/core/src/core/geminiChat.ts`）：

```typescript
/**
 * Retry an in-flight or just-aborted streaming send with a different model.
 * Does NOT re-push userContent (kept from original send).
 * Resets pendingPartialState; releases stale sendPromise; re-opens span.
 */
async retryStreamWithModel(
  model: string,
  signal: AbortSignal,
): Promise<AsyncGenerator<StreamEvent>>;
```

调用契约：

- 仅在原 send 已经 abort 后调用（不并发）
- prompt_id 复用（同一用户意图）
- 历史中已经 push 的 userContent 不再 push

实现工作量约 1.5d 加单测。

#### 运行时保险

`selectContinuationTier` 返回 `'fast'` 但 stream 中出现 `ServerGeminiEventType.ToolCallRequest` 事件 → **立即 abort 当前流，调 `retryStreamWithModel(primaryModel)`**。

这覆盖"预测为 summary 实际仍需工具"的唯一静默放错场景。代价：一次 fast 调用浪费的 tokens（成本归因见 §5.3）。

#### 与 skill `modelOverride` 解耦

`useGeminiStream.modelOverrideRef`（L376, L2225）当前承载 **skill 显式选择的模型**，属"业务语义"。本方向的 fast 路由属"优化语义"，两者**必须分离**：

```typescript
// 新增独立 ref
const summaryTierRef = useRef<'fast' | 'primary' | undefined>(undefined);

// 调用点合并（不复用 modelOverrideRef）
const stream = geminiClient.sendMessageStream(
  finalQueryToSend,
  abortSignal,
  prompt_id!,
  {
    type: submitType,
    notificationDisplayText: metadata?.notificationDisplayText,
    modelOverride:
      modelOverrideRef.current ?? // skill 显式选择优先
      (summaryTierRef.current === 'fast' ? config.getFastModel() : undefined),
  },
);
```

生命周期：

| 时机                                       | `modelOverrideRef`（skill） | `summaryTierRef`（fast 路由）            |
| ------------------------------------------ | --------------------------- | ---------------------------------------- |
| 新 user turn (`!Retry && !ToolResult`)     | 清空                        | 清空                                     |
| skill 工具返回 `modelOverride` 字段        | 写入                        | 不变                                     |
| tool batch 完成 → `selectContinuationTier` | 不变                        | 写入                                     |
| Runtime fallback（看到 ToolCallRequest）   | 不变                        | 升级为 `'primary'`                       |
| Retry（用户手动 Ctrl+Y）                   | 保留                        | 升级为 `'primary'`（fast 失败不再 fast） |

skill 显式选择**永远赢**——用户的显式意图优先于优化策略。

#### Telemetry 修正

`client.ts:1303` 的 interaction span 在 turn 启动时记录 `model` 属性。fallback 触发时 model 实际变了，span 数据失真。需要：

```typescript
// fallback 触发时
span.setAttribute('llm.model.requested', fastModel);
span.setAttribute('llm.model.actual', primaryModel);
span.setAttribute('llm.fallback.reason', 'tool_call_seen');
```

并在 `addUserPromptAttributes` 中区分 `requested` / `actual` 模型，避免计费/审计混淆。

#### 用户级别强制开关

新增 setting（`packages/cli/src/config/settingsSchema.ts`）：

```typescript
summaryTierStrategy: 'auto' | 'always_primary' | 'always_fast';
// default: 'auto'
```

- `'auto'`：使用 `selectContinuationTier`（推荐）
- `'always_primary'`：完全禁用 D2 优化（生产敏感场景）
- `'always_fast'`：跳过 vetoes，**仍受运行时保险约束**（高级用户）

理由：D2 是质量换速度，部分用户/场景需要明确退出权。

#### 前置条件

- `config.getFastModel()` 已配置
- **主 chat fastModel-streaming 验证实验**（编码前 1d）：
  - mock 一个 `resultIsTerminal=true` 工具，在主 chat 反复触发 summary 轮
  - 观察 `tryCompress` 是否被错误触发（fast 模型 context window 小可能提前触发）
  - 观察 chatRecordingService 输出是否有 model mismatch
  - 观察单次 fast 调用后下一次 primary 调用是否能正常读 history
- **Fast 候选模型基线测量**（1d）：
  - 跑 100 条 summary 轮 prompt（输入含 `function_response`），测 P50/P95 端到端延迟与 time-to-first-token
  - 测 `tryCompress` 触发率 `P_compact`，验证净 RT 收益 = `(1 - P_compact) × ΔRT − P_compact × compression_RT > 0`
  - 仅当 fast P50 ≤ primary P50 × 0.5 且 P95 ≤ primary P95 × 0.6 时启用
- Fast model 与 primary model 同家族（避免 function_response 编码差异）；跨家族需 `getFastModel()` 层校验拒绝
- **`thinkingConfig` 兼容性**：
  - Fast 模型必须与 primary 在 `thinkingConfig.includeThoughts` 支持上一致；或
  - Fast 路径强制 `includeThoughts: false`（与 `sideQuery.ts:118-122` 对齐）
  - 验证：history 含 thought parts 时 fast 模型能正确处理（不报错、不把 thought 当用户输入）

#### 风险与缓解

| 风险                                                                      | 严重度 | 缓解                                                                                                                                 |
| ------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Fast 模型 tool-calling 静默放错                                           | 高     | 对话流启发式 + 运行时 ToolCallRequest abort 保险                                                                                     |
| Fast 在含 error 的输入上幻觉成"对用户可见的错误回答"                      | **高** | `hasUnresolvedError` 否决；监控用户追问率（注：`emitToolUseSummaries` 的同类风险只影响 60 token 标签，本风险影响最终回答，量级更高） |
| Fast 路径触发 `tryCompress` → 多一次 LLM 调用，**反向恶化 RT 和成本**     | **高** | `wouldTriggerCompression` 预判 gate（见决策函数 #7）；前置基线测量 P_compact 阈值                                                    |
| Compression 自身用谁的模型                                                | 中     | 触发 compression 即放弃 fast 路由（gate #7 兜底）；避免回答出问题                                                                    |
| 主 chat 切模型让 chat 内部状态/recording 异常                             | 中     | 前置验证实验覆盖；session resume 重放测试                                                                                            |
| D2 与 `emitToolUseSummaries` 同时触发 concurrent fast 调用，超 rate-limit | 中     | 二选一：D2 启用时禁用 `emitToolUseSummaries`（标题不影响功能），或共享 rate-limit token bucket                                       |
| `thinkingConfig` 在 fast / primary 间不一致导致 history 解析异常          | 中     | 同家族 + fast 路径强制 `includeThoughts: false`（见前置条件）                                                                        |
| Fallback 路径反而更贵（fast tokens 浪费 + primary 全程）                  | 中     | `fast_tokens_consumed` 决策日志监控；fallback 率 >20% 自动关 flag                                                                    |
| Telemetry span model 失真                                                 | 中     | `requested` / `actual` 拆分（见 Telemetry 修正）                                                                                     |
| 上下文格式不兼容（跨家族）                                                | 中     | `getFastModel()` 拒绝跨家族选择                                                                                                      |
| 与 skill modelOverride 语义冲突                                           | 中     | 独立 ref + skill 优先                                                                                                                |
| `/model` 运行时切换主模型后 `summaryTierRef` 决策失效                     | 低     | `/model` 命令处理时同步清空 `summaryTierRef`                                                                                         |
| fast tokens/s 反而更慢                                                    | 低     | 实测时同时测 TTFT，不只总 RT                                                                                                         |

#### 收益（待实测）

- **RT**：summary 轮节省 2-3s（实测前不写入 PR 标题）
- **成本**：fast 模型单价通常显著低于 primary，高频 summary 场景下 token 成本可能下降 30-50%；但 fallback 路径浪费会抵消部分收益，需用 `fast_tokens_consumed` 实测确认净收益

---

### 3.3 方向三：结果展示与交互解耦（Presentation Decoupling）

#### 问题

用户从工具完成到可以再次输入，必须等 LLM 总结轮完成：

```
工具完成 → [渲染结果] → [submitQuery] → [等 LLM 流式回复 3-4s] → Idle → 可输入
                                         ~~~~~~~~~~~~~~~~~~~~~~~~
                                         用户已看到结果但无法操作
```

#### 设计

新增 `StreamingState.Summarizing` 状态：

```typescript
export enum StreamingState {
  Idle = 'idle',
  Responding = 'responding',
  WaitingForConfirmation = 'waiting_for_confirmation',
  Summarizing = 'summarizing', // 新增
}
```

#### 状态机变更

```
工具完成且结果已展示
  → 若 batch 全员 postExecution.resultIsTerminal === true:
    → 进入 Summarizing（用户可输入）
    → submitQuery 异步执行
    → LLM 总结追加到 history（或被用户新消息取消）
  → 否则:
    → 保持 Responding（用户不可输入）
```

#### 用户新消息处理

- `Summarizing` 状态下用户提交新消息 → abort 当前总结 → 处理新消息
- 已生成的**部分总结文本丢弃**（不入 history），避免半句 assistant 污染上下文
- `function_response` 仍保留在 history（模型知道工具执行了）
- followup suggestion 等 Summarizing 完成或被取消后再触发

#### Abort 时 partial text 清理清单

partial text 分布在多处，需**同时**清理，缺一会导致状态不一致：

| 位置                                                           | 清理动作                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pendingHistoryItemRef.current`（useGeminiStream React state） | 置 `null`，不调 `addItem`                                                                 |
| `GeminiChat.history` 内部累积                                  | abort 前若已 push 部分 assistant content，需通过新的 `discardPendingAssistant()` 接口回滚 |
| `ChatRecordingService` buffered turn                           | 标记为 cancelled，不写入 JSONL                                                            |
| `dualOutput.emitText`（如启用）                                | 发送 abort sentinel，sidecar 自行丢弃                                                     |
| `loopDetectorRef` 累积 token                                   | 重置当前 turn 计数                                                                        |

执行顺序：abort signal 触发 → 收齐上述五处清理 → 才允许新 user message 进入 `submitQuery`。竞态测试覆盖：abort 触发瞬间正好收到最后一个 chunk。

#### 适用条件

batch 全员 `postExecution.resultIsTerminal === true`。

#### 历史不变量（与 §3.1 同源）

中途打断 Summarizing 会产生：

```
[user_1, function_call, function_response, user_2]
                                          ↑ 无 assistant turn
```

**这与 §3.1 跳过 LLM 轮破坏的是同一个不变量**，必须使用与 D1 相同的修复策略（注入空 assistant / 接受 Qwen 容忍）。

- 复用 D1 的不变量单测覆盖
- session-load 重放（含 `repairOrphanedToolUseTurnsInHistory`）必须覆盖此形态
- Anthropic alternation：直连时与 D1 同时补兜底

#### 风险与缓解

| 风险                                | 严重度 | 缓解                                                           |
| ----------------------------------- | ------ | -------------------------------------------------------------- |
| Abort 时半句 assistant 进 history   | **中** | 显式丢弃 partial text；仅保留 function_response；单测覆盖 race |
| 历史不变量破坏（无 assistant 接续） | **中** | 与 D1 同源问题，统一修复（见 §3.1 历史不变量）                 |
| UI 状态复杂度增加                   | 中     | Summarizing = Idle + 背景任务；输入路径复用 Idle               |
| 用户感知收益依赖行为模式            | 低     | 用户若 3s 内不输入，summary 已完成 → 无感知收益；但**不退化**  |

#### 收益

- **理论上限**：3-4s 感知 RT（用户工具完成即输入）
- **实际中位数**：取决于用户输入间隔——读结果 2-5s 后才输入的用户不会感受到差异，但**绝不会更慢**

---

### 3.4 方向四：流式提前调度（Stream-Ahead Scheduling）

#### 问题

`processGeminiStreamEvents` 在 stream 完全结束后才批量调度工具。`ToolCallRequest` 事件可能在 stream 中期就已 yield。

#### 设计

在 stream 事件处理中对 `ToolCallRequest` 立即开始**前置验证**（不执行）：

```typescript
case ServerGeminiEventType.ToolCallRequest:
  toolCallRequests.push(event.value);
  scheduler.prevalidate(event.value, signal);  // 新增
  break;
```

`CoreToolScheduler.prevalidate(request)`：

1. 查找工具注册
2. 构建 invocation
3. 执行 `shouldConfirmExecute`（缓存结果）
4. `schedule()` 时直接使用缓存结果

#### 纯度契约与 Allowlist

`prevalidate` 要求 `shouldConfirmExecute` 是 side-effect-free **且**结果在 prevalidate→schedule 间隙不会被外部修改使之失效。

**直接复用 `tools.ts:818` 的 `CONCURRENCY_SAFE_KINDS`**：

```typescript
export const CONCURRENCY_SAFE_KINDS: ReadonlySet<Kind> = new Set([
  Kind.Read,
  Kind.Search,
  Kind.Fetch,
]);
```

这是项目已有的"无副作用 + 可并发"分类，正好匹配 prevalidate 需求。

| 工具 Kind                     | 是否在 allowlist        | 理由                                                    |
| ----------------------------- | ----------------------- | ------------------------------------------------------- |
| `Read`（read_file 等）        | ✅                      | 纯读                                                    |
| `Search`（grep / glob）       | ✅                      | 纯读                                                    |
| `Fetch`（web_fetch 等）       | ✅                      | 远程读，无写副作用                                      |
| `Edit`                        | **❌**（见下文 TOCTOU） | shouldConfirmExecute 纯只读，但 diff 在调度间隙可能失效 |
| `Delete` / `Move` / `Execute` | ❌                      | MUTATOR_KINDS                                           |
| `Think`                       | ❌                      | 含 save_memory / todo_write 等隐式写                    |
| MCP 工具                      | ❌                      | 不可信                                                  |

**TOCTOU：为什么 Edit 不进 allowlist**

理论上 Edit 的 `shouldConfirmExecute` 是纯只读（读文件、算 diff）。但 prevalidate 与 schedule 之间存在时间窗：

```
T=0      stream 收到 Edit(file=a.ts, ...) → prevalidate
T=10ms   shouldConfirmExecute 读 a.ts，缓存 diff_v0
T=300ms  stream 结束，scheduler.schedule()
T=305ms  期间其他工具/IDE/外部进程修改 a.ts
T=310ms  scheduler 用 diff_v0 展示给用户
T=320ms  用户基于 v0 确认
T=330ms  Edit 应用旧 params 到 v1 文件 → 内容损坏 / merge 失败
```

这是 TOCTOU。修复方向：

- **A（推荐）**：Edit 不进 allowlist，prevalidate 仅覆盖 `CONCURRENCY_SAFE_KINDS` 三类。代价：收益从"50-200ms（Edit 主导）"降到"50-100ms（仅读类）"
- **B（可选加强）**：Edit 进入 allowlist 但缓存附 `(mtime, size, content_hash)`；schedule() 时校验未变才用缓存，否则重算

文档暂选 A。

#### 与现有并行调度的交互

`coreToolScheduler.attemptExecutionOfScheduledCalls`（L2436+）使用 `partitionToolCalls` 把工具分成"并发安全 batch"和"串行 batch"，并发 batch 通过 `runConcurrently`（L2473）执行。

prevalidate 必须与这个分批模型对齐：

- 缓存按 `callId` 索引（不是 `(toolName, args)`，避免并发同名调用冲突）
- prevalidate 失败的 call → 不影响其他 call，schedule 时该 call 走原始 `shouldConfirmExecute` 路径
- stream 取消时按 `signal` 级联 abort 所有 in-flight prevalidate

#### 风险

| 风险                                       | 严重度 | 缓解                                                                   |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------- |
| 缓存 diff 与确认时实际文件不一致（TOCTOU） | 高     | 方案 A：Edit 不进 allowlist；方案 B：缓存附 `(mtime, size, hash)` 校验 |
| prevalidate 失败影响调度                   | 低     | 失败/超时退回原 `shouldConfirmExecute` 路径，缓存缺失 ≡ 未启用         |
| 并发 prevalidate 共享 fd / 资源争抢        | 低     | `QWEN_CODE_MAX_TOOL_CONCURRENCY` 已限并发上限（默认 10）               |

#### 收益

50-100ms/轮（仅 `CONCURRENCY_SAFE_KINDS` 范围）。若选方案 B 含 Edit，理论收益 100-200ms。

---

## 4. 综合评估与路线图

### 4.1 综合评估

| 方向                 | RT 收益                       | 实施复杂度               | 质量风险 | 依赖                                        | 优先级 |
| -------------------- | ----------------------------- | ------------------------ | -------- | ------------------------------------------- | ------ |
| D1 工具后置指令      | 3-4s/终态轮                   | 低（2-3d）               | 低       | 无                                          | **P0** |
| D2 summary fast 路由 | 2-3s/summary 轮（待实测）     | **中-高（9d）**          | 中-高    | D2 自带启发式 + 主 chat 验证实验 + ACP 同步 | **P1** |
| D3 展示解耦          | 3-4s 感知改善（依赖用户行为） | 中（3-5d，含不变量修复） | 中       | D1 历史不变量修复                           | **P1** |
| D4 流式提前调度      | 50-200ms/轮                   | 高（5-7d）               | 极低     | 无                                          | P2     |

#### D2 工作量细分

| 子任务                                                                                     | 估时   |
| ------------------------------------------------------------------------------------------ | ------ |
| 主 chat fastModel-streaming 验证实验（含 P_compact 测量）                                  | 1d     |
| Fast 候选模型基线测量（含 TTFT、P95、`thinkingConfig` 兼容性）                             | 1d     |
| `selectContinuationTier` + `summaryTierRef` 接入（useGeminiStream）                        | 0.5d   |
| 启发式实现（含 `MUTATOR_KINDS` 复用 / `wouldTriggerCompression` 估算 / 多语言 / 状态突变） | 1d     |
| `GeminiChat.retryStreamWithModel` + `discardPendingAssistant` 接口实现                     | 1.5d   |
| ACP Session 同步改造（acp-integration/session/Session.ts）                                 | 1d     |
| Telemetry span 修正（`requested` / `actual` 拆分）                                         | 0.5d   |
| User-level setting `summaryTierStrategy` + JSON schema + `/config` 集成                    | 0.5d   |
| 单测（race、abort 时机、history 不变量、fallback 路径、ACP 路径）                          | 2d     |
| **合计**                                                                                   | **9d** |

> 注：早期估时 6.5d 未含 ACP 路径、`wouldTriggerCompression` gate、清理清单、settings schema 工程化等成本。

### 4.2 实施路线

#### Phase 1：D1 工具后置指令（1 周）

- 扩展 `ToolResult.postExecution`（tools.ts L422）：`skipLlmRound` + `resultIsTerminal`
- `handleCompletedTools` 实现 `skipLlmRound` 短路（useGeminiStream.ts L2038）
- 单测覆盖历史不变量
- **Phase 1 不消费 `resultIsTerminal`**（留给 Phase 3）

#### Phase 2：信号生态建设（2 周，与 Phase 4 并行）

- 内置工具陆续打标 `skipLlmRound` / `resultIsTerminal`（见 §3.1 表）
- 验证打标覆盖率 ≥60%（按 turn 数加权，非按调用次数）
- 收集 production 数据，校准 §3.2 否决 gate 阈值
- Phase 2 末期跑 §3.2 主 chat 验证实验和基线测量

#### Phase 3：D2 + D3（约 3 周，含 ACP 同步）

> **修正**：早期路线图估 1 周，未含 fastModel-streaming 验证实验、`retryStreamWithModel` 实现、不变量统一修复、ACP 路径同步。

- 编码前：完成主 chat 验证实验 + 基线测量（含 `P_compact` 与 thinkingConfig 兼容性）
- 新增 `summaryTierRef` + `selectContinuationTier`（含 `wouldTriggerCompression` gate）
- 新增 `GeminiChat.retryStreamWithModel` + `discardPendingAssistant`
- **同步改造 ACP Session 路径**（acp-integration/session/Session.ts）使用同一决策函数
- 新增 `StreamingState.Summarizing` + 输入路径复用 + abort 清理清单
- 历史不变量统一修复（D1+D3 同源）
- Feature flag `experimental.summaryRoundFastModel: false`，**Release N 默认关**
- User setting `summaryTierStrategy`
- Telemetry span 修正
- 运行时保险（ToolCallRequest abort + retryStreamWithModel）

#### Phase 4：D4 流式提前调度（可独立插入）

- `CoreToolScheduler.prevalidate` + allowlist
- `processGeminiStreamEvents` 增量调度

---

## 5. 度量、验收与限制

### 5.1 性能指标

| 指标                       | 基线  | Phase 1 | Phase 3                   |
| -------------------------- | ----- | ------- | ------------------------- |
| 端到端 RT P50（3 轮 loop） | 13.4s | <10s    | <8s（待实测）             |
| 端到端 RT P95              | -     | <13s    | <12s（fallback 路径上限） |
| 用户感知首结果时间 P50     | 13.4s | <10s    | <5s（D3 启用）            |
| 用户感知首结果时间 P95     | -     | <13s    | <8s                       |
| LLM 调用次数（可跳过场景） | 3     | 2       | 2（更快）                 |

> 注：基线为单次采样，落地前需补 ≥3 类场景。

### 5.2 质量指标

| 指标                                         | 基线 | 允许退化                 |
| -------------------------------------------- | ---- | ------------------------ |
| Tool-calling 准确率（fast model summary 轮） | 100% | ≥98%                     |
| skipLlmRound 误用率（用户追问"再详细些"）    | -    | <1%                      |
| Fast model fallback_triggered 率             | -    | <10%（>20% 自动关 flag） |
| Summarizing 状态下半句 assistant 入 history  | 0    | 0（硬性）                |

### 5.3 成本指标

| 指标                              | 基线 | Phase 3 目标                                                 |
| --------------------------------- | ---- | ------------------------------------------------------------ |
| 每千会话 token 成本（summary 轮） | 100% | <70%                                                         |
| Fallback 路径浪费 tokens 占比     | 0    | <15%（fallback 率 × 单次 fast tokens / 单次 primary tokens） |

### 5.4 决策日志 schema

每次 `selectContinuationTier` 与 `handleCompletedTools` 的关键判定写一条结构化日志：

```
{
  turn_id, prompt_id,
  decision: 'skip' | 'fast' | 'primary',
  tier_requested: 'fast' | 'primary',          // 决策（fallback 前）
  tier_actual:    'fast' | 'primary',          // 实际跑（fallback 后）
  signal_skipLlmRound: bool,
  signal_resultIsTerminal: bool,
  user_strategy: 'auto' | 'always_primary' | 'always_fast',
  veto_reason: 'further_action' | 'write_tool' | 'unresolved_error' |
               'deep_reasoning' | 'cross_result' | 'output_tokens' |
               'lang_unsupported' | 'compact_or_clear' | null,
  tool_count, distinct_tool_count,
  has_write_tool: bool,
  has_error: bool, has_cancel: bool,
  output_tokens_est: int,
  user_prompt_classification: 'query' | 'action' | 'analysis',
  fast_ttft_ms, primary_ttft_ms,                // fallback 时双份
  fast_tokens_consumed: int,                    // fallback 浪费的 tokens（成本归因）
  total_rt_ms,
  fallback_triggered: bool,
  fallback_reason: 'tool_call_seen' | 'timeout' | 'error' | null,
}
```

观察指标：

- fast 触发率（预期 30-50%）
- fallback_triggered 率（预期 <10%；>20% 提示在下个 release 关 default flag）
- 各 veto 占比（识别过严/过松）
- fast_tokens_consumed × fallback_rate（成本反向风险）
- 用户追问"再详细些"频次（fast 质量回归信号）

**`fast_tokens_consumed` 测量说明**：

abort 中断的 stream **大概率收不到 `finishReason` / `usageMetadata`**——后者只在 stream 完整结束时填充。实现需估算：

- 优先：abort 前尝试 `stream.return()` 让生成器走 finally 路径，可能拿到 partial usage
- 兜底：累计已收 chunk 的文本长度 × 4 估算 output tokens；input tokens 用 history 估算
- 标注：日志字段附 `tokens_source: 'usage' | 'estimated'`，事后分析需区分

### 5.5 验证方法与发布策略

#### 验证

- 复用 `/tmp/tool-timing.log` 计时框架
- 新增 `T_userIdle`（用户可再次输入时刻）
- 新增 `T_firstToken`（流式首 token 时刻）
- A/B 测试对比各 Phase 前后的 RT 与 cost 分布

#### 发布策略（适配本地 CLI）

Qwen Code 是本地 CLI，**没有运行时下发能力**——传统"5% / 25% / 100% 灰度"不适用。采用**阶段性 release 推进**：

| 阶段                  | Release 节点           | feature flag 默认值 | 触发条件                                                    |
| --------------------- | ---------------------- | ------------------- | ----------------------------------------------------------- |
| Phase 3a：dogfood     | Release N              | `false`             | 内部用户用 `summaryTierStrategy=always_fast` 自启用         |
| Phase 3b：opt-in 默认 | Release N+1（≥2 周后） | `false`（不变）     | dogfood 阶段决策日志达标：fallback <10%、净 RT/cost 收益 >0 |
| Phase 3c：默认开启    | Release N+2（≥4 周后） | `true`              | Phase 3b 用户层面无质量回归报告                             |
| 回滚                  | Release N+3（如需）    | `true → false`      | 大规模 fallback >20% 或质量指标退化                         |

**回滚机制**：

- 无运行时下发，**回滚 = 发新 release 关 default flag**
- 用户级 `summaryTierStrategy=always_primary` 始终提供"我要立刻退出"通道，不依赖新 release
- 决策日志的 `fallback_rate` / `cost_regression` 在每个 Release 周期评估，决定下一步

### 5.6 已知限制

1. **基线数据单薄**：单次采样不能覆盖全部任务模式，落地前需补场景
2. **fast 模型前提**：不存在显著更快且 tool-calling 达标的同家族模型 → D2 不启用
3. **`skipLlmRound` 是质量换速度**：跳过 LLM = 放弃模型理解和纠错，仅适用确定性高场景
4. **D2 是质量+成本换速度**：fast 模型质量低于 primary；fallback 路径反而更贵——必须以决策日志实测净收益
5. **`tryCompress` 触发可能反向恶化**：fast 模型 context 小，compression 自身耗 LLM 调用——`wouldTriggerCompression` gate 是必备防御
6. **展示解耦改变交互模型**：新模式需要用户适应；用户行为决定实际感知收益
7. **网络延迟不可控**：本方案减少调用次数，非优化单次调用
8. **Anthropic 直连未覆盖**：当前 alternation 容忍度依赖 Qwen / OpenAI 风格 API
9. **主 chat 上 fastModel-streaming 是首次落地**：无生产先例，需独立验证实验
10. **本地 CLI 无运行时下发**：发布策略只能阶段性 release 推进，不支持快速灰度调节
11. **D2 仅作用于交互路径**：Subagent / Cron / Notification 不享收益，刻意如此
12. **混合模型 history 长期影响未知**：D2 启用后 session 内 turn 在 fast/primary 间切换，长会话 resume 与上下文连贯性需观察
13. **D4 收益缩水**：Edit 退出 allowlist 后，prevalidate 仅覆盖纯读类工具（50-100ms 收益）；含 Edit 的 200ms 收益需方案 B 的 mtime/hash 校验机制

### 5.7 关键代码位置

| 文件                                                  | 关键符号                                                 | 位置                     |
| ----------------------------------------------------- | -------------------------------------------------------- | ------------------------ |
| `packages/core/src/tools/tools.ts`                    | `ToolResult` interface                                   | L422                     |
| `packages/core/src/tools/tools.ts`                    | `Kind` enum + `MUTATOR_KINDS` + `CONCURRENCY_SAFE_KINDS` | L793, L806, L818         |
| `packages/core/src/tools/tools.ts`                    | `DeclarativeTool.kind: Kind`（每个 Tool 实例都带）       | L165                     |
| `packages/core/src/core/client.ts`                    | `SendMessageOptions.modelOverride`                       | L142                     |
| `packages/core/src/core/client.ts`                    | `sendMessageStream`                                      | L1216                    |
| `packages/core/src/core/client.ts`                    | `modelOverride ?? getModel()`                            | L1305, L1598             |
| `packages/core/src/core/client.ts`                    | `turn.run(model, …)`                                     | L1707                    |
| `packages/core/src/core/geminiChat.ts`                | `sendMessageStream(model, …)`                            | L1387                    |
| `packages/core/src/core/geminiChat.ts`                | `history.push(userContent)`                              | L1428                    |
| `packages/core/src/core/geminiChat.ts`                | `sendPromise` 锁                                         | L1392                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `modelOverrideRef`（skill 选模型）                       | L376, L2225              |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `processGeminiStreamEvents`                              | L1365                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `sendMessageStream` 调用点                               | L1841                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `handleCompletedTools`                                   | L2038                    |
| `packages/cli/src/ui/hooks/useGeminiStream.ts`        | `submitQuery(ToolResult, …)`                             | L2355                    |
| `packages/core/src/services/toolUseSummary.ts`        | fast-model side query（非流式先例）                      | L108                     |
| `packages/core/src/followup/speculation.ts`           | fast-model streaming（forked chat 先例）                 | L224                     |
| `packages/core/src/config/config.ts`                  | `fastModel` + `getFastModel` + `setFastModel`            | L684, L1987, L2021       |
| `packages/core/src/core/coreToolScheduler.ts`         | `attemptExecutionOfScheduledCalls`                       | L2436                    |
| `packages/core/src/core/coreToolScheduler.ts`         | `runConcurrently` + `partitionToolCalls`                 | L2473                    |
| `packages/cli/src/acp-integration/session/Session.ts` | `sendMessageStream` 调用点（ACP / IDE 路径）             | L705, L965, L1182, L1423 |
| `packages/core/src/agents/runtime/agent-core.ts`      | Subagent `sendMessageStream`（不受 D2 影响）             | L614                     |

---

## 6. Review 验证记录（2026-05-26）

### 6.1 验证方法

针对设计文档中**只声明、未量化**的几条前置数据质量假设与收益估算，启动 4 个并行 Explore subagent 做只读代码调研。每个 subagent 只回答一个事实问题，不做判断，不给优化建议。调研基于当前 `main` 分支（HEAD: `026f2f768`）。

| 验证问题                                                               | 关联章节                           |
| ---------------------------------------------------------------------- | ---------------------------------- |
| Q3 当前所有工具的 `ToolResult.error` 字段填充率                        | §3.2 `hasUnresolvedError` 前置依赖 |
| Q4 stream abort 后 `usageMetadata` 实际可得性                          | §5.4 `fast_tokens_consumed` 测量   |
| Q5 "用户追问 / clarification" 埋点存在性                               | §5.2 fast 质量回归监控信号         |
| Q6 `CONCURRENCY_SAFE_KINDS` 工具 `shouldConfirmExecute` 实际 IO 工作量 | §3.4 D4 收益估算                   |

### 6.2 发现 1：`hasUnresolvedError` 启发式存在 32% 工具盲区（影响 D2）

**事实**：在 22 个有错误路径的工具中，**15 个（68%）规范填 `ToolResult.error` 字段**（shell、read-file、write-file、edit、grep、glob、ls、web-fetch、mcp-tool、cron-\* 等核心 I/O 工具齐备），**7 个（32%）仅把错误塞进 `llmContent` 字符串**：`askUserQuestion`、`monitor`、`skill`、`lsp`、`exitPlanMode`、`todoWrite` 等。

**不存在**统一的 `createErrorResult` helper，每个工具独立实现错误构造。

**对设计的影响**：

- §3.2 的 `hasUnresolvedError` 否决项若仅检查 `ToolResult.error` 字段，**这 7 个工具的失败永远不会触发"切回 primary"**——下一轮仍会被路由到 fast model
- 其中 **`skill` 工具的失败被 fast model 错误总结**是高优风险场景（本仓库大量 skill 驱动的工作流会被影响）
- §3.2 列出的"shell 等需正确填 ToolResult.error（前置数据质量依赖）" **范围太窄**，shell 实际已规范，真正漏报的是 skill / lsp / todoWrite 等

**建议修正**：把 "**将 7 个仅靠 `llmContent` 传错的工具改造为规范填 `error` 字段**" 列为 D2 的硬前置依赖（§3.2 前置条件），估时 ~2d；不接受 "用 `llmContent.match(/^Error:/i)` 兜底" 的脏路径（误判风险高）。

### 6.3 发现 2：`fast_tokens_consumed` 指标实现成本被低估（影响 D2 / §5.3）

**事实**：

- `turn.ts` 的 abort 路径（L289-291）直接 `return`，**没有 finally 块，也没有 `stream.return()` 调用**——文档 §5.4 暗示的 "abort 前 `stream.return()` 让生成器走 finally" 在当前代码中不存在该入口
- `geminiChat.ts:processStreamResponse` 的 `for await` 循环只在完整遍历时记录 turn（L1286），abort 中断意味着最后的 usage-only chunk（通常携带完整 metadata）**被直接丢弃**
- 主聊天路径**无任何 chunk-level token 累计兜底**；仅 subagent 层（`agent.ts:731-744`）有累计，无法复用
- 结论：abort 时 `usageMetadata` **零获取**，只能靠 `chars/4` 估算（±20% 误差）

**对设计的影响**：

- §5.4 末尾的"优先 / 兜底 / 标注"三层方案中，**"优先" 路径在当前代码不可达**——需先改 `sendMessageStream` 生成器结构加 finally，工作量约 1d，设计文档没体现这笔成本
- §5.3 把 "每千会话 token 成本 <70%" 列为 Phase 3 目标，但若指标本身 ±20% 误差，**"70%" 与 "82%" 落在测量噪声内**

**建议修正**：

- §5.3 改写为**趋势指标**，不作为 release gate；改用 "决策日志的 `fallback_triggered` 率 + `fast_tokens_consumed` 同向趋势" 双指标联合判断
- §5.4 增补：`fast_tokens_consumed` 实现需先改造 turn.ts abort 路径加 finally + `stream.return()`，作为 §3.2 工作量补充（+1d）

### 6.4 发现 3：`user_prompt_classification` 与"用户追问"埋点需新建（影响 D2 / §5.2）

**事实**：

- `packages/core/src/followup/` 已存在 `speculation.ts` / `suggestionGenerator.ts` / `followupState.ts`，但其 telemetry（`PromptSuggestionEvent`）记录的是 **"系统建议被采纳/忽略"**，不是"用户主动追问"
- `ChatRecordingService` 存储用户消息但**不打分类标签**
- 全仓库 grep 无 `user_prompt_classification`、无中英文追问模式匹配、无 `clarif*` / `intentDetect` 类机制

**对设计的影响**：

- §5.4 决策日志 schema 里 `user_prompt_classification: 'query' | 'action' | 'analysis'` 字段**没有数据源**——既不能从现有 PromptSuggestionEvent 推导，也不能从 ChatRecord 读出
- §5.2 "用户追问'再详细些'频次" 监控信号同上，**最接近的现有锚点 `followupState.onOutcome` 不可复用**

**建议修正**：

- §3.2 前置条件中追加"用户输入分类器最小实现"（中英文模式匹配，~3d），否则 §5.4 决策日志的 `user_prompt_classification` 与 `requestImpliesFurtherAction` 都缺数据
- 或者**接受**在 Phase 3a dogfood 阶段没有这两个信号，仅靠 `fallback_triggered` 率监控质量回归——成本低但风险高

### 6.5 发现 4：D4 设计内在矛盾——allowlist 与收益归因不对齐（影响 D4 / §3.4）

**事实**：

- `Kind.Read`（read_file）、`Kind.Search`（glob / grep）、`Kind.Fetch`（web_fetch）三类工具的 `shouldConfirmExecute` / `getConfirmationDetails`，**绝大多数继承 `BaseToolInvocation` 默认实现，做零 IO**（read_file / glob / grep 完全没 override，web_fetch 只做 5-10 行字符串解析 URL hostname）
- 真正有 IO 的是 `Edit` / `WriteFile`（`calculateEdit` + `readTextFile` + `Diff.createPatch`，典型 ~20ms），但 §3.4 方案 A 把它们排除出 allowlist 以规避 TOCTOU
- **结果**：留在 allowlist 里的三类工具，prevalidate 与不 prevalidate 工作量基本相同——allowlist 实际拦截的是"唯一有 IO 可省的 Edit"，留下"本来就零成本的工具"

**对设计的影响**：

- §3.4 的"前置 IO 验证"叙事**不成立**：50-100ms 收益的真正来源是 **"stream 完全结束 → 才批量 schedule" 这段调度等待被消除**，与工具端 IO 几乎无关
- 收益归因错误会带来两个问题：
  1. **allowlist 可以更宽**——凡是 idempotent prevalidate 的工具都行，不必绑定 `CONCURRENCY_SAFE_KINDS`
  2. **5-7d 投入难以自洽**——如果真实收益只有调度模型改变的 ~50ms，Edit 又不在 allowlist 里，这笔投入的 ROI 比设计文档暗示的低

**建议修正**：§3.4 重写收益归因——

- 拆分为两部分：(a) 调度模型改变省下的 stream 等待 ~50ms，(b) 工具端 IO 前置可省的工作量 ~0ms（allowlist 内）/ ~20ms（若 Edit 入 allowlist）
- 在 §4.1 综合评估表里把 D4 RT 收益从 "50-200ms" 改为 "30-80ms（方案 A，主要来自调度模型）/ 100-200ms（方案 B，含 Edit）"
- 在 §4.2 路线图中把 D4 进一步降级——纯调度模型改造可独立做，不必强行绑定 prevalidate 概念

### 6.6 对路线图的合并影响

| 章节                          | 原估时 | 验证后估时   | 增量来源                                                                                         |
| ----------------------------- | ------ | ------------ | ------------------------------------------------------------------------------------------------ |
| D2 §3.2 工作量（§4.1 细分表） | 9d     | **14-16d**   | +2d（发现 1 前置工具改造）+1d（发现 2 turn.ts finally 改造）+3d（发现 3 输入分类器，如取硬路径） |
| D4 §3.4 综合评估              | 5-7d   | 5-7d（不变） | 工作量不变，但 **RT 收益归因从"工具端 IO"改为"调度模型"**，投入 ROI 下调                         |
| Phase 3 总时长（§4.2）        | ~3 周  | **~4-5 周**  | D2 工作量上调 + 前置工具改造 PR 单独走 review 周期                                               |

**对原路线图的修正建议**：

1. **保持 D1（P0）和 D3 紧随其后**——本次验证未触及它们的核心假设，ROI 判断不变
2. **D2 启动条件加严**——把发现 1/2/3 的前置工作（共 ~6d）作为 "D2 启动 gate"，未完成不进入 §3.2 前置实验
3. **D4 重新评估优先级**——既然真实收益是调度模型改变而非工具端 IO，要么 (a) 接受 30-80ms 把 D4 降到 P3 后置，要么 (b) 考虑方案 B（Edit + mtime/hash）拿回 100-200ms 但额外 5-7d
4. **不修改 §1.2 单次采样基线**——但 §5.1 P95 一栏在 D1 落地、补完 ≥3 类场景基线之前不写具体数字

### 6.7 验证未覆盖的追问点

以下追问点属于主观判断或作者意图问题，本次验证未通过 subagent 处理，留作后续 design review 讨论：

- D2 实施次序应否后置于 D3（主观次序）
- D1/D3 是否应合并到 Phase 1 一起做（实施策略）
- §3.2 `needsCrossResultReasoning` 阈值 ≥3 是否反向拟合 §1.2 基线场景（作者意图）
- §5.7 关键代码位置表的行号锚点是否应改为符号锚点（文档稳定性）

---

## 7. 浮油评估与下一步（2026-05-26 二次 review）

### 7.1 触发本次重排的事实

§6 验证之后，又发现两个**改变 ROI 判断的事实**：

1. **DashScope `cache_control` 已实装**（`packages/core/src/core/openaiContentGenerator/provider/dashscope.ts:172-181`）
   - streaming 请求标记 `system + 最后一条 message + 最后一个 tool definition`
   - 命中数据 `cached_tokens` 已采集到 `usageMetadata.cachedContentTokenCount`（`converter.ts:1124-1149`）
   - 这是 prefix cache 机制：Round N+1 自动命中 Round N 写入的前缀
   - **summary 轮恰好是命中前缀最长的一轮**

2. **system prompt 已经稳态**（`prompts.ts` 审计结果）
   - 没有 cwd / timestamp / git status / 文件列表 / LSP 状态等"每 turn 都变"的硬伤
   - `process.cwd()` 仅用作 `isGitRepository()` 开关，不写入 prompt 内容
   - 唯一动态点：`save_memory` 工具触发 / `/model` 切换 / MCP 动态加载（均事件性，低频）

### 7.2 这两条事实改变了 D2 的 ROI 判断

§3.2 文档假设 "fast model 比 primary 快 ~2s"，对照基线是 **primary uncached vs fast uncached**。

但现实运行中 primary 是 **cached**（summary 轮恰好命中最强），所以正确对照是：

> primary cached vs fast uncached

| 路由                          | 估算延迟  | 备注                     |
| ----------------------------- | --------- | ------------------------ |
| primary 命中 80% 前缀 cache   | ~1.8-2.2s | summary 轮的当前实际表现 |
| fast 无 cache（跨模型不共享） | ~1.5-2s   | D2 切换后的实际表现      |

**净差距：几百毫秒，甚至可能 fast 反而慢**。叠加 14-16d 工程成本 + 质量风险 + fallback 浪费，**D2 净收益接近 0 或负**。

§3.2 前置条件**必须新增**：基线测量必须对比 primary **cached** vs fast **uncached**，且 `T_primary_cached < T_fast_uncached × 1.5` 时 D2 不应启用。

### 7.3 候选清单（按浮油性重排）

**真·浮油（立刻动手，< 1d 投入，极低风险，确定收益）**：

| 项                            | 投入  | 收益                              | 操作位置                                                                    |
| ----------------------------- | ----- | --------------------------------- | --------------------------------------------------------------------------- |
| 简洁回复指令                  | 30min | ~2s/summary 轮（输出 token 减半） | `prompts.ts` Final Reminder 段加一句                                        |
| 暴露 cache hit rate telemetry | 0.5d  | 0s 直接，是后续决策 **enabler**   | `cachedContentTokenCount` 已采集，缺暴露；并应识别 `save_memory` 后单独打标 |

**近浮油（等数据决定，0.5-1d 投入）**：

| 项                              | 投入                  | 收益                                    | 决策前置                                                              |
| ------------------------------- | --------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| summary 轮 `tool_choice='none'` | 0.5-1d                | 0.3-1s（sampling 跳过 tool_call token） | 需"是 summary 轮"判定逻辑，错判风险低                                 |
| summary 轮关 thinking           | 1d                    | 0.5-2s                                  | 仅对启用 thinking 的模型有意义（qwen3.5-plus、glm-4.7、kimi-k2.5 等） |
| UI 渲染层 chunk batching        | 0.5d 调研 + 0.5d 实施 | 待验证                                  | 假设：长 summary 的 `useGeminiStream` token 渲染累计开销不小          |

**待调研（可能是大鱼）**：

| 项                                   | 调研投入                 | 潜在收益            | 关键未知                                                                                   |
| ------------------------------------ | ------------------------ | ------------------- | ------------------------------------------------------------------------------------------ |
| ~~DashScope `scope: 'global'` 支持~~ | ~~0.5d 文档 + 0.5d A/B~~ | ~~跨 session 命中~~ | **已调研，结论 (c) 不可行**（见 §7.4 发现 B 调研结果）。此行保留作为决策记录，不要重启调研 |

**中等改造（不算浮油，单独评估）**：

| 项                                | 投入             | 风险 | 收益        |
| --------------------------------- | ---------------- | ---- | ----------- |
| D1 `skipLlmRound`（终态查询场景） | 2-3d             | 中   | 3-4s/终态轮 |
| summary 轮工具结果裁剪（D5 子集） | 2d               | 中   | 1-2s        |
| D3 `Summarizing` 状态             | 3-5d             | 中   | 感知改善 3s |
| system prompt 减肥                | 2-3d 含 A/B 测试 | 中   | 0.5-1s      |

**已废弃方向（不要再做）**：

| 项                                         | 废弃原因                                               |
| ------------------------------------------ | ------------------------------------------------------ |
| D2 fast model 路由                         | 被 DashScope cache 抵消，净收益接近 0 或负             |
| D4 prevalidate                             | 收益归因错（真实仅 ~50ms 来自调度模型），5-7d 投入不值 |
| system prompt 稳定化                       | 已稳态，无事可做                                       |
| 流式提前 terminal（提前 abort 收尾客套话） | 高误判风险，用户感知答案被切断                         |

### 7.4 三个值得展开的新发现

#### 发现 A：`tool_choice='none'` 的真实机制

OpenAI / DashScope API 里 `tool_choice='none'` 不仅是"禁止调工具"——模型 sampling 阶段会**完全跳过 `<tool_call>` 特殊 token 的概率分配**，decoder 直接走自然语言生成路径。收益不在"省一两次 retry"，而在 sampling 本身更快。

#### 发现 B：`scope: 'global'` 在仓库已有 Anthropic 先例

`packages/core/src/core/anthropicContentGenerator/converter.test.ts:85, 1543` 已有 `cache_control: { type: 'ephemeral', scope: 'global' }` 用法。但 `provider/dashscope.ts:288` 标 cache_control 时**没传 scope**：

```typescript
cache_control: { type: 'ephemeral' },   // 没有 scope
```

若 DashScope 服务端识别 `scope: 'global'`：

- system + tools 升级为 global cache（TTL 远大于 ephemeral 的 5min）
- **跨 session 命中**，启动延迟也降
- 单这一条收益可能超过原 D2 全部假设收益

##### 调研结果（2026-05-26，结论：(c) 不可行，关闭此线）

通过查阿里云百炼官方文档 `help.aliyun.com/zh/model-studio/context-cache` 得到的事实清单：

| 问题                   | 结论                                                                                                                                                                                               | 证据                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `scope` 字段支持       | **不支持**。仅识别 `type: 'ephemeral'`，任何 `scope`/`persistent`/`global` 会被 silently dropped                                                                                                   | 官方文档原文："仅支持将 `type` 设置为 `ephemeral`" |
| ephemeral 实际 TTL     | **5 分钟滑动窗口**（命中后重置）                                                                                                                                                                   | 百炼文档明确说明                                   |
| 长 TTL / 全局机制      | **无任何公有云 API 端机制**。无 `persistent` type 值、无独立预上传 API、无 `prompt_cache_key`；唯一"全局持久"产品是 PAI 全局上下文缓存（自部署 + vLLM + 灵骏 + 共享 Redis），与 DashScope API 无关 | PAI 文档                                           |
| 跨 session 共享        | 同账号 + 同模型 + 内容匹配 → 已经命中（这就是 `ephemeral` 已经在做的）；不同账号绝对不共享                                                                                                         | 百炼文档                                           |
| 定价                   | cache write 125%、显式 cache read 10%、**隐式 cache read 20%**（无 `cache_control` 标记也能拿到隐式 20% 折扣）                                                                                     | 百炼定价文档                                       |
| 最小可缓存 prompt      | **1024 tokens**                                                                                                                                                                                    | 百炼文档                                           |
| 模型支持（显式 cache） | qwen3.7-max / qwen3.6-plus / qwen3.5-plus / qwen3-coder-plus / qwen3-vl-plus / deepseek-v3.2 / kimi-k2.5 / glm-5.1 均显式列出。**qwen3.6-plus 与 qwen3.7-max 同样享受 90% 显式 cache 折扣**        | 百炼模型列表（2026-05-26 重核）                    |

**几条副发现的连带意义**：

1. **TTL 滑动窗口** 对 agent loop 是好消息——loop 内连续调用间隔通常 < 30s，**cache 永远新鲜，不会 5min 失效**
2. **隐式 cache 20% 折扣** 是免费红利——即使没标 `cache_control` 也能拿；但精细控制需要显式
3. ~~`qwen3.6-plus` 未在显式列表~~ —— **更正（2026-05-26）**：经重核，qwen3.6-plus **确实在显式 cache 列表里**，享受 90% 折扣。前一轮报告此处错误，已于本节首张表更正
4. **`dashscope.ts:288` 当前做法已经是 DashScope 公有云 API 的能力上限**——没有继续榨的空间

**对 §7.2 D2 判断的连带加强**：

TTL 滑动窗口意味着 agent loop 内 summary 轮**几乎 100% 命中** primary 的 cache（前几轮刚刚命中过、5min 内）。D2 切 fast model 不仅会打碎累计的 cache 写入链，**还会让 summary 轮从"近 100% 命中"退化为"完全 miss"**——净收益判断比 §7.2 原假设更明确为负。

#### 发现 C：UI 渲染层是被忽视的盲区

§1.2 基线把"框架开销"标为 0.3s（3%），但这是粗估。Ink 7 + React 19.2 在每个 chunk 触发 setState → re-render，长 summary 累计可能 200-500ms。需要查 `useGeminiStream` 怎么处理 token 流，有没有 `requestAnimationFrame` / `useDeferredValue` 合并 chunk。

### 7.5 待数据 checkpoint —— 数据到了该看哪个决策

本节是**这份文档的活动入口**：后续有任何度量数据，对照下表决定该回看哪个决策。

#### Checkpoint 1：cache hit rate 数据出来后

**触发条件**：浮油"暴露 cache hit rate telemetry"上线 ≥3 天，决策日志含 `cached_tokens` / `prompt_tokens` 分布。

**该看的数据**：

- 整体命中率（cached / prompt）的 P50、P90 分布
- 按轮次划分：Round 1 / Round 2 / Round 3 (summary) 各自命中率
- `save_memory` 触发后下一轮命中率（应该接近 0）
- `/model` 切换后下一轮命中率（应该接近 0）

**决策路径**：

| 整体命中率 | 含义                 | 行动                                                                        |
| ---------- | -------------------- | --------------------------------------------------------------------------- |
| > 70%      | 现状已经接近理论上限 | 只做 #1 简洁指令 + 发现 B 调研；其余浮油按需                                |
| 40-70%     | 还有空间但来源不明   | 分析按轮次命中率，找出哪一段在 miss                                         |
| < 40%      | 有动态点在打 cache   | 重新审计 system prompt / userMemory 触发频率；可能 `save_memory` 比预期频繁 |

#### Checkpoint 2：DashScope `scope: 'global'` 文档调研结果 ✅ 已完成（2026-05-26）

**结果**：**完全不识别**。详见 §7.4 发现 B 的"调研结果"段。

**已执行行动**：接受现状，跳过此项。`dashscope.ts:288` 维持现有 `ephemeral` 标记，无需改造。

**后续不要重新启动此调研**——除非 DashScope 官方公告新增持久化机制。

#### Checkpoint 3：UI 渲染层调研结果

**触发条件**：发现 C 调研完成（看 `useGeminiStream` token 流处理 + Ink/React DevTools 实测）。

**决策路径**：

| 结果                               | 行动                                             |
| ---------------------------------- | ------------------------------------------------ |
| 长 summary stream 渲染累计 > 200ms | 改用 batching（`useDeferredValue` 或自定义节流） |
| 渲染开销 < 100ms                   | 关闭此线索                                       |

#### Checkpoint 4：完成"真·浮油"后的二次基线测量

**触发条件**：#1 简洁指令 + Checkpoint 1/2/3 决策完成 ≥1 周。

**该看的数据**：

- 端到端 RT P50 与 §1.2 单次采样基线（13.4s）对比
- summary 轮单独的 P50 / P95
- 用户追问率（如果浮油 A 顺带做了用户输入分类）

**决策路径**：

| 累计节省                     | 行动                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------- |
| > 4s（达到 9.6s 端到端 P50） | 评估 D1 `skipLlmRound`（再省 3-4s/终态轮）                                    |
| 2-4s                         | 接受现状，评估 D3 感知改善是否值得做                                          |
| < 2s                         | 重新审视：是否浮油本身被高估，还是有未识别的瓶颈（网络 RTT、provider 端延迟） |

### 7.6 与 §3 各方向的最终判定

基于 §6 验证 + 本节 ROI 重排：

| 方向                 | §3 原优先级 | 本节判定                             | 理由                                               |
| -------------------- | ----------- | ------------------------------------ | -------------------------------------------------- |
| D1 工具后置指令      | P0          | **P0 保留**，但等浮油完成后再评估    | ROI 仍然好，但不再"立刻就做"——先把更便宜的浮油拿掉 |
| D2 summary fast 路由 | P1          | **Defer / Won't Fix**                | 被 DashScope cache 抵消，14-16d 投入换接近 0 收益  |
| D3 展示解耦          | P1          | **保留为可选**，看 Checkpoint 4 数据 | 感知改善确定，但绝对 RT 不变，依赖用户行为         |
| D4 流式提前调度      | P2          | **Defer**                            | 收益归因错，真实 ~50ms 不值 5-7d                   |

### 7.7 推荐执行顺序

**Day 1**（可单人单日完成）：

- ✅ `prompts.ts` 加简洁回复指令（30min）
- ✅ `cachedContentTokenCount` 暴露到 telemetry + `save_memory` / `/model` 切换打标（0.5d）
- ✅ 启动发现 B 调研：DashScope `scope: 'global'` 文档查询 + 现有 Anthropic 用法对照（0.5d）

**Day 2-3**：

- 收第一批 cache hit rate 数据
- 启动发现 C 调研：`useGeminiStream` 的 React 渲染路径
- 根据 Checkpoint 2 决定要不要做 `scope: 'global'` 改造

**Week 1 末**：

- Checkpoint 1 数据决策（看分布）
- 决定要不要做 `tool_choice='none'` / 关 thinking（根据 hit rate 数据）

**Week 2-3**：

- Checkpoint 4 二次基线测量
- 决定是否启动 D1（最大的非浮油项，3-4s/终态轮）

**始终不做**：D2 / D4 / system prompt 稳定化。

### 7.8 `prompts.ts` 动态内容审计（2026-05-27）

§7.1 给出 "system prompt 已稳态" 的结论时只做了粗略 grep。本节是对 `packages/core/src/core/prompts.ts`（1169 行）的系统性审计，列清单作为后续 cache 命中率分析与浮油决策的依据。

**审计方法**：枚举所有 `${...}` 插值表达式、IIFE、`process.*` / `new Date` / `Date.now` / `Math.random` / `fs.*` 调用，对每一处判断"在同一 session 内是否会变化"。

#### 完全没有（常被怀疑的硬伤）

| 候选                               | 代码事实                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `Date.now()` / `new Date()`        | 全文 **零次出现**（`rg` 全无匹配）                                                  |
| `Math.random()`                    | **零次出现**                                                                        |
| `process.cwd()` 值写入 prompt      | 仅 L366 `if (isGitRepository(process.cwd())) { ... }`，**值不写入字符串**，只作开关 |
| git status / git branch 子进程调用 | **零次**，git 段是静态指导文本                                                      |
| 当前文件列表 / 项目结构注入        | **零次**                                                                            |
| LSP 状态 / 错误数                  | **零次**                                                                            |
| 用户输入历史                       | **零次**（history 走 messages，不在 system）                                        |

#### 启动时一次，session 内不变

| 位置     | 内容                                                                                             | 何时可能变                |
| -------- | ------------------------------------------------------------------------------------------------ | ------------------------- |
| L190     | `process.env['QWEN_SYSTEM_MD']` 决定 basePrompt 来源（默认 vs 用户 system.md）                   | 进程内不变                |
| L342-343 | `process.env['SANDBOX']` 决定 sandbox 段选哪一版（Seatbelt / Sandbox / Outside）                 | 进程内不变                |
| L366     | `isGitRepository(process.cwd())` 决定 git 段是否插入                                             | cwd 同 session 内通常不变 |
| L871     | `process.env['QWEN_CODE_TOOL_CALL_STYLE']` 决定 tool call 风格（qwen-coder / qwen-vl / general） | 进程内不变                |

#### 事件触发（低频）

| 参数                                              | 触发条件                                          | 频率估计           |
| ------------------------------------------------- | ------------------------------------------------- | ------------------ |
| `userMemory`（`getCoreSystemPrompt` 第 1 参）     | `save_memory` 工具 / `/memory refresh` / 扩展加载 | 0-3 次/session     |
| `model` 名（影响 `getToolCallExamples` 选哪一支） | `/model` 切换                                     | 罕见               |
| `appendInstruction`                               | 配置项，session 内基本不变                        | 几乎从不           |
| `deferredTools`（`buildDeferredToolsSection`）    | MCP 工具动态加载                                  | session 启动期居多 |

#### 一个隐蔽的小坑

L207-209：若设置了 `QWEN_SYSTEM_MD` env，**每次** `getCoreSystemPrompt` 都会 `fs.readFileSync(systemMdPath)`：

```typescript
const basePrompt = systemMdEnabled
  ? fs.readFileSync(systemMdPath, 'utf8')
  : `...`;
```

- 文件不变时内容稳定 → cache 命中不受影响
- 但每轮 LLM 调用都有一次同步 IO（默认 `.qwen/system.md`，网络挂载文件会更慢）
- 不影响本节"cache 友好性"结论，仅作为已知性能小坑记录

#### 连带结论

1. **system prompt 在稳态 session 内每次产出 byte-for-byte 一致** → DashScope ephemeral cache key（基于内容 hash）整段稳定 → **system 段 cache 命中率几乎 100%**
2. 唯一打 cache 的事件是 `save_memory`——核心功能，不能为 cache 让路
3. **浮油 #1（简洁回复指令）的代价分析**：把指令加到 Final Reminder 段（L389-390）→ system prompt 内容改变一次 → **首次请求 cache miss（一次性预热成本），之后所有请求继续命中**
4. **§7 的 "system prompt 稳定化" 已废弃判断得到正式证据支持**——不仅没必要做，连"理论上做了能进一步降低 cache miss 率"都不成立，因为本来就 ≈ 0
5. 本审计可作为后续相关讨论的引用基线，避免重复 grep；若 prompts.ts 有大改动，本节需要同步更新
