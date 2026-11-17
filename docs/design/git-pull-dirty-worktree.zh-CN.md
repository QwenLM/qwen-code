# Git pull 与脏工作树

[English](git-pull-dirty-worktree.md) | [简体中文](git-pull-dirty-worktree.zh-CN.md)

## 目标

让 Web Shell 的「Update Project」动作在工作区有未提交修改时也能成功，
而不是止步于一个不透明的 `dirty_working_tree` 错误、把用户赶回终端。

## 问题

工作区 git pull 路径（分支选择器弹层 → SDK `workspaceGitPull` →
`POST /workspace(s)/git/pull` → core `gitPull`）执行的是裸的
`git pull`。当本地修改落在传入 merge 会触碰的文件上时，git 拒绝
合并；路由早已把这种失败归类为 `409 dirty_working_tree` 并附路径脱敏
后的 git 消息，但弹层只渲染 SDK 的原始错误字符串，没有任何可操作的
出口。

## 行为

`POST /workspace/git/pull` 与 `POST /workspaces/:workspace/git/pull`
接受两个新的布尔选项（都默认 false，互斥——同时发送是 400）。它们是
用户在终端里会做的两件事，仅此而已：

- `stash`：fetch（`--prune`，因此早先被剪掉的跟踪 ref 在远端分支重新
  出现时会回来）、检查上游、`git stash push --include-untracked`、执行
  与以往相同的 `git pull`、然后恢复条目。若 pull 失败，它启动的 merge
  或 rebase 会被 abort，条目被恢复，工作区回到 pull 前的状态；响应是
  `409 pull_failed` 携带 git 的消息——没有什么可 stash 时亦然（被
  `skip-worktree` 藏起的编辑、分叉的干净树），让客户端展示 git 的原因
  而不是再次提供同一个解决方式。若 git 拒绝 stash 本身（intent-to-add
  条目、卡死的 index lock），则什么都没动，拒绝同样是 `409 pull_failed`。
  若 pull 成功但恢复失败（冲突，或 incoming 文件落在 stash 以未跟踪
  形式持有的路径上），响应仍是成功并带 `stashRestoreConflict: true` 与
  `stashSha`；git 保留条目，`output` 点名它。
- `force`：fetch（`--prune`）、检查上游、除非更新是 fast-forward 否则
  拒绝，然后 `git reset --hard` + `git clean -fd`（ignored 文件保留）再
  `git merge --ff-only <已校验的 sha>`。因为是破坏性的，一切都在丢弃
  之前校验：远端已删除的分支以 `409 pull_failed` 拒绝、什么都不丢弃；
  分叉的分支以 `409 diverged` 拒绝、本地修改仍完好。merge 按 SHA 集成
  被校验的那个确切提交：校验与 merge 之间落地的 push、或并发 fetch
  移动 `@{upstream}`，都不能把已校验的 fast-forward 变成丢弃之后的
  拒绝。当工作区 cwd 在仓库根之下时，`force` 被拒绝
  （`409 force_unsupported`），因为 `git reset --hard` 作用于整个仓库，
  会抹掉工作区之外的修改。

两个选项在 worktree 里停着 merge、cherry-pick、revert、rebase 或 am 时
都会被拒绝（`409 operation_in_progress`）：`git stash push` 与
`git reset --hard` 都会清掉这些状态——已解决但未提交的 merge 只存在于
`MERGE_HEAD` 里。探针紧挨着这两条命令各自执行，因此终端能在不被看见的
情况下停放操作的窗口就是命令本身。状态通过 `git rev-parse --git-path`
读取，链接 worktree 也能正确解析，名为 `MERGE_HEAD` 的分支不能遮蔽
它们。

失败恢复只 abort pull 自己创建的 merge 或 rebase，其归属来自 git：当
这种状态已经存在时，`git pull` 在触碰树之前就以 128 退出，因此退出码
1（git 尝试了集成并停在冲突上）之后存在的 merge 或 rebase 就是 pull
自己的。它还必须指向 pull 所集成的上游 tip。其余一切——终端期间停放
的 merge，无论其 tip 是什么——都原样保留，失败消息点名仍持有用户修改
的 stash 条目。恢复 helper 端到端尽力而为：探针或列表失败绝不会把一个
已恢复的状态变成未分类错误。

stash 条目按归属与 SHA 识别，绝不按位置：push 前后各取一次列表做
对比，选中的是 subject 以 auto-stash 标签加每请求 nonce 结尾的新条目
——因此即使本请求自己的 push 是空操作，也绝不会认领并发请求的条目；
多候选时 fail closed（期间落地的终端 push 排在它上面、原样不动；若
那次重新列表失败，拒绝消息按带标签的 subject 点名条目）；恢复是
`git stash apply <sha>`；drop 点名紧挨着它之前解析出的槽位，然后核对
git 报告为已 drop 的 SHA——git 没有按身份寻址的 drop——若槽位在其间
移动了，另一个条目会被 `git stash store` 回去，我们的条目报告为保留；
万一连那次 store 也失败，被挤位条目的 SHA 与把它找回的命令都在 output
里。每条关于保留条目的提示都携带其 SHA。store 回去的条目落在栈顶而不是
旧槽位——位置不是这里任何身份的一部分，output 会说明发生了什么——
因此依赖 `git stash pop` 顺序的终端应先读 `git stash list`。

裸 pull——不带选项——执行与以往完全相同的 git 调用；它的 `output`
现在与其他响应一样做路径脱敏。共享的路由分类器还匹配
`would lose untracked`（目录碰撞拒绝；见
[checkout 脏工作树设计](2026-11-15-web-shell-git-checkout-dirty-worktree.md)），
因此该形态在裸 pull 上也回 `409 dirty_working_tree`，而以往会落进
未分类的 500——以拒绝行落在路由的 512 字符客户端消息边界内为限：
宽松关键词分支读取的是截断切片，裸 pull 在多 ref 更新时的 fetch 摘要
可能把拒绝行挤出边界（那个角落仍是未分类 500，与文件碰撞关键词相同）。
三个选项互斥：`stash`+`force`、以及 `fetchOnly` 与任一组合，都以 400
拒绝，而不是静默丢掉其中一个。

## 非目标（刻意为之）

这些是功能的边界；每一条都是决定，不是遗漏：

- **尊重环境 git 配置，不覆盖。** pull 就是终端执行的那条 `git pull`，
  因此 `pull.rebase`、`pull.ff`、`merge.ff`、autostash 与签名设置完全
  按终端里的方式生效。策略让分叉的裸 pull 致命的主机，在这里得到同样
  的致命结果（已恢复，作为 `pull_failed`），附 git 自己的提示。
- **ignored 文件是可丢弃的，与 git 一致。** git 会静默地把 incoming
  文件检出到 ignored 路径上；终端的 `git pull` 与 `main` 上的裸 pull
  早已如此。解决流程不增加碰撞预检：一个对每种路径形态（改名、符号
  链接、大小写折叠、交叉 merge base、嵌套仓库）都正确的预检是对 git
  checkout 规则的重新实现，不是这个 UI 的功能。
- **不做跨请求串行化。** 同一仓库上的并发 pull 会在 git 自己的
  `index.lock` 上响亮地失败；基于归属的捕获、基于身份的恢复与带核对的
  drop 都 fail closed（条目保留、`stashRestoreConflict`、或把另一个
  条目 store 回去），而不是 apply 或 drop 别人的条目。任何交错下都不
  丢东西。
- **失败按 core 实际做了什么来分类，而不是匹配 git 的文本。** 新码来自
  `GitPullFailure`；路由里的正则分类与 checkout 路由共享，仍覆盖裸
  pull。它为目录碰撞拒绝新增了 `would lose untracked` 分支（见
  [checkout 脏工作树设计](2026-11-15-web-shell-git-checkout-dirty-worktree.md)）；
  stash 与 force 流程在分类器之前就把更新失败类型化，因此它们的响应
  不受该分支影响。

## UI

当裸 pull 以 `409 dirty_working_tree` 失败时，分支选择器 footer 从状态行
切换为解决面板，提供：

- **Stash Changes and Update** —— 以 `stash: true` pull。
- **Discard Changes and Update…** —— 破坏性，因此需要第二次点击：面板
  换成警告加确认按钮，以 `force: true` pull。
- **Cancel** —— 关闭面板。

面板在自己的 pull 在飞期间保持挂载（被点击的按钮上带 spinner），弹层
每次重开时重置，并被任何实际执行的竞争动作（checkout、push、有效的
新建分支提交）关闭。带 `stashRestoreConflict` 的成功渲染为警告，点名
持有修改的 stash 条目（`stashSha`）；该警告跨重开重置幸存，因为 pull
可能在弹层关闭期间落定，而它是用户得到的唯一信号。`force_unsupported`
拒绝让面板保持升起、用 daemon 的解释替换被阻塞的那一行，因为树仍然
脏、stash 仍然可用。其余每种拒绝——`pull_failed`、`diverged`、
`operation_in_progress`——渲染 daemon 的 `message`（携带 git 自己的
提示或 core 的解释），而不是 SDK 的路由标签。

SDK 的 `workspaceGitPull` 接受可选的每调用超时，让弹层可以超出客户端
默认的 fetch 预算：stash 流程的失败路径最多串起 16 条 git 命令、每条
各有 30s 上限，因此弹层允许 600s。

## 归属

两条路由保持既有作用域：legacy 路由是 legacy-primary-workspace 作用域；
限定路由照旧解析受信运行时与受包含的 `cwd`。新选项只改变在已解析工作区
内执行哪些 git 命令，不新增信任面。

## 考虑过的替代方案

每次脏 pull 自动 stash 被否决：静默地把用户的修改挪进 stash 令人意外，
而放弃选项是破坏性的，两者都需要显式选择。`git pull --autostash` 隐式
执行的正是同一种 stash-然后-恢复，因此未被采用。
