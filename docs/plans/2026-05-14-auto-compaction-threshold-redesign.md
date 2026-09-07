---
description: "Implementation plan for Qwen Code auto-compaction threshold redesign, including token estimation, failure handling, and tests."
---

# Auto-Compaction Threshold Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 qwen-code 自动压缩的单层比例阈值（70%）升级为「比例 + 绝对」混合的三层阈值梯子（warn / auto / hard），同时给压缩调用本身打上 `maxOutputTokens` 上限、关闭 thinking、引入失败熔断、修复 `lastPromptTokenCount` 的滞后/首轮缺口、清理用户配置面。

**Architecture:**

- `chatCompressionService.ts` 新增 `computeThresholds(window)` 输出 `{ warn, auto, hard }`；cheap-gate 用 `auto`，`sendMessageStream` 入口加 hard 主动救场。
- 新建 `tokenEstimation.ts` 提供本地 char/4 估算函数，补偿 `lastPromptTokenCount` 的「滞后一轮 + 首轮为 0」两个 gap。
- 失败处理从 `hasFailedCompressionAttempt: boolean` 单次锁升级为 `consecutiveFailures: number` 三次熔断。
- 压缩 sideQuery 调用关 thinking + 加 `maxOutputTokens: 20K`。
- 删除 `chatCompression.contextPercentageThreshold` settings 字段，启动时遇旧配置 stderr 警告并忽略。
- `tipRegistry.ts` 三条 context-\* tip 重写为跟随新阈值；`/context` 命令显示三层数值。

**Tech Stack:** TypeScript, Vitest, `@google/genai`, 现有 `compactionInputSlimming` 估算工具。

**合并顺序：** P6 → P7 → P1 → P2 → P4 → P3 → P5。每个 Task 都是单 PR 候选。

---

## 文件结构

| 路径                                                        | 操作      | 责任                                                                                        |
| ----------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `packages/core/src/services/tokenEstimation.ts`             | 创建      | 字符级 token 估算 + `estimatePromptTokens` 入口                                             |
| `packages/core/src/services/tokenEstimation.test.ts`        | 创建      | 估算函数单元测试                                                                            |
| `packages/core/src/services/chatCompressionService.ts`      | 修改      | 新增常量 + `computeThresholds`；改 cheap-gate；关 thinking + maxOutput；改失败计数          |
| `packages/core/src/services/chatCompressionService.test.ts` | 修改      | computeThresholds 单测 + cheap-gate / sideQuery config 断言                                 |
| `packages/core/src/core/geminiChat.ts`                      | 修改      | `sendMessageStream` 入口加 hard 检查；`hasFailedCompressionAttempt` → `consecutiveFailures` |
| `packages/core/src/core/geminiChat.test.ts`                 | 修改      | hard 触发 + 熔断器 + 首轮覆盖集成测试                                                       |
| `packages/core/src/config/config.ts`                        | 修改      | `ChatCompressionSettings` 删除 `contextPercentageThreshold`；启动 warning                   |
| `packages/cli/src/services/tips/tipRegistry.ts`             | 修改      | 三条 context-\* tip 改用阈值绝对比较；`TipContext` 加 `thresholds`                          |
| `packages/cli/src/services/tips/tipRegistry.test.ts`        | 创建/修改 | tip 触发区间测试                                                                            |
| `packages/cli/src/ui/commands/contextCommand.ts`            | 修改      | 显示新三层阈值                                                                              |
| `packages/cli/src/ui/commands/contextCommand.test.ts`       | 修改      | 输出快照                                                                                    |
| `packages/cli/src/ui/AppContainer.tsx`                      | 修改      | 构造 `TipContext` 时注入 `thresholds`                                                       |

---

## Phase P6 — 压缩 sideQuery 关 thinking + 加 maxOutputTokens

第一个落地，让后续阈值假设可信。独立 PR。

### Task 1: 改 chatCompressionService 的 sideQuery 调用

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts:374-376`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

在 `chatCompressionService.test.ts` 顶部 import 部分增加 spy 入口，并在合适的 describe 内加测试。`runSideQuery` 已经是模块导出，可以 spyOn：

```ts
import * as sideQueryModule from '../utils/sideQuery.js';

describe('ChatCompressionService.compress sideQuery config', () => {
  it('passes maxOutputTokens=20_000 and includeThoughts=false to runSideQuery', async () => {
    const spy = vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>summary</state_snapshot>',
      usage: {
        promptTokenCount: 1000,
        candidatesTokenCount: 500,
        totalTokenCount: 1500,
      },
    } as any);

    const service = new ChatCompressionService();
    await service.compress(makeFakeChat(), {
      promptId: 'p',
      force: true,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 180_000,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const callArg = spy.mock.calls[0]![1];
    expect(callArg.config?.thinkingConfig?.includeThoughts).toBe(false);
    expect(callArg.config?.maxOutputTokens).toBe(20_000);
  });
});
```

`makeFakeChat` / `makeFakeConfig` 复用现有测试 helper（如果文件里已有，直接用；没有就 inline 一个最小桩）。

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'passes maxOutputTokens=20_000'
```

Expected: FAIL — 现在传入的是 `{ thinkingConfig: { includeThoughts: true } }`，且没有 `maxOutputTokens`。

- [ ] **Step 3: Implement — 修改 chatCompressionService.ts**

替换 [chatCompressionService.ts:374-376](packages/core/src/services/chatCompressionService.ts:374) 整段 `config:`：

```ts
const summaryResult = await runSideQuery(config, {
  purpose: 'chat-compression',
  model,
  maxAttempts: 1,
  systemInstruction: getCompressionPrompt(),
  contents: [
    ...slim.slimmedHistory,
    {
      role: 'user',
      parts: [
        {
          text: 'First, reason in your scratchpad. Then, generate the <state_snapshot>.',
        },
      ],
    },
  ],
  // Compression output is bounded by maxOutputTokens to guarantee a predictable
  // reserve across providers (see docs/design/auto-compaction-threshold-redesign.md).
  // Thinking is disabled because per-provider thinking-budget semantics are
  // inconsistent (Anthropic/OpenAI count it separately, Gemini varies by model).
  config: {
    thinkingConfig: { includeThoughts: false },
    maxOutputTokens: COMPACT_MAX_OUTPUT_TOKENS,
  },
  abortSignal: signal ?? new AbortController().signal,
  promptId,
});
```

在文件顶部常量区（紧跟 `TOOL_ROUND_RETAIN_COUNT` 之后）加：

```ts
/**
 * Hard cap on the compression sideQuery output (summary text only, since
 * thinking is disabled). Mirrors claude-code's MAX_OUTPUT_TOKENS_FOR_SUMMARY
 * (autoCompact.ts:30) which is based on p99.99 of real compaction outputs.
 */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
```

同时清理 `compress()` 内 token math 段（约 line 436-437）那条 `"may include non-persisted tokens (thoughts)"` 注释 —— 现在不存在 thinking 输出了，把句子改成「compressionOutputTokenCount reflects the summary tokens only since thinking is disabled」。

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS（新测试 + 现有测试不应回归）

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
feat(core): cap compression sideQuery output and disable thinking

Add COMPACT_MAX_OUTPUT_TOKENS=20_000 and pass maxOutputTokens to the
runSideQuery call, disable thinkingConfig.includeThoughts. Aligns with
claude-code's autoCompact reserve so the downstream threshold ladder
(P1/P3) can rely on a predictable upper bound on summary output across
providers (Anthropic / OpenAI / Gemini handle thinking budgets
inconsistently).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P7 — Token 估算补偿

修复 `lastPromptTokenCount` 的滞后/首轮缺口。3 个 Task。

### Task 2: 新建 tokenEstimation.ts 单元

**Files:**

- Create: `packages/core/src/services/tokenEstimation.ts`
- Create: `packages/core/src/services/tokenEstimation.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/services/tokenEstimation.test.ts`：

```ts
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import {
  estimateContentTokens,
  estimatePromptTokens,
} from './tokenEstimation.js';

const textContent = (text: string): Content => ({
  role: 'user',
  parts: [{ text }],
});

describe('estimateContentTokens', () => {
  it('returns 0 for empty array', () => {
    expect(estimateContentTokens([])).toBe(0);
  });

  it('estimates plain text at ~chars/4', () => {
    // "hello world" = 11 chars → ceil(11/4) = 3
    expect(estimateContentTokens([textContent('hello world')])).toBe(3);
  });

  it('sums tokens across multiple messages', () => {
    const a = textContent('aaaa'); // 4/4 = 1
    const b = textContent('bbbbbbbb'); // 8/4 = 2
    expect(estimateContentTokens([a, b])).toBe(3);
  });

  it('estimates inlineData via imageTokenEstimate', () => {
    const c: Content = {
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'xxx' } }],
    };
    expect(estimateContentTokens([c], 1600)).toBe(1600);
  });

  it('estimates functionCall (json-dense) at ~chars/2', () => {
    const c: Content = {
      role: 'model',
      parts: [{ functionCall: { name: 'foo', args: { a: 1, b: 2 } } }],
    };
    // estimateContentChars stringifies; the resulting JSON is short but the
    // ratio (chars/2) should make this >= chars/4 path.
    const result = estimateContentTokens([c]);
    expect(result).toBeGreaterThan(0);
  });
});

describe('estimatePromptTokens', () => {
  const history: Content[] = [
    textContent('older message a'),
    textContent('older message b'),
  ];
  const user = textContent('current user message');

  it('uses lastPromptTokenCount + user-message estimate when count > 0', () => {
    const userEst = estimateContentTokens([user]);
    expect(estimatePromptTokens(history, user, 5000)).toBe(5000 + userEst);
  });

  it('falls back to full estimate when lastPromptTokenCount is 0', () => {
    const fullEst = estimateContentTokens([...history, user]);
    expect(estimatePromptTokens(history, user, 0)).toBe(fullEst);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/tokenEstimation.test.ts
```

Expected: FAIL — `tokenEstimation.ts` 尚未创建。

- [ ] **Step 3: Implement — 新建 tokenEstimation.ts**

`packages/core/src/services/tokenEstimation.ts`：

```ts
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import {
  DEFAULT_IMAGE_TOKEN_ESTIMATE,
  estimateContentChars,
} from './compactionInputSlimming.js';

/**
 * Average bytes-per-token for char-based token estimation.
 * Matches claude-code's roughTokenCountEstimation default (tokens.ts).
 */
const BYTES_PER_TOKEN = 4;

/**
 * Estimate the token count of a list of Content objects via char/4.
 *
 * Reuses `estimateContentChars` so that inlineData / functionCall /
 * functionResponse get the same treatment they receive when computing
 * compression split points — keeping the two estimators in sync prevents
 * the auto-compaction trigger and the splitter from disagreeing on size.
 *
 * Intended for the pre-send threshold gate only. Char/4 is a conservative
 * lower bound (real tokenizers vary ±30%); using it to TRIGGER compaction
 * earlier is safe (false-positive), using it to SKIP compaction is not.
 */
export function estimateContentTokens(
  contents: Content[],
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  let totalChars = 0;
  for (const content of contents) {
    totalChars += estimateContentChars(content, imageTokenEstimate);
  }
  return Math.ceil(totalChars / BYTES_PER_TOKEN);
}

/**
 * Compute an effective prompt-token count for the auto-compaction gate.
 *
 * `lastPromptTokenCount` (from the previous turn's usage metadata) lacks
 * two things: the current user message, and any initial value on the
 * very first send. This helper closes both gaps via local estimation.
 */
export function estimatePromptTokens(
  history: Content[],
  userMessage: Content,
  lastPromptTokenCount: number,
  imageTokenEstimate: number = DEFAULT_IMAGE_TOKEN_ESTIMATE,
): number {
  if (lastPromptTokenCount > 0) {
    return (
      lastPromptTokenCount +
      estimateContentTokens([userMessage], imageTokenEstimate)
    );
  }
  return estimateContentTokens([...history, userMessage], imageTokenEstimate);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/tokenEstimation.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/tokenEstimation.ts packages/core/src/services/tokenEstimation.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add token estimation helper for compaction gate

Introduce estimateContentTokens / estimatePromptTokens built on the
existing estimateContentChars (compactionInputSlimming) divided by a
char/4 ratio. Will replace raw lastPromptTokenCount usage at the cheap-
gate and hard-threshold checks so the system can react to (a) the
current user message and (b) the very first send (where the API-
reported count is 0).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3: 在 chatCompressionService cheap-gate 应用估算

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

本 Task 在 P1 之前落地，所以使用**现有的** `threshold * contextLimit` 公式（70% \* 200K = 140K），只把 `originalTokenCount` 替换为 `estimatePromptTokens(...)`：

```ts
import * as sideQueryModule from '../utils/sideQuery.js';

describe('ChatCompressionService.compress cheap-gate uses estimated tokens', () => {
  it('triggers compaction when API-reported tokens are below threshold but estimated tokens with the pending user message exceed it', async () => {
    // 200K 窗口当前阈值 = 0.7 * 200K = 140K
    // originalTokenCount = 135K（差 5K）
    // user message 估算 ~10K → 145K，跨越 140K
    const userMessage: Content = {
      role: 'user',
      parts: [{ text: 'x'.repeat(40_000) }], // 40K chars ≈ 10K tokens
    };
    const chat = makeFakeChat({ historyChars: 500_000 });

    // Mock runSideQuery 让 compress 后续步骤不爆
    vi.spyOn(sideQueryModule, 'runSideQuery').mockResolvedValue({
      text: '<state_snapshot>x</state_snapshot>',
      usage: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    } as any);

    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 135_000,
      pendingUserMessage: userMessage,
    });
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });

  it('NOOPs when neither originalTokenCount nor estimated total reaches threshold', async () => {
    const chat = makeFakeChat();
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 80_000,
      pendingUserMessage: {
        role: 'user',
        parts: [{ text: 'short' }],
      },
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });
});
```

`makeFakeChat({ historyChars })` 是测试文件内 inline helper：构造 `GeminiChat` 替身，`getHistory()` 返回长度近似匹配 `historyChars` 的 Content 数组（如果文件已有 helper 则复用）。

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'cheap-gate uses estimated tokens'
```

Expected: FAIL — 当前 cheap-gate 只看 `originalTokenCount`，会判定 NOOP。

- [ ] **Step 3: Implement — 改 compress() cheap-gate**

修改 [chatCompressionService.ts:235-249](packages/core/src/services/chatCompressionService.ts:235) 这段：

```ts
// Don't compress if not forced and we are under the limit. This is the
// steady-state path on every send; we want to exit before paying for the
// full `getHistory(true)` clone below.
if (!force) {
  const contextLimit =
    config.getContentGeneratorConfig()?.contextWindowSize ??
    DEFAULT_TOKEN_LIMIT;
  const pendingUserMessage = opts.pendingUserMessage;
  const effectiveTokens = pendingUserMessage
    ? estimatePromptTokens(
        chat.getHistory(true),
        pendingUserMessage,
        originalTokenCount,
        slimmingConfig.imageTokenEstimate,
      )
    : originalTokenCount;
  if (effectiveTokens < threshold * contextLimit) {
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus: CompressionStatus.NOOP,
      },
    };
  }
}
```

`CompressOptions` 接口（[:172-196](packages/core/src/services/chatCompressionService.ts:172)）加新字段：

```ts
export interface CompressOptions {
  // ... 现有字段 ...
  /**
   * Pending user message about to be sent. When present, the cheap-gate
   * adds its estimated token count to `originalTokenCount` (which reflects
   * only the prior turn's API usage) so the gate sees the real prompt size.
   * Optional for backward compatibility with callers that don't have a
   * user message in hand (e.g. manual /compress force=true paths).
   */
  pendingUserMessage?: Content;
}
```

加 import：`import { estimatePromptTokens } from './tokenEstimation.js';`

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
feat(core): cheap-gate uses estimated tokens when user message is pending

Add `pendingUserMessage` to CompressOptions and feed it through
estimatePromptTokens at the auto-compaction cheap-gate. Closes the
'lag by one turn' gap where the threshold check missed the user
message about to be sent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: 在 geminiChat sendMessageStream 入口透传 pendingUserMessage

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/core/geminiChat.test.ts` 增加：

```ts
describe('sendMessageStream first-turn estimation', () => {
  it('triggers auto-compaction on the very first send when inherited history is huge', async () => {
    // 模拟 sub-agent 继承大历史 / --continue 场景：
    // lastPromptTokenCount = 0，但 history 已经填到接近 auto 阈值
    const chat = makeChatWithLargeInheritedHistory(/* ~150K chars worth */);
    expect(chat.getLastPromptTokenCount()).toBe(0);

    const mockGen = mockContentGeneratorWithUsage({
      totalTokenCount: 80_000,
    });
    chat.setContentGenerator(mockGen);

    const stream = await chat.sendMessageStream(
      'qwen-test',
      { message: 'next user prompt' },
      'prompt-1',
    );
    // 收集 stream 的第一个事件，应是 COMPRESSED
    const first = await stream.next();
    expect(first.value?.type).toBe(StreamEventType.COMPRESSED);
  });
});
```

helper `makeChatWithLargeInheritedHistory` 在测试文件里 inline：构造一个 `GeminiChat`，`history` 装入 1500 个简单 user/model content，每条 100 chars，总 ~150K chars。

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts -t 'first-turn estimation'
```

Expected: FAIL — 当前 `tryCompress` 用的是 `lastPromptTokenCount = 0`，cheap-gate 判 NOOP。

- [ ] **Step 3: Implement — 改 sendMessageStream 与 tryCompress**

[geminiChat.ts:562](packages/core/src/core/geminiChat.ts:562) 改为：

```ts
compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  false,
  params.config?.abortSignal,
  {
    pendingUserMessage: createUserContent(params.message),
  },
);
```

`tryCompress` 函数签名（约 [:460-478](packages/core/src/core/geminiChat.ts:460)）的 `options` 接口 `TryCompressOptions` 加：

```ts
interface TryCompressOptions {
  originalTokenCountOverride?: number;
  trigger?: CompactTrigger;
  pendingUserMessage?: Content; // ← 新增
}
```

把 `pendingUserMessage` 透传给 `service.compress`：

```ts
const { newHistory, info } = await service.compress(this, {
  // ... 现有字段 ...
  pendingUserMessage: options?.pendingUserMessage,
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/geminiChat.ts packages/core/src/core/geminiChat.test.ts
git commit -m "$(cat <<'EOF'
feat(core): pass pendingUserMessage from sendMessageStream to tryCompress

Closes the 'first send after inherited history' gap where
lastPromptTokenCount is 0 and the cheap-gate would always NOOP.
estimatePromptTokens falls back to a full-history estimate in that
case once the user message is provided.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P1 — 三层阈值常量 + computeThresholds + cheap-gate

### Task 5: 添加常量与 computeThresholds 函数

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

`chatCompressionService.test.ts` 增加：

```ts
import { computeThresholds } from './chatCompressionService.js';

describe('computeThresholds', () => {
  it('32K window — proportional fallback for all tiers, hard degrades to auto', () => {
    const t = computeThresholds(32_000);
    expect(t.warn).toBe(19_200); // 0.6 * 32K
    expect(t.auto).toBe(22_400); // 0.7 * 32K
    expect(t.hard).toBe(22_400); // max(window-23K=9K, auto=22.4K) = auto
    expect(t.effectiveWindow).toBe(12_000);
  });

  it('128K window — mixed (warn=pct, auto/hard=abs)', () => {
    const t = computeThresholds(128_000);
    expect(t.warn).toBe(76_800); // 0.6 * 128K (pct wins: 76.8K vs auto-20K=75K)
    expect(t.auto).toBe(95_000); // abs: window-33K (abs wins: 95K vs 0.7*128K=89.6K)
    expect(t.hard).toBe(105_000); // abs: window-23K
    expect(t.effectiveWindow).toBe(108_000);
  });

  it('200K window — absolute takes over all tiers', () => {
    const t = computeThresholds(200_000);
    expect(t.warn).toBe(147_000); // abs: auto-20K (abs wins: 147K vs 0.6*200K=120K)
    expect(t.auto).toBe(167_000); // abs: 200K-33K
    expect(t.hard).toBe(177_000); // abs: 200K-23K
  });

  it('1M window — fully absolute', () => {
    const t = computeThresholds(1_000_000);
    expect(t.warn).toBe(947_000);
    expect(t.auto).toBe(967_000);
    expect(t.hard).toBe(977_000);
  });

  it('extreme small window (10K) does not crash; returns sane values', () => {
    const t = computeThresholds(10_000);
    expect(t.warn).toBeGreaterThan(0);
    expect(t.auto).toBeGreaterThan(0);
    expect(t.warn).toBeLessThanOrEqual(t.auto);
    expect(t.auto).toBeLessThanOrEqual(t.hard);
  });

  it('thresholds always satisfy warn <= auto <= hard', () => {
    for (const w of [32_000, 64_000, 128_000, 200_000, 256_000, 1_000_000]) {
      const t = computeThresholds(w);
      expect(t.warn).toBeLessThanOrEqual(t.auto);
      expect(t.auto).toBeLessThanOrEqual(t.hard);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'computeThresholds'
```

Expected: FAIL — `computeThresholds` 不存在。

- [ ] **Step 3: Implement — 加常量与函数**

在 [chatCompressionService.ts](packages/core/src/services/chatCompressionService.ts) 文件常量区（紧跟 `COMPACT_MAX_OUTPUT_TOKENS`）加：

```ts
/**
 * Default proportional auto-compaction threshold (legacy semantics
 * preserved as a small-window fallback / safety net).
 */
export const DEFAULT_PCT = 0.7;

/**
 * Warn-tier proportional offset: warn-pct = PCT - WARN_PCT_OFFSET (= 0.6).
 */
export const WARN_PCT_OFFSET = 0.1;

/**
 * Token budget reserved for compression output. Matches COMPACT_MAX_OUTPUT_TOKENS
 * because thinking is disabled (see Task 1) so maxOutputTokens is the hard
 * ceiling on summary output.
 */
export const SUMMARY_RESERVE = COMPACT_MAX_OUTPUT_TOKENS; // 20_000

/** Distance between auto threshold and effectiveWindow. */
export const AUTOCOMPACT_BUFFER = 13_000;

/** Distance between warn threshold and auto threshold. */
export const WARN_BUFFER = 20_000;

/** Distance between hard threshold and effectiveWindow (claude-code MANUAL_COMPACT_BUFFER). */
export const HARD_BUFFER = 3_000;

/** Auto-compaction consecutive-failure circuit breaker. */
export const MAX_CONSECUTIVE_FAILURES = 3;

export interface CompactionThresholds {
  /** Token count at which UI warn tier triggers. */
  warn: number;
  /** Token count at which auto-compaction triggers. */
  auto: number;
  /** Token count at which auto-compaction is forced (resets failure counter). */
  hard: number;
  /** Window minus SUMMARY_RESERVE; the budget available for input + summary. */
  effectiveWindow: number;
}

/**
 * Compute the three-tier threshold ladder for a given context window.
 *
 * Each tier is `max(proportional, absolute)`:
 *   auto  = max(PCT * window,                effectiveWindow - AUTOCOMPACT_BUFFER)
 *   warn  = max((PCT - WARN_OFFSET) * window, auto - WARN_BUFFER)
 *   hard  = max(effectiveWindow - HARD_BUFFER, auto)  // hard degrades to auto for tiny windows
 *
 * Small windows (where the absolute branch goes negative) automatically fall
 * back to the proportional branch. Large windows are dominated by the absolute
 * branch, capping wasted reservation to ~33K instead of 30% of the window.
 */
export function computeThresholds(window: number): CompactionThresholds {
  const effectiveWindow = window - SUMMARY_RESERVE;

  const absAuto = effectiveWindow - AUTOCOMPACT_BUFFER;
  const auto = Math.max(DEFAULT_PCT * window, absAuto);

  const absWarn = auto - WARN_BUFFER;
  const warn = Math.max((DEFAULT_PCT - WARN_PCT_OFFSET) * window, absWarn);

  const rawHard = effectiveWindow - HARD_BUFFER;
  const hard = Math.max(rawHard, auto);

  return { warn, auto, hard, effectiveWindow };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
feat(core): add computeThresholds for three-tier compaction ladder

Introduces warn/auto/hard thresholds combining proportional fallback
(small windows) with absolute reservation (large windows). Matches the
formula in docs/design/auto-compaction-threshold-redesign.md. Pure
function with full coverage across 32K/128K/200K/1M/extreme-small
windows.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6: cheap-gate 切换到 computeThresholds.auto

**Files:**

- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('compress cheap-gate uses computeThresholds.auto', () => {
  it('on a 200K window with originalTokenCount=160K, NOOP (below auto=167K)', async () => {
    const chat = makeFakeChat();
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 160_000,
    });
    expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
  });

  it('on a 200K window with originalTokenCount=168K, proceeds past gate', async () => {
    // 168K > 167K (auto)，cheap-gate 放行，进入 curatedHistory 阶段
    const chat = makeFakeChat({ historyChars: 500_000 });
    const result = await new ChatCompressionService().compress(chat, {
      promptId: 'p',
      force: false,
      model: 'qwen-test',
      config: makeFakeConfig({ contextWindowSize: 200_000 }),
      hasFailedCompressionAttempt: false,
      originalTokenCount: 168_000,
    });
    // 实际结果取决于 mock 出来的 sideQuery；只验证不是被 cheap-gate 拦下的早期 NOOP
    expect(result.info.compressionStatus).not.toBe(CompressionStatus.NOOP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts -t 'cheap-gate uses computeThresholds'
```

Expected: FAIL — 当前阈值是 `threshold * contextLimit = 0.7 * 200K = 140K`，160K 已经超过 140K 直接 cheap-gate 放行（不符断言①）；168K 同理。

- [ ] **Step 3: Implement — 切换 cheap-gate 公式**

修改 [chatCompressionService.ts:235-249](packages/core/src/services/chatCompressionService.ts:235) 那段 `if (!force) { ... }` 块：

```ts
if (!force) {
  const contextLimit =
    config.getContentGeneratorConfig()?.contextWindowSize ??
    DEFAULT_TOKEN_LIMIT;
  const { auto } = computeThresholds(contextLimit);
  const pendingUserMessage = opts.pendingUserMessage;
  const effectiveTokens = pendingUserMessage
    ? estimatePromptTokens(
        chat.getHistory(true),
        pendingUserMessage,
        originalTokenCount,
        slimmingConfig.imageTokenEstimate,
      )
    : originalTokenCount;
  if (effectiveTokens < auto) {
    return {
      newHistory: null,
      info: {
        originalTokenCount,
        newTokenCount: originalTokenCount,
        compressionStatus: CompressionStatus.NOOP,
      },
    };
  }
}
```

同时删除 [chatCompressionService.ts:214-217](packages/core/src/services/chatCompressionService.ts:214) 那段 `const threshold = chatCompressionSettings?.contextPercentageThreshold ?? COMPRESSION_TOKEN_THRESHOLD;`，因为 `threshold` 现在不再被 cheap-gate 使用。同时去掉 line 221 那个 `threshold <= 0` 分支（隐式禁用语义，详细在 P4 处理）。

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): cheap-gate uses computeThresholds.auto

Replace the legacy `threshold * contextLimit` formula with
computeThresholds.auto, which combines proportional fallback with
absolute reservation. On large windows (>=128K) the gate now triggers
later than 70% but reserves a fixed ~33K, freeing tens of thousands of
context tokens that the old formula wasted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P2 — 失败处理升级（1 次锁 → 3 次熔断）

### Task 7: hasFailedCompressionAttempt → consecutiveFailures

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

`geminiChat.test.ts`：

```ts
describe('compression failure circuit breaker', () => {
  it('tolerates 2 consecutive failures, NOOPs the third', async () => {
    const chat = makeChatWithMockedFailingCompression();
    // 触发 3 次连续失败：
    await chat.sendMessageStream('m', { message: 'a' }, 'p1'); // attempt 1 fails
    await chat.sendMessageStream('m', { message: 'b' }, 'p2'); // attempt 2 fails
    const events = await collectEvents(
      await chat.sendMessageStream('m', { message: 'c' }, 'p3'), // attempt 3 should NOOP
    );
    expect(
      events.find((e) => e.type === StreamEventType.COMPRESSED),
    ).toBeUndefined();
    // 验证 service.compress 第 3 次根本没被调用（熔断器 NOOP 在 cheap-gate）
    expect(getCompressCallCount()).toBe(2);
  });

  it('resets counter on a successful force compress', async () => {
    const chat = makeChatWithMockedFailingCompression();
    await chat.sendMessageStream('m', { message: 'a' }, 'p1'); // fail
    await chat.sendMessageStream('m', { message: 'b' }, 'p2'); // fail
    // 用户手动 /compress
    await chat.tryCompress('p3', 'm', /* force */ true);
    // 现在熔断器应该已重置
    await chat.sendMessageStream('m', { message: 'c' }, 'p4');
    expect(getCompressCallCount()).toBeGreaterThan(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts -t 'circuit breaker'
```

Expected: FAIL — 当前一次失败就永久锁，第 2 次 send 已经被 cheap-gate NOOP，第 3 次也 NOOP，但断言 ② 期望力 force 之后能恢复且 sendMessageStream 走得到 compress。

- [ ] **Step 3: Implement —替换字段**

[geminiChat.ts](packages/core/src/core/geminiChat.ts) 内部字段（grep `hasFailedCompressionAttempt`）：

```ts
// 替换前
private hasFailedCompressionAttempt = false;

// 替换后
private consecutiveFailures = 0;
```

[geminiChat.ts:467-478](packages/core/src/core/geminiChat.ts:467) 的 `tryCompress` 函数传给 `service.compress` 的字段：

```ts
const { newHistory, info } = await service.compress(this, {
  promptId,
  force,
  model,
  config: this.config,
  consecutiveFailures: this.consecutiveFailures, // ← 取代 hasFailedCompressionAttempt
  originalTokenCount:
    options?.originalTokenCountOverride ?? this.lastPromptTokenCount,
  pendingUserMessage: options?.pendingUserMessage,
  trigger: options?.trigger,
  signal,
});
```

[geminiChat.ts:503-510](packages/core/src/core/geminiChat.ts:503) 失败/成功分支：

```ts
if (info.compressionStatus === CompressionStatus.COMPRESSED && newHistory) {
  // ... 现有逻辑 ...
  this.setHistory(newHistory);
  this.config.getFileReadCache().clear();
  this.lastPromptTokenCount = info.newTokenCount;
  this.telemetryService?.setLastPromptTokenCount(info.newTokenCount);
  this.consecutiveFailures = 0; // ← 取代 hasFailedCompressionAttempt = false
} else if (isCompressionFailureStatus(info.compressionStatus)) {
  if (!force) {
    this.consecutiveFailures += 1; // ← 取代 hasFailedCompressionAttempt = true
  }
}
```

[chatCompressionService.ts](packages/core/src/services/chatCompressionService.ts) 的 `CompressOptions` 接口：

```ts
export interface CompressOptions {
  // ... 现有字段 ...
  /**
   * Number of consecutive auto-compaction failures for this chat. When
   * it reaches MAX_CONSECUTIVE_FAILURES, the gate stops trying until a
   * successful force=true call resets it.
   */
  consecutiveFailures: number;
  // 删除 hasFailedCompressionAttempt
}
```

`compress()` 函数内 [:221](packages/core/src/services/chatCompressionService.ts:221) 那段 cheap-gate 检查：

```ts
// Cheap gates first — these don't need the curated history.
if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !force) {
  return {
    newHistory: null,
    info: {
      originalTokenCount: 0,
      newTokenCount: 0,
      compressionStatus: CompressionStatus.NOOP,
    },
  };
}
```

更新解构 `const { ... } = opts;` 把 `hasFailedCompressionAttempt` 替换成 `consecutiveFailures`。

`chatCompressionService.test.ts` 中所有传 `hasFailedCompressionAttempt: false/true` 的地方改为 `consecutiveFailures: 0` / `consecutiveFailures: MAX_CONSECUTIVE_FAILURES`，逐个修正测试期望。

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts packages/core/src/services/chatCompressionService.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/geminiChat.ts packages/core/src/services/chatCompressionService.ts packages/core/src/core/geminiChat.test.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
refactor(core): replace hasFailedCompressionAttempt with circuit breaker

Switches from a one-shot permanent lock to a three-strike circuit
breaker (MAX_CONSECUTIVE_FAILURES=3). Successful force compress
(manual /compress, reactive overflow, or hard-tier rescue) resets the
counter. Aligns with claude-code's design and unblocks recovery from
transient failures (rate limits, transient model errors) that
previously disabled auto-compaction for the rest of the session.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P4 — 配置面：删除 contextPercentageThreshold + breaking-change 警告

### Task 8: 删除字段 + 启动 warning

**Files:**

- Modify: `packages/core/src/config/config.ts`
- Modify: `packages/cli/src/config/settingsSchema.ts`（如果有引用）
- Modify: `packages/core/src/services/chatCompressionService.ts`
- Modify: `packages/core/src/services/chatCompressionService.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/core/src/config/config.test.ts`（如果不存在则创建）：

```ts
import { describe, it, expect, vi } from 'vitest';

describe('Config — chatCompression.contextPercentageThreshold deprecation', () => {
  it('logs a stderr warning when the deprecated field is set', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Config({
      // ... minimal required Config params ...
      chatCompression: { contextPercentageThreshold: 0.5 } as any,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'chatCompression.contextPercentageThreshold has been removed',
      ),
    );
    warnSpy.mockRestore();
  });

  it('does not warn when the deprecated field is absent', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new Config({
      // ... minimal params, no chatCompression.contextPercentageThreshold ...
    });
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('chatCompression.contextPercentageThreshold'),
    );
    warnSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/config/config.test.ts
```

Expected: FAIL — Config 当前完全接受这个字段，无 warning。

- [ ] **Step 3: Implement — 改 ChatCompressionSettings + Config 构造函数**

[config.ts:217-227](packages/core/src/config/config.ts:217)：

```ts
export interface ChatCompressionSettings {
  /**
   * Estimated tokens for a single inline image / document part when
   * apportioning chars across history in `findCompressSplitPoint`.
   * Also used as the placeholder budget when stripping inline media
   * out of the side-query compaction prompt. Default 1600.
   * Env override: `QWEN_IMAGE_TOKEN_ESTIMATE`.
   */
  imageTokenEstimate?: number;
}
```

（删除 `contextPercentageThreshold` 字段。）

[config.ts](packages/core/src/config/config.ts) 找到 Config 构造函数中处理 `params.chatCompression` 的位置（约 line 933），在赋值前加：

```ts
if (
  params.chatCompression &&
  typeof (params.chatCompression as Record<string, unknown>)
    .contextPercentageThreshold !== 'undefined'
) {
  console.warn(
    '[qwen-code] chatCompression.contextPercentageThreshold has been removed ' +
      'and is now controlled by built-in thresholds. Setting will be ignored.',
  );
}
this.chatCompression = params.chatCompression;
```

`chatCompressionService.ts` 同时清理：[:214-217](packages/core/src/services/chatCompressionService.ts:214) 那段已经在 Task 6 删除，再检查文件里有没有残留 `chatCompressionSettings?.contextPercentageThreshold` 或导出的常量 `COMPRESSION_TOKEN_THRESHOLD`：

- 如果 `COMPRESSION_TOKEN_THRESHOLD` 已经无任何引用，删除该常量。
- 如果还有引用（比如 telemetry 或 doc），改为引用 `DEFAULT_PCT`。

cli/config/settingsSchema.ts 不需要改 —— `chatCompression` 仍然是 `type: 'object'`，里面没有 schema 字段（[settingsSchema.ts:1020-1028](packages/cli/src/config/settingsSchema.ts:1020)）。如果 schema 内部有对 `contextPercentageThreshold` 的引用，删除。

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core
npm test --workspace=packages/cli
```

Expected: PASS（包括既有压缩相关测试）

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config/config.ts packages/core/src/config/config.test.ts packages/core/src/services/chatCompressionService.ts packages/core/src/services/chatCompressionService.test.ts
git commit -m "$(cat <<'EOF'
refactor(core)!: remove chatCompression.contextPercentageThreshold setting

The proportional threshold is now an internal constant (DEFAULT_PCT) and
the auto-compaction threshold is computed from a mixed proportional /
absolute formula (computeThresholds). User-facing tuning of the bare
percentage no longer maps to meaningful behavior on large-window models.

Existing settings.json files containing the field will log a one-line
stderr warning on startup; the field is otherwise ignored.

BREAKING CHANGE: chatCompression.contextPercentageThreshold is removed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P3 — hard 层主动救场

### Task 9: sendMessageStream 入口加 hard 检查 + force compress

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('sendMessageStream hard-tier rescue', () => {
  it('triggers force compress when estimated tokens cross hard threshold', async () => {
    // 构造 200K 窗口：hard = 177K
    const chat = makeChatWithLastPromptTokenCount(176_000);
    // 本轮 user message 估算 + 176K 越过 177K
    const userMessage = makeBigUserMessage(/* ~3K tokens */);
    const stream = await chat.sendMessageStream(
      'm',
      { message: userMessage },
      'p',
    );
    const first = await stream.next();
    expect(first.value?.type).toBe(StreamEventType.COMPRESSED);
    expect(getLastCompressCallForce()).toBe(true);
  });

  it('hard rescue resets consecutiveFailures before forcing', async () => {
    const chat = makeChatWithLastPromptTokenCount(176_000);
    // 先制造 3 次失败，使 consecutiveFailures = 3
    setMockedCompressionToFail(3);
    await chat.sendMessageStream('m', { message: 'a' }, 'p1');
    await chat.sendMessageStream('m', { message: 'b' }, 'p2');
    await chat.sendMessageStream('m', { message: 'c' }, 'p3');
    expect(chat.getConsecutiveFailures()).toBe(3);
    // 第 4 次：token 跨越 hard，hard rescue 重置熔断器并 force=true
    setMockedCompressionToSucceed();
    await chat.sendMessageStream('m', { message: 'd' }, 'p4');
    expect(getLastCompressCallForce()).toBe(true);
    expect(chat.getConsecutiveFailures()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts -t 'hard-tier rescue'
```

Expected: FAIL — sendMessageStream 当前永远以 `force=false` 调 tryCompress。

- [ ] **Step 3: Implement —在 sendMessageStream 入口加 hard 判断**

[geminiChat.ts:560-567](packages/core/src/core/geminiChat.ts:560)：

```ts
// Hard-tier rescue: if pending prompt is large enough to risk overflow,
// force compress before the send and reset the failure counter so a
// session already in circuit-breaker NOOP can recover. This proactively
// covers what reactive overflow (line ~711) would otherwise catch
// after a wasted round-trip.
const contextLimit =
  this.config.getContentGeneratorConfig()?.contextWindowSize ??
  DEFAULT_TOKEN_LIMIT;
const { hard } = computeThresholds(contextLimit);
const pendingUserMessage = createUserContent(params.message);
const effectiveTokens = estimatePromptTokens(
  this.getHistory(true),
  pendingUserMessage,
  this.lastPromptTokenCount,
);
const shouldForceFromHard = effectiveTokens >= hard;
if (shouldForceFromHard) {
  this.consecutiveFailures = 0;
}

compressionInfo = await this.tryCompress(
  prompt_id,
  model,
  shouldForceFromHard,
  params.config?.abortSignal,
  { pendingUserMessage },
);
```

注意：`createUserContent` 在 sendMessageStream 内部本来在 [:569](packages/core/src/core/geminiChat.ts:569) 调一次；现在我们提前调，所以 [:569](packages/core/src/core/geminiChat.ts:569) 那行 `const userContent = createUserContent(params.message);` 可以删除/替换为 `const userContent = pendingUserMessage;`。

加 import：`import { computeThresholds } from '../services/chatCompressionService.js';`
加 import：`import { estimatePromptTokens } from '../services/tokenEstimation.js';`

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/core -- --run packages/core/src/core/geminiChat.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck --workspace=packages/core
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/core/geminiChat.ts packages/core/src/core/geminiChat.test.ts
git commit -m "$(cat <<'EOF'
feat(core): hard-tier rescue forces compaction before oversized send

When estimated tokens cross computeThresholds.hard, sendMessageStream
now resets the consecutive-failure counter and calls tryCompress with
force=true. This pulls reactive overflow recovery forward to before
the send, saving one wasted round-trip and unblocking sessions whose
circuit breaker had latched off.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase P5 — UI 改动（tip 重写 + /context 显示）

### Task 10: tipRegistry 重写三条 context-\* tip

**Files:**

- Modify: `packages/cli/src/services/tips/tipRegistry.ts`
- Modify: `packages/cli/src/services/tips/tipRegistry.test.ts`（如不存在则创建）
- Modify: `packages/cli/src/ui/AppContainer.tsx`

- [ ] **Step 1: Write the failing test**

`packages/cli/src/services/tips/tipRegistry.test.ts`：

```ts
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { tipRegistry, type TipContext } from './tipRegistry.js';

const baseCtx: TipContext = {
  lastPromptTokenCount: 0,
  contextWindowSize: 200_000,
  sessionPromptCount: 10,
  sessionCount: 1,
  platform: 'darwin',
  thresholds: {
    warn: 147_000,
    auto: 167_000,
    hard: 177_000,
    effectiveWindow: 180_000,
  },
};

function tipById(id: string) {
  return tipRegistry.find((t) => t.id === id)!;
}

describe('context-* tip thresholds align with computeThresholds', () => {
  it('compress-intro fires between warn and auto', () => {
    const t = tipById('compress-intro');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 100_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 150_000 })).toBe(
      true,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 168_000 })).toBe(
      false,
    );
  });

  it('context-high fires between auto and hard', () => {
    const t = tipById('context-high');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 150_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 170_000 })).toBe(
      true,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 178_000 })).toBe(
      false,
    );
  });

  it('context-critical fires at or above hard', () => {
    const t = tipById('context-critical');
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 170_000 })).toBe(
      false,
    );
    expect(t.isRelevant({ ...baseCtx, lastPromptTokenCount: 178_000 })).toBe(
      true,
    );
  });

  it('falls back gracefully when thresholds undefined (legacy callers)', () => {
    const ctx = { ...baseCtx, thresholds: undefined };
    // 三条 tip 在缺 thresholds 时应该都不触发（不能比较）
    expect(tipById('compress-intro').isRelevant(ctx)).toBe(false);
    expect(tipById('context-high').isRelevant(ctx)).toBe(false);
    expect(tipById('context-critical').isRelevant(ctx)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/services/tips/tipRegistry.test.ts
```

Expected: FAIL — `TipContext` 没有 `thresholds` 字段；三条 tip 仍按 50/80/95 百分比触发。

- [ ] **Step 3: Implement — 改 tipRegistry**

[tipRegistry.ts:15-21](packages/cli/src/services/tips/tipRegistry.ts:15)：

```ts
import type { CompactionThresholds } from '@qwen-code/qwen-code-core';
import { DEFAULT_TOKEN_LIMIT } from '@qwen-code/qwen-code-core';

export type TipTrigger = 'startup' | 'post-response';

export interface TipContext {
  lastPromptTokenCount: number;
  contextWindowSize: number;
  sessionPromptCount: number;
  sessionCount: number;
  platform: string;
  /**
   * Three-tier auto-compaction thresholds, computed by callers.
   * Optional for backward compat; tip checks return false when missing.
   */
  thresholds?: CompactionThresholds;
}
```

`getContextUsagePercent` 保留（其他 startup tip 可能用到），但 context-\* tips 不再依赖它。

替换 [tipRegistry.ts:37-69](packages/cli/src/services/tips/tipRegistry.ts:37) 三条 tip 的 `isRelevant`：

```ts
export const tipRegistry: ContextualTip[] = [
  // --- Post-response contextual tips (priority: higher = more urgent) ---
  {
    id: 'context-critical',
    content:
      'Context near hard limit — auto-compact will force on next send. Consider /clear if you want to start fresh.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.hard,
    cooldownPrompts: 3,
    priority: 100,
  },
  {
    id: 'context-high',
    content: 'Context is getting full. Use /compress to free up space.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.auto &&
      ctx.lastPromptTokenCount < ctx.thresholds.hard,
    cooldownPrompts: 5,
    priority: 90,
  },
  {
    id: 'compress-intro',
    content: 'Long conversation? /compress summarizes history to free context.',
    trigger: 'post-response',
    isRelevant: (ctx) =>
      ctx.thresholds !== undefined &&
      ctx.lastPromptTokenCount >= ctx.thresholds.warn &&
      ctx.lastPromptTokenCount < ctx.thresholds.auto &&
      ctx.sessionPromptCount > 5,
    cooldownPrompts: 10,
    priority: 50,
  },

  // --- Startup tips ---  ← 保持不变
  // ... 后面 startup tips 不动 ...
```

`packages/cli/src/ui/AppContainer.tsx:1150` 那一带（已知是 contextual-tips 构造点），改为：

```tsx
// pseudo — 具体取决于现有代码
const thresholds = computeThresholds(contextWindowSize);
const tipCtx: TipContext = {
  lastPromptTokenCount,
  contextWindowSize,
  sessionPromptCount,
  sessionCount,
  platform: process.platform,
  thresholds,
};
```

加 import 到 AppContainer.tsx：

```tsx
import { computeThresholds } from '@qwen-code/qwen-code-core';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/services/tips/tipRegistry.test.ts
npm test --workspace=packages/cli
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/services/tips/tipRegistry.ts packages/cli/src/services/tips/tipRegistry.test.ts packages/cli/src/ui/AppContainer.tsx
git commit -m "$(cat <<'EOF'
feat(cli): align context-* tips with new compaction thresholds

The three context-usage tips now compare tokenCount against the
warn/auto/hard ladder from computeThresholds instead of fixed 50/80/95
percentages. compress-intro fires between warn and auto, context-high
between auto and hard, context-critical at or above hard. Threshold
data is injected into TipContext from the AppContainer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 11: /context 命令显示三层阈值

**Files:**

- Modify: `packages/cli/src/ui/commands/contextCommand.ts`
- Modify: `packages/cli/src/ui/commands/contextCommand.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('/context shows three-tier thresholds', () => {
  it('renders warn/auto/hard with current tier marker', () => {
    const result = renderContextCommand({
      contextWindowSize: 200_000,
      lastPromptTokenCount: 150_000, // 在 warn 与 auto 之间
    });
    expect(result).toMatch(/Warn threshold:\s+147[,.]?000/);
    expect(result).toMatch(/Auto threshold:\s+167[,.]?000/);
    expect(result).toMatch(/Hard threshold:\s+177[,.]?000/);
    expect(result).toMatch(/current tier:\s+warn/i);
  });

  it('correctly identifies "below warn" tier when tokens are low', () => {
    const result = renderContextCommand({
      contextWindowSize: 200_000,
      lastPromptTokenCount: 50_000,
    });
    expect(result).toMatch(/current tier:\s+(safe|below warn|normal)/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/ui/commands/contextCommand.test.ts -t 'three-tier'
```

Expected: FAIL — 当前 [contextCommand.ts:177-183](packages/cli/src/ui/commands/contextCommand.ts:177) 用的是 `(1 - threshold) * contextWindowSize` 公式，只显示单个 "autocompactBuffer" 数。

- [ ] **Step 3: Implement — 改 contextCommand 输出**

替换 [contextCommand.ts:177-183](packages/cli/src/ui/commands/contextCommand.ts:177) 那段：

```ts
import { computeThresholds } from '@qwen-code/qwen-code-core';

// ... 在 buildContextSummary 或类似入口里：
const thresholds = computeThresholds(contextWindowSize);
const { warn, auto, hard, effectiveWindow } = thresholds;

function currentTier(tokens: number): string {
  if (tokens >= hard) return 'hard (force compress imminent)';
  if (tokens >= auto) return 'auto (compaction in progress / just ran)';
  if (tokens >= warn) return 'warn';
  return 'safe';
}

// 在格式化输出部分追加：
const lines = [
  // ... 现有输出 ...
  `Effective window:   ${formatNum(effectiveWindow)}  (window − 20K reserve)`,
  `Warn threshold:     ${formatNum(warn)}`,
  `Auto threshold:     ${formatNum(auto)}`,
  `Hard threshold:     ${formatNum(hard)}`,
  `Current tier:       ${currentTier(lastPromptTokenCount)}`,
];
```

注：`formatNum` 是现有项目里的 `.toLocaleString()` 等；如未在文件内则 inline 一个 `(n: number) => n.toLocaleString('en-US')`。

同时**删除**原来计算 `autocompactBuffer` 的代码（[:180-183](packages/cli/src/ui/commands/contextCommand.ts:180)）和对 `compressionThreshold` 的使用 —— 现在直接看 `auto`。

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test --workspace=packages/cli -- --run packages/cli/src/ui/commands/contextCommand.test.ts
```

Expected: PASS

- [ ] **Step 5: Typecheck + lint**

```bash
npm run typecheck
npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/ui/commands/contextCommand.ts packages/cli/src/ui/commands/contextCommand.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): /context shows three-tier thresholds and current tier

Replace the legacy single-buffer display with effective window + warn /
auto / hard threshold lines and a "current tier" label so users can see
exactly where in the ladder the session sits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## 验收（最终全量回归）

落地所有 task 后，最后跑一遍全量校验：

- [ ] **Step 1: 全量测试**

```bash
npm test
```

Expected: 全部 workspace 测试通过。

- [ ] **Step 2: 全量 typecheck**

```bash
npm run typecheck
```

- [ ] **Step 3: 全量 lint**

```bash
npm run lint
```

- [ ] **Step 4: 手动 smoke**

启动 CLI，执行：

1. `/context` —— 看新三层显示是否合理
2. 跑一个会触发压缩的对话（可用 200K 窗口模型把 prompt 灌到 170K+）
3. 设置 `chatCompression.contextPercentageThreshold = 0.5` 启动 —— 看 stderr 是否打印 deprecation 警告
4. 用 `--continue` 恢复一个 huge session，首次 send 时压缩是否被首轮估算路径触发

- [ ] **Step 5: PR 描述统一脚本（可选）**

如果 PR 是分批提交的，每个 PR 描述里链接 [docs/design/auto-compaction-threshold-redesign.md](docs/design/auto-compaction-threshold-redesign.md) 并标注 Phase / Task。
