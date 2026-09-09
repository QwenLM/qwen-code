# 按轮数或活跃时长停止 Goal

[English](2026-09-09-goal-turn-and-time-budget.md) | [简体中文](2026-09-09-goal-turn-and-time-budget.zh-CN.md)

## 问题

Goal 的自主续跑目前只有一道可配置的上限：token 预算，默认
`GOAL_DEFAULT_TOKEN_BUDGET` 为 30,000,000。这道上限的职责是兜住失控花费，也是
按这个职责定的量——一次健康的长跑很晚才会碰到它。

但当用户想限定一个 Goal 的规模时，他要的不是这道上限。让人把 Goal 说短一点，他
说的是"最多二十轮"或"最多半小时"，不会说"最多 120 万 token"。而今天这两种说法都
不起作用。目标模板甚至就在鼓励第一种写法（`Budget: stop as blocked after 20
turns`），于是 `docs/users/features/goals.md` 只好补一句：这么写什么也不配置——
它只是给模型的一条指令，模型可能遵守也可能不遵守，背后没有任何运行时计时器。

记录上其实两个计数器都已经有了。`GoalRecord.turnCount` 由
`reduceGoalTurnFinished` 在每轮结束时加一，`activeTimeMs` 由 `transitionGoal`
通过 `elapsedActiveTime` 在每次状态转换时落账。缺的只是给这两者一个上限，以及
到达上限时的停机。

## 现状

- `tokenBudget?` 在创建时按运行时的 `tokenBudgetGrant` 武装；当 resume 或 edit
  发现它已花完时，前移到 `tokensUsed + grant`（`rearmedTokenBudget`）。已花掉的
  计量本身从不清零。
- `isGoalTokenBudgetSpent` 是运行时停机与 reducer 再授共用的唯一谓词，因此两者
  不可能失步。
- `queueContinuation` 是通往自主续跑的唯一路径。预算花完时它恰好再给一个
  wind-down 交接轮——交付后在记录上标为 `windDownTurnId`——随后由
  `stopForSpentBudget` 把 Goal 结算为 `usage_limited`，`limitKind` 为
  `'token_budget'`。
- 所有界面都按 `status` 渲染 `usage_limited` 的 Goal，并把 `lastReason` 当散文
  显示。没有任何界面把 `limitKind` 映射成展示文案。

## 目标与非目标

在范围内：两个运维设置，让 Goal 在到达轮数或活跃时长时停下，并且经由与 token
预算完全相同的交接轮、相同的 `usage_limited` 状态、相同的 resume 语义抵达用户。

不在范围内：在状态卡片、底栏 pill 或 Web Shell 状态条上显示这两道上限；改变
`tokensUsed` 的计量口径；按轮或按工具调用的上限；以及让目标中仅供模型参考的
`Budget:` 行直接配置运行时状态。模板与示例会点名两项设置，避免用户把这条参考说明
误认为已强制执行的上限。

## 设计

**两道上限，形状与 token 那道完全一致。** `GoalRecord` 新增 `turnBudget?` 与
`activeTimeBudgetMs?`。两者都是绝对值：`turnCount >= turnBudget` 即停，活跃时长
达到 `activeTimeBudgetMs` 即停。两者都在创建时按 grant 武装，都在已花完的 Goal
被 resume 或 edit 时前移，并且都不会被追加到一个创建时没有该上限的 Goal 上。
`isGoalTurnBudgetSpent` 与 `isGoalActiveTimeBudgetSpent` 是配对的谓词，运行时与
reducer 共用。

`isGoalActiveTimeBudgetSpent` 把已耗时长作为参数传入，而不是自己算：Goal 处于
`active` 时活跃时长仍在累积，握着时钟的是调用方。一个已停止 Goal 的耗时就是它落
账的 `activeTimeMs`，这正是让再授有明确定义的前提——`elapsed + grant`，量的是
`transitionGoal` 即将落账的同一个数。

**在续跑边界检查，绝不在轮中打断。** 三道上限都在 `queueContinuation` 里通过一个
新的读取器 `spentBudget` 读取，它返回 kind 与 reason，或者什么都不返回。跨过上限
的那一轮仍会跑完；Goal 在下一轮被铸出之前停下。token 预算本来就是这个行为，也正
是这个性质让预算不会把模型的思路截断在中途。

**一次停机只报一个原因，token 优先。** 当同一轮跨过多道上限时，`spentBudget` 按
token、轮数、时长的顺序上报。token 预算是默认武装的那一道，所以也是用户最可能在
问的那一道。`limitKind` 新增 `'turn_budget'` 与 `'time_budget'`，
`isGoalBudgetLimitKind` 把三者归为一类。

**resume 分支要放宽。** `reduceGoalControl` 里那条预算 resume 分支存在的唯一目的
就是清掉 `lastReason` 与 `limitKind`，而它是按字面量 `token_budget` 判断的。不改
的话，一个按轮数停下的 Goal 在 resume 之后仍会把"ran its turn budget"当作它当前
处于活跃状态的原因显示出来。现在改为按 `isGoalBudgetLimitKind` 判断。

**每道预算各自独立再授。** 因为轮数用完而给出的 resume 只前移轮数上限，把一个几
乎没动过的 token 窗口原样留在那里。放宽一道没人抱怨过的上限，等于花掉用户并没有
给出的授权。

**默认是"没有"，不是某个数。** 与 token 预算不同，设置缺省或非法时不武装任何上
限。节奏是运维自己选的规模；项目替他挑任何一个数，都不会比"没有上限"更正确。
CLI 只接受 `-1` 作为显式关闭方式，并把 `0` 当作可能的笔误拒绝；运行时嵌入方会把
关闭值归一化为非有限 grant，而日志用"不写字段"表达"什么都不武装"，因为
`Infinity` 无法在 JSON 日志里存活。

**cap 是防打错的护栏。** `GOAL_MAX_TURNS_CAP` 是 10,000 轮，
`GOAL_MAX_ACTIVE_MINUTES_CAP` 是一周的活跃时长。两者都不是对长跑的政策：想要比
这更大自主权的运维，要的是没有上限，而那正是默认值。CLI 在启动时就拒绝超范围的
值，与 `model.goalTokenBudget` 的处理方式一致，这样一个多打的零会表现为一条报错
消息，而不是一个悄悄无上限运行的 Goal。

**命名为 `model.goalMaxTurns` 与 `model.goalMaxActiveMinutes`。** 仓库里确实有一
个 `goals.*` 设置组，但它装的是模型提案的同意设置，且忽略 workspace 作用域。
Goal 预算已经位于 `model.*`，所以两项新设置沿用这个命名空间及其三层校验链路。它们
的值在构造 `Config` 与 Goal runtime 时捕获，因此 schema 声明
`requiresRestart: true`；`/config` 不能声称当前会话已经应用一项实际上不会重读的
上限。

**交接轮的提示词不再写死 token 预算。** 三个 host 传的是一个朴素的 `windDown`
布尔值，所以 wind-down 那一行无法说出是哪道上限到了。现在它指向上面那条预算行，
由预算行来说。那条预算行改成多段——token、轮数，以及仅在武装了时长上限时才出现的
活跃分钟数——这样模型能看出是哪份额度用尽了。没有上限可比的已耗时长被完全省略：
那会是每一轮都多出一个没人会据此行动的数字。

## 影响范围

- `packages/core/src/goals/goal-protocol.ts`：两个新的 `GoalLimitKind` 取值、
  `isGoalBudgetLimitKind`、两个记录字段、`isGoalTurnBudgetSpent`、
  `isGoalActiveTimeBudgetSpent`、`goalTurnBudgetReason`、
  `goalActiveTimeBudgetReason`。
- `packages/core/src/goals/goal-reducer.ts`：`GoalControlTransition` 上的两个
  grant、创建时的 `armedBudget`、`rearmedTurnBudget`、
  `rearmedActiveTimeBudget`、`rearmedBudgets`、放宽后的 resume 条件，以及解析器
  的键名清单、校验、再水化，加上 `transitionGoal` 的删键分支。
- `packages/core/src/goals/goal-runtime.ts`：`CreateGoalRuntimeOptions` 上的两个
  grant、`spentBudget`，以及它在 `queueContinuation`、`stopForSpentBudget`、
  `finishTurn` 空转让位清单与 `flushContinuation` 的 `usage` 中的使用；恢复持久化
  会话时重置活跃记录的进行中时钟，不把离线时间计入。
- `packages/core/src/goals/goal-tools.ts` 与内置 `/goal-draft` skill：面向模型的目标
  示例明确 `Budget` 只是参考，并点名真正强制上限的设置。
- `packages/core/src/goals/goal-continuation-prompt.ts`：放宽后的
  `GoalContinuationUsage`、多段预算行、wind-down 行。
- `packages/core/src/config/config.ts`：两个参数、它们的 cap、校验器与归一化函
  数、两个 grant，以及与运行时的接线。
- `packages/cli/src/utils/runBudget.ts`、`packages/cli/src/config/config.ts`、
  `packages/cli/src/config/settingsSchema.ts`、`settingsUtils.ts` 与 JSON Schema
  生成器：启动和写入校验、解析、重启提示与两条 schema 条目，以及重新生成的
  `packages/vscode-ide-companion/schemas/settings.schema.json`。
- `packages/sdk-typescript/src/daemon/types.ts` 与
  `packages/web-shell/client/daemon/session/mappers.ts`：两个新的 `limitKind`
  取值与两个新的记录字段。Web Shell 的解析器按一份明确的白名单重建记录，所以它
  没有点名的字段会在实时链路上被丢掉。
- `packages/web-shell/client/i18n.tsx` 与用户/设计文档：新建 Goal 的占位文案和示例
  区分模型参考与强制设置，并准确说明两种计量。

Goal host 接口无需改动；SDK 与 Web Shell 的记录副本仍需更新，因为它们显式枚举
字段。

## 约束与风险

- **节奏停机不能被读成空转。** 空转闸门会在连续三轮没有产出时 pause 一个 Goal。
  在同一轮跨过节奏上限的 Goal 应得的是它的交接轮和一个可 resume 的
  `usage_limited` 停机，所以该闸门对每一种已花完的预算让位——正如它本来就对
  token 预算让位一样。
- **时间是活跃时长，不是墙钟。** 隔夜 pause 的 Goal 恢复时窗口不变；恢复一条
  `active` 日志记录时也会重置进行中时钟，进程不存在的时间不会被计入。
- **轮次之间的空闲活跃时长仍然计入。** `elapsedActiveTime` 在状态为 `active` 期
  间一直累积，包括等待和轮次之间。因此一个处于活跃状态却没有 host 来续跑它的
  Goal 会持续花掉时间窗口，直到进程退出。
- **每个完成的 Goal 轮次都计入。** 轮数计量既包括自主续跑，也包括用户驱动的
  轮次。用户轮次不会因为到达上限而被拒，但它可能让下一次自主续跑变成交接轮。
- **core 之外有两处白名单。** SDK 手抄的联合类型与 Web Shell 的 mapper 各自按取
  值枚举 `limitKind`。漏掉任何一处，新的 kind 会被静默丢弃而不是报错。
- **默认关闭意味着没有行为变化。** 两个设置都不设时，没有 Goal 会带上任何一个字
  段，`spentBudget` 退化为现有的 token 检查。

## 验证

- `goal-reducer.test.ts`：等于上限即算花完的边界；create 与 replace 上落下的
  grant；非有限 grant 什么都不武装；每一种 kind 在 resume 上的再授以及 edit 上的
  再授；每一种预算 kind 的停机文案都被清掉；未花完的上限原样保留；不给无上限的
  Goal 追加上限；只有已花完的那道上限被再授；wind-down 标记被丢弃；被显式关闭的
  上限被移除且不留值为 `undefined` 的键；经由证据 resume 时同样再授；两个字段与
  两种 kind 的快照往返；非法上限被拒；以及字段存在之前持久化的 Goal 能恢复。
- `goal-runtime.test.ts`：没有 grant 就不武装上限；完整的轮数预算路径（工作轮、
  一次交接、带 `turn_budget` 的 `usage_limited`、resume 前移到计数之前）；时长预
  算的同一套；pause 期间活跃时长不累积；一轮跨两道上限时只报一个原因；节奏数字
  抵达 host，包括 host 绑定前已经排队的续跑；没有时长上限时不发时长数字；恢复时
  丢弃离线时间；用户轮次计数；token/轮数/时长优先级；已花完的节奏预算优先于空转
  闸门；结算写入失败时停机仍然显示。
- `goal-continuation-prompt.test.ts`：轮数段与 token 段并列；活跃分钟仅在其上限
  存在时出现；五处整段提示词固定断言按新前缀与新交接行更新。
- core 与 cli 的 `config.test.ts`、`settingsSchema.test.ts`、
  `settingsUtils.test.ts`、`config-command.test.ts` 以及 `runBudget.test.ts`：设置
  抵达 grant、默认无上限、每个 cap 本身被接受而超一即被拒、所有非法值在启动和
  写入时被拒、重启提示与非法值诊断。
- `goal-protocol.test.ts`、内置 skill 测试与 Web Shell mapper 测试：停机原因格式、
  目标说明，以及 core 之外两处记录白名单。
- 完整 CLI 包测试覆盖 `nonInteractiveCli.test.ts`、`Session.test.ts` 与
  `use-llm-stream.test.tsx` 的提示词断言，以及 `acpAgent.worktree.test.ts` 与
  `facade.test.ts` 的显式 core 导出 mock。
- 真实模型端到端：`model.goalMaxTurns: 2` 的 Goal 在第三轮交接后停下，`/goal
resume` 再授一个窗口；`model.goalMaxActiveMinutes: 1` 同理。

## 验收标准

- 两个设置都不设时，Goal 记录不带这两个字段，行为不变。
- 到达任一上限的 Goal 恰好获得一个 wind-down 轮，随后结算为 `usage_limited`，
  带上对应的 `limitKind` 与一条点名该预算的 `lastReason`。
- `/goal resume` 清掉停机文案与 kind，并且只前移已花完的那道上限。
- 两个新的 `limitKind` 取值能经 daemon 线协议活着进入 Web Shell，两个新的记录字
  段能在日志中存活。
- 超范围或格式错误的设置会让启动失败，并给出
  `settings.json: model.goalMaxTurns`（或 `goalMaxActiveMinutes`）消息。

## 后续工作

- 在已经显示 token 那一对数字的位置上显示这两道节奏上限：底栏 pill、ink 与
  OpenTUI 状态卡片、headless 的 `Usage:` 行，以及 Web Shell 的状态条与 Goals 对
  话框。
- 等到有人报告轮次之间的空闲活跃时长确实造成困扰时，再重新考虑它是否应当计入时长
  预算。
