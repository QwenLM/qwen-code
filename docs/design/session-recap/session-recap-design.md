# Session Recap 会话回顾

> 本文介绍 `/recap` 命令与离开-返回自动摘要（"where did I leave off"）功能的设计与实现。

---

## 目录

1. [问题与目标](#问题与目标)
2. [触发方式](#触发方式)
3. [架构](#架构)
4. [Prompt 设计](#prompt-设计)
5. [History 过滤](#history-过滤)
6. [并发与边界情况](#并发与边界情况)
7. [配置与模型选择](#配置与模型选择)
8. [可观测性](#可观测性)
9. [刻意未做的范围](#刻意未做的范围)

---

## 问题与目标

用户离开几天再 `/resume` 一个旧会话时，往往要翻几页才能回忆起**"上次在做什么、下一步是什么"**。
仅靠重新加载消息无法解决这个体验问题。

目标：在用户回到终端时，**主动**提供一段 1-3 句话的会话摘要：

- **高层任务**（在做什么）→ **下一步**（下一步做什么）。
- 视觉上明确区别于 Agent 的正常回复，避免被误读为新输出。
- **尽力而为**：失败必须静默，绝不打断主流程。

---

## 触发方式

| 触发     | 条件                                                                | 实现                                                         |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| **手动** | 用户输入 `/recap`                                                   | `recapCommand.ts` 调用同一个底层服务                         |
| **自动** | 终端失焦（DECSET 1004 焦点协议）≥ 5 分钟 + 焦点回归 + 流处于 `Idle` | `useAwaySummary.ts` 5min blur 计时 + `useFocus` 监听焦点事件 |

两条路径最终都调用 `generateSessionRecap()` 这一个底层函数，保证行为一致。
自动触发受 `general.showSessionRecap` 控制（默认开启），手动 `/recap` 不受其影响。

---

## 架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                          AppContainer.tsx                              │
│   isFocused = useFocus()                                               │
│   isIdle = streamingState === Idle                                     │
│       │                                                                │
│       ├─→ useAwaySummary({enabled, config, isFocused, isIdle, addItem})│
│       │       │                                                        │
│       │       └─→ 5 min blur 计时 + idle/dedupe 闸门                   │
│       │              │                                                 │
│       │              ↓                                                 │
│       └─→ recapCommand (slash) ─→ generateSessionRecap(config, signal) │
│                                          │                             │
│                                          ↓                             │
│                              ┌─────────────────────────┐               │
│                              │ packages/core/services/ │               │
│                              │   sessionRecap.ts       │               │
│                              └─────────────────────────┘               │
│                                          │                             │
│                                          ↓                             │
│                              GeminiClient.generateContent              │
│                              （fastModel + tools:[]）                  │
│                                                                        │
│   addItem({type: 'away_recap', text}) ─→ HistoryItemDisplay            │
│                                            └─ AwayRecapMessage         │
│                                               （dim color + ❯ 前缀）    │
└────────────────────────────────────────────────────────────────────────┘
```

### 关键文件

| 文件                                                         | 作用                                      |
| ------------------------------------------------------------ | ----------------------------------------- |
| `packages/core/src/services/sessionRecap.ts`                 | 一次性 LLM 调用 + history 过滤 + tag 提取 |
| `packages/cli/src/ui/hooks/useAwaySummary.ts`                | 自动触发的 React hook                     |
| `packages/cli/src/ui/commands/recapCommand.ts`               | `/recap` 手动入口                         |
| `packages/cli/src/ui/components/messages/StatusMessages.tsx` | `AwayRecapMessage` dim 渲染               |
| `packages/cli/src/ui/types.ts`                               | `HistoryItemAwayRecap` 类型               |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`      | 渲染分发                                  |
| `packages/cli/src/config/settingsSchema.ts`                  | `general.showSessionRecap` 配置           |

---

## Prompt 设计

### System Prompt

通过 `generationConfig.systemInstruction` 替换主 Agent 的 system prompt，使模型在这次调用中
**只**做 recap，不再表现为编程助手。注意 `GeminiClient.generateContent()` 内部会用
`getCustomSystemPrompt()` 在我们提供的 prompt 之后追加用户的 memory（QWEN.md / 自动 memory），
因此最终 system prompt = recap prompt + 用户 memory，这对 recap 反而是有益的项目背景。

要点（与 `RECAP_SYSTEM_PROMPT` 一一对应）：

- 限制 1-3 句、纯文本（无 markdown / 列表 / 标题）。
- 第一句必须是高层任务，紧接下一步。
- 明确禁止：罗列已做事项、复述工具调用、状态汇报。
- 要求**用对话主导语言回答**（中文 / 英文）。
- 输出必须包在 `<recap>...</recap>` 标签中，标签外不允许任何内容。

### 结构化输出 + 提取

模型被要求把 recap 包在 `<recap>...</recap>` 标签内：

```
<recap>正在重构 loopDetectionService.ts，解决长会话 OOM。下一步是实现选项 B。</recap>
```

理由：部分模型（GLM 系列、reasoning 模型等）在给出最终答案前会写"思考过程"。
直接取响应文本会把推理 leak 进 UI。

`extractRecap()` 三级回退：

1. 标签完整：取 `<recap>...</recap>` 之间的文本（首选）。
2. 仅有开标签（`maxOutputTokens` 截断 close 标签）：取开标签后的全部文本。
3. 标签缺失：返回空 → 服务整体返回 `null` → UI 不渲染。

第 3 级的策略是"宁可不显示也不显示错的"——展示模型 reasoning 的 preamble 会比"没有 recap"更糟。

### 调用参数

| 参数                | 值                             | 理由                              |
| ------------------- | ------------------------------ | --------------------------------- |
| `model`             | `getFastModel() ?? getModel()` | 摘要任务无需 frontier 模型        |
| `tools`             | `[]`                           | 一次性查询，禁止工具调用          |
| `maxOutputTokens`   | `300`                          | 1-3 句 + 标签足够，太大会鼓励冗长 |
| `temperature`       | `0.3`                          | 偏确定性，但保留少量自然变化      |
| `systemInstruction` | 上述 recap-only prompt         | 覆盖主 Agent 的角色定义           |

---

## History 过滤

`geminiClient.getChat().getHistory()` 返回的 `Content[]` 包含：

- `user` / `model` 的文本消息
- `model` 的 `functionCall` parts
- `user` 的 `functionResponse` parts（含工具返回的**文件全文**等大体积内容）
- `model` 的 thought parts（`part.thought` / `part.thoughtSignature`，模型隐藏推理）

`filterToDialog()` 只保留 `user`/`model` 消息中**有非空文本且非 thought**的 part：

- 工具调用/响应：单次 `functionResponse` 可能含 10K+ token，30 条这样的消息会把 recap LLM
  淹没在无关细节里，既费 token 又导致 recap 跑偏（容易输出 "调用了 X 工具读取了 Y 文件"
  这种实现细节）。
- thought parts：携带模型的内部推理。混进 recap 上下文会有把隐藏 chain-of-thought 当成
  对话内容、最终被概括到 recap 文本里 leak 出来的风险。

丢空消息后再做 30 条窗口截取（`takeRecentDialog`），并保证窗口起点不是悬空的 model 回复。

---

## 并发与边界情况

### 自动触发 hook 的状态机

`useAwaySummary` 维护三个 ref：

| Ref               | 含义                                |
| ----------------- | ----------------------------------- |
| `blurredAtRef`    | 失焦起始时间（焦点回归前不清）      |
| `recapPendingRef` | 是否有 LLM 调用在飞                 |
| `inFlightRef`     | 当前 in-flight 的 `AbortController` |

`useEffect` deps：`[enabled, config, isFocused, isIdle, addItem]`。

| 事件                                                  | 处理                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `!enabled \|\| !config`                               | abort 在飞调用 + 清 `inFlightRef` + 清 `blurredAtRef`                                  |
| `!isFocused` 且 `blurredAtRef === null`               | 设 `blurredAtRef = Date.now()`                                                         |
| `isFocused` 且 `blurredAtRef === null`                | 直接返回（没有失焦周期可处理；首次渲染或刚 reset 后会走这里）                          |
| `isFocused` 且 blur 时长 < 5 min                      | 清 `blurredAtRef`，等下个失焦周期                                                      |
| `isFocused` 且 blur 时长 ≥ 5 min 且 `recapPendingRef` | 直接返回（去重）                                                                       |
| `isFocused` 且 blur 时长 ≥ 5 min 且 `!isIdle`         | **保留** `blurredAtRef` 等 turn 结束（`isIdle` 在 deps 中，turn 完成时 effect 会重跑） |
| `isFocused` 且全部条件满足                            | 清 `blurredAtRef`、置 `recapPendingRef` 为 true、新建 `AbortController`、发 LLM 请求   |

`.then` 回调里**再次**检查 `isIdleRef.current`：如果在等 LLM 期间用户已经开始新 turn，
丢弃这次 recap，避免 recap 插入到 turn 中间。

`.finally` 清 `recapPendingRef`，并仅在 `inFlightRef.current === controller` 时清 `inFlightRef`
（避免覆盖其它 controller）。

组件卸载时第二个 `useEffect` 会 abort 在飞调用。

### `/recap` 的拦截

`CommandContext.ui.isIdleRef` 暴露当前流状态（mirror 已有的 `btwAbortControllerRef` 模式）。
`recapCommand` 在交互模式下，当 `!isIdleRef.current` **或** `pendingItem !== null` 时拒绝执行：
仅靠 `pendingItem` 不够，因为正常 model 回复期间 `streamingState === Responding` 但 `pendingItem` 为 null。

---

## 配置与模型选择

### 用户可控

| 设置                       | 默认   | 说明                                                    |
| -------------------------- | ------ | ------------------------------------------------------- |
| `general.showSessionRecap` | `true` | 自动触发开关。手动 `/recap` 不受其影响                  |
| `fastModel`                | 未设   | 推荐设置（如 `qwen3-coder-flash`），让 recap 快速且便宜 |

### 模型回退

`config.getFastModel() ?? config.getModel()`：

- 用户设了 `fastModel` 且当前 auth type 可用 → 用 `fastModel`
- 否则 → 退回主 session 模型（功能可用，但成本和延迟略高）

---

## 可观测性

通过 `createDebugLogger('SESSION_RECAP')` 输出：

- catch 块捕获的异常（`debugLogger.warn`）

所有失败对用户**完全透明**——recap 是辅助功能，不会向用户面前抛错。
开发者可在 debug 日志文件中按 `[SESSION_RECAP]` 标签检索：默认写入
`~/.qwen/debug/<sessionId>.txt`（`latest.txt` 软链指向当前会话），可通过
`QWEN_DEBUG_LOG_FILE=0` 关闭。

---

## 刻意未做的范围

| 项                                            | 不做的原因                                                                        |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `/recap` 进度指示 UI（spinner / pendingItem） | 3-5 秒等待可接受，加 UI 增加复杂度                                                |
| 自动化测试                                    | 服务实现较小（~150 行），先做端到端验证；后续单测可单独 PR 加                     |
| Prompt 国际化                                 | system prompt 是给模型看的，英文最稳定；模型按对话语言决定输出语言                |
| `QWEN_CODE_ENABLE_AWAY_SUMMARY` env var       | Claude Code 用它处理"telemetry 关闭时仍启用"；Qwen Code 当前 telemetry 模型不需要 |
| `/resume` 完成后自动 recap                    | 自然的下一步增强，但需要在 `useResumeCommand` 加 hook 点；当前 PR 范围之外        |
