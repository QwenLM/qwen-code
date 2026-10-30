# `/autofix-pr --in-place`：在用户自己的检出里人机共驾

[English](2026-10-30-autofix-pr-in-place-copilot.md) | [简体中文](2026-10-30-autofix-pr-in-place-copilot.zh-CN.md)

状态：提案并在同一改动中实现。日期：2026-10-30。

本设计为 [`/autofix-pr`](2026-10-21-autofix-pr-command.zh-CN.md) 增加第二种
工作模式。下文引用"命令设计"的章节号均指该文档。

## 1. 问题

`/autofix-pr` 永远在专属 worktree（`.qwen/tmp/autofix-pr-<n>`，分支
`qwen-autofix/pr-<n>`）里修复 PR。这份隔离是无人值守 watch 安全的根基，但它
不适合人机共驾——用户坐在会话里，与 agent 一起在 PR 分支上工作：

- watch 每 push 一次，用户自己的检出就落后一次；之后从那里 push 会被拒。
  skill 在启动时就警告了这一点，用户每轮之后都得手动 fetch、reset。
- 专属 worktree 没有 `node_modules` 等已安装状态；fix agent 要先付出一整套
  安装成本才能跑仓库的检查，而用户的检出里一切都是现成的。
- 用户看不到编辑的实时过程，无法中途插手，只能在 push 之后去 PR 上评审。

当会话的当前分支**就是** PR 的 head 分支时，直接在这个检出里工作能消掉以上
全部三个摩擦。而今天的 skill 恰恰在这种情况下——只要检出持有未推或未提交
的工作（`prepare` 的 `localUnpushedCommits`、`localUncommittedChanges`、
`localWorkUnknown`）——拒绝启动：它检测到了两个写者的冲突，然后退出。本设计
把这条拒绝缝变成一个显式的、经用户同意的共驾模式。

## 2. 现状

以下均按撰写时的实现核实
（`packages/cli/src/commands/autofix-pr/`、
`packages/core/src/skills/bundled/autofix-pr/SKILL.md`）：

- `prepare` 把 `refs/pull/<n>/head` fetch 进新建的 `qwen-autofix/pr-<n>`
  分支，然后 `git worktree add`。用户的检出永不被触碰（SKILL.md 规则 3）。
- watch 的生命周期按设计就是破坏性的：`sync --discard` 执行
  `git reset --hard` 加 `git clean -ffdq`（`sync.ts`）；带 `switchBack` 的
  `requireWorktree` 执行 `git switch --discard-changes`（`worktree.ts`）；
  一轮结束若没有 push，就丢弃 worktree 里的工作；`cleanup` 删除 worktree
  和分支。
- 轮次从不提问（SKILL.md 规则 4）：一次定时触发依次跑 `sync`、`snapshot`、
  fix agent（`unattended` 时在后台）、`push`、`reply`——不问任何问题。需要
  人裁决的事项变成 PR 上的 "Needs a human decision" 回复。
- 信任检查假定 linked worktree：`untrustedGitfile` 要求一个指向本 clone 自己
  的 worktree 条目的 gitfile；anchor store 与 `trustAnchor` 钉住真正的
  clone（`state.ts`、`worktree.ts`）。
- daemon shell guard 把会话的命令限制在它自己的工作目录内，所以从 linked
  worktree 准备的 watch 就落在那里（`watchRoot()`，设计
  [2026-10-29-autofix-pr-worktree-rooted-storage](2026-10-29-autofix-pr-worktree-rooted-storage.zh-CN.md)）。

以上任何一条都不得为现有 worktree 模式而改变。

## 3. 目标与非目标

目标：

- 一个显式的 `--in-place` 模式：fix agent 在用户自己检出的 PR head 分支上、
  前台、有人值守地工作。
- 用户的工作永不被销毁：worktree 模式的每一条破坏性路径都改为拒绝并询问
  用户。
- 用户实时看到编辑、可以与 agent 并肩修改、继续使用检出里已安装的依赖。
- push、reply、rerun、预算、历史与命令设计的信任规则在实质上保持不变。

非目标（v1）：

- 不做定时的 in-place watch：没有 cron 任务、没有后台 fix、没有
  `unattended` 授权。轮次只在用户调用 skill 时运行。
- 不自动切分支：模式要求 head 分支已经检出；skill 永不替用户检出分支。
- 不支持运行中切换模式：换模式意味着 `cleanup` 后重新 `prepare`。
- 不做沙箱。暴露面被明确说出并经用户同意（第 7 节）。

## 4. 用户体验

```
# 会话开在持有 PR 分支的检出根目录
/autofix-pr 123 --in-place
```

启动确认**替换** worktree 模式的确认 bullets，内容为：

- fix agent **在这个检出里**、前台工作，用户可以与它并肩编辑；
- 轮次 push 的是分支上超出 PR head 的全部内容——**包括用户在轮次的 sync
  与 push 之间自己做的提交**；
- 任何东西都不会被自动丢弃：脏的或分叉的检出会让轮次停下来询问；
- 没有定时任务；每次 `/autofix-pr <n> --in-place` 跑一轮，结束时的
  `cleanup` 保留检出和分支。

随后一轮照常运行——sync、snapshot、fix、verify、push、reply——除了 fix
agent 的 `working_dir` 是用户的检出、它永远在会话的审批模式下前台运行、
以及任何会丢弃工作的步骤都停下来问用户。

同时给 `--every` 与 `--in-place` 的启动会在跑 `prepare` 之前停下来并说明
（in-place 没有定时轮次）。`--yes` 不跳过启动确认（这份同意关乎用户自己的
树）。headless 运行被拒绝：共驾以人在场为前提。`--no-reply` 与自由文本
指令和 worktree 模式一样可用。

## 5. 设计决策

1. **只跑有人值守的手动轮次。** worktree 模式的核心契约是"轮次从不提问"；
   共驾的契约是"人在场、人裁决"。v1 不让两份契约混用：一次 in-place 调用
   是 `--once` 形态（prepare → 一轮 → cleanup，保留历史），`schedule`、
   `fix-start` 与 `unattended` 授权都拒绝 in-place watch。"编辑前先问"的
   定时 in-place 轮次是可能的后续，不在本次改动内。
2. **永不销毁用户的工作。** `sync --discard` 在 in-place 下直接拒绝；历史
   重写时的 reset 与脏工作树的 reset 都变成 `synced: false` 的回答；
   `requireWorktree` 永不替用户切回分支；`cleanup` 永不删除检出或分支。
   每条拒绝都说清用户下一步要做什么（commit、stash、切回、自行调和）。
3. **push 会带上用户的提交。** 在轮次的 sync 与 push 之间用户可能提交；
   push 发送分支上超出已知 head 的全部内容，仍受同一条 fast-forward lease
   保护。按作者过滤的方案被否决：git 作者身份不是边界，而共驾本就意味着
   一起 push。启动确认明说这一点。
4. **一个可选 state 字段。** `AutofixPrState.inPlace?: true`；缺省即
   worktree 模式。旧 state 文件原样可读；无迁移。`worktreePath` 记用户检出
   的 toplevel，`branch` 记 PR head 分支本身——不创建
   `qwen-autofix/pr-<n>` 分支。
5. **入口是一条收窄的、逐项检查的缝。** `prepare --in-place` 的任何前置
   条件不满足就拒绝（第 6.1 节）；它绝不试图把用户的检出"修"成符合条件。
6. **flag 名为 `--in-place`**（工具参数 `in_place`），加在 `prepare` 与
   skill 的启动参数上。它描述工作发生的位置，与 worktree 模式的"a worktree
   of its own"对称。

## 6. 提议的改动

### 6.1 `prepare --in-place`

新增检查，全部在写入任何东西之前，按此顺序：

1. **本 clone 中不存在该 PR 的 watch**（`findWatchRoot`），两种模式都算
   → 先 `cleanup`。模式切换也走这条路。
2. **会话位置。** daemon 下（`QWEN_CODE_SERVE=1`）采用与
   `assertSessionCanRunWorktree` 相同的包含规则，作用于检出：检出必须
   位于会话工作目录之内——对一个检出 toplevel 而言，这意味着会话必须开在
   **检出根目录**。非 daemon 下，cwd 位于检出之内即可。
3. **检出就是会话所在的仓库。** 从 cwd 跑
   `git rev-parse --show-toplevel` 得到它；cwd 落在子模块或别的仓库里
   时，remote 推断（没有唯一 remote 服务该 PR 的仓库）会在写入任何东西
   之前拒绝。
4. **head 分支已检出。** `symbolic-ref -q HEAD` 等于
   `refs/heads/<headRefName>`；detached HEAD 或别的分支一律拒绝（skill
   永不替用户切分支）。
5. **push 目标是命名 remote，且分支跟踪它。** git 只能跟踪
   `<remote>/<branch>`，永远不能是 URL：当本 clone 没有 remote 服务 head
   仓库（`pushTargetFor` 回退为 URL）时，拒绝信息给出可执行的步骤——添加
   一个 fetch 与 push URL 都指向 head 仓库的 remote，并把分支 upstream
   设为它。有命名 remote 时，upstream 必须是
   `<pushTarget>/<headRefName>`——与 `localCopy` 识别"用户自己的 head
   分支副本"用的是同一条约定。
6. **检出是干净的。** 采用 `checkoutHoldsWork` 的语义：带未跟踪文件的
   porcelain status，以 NUL 分隔（`-z`），使 C 转义的路径不会冒充用户
   工作；其中 `.qwen/tmp` 下的未跟踪 watch 文件不算。
7. **没有未推的本地提交。** 先 fetch `refs/pull/<n>/head` 进 watch 的私有
   ref `refs/qwen-autofix/pr-<n>/head`（在 `refs/heads` 之外，不动任何
   分支——不用 `FETCH_HEAD`，用户的并发 fetch 会在共享检出里覆写它），
   本地分支 tip 是 PR head 或其祖先。领先或分叉 → 拒绝并给出指引；落后
   的分支由第一轮的 `sync` fast-forward。`cleanup` 删除该私有 ref。

标准资格检查（PR 开放、push 权限、默认分支拒绝、`authorCanPush`）原样
适用。成功后 `prepare` 写入 state：`inPlace: true`、`worktreePath` = 检出
toplevel、`branch` = `headRefName`、`lastKnownHeadSha` = fetch 到的 PR
head——不建分支、不建 worktree。报告带 `inPlace: true`，供 skill 选择
in-place 的确认文案与轮次契约。

v1 没有 in-place 的 resume 或 take-over：in-place watch 没有定时任务，
`resume` 不会遇到它；遗留 state——包括崩溃轮次留下的——用 `cleanup`
清除。经典 `prepare` 遇到 in-place state 同样拒绝（模式不符），只指明
`cleanup` 这一条出路；该检查在首次读 state 时与 watch 锁下各跑一次，
因此经典调用的 GitHub 往返期间落地的 in-place 启动不会被静默转换成
worktree watch。

### 6.2 in-place 的 `sync`

- `--discard` → 拒绝："an in-place watch never discards the user's
  checkout"。
- 脏检出（在任何要移动它的步骤上）→ `synced: false`，reason 告诉用户去
  commit 或 stash；绝不建议 `--discard`。
- 历史重写（已知 head 不是新 PR head 的祖先）→ `synced: false`：作者重写
  了历史，由用户自行调和检出。worktree 模式那条干净树上的 `reset --hard`
  不运行。
- 干净且可 fast-forward → fast-forward 用户的分支（这正是共驾的收益：
  作者的 push 直接到达用户的检出），然后以 `keepWork = true` 对齐子模块
  ——持有工作的子模块原样保留；若因此树不干净，回答 `synced: false`。
- 有未推提交（轮次的、用户的、或两者）且新 head 在其上 → 与今天一样的
  `action: "merge"`；merge 在前台、在用户的检出里、有人值守地运行。

### 6.3 in-place 的 `push`

机制不变：只 fast-forward、以已知 head 为 lease、绝不推默认分支、跑
pre-push hook、`MAX_PUSHES` 预算。两个后果被写明，而不是用代码绕开：

- push 带上用户自轮次 sync 以来做的任何提交（决策 3）；
- `push` 仍拒绝有未提交改动的检出——轮次先请用户提交或搁置自己的编辑。

### 6.4 in-place 的 `requireWorktree` 与信任检查

- 分支检查保留：HEAD 必须在 `state.branch` 上。in-place 下永不执行
  `switchBack`——用户若在一轮中途切了分支，helper 拒绝，由用户自己切回。
- gitfile 检查按检出类型适配：linked worktree 原样沿用
  `untrustedGitfile`（信任根 = clone 的主 worktree）；clone 的**主**
  worktree 是 `.git` 目录，检查改为把该目录的内核解析路径（`realpath`）
  与从信任根解析出的本 clone git common dir 直接比较。不在被检树里跑任何
  git 命令——那会读到问题中的 config；toplevel 匹配是 `requireWorktree`
  之后单独的检查。`untrustedSubmodules` 原样适用。
- 符号链接祖先检查与 anchor 检查原样适用。

### 6.5 in-place 的 `cleanup`

结束 watch，只删 watch 自己拥有的东西：state 文件、其 tmp 产物与私有
head ref（`refs/qwen-autofix/pr-<n>/head`），历史与 gate cursor 的规则与
今天完全一致。绝不调用 `releaseWorktree`、绝不删分支；`--force` 只改变
所有权/可读性处理（外加被杀 helper 可能遗留的锁与非常规 gate cursor）
——绝不触碰树。回答报告 `removed: true` 与 `inPlace: true`；skill 的
"worktree 被保留"文案不适用（没有属于 watch 的东西可留）。"不能从里面
删自己"的守卫自然失效。

### 6.6 `schedule`、`fix-start`、`unattended`

- `schedule` 拒绝 in-place watch：轮次只在用户要求时运行。
- `fix-start` 拒绝 in-place watch：没有后台 fix。（`fix-end` 无需改动
  ——不可能存在可认领的 attempt。）
- `autofix_pr` 工具的 `unattended` 命令拒绝 in-place watch；`attended`
  与今天一样。

### 6.7 `status` 与 Web Shell

`status` 透传 `inPlace`。对 in-place watch，`worktreeWork` 描述的是**用户
的检出**；skill 将其报告为"你的检出持有工作"，而不是一轮的遗留。Web Shell
的 PR-watches 页面读同一份列表；它不得把 in-place watch 误报成 worktree
watch（透传该字段；徽章可选，实现时验证）。in-place watch 生命周期很短，
页面很少会显示它。

### 6.8 skill（`SKILL.md`）

- 参数：启动时的 `--in-place`；同时给 `--every` 与 `--in-place` 的启动
  在跑 `prepare` 之前停下来并说明（写成 agent 动作，而非被动承诺——没有
  任何 helper 会收到这个组合）。
- 规则 3 的例外："The user's working tree is never touched — except in
  an explicit `--in-place` start, where the user's checkout **is** the
  workspace, consented to at the start."
- 规则 4 的例外：in-place 轮次可以问用户；它天然有人值守。安静的 PR 上
  它仍然什么都不必问。
- Start：第 4 节的 in-place 确认；headless 拒绝；`--yes` 不跳过；
  `authorCanPush: false` 保留其现有的更严格确认，并额外说明代码将在用户
  自己的检出里运行。
- Round：每一条 `sync --discard` 路径（未验证的修复、被拒的 push、失败的
  merge、遗留的工作）都变成"停下来问用户保留什么"；fix agent 前台运行，
  `working_dir` = 检出；轮末的 `cleanup` 总会运行（once 形态）。
- Brief 模板：工作目录段落的 in-place 变体——该目录是用户的检出，与用户
  共享，用户可能并肩编辑——以及验证失败那句的变体（"轮次停下来问用户保留
  什么——什么都不丢弃"，而非"轮次会丢弃它"）；`## Never` 清单保留每一项
  （不 stash、不切分支、不写检出之外、不 push——由主会话 push）。
- Stop / Status / Resume：上述 in-place 文案；in-place watch 没有任务，
  `resume` 不会遇到它——遗留的 in-place state 用 `cleanup` 清除，下次
  启动重新 prepare。

### 6.9 `autofix_pr` 工具（core）

`prepare` 增加 `in_place` 参数（像 `take_over` 一样进 allowlist）；
confirmed-watch 记录从 prepare 报告增加 `inPlace`，reply plan 的位置检查
据此推导 plan 目录：in-place watch 的 plan 在 `<检出>/.qwen/tmp` 里，而
不在检出的旁边（其父目录）——后者是 worktree watch 的 plan 位置。
`unattended` 拒绝 in-place watch（6.6）。

## 7. 信任模型的差异

worktree 模式的隔离买来两样东西：用户的树永不被触碰，以及出错的轮次被
限制在 helper 拥有的目录里。in-place 经显式同意，刻意放弃两者：
fix agent **在用户的检出里、在用户凭据可及之处**运行 PR 的代码——这与
用户在一个有人值守的会话里直接让 agent 编辑该检出的暴露面相同。启动确认
把这一点说清；对作者无 push 权限的 PR（`authorCanPush: false`），现有的
更严格确认在此之上继续适用。

不变的部分：

- PR 内容是数据；可信作者决定处理什么反馈，永远不能扩大工具可做的范围
  （命令设计第 8 节）。
- brief 的 `## Never` 清单、push lease、只 fast-forward、默认分支拒绝、
  push 预算，以及 helper 对"推往 PR head 分支以外任何地方"的拒绝。
- git 层信任检查做适配（6.4）但目的不变：轮次不能把检出的 git 指向一个
  替身仓库再让 helper 为它背书。与命令设计一样，这是纵深防御，不是对抗
  同用户写入的边界。

变化的部分：破坏性生命周期被"拒绝并询问"取代（决策 2），于是一个混乱的
轮次对用户工作能做的最坏的事，是停下来问——而不是丢弃它。

## 8. 受影响的文件

- `packages/cli/src/commands/autofix-pr/prepare.ts` —— `--in-place` 入口
  检查与 state；报告字段。
- `packages/cli/src/commands/autofix-pr/sync.ts` —— in-place 拒绝与
  keep-work 子模块对齐。
- `packages/cli/src/commands/autofix-pr/worktree.ts` —— `requireWorktree`
  的 in-place 分支/gitfile 处理。
- `packages/cli/src/commands/autofix-pr/cleanup.ts` —— 只删文件。
- `packages/cli/src/commands/autofix-pr/schedule.ts`、`fix.ts` —— 拒绝。
- `packages/cli/src/commands/autofix-pr/state.ts` —— `inPlace` 字段。
- `packages/cli/src/commands/autofix-pr/status.ts` —— 透传。
- `packages/cli/src/commands/autofix-pr/push.ts` —— 逻辑不变；为"用户提交
  随行"补测试。
- 以上各文件的同置测试。
- `packages/core/src/tools/autofix-pr.ts`（若涉及 grants 则一并）与测试
  —— `in_place` 参数、`unattended` 拒绝。
- `packages/core/src/skills/bundled/autofix-pr/SKILL.md` —— 第 4、6.8 节。
- `packages/web-shell` 的 PR-watches 列表 —— 实现时验证透传。
- 本设计双版；E2E 测试计划在 `.qwen/e2e-tests/` 下。

## 9. 约束与风险

- **两个写者，一棵树。** fix agent 运行时用户可能在编辑。v1 的答案是
  在场加审批模式：用户看得到每一次编辑，`sync`/`push` 拒绝脏树而不是移动
  它。用户若在前台 fix 期间编辑，仍可能产生混乱的提交；brief 要求 agent
  只按名暂存自己的文件。
- **入口严格。** 要求检出干净且处于 PR head（或落后），意味着用户启动前
  必须 commit 或 stash。这是刻意的：模式绝不替用户调和其工作。
- **push 预算。** 每次 in-place 调用都是一个新 watch，因此 `MAX_PUSHES`
  按调用链计，与今天的 `--once` 相同；历史跨调用保留。
- **daemon 位置。** daemon 下会话必须坐在检出根目录；开在子目录的会话
  被拒绝，并告知应打开的目录（与 worktree 模式同样的 fail-closed 形态）。

## 10. 验证计划

单元测试（同置，vitest）：

- `prepare --in-place`：每条拒绝（错分支、detached、脏、领先、分叉、
  upstream 不符、daemon 子目录会话、已有 watch、别的 clone）都不留下任何
  写入；happy path 写入带 `inPlace` 的 state、不建分支不建 worktree，
  落后的分支留给第一次 sync。
- in-place 的 `sync`：`--discard` 被拒；脏 → `synced: false` 且不建议
  `--discard`；重写 → `synced: false`、分支不动；干净 fast-forward 移动
  分支；持有工作的子模块被保留。
- in-place 的 `requireWorktree`：主 worktree 的 gitdir 检查；linked
  worktree 的 gitfile 检查；别的分支 → 拒绝、绝不切换。
- in-place 的 `push`：sync 与 push 之间的用户提交在 lease 下随行；未提交
  改动被拒。
- in-place 的 `cleanup`：检出与分支不动，state 与 tmp 文件消失，历史
  保留；`--force` 对树没有区别。
- `schedule` / `fix-start` / `unattended`：拒绝 in-place watch。
- 回归：现有 worktree 模式的全部测试原样通过。

E2E（完整计划在 `.qwen/e2e-tests/autofix-pr-in-place-copilot.md`，
Phase 3）：一个 head 分支已检出在真实 clone 里的 scratch PR；一次有人值守
的 `--in-place` 轮次在用户检出里修好一个失败检查并 push；脏检出让轮次带着
问题停下且原样幸存；`cleanup` 后检出与分支完好；随后对同一 PR 跑 worktree
模式，行为与从前完全一致。

## 11. 验收标准

1. 在检出根目录、PR head 分支上、干净且处于 head 的会话里执行
   `/autofix-pr <n> --in-place`，在该检出里跑完一轮有人值守的轮次并
   push；全程检出保留其已安装依赖。
2. in-place watch 的任何代码路径都不对用户检出或分支运行 `reset --hard`、
   `clean`、`switch --discard-changes`、`worktree remove` 或 `branch -D`
   （单元测试覆盖）。
3. 脏的或分叉的检出让轮次带着一条指明用户下一步的拒绝停下；事后用户的
   工作逐字节完好。
4. `schedule`、`fix-start`、`unattended` 拒绝 in-place watch；不会为其
   创建 cron 任务。
5. in-place watch 的 `cleanup` 只删 watch 文件；检出、分支与用户的提交
   都在。
6. 所有既有 worktree 模式单元测试不经修改全部通过。
7. 设计双版与 SKILL.md 改动在同一个 PR 里交付。

## 12. 开放问题

1. "编辑前先问"的定时 in-place 轮次——手动模式验证成立后值得做后续吗？
   （v1：不做。）
2. `prepare` 是否应立即 fast-forward 落后的分支，而不是留给第一次
   `sync`？（v1：第一次 sync，让 `prepare` 本身不移动任何东西。）
3. Web Shell 的 PR-watches 页面需要 in-place 徽章，还是对一个只活一轮的
   watch 透传就够了？**实现时已验证：** daemon 路由以 rest-spread 透传
   status 的 watch（`autofix-pr-watches.ts`），`inPlace` 原样到达客户端；
   且该视图本就省略 `worktreePath`——不会把 in-place watch 误报成
   worktree watch。v1 不做徽章。
