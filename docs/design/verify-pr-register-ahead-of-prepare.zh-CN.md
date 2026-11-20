# verify-pr：把 watch 轮注册提前到 prepare 之前（R17-2 活性）

语言：中文 | [English](verify-pr-register-ahead-of-prepare.md)

跟踪 issue：#17371（#17185 的 land-with-residual-risk 决定所接受的残余风险）。
本改动闭合 **R17-2**——issue「报告完整性 / 本地正确性 / 文档 / 活性」层最后一个
开放项。核心信任边界残余 R17-1 已由 #17375 闭合（根感知围栏 + 硬链接别名检查 +
sha256 内容绑定，由 `R17-1 / R2-1 trust-boundary witnesses` 套件见证）；
R16-1/R16-2/R16-4 与 D17-1…3 已由 #17440 闭合。R17-2 是活性/可用性缺口，非攻击者可控。

## 问题陈述与现状

watch 契约在 prepare **之后**注册轮次。prompt（`.qwen/skills/verify-pr/SKILL.md`）
写「先跑 prepare（受信宿主元数据），再用 `verify-pr-watch-state.mjs <n> --start
--head <headSha> --round <r> --artifact-dir <dir> --repo <owner>/<repo>` 注册轮次」，
其中 `<dir>` 是 **prepare 打印的**产物目录。`parseArgs` 强制此顺序：`--start` 不带
`--artifact-dir` 是 usage 错误（`scripts/verify-pr-watch-state.mjs`，
`if (out.start && !out.artifactDir)`）。

探针游标（`autofix-pr snapshot --gate`）在 head-move 事件**投递**给模型时前进——
早于 prepare。故顺序为：

1. 游标前进（head 已投递）；
2. prepare 运行（宿主元数据，创建产物目录）；
3. `--start` 注册 head 在飞；
4. 电池；
5. `--complete` 登记判定。

会话**在 prepare 窗口内被杀**（步骤 1 后、步骤 3 前）使已投递 head **无状态**：
游标已越过它，故无第二次事件，也无在飞标记记录该 head 曾投递。head 被静默丢弃——
即便下一次 head move 也无法恢复，因为新 head 的 `--start` 看不到阻塞者，被丢的
head 不留痕迹。这朝不认证方向失败（head 永远得不到轮次），即 R17-2 所指活性缺口。

## 拟议改动

把轮次注册**提前到 prepare 之前**，使 prepare 窗口内被杀留下可恢复的在飞标记，
而非静默丢弃。

### watch-state 助手（`scripts/verify-pr-watch-state.mjs`）

- `parseArgs`：去掉 `--start requires --artifact-dir` usage 错误。`--artifact-dir`
  在 `--start` 上变为**可选**（给了就存，否则 `null`）。空值/无值拒绝保留。
  `--start --artifact-dir <dir>` 仍被接受，故既有调用方不受影响。
- `completeRound` 的目录解析不变（`dir = artifactDir ?? ownFlight?.artifactDir ??
prior?.artifactDir ?? null`——标记优先，再先前判定，再无），但本 PR **在其返回值
  加 `artifactDir: dir`** 以便 CLI 披露 null，并**在 `main()` 加告警分支**：非
  inconclusive 完成解析不到目录时触发（R1-3）。`--complete --artifact-dir <dir>`
  记录 prepare 打印的目录；省略目录回退到标记（start 带了目录时）或先前判定。
- HELP：`--start` 概要标记 `--artifact-dir` 可选，并说明注册先于 prepare、目录在
  `--complete` 记录；回退段写明完整链（标记→先前判定→无）。

产物目录为 `null` 的在飞条目本就是合法形状（遗留 `inFlightHead` 迁移即产出其一），
故去重、deferral、release 与 resting-view 守卫均不变。

### Skill 契约（`.qwen/skills/verify-pr/SKILL.md`）

watch prompt 与手动复验步骤均改为：

1. **先注册**：`verify-pr-watch-state.mjs <n> --start --head <H> --round <r>
--repo <owner>/<repo>`（不带 `--artifact-dir`——prepare 尚未运行）。
2. **prepare**：跑受信 prepare 块；它创建并打印产物目录 `<dir>`。
3. **电池**在 `<dir>`。
4. **完成**：`verify-pr-watch-state.mjs <n> --complete --head <H> --round <r>
--verdict <word> [--artifact-dir <dir>] [--comment-id <id>] --repo <owner>/<repo>`
   ——目录在此记录（可选：重放完成省略它以继承已记录的目录）。

新职责：因标记现在先于 prepare 存在，**`--start` 后 prepare 失败**按轮次状态恢复。
*瞬时*失败（轮次仍在运行）时标记完好——prepare 从不读 watch 状态——故直接对完好
标记重试 prepare 并按原轮次完成，无需 release（第 7 轮）；先 release 会使 head 在
release 与重启之间失去记录，若在该窗口被杀则重新打开静默丢弃。*已死*的轮次用
`--release --head <H> --round <r> --repo <owner>/<repo>` **并随后重新启动该
head**（`--start --head <H> --round <r+1> --repo <owner>/<repo>`）再重试 prepare。
单独 release 不是恢复：`releaseRound` 只写 `releasedHeads` 推序提示——明确不是
deferral，且无任何动词打印它——故 head 失去记录，而探针游标已越过它，不会再有
触发投递它（R1-1 第 2 轮）。release 必须与重启成对，正如本文件死轮段落把两者
成对写出。`--start` 记录 repo 后两者 `--repo` 必填；每个动词都对已记录 repo 拒绝
省略 `--repo`）。用 `--release` + 重启，**而非** `--complete inconclusive`：
inconclusive 是唯一增加 head 重试计数的判定，而计数上限即终态（not-covered），
故两次瞬时 prepare 失败会让一个从未跑过轮次的 head 被退役（R1-5）。重启后的轮次
编号（`<r+1>`）即为本轮编号，`--complete` 须重复该值（R3-2）。恢复有非瞬时终止
分支：若 prepare 因点名的 head 不是本轮注册的 head 而拒绝——前移或 force-push；
prepare 从实时 `gh pr view` 重取 `headRefOid`、精确相等判定、不含顺序信息——注册的
head 永远无法 prepare：`--release` 它（带标记的 `--round`）且**不要**重启（R9-1
第 10 轮把此分支从「越过/更新」扩到任何不同的 head，故强推回祖先也能落到该分支）。
watch prompt 中实时 head 由下一次触发投递（gate 游标跟实时 head，
`next.headSha = pr.headRefOid`），或已在 release 打印的 deferred 列表中、由你启动
——所启动的 head 自成一轮，`--complete` 重复它的 head 与轮次，而非被释放 head 的
（第 7 轮）；常规 moved-head 情形注册与 prepare 之间没有触发运行，故实时 head 从未
被 defer、由下一次触发投递（R4-1 第 5 轮恢复此两分支写法）。手动路径没有触发，故
自行重新解析实时 head（`gh pr view … --json headRefOid`）并 `--start` 它；重启后的
轮次现为 `<live>` 于 `<next>`，`--complete` 重复这两个值，而非原来的 `<H>` 与 `<r>`
（第 6 轮）。不要在旧标记下 `git checkout` 点名的 head，否则会把点名 head 的证据记到
所投递 head 的判定名下（R1-1 第 3 轮、R4-1）。prepare **成功**时也要比对（维护者
P1，第 14 轮）：prepare 拿树与实时 PR head 比对、而非与注册 head 比对，故
force-push 回到树已停留的 head 时，即便本轮注册的是另一 head，prepare 仍会成功
——拒绝分支的比对永不触发，完成就会把另一 head 的证据记到注册 head 名下。因此两条
流程都在电池前把 prepare 打印的 `head`（可信快照的 `headRefOid`）与注册 head 比对；
不同即 moved-head 情形（释放本轮标记；电池与 `--complete` 都不跑）。prepare 段的错
HEAD checkout 补救以同一性（而非新旧）为判据（R5-1 第 8
轮）：若本轮注册了 head，仅当 prepare 点名的 head **就是**该 head 时普通 checkout
才是补救；点名的 head 不同（移动或 force-push——prepare 是精确相等判定、不含顺序
信息）即 moved-head 情形（释放本轮标记；绝不在其下 checkout 点名 head）。未注册任何
head 的轮次（全新 `/verify-pr <n>`，从不调用 `--start`）没有自己的标记：先读状态文件
的在飞条目，另一轮次的标记仍活时让该轮作答、不在其下 checkout。第 7 轮「比本轮注册
head 更新」的写法对全新轮次无定义、也漏掉 force-push，其 else 分支认可在另一轮活
标记下 checkout 点名 head——`completeRound` 只按 head+round 匹配标记，点名 head 的
证据会被记到注册 head 的判定名下、`duplicateHead` 从此拒绝再查。两个 moved-head
release 形式都像兄弟恢复形式一样传 `--round <r>`（本轮自己的标记）。完成形式的 `--artifact-dir` 可选：重放完成省略它
以继承该 head 已记录的目录，而非覆盖。死标记条目的 `--round` 是
阻塞标记的轮次，从状态文件的在飞条目读出并传入（读状态允许，只有手写 JSON 被
禁止）：省略 `--round` 会跳过比对，重试的 release 会删掉同 head 较新轮次的活
标记；仅对不记录 round 的遗留标记才可省略（R2-1 第 4 轮）。契约显式说明此点。
既有死轮恢复（`--start` 后死掉的轮用 `--release`）现在也覆盖 prepare 期间死掉的轮。

### 钉与见证

- `scripts/tests/qwen-triage-workflow.test.js`：`--start` 命令钉去掉
  `--artifact-dir`；`--complete` 命令钉加上 `--artifact-dir <dir>`；**位置**钉
  断言注册句先于每节的 `Then run prepare` 句（watch 用 `<headSha>`、手动用
  `<H>`）；prepare 失败恢复钉断言完整 `--release` 形式带 `--repo` **及重启子句**
  （`--start … --round <r+1>`；删任一变红）；watch prompt 的 exit-3 死标记条目
  钉住完整 `--release … --repo` 形式（R2-1）。第 6 轮加按节切片的钉，使共享句在
  一节的副本不为另一节作不在场证明：无 `--artifact-dir` 不变量与重放省略子句各钉
  在本节切片上，错 HEAD 例外（R5-1）与 moved-head 完成重绑定被钉住，通用入口
  条目钉到 prepare 块（注册是 watch/复验程序），边界节则限定注册先于 prepare。
  第 7 轮把错 HEAD 补救改为注册感知（取代第 6 轮三态写法——其在飞分支会在本轮自己
  的标记上卡死），各节钉瞬时「重试不 release」恢复与 watch moved-head 完成重绑定，
  写明误拼 `--repo` 的重置。第 8 轮把补救细化为同一性判据（仅当点名 head 就是本轮注册
  head 才普通 checkout；不同即 moved-head；全新轮次读状态在飞条目、对活标记让该轮
  作答），钉住该措辞使改回「比…更新」变红，补重置的重注册步骤。第 10 轮把同一性
  判据带进 watch 与手动 moved-head 分支本身（watch prompt 只读闸门 JSON，prepare 段
  规则单独到不了它们）：分支现对任何不同于注册 head 的点名 head 触发——前移或
  force-push；所投递 head 称「实时 head」（`<live>`），逐节 moved-head 钉随措辞迁移，
  本轮恢复的 release 形式传 `--round`（不再可选），重置写明也丢 deferred heads，
  注册顺序钉改钉 `--start` 命令的位置、而非仅标题。第 11 轮补全新轮次的死标记分支
  （回收死轮标记后再 checkout）与顺序钉的存在性守卫（占位符改拼写不致空转）；第 12
  轮把 prepare 点名 head 与注册 head 的比对写明、并把重置限定为无活轮（无在飞标记，
  而非仅未跑电池）；第 13 轮修正重建指引——register-ahead 之前的 watch 无法经标准安装
  重建，因步骤 3 被探针游标与 claim 共同阻挡、而 `--release` 只清 claim，故此类 watch
  保留旧顺序直至手动迁移（残余），且不得删另一会话的活 watch 腾位。第 14 轮（维护者
  P1）把 prepare 成功后的 head 比对补进两条流程，并各钉在本节切片上（共享的「释放而
  不完成」句按切片各钉，使一节副本不为另一节作不在场证明）。这些 prose 子句均在
  文本钉套件钉住。
- `scripts/tests/verify-pr-watch-state.test.js`：新见证走 **CLI**（`run(root, …)`，
  演练本 PR 改动的助手代码——`parseArgs` 要求、`completeRound` 返回字段、`main`
  告警）——`--start` 不带 `--artifact-dir` 注册在飞且目录 `null`（恢复强制要求
  变红）；`--complete --artifact-dir <dir>` 记录之**且无警告**；`--start
--artifact-dir <dir>` 仍可用、无目录 `--complete` 继承标记目录**且无警告**
  （向后兼容）；重放完成继承先前判定目录；非 inconclusive 的 `--complete` 无解析
  目录时打印无产物目录警告（删警告的目录合取项使无警告断言变红，R2-3）；先注册
  后 prepare 无 `--complete`（prepare 被杀）再经 CLI `--release` **并重启**恢复
  head（无静默丢弃）。目录链的 CLI 见证也在此文件（而非文本钉文件）：显式完成目录
  覆盖不同的 start 目录（重排解析链即变红）；带显式目录的重放完成覆盖先前判定目录
  （prior 臂优先级）；完成会按所给目录登记活 head、随后拒绝再 start——即 checkout
  补救是唯一防线所防的 certifies-falsely 危害（助手刻意不做树/证据校验）。第 14 轮
  见证覆盖 prepare 成功但 head 不符：注册某 head 后释放它（moved-head 恢复、绝不
  完成）使其无判定，再以另一 head 的证据目录完成它会被拒绝——注册 head 不获得判定。

## 关键设计决定

- **`--complete` 可选而非强制。** 目录供判定的产物链接，非认证本身。保持可选
  保留 inconclusive/replay 回退路径；契约指示传它。强制会破坏继承先前目录的
  重放完成。因提前注册的标记不带目录，非 inconclusive 的完成若解析不到目录会在
  stderr **警告**该判定无产物目录（R1-3）——披露丢失的链接而不破坏回退。HELP
  写明代码实现的真实回退链：start 带了目录时为在飞标记的目录，否则同 head 更早
  判定的目录，再无。
- **向后兼容。** `--start --artifact-dir` 仍接受；改动只移除一个强制要求并重排契约。
- **不去重/defer/release 语义改动。** 标记的目的是去重/恢复；`null` 目录不影响它。

## 涉及文件

- `scripts/verify-pr-watch-state.mjs` —— 移除 `parseArgs` 强制；HELP 真实回退；
  `completeRound` 返回解析目录；非 inconclusive 的 null 目录完成给警告；后续
  #17371 闭合补入 `recordDelivery`（gate 预记入 `deferredHeads`）与
  `restartRound`（`--restart`，单锁原子替换死轮次且拒绝不高于当前轮次的
  `--round`）。
- `scripts/verify-pr-watch-gate.mjs` —— 后续 #17371 闭合补入 `deliverGateOutput`
  与 `resolveDeliveryRoot`（在 stdout 唤醒模型前先按脚本所在 git worktree 预记
  `resync` `headSha`，绝不回退到 `cwd`，锁/损坏/repo 异常时 fail-open），以及
  `resetWatchCursor`（`--release --reset-cursor`，先读出末次 `headSha` 并删除游
  标、再释放 claim，兼顾所有权与 `autofix-pr` 保护）。
- `scripts/verify-capture.mjs` —— 当脚本旁缺失 `@xterm/headless` 或 `sharp`
  时提供显式 `--allow-cwd-modules` 回退开关（默认拒绝从 `cwd` 加载，防止隔离的
  `/trusted-scripts` 副本误执行 PR 可写树中的依赖）。
- `.qwen/skills/verify-pr/SKILL.md` —— watch prompt + 手动复验顺序；start 后
  prepare 失败的恢复；`--restart`、停止/迁移 `--release --reset-cursor` 与宿主克
  隆截屏指引。
- `scripts/tests/qwen-triage-workflow.test.js` —— 命令/顺序钉。
- `scripts/tests/verify-pr-watch-state.test.js` —— 提前注册与 `recordDelivery` /
  `--restart` 见证。
- `scripts/tests/verify-pr-watch-gate.test.js` —— pre-delivery、默认根解析与
  `--release --reset-cursor` 见证。
- `scripts/tests/verify-capture.test.js` —— 隔离挂载下拒绝 `cwd` 模块及
  `--allow-cwd-modules` 显式开关见证。
- `docs/design/verify-pr-register-ahead-of-prepare.md` + `.zh-CN.md` —— 本文档
  （并同步 `docs/design/verify-pr-watch.md` + `.zh-CN.md`）。

## 范围边界

- 最初的 PR #17185 仅调整注册顺序与 `--start` 参数要求，保持 watch-gate 所有权/游
  标、去重/defer 与 release 语义不变；本文档记录的后续闭合改动在此基础上扩展了
  watch-gate 与 watch-state 助手，专门闭合 #17371 的三条 watch 活性残余（及
  `verify-capture.mjs` 的显式 cwd 依赖开关）。
- 信任边界检查（R17-1，已由 #17375 闭合）及剩余 below-Critical 延后项（D17-4…14、
  R5-2、第 7/8 轮 deferred）不在本改动范围内。

## 待决问题

- 无阻塞项。活性收益是可观测/可恢复性：投递后在 prepare 被杀的 head 现在留下
  在飞标记，操作者或下一次 head move 可恢复，而非消失。此前由 #17371 跟踪的
  三条残余现已按如下边界闭合：
  1. `scripts/verify-pr-watch-gate.mjs`（`deliverGateOutput` + `resolveDeliveryRoot`
     → `scripts/verify-pr-watch-state.mjs` 中的 `recordDelivery`）在向 stdout 输
     出 `resync` 事件唤醒模型之前，先把投递的 `headSha` 预记入 `deferredHeads`
     （`startRound` 按保留的 `seq` 将该条目晋升为在飞）。该预登记刻意采用
     **fail-open**：若状态锁被占用、`repo` 不匹配、状态文件损坏或孤立脚本不在
     git worktree 内（绝不回退写进 `cwd`），闸门会在 stderr 记录警告并仍投递该事件，
     避免因瞬时状态故障吞掉已经被游标消费的事件。
  2. `scripts/verify-pr-watch-gate.mjs --release --reset-cursor`（`resetWatchCursor`）
     在删除前读取并汇报探针游标的末次 `headSha`，先删除 `autofix-pr-<n>-gate.json`
     再移除 `verify-pr` 所有权声明（保证 unlink 失败时 claim 留存以便重试），且仅在
     `verify-pr` 声明存在且不存在 `autofix-pr-<n>-state.json` 时执行，支持干净停
     止与既有 `verify-pr` watch 的就地迁移，同时禁止误删其他消费者的游标。
  3. `scripts/verify-pr-watch-state.mjs --restart --head <oid> [--from-round <r>] --round <r+1>`
     （`restartRound`）在单次状态锁内原子替换死轮次的在飞标记并拒绝任何
     `--round <= entry.round` 的回退（同时兼容升级 `round: null` 的旧版标记），
     消除 `--release` 与 `--start` 之间失去记录的窗口（原有的 `--release` 后接
     `--start` 仍保留兼容；watch 仅在 head move 时唤醒，故*最后一个* head 上被杀
     的轮次仍需等待新 move，或手动执行 `--restart` / `--release` + `--start`）。
