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
→ { "bindings": [ { sessionId, workspaceCwd, sourceType, sourceId, updatedAt, prs: [{number, url, state?}] } ], "partial": false }
```

- 所有权类别：**进程级**（与 `POST /sessions/backfill-prs` 同类）。遍历 registry 中的 trusted workspace runtime，经 live-merged 会话列表路径（`listWorkspaceSessionsForResponse`，它会用 PR sidecar 补全会话摘要）枚举 active 会话，分页有上限。Untrusted workspace 跳过。
- 排除归档会话。携带 `sourceType`/`sourceId` 以便调用方排除 channel 自有会话。`prs` 条目投影为 `{number, url, state?}`。
- **`partial`** 在答案不完整时为 true：某个 workspace 列表失败、某页报告截断、或页数上限耗尽仍有游标。调用方绝不能把 partial 答案中缺失的条目当作权威性的「不存在」（适配器在 partial 快照下跳过监视状态剪枝）。
- 与其他会话路由一样鉴权（`--require-auth` 时 bearer）。不新增写入面。
- 该路由是扫描而非索引：以 sidecar 体系的规模（每 workspace 几十个会话），每次轮询扫一遍可以接受；适配器将结果缓存一个轮询周期。

### 第 2 层 —— worker 提供的投递访问器

`ChannelBaseOptions`（`packages/channels/base/src/ChannelBase.ts`）增加一个可选字段；`ChannelAgentBridge` 契约不变：

```ts
boundSessions?: {
  listPrBindings(): Promise<{ bindings: PrBindingSummary[]; partial: boolean }>;
  deliverPrompt(sessionId: string, prompt: string): Promise<void>;
};
```

- daemon channel worker（`packages/cli/src/commands/channel/daemon-worker.ts`）用它已持有的 SDK client 实现：`listPrBindings` 调新路由，并从每次完整答案重建 session→cwd 缓存（离开绑定的会话随之掉出）；`deliverPrompt` 以 text content block 投递 prompt，进入 FIFO 队列即算投递成功——worker 不等待目标会话的回合结束。
- **休眠唤醒**：绑定路由列出的是持久化的 active 会话，但 prompt 路由只服务 live 会话；daemon 重启后绑定会话处于休眠态，prompt 会 404。访问器遇 404 时经 channel bridge 同款 resume 路径恢复该会话（workspace cwd 取自缓存的绑定，未知时先刷新一次），再重试一次 prompt。恢复出的 client 直接丢弃：已受理的 prompt 会在回合期间持有会话，回合结束后 daemon 的 idle 清扫使其回到休眠。
- **唤醒错误分类**：只有 404 恢复失败（会话记录真正不存在）才成为 `BoundSessionGoneError`。恢复冲突、会话数上限、超时、绑定刷新失败都作为瞬时错误传播，让适配器重试，而不是降级成公开 channel 投递。
- `deliverPrompt` 把唤醒后仍 404（会话已不存在）与 503 `prompt_queue_full` 作为可区分的错误抛出，供适配器回退或重试。
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

开启 `deliverToBoundSessions` 时，适配器在每次轮询开始拉取 `GET /sessions/pr-bindings`，构建 `owner/repo#number → session` 映射。键的两侧都对 repo 路径小写归一：GitHub URL 大小写不敏感（core 的 `canonicalSessionPrUrl` 即小写化），绑定 URL 可能带任意大小写，而通知 subject URL 带规范大小写。绑定 URL 解析容忍尾部 tab 段（`/files`、`/commits`、`/checks`），因为绑定路由接受任何命名该 PR 的 http(s) URL。

- 只保留 PR URL 主机与 channel 的 GitHub 主机一致的绑定（Aone 等其他 provider 的绑定忽略）。
- 监视集合只保留记录 `state` 非 `merged`/`closed` 的条目；评论事件的投递候选接受任意记录状态（刚合入的 PR 上的评论仍应投递，绑定状态由刷新定时器追平）。
- 排除 `sourceType === 'channel'` 的会话——channel 会话走正常 channel 路径，以保留其公开回复契约。
- 多个候选：取最近更新的会话（`updatedAt` 降序；live 摘要缺 `updatedAt` 时路由回退到 `createdAt`，新建的 live 会话因此不会被过期的持久化会话压过）。确定性选择，不广播。
- 刷新失败保留旧映射（过期候选在投递时失败并回退）；该轮询跳过监视回合，瞬态失败因此无法剪掉持久化基线。`partial` 快照保留映射但禁用监视状态剪枝。

#### 评论投递拦截

`dispatchEnvelope` 是已接受评论/正文/review/assign 事件的唯一漏斗。在认领 inbound task 之前查询绑定会话映射：

- **找到绑定会话** → 持久化的 `InboundTaskRecord` 增加 `delivery: { kind: 'bound-session', sessionId }`。`runInboundTask` 经 `boundSessions.deliverPrompt` 投递事件 prompt，而非 `handleInbound`。由于绕过了 `handleInbound`，bound 路径在投递前执行同一套 `preflightInbound`（group policy、sender gate、pairing——含副作用）；watch 事件豁免（无人类发送者、操作者 opt-in）。去重 key、游标语义、可恢复任务机制不变——只有最终投递不同。
- **无绑定会话** → 今天的路径（`handleInbound` → channel 会话）。
- **投递失败**：404 → 访问器先尝试休眠唤醒（第 2 层）；只有无法恢复的会话才视为消失，适配器随后重新拉取绑定再解析一次；解析到不同候选则改投，无候选 → 本事件回退到 `handleInbound`。503 队满是背压而非失败：不消耗重试预算，busy 会话因此推迟事件而不是在 `MAX_INBOUND_TASK_ATTEMPTS = 3` 后丢失它。其他瞬时错误按该上限重投；任务可恢复期间游标不前进。重启后的恢复尊重持久化的 `delivery` 字段。

注入的 prompt 复用 webhook 任务的 prompt 形状（`buildChannelWebhookPrompt` 风格）：事件头、显式的「不可信事件数据」警告、PR 身份（repo、number、标题、URL）、该 lane 的 `Trigger:`/`Event:` 行及 direct lane 的事实性 `Author:` 详情、评论作者/正文或事件详情，以及「回复留在本会话」的指引（该会话不受 channel publication contract 约束；如需在 GitHub 上动作，用它自己的常规工具）。面向 channel 的发布措辞绝不进入绑定会话：metadata 里的 publication instructions 被丢弃，聚合 lane 的「output exactly `<no-reply/>`」前缀被替换为普通的「New comments on the PR」头。

#### PR 状态监视

`prWatchEvents` 非空时，`pollOnce` 在通知处理之后运行监视回合：

1. **监视集合**：来自同一次绑定拉取的绑定 PR，过滤为记录状态 open 且主机匹配 channel 的 GitHub 主机，上限 30 个（按绑定更新时间取最新）。无绑定 PR → 零 API 调用。持久化条目按完整候选集剪枝（而非截断后的监视集，轮转出上限的 PR 因此保留基线），且仅在快照完整时剪枝——partial 快照绝不剪枝。
2. **每 PR**：每次轮询调 `pulls.get`（head SHA、`mergeable`、`mergeable_state`、`state`、`updated_at`）。Check runs（`checks.listForRef`）与组合提交状态（`repos.getCombinedStatusForRef`）仅在以下情况拉取：head SHA 较上次轮询变化、上次 CI 聚合为 pending/in_progress、尚无 CI 观测、PR 的 `updated_at` 前进（任何线程活动——包括 check 复跑——都会 bump 它，因此已绿 head 后来变红仍能被捕获）、或聚合为 `none` 且处于 head 首次观测后的 10 分钟宽限窗口内（check 异步注册；窗口外 `none` 表示仓库无 CI，视为已 settled）。稳态成本为每 PR 每轮询一次调用。
3. **迁移检测**：对照持久化监视状态（`channelFilePath('github-pr-watch.json')`，按监视集合裁剪）：
   - `ci_failure`：聚合转为失败（任一已完成 check run 结论为 `failure`/`timed_out`/`action_required`，或组合状态为 `failure`/`error`）。每个 head SHA 触发一次；新 head 再失败会再触发。事件摘要点名失败的 check（至多 5 个），会话无需再查即可行动。
   - `merge_conflict`：`mergeable_state` 进入 `dirty`。边沿触发；`dirty → clean → dirty` 会再次触发。`mergeable === null`（GitHub 仍在计算）绝不覆盖最后已知状态。
   - `head_change`：head SHA 与上次观测不同（首次观测静默初始化）。
   - `state_change`：PR `state` 离开 `open`（merged 或 closed）。首次观测静默初始化。
4. **先写状态再投递**：新监视状态在认领事件任务之前持久化，崩溃不会重放同一迁移；认领的 inbound task（`delivery` 在认领时解析）负责重试。事件任务使用 `source.messageId = watch:<eventType>:<headSha|state>`，走与评论相同的「绑定会话或回退」投递。
5. **绑定状态维护**仍由既有 5 分钟刷新定时器负责；适配器不 PATCH metadata。定时器记录 `merged`/`closed` 后，该 PR 离开监视集合。

#### API 预算

默认 60 秒轮询、上限 30 个被监视 PR：稳态 ≤ 1 800 次/小时；CI 活跃期每个受影响 PR 每轮询至多增加 2 次调用。通知轮询开销不变。绑定拉取失败时适配器记录日志并跳过监视回合（通知仍正常流动）。

## 关键决策

1. **prompt 注入，而非 channel 接管。** `activateManagedSession` 会把跟进会话的出站目标绑到 GitHub 线程，交互式会话的每条最终回复都会被发布为公开 PR 评论（publication contract）。注入让回复留在会话内，GitHub 动作交给会话自己的判断与工具。
2. **channel 内状态监视，而非 webhook。** 监视复用 channel 既有轮询循环与凭据；判定发生在 API 层，真实迁移出现前零模型 token。Webhook 推送需要公网隧道加在仓库建 webhook（需操作者同意），还要改造静态 webhook targets。监视本质仍是轮询，但它是维护者接受的 gate 探针形状：模型之外做廉价判定，有变化才动模型。
3. **反查放在 daemon。** 绑定跨 workspace；worker 是 workspace 作用域且已经通过鉴权 HTTP 与 daemon 通信。只读进程级路由复用刷新定时器的扫描模式，避免在 worker 里重复 sidecar 访问。
4. **单候选，取最近更新。** 广播到所有绑定会话会成倍放大模型成本并产生重复的 GitHub 动作；最新的非归档、非 channel 会话最可能持有工作上下文。
5. **候选排除 channel 会话。** 经 `/review` 回填绑定的 channel 自建会话必须保持公开回复契约；正常 channel 路径已经服务它。
6. **默认 opt-in。** 公开仓库事件驱动交互式会话是新的信任面；操作者显式开启，且评论的 sender gate 在投递前照常生效。
7. **唤醒休眠会话，而非回退。** E2E 发现 daemon 重启后绑定会话处于休眠态、prompt 路由 404；若把这当作「会话已消失」，重启后的所有事件都会静默改走公开 channel 投递——违背功能的核心私密投递承诺。因此访问器先恢复会话（channel bridge 已在用的同款 resume 路径）再重试一次；只有无法恢复的会话才回退。唤醒注册的是临时 client，daemon 的 client-close 清扫会在回合结束后回收，会话不会被永久钉在 live 态。

## 影响文件

| 层           | 文件                                                                 | 改动                                                   |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------ |
| core 类型    | `packages/core/src/services/session-pr-service.ts`                   | 无（原样复用）                                         |
| daemon 路由  | `packages/cli/src/serve/routes/session-pr-bindings.ts`（新增）+ 注册 | `GET /sessions/pr-bindings` 扫描路由                   |
| channel base | `packages/channels/base/src/ChannelBase.ts`、`types.ts`              | 可选 `boundSessions` 选项 + `PrBindingSummary` 类型    |
| worker       | `packages/cli/src/commands/channel/daemon-worker.ts`                 | 用 SDK client 实现访问器                               |
| 适配器       | `packages/channels/github/src/GithubAdapter.ts`、`index.ts`          | 配置字段、选择映射、投递拦截、状态监视、监视状态持久化 |
| 文档         | `docs/users/features/channels/github.md`                             | 记录两个字段、事件语义、限制                           |
| 测试         | 各改动文件的 collocated `.test.ts`                                   | 见验证                                                 |

## 约束与风险

- **不可信内容进入交互式会话。** 事件 payload 在注入 prompt 中标记为不可信（与 webhook 任务同一契约）。评论 sender gate 照常生效。状态事件没有人类发送者；它们存在仅因为操作者 opt-in。目标会话自己的审批模式约束其动作。
- **队列压力。** 事件突发可能填满目标会话的 5 槽 prompt 队列；队满按背压处理（不消耗重试预算），投递在后续轮询重试，游标保持。bound 事件在任务可恢复期间绝不静默丢失；只有非背压失败会耗尽 3 次上限，并记录终态错误日志。
- **速率限制。** 监视上限与条件化 check 拉取把稳态压在 5 000 次/小时的 token 预算之内；被限流的监视回合记日志跳过，通知不受影响。
- **过期绑定。** 休眠的绑定会话由访问器唤醒（第 2 层），daemon 重启不会把事件改道公开 channel 投递。会话真正已删除的绑定唤醒失败 → 回退 channel 路径；下一轮询的绑定拉取自愈映射。
- **已关闭的会话。** `DELETE /session/:id` 只关闭会话、不删除记录；记录仍可 resume 且绑定仍在，因此这类会话仍会被唤醒投递（E2E 已实证）。只有删除记录（`POST /sessions/delete`）或归档才会把会话移出候选集。关闭是资源动作，不是退订；绑定本身表达跟随意图。
- **扫描成本。** 路由每次调用扫 sidecar；当前规模下是毫秒级。若规模增长，用 `session_metadata_updated` 失效的内存索引是后续工作，不属于本改动。

## 验证计划

- **单测**：路由扫描（trusted/untrusted、归档排除、sidecar 损坏容忍）；适配器选择（主机过滤、状态过滤、channel-source 排除、更新时间 tie-break）；投递拦截（绑定 → 注入、未绑定 → channel 路径、404 回退、队满重试、恢复尊重持久化 delivery）；监视迁移（各事件类型、按 head 去重、null-mergeable 守卫、首次观测静默、先写状态再投递的顺序）；配置校验。
- **E2E**（daemon + 本地构建）：经 PATCH metadata 把 PR 绑定到会话；用 stub 的 GitHub API 层模拟事件；断言绑定会话每个迁移恰好收到一条注入 prompt、回复留在会话内、未绑定 PR 仍创建 channel 会话。计划详见 `.qwen/e2e-tests/github-channel-bound-session-events.md`。

## 验收标准

1. 两个字段开启后，绑定 PR 上的新评论以 prompt 形式进入绑定会话（而非 channel 会话），且会话回复不自动发布到 GitHub。
2. 绑定 PR head 的 CI 失败、`mergeable_state: dirty` 迁移、head 前进、合入/关闭，每个迁移恰好产生一条注入 prompt，daemon 重启后不重放。
3. 无绑定会话时，每类事件行为与今天完全一致（创建/复用 channel 会话，公开回复契约不变）。
4. 字段关闭（默认）时，行为与 API 调用量不变。
5. 队满与会话消失路径重试或回退，不丢失、不重复事件。

## 开放问题

无。Webhook 推送投递与内存绑定索引记录为后续工作，不构成阻塞。
