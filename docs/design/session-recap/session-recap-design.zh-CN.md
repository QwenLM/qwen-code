# 会话回顾（Session Recap）设计

[English](session-recap-design.md) | [简体中文](session-recap-design.zh-CN.md)

> 一段简短（1-2 句）的「上次进行到哪里」摘要，在用户回到空闲会话时呈现——
> 或按需触发（`/recap`），或在终端失焦 5 分钟以上后重新聚焦时触发。

## 概述

当用户隔了几天 `/resume` 一个旧会话时，翻好几页历史才能想起**自己当时在做什么、
接下来要做什么**，是真实的摩擦点。单纯重新加载消息并不能解决这个 UX 问题。

目标是主动呈现一段 1-2 句的简短回顾：

- **高层任务**（正在做什么）→ **下一步**（接下来做什么）。
- 视觉上与真实的助手回复区分开，绝不会被误认为新的模型输出。
- **尽力而为**：失败必须静默，绝不打断主流程。

## 触发方式

| 触发方式        | 条件                                                                | 实现                                                                                                                                        |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **手动**        | 用户运行 `/recap`                                                   | `recapCommand.ts` 调用同一底层服务                                                                                                          |
| **自动**        | 终端失焦（DECSET 1004 焦点协议）≥ 5 分钟 + 重新聚焦 + 流处于 `Idle` | `useAwaySummary.ts` — 5 分钟失焦计时器 + `useFocus` 事件监听                                                                                |
| **Daemon HTTP** | 远程客户端调用 `POST /session/:id/recap`                            | `server.ts` 路由 → `bridge.generateSessionRecap`（ext-method 往返）→ `acpAgent.ts` 调用 `generateSessionRecap(session.getConfig(), signal)` |

三条路径都汇入 `core/services/sessionRecap.ts` 中同一个
`generateSessionRecap()` 函数，以保证行为一致。自动触发由
`general.showSessionRecap` 门控（默认关闭——需显式加入，绝不会在用户不知情的
情况下悄悄增加环境性 LLM 调用）；手动命令与 daemon HTTP 路由忽略该设置
（调用本身就是显式请求）。

### Daemon 访问路径

daemon 路由不做严格门控（与 `/session/:id/prompt` 的姿态一致——回顾消耗
token 但不改任何状态）。能力标签 `session_recap` 在 `/capabilities.features`
上通告该路由。SDK 辅助方法：`DaemonClient.recapSession(sessionId, opts)` 与
`DaemonSessionClient.recap(opts)`。线上契约与错误信封见
`docs/developers/qwen-serve-protocol.md` 的 `POST /session/:id/recap` 一节。

v1 **没有**取消机制。该路由不监听 HTTP 客户端断开，没有把 `AbortSignal`
传入 `bridge.generateSessionRecap`，ACP 子进程处理器也把一个永不中止的
`AbortController().signal` 传给核心辅助函数（尚无跨进程中止管道）。唯一的
上限是 bridge 60 秒的 `SESSION_RECAP_TIMEOUT_MS` 兜底与 ACP 通道关闭的
竞态。单独加一个 HTTP 侧的 AbortController 只是表面功夫——子进程侧的
LLM 调用仍会跑完，所以没有跨进程中止这一环就做不到端到端取消。v1 可以
接受，因为回顾很短（单次尝试的旁路查询，`maxOutputTokens: 300`，典型
1–5 秒）。未来若带宽成本值得，可以加一个基于 request-id 的取消
ext-method 来打通端到端取消。

## 架构

```
┌────────────────────────────────────────────────────────────────────────┐
│                          AppContainer.tsx                              │
│   isFocused = useFocus()                                               │
│   isIdle = streamingState === Idle                                     │
│       │                                                                │
│       ├─→ useAwaySummary({enabled, config, isFocused, isIdle,          │
│       │       │             addItem})                                  │
│       │       └─→ 5 min blur timer + idle/dedupe gates                 │
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
│                              (fastModel + tools:[])                    │
│                                                                        │
│   addItem({type: 'away_recap', text}) ─→ HistoryItemDisplay            │
│       └─ AwayRecapMessage rendered inline like any other history       │
│         item (※ + bold "recap: " + italic content, all dim);           │
│         scrolls naturally with the conversation. Mirrors Claude        │
│         Code's away_summary system message.                            │
└────────────────────────────────────────────────────────────────────────┘
```

### 文件

| 文件                                                         | 职责                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `packages/core/src/services/sessionRecap.ts`                 | 一次性 LLM 调用 + 历史过滤 + 标签提取                                        |
| `packages/cli/src/ui/hooks/useAwaySummary.ts`                | 自动触发 React hook                                                          |
| `packages/cli/src/ui/commands/recapCommand.ts`               | `/recap` 手动入口                                                            |
| `packages/cli/src/ui/components/messages/StatusMessages.tsx` | `AwayRecapMessage` 渲染器（`※` + 粗体 `recap:` + 斜体内容，全部暗色）        |
| `packages/cli/src/ui/types.ts`                               | `HistoryItemAwayRecap` 类型                                                  |
| `packages/cli/src/ui/components/HistoryItemDisplay.tsx`      | 把 `away_recap` 历史条目分发给渲染器                                         |
| `packages/cli/src/config/settingsSchema.ts`                  | `general.showSessionRecap` + `general.sessionRecapAwayThresholdMinutes` 设置 |

## 提示词设计

### 系统提示词

`generationConfig.systemInstruction` 在这一次调用中替换主 agent 的系统
提示词，让模型只作为回顾生成器而非编码助手。

注意 `GeminiClient.generateContent()` 内部会把提示词先经过
`getCustomSystemPrompt()`，它会追加用户的记忆（QWEN.md / 托管自动记忆）
作为后缀。最终系统提示词是「回顾提示词 + 用户记忆」——为回顾提供有用的
项目上下文，而不是泄漏。

以下要点与 `RECAP_SYSTEM_PROMPT` 一一对应：

- 40 个英文单词以内，1-2 个平实句子（不用 markdown / 列表 / 标题）。中文按总共约 80 字掌握。
- 第一句：高层任务。接着：具体的下一步。
- 明确禁止：罗列做过的事、复述工具调用、状态汇报。
- 匹配会话的主导语言（英文或中文）。
- 输出包裹在 `<recap>...</recap>` 中；标签之外不能有任何内容。

### 结构化输出 + 提取

模型被要求把答案包裹在 `<recap>...</recap>` 中：

```
<recap>Refactoring loopDetectionService.ts to address long-session OOM. Next step is to implement option B.</recap>
```

原因：一些模型（GLM 系列、推理模型）会在最终答案前写一段「思考」。直接
返回原文会把那段推理泄漏到 UI 里。

`extractRecap()` 有三级回退：

1. 两个标签都在：取 `<recap>...</recap>` 之间的内容（首选）。
2. 只有开标签（如 `maxOutputTokens` 截掉了闭标签）：取开标签之后的全部内容。
3. 标签完全缺失：返回空字符串 → 服务返回 `null` → UI 不渲染任何东西。

第三级是「宁可不显示也不显示错误内容」——把模型的推理前言暴露出来比
没有回顾更糟。

### 调用参数

| 参数                | 值                             | 原因                     |
| ------------------- | ------------------------------ | ------------------------ |
| `model`             | `getFastModel() ?? getModel()` | 回顾不需要旗舰模型       |
| `tools`             | `[]`                           | 一次性查询，不用工具     |
| `maxOutputTokens`   | `300`                          | 1-2 个短句 + 标签的余量  |
| `temperature`       | `0.3`                          | 基本确定，带一点自然变化 |
| `systemInstruction` | 上面的回顾专用提示词           | 替换主 agent 的角色定义  |

## 历史过滤

`geminiClient.getChat().getHistory()` 返回的 `Content[]` 包含：

- `user` / `model` 文本消息
- `model` `functionCall` part
- `user` `functionResponse` part（可能装着整个文件内容）
- `model` 思考 part（`part.thought` / `part.thoughtSignature`，模型的隐藏推理）

`filterToDialog()` 只保留**文本非空且不是思考**的 `user` / `model` part。
两个原因：

- **工具调用 / 响应**：一条 `functionResponse` 可以超过 1 万 token。30 条
  这样的消息会把回顾 LLM 淹没在无关细节里，既浪费 token，又把回顾带偏成
  「调了 X 工具读 Y 文件」这类实现噪音。
- **思考 part**：携带模型的内部推理。包含它们有把隐藏思维链当对话处理、
  进而泄入回顾文本的风险。

丢弃空消息之后，`takeRecentDialog` 切到最后 30 条消息，并拒绝把切片起点
放在悬空的 model / 工具响应上。

## 并发与边界情况

### 自动触发 hook 状态机（终端宿主）

`useAwaySummary` 维护三个 ref：

| Ref               | 含义                             |
| ----------------- | -------------------------------- |
| `blurredAtRef`    | 失焦开始时间（重新聚焦前不清除） |
| `recapPendingRef` | 是否有 LLM 调用在途              |
| `inFlightRef`     | 当前在途的 `AbortController`     |

`useEffect` 依赖：`[enabled, config, isFocused, isIdle, addItem, thresholdMs]`。

| 事件                                                       | 动作                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `!enabled \|\| !config`                                    | 中止在途调用 + 清空 `inFlightRef` + 清空 `blurredAtRef`                                         |
| `!isFocused` 且 `blurredAtRef === null`                    | 置 `blurredAtRef = Date.now()`                                                                  |
| `isFocused` 且 `blurredAtRef === null`                     | 提前返回（没有失焦周期可处理——首次渲染或短暂失焦重置之后）                                      |
| `isFocused` 且失焦时长 < 5 min                             | 清空 `blurredAtRef`，等待下一个失焦周期                                                         |
| `isFocused` 且失焦 ≥ 5 min 且 `recapPendingRef`            | 返回（去重）                                                                                    |
| `isFocused` 且失焦 ≥ 5 min 且 `!isIdle`                    | **保留** `blurredAtRef` 并等待本轮结束（`isIdle` 在依赖里，流式结束后 effect 会重新执行）       |
| `isFocused` 且失焦 ≥ 5 min 且 `shouldFireRecap` 返回 false | 清空 `blurredAtRef` 并返回——自上次回顾以来对话推进不足（至少 2 个新用户回合，对齐 Claude Code） |
| `isFocused` 且条件全部满足                                 | 清空 `blurredAtRef`，置 `recapPendingRef = true`，创建 `AbortController`，发送 LLM 请求         |

`.then` 回调会**复查** `isIdleRef.current`：如果 LLM 运行期间用户开始了
新一轮，迟到的回顾会被丢弃，避免插进回合中间。

`.finally` 清除 `recapPendingRef`，并且只有当
`inFlightRef.current === controller` 时才清空 `inFlightRef`
（避免覆盖更新的 controller）。

第二个 `useEffect` 在卸载时中止在途的 controller。

### Web Shell 宿主

Web Shell（`packages/web-shell/client/App.tsx`）基于
`document.visibilitychange` 自行实现自动触发，而不是复用
`useAwaySummary`；上面的表格只描述终端宿主。三种行为是刻意的分歧：

- 离开触发是标签页被隐藏，而不是终端失焦。
- 落在回合中间的返回**直接丢弃，不做延后**——处理器在流式检查之前就清空
  `hiddenAtRef`，回合结束后不会重新触发。
- 触发门槛不同：终端要求至少 3 条用户消息、且自上次回顾以来至少 2 条新的
  （`useAwaySummary.ts` 的 `MIN_USER_MESSAGES_TO_FIRE` /
  `MIN_USER_MESSAGES_SINCE_LAST_RECAP`），而 Web Shell 只要求任意类型的
  新增 transcript block 至少 4 个（`App.tsx` 的 `MIN_NEW_BLOCKS`）。

### `/recap` 门控

`CommandContext.ui.isIdleRef` 暴露当前流状态（沿用已有的
`btwAbortControllerRef` 模式）。交互模式下，`recapCommand` 在
`!isIdleRef.current` **或** `pendingItem !== null` 时拒绝执行。只有
`pendingItem` 并不够，因为普通的模型回复在
`streamingState === Responding` 时 `pendingItem` 为 null。

## 配置与模型选择

### 用户可见的开关

| 设置                                       | 默认值  | 说明                                                         |
| ------------------------------------------ | ------- | ------------------------------------------------------------ |
| `general.showSessionRecap`                 | `false` | 仅约束自动触发。手动 `/recap` 忽略它。                       |
| `general.sessionRecapAwayThresholdMinutes` | `5`     | 自动回顾触发的失焦分钟数。与 Claude Code 的默认一致。        |
| `fastModel`                                | 未设置  | 建议配置（如 `qwen3-coder-flash`）以获得快速、低成本的回顾。 |

### 模型回退

`config.getFastModel() ?? config.getModel()`：

- 用户设置了 `fastModel` 且对当前 auth type 有效
  → 使用 `fastModel`。
- 否则 → 回退到主会话模型（可用，只是更贵更慢）。

## 可观测性

`createDebugLogger('SESSION_RECAP')` 输出：

- 回顾路径捕获到的异常（`debugLogger.warn`）。

所有失败对用户**完全透明**——回顾是辅助功能，绝不会向 UI 抛错。开发者可以
在调试日志文件里 grep `[SESSION_RECAP]` 标签：默认写入
`~/.qwen/debug/<sessionId>.txt`（`latest.txt` 软链到当前会话）；用
`QWEN_DEBUG_LOG_FILE=0` 关闭。

## 范围之外

| 项                                          | 原因                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `/recap` 的进度 UI（spinner / pendingItem） | 3-5 秒的等待可以忍受；增加复杂度。                                         |
| 自动化测试                                  | 服务很小（约 150 行），先手工做端到端验证；单元测试可以另开 PR。           |
| 提示词本地化                                | 系统提示词是给模型的；英文是最可靠载体。模型会根据会话选择输出语言。       |
| `QWEN_CODE_ENABLE_AWAY_SUMMARY` 环境变量    | Claude Code 用它在遥测关闭时保留该功能；Qwen Code 目前的遥测模型不需要。   |
| `/resume` 完成后自动回顾                    | 自然的后续项，但需要在 `useResumeCommand` 里加 hook 点；不在本 PR 范围内。 |
