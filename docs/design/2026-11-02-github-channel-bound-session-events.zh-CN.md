# GitHub Channel 事件投递到 PR 绑定会话

[English](2026-11-02-github-channel-bound-session-events.md) | [简体中文](2026-11-02-github-channel-bound-session-events.zh-CN.md)

状态：提案（维护者已于 2026-11-02 确认决策：prompt 注入投递、channel 内状态监视、事件范围 = CI 失败 + 合并冲突 + 新评论 + head 前进 / merged / closed）。

## 问题

在 Qwen Code 会话里跟进一个 PR 的用户（创建、评审或验证过该 PR 的 Web Shell 或 CLI 会话），在该 PR 发生变化时得不到 GitHub channel 的任何帮助：

1. **两套互不相通的会话体系。** GitHub channel 把每个事件路由到 channel 自有的会话，路由 key 为 `github:<owner>/<repo>:pr:<N>`（`SessionRouter`，`chat_thread` scope）。真正跟进该 PR 的会话——拥有 worktree、上下文、且 `prs` sidecar 里登记了该 PR 绑定的那个——永远看不到事件。
2. **事件覆盖缺口。** 适配器轮询 Notifications API 并枚举评论。纯 CI 失败（reason 为 `ci_activity`、无新评论）不产生任何投递。合并冲突根本不会产生 GitHub 通知。新推送与合入/关闭迁移同样不可见，除非有人发表评论。

补齐这两个缺口所需的积木已经存在：

- **PR 绑定**：`packages/core/src/services/session-pr-service.ts` 持久化 `<chatsDir>/<sessionId>.pr.json`；daemon 刷新定时器（`packages/cli/src/serve/server/session-pr-refresh.ts`）已经在周期性扫描所有 trusted workspace 的 sidecar。目前还没有反查（PR → 会话）。
- **向已有会话投递**：`POST /session/:id/prompt` 接受任意存活会话的 prompt，按 session id 解析 owner runtime（可跨 workspace），会话 busy 时 FIFO 排队（`packages/acp-bridge/src/session-control-plane.ts` 的 `DEFAULT_MAX_PENDING_PROMPTS_PER_SESSION = 5`；队满 → HTTP 503 `prompt_queue_full` + `Retry-After`）。
- **新建会话**：channel 现有的 `SessionRouter` 路径在无路由时本就会创建 channel 会话。

## 目标

- 当 GitHub 事件涉及的 PR 已绑定到某个存活会话时，把事件作为 prompt 回合投递进该会话，让它带着已有上下文处理。
- 感知 Notifications API 给不了的事件：PR head 的 CI 失败、合并冲突出现、head 前进、PR 合入/关闭迁移——针对已绑定到会话的 PR 集合。
- 没有绑定会话时保持今天的行为：事件走正常 channel 路径，创建（或复用）channel 会话。

## 非目标

- 不做 webhook 推送接入。daemon 的 `POST /channels/:channelName/webhooks/:source` 路由保持原样（静态 targets）；真推送投递是后续工作。
- 不让 channel 接管绑定会话（不使用 `SessionRouter.activateManagedSession`）：绑定会话的回复绝不能按 channel publication contract 自动发布为 GitHub 评论。
- 此路径不走跨会话 peer 消息（review-class 审批门与 external peer 注册在此徒增复杂度）。
- 不自动给 channel 创建的会话登记 PR 绑定。Channel 会话保持既有路由与公开回复行为。
- 不支持 standalone `qwen channel start`（非 daemon 的 ACP 模式）：反查是 daemon 路由，该模式下功能退化为今天的行为。
- 行内 PR review 评论仍不在范围内（适配器既有限制）。

## 设计

### 第 1 层 —— daemon 反查路由

新增进程级只读路由：

```
GET /sessions/pr-bindings
→ { "bindings": [ { sessionId, workspaceCwd, sourceType, updatedAt, prs: [{number, url, state?}] } ], "partial": false }
```

- 所有权类别：**进程级**（与 `POST /sessions/backfill-prs` 同类）。遍历 registry 的 workspace 条目（`listAllEntries()`），对每个 active 的受信 runtime 经 live-merged 会话列表路径（`listWorkspaceSessionsForResponse`，它会用 PR sidecar 补全会话摘要）枚举 active 会话，分页有上限。Untrusted 非 primary workspace 跳过（它们无法创建或恢复会话，缺席是合法的）；untrusted PRIMARY 跳过但置 `partial`，因为会话创建/恢复对 primary 豁免信任门，它仍在服务绑定会话。
- 排除归档会话。携带 `sourceType` 以便调用方排除 channel 自有会话。`prs` 条目投影为 `{number, url, state?}`。**每个成功扫描到的会话都输出一行，包括空行**：`prs: []` 的行是 tombstone，意为「已扫描、无绑定」（观测到的解绑），调用方必须能把它与「本次答案未枚举到该会话」区分开——否则任何 partial 答案都会在显式解绑后复活过期绑定。sidecar 存在但读取失败（I/O 错误、JSON 非法、形状校验失败——投影的 `prsReadFailed` 标志，底层是 core 的 `readSessionPrsDetailed` 对 absent/invalid 的区分）的会话被省略并置 `partial`：它的绑定是未知，不是空。
- **`partial`** 在答案不完整时为 true：某个 workspace 列表失败、某个受信 workspace 非 active（draining / transitioning / blocked——它仍在服务会话但无法被枚举）、untrusted primary workspace（仍在服务绑定会话，被跳过）、live-merge 降级成功（`liveMergeFailed`）、某页报告截断、页数上限耗尽、或扫描需要多页。最后一条之所以重要，是因为活动序分页不是快照隔离的：某个 live 会话的活动在两次翻页之间前进，就可能被每一页都跳过而扫描仍然「干净」结束，因此任何多页答案都是非权威的。调用方绝不能把 partial 答案中缺失的条目当作权威性的「不存在」（适配器把 partial 答案并入已知绑定，并跳过监视状态剪枝）。单个 workspace 扫描失败会打 stderr 日志（workspace + 原因），持续 partial 因此有诊断面。
- 与其他会话路由一样鉴权（`--require-auth` 时 bearer）。不新增写入面。
- 该路由是扫描而非索引：以 sidecar 体系的规模（每 workspace 几十个会话），每次轮询扫一遍可以接受；适配器将结果缓存一个轮询周期。

### 第 2 层 —— worker 提供的投递访问器

`ChannelBaseOptions`（`packages/channels/base/src/ChannelBase.ts`）增加一个可选字段；`ChannelAgentBridge` 契约不变：

```ts
boundSessions?: {
  listPrBindings(): Promise<{ bindings: PrBindingSummary[]; partial: boolean }>;
  deliverPrompt(
    sessionId: string,
    prompt: string,
    idempotencyKey?: string,
  ): Promise<void>;
};
```

- daemon channel worker（`packages/cli/src/commands/channel/daemon-worker.ts`）用它已持有的 SDK client 实现：`listPrBindings` 调新路由，并从每次完整答案重建 session→cwd 缓存（离开绑定的会话随之掉出）；畸形的 HTTP-200 响应体（`bindings` 非数组）抛错而非返回权威空快照，把失败导入适配器的 fail-closed 刷新处理。空 prs 的 tombstone 行原样传给适配器（它们是观测到解绑的信号）；任一 PR 条目畸形——或任一会话行被丢弃——都把答案标记为 partial，而某会话列出的 PR 条目全部形状校验失败时还会跳过该会话，而非投影出权威的空集。`deliverPrompt` 以 text content block 投递 prompt，进入 FIFO 队列即算投递成功——worker 不等待目标会话的回合结束。每个 POST 都携带调用方的 `idempotencyKey`（由源 chat 与 message id 导出的稳定事件身份）：prompt 路由按会话记住已受理的键，重复请求返回原受理结果，因此受理标记丢失或 202 丢失后的重试不会重复注入（关键决策 10）。每个可达的入队前 admission 检查都**同步抛错**——包括保留 standalone 工作目录守卫：会话的托管会话绑定尚未 release 时它返回可重试的 `409 working_directory_missing`——因此路由绝不会返回会被中继当作持久受理消费掉的幻影 202；路由对延迟非受理的键遗忘保留为纵深防御。POST 携带与 bridge 相同的 channel 回合分类（`_meta` channel-prompt 标记加 worker 授权，admission 一并校验），因此中继不会被当作交互式用户 prompt（loop-detected 拒绝、对中继文本做 live PR 绑定回填）。worker 授权是**限定于其存在理由的进程级中继凭据**：本 workspace 的回合走按 workspace 的注册；跨 workspace 的分类额外要求显式的 `qwen.daemon.channelBoundRelay` 标记与 primary/受信目标，因为绑定投递本就跨 workspace（关键决策 3），但携带外部 worker token 的普通 prompt 必须仍是普通交互式 prompt。伪造或未注册的 token 仍在路由处与 bridge admission 剥离处两次被丢弃。每个响应体都被消费或取消，每次 body 读取都有 abort signal 兜底：未读的 undici body 会把连接占到 GC，而停滞的 mid-body 读取否则会挂死整个轮询循环。
- **休眠唤醒**：绑定路由列出的是持久化的 active 会话，但 prompt 路由只服务 live 会话；daemon 重启后绑定会话处于休眠态，prompt 会 404。访问器遇 404 时经 channel bridge 同款 resume 路径恢复该会话（workspace cwd 取自缓存的绑定，未知时先刷新一次），再重试一次 prompt。恢复会铸造一个 client 注册；访问器在重试的 prompt 落定后显式释放它（detach）——非空注册会挡住 daemon 的 prompt-settled idle close，不 detach 就会把会话钉在 live 态直到 TTL reaper。若 cwd 未知且刷新返回的 partial 快照漏列了该会话，访问器以背压错误（`BoundSessionUnavailableError`）推迟，而非把 404 判为消失或消耗失败预算：不完整枚举中的缺席不是删除的证据。
- **唤醒错误分类**：404 恢复失败（会话记录真正不存在，或 workspace 本身未注册——restore 路由对永久性缺席返回可区分的 `workspace_not_found` 404，可逆的 draining/transitioning 状态仍返回 `workspace_mismatch` / `workspace_runtime_unavailable`）、归档会话（409 `session_archived`，按契约排除在候选集外）、被取代会话（409 `worktree_session_superseded`——worktree reset 永久切断它，绝不再恢复），以及中断的 worktree 形状（409 `worktree_marker_missing` / `worktree_reset_interrupted`——其修复是 worktree-reset 重试而非 resume 重试，推迟它们只会在视界后死信而永不回退）成为 `BoundSessionGoneError`。队满、workspace/会话暂不可用（503、daemon 自身 prompt 档限流 429 与其他 5xx、恢复冲突、会话数上限、已武装的 worktree-reset prompt 屏障 409 `worktree_reset_active`——reset 流程明确要求 channel-worker 调用方重试）、绑定刷新失败，以及**成功 wake 之后重试得到的 404**（属主可能在 resume 与重试之间开始 drain，而 prompt 路由对非 active 属主返回同一个可逆 404）作为背压或瞬时错误传播，让适配器推迟或重试，而不是降级成公开 channel 投递——若会话确已消失，下一轮 wake 的 resume 会报告永久 404/409。直接 prompt 路径对这些 409 码的分类与 wake 一致（archived/superseded → gone；reset 屏障/restore-in-progress/busy → 背压），另把未 release 的 standalone 工作目录绑定（`working_directory_missing`，daemon 标记 retryable 并带 `Retry-After`）归为背压：会话恢复前后的 bind/release 窗口是瞬态的，事件推迟而不消耗失败预算。权威 Gone 还会逐出该会话缓存的 wake cwd，永久 partial 快照因此不会让后续每次投递都空转一次注定失败的 resume。
- `deliverPrompt` 把消失、队满（`BoundSessionQueueFullError`）与暂不可用（`BoundSessionUnavailableError`）作为可区分的错误抛出，供适配器回退、推迟或重试。
- 该选项缺失时（standalone 模式、测试），适配器行为与今天完全一致。

### 第 3 层 —— GitHub 适配器改动

全部在 `packages/channels/github/src/GithubAdapter.ts` 及 `index.ts` 的插件描述符内。

#### 配置

新增两个管理字段：

| 字段                     | 类型        | 默认         | 含义                                                                                      |
| ------------------------ | ----------- | ------------ | ----------------------------------------------------------------------------------------- |
| `deliverToBoundSessions` | boolean     | `false`      | 把已绑定到存活会话的 PR 的事件投递进该会话，而非 channel 会话。                           |
| `prWatchEvents`          | string-list | `[]`（关闭） | 对绑定 PR 监视的状态迁移：`ci_failure`、`merge_conflict`、`head_change`、`state_change`。 |

`deliverToBoundSessions` 关闭时 `validateConfig` 拒绝非空 `prWatchEvents`（监视集合由绑定定义；只监视不投递在 MVP 没有意义）。描述符委托适配器的共享校验器（`validateBoundSessionConfig`），管理界面与 `connect()` 共用同一份词表，不会漂移。两个字段都是 opt-in；既有部署不受影响。

#### 绑定会话选择

开启 `deliverToBoundSessions` 时，适配器在每次轮询开始拉取 `GET /sessions/pr-bindings`，构建 `owner/repo#number → session` 映射。键的两侧都对 repo 路径小写归一：GitHub URL 大小写不敏感（core 的 `canonicalSessionPrUrl` 即小写化），绑定 URL 可能带任意大小写，而通知 subject URL 带规范大小写。主机比较两侧都剥离前导 `www.`（用户会粘贴 `www.github.com` 链接；core 的 `repoKeyFromWebUrl` 归一同一别名）。绑定 URL 解析容忍尾部 tab 段（`/files`、`/commits`、`/checks`），因为绑定路由接受任何命名该 PR 的 http(s) URL。

- 只保留 PR URL 主机与 channel 的 GitHub 主机一致的绑定（Aone 等其他 provider 的绑定忽略）。
- 活跃监视集合只保留记录 `state` 非 `merged`/`closed` 的条目，但终态迁移尚未被观测到的除外（见 PR 状态监视）；评论事件的投递候选接受任意记录状态（刚合入的 PR 上的评论仍应投递，绑定状态由刷新定时器追平）。
- 排除 `sourceType === 'channel'` 的会话——channel 会话走正常 channel 路径，以保留其公开回复契约。
- 多个候选：取最近更新的会话（`updatedAt` 降序；live 摘要缺 `updatedAt` 时路由回退到 `createdAt`，新建的 live 会话因此不会被过期的持久化会话压过）。确定性选择，不广播。
- 刷新失败保留旧映射（过期候选在投递时失败并回退）；该轮询跳过监视回合，瞬态失败因此无法剪掉持久化基线。`partial` 快照会并入旧映射与绑定列表——不完整答案漏列的已知绑定被保留，私密投递绝不会因扫描失败降级成公开路径——并禁用监视状态剪枝。保留以会话为粒度而非 PR 键：已列出会话的 PR 集是权威的（路由返回每个已列出会话完整的 sidecar 投影），因此保留绝不会复活该会话刚解绑的 PR；被保留的候选按更新时间竞争，因此只列出较旧会话的 partial 答案不会挤掉更新的已知会话。访问器在 partial 答案下同样保留 session→cwd 唤醒缓存。
- **冷启动**：首个快照成功之前（完整或 partial——映射同样由 partial 答案填充），评论车道推迟（游标不前进）。对着冷启动的空映射认领投递会把事件永久冻结到公开 channel 路径，即使扫描随后恢复；车道推迟期间持久化任务仍正常恢复。门在任意成功快照（`boundSnapshotSeen`）即开启，而非仅完整快照：永久 partial（多页扫描或长期非 active 的 workspace）否则会把车道永久停摆。**空的 partial 答案另外有界**：在从未有过完整快照且映射为空时，连续的空 partial 答案让车道最多关闭 `MAX_COLD_EMPTY_PARTIAL_POLLS = 30` 轮（限流 stderr）——重启后首轮就答 `{bindings: [], partial: true}` 的 draining/不可读 workspace，绝不能抢在真实快照到达之前把每个事件公开路由并提交游标。到达上限后车道仍然开启（永久空 partial 不能冻结 channel），未匹配事件随后走下面的逐事件有界推迟而非公开路径。重新校验与监视剪枝仍要求完整快照（`boundSnapshotTrusted`）。由于从未成功过的绑定刷新（缺该路由的旧 daemon、轮换后的凭据）否则会在一句误导性的「keeping previous map」后面冻结所有通知，推迟会打一条可区分、限流、可操作的日志，点名停摆的车道与要检查的路由——门本身仍保持 fail-closed。
- **不完整扫描绝不确立缺席**：`boundSnapshotTrusted` 为 false 期间，映射中无候选的 PR 的事件不会被公开路由。它被认领并作为背压推迟（尚无 delivery，与其他推迟同样的持久化重试与 `MAX_BOUND_DEFERRALS` 视界，视界尽头进死信）；恢复时对照当前映射重新解析这类推迟事件，因此随后到达的完整快照会把它们私密投递。已知目标不受影响、立即投递。未匹配事件的公开路由要求至少有一次完整快照确立过缺席。

#### 评论投递拦截

`dispatchEnvelope` 是已接受评论/正文/review/assign 事件的唯一漏斗。在认领 inbound task 之前查询绑定会话映射：

- **找到绑定会话** → 持久化的 `InboundTaskRecord` 增加 `delivery: { kind: 'bound-session', sessionId }`。`runInboundTask` 经 `boundSessions.deliverPrompt` 投递事件 prompt，而非 `handleInbound`。由于绕过了 `handleInbound`，bound 路径在投递前执行同一套 `preflightInbound`（group policy、sender gate、pairing——含副作用）；watch 事件豁免（无人类发送者、操作者 opt-in）。冻结的投递目标在投递时对照最新完整快照重新校验，因此 live 改绑会把事件改投新会话而非错投旧会话；partial/失败快照下持久化目标保持（fail-closed）。去重 key、可恢复任务机制不变——只有最终投递不同。
- **无绑定会话** → 评论事件走今天的路径（`handleInbound` → channel 会话）。**watch 事件是私有-only**：它们是面向操作者的机器状态，没有既有的公开路径，channel 会话的回复会把内部 prompt 文本发布到 PR 上（并被 sender allowlist 重新 gating）。没有绑定目标的 watch 事件——投递时、gone 重解析后、或排空时——记日志并退役，绝不公开回退。
- **投递失败**：404 → 访问器先尝试休眠唤醒（第 2 层）；只有无法恢复的会话才视为消失，适配器随后从绑定映射中逐出该死会话（partial 快照因此无法按 recency 保留它、遮蔽活的跟随者）并重新拉取绑定再解析一次；解析到不同候选则改投（该改投 hop 抛出的 Gone 落入同一段回退，而不消耗失败预算），完整快照下无候选 → 评论事件回退到 `handleInbound`，watch 事件记日志退役；partial/失败刷新下评论回退按背压推迟，直到完整快照确立缺席（关键决策 11）。队满与暂不可用的会话/workspace 是背压而非失败：不消耗重试预算，busy 或 draining 的会话因此推迟事件而不是在 `MAX_INBOUND_TASK_ATTEMPTS = 3` 后丢失它。背压有界（`MAX_BOUND_DEFERRALS = 240`，默认轮询下约 4 小时）：超出视界的事件退役到私有死信日志（`github-bound-deadletter.jsonl`）并打 stderr 告警——被显式呈现，绝不静默消费。死信追加本身失败时任务被保留（payload 打到 stderr，持久化记录存活到下一轮重试或操作者恢复）——在那里移除任务会让一行日志成为事件仅存的痕迹。纯背压——包括不完整快照产生的无目标推迟——不持有共享通知游标（一个卡住的会话绝不能冻结所有无关 PR 的 mark-as-read）；其他可恢复任务仍然持有它（reconciliation 被阻塞期间的 watch 任务除外：它们无法推进，也不依赖通知游标）。非背压的 bound 失败耗尽 3 次上限后同样退役到死信日志（私有路径的耗尽呈现面——它不发公开错误评论）。受理在任务移除前持久化（`deliveredAt`）；该标记是优化而非重放守卫：每次注入都携带稳定的事件身份（源 chat + message id）作为准入侧 `idempotencyKey`，因此受理窗口内的崩溃或写失败（或丢失的 202）会以相同的键重放 POST——即使恢复以新 id 重建任务——daemon 将其去重为原受理结果（关键决策 10）。崩溃循环每次恢复捡回计一次尝试，因此会终止。重启后的恢复尊重持久化的 `delivery` 字段，并对照当前映射重新解析无目标的背压推迟。

注入的 prompt 复用 webhook 任务的 prompt 形状（`buildChannelWebhookPrompt` 风格）：事件头、显式的「不可信事件数据」警告、PR 身份（repo、number、标题、URL）、该 lane 的 `Trigger:`/`Event:` 行及 direct lane 的事实性 `Author:` 详情、评论作者/正文或事件详情，以及「回复留在本会话」的指引（该会话不受 channel publication contract 约束；如需在 GitHub 上动作，用它自己的常规工具）。mention 与 first-contact lane 不提供 `Author:` metadata 行，因此 prompt 回退到信封的发送者名——会话必须能区分维护者的指令与路人的评论。面向 channel 的发布措辞绝不进入绑定会话：metadata 里的 publication instructions 被丢弃，聚合 lane 的「output exactly `<no-reply/>`」前缀被替换为普通的「New comments on the PR」头。**任何尾部都不被静默消费**：评论内容上限 6,000 码点，切片之外追加显式的 `[prompt truncated: N more characters omitted]` 提示；聚合批次在 20 条上限处丢弃较旧评论时前置一条省略提示（放在最前，码点上限因此不会截掉提示本身）；每条聚合评论的 400 字符展示上限也带自己的 `[comment truncated: N more characters]` 标记——这些评论都已记入 `dispatchedComments`，任何一级的静默截断都会让它们从所有呈现面消失而 prompt 读起来却像完整的。

#### PR 状态监视

`prWatchEvents` 非空时，`pollOnce` 先对持久化 pending 事件做 reconciliation，再在绑定刷新之后、通用 inbound 恢复与通知处理之前运行监视检测回合：

1. **监视集合**：来自同一次绑定拉取的绑定 PR，过滤为主机匹配 channel 的 GitHub 主机，活跃轮询上限 30 个（按绑定更新时间取最新）。绑定 PR 超过 30 个时，溢出打 stderr 日志（数量 + 被排除的键），最旧绑定被确定性排除因此被显式呈现，绝不静默。被独立刷新记为 `merged`/`closed` 的绑定仍保留轮询，直到本轮询自己观测到终态迁移（`prState: 'closed'`），刷新抢跑因此不会漏掉 `state_change`。观测到终态后，终态标记在绑定仍列出该 PR 期间保留但不再轮询——剪掉它会让下一轮询把已关闭 PR 当作首次观测重新加入（查询振荡）。绑定保留与活跃轮询是两件事。无绑定 PR → 零 API 调用。持久化条目按完整候选集剪枝（而非截断后的监视集，轮转出上限的 PR 因此保留基线），仅在快照完整时剪枝——partial 快照绝不剪枝——且条目仍持有未投递 pending 事件时绝不删除。由于永久 partial 从不剪枝，保留另有上限：至多保留 1024 个未被列出的会话与 1024 个空闲 watch 条目（最旧先逐出，两个上限都打 stderr 呈现），永久不可扫描的 workspace 因此无法让适配器状态无界增长。watch 条目逐出另外跳过仍被保留绑定声明、或仍被在途 watch 任务拥有的条目；被逐出条目的 PR 没有投递目标，后续重新绑定像任何首次观测一样静默重建基线，因此逐出在界定内存的同时不丢失可投递事件。被丢弃会话的未匹配事件走推迟（被逐出的绑定者未被列出，缺席不具权威），在视界尽头呈现于死信。
2. **每 PR**：每次轮询调 `pulls.get`（head SHA、`mergeable`、`mergeable_state`、`state`、`updated_at`）。Check runs（`checks.listForRef`）与组合提交状态（`repos.getCombinedStatusForRef`）仅在订阅了 `ci_failure` 且以下情况拉取：head SHA 较上次轮询变化、尚无 CI 观测、上次 CI 聚合为 pending 且已超过 5 分钟的 pending 复查间隔（`CI_PENDING_RECHECK_INTERVAL_MS`）、PR 的 `updated_at` 前进、聚合为 `none` 且处于 head 首次观测后的 10 分钟宽限窗口内（check 异步注册）、或上次 CI 拉取已超过 10 分钟的 settled-head 复查间隔。pending 间隔在另一个方向上承重：等待环境审批的 workflow 或离线 runner 可能 pending 数小时，无界的每轮询重拉会把 settled-head 成本模型变成监视上限下约 3,600 次 CI 调用/小时——算上 `pulls.get` 就超预算。周期复查同样承重：GitHub 不会因 check 活动 bump PR 的 `updated_at`（已对活体 API 核实），因此已 settled 的 head 复跑变红——或手动 `workflow_dispatch` 晚到的 CI——否则会被永久漏掉。稳态成本为每 PR 每轮询一次调用加有界的周期复查。CI 拉取失败被隔离在自己的 try/catch 里：CI 是 `pulls.get` 基线的条件性补充，因此 Checks 端点的持久失败（经典 PAT 无 Checks 权限、企业策略）记日志后继续、不写入任何 CI 状态——`merge_conflict`/`state_change` 仍从已到达的数据触发，最后已知聚合保持（写 `none` 会在端点恢复时重放 `ci_failure`）。监视 API 调用对重试无法修复的条件快速失败——凭据失败（401）、任何限流（403/429；GitHub 对二级/滥用限流并不总带 `retry-after` 头）与永久性的 per-PR 状态（404/410/451——PR 已删除、已转移或仓库不可用）——不做阻塞 cooldown sleep。共享条件（401/403/429）在失败的 PR 处中止整个回合：遍历其余集合只会在整个重置窗口内对每个被监视 PR 每轮询发一次注定失败的请求；per-PR 永久状态保持隔离，一个被删 PR 不会停掉其他 PR。快速失败谓词是监视局部的，发布车道保留自己的重试语义，通知车道在同一轮询照常运行。
3. **迁移检测**：对照持久化监视状态（`channelFilePath('github-pr-watch.json')`，完整快照时按完整候选集剪枝——见第 1 条）：
   - `ci_failure`：聚合转为失败（任一已完成 check run 结论为 `failure`/`timed_out`/`action_required`/`startup_failure`，或非空组合状态报告 `failure`/`error`）。空组合状态（`total_count: 0`，GitHub 对无 legacy status 的 SHA 返回 `state: "pending"`）绝不算活跃 CI。经持久化 `fired` 环每个 head SHA 只触发一次，即使聚合回绿后再次转红；新 head 再失败会再触发。每条目 `ciFiredSha` 钉作为环的后盾：有上限的环在长寿命 head 上经过 64 个非 ci episode 后可能逐出该 `ci_failure` 每-head 键，钉即使在该逐出后仍保住「每 head 一次」的保证（head 变化时重置）。事件摘要点名失败的 check（至多 5 个），会话无需再查即可行动。
   - `merge_conflict`：`mergeable_state` 进入 `dirty`。边沿触发；`dirty → clean → dirty` 会再次触发。`mergeable === null`（GitHub 仍在计算）绝不覆盖最后已知状态。
   - `head_change`：head SHA 与上次观测不同（首次观测静默初始化）。force-push 回到近期 SHA 是新迁移，会再次触发。
   - `state_change`：PR `state` 离开 `open`（merged 或 closed）。首次观测静默初始化；close → reopen → close 会再次触发。
   - **去重键身份**：每个 watch 键都嵌入 PR 编号与检测时间戳（`watch:<type>:<pr>:<seq>:<detectedAt>`；`watch:ci_failure:<pr>:<sha>:<detectedAt>`）。嵌入 PR 编号是因为投递幂等键只含 chat + message id，而同仓库两个 PR 绑定同一会话时各自并行递增 episode 计数。时间戳让迁移实例在计数重置（剪枝、损坏恢复）后依然唯一：daemon 的幂等环比 worker 长寿，重新发出的裸计数键会去重到旧受理上、静默吞掉新迁移。`ci_failure` 仍每 head SHA 一次——fired 环与 pending 队列按 PR+SHA 前缀匹配其键——其余三类以 episode 计数为键，标识迁移实例而非状态值，因此上述合法复发绝不会被 fired 环压制。计数与基线一同持久化。会超出 prompt 路由 200 字符上限的事件键改用同一身份的确定性哈希（`github:h:<sha256-40>`），重试因此仍能去重，而不是把失败预算烧在 400 上。watch 身份按设计是实例局部的：监视同一仓库的两个 channel 配置各自投递自己的 watch 通知（每订阅 at-least-once）——daemon 环去重的是同一次投递的重试，而非独立订阅；评论事件仍凭稳定的 GitHub id 跨实例去重。
4. **持久化事件队列**：检测到的事件追加进 `pending` 队列，与新基线同一次写入持久化，检测与认领之间崩溃不会丢事件。reconciliation 回合在通用 inbound 恢复之前、独立于 live 监视回合排空所有 pending 条目（不调 GitHub API）：失败或被限流的 API 回合不能饿死已检测事件，恢复也不会先投递并移除一个随后排空会重复认领的任务（认领与 pending→fired 落盘之间崩溃会留下两条记录）。**reconciliation 本身失败时**（如 watch 文件不可读），通用恢复完全跳过 watch 任务直到某次 reconciliation 成功——在 pending 记录尚未对账时投递并移除已受理的 watch 任务，会让随后的排空把同一迁移再认领投递一次；无关的评论恢复照常运行。被阻塞的 watch 任务同时不再持有共享通知游标：reconciliation 失败期间它们无法推进，而 watch 事件来自 PR 状态检测、不依赖通知游标，为它们冻结 mark-as-read 只会让所有无关 PR 停摆到 sidecar 恢复；reconciliation 成功后它们重新持有游标，直到有界重试使其结清。随后逐事件排空：对照最新完整快照重新校验收件人 → 认领 inbound task（持久化——复发的 WATCH 键命中的终态 failed/cancelled 记录会被替换，绝不静默复用；评论/事件/issue-body 键是永不复发的稳定标识，其终态记录保持永久去重屏障——替换它们会在崩溃使游标滞后于取消时复活已取消的评论）→ 把 key 从 `pending` 移入有上限的 `fired` 环（持久化）→ 执行任务。任何点崩溃都留下 pending 事件或已认领任务；`fired` 环是持久化的「每迁移一次」记录（仅靠任务级去重，聚合抖动会在已完成任务被移除后重放同一 head）。认领失败则事件留队下轮重试。drain 在首个投递失败处停下，避免较晚事件跳到较早的重试事件之前（按 PR 保序）；pending 与 fired 已持久化，停下不丢任何东西。保序跨 pass 同样成立：同 PR 较早的 watch 迁移仍有未 settle 的任务时，整个条目的 drain 被跳过（watch pass 在 reconcile 之后会再次 drain，而下一 poll 的 reconcile 先于 recovery）——键等于 pending 头部的任务是该事件自己的崩溃窗口认领，正常 drain。认领持久化失败向上传播出 drain，使 reconcile 失败、恢复守卫保持。每条目 pending 队列上限 64：持续失败的认领无法让它无界增长；溢出把最旧的排队事件退役进死信，死信写失败则留队等待下次检测。认领成功之后 pending→fired 落盘失败则回滚认领（移除任务、恢复 pending 事件）下轮重试，watch 文件不可写 / 任务文件可写的分歧因此不会在重启后二次投递同一迁移。事件任务使用 `source.messageId = watch:<eventType>:<pr>:<headSha|seq>:<detectedAt>`，与评论一样私密投递——但没有公开回退（见评论投递拦截）。
5. **绑定状态维护**仍由既有 5 分钟刷新定时器负责；适配器不 PATCH metadata。定时器记为 `merged`/`closed` 且监视已观测到终态迁移后，该 PR 离开活跃轮询；其终态标记保留到绑定本身消失。
6. **持久化失败语义**：瞬态读错误（EACCES/EMFILE/EIO）fail-CLOSED——跳过监视回合且不保存，直到状态重新加载成功，降级的内存态因此绝不能覆盖完好的文件。只有 ENOENT（首次启动）与持久 JSON 损坏才从空状态起步；语法合法但个别条目畸形的文件就地修复——每个坏条目被丢弃（打一行 stderr），健康条目保留，因此一个损坏值不会饿死其后续条目的 API 无关排空。逐条目形状校验用与任务存储认领时相同的 envelope 与 delivery 校验器校验 pending 事件：缺少 `chatId` 的形状合法信封否则会在绑定键查找处抛错并中止整个 reconcile 循环，部分信封则会被原样认领、在下次任务文件读取时被拒绝、把存储楔住直到操作者删除文件。失败的原子写清理其 UUID 命名的 tmp 文件，持续磁盘压力因此不会累积孤儿。状态文件与目录权限为 0600/0700（它们持久化私密评论信封）。

#### API 预算

默认 60 秒轮询、上限 30 个被监视 PR：稳态 ≤ 1 800 次/小时，加周期性的 settled-head 复查（每 PR 每 10 分钟间隔 ≤ 2 次调用 → ≤ 360 次/小时）与有界的 pending 复查（每 PR 每 5 分钟间隔 ≤ 2 次调用 → 全部被监视 PR 都 pending 的最坏情况 ≤ 720 次/小时）。CI 活跃期每个受影响 PR 每次复查增加 1 次组合状态调用加 `ceil(checkRuns/100)` 页 check 列表——300 个 check 的 monorepo head 花费 4 次调用，大 CI 突发仍可能超出 5 000 次/小时的 token 预算；监视随后在共享的限流/凭据失败处中止回合（一次注定失败的调用，而非每 PR 一次）、下轮重试而非阻塞。通知轮询开销不变。绑定拉取失败时适配器记录日志并跳过监视回合（通知仍正常流动）。

## 关键决策

1. **prompt 注入，而非 channel 接管。** `activateManagedSession` 会把跟进会话的出站目标绑到 GitHub 线程，交互式会话的每条最终回复都会被发布为公开 PR 评论（publication contract）。注入让回复留在会话内，GitHub 动作交给会话自己的判断与工具。
2. **channel 内状态监视，而非 webhook。** 监视复用 channel 既有轮询循环与凭据；判定发生在 API 层，真实迁移出现前零模型 token。Webhook 推送需要公网隧道加在仓库建 webhook（需操作者同意），还要改造静态 webhook targets。监视本质仍是轮询，但它是维护者接受的 gate 探针形状：模型之外做廉价判定，有变化才动模型。
3. **反查放在 daemon。** 绑定跨 workspace；worker 是 workspace 作用域且已经通过鉴权 HTTP 与 daemon 通信。只读进程级路由复用刷新定时器的扫描模式，避免在 worker 里重复 sidecar 访问。
4. **单候选，取最近更新。** 广播到所有绑定会话会成倍放大模型成本并产生重复的 GitHub 动作；最新的非归档、非 channel 会话最可能持有工作上下文。
5. **候选排除 channel 会话。** 经 `/review` 回填绑定的 channel 自建会话必须保持公开回复契约；正常 channel 路径已经服务它。
6. **默认 opt-in。** 公开仓库事件驱动交互式会话是新的信任面；操作者显式开启，且评论的 sender gate 在投递前照常生效。
7. **唤醒休眠会话，而非回退。** E2E 发现 daemon 重启后绑定会话处于休眠态、prompt 路由 404；若把这当作「会话已消失」，重启后的所有事件都会静默改走公开 channel 投递——违背功能的核心私密投递承诺。因此访问器先恢复会话（channel bridge 已在用的同款 resume 路径）再重试一次；只有无法恢复的会话才回退。恢复铸造的 client 注册由访问器在重试 prompt 落定后显式 detach：非空注册会挡住 daemon 的 prompt-settled idle close，不 detach 就会把被唤醒的会话钉在 live 态直到 TTL reaper（reaper 禁用时则永久）。
8. **watch 事件私有-only。** 评论有既有的公开路径可回退；watch 事件没有。把 watch 事件回退到 channel 会话会把面向操作者的机器状态（「CI failed on head X. Inspect the failed checks…」）发布为公开 PR 评论，并被 sender allowlist 重新 gating。维护者决策（2026-11-02，解决 triage/验证升级）：没有绑定目标的 watch 事件记日志并退役，绝不发布。退役被显式呈现（stderr + 任务移除），不是静默丢弃。
9. **有界背压加死信呈现面。** 队满与暂不可用条件推迟事件而不消耗失败预算，但推迟视界有界（约 4 小时），且纯背压——bound 投递与不完整快照产生的无目标推迟——不持有共享通知游标：一个卡住的会话绝不能冻结所有无关 PR 的 mark-as-read，一个永久卡住的会话也绝不能永久楔住任务。耗尽视界或失败预算的事件退役到私有死信日志：私有路径不发公开错误评论，死信就是它的耗尽呈现面。死信写失败时保留任务而非移除。
10. **准入侧幂等，而非更大的受理窗口。** 持久化 `deliveredAt` 标记只能保护它落盘之后的崩溃；受理写本身可能失败（EIO），202 也可能丢失，而 daemon 对每个请求铸造新的 prompt id，重试因此会重复注入同一事件。把标记移到 POST 之前则是用静默丢失换重复。因此 POST 携带稳定的事件身份（源 chat + message id）作为 `idempotencyKey`——跨任务重建稳定，任务级键则做不到——prompt 路由按会话去重已受理的键（有界内存环，每会话 128 键、1024 会话，FIFO）：重试返回原受理结果而不排队。环的寿命与内存 prompt 队列相同——daemon 重启两者一起丢失，那里的重新注入正是正确的恢复。会话上限是唯一的例外：当超过 1024 个会话持有键时，键可能在其队列仍存活时被逐出，这种逐出之后的重试会重新注入。标记保留为快速路径：无需往返即退役任务。聚合评论批次的 message id 是排序后成员 id 的内容哈希（`agg:<sha256-40>`），而非首条评论：游标保存前崩溃可能重列出超集批次，首评论键会让 daemon 环把长大的批次去重到原受理上、静默丢弃新成员；相同批次仍跨受理崩溃窗口去重。游标的 `dispatchedComments` 环以**窗口感知逐出**支撑这一点：每个键携带其评论的 `created_at`（`dispatchedCommentTimes`，在 fetch 时捕获），超过软上限（500）后逐出只丢弃评论已不可再重列的键（`created_at <=` 已提交游标）——仍可重列的键（或无记录时间的 legacy 键）受保护，因此冻结游标无法把已回复评论滑出环、让重列超集以新哈希重新发布它。**刻意不设硬上限拒绝**：不冻结游标而拒绝派发会把被拒事件 mark-read（静默丢失），冻结游标又会死锁（环只有在游标推进后才能收缩）。代价是*持续* mark-read 故障会让保护环随重列窗口增长（受 流量 × 故障时长 界定）；mark-read 恢复后即收缩。恢复会重录仍挂起任务的键（恢复去重）；无捕获时间的重录保持受保护，即保守方向。辅助时间映射自身有界（`MAX_COMMENT_TIMES = 8192`，最旧非环条目优先丢弃，环键时间始终保留），并在每轮 mark-read 提交**之前** prune——因此零派发的冻结游标（sender 拒绝流、或 mark-read 本身失败）无法使其无界增长。publication audit 的消费判定按 source key 取最后一条 outcome：`posting` 之后的终态 `failed`（可证明未写入）让事件保持可重试，而歧义失败（`failed_ambiguous`——写入可能已落地）与无终态记录的 `posting`（发布中崩溃）按 at-most-once 消费，因为第二条公开回复不可逆；audit 不可读时冻结本轮游标，而不是把事件跳过 mark-read，且每个 dispatch lane 在记录 dedupe 键前都尊重该拒绝。冻结在 **dispatch 时**强制：只含 watch 任务的恢复回合两个公共存储都不读（watch 事件从不发布，既不会匹配 pending delivery 也不会匹配 audit 键），audit 不可读时私有 watch retire 仍能完成——下一个公共 dispatch 依旧拒绝并冻结。
11. **不完整扫描绝不确立缺席。** partial 绑定答案——尤其是重启后的空答案——不是 PR 未绑定的证据，而公开路由是不可逆的（游标在同一轮询提交）。因此冷启动门对空 partial 答案推迟有界轮数，且只要缺席不具权威，未匹配事件就逐事件推迟（可恢复，视界尽头死信）而非走公开路径——首个完整快照之前，以及对 PR 事件而言任何 partial 答案或刷新失败期间。partial 答案即使每个已观测绑定者都被列出并排除该 PR 也无法证明缺席：不可扫描的 workspace 可能持有从未被观测的跟随者，而被列出的 tombstone 只证明该被列出会话解绑（它仍立即停止私密投递与监视）。已知目标立即投递。issue 事件豁免 partial/失败子句：绑定仅针对 PR，冷启动门开启后 issue 的缺席可证。这些界限让永久降级的部署不至于冻结：车道在上限处开启，事件呈现在死信里而非消失。

## 影响文件

| 层           | 文件                                                                                                     | 改动                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core 类型    | `packages/core/src/services/session-pr-service.ts`                                                       | 新增 `readSessionPrsDetailed`（区分 sidecar 缺席与非法）；`readSessionPrs` 委托实现，契约不变                                                                     |
| daemon 路由  | `packages/cli/src/serve/routes/session-pr-bindings.ts`（新增）+ 注册                                     | `GET /sessions/pr-bindings` 扫描路由：空 prs tombstone、`prsReadFailed` → partial                                                                                 |
| daemon 投影  | `packages/cli/src/serve/server/session-list.ts`、`packages/acp-bridge/src/bridgeTypes.ts`                | sidecar 补全区分不可读 sidecar（`BridgeSessionSummary` 上的 `prsReadFailed`）与缺席                                                                               |
| daemon 路由  | `packages/cli/src/serve/routes/session.ts`                                                               | restore 路由：对永久性 workspace 缺席返回可区分的 `workspace_not_found` 404；prompt 路由：relay 标记限定的跨 workspace worker 授权 + 准入侧 `idempotencyKey` 去重 |
| daemon 准入  | `packages/cli/src/serve/channel-worker-prompt-authorization.ts`                                          | 进程级中继谓词 `isChannelWorkerPromptToken` + 跨 workspace 分类所需的显式 `CHANNEL_BOUND_RELAY_META_KEY` 意图标记                                                 |
| channel base | `packages/channels/base/src/ChannelBase.ts`、`types.ts`、`bound-session-delivery.ts`（新增）、`index.ts` | 可选 `boundSessions` 选项 + `PrBindingSummary` 类型 + 共享投递错误类（gone / queue-full / unavailable）                                                           |
| worker       | `packages/cli/src/commands/channel/daemon-worker.ts`                                                     | 用 SDK client 实现访问器                                                                                                                                          |
| 适配器       | `packages/channels/github/src/GithubAdapter.ts`、`index.ts`                                              | 配置字段、选择映射、投递拦截、状态监视、监视状态持久化                                                                                                            |
| 文档         | `docs/users/features/channels/github.md`、`docs/developers/qwen-serve-protocol.md`                       | 记录两个字段、事件语义、限制、两种停摆状态、restore 的 404/400 划分与 `idempotencyKey`                                                                            |
| web shell    | `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`、`client/i18n.tsx`               | 两个新描述符字段的标签/说明键（中英双语）                                                                                                                         |
| 测试         | 各改动文件的 collocated `.test.ts`                                                                       | 见验证                                                                                                                                                            |

## 约束与风险

- **不可信内容进入交互式会话。** 事件 payload 在注入 prompt 中标记为不可信（与 webhook 任务同一契约）。评论 sender gate 照常生效。状态事件没有人类发送者；它们存在仅因为操作者 opt-in，且私有-only（无公开回退）。目标会话自己的审批模式约束其动作。
- **进程级中继凭据（放宽的 worker 授权）。** 绑定投递跨 workspace，prompt 路由因此无法对 worker token 保持旧的 home===target 相等性。放宽被限定于其存在理由：跨 workspace 的 channel 分类除已注册 worker token 与 primary/受信目标外，还要求显式的 `qwen.daemon.channelBoundRelay` 标记；携带外部 worker token 的普通 prompt 不获得 channel 分类，也不获得调用方提供的展示投影。残余风险明说：标记是意图而非认证——持有 workspace B 的 worker token 者可以设置它并中继进受信的 workspace A，使该回合豁免 loop-detected 拒绝并提供其展示文本。安全边界仍是 token 持有加目标信任（与绑定路由枚举的信任模型相同）；一个同时服务内部交互 workspace 与「channel 摄入攻击者可控文本」workspace 的 daemon，把该 channel 的触手延伸进了受信 workspace 的会话。不能接受这一点的操作者不应在同一 daemon 上注册 channel worker，或应让摄入 workspace 保持 untrusted（untrusted 非 primary workspace 本就被绑定扫描与 relay 门同时排除）。
- **队列压力。** 事件突发可能填满目标会话的 5 槽 prompt 队列；队满与暂不可用条件按背压处理（不消耗重试预算），投递在后续轮询重试。推迟视界有界（`MAX_BOUND_DEFERRALS`，约 4 小时）；超出视界——或非背压失败耗尽 3 次上限——事件退役到私有死信日志并打 stderr 告警。纯 bound 背压不持有共享通知游标；其他可恢复任务仍然持有它（reconciliation 被阻塞期间的 watch 任务除外：它们无法推进，也不依赖通知游标）。bound 事件绝不静默消费：要么投递、要么推迟、要么死信。
- **速率限制。** 监视上限、条件化 check 拉取与有界的周期/pending 复查把稳态压在 5 000 次/小时的 token 预算之内（大 CI 突发可能超出；见 API 预算）。共享的凭据/限流失败（401/403/429）中止整个监视回合并记日志——一次注定失败的调用，而非每被监视 PR 一次——通知不受影响，而不是在通知车道之前睡完重置窗口。daemon 自身的 prompt 档 429 对投递是背压（推迟，绝不消耗失败预算）。
- **过期绑定。** 休眠的绑定会话由访问器唤醒（第 2 层），daemon 重启不会把事件改道公开 channel 投递；冷启动门在首个成功快照填充绑定映射之前推迟评论车道，空 partial 答案让它在有界轮数内保持关闭（关键决策 11）。只要缺席不具权威（尚无完整快照，或对 PR 事件而言任何 partial 答案或刷新失败），未匹配事件就可恢复地推迟而非公开路由。会话真正已删除的绑定唤醒失败 → 评论事件回退 channel 路径，watch 事件记日志退役；下一轮询的绑定拉取自愈映射。partial/失败扫描下评论回退按背压推迟，直到完整快照确立缺席——不可扫描的 workspace 可能仍持有从未被观测的跟随者，而公开回复不可逆。观测到的解绑（被扫描会话以空 PR 集列出）即使在 partial 答案下也停止私密投递与监视——tombstone 行使「已扫描、无绑定」与「未枚举」可区分——而该 PR 的公开路由仍等待完整快照。
- **已关闭的会话。** `DELETE /session/:id` 只关闭会话、不删除记录；记录仍可 resume 且绑定仍在，因此这类会话仍会被唤醒投递（E2E 已实证）。只有删除记录（`POST /sessions/delete`）或归档才会把会话移出候选集（归档会话的 restore 返回 409 `session_archived`，投递分类为 gone）。关闭是资源动作，不是退订；绑定本身表达跟随意图。
- **扫描成本。** 路由每次调用扫 sidecar；当前规模下是毫秒级。多页扫描标记 partial（活动序分页非快照隔离），使调用方保留已知绑定而非剪枝——这是刻意的保守取舍。若规模增长，快照一致枚举或用 `session_metadata_updated` 失效的内存索引是后续工作，不属于本改动。

## 验证计划

- **单测**：路由扫描（trusted/untrusted、归档排除、sidecar 损坏容忍）；适配器选择（主机过滤、状态过滤、channel-source 排除、更新时间 tie-break）；投递拦截（绑定 → 注入、未绑定 → channel 路径、404 回退、队满重试、恢复尊重持久化 delivery）；监视迁移（各事件类型、按 head 去重、null-mergeable 守卫、首次观测静默、先写状态再投递的顺序）；配置校验。
- **E2E**（daemon + 本地构建）：经 PATCH metadata 把 PR 绑定到会话；用 stub 的 GitHub API 层模拟事件；断言绑定会话每个迁移恰好收到一条注入 prompt、回复留在会话内、未绑定 PR 仍创建 channel 会话。计划详见 `.qwen/e2e-tests/github-channel-bound-session-events.md`。

## 验收标准

1. 两个字段开启后，绑定 PR 上的新评论以 prompt 形式进入绑定会话（而非 channel 会话），且会话回复不自动发布到 GitHub。
2. 绑定 PR head 的 CI 失败、`mergeable_state: dirty` 迁移、head 前进、合入/关闭，每个迁移实例恰好产生一条注入 prompt，daemon 重启后不重放；合法复发（dirty → clean → dirty、close → reopen → close、`head_change` 的 SHA 回访、新 head 失败）会再次触发，已 settled head 的 check 复跑变红由周期复查捕获。`ci_failure` 在 fired 环窗口内每个 head SHA 只触发一次——被回访的 SHA 的 CI 失败在该 head 的键仍留在环内时被抑制，回访本身由 `head_change` 承载。
3. 无绑定会话时，评论事件行为与今天完全一致（创建/复用 channel 会话，公开回复契约不变）；watch 事件记日志退役，绝不发布。
4. 字段关闭（默认）时，行为与 API 调用量不变。
5. 队满、限流（429）与暂不可用路径推迟事件、不丢失、不冻结共享游标；会话消失的评论路径无丢失回退；watch 路径私密退役；耗尽事件进死信（死信写失败时保留任务）；任何崩溃窗口都不重放已受理的注入——受理标记丢失或 202 丢失后的重试携带相同幂等键、去重为原受理结果——也不静默消费迁移；空 partial 冷启动快照绝不公开路由事件，观测到的解绑即使在 partial 答案下也停止私密投递。

## 开放问题

无。Webhook 推送投递与内存绑定索引记录为后续工作，不构成阻塞。
