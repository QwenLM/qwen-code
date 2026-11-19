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
路由把文件碰撞的拒绝形态归类为 `409 dirty_working_tree`（分类器匹配
`dirty|uncommitted|would be overwritten`，覆盖 git 的 "Your local
changes … would be overwritten by checkout" 与 "The following untracked
working tree files would be overwritten by checkout"），但弹层只是把
错误字符串渲染在 footer 里——没有任何可操作的出口。目录碰撞的兄弟形态
——"Updating the following directories would lose untracked files in
them"，未跟踪目录挡住目标分支以文件跟踪的路径——一个关键词都不命中，
落进未分类的 500，是同一类死胡同。

典型成因是早前工作的残留：上一个会话留下的编辑、或构建产生的新文件，
挡住了切换到另一个分支。pull 路径已经用 stash 或放弃两种解决方式回应同
样的拒绝；checkout 没有。

## 行为

`POST /workspace/git/checkout` 与 `POST /workspaces/:workspace/git/checkout`
接受两个新的布尔选项（默认均为 false，互斥——同时发送返回
`400 invalid_stash_force`；非布尔值返回 400）。它们就是用户在终端里会做
的两件事，仅此而已：

- `stash`：拒绝进行中的操作，`git stash push --include-untracked`
  （条目按来源识别：subject 为 `qwen-code: auto-stash before checkout`
  加一个每请求 nonce，因此即使本请求自己的 push 是空操作，也绝不会认领
  并发请求的条目），然后执行与裸路径相同的 checkout。若 checkout 失败
  且 **HEAD 未移动**，恢复该条目（按 SHA apply、带校验的 drop），响应为
  `409 checkout_failed`，携带 git 的消息与条目下落——没有什么可 stash
  时同样如此，让客户端展示 git 的原因，而不是重复提供同一个解决方式。
  若 `post-checkout` hook 在 **HEAD 已移动后**拒绝，切换已经完成：条目
  保留（恢复它会把旧分支的修改应用到新分支上），响应为
  `409 checkout_failed`（"switched, but the checkout reported a failure"），
  消息本身点名条目（置于 git 详情之前，避免被路由的长度上限截掉），并
  携带条目 SHA。push 成功之后（身份探针运行期间）停放的 merge 以
  `operation_in_progress` 拒绝，并在消息与 `stashSha` 中都点名保留的
  条目：此时树已干净，条目是修改的唯一记录。
  若 git 拒绝 stash 本身（intent-to-add 条目、卡死的
  index lock），则什么都没动，拒绝同样是 `409 checkout_failed`。成功时
  条目**保留**：切换分支是有意行为，把旧分支的修改恢复到新分支上不是
  "切换"的含义。响应携带 `stashSha`，弹层保持打开并显示一条点名该条目
  的常驻警告，修改绝不会无声失踪。只要条目 SHA 可知，`stashSha` 就随
  失败响应返回——不仅是 apply 失败，也包括恢复成功但列表读取或 drop
  失败的情形（恢复提示非空即意味着条目仍在栈上），以及 push 成功之后
  停放操作的拒绝（含守卫探针的原始失败——在那里被类型化，条目仍能
  到达客户端）。若 push 成功但 SHA
  从未获知（push 后的列表读取失败），则不发送 `stashSha`，消息以带标签
  的 subject 点名条目。
- `force`：当工作区 cwd 位于仓库根之下时拒绝
  （`409 force_unsupported`，因为强制 checkout 作用于整个仓库，会抹掉
  工作区之外的修改）；读取完成判定探针（HEAD 身份、已跟踪树的脏状态、
  以及一份 tracked-diff 快照）；
  把「拒绝进行中操作」作为破坏性命令前的最后一条语句；然后执行与裸路径
  相同的 checkout，**带 `-f`**；最后 `git clean -fd` 清理强制切换留下的
  未跟踪残留（ignored 文件按目标分支的 ignore 规则保留——仅在源分支被
  ignore 的文件在目标分支上是未跟踪残留，会被删除；见非目标）。刻意不做
  任何手写的 ref 预校验：`git checkout -f` 把「校验 ref」与「放弃已跟踪
  修改」合为一个原子步骤，读的是真实的 remote 配置、refspec 与 DWIM
  规则，因此 git 拒绝的切换——不可解析的 ref、歧义的 DWIM 名字、被另一个
  链接 worktree 占用的分支、skip-worktree 冲突、`checkout.guess` 关闭
  DWIM——都不会动工作树，响应为 `409 checkout_failed`
  （"cannot discard and switch"），且未放弃任何东西。挡路的未跟踪文件由
  强制 checkout 本身覆盖。`post-checkout` hook 可能在切换完成后拒绝；
  流程把完成归因到用户请求的目标，而不是只看树状态：HEAD 现在必须落在
  本次 checkout 会落到的位置——remote-tracking ref 对应去前缀的本地
  分支名（裸路径的重映射）、本地或 DWIM 创建的分支对应分支名本身、
  detached 目标（tag、SHA、完整 ref 如 `refs/heads/x`——git 对它们
  detach HEAD）对应该 ref 的 commit、`HEAD` 本身则要求完全未移动。
  在该归因之上，HEAD 身份（名字与 commit）改变、或已跟踪树见证到
  重置——由脏变净、或其对 HEAD 的 diff 改变——二者居其一：强制切换
  HEAD 已停留的目标会放弃修改但不改变身份，而拒绝的 hook 重新弄脏
  已跟踪文件虽让「树变干净」这一读数失效，用户的编辑却已从 diff 中
  消失（快照含 blob id），因此原地放弃仍被报告为已完成、残留照常
  清理。触碰前的拒绝让 diff 逐字节不变，绝不合格；只有 hook 把用户
  的编辑逐字节写回原样才不可区分，保守地报告为拒绝并保留残留。
  身份证据仅在前后两个探针都解析出 commit 时才被信任，diff 见证仅在
  前后两个 diff 探针都成功时才被信任，探针失败不能认证一次切换。
  因此并发行为者把 HEAD 移到别处，绝不会把触碰前的拒绝变成冒认的
  切换（行为者恰好落到请求的目标上、或在失败窗口内改写已跟踪文件，
  则与本次放弃不可区分——与下方并发会话风险同属已确认放弃的暴露
  面）。归因只是事后的：执行切换的权威仍是 git 自己的
  checkout，与 git 分叉的解析最多漏报一次已完成的切换，绝不会为被
  拒绝的切换放弃修改。完成臂清理
  残留并报告 `409 checkout_failed`
  （"switched, but the checkout reported a failure"）。clean 在切换之后
  执行，因此由目标分支的 ignore 规则决定保留什么。成功路径上 clean
  失败时为 `409 checkout_failed`
  （"switched, but removing untracked files failed"）；hook 拒绝后的
  完成臂里残留 clean 是尽力而为——其错误被吞掉，让 hook 拒绝保持为
  被报告的失败，残留可能幸存。

阻塞的未跟踪目录里、被当前分支已提交规则忽略的残留不会被保留：git 在
切换过程中自己丢弃挡路的 ignored 文件，两种解决方式皆然（已探针证实），
与文件碰撞形态完全一致。残留是否算 ignored，是在 stash 执行那一刻按
当前分支的规则判定的，而不是目标分支：当前分支不忽略的残留属于普通
未跟踪文件，会被 stash 条目收进去、在切换后幸存，可从响应点名的条目
里恢复——但在这一形态上，条目无法 apply 回切换后的树：`git stash apply`
无法在一个现在是普通文件的路径下重建被收走的路径，需按路径从条目里
取出（`git show <sha>^3:d/blocker.txt`）。保留条目提示里的 apply 指引
对文件碰撞形态仍然正确。force 解决方式仍会丢弃这类残留——挡路的未跟踪
文件被强制 checkout 本身覆盖。当忽略规则本身是一次未提交的 `.gitignore` 修改时，stash
会把规则一并收走：残留在 checkout 时刻是普通未跟踪文件，切换以目录
碰撞消息被拒绝，条目被恢复——没有任何东西被丢弃，也没有任何东西丢失
（已探针证实）。在完成的切换上，「你的修改被保留」覆盖的是条目所持的
内容；被一条幸存规则忽略的文件不在其中。

两个选项在 worktree 里停着 merge、cherry-pick、revert、rebase 或 am 时
都会被拒绝（`409 operation_in_progress`）：破坏性命令会吸收或扰动这些
状态——已解决但未提交的 merge 只存在于 `MERGE_HEAD` 里。探针紧挨着
破坏性命令执行（在只读的完成判定探针之后，因此探针运行期间停放的状态
仍会被拒绝），状态通过 `git rev-parse --git-path` 读取，链接 worktree
也能正确解析——与 pull 流程使用的是同一道守卫。stash 流程里此时 push
已经发生，因此这道 push 后的拒绝会点名保留的条目（消息与 `stashSha`）；
push 前的守卫不 stash 任何东西。

裸 checkout——不带选项——执行与以往完全相同的 git 调用。响应层面的变化
是 stash checkout 成功时可选的 `stashSha` 字段、auto-stash 条目存活且
SHA 可知的失败响应上携带的同名字段——保留恢复后的 `checkout_failed`、
或 push 之后停放 merge 的 `operation_in_progress`（见下文）——以及目录
碰撞拒绝：共享分类器以往回未分类的 500，现在回 `409 dirty_working_tree`，
裸 checkout、建分支与裸 pull 皆然——以拒绝行落在客户端消息边界内为限
（见下文）。

失败按 core 实际做了什么来分类，而不是匹配 git 的文本：新的
`GitCheckoutFailure` 携带稳定码 `operation_in_progress`、
`force_unsupported` 与 `checkout_failed`，路由把它映射为 409 并附路径
脱敏后的消息，与它处理 `GitPullFailure` 的方式完全一致。共享 helper
（`refuseOperationInProgress`、`pushAutoStash`）增加一个动作词参数，
默认保持 pull 的措辞；`restoreStash` 原样复用，因为它的提示与动作无关。
分类器为目录碰撞拒绝新增了 `would lose untracked` 分支；其余分支不变。
分类器为所有工作区 git 路由共享，因此凡 git 裸错误能到达之处，该分支
都会把这一拒绝形态归类——裸 checkout、建分支（`checkout -b`）与裸
pull 皆然；stash 与 force pull 流程在分类器之前就把更新失败类型化，
它们的响应不变。宽松关键词分支读取的是 512 字符的客户端截断切片，
因此被挤出该边界的拒绝仍是未分类 500——裸 pull 在多 ref 更新时的
fetch 摘要就可能造成这一点，与文件碰撞关键词一向共有的角落相同。

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
为点名条目与用户点击的 ref 的常驻警告，并**保持弹层打开**，让警告立即
绘制——在同一次更新里关闭会隐藏「修改去了哪里」的唯一记录（pull 流程
出于同样原因保持打开；裸 checkout 保留成功即关闭的契约）。该警告也能在
重新打开的重置中幸存。任何携带 `stashSha` 的失败响应（auto-stash 条目
存活——保留恢复后的 `checkout_failed`、或 push 之后停放 merge 的
`operation_in_progress`）都同样渲染为常驻警告而非可消除的错误——此时
保留的条目是修改的唯一记录。与 pull 流程一致，失败的解决方式会不阻塞地重读
分支列表与状态。该提示与 pull 流程的一样存在于组件状态中：刷新页面会
丢失它，条目仍可凭带标签的 subject 从 `git stash list` 找回。

SDK 的 `workspaceGitCheckout`（legacy 与 workspace 限定两个方法）接受
选项以及可选的按调用超时，让弹层可以超出客户端默认的 fetch 预算：stash
流程的失败路径最多串约 18 条 git 命令、每条各有 30s 限制，因此弹层给到
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
- **ignored 文件按目标分支的规则保留，而非源分支的。** `clean -fd` 在
  切换之后执行，删除未跟踪文件但不删 ignored 文件；不提供 `-x` 选项
  （它会删掉 `.env`、本地配置、依赖树）。仅在源分支被 ignore 的文件在
  目标分支上是未跟踪残留，会被删除——确认文案（"所有未提交修改，包括
  未跟踪文件"）覆盖它；而把 clean 移到切换之前不可行：那会为一次 git
  随后拒绝的切换先销毁未跟踪文件。另外，当目标分支**跟踪**某个存放着
  本地 ignored 文件的路径时，`git checkout` 会用提交里的内容静默覆盖该
  文件（git 默认的 `--overwrite-ignore`）；它不会拒绝，两种解决方式也都
  保不住该 ignored 内容——stash（`--include-untracked`，绝不用 `--all`）
  不捕获 ignored 文件。这是 git 裸 checkout 自身的行为，原样继承。
- **不做任何手写的 ref 或冲突预检。** 强制 checkout 让 git 自己决定切换
  能否发生，且与放弃原子同步；重新实现 git 的 ref 解析（remote 配置、
  refspec、DWIM、worktree 占用）的预检会在角落形态上与 git 分叉，可能为
  一次 git 随后拒绝的切换先放弃修改。唯一确实执行的映射是裸路径既有的
  `runCheckout` remote-tracking 重映射（点击的 `origin/dev` 在本地 `dev`
  存在时解析到它，否则创建跟踪分支）：它是既定的 fork 布局契约，不是
  新增校验。`force` 下跟踪分支先用 `git branch --track` 绑定，再强制
  checkout 新建的本地分支——`checkout -f --track` 会先改写工作树、之后
  才在 git 无法建立跟踪绑定（陈旧 remote-tracking ref）时失败，留下
  半切换的树；先绑定则在任何放弃之前无害地失败。裸路径保持其历史上的
  精确调用。
- **子目录发起的 stash 不被拒绝，与 pull 流程一致。** 从仓库根之下
  `git stash push` 会收走全仓库的修改，切换也移动整个仓库——但没有任何
  东西被销毁：条目保留并被点名，修改可恢复。pull 设计出于同样原因只守卫
  其破坏性选项；在这里拒绝 stash 还会让面板在子目录工作区里提供一个永远
  失败的选项。
- **不做跨请求串行化。** 并发的 git 操作——checkout 与 stash 取 git 自己的
  `index.lock`，建分支取其 ref 与 config 锁——都会响亮地失败；残留
  `clean -fd` 两把锁都不取（已探针证实），因此并发 clean 在文件本身上
  竞争——与并发会话风险同属已确认放弃的暴露面。stash 捕获在条目 subject 里携带每请求 nonce（文档化的标签
  保留为其前缀），因此当本请求自己的 push 是空操作——因为并发请求先把
  树 stash 了——它什么都不会认领、也不报告条目；按身份恢复绝不会 apply
  或 drop 别人的条目。pull 流程共用该 helper 与同一保证。
- **子模块工作树不被触碰。** git 自己的 checkout 与 stash 不带
  `--recurse-submodules` 就不递归进子模块，两种解决方式也都不传它：
  脏子模块在强制切换后幸存（并可能让已完成切换后的树仍脏——完成判定
  见证会处理），其修改也绝不会被 stash。残留 clean 从不删除子模块内容。
- **skip-worktree 保留 git 自己的保护。** 跨分支的强制 checkout 在
  skip-worktree 条目被编辑时拒绝（触碰前拒绝见证已覆盖）；原地强制
  checkout 报告 git 的成功、被保护文件原样不动——git 自己的 `-f` 在
  原地尊重 skip-worktree，流程不覆盖它。
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
- 失败的 `post-checkout` hook 可能在 HEAD 已移动后拒绝。stash 流程通过
  前后 HEAD 的分支身份（名字与 commit）发现已完成的切换，保留条目（绝不
  把它应用到新分支上），并报告在消息与 `stashSha` 字段中都点名条目 SHA
  的 `checkout_failed`。任何 HEAD 移动都保留条目：没有破坏性步骤依赖
  「把移动归因到本次调用」，而把条目恢复到已移动的 HEAD 上才是危险所在。
  force 流程则以「切换归因到请求的目标」作为执行残留 clean 的前提
  （见「行为」），
  以身份改变、或已跟踪树由脏变净／diff 改变作为完成见证——因此强制切换 HEAD 已停留
  的目标（身份不变）仍被报告为已完成的放弃；而并发行为者把 HEAD 移到
  别处、或身份探针失败，绝不会把触碰前的拒绝变成冒认的切换。hook 留下
  强制 checkout 不会重置的脏，不会降格已完成的切换：身份会变化的移动
  由身份见证，原地放弃由 tracked-diff 改变（或由脏变净）见证；残留
  clean 照常执行，hook 自己的改写保留（那是 hook 所为，不是用户的
  未提交工作）。只有原地放弃时 hook 把用户的编辑逐字节写回原样，
  才保守地报告为拒绝（见「行为」）。

## 验证计划

- core 单元测试，使用真实临时仓库：stash 成功保留条目并报告其 SHA；
  checkout 失败恢复条目，恢复失败则保留条目并报告其 SHA；干净 apply 后
  drop 失败仍报告存活条目的 SHA；拒绝的 post-checkout hook 保留条目并
  报告已完成的切换（stash 与 force，含目标在当前 commit 的情形；force
  另含 HEAD 已停留的分支、以及 `HEAD` 本身）；干净树上的 stash checkout
  遇 hook 拒绝报告已完成切换且不点名条目；完成切换的消息点名条目；
  push 成功后停放的 merge 在拒绝中点名保留的条目（消息与 `stashSha`）；
  触碰前拒绝期间并发行为者移动 HEAD 不被冒认为本次切换——含仅未跟踪
  脏的树（此时由脏变净的见证不可用）；前置探针失败不认证任何切换，
  即使行为者恰好落到请求的目标上；`checkout -f HEAD` 被拒期间并发
  行为者移动 HEAD 时保留编辑与残留（原地目标必须完全未移动）；
  失败的前置 diff 探针不被信任，而两个 diff 探针都失败但 hook 留下
  干净树时，由脏变净见证仍承载已完成的原地放弃；
  拒绝的 hook 改写已跟踪文件后仍报告
  已完成切换并清理残留；仅未跟踪脏遇 hook 拒绝经身份见证判定完成；
  原地放弃（当前分支与 `HEAD`）遇拒绝的 hook 重新弄脏已跟踪文件仍
  报告已完成放弃并清理残留；当前分支的触碰前拒绝保留编辑与残留
  （仅凭脏树认证不了任何事）；
  detached 目标（tag）遇 hook 拒绝报告已完成切换，完整 ref
  （`refs/heads/x`，detached）与 remote-tracking ref（在重映射的本地
  分支上完成）同样如此；完成判定探针运行期间停放的 merge 仍被拒绝；自身 push 为空操作时绝不认领并发请求的
  带标签条目；intent-to-add 条目类型化 stash 拒绝；stash 让 ignored
  文件留在磁盘且不进条目（`--include-untracked`，绝不用 `--all`）；
  force 放弃已跟踪修改与未跟踪文件（含目录）、按目标分支规则保留
  ignored 文件、并删除仅在源分支被 ignore 的文件；force 带 `-f` 到达
  remote 重映射的「本地分支已存在」臂；切换后残留 clean 失败被类型化；
  force 对不可解析的 ref、歧义 DWIM 名字、git 无法解析的 tracking ref
  （无已配置 remote）、`checkout.guess` 关闭 DWIM、被另一 worktree 占用
  的分支、skip-worktree 冲突都在放弃前拒绝；force 接受 git 接受的 DWIM
  形态（裸名、斜杠名、remote-tracking ref）；git 无法建立跟踪绑定的
  陈旧 remote-tracking ref 在任何放弃之前拒绝（先绑定后放弃）；数 MB
  的已跟踪 diff 仍见证原地放弃（流式哈希，无缓冲上限）；信任守卫的
  后置半边各有见证（后置 status／diff／身份探针失败不认证任何事）；
  完成臂被吞掉的 clean 失败让 hook 拒绝保持为被报告的失败；空操作
  push 后的停放操作拒绝不点名条目；push 后守卫探针的原始失败仍点名
  保留的条目；原地放弃不触碰 skip-worktree 编辑（git 自己的保护）；
  子目录与进行中操作拒绝。
- 路由测试：选项校验（400）、类型化 409 映射、由携带绝对路径的
  linked-worktree 拒绝见证脱敏、post-checkout hook 在切换后拒绝时转发
  `stashSha`。
- SDK 测试：请求体携带选项；超时被转发。
- 组件测试：脏 checkout 拒绝时面板出现、分发正确的选项、确认步骤就位、
  `force_unsupported` 时保持面板、在飞 spinner、竞争动作开始时关闭面板、
  stash 成功时保持弹层打开并立即绘制保留 stash 的警告、stash 成功与
  保留条目的失败解决之后一并重读分支列表与树状态（两半各有见证：提示
  不再报告未提交修改、两个 RPC 计数都增长、行列表跟随真正的切换后
  列表）、保持弹层打开的 stash 成功通知 `onBranchChanged`、裸 checkout
  成功即关闭弹层、放弃 checkout 在飞时确认按钮带放弃 spinner 保持
  busy、站立面板重定向到第二个被拒分支、重开时丢弃站立的 checkout
  面板、该警告（成功与恢复失败）跨重开幸存。
- E2E（mock daemon，Playwright，带 `@smoke` 使 PR CI 运行）：两种解决
  方式的完整面板流程、保留条目警告立即可见且跨重开幸存、取消路径。

## 验收标准

- 因本地修改被拒的 checkout 提供 stash 与放弃两种解决方式，且都能端到端
  完成切换。
- 裸 checkout 的调用不变；目录碰撞拒绝的响应从无分类 500 变为
  `409 dirty_working_tree`——凡 git 裸错误到达共享分类器的路由皆然：
  裸 checkout、建分支与裸 pull——以拒绝行落在路由的客户端消息边界内
  为限。
- 上文列出的每道守卫都有一个"没有它就失败"的测试。
- 设计文档双语齐备；lint、typecheck、build 与聚焦单测通过。

## 开放问题

- 同一 checkout 里有另一个活跃会话时，放弃是否应当警告（后续；pull
  force 流程今天也有同样的缺口）。
- 之后是否需要独立的"放弃本地修改"动作（后续）。
