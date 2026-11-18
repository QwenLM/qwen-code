# 把后台（异步）hook 输出交付给模型

[English](2026-11-16-async-hook-output-delivery.md) | [简体中文](2026-11-16-async-hook-output-delivery.zh-CN.md)

- **状态**：本改动已在 `LlmClient` 请求路径上实现。把能力台账 L11 行从 `missing` 移到 `differs`：模型轮经 `LlmClient.sendMessageStream` 发送的入口，输出能送达模型；ACP 默认 legacy 轮次经会话自有 chat 发送、尚未 drain，故该入口的交付是 follow-up，由 #17284 承载。
- **日期**：2026-11-16，基于 `main` `27681123f719`。
- **相关**：[agent loop 能力台账](2026-11-15-loop-capability-ledger.zh-CN.md)（L11）；[统一 agent loop](2026-10-23-unified-agent-loop.zh-CN.md)；follow-up #17284；同步对应物 `hooks/user-prompt-submit-context.ts`。

## 缺陷

后台（异步）hook 在轮次之间运行。某个完成时，`AsyncHookRegistry.complete` 解析其 stdout，把面向模型的上下文（`hookSpecificOutput.additionalContext`）与通知消息（`systemMessage`、纯 stdout、stderr）累积进 `completedContexts` / `completedOutputs`。`HookSystem.getPendingAsyncOutput()` 把两者 drain（取走即清空），其注释说输出「用于交付给下一轮」——但**没有任何调用方**：在 `main` 上，测试之外 `getPendingAsyncOutput` 的唯一出现就是它自己的定义（`hooks/hookSystem.ts:996`）。输出被收集后静默丢弃，从不送达模型。1.0 loop 在其请求准备中 drain 等价的待交付异步上下文（`event-bus/llm/request-preparation.ts:748-760`），并在压缩前作为 meta user message 注入。

## 决策

在组装外出请求时 drain 待交付的异步输出，并作为一个带标签的上下文 part 追加，使其在下一轮请求送达模型。

- **交付点**：`LlmClient.sendMessageStream` 的 `requestToSend` 组装处——在 UserPromptSubmit hook 上下文回执之后、IDE 上下文合并与 system-reminders 前置之前。它位于 Goal 准入与 hook 窗口结算块之下游（不触碰它们的任何契约），并在 send 及其 chat 内自动压缩之上游，因此压缩阈值看到的尾部与 provider 将看到的一致——契合 1.0「压缩前 drain」的意图。它覆盖到达该组装处的每种轮次类型。模型轮即主会话 `LlmClient` 的入口能到达它——headless 与 Ink（含它们的统一循环默认开启态，此时共享轮的 source 就是 `LlmClient`），以及 opting-in 统一循环的 ACP；ACP 默认 legacy 轮次经会话自有 chat 发送（`Session.ts` → `chat.sendMessageStream`），从不进入本方法，故其异步输出在那里仍被丢弃——这是 follow-up，而非相对基线的回归（基线在任何入口都不交付）。`getHookSystem` 以防御方式读取（`getHookSystem?.()`，helper 内 `getPendingAsyncOutput?.()`），因此缺少该方法的 config 或 hook-system 替身降级为「无可交付」而非抛错。
- **放置保持同步回执末位**：当 UserPromptSubmit 上下文回执是末位 part 时，异步 part 被插到它*之前*（`appendAsyncHookContextPart`），而非追加到它之后。回执契约的 resume 半侧（`restoreUserPromptSubmitContextReceipt`）、遗留转录投影剥离与 session-title 剥离都只在末位识别同步块；异步 part 尾随它会在共现轮次（同一请求里同步上下文 + 异步输出）静默破坏它们，丢失同步块的 resume 溯源并在 resume 后二次注入其上下文。无末位同步回执时异步 part 直接追加。
- **线上顺序保持指令末位**：异步信封已登记到注入上下文分类器——`isAsyncHookContextPartText`（紧邻 `hooks/async-hook-context.ts` 的标签常量）被 OR 进 `isInjectedPromptContext`（`core/prompt-context-order.ts`），因此 `movePromptContextAheadOfUserText` 在线上副本里把该块前移到用户指令之前，与其他注入块一致。否则裸标签会被当作调用方自有文本，线条目将以 hook 输出结尾。只重排线上副本；splice 所依赖的存储历史放置不受影响。
- **所有权门控 drain**：并发 `/btw` 侧问经同一 client 运行，不得消费正在运行那一轮的待交付块。其首发带 `isConcurrentSideQuery`，但其工具结果续传**不带标志**到达，故仅按标志的门仍会放行该续传成为消费者。因此 client 记录每个带标志侧问首发的 prompt id（`concurrentSideQueryPromptIds`），drain 在 `isConcurrentSideQuery === true` 或该 send 是 prompt id 属于已记录侧问 id 的 `ToolResult` 时跳过。其余所有 `ToolResult` 都 drain：归属轮的续传，以及以全新 prompt id 首发 `ToolResult` 的中断续跑轮（`continue_last_turn`）。探索预算 prompt id（`ownsExplorationBudget`）刻意**不**作判别依据：它只在 `startsInteraction` 时认领，故 `ToolResult` 首发的轮次——无论预算 id 未被认领（全新 client）还是来自被中断轮的陈旧值——都会被拒绝并静默丢块，重新引入本改动要修复的那类静默丢失。已记录的侧问 id 是唯一能把侧问续传与合法 `ToolResult` 首发轮区分开的信号。该记录保留至 client 生命周期结束：仍在等待续传的侧问即使在新主轮开始之后也必须保持被拒（若在新主轮处清空，迟到的续传就会 drain 走新主轮的块）；prompt id 逐轮唯一，故已记录的 id 不会被合法复用。这是刻意收窄的：它不是 Cron、ACP、后台会话或重绑定的通用 hook/epoch 权威模型，那些仍是 follow-up。
- **交付内容**：`contexts`（逐字 additional context）与 `messages`（标注为 `[type] hookName: message`）都交付，合并为一个块。`<`/`>` 被转义，使 hook 输出无法伪造闭合标签，镜像同步 UserPromptSubmit 上下文。
- **保留标签**：`<qwen:async-hook-context>…</qwen:async-hook-context>`，定义在新的自包含模块 `hooks/async-hook-context.ts`。
- **取走即清空，无需去重**：drain 会清空 registry，故一个块被*选中交付*一次。同步 UserPromptSubmit 上下文持久存在于历史，因此需要回执 symbol、历史去重与 resume 重新盖章；异步块不需要那套机制。两个边界是刻意的：(1)「选中一次」不等于「被模型轮次接纳」——drain 之后失败的 send（loop detection、goal 中断、429/retry）会消费该块却不交付，即「已消费未送达」窗口；把 drain 紧贴 send 之前可最小化它而不改变证据类别。(2) 该块只追加到**进程内请求历史**：转录记录由追加前的 `request` 构建，故该块不被持久化，resume 的会话（`--continue`）不携带它。异步标签的 resume 溯源是已记录的 follow-up，而非相对基线（基线根本不交付）的回归。

## 范围

- **在内**：待交付异步 hook 输出面向模型的交付（L11），在 `LlmClient` 请求路径上：drain、格式化/包裹 helper、请求组装处的单一调用点、线上顺序分类器登记、带变异见证的单测。
- **在外（follow-up）**：(1) ACP 默认 legacy 轮次自有的组装处——它经会话 chat 而非 `LlmClient` 发送，故需同样的 drain/append 对（复用 helper）才能在那里交付；(2) 异步标签的显示投影与 resume 溯源。同步上下文会从用户可见的转录投影中隐藏、并在 resume 时经其回执重新盖章；异步块作为带标签 part 交付，但尚未接入 `projectUserTranscriptForDisplay`，因此目前按面向模型的文本投影。把它隐藏并赋予 resume 溯源，是与「输出送达模型」不同的另一关注点，留给 follow-up。

## 验证

`hooks/async-hook-context.test.ts` 驱动真实 `AsyncHookRegistry`：已完成 hook 的 `additionalContext` 与 `systemMessage` 在带标签 part 中交付，第二次 drain 不交付任何东西（取走即清空），空白上下文与纯空白消息不产生 part，缺少 drain 方法的 hook-system 替身降级为 null，且 hook 输出无法伪造闭合标签。`appendAsyncHookContextPart` 测试了「插到末位回执之前」的放置；共现测试 resume 一个克隆条目（symbol 被丢弃），断言异步 part 插在同步块之前时 `restoreUserPromptSubmitContextReceipt` 重新盖章同步块——而异步 part 尾随它时则不会（即放置所避免的 bug）。`client.test.ts` 新增调用点见证：一个真实 `sendMessageStream` 轮次配合 registry 支撑的 `getHookSystem`，把该块交付进外出请求、跨两轮只 drain 一次、无待交付输出时不交付；一个携带 `promptContext` 的共现 UserQuery 轮次断言同步回执仍是 `turn.run` 收到的最后 part、异步块紧随其前；一个 ToolResult 轮次断言该块追加在 `functionResponse` parts 之后、且这些 parts 原样保留。另有调用点用例钉住其余边界：持久化用户记录不含异步块而线上请求含之（仅进程内）；`/btw` 侧问——其带标志首发与不带标志的非归属 `ToolResult` 续传——都把块留给归属轮，归属轮恰收一次；中断续跑的 `ToolResult` 首发轮在其 prompt id 从未被认领（全新 client）与先前轮留下陈旧已认领预算 id 两种情形下都交付该块；侧问续传在新主轮开始之后——或主轮同 id 重试之后——到达仍被拒，而新主轮自身的续传收到该块。这些调用点断言用 `isAsyncHookContextPartText`（与被测代码同一谓词）匹配信封。`prompt-context-order.test.ts` 断言线上重排把尾随异步块（及异步 + 同步序列）前移到调用方文本之前；`isAsyncHookContextPartText` 单测覆盖信封识别、空白容忍与内部标签拒绝。变异见证（均按字节还原）：使 drain 不交付任何东西使交付用例转红；去转义使转义用例转红；去掉消息空白守卫使空白用例转红；把 splice 塌缩为纯追加使放置与共现用例转红；删除 `client.ts` 调用点使调用点交付用例转红；从 `isInjectedPromptContext` 去掉异步 matcher 使两条线上顺序前移用例转红；把 `syncReceiptTrailing` 强制为 `false` 使共现调用点用例转红；ToolResult 轮次跳过 drain 使 ToolResult 用例转红；去掉已记录侧问 id 检查（仅标志门）使 `/btw` 侧问用例转红；把门回退为探索预算所有权拒绝使两条续跑交付用例转红；新主轮开始时清空记录使迟到侧问续传用例转红；无条件清空使两条迟到续传用例转红；把 drain 落入被记录的 `request` 使落盘记录用例转红。一次真实环境运行——从源码跑 headless CLI 指向 mock OpenAI server、并在 settings 配置 `async: true` 的 PostToolUse hook——验证了完整管线：hook 的 `additionalContext` 被 drain，并在 hook 完成后的轮次以 `<qwen:async-hook-context>` 块出现在外出的 provider 请求体中。改动文件 `prettier`/`eslint` 干净；改动文件通过类型检查（以 CI 的 frozen-lockfile 构建为权威）。
