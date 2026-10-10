# `ask_user_question` 的 ACP 结构化问题投影

[English](2026-10-10-acp-structured-question-projection.md) | [简体中文](2026-10-10-acp-structured-question-projection.zh-CN.md)

## 状态

已实现。解决 [#11361](https://github.com/QwenLM/qwen-code/issues/11361)。
取代 `docs/design/2026-07-25-channel-interaction-presentation-contract.md`
中 ACP 层面的非目标。

## 问题

`ask_user_question` 被投影到 ACP 的 `session/request_permission`，表现为一个通用的
双按钮审批。真正的逐题选项只通过 Qwen 专有的 `_meta.qwenQuestions` 键传递，而 ACP
要求符合规范的客户端忽略自己不理解的 `_meta` 值。因此，Zed 这类标准客户端只能看到
`title`、`kind: 'think'` 和原始 JSON `rawInput`，这正是 #11361 报告的
"Raw Input" 卡片。

这一缺口并非只是外观问题。答案是从 `outcome` 的同级顶层 `answers` 字段读回的，但
ACP 的 `RequestPermissionResponse` 只定义了 `outcome`
（`cancelled` | `selected{optionId}`）和 `_meta`。符合规范的客户端不会发送
`answers`，因此点击 "Submit" 会得到 `userAnswers = {}`，工具随即落到
`"No valid answers were provided."`。也就是说，任何不实现 Qwen 私有契约的 ACP
宿主都无法回答结构化问题。

## 目标

1. 对常见形态（单题、2–4 个选项），符合规范的 ACP 客户端能够渲染可选择的选项并
   返回有效答案。
2. 消费 `_meta.qwenQuestions` 和私有 `answers` 字段的 Qwen 自有界面（VS Code
   伴侣、Web Shell、飞书/钉钉卡片、daemon bridge、channel loop）不出现回退。
3. 答案可从标准 ACP 响应通道恢复，而非只能来自 Qwen 专有字段。
4. Core 的 `ask_user_question` schema（`Question`、`QuestionOption`、
   `multiSelect`）保持不变。

## 非目标

- 不修改 Core 的问题 schema 或面向模型工具契约。
- 不新增 ACP JSON-RPC 方法，也不修改 ACP 规范本身。
- 不捕获超出 `PermissionOption` 承载能力的自由文本 "Other" 输入。
- 不重新设计 daemon 的带外答案回注。

## 设计

四项协同改动。

### 1. 始终把问题文本投影进 `toolCall.content`

`buildPermissionRequestContent` 新增 `ask_user_question` 分支，为每个问题输出一个
`text` 块：`header`、完整的 `question`，以及每个选项的 `label` + `description`。
这是纯增量改动，也是选项层无法表达时的正确回退。任何客户端——包括 Zed——都会渲染
可读的问题，而不是原始 JSON。它本身并不能让用户选择选项。

### 2. 由能力协商门控的选项扁平化

对于**不**声明支持 Qwen 结构化问题的客户端，`toPermissionOptions` 输出真正的逐选项
`PermissionOption`，而不再是 `Submit`/`Cancel`：

- **单题。** 每个选项一个 `PermissionOption`，`name` = `option.label`，
  `kind: 'allow_once'`。追加一个合成的 `Other…` 选项（`kind: 'allow_once'`），
  并保留 `Cancel`（`kind: 'reject_once'`）。
- **`optionId` 编码。** 每个选项携带一个不透明 id，编码问题下标与选项下标，例如
  `ask:q0:o2`；合成选项为 `ask:q0:other`。标签可从请求中恢复，因此 id 只需是
  稳定 token。
- **多题（2–4 个）。** ACP 没有多表单原语，把不同问题的选项交错放进一次选择会产生
  歧义。因此多题请求保留通用的 `Submit`/`Cancel`，依赖内容投影加 `_meta`——这是
  在顺序请求形态得到验证之前的一处已记录限制。
- **`multiSelect: true`。** ACP 是单选。单个多选问题降级为在选项集上加 `Other…` 的
  单选，并记录该限制。

对于**声明**支持 Qwen 结构化问题的客户端，保留丰富路径：
`_meta.qwenInteractionKind = 'user_question'` + `_meta.qwenQuestions`，私有
`answers` 响应字段继续可用。

### 3. 能力协商

agent 读取客户端 `initialize` 能力上的厂商 `_meta` 键
`clientCapabilities._meta['qwen.askUserQuestion'] === true`，与既有的
`qwen.goalProposals` 标志保持一致。该标志存于按会话创建的 `Config`
（`setAskUserQuestionHostSupported` / `getAskUserQuestionHostSupported`），
供会话层读取。缺失即表示"扁平化"。

仓库内的 Qwen 界面在 `initialize` 时声明该键：daemon/channel bridge 握手、VS Code
伴侣、channel-loop ACP bridge、Qwen Live 语音客户端。Qwen Live 声明该键并非因为
它渲染富载荷，而是因为它的投票只有 allow/cancel，且取升级最小的 proceed 选项——
逐选项扁平化会静默记录第一个选项，因此它保留通用按钮对。

### 4. 答案恢复

`resolvePermissionOutcome` 目前会拒绝任何不属于 `ToolConfirmationOutcome` 的
`optionId`。扁平化后的 `ask:q0:o2` 虽然已在提供的选项集合中，却不是
`ToolConfirmationOutcome`，因此无法通过该校验。设计引入 `ask_user_question` 专用
路径：

1. 仅针对**已提供的选项集合**校验所选 id。
2. 对 `ask_user_question` 确认，凡是可解析为
   `ask:q<questionIndex>:<choiceToken>` 的 id 都解析为 `ProceedOnce`。
3. `resolveAskUserQuestionAnswers` 把 id 解析回
   `{ [questionIndex]: selectedLabel }`，作为 `payload.answers` 交给工具。

其余确认类型仍保留原枚举校验。答案的取值顺序为：优先使用私有顶层 `answers` 同级
字段，其次使用可选的 `_meta.qwenAnswers`，最后从所选 option id 重建。

## 设计决策

1. **能力键与握手。** `initialize` 上的厂商 `_meta` 键
   （`qwen.askUserQuestion`）足够，且与 `qwen.goalProposals` 一致。不新增一等
   `clientCapabilities` 字段。
2. **多题的顺序权限请求。** 未实现。尚无真实 ACP 客户端被验证可对同一 `toolCall`
   接受多次 `session/request_permission`，因此多题在标准客户端上仅保留内容投影。
3. **`multiSelect` 语义。** 单个多选问题降级为单选；答案只携带一个所选标签。
4. **`Other…` 答案编码。** 选择 `Other…` 返回哨兵值 `'(Other)'`，使模型能区分
   "用户想要别的东西" 与一个具体选择。
5. **答案键与下标。** 扁平化答案以问题下标字符串（`'0'`）为键，与 Core 现有的
   `parseAnswerQuestionIndex` 一致。

## 兼容性与发布

- **由能力门控。** 仅当客户端未声明 `qwen.askUserQuestion` 时才启用扁平化。
  Qwen 自有界面保持现有载荷逐字节不变。
- **内容投影始终开启。** 它是增量的；从 `_meta` 渲染自有问题卡片的 Qwen 界面会
  忽略额外的文本块。
- **文档。** 该限制与该能力契约记录于此，以及
  `docs/users/integration-zed.md` 和 `packages/zed-extension/README.md`。

## 验证

- 针对 `ask_user_question` 的 `toPermissionOptions` 单元测试：单选扁平化产生
  每选项一个 `PermissionOption` + `Other…` + `Cancel`；能力开启时保留
  `Submit`/`Cancel`；多题不扁平化。
- `resolveAskUserQuestionAnswers` 与 `resolvePermissionOutcome` 的单元测试：
  已提供的 `ask:q0:o1` 解析为正确的 `answers` 条目；未加标志的编码 id 仍抛错；
  未提供的 id 仍抛错。
- `buildPermissionRequestContent` 测试断言 `ask_user_question` 出现问题文本与选项。
- 一个 Session 测试以编码 option id 驱动 `requestPermission` 并断言恢复出的
  `answers`；一个 acpAgent 测试断言仅在声明能力时调用
  `setAskUserQuestionHostSupported`。

## 待解决问题

- **标准客户端上的多题。** 未来阶段能否对同一 `toolCall` 复用来发起逐题顺序
  `session/request_permission`，尚未针对 Zed 与 VS Code 伴侣验证。
- **`multiSelect` 保真度。** 未来阶段可改为每个选项一次是/否确认，而不是降级为
  单选。

## 参考

- Issue [#11361](https://github.com/QwenLM/qwen-code/issues/11361) 及其分诊根因梳理。
- `packages/cli/src/acp-integration/session/permissionUtils.ts` —
  `toPermissionOptions`、`resolvePermissionOutcome`、
  `buildPermissionRequestContent`、`interactionMetaFields`。
- `packages/cli/src/acp-integration/session/Session.ts` — 权限参数构造与答案回读。
- `packages/core/src/tools/askUserQuestion.ts` — `getConfirmationDetails`、
  `onConfirm`、答案格式化。
- 先例：`docs/design/2026-08-25-acp-workspace-event-capability.md`、
  `docs/design/2026-08-05-feishu-ask-user-question-cards.md`、
  `docs/design/2026-09-09-web-shell-question-message.md`。
