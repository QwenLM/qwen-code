# 绑定 PR 评论监视（会话评论 + 行内 review 评论）

[English](2026-11-08-bound-pr-comment-watch.md) | [简体中文](2026-11-08-bound-pr-comment-watch.zh-CN.md)

状态：proposed（2026-11-08）。扩展 [GitHub Channel Events to PR-Bound Sessions](2026-11-02-github-channel-bound-session-events.md)；不改动四个 PR 状态 watch 事件，也不改动通知驱动的评论 lane。

修订 2026-11-08（评审）：watch 仅在把评论投递给至少一个绑定会话时才消费它——其较窄的 `comment` 类无法路由的评论保持未消费（不写共享去重键），好让通知 lane 仍按线程自身的 reason 投递；评论游标不会越过投递意图未被持久化认领的评论（`dispatchEnvelope` 返回 false 时保留 `commentSince` 以便重试）；两个评论抓取沿用状态 watch 的限流快速退出重试判断，并把共享凭据/限流错误交给本轮中止逻辑；归因要求写标志与评论集合同处一个管道段（链尾的 `stat -f` 或引号内的 `grep 'gh pr comment'` 属读取）、对显式 GET（即便带字段参数）一票否决、剥离引号片段、给 transcript 扫描缓存设上限、且只在有候选时才查询；每轮候选上限用于排出停机积压而不丢尾部。watch 记录 `dispatchedCommentTimes` 使其去重键可被逐出；仅评论的 channel（`prWatchEvents` 为空）跳过每轮 `pulls.get`。`prCommentWatch` 不带 `deliverToBoundSessions` 依赖校验，因为编辑器会为每个 channel 提交它的默认值。归因读活跃 transcript 及该会话的 subagent transcript（归档会话自己发的评论是已点名的尽力而为残余）。watch 将自身限定于同账号评论——即通知 lane 看不到的缺口；异账号评论仍由通知 lane 处理，因为若以 watch 较窄的 `comment` 类消费它们，可能只触达已配置角色的一个子集而饿死其余角色。作者排除先于每轮批次上限执行，避免一连串自己发的评论占满批次位、卡住游标。归因还识别纯数字的创建结果（`--jq '.id'`）与标志在 URL 之前的 curl 写入、否决带引号的 GET 方法值、并把换行视为命令边界。

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

- 当 `deliverToBoundSessions` 为 true 时，轮询每个绑定 PR 的**同账号会话评论与行内 review 评论**，把每条新评论投递进每一个**没有发过它**的绑定会话。本监视恰好补上通知 lane 看不到的缺口：GitHub 不会就账号自己的活动给它发通知。异账号评论会产生通知，仍由通知 lane 处理（见非目标）。
- 无标记、无 mention：不需要隐藏 HTML 标记、不需要 `@bot`。同账号的其他会话/agent/本人评论无论有无标记都投递；仅当发送者是 channel 自身 login 时，这条私有 lane 才豁免 sender 门禁。
- 仅当目标会话自己发过某条评论时才对其抑制（防回环）；排除按目标逐个执行，因此 fix/verify 组合仍会投递给非作者。
- 复用现有绑定投递契约：角色感知路由、稳定键去重、死信/背压、休眠唤醒、仅私有（绝不公开回复）。
- 随 `deliverToBoundSessions` 默认开启；operator 关闭开关（`prCommentWatch: false`）可禁用。

## 非目标

- Webhook 推送接入（仍是未来工作）。
- 改动四个 PR 状态事件、`prWatchEvents`、或通知驱动的评论 lane（它们照旧；新监视是增量的）。
- **异账号评论。** 它们会产生 GitHub 通知，由通知 lane 按线程自身的 reason/角色模板投递。watch 不得消费它们：仅解析较窄的 `comment` 类可能只触达已配置角色的一个子集而饿死其余角色。两条路径按发送者互斥，因此不需要也不可能跨路径去重。
- **review 正文**（经 `gh pr review` / `pulls/<n>/reviews` 发布的 verdict/总结）。watch 只抓会话评论与行内 review 评论；review 正文两者都不是，也没有任何 lane 读它。review 对象的 id 还与行内 review 评论处于不同的 id 表，因此归因不识别 review 创建。投递 review 正文可作为后续工作（带独立键空间的第三次抓取）。
- 公开回复：没有剩余可投递目标的被监视评论私有退休并记一条 journal，绝不在公开作答。
- 归因任何本地 transcript 之外发布的评论（例如人在 github.com 上用另一账号）。那些没有本地作者证据；同账号的投递给所有绑定会话，这是正确的。
- 在*通知* lane 里读行内 review 评论（现有限制）。本监视直接抓取它们，但只投递 channel 自身账号的；其他账号的行内 review 评论今天没有任何 lane 投递。

## 设计

### 1. 轮询 —— channel PR watch

独立的 `watchPrComments` 与 `watchOnePr` 一起在每 PR watch pass 中运行，受 `deliverToBoundSessions` 与关闭开关门禁，独立于 `prWatchEvents`。仅评论的 channel（`prWatchEvents` 为空）完全跳过 `watchOnePr`，因此不付每轮 `pulls.get`：

- 抓取绑定 PR 的会话评论（`issues.listComments`）与行内 review 评论（`pulls.listReviewComments`），用 `since` 游标分页。按固定间隔复查（`COMMENT_RECHECK_INTERVAL_MS`，2 分钟）；没有 `updated_at` 快路径。两个抓取沿用状态 watch 的限流快速退出重试判断，并把共享凭据/限流错误交给本轮中止逻辑。
- 只有**同账号**评论成为候选（`user.login` 等于 channel 的 `botUsername`）；异账号评论留给通知 lane。
- 在 `PrWatchEntry` 里持久化每 PR 评论游标（`commentBaseline`、`commentSince`、`commentLastFetchAt`）。首次观测静默基线化（不回填积压）。游标下取整到整秒，因为 GitHub 按秒粒度比较 `since`。仅评论的 channel 依据绑定的终态排空 merged/closed 绑定（没有 `state_change` 可观测），因此不会被永久评论抓取。
- 每个候选的**去重身份**是评论的 `node_id`（缺失时退回 `String(id)`），记入 `dispatchedComments`，并把 `created_at` 记入 `dispatchedCommentTimes` 使该键可被逐出。归因键是独立的：`ic:<id>` / `rc:<id>`（见 §2）。
- 作者排除先于批次上限执行，避免自己发的评论占满批次位、卡住游标。**pass 级预算**（`MAX_WATCH_COMMENTS_PER_PASS`，由本轮所有被监视 PR 共享）约束停机突发；发现预算已耗尽的 PR 保留游标、下一轮续跑，被封顶的 PR 在其最后处理的评论之前续跑，使尾部排出而不丢弃。
- 游标不会越过投递意图未被持久化认领的评论（`dispatchEnvelope` 返回 false 时保留 `commentSince` 以便重试）。没有任何可投递目标的同账号评论记一条 `comment_watch_no_target` skip 行——通知 lane 永远看不到它，所以该行是它唯一的痕迹。

### 2. 归因 —— daemon 已发评论查询

新增只读路由，返回某会话**发过**的评论标识集合，源自其 transcript：

- 扫描 `<chatsDir>/<sessionId>.jsonl` 的 `tool_result` 条目。当所执行命令在**命令位置**是评论**创建**（识别：`gh pr comment`、`gh issue comment`，以及 `gh api`/`curl` POST 到 `issues/<n>/comments` 或 `pulls/<n>/comments`）时，把评论 id 归因给该会话。review 正文（`gh pr review`、`pulls/<n>/reviews`）超出范围、不被识别。收割**优先结构化结果**：单个 JSON 对象的顶层 `id` 即所创建评论，其正文里引用的 URL 属数据（不再扫描）；即便对象后跟一行尾部输出（`…}\nALL DONE`）也解析首个平衡对象；一行纯数字是 `--jq '.id'` 形态；单条评论 URL（`issuecomment-(\d+)` / `discussion_r(\d+)`）是 `gh pr comment` 形态。**所有**形态都先过输出来源检查：若链中运行了**多于一个 `gh`/`curl` 命令**（按与创建识别一致的 wrapper/赋值前缀计数），则不归因。另一个 API 命令可能产出了我们所解析的评论形态输出——创建之前的读取、创建之后的读取、或众多读取形态中的任意一种（集合列表、单评论端点 `issues/comments/<id>`、`gh pr view --comments` / `--json comments` 等）——枚举读取语法无法证明没有其他命令贡献评论输出；仅凭命令顺序不能证明作者。非 API 伴随命令（如 `| tee`）不构成歧义。id 归一化为 `ic:<id>` / `rc:<id>` 并键到创建自身的集合。歧义输出不归因任何内容（fail-open）。
- 读取/列表不归因（只有创建归因）：显式 GET 即便带字段参数也被否决（`--method`/`--request`/`-X`，含带引号的方法值），`curl -G`/`--get` 属读取，shell 注释在**分段时**即被丢弃（故 `… # inspect; gh pr comment …` 既不会把注释文字当创建、也不会按注释里的 `;` 拆段，注释里的写标志不算标志），子命令须位于命令位置（引号内或未加引号的 `grep gh pr comment` 属读取），链尾的 `stat -f` 不算写标志。仅查看过某评论的会话仍会收到该事件。
- 增量：按会话以 transcript 水位（size/mtime + 已扫描偏移）为键缓存，受 FIFO 扫描缓存上限约束；只重扫追加的行。transcript 不可读/缺失时返回空集（对投递 fail-open：宁可投递也不静默丢弃），绝不成为剪枝绑定的理由。查询以非 200 或请求异常失败时，worker 记一条节流诊断，使由此产生的自投递回环可与「安静的 PR」区分。
- 给 `ChannelBoundSessions` 增加 `postedCommentIds(sessionId): Promise<ReadonlySet<string>>`；daemon worker 通过新路由实现。standalone 模式缺失 → 不抑制（今天的行为）。

所有权：该路由从调用方声明的 `workspaceCwd` 解析会话所属 workspace runtime，像兄弟路由 `/sessions/pr-bindings` 一样以项目成员闸门（`sessionPrSidecarBelongsToCurrentProject`）门禁读取，使调用方无法扫描外来项目的 transcript，并像其他会话路由一样鉴权。它经 core 的规范访问器 `getSessionTranscriptPath` 读活跃 transcript（而非重新推导 sidecar 兄弟路径），并扫描该会话的 subagent transcript（`<projectDir>/subagents/<sessionId>/agent-*.jsonl`，按数量设上限）——委托给 subagent 发布的评论仍是该会话自己的评论，否则会回灌。它只读，不新增写面。

### 3. 投递 —— channel

对每条候选评论：

1. 用现有角色感知解析器（`resolveBoundTargets`）解析该 PR 的绑定目标，事件类为 `comment`。
2. 剔除 `postedCommentIds` 含该评论标识的每个目标。
3. 经现有绑定 prompt 路径（`claimInboundTask` + `deliverToBoundSession`）投递给剩余目标，用稳定评论 id 作事件/幂等键。复用角色模板（`fix:comment` / `comment` / `default`）、死信、背压与唤醒。
4. 若无剩余目标（都发过它，或没有绑定），私有退休并记一条 journal；绝不回退公开回复。

prompt envelope 携带：作者 login、评论正文（sanitize + 码点上限）、评论 URL，行内评论还带文件路径与行/侧（不带 diff-hunk 上下文）。metadata 身份行渲染最近观测到的 PR 标题，因此只要观测过标题，`%title%` 绑定动作变量就有值（从未观测过标题的仅评论 pass 渲染为空）。所有 GitHub 内容标记为不可信事件数据；回复留在会话内。

### 4. 防回环与边界

- 自身评论由归因抑制，fix 会话的回复不会再次触发它自己。排除按目标逐个执行：在 fix 会话作者了评论的 fix/verify 组合里，verify 会话仍会收到。
- 归因漏判（某种不留可识别创建结果的发布方式）可能回声一条自身评论；稳定 id 去重把它限制为单次投递，并予以文档化。本仓库 skill 主流的基于 `gh` 的发布被覆盖。
- 部分绑定快照绝不剪枝 watch 状态，且延迟而非消费（fail-closed，与状态 watch 一致）。
- watch 与通知 lane **按发送者互斥**（同账号 vs 异账号），因此永远不会投递同一条评论，也不会触发跨路径去重。watch 的私有投递仅在发送者是 channel 自身 login 时豁免 sender 门禁（推荐的 `senders: allowlist` 策略排除该账号）；公开/通知路径继续拒绝白名单之外的发送者。

## 受影响文件

- `packages/channels/github/src/GithubAdapter.ts` —— `watchPrComments`、候选 → 按目标过滤的绑定投递、游标字段、pass 级预算、仅评论终态排空、无目标 journal 行、标题透传、关闭开关配置、行内评论抓取。
- `packages/channels/base/src/types.ts` —— `ChannelBoundSessions.postedCommentIds`。
- `packages/channels/base/src/ChannelBase.ts` —— 私有同账号 lane 的 `waiveGroupSender` 预检选项。
- `packages/cli/src/serve/server/posted-comment-attribution.ts`（新增）—— transcript 创建检测与 `ic:`/`rc:` 归因键。
- `packages/cli/src/commands/channel/daemon-worker.ts` —— 通过新路由实现访问器，带节流失败诊断。
- `packages/cli/src/serve/routes/session-posted-comments.ts`（新增）+ 路由注册 —— 带项目成员闸门的 transcript 归因查询。
- `packages/web-shell/client/components/channels/*` + i18n —— 尊重声明的布尔默认值，并把 `prCommentWatch` 登记进绑定面板。
- `docs/users/features/channels/github.md` —— 文档化默认开启的评论监视、归因与关闭开关。
- 每个改动文件的同址测试；`.qwen/e2e-tests/` 下的 E2E 计划。

## 约束

- 归因 fail-open：证据缺失绝不得把「判不准」变成「本会话发过」；收窄归因只会投递更多，绝不抑制更多。
- 仅私有：被监视评论绝不在公开作答；没有可投递目标的评论记 journal，而非静默消费。
- 通知 lane 与公开 sender 门禁不变；sender 豁免仅作用于私有同账号绑定 lane。
- review 对象的 id 不得进入 `rc:` 命名空间（行内 review 评论用不同的 id 表）。
- 游标与去重必须在重启、限流中止后仍不越过评论、不重复投递。

## 验证

- 单测：adapter 评论 watch 套件（同账号范围、按目标排除、游标精度、批次上限、pass 级预算、间隔门、默认开启、终态排空、无目标 journal、标题）；归因检测器（创建形态收割、GET/`-G` 否决、引号感知分段、`ic:`/`rc:` 字面量钉子）；路由（信任 + 项目成员闸门）；worker 访问器（fail-open + 节流诊断）；web-shell 编辑器默认值一致性。
- 变异见证：每个承重守卫（sender 豁免、按目标排除、无目标 journal、标题、终态排空、pass 预算、归因诊断）在移除时让一条点名的用例变红。

## 验收标准

- 一个绑定会话发布的同账号评论，在推荐的 `senders: allowlist` 策略下、无需标记或 mention，投递给每一个没有发过它的其他绑定会话。
- 作者会话收不到自己的评论；仅读取过评论的会话仍会收到。
- 异账号评论与 review 正文不被 watch 消费。
- UI 创建/编辑的 channel 保持监视默认开启；显式 `prCommentWatch: false` 禁用它。

## 开放问题

1. 归因精度：不留可识别创建结果的奇异静默发布是文档化的残余（一次自回声，受稳定 id 去重约束）。
2. review 正文投递（带独立键空间的第三次抓取）可作为后续工作，此处不涉及。
3. watch 感知的去重环逐出下界（使仅同账号 channel 的环在没有通知时也能收缩）需要独立的 watch 环或按 lane 标记的键才安全；作为后续跟进。
