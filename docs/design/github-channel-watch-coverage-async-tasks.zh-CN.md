# GitHub 渠道：watch 覆盖与非阻塞任务执行

[English](github-channel-watch-coverage-async-tasks.md) | [简体中文](github-channel-watch-coverage-async-tasks.zh-CN.md)

状态：已实现并验证（2026-11-06）；基线干跑、本地构建 E2E 结果与变异
见证见 `.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md`。

## 问题陈述

在绑定数量较多的 daemon 上，GitHub 渠道的绑定会话投递
（`deliverToBoundSessions` + `prWatchEvents`）不可靠。两个相互独立的缺陷，
均在一台运行 0.26.8 的生产 daemon 上实盘观测到（315 条会话绑定、242 个
活跃 watch 候选、约 94 条 open PR 绑定）：

1. **watch 饥饿。** PR 状态 watch 每轮至多轮询
   `MAX_WATCHED_PRS = 30` 个绑定 PR，且纯按绑定 `updatedAt` 新旧选择
   （`GithubAdapter.ts` 的 `runPrStateWatch`）。其余绑定 PR 永不被轮询，
   它们的 `head_change` / `ci_failure` / `merge_conflict` / `state_change`
   事件永不被检测。daemon 每轮日志都警告
   `PR watch cap exceeded: watching 30/242 bound PRs`。两个效应叠加：
   - 绑定较早的 open PR 被更新的绑定挤出，其中不少是早已合入的 PR 的绑定。
   - 绑定里记录为 `merged`/`closed` 的 PR 会一直留在活跃集里，直到 watch
     亲自观测到终态迁移。若上限把它排除在外，这次观测永远不会发生，
     于是它永久占据一个活跃名额。活跃集随死 PR 单调增长。
2. **队头阻塞。** 轮询循环是串行的
   （`PollingChannelBase.runLoop` await `pollOnce`）。在 `pollOnce` 内部，
   新派发（`dispatchEnvelope` 公共分支）与恢复（`recoverInboundTasks`）
   都 await `runInboundTask`，其公共路径（`handleInbound`）会等待
   **整个 agent turn** 跑完才发布回复。于是一个落在未绑定 PR 上的
   `review_requested` 就把整个渠道——watch、绑定投递、所有其他通知——
   冻结整个 turn 时长（实测 64 分钟）。绑定投递本身很快（一次不等 turn
   的 prompt POST）；只有公共路径阻塞。

## 目标

- 只要配置的 watch 预算允许，每个 open 绑定 PR 都被 watch；终态待观测
  PR 从活跃集中排出，而不是不断累积。
- watch 预算可由运维配置，并写明限流权衡。
- 冗长的公共路径 agent turn 永不阻塞轮询循环：turn 运行期间，watch
  检测、绑定投递、新通知接收照常进行。
- 不改变投递保证：至少一次、游标推进前先持久化认领、边沿触发的 watch
  语义、崩溃恢复、背压预算，全部与今天一致。

## 非目标

- 公共 turn 并行化（并发度保持 1，顺序不变）。
- 改变通知游标契约：可恢复的非背压任务仍然持有 mark-as-read
  （`hasCursorBlockingTasks`），与今天一致。
- 提升 GitHub 限流额度或引入条件请求缓存。
- 改动绑定会话投递本身（fan-out、角色、模板）。

## 提议的改动

### 1. watch 选择与预算（`packages/channels/github`）

- 新渠道配置字段 `prWatchLimit`：
  - 描述符：`kind: 'number'`、`exclusiveMinimum: 0`、`maximum: 500`、
    `default: '30'`，描述写明每轮 API 成本与 `pollInterval` 的权衡。
  - 适配器：`prWatchLimit` getter 沿用现有 `pollInterval` getter 的钳制
    方式（非法/缺省 → 30；小数 → 抬到 1；超过 500 → 钳到 500）。
    `MAX_WATCHED_PRS` 变为默认值常量，不再是硬上限。
- `runPrStateWatch` 用它已经读取的绑定注册表状态对活跃集分区：
  - **open**：绑定状态既非 `merged` 也非 `closed`；
  - **终态待观测**：绑定状态为 `merged`/`closed`，但 watch 条目尚未观测
    到 `prState === 'closed'`。
    选择时先 watch open PR（按 `updatedAt` 降序）直到上限，再用剩余预算
    填入终态待观测 PR（同样排序），让它们拿到那一次终态观测后离开活跃集。
- 上限警告保留 `PR watch cap exceeded` 前缀（有测试 pin），只要预算覆盖
  不了整个活跃集就触发：报告 `已watch/活跃` 计数、配置的上限、以及被
  排除的键（open 与终态待观测一视同仁）。
- 终态观测仍以 API 为权威：绝不从绑定注册表数据合成 `state_change`。
  注册表只决定**优先级**，从不决定事件内容。

### 2. 后台公共任务运行器（`packages/channels/github`）

- 每渠道一个 FIFO 运行器（并发度 1）承接公共路径的 `runInboundTask`
  执行。沿用现有 `retryPendingFinalDeliveries` 后台循环模式：`connect`
  启动，`disconnect` 停止。
- `dispatchEnvelope` 公共分支：持久化认领任务（不变），入队，返回
  `true`。该布尔值从此表示"已持久化认领或已退役"——这正是调用方落盘为
  去重键的语义；执行结果继续经任务状态迁移与恢复机制流转。
- 绑定 fan-out 分支保持内联：投递是一次快速 prompt POST，其裁决
  （delivered/deferred/retired）是派发返回值与游标闸门已经依赖的输入。
- `recoverInboundTasks`：绑定任务照旧内联执行；可恢复的公共任务改为
  入队而非 await。
- 在途集合（已入队 + 运行中的任务 id）防止重复执行：重列事件重新认领
  到运行中任务、或恢复 pass 重新扫描时，运行器跳过自己已持有的 id。
  `claimInboundTask` 对存活任务本就返回既有记录。
- 运行器隔离失败：`runInboundTask` 已把错误迁移为
  `failed`/背压/退役；意外抛出会被记日志，运行器继续下一个任务。
- `disconnect` 让运行器不再领取新任务。在途 turn 保持今天的语义：
  worker 退出、daemon 会话存活、持久化任务由下次 worker 启动恢复。
- first-contact issue body 投递新增线程级闸门：同一线程还有可恢复任务
  （新认领或运行器中的重试）时，body 推迟到后续轮询。没有这个闸门，
  异步的 body turn 会追上仍在重试的评论 turn（同一渠道会话），并把它
  steer-cancel。推迟期间不记录 body 键，事件不会丢；推迟时长受任务
  自身重试/背压地平线约束。

### 保留的不变量（为什么安全）

- 认领在派发返回前已持久化，游标推进永不超越消费——不变。
- 公共任务可恢复期间，`hasCursorBlockingTasks` 仍冻结 mark-as-read；
  长 turn 期间的每轮轮询重列同一窗口，去重跳过已认领事件——这正是今天
  崩溃恢复已经产生的状态。
- 公共任务按认领顺序串行执行（FIFO、并发 1），每线程回复顺序不变。
- watch pending/fired 对账、尝试预算、背压地平线、发布审计均不改动。

## 受影响文件

- `packages/channels/github/src/GithubAdapter.ts` —— 选择逻辑、上限
  getter、运行器、派发/恢复交接、disconnect。
- `packages/channels/github/src/index.ts` —— `prWatchLimit` 描述符字段。
- `packages/channels/github/src/GithubAdapter.test.ts` —— 新增覆盖；
  `pollOnce` 测试助手额外等待运行器空闲，使既有公共路径断言含义不变。
- `packages/cli` 渠道描述符 pin 测试（若其枚举 GitHub 管理字段）。
- 文档：GitHub 渠道指南的绑定会话小节补充 `prWatchLimit` 旋钮与
  非阻塞执行说明。

## 设计决策与理由

1. **open 优先，而不是更大的固定上限。** 更大的硬上限只是推迟饥饿，
   还把限流预算花在死 PR 上。优先级 + 终态排出在任何预算下都修复排序
   缺陷。
2. **上限可配置，默认不变（30）。** 每个被 watch 的 PR 每轮约花费一次
   `pulls.get` 加条件性 Checks 拉取；按 60 秒默认间隔，30 个 PR 已占
   5000 req/h PAT 预算的可观份额。绑定更多的运维有意识地调高
   `prWatchLimit`（与 `pollInterval`）。watch pass 本就在限流时快速失败，
   超预算配置会降级而不是锤爆 API。
3. **并发 1 运行器，而非按会话并行。** 缺陷是活性，不是吞吐。串行执行
   保住回复顺序，避开 `ChannelBase` 里记载的桥级并发 prompt 风险
   （steer/chain-and-wait）。
4. **终态观测不走绑定状态捷径。** 从注册表数据合成 `state_change` 会
   破坏边沿触发契约（注册表可能滞后或超前于 API）。每个终态 PR 一次
   真实观测，成本低且永久排出活跃集。

## 约束与风险

- **测试迁移面。** 既有测试在 `await pollOnce()` 后立即断言公共结果。
  把运行器空闲等待集中到测试助手可保住大多数断言；刻意观察在途状态的
  测试必须显式退出该等待。
- **冻结游标期的轮询成本。** 长公共 turn 运行期间，每轮轮询重列通知
  窗口。这是既有恢复态行为，受窗口与去重约束；收益是 watch 与绑定
  车道持续流动。
- **运行器关停。** `disconnect` 时不取消在途 turn（与今天一致），恢复
  机制在下次启动按既有尝试预算重放。

## 验证计划

- 单测（同目录）：open 优先选择；终态排出；上限钳制与描述符接受；
  警告形态；运行器交接、FIFO 顺序、在途去重、恢复入队、失败隔离、
  disconnect 停止；公共任务运行期间游标闸门不变。
- E2E（`.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md`）：
  按渠道真场景 harness，用真实 daemon + 本地 GitHub 兼容桩 + 本地模型
  端点。基线干跑（已安装发行版）必须复现两个缺陷；本地构建必须通过
  全部组。
- 变异见证：回退 open 优先排序、回退入队交接、移除在途去重集合——
  每一项都必须让对应专属测试变红。

## 验收标准

- open 绑定 PR 超过 30 且用默认上限时，最新的 30 个 open PR 被 watch，
  终态待观测 PR 不占 open 名额；把 `prWatchLimit` 抬到 open 数量后，
  每个 open 绑定 PR 都能收到 `head_change` 投递。
- 终态待观测 PR 在一次观测轮询后离开活跃集；上限警告里的活跃数相应
  下降。
- 公共评审 turn 运行数分钟期间，绑定 PR 的 head 变化仍在一个轮询间隔
  内投递，新通知仍被认领。
- 既有投递/恢复/背压测试全部通过（助手等待运行器空闲）；lint、
  typecheck、聚焦单测全绿。

## 开放问题

- 无阻塞项。未来可在 open PR 超限时仍为终态保留一小份预算；今天终态
  排出只用剩余预算，这已足够，因为终态待观测 PR 不再阻塞 open 覆盖。
