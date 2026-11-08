# Daemon PR watch：投递 drain

[English](2026-11-08-daemon-pr-watch-drain.md) | [简体中文](2026-11-08-daemon-pr-watch-drain.zh-CN.md)

状态：proposed（2026-11-08）。本增量是 [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md)（下称「主设计」）中继 [观测与转换检测](2026-11-08-daemon-pr-watch-observation.md)（已合入 #16611）之后的增量。它实现 §4 投递与 §5 持久性，并一并落地观测增量延后到 drain 的 §2 watch 文件删除与 `lastBoundAt` 规则（因为它们需要 drain 的扫描完整性信息）。配置（§6）与 channel 迁移（§7）仍排除在外（PR B）。与观测一样，整条路径保持在内部关闭开关之后，在启用增量填充其 deps 之前对生产惰性。

## 问题

观测把检测到的转换写进每个 PR watch 文件的 `pending`，但没有任何东西去 drain：不解析接收者、不准入 prompt、不唤醒休眠会话。存储有写入者却没有读取者，因此关注某 PR 的会话在该 PR 的 head、CI、可合并性或状态变化时收不到 daemon 通知。GitHub channel 自身的绑定投递目前仍处理 watch 事件；本增量新增 daemon 侧 drain，供 PR B 切换过去。按主 §7，任何构建都绝不能同时跑两个 poller，因此在 PR B 移除 adapter watch 之前 drain 保持关闭。

## 现状

- 观测 + 检测（`packages/cli/src/serve/server/pr-watch-observation.ts`，#16611）在 PR 锁内把转换追加到 `pending`（上限 16）；没有任何东西读 `pending`。timer 钩子由 `SESSION_PR_WATCH_OBSERVATION_ENABLED`（关）加上尚未填充的 `getPrWatchDeps` 接缝门控。
- watch 存储（`pr-watch-store.ts`，#16590）：`PrWatchState` 已含 `delivered`（上限 64）、`pending[].served` 与角色组 `review/verify/fix/untyped`；`readPrWatchStateSync`/`writePrWatchStateSync`/`deletePrWatchStateSync` 自身不加锁（调用方持 `PathMutexRegistry` 锁，其不可重入）。owner 记录 claim/release 已存在。
- channel-base 提示词/模板契约（`packages/channels/base/src/bound-session-prompt.ts`，#16523/#16576）已共享：`validateBoundActionEntries`、`resolveBoundActionTemplate`、`renderBoundActionTemplate`、`buildBoundEventPrompt`、`sanitizePromptText`，以及各上限（模板 2,000 / title+sender 200 / 正文 6,000 code points）。渲染器已对每个值 sanitize，并用 `Map` 阻断 `%constructor%` 原型逃逸。
- `BoundSessionGoneError` / `BoundSessionUnavailableError` / `BoundSessionQueueFullError` 已在 `packages/channels/base/src/bound-session-delivery.ts` 共享。
- prompt 准入已抽取（`routes/session-prompt-admission.ts`，#16543）：`admitSessionPrompt(deps, input)` 同步、按幂等键去重、由 classification 驱动，可进程内调用。`PROMPT_IDEMPOTENCY_KEY_MAX_LENGTH` 为 200。
- 绑定扫描（`routes/session-pr-bindings.ts`）：`scanWorkspaceBindings` 返回 `SessionPrBindingSummary[]`（`sessionId`、`workspaceCwd`、`sourceType?`、`updatedAt?`、含 `role?` 的 `prs[]`）加 `partial` 标志。`updatedAt` 是共享 recency 规则（transcript mtime 被 bridge live activity 精化）；hidden-catalog 与 archived 会话已被归因排除。
- restore 仍是路由局部：`restoreSessionHandler` 是 `registerSessionRoutes`（`routes/session.ts`）内约 650 行的闭包；channel 的 wake 经 SDK 走同一 `POST /session/:id/resume` 路由（`commands/channel/daemon-worker.ts`）。没有共享的进程内 restore 函数，也没有 resume-后 drain 钩子。
- 接收者选择、partial 扫描保留（`MAX_PARTIAL_RETAINED`）与 Gone 迭代都是 `GithubAdapter.ts` 的 adapter 局部 private 方法。
- 任何地方都不存在「至多四个并发 restore」限制器。
- autofix-pr 自推 head 账本积木已导出（`commands/autofix-pr/state.ts`：`vouchedScanRoots`、`autofixPrPaths`、`readState`、`readRegularFile`、`sameRepository`；`routes/autofix-pr-watches.ts`：异步单 git 调用 `cloneWorktreesOf`），但没有「按候选会话 + 本 PR 读账本并判自推」的组合。

## 目标

- 在 PR 锁内按主 §5 崩溃窗口语义最旧优先 drain `pending`：检查 `delivered` 与内存 in-flight 标记，解析接收者，置标记，经 `admitSessionPrompt` 准入，然后写 `delivered`/`served` 并移除条目；记录写失败则保留标记，后续 drain 只重试该写。
- 跨 daemon 为每个 PR 解析一个接收者（role-aware 动作下每角色组一个），绝不每 workspace 一个，投递时惰性解析，采用 channel 的 legacy recency 规则与 partial 扫描保留。
- 经注入的 `wakeSession` 依赖恢复休眠接收者，至多四个并发，采用 channel 的 Gone/Unavailable 划分，`wakeDormant` 默认开。
- 经 autofix-pr 账本按接收者抑制自推 `head_change`；绝不抑制其余三种转换。
- 经共享 channel-base 契约投递 role-aware 动作与通用 prompt，以组后缀转换键作 `idempotencyKey`。
- 依据 drain 的扫描完整性信息应用 §2 删除与 `lastBoundAt` 规则。
- 整条路径保持在关闭开关后：不读 config，不改变生产行为或 API 量。

## 非目标（本增量）

- 配置（§6）与 channel 迁移/别名（§7）：PR B。不读 `sessionPrWatch` 设置。
- `run-qwen-serve.ts` 中 daemon 级 watch/drain deps 填充（allowed-hosts 发现、锁 registry 与 watch 目录、准入/restore deps、以及 listing→watch 写入 + `listedKeys`）：启用增量。drain 暴露 deps 接缝，在被填充且开关打开前惰性。
- 从 `restoreSessionHandler` 抽取共享 restore、resume-后 drain 钩子、serve lifecycle close 重排：这些只在 drain 启用后才运行，故随启用增量落地以便端到端验证。本增量把 `wakeSession` 作为依赖注入并据此测试 drain 的 restore 处理；路由不改动。
- 对交互式写入者的隔离（fencing，主 §4「Dormant sessions」）：session-writer-lease 暴露面是 channel 今天的现状，仍排除在外。
- 手动 push 账本（主开放问题 5）：只记录经 autofix-pr helper 的 push。

## 拟议改动

### restore 作为注入依赖

drain 经注入的 `wakeSession(sessionId, workspaceCwd)` 恢复休眠接收者，返回 `restored`（带所铸造 client registration 的 `release`）、`gone` 或 `unavailable`。drain 在投递的 prompt 落定后释放 registration，一如 channel accessor。真实实现——把 workspace 会话 restore 从 `restoreSessionHandler` 抽取为路由与 drain 共享的函数，外加 resume-后 drain 钩子使 `wakeDormant: false` 条目在下一次 live turn 投递——随启用增量落地；本增量不改路由，用假 `wakeSession` 测试 drain。

### drain 编排

新模块 `packages/cli/src/serve/server/pr-watch-drain.ts` 暴露每 tick drain 与每 PR drain 步骤。tick 仅在持有 owner 记录时 drain（非 owner 什么都不 drain）。对每个被 watch 的 PR，在一次 PR `PathMutexRegistry` 锁持有内重读 watch 文件并最旧优先 drain `pending`：跳过已在 `delivered` 或已标 in-flight 的键；解析接收者；置内存 in-flight 标记；准入；然后把条目键写入 `delivered`（并把组写入 `served`），在所有匹配组都被 served 后从 `pending` 移除条目。标记在该写之后清除，或在准入被直接拒绝时清除。若记录写失败，保留标记，后续 drain 只重试该写，绝不重新解析或重新准入。超过 7 天的 pending 条目记日志后丢弃。只有休眠接收者的 restore 在锁外运行且其键标 in-flight；其准入重新取锁、重读文件，若键已在 `delivered` 则跳过。这给出主 §5 崩溃窗口：写前重新检测、写后 drain、以及准入与记录写之间重启后的至少一次重新准入。

### 接收者解析

接收者来自对扫描覆盖 workspace（trusted 加 primary）的进程内绑定扫描。排除 channel 拥有的会话（`sourceType: 'channel'`）；archived 与 hidden-catalog 会话已被扫描归因排除。无 actions 时接收者是单个最近活跃的绑定者（`updatedAt`，扫描的 recency 规则）；有 actions 时每角色组解析其模板链匹配的最近活跃绑定者。partial 扫描时，从上一次列出它的扫描保留未被列出的行（有界、最旧先丢，镜像 adapter 的 `MAX_PARTIAL_RETAINED`），并在完整扫描省略它时丢弃保留行；无法触达的保留赢家使条目保持 pending。检测与 drain 之间被归档或被超越的接收者不损失什么——drain 重新解析下一个绑定者。不再注册、不再被覆盖、或 generation 已退役的 workspace 记日志跳过，并在 dispatch 前立即重新解析。

### 休眠 restore

非 live 的绑定会话经注入的 `wakeSession` 恢复，然后投递。restore 绝不在 tick 上运行：drain 启动休眠接收者的 restore 与准入而不等待（至多四个并发；其余等待后续 drain），键保持 in-flight 直到它们落定，restore 超时绝不拉长 tick。`wakeDormant` 默认开，使重启不搁浅事件；关闭时条目保持 pending 直到会话下一次 live turn（drain 它的 resume 钩子随启用增量落地）。restore 结果按 channel 划分：永久 Gone（404 会话记录丢失，或 409 `session_archived`/`worktree_session_superseded`/`worktree_marker_missing`/`worktree_reset_interrupted`）排除该会话，drain 在其余绑定者中重新解析，仅当完整扫描无候选时记日志丢弃转换；临时结果（超时、503、429、409 `restore_in_progress`/`session_busy`、`session_writer_conflict`）使条目在下一 drain 仍为同一接收者保持 pending。drain 的 restore 错误分类把 `session_writer_conflict` 纳入临时（channel accessor 的 `deliverPrompt` 409 白名单目前漏了它；drain 不复用该白名单）。

### 自推 head 抑制

仅对 `head_change`，自身推送 head 账本含新 head 的候选被排除，drain 重新解析下一个绑定者（有 actions 时在其角色组内，无则单赢家）。账本是 autofix-pr watch 状态里的 `pushedShas`，经 helper 自身的单 git 调用发现解析（从候选的 clone——bridge live summary 的 `worktree.path`，否则绑定的 `workspaceCwd`——跑 `cloneWorktreesOf`，然后 `vouchedScanRoots` 与 regular-file 检查），经 `readRegularFile`/`readState` 读取，且仅在 `sameRepository` 与 `sessionId` 匹配时接受。untrusted primary 仅用坐标（其检出里不跑 git）。任何拒绝（缺失、非常规、不可读、不匹配）意味着无账本、转换照常投递。`lastKnownHeadSha` 刻意不属于账本。`ci_failure`、`merge_conflict`、`state_change` 永不被抑制。

### role-aware 动作与 prompt 构造

设置 actions 时，投递使用共享 channel-base 契约。`deps.actions` 作为**已校验**的 map 被消费：对四个裸转换类型（无 lane）的封闭键词表与 2,000 code-point 模板上限，由 `validateBoundActionEntries` 在 daemon 构造该 map 处（§6 配置，PR B）强制，而非由 drain 强制。投递随后每角色组跑 `resolveBoundActionTemplate`（`<role>:<type>` → `<role>:default` → `<type>` → `default`；untyped 只解析裸链），用各值（`%repo%`/`%pr%`/`%url%`/`%title%`/`%event%`/`%sender%`/`%role%`，`%event%` 为裸类型）跑 `renderBoundActionTemplate`。每个匹配组有自己的赢家、自己在组后缀键下的准入、以及由 `buildBoundEventPrompt` 构造、在带标签可信指令块中携带渲染指令的 prompt；每转换至多四次投递。无合格绑定者的匹配组在完整扫描被跳过、在 partial 扫描等待。无 actions 时投递是单赢家与通用 prompt（有角色时用内置角色指导）。prompt 的 GitHub 派生行经 `sanitizePromptText`，正文保持 6,000 code-point 上限。不设置 display text；回复留在会话内。

### 扫描完整性：lastBoundAt 与删除

drain 在完整或 partial 扫描列出 PR 的绑定者（或保留行命名它）时，在 PR 锁内刷新 `lastBoundAt`。完整扫描发现无绑定者时删除 watch 文件，否则自 `lastBoundAt` 起 7 天后删除；未投递条目记日志丢弃。partial 扫描只适用 7 天规则。absent/invalid 以外的读错使该 PR 本 tick 跳过（无 drain 步骤、无删除、无记录写）。删除后再次绑定的 PR 静默初始化；删除前再次绑定则从其上次观测恢复。

### lifecycle close 重排（延后到启用）

重排 serve lifecycle close（`serve-app-lifecycle.ts`），使 owner 在移除 owner 记录之前停止其 PR watch——timer、drain、以及所有在途 restore 与准入（主 §2）——只在 drain 运行后才有意义。开关关闭时不尝试 claim、也无在途 drain/restore/准入，故该重排随启用增量落地。

### timer 接线与 deps 接缝

drain 在与观测相同的门控 timer 块内、`runPrWatchObservationTick` 之后运行，处于关闭开关与其独立 `getPrDrainDeps` 接缝之后；deps 携带所需的准入/restore/registry/自推访问。开关关闭（或接缝未填充）时该块惰性、refresh 不变。独立于 timer 跑 drain 的 resume 钩子随启用增量落地。

## 涉及文件

| 文件                                                         | 改动                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/cli/src/serve/server/pr-watch-drain.ts`（新）      | 每 tick + 每 PR drain、接收者解析、in-flight 标记、自推抑制、role-aware 投递、删除/`lastBoundAt` |
| `packages/cli/src/serve/server/pr-watch-drain.test.ts`（新） | drain 语义、崩溃窗口、接收者/保留、restore 划分、自推、角色组、删除                              |
| `packages/cli/src/serve/server/session-pr-refresh.ts`        | 门控块内观测之后跑 drain；加 `getPrDrainDeps` 接缝                                               |
| `packages/cli/src/serve/routes/session.ts`（延后）           | 从 `restoreSessionHandler` 抽取共享 restore；加 resume-drain 钩子（启用）                        |
| `packages/cli/src/serve/serve-app-lifecycle.ts`（延后）      | 移除 owner 记录前停止 watch（启用）                                                              |
| `packages/cli/src/serve/run-qwen-serve.ts`（延后）           | 随启用增量填充 watch/drain deps                                                                  |

## 关键设计决策

1. **复用已合入契约，不重新实现。** prompt/模板校验、解析、渲染、信封、准入与错误类都已共享；drain 只新增编排、接收者解析、restore 槽位与自推组合。
2. **文件是唯一基线；投递是 PR 作用域。** 观测保持每 workspace，而检测与投递是 PR 作用域，因此不可达/untrusted/退役的绑定者不持陈旧副本，可达时重新成为候选。
3. **准入即投递。** 一如 channel 的绑定 relay，准入后排在运行中 turn 之后的 prompt 在重启时随内存队列丢失；watch 文件已记录该键、不再注入。`delivered`（而非每会话准入 ring）阻止一个键被准入到另一个会话。
4. **restore 是注入依赖。** drain 消费 `wakeSession`；从路由抽取共享 restore 随启用增量落地以便端到端测试。drain 的 restore 错误分类是自己的，并把 `session_writer_conflict` 视为临时。
5. **默认关闭。** drain 在启用增量填充 deps、PR B 打开开关之前对生产惰性；任何构建都不跑两个 poller。

## 约束与风险

- 开关关闭时无行为或 API 量变化；风险限于新模块测试与门控钩子。本增量不改动核心 `routes/session.ts`。
- drain 不得拉长 tick：restore 在 tick 外运行、至多四个在途，每个 drain 步骤受 PR 锁与 pending 上限约束。
- 自推账本可被会话写：是成本优化而非信任边界（主 §4）；伪造条目可把 `head_change` 转投下一个绑定者，但不能静默其余三种转换。

## 验证计划

- 单元（drain）：最旧优先 drain；`delivered`/in-flight 跳过；记录写失败保留标记且只重试写；7 天年龄丢弃；崩溃窗口重新准入；非 owner 什么都不 drain。
- 单元（接收者）：按 recency 单赢家；角色组赢家；channel 拥有被排除；partial 保留与完整扫描丢弃；Gone 重新解析；退役/未注册 workspace 被跳过。
- 单元（restore）：至多四个并发；Gone vs 临时划分含 `session_writer_conflict`；`wakeDormant` 关保持 pending；被恢复接收者获投递且 registration 被释放。
- 单元（自推）：账本含该 head 的候选其 `head_change` 被抑制并重新解析到下一个绑定者；其他转换永不抑制；账本拒绝则投递；untrusted primary 用坐标。
- 单元（role-aware/prompt）：组后缀键；每组 `served`；所有匹配组 served 后条目离开 pending；无 actions 通用 prompt；sanitize 与上限。
- 单元（删除/`lastBoundAt`）：完整扫描无绑定者删除；partial 的 7 天规则；读错跳过；再绑定静默初始化。
- 关闭开关 parity：refresh/timer 不变；关闭时绝不读 drain 接缝。

## 验收标准

1. 开关关闭时，timer 与 refresh 行为完全如前：无 drain、无准入、无 restore、无删除。
2. 开关打开（测试）时，pending 转换向解析出的接收者投递一次、记入 `delivered`、并从 `pending` 移除；重试去重；准入与记录写之间崩溃则重新准入一次。
3. 休眠接收者被恢复（≤4 并发）并投递；Gone 接收者被重新解析；临时失败使条目保持 pending。
4. 自推 `head_change` 对推送候选被抑制并重新解析；其余三种转换照常投递。
5. 完整扫描无绑定者的 watch 文件被删除；`lastBoundAt` 在 partial 扫描门控 7 天规则。
6. 任何转换都不发布到任何地方；回复留在会话内。

## 开放问题

- 继承自主设计（默认开启时机、`cancelled`/`stale` CI 谓词、手动 push 账本）；此处均不决定。
