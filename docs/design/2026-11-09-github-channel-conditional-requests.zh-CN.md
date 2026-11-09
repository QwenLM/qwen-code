# GitHub channel：轮询使用条件请求

[English](2026-11-09-github-channel-conditional-requests.md) | [简体中文](2026-11-09-github-channel-conditional-requests.zh-CN.md)

状态：提案。实现 #16691。基线：`main` 的 `56ea1bc3fbb`。

## 问题陈述

GitHub channel 不发送任何条件头。即使什么都没变，每轮轮询也照付主速率限制的全价。按默认 60 秒轮询、`DEFAULT_PR_WATCH_LIMIT = 30` 计，仅 PR 状态监视一项每小时就发出约 1,800 个请求——超过 5,000 次/小时预算的三分之一，花在确认「什么都没发生」上。

在请求携带正确认证的前提下，GitHub 不会把 `304` 计入主速率限制。channel 目前还忽略了通知端点返回的 `X-Poll-Interval` 头。

## 现状

已对照上述基线核实：

- `GithubAdapter.ts` 构造 Octokit 时只传 `auth`、`baseUrl` 与可选的 `request.agent`。整个 channel 没有任何 ETag 处理。
- 唯一的 `hook.wrap('request', …)` 只调用 `recordRateLimitBudget`，由 #16701 引入，是成功路径上的预算汇聚点。
- `watchOnePr` 每轮为每个被监视 PR 发一次 `pulls.get`，外层是 `githubApi(…, 3, (err) => !isWatchFailFastError(err))`。
- 通知通道调用 `octokit.paginate(listNotificationsForAuthenticatedUser, { since, per_page: 100 })`。`since` 取 `cursor.lastProcessedAt − 1s`，因此**空闲时是稳定的**，只在有新通知被提交时才前进。
- `githubApi` 会重试任何抛出的错误，除非 `shouldRetry` 另有判断。冒泡到它的 `304` 会被当作可重试失败。
- CI 复查是按时间的（`CI_RECHECK_INTERVAL_MS`、`CI_PENDING_RECHECK_INTERVAL_MS`、`CI_NONE_GRACE_MS`）。代码中已经写明 GitHub 不会因 check 活动推进 `updated_at`。
- `PollingChannelBase.pollInterval` 是一个 protected getter，钳制在 `[MIN_POLL_INTERVAL_MS, MAX_POLL_INTERVAL_MS]`，默认 60,000 毫秒。

### 依赖栈的实测行为

以下结论是对已安装依赖与真实 API 打探针得到的，不是从文档推断的。

| 探针                                                   | 结果                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@octokit/request` 的 fetch-wrapper 遇到 `304`         | 硬编码 `throw new RequestError("Not modified", 304, …)`，且发生在 `plugin-request-log` 自己的 `hook.wrap` 内层。                                         |
| 在适配器注册的 `hook.wrap` 里捕获 `304` 并返回缓存响应 | 可行；`rest.pulls.get` 正常兑现，`paginate` 也能沿缓存的 `link` 走完整条全 `304` 的分页序列。                                                            |
| 该捕获方式的副作用                                     | `plugin-request-log` 位于内层，其 `.catch` 仍会先执行 `octokit.log.error("GET … - 304 …")` 再重新抛出。Octokit 默认的 `log.error` 就是 `console.error`。 |
| 真实 `GET /notifications?per_page=1`，`200`            | 返回 `link: <…page=2>; rel="next", <…page=298>; rel="last"`、`etag`、`x-poll-interval: 60`。                                                             |
| 同一 URL 带 `If-None-Match`，`304`                     | 返回 `etag`、`x-poll-interval: 60`、`x-ratelimit-remaining`、`cache-control`、`vary`——但**没有 `link` 头**。                                             |
| `@octokit/request` 与 `request.agent`                  | 已安装的 fetch-wrapper 从不读取 `request.agent`；它只转发 `method`、`body`、`redirect`、`headers`、`signal`、`duplex`。                                  |

「`304` 不带 `link`」是其中承重的发现。若用 `304` 自身的头去构造响应，`paginate` 会在第 1 页之后停止，静默丢掉剩余的 297 页通知。

## 目标

- 未变化的 `pulls.get` 与通知响应不消耗主速率限制。
- 对通知端点遵守 `X-Poll-Interval`。
- 不改变观测什么、事件如何判定，以及 CI 复查何时触发。

## 范围边界

- 条件头只应用于 `pulls.get` 与通知列表。Checks、评论、评审以及所有写操作都不改动。
- 缓存是内存态、按连接持有的。不做持久化；重启后的首轮轮询是一次完整 `200`。
- #16692（GraphQL 批量）继续延后。两个 issue 上的 triage 已为监视路径选择了本 issue。
- 失效的 `request.agent` 代理选项是既有状况。本改动既不修复也不使其恶化：注入的 `fetch` 以完全相同的 init 转发给 `globalThis.fetch`。

## 方案

### 传输层

构造 Octokit 时把 `request.fetch` 设为一个适配器方法，由它持有条件交换：

1. 只有 URL 匹配 `pulls.get` 或通知列表的 `GET` 请求参与。其余请求原样转发。
2. 缓存键是完整请求 URL，含查询串，因此移动后的 `since` 游标是另一个条目，而不是假命中。
3. 命中缓存时请求携带 `If-None-Match`。
4. 带 `ETag` 的 `200` 在返回响应之前存下 body 与 `Link` 头。
5. 有缓存条目的 `304` 用一个合成 `200` 应答：body 是缓存 body，头是**新鲜的 `304` 头**，而当 `304` 省略 `Link` 时，`Link` 取**缓存的 `Link`**。
6. 没有缓存条目的 `304` 不可能出现在本层发出过条件头的请求上；这种情况原样转发，不做猜测。

现有的 `hook.wrap('request', …)` 预算记录器保持原样。它看到的是携带新鲜 `x-ratelimit-*` 头的合成 `200`，因此 #16701 的预算感知无需修改即可继续工作。

### 轮询间隔

`GithubAdapter` 覆写 protected 的 `pollInterval` getter，返回基础间隔与最近一次观测到的 `X-Poll-Interval` 中的较大者，并以 `MAX_POLL_INTERVAL_MS` 封顶；后者在现有 request hook 中从响应头读取。

这个封顶与基类的钳制不重复。基类钳制的是**配置值**的两端；而该头由服务端控制、在那次钳制之后才到达，因此用它抬高间隔会重新打开上界。Node 会把超过其 32 位范围的超时向下取整为 1 毫秒，那会让轮询循环变成热循环，烧掉本改动想省下的配额。

### 监视与 CI

`watchOnePr` 不作改动。`304` 交付的 body 与上一次 `200` 逐字节相同，因此 `headChanged` 为 false、`prUpdatedAt` 等于保留值，按时间的 CI 条件继续按自己的节奏触发。

## 设计决定与理由

### 拦截点放在 `request.fetch`，而不是 `hook.wrap`

本 issue 的 triage 建议在 request hook 里把 `304` 当作缓存 body 复用。这可行，但探针表明 `plugin-request-log` 位于任何适配器注册的 wrap 的内层，会在重新抛出之前把每个 `304` 记为 `error` 级别。按默认轮询频率，那是每小时约 1,800 行纯噪声的 `console.error`。Octokit 没有提供把 wrap 注册到其内置插件内层的方法。

在传输边界把 `304` 转换掉，意味着其上的任何一层都不会知道曾有 `304`：没有错误日志、不与重试交互、也不经过 `githubApi`。

### 缓存存 HTTP body，而不是派生的监视状态

`PrWatchEntry` 持久化的字段足以重建一次观测，issue 也建议复用它们。但改为重建一个 PR 形状的对象，会把缓存耦合到 `watchOnePr` 今天恰好读取的那组字段（`head.sha`、`updated_at`、`mergeable`、`mergeable_state`、`state`、`merged`、`title`）。其中两个——`merged` 与非 null 的 `mergeable`——根本没有被持久化。缓存响应 body 彻底避开这层映射，也不会在监视日后读取新字段时失配。

### 从缓存承接 `Link`，且只承接 `Link`

实测的 `304` 省略 `Link`。用缓存头整体重建合成响应会带来 `content-encoding` 与 `content-length` 过期的风险；只取 `Link` 是保持分页正确的最小承接量。其余每个头都来自新鲜的 `304`，因此 `x-ratelimit-*` 与 `x-poll-interval` 绝不会以过期值提供。

### `X-Poll-Interval` 会放慢整个轮询循环

基类对整轮轮询只暴露一个间隔，而监视通道排在通知通道之前。因此通过抬高该间隔来遵守这个头，也会同时放慢监视。另一种做法——只跳过通知拉取——需要在 `pollOnce` 中段穿过其游标与延迟机制做一次提前返回，改动更大也更冒险。

在默认 60 秒轮询下该头也是 60，因此没有任何变化。只有配置了更快轮询的操作者会受影响，而 GitHub 正是明确要求他们放慢。这个后果被写进文档，而不是隐藏起来。

### 缓存有界且按连接持有

移动后的 `since` 游标会不断产生新键，因此无界的 map 会在进程生命周期内持续增长。缓存超过固定条目上限时按最旧优先淘汰，并拒绝存储超过固定大小的 body；被拒绝的 URL 只是保持无条件请求，也就是改动前的行为。缓存在 disconnect 时清空，因此重连绝不会提供在上一个凭据下缓存的 body。

## 涉及文件

| 文件                                                 | 改动                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/channels/github/src/GithubAdapter.ts`      | 条件 `fetch`、缓存、`X-Poll-Interval` 采集、`pollInterval` 覆写。 |
| `packages/channels/github/src/GithubAdapter.test.ts` | 同目录测试，含一个传输层的链路计数基准。                          |
| `docs/users/features/channels/github.md`             | 记录该行为与轮询间隔的后果。                                      |

不改配置描述符：本特性没有新增面向操作者的选项。

## 约束与风险

- **`Link` 承接的正确性是首要风险。** 这里回归会静默丢弃通知，而不是响亮地失败。它需要一条「移除承接就会变红」的测试。
- **ETag 的权威性。** 本设计信任 GitHub 的 `ETag` 在表示变化时必然变化，包括惰性计算的 `mergeable` 落定时。如果 GitHub 曾在真实变化前后提供同一个过期 `ETag`，监视就会漏掉它。这与所有条件请求客户端对平台投入的信任是同一种。
- **预算记账。** `304` 仍会返回 `x-ratelimit-remaining`；合成响应必须携带新鲜值而非缓存值，否则 #16701 的门会基于过期预算做判断。

## 验证计划

- `GithubAdapter.test.ts` 中的单元测试覆盖：第二轮轮询发出条件头；`304` 由缓存提供且不进入 `githubApi` 重试；`ETag` 变化后返回 `200`；缓存以含 `since` 的完整 URL 为键；disconnect 时清空缓存；条目与 body 大小上限。
- 一条回归测试，让多页通知序列完全经由 `304` 驱动，并断言每一页仍被返回——这是 `Link` 承接的变异见证。
- 一条测试，在若干轮轮询中保持 PR body 不变，并断言 CI 复查在其间隔到达时仍然触发。
- 一条传输层测试，使用真实 Octokit 注入 `fetch` 并统计实际请求数，使断言无法被 mock 掉的 `paginate` 满足。
- `npm run build`、`npm run typecheck`，以及该包的定向测试文件。

## 验收标准

- 一个安静的被监视 PR 花费一次 `200` 加若干 `304`，且这些 `304` 不推进主速率限制。
- 当每一页都应答 `304` 时，多页通知列表仍被完整返回。
- 在全 `304` 序列期间，CI 复查按既有节奏触发。
- 没有任何 `304` 产生 error 级别日志。
- 轮询间隔绝不快于最近一次的 `X-Poll-Interval`，且无论该头多大都绝不超过 `MAX_POLL_INTERVAL_MS`。
- 既有的监视、通知与预算测试保持全绿。

## 待定问题

- 条目上限与 body 大小上限是否应当可由操作者配置。倾向：不，先保持为内部常量，直到某个部署表明需要。
- 本项落地后是否把条件请求扩展到评论与评审通道。倾向：先测量；两者都已按游标设门，并非主要成本。
