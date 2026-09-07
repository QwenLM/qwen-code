---
description: "Qwen Code auto-compaction threshold redesign. Add warn, auto, and hard token thresholds with safer compression budgeting."
---

# Auto-Compaction Threshold Redesign

**Status:** Draft · 2026-05-14

## 背景

> 本节描述本 PR 落地**之前**的状态（pre-redesign behavior）。下文出现的 `COMPRESSION_TOKEN_THRESHOLD`、`thinkingConfig.includeThoughts = true`、`hasFailedCompressionAttempt`、以及具体的 file:line 引用都对应 PR #4345 合入前的代码——合入后这些符号 / 行号会不再有效。

当前 qwen-code 的自动压缩仅使用单一比例阈值 `COMPRESSION_TOKEN_THRESHOLD = 0.7`（`chatCompressionService.ts:33`），所有窗口大小共用同一比例。对比 claude-code 的「绝对 token 梯子」（autoCompact.ts:62-65），qwen-code 存在三个具体问题：

1. **大窗口下预留过多**：1M 模型 70% 阈值在 700K 触发，剩余 300K 远超摘要 + 输出实际所需的 ~33K
2. **失败 1 次永久锁**：`hasFailedCompressionAttempt = true` 之后整个 session 不再尝试 auto-compact（geminiChat.ts:504），比 claude-code 的「连续 3 次熔断」更严苛
3. **tip 系统与 auto 阈值脱钩**：`tipRegistry.ts` 里的三条 `context-*` tip 使用固定的 50/80/95 百分比，与 auto-compact 阈值（70%）完全独立。这意味着在「auto 正常工作」的主路径上 80% / 95% tip 极少触发，而在「auto 失败 / 反应式兜底」的边缘路径上又缺乏与阈值对齐的语义
4. **压缩调用本身没有输出预算控制**：[chatCompressionService.ts:374-376](packages/core/src/services/chatCompressionService.ts:374) 显式开启 `thinkingConfig.includeThoughts = true`（注释：「Compression quality drives every subsequent main turn」），同时 sideQuery 调用未设 `maxOutputTokens` 上限。代码注释（[:436-437](packages/core/src/services/chatCompressionService.ts:436)）也承认 `compressionOutputTokenCount may include non-persisted tokens (thoughts)`。在压缩接近窗口顶时，总输出可能膨胀，使 buffer 预留缺乏可预测上限。<br/><br/>更糟糕的是跨 provider 行为不一致：Anthropic 的 thinking budget 与 max_tokens 完全独立；OpenAI 的 reasoning tokens 不受 max_completion_tokens 限制；Gemini 的行为又因模型版本而异。这意味着「单靠加 maxOutputTokens 就能控制总输出」在 qwen-code 这种多 provider 项目里不成立

5. **阈值判断使用的 `lastPromptTokenCount` 系统性下偏。** [geminiChat.ts:1217-1232](packages/core/src/core/geminiChat.ts:1217) 表明这个数来自上一轮 API response 的 `usageMetadata.totalTokenCount`。两个 gap：(a) 不包含本轮即将加入的 user message，每次 cheap-gate 判断都比真实 prompt 小一段；(b) 首轮初始值是 0，`--continue` 恢复巨大 session / sub-agent 继承大量历史时第一次 send 永远绕过所有阈值。对比 claude-code 的 `tokenCountWithEstimation`（[query.ts:638](src/query.ts:638)）走「最后一条 assistant API usage + 之后新增 message 估算」的双轨制能闭合这两个 gap

## 设计目标

- 引入「比例 + 绝对」混合阈值，让大窗口模型由绝对值接管，小窗口仍走比例兜底
- 新增 warn / hard 两层（auto 保留为主触发点），形成三层梯子
- 把 tip 系统重写为跟随新阈值的触发条件
- 失败处理从「1 次永久锁」升级为「3 次熔断 + 自动恢复」
- **压缩调用关闭 thinking 并加 `maxOutputTokens` 上限**：与 claude-code 对齐，让总输出受单一参数约束、buffer 预算可预测；接受压缩质量可能下降的代价
- **加 token 估算补偿**：消除 `lastPromptTokenCount` 的「滞后一轮」和「首轮为 0」两个系统性下偏，让阈值判断更贴近真实 prompt 大小
- 删除 settings 里的 `contextPercentageThreshold` 配置入口（内部 PCT 常量保留）
- **不引入** env 覆盖通道、**不**新增显式 enabled 开关

## 三层阈值梯子

```
                       window  (raw context window)
                          │
                          │  ← SUMMARY_RESERVE = 20K
                          ▼
                    effectiveWindow
                          │
                          │  ← HARD_BUFFER = 3K
                          ▼
              hard_threshold = effectiveWindow - 3K
                          │
                          │  ← (AUTOCOMPACT_BUFFER - HARD_BUFFER) = 10K
                          ▼
auto_threshold = max(PCT * window, effectiveWindow - AUTOCOMPACT_BUFFER)
                          │
                          │  ← WARN_BUFFER = 20K
                          ▼
warn_threshold = max((PCT - WARN_OFFSET) * window, auto_threshold - WARN_BUFFER)
                          │
                          ▼
                          0
```

### 三层语义

| 层       | 触发条件                       | 行为                                                     |
| -------- | ------------------------------ | -------------------------------------------------------- |
| **warn** | `tokenCount >= warn_threshold` | UI 提示「距自动压缩还剩 X tokens」，不改变 send 行为     |
| **auto** | `tokenCount >= auto_threshold` | 在 send 前 `tryCompress(force=false)`，正常压缩流程      |
| **hard** | `tokenCount >= hard_threshold` | 在 send 前 `tryCompress(force=true)`，重置失败锁强制压缩 |

`hard` 层等同于把现有 reactive overflow（geminiChat.ts:711）的兜底逻辑提前到 send 前，避免一次失败的 oversized request round-trip。

## 内部常量

```ts
// chatCompressionService.ts
const DEFAULT_PCT = 0.7; // auto 比例兜底
const WARN_PCT_OFFSET = 0.1; // warn 比例 = PCT - WARN_OFFSET = 0.6
const COMPACT_MAX_OUTPUT_TOKENS = 20_000; // 压缩 sideQuery 输出硬上限（thinking + summary 合计）
const SUMMARY_RESERVE = 20_000; // 阈值梯子从窗口顶减去的输出预留 = maxOutput
const AUTOCOMPACT_BUFFER = 13_000; // auto 与 effectiveWindow 间距
const WARN_BUFFER = 20_000; // warn 与 auto 间距
const HARD_BUFFER = 3_000; // hard 与 effectiveWindow 间距
const MAX_CONSECUTIVE_FAILURES = 3; // 失败熔断阈值
```

数值来源：全部沿用 claude-code 的实测值（[autoCompact.ts:30,62-65](src/services/compact/autoCompact.ts:30)）。

`SUMMARY_RESERVE = COMPACT_MAX_OUTPUT_TOKENS` 是关键关系：模型受 `maxOutputTokens` 硬限制约束，输出不可能超出 20K，因此 reserve 不需要额外 safety margin。注意：本设计关闭 thinking 后该等式成立（output budget 全部给 summary）；若保留 thinking，`thinking + summary` 共享预算（Gemini SDK / 多数 provider 的 `maxOutputTokens` 语义），模型自行在两者间分配，此时 summary 的实际可用空间小于 20K（见「风险与注意事项」第 1、2 条）。

## 计算函数

```ts
export interface CompactionThresholds {
  warn: number;
  auto: number;
  hard: number; // 当 hard < auto 时等于 auto（小窗口退化）
  effectiveWindow: number;
}

export function computeThresholds(window: number): CompactionThresholds {
  const effectiveWindow = window - SUMMARY_RESERVE;

  const absAuto = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto = Math.max(DEFAULT_PCT * window, absAuto);

  const absWarn = auto - WARN_BUFFER;
  const warn = Math.max((DEFAULT_PCT - WARN_PCT_OFFSET) * window, absWarn);

  const rawHard = effectiveWindow - HARD_BUFFER;
  const hard = Math.max(rawHard, auto); // 小窗口下退化为 auto

  return { warn, auto, hard, effectiveWindow };
}
```

### 实测数据

| 窗口 | warn        | auto        | hard         | 备注                            |
| ---- | ----------- | ----------- | ------------ | ------------------------------- |
| 32K  | 19.2K (pct) | 22.4K (pct) | 22.4K (退化) | 比例兜底                        |
| 64K  | 38.4K (pct) | 44.8K (pct) | 44.8K (退化) | 比例兜底                        |
| 128K | 76.8K (pct) | 95K (abs)   | 105K (abs)   | 混合（warn=pct, auto/hard=abs） |
| 200K | 147K (abs)  | 167K (abs)  | 177K (abs)   | 绝对接管                        |
| 256K | 203K (abs)  | 223K (abs)  | 233K (abs)   | 绝对接管                        |
| 1M   | 947K (abs)  | 967K (abs)  | 977K (abs)   | 全绝对                          |

`(pct)` 表示该层由比例公式决定，`(abs)` 表示由绝对值公式决定。

## 用户配置

### ChatCompressionSettings 变更

```ts
// packages/core/src/config/config.ts:217
export interface ChatCompressionSettings {
  /** 保留（与本设计无关，由 compactionInputSlimming 使用） */
  imageTokenEstimate?: number;
}
```

**删除：** `contextPercentageThreshold` 字段。理由：

1. 新公式下，对主流窗口（>= 128K）该字段几乎无影响——绝对值接管
2. 小窗口下用户配置反而可能让阈值"更早"压缩，与节省 token 直觉相反
3. claude-code 没有暴露此字段，无类似的用户面配置先例

### Breaking change 处理

**用户面：** 启动时 `Config` 加载发现 `chatCompression.contextPercentageThreshold` 存在：

- 写入 stderr 一行警告：`"chatCompression.contextPercentageThreshold has been removed and is now controlled by built-in thresholds."`
- **不**报错、**不**阻塞启动
- 字段值被忽略

**SDK 面（R5.4）：** `CompressOptions` 的 `hasFailedCompressionAttempt: boolean` 字段重命名为 `consecutiveFailures: number`。两点差异：

|      | 旧字段                         | 新字段                                                               |
| ---- | ------------------------------ | -------------------------------------------------------------------- |
| 名称 | `hasFailedCompressionAttempt`  | `consecutiveFailures`                                                |
| 类型 | `boolean`                      | `number`                                                             |
| 语义 | `true` = 永久禁用 auto-compact | `>= MAX_CONSECUTIVE_FAILURES`（默认 3）= 暂时禁用直到 force 成功重置 |

仓库内只有 `GeminiChat.tryCompress` 一个内部消费方，所以内部 migration 风险低；但 `@qwen-code/qwen-code-core` 是 published package、`CompressOptions` 在 d.ts 里可见，下游 SDK 直接调 `service.compress({ ..., hasFailedCompressionAttempt: true })` 的代码会拿到 TS 编译错误。**迁移指引：** 把 `true` 改为 `MAX_CONSECUTIVE_FAILURES`（或任意 >= 3 的整数），`false` 改为 `0`。如果调用方维护自己的失败计数，直接传入即可。

## Token 估算补偿

qwen-code 的 `lastPromptTokenCount` 来自上一轮 API response 的 `usageMetadata.totalTokenCount`（[geminiChat.ts:1217-1232](packages/core/src/core/geminiChat.ts:1217)）。这导致：

1. **滞后一轮**：cheap-gate 用 `lastPromptTokenCount` 判断，但本次 send 实际 prompt = 它 + 本轮 user message。少算的部分可能让阈值判断 false-negative
2. **首轮为 0**：初始值是 0，第一次 send 时无论历史多大都不会触发任何阈值（含 `--continue` 恢复 / sub-agent 继承场景）

引入轻量本地估算函数 `estimatePromptTokens`，在 send 前 cheap-gate / hard 判断时补足这两段缺失：

```ts
// chatCompressionService.ts（或新文件 packages/core/src/services/tokenEstimation.ts）

const BYTES_PER_TOKEN = 4; // 通用 char/4 估算（claude-code 同此）
const BYTES_PER_TOKEN_JSON = 2; // JSON / tool_call input 更密集

/**
 * 估算一组 Content 的 token 数，用于补偿 API usage metadata 的滞后。
 * 对 image / document 复用现有 imageTokenEstimate（默认 1600）。
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  // 复用 estimateContentChars（compactionInputSlimming.ts），再除以 bytesPerToken
  // 内部对 functionCall / functionResponse 用 BYTES_PER_TOKEN_JSON
  // ...
}

/**
 * cheap-gate 与 hard 判断的统一入口。
 * 主路径：lastPromptTokenCount 准 + 本轮 user message 估算
 * 首轮路径：full history 估算
 */
export function estimatePromptTokens(
  history: Content[],
  userMessage: Content,
  lastPromptTokenCount: number,
): number {
  if (lastPromptTokenCount > 0) {
    return lastPromptTokenCount + estimateContentTokens([userMessage]);
  }
  return estimateContentTokens([...history, userMessage]);
}
```

应用位置：

- `chatCompressionService.compress()` 的 cheap-gate：把 `originalTokenCount` 来源换成 `estimatePromptTokens(history, userMessage, lastPromptTokenCount)`
- `geminiChat.sendMessageStream` 入口的 hard 判断（见下一节）

**估算只用于提前触发，不用于「跳过触发」。** 因为 char/4 是粗略下界估计，作为 false-positive 一侧是安全的（宁可早一点压），作为 false-negative 则不可靠。

## 触发链路改动

### chatCompressionService.ts

1. **导出 `computeThresholds`**，供 cheap-gate / UI / 命令复用
2. **`compress()` cheap-gate** (line 221-249)：
   ```ts
   if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !force) {
     return NOOP;
   }
   const { auto } = computeThresholds(contextLimit);
   const effectiveTokens = estimatePromptTokens(
     curatedHistory,
     userMessage,
     originalTokenCount,
   );
   if (!force && effectiveTokens < auto) return NOOP;
   ```
3. **`compress()` 的 runSideQuery 调用** (line 356-380)：关闭 thinking + 加 `maxOutputTokens`：

   ```ts
   const summaryResult = await runSideQuery(config, {
     // ...
     config: {
       thinkingConfig: { includeThoughts: false }, // 关闭 thinking（与 claude-code 一致）
       maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS, // 硬上限 20K
     },
     // ...
   });
   ```

   或者直接删掉 `thinkingConfig` 让 `runSideQuery` 默认值（[sideQuery.ts:118](packages/core/src/utils/sideQuery.ts:118) 默认 `includeThoughts: false`）接管。

   关 thinking 后，`maxOutputTokens` 直接约束总输出（不存在 thinking 单独 budget 的问题），`SUMMARY_RESERVE = maxOutput = 20K` 是干净的硬关系。

   同时更新 [chatCompressionService.ts:374-376](packages/core/src/services/chatCompressionService.ts:374) 的注释，从「Compression quality drives every subsequent main turn — keep reasoning on」改为说明「为保证跨 provider 可预测的输出上限，与 claude-code 设计对齐」。

   token math 一段（[:436-437](packages/core/src/services/chatCompressionService.ts:436)）的 "may include non-persisted tokens (thoughts)" 注释也可以同步清理

### geminiChat.ts: `sendMessageStream` 入口（line 562）

```ts
// 替换前：tryCompress(force=false)
// 替换后：用估算 token 判断是否触发 hard，决定 force 标志

const { hard } = computeThresholds(contextLimit);
const effectiveTokens = estimatePromptTokens(
  this.getHistory(true),
  createUserContent(params.message),
  this.lastPromptTokenCount,
);
const shouldForceFromHard = effectiveTokens >= hard;

if (shouldForceFromHard) {
  // 重置熔断器，等同 force compress
  this.consecutiveFailures = 0;
}

compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  shouldForceFromHard,
  params.config?.abortSignal,
);
```

### 失败处理升级 (`geminiChat.ts:504-510`)

```ts
// 替换前
hasFailedCompressionAttempt: boolean;

// 替换后
consecutiveFailures: number;  // 默认 0

// 失败分支
} else if (isCompressionFailureStatus(info.compressionStatus)) {
  if (!force) {
    this.consecutiveFailures += 1;
  }
}

// 成功分支
this.consecutiveFailures = 0;
```

`force=true` 调用失败不计入计数（保持现有 reactive / manual 不"占额"的语义）。

## UI 改动

### tipRegistry.ts 重写三条 context-\* tip

三层阈值正好与三条 tip 一一对应。映射关系（按 token 数从低到高）：

| Tip ID             | 当前条件                                      | 新条件                                                              | 文案变化                                                          |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `compress-intro`   | `pct >= 50 && < 80 && sessionPromptCount > 5` | `tokenCount >= warn && tokenCount < auto && sessionPromptCount > 5` | 保持不变                                                          |
| `context-high`     | `pct >= 80 && < 95`                           | `tokenCount >= auto && tokenCount < hard`                           | 保持不变                                                          |
| `context-critical` | `pct >= 95`                                   | `tokenCount >= hard`                                                | 加一句「Auto-compact will force on next send.」反映新 hard 层行为 |

**对触发频率的影响：**

- 主路径（auto 正常工作）：`tokenCount` 跨越 auto 后立即触发压缩，下一轮 tokenCount 回落，所以 `context-high` 仅在「触发到压缩生效之间」短暂可见
- 边缘路径（auto 失败 / 熔断 / reactive 来不及）：`tokenCount` 持续上涨，会依次穿过 warn → auto → hard 触发三条 tip，跟用户视角的"上下文越来越紧"一致
- `context-critical` 触发时 hard 层已经在 send 前 force compress（spec 触发链路改动一节），所以这条 tip 实际上是「post-rescue 告知」而非「pre-rescue 警告」，文案补一句说明

`TipContext` 接口增加：

```ts
export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
  // 新增：让 isRelevant 函数能拿到阈值。
  // computeThresholds 在调用方算好后注入，避免 tipRegistry 直接依赖 core。
  thresholds?: CompactionThresholds;
}
```

`AppContainer.tsx:1150` 构造 `TipContext` 时同步注入。

### /context 命令同步 (`contextCommand.ts:177-183`)

```ts
// 替换硬编码 (1 - threshold) * contextWindowSize
const { warn, auto, hard, effectiveWindow } =
  computeThresholds(contextWindowSize);

// 显示四行：
//   Effective window:   180K   (window − 20K reserve)
//   Warn threshold:     147K   (...)
//   Auto threshold:     167K   ← 当前位置
//   Hard threshold:     177K
// 标记当前 token count 落在哪个 tier
```

### Footer 持续提示（可选 follow-up）

本 spec 不强制实现 footer 持续提示，理由：

- 现有 tip 系统已经能在 history 里给出提示
- Footer 持续提示需要改 ink 渲染、增加重绘频率
- 可作为本 spec 后置 follow-up（独立 PR）

如果后续要做，建议触发条件 `tokenCount >= warn && tokenCount < auto`，超过 auto 后隐藏（压缩已开始）。

## 测试覆盖

### 单元测试（chatCompressionService.test.ts）

- `computeThresholds(32K)` → 比例兜底分支（warn/auto 均 pct，hard 退化）
- `computeThresholds(128K)` → 混合分支（warn=pct，auto=abs，hard=abs）
- `computeThresholds(200K)` → 绝对接管分支（warn/auto/hard 均 abs）
- `computeThresholds(1M)` → 全绝对分支
- `computeThresholds(window=10K)` → 极小窗口（绝对值全负），公式不崩
- 三层阈值始终满足 `warn <= auto <= hard`
- max() 公式在边界点（pct \* window == abs）稳定

### 单元测试（tokenEstimation.test.ts）

- `estimateContentTokens` 对纯文本 / json / functionCall / functionResponse / image / document 分别走对应 bytesPerToken
- `estimatePromptTokens` 在 `lastPromptTokenCount > 0` 时走「主路径」，等于 0 时走「首轮路径」
- 大 user message 在 cheap-gate 阶段被加上去后能跨越 auto 阈值
- 估算与真实 API usage 的偏差在 ±30% 以内（用真实历史样本回归）

### 集成测试（geminiChat.test.ts / chatCompressionService.test.ts）

- 3 次连续失败后 cheap-gate NOOP；下一次 force 后恢复
- 单次失败不再永久锁
- 估算 token 跨越 hard 后 send 自动 force compress
- 压缩 sideQuery 调用 `maxOutputTokens = COMPACT_MAX_OUTPUT_TOKENS` 正确透传到 `runSideQuery`，`thinkingConfig.includeThoughts` 为 `false`（或被 sideQuery 默认值接管）
- **首轮覆盖**：构造一个 `lastPromptTokenCount = 0` 但 history 巨大的 chat（模拟 `--continue` 恢复），首次 send 时 auto 阈值能被估算路径触发

### 兼容性测试

- 设置 `contextPercentageThreshold = 0.5` 启动 → stderr 警告 + 字段被忽略，行为以内部 PCT 常量为准

### Tip 系统测试（tipRegistry.test.ts）

- 三条 context-\* tip 在跨越 warn/auto/hard 时正确触发，且区间不重叠
- 主路径下 auto 阈值触发压缩后 `context-high` 不持续可见
- 边缘路径（熔断 + token 继续涨）下三条 tip 依次触发
- TipContext 缺 `thresholds` 时（fallback）行为合理

## 实施分阶段

| Phase | 内容                                                                                         | 独立性             |
| ----- | -------------------------------------------------------------------------------------------- | ------------------ |
| 1     | 内部常量 + `computeThresholds` + cheap-gate 改动（不含估算补偿）                             | 可独立合并         |
| 2     | 失败处理升级（1 → 3 熔断）                                                                   | 可独立合并         |
| 3     | hard 层 force compress 提前                                                                  | 依赖 P1 + P7       |
| 4     | 配置面变更 + breaking change 警告                                                            | 依赖 P1            |
| 5     | UI（tip 重写 + /context）                                                                    | 依赖 P1            |
| 6     | 压缩 sideQuery 关 thinking + 加 `maxOutputTokens` 上限                                       | 独立可先于 P1 落地 |
| 7     | Token 估算补偿（`estimateContentTokens` + `estimatePromptTokens`，应用到 cheap-gate / hard） | 独立可与 P1 并行   |

每个 Phase 可独立 PR。建议合并顺序 **P6 → P7 → P1 → P2 → P4 → P3 → P5**：先给压缩调用打上 `maxOutputTokens` 上限（让 buffer 假设可信）；再加估算补偿（让 token 数判断更可靠）；再把阈值基础设施落地；再做失败熔断、配置面变更；最后才打开 hard 层主动救场（这时已有可靠的 token 数 + 熔断器）。每个 PR 都能独立验证、独立回滚。

## 风险与注意事项

1. **关 thinking 可能影响摘要质量。** 原作者注释 "Compression quality drives every subsequent main turn — keep reasoning on" 表达过对此的担忧。本 spec 的判断是「可预测的 token 上限」优先于「最大化质量」，但落地后需要观察 telemetry 里 `compression_input_token_count` / `compression_output_token_count` 的分布，以及主对话在压缩后的质量变化（用户反馈、`COMPRESSION_FAILED_*` 状态率）。如果质量下降明显，再考虑回退到 thinking 开启 + provider-specific thinkingBudget 控制。

2. **`maxOutputTokens` 触顶可能导致 summary 被截断。** 关 thinking 后，20K 直接限制 summary 主体；claude-code 实测 p99.99 ≈ 17K，留 ~3K 安全冗余。但 qwen-code 的压缩 prompt 与 claude-code 不同，分布需要观测。建议在压缩失败分支（[chatCompressionService.ts:464-491](packages/core/src/services/chatCompressionService.ts:464)）追加「检测到 finish_reason = MAX_TOKENS」的 NOOP 路径，避免持久化半截 summary。

3. **跨 provider 的 maxOutputTokens 映射差异。** OpenAI compat (dashscope) → `max_tokens`、Anthropic → `max_tokens`、Gemini SDK → `maxOutputTokens`。当前 qwen-code 已有这层映射（[contentGenerator.ts:94](packages/core/src/core/contentGenerator.ts:94) 等），需要在 P6 实现时验证 sideQuery 路径上 `maxOutputTokens` 字段确实贯穿到所有 provider 的请求体。

4. **Token 估算是粗略下界，不应反向用作"跳过触发"的依据。** `char/4` 与各 provider 真实 tokenizer 偏差可能 ±30%。本 spec 只用估算来「让阈值更早触发」（false-positive 方向，宁可早压不可晚压）。所有「降低 token 计数 / 跳过压缩」的代码路径仍应使用 `lastPromptTokenCount`（API 权威值）。

5. **估算函数与现有 `estimateContentChars` 的关系。** [compactionInputSlimming.ts](packages/core/src/services/compactionInputSlimming.ts) 已经有 `estimateContentChars`（用于压缩 split point 计算），新增的 `estimateContentTokens` 应复用它（除以 bytesPerToken）而非新写一套，避免两套估算口径出现分歧。

## 不在本 spec 范围

- Env 变量覆盖通道（D 方案）：维持「配置面最小」原则
- Footer 常驻可视化：留作 follow-up
- 摘要 prompt 改进、`MIN_COMPRESSION_FRACTION` 调整：与阈值设计正交

## 开放问题（等 review）

1. **breaking change 强度**：警告 + 忽略字段 vs 启动报错。当前选警告，需要确认对企业部署/团队配置是否够友好

## 已结案

2. **小窗口（≤ ~76.7K）下 hard 与 auto 退化为同一值** — 决定**不在 `/context` 明示**。理由：
   - 塌缩范围不只是 32K，所有 `effectiveWindow - HARD_BUFFER ≤ 0.7 × window` 的窗口都塌缩（包括 64K）
   - 用户行为不变：塌缩窗口上 `currentTier` 跳过 `'auto'` 直接报 `'hard'`（`contextCommand.ts:43-44` 先判 `>= hard`），`context-high` band（`auto ≤ t < hard`）变成空带，少一档提示在小窗口上是合理的——窗口本身就小，用户大概率手动管理上下文
   - 如果未来有真实用户报告"小窗口看不到中间档提示"，再决定加 UI 标注或调整 `context-high` 触发条件（这是 UI 工作，不是 spec 工作）。当前选不增加 UI 复杂度
