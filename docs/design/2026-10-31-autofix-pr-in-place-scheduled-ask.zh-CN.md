# `/autofix-pr --in-place`：编辑前先问的定时轮次

[English](2026-10-31-autofix-pr-in-place-scheduled-ask.md) | [简体中文](2026-10-31-autofix-pr-in-place-scheduled-ask.zh-CN.md)

状态：提案（未实现）。日期：2026-10-31。

本设计为 [`/autofix-pr --in-place`](2026-10-30-autofix-pr-in-place-copilot.zh-CN.md)
（下称"v1 in-place 设计"，已随 #15929 合入）补上其第 12 节开放问题 1 留下的
后续：编辑前先问用户的定时 in-place 轮次。下文引用"命令设计"的章节号均指
[2026-10-21-autofix-pr-command](2026-10-21-autofix-pr-command.zh-CN.md)；
引用"v1"的均指 v1 in-place 设计。

## 1. 问题

v1 in-place 是 once 形态：每一轮都是手动 `/autofix-pr <n> --in-place` 调用，
轮末即清理 watch。这安全——每轮都有人在场——但它要求用户自己记得在 CI 失败
或有可信评审者评论时跑一轮。共驾的收益（agent 在用户自己的检出里、用其已装
依赖工作）于是被"用户注意到 PR 需要处理"这件事卡住。

worktree 模式本就有定时轮次，但它的轮次从不提问（命令设计规则 4），其生命
周期靠隔离而破坏性安全：定时轮次可以 `reset --hard`、`clean`、丢弃 worktree，
因为 worktree 是 helper 自己的、绝不是用户的。这些在用户的检出里都不安全
——那里可能有第二个写者（用户）正在编辑。

缺口是一个兼具两者的模式：轮次像 worktree 模式那样定时触发，但每轮像 v1
in-place 那样在编辑检出前先问用户。v1 刻意没做这个（v1 第 5 节决策 1："v1
不让两份契约混用"）；本设计就是那个后续。

## 2. 现状

以下均按已合入的实现核实
（`packages/cli/src/commands/autofix-pr/`、
`packages/core/src/skills/bundled/autofix-pr/SKILL.md`）：

- `schedule` 拒绝 in-place watch（`state.inPlace` → "its rounds run only
  when you ask … there is no scheduled task"）；`fix-start` 也拒绝（"its
  fixes run in the foreground … never in the background"）。skill 对同时给
  `--every` 与 `--in-place` 的启动在跑 `prepare` 之前就停下。
- worktree watch 的定时任务（`scheduledTask`）是一个 cron 表达式、一个
  **gate**（`autofix-pr snapshot <n> --gate --session <id> --task <id>`，
  不经模型运行、只打印自 gate cursor 以来的变化）、以及一个 **prompt**
  （`Run /autofix-pr tick <repo>#<n> …`，gate 报告有事可做时作为一轮交付给
  会话）。daemon 会话的任务是 `durable` 且绑定会话的（`sessionMode:
"current"`），于是 daemon 让会话常驻、重启后重载任务。
- gate 在报告事件时推进其 cursor；触发启动的那轮处理这些事件。安静的 PR
  不耗任何轮次。
- v1 in-place 的轮次：`sync` 对干净检出 fast-forward（共驾收益），对脏或
  分叉的回答 `synced: false`；fix agent 在检出里前台运行；每条会丢弃的路径
  都停下询问；轮末跑 `cleanup`，只删 watch 自己的文件。没有任务、也没有
  gate cursor 参与。

以上任何一条都不得为 worktree 模式而改变。

## 3. 目标与非目标

目标：

- in-place watch 可以定时跑轮次（`--in-place --every <n>`）。
- 定时轮次**在 fix agent 编辑检出前先问用户**，没有显式的逐轮批准就什么都
  不编辑。
- 无事可做的触发不耗轮次、也不提问（gate 保持廉价，如 worktree 模式）。
- 被拒绝或无人应答的轮次什么都不改、也什么都不丢：其事件留待后续触发。
- v1 的安全原样成立：任何东西都不自动丢弃；脏或分叉的检出停下询问；fix
  只在前台。

非目标：

- 用户检出里绝不存在没有逐轮批准的自主编辑。in-place watch（无论是否定时）
  没有"fixes run without asking"，也没有 `unattended` 授权。
- in-place 不做后台 fix（如 v1，保持前台）。
- 不改 worktree 模式的定时轮次、gate 或生命周期。
- 不做新沙箱。暴露面即 v1 的（第 7 节），逐轮经同意。

## 4. 用户体验

```
# 会话开在检出根目录、PR head 分支上、干净
/autofix-pr 123 --in-place --every 5
```

启动确认**替换** v1 的 once 形态确认，内容为：

- fix agent 在这个检出里、前台、在会话审批模式下工作，用户可以与它并肩
  编辑；
- 每 `<n>` 分钟触发一轮；**每轮编辑前都先问**——它报告发现了什么（失败
  检查、可信评审反馈）并等待"Fix it"的回答；没有那个回答就什么都不编辑；
- 轮次 push 分支上超出 PR head 的全部内容——包括用户在轮次 sync 与 push
  之间自己做的提交——并在 PR 上回复，用用户自己的 git 与 `gh` 身份；
- 任何东西都不自动丢弃：脏或分叉的检出停下询问；
- 被拒绝或无人应答的轮次什么都不编辑、把事件留到下次触发；`/autofix-pr
stop 123` 结束 watch，保留检出、分支与历史。

选项只有"Start"与"Cancel"——`--yes` 不跳过此确认，也没有"fixes run
without asking"（第 3 节）。

随后，有事可做的触发在会话里 surfaced 一个**提案**：

```
PR #123 — 自上一轮以来 2 个失败检查、1 条可信评审线程。
在你的检出里修它们？  [Fix it] [Not now] [Stop watching]
```

- **Fix it** → 如 v1 跑一轮前台轮次（审批模式下的 fix agent、push、
  reply），然后 gate cursor 推进到它已处理之处。
- **Not now** → 轮次结束、什么都没编辑；事件保持待定，下次触发再提案。
- **Stop watching** → `cleanup`（保留检出与分支）并删除任务。

无事可做的触发什么都不问、安静结束。触发时检出脏或分叉则如 v1 停下询问，
与提案的回答无关。

## 5. 设计决策

1. **定时 in-place 轮次是一个提案，不是一个自主轮次。** 触发跑只读/安全的
   前缀（gate、干净检出的 `sync`、`snapshot`），然后在 fix agent 运行前先问。
   没有"Fix it"的回答，fix agent 绝不启动。这条唯一的规则把"定时触发"与
   "用户的检出绝不在无人裁决时被编辑"调和起来。
2. **两层同意。** 启动时的常设定时同意（第 4 节确认）加上任何编辑前的逐轮
   批准。两者都不可被 `--yes` 跳过；两者都不提供无人值守选项。常设同意使
   watch 成为 watch；逐轮批准使每次编辑都有人在场。
3. **gate cursor 只在处理时推进，不在提案时推进。** worktree gate 在报告
   事件时提交其 cursor，因为它启动的那轮会处理它们。in-place 轮次可能被
   拒绝，所以其 gate 报告待定事件而**不**提交 cursor；cursor 只在那轮
   push/reply 之后（或用户驳回事件后）推进。于是被拒绝的轮次在下次触发
   重新提案同一批事件，而不是丢掉它们。
4. **安全的 fast-forward 照跑；只有编辑才问。** 干净、可 fast-forward 的
   检出在触发时如 v1 照常 `sync`——它不丢任何工作、让分支保持最新。提案
   门控的是 fix agent 的编辑，不是 fast-forward。脏或分叉的检出如 v1 拒绝
   并询问（v1 决策 5 不变）。
5. **无人应答即拒绝。** 在有界等待内无人应答的提案结束轮次、什么都没编辑、
   事件待定。watch 绝不因为用户离开而编辑。确切的通知-与-超时机制是一个
   开放问题（第 12 节）。
6. **任务如 worktree 模式那样 durable 且绑定会话。** 定时 in-place watch
   需要一个让会话常驻的 daemon 任务（`durable`、`sessionMode: "current"`），
   因为轮次必须触及用户去问。终端会话的 in-place watch 只与会话同寿，如
   那里的 worktree watch。

## 6. 提议的改动

### 6.1 `schedule` 与 watch state

- `runSchedule` 不再拒绝 in-place watch，而是记录一个选项标记为
  scheduled-in-place 的 watch；`scheduledTask` 为提案轮次打印 gate 与
  prompt（prompt 调用 skill 的 scheduled-in-place 轮次，而非自主的
  `tick`）。`authorCanPush !== true` 的拒绝保留：这样的 PR 绝不被 watch。
- `AutofixPrWatchOptions` 携带 scheduled-in-place 模式（一个字段，或把现有
  `inPlace` state 标志与 `watch` 一起读）；旧 state 文件原样可读。
  `fix-start` 保持拒绝 in-place（无后台 fix）。
- in-place watch 的 gate cursor 遵循决策 3：报告待定、处理时提交。

### 6.2 gate（`snapshot --gate`）

- 对 in-place watch，gate 报告比 cursor 新的事件（失败检查、可信评审
  反馈）而**不**推进 cursor。它仍点名会话与任务，于是过期任务在下次触发
  停下（命令设计）。安静的 PR 什么都不打印、不耗轮次。
- cursor 在轮次报告它已处理事件时（push/reply 之后）、或用户驳回事件时
  推进。提交 cursor 的具体 helper 是实现细节；不变量是决策 3。

### 6.3 skill（`SKILL.md`）

- 给 `--in-place --every <n>` 的启动不再被拒绝；它跑 scheduled-in-place
  启动（第 4 节确认，然后 `schedule`，然后 durable 任务）。不带 `--every`
  的 `--in-place` 保持 v1 的 once 形态。
- 新增"Scheduled in-place round"路径：跑 gate；若无所报告，安静结束；否则
  跑 `sync`（干净 fast-forward，或对脏/分叉拒绝并询问）与 `snapshot`、写
  brief，并在启动 fix agent 前**询问**（第 4 节提案）。"Fix it"则跑前台
  fix 与 v1 轮次的其余部分（push、reply），然后提交 gate cursor；"Not
  now"/超时则什么都不编辑、cursor 不动地结束；"Stop watching"则清理并删除
  任务。
- in-place 确认、brief 变体与 `## Never` 清单从 v1 原样继承；定时轮次增加
  提案步骤与"处理时推进 cursor"规则。

### 6.4 `autofix_pr` 工具（core）

- `schedule` 对 in-place watch 放行（目前拒绝）；`unattended` 保持拒绝
  in-place。confirmed-watch 记录与 reply plan 位置保持 v1（plan 在
  `<检出>/.qwen/tmp`）。

### 6.5 `status`、`stop`、`resume`

- `status` 以 `inPlace: true` 及其任务列出 scheduled in-place watch；
  `worktreeWork` 是用户检出的工作，如 v1 报告。
- `stop` 清理（保留检出/分支）并删除任务。
- `resume` 以记录的选项在本会话重建 durable 任务，如 worktree watch；遗留
  的 once 形态 in-place state 仍被 `cleanup`（v1）。

## 7. 信任模型

暴露面即 v1 in-place 的（v1 第 7 节）：fix agent 在用户检出里、在用户凭据
可及之处、在一个有人值守的会话里运行 PR 的代码。定时不扩大它，因为没有逐轮
批准就没有编辑（决策 1）：撞上用户离开的触发会提案然后推迟，而不是编辑。
常设定时同意是"同意被定时询问"，不是"同意无人值守地编辑"。其余一切——PR
内容作为数据、可信作者分拣、brief 的 `## Never` 清单、push lease、只
fast-forward、默认分支拒绝、push 预算——从 v1 与命令设计原样继承。

## 8. 受影响的文件

- `packages/cli/src/commands/autofix-pr/schedule.ts` —— 允许为 in-place
  watch 定时；提案轮次的 gate/prompt。
- `packages/cli/src/commands/autofix-pr/state.ts` —— scheduled-in-place
  watch 选项；处理时推进 cursor。
- `packages/cli/src/commands/autofix-pr/snapshot.ts`（gate）—— 对 in-place
  watch 报告待定而不提交 cursor。
- `packages/cli/src/commands/autofix-pr/fix.ts` —— 不变（in-place 仍拒绝
  后台 fix）。
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` —— 第 4 节启动、
  scheduled-in-place 轮次、status/stop/resume。
- `packages/core/src/tools/autofix-pr.ts` —— `schedule` 对 in-place 放行；
  `unattended` 仍拒绝。
- 以上各文件的同置测试；本设计双版；`.qwen/e2e-tests/` 下的 E2E 测试计划。

## 9. 约束与风险

- **两个写者、一棵树、一个定时器。** 触发到达时用户可能在编辑。干净检出
  fast-forward 与脏/分叉拒绝（v1）处理树的状态；逐轮批准处理编辑。在已批准
  的前台 fix 期间编辑的用户仍可能产生混乱的提交；brief 仍要求只按名暂存
  agent 自己的文件（v1 第 9 节）。
- **打扰。** 被拒绝的轮次每个间隔重新提案同一批事件（决策 3）。本后续的
  v1 接受这一点：用户答"Not now"推迟、或"Stop watching"结束。snooze 间隔
  是一个开放问题（第 12 节）。
- **可达性。** 提案必须触及用户。durable、绑定会话的 daemon 任务让会话
  常驻；结束的终端会话带走其任务（如 worktree 模式）。用户离开时的有界
  等待机制是一个开放问题。
- **gate 成本。** gate 保持无模型且廉价；只有有待定事件的触发才耗一轮
  （提案）。安静的定时 in-place watch 不比安静的 worktree watch 更贵。

## 10. 验证计划

单元测试（同置，vitest）：

- `schedule`：in-place watch 可定时（打印任务、daemon 会话下 durable）；
  `authorCanPush: false` 仍拒绝；旧 state 原样可读。
- gate：in-place gate 报告待定事件而不推进 cursor；cursor 在处理时推进；
  安静的 gate 什么都不打印。
- `fix-start`：in-place 仍拒绝后台 fix。
- 工具：`schedule` 对 in-place 放行；`unattended` 仍拒绝。
- 回归：worktree 模式的全部测试原样通过。

E2E（计划在 `.qwen/e2e-tests/` 下）：scratch PR 上的定时 in-place watch；
带失败检查的触发提案并等待；"Not now"什么都不编辑、下次触发再提案；"Fix
it"跑前台轮次、push、reply、推进 cursor；触发时脏检出拒绝并询问；"Stop
watching"保留检出与分支并删除任务；随后对同一 PR 跑 worktree 模式行为与从前
完全一致。

## 11. 验收标准

1. `/autofix-pr <n> --in-place --every <n>` 启动一个带 durable、绑定会话
   任务的定时 in-place watch；确认说轮次编辑前先问；`--yes` 不跳过。
2. 有待定事件的触发在 fix agent 运行前先问；没有"Fix it"的回答就没有编辑。
3. "Not now"或无人应答的提案什么都不编辑、事件保持待定、下次触发重新提案。
4. "Fix it"在审批模式下跑前台轮次、push、reply，并把 gate cursor 推进到
   它已处理之处。
5. 触发时脏或分叉的检出停下询问；什么都不丢弃；用户的工作逐字节完好。
6. in-place watch 没有后台 fix、也没有 `unattended` 授权。
7. 所有既有 worktree 模式单元测试不经修改全部通过。
8. "Stop watching"、PR 合入/关闭、或 push 预算以 `cleanup` 结束 watch，
   保留检出与分支并删除任务。
9. 本设计双版与 SKILL.md 改动在同一个 PR 里交付。

## 12. 开放问题

1. **有界等待的提案机制。** 阻塞的 `ask_user_question` 轮次不能无限等待
   离开的用户。daemon 调度器是否支持用户稍后应答的通知、或一个让轮次推迟
   的轮次超时？实现前需要一次 daemon 调度器调查；不变量（无人应答 → 不
   编辑、事件待定）已定，机制未定。
2. **打扰控制。** 每个间隔重新提案（本提案） versus snooze（"一小时后再
   问"）。本后续的 v1 重新提案；snooze 选项是后续细化。
3. **干净 fast-forward 也要问吗？** 本提案让 `sync` 在触发时不问就
   fast-forward 干净检出（决策 4），把询问留给编辑。若用户更希望离开时
   分支不动，fast-forward 可由同一提案门控；本后续的 v1 保持 v1 的安全
   fast-forward。
