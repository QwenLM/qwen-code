# 把后台（异步）hook 输出交付给模型

[English](2026-11-16-async-hook-output-delivery.md) | [简体中文](2026-11-16-async-hook-output-delivery.zh-CN.md)

- **状态**：本改动已实现。关闭能力台账 L11 行，该行作为缺陷由 follow-up #17284 承载。
- **日期**：2026-11-16，基于 `main` `27681123f719`。
- **相关**：[agent loop 能力台账](2026-11-15-loop-capability-ledger.zh-CN.md)（L11）；[统一 agent loop](2026-10-23-unified-agent-loop.zh-CN.md)；follow-up #17284；同步对应物 `hooks/user-prompt-submit-context.ts`。

## 缺陷

后台（异步）hook 在轮次之间运行。某个完成时，`AsyncHookRegistry.complete` 解析其 stdout，把面向模型的上下文（`hookSpecificOutput.additionalContext`）与通知消息（`systemMessage`、纯 stdout、stderr）累积进 `completedContexts` / `completedOutputs`。`HookSystem.getPendingAsyncOutput()` 把两者 drain（取走即清空），其注释说输出「用于交付给下一轮」——但**没有任何调用方**：在 `main` 上，测试之外 `getPendingAsyncOutput` 的唯一出现就是它自己的定义（`hooks/hookSystem.ts:996`）。输出被收集后静默丢弃，从不送达模型。1.0 loop 在其请求准备中 drain 等价的待交付异步上下文（`event-bus/llm/request-preparation.ts:748-760`），并在压缩前作为 meta user message 注入。

## 决策

在组装外出请求时 drain 待交付的异步输出，并作为一个带标签的上下文 part 追加，使其在下一轮请求送达模型。

- **交付点**：`LlmClient.sendMessageStream` 的 `requestToSend` 组装处——在 UserPromptSubmit hook 上下文回执之后、IDE 上下文合并与 system-reminders 前置之前。它位于 Goal 准入与 hook 窗口结算块之下游（不触碰它们的任何契约），并在 send 及其 chat 内自动压缩之上游，因此压缩阈值看到的尾部与 provider 将看到的一致——契合 1.0「压缩前 drain」的意图。它覆盖到达该组装处的每种轮次类型。
- **交付内容**：`contexts`（逐字 additional context）与 `messages`（标注为 `[type] hookName: message`）都交付，合并为一个块。`<`/`>` 被转义，使 hook 输出无法伪造闭合标签，镜像同步 UserPromptSubmit 上下文。
- **保留标签**：`<qwen:async-hook-context>…</qwen:async-hook-context>`，定义在新的自包含模块 `hooks/async-hook-context.ts`。
- **取走即清空，无需去重**：drain 会清空 registry，故一个块恰好交付一次。同步 UserPromptSubmit 上下文持久存在于历史，因此需要回执 symbol、历史去重与 resume 重新盖章；异步块不需要那套机制——它被 drain 一次，随后作为普通已交付上下文 part 存在于历史。

## 范围

- **在内**：待交付异步 hook 输出面向模型的交付（L11）：drain、格式化/包裹 helper、请求组装处的单一调用点、带变异见证的单测。
- **在外（follow-up）**：异步标签的显示投影与 resume 溯源。同步上下文会从用户可见的转录投影中隐藏、并在 resume 时经其回执重新盖章；异步块作为带标签 part 交付，但尚未接入 `projectUserTranscriptForDisplay`，因此目前按面向模型的文本投影。把它隐藏并赋予 resume 溯源，是与「输出送达模型」不同的另一关注点，留给 follow-up。

## 验证

`hooks/async-hook-context.test.ts` 驱动真实 `AsyncHookRegistry`：已完成 hook 的 `additionalContext` 与 `systemMessage` 在带标签 part 中交付，第二次 drain 不交付任何东西（取走即清空），空白输出不产生 part，且 hook 输出无法伪造闭合标签。变异见证：使 drain 不交付任何东西，恰使三条交付用例转红（6 绿）；去掉转义，恰使两条转义用例转红（7 绿）；两个变异均按字节还原。改动文件 `prettier`/`eslint` 干净；改动文件通过类型检查（以 CI 的 frozen-lockfile 构建为权威）。
