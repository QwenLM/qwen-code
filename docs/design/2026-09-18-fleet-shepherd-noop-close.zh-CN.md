# Fleet Shepherd：关闭合入后不会改变任何内容的 bot PR

[English](2026-09-18-fleet-shepherd-noop-close.md) | [简体中文](2026-09-18-fleet-shepherd-noop-close.zh-CN.md)

日期：2026-09-18
状态：提议中 —— 由添加本文档的 PR 实现；等待评审

## 问题

autofix 机器人为每个它认领的 issue 开一个 PR。当另一个 PR 先把同样的修复合入
`main`，这个 bot PR 就变成了空壳：合入它不会改变任何一个字节。GitHub 仍把它显示为
普通的 open PR，于是评审机器人继续评审它，autofix 循环继续在上面发「无需改动」的
轮次，直到某位维护者注意到并手工关闭。

自 7 月以来，每一个未合并即关闭的 bot PR 都是人工关掉的。9 月的三个严格空壳展示了
代价：

| PR     | 变成空壳的时刻    | 人工关闭的时刻    | 以空壳状态滞留 | 期间机器人烧掉的轮次 |
| ------ | ----------------- | ----------------- | -------------- | -------------------- |
| #11379 | 2026-09-08 11:19Z | 2026-09-08 22:56Z | 11 h           | 8                    |
| #11376 | 2026-09-09 14:47Z | 2026-09-17 11:26Z | 188 h          | 5                    |
| #12109 | 2026-09-17 16:09Z | 2026-09-18 02:47Z | 10 h           | 2                    |

现有自动化中没有任何环节能关闭这样的 PR。autofix 的 agent 车道没有 GitHub 写凭据
（它在 #11376 上自己就是这么说的），循环的推送与报告步骤持有 bot PAT 但没有关闭
路径，`stale.yml` 要等 60 + 30 天才动手。Fleet Shepherd 每 15 分钟用 bot PAT 走一遍
bot 车队，并且已经拥有车队的其它杠杆（冲突派发、陈旧 base 同步、liveness、接管
自动释放），所以它是再加一个杠杆的自然位置。

## 判定：GitHub 自己的试合并

对每个可合并的 PR，GitHub 都会计算一个试合并提交，在 GraphQL 中以
`potentialMergeCommit` 暴露。它的第一个父提交是 base 一侧。若试合并的 tree 与该父
提交的 tree 相同，合入这个 PR 就不会增加任何内容 —— `main` 已经包含分支提出的每一
个 hunk。每个可合并 PR 一次 GraphQL 读取，无需检出。

这条配方在自动化之前先对照历史记录做了核验：

- 上面三个空壳全部读出 tree 相等（它们同时也显示 `changed_files = 0`）。
- 当时 open 车队中的每一个可合并 PR 都读出有变化，与本地
  `git merge-tree --write-tree origin/main <head>` 的结果一致。
- #10452 是一个作为另一个 open PR 的*重复*而被关闭的 bot PR，它读出有变化。与仍然
  开着的东西重复不是空壳；它仍然是人工裁决，本杠杆不得碰它。

PR 对象上的 `changed_files == 0` 是更便宜的信号，但它只有在 `main` 被合进分支之后才
会归零。tree 比较能在任何同步发生之前就抓到空壳。

任何达不到「已证明 tree 相等」的答案 —— 试合并为 null（GitHub 仍在计算；每次分支同
步都会重置它）、缺少父提交、API 失败、无法解析的输出 —— 都报告为*不可读*，绝不当作
「有差异」，也绝不当作「空壳」。它喂养的杠杆会关闭 PR，所以读取失败时向关闭的方向
兜底。

## 杠杆

空壳关闭分两个 tick 完成，两步都按 head SHA 用标记去重，两步都以机器人身份发出：

1. **通知。** 当探针证明空壳，且 PR 上没有机器人针对当前 head 的通知时，发一条双语
   通知：检测到了什么、若 head 不再变动下一个 tick 就会关闭、以及 `autofix/skip`
   可以保留它。标记：`<!-- fleet-shepherd noop-notice sha=<head> -->`。
2. **关闭。** 在之后的某个 tick，若针对该 head 的通知存在、探针仍证明空壳、并且实时
   读取显示 PR 仍然开着且 head 未变，则带一条双语关闭评论关闭它。标记：
   `<!-- fleet-shepherd noop-close sha=<head> -->`。

两个 tick 之间的一次推送会移动 head，从而使通知失效并让这一对重新开始。重新获得差异
的 head 则根本不会再进入这个杠杆。

杠杆位于车队遍历中冲突杠杆之后、陈旧 base 同步之前，只在 `MERGEABLE` 快照上触发：
`CONFLICTING` 没有试合并，`UNKNOWN` 意味着 GitHub 仍在计算。它有意不等待 checks 结
束。shepherd 自己刚做的一次同步会启动一个把数小时花在空差异上的评审运行；关闭 PR 正
是取消它的方式。

护栏与冲突杠杆同类：

- 只有机器人自己的标记算数；人工粘贴标记文本不能把关闭提前。
- 评论历史不可读、忙碌状态未知（autofix 运行快照或 jobs 读取失败）、或本 PR 有正在进
  行的 `review-address` 运行，都会推迟该杠杆。
- 每 tick 关闭预算（`MAX_NOOP_CLOSES_PER_TICK`，3）在 PAT 支撑的实时标签读取之前检
  查；实时 `autofix/skip` 复查在两次写入之前都会执行，标签状态不可读时向关闭方向
  兜底。
- 关闭前会重新读取实时 head；PR 已关闭或 head 已移动都意味着不关闭。
- 每次写入都经过 `act()`：dry-run 不执行任何操作，失败的写入绝不推进计数器或标记。
- 仪表盘行显示 `no-op vs main` 及杠杆结果，探针不可读会追加到该行，而不是让 PR 看起
  来只是 idle。表头与 tick 汇总报告通知数与关闭数。

## 不在范围内

- **孤儿 PR。** 2026-09-18 当天 17 个 open 的 autofix PR 中有 10 个的关联 issue 已被
  人工关闭（多为已恢复的 CI 事故），但仍带有真实差异；#10455 的 issue 甚至是被另一个
  已合入的 PR 关掉的。它们不是空壳。剩余差异是否仍然需要是人工决定，本杠杆不碰它们。
- **与 open PR 重复**（#10452 的形态）—— 同样的原因。
- **关联 issue。** 空壳关闭不触碰 issue 及其 `autofix/in-progress` 标签；关闭评论请人
  工在 issue 仍开着时确认 `main` 已解决它。自动清理是后续工作。
- **阻止空壳的诞生。** 在 agent 写补丁之前，于新拉取的 base 上重新确认目标仍能复现，
  本可以彻底避免 #11379。那属于 `qwen-autofix.yml` 的 issue 阶段，是另一处改动。

## 约束与风险

- **陈旧的试合并。** GitHub 惰性地重算试合并。针对较旧 `main` 计算出的 tree 相等，
  仍然证明分支相对那个 `main` 没有任何内容；分支只有在 `main` 之后回滚了修复时才可能
  重新有意义，此时重新打开 PR（或一次新的 autofix 运行）才是正确的恢复方式。两 tick
  配对与实时 head 读取约束的是与推送的竞态；它们不试图约束这一点。
- **成本。** 每个可合并 PR 每 tick 一次 GraphQL 调用（约 15 个 PR，每 15 分钟一次），
  叠加在遍历已经发出的 compare 调用之上；只对探针标记的 PR 读取评论历史。
- **workflow 体积。** 该杠杆让 `qwen-fleet-shepherd.yml` 超过其记录基线；基线在同一
  PR 中更新，远低于 470 KB 门槛。

## 验证

- `scripts/tests/qwen-fleet-shepherd-workflow.test.js` 钉住杠杆的位置、标记、护栏顺
  序、计数器与仪表盘接线，并在 `set -eo pipefail` 下用假 `gh` 逐字回放
  `noop_merge()` 与 `noop_close_lever()`：探针覆盖 tree 相等、不同、null、缺父提交、
  API 失败与垃圾输出；杠杆覆盖通知 tick、关闭 tick、针对其它 head 的陈旧通知、人工伪
  造的标记、head 移动、PR 已被关闭、实时 head / 评论 / 标签不可读、忙碌状态未知、本
  PR 与其它 PR 的在飞 address 运行、预算耗尽、实时 skip 标签、任一 tick 的写入失败、
  以及 dry-run。
- 最初几个生产 tick 可在 Fleet Shepherd Dashboard 上观察（`no-op notices` 与
  `closes` 计数器、`no-op vs main` 行），也可以用 workflow 的 `dry_run` 派发输入预演。

## 验收标准

- 试合并 tree 与其 base 父提交 tree 相同的 bot PR 收到一条机器人通知，并在之后的
  tick 中、head 未变动时被关闭，两个标记都存在，仪表盘如实反映。
- 任何带有真实差异、合并状态为冲突或仍在计算、探针不可读、有在飞 address 运行、或带
  skip 标签的 PR 都不会被关闭。
- shepherd 的既有行为（冲突派发、同步、liveness、接管池、等待人工表）保持不变；脚本
  测试套件全绿。

## 后续工作

- 当空壳 PR 关闭而 issue 仍开着时，释放关联 issue 的 `autofix/in-progress` 认领。
- 把孤儿 PR（关联 issue 被他人关闭、差异仍在）作为人工决策项显示在仪表盘上，但不关闭
  它们。
- 在 autofix 的 issue 阶段写补丁之前，于新 base 上重新确认复现。
