# `/autofix-pr --in-place --watch`：编辑前先问的定时轮次

[English](2026-10-31-autofix-pr-in-place-scheduled-ask.md) | [简体中文](2026-10-31-autofix-pr-in-place-scheduled-ask.zh-CN.md)

状态：已实现。日期：2026-10-31（更新于 2026-11-27）。

本设计为 [`/autofix-pr --in-place`](2026-10-30-autofix-pr-in-place-copilot.zh-CN.md)
（下称“v1 in-place 设计”，已随 #15929 合入）补上其第 12 节开放问题 1 留下的
后续：通过 `--in-place --watch`（或隐含 `--watch` 的 `--in-place --every <n>`）
开启编辑前先问用户的定时 in-place 轮次。下文引用“命令设计”的章节号均指
[2026-10-21-autofix-pr-command](2026-10-21-autofix-pr-command.zh-CN.md)；
引用“v1”的均指 v1 in-place 设计。

## 1. 问题

v1 in-place 是 once 形态：每一轮都是手动 `/autofix-pr <n> --in-place` 调用，
轮末即清理 watch。这安全——每轮都有人在场——但它要求用户自己记得在 CI 失败
或有可信评审者评论时跑一轮。共驾的收益（agent 在用户自己的检出里、用其已装
依赖工作）于是被“用户注意到 PR 需要处理”这件事卡住。

worktree 模式本就有定时轮次，但它的轮次从不提问（命令设计规则 4），其生命
周期靠隔离而破坏性安全：定时轮次可以 `reset --hard`、`clean`、丢弃 worktree，
因为 worktree 是 helper 自己的、绝不是用户的。这些在用户的检出里都不安全
——那里可能有第二个写者（用户）正在编辑。

缺口是一个兼具两者的模式：轮次像 worktree 模式那样定时触发，但每轮定时触发
时像 v1 in-place 那样在编辑检出前先问用户。v1 刻意没做这个（v1 第 5 节决策
1：“v1 不让两份契约混用”）；本设计就是那个后续。

## 2. 变更前现状

在本次变更前（`packages/cli/src/commands/autofix-pr/`、
`packages/core/src/skills/bundled/autofix-pr/SKILL.md`）：

- `schedule` 拒绝 in-place watch（`state.inPlace` → "its rounds run only
  when you ask … there is no scheduled task"）；`fix-start` 也拒绝（"its
  fixes run in the foreground … never in the background"）。skill 对同时给
  `--every` 与 `--in-place` 的启动在跑 `prepare` 之前就停下。
- `prepare --in-place` 拒绝任何已存在的同 PR watch（哪怕是同一检出里的
  in-place watch），因此 `resume` 与 `--take-over` 都不支持 in-place watch。
- worktree watch 的定时任务（`scheduledTask`）包含 cron 表达式、**gate**
  （`autofix-pr snapshot <n> --gate --session <id> --task <id>`，不经模型
  运行、只打印自 gate cursor 以来的变化）、以及 **prompt**（`Run
/autofix-pr tick <repo>#<n> …`，gate 报告有事可做时作为一轮交付给会话）。
  daemon 会话的任务是 `durable` 且绑定会话的（`sessionMode: "current"`），
  于是 daemon 让会话常驻、重启后重载任务。
- gate 在报告事件时推进其 cursor；轮次从 `snapshot` 读取完整未处理状态（比对
  对象是 `state.json`，不是 `gate.json`）。安静的 PR 不耗任何轮次。
- v1 in-place 的轮次：`sync` 对干净检出 fast-forward（共驾收益），对脏或
  分叉的回答 `synced: false`；fix agent 在检出里前台运行；每条会丢弃的路径
  都停下询问；轮末跑 `cleanup`，只删 watch 自己的文件。

以上任何一条都不改变 worktree 模式的既有行为。

## 3. 目标与非目标

目标：

- 为 `/autofix-pr` 增加 `--watch` 参数：
  - `--in-place --watch` 启动定时 in-place watch（默认每 2 分钟，可配
    `--every <n>`）。
  - `--in-place --every <n>` 自动隐含 `--watch`。
  - 单独 `--in-place`（或 `--in-place --once`）保持 v1 单轮行为。
  - 普通 worktree 模式（不带 `--in-place`）下，`--watch` 作为默认 watch 的
    显式同义写法被接受；`--once` 与 `--watch` 或 `--every` 组合在 `prepare`
    之前即报错停止。
- 每次定时触发或 `resume` 的 in-place 轮次**在 fix agent 编辑检出前先问用户**
  （`Fix it` / `Not now` / `Stop watching`），没有显式的 `"Fix it"` 回答就
  什么都不编辑。
- 无事可做的触发不耗轮次、也不提问（gate 保持廉价，如 worktree 模式）。
- 等待用户回复或用户选 `"Not now"` 时，绝不往会话 cron 队列堆积重复提示，也
  不每隔一个周期重复打扰；同时保持 `state.json` 不动，待下次有新 PR 事件或
  用户手动运行 `/autofix-pr <n> --in-place` 时，所有仍未处理的事项一并呈现。
- 支持同一检出下对定时 in-place watch 执行 `resume` 与 `--take-over`（同时
  仍严禁在 worktree 与 in-place 模式间静默切换）。
- v1 的安全原样成立：任何东西都不自动丢弃；脏或分叉的检出停下询问；fix
  只在前台。

非目标：

- 用户检出里绝不存在没有逐轮批准的自主编辑。in-place watch（无论是否定时）
  没有“fixes run without asking”，也没有 `unattended` 授权。
- in-place 不做后台 fix（如 v1，保持前台）。
- 不改 worktree 模式的定时轮次、gate 或生命周期。
- 不做新沙箱。暴露面即 v1 的（第 7 节），逐轮经同意。

## 4. 用户体验

```text
# 会话开在检出根目录、PR head 分支上、干净
/autofix-pr 123 --in-place --watch
/autofix-pr 123 --in-place --watch --every 5
/autofix-pr 123 --in-place --every 5        # 隐含 --watch
/autofix-pr 123 --in-place                  # 单轮（与 v1 一致）
/autofix-pr 123 --watch                     # 默认 worktree watch 的显式写法
```

定时 in-place 启动确认说明：

- fix agent 在这个检出里、前台、在会话审批模式下工作，用户可以与它并肩
  编辑；
- 立即先跑一轮有人值守的轮次，随后每 `<every>` 分钟定时检查（daemon 会话下
  durable 且绑定当前会话）；**每次定时轮次在编辑前都会先问**（`Fix it` /
  `Not now` / `Stop watching`），没有 `"Fix it"` 回答就什么都不编辑；
- 轮次 push 分支上超出 PR head 的全部内容——包括用户在 sync 与 push 之间
  自己做的提交——并在 PR 上回复（未传 `--no-reply` 时），使用用户自己的 git
  与 `gh` 身份；
- 任何东西都不自动丢弃：脏或分叉的检出停下询问；
- 选 `"Not now"` 什么都不编辑，watch 保持安静直到有新的 PR 事件到来（或用户
  手动运行 `/autofix-pr <n> --in-place`），届时仍未处理的事项会一并再次询问；
  `/autofix-pr stop 123`（或 `"Stop watching"`）结束 watch，保留检出、分支与
  历史。

选项只有 `"Start"` 与 `"Cancel"`——`--yes` 不跳过此确认，也没有 `"fixes run
without asking"`（第 3 节）。

随后，定时触发（或 `/autofix-pr resume` 的轮次）发现有事可做时，通过
`ask_user_question` 弹出**提案**：

```text
PR #123 — 2 failing checks, 1 trusted review thread.
Fix them in your checkout?  [Fix it] [Not now] [Stop watching]
```

- **Fix it** → 如 v1 跑一轮前台轮次（审批模式下的 fix agent、验证、`sync`、
  `push`、`reply`）。
- **Not now** → 什么都不编辑、不 push、不回复、不 `rerun`，且不修改
  `state.json`，让这些事项保留为未处理状态，待下次新 PR 事件或手动
  `/autofix-pr 123 --in-place` 时一并处理。
- **Stop watching** → `cleanup`（保留检出与分支）并删除定时任务。

无事可做的触发什么都不问、安静结束。触发时检出脏或分叉则如 v1 停下询问，
与提案回答无关。

## 5. 设计决策

1. **定时 in-place 轮次是一个提案，不是自主轮次。** 触发先跑只读/安全前缀
   （gate、干净检出的 `sync`、`snapshot`、`ci-log`），然后在写 brief、启动
   fix agent、重跑 CI、push 或回复之前通过 `ask_user_question` 询问。在定时
   或 `resume` 触发中，没有 `"Fix it"` 回答绝不编辑。
2. **两层同意。** 启动时的常设定时同意（第 4 节确认）加上定时/恢复轮次中任
   何编辑前的逐轮批准。两者都不可被 `--yes` 跳过；两者都不提供无人值守选项。
3. **复用现有推进式 gate cursor（零队列堆积、零重复打扰）。** 2026-10-31 原
   草案曾设想在轮次处理前不推进 gate cursor。实查
   `packages/cli/src/acp-integration/session/Session.ts`（`#enqueueCronPrompt`）
   与 daemon `permissionResponseTimeoutMs`（默认 `0`，等待人工应答）后确认：
   如果 gate 报告待定事件时不推进 cursor，只要 `ask_user_question` 尚未回复，
   每隔 `--every` 分钟就会再次吐出同一批事件并往 `cronQueue` 堆入重复 tick；
   用户选 `"Not now"` 后也会每 2 分钟被同一批事件反复打扰。

   因此最终实现原样复用 `snapshot --gate` 现有的推进式 cursor：
   - 每批新的 PR 变化只触发**一次**提案并推进 `gate.json`，等待回复期间及选
     `"Not now"` 之后的后续 tick 完全安静、零队列堆积。
   - 因为 prepared `snapshot` 始终将 GitHub 与 `state.json` 比对（而非
     `gate.json`），选 `"Not now"` 后这些事项在 `state.json` 中保持未处理。
     下次有任何新 PR 事件到来时，或用户随时手动跑 `/autofix-pr <n> --in-place`
     （会直接复用当前 in-place watch 而不会清理它）时，所有仍未处理事项都会
     自动一起列出。

4. **安全的 fast-forward 照跑；只有编辑才问。** 干净、可 fast-forward 的检出
   在触发时如 v1 照常 `sync`——不丢任何工作、让分支保持最新。脏或分叉的检出
   如 v1 拒绝并询问（v1 决策 5 不变）。
5. **同一检出下的 in-place watch 恢复与接管。** `prepare --in-place` 允许恢
   复当前会话在同一检出里已有的 in-place watch（带 `--take-over` 时可接管其
   他会话的），保留已记录的 watch 选项、历史与预算，且绝不触碰检出里的脏文件
   或本地提交。worktree watch、其他仓库、其他检出仍被拒绝——绝不静默切换模式。
6. **任务如 worktree 模式那样 durable 且绑定会话，并沿用 `tick` prompt 形态。**
   `scheduledTask` 生成 `Run /autofix-pr tick <repo>#<n> --task <id>
--in-place ...`，天然兼容 Web Shell 的 PR Watches 页面、Scheduled Tasks
   对话框（`parseAutofixPrTick`）以及 daemon 侧 PR watch 检测
   （`session-pr-watches.ts`），同时在 prompt 里显式标明 `--in-place`。

## 6. 具体改动

### 6.1 `schedule`（`packages/cli/src/commands/autofix-pr/schedule.ts`）

- 移除 `runSchedule` 中对 `state.inPlace` 的拒绝；`authorCanPush !== true` 的
  拒绝保留（非协作者 PR 任何模式都不允许 watch）。
- 当 `state.inPlace` 为真时，在 `scheduledTask` 的 `prompt` 中追加
  `--in-place`：`Run /autofix-pr tick <repo>#<n> --task <id> --in-place ...`。
- `--again` 在没有已记录任务时的错误提示对 in-place watch 指引使用
  `/autofix-pr <n> --in-place --watch`。

### 6.2 `prepare`（`packages/cli/src/commands/autofix-pr/prepare.ts`）

- 在 `runInPlacePrepare` 中通过 `redirectedAncestor` 拦住检出内被替换成符号链接的 `.qwen` 或 `.qwen/tmp`（与经典 worktree prepare 一致）。
- 允许 `runInPlacePrepare` 恢复同一检出里的已有 in-place watch（按实际找到的 watch 根目录 `where` 校验，而非可能陈旧的 `state.worktreePath`，使克隆目录移动后也可正常恢复），并在带 `--take-over` 时接管其他会话的 watch；重新校验 PR 资格（已合入/关闭时返回 `pr_closed`）、`authorCanPush`、remote、head 分支与 upstream 跟踪，同步刷新 `headRefName`、`baseRefName`、`branch`、`worktreePath`、`authorCanPush`、`remote`、`pushTarget` 与 `sessionId` 并重新确认 trust anchor，fetch 到私有引用 `paths.headRef` 以保证 `localCopy` 准确，且不触碰检出里的脏文件或超前提交（留给 `sync` 安全处理）。
- 继续拒绝：已有 worktree watch（禁止静默转换模式）、不同仓库、不同检出（兄弟 worktree）、以及未带 `--take-over` 的他会话 watch（`watched_elsewhere`）。
- 全新 `prepare --in-place` 保持 v1 全部前置条件（干净检出、位于或落后于 PR head），并在持锁后通过 `findWatchRoot(prNumber)` 关闭兄弟 worktree 并发竞态窗口。

### 6.3 `autofix_pr` 工具（`packages/core/src/tools/autofix-pr.ts`）

- 为 `prepare --in-place --take-over` 补充准确的 `startsWatchWarning` 提示。
- 更新 `in_place` 参数说明；`schedule` 对已确认的 in-place watch 放行，而
  `checkUnattendedWatch` 继续拒绝 `watch.inPlace === true` 的 `unattended`。

### 6.4 skill（`packages/core/src/skills/bundled/autofix-pr/SKILL.md`）

- 在 frontmatter、参数说明和冲突检查中加入 `--watch`（`--once` 与 `--watch`
  或 `--every` 冲突并在 `prepare` 前停止；`--in-place --every` 隐含 `--watch`；
  worktree 模式下 `--watch` 作为显式同义词）。
- 更新 Start 第 3–8 步、Round 第 1 与 第 8 步、In-place 节和 Resume 节：
  - 单轮 `--in-place` 保持 v1 行为（无定时任务，仅在本次启动新建 watch 时轮末
    清理）；
  - 定时 `--in-place --watch` 走排程、`--task`、在定时和恢复轮次编辑前询问
    `Fix it` / `Not now` / `Stop watching`、永不丢弃、永不后台/无人值守，仅
    在停止/耗尽 push 预算/`"Stop watching"` 时清理；
  - `resume` 通过 `prepare --in-place --take-over` 与 `schedule --again` 恢复
    定时 `inPlace: true` watch，绝不提供或调用 `unattended`。

### 6.5 gate、`fix-start`、Web Shell 与文档

- `snapshot.ts --gate`：无需修改——原样复用推进式 cursor 及会话/任务归属校验。
- `fix.ts`：无需修改——`fix-start` 继续拒绝 `state.inPlace`。
- `packages/web-shell/client/utils/autofixPrWatches.ts`：已能解析 `Run
/autofix-pr tick <repo>#<n> --task <id> --in-place ...`，在
  `autofixPrWatches.test.ts` 中补测钉住。
- `docs/users/features/autofix-pr.md`：补充 `--watch`、`--in-place` 及
  `--in-place --watch` 文档。

## 7. 信任模型

暴露面即 v1 in-place 的（v1 第 7 节）：fix agent 在用户检出里、在用户凭据
可及之处、在一个有人值守的会话里运行 PR 的代码。定时不扩大它，因为在定时或
恢复触发中，没有逐轮 `"Fix it"` 批准绝不会发生任何编辑（决策 1）：撞上用户
离开的触发停留在 `ask_user_question`，绝不自主编辑。非协作者 PR
（`authorCanPush: false`）仍禁止排程。其余一切——PR 内容作为数据、可信作者
分拣、brief 的 `## Never` 清单、push lease、只 fast-forward、默认分支拒绝、
push 预算——从 v1 与命令设计原样继承。

## 8. 受影响的文件

- `packages/cli/src/commands/autofix-pr/schedule.ts` 与 `schedule.test.ts`
- `packages/cli/src/commands/autofix-pr/prepare.ts` 与 `prepare.test.ts`
- `packages/cli/src/commands/autofix-pr/snapshot.test.ts`
- `packages/cli/src/commands/autofix-pr/chain.integration.test.ts`
- `packages/core/src/tools/autofix-pr.ts` 与 `autofix-pr.test.ts`
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` 与 `SKILL.test.ts`
- `packages/web-shell/client/utils/autofixPrWatches.test.ts`
- `docs/users/features/autofix-pr.md`
- `docs/design/2026-10-31-autofix-pr-in-place-scheduled-ask.{md,zh-CN.md}`

## 9. 约束与风险

- **两个写者、一棵树、一个定时器。** 触发到达时用户可能在编辑。干净检出
  fast-forward 与脏/分叉拒绝（v1）处理树的状态；逐轮批准处理编辑。在已批准
  的前台 fix 期间编辑的用户仍可能产生混乱的提交；brief 仍要求只按名暂存
  agent 自己的文件（v1 第 9 节）。
- **被推迟事项等待新事件或手动触发。** 由于 gate cursor 在提案时即推进（决策
  3），选 `"Not now"` 后会保持安静，直到 PR 出现新事件或用户手动执行
  `/autofix-pr <n> --in-place`。这是用“不自动反复弹窗”换取“零队列堆积、零
  打扰”的显式权衡。
- **可达性。** durable、绑定会话的 daemon 任务让会话常驻；终端会话结束则任务
  随之结束（如 worktree 模式），可用 `/autofix-pr resume <n>` 重新接管。
- **gate 成本。** gate 保持无模型且廉价；只有出现新变化时才耗一轮。

## 10. 验证计划

单元测试与集成测试（vitest）：

- `schedule.test.ts`：in-place watch 排程并在 tick prompt 中带 `--in-place`、
  daemon 会话下 durable；`--again` 保留 `--in-place` 与选项并换新 task id；
  无已记录任务时 `--again` 报错指引 `--in-place --watch`；`authorCanPush:
false` 仍拒绝。
- `prepare.test.ts`：恢复同检出已有 in-place watch 保留选项与历史且不触碰脏
  或超前提交；PR head 分支改名刷新 `headRefName` 与 `branch`；作者失权后刷新
  `authorCanPush: false` 并阻止 `schedule`；兄弟 worktree 锁内并发竞态被拒绝；
  移动克隆目录后重新确认 trust anchor 并刷新 `worktreePath`；`.qwen/tmp` 符号
  链接被拒绝；他会话无 `--take-over` 报 `watched_elsewhere`、带 `--take-over`
  接管成功；已关闭 PR 报 `pr_closed`；worktree watch、他仓库、兄弟检出仍拒绝。
- `snapshot.test.ts`：钉住 `buildGateSnapshot` 推进游标越过评论和失败检查
  （`"Not now"` 后后续 tick 安静）后，`buildSnapshot` 仍从原样保留的
  `state.json` 完整呈现这些延后项，并在新事件到来时合并列出。
- `chain.integration.test.ts`：定时 in-place watch 端到端链路（`prepare
--in-place` → `schedule` → 带 `--task` 的 `sync`/`snapshot`/`push`/`reply`
  → 已处理后 gate 安静、新评论只触发一次且不重复打扰而 `snapshot` 仍保留未处
  理评论 → 换会话 `prepare --in-place --take-over` + `schedule --again` →
  `cleanup` 保留检出与分支）。
- `autofix-pr.test.ts`：`prepare --in-place --take-over` 警告文案；经其假
  helper（`FAKE_IN_PLACE=1`）验证 `AutofixPrTool` 包装层为 in-place watch 记
  录 `schedule` 的 `watchTask` 同时继续拒绝 `unattended`（真实 helper 的
  `schedule` 放行由 `schedule.test.ts` 钉住）。
- `SKILL.test.ts`：`--watch`、`--once` 冲突、`--in-place --watch` /
  `--in-place --every`、逐轮 `ask_user_question` 提案、`resume` 传 `--in-place`
  且禁 `unattended`、禁 `--discard`。
- `autofixPrWatches.test.ts`：`parseAutofixPrTick` 正确解析带 `--in-place` 的
  tick prompt。
- 回归：`npm run build && npm run typecheck`，以及全部既有 `autofix-pr` 测试
  原样通过。

## 11. 验收标准

1. `/autofix-pr <n> --in-place --watch`（及 `--in-place --every <n>`）启动
   定时 in-place watch（daemon 会话下 durable 且绑定当前会话）；启动确认写明
   定时轮次编辑前先问；`--yes` 不跳过。
2. 不带 `--watch` 或 `--every` 的 `/autofix-pr <n> --in-place` 保持 v1 单轮行
   为；worktree 模式下接受 `--watch` 作为显式写法；`--once` 与 `--watch` 或
   `--every` 组合在 `prepare` 前即拒绝。
3. 定时或恢复的 in-place 轮次发现可处理事件时，在 fix agent 运行前先问
   （`Fix it` / `Not now` / `Stop watching`）；没有 `"Fix it"` 回答绝不编辑。
4. 选 `"Not now"` 什么都不编辑且不改 `state.json`；推进式 gate cursor 避免
   cron 队列堆积与反复弹窗，待下次新 PR 事件或手动 `/autofix-pr <n>
--in-place` 时未处理项仍会一并呈现。
5. 选 `"Fix it"` 在审批模式下跑前台轮次、push 并回复。
6. 触发时脏或分叉的检出停下询问；什么都不丢弃；用户的工作逐字节完好。
7. in-place watch 没有后台 fix、也没有 `unattended` 授权。
8. `/autofix-pr resume` 通过 `prepare --in-place --take-over` 与 `schedule
--again` 恢复定时 in-place watch，绝不提供无人值守选项。
9. `"Stop watching"`、`/autofix-pr stop <n>`、PR 合入/关闭或 push 预算耗尽以
   `cleanup` 结束 watch，保留检出与分支并删除任务。
10. 所有既有 worktree 模式测试原样通过；本设计双语版本与 `SKILL.md` 同步交付。

## 12. 已解决的开放问题

1. **离开用户时的等待机制（已由决策 3 解决）。** gate 在报告变化时推进 cursor，
   等待 `ask_user_question` 期间后续 tick 保持安静，绝不会向 `cronQueue` 堆积
   重复任务，也不会在用户离开时自主编辑。
2. **打扰控制（已由决策 3 解决）。** 提案即推进 gate cursor 消除了 `"Not now"`
   后的周期性重复弹窗，同时 `state.json` 保留未处理项以待下次新事件或手动
   `/autofix-pr <n> --in-place`。
3. **触发时的干净 fast-forward（已定案：保持 v1）。** `sync` 仍对干净检出无须
   询问地 fast-forward；只有编辑才问，脏或分叉检出停下询问。
