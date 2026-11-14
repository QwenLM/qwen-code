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

1. 绝不投递事实已被后续观测取代的 watch 事件；净变化可得时绝不投递中间 **pending** head 跳变（停放的跳变按观测投递——跳变是历史事实而非当前状态断言；见 §1）。退役可见（死信 + journal），绝不静默。
2. 检测到停机缺口后（或窗口大于逐条评论 pass 上限），每个绑定 PR 的评论积压以私有摘要 prompt 投递——每个正文预算窗口一条，绝不每条评论一条；角色路由、归属排除方向、游标崩溃安全性均不变。
3. 不新增配置键；不改通知 lane、公开发布契约、已认领任务的恢复契约。

## 范围边界

- **状态事件保持逐条。** 缺口后状态 watch 每 PR 至多 fire 四个事件（head_change、ci_failure、merge_conflict、state_change），每个都描述**当前**状态、各按自己的事件类别路由。把它们合并成一条 digest 需要新事件类别，并对已发布的 channel-base 模板解析做「任一成员类别匹配」扩展——对既有角色配置是路由回归风险。折叠（目标 1）移除过期的那些；其余都是当前事实。这收窄了最初「每 PR 一条含 head/CI 的摘要」提案；无界洪泛源（评论）被完整覆盖。
- **通知 lane 不变。** 它已按线程批处理评论，且其 mark-read + publication audit + 公开回退契约是风险最高的表面。异账号评论积压保持现状。
- **停机前 pending** 在首轮按既有 reconcile 契约排空，先于首次检测可折叠的时机（有界：每条目 pending 上限 64，检测时当前）。**停放的背压任务会被折叠**——在观测到取代事实的首次检测时，包括重启后的首轮 poll。**在途或已投递任务**（accepted / running / `deliveredAt` 已设）绝不折叠，按既有恢复契约结清。
- **首次观测保持静默。** 无持久化条目的 PR 静默基线化，无论是否处于 digest 模式。

## 提议的改动

### 1. 被取代折叠（常开，事实驱动）

共享谓词 `supersededWatchReason(key, number, facts)` 判定 watch 事件是否被给定事实取代。它**按事实而非跳变**驱动：留队事件（死信写失败）在后续 pass 仍可折叠，同 head 重跑变绿也会折叠该红事件。分支：

- **ci_failure，head 前进。** key SHA（从稳定格式 `watch:ci_failure:<n>:<sha>:<detectedAt>` 解析）与 `facts.headSha` 不同。携带 `unknown` 的 key 绝不折叠（无取代证据）。
- **ci_failure，CI 恢复。** key SHA 等于 `facts.headSha` 且 `facts.ci === 'success'`——正向观测到的重跑变绿。Checks 拉取失败或缺失绝不折叠（基线保留上次聚合）。
- **merge_conflict，已解决。** `facts.mergeableState` 被正向观测为非 `dirty`。`null`/缺失的 mergeable（GitHub 仍在计算）绝不折叠。
- **state_change，重新打开。** `facts.prState === 'open'` 退役停放的「PR 已关闭」事件；只在关闭边沿 fire 意味着 reopen 自身不产生纠正事件。

两个调用点共享该谓词：

- **检测时**（`watchOnePr`）：事实是新算出的基线（`next`）。只要有 pending 就扫描；停放背压任务对照 `runPrStateWatch` **每 pass 读一次**（而非每 PR）的任务存储快照扫描——稳态成本是每 pass 一次读取，存储不可读则 fail-closed 跳过折叠。任务仅在停放而非在途时折叠：`state === 'failed'`、`backpressure === true`、`deliveredAt` 未定义、不在 `publicTasksInFlight`，且经 `prBindingKey` 限定本 PR。
- **恢复时**（`recoverInboundTasks`）：事实是**持久化基线**，因此 watch pass 被跳过的轮次（REST 预算低于预留、绑定刷新失败）仍能在投递前退役过期停放任务。该折叠不需要实时观测。

**head_change 合并**（仅限 pending）：已有 pending `head_change` 时再追加新的，pending 条目保留其 key，文本重渲染为净变化（原始 `from` → 新 `to`）；被吸收的跳变写一条 `watch_coalesced` journal 行（合并不是退役，故无死信）。候选查找**跳过已死信的 key**：key 已被退役的 pending 条目（如往返退役后状态保存抛错）绝不能吸收新跳变——净变化会无处投递而 journal 却声称折叠进了一条活 prompt；此时改为追加新跳变。`PendingWatchEvent` 新增可选 `headChangeFrom?: string`，检测时记录，并由 pending 条目形状校验为 `undefined | string`（畸形值与任何坏形状一样丢弃整个条目）；缺该字段的遗留 pending 条目不合并（两条都投递——升级前行为）。往返（head 回到 pending 跳变的原始 `from`）以 reason `superseded: head returned to original` 退役该 pending 跳变，而不是渲染无意义的「A 到 A」prompt——但**仅当尚无任何目标收到该跳变**（以持久投递环为证）：角色感知扇出在一个角色被阻塞时让事件留在 pending，已投递的角色必须得知回退，故改为排入反向跳变。死信写失败也回退为追加新跳变（fail-closed：事实 prompt，绝不丢迁移）。合并后的跳变保留原 key，**不消耗**新 seq 号（分支在自增前 continue）。停放的 `head_change` 任务**不**折叠：跳变是历史事实而非当前状态断言，按观测投递；合并只在跳变仍 pending 时适用。

退役表面沿用既有 pending 溢出路径：`github-bound-deadletter.jsonl` 中 reason 为 `superseded: head advanced` / `superseded: CI recovered` / `superseded: conflicts resolved` / `superseded: PR reopened` / `superseded: head returned to original` 的死信记录是提交点；随后事件离开 `pending`（在与基线同一次 pass 末尾保存中）或任务从存储移除，`watch_superseded` journal skip 行在持久步骤之后写入。死信写失败则事件留队/任务继续停放（fail-closed，下次检测或恢复重试）。

**作用域恢复守卫。** 死信记录有两种作用域：事件级记录（无 `taskId`——被取代折叠、溢出）退役该事件的每个任务；按任务记录（`retireBoundTask` 的耗尽表面，写 `taskId`）只退役其点名的任务。恢复守卫仅在记录覆盖**本任务**时完成退役，因此一个角色的耗尽绝不退役同事件下另一角色仍停放的任务。内存索引跟踪两种作用域并在每次追加时保持最新——包括写事件级记录的 pending 溢出退役。

**未投递的同 head 退役释放抑制。** fired 环前缀与 `ciFiredSha` pin 的存在是为了让**已投递**的红抑制同 head 的红→绿→红抖动。CI 恢复分支退役的是从未投递的失败，因此绝不能耗掉该 head 唯一的触发名额：该分支退役 `ci_failure` 时（pending 或停放，检测或恢复），清除 pin（若其点名该 key 的 SHA）并移除匹配的 fired 环前缀条目，使同 head 之后真正的失败再次 fire。已投递的红保留两个抑制器；head 前进照旧丢弃 pin。恢复时释放在死信记录写入**之前**保存到 watch 状态：恢复的死信守卫会在后续回合完成退役而不重新推导释放，故释放必须先于「让该守卫得以移除任务的那条记录」持久化（释放保存失败则留下停放任务且不写死信，交由下一次恢复重新折叠）。释放是事实驱动的——此分支 CI 必为正向绿——因此即便随后死信写失败、任务重试，释放也依然正确。退役停放的前驱同时解除按 PR 的 drain 保序守卫，幸存的净 `head_change` 无需等待过期事件的视界即可投递。

契约修订：bound-session-events 的验收「每个迁移实例恰好产生一条注入 prompt」变为「每个迁移实例恰好产生一条注入 prompt **或一次可见的被取代退役**」；合并后的 pending 跳变仍投递**一条**净变化 prompt 加一条 `watch_coalesced` 行。合法复发（dirty → clean → dirty、close → reopen → close、新 head 失败）仍会 fire；回到仍 pending 跳变的起点是 carved-out 例外（未投递时以零 prompt 退役）。2026-11-02 设计对在同一次改动中修订。

### 2. 停机缺口检测

- `GithubCursor` 新增 `lastPollAt?: string`，**仅在成功 poll 后**盖章（基类在 `pollOnce` resolve 后保存游标）。`validateCursor` 接受缺失（遗留游标）并丢弃畸形值。
- **每个** poll 比较 `now - lastPollAt > max(10 分钟, 5 × pollInterval)`；缺口超阈值时置内存标志 `startupDigestPending`（每个边沿一条 stderr）。健康 poll 重新盖章，故稳态不会触发。进程重启**与**进程内故障都算缺口：失败 poll 跳过游标保存，心跳保持陈旧直到 poll 恢复。阈值随配置的 poll 间隔缩放，长间隔 channel 不会每轮都 digest。

### 3. 评论积压摘要（按 PR，由缺口装载）

全局标志在**每个持久化 watch 条目**上装载持久化的按条目 `digestPending` 标志——不只是当前快照的活跃键，因此降级（空/部分）的首轮 poll 仍会把磁盘上的条目装载，完整快照到达前的重启也能找到装载。watch 上限切片之外的条目保留其装载直到被 watch。全局标志在一次可信、未中止且确实 watch 了内容的 pass 后清除；按条目标志为单个 PR 承载 digest，跨越逐 PR 错误、上限排除、不可信快照与重启。条目的装载在其积压被消费时清除（digest 落定且无省略、或无内容可投递）、在评论监视被禁用时清除（点名例外：积压在重新启用后按逐条投递）、或在静默首次观测时清除。停留的游标（省略尾部、被拒 dispatch、gate 宽限）**保留**装载。「完整但空」的绑定快照是权威缺席：条目按既有契约剪掉，随后出现的绑定是静默首次观测。

digest 模式也由**积压大小**装载：可投递窗口大于 `MAX_WATCH_COMMENTS_PER_PASS` 时无论心跳如何都 digest——持续逐 PR 拉取失败后恢复的端点会让心跳保持新鲜而游标停在数小时前，仅靠缺口永远无法装载。

在 `watchPrComments` 中，digest 模式替换逐条评论的 dispatch 循环：

- **正文预算，最新优先**：共享 bound prompt 上限（`BOUND_PROMPT_BODY_MAX_CODE_POINTS`，6,000）保留**前缀**，因此 digest 最新优先分配：完整成员行（作者 lead、按 `MAX_AGGREGATE_COMMENT_CHARS` 截断的摘录加截断提示、评论 URL）从最新往回接受，直到超出「上限减 lead 与前置省略提示」。最新成员因此总是幸存；共享上限绝不截断 digest 尾部。
- **归属排除基于已渲染片段与 follower 集**：follower 仅在写了**每个已渲染成员**时被排除（它已持有全部正文）；人口与逐条路径使用的绑定 follower 集相同，因此投递时 Gone 回退不会把 digest 交回给写了每个已渲染成员的会话。部分作者仍收到 digest——互相署名情形（两个角色各写一条）绝不能以零 prompt 消费整包。全目标排除不可达（每个可投递成员都有某个没写它的目标），故没有 digest 无目标分支。
- **省略无损且保留装载**：放不下的成员（超出最新 20 窗口或被预算丢弃）计入**前置**的 `offlineOmittedNotice`（「……将分批摘要补投」），其去重键**不**记录，游标停在积压头部之前**并保留装载**，下一 pass 重列并**再次 digest** 余量（已渲染后缀去重）。在此清除装载会把余量按一条评论一条 prompt 排空——正是本功能移除的洪泛。没有任何内容在未投递时被消费。
- 信封：`messageId` 为 `comment-digest:<n>:<排序后已渲染成员 key 的 sha256-40>`（对实际投递内容的哈希身份，镜像聚合 lane 的超集语义）；metadata 保持 `Trigger: comment.`，`boundEventClass` 解析为 `comment`，角色路由与逐条评论 watch 投递逐字节一致。`dispatchedComments` 恰好记录已渲染成员 key。信封携带**channel 账号**身份（`senderId = botUsername`），与本同账号车道上的逐条信封完全一致：合成 sender 会在群组发送者白名单 preflight 被拒（豁免匹配 channel 登录），从而退役 digest 而游标却推进过整段积压。
- **退役不等于消费**：retired 判定（如 preflight 拒绝）会消费任务并返回 settled 但**不**记录投递。digest 路径在 dispatch 后检查持久投递环；若事件未投递，保持 `since` 与装载，游标绝不推进过从未投递的成员。
- 游标：dispatch 已投递且无省略时提交 `nowIso`（清除装载）；有省略时停在积压头部之前（保留装载）；未投递时保持 `since`（保留装载）。gate-grace hold 在批次粒度保持既有一轮语义并保留装载。若连一个成员都放不下（病态长 URL），digest 回退到逐条路径并消费其装载。
- digest 路径从不递减 pass 级评论突发预算（每 PR 一个任务，而非每评论），故 digest pass 总是看到预算完好；预算继续约束逐条扇出。
- 跨实例说明：逐条评论 watch 投递经稳定 GitHub id 跨 channel 实例去重；digest 的哈希身份是实例局部的（每实例各有游标），与 watch 事件的「每订阅 at-least-once」语义一致。两个实例同看一个 PR 穿过同一缺口时各投递自己的 digest。

`BOUND_DELIVERY_COPY` 新增文案条目（en + zh）：带条数的离线积压 lead 与离线省略提示。省略提示前置，因为共享正文上限从尾部截断。结构性标记与平台值遵循既有语言契约（`en` 条目逐字节英文）。

## 设计决策与理由

1. **在检测与恢复两处按事实折叠。** 新事实在 `watchOnePr` 到达；在此折叠以一条代码路径覆盖两个 drain 变体（legacy 与角色感知）。恢复时对照持久化基线的折叠覆盖 watch pass 被跳过的轮次（预算、刷新失败）——否则恢复会在任何检测可折叠前投递过期停放任务。谓词按事实驱动，留队事件（死信写失败）与重跑变绿都在后续 pass 折叠，无需新跳变。
2. **死信是折叠的提交点，按记录作用域。** 复用溢出退役表面保持「呈现、绝不静默」与操作者已知的 fail-closed 写语义。事件级记录退役该事件的每个任务；按任务的耗尽记录只退役其点名任务，兄弟角色的停放任务因此幸存。
3. **只 digest 评论车道。** 它是唯一无界的积压源；其 `comment` 类别在不触碰已发布 channel-base 解析链的前提下保持角色路由一致。状态事件有界（每 PR 每缺口 ≤4）且折叠后都是当前的。
4. **心跳放在通知游标，仅成功时盖章。** 游标在每次成功 poll 后保存，与 watch 是否可运行无关，缺口信号不会被合法未运行的 watch 伪造；失败 poll 使其陈旧，进程内故障在 poll 恢复时被检测。比较每轮运行（纯本地检查），而非每进程一次。
5. **只排除全上下文作者，基于已渲染片段。** 写了每个已渲染成员的 follower 已持有全部正文，被排除；部分作者仍收到 digest。人口是绑定 follower 集（不只是解析出的目标），故 Gone 回退不会把 digest 交回给作者；片段是已渲染的（不是全部可投递成员），故写了整个已渲染窗口的目标即使更旧的省略成员不是它写的也被排除。早先的并集规则以零 prompt 消费互相署名整包——相对逐条路径（把每个会话没写的评论交给它）是回归。
6. **按 PR 持久化 digest 装载，装载到每个持久化条目。** 「pass 完成即清」的一次性全局标志在空/不可信快照、逐 PR 错误、watch 上限排除时丢失 digest；只装载快照活跃键又在降级首轮 poll 后重启时再次丢失。装载写入每个持久化条目，仅在该 PR 积压被消费时清除（或禁用监视、或静默首次观测）；停留的游标保留它。积压大小独立于心跳装载 digest，覆盖 poll 从未失败的恢复端点。
7. **最新优先正文预算，无损省略，保留装载。** 共享上限保留前缀；最新优先分配保证最可操作的成员幸存。游标停在省略前缀之前（其键不记录）**并保留装载**，使余量以更多 digest 补投——清除装载会把余量按一条评论一条 prompt 排空，正是本功能移除的洪泛。
8. **channel 账号身份；退役不等于消费。** digest 与本同账号车道的每条逐条信封一样携带 channel 登录，故群组发送者白名单豁免匹配；且 digest 路径在 dispatch 后校验持久投递环，retired 判定消费了任务却无投递时停留游标。两者任一即可闭环静默消费路径；两者都保留作为纵深防御。
9. **仅对未投递的同 head 退役释放抑制。** 已投递的红必须继续抑制红→绿→红抖动；从未投递的 CI 恢复退役绝不能耗掉该 head 的触发名额，故为该 SHA 释放 pin 与 fired 环前缀。
10. **不加配置键。** 该行为是对所报告痛点的严格改进且退役可见；操作者开关会增加没有被请求的表面（简单性优先）。

## 约束

- 通知游标、mark-as-read、publication audit、公开回退契约均不触碰。
- `PendingWatchEvent.headChangeFrom` 与 `PrWatchEntry.digestPending` 是增量字段；`isPrWatchEntryShape` 宽松校验（额外/布尔字段放行），遗留状态文件原样加载。
- `lastPollAt` 是 `GithubCursor` 的增量字段；缺它的遗留游标在首个成功 poll 盖章前跳过 digest 检测（不误 digest）。
- channel-base 是已发布包；本设计不改其任何导出。
- digest 在共享信封上限生效前自行约束到 `BOUND_PROMPT_BODY_MAX_CODE_POINTS`；摘录复用聚合 lane 常量。

## 风险

- **信息密度。** 大积压会从 digest 正文省略成员；前置提示点名条数并承诺分批摘要补投，停留的游标加保留的装载保证该补投。接受：替代方案正是本设计移除的 prompt 洪泛。
- **停机前陈旧 pending。** 停机时仍在 `pending` 的事件在首次折叠前排空（见范围）。有界且检测时当前；v1 接受。停放的背压任务——过期主路径——在检测与恢复两处折叠。
- **任务存储扫描成本。** 存储每 watch pass 读一次（而非每 PR）、每恢复 pass 读一次；两者本就被每轮 poll 读取。折叠在内存中对照基线比较 key。
- **digest 装载重入.** dispatch 被拒（或退役但无投递）的已装载条目从 `since` 重试并带成员去重；省略尾部在下一 pass 再次 digest。「完整但空」快照剪掉条目（权威缺席），故随后的绑定是静默首次观测。禁用评论监视会清除装载（点名例外）：积压在重新启用后按逐条投递。
- **多实例重复**：共享缺口期间每实例一条 digest——与既有 watch 事件语义一致，已在上面载明。

## 验证计划

- 单元测试（collocated，`GithubAdapter.test.ts`，`startup backlog` 套件 65 例）：每条折叠分支在 pending 事件与停放任务上（head 前进、CI 恢复、冲突解决、PR 重开、往返），死信写失败后的事实驱动重试，watch pass 跳过时的恢复基线折叠，按任务与事件级死信记录的作用域（兄弟角色幸存），fail-closed 死信写，`unknown`-SHA 与 null-mergeable 不折叠，在途/已投递任务绝不折叠，跨**仓库**任务作用域（同 PR 号），带 `watch_coalesced` journal 行与端到端 `headChangeFrom` 生成的合并，合并器跳过已死信 pending 跳变，部分扇出投递后的往返排入反向跳变，CI 恢复释放让同 head 之后的失败再次 fire，恢复时释放保存失败保留停放任务待重试完成释放，畸形 `headChangeFrom` 丢弃条目，溢出退役在进程内保持事件级索引最新；缺口下限（6 分钟否 / 11 分钟是）、间隔缩放、进程内故障恢复、遗留游标容忍、时钟偏移；digest 正文预算（最新幸存、无尾部截断）、无损省略尾部以**更多 digest** 补投且保留装载、内容哈希 id 形状、重列去重、互相署名、基于已渲染片段与 follower 集的排除、群组发送者白名单下投递 digest、retired 判定（message-route preflight）停留游标与装载、无缺口时按大小装载、游标提交/保持、按 PR 装载在部分/空快照与重启下的保留、持续拉取失败运行逐 PR 处理器、gate 宽限与被拒 dispatch 保留装载、预算耗尽、缺口下首次观测静默。
- E2E（封闭 mock GitHub + 隔离 daemon，按绑定投递夹具模式；两阶段：启动 → 绑定 → 静默基线 → 停止 → 重写 `commentSince`/`lastPollAt` 模拟缺口 → 重启）：断言绑定会话 transcript 中**一条** digest prompt 且记录已渲染成员去重键；无缺口对照断言逐条评论投递不变；背压臂（prompt 队列满、CI 变红后 head 前进）断言过期 `ci_failure` 任务从 `github-inbound-tasks.json` 退役并有 superseded 死信行；满员积压臂断言最新成员在正文预算内幸存；缺口下首次观测臂断言静默。首次启动前预种 watch 状态**不可行**：首个「完整但空」的绑定快照会剪掉未绑定条目。
- `npm run build && npm run typecheck`，改动文件的聚焦 vitest。

## 验收标准

1. 非当前 head 或正向恢复 head 的 `ci_failure`、明确观测非 dirty 后的 `merge_conflict`、reopen 后的 `state_change`、中间 pending head 跳变被退役/合并，带死信 + journal 痕迹（合并：仅 journal，净变化 prompt 仍投递）——无论事件在 `pending` 还是停放背压任务，无论 watch pass 运行还是被跳过；CI 恢复退役释放该 head 的抑制使之后真正的失败再次 fire；合并器绝不吸收进已死信 key，部分投递后的往返排入反向跳变；恢复回合仅在记录覆盖该任务时完成已死信 watch 任务的退役；无任何静默消费；死信写失败事件留队/任务继续停放；在途与已投递任务绝不折叠。
2. 缺口超阈值后（或窗口大于逐条评论 pass 上限），每个绑定 PR 的同账号评论积压以类别为 `comment` 的私有 digest prompt 到达——每个正文预算窗口一条，最新成员在预算内，恰好记录已渲染成员去重键，基于已渲染片段与 follower 集排除全上下文作者，channel 账号身份被发送者白名单接纳，retired 判定绝不推进游标，省略成员以更多 digest 补投（游标停留，装载保留，无丢失）。
3. 无缺口（或首次观测）且可投递窗口在逐条评论 pass 上限内时，**评论**投递与今天逐字节一致：逐条评论 prompt、静默基线、无 digest。窗口**超过**上限时即使无缺口也打 digest（标准 2 的大小装载——对旧的逐条突发排空的有意扩展，评论监视契约对已记录）。常开的被取代折叠无论有无缺口都适用于 watch 事件——那是标准 1，不是评论投递变化。
4. 角色感知路由、accepted/running/已投递任务的恢复、通知 lane、公开发布契约不变；已死信停放 watch 任务的恢复现在完成其退役（§1）而非投递。

## 开放问题

- 若操作者反馈显示长缺口后通知 lane 的异账号积压同样痛苦，后续可在其自有设计下把 digest 扩展到该 lane（其 mark-read/audit 契约需要单独处理）。
