# Web Shell Goal 展示：会话跳转与状态可读性

[English](2026-11-15-web-shell-goal-display.md) | [简体中文](2026-11-15-web-shell-goal-display.zh-CN.md)

状态：已实现（2026-11-15），在多工作区 Goals 页（#17230、#17291）之上的纯客户端增强。

## 问题

Goals 页列出每个已加载会话的目标，但要查看一个目标，只能找到卡片页脚最右侧那个小小的会话名文字链接。卡片本身无法让人一眼看出生命周期状态（状态胶囊是单色的），也无法看出已设定的预算消耗了多少（数字只是若干 meta 项中的纯文本）。会话内的 `GoalStatusStrip` 没有回到 Goals 页的入口，用户进入某个目标的会话后，只能靠侧栏才能到达聚合视图。

## 现状

- `GoalsDialog` 每个目标渲染一张卡片：状态圆点（活动态）、目标内容、编辑/暂停/继续/清除图标操作、`lastReason`，以及页脚的工作区胶囊、单色状态胶囊、活动态、轮数、tokens、耗时，还有一个调用 `onOpenSession(sessionId, workspaceCwd)` 的会话名按钮。
- `GoalStatusStrip` 渲染在目标所属会话的输入框上方，包含状态文本、目标内容、耗时/轮数/token 数字，以及同样的四个控制操作。它没有导航入口。
- 驾驶舱（cockpit）头部与工作流检查器已共享一套执行状态色板（`App.module.css` 中的 `--status-running-*`、`--status-attention-*`、`--status-done-*`、`--status-idle-*`），让同一状态在各处读起来颜色一致。Goals 尚未使用它。

## 目标

- 让「从目标跳到其会话」成为卡片上常驻、一等公民的操作。
- 让生命周期状态一眼可读，并与 Web Shell 其余部分使用同一套颜色语言。
- 对每个已设定的预算（轮数、tokens、活跃时长）以紧凑的进度条展示消耗进度，同时不给无上限的目标增加噪音。
- 在 Goals 页可用的前提下，让会话内的 strip 能打开 Goals 页。

## 非目标

- 不改 daemon、SDK 或 wire 格式。一切均派生自现有的 `DaemonGoal` / `GoalSnapshotV2` 载荷。
- 不在侧栏会话列表上加目标标记：那需要新增一个常驻的 goals 轮询（`GET /goals` 会探测每个存活会话），或新增会话摘要字段，两者都超出展示增强的范围。
- 不改目标控制语义、门控或创建/编辑表单。
- 不新增页面或深链；strip 复用现有的 `openGoals` 动作。

## 改动方案

### GoalsDialog 卡片

- 卡片头部新增第一个图标操作（`MessageSquareText`，`data-testid="goal-open-session"`），调用 `onOpenSession(item.sessionId, item.workspaceCwd)` —— 与页脚链接同一处理器，含工作区标签。它是导航而非控制，因此永不被按会话的 `busy` 门禁用，并着交互蓝（`--agent-blue-500`），与灰色的编辑/暂停/清除控制图标区分开。
- 页脚会话入口是带标签的链接而非灰色文字（`data-testid="goal-session-link"`）：会话图标 + 会话名 + 箭头图标，交互蓝，悬停/聚焦下划线，聚焦环。第一版沿用了旧的灰色纯文本形态，评审中与周围 meta 无法区分、读者根本找不到跳转，因此现在链接具备全部常规链接线索。
- 状态胶囊带上由 `goalStatusTone(status)` 映射的 `data-status`：`active → running`，`paused | blocked | usage_limited → attention`，`complete → done`。CSS 复用共享执行状态色板。这与 `GoalStatusMessage` 现有的 warning/success 颜色语言一致。`done` 分支为完备性而定义，但当前不可达：两个 goals 列表都过滤 `complete`（daemon 既有策略），strip 对 `complete` 返回 null，因此目前没有界面渲染已完成目标。列出已完成目标属于独立的 daemon 侧改动。
- 当至少设定了一个预算时，在 reason 与页脚之间渲染 `budgets` 区块，每个预算一行：标签、`role="progressbar"` 的轨道（`data-testid="goal-budget-<kind>"`，`aria-valuenow` = 截断后的百分比）、按生命周期色调着色的填充条，以及数值文本。进度条的可访问名就是可见的标签与数值本身（`aria-labelledby` 引用，按会话唯一 id），不在 `aria-label` 里再复制一份。该行是已设定预算数值的**唯一载体**：行渲染时抑制对应的页脚单元格（`goal-turns`、`goal-tokens`、`goal-elapsed`），同一事实绝不陈述两次；数值复用页脚原有的本地化模板（`goal.turnsOfBudget`、`goal.tokensOfBudget`，活跃时长走 `getGoalActiveTimeLabel`），文案变更会同时作用于所有界面。轮数用 `turnCount / turnBudget`；tokens 对 `tokensUsed / tokenBudget` 使用 `formatContextTokens`，daemon 未上报用量时跳过；活跃时长复用 elapsed meta 已在使用的同一个实时 `getGoalActiveTimeMs`，对照 `activeTimeBudgetMs`。比例截断到 `[0, 1]`，耗尽的预算显示为满条；截断后的比例四舍五入到最近整百分比（`Math.round`）：99.67% 的目标读作满条，而数值文本仍如实陈述剩余余量——条是一瞥即读的读数，数值是精确读数。无上限的目标不渲染该区块、保留页脚数值。填充条的宽度过渡包在 `@media (prefers-reduced-motion: no-preference)` 里，与兄弟进度条一致——因为活跃时长比例每秒都在推进。

### GoalStatusStrip

- `goalStatusTone` 定义于此并导出（dialog 本就从这个模块导入展示辅助函数；反向导入会形成循环依赖）。
- 状态文本带上同样的 `data-status` 色调。
- 新增可选 `onOpenGoals` prop，渲染一个 `Target` 图标按钮（`data-testid="goal-open-goals"`，标签 `goals.viewAll`）作为第一个操作。prop 缺席则不渲染按钮，没有 Goals 页的界面保持现有形态。该跳转是导航而非控制：与卡片跳转入口着同一交互蓝（`.goalsAction`，声明在 `.action:hover` 规则之后使蓝色在悬停下存活），且永不被 `busy` 禁用。`Target` 图标保留——它是全应用统一的 Goals 图标（侧栏 Goals 入口同样使用）；第 6 轮评审修的是灰色控制类，不是图标。

### App 接线

- 主输入框的 strip 接收 `onOpenGoals={projectFeaturesAvailable ? openGoals : undefined}`，与 Goals 页自身的渲染门一致。
- 分屏视图的 `ChatPane` 渲染同一个 strip，且本就接收 `onOpenGoals` prop（其 `/goal status` 命令在用）。它的 strip 现在透传同一 prop。`SplitView` 本身只在 `projectFeaturesAvailable && mainView === 'split'` 下挂载，因此每个挂载的 pane 都有 Goals 界面并渲染该入口；prop 保持可选，供没有 Goals 页的界面使用，那里不渲染按钮。

### i18n

- en / zh / ru 新增键：`goals.viewAll`、`goals.budget.turns`、`goals.budget.tokens`、`goals.budget.time`。预算数值文本复用现有的 `formatRuntime` / `formatContextTokens` 格式化器。

## 设计决策

- **头部图标而非整卡可点。** 整卡点击目标会嵌套五个按钮并夺走目标内容的文本选择；常驻头部图标在不改变卡片语义的前提下保证可发现性。
- **导航带链接线索，控制灰留给控制。** 第一版两个跳转入口都用与 meta 文本相同的无彩色灰，评审者在截图里找不到跳转。页脚入口现在以交互蓝承载「图标 + 会话名 + 箭头」，悬停下划线、聚焦环；头部图标着蓝——用颜色与形状而非仅靠位置表明「这是导航」。该规则延伸到 strip 的 Goals 页跳转：第 6 轮评审发现它仍穿着灰色控制类，现在着同一蓝色（`.goalsAction`）。
- **条四舍五入，数值保持精确。** `aria-valuenow` 与填充宽度把截断后的比例四舍五入到最近整百分比，99.67% 的目标读作满条，而数值仍显示剩余余量。两种读数用途不同——一瞥与精确——向下取整会低估进度，正如向上取整会高估。
- **行标签有意重复单位。** 数值模板与无标签的页脚、strip 界面共享，那里单位词是维度的唯一载体。为行内单独做无单位变体会分裂本 PR 刻意统一的单一文案源，因此行内标签/单位重复是可接受的代价；改为钉住每个语言的标签与数值模板。
- **共享色板，不引入新颜色。** 色调映射复用 `--status-*-fg/bg`，两种主题下 goals 与驾驶舱、工作流界面读起来完全一致；不新增主题 token。
- **仅为已设定的预算渲染进度条。** 多数目标无上限；为它们渲染空轨道会增加噪音并暗示一个不存在的上限。有 `tokenBudget` 而无 `tokensUsed`（旧 daemon）时跳过而非画成零——零会断言一个快照无法证明的消耗。
- **每个数值只有一个载体。** 第一版把已设定预算的数值同时印在新行与未改动的页脚——正是本 PR 要消除的 meta 噪音被复制了一份，且两处用不同模板构造。现在行拥有数值（含本地化模板），对应页脚单元格被抑制；无上限的目标页脚保持不变。
- **`goalStatusTone` 放在 strip 模块。** 两个界面共用单一来源；dialog 已依赖 strip 的辅助函数，依赖方向保持无环。

## 涉及文件

- `packages/web-shell/client/components/dialogs/GoalsDialog.tsx` / `.module.css`
- `packages/web-shell/client/components/GoalStatusStrip.tsx` / `.module.css`
- `packages/web-shell/client/App.tsx`（仅 strip 接线）
- `packages/web-shell/client/components/ChatPane.tsx`（分屏 strip 接线）
- `packages/web-shell/client/i18n.tsx`（en / zh / ru 键）
- 测试：`GoalsDialog.test.tsx`、`GoalStatusStrip.test.tsx`、`ChatPane.test.tsx`、`SplitView.test.tsx`、`App.test.tsx`、`i18n.test.ts`、`web-shell.goals-multi-workspace.spec.ts`

## 约束与风险

- 新增头部按钮与页脚链接共享同一可访问名模式（`"<提示>: <会话名>"`）；两者执行同一导航，且没有 E2E 选择器按该名字查询，冗余是安全的。
- 预算条仅在有目标处于 active 时随现有 1 秒 tick 重渲染；不引入新计时器。
- 没有 `tokensUsed` 的旧 daemon 只是不显示 token 条；不编造兜底数字。

## 验证计划

- 单测：`GoalsDialog.test.tsx`（带/不带工作区标签的头部操作——带标签用例改用次工作区目标使按目标路由可观测、各生命周期状态的胶囊色调、预算条的有无/截断并钉住 `role="progressbar"` 与显式 `aria-valuemin`/`aria-valuemax`、token 条跳过、running 与 attention 两态的填充条色调、含零进度 `0%` 的填充条内联宽度、假时钟下活跃时长条**与其数值文本**同步推进、轮间空闲用例证明计时器按目标状态而非会话活动态门禁、四舍五入到最近百分比且数值保留精确余量、数值只出现一次的见证、混合预算用例钉住只抑制已设定预算的页脚格、两个跳转入口的可访问名、completed 目标用例钉住两个跳转仍可导航、第二张卡用例钉住跳转的按卡收敛、双卡用例钉住按会话标签 id 唯一与引用收敛在本卡）。可访问名 helper 按浏览器计算方式以空格拼接 aria-labelledby 引用文本，并断言 aria-label 缺席——回退到 aria-label 会使所有名字钉子变红。`GoalStatusStrip.test.tsx`（入口接线/缺席、接线按钮携带 `goalsAction` 链接线索类、状态色调、色调映射）。`ChatPane.test.tsx` 双向钉住分屏透传：接线时渲染按钮且点击触发一次；未接线时不渲染按钮而 strip 保留控制。`SplitView.test.tsx` 双向钉住中间一跳（每个 pane 都收到 `onOpenGoals` 且可触发；未接线的 pane 没有）；`i18n.test.ts` 对 `goals.viewAll` 与三个预算标签做 en / zh / ru 全串钉子。
- `GoalsDialog.test.tsx` 还钉住控制请求在途时头部操作**与页脚链接**都仍可用（导航不是控制）；`GoalStatusStrip.test.tsx` 钉住 strip 的 Goals 跳转在 `busy` 下同样豁免；`App.test.tsx` 双向钉住主输入框 strip 的 `projectFeaturesAvailable` 门（有项目特性时入口在、无时缺席），并端到端钉住 App→SplitView 一跳（透传的回调打开真实 Goals 页）。
- 变异见证（字节级还原已核验）：去掉页脚抑制、把抑制接错预算、删除 `ChatPane` 透传、丢掉头部跳转的工作区标签、把填充宽度硬编码为 `0%`、把链接改回 meta 灰、删除胶囊的 `[data-status='attention']` 规则（填充条读它）、删除 strip 的 `[data-status='attention']` 规则（由 paused 目标导航用例钉住）、双删 running 规则（由未着色锚点捕获）、给头部跳转加 busy 门禁、让 `getGoalActiveTimeLabel` 输出分叉，各自使其钉子变红。第 6 轮新增：去掉 strip 跳转的 `goalsAction` 类（单测）与删除 `.goalsAction` 颜色规则（E2E）、把百分比四舍五入改成向下取整、把计时器门从目标状态改写成会话活动态、给页脚链接或 strip 跳转加 busy 门禁、删除 SplitView 或 App 的 `onOpenGoals` 透传、把头部跳转接到固定行而非其所在卡。
- 对改动文件跑 `npm run typecheck`、ESLint、Prettier。
- E2E：现有 `web-shell.goal.spec.ts` 与 `web-shell.goals-multi-workspace.spec.ts` 套件必须保持全绿（它们钉住了新按钮旁边的控制操作与卡片结构）。预算 @smoke 用例渲染两张卡（主+次）使卡片收敛读取面对真实兄弟卡，在真实浏览器测量填充条相对轨道的像素宽度（15% ± 1px），并读取计算颜色——填充对轨道、链接等于头部操作的蓝色（正向见证）且区别于 meta 与未着色 `--foreground` 锚点、填充等于胶囊的 attention 色。头部跳转用例钉住头部操作相对灰色控制图标的绘制颜色、strip 的目标身份、load 请求的 `cwd`（目标所在的次工作区运行时）、以及 strip 的 Goals 跳转与卡片头部跳转读同一蓝色且区别于 strip 的灰色编辑控制与未着色锚点。专门的 paused 目标导航用例把 strip 绘制成 attention 并将其颜色对胶囊与未着色锚点钉住。

## 验收标准

- 每张目标卡片提供常驻头部操作，能在目标自己的工作区打开其会话。
- 状态胶囊与 strip 状态文本在两种主题下使用共享生命周期色调。
- 已设定的预算渲染进度条，百分比截断正确、可访问标签完整；无上限的目标不渲染。
- strip 在 Goals 页可用处能打开该页，在不可用处不渲染入口。
- 无 daemon/SDK 改动；现有 goals E2E 套件原样通过。

## 开放问题

- 无。侧栏目标标记明确延后（见「非目标」）。
