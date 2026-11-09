# Daemon PR watch：启用接线

[English](2026-11-09-daemon-pr-watch-enablement.md) | [简体中文](2026-11-09-daemon-pr-watch-enablement.zh-CN.md)

状态：proposed（2026-11-09）。本增量是 [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md)（下称「主设计」）中继 [投递 drain](2026-11-08-daemon-pr-watch-drain.md)（已合入 #16656）之后的增量，落地 drain 增量延后到启用的四项：共享 restore、resume 后 drain 钩子、lifecycle close 重排、daemon 级 deps 填充。**off 开关仍为 `false`，`sessionPrWatch` 设置仍不读取**——配置（§6）、channel 别名与打开开关（§7）仍属 PR B。任何构建都绝不能同时跑两个 poller。

## 问题

drain 已完整但不可达。`runPrWatchDrainTick` 把 restore、准入、registry 与自推访问都作为注入依赖，而生产中没有任何东西填充它们：`getPrWatchDeps` 与 `getPrDrainDeps` 没有生产调用方，`defaultPrWatchDir()` 与 `releasePrWatchOwnershipSync()` 只被测试引用。由此有三个后果，每一个在 PR B 打开开关的那一刻就是缺陷：

- 休眠接收者永远无法被唤醒。真实 restore 位于 `restoreSessionHandler`——`registerSessionRoutes` 内约 650 行的闭包（`packages/cli/src/serve/routes/session.ts:4273-4922`），只能经 HTTP 到达。channel 经 SDK 调用它（`commands/channel/daemon-worker.ts:1057-1063`），而 daemon 不能用这条跨进程路径做自己的进程内投递。
- `wakeDormant: false` 会永久搁浅条目。drain 把它们留到会话下一次 live turn，但没有 resume 后 drain 的钩子，因此无人消费。
- 关停会与后继者重叠。没有任何东西停止 watch 或释放 owner 记录，因此后继 daemon 可能在前任的 restore 与准入仍在途时就 claim（主 §2）。

另有两处缺口关乎正确性而非可达性：观测丢弃了绑定扫描的 `partial` 标志（其自身注释明写启用增量必须在任何负面决策前透传它），以及 slim listing 从不把 `state` 写进 watch 文件、也不提供 `listedKeys`，因此 listing 已返回的 closed PR 会永远留在 view 轮转里。

## 现状

- **restore 是路由局部的。** handler 形如 `(action: 'load' | 'resume') => async (req, res) => …`。可复用核心是从 archive coordinator 共享锁（`session.ts:4498`）起，经 bridge 的 `loadSession`/`resumeSession`、`cleanupRestoredSession`（`4803-4819`）、worktree 复挂（`reconcileRestoredSessionWorktree`，已是 `930` 处模块级、全参数注入的函数）到 deferred question 点火。该核心不碰 `req`/`res`。HTTP 耦合集中在五处：把 400 写进 `res` 的输入解析 helper；`resolveRuntimeForSessionRestore`（`2180-2299`，把六种失败写进 `res` 并返回 `undefined`）；`setDaemonTelemetryWorkspace(res, …)`；三处 `!res.writable` 断连清理；以及响应 shaping（`withPromptTerminals` / `redactSdkSurfaceReplay` / 200 JSON）。
- **typed error 已经是纯的。** `SessionNotFoundError`、`WorktreeSessionSupersededError`、restore 冲突与 session 限额错误都以类的形式存在，之后才由 `sendBridgeError` 翻译成 wire 形状（`server/error-response.ts`）。进程内调用方可直接按类分拣，无需任何 HTTP 参与。429 限流是全局中间件（`rate-limit.ts:277-289`），进程内调用者天然不会遇到。
- **两把锁与 detach 都幂等。** `RequestedSessionIdReservation.release()` 由 `released` 布尔门守卫（`session-id-admission.ts:212-229`）；worktree ownership op 的 release 同理（`server/worktree-ownership-op.ts:52-60`）；`bridge.detachClient` 对未知 client no-op，否则递减引用计数。最后一个 client 离开会触发 idle close——这正是 drain 必须释放它所铸造 registration 的原因。
- **channel 的 wake 生命周期是范本。** `createBoundSessionsAccessor` 的 `wake` 调 SDK resume 并返回 `restored.detach`；`deliverPrompt` 在 prompt 落定后于 `finally` 中释放，绝不在重试之前（`daemon-worker.ts:1127-1134` and `692-703`）。其 Gone 集是 404 加 409 的 `session_archived`、`worktree_session_superseded`、`worktree_marker_missing`、`worktree_reset_interrupted`；其余皆临时。
- **drain 的接缝已就绪。** `PrWatchDrainDeps` 已声明 `wakeSession`、`admitPrompt`、`readPushedHeads`、`resolveRuntime`、`isSessionLive`、`scanBindings`、`actions`、`wakeDormant`；`runPrWatchDrainTick` 已接受调用方的 `coveragePartial`。`admitSessionPrompt` 已抽取且可进程内调用（#16543）。
- **timer 填充有先例。** `run-qwen-serve.ts:7611` 在 app 存在之前启动 refresh timer，并经 late-bound getter 取得 archive coordinator。watch deps 必须沿用同一形状。
- **lifecycle 有 drain 注册表。** `ServeAppLifecycleController.addAppDrain`（`serve-app-lifecycle.ts:118`）汇入 `closeOnce`（`198`），后者先封准入，再并发启动每个 drain 与 listener 关闭，并用 `Promise.allSettled` 一并等待——任一 drain reject 都会让 `close()` 抛错。`server.ts:4440` 是既有注册例。
- **host 发现有积木但无枚举器。** `resolveGithubWebOrigin(baseUrl)`（`packages/channels/github/src/web-origin.ts:14`）把 channel 的 `baseUrl` 映射为其 web origin；`resolveChannelWorkspaceGroups`（`serve/channel-workspace-grouping.ts:128`）已施加 channel 托管所用的信任门控。`gh` 自己配置的 hosts 在任何地方都没有被枚举——adapter 只经 `gh auth token --hostname` 一次查一个主机，并在 `GithubAdapter.ts:136-147` 记录了 go-gh 的 ConfigDir 优先级。

## 目标

- 把 restore 核心抽取为路由与 drain 都能进程内调用的函数，且路由的 HTTP 行为逐字节兼容。
- 给 drain 一个真实的 `wakeSession`，铸造并释放 client registration，并按 channel 的方式划分结果。
- 在 resume 时 drain，使 `wakeDormant: false` 的条目在会话下一次 live turn 被消费。
- 关停时停止 watch 并释放 owner 记录，且在途工作落定之后才释放。
- 填充两个 deps 接缝：watch 目录与锁 registry、allowed hosts、准入、restore、自推账本，以及扫描的 `partial`。
- 把 slim listing 的 `state` 写进 watch 文件并提供 `listedKeys`。
- 保持开关关闭、设置不读：生产中零行为与零 API 量变化。

## 非目标

- `sessionPrWatch` 配置、其环境覆盖、channel 别名与打开开关：**PR B**（主 §6/§7）。
- 移除 adapter watch：PR B。在此之前 channel 保留自己的 poller，daemon 侧保持惰性。
- 对交互式写入者的隔离（主 §4）：session-writer-lease 暴露面是 channel 今天的现状，仍排除在外。
- 手动 push 账本（主开放问题 5）：只记录经 autofix-pr helper 的 push。

## 拟议改动

### 1. 共享 restore

新模块 `packages/cli/src/serve/server/session-restore.ts` 把核心导出为一个函数，接收 runtime、session id、action、已校验的选项，以及路由当前捕获的闭包态（`archiveCoordinator`、`requestedSessionIdAdmission`、generation 断言、`materializeLiveConversationDirectory`、`daemonLog`）。它返回被恢复的会话加一个释放所铸造 client registration 的 `release()`，并**抛出既有的 typed error**而不是写响应。

路由保留全部 HTTP 专属部分：解析、`resolveRuntimeForSessionRestore`、telemetry、断连检查、响应 shaping 与 `sendBridgeError` 翻译。它在既有 `try`/`catch`/`finally` 内调用共享函数，因此 reservation 与 worktree 锁的释放留在原处，约 70 条既有 HTTP 测试原样通过。

三条边界明确决定：

- **legacy standalone 收养分支与 virtual-subagent 分支留在路由。** 两者都是自带回滚的 HTTP 形状早返回，且都不是 drain 能定位的 workspace 会话。共享函数只覆盖 workspace-session 路径。
- **`res.writable` 没有进程内对应物。** 共享函数接受可选的 `isCancelled` 谓词；路由传 `() => !res.writable`，drain 不传。它所守卫的清理移入共享函数，使两个调用方都获得它。
- **`resolveRuntimeForSessionRestore` 不抽取。** 它的六个 `res` 出口是 drain 不做的路由决策——drain 已知接收者的 runtime，并在 dispatch 前立即重新解析。抽取它意味着为进程内调用者根本碰不到的失败发明 typed-error 变体。

### 2. resume 后 drain 钩子

共享 restore 接受可选的 `onRestored` 回调，在会话已 live 且 generation 断言通过之后、函数返回之前调用。路由不传（行为不变）；drain 的 `wakeSession` 填充传入一个为该会话所绑定 PR 调度 drain 的钩子。

钩子**绝不能在 restore 内被 await**。`PathMutexRegistry.runExclusive` 不可重入，而 drain 自己的 `restoreAndAdmit` 在 wake 之后会重新取同一把 per-PR 锁。从「由 drain 派发的 restore」内部 await 一个 drain 会反转 await 方向并可能死锁。因此钩子不等待地触发 drain（`void`，自带失败日志），正如 drain 已经不等待地触发 restore。它还在 reservation 与 worktree 锁释放之后运行，因此重新进入同一会话 restore 的 drain 不会撞上 pending reservation 计数。

### 3. lifecycle close 重排

注册一个 app drain，依次：停止 refresh timer；等待持有 claim 的 refresh tick 与 drain 的在途 restore 与准入落定；然后经 `releaseOwnedPrWatchSync` 释放 owner 记录。经 `addAppDrain` 注册使它进入 `closeOnce` 的 drain 集合，`close()` 会把它与 listener 关闭一并等待。lifecycle 不在两者之间施加任何顺序，因此「停止 → 落定 → 释放」的次序必须在 drain 内部自己成立。

等待需要 drain 今天未暴露的落定信号。给 drain state 加一个 `idle()` promise，在无 drain tick 且无 restore 在途时 resolve。写失败留下的 admitted 标记不是在途工作——它是下一任 owner 要做的重试——因此绝不把等待卡住。

仅有这个信号**并不够**：observation 在整个 refresh tick 期间持有 owner 记录，却从不进入 drain tick，因此落在 view 中途的关停会看到一个空闲的 drain，并在本 daemon 仍在 view、随后就要 drain 时释放记录。所以等待有两条臂——`stopPrWatch` 还接受一个由 refresh timer 提供的 `waitForTick` 落定 promise，在其在途 tick 结束时 resolve。两条臂一起与超时赛跑。

`idle()` 本身无界：由 `stopPrWatch` 用超时与之赛跑，因为只有调用方知道自己的关停 deadline。owner 记录**只在等待成功之后**释放，因此后继者绝不与在途工作重叠（主 §2）。超时则刻意**保留**记录——在 restore 仍在准入时释放会让后继者把同一转换投递两次，而留着是安全的，因为 claim 会清扫进程已确证消失的记录。从未 claim 的 daemon 不释放任何东西，本进程不拥有的记录也原样留下。

### 4. deps 填充

`run-qwen-serve.ts` 在 `getArchiveCoordinator` 旁经 late-bound getter 填充两个接缝：

- **watch 目录与锁**：`defaultPrWatchDir()`，一个由观测与 drain 共享的 `PathMutexRegistry`，使 owner 的进程内锁对每个文件都权威（主 §2）。
- **allowed hosts**：`github.com`、daemon 自己 `gh` 配置中的 hosts，以及本 daemon 托管的每个 GitHub channel 的 web origin。新 helper 按 go-gh 的 ConfigDir 优先级（`GH_CONFIG_DIR`、`XDG_CONFIG_HOME`、`%AppData%\GitHub CLI`、`HOME/.config/gh`）枚举 `gh` 的 `hosts.yml` 键，用仓库的 `node yaml` 读 YAML。托管 channel 来自 `resolveChannelWorkspaceGroups`，因此非受信 workspace 的设置绝不贡献；`resolveGithubWebOrigin` 给出各自的主机。每个主机都用 `normalizeWatchHost` 归一化。读取失败降级为 `github.com` 加托管 channel，并记一行日志——绝不降级为会静默禁用所有 view 的空集。
- **准入**：`admitSessionPrompt` 配 app 的 archive coordinator，沿用 bound relay 的 classification（`channelPrompt: true`），使注入文本不跑 PR-binding backfill（主 §4）。
- **restore**：§1 的共享 restore，把其 typed 结果映射为 `PrWatchWakeOutcome`——成功映射为带 registration `release` 的 `restored`，Gone 集映射为 `gone`，其余映射为 `unavailable`。`session_writer_conflict` 属临时，正如 drain 自己的划分已要求。
- **自推账本**：从候选者的 clone（bridge live summary 的 `worktree.path`，否则绑定的 `workspaceCwd`）跑 `cloneWorktreesOf`，然后 `vouchedScanRoots`、`autofixPrPaths`、`readState`，仅在 `sameRepository` 与 `sessionId` 匹配时接受。untrusted primary 仅用坐标——其检出里不跑 git。任何拒绝意味着无账本、转换照常投递。
- **actions**：不填充。`sessionPrWatch.actions` 属 PR B；drain 的空 map 归一化已把缺失的 map 当作通用 prompt。

### 5. listing 写入、listedKeys 与 partial

refresh 的 slim listing 已知每个被列出 PR 的 state。在同一门控下、且仅当 daemon 持有 owner 记录时，在该 PR 的 per-PR 锁内把 `state` 与 `observedAt` 写进其 watch 文件——与观测相同的原子写，无文件时静默初始化。把被列出的键收集为 `listedKeys` 传给观测，使 listing 已返回的 closed PR 离开 view 轮转（主 §1）。

把绑定扫描的 `partial` 标志透传进观测选项。观测今天不做负面决策，但 drain 已经做，且该标志必须来自同一次扫描而不是重新计算。drain 调用方的 `coveragePartial`（#16656 新增）保留：它覆盖 `listAll()` 略过的 registry 条目，那是扫描自身标志看不到的。

## 涉及文件

| 文件                                                             | 改动                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/cli/src/serve/server/session-restore.ts`（新）         | 共享 restore 核心、typed error、`release()`、可选 `isCancelled` 与 `onRestored` |
| `packages/cli/src/serve/routes/session.ts`                       | 路由委托给共享核心；保留解析、runtime 解析、telemetry、断连检查、响应 shaping   |
| `packages/cli/src/serve/server/pr-watch-drain.ts`                | drain state 上的 `idle()` 落定信号，以及 `stopPrWatch`（停止、等待、再释放）    |
| `packages/cli/src/serve/server/pr-watch-store.ts`                | `releaseOwnedPrWatchSync`：只释放本进程持有的记录                               |
| `packages/cli/src/serve/server/pr-watch-gh-hosts.ts`（新）       | 枚举 daemon 的 `gh` 已配置 hosts                                                |
| `packages/cli/src/serve/server/pr-watch-deps.ts`（新）           | 构建观测与 drain 的 deps：hosts、准入、restore 映射、账本                       |
| `packages/cli/src/serve/run-qwen-serve.ts`                       | 经 late-bound getter 填充两个接缝；注册关停 drain                               |
| `packages/cli/src/serve/serve-app-lifecycle.ts`                  | 形状不变；新 drain 经既有 `addAppDrain` 注册                                    |
| `packages/cli/src/serve/server/session-pr-refresh.ts`            | listing→watch 写入、`listedKeys`、`partial` 透传；`stopWatch` 与 tick 落定信号  |
| `docs/design/2026-11-09-daemon-pr-watch-enablement.md`（+zh-CN） | 本设计                                                                          |

## 关键设计决策

1. **抽取核心，而非 handler。** res 耦合部分是 drain 不共享的路由与 wire 关注点。抽取它们会为进程内调用者到不了的失败发明 typed 变体，并让约 70 条 HTTP 响应形状测试承担无谓风险。
2. **restore 边界用 typed error，而非结果联合。** 类已存在，`sendBridgeError` 已映射它们。drain 的适配器按类分拣，因此 Gone/临时划分只存在于一处，不会与路由的 wire 映射漂移。
3. **钩子不等待，且在锁释放之后运行。** 这是死锁避免而非优化：per-PR 锁不可重入，而 drain 的 restore 路径会重新取它。
4. **owner 记录最后释放，且两条臂都要等。** 停 timer 不够；持有 claim 的 observation tick 与在途 restore 与准入都必须先落定，否则后继者与它们重叠。只等 drain 空闲会漏掉 observation——它从不进入 drain tick。
5. **host 发现向已知安全集失败开放，绝不向空集。** 空的 allowed-host 集会静默禁用所有 view，却看起来健康。
6. **仍然关闭。** 每条新路径都在既有开关与「PR B 前不填充」的设置之后，因此本增量不改变任何生产行为。

## 约束与风险

- restore 抽取是风险最高的改动：对一个 650 行闭包做字节等价重构，约 70 条 HTTP 测试外加 worktree、multi-workspace 与 prompt-terminal 套件钉住它。路由必须保持完全相同的状态码、响应字段与 `Retry-After` 头。
- 关闭态 parity 必须成立：开关关闭时不 claim、不 view、不写 watch、不准入、不 restore，且从未 claim 的 daemon 不尝试释放 owner 记录。
- `run-qwen-serve.ts` 位于 serve 快路径的 pre-listen 闭包内。新 deps 模块绝不能把 SessionService 链拉进该静态闭包；refresh timer 既有的动态 import 边界是范本。
- lifecycle 等待必须有限：挂起的 restore 不能把 shutdown 拖过 controller 的 deadline。

## 验证计划

- 单元（共享 restore）：核心返回被恢复会话与释放句柄；typed error 原样传播；`isCancelled` 触发与断连相同的清理；`onRestored` 在锁释放后触发且不被 await。
- 路由 parity：既有 load/resume、worktree 分类、prompt-terminal、multi-workspace 与 REST 契约套件原样通过——它们是字节兼容的判据。
- 单元（wake 映射）：每个 Gone 码映射为 `gone`，每个临时码映射为 `unavailable`，成功映射为带「恰好 detach 一次」release 的 `restored`。
- 单元（钩子）：resume 会 drain 该会话绑定的 PR；挂起的 drain 不拉长 restore；per-PR 锁绝不被重入。
- 单元（lifecycle）：close 停 timer、等在途工作、然后释放记录；挂起的 restore 超时而非阻塞；非 owner 不释放。
- 单元（hosts）：无 channel 时只有 `github.com`；`hosts.yml` 条目；托管 channel 的企业 web origin；非受信 workspace 的 channel 不贡献；读取失败降级为已知安全集并记日志。
- 单元（listing）：被列出的 closed PR 离开 view 轮转；listing 的 `state` 写入静默初始化并取得 per-PR 锁；`partial` 到达 drain。
- 关闭态 parity：开关关闭时新接缝一个都不被读取，refresh 不变。
- 真实场景：扩展既有 POSIX 场景套件，经 drain 的 `wakeSession` 驱动真实共享 restore，并加一个真实关停顺序探针。

## 验收标准

1. 开关关闭时，生产行为与 API 量不变；不读取任何新接缝。
2. 路由 HTTP 行为逐字节兼容：每条既有 load/resume 测试无需修改即通过。
3. 开关打开（测试）时，休眠接收者经共享核心被恢复、获投递，且其 registration 在 prompt 落定后释放。
4. `wakeDormant: false` 的条目在会话下一次 resume 时被消费。
5. 关停停止 watch、等待在途工作，然后才释放 owner 记录。
6. slim listing 已返回的 closed PR 不再被 view；listing 的 `state` 到达 watch 文件。
7. view 只发往 allowed hosts；任何其他主机上的绑定不引发 `gh` 调用。

## 开放问题

- 继承自主设计（默认开启时机、`cancelled`/`stale` CI 谓词、手动 push 账本）；此处均不决定。
- `gh` hosts 枚举是否应跨 tick 缓存。拟议：每次构建 deps 时读一次，因为 daemon 运行期间新增主机是运维动作，重启已覆盖；若 PR B 的别名需要实时 channel 托管变化再议。
