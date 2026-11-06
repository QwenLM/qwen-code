# Ask User「问细节」侧边任务

[English](2026-11-06-ask-user-details-side-task.md) | [简体中文](2026-11-06-ask-user-details-side-task.zh-CN.md)

状态：已实现并验证（单元测试、mock daemon 视觉验证、真实 daemon + 真实模型
E2E 轮；证据见 `.qwen/e2e-tests/`）。

## 问题

当 `ask_user_question` 权限待回答时，Web Shell 会隐藏主输入框
（`composerHidden`），btw 快捷键也会忽略 `pendingApproval` 状态。用户只能选择
选项、输入自由文本答案或忽略。此时没有任何途径就待答问题本身追问——例如某个
选项是什么意思、会改动什么、有什么风险——除非先提交一个答案或丢弃这个问题。

## 现状

- `/btw <问题>` 走轻量侧边提问（`btwSessionStream`），不进入主对话上下文。
  它只由主视图输入框处理。
- `/btw side <问题>` 在 daemon 声明 `session_side_task` 且存在工作区会话
  （`sideTasksAvailable`）时创建侧边任务：`createSideTask(initialPrompt)`
  打开右侧面板 tab，`createSideTaskSession` 创建继承父会话转录上下文的子会话。
  tab 的 `initialPrompt` 作为子会话的首条提示词发送。
- 会话写出的文件会作为回合产物展示；`.html` 文件是可渲染产物，可在右侧面板的
  HTML 预览中打开。
- 待答 AskUser 面板（`AskUserQuestion`）提供提交 / 忽略 / 上一题 / 下一题与
  「其他」自由输入，但没有问细节的入口。

## 目标

- 让用户在作答前了解待答问题的细节，且不提交答案、不丢弃问题、不污染主对话。
- 端到端复用现有侧边任务基础设施；不改 daemon。
- 解释以自包含单文件 HTML 交付，用受控、无歧义的句式（ASD-STE100 句式规则）
  写作，语言跟随 UI 语言。

## 非目标

- 不在 split view 面板或侧边任务面板内提供问细节入口。这与 `/btw side` 一致
  （后者也只在主视图可用）；按面板区分的变体需要侧边任务面板目前不具备的
  按面板父会话作用域能力。
- 不新增 daemon 路由、能力声明或设置项。
- 不自动作答：侧边任务绝不能提交待答权限，也不能向主会话发送提示词。

## 方案

1. `AskUserQuestion` 接受可选 `onAskDetails?: () => void`。提供时在操作行渲染
   「问细节」文本按钮（弱化样式，位于忽略左侧）。按钮在选项 radiogroup 之外，
   选项数字快捷键与 roving-tabindex 导航不受影响。提交进行中时按钮禁用。
2. App 只为主视图 overlay 接线该回调，门控与 `/btw side` 相同
   （`sideTasksAvailable`）。回调用 `formatAskUserQuestions(rawInput)` 格式化
   待答载荷——语言中立的编号问题快照，含选项 label/description——然后调用
   `createSideTask(t('askUser.detailsPrompt', { questions }))`。
3. 本地化提示词模板要求侧边任务：先阅读相关代码与上下文；未核实的结论要标注；
   解释每个问题的背景与每个选项的含义、差异、影响与风险；给出建议并说明理由；
   不替用户作答、不改动主会话；用 ASD-STE100 句式规则（一句一个意思、主动
   语态、短句、同一概念一个词、条件在动作前、三项以上用列表、不用比喻和感叹号）
   写出自包含单文件 HTML（内联 CSS、不引用外部资源），保存到 `.qwen/tmp/` 下；
   代码、命令、路径、配置键名原样保留；完成后回复文件路径和一句话摘要。
4. HTML 文件作为回合产物出现在侧边任务聊天中，用现有右侧面板 HTML 预览打开。
   待答问题保持待答；用户回到主视图作答或忽略。

## 设计决策

- **用侧边任务，不用轻量 btw。** 细节对话可能需要读代码、写文件与多轮追问；
  侧边任务是继承上下文的完整子会话，而 `btwSessionStream` 是单发回答。HTML
  交付也需要文件工具。
- **预填提示词，不是空草稿。** 点击时用户意图（「解释这个待答问题」）已知；
  预填省去一次输入并锁定范围。用户仍可用后续提示词引导。
- **样式规则写进提示词。** 侧边任务模型不共享用户的个人记忆，受控语言与 HTML
  要求必须在提示词中自包含。只包含核心句式规则；更重的校验仪式不进入产品
  默认提示词。
- **可选 prop，条件渲染。** 没有侧边任务界面的宿主（嵌入式宿主、split 面板、
  无该能力的 daemon）不传回调，按钮就不存在。不做禁用态 UI。
- **解释语言跟随 UI 语言。** 提示词模板本地化（en/zh-CN；ru 经现有 i18n 回退
  机制落到 en），解释语言跟随 UI 语言，而不是 daemon 的输出语言设置。
- **每个待答问题一个细节任务。** 细节 tab 用权限请求 id（uuid；tab 已按父会话
  分桶）派生的稳定 id，按 upsert 而非追加：重复点击聚焦已有 tab，不会重复创建
  子会话。「问题→子会话」关联还按父会话持久化（localStorage），因此比 tab 更
  长寿：关闭细节 tab 后再点击会重新打开同一子会话（不新建草稿、不重发提示词）；
  从侧边任务目录以 `side-task:<sessionId>` tab 重新打开的子会话会被聚焦而非
  重复。每个父会话一条关联，新问题取代已解决问题的关联，存储有界。tab id 必须
  短——面板派生的 daemon clientId 形如 `side-task:<父会话>:<tabId>`，daemon
  拒绝超过 128 字符的 clientId。`/btw side` 保持每次调用唯一的草稿 id。
- **快照携带选择语义。** 多选问题标记 `[multiSelect]`，让解释覆盖可组合的
  选项，而不只依赖继承的转录。
- **操作行可换行。** 第五个按钮可能把行撑出窄视口，而 flex-end 行的溢出发生
  在左侧——`scrollWidth` 测不到。操作行改为可换行，并用 320px 双问题回归
  测试断言每个操作按钮都在面板内且可点击。

## 约束与风险

- 侧边任务在创建时继承父会话转录；待答问题属于该上下文，提示词又内嵌了快照，
  即使父转录很长，解释也能保持聚焦。
- `.qwen/tmp/` 是 agent 的临时目录（本仓库 git 忽略）。在未忽略它的工作区里，
  该文件也只是用户可删除的普通工作区文件；不会自动提交任何内容。
- 按钮不得破坏面板的键盘契约：它位于操作行，不是选项，不注册数字快捷键。
- 侧边任务创建可能失败（daemon 错误、策略翻转）。失败处理沿用现有 `/btw side`
  路径（toast、tab 守卫）；问细节入口不引入新的失败模式。

## 验证计划

- 单元：`formatAskUserQuestions` 的格式化、去空白、跳过畸形条目
  （`askUserPermission.test.ts`）。
- 单元：无回调时按钮隐藏；点击触发回调且不提交；按钮在选项组与数字快捷键之外；
  提交进行中禁用（`AskUserQuestion.test.tsx`）。
- 单元：App 接线——有 `session_side_task` 时，待答问题的问细节动作创建侧边
  任务 tab，其 `initialPrompt` 含问题文本、STE100 指令与 `.qwen/tmp/` 目标；
  主会话无 `submitPermission`/`sendPrompt`；无该能力时不提供回调
  （`App.test.tsx`）。
- 视觉：`client/e2e/visuals/ask-user-details.spec.ts`（mock daemon、真实
  Chromium、dark/light、zh-CN UI）——按钮在待答面板渲染，点击打开侧边任务
  tab，问题保持待答。
- E2E：`.qwen/e2e-tests/` —— 真实 daemon、待答 AskUser、点击问细节，
  验证侧边任务创建、HTML 产物预览，以及主问题保持待答。2026-11-06 已用真实
  daemon 与模型执行，全部通过（证据：`.qwen/e2e-tests/ask-details-e2e-20261106/`）。

## 验收标准

- 有侧边任务能力时，待答 AskUser 面板显示「问细节」；点击后打开侧边任务并
  开始解释问题，主会话不提交任何答案。
- 无该能力（或嵌入式/split 界面）时，面板保持不变。
- 现有 AskUser 键盘行为（数字、方向键、Enter、Esc、Ctrl+Enter）不变。
