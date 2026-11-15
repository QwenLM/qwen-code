# Web Shell 脏工作树下的 git checkout

[English](2026-11-15-web-shell-git-checkout-dirty-worktree.md) | [简体中文](2026-11-15-web-shell-git-checkout-dirty-worktree.zh-CN.md)

## 目标

让 Web Shell 分支选择器的 checkout 在工作区存在未提交修改时也能完成，
而不是止步于一个 `dirty_working_tree` 错误、把用户赶回终端。这与 pull
路径已经提供的解决方式对齐（见 [Git pull with a dirty working tree](git-pull-dirty-worktree.md)）。

## 问题

工作区 git checkout 路径（分支选择器弹层 → SDK `workspaceGitCheckout` →
`POST /workspace(s)/git/checkout` → core `gitCheckout`）执行的是裸的
`git checkout <ref> --`。当本地修改或未跟踪文件会被切换覆盖时，git 拒绝。
路由已经把这两种拒绝形态都归类为 `409 dirty_working_tree`（分类器匹配
`dirty|uncommitted|would be overwritten`，覆盖 git 的 "Your local changes
… would be overwritten by checkout" 与 "The following untracked working
tree files would be overwritten by checkout"），但弹层只是把错误字符串
渲染在 footer 里——没有任何可操作的出口。

典型成因是早前工作的残留：上一个会话留下的编辑、或构建产生的新文件，
挡住了切换到另一个分支。pull 路径已经用 stash 或放弃两种解决方式回应同
样的拒绝；checkout 没有。

## 行为

`POST /workspace/git/checkout` 与 `POST /workspaces/:workspace/git/checkout`
接受两个新的布尔选项（默认均为 false，互斥——同时发送返回
`400 invalid_stash_force`；非布尔值返回 400）。它们就是用户在终端里会做
的两件事，仅此而已：

- `stash`：拒绝进行中的操作，`git stash push --include-untracked`
  （条目按来源识别，标签为 `qwen-code: auto-stash before checkout`），
  然后执行与裸路径相同的 checkout。若 checkout 失败，恢复该条目（按 SHA
  apply、带校验的 drop），响应为 `409 checkout_failed`，携带 git 的消息
  与条目下落——没有什么可 stash 时同样如此，让客户端展示 git 的原因，
  而不是重复提供同一个解决方式。若 git 拒绝 stash 本身（intent-to-add
  条目、卡死的 index lock），则什么都没动，拒绝同样是
  `409 checkout_failed`。成功时条目**保留**：切换分支是有意行为，把旧
  分支的修改恢复到新分支上不是"切换"的含义。响应携带 `stashSha`，弹层
  显示一条点名该条目的常驻警告，修改绝不会无声失踪。
- `force`：拒绝进行中的操作；当工作区 cwd 位于仓库根之下时拒绝
  （`409 force_unsupported`，因为强制 checkout 作用于整个仓库，会抹掉
  工作区之外的修改）；再次拒绝进行中的操作；然后执行与裸路径相同的
  checkout，**带 `-f`**；最后 `git clean -fd` 清理强制切换留下的未跟踪
  残留（ignored 文件保留）。刻意不做任何手写的 ref 预校验：
  `git checkout -f` 把「校验 ref」与「放弃已跟踪修改」合为一个原子步骤，
  读的是真实的 remote 配置、refspec 与 DWIM 规则，因此 git 拒绝的切换
  ——不可解析的 ref、歧义的 DWIM 名字、被另一个链接 worktree 占用的分支、
  skip-worktree 冲突、`checkout.guess` 关闭 DWIM——都不会动工作树，响应
  为 `409 checkout_failed`（"cannot discard and switch"），且未放弃任何
  东西。挡路的未跟踪文件由强制 checkout 本身覆盖。clean 在切换之后执行，
  因此由目标分支的 ignore 规则决定保留什么；切换成功后 clean 失败时为
  `409 checkout_failed`（"switched, but removing untracked files failed"）。

两个选项在 worktree 里停着 merge、cherry-pick、revert、rebase 或 am 时
都会被拒绝（`409 operation_in_progress`）：`git stash push` 与强制
checkout 都会清掉这些状态。探针紧挨着破坏性命令执行，状态通过
`git rev-parse --git-path` 读取，链接 worktree 也能正确解析——与 pull
流程使用的是同一道守卫。

裸 checkout——不带选项——执行与以往完全相同的 git 调用。响应层面的变化
是 stash checkout 成功时可选的 `stashSha` 字段，以及 auto-stash 未能恢复
的 `checkout_failed` 响应上携带的同名字段（见下文）。

失败按 core 实际做了什么来分类，而不是匹配 git 的文本：新的
`GitCheckoutFailure` 携带稳定码 `operation_in_progress`、
`force_unsupported` 与 `checkout_failed`，路由把它映射为 409 并附路径
脱敏后的消息，与它处理 `GitPullFailure` 的方式完全一致。共享 helper
（`refuseOperationInProgress`、`pushAutoStash`）增加一个动作词参数，
默认保持 pull 的措辞；`restoreStash` 原样复用，因为它的提示与动作无关。
既有的正则分类不变，仍覆盖裸 checkout。

## UI

当裸 checkout 以 `409 dirty_working_tree` 失败时，分支选择器 footer 从
状态行切换为 pull 拒绝所使用的同一个解决面板，文案换成 checkout 版本：

- **Stash 修改并切换** —— 以 `stash: true` checkout。
- **放弃修改并切换…** —— 破坏性操作，需要第二次点击：面板切换为既有的
  放弃警告（所有未提交修改，包括未跟踪文件，无法撤销）加一个确认按钮，
  以 `force: true` checkout。
- **取消** —— 关闭面板。

面板是与 pull 共用的一套机制：一个判别状态记住被挡的是哪个动作
（checkout 时还有目标 ref），按钮分发到对应的 handler。生命周期沿用
pull 面板：弹层每次重新打开时重置；任何真正执行的竞争动作都会关闭它；
请求在飞时被点击的按钮显示 spinner。`force_unsupported` 拒绝让面板保持
打开，用 daemon 的解释替换受阻提示行，因为树仍然是脏的、stash 仍然可用。
其余拒绝渲染 daemon 的 `message` 并关闭面板。携带 `stashSha` 的成功渲染
为点名条目与用户点击的 ref 的常驻警告；它能在重新打开的重置中幸存，因为
checkout 可能在弹层关闭期间才落定，而这是用户能得到的唯一信号。携带
`stashSha` 的 `checkout_failed` 响应（auto-stash 未能恢复）同样渲染为常驻
警告而非可消除的错误——此时保留的条目是修改的唯一记录。与 pull 流程一致，
失败的解决方式会不阻塞地重读分支列表与状态。

SDK 的 `workspaceGitCheckout`（legacy 与 workspace 限定两个方法）接受
选项以及可选的按调用超时，让弹层可以超出客户端默认的 fetch 预算：stash
流程的失败路径最多串约 14 条 git 命令、每条各有 30s 限制，因此弹层给到
600s，与 pull 的上限一致。

## 归属

两条路由保持既有作用域：legacy 路由是 legacy-primary-workspace 作用域；
限定路由照旧解析受信运行时与受包含的 `cwd`。新选项只改变在已解析工作区
内执行哪些 git 命令，不新增信任面。类型化失败与其余所有 git 响应走同一
套路径脱敏。

## 非目标（刻意为之）

这些是功能的边界；每一条都是决定，不是遗漏：

- **成功切换后不自动恢复。** stash 条目保留并被点名；把它恢复到新分支上
  是用户的决定（`git stash apply`），不是切换的副作用。
- **ignored 文件保留，与 pull force 流程一致。** `clean -fd` 删除未跟踪
  文件但不删 ignored 文件；不提供 `-x` 选项（它会删掉 `.env`、本地配置、
  依赖树）。ignored 的构建产物通常不挡 checkout；当目标分支恰好跟踪这样
  的路径时，git 自己的拒绝会浮现。
- **不做任何手写的 ref 或冲突预检。** 强制 checkout 让 git 自己决定切换
  能否发生，且与放弃原子同步；重新实现 git 的 ref 解析（remote 配置、
  refspec、DWIM、worktree 占用）的预检会在角落形态上与 git 分叉，可能为
  一次 git 随后拒绝的切换先放弃修改。这比 pull 设计的"不做冲突预检"更
  彻底：完全不重新实现 ref 校验。
- **子目录发起的 stash 不被拒绝，与 pull 流程一致。** 从仓库根之下
  `git stash push` 会收走全仓库的修改，切换也移动整个仓库——但没有任何
  东西被销毁：条目保留并被点名，修改可恢复。pull 设计出于同样原因只守卫
  其破坏性选项；在这里拒绝 stash 还会让面板在子目录工作区里提供一个永远
  失败的选项。
- **不做跨请求串行化。** 并发 git 操作会在 git 自己的 `index.lock` 上
  响亮地失败；按来源捕获、按身份恢复会 fail closed（条目保留），而不是
  apply 或 drop 别人的条目。
- **会话创建的脏树闸门与 Git Mode 不变。** session 路由里"为新会话创建
  分支"的闸门与 agent 驱动的 Git Mode 弹层保持当前行为。
- **不做独立的放弃按钮。** 解决方式在拒绝发生的地方提供；通用的"放弃
  本地修改"动作是可能的后续，不属于本次改动。

## 风险

- force 流程按设计就是破坏性的。缓解：两步确认、git 原子的「校验即放弃」
  （被拒绝的切换不放弃任何东西）、进行中操作拒绝、子目录拒绝、ignored
  文件按目标分支规则保留。
- 用户确认放弃时，同一 checkout 里并发的会话或终端可能丢失未提交工作。
  这与既有 pull force 流程的暴露面相同；显式确认就是闸门。是否增加活跃
  会话警告是下面的开放问题，不属于本次改动。
- 失败的 `post-checkout` hook 可能在 HEAD 已移动后拒绝。stash 流程恢复
  （或保留）条目并报告携带保留条目 SHA 的 `checkout_failed`；force 流程
  通过状态比较发现 HEAD 已移动，如实报告切换已完成。两者都与裸路径既有
  的 hook 行为一致。

## 验证计划

- core 单元测试，使用真实临时仓库：stash 成功保留条目并报告其 SHA；
  checkout 失败恢复条目，恢复失败则保留条目并报告其 SHA；intent-to-add
  条目类型化 stash 拒绝；force 放弃已跟踪修改与未跟踪文件（含目录）但
  保留 ignored 文件；force 对不可解析的 ref、歧义 DWIM 名字、git 无法
  解析的 tracking ref（无已配置 remote）、`checkout.guess` 关闭 DWIM、
  被另一 worktree 占用的分支、skip-worktree 冲突都在放弃前拒绝；force
  接受 git 接受的 DWIM 形态（裸名、斜杠名、remote-tracking ref）；拒绝的
  post-checkout hook 被报告为已完成的切换；子目录与进行中操作拒绝。
- 路由测试：选项校验（400）、类型化 409 映射、脱敏、恢复失败时转发
  `stashSha`。
- SDK 测试：请求体携带选项；超时被转发。
- 组件测试：脏 checkout 拒绝时面板出现、分发正确的选项、确认步骤就位、
  `force_unsupported` 时保持面板、在飞 spinner、竞争动作开始时关闭面板、
  保留 stash 的警告（成功与恢复失败）跨重开幸存。
- E2E（mock daemon，Playwright）：两种解决方式的完整面板流程。

## 验收标准

- 因本地修改被拒的 checkout 提供 stash 与放弃两种解决方式，且都能端到端
  完成切换。
- 裸 checkout 的调用与响应不变。
- 上文列出的每道守卫都有一个"没有它就失败"的测试。
- 设计文档双语齐备；lint、typecheck、build 与聚焦单测通过。

## 开放问题

- 同一 checkout 里有另一个活跃会话时，放弃是否应当警告（后续；pull
  force 流程今天也有同样的缺口）。
- 之后是否需要独立的"放弃本地修改"动作（后续）。
