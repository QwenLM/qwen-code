# Managed Agent 门禁

[English](2026-10-16-managed-agent-gate.md) | [简体中文](2026-10-16-managed-agent-gate.zh-CN.md)

状态：已提出，并已在 `.github/workflows/managed-agent-gate.yml` 中实现；是否设为
必需检查待维护者决定。跟踪 issue：#14392、#14381。

## 问题

自 #14205 起，SDK Java 套件（`sdk-java.yml`）只在每日定时、手动触发和 Java 发布前
运行。2026-10-16，#13918 和 #14370 各自全绿，合在一起却让 main 上
`managed-agent-server` 的测试源码编译失败；直到夜间运行才有人发现。Managed Agent
现在是重点保障的产品线：改动它、或改动它所驱动的 harness 的 PR，合入前必须通过
全量套件。

每次 push 都跑全量负担不起。一次全量是 11 个检查，约 330 机器分钟、125 分钟墙上
时间（run 38874583246）；按最近两天改到 Java 的开放 PR 估算，每天超过 44 机器小时。

## 目标

- 每个改到 Managed Agent 路径的 PR，在最终 head 上通过全量套件后才能合入。
- push 时的反馈保持快速（约 25 分钟）。
- 没改到这些路径的 PR，除几秒钟的路径匹配外不付出额外成本。
- 仍然漏进 main 的回归，经现有 `main-ci-failure-issue.yml` 路线自动开 issue。

## 非目标

- 修改分支保护、merge queue 或 code-owner review。这些是维护者设置；本设计只让它们
  成为可能。
- 修改夜间排程或发布调用方。
- 修复 Hosted 门禁的间歇性失败（#14361），它单独跟踪。
- 另做一个独立的 Java 编译门禁。#14385 曾按同样的路径提出一个独立 workflow，本门禁
  取代它：编译覆盖搭 fast 层级的 Linux Java 21 leg——它先 install SDK，再对
  `managed-agent-server` 做 test-compile 并跑测试，该 leg 同时也带 Managed Agent
  Server 的 checkstyle 步骤。Java SDK 的 checkstyle 步骤钉在 Java 11 leg 上，因此
  只有 full 层级会跑它。

## 设计

### 分层

| 触发                  | 条件                                           | 层级 | 检查项                                      |
| --------------------- | ---------------------------------------------- | ---- | ------------------------------------------- |
| `pull_request` push   | 改到 Managed Agent 路径                        | fast | flyway 检查、真实 daemon E2E、Linux Java 21 |
| `pull_request_review` | 当前 head 的首个维护者 approve，且改到这些路径 | full | 全部 11 项                                  |
| `push` 到 main        | 改到这些路径                                   | fast | 同上                                        |
| `merge_group`         | 改到这些路径                                   | fast | 同上                                        |
| 夜间、手动、发布      | 不变（直接调用 `sdk-java.yml`）                | full | 全部 11 项                                  |

`managed-agent-gate.yml` 选择层级，并通过 `workflow_call` 调用 `sdk-java.yml`，
传入新增的 `tier` 输入。`tier: fast` 把 `test` 矩阵收窄到 Linux Java 21 一条，并跳过
`mysql-integration`、`hosted-harness-mysql`、`event-transport-broker` 和
`event-transport-multi-node`。其他取值（包括不传）都运行全部检查项，因此发布与夜间
路径不变。

跳过 `mysql-integration` 也会跳过 Managed Agent Server 的 H2 单元测试，完整的这套
测试只在该检查项里跑。fast 层中，Java 21 一条改为运行整个模块的单元测试，代替原来的
Runtime Broker 子集。其中一部分测试要加载已构建的 Core 与 CLI JavaScript，所以这一条先执行与
`mysql-integration` 相同的 workspace 安装。合计约多 16 分钟：ECS 池上安装约 5 分钟，
测试约 11 分钟。

### 路径范围

`.github/scripts/managed-agent-gate-scope.mjs` 匹配变更路径：
`packages/managed-agent-server/`、`packages/sdk-java/`、
`packages/cli/src/serve/`、`packages/core/src/managed-runtime/`、Hosted 集成测试
helper 与配置、`sdk-java.yml` 运行的脚本，以及门禁自身文件。Pull request 与 review
事件都用测试 merge commit 对比它的第一父提交，得到的就是 PR 自身的变更集；push 对比
`before..after`，merge group 对比其 base。重命名的新旧路径都计入；diff 关闭 git 的
路径引号化，因此含非 ASCII 字符的文件名也能匹配。范围外的改动仍由夜间运行兜底。

### 必需检查

`gate` job 总会运行并报告层级结果。它的名字是计算出来的：

| 事件                  | 范围           | 名字                                 |
| --------------------- | -------------- | ------------------------------------ |
| 任意                  | 未改到         | `Managed Agent gate`（通过）         |
| `pull_request`        | 改到           | `Managed Agent fast tier`            |
| `pull_request_review` | 改到，跑了全量 | `Managed Agent gate`                 |
| `pull_request_review` | 改到，未跑全量 | `Managed Agent review (no full run)` |
| `push`、`merge_group` | 改到           | `Managed Agent gate`                 |
| 任意                  | 层级选择失败   | `Managed Agent gate`（失败）         |

分支保护读取同名检查中最近一次更新的那个。因此改到路径的 PR 会一直显示
`Managed Agent gate` 为 Expected，直到其 head 上的全量运行报告它；对这类 PR，只有
全量运行（或失败）能报告这个名字。check run 不需要写权限 token，所以门禁对 fork PR
同样有效。

被取代的 fast 层级是中性的、而非红色：当新的 push 取消 pull request 正在进行的运行时，
门禁把 `Managed Agent fast tier` 报告为警告级通过。其他取消仍然失败——全量运行的取消
如此，下一个 approve 才能重试套件，而不是对着一个绿色 check 去重；push 与 merge group
臂上的取消也如此，因为那里不会取消正在进行的运行，取消意味着超时或人工停止。

### 当前 head 的首个 approve

main 开启了 `dismiss_stale_reviews`，所以一个 head 的首个 approve 必然在它最后一次
push 之后。只有维护者的 approve 才会启动全量层级：reviewer 的 `author_association`
必须是 `OWNER`、`MEMBER` 或 `COLLABORATOR`，缺失该字段时同样按不放行处理。
`qwen-triage-finalize.yml` 监听本工作流，并在一个 PR 的检查全绿后自动发 deferred
`APPROVE`；少了这道限制，门禁自己的 fast 层级就会在无人参与的情况下买下仓库里最贵的
一次运行。

对这样的 approve，`scope` job 会运行全量层级，除非之前已有
`pull_request_review` 运行为同一 head 报告了通过或运行中的 `Managed Agent gate`。
本次运行自己的重跑不算，PR push 运行的通过（未改到的分类）也不算。被认定的运行还必须
属于同一个 pull request，且其 job 列表中存在 `SDK Java (full)` callee：同一 head 上
另一个 PR 的 review 运行、或未跑套件就报告该名字的运行，都没有跑过任何 Java lane，
不算数。全量失败后，下一个 approve 或 **Re-run failed jobs** 会重试。

### 并发

- 同一个 PR 的所有事件共用一个组，而 `cancel-in-progress` 是「新进来的那个运行」的
  属性、且只对 `pull_request` 为 true。因此一次 push 会取消它所取代的 approve 运行
  ——否则那次运行还要跑约 125 分钟，最后把结果报在一个 branch protection 已不再读取
  的 head 上。
- approve 之间不取消：第二个 approve 等第一次全量跑完，再由上面的去重跳过它。
- 一个组只保留一个排队中的运行，新进来的运行无论 `cancel-in-progress` 如何都会把它
  取消。因此非 approve 的 review 各自单独成组，评论不会取消排在该 PR fast 层级之后
  等待的 approve 运行。
- main push 不带 pull request，所以每个 commit 一组。
- `sdk-java.yml` 自身的并发组现在包含事件名和被调用的 commit，同一 PR 的 fast 与
  full 运行不再互相排队（否则新排队的运行会顶掉旧的）。

### Fork 信任

`sdk-java.yml` 过去把除 `pull_request` 以外的所有事件都路由到 ECS 池。approve 一个
fork PR 会产生 `pull_request_review`，所以信任检查现在同时覆盖这两个事件：不受信任的
fork 代码留在托管 runner 上，在那里跑全量也不需要任何 secret。

门禁自己的 `scope` 和 `gate` job 也用同样的路由。它们报告的是将来的必需检查，不能被
拥堵的托管队列卡住（2026-10-16 本工作流第一次运行就在那里排队，当时全仓库有 123 个
运行在排队）。受信任的运行走 ECS 池，并带上共享的 checkout 前清理步骤；fork 的运行
留在托管 runner。

### 失败上报

`main-ci-failure-issue.yml` 也监听 `Managed Agent gate`，合入后快闸变红会和其他 main
失败一样开去重的 autofix issue。`qwen-triage-finalize.yml` 用 `Managed Agent gate`
替换了 `SDK Java`——后者自 #14205 起已没有 `pull_request` 触发。

## 成本

- 改到路径的一次 push：约 55 机器分钟——Java 21 leg 25，加上上文全量模块套件带来的
  约 16，daemon E2E 13，flyway 不到 1。
- 改到路径且获得维护者 approve 的 head：一次全量，约 330 机器分钟。这个数字量于
  `setup-java` 还在 ECS 池上跑 post-job Maven 缓存保存（每个 job 14 到 37 分钟）的
  时期；#14396 之后自托管 runner 上已抑制该保存，且已合入本分支，所以一次全量应当
  低于 330。这里没有重新实测。
- 未改到路径的 PR：两次 runner 分配，分别是 `scope` 与 `gate` job。受信任的运行走
  ECS 池，`scope` 在那里会删掉 `.git` 再以 `fetch-depth: 2` 重新 checkout，所以一次
  事件的成本是一次冷克隆加几秒钟的实际工作；fork 的运行留在托管 runner 上。

本次不包含的进一步手段：CLI 只构建一次并以 artifact 共享；把 `hosted-harness-mysql`
（97 分钟墙上时间）拆成并行 job；Java 17 只在夜间跑。

## 风险

- **全量套件不稳定。** `HostedShellLifecycleRecoveryIT` 约 41% 的运行失败（#14361），
  `HostedMonitorRunFaultGatesIT` 的 fg8f 时序断言也会间歇失败。如果现在就设为必需，
  门禁会因噪声卡住大量 Java PR。在 #14361 解决前保持为非必需；期间
  **Re-run failed jobs** 是逃生口。
- **approve 时机。** 全量在首个 approve 时启动，合入最多要在其后等约两小时。reviewer
  可以更早 approve；approve 后的 push 会作废它并重新开始。
- **分类漂移。** push 运行和 approve 运行各自对自己的 merge commit 分类；两次之间 base
  移动时范围可能不同。两者都对比各自的第一父提交，除非冲突解决改变了变更集，否则 PR 的
  变更集保持稳定。
- **范围较窄。** 列表外的 core 改动仍可能破坏 harness；夜间运行仍是兜底。

## 上线步骤

1. 合入本改动；门禁在 PR 上报告结果，但不是必需检查。
2. 观察全量运行，直到 #14361 修复、通过率稳定。
3. 维护者把 `Managed Agent gate` 加入 main 的必需检查（若重新启用 merge queue，也加到
   那里）。

## 验证

- `scripts/tests/managed-agent-gate-workflow.test.js` 求值路径匹配、检查名与并发组表达式、
  fast 矩阵，并用桩 `gh` 运行层级选择和结果报告脚本。
- 现有 SDK Java、Hosted、失败上报、finalize 与 runner 路由元测试钉住了被修改的契约，
  包括 approve fork PR 时仍留在托管 runner。
- 合入后：改到路径的 PR push 后显示 `Managed Agent fast tier`，首个 approve 后显示
  `Managed Agent gate`；未改到的 PR 一分钟内显示通过的 `Managed Agent gate`。

## 验收标准

- 改到路径的 PR，在当前 head 没有全量运行时，不能报告通过的 `Managed Agent gate`。
- 未改到路径的 PR 不跑 Java 即报告通过的 `Managed Agent gate`。
- 同一 head 全量通过后，第二个 approve 不会再启动一次全量。
- 夜间、手动和发布运行仍执行全部 11 项。

## 待定问题

- 是否把范围放宽到 #14205 之前更宽的路径列表（约 49% 的 PR，而不是 27%）。
- merge queue 若重新启用，是否应跑全量层级而非 fast 层级。
