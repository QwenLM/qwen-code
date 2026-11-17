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
--verdict <word> --artifact-dir <dir> [--comment-id <id>] --repo <owner>/<repo>`
   ——目录在此记录。

新职责：因标记现在先于 prepare 存在，**`--start` 后 prepare 失败**必须
`--release --head <H> [--round <r>] --repo <owner>/<repo>` **并随后重新启动该
head**（`--start --head <H> --round <r+1> --repo <owner>/<repo>`）再重试 prepare。
单独 release 不是恢复：`releaseRound` 只写 `releasedHeads` 推序提示——明确不是
deferral，且无任何动词打印它——故 head 失去记录，而探针游标已越过它，不会再有
触发投递它（R1-1 第 2 轮）。release 必须与重启成对，正如本文件死轮段落把两者
成对写出。`--start` 记录 repo 后两者 `--repo` 必填；每个动词都对已记录 repo 拒绝
省略 `--repo`）。用 `--release` + 重启，**而非** `--complete inconclusive`：
inconclusive 是唯一增加 head 重试计数的判定，而计数上限即终态（not-covered），
故两次瞬时 prepare 失败会让一个从未跑过轮次的 head 被退役（R1-5）。契约显式说明
此点。既有死轮恢复（`--start` 后死掉的轮用 `--release`）现在也覆盖 prepare 期间
死掉的轮。

### 钉与见证

- `scripts/tests/qwen-triage-workflow.test.js`：`--start` 命令钉去掉
  `--artifact-dir`；`--complete` 命令钉加上 `--artifact-dir <dir>`；**位置**钉
  断言注册句先于每节的 `Then run prepare` 句（watch 用 `<headSha>`、手动用
  `<H>`）；prepare 失败恢复钉断言完整 `--release` 形式带 `--repo` **及重启子句**
  （`--start … --round <r+1>`；删任一变红）；watch prompt 的 exit-3 死标记条目
  钉住完整 `--release … --repo` 形式（R2-1）。
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
  醒来，故*最后一个* head 上被杀的轮仍等待新 move 或手动 `--release`。
