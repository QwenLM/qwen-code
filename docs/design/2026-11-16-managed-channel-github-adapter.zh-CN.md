# Managed channel 第三个 adapter：GitHub（H5f）

[English](2026-11-16-managed-channel-github-adapter.md) | [简体中文](2026-11-16-managed-channel-github-adapter.zh-CN.md)

状态：proposed。本切片是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)
**H5** 阶段的第三个 adapter，继 email 参考切片（H5b/H5c）与 DingTalk 第二
adapter（H5d，[设计文档](2026-11-13-managed-channel-dingtalk-adapter.zh-CN.md)）
之后。原始 [managed-channels 设计](2026-10-04-managed-channels.zh-CN.md)明确把
GitHub 推迟到「后续 adapter 切片」；本文兑现该切片。首版产品范围由产品负责人于
2026-11-16 拍板：**仅 @mention 评论入站、不做 PR watch、仅 token 认证**。

## 问题

managed channel 路径目前服务 email 与 DingTalk。GitHub 会话（issue 与 PR 评论
线程）是编码 agent 的主要工作面，但今天 GitHub channel 只跑在 Legacy daemon
路径上（`packages/channels/github/src/GithubAdapter.ts`），由 adapter 自持会话
路由、任务执行与发布审计。Managed Agent 部署无法把 GitHub mention 准入控制面
Session，也无法把带回执的回复投回线程。

## 现状（哪些已经通用）

已在当前工作树逐条核实；控制面 provider 无关，因此本切片是 **Java 零改动**的
TypeScript 切片：

- Java 侧 `ChannelPolicy.adapter` 按正则 `[a-z][a-z0-9-]{0,63}` 校验，
  `RegisterChannelRequest.platform` 是有界字符串（`ChannelAdapterModels.java`），
  两者都不枚举 provider。`ma_channel_instance.platform` 列无 CHECK 约束。
  reply context 是 adapter 不透明 JSON：Java 只做透传（`ManagedChannelService`
  的入站转发与 claim 回传），唯一解析者是 adapter 自己。
- 启用门在 TypeScript core：`MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS`
  （`packages/core/src/managed-runtime/managed-session-records.ts`），authority
  在**每个** `channel_route` 修订上行使。
- 共享 adapter 契约（`ManagedChannelPolicy`、`ManagedChannelControlPlane`、
  `ManagedInboundEvent`、`ManagedClaimedDelivery`、`ManagedReceipt`、
  `MANAGED_OUTBOUND_LIMIT`、`validManagedReceipt`）住在
  `packages/channels/base/src/managed-channel.ts`；联合类型为
  `'email' | 'dingtalk'`。
- CLI 命令壳已共享：`createManagedChannelCommand`
  （`packages/cli/src/commands/channel/managed-channel-command.ts`）持有参数面、
  `HttpManagedChannelControlPlane` 接线与 connect → 等信号 → disconnect 生命
  周期；每个 provider 只供 adapter 工厂。HTTP 客户端 provider 无关。
- 多段生产者按每段 48 KiB **UTF-8 字节**、1–64 段切分（`planChannelSegments`，
  `packages/core/src/managed-runtime/managed-channel-operations.ts`）。48 KiB
  UTF-8 段至多 49,152 字符，低于 GitHub 评论正文 65,536 字符上限——一个台账段
  映射一条 GitHub 评论，无需 provider 侧再切块。
- GitHub 包已依赖 `@octokit/rest`、`@qwen-code/channel-base` 与
  `https-proxy-agent`；Legacy adapter 提供 provider 机制（notifications 轮询、
  mention 检测、`extractFromSubjectUrl`、`issues.createComment`），但不复用其类。
- OpenAPI `PublicChannel.platform` 是无枚举字符串；channel 契约测试钉 wire 形状
  而非 platform 值；Web Shell 生成类型不含 channel 路由（`Public Resources`
  tag）。契约、surface-capture 与生成类型门禁均不动。

## 决策

在 email 与 DingTalk 旁新增 managed GitHub adapter，沿用 DingTalk 纪律：
deps 注入、绝不驱动模型、每个 claim 先持久化再产生副作用、重启重放而非重发。

### 契约与启用

- `channel-base` 的 `ManagedChannelAdapter` 扩为
  `'email' | 'dingtalk' | 'github'`；命令 spec 的 `adapterType` 联合同步。
- `MANAGED_SESSION_ENABLED_CHANNEL_ADAPTERS` 加 `'github'`；同步钉死列表的
  测试。Java 正则已放行该名字。

### 身份、scope 与 policy

- **认证仅 token。**`token` 必填（secret 配置字段，凭据规则镜像 DingTalk：
  非空、拒绝 CR/LF/NUL）。managed 路径拒绝 `useLocalGh`：gh CLI 登录态是机器级
  身份，不属于租户化部署。`baseUrl` 保持可配（GitHub Enterprise 与封闭 mock
  端点；默认 `https://api.github.com`）。
- **账号身份**是 connect 时 `GET /user` 解析的 bot login；`accountGeneration`
  初值 1，无 epoch 事件（与 DingTalk 相同）。换 token 到不同 login 会以控制面
  `channel_identity_conflict` 注册拒绝可见地 surfaced。
- **Scope** 为 `chat_thread`：`chatId = owner/repo`（小写），
  `threadId = "issue:N" | "pr:N"`，与 Legacy adapter 相同地从 notification
  subject URL 提取。一个 repo + issue/PR 号 = 一条路由 = 一个 Session。
- **Policy** 是 email 形状的平铺 `senderPolicy`（allowlist / open / disabled，
  默认 allowlist），作用于小写 GitHub login；`allowedUsers` 是 allowlist 来源，
  `dispatchMode` 来自配置（默认 `followup`）。`pairing` 显式拒绝，镜像
  DingTalk。Legacy 的 per-repo `groups` 映射不搬；可选 `repoFilter` allowlist
  （小写 `owner/repo` 条目）过滤哪些仓库可准入事件。allowlist 必须非空且
  每个条目符合 Legacy 的 `owner/repo` 形状——空表或畸形表会在报告 running
  的同时静默丢弃全部事件。携带 `repoFilter` 且 Legacy `repoFilterMode` 为
  `blocklist` 或 `off` 的配置被拒绝而非重解释：把屏蔽名单读成 allowlist
  会让 bot 只在操作者声明屏蔽的仓库回复。sender 门在 adapter 侧执行，与
  email 的 `senderAllowed` 同层。
- **轮询下限。** 轮询间隔尊重 GitHub 的 `X-Poll-Interval` 与限流等待提示
  （`retry-after`、`x-ratelimit-reset`），并封顶于 Node 的 32 位定时器上限
  ——即 Legacy 的 `MAX_TIMER_DELAY_MS` 守卫。超过 2^31-1 ms 的无帽提示会被
  Node 钳成约 1 ms，把限流冷却变成立即重试风暴。

### 入站管线（仅 mention）

一个 poll tick：

1. 先重驱已持久化的 pending 事件（崩溃恢复，见下）。
2. 列举 notifications（`GET /notifications`，分页，`since` = 游标水位回退
   一秒；全新启动后的首轮用 connect 时刻——不追历史积压）。只保留
   `reason === "mention"`、subject 为 Issue/PullRequest 且 repo 通过
   `repoFilter` 的通知。
3. 对每个保留线程列举窗口内的会话评论
   （`GET /repos/{owner}/{repo}/issues/{n}/comments`）。保留 mention 到 bot
   login（复用 Legacy `mention.ts` 检测器）、非 bot 自发、不在 dispatched 环、
   且作者通过 sender policy 的评论。
4. 把结果事件 stage 为 pending，**先于任何副作用**（持久化）。
5. 逐条提交 pending；准入或重放成功后把评论键记入 dispatched 环并移出
   pending（持久化）。
6. 一个通知线程的全部事件提交后**且**其评论收集完整完成，才 mark read。
   被 32 条 claim 上限截断的收集留有未收集评论：该线程保持未读、窗口冻结，
   下轮收集剩余部分，而不是消费一个 mention 从未 stage 的通知。
7. 窗口内线程全部 mark read 后才推进游标水位（持久化）。mark-read 失败冻结
   窗口；下轮重列，去重吸收重叠。不可解析的 `updated_at` 同样冻结窗口：
   持久化它会让后续每个 tick 的 `since` 计算抛 RangeError、重启时 `load()`
   拒绝，而出站继续运行。

事件映射：

- `platformEventId = "github:" + comment.node_id`；响应无 `node_id` 时兜底
  `"github:" + chatId + "/" + threadId + "/" + comment.id`：数字 id 只在
  仓库内唯一，兜底键按线程作用域化——两个仓库的 #555 评论是两个事件，
  不会被幂等吞成一个。跨重投与评论编辑稳定。一条评论一个事件；编辑不
  重新准入（Legacy 的 edited-mention journal 是 daemon 面，不在本范围）。
- `senderId = user.login` 小写；`subject = notification.subject.title` 钳到
  wire 的 200 字符界；`text = 评论正文`逐字，套用 DingTalk 形状的
  `fitInboundText`（≤ 32,000 UTF-16 单元、尾部高代理项回退，加 64 KiB
  JSON 序列化信封按码点边界切）。GitHub 正文可达 65,536 字符，超长评论截断
  准入而非整条拒绝。钳制抄 DingTalk adapter，不是 email 的裸 UTF-8 预算。
- `attachments: []`——GitHub user-attachment staging 是后续项。
- `replyContext = { owner, repo, issueNumber }`——adapter 不透明，随输入提交、
  claim 时回传；含 `issues.createComment` 所需全部字段。

### pending claim 持久化完整事件

承重的入站决策，按 H5d 规则：notifications 是 **ack-once**——mark read 后线程
离开未读列表，重启无法重列。评论正文虽可按 id 重取，但准入后可能已被编辑或
删除；重驱必须重放「同一被准入事件」，而非重建物。因此 pending 持久化完整
`ManagedInboundEvent`（DingTalk 形状），受 32 条在途入站配额约束。状态文件
不含 bearer capability（token 留在 settings），0600/0700 纪律保护的是平台
数据。

对重复列举的正确性不依赖 dispatched 环：控制面 `platformEventId` 幂等对任何
重提交回放同一 `inputId`。环（有界、尾截断）只是省工过滤器；Legacy 的秒边界
`boundaryComments` 机制不需要——重列的同秒评论是幂等重放，不是第二个输入。

### 出站投递与回执

纪律与 email/DingTalk 完全一致：每 tick claim ≤ 16 个 delivery（512 KiB claim
预算，回执后 re-claim），按 ordinal 序逐段发送，发送结果先持久化再上报回执，
任何非 accepted 段停掉该 delivery 余段。

- 一段 = 一条 `POST /repos/{owner}/{repo}/issues/{issueNumber}/comments`
  （PR 也回会话评论，从不回 inline review comment——Legacy 的发送原语）。
  无 provider 侧切块：生产者 48 KiB 字节界低于 GitHub 评论上限。
- `providerMessageId = String(comment.id)`——GitHub 返回真实平台 id，回执强于
  email 的自铸 Message-ID 与 DingTalk 的 UUID。
- deps 内失败分类：可证明未写入的确定性拒绝（401/403 权限、404、422 校验）→
  `rejected`；限流响应、5xx 与网络含糊 → `unknown`（租约到期由 reconciler
  结算；显式 resend 仍是操作者的防重复路径）。限流发送可证明未写入但属瞬态，
  故沿 DingTalk 的 transient→unknown 规则而非终结回复。
- 重启：`reportOrphanedOutbound` 重放已持久化回执，无回执的报 `unknown`——
  绝不二次发送。
- Legacy 的 `<no-reply/>` 哨兵与 eyes reaction 确认不搬：教会哨兵的
  publication-policy 提示词是 Legacy adapter 注入，managed Session 的指令来自
  部署的工作区上下文。

### 状态与所有权

- 状态目录：
  `~/.qwen/channels/<workspace-scope>/github-<sha256(name\0baseUrl)[:16]>/managed-state.json`，
  0700/0600，临时文件 + fsync + rename 原子写。凭据绝不定义身份。
- 内容：`version`、`generation`、`instanceRefusals`、游标（`lastProcessedAt`、
  dispatched 评论环）、`pending`（完整事件，≤ 32）、`outbound`（段台账，
  ≤ 64，回执用共享 `validManagedReceipt` 校验）。校验器对水位做日期解析：
  非日期字符串在 `load()` 即 fail-closed 拒绝，而不是在 connect 报告 running
  后让每个 tick 抛 RangeError 停摆（Legacy 游标校验器同样解析该字段）。
- 锁仲裁同 name + endpoint 的 managed 实例。不与 Legacy channel 交叉锁：同一
  token 同时跑 Legacy 与 managed adapter 会竞抢 notification mark-read、互偷
  事件；操作者必须保证每个 bot 身份恰一个消费者。
- registration-refusal 重注册、instance-scoped 拒绝停摆（第一条当 poison 丢弃，
  连续第二条 hold claim 作探针；只有新鲜准入才复位）、ownership-loss 写拒绝、
  持锁 disconnect 顺序，全部镜像 DingTalk adapter。

### 命令

`managed-github` CLI 命令经 `createManagedChannelCommand` 把 adapter 接到
`HttpManagedChannelControlPlane`，镜像 `managed-dingtalk`（含出口代理解析）。
它是实验性、显式选择的入口：`qwen channel start` 永不选它，它不驱动模型。

出口代理被**应用**而不只是解析：`@octokit/request` v9 是 fetch 时代产物，
从不读 Legacy 的 `request.agent` 选项（Legacy channel 能用，仅因其启动器
安装了进程级 undici dispatcher）。因此 deps 构造每客户端一个
`undici.EnvHttpProxyAgent`，走被尊重的 `request.fetch` 钩子，并在
`disconnect()` 时销毁。代理范围仅限 GitHub 流量；控制面 HTTP 保持直连——
与 DingTalk deps 的决定一致。代理遍历见证证明请求经代理隧道转发（代理的
CONNECT 日志点名目标 authority；直连请求会留下空日志）。

## 涉及文件

- `packages/channels/base/src/managed-channel.ts`——联合扩为三 provider；
  同址契约测试更新。
- `packages/core/src/managed-runtime/managed-session-records.ts`——启用列表加
  `'github'`；`managed-channel-record.test.ts` 钉子更新。
- `packages/cli/src/commands/channel/managed-channel-command.ts`——
  `adapterType` 联合扩展；命令矩阵与 required-flag 测试加 `managed-github` 行。
- `packages/cli/src/commands/channel/managed-github.ts`（新）与
  `packages/cli/src/commands/channel.ts`——命令及注册。
- `packages/channels/github/src/managed-github-adapter.ts`、
  `managed-github-deps.ts`、`managed-state.ts`（新）——adapter、生产 deps
  （Octokit 装配、代理、重试/退避、失败分类）与持久化状态；从包 index 导出；
  各自同址测试。
- 本设计文档及其中文版。
- Java、schema、OpenAPI、surface-capture、Web Shell 生成类型均零改动。

## 范围边界

- 不动段台账、claim 预算、receipt write-once 规则、partial/unknown 恢复与
  ingress 幂等身份。
- 不做 PR watch 事件（CI 失败、合并冲突、head/state 变化）、bound-session
  投递、pairing、per-repo sender 列表、附件 staging、inline review comment
  回复、仅 issue 正文的 mention（正文 mention 而无评论时不准入任何事件）、
  首启历史积压、`<no-reply/>` 哨兵、reaction 确认。每项都是点名的后续项，
  不是静默缺口。
- Legacy `GithubChannel` 不变；managed adapter 复用 provider 机制（mention
  检测、subject-URL 提取），不复用 Legacy 类。
- Java 控制面零改动；实现中发现的任何 provider 特定需求先点名再加。

## 验证计划

- 契约见证：扩展后的联合接受 `github` 且仍接受 `email`/`dingtalk`；启用门放行
  `github` 且仍拒绝未知 adapter；email 与 DingTalk 套件原样保持绿。
- adapter 见证（deps 注入，不碰真实 GitHub）：mention 评论恰准入一次、重列
  通知重放；超长文本截断到 wire 界而非丢弃；非 mention reason、bot 自发评论、
  被过滤仓库与被拒 sender 均不准入；多段 claim 按序逐段发评论并按 ordinal
  回执真实评论 id；确定性拒绝回执 `rejected` 并停余段；含糊失败回执
  `unknown`、绝不二发；重启重放已持久化回执；stage 与 submit 之间崩溃后
  pending 重驱；mark-read 仅在准入后发生、mark-read 失败冻结水位；收集被
  claim 上限截断的线程即使其已 stage 的 claim 同 tick 全部结算也绝不
  mark read；instance-scoped 停摆、registration-refusal 重注册、
  ownership-loss 拒绝各自红其用例。
- deps 见证对本地 fake GitHub HTTP 端点（真实 Octokit）：分页、`since` 窗口、
  失败分类（401/404/422 确定性，限流/5xx/网络含糊）、代理遍历（CONNECT
  隧道经代理转发）与 disconnect 时 dispatcher 销毁。
- 真实控制面链路（对运行中的 Java server 走 register → inbound → Session
  轮次 → claim → receipt）与 GitHub fault-gate driver 变体是后续项，不是合并
  门，镜像 DingTalk 切片的 live-tenant smoke 姿态。

## 决策（proposed）

1. 仅 token 认证；managed 路径拒绝 `useLocalGh`。
2. 仅 mention（`reason === "mention"`）、仅会话评论；issue 正文 mention 与
   inline review comment 是后续项。
3. pending 持久化完整入站事件（ack-once mark-read），DingTalk 形状；
   dispatched 环是控制面幂等之上的优化，不是正确性边界。
4. 一段 = 一条评论；`providerMessageId` 是真实评论 id；限流是瞬态
   （`unknown`）而非终态。
5. 平铺 sender policy 加可选 repo allowlist（非空、Legacy `owner/repo` 形状；
   Legacy `blocklist`/`off` mode 配置拒绝而非重解释）；拒绝 pairing；v1 无
   哨兵与 reaction 面。
