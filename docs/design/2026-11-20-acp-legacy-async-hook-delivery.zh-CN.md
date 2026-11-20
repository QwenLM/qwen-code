# 在 ACP 默认 legacy 轮次交付后台（异步）hook 输出

[English](2026-11-20-acp-legacy-async-hook-delivery.md) | [简体中文](2026-11-20-acp-legacy-async-hook-delivery.zh-CN.md)

- **状态**：本改动提出。把能力台账 L11 行从 `differs` 推向 `have`：ACP 默认 legacy 轮次——最后一个仍丢弃待交付异步 hook 输出的模型轮入口——像 `LlmClient` 路径一样 drain 它。
- **日期**：2026-11-20，基于 `main` `e8cdbe441fad`。
- **相关**：[异步 hook 输出交付](2026-11-16-async-hook-output-delivery.zh-CN.md)（#17477，`LlmClient` 路径）；[异步 hook 上下文大小上限](2026-11-16-async-hook-output-delivery.zh-CN.md)（#17736）；follow-up 台账 #17284（「在 ACP 默认 legacy 轮次交付（R2-1）」项）；helper `hooks/async-hook-context.ts`。

## 缺陷

#17477 在 `LlmClient.sendMessageStream` 的请求组装处 drain 待交付异步 hook 输出，并作为 `<qwen:async-hook-context>` part 追加。这覆盖了模型轮经主 `LlmClient` 发送的所有入口——headless、各 TUI，以及**开启统一 agent loop 的 ACP**（共享轮的 source 就是主 `LlmClient`）。但 ACP **默认 legacy** 轮次经会话自有 chat 发送（`Session.ts` → `#sendMessageStreamWithAutoCompression` → `chat.sendMessageStream`），从不进入 `LlmClient.sendMessageStream`，因此其异步 hook 输出仍被 registry 收集后静默丢弃。台账该行是 `differs` 而非 `have`，正是因为这个入口。会话注释明确说 legacy 轮刻意不路由到 `LlmClient`。

## 决策

在 ACP legacy 发送 wrapper 里加同样的 drain/append 对，复用既有 helper——**不**把 legacy 轮路由到 `LlmClient`。

- **单一插入点**：`#sendMessageStreamWithAutoCompression` 是 ACP legacy 轮调用 `chat.sendMessageStream` 的唯一处（全文件仅一个调用点）。四类 legacy 调用方都汇聚到它：主 prompt 循环（`#executePromptInner`，UserQuery / Retry / Goal 首轮及 ToolResult / Steer 续轮）、stop-hook / todo-guard / background-result / mid-turn 续轮（`#runStopContinuation`）、Cron / loop tick（`#executeCronPromptInner`）、后台通知执行器（`#executeBackgroundNotificationPromptInner`）。每一类都只在 `isUnifiedAgentLoopEnabled('acp')` 为 false 时到达；unified 路径经 `runModelRound` / `runAgentLoop` 发送，其 source 是主 `LlmClient`（已 drain），从不经过本 wrapper。因此在此 drain 恰好覆盖且仅覆盖 legacy 发送，与 unified 路径无双重 drain。
- **wrapper 内的位置**：在 memory-recall 插入之后、紧邻 `const chat = this.#getCurrentChat()` / `chat.sendMessageStream` 之前。这个位置由两个事实强制确定。(1) stop 续轮的 `beforeSend`（及 `prepareBeforeCompression`）返回调用方闭包里的 `preparedMessage`，wrapper 会 `message = decision.message`——放在 `beforeSend` 之前的 drain 会被覆盖、静默「已消费未送达」。(2) 尾部回执检测必须看到最终消息形状，即在 COMPRESSED 的 `suppressedHookContext` 重追加与 memory 插入之后。放在这里还使所有发送前早退（abort、token-limit 丢弃、`beforeSend` stop）都发生在 drain 之前，被跳过的发送不消费块——比 `LlmClient` 路径的「已消费未送达」窗口更窄。剩余窗口仅为 `chat.sendMessageStream` 抛错或返回空流，与 helper 文档化的边界一致。
- **压缩阈值 parity**：wrapper 的发送前 `tryCompressChat` 只基于历史 token 计数、不接收外出消息，故 drain 相对它的位置不改变其输入。send 内部压缩（LlmChat hard-tier rescue / reactive overflow）发生在请求进入历史之后，因此紧贴 send 之前 drain 使该压缩看到的尾部与 provider 一致——镜像 `LlmClient`「在 send 及其自动压缩之前 drain」的意图。
- **回执保持末位**：外出消息可能以 UserPromptSubmit 上下文回执结尾，来源有两个互斥出处——调用方在首轮注入，或 wrapper 在 COMPRESSED 后重追加 `options.suppressedHookContext`。用 `isUserPromptSubmitContextPartText` 匹配实际末位 part 的 text 来检测（不是固定布尔，因为来源会变），并传给 `appendAsyncHookContextPart`，后者把异步 part 插到尾部回执之前。resume 重新盖章、转录投影剥离、session-title 剥离都只认末位的同步回执，故异步 part 不能尾随它。
- **无所有权门**：ACP 没有到达本 wrapper 的并发侧问。`/btw` 经独立 fork agent 自有的 `LlmChat`，rewriter 经 `runSideQuery` / `BaseLlmClient`；两者都不进入 wrapper 或主 `LlmClient.sendMessageStream`，故都不 drain registry。`LlmClient` 门的两个条件（`isConcurrentSideQuery`、已记录侧问 prompt id）在 ACP 都无对应物，因此这里 drain 无条件。
- **无轮次类型门**：镜像 `LlmClient` 路径（其对 Notification/Teammate 轮也 drain，`isSessionTurn` 只是 ledger 成员资格、不是 drain 闸），后台通知执行器也 drain。opt-out 会是相对 core 的有意偏离，不采用。
- **仅进程内、无持久化泄漏**：用户/cron/notification 的转录记录在 wrapper 运行前用原始输入写就；wrapper 的 `message` 是局部变量，失败保留路径用的是调用方 drain 前的 parts。`LlmChat` 不写 recording service。因此异步 part 只进入进程内 chat 历史——不持久化、resume 的会话不携带它，与 `LlmClient` 路径完全一致。异步标签的 resume 溯源仍是 #17284 的独立 follow-up。

## 范围

- **在内**：ACP legacy 发送 wrapper 里的 drain/append（复用 `drainAsyncHookContextPart` / `appendAsyncHookContextPart` / `isUserPromptSubmitContextPartText`）、`Session.test.ts` 的调用点单测见证、本设计文档。线上顺序分类器已识别该信封（#17477）、大小上限已约束它（#17736）；两者对 ACP 交付的块原样生效。
- **在外（follow-up，#17284）**：异步标签的显示投影与 resume 溯源；「已消费未送达」的轮次绑定；更宽的溯源 / authority-epoch 契约。本改动不把 legacy 轮路由到 `LlmClient`，也不改 unified 路径。

## 验证

`Session.test.ts` 的调用点见证用 registry 支撑的 `getHookSystem` 驱动真实 wrapper：已完成异步 hook 的输出作为 `<qwen:async-hook-context>` part 交付进外出 `chat.sendMessageStream` 请求；第二次 send 不 drain 任何东西（取走即清空）；无待交付输出时不交付；尾部 UserPromptSubmit 回执仍是最后 part、异步 part 紧随其前；无回执的消息直接追加。变异见证：去掉 drain 使交付用例转红；把尾部回执检测强制为固定 `false` 使共现用例转红。一次真实环境 ACP 运行（配置 `async: true` 的 PostToolUse hook）确认 legacy 轮上该块到达 provider 请求。改动文件 `prettier`/`eslint` 干净；改动文件通过类型检查（以 CI 的 frozen-lockfile 构建为权威）。
