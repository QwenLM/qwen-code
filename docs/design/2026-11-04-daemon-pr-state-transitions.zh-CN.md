# 由 daemon PR 刷新产生 PR 状态转换事件

[English](2026-11-04-daemon-pr-state-transitions.md) | [简体中文](2026-11-04-daemon-pr-state-transitions.zh-CN.md)

状态：提案（2026-11-04）。实现后取代 [GitHub Channel 事件投递到 PR 绑定会话](2026-11-02-github-channel-bound-session-events.zh-CN.md) 中"PR 状态监视"的部分；该设计的评论投递部分不变。

## 问题

daemon 对每个会话绑定的 PR 状态跟踪了两遍，用两套凭据、两套调度，以及两种"CI 失败"的定义：

1. `packages/cli/src/serve/server/session-pr-refresh.ts` 已经每 5 分钟（`QWEN_SESSION_PR_REFRESH_MINUTES`）扫一遍每个受信 workspace 的 PR sidecar，用 daemon 宿主的 `gh` 凭据跑 `gh pr list`，重写每个 sidecar 的 `state`（open / merged / closed）和关闭的 issue。Web Shell 侧栏读取结果。不会向会话投递任何东西。
2. GitHub channel 的 PR 状态监视（`packages/channels/github/src/GithubAdapter.ts` 里的 `runPrStateWatch`）每次 channel 轮询（默认 60 秒）用 channel 自己的 token 经 Octokit 轮询每个绑定 PR：每个 PR 一次 `pulls.get`，加上按条件调度的 `checks.listForRef` 与合并状态，上限 30 个 PR，带自己的 `github-pr-watch.json` 状态文件、pending 队列、fired 环、死信和 reconcile 规则。它检测 `ci_failure`、`merge_conflict`、`head_change`、`state_change`，并通过 daemon 的 prompt 路由投递到绑定会话。

第二个轮询器只在运维者配置了带 `deliverToBoundSessions` 与 `prWatchEvents` 的 GitHub channel 时才存在。没有这样的 channel 的会话永远听不到自己的 PR CI 变红。两者同时运行时，同一个 PR 被抓取两次；channel 的 CI 聚合排除 `cancelled` / `stale`，而 core 的 rollup（`packages/core/src/utils/github-prs.ts` 的 `aggregateChecks`）把它们算进去；channel 在上限处的 API 预算约为每小时 1,800 次 `pulls.get` 加有界复查，而刷新是每 workspace 每小时 12 次 `gh pr list`。

## 现状

- sidecar 结构（`packages/core/src/services/session-pr-service.ts` 的 `SessionPr`）：`number`、`url`、`createdAt`、`state?`、`source?`、`issues?`。不持久化 head SHA、CI rollup 或可合并性，所以刷新看不到任何转换。
- 刷新的 GitHub 路径以 **slim** 模式（`number,url,headRefName,state`）跑 `gh pr list --state all --limit 500`，因为 CI rollup 字段会让大的 `--state all` 查询撞上 GitHub GraphQL 服务端超时（504）。非 slim 的 `GH_PR_LIST_FIELDS` 已含 `statusCheckRollup`、`isDraft`、`reviewDecision`、`updatedAt`，但没有 `headRefOid` 或 `mergeable`。
- daemon 已经会向自己不握键盘的会话注入 prompt：channel 的绑定中继（带 `qwen.channel.prompt` / `qwen.daemon.channelBoundRelay` 标记与 `idempotencyKey` 的 `POST /session/:id/prompt`），并经 `/session/:id/resume` 路径恢复休眠会话。两者都是刷新可以在进程内直接调用的代码路径，无需 HTTP。
- channel 监视面向用户的语义记录在 `docs/users/features/channels/github.md`，于 2026-11-03 合入（#16117）并随 v0.26.7（2026-11-04）发布，发布说明点名了该功能；`prWatchEvents` 因此是已发布、运维者可配置的设置。

## 目标

- PR 状态只有一个来源：daemon 刷新。它在已刷新的 state 之外同时观察 head、CI 与可合并性，并把四种转换投递到跟随该 PR 的会话。
- 接收 PR 状态事件不需要 GitHub channel；channel 继续投递 GitHub 的*会话类*事件（评论、评审请求、指派）。
- 不新增轮询循环，不新增状态文件：sidecar 既是快照也是持久队列。
- 移除适配器的 PR 状态监视及其配置。

## 非目标

- webhook 推送接入（仍是未来工作）。
- Aone 合并请求：刷新的 Aone 路径继续只刷新 `state`；Aone 的转换可以之后按同样形状补上。
- 评论事件：仍留在 GitHub channel 的通知车道及其绑定会话投递中。
- 新事件类型（`review_decision` 已经在抓取，列为下面的开放问题，不属于本次改动）。

## 设计

### 1. 观察

刷新保留用于 `state` 的 slim `--state all` 列表，并对该 workspace 每个**open** 的绑定 PR 增加一次 `gh pr view <number> --json headRefOid,mergeable,state,statusCheckRollup`，每次扫描上限 30 个，使用与 Aone 路径 `sweepStart` 同形的旋转窗口；GitHub 路径报告自己消费的数量，定时器为它按 workspace 推进一个 GitHub 偏移（今天只有 Aone 路径报告），因此对 40 个 open 绑定 PR 的两次连续扫描 view 的是不相交的窗口，open 绑定 PR 超过 30 个的 workspace 仍会在连续扫描中观察到每一个。该循环受 Aone 循环同样的聚合 view 预算约束（`AONE_SWEEP_VIEW_BUDGET_MS`，60 秒）：预算用尽后本次扫描不再发起新的 view，旋转按实际发起的 view 数推进，单个 PR 的 view 或投递失败被隔离、不中断该 workspace 其余的扫描——否则 30 次按 `GH_TIMEOUT_MS` 挂住的 view 会占满整个间隔，重入保护会让所有 workspace 跳过下一个 tick。绑定在多个 workspace 的 PR 每个扫描周期只 view 一次：view 它的那次扫描把块盖进每个兄弟 sidecar（§4），同一周期内后来的扫描在该 PR 最新兄弟 `observedAt` 比刷新间隔还新时跳过 view。单个 PR 的 view 不会撞上批量 rollup 的超时。merged 与 closed 的 PR 只通过 slim 列表观察，不为它们逐个抓取，但这次观察同样更新 `watch` 块（其 `state` 与 `observedAt`），与一次 view 完全一样，因此下文的恢复规则对终态同样成立。未设置 `sessionPrWatch.events` 时完全不跑 `gh pr view`，列表调用也不变（验收标准 4）。

`mergeable` 映射为 `MERGEABLE → mergeable`、`CONFLICTING → conflicting`、`UNKNOWN → undefined`（GitHub 仍在计算；绝不覆盖上次已知值）。不覆盖是 sidecar 写入时的合并规则而非映射器的规则：一次 `UNKNOWN` 观察保留已存的 `mergeable` 且不产生转换。CI 使用 core 已有的 `aggregateChecks` rollup（`passing` / `failing` / `pending` / `none`）：侧栏与事件共用一个定义。

### 2. sidecar 中的快照

`SessionPr` 增加可选的 `watch` 块，由与 `state` 相同的变更队列和跨进程锁、经它自己的变更辅助（`updateSessionPrWatch`）写入：`updateSessionPrStates` 在 `state` 与 `issues` 都没变时提前返回，只有 head 变化的观察若走它永远不会持久化、基线也永远不会前进：

```ts
watch?: {
  /** 观察版本：最后一次更新本块的那次观察的时间——open PR 是一次 `gh pr view`，merged 或 closed 的 PR 是 slim 列表。最新的兄弟块是检测基线。 */
  observedAt?: string;
  /** `observedAt` 那次观察看到的状态，与之配对，使基线携带同一次观察的状态；顶层 `state` 仍是侧栏字段。 */
  state?: 'open' | 'merged' | 'closed';
  headSha?: string;
  checks?: 'passing' | 'failing' | 'pending' | 'none';
  mergeable?: 'mergeable' | 'conflicting';
  /** 已触发过 ci_failure 的 head，最旧在前（上限 16）。 */
  ciFired?: string[];
  /** 已检测但尚未投递的转换，最旧在前（上限 16）。以 PR 为范围：同样的条目写进该 PR 的每个 active 绑定 sidecar，因此收件者被归档或被超过时队列不丢。 */
  pending?: Array<{ type: PrTransitionType; key: string; summary: string; detectedAt: string }>;
}
```

对一个 PR 的首次观察静默初始化该块。本次改动之前持久化的条目没有该块，在下一次扫描时初始化。

### 3. 转换规则

沿用 channel 监视的转换规则，迁移过来的运维者看到相同的转换，只有一处刻意的 CI 判定差异（关键决策 5、开放问题 2：core 的 rollup 把 `cancelled` / `stale` 算作失败，channel 的聚合排除了它们）：

| 事件             | 触发条件                                                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `head_change`    | `headSha` 与上次观察不同（force-push 回到最近的 SHA 是新的转换）。                                                                              |
| `ci_failure`     | `checks` 变为 `failing` 且 `headSha` 不在 `ciFired` 中；随后追加进去，因此即使 CI 反复、或 force-push 回到更早的 head，每个 head 也只触发一次。 |
| `merge_conflict` | `mergeable` 从非冲突观察变为 `conflicting`（边沿触发；`conflicting → mergeable → conflicting` 会再次触发）。                                    |
| `state_change`   | `state` 离开 `open`（merged 或 closed）。重新打开会让 `state` 回到 `open`，之后再关闭会再次触发。                                               |

每个转换的 key 为 `pr-state:<owner/repo>#<number>:<type>:<headSha 或 previous→next>:<detectedAt>`；`detectedAt` 让 sidecar 重置后重新检测到的实例彼此不同，而 `ci_failure` 通过 `ciFired` 保持每个 head 一次。`ciFired` 是 daemon 侧与 channel 持久化 `fired` 环等价的东西：有界的逐 head 历史，因此 force-push 回到 `A` 之后的 `A failing → B failing → A failing` 不会为 `A` 再触发一次。上限刻意不同：channel 每个 PR 保留 4 类事件共用的 64 个 key，被挤出后只钉住当前 head；daemon 每个 PR 保留最近 16 个失败过的 head，一个 head 在超过 16 个其它失败 head 之后再被回访会再次触发，与 channel 被挤出后的行为一致。超过 prompt 路由 200 字符 `idempotencyKey` 上限的 key 确定性地哈希为 `pr-state:h:<sha256 前 40 位十六进制>`（channel 的形状），重试仍能去重（很长的 `owner/repo` 配上双 SHA 的 `previous→next` 形式可达 275 字符）。

### 4. 投递

- **目标。** 整个 daemon 范围内每个 PR 只有一个收件会话，绝不是每个 workspace 一个。观察仍按 workspace 进行（每次扫描只 view 本 workspace 的 open 绑定 PR，按 §1 的新鲜度去重），但检测与投递以 PR 为范围。扫描检测到转换时，把新快照、已触发记录与 `pending` 条目写进**该 PR 在所有受信 workspace 的每个 active 绑定 sidecar**——由 `GET /sessions/pr-bindings` 背后的进程级 sidecar 扫描枚举——各走各自的变更队列与锁。收件者在投递时才惰性决定：在所有受信 workspace 中绑定该 PR 的全部合格会话里取最近活跃的那个（transcript mtime，再以 bridge 的 live 活动修正），这正是 channel 今天对整个绑定快照应用的规则，经该会话所属的 runtime 派发。因为 `pending` 以 PR 为范围，检测与排空之间被归档或被别的会话超过的收件者不会丢任何东西：排空在兄弟 sidecar 里找到同一条目，以其原始 key 投递。**基线规则：**检测绝不只拿新鲜 view 与本次扫描自己的 sidecar 比较；比较之前，扫描读取该 PR 在每个绑定 sidecar 中的 `watch` 块，取 `observedAt` 最新的作为基线——取那一次观察的整个块（`state`、`headSha`、`checks`、`mergeable` 及其仍待投递的条目），绝不从多个 sidecar 拼字段。被崩溃落下的兄弟静默采用更新的块，连同其 pending 条目——没有转换、没有新 key。扫描的 `partial` 答案不是基线证据：若扫描无法枚举该 PR 的每个绑定 sidecar（draining、transitioning 或 blocked 的 workspace，某个 sidecar 读取失败），本次扫描对该 PR 跳过检测而不是对着未经确认的基线比较；slim 列表的 `state` 刷新不受影响。**信任与退役：**每个兄弟在写入前、收件者在派发前立即重新解析；不再注册、不再受信或 runtime 代际已退役（`assertGenerationOpen()`）的 workspace 记一行日志跳过并视同崩溃窗口（其 sidecar 之后按基线规则追平），不受信的 workspace 永远不是投递目标。因此同一仓库注册了两个 workspace、各有一个会话跟随同一个 PR 时，无论中间是否崩溃，都只投递一次而非两次。归档会话只刷新 `state`，绝不投递。channel 自有会话（`sourceType: 'channel'`）与机器自有的隐藏目录会话永远不是目标。
- **机制。** 刷新在进程内调用 daemon 的 prompt 准入——`POST /session/:id/prompt` 背后的代码——并带上 daemon 来源分类，准入把它当作 channel 绑定中继那样处理：不是交互式用户 prompt（不做循环检测拒绝，不对注入文本做 PR 绑定回填，显示投影为"PR 事件"），以转换 key 作为 `idempotencyKey`，因此 daemon 生命周期内的重试会去重到原始准入。该分类绑定来源而非字符串：作为准入调用的受信进程内参数传入（即 `context.channelPrompt` 已有的形状，路由与 bridge 只从受信 context 重新装配它，绝不从请求的 `_meta`）。标记名 `qwen.daemon.prStateEvent` 只出现在显示投影和两份剥离清单（路由与 bridge）中作为纵深防御；携带它的客户端请求体会被剥离且得不到任何授权，并由一个与现有伪造 `qwen.channel.prompt` 用例同形的路由测试钉住。
- **休眠会话。** 已绑定但不在线的会话通过 channel 访问器所用的同一恢复路径恢复后再投递；`wakeDormant` 默认开启，这样 daemon 重启不会丢事件；`wakeDormant: false` 时转换留在 `pending`，在该会话下一次 live 回合投递（排空在恢复时也会运行），每个 PR 16 条的上限仍然适用且淘汰会记日志，不会静默消失。无法恢复的会话（记录已删除、已归档、worktree 被取代）丢弃该转换并记一行日志；任何地方都不会公开发布。
- **prompt 文本。** 沿用 channel 绑定 prompt 的形状：事件头、不可信事件数据提示、PR 身份（仓库、编号、标题、URL）、一行 `Event:` 与摘要（`ci_failure` 从 rollup 中列出最多五个失败的 check）。回复留在会话内。

### 5. 持久性

检测结果与新快照按该 PR 的每个绑定 sidecar 各一次写入持久化，每次都把转换追加到该 sidecar 的 `pending`；投递随后按最旧优先排空 `pending`，把同一 key 在该 PR 各 sidecar 中的副本合并，对当时解析出的收件者每个 key 只准入一次，准入后从每个 sidecar 清除该 key。四个崩溃窗口的处理：首次写入前崩溃，下次扫描重新检测（无丢失，也没投递过任何东西）；sidecar 写入之间崩溃，被落下的 sidecar 按基线规则追平——采用更新的块连同其 pending 条目而不检测任何东西——下次扫描把该 key 排空一次；全部写入后、投递前崩溃，下次扫描先排空 `pending`；投递后、清除前崩溃，下次扫描重新投递，准入环在 daemon 生命周期内去重（跨重启是 at-least-once，与 channel 的取舍相同）。`pending` 每个 PR 上限 16 条；溢出时丢弃最旧的并记日志。

### 6. 配置

一个按刷新间隔同样方式读取的 daemon 级设置：`sessionPrWatch: { events: ['ci_failure', 'merge_conflict', 'head_change', 'state_change'], wakeDormant?: boolean }`，环境变量 `QWEN_SESSION_PR_WATCH_EVENTS` 与 `QWEN_SESSION_PR_WATCH_WAKE_DORMANT` 可覆盖。默认：无事件（关闭）；`wakeDormant` 默认为 true，`false` 让休眠会话的转换留在 `pending` 直到其下一次 live 回合（§4）。延迟即刷新间隔（默认 5 分钟；小于 1 分钟回退到默认值，`0` 关闭扫描）。

### 7. channel 迁移

GitHub channel 的 `deliverToBoundSessions` 不变。`prWatchEvents`、监视通道、监视状态文件、任务存储中的监视分支、30 个 PR 的上限与 CI 复查间隔从适配器中移除；`connect()` 在一个 minor 版本内继续接受 `prWatchEvents` 作为弃用窗口：只记一条点名 `sessionPrWatch` 的告警、忽略该字段（不再跑监视通道），Web Shell 描述符将其标为已弃用；PR B 之后的第一个 minor 版本起在 `connect()` 以同一条信息拒绝它。该设置已随 v0.26.7 发布，已发布且写进发布说明的选项不能见到就拒绝，即便它需在 `deliverToBoundSessions` 之后可选开启、实际采用量大概率接近于零。A 与 B 之间窗口期的重叠规则：只要某个已配置的 GitHub channel 对某仓库仍设置着 `prWatchEvents`，daemon 就跳过该仓库的 PR（不观察、不投递）并记一次日志，两个轮询器因此绝不会把同一转换投递两次、也不会重复抓取同一 PR；B 合入或运维者清掉 `prWatchEvents` 后，daemon 接管。两个 PR：A 增加 daemon 的观察、投递与配置；B 移除适配器监视并更新 channel 文档，在 A 之后合入。

## 关键决策

1. **daemon 拥有 PR 状态。** 它已经为侧栏用宿主凭据轮询这些状态；多加三个字段和一个投递步骤比第二个轮询器便宜，而且服务所有绑定会话，而不只是配置了 channel 的那些。
2. **逐 PR 的 `gh pr view`，而非批量 rollup。** 刷新的 slim 批量列表之所以存在，是因为 rollup 字段在大的 `--state all` 查询上超时；单个 PR 的 view 避开了这一点，且受 open 绑定 PR 数量约束（每次扫描上限 30，旋转）。
3. **与 channel 监视相同的选择与转换规则**，迁移过来的运维者看到的事件相同，只有一处刻意的 CI 判定差异（决策 5、开放问题 2）。
4. **sidecar 就是队列。** 不新增状态文件：快照与待投递转换搭乘已有的串行化、跨进程加锁的 sidecar 写入。
5. **单一 CI 定义**（core 的 rollup），在下面的开放问题定案前接受 `cancelled` 与 `stale` 算作失败。
6. **`prWatchEvents` 设一个版本的弃用窗口**：v0.26.7 已发布它（#16117，2026-11-04 发布）并在发布说明中点名，因此不能见到就拒绝；采用量大概率接近于零（只有几小时、需在 `deliverToBoundSessions` 之后可选开启），所以一个 minor 版本的告警并忽略足够，之后再由 `connect()` 拒绝。
7. **本次改动默认关闭**；默认开启是之后的产品决策。

## 涉及文件

| 层              | 文件                                                                                           | 改动                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core            | `packages/core/src/services/session-pr-service.ts`                                             | `SessionPr` 的 `watch` 块；`updateSessionPrWatch` 变更辅助（快照 + 以 PR 为范围的 pending；`updateSessionPrStates` 在 `state`/`issues` 未变时提前返回）；排空辅助 |
| core            | `packages/core/src/utils/github-prs.ts`                                                        | 带 `headRefOid`、`mergeable`、rollup 的 `fetchGitHubPullRequestView(number)`；映射                                                                                |
| daemon          | `packages/cli/src/serve/server/session-pr-refresh.ts`                                          | 逐 PR 观察（上限 30、按 GitHub 偏移旋转、聚合 view 预算）、转换检测、经 prompt 准入与恢复路径投递                                                                 |
| daemon          | `packages/cli/src/serve/routes/session.ts`、`packages/acp-bridge/src/session-control-plane.ts` | prompt 准入中绑定来源的 daemon 来源分类；`qwen.daemon.prStateEvent` 加入两份剥离清单                                                                              |
| 配置            | settings schema + `packages/cli/src/serve/server.ts`                                           | `sessionPrWatch` / `QWEN_SESSION_PR_WATCH_EVENTS`                                                                                                                 |
| channel（PR B） | `packages/channels/github/src/GithubAdapter.ts`、`index.ts`、Web Shell 描述符                  | 移除监视通道与状态文件；弃用 `prWatchEvents`（告警并忽略）                                                                                                        |
| 文档            | `docs/users/features/channels/github.md`、新的 `sessionPrWatch` 用户页、两份设计文档           | 记录这次迁移                                                                                                                                                      |
| 测试            | 每个改动文件并置的 `.test.ts`                                                                  | 见验证                                                                                                                                                            |

## 约束与风险

- **延迟**为刷新间隔（默认 5 分钟），而非 channel 的 60 秒轮询。需要更快信号的运维者调低 `QWEN_SESSION_PR_REFRESH_MINUTES`（小于 1 回退到默认值；`0` 关闭扫描）。
- **凭据。** 需要 daemon 宿主上已认证的 `gh`，这是刷新与 PR 侧栏已有的要求。没有它的 workspace 保持今天的行为（不刷新状态，也无事件）。
- **API 预算。** 每 workspace 每次扫描最多 30 次 `gh pr view`：W 个受信 workspace 在默认间隔下每小时 360·W 次（W = 5 时 1,800 次，即 channel 监视单个 channel 在上限时的数字），叠加在现有列表之上，每次 workspace 扫描受 60 秒聚合 view 预算约束。每次扫描的 view 集合经 §1 的新鲜度跳过按 `owner/repo#number` 跨 workspace 去重，绑定在多个 workspace 的 PR 每周期只抓取一次。
- **不可信内容进入交互式会话。** 事件 prompt 把 PR 标题与 check 名称作为数据携带并标记为不可信，与 channel 绑定 prompt 的契约相同；会话自身的审批模式决定其行为。
- **准入分类。** 非交互式 prompt 的 daemon 来源分类必须对客户端不可伪造。剥离是纵深防御而非机制本身：channel 标记只授予持有 worker 凭据的调用方，而刷新不持有任何凭据，因此这里的授权绑定来源——准入调用的受信进程内参数——绝不绑定从请求体读出的字符串（§4）。

## 验证计划

- 单元：view 映射（`headRefOid`、`mergeable` 状态、rollup）；转换规则，包括 force-push 回访下每个 head 一次的 `ci_failure`（`A failing → B failing → A failing` 触发两次而非三次）、边沿触发的冲突、重开 → 关闭；多个绑定者之间的选择，含分属不同 workspace 的绑定者；模拟崩溃下的 pending 持久化与排空，包括 head 变更与经 slim 列表观察到的终态 `state_change` 两种情形下收件者 sidecar 写入与兄弟写入之间的崩溃（兄弟按 `observedAt` 采用更新的基线、不检测任何东西，pending 中的转换以原始 key 恰好准入一次）；配置解析；超长 key 的哈希；`partial` 扫描的跳过（不检测、不产生第二个 key）；`CONFLICTING` 之后的 `UNKNOWN` 保留已存值且不产生转换；检测与排空之间收件者被归档或被超过（从兄弟 sidecar 以原始 key 恰好准入一次）；`wakeDormant: false` 把条目留到下一次 live 回合；以及未设置该项时零次 `gh pr view` 且列表调用次数不变。
- 刷新测试（现有带假 `fetchPullRequests` 的测试框架）：每个转换投递一次、休眠会话被恢复、归档与 channel 自有会话被跳过、上限与旋转（对 40 个 PR 的两次连续扫描 view 不相交的窗口）、聚合 view 预算、兄弟写入前的信任/退役重新解析，以及重叠规则（已配置 channel 监视的仓库被跳过）。
- E2E（daemon + 桩 `gh` 二进制）：在会话中绑定 PR，把桩的 rollup 翻成失败，下一次扫描后在该会话观察到恰好一条注入 prompt，daemon 重启后没有新的注入。

## 验收标准

1. 设置 `sessionPrWatch.events` 后，绑定会话对 CI 失败、合并冲突、head 变更、合并/关闭的每个转换实例恰好收到一条 prompt，递归语义与 channel 监视相同，且无需配置任何 GitHub channel。
2. 检测与投递之间的 daemon 重启投递该转换一次；投递之后的重启最多重新投递一次。
3. GitHub channel 不再发出任何 PR 状态 API 调用；带 `prWatchEvents` 的配置仍能连接，只记一条点名 `sessionPrWatch` 的弃用告警且不跑监视通道；PR B 之后的第一个 minor 版本起在 `connect()` 以同一条信息拒绝。
4. 未设置该项时，刷新的行为与 API 调用量不变。
5. 同一仓库的两个受信 workspace 各有一个会话绑定同一个 PR 时，每个转换只投递一次，给其中最近活跃的会话，daemon 在 sidecar 写入之间重启、或收件者在检测与排空之间被归档或被超过时亦然；force-push 回到一个 CI 失败已触发过的 head 时，只要该 head 仍在该 PR 的 16 个 head 历史内，`ci_failure` 不再触发。
6. `wakeDormant: false` 时，休眠会话的转换保留在 `pending` 并在其下一次 live 回合投递；A→B 窗口期内，已配置 channel 监视的仓库每个转换只收到一次。

## 开放问题

1. `sessionPrWatch` 是否应对四种事件默认开启？
2. `cancelled` / `stale` 的 check run 是否算作 `ci_failure`？core 的 rollup 算（并发取消的被取代 run 会触发）；channel 监视排除了它们。
3. `reviewDecision` 已在抓取：是否在同一机制下增加 `review_decision` 转换（approved / changes requested）？
4. Aone 对齐：Aone 后端返回 head 与流水线状态后，为 Aone MR 暴露相同的转换。
