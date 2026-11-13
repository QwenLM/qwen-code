# 绑定投递启动积压：被取代折叠与评论摘要

[English](2026-11-14-bound-delivery-startup-backlog.md) | [简体中文](2026-11-14-bound-delivery-startup-backlog.zh-CN.md)

状态：提案（2026-11-14）。

## 问题陈述

启用 `deliverToBoundSessions` 的 GitHub channel 在停机缺口后重启（daemon 停了一夜、长时间故障、channel 关闭后重新启用）时，持久化游标会把整段积压以逐条 prompt 的形式回放给绑定 PR 的会话：

- **评论 watch** 的游标（`commentSince`）按设计跨重启存活（`MAX_WATCH_COMMENTS_PER_PASS` 的注释就描述了停机排空场景）。缺口期间产生的每条同账号评论都成为独立的持久任务与 prompt，按每 pass 20 条逐轮排空。
- **状态 watch** 对照陈旧的持久化基线 fire 迁移。停机前已检测的事件可能描述已不成立的事实：head 已被取代的 `ci_failure`、冲突已解决的 `merge_conflict`、或只有净变化 A→C 有意义时的中间 `head_change` 跳变 A→B、B→C。这类事件通常**不在** `pending` 里：检测会立即认领它，会话 prompt 队列满时把它停成可恢复的背压任务（`state: failed`、`backpressure: true`、无 `deliveredAt`），每轮 poll 重试直到 240 次推迟视界——跨重启存活。dry-run 夹具复现的正是这条路径：过期 `ci_failure` 住在 `github-inbound-tasks.json`，而不是 pending 队列。

每条过期 prompt 都消耗绑定会话的一个模型回合，并可能触发对已解决状态的工作。投递契约（[2026-11-02-github-channel-bound-session-events](2026-11-02-github-channel-bound-session-events.zh-CN.md)，关键决策 10/11）刻意把重启后重新注入视为正确恢复，并禁止静默消费——因此修复必须让每次退役可见、每个当前事实仍可投递。

## 现状

除注明外均指 `packages/channels/github/src/GithubAdapter.ts`。

| 车道       | 积压机制                                                                                                                                                                                | 位置                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 通知 lane  | `since = cursor.lastProcessedAt - 1s` 重列缺口内全部未读通知；评论线程已经过聚合 lane 批处理（`agg:` 内容哈希批次，`MAX_AGGREGATE_COMMENTS = 20`，`MAX_AGGREGATE_COMMENT_CHARS = 400`） | `pollOnce` ~3045；`processAggregateLane`                        |
| 状态 watch | 重启后首轮对照持久化基线（`headSha`、`ci`、`mergeableState`、`prState`）；pending 队列在 watch pass 之前经 `reconcilePendingWatch` 排空                                                 | `watchOnePr`、`drainPendingWatch`、`drainPendingWatchRoleAware` |
| 评论 watch | `commentSince` 跨重启存活；每 pass 突发预算 20；每条评论一个持久任务与 prompt                                                                                                           | `watchPrComments`                                               |

两个 watch 车道的首次观测（无持久化条目）本就静默基线化——不投递任何积压。问题需要「已有持久化状态 + 缺口」同时成立。

角色感知路由约束任何合并：`boundEventClass` 从 `watch:<type>:` messageId 前缀解析 watch 事件类别，而 `resolveBoundActionTemplate`（channel-base）按 `role:event → role:lane → role:default → event → lane → default` 解析；**无匹配即跳过该角色**。合成 digest 类别会让只配置了成员类别模板（如 `fix:watch:ci_failure`）的角色静默错过。

## 目标

1. 绝不投递事实已被后续观测取代的 watch 事件；净变化可得时绝不投递中间 head 跳变。退役可见（死信 + journal），绝不静默。
2. 检测到停机缺口后，每个绑定 PR 的评论积压以**一条**私有摘要 prompt 投递，而非每条评论一条；角色路由、归属排除方向、游标崩溃安全性均不变。
3. 不新增配置键；不改通知 lane、公开发布契约、已认领任务的恢复契约。

## 范围边界

- **状态事件保持逐条。** 缺口后状态 watch 每 PR 至多 fire 四个事件（head_change、ci_failure、merge_conflict、state_change），每个都描述**当前**状态、各按自己的事件类别路由。把它们合并成一条 digest 需要新事件类别，并对已发布的 channel-base 模板解析做「任一成员类别匹配」扩展——对既有角色配置是路由回归风险。折叠（目标 1）移除过期的那些；其余都是当前事实。这收窄了最初「每 PR 一条含 head/CI 的摘要」提案；无界洪泛源（评论）被完整覆盖。
- **通知 lane 不变。** 它已按线程批处理评论，且其 mark-read + publication audit + 公开回退契约是风险最高的表面。异账号评论积压保持现状。
- **停机前 pending** 在首轮按既有 reconcile 契约排空，先于首次检测可折叠的时机（有界：每条目 pending 上限 64，检测时当前）。**停放的背压任务会被折叠**——在观测到取代事实的首次检测时，包括重启后的首轮 poll。**在途或已投递任务**（accepted / running / `deliveredAt` 已设）绝不折叠，按既有恢复契约结清。
- **首次观测保持静默。** 无持久化条目的 PR 静默基线化，无论是否处于 digest 模式。

## 提议的改动

### 1. 被取代折叠（常开，检测时）

在 `watchOnePr` 中，新基线（`next`）算出之后、事件入队之前：

- **head 前进取代 ci_failure。** pending 中 key SHA 与当前观测 `headSha` 不同的 `ci_failure` 被退役。SHA 从稳定 key 格式 `watch:ci_failure:<n>:<sha>:<detectedAt>` 读取；携带 `unknown` 的 key 绝不折叠（无取代证据）。
- **冲突解决取代 merge_conflict。** 当 `mergeableState` 被明确观测为非 `dirty` 时，退役 pending 的 `merge_conflict`。`null`/缺失的 mergeable（GitHub 仍在计算）绝不折叠。
- **head_change 合并。** 已有 pending `head_change` 时再追加新的，pending 条目保留其 key，文本重渲染为净变化（原始 `from` → 新 `to`）。`PendingWatchEvent` 新增可选 `headChangeFrom?: string`，检测时记录；缺该字段的遗留 pending 条目不合并（两条都投递——升级前行为）。往返（head 回到 pending 跳变的原始 `from`）以 reason `superseded: head returned to original` 退役该 pending 跳变，而不是渲染无意义的「A 到 A」prompt；死信写失败则回退为追加新跳变（两条事实 prompt，绝不丢迁移）。

同样的取代规则作用于**停放的背压任务**——这是过期事件的主路径，因为检测立即认领事件、prompt 队列满时将其停放。新事实构成取代时，`watchOnePr` 还扫描本 PR 的 inbound 任务存储，退役每个 `source.messageId` 为被取代的 `ci_failure`（key SHA ≠ 当前 head）或 `merge_conflict`（明确观测非 dirty）、且处于停放而非在途状态的任务：`state === 'failed'`、`backpressure === true`、`deliveredAt` 未定义、不被本进程持有（`publicTasksInFlight`）。其他任何状态的任务（accepted/running、已投递、非背压 failed）绝不折叠——按既有恢复契约结清。

退役表面沿用既有 pending 溢出路径：`github-bound-deadletter.jsonl` 中 reason 为 `superseded: head advanced` / `superseded: conflicts resolved` / `superseded: head returned to original` 的死信记录是提交点；随后事件离开 `pending`（在与基线同一次 pass 末尾保存中）或任务从存储移除，`watch_superseded` journal skip 行在持久步骤之后写入。死信写失败则事件留队/任务继续停放（fail-closed，下次检测重试）。

崩溃窗口：恢复回合遇到 key 已死信的可恢复 watch 任务时完成退役（移除任务、记 journal）而非投递——与 drain 对已死信 pending 头部既有的完成逻辑一致。fired 环、`ciFiredSha` pin、seq 计数语义不变；合并后的 head_change 与任何检测一样消耗一个 seq 号。退役停放的前驱同时解除按 PR 的 drain 保序守卫，幸存的净 `head_change` 无需等待过期事件的视界即可投递。

契约修订：bound-session-events 的验收「每个迁移实例恰好产生一条注入 prompt」变为「每个迁移实例恰好产生一条注入 prompt **或一次可见的被取代退役**」。合法复发（dirty → clean → dirty、SHA 回访、close → reopen → close）仍会 fire：折叠只消费事实已被后续观测取代的实例。

### 2. 停机缺口检测

- `GithubCursor` 新增 `lastPollAt?: string`，在 `pollOnce` 顶部（任何提前返回之前）盖章，由基类在每次成功 poll 后持久化。`validateCursor` 接受缺失（遗留游标）并丢弃畸形值。
- 进程首个 `pollOnce`：若持久化 `lastPollAt` 存在且 `now - lastPollAt > max(10 分钟, 5 × pollInterval)`，置内存一次性标志 `startupDigestPending`。阈值随配置的 poll 间隔缩放，长间隔 channel 不会每轮都 digest；持续 API 故障（失败 poll 不保存游标）算作缺口，与积压语义一致。

### 3. 评论积压摘要（缺口后首个完整 watch pass）

`runPrStateWatch` 把标志读入 pass 局部 digest 模式，仅在 pass 完成后清除标志（限流/凭据中止或状态保存失败则保留到下一 pass；已 digest 的 PR 游标已前进，对它们重跑 digest 模式是 no-op）。

在 `watchPrComments` 中，digest 模式替换逐条评论的 dispatch 循环：

- 全部可投递候选（归属排除与 gate 过滤与今天完全一致）成为**一个**私有-only 信封：
  - `messageId`：`comment-digest:<n>:<排序后成员 key 的 sha256-40>`（内容哈希身份，镜像聚合 lane）。
  - 类别：metadata 保持 `Trigger: comment.`，`boundEventClass` 解析为 `comment`——角色路由与逐条评论 watch 投递逐字节一致。
  - 文本：本地化 lead 带总条数，随后最新 `MAX_AGGREGATE_COMMENTS` 条（作者 lead、按 `MAX_AGGREGATE_COMMENT_CHARS` 截断的正文摘录加既有截断提示、评论 URL），再后是既有的 `omittedNotice` 提示其余。共享 bound prompt 正文上限仍对最终文本可见封顶。
  - 去重：`dispatchedComments` 记录**每个**成员 key，崩溃后重列时逐条过滤已消费成员；重取窗口长大时只以新哈希派发新增余量（聚合 lane 的超集语义）。
- digest 的归属排除是逐成员排除的**并集**：写了任一被打包评论的会话被排除出 digest。理由：缺口期间发过评论的会话在别处活跃、已持有上下文；digest 面向休眠跟随者。若所有目标都被排除，digest 以既有 `comment_watch_no_target` journal 行退役并推进游标（带痕迹消费，与今天的无目标路径完全一致）。
- digest 模式**绕过** pass 级评论突发预算：预算约束的是逐条评论的任务扇出，而 digest 无论积压多大都是每 PR 一个任务，PR 扇出已由 watch 上限约束。消耗预算会把尾部 PR（默认 watch 上限 30 > 预算 20）在 digest 模式清除后推回逐条投递。dispatch 落定时游标提交 `nowIso`，未落定保持 `since`（下一 pass 重试）；gate-grace hold 在批次粒度保持既有一轮语义。
- 跨实例说明：逐条评论 watch 投递经稳定 GitHub id 跨 channel 实例去重；digest 的哈希身份是实例局部的（每实例各有游标），与 watch 事件的「每订阅 at-least-once」语义一致。两个实例同看一个 PR 穿过同一缺口时各投递一条 digest。

`BOUND_DELIVERY_COPY` 新增文案条目（en + zh）：带条数的离线积压 lead。结构性标记与平台值遵循既有语言契约（`en` 条目逐字节英文）。

## 设计决策与理由

1. **检测时折叠，而非 drain 时。** 新事实只在 `watchOnePr` 到达；在此折叠以一条代码路径覆盖两个 drain 变体（legacy 与角色感知），且不触碰 claim/fired 崩溃窗口。drain 时检查不会增加任何东西：head 只通过观测前进，而观测已经折叠。
2. **死信是折叠的提交点。** 复用溢出退役表面保持「呈现、绝不静默」与操作者已知的 fail-closed 写语义；即使崩溃交错，`isDeadLettered` 也让被折叠的 key 不可再投递。
3. **只 digest 评论车道。** 它是唯一无界的积压源；其 `comment` 类别在不触碰已发布 channel-base 解析链的前提下保持角色路由一致。状态事件有界（每 PR 每缺口 ≤4）且折叠后都是当前的。
4. **心跳放在通知游标，而非 watch 状态。** 游标在每次成功 poll 后保存，与 watch 是否可运行（预算跳过、无绑定）无关，缺口信号不会被合法未运行的 watch 伪造。watch 状态文件只在 watch pass 运行时写。
5. **归属排除取并集。** 逐成员排除无法作用于打包；排除缺口期间发过言的会话是保守方向（它们活跃过），并为休眠会话保留自触发环防护。
6. **不加配置键。** 该行为是对所报告痛点的严格改进且退役可见；操作者开关会增加没有被请求的表面（简单性优先）。

## 约束

- 通知游标、mark-as-read、publication audit、公开回退契约均不触碰。
- `PendingWatchEvent.headChangeFrom` 是增量字段；`isPrWatchEntryShape` 的 pending 校验器检查 key/issueNumber/envelope/delivery 并放行额外字段，遗留状态文件原样加载。
- `lastPollAt` 是 `GithubCursor` 的增量字段；缺它的遗留游标在升级后首个 poll 跳过 digest 检测（不误 digest）。
- channel-base 是已发布包；本设计不改其任何导出。
- digest 正文经共享信封上限遵守 `BOUND_PROMPT_BODY_MAX_CODE_POINTS`；摘录复用聚合 lane 常量。

## 风险

- **信息密度。** digest 摘录上限可能把一条可操作评论藏在 `omittedNotice` 之后；提示点名补救方式（列出 PR 评论），每个成员 URL 模式仍可由 PR 推导。接受：替代方案正是本设计移除的 prompt 洪泛。
- **停机前陈旧 pending。** 停机时仍在 `pending` 的事件在首次折叠前排空（见范围）。有界且检测时当前；v1 接受。停放的背压任务——过期主路径——会被折叠。
- **任务存储扫描成本。** 折叠在每个检测到取代事实的 PR 每 pass 读一次 inbound 任务存储；该存储本就被 reconcile 与 recovery 每轮读取，且扫描只在观测到取代事实（head 变化/冲突解决）时运行，稳态 poll 不扫描。
- **digest 模式重入。** 中途 abort 的 pass 保留标志；已 digest 的 PR 游标已前进，不会产生第二条 digest。首条 digest dispatch 失败的 PR 从 `since` 重试并带成员去重。
- **多实例重复**：共享缺口期间每实例一条 digest——与既有 watch 事件语义一致，已在上面载明。

## 验证计划

- 单元测试（collocated，`GithubAdapter.test.ts`）：每条折叠规则在 pending 事件与停放背压任务两种形态上，含死信写 fail-closed、`unknown`-SHA 与 null-mergeable 不折叠、在途/已投递/非背压任务绝不折叠、恢复完成已死信 watch 任务的退役、缺 `headChangeFrom` 的遗留 pending；缺口阈值缩放与遗留游标容忍；digest 打包、重列成员去重、归属并集排除、无目标退役、突发预算绕过、游标提交/保持、完整 pass 清标志与 abort 保留、缺口下首次观测静默。
- E2E（封闭 mock GitHub + 隔离 daemon，按绑定投递夹具模式；两阶段：启动 → 绑定 → 静默基线 → 停止 → 重写 `commentSince`/`lastPollAt` 模拟缺口 → 重启）：断言绑定会话 transcript 中**一条** digest prompt 且记录全部成员去重键；无缺口对照断言逐条评论投递不变；背压臂（prompt 队列满、CI 变红后 head 前进）断言过期 `ci_failure` 任务从 `github-inbound-tasks.json` 退役并有 superseded 死信行；缺口下首次观测臂断言静默。首次启动前预种 watch 状态**不可行**：首个「完整但空」的绑定快照会剪掉未绑定条目。
- `npm run build && npm run typecheck`，改动文件的聚焦 vitest。

## 验收标准

1. 非当前 head 的 `ci_failure`、明确观测非 dirty 后的 `merge_conflict`、中间 head 跳变被退役/合并，带死信 + journal 痕迹——无论事件在 `pending` 还是停放背压任务；恢复回合对已死信的 watch 任务完成退役而非投递；无任何静默消费；死信写失败事件留队/任务继续停放；在途与已投递任务绝不折叠。
2. 缺口超阈值后，每个绑定 PR 的同账号评论积压以一条类别为 `comment` 的私有 digest prompt 到达，记录全部成员去重键、应用归属并集排除，游标推进与逐条路径完全一致。
3. 无缺口（或首次观测）时投递与今天逐字节一致：逐条评论 prompt、静默基线、无 digest。
4. 角色感知路由、已认领任务恢复、通知 lane、公开发布契约不变。

## 开放问题

- 若操作者反馈显示长缺口后通知 lane 的异账号积压同样痛苦，后续可在其自有设计下把 digest 扩展到该 lane（其 mark-read/audit 契约需要单独处理）。
