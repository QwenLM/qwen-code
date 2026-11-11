# Daemon PR watch：观测与转换检测

[English](2026-11-08-daemon-pr-watch-observation.md) | [简体中文](2026-11-08-daemon-pr-watch-observation.zh-CN.md)

状态：proposed（2026-11-08）。本增量是 [PR state transitions from the daemon PR refresh](2026-11-04-daemon-pr-state-transitions.md)（下称「主设计」）的下一步，仅实现 §1 观测与 §3 转换检测；投递（§4–§5）、配置（§6）与 channel 迁移（§7）不在本增量内。

## 问题

主设计的地基已合入：per-PR watch store 及其 owner record（#16590）、单 PR `gh pr view` 抓取与导出的 `aggregateChecks` rollup（#16530、#16545）、`@qwen-code/channel-base` 中共享的 bound-session prompt/模板契约（#16523、#16576）、以及抽取出的 prompt admission（`routes/session-prompt-admission.ts`）。但还没有任何代码观测绑定 PR 的 head、CI 或 mergeability，也没有任何代码检测转换：`session-pr-refresh.ts` 仍只为侧栏重写 sidecar 的 `state` 与 `issues`。因此 store 尚无写入方。

## 现状

- `refreshWorkspaceSessionPrStates`（`packages/cli/src/serve/server/session-pr-refresh.ts`）扫描一个 workspace 的 sidecar，跑精简 `gh pr list --state all` 取 `state`、一次 closing-issue 查询、以及 Aone 的 capped view 循环。它没有 head/CI/mergeability 观测，也不访问 watch 文件。
- `startSessionPrRefreshTimer` 在 `running` 守卫后顺序遍历 trusted workspace，推进每 workspace 的 Aone offset。它不计算 tick 级 deadline，也不扫描 untrusted primary。
- `fetchGitHubPullRequestView(url, cwd, env?)`（`packages/core/src/utils/github-prs.ts`）返回 `{ url, title, headSha, state, mergeable?, checks, failingChecks }` 或类型化的失败；它不做 host 检查（调用方必须先限制 host）。
- `pr-watch-store.ts`（#16590）提供 `readPrWatchStateSync`、`writePrWatchStateSync`、`deletePrWatchStateSync`、owner-record claim/release 与上限；其 read/write 自身不持锁。
- 进程内 bindings scan（`routes/session-pr-bindings.ts` 的 `scanWorkspaceBindings`）产出带 `partial` 标志的 `SessionPrBindingSummary[]`；目前仅由 route handler 调用。

## 目标

- 通过按 URL 的一次 `gh pr view` 观测每个绑定 PR 的 head、CI rollup 与 mergeability，遵循主设计 §1 规则（视图集、cap 30 轮转、tick 级 deadline、allowed hosts、workspace 环境、daemon 私有工作目录、跨 workspace 每 tick 去重、untrusted-primary 仅视图）。
- 对照 PR 的 watch 文件检测四种转换（§3），并在该 PR 的 `PathMutexRegistry` 锁内，以一次原子写持久化新观测、`ciFired` 与 `pending` 条目。
- 整条路径置于一个保持 **off** 的内部开关之后：开关关闭时 refresh 不跑视图、不写 watch 文件，其行为与 API 量不变（主验收标准 4）。不读取 `sessionPrWatch` 设置。

## 非目标（本增量）

- 投递与 drain（§4–§5）：`pending` 条目会被写入但永不被 admit；recipient 解析、共享 restore、自推抑制与 role-aware actions 留下一增量。
- 配置（§6）与 channel 迁移/别名（§7）。
- watch 文件删除与 `lastBoundAt` 维护（§2）：删除需要 drain 的 scan-completeness 规则；本增量只创建与更新文件。owner-record claim 会被接线，使非 owner 不观测任何东西。
- serve-lifecycle close 重排（§2）：由于没有 drain 或 restore 在途，目前没有任何在途工作需要在移除 record 前停止；claim/release 已存在。
- `run-qwen-serve.ts` 中 daemon 级 watch deps 的提供（从 `gh` 配置 host 与托管 channel 的 web host 发现 allowed hosts、lock registry、watch dir）：timer 暴露 `getPrWatchDeps` 接缝，但填充它只有在开关开启后才会被用到，故随启用增量落地。开关关闭时该接缝永不被读取。
- 观测与 refresh 精简 listing 的耦合：扫描接受 `listedKeys` 集合（并有测试），使 listing 已返回的 closed PR 不被重复 view；主 §1 还要求 listing 把 merged/closed PR 的 `state`/`observedAt` 写入 watch 文件。编排者自身不跑 listing；启用增量已把它接通，因此 refresh timer 现在按 workspace 把 `listedKeys` 带进下一个 tick，listing 也会把 `state`/`observedAt`——以及它所替代的那次 view 本会触发的 `state_change`——写入 watch 文件。被 listing 覆盖的 closed 绑定不再被重复 view；未覆盖的仍然会，以便捕捉 reopen。

## 提议改动

### 新模块 `packages/cli/src/serve/server/pr-watch-observation.ts`

两层，均可在无 daemon 下单测：

1. **纯检测** — `detectPrTransitions(identity, previous, observation, detectedAt)`：
   - 输入：上一个 `PrWatchState`（首次观测为 `undefined`）、一次新观测（`state`、`title`、`headSha`、`checks`、`mergeable?`、`failingChecks`）、以及观测起始时间戳。
   - 输出：要写入的下一个 `PrWatchState` 与检测到的转换列表（`type`、`key`、`summary`、`detectedAt`）。
   - 规则严格依主 §3：`headSha` 不同触发 `head_change`；`checks` 为 `failing`、同一 head 的上一次观测并非 failing、且该 head 不在 `ciFired` 时触发 `ci_failure`（追加，cap 16）；边缘触发进入 `conflicting` 触发 `merge_conflict`（一旦存在 `headSha`，从未已知的 `mergeable` 视为非冲突）；`state` 离开 `open` 触发 `state_change`。
   - 首次观测（无先前文件，或无 `headSha` 的 slim-only 文件）静默初始化：填充字段且不触发任何转换。
   - `mergeable: UNKNOWN`（观测中缺省）保留存储值且不触发转换；no-overwrite 在构造下一个 state 时于此应用。
   - key 用主 §3 形状 `pr-state:<owner/repo>#<number>:<type>:<head or prev→next>:<detectedAt>`，当 key 加上最长角色组后缀（`:untyped`，8 字符）会超过 prompt 路由 200 字符 `idempotencyKey` 上限时哈希为 `pr-state:h:<40 hex>`——后缀在投递时（§4）追加，故基础 key 为其预留空间。

2. **观测扫描** — `observeWorkspacePrBindings(bindings, deps, options)`：
   - 从 scan 的 bindings 构造视图集：open 的绑定 PR 加上精简 listing 未返回的 closed PR；merged 按最新观测为终态。foreign-host 绑定在任何 `gh` 调用前跳过并记一行日志。
   - 将 host 限制在 allowed 集合（规范化小写、去 `www.`）：`github.com`、daemon `gh` 配置 host、以及托管的 GitHub channel 的 web host。
   - 按绑定 URL 跑 `fetchGitHubPullRequestView`，用 workspace 的 `effectiveEnv` 与 daemon 私有 watch 目录作 `cwd`，带轮转 offset 与 tick deadline；untrusted primary 的视图改用 daemon 自身环境（主 §1），使其检出里植入的凭据无法为 daemon 请求鉴权。cap（30）约束实际发起的视图数而非轮转窗口：本 tick 已被另一 workspace view 的 PR 被跳过且不占 cap，故跳过前缀之后的独有 PR 仍被观测（主 §1「跳过的 view 不占 cap」）。返回另一 host 或 number 的视图记日志并丢弃，重命名/转移的仓库（同 host 同 number、不同 `owner/repo`）被接受并每 tick 记一次日志（跨 workspace 去重使每个 PR 每 tick 只 view 一次）。每次 view 前断言 workspace 的 generation guard，使退役 generation 不会拿陈旧 env 跑 `gh`。
   - 对每个被接受的视图，在该 PR 的 `PathMutexRegistry` 锁内：读 watch 文件，丢弃起始早于文件 `observedAt` 的观测，跑检测，原子写下一个 state。absent/invalid 以外的读错使该 PR 本 tick 跳过（fail closed）。
   - 返回消耗的视图数（供 timer 轮转）与每 PR 失败隔离。

### `session-pr-refresh.ts` 与 timer 的接线

- 一个内部常量开关（off）门控观测路径；关闭时 `refreshWorkspaceSessionPrStates` 与 timer 的行为逐字节不变。
- timer 计算一个锚定在 tick 起点的 tick 级 deadline（refresh interval 的一半），并在状态 refresh 之前跑观测阶段，使耗时超过半个 interval 的 refresh 无法饿死观测的 deadline 窗口。它每 tick 轮转 workspace 顺序、按消耗视图数推进每 workspace 的 GitHub offset、并仅以视图扫描 untrusted primary。这些仅在开关开启时生效。
- 开关开启时跑 owner-record claim（从 config 读取有效事件集延后）；不持有 record 的 daemon 不观测任何东西。开关关闭时不尝试 claim。

### 涉及文件

| 文件                                                               | 改动                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `packages/cli/src/serve/server/pr-watch-observation.ts`（新）      | 纯检测 + 观测扫描 + 每 tick 编排                                                   |
| `packages/cli/src/serve/server/pr-watch-observation.test.ts`（新） | 检测规则、视图集/host/identity/轮转/deadline/去重、fail-closed 读、owner 门禁      |
| `packages/cli/src/serve/server/session-pr-url.ts`（新）            | `pullRequestKey`/`samePullRequest` 从 refresh 移出，与观测共享                     |
| `packages/cli/src/serve/server/session-pr-refresh.ts`              | off 开关常量；门控 timer 钩子（轮转顺序、GitHub offset、`getPrWatchDeps` 接缝）    |
| `packages/cli/src/serve/server/session-pr-refresh.test.ts`         | 既有套件确认 refresh 不变；新增 timer 级测试钉住 off 开关永不读取 `getPrWatchDeps` |
| `packages/cli/src/serve/routes/session-pr-bindings.ts`             | 导出 `scanWorkspaceBindings` 作为进程内 scan 入口                                  |
| `packages/cli/src/serve/run-qwen-serve.ts`（延后）                 | 随启用增量填充 `getPrWatchDeps`（allowed hosts、lock registry、watch dir）         |

## 关键设计决策

1. **检测纯函数化、与 I/O 分离。** 转换规则是最易回归的部分；隔离后可直接运行主 §3 验证清单，无需 daemon 或 `gh`。
2. **默认 off，置于内部常量而非设置之后。** 符合主 §7 PR A：在后继增量开启前任何 build 都不跑观测器；尚不读取设置。
3. **不投递、不删除。** `pending` 累积（受 store 上限约束）但永不 drain；删除与 `lastBoundAt` 等待 drain 增量，使 scan-completeness 规则在一处决定。
4. **复用而非重实现。** view 抓取、rollup、store、lock registry 与 prompt 契约均已合入；本增量只新增观测编排与检测。

## 约束与风险

- 开关关闭（如发布态）时无行为或 API 量变化；风险局限于新模块的测试与门控钩子。
- 观测扫描不得把 tick 拖过 deadline；cap、轮转 offset 与 tick 级 deadline 约束它，单个在途视图可能以其自身超时超出 deadline（主 §1）。
- 检测写入尚无人 drain 的 `pending`；store 的 16 条上限约束增长，直到投递增量落地。这可接受，因为每个 build 中开关都关闭。

## 验证计划

- 单元（检测）：首次观测静默；slim-only 文件静默填充；`head_change`；force-push 回访下每 head 一次 `ci_failure`（`A failing → B failing → A failing` 触发两次）；per-head 重置；边缘触发冲突；`UNKNOWN` 之后首次 `conflicting`；`CONFLICTING` 之后 `UNKNOWN` 保留且不触发；reopen → close；超长 key 哈希。
- 单元（观测）：视图集（closed-not-listed 被视图、merged 终态）；allowed hosts（foreign host → 无 `gh` 调用；`www.github.com` 等于 `github.com`）；identity（另一 host/number 丢弃；rename 接受）；cap/轮转（两次扫描覆盖 40 个，第二次回绕）；tick deadline；跨 workspace 每 tick 去重；fail-closed 读跳过该 PR；每 PR 失败隔离。
- Refresh：开关关闭 → 零 `gh pr view`、listing 数不变；开关开启用 fake view → 写 watch 文件、转换进 `pending`、不投递。

## 验收标准（本增量）

1. 内部开关关闭时，`refreshWorkspaceSessionPrStates` 与 timer 行为与之前完全一致：无 `gh pr view`、无 watch 文件写、无 claim。
2. 开关开启（测试）时，绑定 PR 的首次观测静默初始化其 watch 文件；随后的 head/CI/conflict/state 变化在该 PR 锁内追加正确的 `pending` 转换，`ci_failure` 每 head 一次。
3. 非 owner daemon 不观测任何东西；foreign-host 绑定不引发 `gh` 调用；返回另一 host/number 的视图被丢弃。
4. 本增量不投递任何转换、不删除任何 watch 文件。

## 开放问题

- 继承自主设计（默认开启、`cancelled`/`stale` CI 谓词、`review_decision`、Aone parity、手动推送账本）；此处均不决定。

## 已决实现选择

- 内部开关是模块常量 `SESSION_PR_WATCH_OBSERVATION_ENABLED`（off），门控 timer 钩子；timer deps 带一个默认取该常量的 `observationEnabled` 测试接缝，使夹具能覆盖 on 路径。生产不传该接缝，故由常量决定。扫描函数被导出并直接测试。仅翻转常量仍会 no-op，直到 `getPrWatchDeps` 被填充（fail closed）。
