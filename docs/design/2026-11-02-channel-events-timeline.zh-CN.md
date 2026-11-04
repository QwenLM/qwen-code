# Web Shell 中的渠道事件时间线

[English](2026-11-02-channel-events-timeline.md) | [简体中文](2026-11-02-channel-events-timeline.zh-CN.md)

状态：已实现。日期：2026-11-02。2026-11-04 更新：覆盖 PR 绑定会话的私投递（§5）与 `failed_ambiguous` 发表结果。

## 问题

渠道的大量行为目前只能从 stderr 看出来。当 GitHub 渠道没有回复某条评论时，运维人员在 Web Shell 里无法判断：通知是被 `reasonFilter` 过滤了、因为评论没有 @ 机器人被丢弃、被发送方门禁拒绝、被去重跳过，还是已经回答但最终被抑制（suppressed）而没有发表。渠道管理页只显示配置和运行时徽标（`stopped` / `starting` / `connected` / `partial` / `error`），不显示渠道实际做了什么。

能回答这些问题的信息其实零散存在：preflight 拒绝和轮询失败写 stderr，发表结果写 `github-audit.jsonl`，入站任务状态写 `github-inbound-tasks.json`，通知原因过滤只写 debug payload。这些都没有 daemon 可读的出口，所以任何页面都拿不到。

## 目标

- 按渠道记录渠道做了什么，写入一个有上限、只追加的事件日志。
- 用工作区作用域的只读 daemon 路由暴露该日志。
- 在 Web Shell 以独立页面展示跨渠道时间线，支持按渠道和事件类型过滤。

## 非目标

- 日志不记录消息正文。运维人员看到的是路由决策和结果，不是会话内容。
- 不做实时推送（SSE）。页面用轮询，因为渠道 worker 与 daemon 是不同进程。
- 不新增能力位。页面复用 `channel_management` 门禁——事件日志本来就只在该能力存在的地方存在。
- 除一个轮转文件外不做保留策略。事件日志是诊断用的，`github-audit.jsonl` 仍然是发表记录。

## 现状

- `packages/channels/base/src/PollingChannelBase.ts` 负责轮询和退避，轮询失败只写 stderr。
- `packages/channels/base/src/ChannelBase.ts` 在 `preflightInbound` 中拒绝入站消息（消息路由、群门禁、私信门禁、发送方门禁），并通过 `logPreflightRejected` 打一行原因。
- `packages/channels/github/src/GithubAdapter.ts` 轮询 GitHub 通知，按 `reasonFilter` 过滤，用游标记账去重，把入站任务记在 `github-inbound-tasks.json`，把发表结果记在 `github-audit.jsonl`。
- `packages/cli/src/serve/routes/workspace-channel-management.ts` 提供渠道配置、生命周期和配对路由，没有任何读取运行时活动的接口。
- `packages/web-shell/client/components/channels/ChannelsManagerPage.tsx` 是 Web Shell 唯一的渠道界面。

## 设计

### 1. 事件日志（`packages/channels/base/src/channel-events.ts`）

渠道按事件追加一行 JSON。文件与其他工作区作用域的渠道状态文件放在一起：

```
~/.qwen/channels/<workspaceScopeDir>/<encodedName>-<nameHash16>-channel-events.jsonl
```

其中 `<workspaceScopeDir>` 为 `getWorkspaceScopeDirName(config.cwd)`，文件名沿用 GitHub 状态文件已有的 `encodedName` + `nameHash16` 规则，渠道名无法逃出该目录。

记录字段：

| 字段          | 含义                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `at`          | ISO 时间戳                                                              |
| `channel`     | 渠道实例名，完整保留（见下方上限）                                      |
| `type`        | `inbound` / `outbound` / `task` / `poll`                                |
| `outcome`     | `accepted` / `skipped` / `posted` / `failed` / `ok` / 任务状态（见 §5） |
| `reason`      | 跳过原因的机器码（`sender_denied`、`reason_filter` 等）                 |
| `triggerKind` | 渠道特定的触发类型（`mention`、`assign` 等）                            |
| `repository`  | 会话容器（GitHub 下为 `owner/repo`）                                    |
| `thread`      | 线程标识（`issue:12`、`pr:34`）                                         |
| `number`      | issue 或 PR 编号                                                        |
| `actor`       | 发送方登录名                                                            |
| `sessionId`   | 事件被路由到的会话；在 `retired` / `skipped` 行上是它失去的那个（§5）   |
| `messageId`   | 来源消息标识                                                            |
| `durationMs`  | 轮询耗时                                                                |
| `error`       | 单行化错误信息，上限 200 字符                                           |
| `detail`      | 扁平原始类型映射，最多 12 个键                                          |

上限：自由文本字段与 `detail` 的值截断到 200 字符。渠道标识是例外：管理接口接受最长 255 UTF-8 字节的名字，而码点数不会超过字节数，因此标识保留到 255 个码点——任何合法名字都完整保留，并且仍能被 `channel` 过滤匹配。只有界面在展示时缩短它。

追加会超过 1 MiB 时轮转为 `<name>.1`，旧的 `.1` 被替换。目录权限 `0700`，文件权限 `0600`。任何写失败都吞掉并只打一行 stderr：诊断设施绝不能打断消息处理。

### 2. 记录点

| 位置                                                           | 事件                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `ChannelBase.logPreflightRejected`                             | `inbound` / `skipped`，带拒绝原因                                                                            |
| `ChannelBase.preflightInbound`（消息路由、`mention_required`） | `inbound` / `skipped`，原因 `message_route` 或 `group_mention_required`                                      |
| `ChannelBase.processPreflightedInbound`                        | `inbound` / `accepted`                                                                                       |
| `PollingChannelBase.runLoop`                                   | `poll` / `ok` 带 `durationMs` 与适配器详情；`poll` / `failed` 带 `consecutiveErrors`                         |
| `GithubAdapter` 原因过滤                                       | `inbound` / `skipped`，原因 `reason_filter`；单轮超过 20 条后，其余合并为一条带 `detail.filtered` 计数的记录 |
| `GithubAdapter` 评论通道（`onlyMentioned` 未命中）             | `inbound` / `skipped`，原因 `mention_required`                                                               |
| `GithubAdapter` 去重命中                                       | `inbound` / `skipped`，原因 `duplicate`                                                                      |
| `GithubAdapter.claimInboundTask`                               | `task` / `accepted`；目标是绑定会话时带 `sessionId`                                                          |
| `GithubAdapter.transitionInboundTask`                          | `task` / `<state>`，带 `attempts`、`error` 与绑定的 `sessionId`；终态用词由 §5 覆盖                          |
| `GithubAdapter.recordPublicationAudit`                         | `outbound` / `<outcome>`（审计文件继续保留）                                                                 |
| `GithubAdapter.runInboundTask`（私投递判定）                   | `task` / `delivered`，或 `task` / `retired` 带原因（§5）                                                     |
| `GithubAdapter.retireBoundTask`                                | `task` / `retired`，原因 `dead_letter`；`task` / `failed`，原因 `dead_letter_write_failed`（§5）             |
| `GithubAdapter.drainPendingWatch`（claim 前退休）              | `inbound` / `skipped`，原因 `watch_no_candidate`（§5）                                                       |
| `GithubAdapter.watchOnePr`（待办队列溢出）                     | `inbound` / `skipped`，原因 `watch_pending_overflow`（§5）                                                   |
| `GithubAdapter` 绑定扫描与 watch 守卫                          | `poll` / `degraded`，带原因，只打在既有限流点或状态边沿上；绑定扫描行另带 `detail.streak`（§5）              |

`PollingChannelBase` 增加 `setPollEventDetail` 挂点，适配器可以挂自己的计数（GitHub 报告本次轮询取到多少条通知），基类不需要知道这些字段。基类在轮询开始前清空该字段，并在本次轮询结束后才消费它，因此事件绝不会把上一次轮询的计数记到本次的时间戳上。

### 3. daemon 路由

```
GET /workspace/channels/events
GET /workspaces/:workspace/channels/events
```

查询参数：`limit`（1-500，默认 100）、`type`（逗号分隔）、`channel`（每个实例名重复一次该参数）、`since`（ISO 时间戳）。

响应：`{ "events": [...], "truncated": boolean }`，`Cache-Control: no-store`，并沿用其他工作区渠道路由的信任与客户端校验。

路由从不接受请求给出的路径。作用域目录由解析后运行时的 workspace cwd 经 `getWorkspaceScopeDirName` 推导；受管渠道的工作目录必须规范化到同一个工作区，因此它的日志就在那里。`channel` 过滤会先按名字推导出的标识收窄候选文件，**再**套用任何上限，因此即使更繁忙的同伴有更新的文件，被显式请求的安静渠道仍然可达。

读取是异步且分块的，因为这条路由跑在同时服务会话的 daemon 上：同步扫描数 MiB 会让其他所有请求在整个扫描期间停摆。上限为每个日志文件（当前与 `.1`）256 KiB、每次请求合计 4 MiB、每次请求 32 个日志文件、最多返回 500 条记录；候选按最近修改优先排序，把额度花在运维最可能查看的日志上。任何被上限裁掉的情况都会置 `truncated`：丢弃文件、字节预算耗尽，**以及单个日志高于尾部窗口**——文件在轮转前会长到 1 MiB，因此 256 KiB 窗口会漏掉该渠道自己更早的事件。这样页面的完整性提示在上述任一情况发生时都不会声称时间线完整。预算按整份日志预留——只有剩余额度装得下它的整个窗口才读它——因此余量不足一个窗口时，小日志仍会被读取，标记也始终意味着「有整份日志被漏掉」。从文件中间开始的窗口会多读一个前导字节，用来区分残缺首行与完整首行，因此正好落在行边界上的窗口会保留它读到的每一条记录。

每一行仍要被解析才能过滤，但累积量一旦超过 `limit` 的四倍就裁到最新的 `limit` 条，因此繁忙工作区的一次轮询不会把它解析过的每条记录都留在内存里。裁剪不会改变答案：被丢弃的记录比留下的每一条都旧，而排序是稳定的，因此同一时刻的记录保持写入顺序。裁剪等同于触及记录数上限，因此同样会置 `truncated`。

作用域目录不存在表示「还没有渠道写过」，仍返回空结果。其他读取失败（权限、I/O）会向上抛出，路由回 5xx 而不是空列表：读不到日志时，绝不能把答案说成「这个工作区的渠道什么都没做」。

### 4. Web Shell

- `useChannelEvents` 在页面挂载且可见期间轮询该路由（5 秒），标签页隐藏时暂停、重新可见时刷新；页面另提供手动刷新。**同一时刻只允许一个轮询周期在途**：请求未完成时恢复可见绝不能再启动一个，否则两者结束时都会 schedule，而只保留最后一个定时器句柄，另一个成为永远轮询的孤儿——慢响应下的普通标签页切换会永久倍增日志读取。因此请求在途时恢复可见，是让该请求结束后再重新排程。两条读取路径都有时间上界（SDK 默认 30 秒 fetch 超时与 action 超时），所以该守卫不会让循环停摆。每份快照都带上产生它的查询（工作区、渠道、类型、limit），不匹配的数据会被遮蔽，做法与 `useDaemonChannels` 一致：底层 resource 在请求进行中或失败后仍保留旧数据，没有这个标记的话，上一个工作区的行——以及过滤选项里它的渠道名——就会显示在新选中的工作区下。
- `ChannelEventsPage` 渲染按时间倒序的时间线，带工作区选择器、渠道过滤、类型过滤，每行显示：时间、渠道、类型、结果、目标（`owner/repo#12`）、操作者、原因或触发类型、耗时、错误。私投递还会显示它到达的会话：一个截断到 8 个字符的标记，完整标识放在 `title` 里——否则一个 UUID 会把原因和计数挤出该列。绑定扫描的 `degraded` 行显示 `detail.streak`（扫描次数，不是轮询次数），且**只有 `bindings_partial` 行**带 `detail.sessions`；`bindings_cold_empty` 与 `bindings_unreachable` 只带 `streak`，因此「是否存在 sessions」不能当作「这次扫描是部分结果」的判据。watch 守卫行只显示原因。工作区选择器与管理页一样列出已注册的非 live 工作区，因为 provider 的 cwd 是 daemon 全局的主工作区，否则在次工作区启动的渠道将无法查看。切换工作区会重置渠道过滤。
- 适配器能写出的每个结果都有中英文标签。`KNOWN_OUTCOMES` 被导出，以便测试断言两份目录都覆盖它：翻译器会先回退到英文、再回退到原始键，所以缺一个中文标签只会静默显示英文。页面不认识的结果仍按原始 token 渲染——不好读，但安全。
- 它是独立页面：`activePanel` 取值 `channel-events`，URL 为 `/channel-events`，侧边栏主导航项为 `channelEvents`。
- 由 `channel_management` 能力位与受信任工作区门禁，与管理页一致。

### 5. 投递到 PR 绑定会话（私投递）

PR #16117 增加了第二条投递通道：开启 `deliverToBoundSessions` 后，落在某个 daemon 会话所关注 PR 上的 GitHub 事件会被注入该会话，而不是公开回复；`prWatchEvents` 又增加了面向运维的 PR 状态变化，这类事件**只能私投递**——绝不能走公开回复路径。上面那套日志讲不清这条通道的故事：

| 事实                                 | 改动前                                      |
| ------------------------------------ | ------------------------------------------- |
| prompt 已被会话接受                  | 最后一行是 `task` / `running`，然后没有下文 |
| 是哪个会话收到的、以及它是私投递     | 任何 task 行都没有 `sessionId`              |
| 投递前被渠道门禁拒绝                 | `inbound` / `skipped`，后面跟两条 `running` |
| watch 事件被私下退休（三个不同出口） | 只有 stderr                                 |
| 事件在背压上限处被投入死信           | 只有 stderr 和死信文件                      |
| 绑定扫描让所有通知停摆               | 只有 stderr；轮询本身仍报 `ok`              |

第一行最糟：已投递的事件和仍在途的事件，最后一个词是同一个。

**用判定结果，而不是布尔值。** `deliverToBoundSession` 是私有方法且只有一个调用方。它原来的 `boolean` 含义是「已了结」，把「注入成功」「私下退休」「公开回退」混为一谈——只有第一个才是投递。现在它返回 `{ kind: 'delivered' }`、`{ kind: 'retired', reason, sessionId? }`、`{ kind: 'public' }` 或 `{ kind: 'deferred' }`，由 `runInboundTask` 据此推导日志的终态用词。路由、回退、预算与游标判定一个都没改：deferred 就是原来的 `false`，其余判定都是原来的 `true`。public 判定不发任何事件，因为公开路径自己会记接受与发表。退休判定会带上它失去的那个会话，因为那些出口在返回前就清掉了 delivery。

`transitionInboundTask` 增加一个可选的日志覆盖参数，使私投递的接受标记仍能按 `running` 持久化（不存在 `delivered` 这个任务状态——记录紧接着就被删除），而日志的最后一个词是终态。没有这个覆盖，被 preflight 拒绝的事件仍会以 `running` 收尾——和「还在投递中」无法区分——因为那个出口在 delivery 仍然挂着的情况下就消费掉了任务。同一个方法还会记住任务进来时持有的目标，因此清除 delivery 时写的那些行仍带着 `sessionId`，不会丢掉它们所指的那个会话。

这份记忆是**持久化**的（任务记录上的 `lostSessionId`），而不只够一行用。gone 会话回退会清掉 delivery，之后每一轮都重新进入缺失门禁、最终进入死信，届时已无 delivery 可读；只记一次转换会让这些行全部无名——包括终态行，而那正是运维用来判断「是哪个会话弄丢了事件」的那一行。该字段只用于归因：**刻意不恢复 delivery**，否则会重新进入私投递并改变路由。它只在显式清除时写入，因此只是省略该键的转换不会扰动它，并像记录的其他字段一样按可选字符串校验。

同一条规则也覆盖两处发生在任何任务被 claim 之前的退休：它们的 `inbound` / `skipped` 行带上待办条目里冻结的目标，而该目标本来就已写进同一事件的死信记录。没有它，时间线与死信就会对同一次被监视的状态变化给出不一致的归属。

**新增结果词。** `task` / `delivered` 与 `task` / `retired` 只是日志用的终态词，不是持久化的任务状态。`retired` 带原因：`preflight_rejected`、`watch_no_target`、`watch_no_candidate`、`watch_session_gone`、`dead_letter`。死信追加失败记 `task` / `failed`，原因 `dead_letter_write_failed`，因为任务被保留、仍可恢复——那不是退休。每一条终态行都写在它所描述的持久化步骤**之后**，因此删除或保存抛错时，不会为一个下一轮还会重跑的事件留下退休声明。

有两处 watch 退休发生在任何任务被 claim 之前，因此没有 task 行可收尾，改记 `inbound` / `skipped`：完整快照下已无候选时记 `watch_no_candidate`；按 PR 的待办队列超过上限、最老的事件被未投递退休时记 `watch_pending_overflow`。claim 前退休在 watch 状态保存抛错时会回滚它的 slice：slice 在保存之前就改了已加载的内存态，而保存失败不会清除已加载标志，因此不回滚的话下一轮会跳过该条目、随后一次保存又把截断后的状态写回磁盘——事件就此丢失且不留任何痕迹。

**不新增事件类型，不改线上形状。** `outcome` 在日志、SDK 和路由里都是自由字符串，所以四个类型、两条路由与响应形状都不变，只有页面的标签目录变大。协议**参考文档**是要更新的，因为集成方正是在那里读词汇：它现在写明了开放的 outcome 字符串、新的终态与原因，以及哪些行带 `sessionId` 与 `detail`。曾考虑用 `outbound` 表示私投递注入，被否掉了：那个类型的含义是「已发表到 GitHub」，而绑定会话的回复明确不发表。

**绝不记录消息正文。** 死信记录为了运维恢复会带 `text`，其写失败路径还会把整个 payload dump 到 stderr。两者都不进日志：失败行只带写盘错误。有一条测试断言正文出现在 stderr、且不出现在任何日志行里。

**依赖降级。** 绑定扫描是一个新的硬依赖：只要它从未成功过，冷启动门就会推迟评论通道，于是**所有**通知停摆，而轮询本身仍报 `ok`。适配器现在在它**本来就限流**的那几行 stderr 旁边记 `poll` / `degraded`——`bindings_unreachable`（首次失败，之后每十次）、`bindings_partial`（第十次，之后每六十次，带 `detail.sessions`）、`bindings_cold_empty`（首次，之后每十次，以及有界逃逸打开评论通道时再记一次）——并在既有 `watchReconcileBlocked` 标志的 false→true 边沿记 `watch_reconcile_blocked` / `watch_pending_unreconciled`。复用这些限流和这个标志意味着不新增适配器状态、也不新增洪水：永久故障不会把有用的行挤出日志轮转窗口。

`detail.streak` 统计的是**绑定扫描次数，不是轮询次数**：`refreshBoundSessions` 在每次 gone 会话重试时也会跑，所以一次轮询可能让它加不止一次。标签与 stderr 措辞因此都说「扫描」。同理 `detail.sessions` 统计的是会话数，而不是路由映射的大小——映射按 PR 建键，一个会话关注两个 PR 就会被报成两个会话，把运维支使去查一个根本没发生的漏读。它等于本次扫描列出的会话行**加上部分快照下保留仍在路由的会话**，受 `MAX_PARTIAL_RETAINED` 封顶。只数 listed 行会把一个「保留会话仍在收投递」的 draining 工作区报成 0，并给出一个并非页容量的页容量诊断。它是会话行的计数，不是通过映射自身过滤后剩下的条目数（建映射时会跳过 channel 自有的会话与无法解析的绑定 URL）。行标签与 stderr 都写「列出 / listed」，这个词是「列出或被保留」的简写，两个表面打印的是同一个数字。

**恢复记在清零边沿上**，即 `watch_reconcile_recovered`。`poll` / `ok` 行不能充当这个信号：基类在每次不抛错的轮询后都会写一条，包括持续故障期间的每一次，所以它在整个降级窗口都存在、结束时也没有变化。只有 watch 守卫这几个原因有恢复行。`bindings_unreachable` 与 `bindings_cold_empty` 是隐含恢复的——扫描一旦成功就不再产生它们，下一次 streak 从头开始。**`bindings_partial` 不是带恢复边沿的降级**：成功的多页扫描恰恰是它的*生产者*，而 `partialSnapshotStreak` 只在完整快照时清零，永远多页的守护进程永远不会返回完整快照。它是一条常驻健康提示，因此运维不能把「它安静下来」当作恢复的证据。

watch 守卫行还会区分成因。`hasUnreconciledWatchPending()` 在读取错误时 fail-closed，所以不可读的 sidecar 同样会阻塞恢复——但把它报成待办积压，给出的补救（重新开启订阅）根本解决不了。订阅关闭时先加载状态：读取失败记 `watch_reconcile_blocked` 并带上错误，`watch_pending_unreconciled` 只留给确实持有待办事件的状态。门本身不变，仍然 fail-closed。

曾考虑把绑定扫描的健康信息挂到现有轮询 detail 上，被否掉了：`setPollEventDetail` 由评论通道调用，而两个冷启动门都在它**之前**就 return——恰恰在它最该报告的那种情况下，detail 永远设不上。

绑定扫描与 watch 这条通道里有五处反复出现的 stderr 是刻意不记的：watch pass 失败、「保留旧映射」的刷新失败、部分快照超过 `MAX_PARTIAL_RETAINED` 时丢弃最旧未列出会话的保留上限裁剪、空闲 watch 条目的条目上限驱逐，以及让最旧的绑定 PR 超出 `MAX_WATCHED_PRS` 而不被监视的 watch 上限。五者在条件成立期间每轮都打、没有限流，也没有现成标志可做边沿触发，覆盖它们就得为诊断新增适配器状态。

它们的后果并不一样重。watch 上限最重：被排除的 PR 根本不会被监视，它的状态变化一行都不产生，运维读到的是沉默而不是迟到的答案。保留上限裁剪次之——被丢弃会话的事件会被延迟、到点进入死信，运维几小时后看到终态行却没有任何一行说明会话被裁剪过。条目上限驱逐按构造是最轻的：它只驱逐没有待办事件、没有存活绑定认领、也没有在飞 watch 任务的空闲条目，因此不会丢掉任何可投递的事件。若将来要加这类状态，这两个容量站点是第一批候选。

这是对这条通道里反复出现的健康与容量站点的清点，不是对适配器里每一行 stderr 的清点。另有两类同样只写 stderr，在此点名以免有人再去找：一次性加载诊断（watch 状态损坏、条目畸形或容器不可用、旧状态迁移），它们每次加载只打一次而不是每轮打；以及按 PR 的请求失败（例如一次 CI 拉取），它只让一个 PR 在一轮里少掉检测。入站任务读取失败不属于这两类——它会向上抛出，成为一条 `poll` / `failed` 行。

一条量级说明：死信追加持续失败时任务保持可恢复，因此重试——以及它的 `dead_letter_write_failed` 行——每轮都会重复。这与既有的背压/失败转换对卡住的任务本来就每轮写一行是一致的，并由轮转封顶。给它加限流就得为「磁盘满」这种紧急状态新增按任务的状态，而这种状态的要害恰恰是事件已经没有任何持久化落点了。

**发表结果词汇。** `failed_ambiguous`（歧义的发表错误：评论可能已经落地，再发一条公开回复就不可逆）本来就会写进日志，却没有标签，界面上显示为原始 token。现在它有了中英文标签，并按失败着色。

## 涉及文件

- `packages/channels/base/src/channel-events.ts`（新增）及其测试
- `packages/channels/base/src/ChannelBase.ts`
- `packages/channels/base/src/PollingChannelBase.ts`
- `packages/channels/base/src/index.ts`
- `packages/channels/github/src/GithubAdapter.ts`
- `packages/cli/src/serve/routes/workspace-channel-management.ts`
- `packages/sdk-typescript/src/daemon/types.ts` 及其 barrel
- `packages/web-shell/client/hooks/useChannelEvents.ts`（新增）
- `packages/web-shell/client/components/channels/ChannelEventsPage.tsx`（新增）
- `packages/web-shell/client/components/channels/channel-events-messages.ts`（新增）
- `packages/web-shell/client/App.tsx`、
  `components/sidebar/WebShellSidebar.tsx`、`utils/navigationUrl.ts`、
  `i18n.tsx`

§5 改动 `packages/channels/github/src/GithubAdapter.ts` 及其测试、`ChannelEventsPage.tsx` / `.module.css` / `.test.tsx`、`channel-events-messages.ts`，以及 `docs/developers/qwen-serve-protocol.md`——集成方读的那份参考，现在公开了结果词汇并写明哪些行带 `sessionId` 与 `detail`。日志模块、基类、daemon 路由、SDK 类型与线上形状均未改动。

## 设计决策

- **用文件日志而不是 IPC。** 渠道运行在 daemon fork 出来的 worker 进程里。文件让 daemon 路由保持只读、无状态，并在 worker 重启后仍然存在——而运维人员正是在重启前后查最近发生了什么。
- **一个通用日志，而不是 GitHub 专用。** 所有渠道类型都继承基类的记录点；页面本身是跨渠道的，只做 GitHub 会导致很快需要第二套实现。
- **不记录消息正文。** 日志不能变成第二份未脱敏的消息历史；发表事件只带结果，正文摘要仍由现有审计文件的 `bodySha256` 与 `bodyChars` 承担。
- **复用 `channel_management`。** 新增能力位要动三处注册表和漂移断言，却没有用户可见收益：事件日志只在渠道管理存在的地方存在。
- **保留 `github-audit.jsonl`。** 它回答的是另一个问题（发表了什么、正文摘要），恢复流程已经在读它。

## 风险

- 繁忙群渠道的环境消息跳过可能很频繁。日志靠轮转封顶，页面请求最新 200 条事件，没有无界增长。（100 是调用方不带 `limit` 时路由自身的默认值。）但只靠轮转不足以保住窗口的**有用性**：只要还有可恢复的入站任务——`accepted`、`running`，或 `failed` 且仍有重试次数——GitHub 的轮询游标就不前进，于是服务端每轮都返回同一批通知，而被过滤的通知在任何去重之前就被跳过。进行中的回合本身不会造成这一点：轮询循环 `await pollOnce()`，回合进行中根本不会发起新的轮询；真正可达的情形是任务失败但仍可重试。一次真实运行（2 秒轮询 + 一个反复失败的回合）把同一批 300 条被过滤通知反复写入，直到日志轮转，把 accepted/posted 行挤出了页面窗口。因此适配器每轮最多记 20 条 `reason_filter`，其余合并为一条带 `detail.filtered` 的记录，页面把它渲染成计数。对真实适配器实测：15 轮共返回 4500 条通知，只写入 315 行而非 4500 行，且日志没有轮转。该额度按轮计算，因此真正新到的一批仍会被完整描述。
- 同步追加位于消息路径上。记录很小且失败被吞掉；改成异步队列会在崩溃时丢掉最后几条事件，而那时恰恰最需要它们。
- 路由每次请求都读磁盘。读取以 64 KiB 分块 await、每次请求预算 4 MiB，因此一次轮询会让出事件循环而不是阻塞它；页面仅在标签页可见时每 5 秒轮询一次。

## 验证

- 单元测试：日志的追加/读取/过滤/轮转/上限与被吞掉的写失败；GitHub 的入站跳过、任务与发表事件；路由按渠道和类型过滤、夹在解析后的工作区内、支持 `since`。
- Web Shell：页面渲染行、两个过滤器生效、空态与错误态正确。
- 手工：用一个测试仓库跑 GitHub 渠道，确认页面能看到会话创建之前的过滤跳过，并按顺序看到接受的触发、任务状态变化与发表结果。
- §5 单元测试：私投递以 `delivered` 收尾并点名会话；preflight 拒绝以 `retired` 收尾、绝不是 `delivered`；rebind 能看到两个会话 id，并钉住重定向那一行的用词；每一处 watch 退休——含 claim 前跳过与待办队列溢出——与死信（两种结果）都被记录；正文进了死信文件与 stderr 但没进任何日志行；每个降级原因在一个限流窗口只出现一次、在后续窗口重复发射、并在归零后重新开始；冷启动逃逸在成功与失败两条路径上都于上限处被记录；删除或保存抛错时不声称退休；watch 守卫的清零边沿被记录，因为 `poll` / `ok` 行在整个故障期间都在写、无法标记它的结束。以上每个守卫都做了变异验证：37 个变异，37 个被杀。其中两个专门用来证明隐私断言是真的在起作用——一个把正文塞进退休行的另一个字段，另一个把正文拼在写盘错误后面、让错误断言仍然通过。另有两个最初存活，被追查而不是被接受：一个宽松的 `sessionId` 计数——即使清除行没有归属，另外三条正确归属的行仍能满足它；以及一个在测试重命名后匹配不到任何测试的变异过滤器。分不清「没有测试运行」与「守卫成立」的 sweep 不算证据，因此 harness 现在会显式报出这种情况。
- §5 Web Shell：`failed_ambiguous` 在中英文下都渲染标签而不是原始 token；会话标记截断显示、完整 id 在 `title` 里；降级计数正确渲染，并在不带计数的行上断言其**不出现**；两份目录覆盖 `KNOWN_OUTCOMES` 的每一项。

## 验收标准

- 运维人员能在 Web Shell 里查明某条 GitHub 通知为什么没有产生回复（原因过滤、未 @、门禁拒绝、去重），不必翻 stderr。
- 发表结果与入站任务失败出现在同一条时间线上。
- 轮询失败与恢复以 `poll` 事件出现，并带上连续错误次数。
- 日志不写消息正文，任何路由都无法读到解析工作区之外的渠道状态。
- 私投递的事件以一条点名目标会话的终态行收尾；未投递就被退休的事件绝不会声称自己投递成功。
- 让评论通道停摆的绑定扫描能在时间线上看到，不必翻 stderr；并且在它一直坏着的时候不会灌满日志。
