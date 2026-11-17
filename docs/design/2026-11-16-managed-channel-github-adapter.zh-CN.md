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
  端点；默认 `https://api.github.com`）。它必须是带 host 的绝对 `http(s)`
  URL——裸 `host:port/path` 会被解析成带畸形 scheme、空 host 的 URL，从而
  静默指向虚无——并归一化为 `origin + pathname`、剥掉尾部斜杠，使仅大小写
  或尾斜杠不同的端点写法键控同一状态目录。
- **账号身份**是 connect 时 `GET /user` 解析的 bot login；`accountGeneration`
  初值 1，无 epoch 事件（与 DingTalk 相同）。换 token 到不同 login 会以控制面
  `channel_identity_conflict` 注册拒绝可见地 surfaced。
- **Scope** 为 `chat_thread`：`chatId = owner/repo`（小写），
  `threadId = "issue:N" | "pr:N"`，与 Legacy adapter 相同地从 notification
  subject URL 提取。一个 repo + issue/PR 号 = 一条路由 = 一个 Session。
- **Policy** 是 email 形状的平铺 `senderPolicy`（allowlist / open / disabled，
  默认 allowlist），作用于小写 GitHub login；`allowedUsers` 是 allowlist 来源，
  `dispatchMode` 来自配置（默认 `followup`）。解析出的 policy 来自
  `resolvePrivatePolicy`（`privatePolicy`，否则 `disabled` 的 `dmPolicy`，
  否则 `senderPolicy`，否则 allowlist）。`pairing` 显式拒绝——无论拼作
  `groupPolicy` 还是从 `privatePolicy` 解析而来——因为 managed 形状没有
  pairing 分支，把它强转成空 allowlist 会在报告 running 的同时跳过全部评论。
  Legacy 的 per-repo `groups` 映射不搬：非空 `groups` 对象被拒绝而非静默丢弃，
  因为丢弃它会准入操作者排除的 sender（或丢掉其放行的 sender）。
- **`groupPolicy` 被尊重而非忽略。** 插件自身 schema 把 `groupPolicy` 文档化
  为 GitHub 准入门。当两个 managed 拼写（`privatePolicy` / `senderPolicy`）
  都缺失时，主动的 `groupPolicy`（`open` / `allowlist`）映射到
  `senderPolicy`；除 `disabled` 外的其它取值被拒绝。配置了
  `groupPolicy: "open"` 的 channel 不得解析成空 allowlist 而静默消费每条
  mention。**`disabled` 保持 inert：** `parseChannelConfig` 把每个 channel 的
  `groupPolicy` 默认成 `disabled`，因此它必须保留 managed
  `resolvePrivatePolicy` 的结果，而不是把 `allowedUsers` allowlist 砸成
  「什么都不准入」——自然的「仅配 allowedUsers」配置仍准入其列出的 sender，
  注入的默认值也不是拒绝触发器。
- **`repoFilter` 是显式 allowlist。** 可选 `repoFilter`（小写 `owner/repo`
  条目）过滤哪些仓库可准入事件。它仅支持 allowlist，且模式必须双向显式声明：
  `repoFilterMode: "allowlist"` 而无 `repoFilter` 数组被拒绝；有 `repoFilter`
  数组而无 `repoFilterMode: "allowlist"` 也被拒绝。其它 `repoFilterMode`
  （`blocklist` / `off`）被拒绝而非重解释——把屏蔽名单读成 allowlist 会让
  bot 只在操作者声明屏蔽的仓库回复。列表必须非空且每个条目符合 Legacy 的
  `owner/repo` 形状；空表或畸形表会在报告 running 的同时静默丢弃全部事件。
  sender 门在 adapter 侧执行，与 email 的 `senderAllowed` 同层。
- **轮询下限。** 轮询间隔尊重 GitHub 的 `X-Poll-Interval` 与限流等待提示
  （`retry-after`、`x-ratelimit-reset`），并封顶于 Node 的 32 位定时器上限
  ——即 Legacy 的 `MAX_TIMER_DELAY_MS` 守卫。超过 2^31-1 ms 的无帽提示会被
  Node 钳成约 1 ms，把限流冷却变成立即重试风暴。两类提示存为不同量：
  `X-Poll-Interval` 是**时长**下限，而限流提示是**绝对冷却截止时间**
  （`now + wait`）。有效下限为 `max(pollFloor, deadline - now, 0)`，因此冷却
  随时钟前进而过期。把限流提示存成永不过期的时长，会让一个偏斜的
  `x-ratelimit-reset` 或伪造的 `retry-after` 把 tick 循环钉死数周。

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
   下轮收集剩余部分，而不是消费一个 mention 从未 stage 的通知。**poison
   逃逸：** 评论读取返回确定性、不可修复拒绝的线程（除 401/408/429 且非
   限流应答之外的 4xx——已删除或不可访问的线程）会永远返回同一拒绝，把水位
   冻结到 channel 生命周期结束。它被可见地丢弃（其 mention 不可恢复）、跳过
   mark-read，且**不**冻结窗口。瞬态读取失败（401/408/429、限流、5xx、网络）
   仍冻结窗口，因为在共享或可重试问题上丢弃线程，会在真正问题是全局性时
   消费掉通知。429 仅凭状态码即被排除——GitHub 或其前置代理可能不带
   `retry-after` 或预算头就返回它——镜像 Legacy `classifyThreadFailure` 的
   「shared」分支。
7. 窗口内线程全部 mark read 后才推进游标水位（持久化）。mark-read 失败冻结
   窗口；下轮重列，去重吸收重叠。水位是整个窗口的单一共享值，因此**任何**
   带不可解析 `updated_at` 的通知——哪怕是被过滤掉或被丢弃的兄弟——都冻结
   整个窗口：持久化它会让后续每个 tick 的 `since` 计算抛 RangeError、重启时
   `load()` 拒绝，而出站继续运行。持久化由一个局部标志门控；仅靠外层完整性
   检查并不足够。

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

重驱复检的是**当前** policy，而非 stage 时刻的 policy：每条已持久化的 pending
事件在提交前都同时过 `senderAllowed` 与 `repoAllowed`。在更宽 sender policy 或
repo allowlist 下 stage 的 claim，不得驱动一个 Session——或发进一个仓库——
而操作者此后已将其排除。被拒的 claim 可见地丢弃（记入 dispatched 环以免重新
stage），而不是重放陈旧准入。

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

**persist 失败纪律（与 DingTalk 对齐）。** 状态保存失败（ENOSPC/EACCES/只读
目录）绝不能逃出 `send()`/`submit()` 而丢弃已领取的批量。每个 persist 点都按
DingTalk 参考的保护方式守卫：出站账本追加在发评论**之前**回滚并放弃该投递
（账本条目是双发守卫；租约 reconciler 结算为 `unknown`）；回执写入记日志但仍
上报结果（评论已在 GitHub，服务端 settle 才是持久记录）；settle 移除与孤儿
移除记日志并把条目留在磁盘，交给下次重启的孤儿重驱。入站准入 settle 回滚其
触碰的一切（pending、dispatched 环、拒绝连击、停摆标志）并锁存日志，使 claim
重驱进幂等的 replayed 应答；held-claim、refused-drop、policy-drop 与
sender-skip 写入记日志而不中断批量。store 抛固定句（状态文件可能含平台数据）
但把 fs 错误保留在 `cause`，`persistErrorText` 记录 cause 使 errno 可诊断。

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
  ownership-loss 拒绝各自红其用例。round-3 硬化见证：主动 `groupPolicy`
  （open/allowlist）映射到 sender policy，而 parse 默认 `disabled` 保持
  inert、仍准入 `allowedUsers` allowlist（`pairing` / 非空 `groups` 被拒绝）；
  `repoFilter` 两个象限（有模式无列表、有列表无模式）均被拒绝；非绝对或非
  `http(s)` 的 `baseUrl` 被拒绝且端点写法归一化；确定性不可读线程被丢弃而
  不冻结窗口，瞬态读取失败仍冻结；任何窗口兄弟的不可解析 `updated_at` 冻结
  共享水位；收窄后的 repo allowlist 排除某仓库时其重驱 claim 被丢弃；每个
  台账在恰好上限处被接受；真实定时器 tick 循环尊重高于配置间隔的轮询下限。
  persist 失败见证（spy 令第 N 次 `store.save` 失败、fs 错误挂在 cause）：
  出站账本写失败则不发评论且仍发批量的下一投递；回执写失败仍上报
  `accepted`；settle 移除写失败把条目留在磁盘交给重启的孤儿重驱；准入
  settle 写失败则回滚使 claim 重驱而非从进程中丢弃。
- deps 见证对本地 fake GitHub HTTP 端点（真实 Octokit）：分页、`since` 窗口、
  失败分类（401/404/422 确定性，限流/5xx/网络含糊）、代理遍历（CONNECT
  隧道经代理转发）与 disconnect 时 dispatcher 销毁；限流冷却随时钟前进而
  过期，而 `X-Poll-Interval` 时长下限与时钟无关。
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
   allowlist 模式必须双向显式声明，`blocklist`/`off` 配置拒绝而非重解释）。
   无 managed policy 拼写时尊重主动 `groupPolicy`（open/allowlist），parse 默认
   `disabled` 保持 inert；拒绝 `pairing` 与非空 per-repo `groups`。v1 无哨兵
   与 reaction 面。
6. 轮询下限把时长（`X-Poll-Interval`）与绝对限流冷却截止时间分开，偏斜提示
   无法钉死循环；确定性不可读线程逃逸窗口而非永久冻结它，任何不可解析的
   窗口兄弟冻结共享水位。
