# GitHub 渠道：watch 覆盖与非阻塞任务执行

[English](github-channel-watch-coverage-async-tasks.md) | [简体中文](github-channel-watch-coverage-async-tasks.zh-CN.md)

状态：已实现并验证（2026-11-06 提案，2026-11-07 评审修复轮）；基线干跑、
本地构建 E2E 结果与变异见证见
`.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md`。

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
  - 描述符：`kind: 'number'`、`exclusiveMinimum: 0`，`maximum` 与
    `default` 取自适配器导出的 `MAX_PR_WATCH_LIMIT`（500）与
    `DEFAULT_PR_WATCH_LIMIT`（30），表单边界与生效边界不会漂移；
    描述写明限流算术（默认 60 秒间隔下每个被 watch 的 PR 约 60 次
    请求/小时；5000 次/小时的 PAT 预算约容纳 80 个被 watch 的 PR，终态
    积压按 1.2 倍扇出排出时约 69 个 open；超预算会让每轮 watch 都中止）。
  - 适配器：`prWatchLimit` getter 沿用现有 `pollInterval` getter 的钳制
    方式（非法/缺省 → 30；小数 → 向上取整；超过 500 → 钳到 500）。
    手工编辑的设置文件不经过描述符校验直达 getter，因此钳制是承重
    设计并有测试。
  - 校验：`validateBoundSessionConfig` 在缺少
    `deliverToBoundSessions: true` 时拒绝 `prWatchLimit`，措辞与兄弟
    字段一致。
  - Web Shell：该字段登记进编辑器的 GitHub 标签映射与绑定会话面板，
    两份语言词条均已翻译。
- `runPrStateWatch` 对活跃集分区：
  - **open**：绑定状态既非 `merged` 也非 `closed`，且 watch 条目尚未
    观测到 `prState === 'closed'`（陈旧的 open 注册表不能让已观测关闭
    的 PR 占据 open 档名额）；
  - **终态待观测**：其余仍需终态观测的条目。
    open PR 独占**全部**预算（按 `updatedAt` 降序）。终态待观测 PR 在
    预算之外的一块**额外**名额中排出——
    `min(终态数, max(1, ceil(limit * 0.2)))`，外加 open 预算的任何剩余。
    没有这块名额时，`limit == open 数` 会让排出永远饿死，活跃集随每次
    合入增长。曾尝试**预算内**预留并移除：它会在积压排出期间排除至多
    `ceil(limit * 0.2)` 个 open 绑定，窗口内被排除绑定上的边沿事件会被
    永久吞掉——正是本设计要修的缺陷。额外名额在排出期间每轮至多多花
    `ceil(limit * 0.2)` 次 `pulls.get`；每个排出的绑定永久离开活跃集，
    积压清空后扇出即回到 open 预算。
- 上限警告保留 `PR watch cap exceeded` 前缀（有测试 pin），只要选择覆盖
  不了整个活跃集就触发：报告 `已watch/活跃` 计数（终态名额排出期间
  已 watch 数可能超过 open 上限）、配置的 open 上限、以及被排除的键
  （open 与终态待观测一视同仁）。
- 终态观测仍以 API 为权威：绝不从绑定注册表数据合成 `state_change`。
  注册表与 watch 条目只决定**优先级**，从不决定事件内容。真正被重新
  打开的 PR 会得到一次剩余预算观测并回到 open 档。

### 2. 后台公共任务运行器（`packages/channels/github`）

- 每渠道一个 FIFO 运行器（并发度 1）承接公共路径的 `runInboundTask`
  执行。沿用现有 `retryPendingFinalDeliveries` 后台循环模式：按需启动，
  `disconnect`/`connect` 以代次退役。
- `dispatchEnvelope` 公共分支：持久化认领任务（不变），同步执行缺席
  闸门，然后入队并返回 `true`。缺席闸门（不完整的绑定快照无法证明 PR
  无绑定）必须在派发时执行，被延迟的事件才能保持评论车道 first-contact
  body 抑制所依赖的 `false` 裁决；`runInboundTask` 对恢复入队的任务
  再检查一次。
- 绑定会话消失的公共回退（目标消失且缺席已确定为权威）持久化清空
  delivery 后经同一运行器重新入队（`requeued` 裁决），而不是在轮询车道
  内 await `handleInbound`：它们是完整的公共 turn，内联执行既会队头
  阻塞轮询，也可能在共享渠道会话上 steer-cancel 另一个公共 turn。
- 绑定 fan-out 分支保持内联：投递是一次快速 prompt POST，其裁决
  （delivered/deferred/retired）是派发返回值与游标闸门已经依赖的输入。
- `recoverInboundTasks` 在任何分支改动任务**之前**跳过运行器在途集合
  中的任务（否则重定向分支会重新解析一个公共 turn 正在运行的背压挂起
  任务——running 转换是合并语义，`backpressure: true` 会保留——并把
  它第二次绑定投递）。没有在途条目的 running 任务是真正的崩溃，仍然
  恢复并计次。绑定任务照旧内联执行；其余可恢复任务入队。
- 在途集合（已入队 + 运行中的任务 id）防止恢复 pass 重扫已入队任务时
  重复执行。同实例重连时，孤立运行器正在执行的任务 id 保留在集合中
  （孤立运行器的 `finally` 会移除它）；已入队但未启动的 id 被丢弃，
  由恢复从持久存储重新入队。
- 运行器隔离失败：`runInboundTask` 已把错误迁移为
  `failed`/背压/退役；意外抛出会被记日志**并**按任务 id 各记一次
  inbound `failed` 事件行（轮询循环的按线程 catch 不再看到它），然后
  运行器继续下一个任务。
- `disconnect` 退役运行器代次并释放空闲等待者。收尾运行器的重启钩子
  只对**当前**代次生效，因此 disconnect 之后绝不会继续排空退役队列；
  任务保持持久化，等下次 connect 的恢复。在途 turn 保持今天的语义：
  worker 退出、daemon 会话存活。
- 当某线程的在途公共工作在轮询开始时已持有游标，评论/聚合车道跳过对
  它的评论重抓，直接车道跳过重复处理（快照而非实时：本轮认领的任务
  不能抑制同线程后续车道；不在途的崩溃任务必须仍可重新派发）。
  first-contact body 投递**不加**闸门：它只认领一次，运行器会把它串行
  排在任何运行中的评论 turn 之后。曾尝试延迟闸门并移除——没有任何
  东西为被延迟的 body 占位，一旦阻塞任务落定，轮询末尾的游标提交可能
  把线程标记已读，此后 first contact（`!lastReadAt`）不可达，body
  永久丢失。

### 保留的不变量（为什么安全）

- 认领在派发返回前已持久化，游标推进永不超越消费——不变。
- 公共任务可恢复期间，`hasCursorBlockingTasks` 仍冻结 mark-as-read；
  长 turn 期间的每轮轮询重列同一窗口，去重跳过已认领事件——这正是今天
  崩溃恢复已经产生的状态。
- 公共任务按认领顺序串行执行（FIFO、并发 1），每线程回复顺序不变。
- watch pending/fired 对账、尝试预算、背压地平线、发布审计均不改动。

## 受影响文件

- `packages/channels/github/src/GithubAdapter.ts` —— 选择逻辑、上限
  getter、运行器、派发/恢复交接、缺席闸门提取、gone-session 重新入队、
  持有线程免重抓、disconnect/connect。
- `packages/channels/github/src/index.ts` —— 由导出常量构建的
  `prWatchLimit` 描述符字段。
- `packages/channels/github/src/GithubAdapter.test.ts` —— 新增覆盖；
  `pollOnce` 测试助手额外等待运行器空闲，使既有公共路径断言含义不变。
- `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`
  与 `packages/web-shell/client/i18n.tsx` —— 字段登记与两份语言词条。
- 文档：GitHub 渠道指南的绑定会话小节补充 `prWatchLimit` 旋钮与
  非阻塞执行说明。

## 设计决策与理由

1. **open 优先 + 额外终态名额。** 更大的硬上限只是推迟饥饿，还把限流
   预算花在死 PR 上。优先级修复排序缺陷；额外名额（上限的 20%，至少
   一个，在 open 预算**之外**）保证 open 占满上限时排出仍能推进，且不
   排除任何一个 open 绑定，积压清空后即消失。预算内变体经实测会在整个
   排出窗口内重新饿死最旧的 open 绑定（验证夹具：limit 30 下 30 open +
   5 终态，最旧 open PR 的 head 变化仍必须投递），因此名额是加法的，
   最坏扇出界定为上限加 `ceil(limit * 0.2)`（默认 30 时为 1.2 倍）。
2. **上限可配置，默认不变（30）。** 每个被 watch 的 PR 每轮约花费一次
   `pulls.get` 加条件性 Checks 拉取——默认 60 秒间隔下约 60 次请求/小时，
   5000 次/小时的 PAT 预算约容纳 80 个被 watch 的 PR（终态积压按 1.2 倍
   扇出排出时约 69 个 open）。绑定更多的运维有意识地调高
   `prWatchLimit`（与 `pollInterval`）。watch pass 本就在限流时快速失败，
   超预算配置会降级而不是锤爆 API；算术写明在描述符与指南中。
3. **并发 1 运行器，而非按会话并行。** 缺陷是活性，不是吞吐。串行执行
   保住回复顺序，避开 `ChannelBase` 里记载的桥级并发 prompt 风险
   （steer/chain-and-wait）。所有进入公共执行的转换都经过运行器，包括
   gone-session 回退。
4. **终态观测不走绑定状态捷径。** 从注册表数据合成 `state_change` 会
   破坏边沿触发契约（注册表可能滞后或超前于 API）。每个终态 PR 一次
   真实观测，成本低且永久排出活跃集。watch 条目可以把陈旧 open 绑定
   分为终态档，但绝不凭空生成事件。
5. **不加 first-contact body 延迟闸门。** 被延迟的 body 没有任何占位：
   阻塞任务一旦落定，轮询末尾的游标提交可能把线程标记已读，first
   contact（`!lastReadAt`）从此不可达——永久丢失。运行器 FIFO 本就把
   body turn 串行排在运行中的评论 turn 之后，这正是闸门想保护的性质。
   派发时的同步缺席闸门保留了车道对背压延迟评论的 false 裁决 body
   抑制。

## 约束与风险

- **测试迁移面。** 既有测试在 `await pollOnce()` 后立即断言公共结果。
  把运行器空闲等待集中到测试助手可保住大多数断言；刻意观察在途状态的
  测试必须显式退出该等待。
- **冻结游标期的轮询成本。** 长公共 turn 运行期间窗口每轮重列；持有
  线程快照跳过冗余的按线程评论重抓与直接车道重复处理，请求量不再随
  turn 时长线性增长。派发去重不变。
- **运行器关停。** `disconnect` 时不取消在途 turn（与今天一致），恢复
  机制在下次启动按既有尝试预算重放。退役代次绝不重启队列，空闲等待者
  在 disconnect 时释放。

## 验证计划

- 单测（同目录）：事故形态的 open 优先选择；`limit == open 数` 时的额外
  终态名额（积压排出期间每个 open 绑定保住观测，窗口内最旧 open PR 的
  head 变化仍投递）；陈旧 open 分档；上限钳制（超上限、零、非有限）与
  描述符接受；校验前置依赖；警告形态；运行器交接、FIFO 顺序、turn 中途
  恢复 pass 钉住在途去重、恢复重定向跳过、gone-session 重新入队、同实例
  重连、disconnect 停止 + 空闲等待者、持有线程免重抓、失败记账；公共
  任务运行期间游标闸门不变。
- E2E（`.qwen/e2e-tests/github-channel-watch-coverage-async-tasks.md`）：
  按渠道真场景 harness，用真实 daemon + 本地 GitHub 兼容桩 + 本地模型
  端点。基线干跑（已安装发行版）必须复现两个缺陷；本地构建必须通过
  全部组。
- 变异见证：回退 open 优先排序、回退入队交接、移除恢复在途跳过、移除
  额外终态名额、把 open 预算缩减该名额（已移除的预算内预留）、移除
  disconnect 代次守卫——每一项都必须让对应专属测试变红。

## 验收标准

- open 绑定 PR 超过 30 且用默认上限时，最新的 open PR 在**完整** open
  预算内被 watch，终态待观测 PR 经预算之外的额外名额排出；把
  `prWatchLimit` 抬到 open 数量后，每个 open 绑定 PR 都能收到
  `head_change` 投递。
- 终态待观测 PR 在一次观测轮询后离开活跃集，即使 open PR 占满上限，且
  不排除任何 open 绑定（夹具：limit 30 下 30 open + 5 个更新的终态——
  最旧 open PR 被观测、其 head 变化被投递）；上限警告里的活跃数相应
  下降。
- 公共评审 turn 运行数分钟期间，绑定 PR 的 head 变化仍在一个轮询间隔
  内投递，新通知仍被认领，持有线程的评论不再每轮重抓。
- first-contact body 绝不因游标提交而丢失；被延迟（背压）的评论仍在
  该轮抑制 body。
- 既有投递/恢复/背压测试全部通过（助手等待运行器空闲）；lint、
  typecheck、聚焦单测全绿。

## 开放问题

- 无阻塞项。未来可用批量 PR 状态查询彻底去掉按 PR 扇出（triage 提出的
  长期优选形态）；那是独立工作，有自己的限流问题，刻意推迟。
