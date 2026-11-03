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
- channel 监视面向用户的语义记录在 `docs/users/features/channels/github.md`，于 2026-11-04 合入（#16117）；没有任何已打标签的发布包含它（v0.26.6 发布于 2026-11-02）。

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

刷新保留用于 `state` 的 slim `--state all` 列表，并对该 workspace 每个**open** 的绑定 PR 增加一次 `gh pr view <number> --json headRefOid,mergeable,state,statusCheckRollup`，每次扫描上限 30 个，复用 Aone 路径已有的旋转窗口（`sweepStart`），因此 open 绑定 PR 超过 30 个的 workspace 仍会在连续扫描中观察到每一个。单个 PR 的 view 不会撞上批量 rollup 的超时。merged 与 closed 的 PR 只通过 slim 列表观察，不为它们逐个抓取。

`mergeable` 映射为 `MERGEABLE → mergeable`、`CONFLICTING → conflicting`、`UNKNOWN → undefined`（GitHub 仍在计算；绝不覆盖上次已知值）。CI 使用 core 已有的 `aggregateChecks` rollup（`passing` / `failing` / `pending` / `none`）：侧栏与事件共用一个定义。

### 2. sidecar 中的快照

`SessionPr` 增加可选的 `watch` 块，由与 `state` 相同的变更队列和跨进程锁写入：

```ts
watch?: {
  headSha?: string;
  checks?: 'passing' | 'failing' | 'pending' | 'none';
  mergeable?: 'mergeable' | 'conflicting';
  /** 已触发过 ci_failure 的 head（每个 head 一次）。 */
  ciFiredSha?: string;
  /** 已检测但尚未投递的转换，最旧在前（上限 16）。 */
  pending?: Array<{ type: PrTransitionType; key: string; summary: string; detectedAt: string }>;
}
```

对一个 PR 的首次观察静默初始化该块。本次改动之前持久化的条目没有该块，在下一次扫描时初始化。

### 3. 转换规则

与 channel 监视完全一致，迁移过来的运维者看到的行为不变：

| 事件             | 触发条件                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `head_change`    | `headSha` 与上次观察不同（force-push 回到最近的 SHA 是新的转换）。                                                   |
| `ci_failure`     | `checks` 变为 `failing` 且 `ciFiredSha !== headSha`；随后设置 `ciFiredSha`，因此即使 CI 反复也每个 head 只触发一次。 |
| `merge_conflict` | `mergeable` 从非冲突观察变为 `conflicting`（边沿触发；`conflicting → mergeable → conflicting` 会再次触发）。         |
| `state_change`   | `state` 离开 `open`（merged 或 closed）。重新打开会让 `state` 回到 `open`，之后再关闭会再次触发。                    |

每个转换的 key 为 `pr-state:<owner/repo>#<number>:<type>:<headSha 或 previous→next>:<detectedAt>`；`detectedAt` 让 sidecar 重置后重新检测到的实例彼此不同，而 `ci_failure` 通过 `ciFiredSha` 保持每个 head 一次。

### 4. 投递

- **目标。** 拥有该 sidecar 的会话。同一 workspace 的多个会话绑定同一个 PR 时，转换投递给最近活跃的那个（transcript mtime，再以 bridge 的 live 活动修正），其余 sidecar 记录新快照但不投递——这正是 channel 今天的规则。归档会话只刷新 `state`，绝不投递。channel 自有会话（`sourceType: 'channel'`）与机器自有的隐藏目录会话永远不是目标。
- **机制。** 刷新在进程内调用 daemon 的 prompt 准入——`POST /session/:id/prompt` 背后的代码——并带上 daemon 来源标记（`qwen.daemon.prStateEvent`），准入把它当作 channel 绑定中继那样分类：不是交互式用户 prompt（不做循环检测拒绝，不对注入文本做 PR 绑定回填，显示投影为"PR 事件"），以转换 key 作为 `idempotencyKey`，因此 daemon 生命周期内的重试会去重到原始准入。
- **休眠会话。** 已绑定但不在线的会话通过 channel 访问器所用的同一恢复路径恢复后再投递；`wakeDormant` 默认开启，这样 daemon 重启不会丢事件。无法恢复的会话（记录已删除、已归档、worktree 被取代）丢弃该转换并记一行日志；任何地方都不会公开发布。
- **prompt 文本。** 沿用 channel 绑定 prompt 的形状：事件头、不可信事件数据提示、PR 身份（仓库、编号、标题、URL）、一行 `Event:` 与摘要（`ci_failure` 从 rollup 中列出最多五个失败的 check）。回复留在会话内。

### 5. 持久性

检测结果与新快照在同一次 sidecar 写入中持久化，转换追加到 `pending`；投递随后按最旧优先排空 `pending`，每条在准入后清除。三个崩溃窗口的处理：写入前崩溃，下次扫描重新检测（无丢失，也没投递过任何东西）；写入后、投递前崩溃，下次扫描先排空 `pending`；投递后、清除前崩溃，下次扫描重新投递，准入环在 daemon 生命周期内去重（跨重启是 at-least-once，与 channel 的取舍相同）。`pending` 每个 PR 上限 16 条；溢出时丢弃最旧的并记日志。

### 6. 配置

一个按刷新间隔同样方式读取的 daemon 级设置：`sessionPrWatch: { events: ['ci_failure', 'merge_conflict', 'head_change', 'state_change'], wakeDormant?: boolean }`，环境变量 `QWEN_SESSION_PR_WATCH_EVENTS` 可覆盖。默认：无事件（关闭）。延迟即刷新间隔（默认 5 分钟，下限 1 分钟）。

### 7. channel 迁移

GitHub channel 的 `deliverToBoundSessions` 不变。`prWatchEvents`、监视通道、监视状态文件、任务存储中的监视分支、30 个 PR 的上限与 CI 复查间隔从适配器中移除；`connect()` 拒绝仍设置 `prWatchEvents` 的配置并点名 `sessionPrWatch`，Web Shell 描述符去掉该字段。由于没有已打标签的发布包含 channel 监视，不设弃用窗口。两个 PR：A 增加 daemon 的观察、投递与配置；B 移除适配器监视并更新 channel 文档，在 A 之后合入。

## 关键决策

1. **daemon 拥有 PR 状态。** 它已经为侧栏用宿主凭据轮询这些状态；多加三个字段和一个投递步骤比第二个轮询器便宜，而且服务所有绑定会话，而不只是配置了 channel 的那些。
2. **逐 PR 的 `gh pr view`，而非批量 rollup。** 刷新的 slim 批量列表之所以存在，是因为 rollup 字段在大的 `--state all` 查询上超时；单个 PR 的 view 避开了这一点，且受 open 绑定 PR 数量约束（每次扫描上限 30，旋转）。
3. **与 channel 监视相同的选择与转换规则**，迁移过来的运维者看到的事件相同。
4. **sidecar 就是队列。** 不新增状态文件：快照与待投递转换搭乘已有的串行化、跨进程加锁的 sidecar 写入。
5. **单一 CI 定义**（core 的 rollup），在下面的开放问题定案前接受 `cancelled` 与 `stale` 算作失败。
6. **`prWatchEvents` 不设弃用窗口**：该功能只有一天历史且未发布。
7. **本次改动默认关闭**；默认开启是之后的产品决策。

## 涉及文件

| 层              | 文件                                                                                           | 改动                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| core            | `packages/core/src/services/session-pr-service.ts`                                             | `SessionPr` 的 `watch` 块；`updateSessionPrStates` 写入快照 + pending；排空辅助    |
| core            | `packages/core/src/utils/github-prs.ts`                                                        | 带 `headRefOid`、`mergeable`、rollup 的 `fetchGitHubPullRequestView(number)`；映射 |
| daemon          | `packages/cli/src/serve/server/session-pr-refresh.ts`                                          | 逐 PR 观察（上限 30，旋转）、转换检测、经 prompt 准入与恢复路径投递                |
| daemon          | `packages/cli/src/serve/routes/session.ts`、`packages/acp-bridge/src/session-control-plane.ts` | prompt 准入中的 `qwen.daemon.prStateEvent` 分类                                    |
| 配置            | settings schema + `packages/cli/src/serve/server.ts`                                           | `sessionPrWatch` / `QWEN_SESSION_PR_WATCH_EVENTS`                                  |
| channel（PR B） | `packages/channels/github/src/GithubAdapter.ts`、`index.ts`、Web Shell 描述符                  | 移除监视通道、状态文件、`prWatchEvents`                                            |
| 文档            | `docs/users/features/channels/github.md`、新的 `sessionPrWatch` 用户页、两份设计文档           | 记录这次迁移                                                                       |
| 测试            | 每个改动文件并置的 `.test.ts`                                                                  | 见验证                                                                             |

## 约束与风险

- **延迟**为刷新间隔（默认 5 分钟），而非 channel 的 60 秒轮询。需要更快信号的运维者调低 `QWEN_SESSION_PR_REFRESH_MINUTES`（下限 1）。
- **凭据。** 需要 daemon 宿主上已认证的 `gh`，这是刷新与 PR 侧栏已有的要求。没有它的 workspace 保持今天的行为（不刷新状态，也无事件）。
- **API 预算。** 在现有列表之外，每 workspace 每次扫描最多 30 次 `gh pr view`（默认间隔下每小时 360 次）；远低于 channel 监视的预算。
- **不可信内容进入交互式会话。** 事件 prompt 把 PR 标题与 check 名称作为数据携带并标记为不可信，与 channel 绑定 prompt 的契约相同；会话自身的审批模式决定其行为。
- **准入分类。** 非交互式 prompt 的 daemon 来源标记必须对客户端不可伪造：路由像今天剥离 channel 标记那样从客户端请求体中剥离它。

## 验证计划

- 单元：view 映射（`headRefOid`、`mergeable` 状态、rollup）；转换规则，包括每个 head 一次的 `ci_failure`、边沿触发的冲突、重开 → 关闭；多个绑定者之间的选择；模拟崩溃下的 pending 持久化与排空；配置解析。
- 刷新测试（现有带假 `fetchPullRequests` 的测试框架）：每个转换投递一次、休眠会话被恢复、归档与 channel 自有会话被跳过、上限与旋转。
- E2E（daemon + 桩 `gh` 二进制）：在会话中绑定 PR，把桩的 rollup 翻成失败，下一次扫描后在该会话观察到恰好一条注入 prompt，daemon 重启后没有新的注入。

## 验收标准

1. 设置 `sessionPrWatch.events` 后，绑定会话对 CI 失败、合并冲突、head 变更、合并/关闭的每个转换实例恰好收到一条 prompt，递归语义与 channel 监视相同，且无需配置任何 GitHub channel。
2. 检测与投递之间的 daemon 重启投递该转换一次；投递之后的重启最多重新投递一次。
3. GitHub channel 不再发出任何 PR 状态 API 调用；带 `prWatchEvents` 的配置在 `connect()` 时被拒绝，并点名 `sessionPrWatch`。
4. 未设置该项时，刷新的行为与 API 调用量不变。

## 开放问题

1. `sessionPrWatch` 是否应对四种事件默认开启？
2. `cancelled` / `stale` 的 check run 是否算作 `ci_failure`？core 的 rollup 算（并发取消的被取代 run 会触发）；channel 监视排除了它们。
3. `reviewDecision` 已在抓取：是否在同一机制下增加 `review_decision` 转换（approved / changes requested）？
4. Aone 对齐：Aone 后端返回 head 与流水线状态后，为 Aone MR 暴露相同的转换。
