# 绑定 PR 评论监视（会话评论 + 行内 review 评论）

[English](2026-11-08-bound-pr-comment-watch.md) | [简体中文](2026-11-08-bound-pr-comment-watch.zh-CN.md)

状态：proposed（2026-11-08）。扩展 [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md)；不改动四个 PR 状态 watch 事件，也不改动通知驱动的评论 lane。

修订 2026-11-08（评审）：watch 仅在把评论投递给至少一个绑定会话时才消费它——其较窄的 `comment` 类无法路由的评论保持未消费（不写共享去重键），好让通知 lane 仍按线程自身的 reason 投递；评论游标不会越过投递意图未被持久化认领的评论（`dispatchEnvelope` 返回 false 时保留 `commentSince` 以便重试）；两个评论抓取沿用状态 watch 的限流快速退出重试判断，并把共享凭据/限流错误交给本轮中止逻辑；归因要求写标志与评论集合同处一个管道段（链尾的 `stat -f` 或引号内的 `grep 'gh pr comment'` 属读取）、对显式 GET（即便带字段参数）一票否决、剥离引号片段、给 transcript 扫描缓存设上限、且只在有候选时才查询；每轮候选上限用于排出停机积压而不丢尾部。watch 记录 `dispatchedCommentTimes` 使其去重键可被逐出；仅评论的 channel（`prWatchEvents` 为空）跳过每轮 `pulls.get`。`prCommentWatch` 不带 `deliverToBoundSessions` 依赖校验，因为编辑器会为每个 channel 提交它的默认值。归因只读活跃 transcript（归档会话自己发的评论是已点名的尽力而为残余）。

## 问题

绑定到某 PR 的会话——尤其是承担整个研发闭环的 `fix` 角色会话——必须听到该 PR 上的新评论，无论评论是谁发的：本人手工、另一个 Qwen Code 会话、或另一个 agent/模型，无论用的是同一个 GitHub 账号还是别的账号。今天做不到：

1. **评论由通知驱动。** adapter 的评论 lane 只在 GitHub 以 `mention`、`author`、`comment`、`review_requested`、`assign` 等 reason 通知 channel 账号时才运行。GitHub 不会就账号自己的活动给它发通知，所以 channel 自身账号发的评论永远不会产生通知。
2. **自身评论在采集处被过滤。** `fetchNewComments` 在任何 lane 看到之前，就丢弃 `user.login` 等于 `botUsername` 的评论（`GithubAdapter.ts`）。绑定路径的 mention 豁免（`waivesBoundMention`）出于同样的回环考虑也排除 `operators`。

实际故障（2026-11-08 于 PR #16587、会话 `7bddc58f` 观测）：一个 verify 会话用 channel 所认证的同一个 `wenshao` 账号发布了 findings 评论。绑定该 PR 的 fix 会话收到了 `head_change`/`ci_failure` watch 事件，却始终收不到这条评论，于是只能靠本人手工贴链接才能处理 findings。缺口在于单一账号身份，而不是投递机制。

## 现状

- 评论 lane：`processCommentLane`（mention / direct）与 `processAggregateLane`（`author`/`comment` reason）都经 `fetchNewComments` 采集，过滤 `botUsername` 与时间窗，再做 sender 门禁，经 `dispatchEnvelope` → `claimInboundTask` → `deliverToBoundSession` 派发 envelope。
- PR 状态 watch：`runPrStateWatch` / `watchOnePr` 已在每个 channel poll 逐个轮询绑定 PR（受 `prWatchLimit` 上限），把每 PR 的 `PrWatchEntry` 基线 + pending 队列 + fired 环持久化到 `github-pr-watch.json`，并私投递 `ci_failure` / `merge_conflict` / `head_change` / `state_change`。
- 投递访问器：`ChannelBoundSessions`（`packages/channels/base/src/types.ts`）暴露 `listPrBindings()` 与 `deliverPrompt(sessionId, prompt, idempotencyKey)`；daemon worker 通过 HTTP 实现两者。绑定投递是角色感知的（`boundSessionActions`）、按稳定事件键去重、背压时进死信、并唤醒休眠会话。
- 没有 daemon 级的“某会话发过哪些评论”记录。`/autofix-pr` 把 `postedCommentIds` 存在它自己的命令本地状态里；那不是共享归因来源。
- 会话 transcript（`<chatsDir>/<sessionId>.jsonl`）记录每个 shell 工具结果，包括发评论命令与返回的 `…#issuecomment-<id>` / review 评论 JSON。这是唯一无标记、按会话、且覆盖任意发布方式的作者身份证据。

## 目标

- 当 `deliverToBoundSessions` 为 true 时，轮询每个绑定 PR 的**会话评论与行内 review 评论**，把每条新评论投递进每一个**没有发过它**的绑定会话。
- 无标记、无 mention：不需要隐藏 HTML 标记、不需要 `@bot`、不需要 sender 白名单豁免。同账号的其他会话/agent/本人评论，以及异账号评论，都投递。
- 仅当目标会话自己发过某条评论时才对其抑制（防回环）。
- 复用现有绑定投递契约：角色感知路由、稳定键去重、死信/背压、休眠唤醒、仅私有（绝不公开回复）。
- 随 `deliverToBoundSessions` 默认开启；提供一个 operator 关闭开关。

## 非目标

- Webhook 推送接入（仍是未来工作）。
- 改动四个 PR 状态事件、`prWatchEvents`、或通知驱动的评论 lane（它们照旧；新监视是增量的，并按评论 id 与之去重）。
- 公开回复：没有剩余绑定目标的被监视评论私有退休，绝不在公开作答。
- 归因任何本地 transcript 之外发布的评论（例如人在 github.com 上）。那些没有本地作者证据，投递给所有绑定会话，这是正确的。
- 在*通知* lane 里读行内 review 评论（现有限制）；本监视直接抓取它们。

## 设计

### 1. 轮询 —— channel PR watch

在现有每 PR watch pass（`watchOnePr`）里增加评论观测，受 `deliverToBoundSessions` 与关闭开关门禁，独立于 `prWatchEvents`：

- 抓取绑定 PR 的会话评论（`issues.listComments`）与行内 review 评论（`pulls.listReviewComments`）。为控制 API 成本，仅当 PR 的 `updated_at` 自上次评论观测以来前进、或周期性复查间隔到期时才抓取（与 CI 复查同形），并用 `since` 游标分页。
- 在 `PrWatchEntry` 里持久化每 PR 评论游标（最近见到的评论时间戳/id 与上次抓取时间）。首次观测静默基线化（不回填积压），与状态 watch 约定一致。
- 每条新评论成为一个带**稳定身份**的候选事件（会话评论：`issuecomment-<id>`；行内：`reviewcomment-<id>`），使 poll、重启、多 channel 实例都按 GitHub id 去重。
- 每 pass 限制候选数量；仅在投递意图被持久化认领后才记录游标（与聚合 lane 相同的崩溃窗口规则）。

### 2. 归因 —— daemon 已发评论查询

新增只读路由，返回某会话**发过**的评论标识集合，源自其 transcript：

- 扫描 `<chatsDir>/<sessionId>.jsonl` 的 `tool_result` 条目。当所执行命令是评论/review **创建**（识别模式：`gh pr comment`、`gh issue comment`、`gh pr review`，以及 `gh api`/`curl` POST 到 `issues/<n>/comments`、`pulls/<n>/comments`、`pulls/<n>/reviews`）时，把该结果输出里的评论 id 归因给该会话。从结果输出提取 id（`issuecomment-(\d+)`、`discussion_r(\d+)`、以及评论/review JSON 的 `"id"`），归一化为 `ic:<id>` / `rc:<id>`。
- 读取/列表不归因（只有创建归因），所以仅查看过某评论的会话仍会收到该事件。
- 增量：按会话以 transcript 水位（size/mtime + 已扫描偏移）为键缓存；只重扫追加的行。transcript 不可读时返回空集并记日志（对投递 fail-open：宁可投递也不静默丢弃），绝不成为剪枝绑定的理由。
- 给 `ChannelBoundSessions` 增加 `postedCommentIds(sessionId): Promise<ReadonlySet<string>>`；daemon worker 通过新路由实现。standalone 模式缺失 → 不抑制（今天的行为）。

所有权：该路由像 prompt 路由一样解析会话所属 workspace runtime，只读该会话的 transcript，并像其他会话路由一样鉴权。它只读，不新增写面。

### 3. 投递 —— channel

对每条候选评论：

1. 用现有角色感知解析器（`resolveBoundTargets`）解析该 PR 的绑定目标，事件类为 `comment`。
2. 剔除 `postedCommentIds` 含该评论标识的每个目标。
3. 经现有绑定 prompt 路径（`claimInboundTask` + `deliverToBoundSession`）投递给剩余目标，用稳定评论 id 作事件/幂等键。复用角色模板（`fix:comment` / `comment` / `default`）、死信、背压与唤醒。
4. 若无剩余目标（都发过它，或没有绑定），私有退休并记一条 journal；绝不回退公开回复。

prompt envelope 携带：作者 login、评论正文（sanitize + 码点上限）、评论 URL，行内评论还带文件路径、行/侧与有界的 diff-hunk 上下文。所有 GitHub 内容标记为不可信事件数据；回复留在会话内。

### 4. 防回环与边界

- 自身评论由归因抑制，fix 会话的回复不会再次触发它自己。
- 归因漏判（某种不留可识别创建结果的发布方式）可能回声一条自身评论；稳定 id 去重把它限制为单次投递，并予以文档化。本仓库 skill 主流的基于 `gh` 的发布被覆盖。
- 部分绑定快照绝不剪枝 watch 状态，且延迟而非消费（fail-closed，与状态 watch 一致）。
- 通知 lane 也可能投递同一条评论（异账号的 `author`/`mention` 线程）；共享的稳定评论 id 在两条路径间去重。

## 受影响文件

- `packages/channels/github/src/GithubAdapter.ts` —— watch pass 的评论观测、候选 → 过滤后的绑定投递、游标字段、关闭开关配置、行内评论抓取。
- `packages/channels/base/src/types.ts` —— `ChannelBoundSessions.postedCommentIds`。
- `packages/cli/src/commands/channel/daemon-worker.ts` —— 通过新路由实现访问器。
- `packages/cli/src/serve/routes/session-posted-comments.ts`（新增）+ 路由注册 —— transcript 归因查询。
- `docs/users/features/channels/github.md` —— 文档化默认开启的评论监视、归因与关闭开关。
- 每个改动文件的同址测试；`.qwen/e2e-tests/` 下的 E2E 计划。

## 开放问题

1. 归因精度：创建模式检测（已选）vs 宽泛的“任何 tool_result 提及”。创建检测忠于“本会话发出”，并避免抑制会话仅读过的评论；奇异的静默发布是文档化的残余。
2. 多绑定 PR 下的评论抓取节奏与上限（API 预算）；先用 `updated_at` + 周期复查形状与现有 `prWatchLimit`。
3. 行内评论 prompt 形状：在正文上限内包含多少 diff-hunk 上下文。
