# GitHub channel：API 预算感知与 mention 车道保护

[English](2026-11-09-github-channel-budget-awareness.md)

- Issue：#16690
- 状态：提议中
- 相关：#16665（去掉冗余的 CI 聚合请求）、#16691 / #16692（互为替代的监视传输削减方案）

## 问题陈述

GitHub channel 用一个具有固定每小时 REST 预算的令牌轮询 GitHub（经典 PAT 为 5,000 次/小时）。两个结构性事实把这个预算变成了用户可见的问题：

1. **PR 状态监视在每轮轮询中跑在通知车道之前。** `pollOnce` 先 reconcile 待处理 watch 事件、运行 `runPrStateWatch`，之后才处理通知（mention、review 请求、评论）。当监视把预算花到一个限流应答时，同一轮里交互式的 mention 处理——以及重置前的后续轮次——正是失败的那部分。最不紧急的工作（对通常并未变化的 PR 做后台状态轮询）饿死了最紧急的工作（有人请 bot 做事）。
2. **channel 在成功路径上对预算是盲的。** `x-ratelimit-remaining` 只在 `githubApi` 的 catch 块与限流分类器（`rateLimitRemaining`、`isRateLimitAnswer`、`isDefiniteNoWriteGithubError`）里被读取，而它们全都接收一个*错误*。成功响应携带同一个头，但没有东西记录它。因此 channel 无法在撞墙之前减速——它只在请求已被拒绝之后才反应。

### 当前状态（已在 `main` 上核实）

- `githubApi<T>(fn, label, retries, shouldRetry, signal)` await `fn()` 并返回其值；出错时检查 `e.response.headers` 做退避。`fn()` 各调用点返回不同形状——`octokit.paginate(...)` 解析为数组，`octokit.rest.pulls.get(...)` 解析为 `{ data, headers, ... }`——因此包装器无法从返回值统一读取成功头。
- `rateLimitRemaining(err)` 及其同类只处理错误；没有存储的「上次已知剩余额度」。
- watch 回合在 `pollOnce` 处由 `this.prWatchEvents.size > 0 && !this.boundRefreshFailed` 门控，随后 `runPrStateWatch` 把扇出上限设为 `prWatchLimit`（默认 30）。没有预算门。
- 降级但存活的条件经 `recordPollDegraded(reason, detail?, error?)` 记日志，它发出一行 `type: 'poll', outcome: 'degraded'`。现有 reason 是边沿触发的（如 `watchReconcileBlockedCause`），因此永久条件不会把有用行转出日志。

## 期望行为

- 从**每一个**成功的 GitHub 响应记录剩余 REST 预算，在一个 choke point 处，无论调用返回什么形状。
- 当上次已知剩余预算处于或低于预留阈值时，**本轮跳过 watch 回合**，让通知车道保住剩余预算。watch 是尽力而为的边沿触发检测；跳过一轮只是延迟检测，不丢失任何东西（基线与 pending 队列都是持久的）。
- 把跳过记为降级 poll 行，边沿触发；预算爬回阈值之上时记 recovery。
- 绝不让一个过期的低读数永久饿死 watch：一旦预算窗口的重置时间已过，该读数就是过期的，不得据此门控。

## 按组件划分的拟议改动

### 1. 单个响应 hook 记录预算

在 `connect()` 里构造客户端之后，立即注册一次 `octokit.hook.wrap('request', ...)`。包装器 await 真实请求，从响应头读 `x-ratelimit-remaining` 与 `x-ratelimit-reset`，存到适配器上，原样返回响应。已对照已安装的 `@octokit/rest`（before-after-hook 3.0.2）核实：wrap 回调在每个请求上都能看到响应头，包括 `paginate` 调用的每一页，因此这确实是一个 choke point，且与 `fn()` 的返回形状无关。

适配器新增状态：

- `lastRateLimitRemaining: number | undefined`
- `lastRateLimitResetAt: number | undefined`（epoch 毫秒；`x-ratelimit-reset` 是 epoch 秒）

这里只关心 `core` REST 资源；REST 响应上的该头报告的就是 core 池。GraphQL 超出范围（#16692）。

### 2. 预留阈值门控 watch 回合

新增配置字段 `prWatchBudgetReserve`（描述符：number，可选），设定为通知车道留回多少请求。默认值选得让健康的 5,000/小时令牌不受影响，而接近耗尽的令牌保护 mention。拟定默认：**200**。理由见「已定决策」。

`pollOnce` 里的门，替换当前 watch 条件：

- 计算 `budgetLow` = `lastRateLimitRemaining !== undefined && lastRateLimitRemaining <= reserve && !resetHasPassed`。
- `resetHasPassed` = `lastRateLimitResetAt !== undefined && Date.now() >= lastRateLimitResetAt`。来自一个已重置窗口的读数是过期的，不得据此门控。
- 若 `budgetLow`，本轮跳过 `runPrStateWatch()` 并记降级边沿。通知车道照常运行。

watch 现有的 `isWatchFailFastError` 行为（在 403/429 处中止回合）保留，作为「估算错误或二级限流在名义还有额度时命中」的后盾。本改动是那个反应式后盾*前面*的*主动*层，不是替代。

### 3. 边沿触发记日志

仿照 `watchReconcileBlockedCause`：一个 `watchBudgetCause: 'low' | undefined` 字段。在第一个低预算轮次（且仅在边沿）发出 `recordPollDegraded('watch_budget_low', { remaining, reserve })` 与一行节流的 stderr。当预算恢复到阈值之上（或窗口重置）时，发一次 `recordPollDegraded('watch_budget_recovered')` 并清除 cause。这让永久低预算条件不会灌满日志。

## 关键设计决策

| 决策                              | 理由                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用 hook，而非逐调用点读头         | 一个 choke point；与形状无关；覆盖分页各页。替代方案（把头部捕获穿过每个 `fn()`）要碰十几个调用点，还漏掉 paginate 的数组形状。                                            |
| 跳过整个 watch 回合，而非收缩扇出 | watch 是尽力而为、边沿触发的；跳过一轮只延迟检测。收缩扇出仍会在错误的车道上花*一些*预算，还引入部分公平性问题（哪些 PR 拿到被削减的名额）。跳过更简单，且保护完整的预留。 |
| 门控依据上次已知剩余 + 重置时间   | 该头权威且免费。重置时间感知防止一个过期低读数在窗口翻转后继续饿死 watch。                                                                                                 |
| 预留是阈值，不是速率预测器        | 预测每轮开销很脆（扇出与 CI 页数会变）。固定预留是清楚、可测的契约：「为 mention 至少留 N 个请求」。                                                                       |
| 保留 `isWatchFailFastError`       | 估算可能错（二级限流、共用令牌的其它消费者）。反应式中止仍是后盾。                                                                                                         |

## 受影响文件

- `packages/channels/github/src/GithubAdapter.ts` — hook 注册、预算状态、门、记日志、配置字段 + getter。
- `packages/channels/github/src/index.ts` — `prWatchBudgetReserve` 描述符字段。
- `packages/channels/github/src/GithubAdapter.test.ts` — hook mock；记录/门控/恢复/过期重置的单测；一条证明 hook 记录头部的真实分页用例。
- `docs/users/features/channels/github.md` — 记录该字段与 mention 车道保护。
- 本设计文档 + 其中文孪生。

## 范围边界

- **在内：** watch 回合的主动预算门、成功路径预算记录、降级记日志、一个配置旋钮、文档。
- **在外：** 独立凭证建议是部署/文档动作，在 issue 里跟踪但此处不作代码改动（`token` 字段已存在）。ETag（#16691）与 GraphQL（#16692）是独立、互斥的传输改动。不改通知车道自身行为、发布重试、或 `githubApi` 的退避。
- 该门只影响 watch 回合。`prWatchEvents` 为空时该功能惰性（无 watch 可跳过）。

## 已定决策

1. **默认预留 = 200，绝对值，可配置。** 维护者选了固定绝对值而非按 limit 比例。200 ≈ 5,000/小时预算的 4%：够几轮 mention 流量，几乎不削减健康的 watch。该字段可由运维者按其它量级调整。按 limit 比例的方案（用于 GitHub Enterprise / 非 5,000 令牌）明确延后——此类部署的运维者手动设 `prWatchBudgetReserve`。
2. **验证深度：单测 + 构建/类型/lint + 变异，不做 E2E/tmux。** 维护者选此是因为该改动是适配器内部、无 TUI 表面。覆盖：记录/门控/恢复/过期重置的单测、一条在链路上证明 hook 记录头部的真实分页用例、以及证明每个新守卫承重的变异 sweep。`npm run build`、`typecheck`、聚焦 vitest、eslint、prettier。

## 开放问题

1. **`hook.wrap` 与测试 mock。** 单元 mock 没有 `hook`；必须给它加一个 no-op `hook.wrap` 使 `connect()` 不抛错，真实分页的链路 oracle 用例则跑真实 hook。确认没有其它测试构造不带 hook 的客户端。（实现细节，Phase 5 解决。）
