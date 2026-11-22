# 侧栏会话「待继续」徽章

[English](sidebar-session-continuation-badge.md) | [简体中文](sidebar-session-continuation-badge.zh-CN.md)

状态：已随本次改动实现。

## 问题陈述

最后一个 turn 被中途切断的会话（daemon 崩溃、daemon 关停、agent 通道退出、
prompt 运行中会话被 close/kill）是可以继续的：打开它会看到
`SessionRecoveryBanner` 的「Continue execution（继续执行）」按钮。但 Web Shell
侧栏的会话行没有任何标记，用户无法从会话列表看出哪些会话欠一次继续执行，
只能逐个打开可疑会话、等 transcript 加载完成后才看到横幅。

## 现状

- `packages/core/src/core/session-recovery.ts` 与
  `packages/core/src/core/turn-interruption.ts` 从持久化历史分类未完成的 turn
  （`interrupted_prompt`、`interrupted_turn`、`degraded_history`）。分类在会话
  被加载进 agent 时运行（`Session.getRecoveryStatusForClient()`），结果随会话
  context status 下发（`ServeSessionContextStatus.recovery`）。
- `SessionRecoveryBanner.tsx` 只在打开的聊天面板内、基于
  `connection.context?.recovery` 渲染「继续执行」入口。
- 侧栏行的易变状态来自会话目录（`DaemonSessionSummary`）与 workspace
  live state（`DaemonSessionLiveState`：`hasActivePrompt`、`activeWorkState`、
  `isWaitingForPermission`、`isWaitingForUserQuestion`、`hasTurnError`、
  `backgroundTurn`、`hasRunningBackgroundTasks`）的合并。两者都没有继续执行
  信号，而冷会话——daemon 重启后的主要中断场景——根本不在 live 列表里。
- daemon 已经持久化了每会话的 **prompt terminal ledger**
  （`packages/acp-bridge/src/prompt-ledger.ts`，设计见
  `2026-08-19-prompt-terminal-ledger-design.md`）：prompt 准入时写一条
  `in_flight`，正式 terminal 发布时写一条 terminal 记录
  （`completed` / `cancelled` / `error` / `interrupted`），包括
  close/kill/通道崩溃/daemon 关停的 flush。硬崩溃会留下悬空的 `in_flight`；
  冷加载对账（`reconcileDanglingPromptTerminals`）在能归因时追加
  `interrupted` / `daemon_lost`。

## 目标

- 持久化 prompt-ledger 证据表明最后一个 turn 被切断的会话，在侧栏会话列表
  （桌面与触屏布局）显示可见徽章，让用户能注意到并打开会话去继续。
- 正在运行、有后台工作、等待批准/输入的会话绝不显示徽章；一旦观察到更新的
  turn terminal，或继续执行落定后目录被重读，徽章即清除。
- 不新增持久化状态、不在热路径写盘：信号完全从已有 ledger 推导。

## 范围边界

- 徽章是**提示**，不是权威恢复判定。打开的会话内横幅仍从 transcript 与 live
  turn 守卫计算 `canContinue`；点了徽章进去后横幅被抑制（例如写锁或自动 turn
  在跑）是合法结果。
- 没有 ledger 的会话（纯 TUI 会话、prompt 从未到达 daemon 准入的会话）没有
  徽章。覆盖它们需要对每个列出的会话做 transcript 尾部扫描，暂缓。
- 普通模型错误 terminal（不带 teardown code 的 `terminal: 'error'`）不触发
  徽章；那属于 turn-error/Retry 面，不是继续执行面。
- 归档会话是已关闭的会话；归档列表不做 enrichment。
- Session Overview 面板与其他目录消费者本次不改；它们以后可以读这个新字段。

## 方案

### wire 字段

在会话摘要上新增一个可选布尔，两个 wire 类型同步镜像：

- `DaemonSessionSummary.needsContinuation?: boolean`
  （`packages/sdk-typescript/src/daemon/types.ts`）
- `BridgeSessionSummary.needsContinuation?: boolean`
  （`packages/acp-bridge/src/bridgeTypes.ts`）

`true` 表示：持久化 prompt ledger 的最后一条记录表明该会话最新的 prompt 被
中途切断。缺省表示没有证据（省略字段，绝不写 `false`，与 sidecar enrichment
惯例一致）。OpenAPI 的 `SessionSummary` schema 记录该字段
（`docs/developers/daemon-rest-api.openapi.json`，`additionalProperties: true`
本就允许）。

### 服务端推导（cli serve）

`packages/cli/src/serve/server/session-list.ts` 新增一个 enrichment 步骤
`enrichPromptContinuation`，在两处持久化摘要组装点与
`enrichWorktreeSidecars` / `enrichPrSidecars` 并列调用（默认分页路径与
`loadAllPersistedSummaries`——后者同时服务 organized、metadata 过滤与
standalone 会话列表）。对每个 active 会话读取 ledger 尾部
（`sessionService.getPromptLedgerPath(sessionId)`，
`readPromptLedgerRecords(path, { tailBytes: 4096 })`），当**最后一条记录**是
以下形状时置 `needsContinuation: true`：

1. `in_flight`——prompt 已准入但从未 terminal（任何 flush 之前的硬崩溃）；或
2. terminal `interrupted`——冷加载对账归因出 `daemon_lost` 中断；或
3. terminal `error` 且带 teardown code：`daemon_shutdown`、`channel_closed`、
   `session_closed`、`session_killed`——优雅 flush 会为每个仍在 pending 的
   prompt 发布 error terminal，所以这些 code 的含义是「turn 被 teardown 切断」，
   而不是「模型失败」。

其他任何最后记录（`completed`、`cancelled`、普通 `error`、
`prompt_deadline_exceeded` 错误）都省略字段。只读最后一条记录让规则便宜且
fail-closed：撕裂的尾行被 ledger reader 丢弃，不可读的 ledger 直接跳过，
更晚落定的 prompt 永远取代更早的中断。4 KiB 窗口能容纳几十条记录，而只有
最后一条参与判定；最后记录已落定的多悬空 prompt 形状刻意不标记
（对账本身对它们也 fail-closed）。

`mergeLiveSessionSummary` 在 live 条目显示有工作在飞
（`hasActivePrompt`、`activeWorkState === 'active'`、
`hasRunningBackgroundTasks` 或存在 `backgroundTurn`）时丢弃持久化标记，
运行中会话的新目录读取因此绝不携带徽章证据。

### 客户端新鲜度（web-shell）

- `session-catalog-store.ts` `applyLiveState`：当 live 活动水位推进了某行的
  活动时间时，清除该行的 `needsContinuation`。水位是当前 bridge 里运行过的
  prompt 的最新 terminal；比持久化证据更新的 terminal 意味着继续执行
  （或新 prompt）已经落定，陈旧标记不必等限流的全量目录 reconcile
  （最长约 10 s）才消失。
- `WebShellSidebar.tsx`：当 `session.needsContinuation === true` 且会话不在
  运行、没有后台运行、不带 `backgroundTurn`、也没有批准/输入 attention 徽章
  时，行内在既有 meta slot 渲染琥珀色 pill
  （`sidebar.continuationNeededShort`，完整标签
  `sidebar.continuationNeeded` 作为 `aria-label`）。pill 复用
  `sessionAttention` 的布局规则（hover 让位操作按钮、触屏布局保持在流内），
  触屏设备因此保有可见状态。
- 新鲜度按各面既有契约区分：workspace 树行经 catalog store 合并 live-state
  tick，运行一开始徽章即隐藏，并按水位规则清除。跨 workspace 的 Recent 区
  按既有 10 s 节奏重读原始目录页（它今天对所有易变指示都不消费 live
  state）；其徽章遵循同一契约——每次重读时服务端 live 合并会为运行中会话
  丢弃标记，继续执行落定后下一次重读清除。
- i18n：英文 `Continue execution needed` / `Continue`；中文
  `需要继续执行` / `待继续`。

## 设计决策与理由

- **用 ledger，不做 transcript 扫描。** ledger 已经记录了恰好需要的
  准入/terminal 证据，体积极小，且加载路径本就在读它。对每个列出的会话做
  transcript 尾部中断扫描会在列表成本上复制 `detectTurnInterruption` 语义，
  还仍会漏掉 notification-trim 的 provenance 规则。
- **只看最后一条记录，不做全 ledger 分析。** 继续执行问的是会话最新的 turn。
  更晚准入的 prompt 取代更早的中断（send 路径会剥离孤儿尾部 user 条目），
  最后一条记录是正确且最便宜的见证。
- **纳入 teardown error code。** 优雅 shutdown/close/kill 的 flush 写的是
  `error` terminal 而非 `interrupted`；排除它们会漏掉最常见的重启场景。
  这四个 code 恰好是 `flushPromptTerminals` 的全部调用点。
- **提示语义。** 推导权威 `canContinue` 需要加载后的 transcript 与 live turn
  守卫；列表路径不能也不应复制它们。徽章指向横幅，横幅保持权威。
- **客户端按水位清除。** 目录 reconcile 有限流（10 s 冷却）；没有水位规则时，
  继续执行完成后缓存目录仍带标记，徽章会闪回最长约 10 s。

## 约束

- ledger 读取为每个列出的 active 会话增加一次有界文件读，与既有 PR/worktree
  sidecar enrichment 同一量级；持久化列表缓存（2 s TTL）与目录分页限制频率。
- 字段是增量可选的；旧 daemon 省略它，旧客户端忽略它。不需要 capability flag。
- `BridgeSessionSummary` 是 `DaemonSessionSummary` 的 wire 镜像；两者必须在
  同一改动里同时加字段。

## 风险

- **另一进程持有 turn 时的假阳性。** 悬空 `in_flight` 可能属于另一个
  daemon/进程里正在运行的 prompt；本 daemon 的 live state 无法抑制它。徽章
  此时指向一个加载后横幅被 veto 的会话。接受：徽章是提示，横幅守卫仍是权威。
- **ledger 追加失败。** ledger 写入是 best-effort；丢失 terminal 会留下悬空
  `in_flight`，徽章保留到下一个 prompt 落定。接受，与对账同一姿态。
- **recorder flush 窗口。** 硬崩溃落在 prompt 准入与 recorder 首次 flush
  之间时，ledger 留下悬空准入，但 transcript 里没有 user 记录：徽章会亮，
  而加载后的会话读作 `clean`（没有可继续的内容）。真实 daemon E2E 在
  SIGKILL 落进该窗口时实测到此形状。按提示语义接受——下一个 prompt 即清除
  徽章；E2E 在崩溃前等待 user 记录落盘，以验证可继续的场景。
- **窗口边界。** ledger 最后一条记录不可能落在 4 KiB 窗口起点之前（窗口锚定
  EOF）；只有撕裂的末行会被丢弃，回退到前一条记录——fail-closed。

## 验证计划

- 单元（cli）：`session-list.test.ts`——每种最后记录形状（悬空 `in_flight`、
  `interrupted`、四个 teardown code、`completed`、`cancelled`、普通 `error`、
  `prompt_deadline_exceeded`）、不可读 ledger、归档跳过、live 合并抑制，以及
  organized/standalone 路径继承 enrichment。
- 单元（web-shell）：`session-catalog-store.test.ts`——水位推进清除标记、
  相等/更旧水位保留标记；侧栏测试——idle 且带标记时徽章可见（en + zh-CN
  标签），运行/活动任务/后台任务/后台 turn/attention 时隐藏，git 图标让位
  徽章。触屏可见性不单独断言：pill 复用 `sessionAttention` 的布局规则，
  在 `@media (hover: none)` 下保持在流内。
- E2E（mock daemon，Playwright）：带 `needsContinuation` 的目录夹具渲染徽章；
  带 `hasActivePrompt` 的 live-state tick 将其隐藏。
- E2E（真实 daemon）：运行一个 prompt，turn 中途 SIGKILL daemon，重启后验证
  目录回答 `needsContinuation: true`、侧栏显示徽章、继续执行落定后徽章清除。

## 验收标准

- 被中断的冷会话在桌面与触屏布局的侧栏显示可见、带标签的徽章；点击行打开
  会话后恢复横幅提供「Continue execution」。
- 运行中、后台活动、attention 会话在 workspace 树绝不显示徽章；Recent 区
  与其所有易变指示一样，在 10 s 原始重读节奏内收敛。
- 继续执行完成后徽章无需刷新页面即消失：workspace 树立即清除（水位清除，
  随后目录 reconcile），Recent 区在其既有 10 s 原始重读节奏内清除。
- 无 ledger 证据的会话、归档会话、旧 daemon 的行为与之前完全一致。

## 开放问题

- Session Overview 面板是否应展示同一信号（暂缓；字段已在 wire 上）。
- 纯 TUI 会话是否值得一个 transcript 尾部回退扫描（暂缓；对侧栏热列表路径
  的成本收益尚不明确）。
