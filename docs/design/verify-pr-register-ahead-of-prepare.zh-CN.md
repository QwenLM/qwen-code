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
所投递 head 的判定名下（R1-1 第 3 轮、R4-1）。prepare 段的错 HEAD checkout 补救以同一性（而非新旧）为判据（R5-1 第 8
轮）：若本轮注册了 head，仅当 prepare 点名的 head **就是**该 head 时普通 checkout
才是补救；点名的 head 不同（移动或 force-push——prepare 是精确相等判定、不含顺序
信息）即 moved-head 情形（释放本轮标记；绝不在其下 checkout 点名 head）。未注册任何
head 的轮次（全新 `/verify-pr <n>`，从不调用 `--start`）没有自己的标记：先读状态文件
的在飞条目，另一轮次的标记仍活时让该轮作答、不在其下 checkout。第 7 轮「比本轮注册
head 更新」的写法对全新轮次无定义、也漏掉 force-push，其 else 分支认可在另一轮活
标记下 checkout 点名 head——`completeRound` 只按 head+round 匹配标记，点名 head 的
证据会被记到注册 head 的判定名下、`duplicateHead` 从此拒绝再查。两个 moved-head
release 形式都像兄弟恢复形式一样带 `[--round <r>]`。完成形式的 `--artifact-dir` 可选：重放完成省略它
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
  写明误拼 `--repo` 的重置，并新增 CLI 见证：显式完成目录覆盖不同的 start 目录
  （重排解析链即变红）。第 8 轮把补救细化为同一性判据（仅当点名 head 就是本轮注册
  head 才普通 checkout；不同即 moved-head；全新轮次读状态在飞条目、对活标记让该轮
  作答），钉住该措辞使改回「比…更新」变红，补重置的重注册步骤，并见证 prior 臂目录
  优先级、以及完成会按所给目录登记活 head（checkout 补救是唯一防线）。第 10 轮把同一性
  判据带进 watch 与手动 moved-head 分支本身（watch prompt 只读闸门 JSON，prepare 段
  规则单独到不了它们）：分支现对任何不同于注册 head 的点名 head 触发——前移或
  force-push；所投递 head 称「实时 head」（`<live>`），逐节 moved-head 钉随措辞迁移，
  本轮恢复的 release 形式传 `--round`（不再可选），重置写明也丢 deferred heads，
  注册顺序钉改钉 `--start` 命令的位置、而非仅标题。
- `scripts/tests/verify-pr-watch-state.test.js`：新见证走 **CLI**（`run(root, …)`，
  演练本 PR 改动的助手代码——`parseArgs` 要求、`completeRound` 返回字段、`main`
  告警）——`--start` 不带 `--artifact-dir` 注册在飞且目录 `null`（恢复强制要求
  变红）；`--complete --artifact-dir <dir>` 记录之**且无警告**；`--start
--artifact-dir <dir>` 仍可用、无目录 `--complete` 继承标记目录**且无警告**
  （向后兼容）；重放完成继承先前判定目录；非 inconclusive 的 `--complete` 无解析
  目录时打印无产物目录警告（删警告的目录合取项使无警告断言变红，R2-3）；先注册
  后 prepare 无 `--complete`（prepare 被杀）再经 CLI `--release` **并重启**恢复
  head（无静默丢弃）。

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
  `completeRound` 返回解析目录；非 inconclusive 的 null 目录完成给警告。
- `.qwen/skills/verify-pr/SKILL.md` —— watch prompt + 手动复验顺序；start 后
  prepare 失败的恢复。
- `scripts/tests/qwen-triage-workflow.test.js` —— 命令/顺序钉。
- `scripts/tests/verify-pr-watch-state.test.js` —— 提前注册见证。
- `docs/design/verify-pr-register-ahead-of-prepare.md` + `.zh-CN.md` —— 本文档。

## 范围边界

- 仅注册顺序与 `--start` 参数要求。watch-gate 所有权/游标、去重/defer/release
  语义、信任边界检查（R17-1，已由 #17375 闭合）均不变。
- below-Critical 延后项（D17-4…14、R5-2、第 7/8 轮 deferred）仍由 #17371 跟踪；
  本改动不触碰。

## 待决问题

- 无阻塞项。活性收益是可观测/可恢复性：投递后在 prepare 被杀的 head 现在留下
  在飞标记，操作者或下一次 head move 可恢复，而非消失。修复**收窄**静默丢弃窗口，
  并未消除。两条残余仍存，跟踪于 #17371：(1) 闸门先写游标再打印事件
  （`packages/cli/src/commands/autofix-pr/snapshot.ts`），故会话在闸门投递与首次
  `--start` 之间被杀仍使 head 无记录——窗口收窄到该「投递→--start」区间，并未
  闭合（闭合需把标记写在闸门侧，那里本就握着 headSha）；(2) watch prompt 是任务上
  的持久快照，故本改动前安装的 watch 仍按 prepare→register 旧顺序，直到任务重建
  ——而 `--start --artifact-dir` 仍被接受，无机制强制重建。watch 只在 head move 时
  醒来，故*最后一个* head 上被杀的轮仍等待新 move，或手动
  `--release --head <H> [--round <r>] --repo <owner>/<repo>` **后再重启**
  （`--start … --round <r+1>`）——单独 release 会让 head 失去记录。
