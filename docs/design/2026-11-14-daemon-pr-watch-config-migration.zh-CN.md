# Daemon PR watch：配置与渠道迁移（PR B）

[English](2026-11-14-daemon-pr-watch-config-migration.md) | [简体中文](2026-11-14-daemon-pr-watch-config-migration.zh-CN.md)

状态：提案。本增量即母设计（[PR 状态跃迁](2026-11-04-daemon-pr-state-transitions.md)
§6 与 §7）所称的 **PR B**。下文每条代码引用都读自 `bbdca16b52`（`origin/main`），
也就是本分支的起点提交。

PR A 已完成：九个 PR 已合入（#16577、#16590、#16611、#16656、#16732、#16810、
#16834、#16847、#17032）。daemon 已拥有 watch store、观测、drain、共享 admission
与 restore，以及 deps 装配。内部开关 `SESSION_PR_WATCH_OBSERVATION_ENABLED` 仍为
`false`（`packages/cli/src/serve/server/session-pr-refresh.ts:82`），因此生产行为
未变，PR 监视仍全部由 GitHub 渠道适配器承担。

## 问题

操作员无法配置 daemon 的 PR watch，而 daemon 的 watch 从不运行。若只是把开关翻开，
两个轮询器会观测同一批 PR，所以设置、迁移与启用必须一起落地：母设计禁止任何构建
里出现两个投递者。

母设计 §7 有三条论断经不起读适配器代码，§6 还有一项成本未实测。本增量在实现前先
更正它们；每条更正都在**现状**里给出引用。

渠道投递在实践中滞后 PR 生命周期数天。撰写本设计期间，一个绑定会话收到十五条事件，
指向两个分别在三天前与四天前合入的 PR——head 变更、一次 CI 失败、合入通知、一份
其阻断发现早已修好的陈旧 `blocked` 验证报告，以及若干条作者自己回复的回声。只把
文件改名的退休方式既数不出、也解释不了这批积压。

## 现状

**适配器的 pass 是共同载体，不是只服务状态 watch 的函数。**
`runPrStateWatch`（`packages/channels/github/src/GithubAdapter.ts:7782`）在
`prWatchEvents` 非空**或** comment watch 活跃时运行，而 comment watch 随
`deliverToBoundSessions` 默认开启（`:7786-7792`，闸门在 `:3102-3106`）。预算闸自己
的注释写着「The gate covers the comment fetches too: they run inside the same pass
and spend the same budget」（`:3115-3117`）。删掉这个 pass 就等于删掉评论投递。

**状态文件也是共享的。** `PrWatchEntry` 在 watch 基线之外还携带 comment 游标
`commentBaseline`、`commentSince` 与 `commentLastFetchAt`（`:766-773`）。
`commentBaseline` 的注释写明它是「the first-observation cutoff (no backlog
delivery)」。按 §7 的提议把整个文件改名为 `.retired`，会丢掉这个 cutoff，让
comment watch 重新基线。

**`title` 只有一个写入者，读取者却在另一条路径。** 该字段注释为「so comment-watch
prompts can render %title%」（`:717-718`），唯一写入点是状态 watch（`:8176-8180`），
读取者却是 comment 投递路径（`:8512`）。因此移除状态 watch 会改变 comment 提示词，
而 §7 称其不变。用户页已为 comment-only 渠道记录了空值情形
（`docs/users/features/channels/github.md:562-564`）。

**没有字段级弃用机制。** `ChannelConfigFieldDescriptorBase` 只有 `key`、`label`、
`options`、`default` 与 `description`
（`packages/channels/base/src/types.ts:593-599`）。§7 的「Web Shell descriptor 标记
弃用」没有可抄的先例；最接近的既有形式是类型层 `@deprecated` JSDoc
（`types.ts:64`、`:86`）与描述文案。

**上限是三套机制，不是一套。** `prWatchLimit` 默认 30、可接受到 500
（`GithubAdapter.ts:575-578`，getter `:7745`），终态 PR 另加 20% 切片
（`:7947-7960`），预算保留额闸住整个 pass（`:588-591`、`:5817`）。

**跃迁有两个生产者。** `detectPrTransitions`
（`packages/cli/src/serve/server/pr-watch-observation.ts:95`）被 view 路径
（`:451`）与 listing 写入（`packages/cli/src/serve/server/session-pr-refresh.ts:283-305`）
调用。listing 这个生产者正是 #16847 补上的，因为该写入会抑制掉本会检测到这次关闭
的那次 view。

**drain 的两个配置接缝是死开关。** `PrWatchDrainDeps` 声明了 `actions` 与
`wakeDormant`（`packages/cli/src/serve/server/pr-watch-drain.ts:87-88`）并读取它们
（`:700`、`:795`），但 `createPrWatchDeps` 两者都不设
（`packages/cli/src/serve/server/pr-watch-deps.ts:210`）。全仓没有任何调用方设置它们。

**启动时快照看不到 hosted channels。** `channelWorkspaceGroups` 声明为 `undefined`
（`packages/cli/src/serve/run-qwen-serve.ts:4984`），只在 worker 提交选择
（`:10444`）或 listen 时（`:11118`）赋值，两者都晚于 refresh timer 的创建
（`:7821`）。现有 deps 因此每次调用都重读、并在签名变化时重建（`:7659-7684`）；
那里的注释说只构建一次「would freeze the allowed set before the channels commit at
listen」。该签名目前只覆盖 base-URL 列表。

**fast-path 摘要是结构白名单。** `ServeFastPathSettings` 声明
`serve?: { channels?: unknown; tokenQr?: unknown; maxSessions?: unknown }`
（`packages/cli/src/serve/fast-path-settings.ts:56`），picker 只搬这三个键
（`:697-721`）。只往 schema 加一个 `serve` 子键，`bootSettings` 看不到它。完整 boot
设置另行加载（`run-qwen-serve.ts:5459-5470`），且在 timer 创建前已就绪。

**今天没有任何 `serve.*` 设置带环境覆盖。** 最接近的 boot 期先例是
`advanced.runtimeOutputDir`（schema
`packages/cli/src/config/settingsSchema.ts:3840-3850`，读取点
`run-qwen-serve.ts:5530-5545`）。

**三条 action 校验规则已经存在。** `validateBoundActionEntries`
（`packages/channels/base/src/bound-session-prompt.ts:137-166`）拒绝未知键、空模板
与超过 `BOUND_ACTION_TEMPLATE_MAX_CODE_POINTS`（2,000，`:23`）的模板，词表是参数。
`boundActionTemplateEntries`（`:118`）刻意分离，以便生产者插入自己的前置条件。

**每 workspace 每 tick 三次扫描，而今天一次都没有。** `scanWorkspaceBindings` 被
观测（`pr-watch-observation.ts:544`）、listing 写入（`session-pr-refresh.ts:553`）
与 drain（`pr-watch-deps.ts:215` 经 `pr-watch-drain.ts:560`）调用。开关关着时三者
都不跑：listing 分支受 watch seam 门控，而该 seam 只在启用块内赋值。

**两套 host 口径并存。** `allowedHosts` 与 watch identity 用不带端口的裸 hostname，
且是刻意的（`pr-watch-deps.ts:141-150`）；而推送账本坐标用带端口、剥掉 `www.` 的
`host`（`pr-watch-deps.ts` 的 `readPushedHeads`）。

## 目标

1. 操作员能设置 `sessionPrWatch` 及其两个环境覆盖，且 daemon 的 watch 恰在有效事件
   集非空时运行。
2. `actions` 与 `wakeDormant` 抵达 drain，使角色化投递与休眠保留成为可配置项，而不
   再是死开关。
3. 配置了渠道 `prWatchEvents` 的操作员在升级后仍按 host 收到跃迁，为期一个 minor
   版本。
4. 适配器停止检测与投递 PR 状态跃迁，且没有任何构建同时跑两个轮询器。
5. 评论投递继续工作、保留其游标，其唯一一处用户可见变化被点名，而不是被暗示掉。

## 非目标

- 默认打开 watch。母设计决策 7 把这留作后续产品决策；本增量保持默认关闭。
- 改动 CI 谓词、跃迁规则、drain 的加锁、restore 并发或投递信封。这些由 PR A 定案。
- `review_decision` 跃迁、Aone 对等、手工推送账本（母设计 open questions 3、4、5）。
- 重写 comment 车道、其预算钩子或其 ETag 缓存。

## 提议的改动

### 1. `sessionPrWatch` 设置

在设置 schema（`packages/cli/src/config/settingsSchema.ts`，`serve` 段位于
`:335-401`）中新增 `serve.sessionPrWatch` 对象：`events`（四种跃迁类型的数组）、
`wakeDormant`（布尔，默认 true）与 `actions`（字符串映射，仅设置）。默认：无事件。

**该键是 operator-only**，与 `serve.maxSessions` 同类：它花费 daemon 全局的 `gh` 预算，
并向跨 workspace 的会话注入提示词，因此一个仓库不得为整个 daemon 打开它。别名（§5）是
被认可的按 workspace 路径，且受信任门控。

由此共有**四个**声明站点，而不是两个，漏掉任何一个都是静默死开关：

1. 摘要类型 `ServeFastPathSettings.serve`
   （`packages/cli/src/serve/fast-path-settings.ts:56`）；
2. picker（`:697-721`），走 `includeOperatorServe` 而**不是** `includeServe`；
3. 合并器 `mergeFastPathSettings`（`:781-790`），它今天只携带 `tokenQr` 与
   `maxSessions`，因此只加 picker 的键会在各作用域合并时被丢掉；
4. `WORKSPACE_RESTRICTED_SETTINGS`
   （`packages/cli/src/config/settingsUtils.ts:292-293`），其消费方是 workspace 剥离、
   「ignored」告警，以及拒绝写入的 daemon 路由。fast-path 读取器自己的 `ignoredKeys`
   上报（`fast-path-settings.ts:470-483`）会在 stderr 点名被丢弃的键。

daemon 读完整 boot 设置，它在 timer 创建前已完成合并。

`QWEN_SESSION_PR_WATCH_EVENTS` 与 `QWEN_SESSION_PR_WATCH_WAKE_DORMANT` 在 boot 期
覆盖设置，沿用 `advanced.runtimeOutputDir` 的 env 先行形状。它们经注入的环境记录
读取，不新增 `process.env` 访问，因此
`packages/cli/src/serve/process-env-guard.test.ts` 的每文件访问多重集保持不变；若
确实需要直接访问，则在同一改动里更新其 allowance 条目并写明理由。

无法识别的 `events` 成员只丢弃该项并告警，其余成员继续生效：坏列表只收窄监视，
清空整表会在 `explicit` 仍压掉别名的同时让监视彻底沉默。未知子键同样告警，而不是
让配置变成「explicit 但零事件」。两个环境覆盖都进入项目 `.env` 的排除表，与其它
daemon 全局键一致：被服务的仓库不得打开它的设置文件被禁止设置的监视。非法 `actions`
映射拒绝启动，与 `validatePolicyConfig`（`:692`，在 `:722` 与 `:734` 抛
`InvalidPolicyConfigError`）一致：一个静默关掉投递的模板笔误比一次响亮失败更糟，
而渠道对同样三条规则本来就抛错。

### 2. 启用即 deps 存在性

内部常量被**移除**，而不是翻成 `true`：一个恒真的常量就是死开关。有效事件集为空时
daemon 不构建 deps，而周期 tick 与按需 drain 本来就都以 deps 存在性为闸门——因此两个
入口**由构造保证一致**，而不是靠第二道可能与第一道漂移的闸门。测试接缝
`observationEnabled` 保留为「强制关」的覆盖。

这正是观测设计早已记录的 fail-closed 性质：只翻开关从来不会真的监视，直到 deps 接缝
被填充。#17032 的最后一条 Critical 是两个入口口径不一致；这里只有一个条件，无从不一致。

两条既有 parity 用例随闸门迁移而改。它们原先断言开关关着时**从不读**该接缝；现在闸门
会读它并发现未装配。断言因此变为「getter 被调用过」，这**更弱**，而它们原先直接钉住的
惰性现在由 `if (watchDeps)` 守卫结构性保证，该守卫由 on-path 用例与 `stopWatch` 用例
覆盖。这一点被点名，而不是掩盖。

### 3. 事件过滤只写一处，在探测器内部

`detectPrTransitions` 接收有效事件集，丢弃类型不在其中的跃迁。改为在两个调用点过滤，
会给一段残余漂移风险已在案的重复代码再加一根漂移轴（#16847 关于 listing ladder 的
评审线程拒绝了抽取，理由是 view 写整体 state 而 listing 写偏观测）。

`ciFired` 记账**不**跟着过滤：未订阅的 `ci_failure` 仍记录其 head，因此事后订阅不会
对一个早已 failing 的 head 补发。这与「首次观测静默初始化」的既有规则一致。

### 4. `actions` 与 `wakeDormant` 抵达 drain

`createPrWatchDeps` 把两者从解析后的配置透传下去。词表是四种跃迁类型；别名贡献键时
剥掉渠道的 `watch:` 前缀（§5）。不写新校验代码：用该词表调用既有的
`validateBoundActionEntries`。

### 5. 按 host 的别名

`sessionPrWatch` 未设时，每个 hosted GitHub 渠道为其 web host 上的 PR 贡献
`prWatchEvents` 与 `watch:*` actions，并沿用 `resolveChannelWorkspaceGroups` 已有的
信任门控。同一 host 上两个渠道取事件并集；每个类型的 actions 取自按名排序第一个订阅
它且能投递它的渠道，并记录一条冲突日志。`boundSessionActions` 非空的渠道在别名下保持
角色化，即使其键没有一个适用于状态事件。

别名沿用既有的重读与签名重建机制，且签名**扩展**为除 base URL 外还覆盖
`prWatchEvents`、`boundSessionActions` 与 `deliverToBoundSessions`。不做这个扩展，
操作员在 daemon 运行期编辑这些键将永不生效——正是 base-URL 签名当初要避免的冻结。

host 按 watch identity 的口径归并（裸 hostname、不带端口），因此别名与 `allowedHosts`
不可能不一致。同一 hostname 不同端口的两个渠道因此共享一个条目；这是 identity 的
推论，不是新规则。

别名生效时记录一次日志。若存在有效订阅而刷新 timer 未运行
（`QWEN_SESSION_PR_REFRESH_MINUTES=0`），启动时也告警一次；某个 PR 连续两次视图失败
后，每个失败连续段告警一次，点名该 PR 与错误类别：别名用的是 daemon 的 `gh`，不是
渠道 token，因此渠道能读的 PR 也可能拿不到事件。

### 6. 拆分适配器的 pass，而不是删除它

`runPrStateWatch` 保留其候选选择、每 PR 状态文件、预算闸与 comment 游标。去掉的是
状态跃迁的检测与投递：`watchOnePr` 的四个探测器、CI 重查间隔、
`fired`/`ciFiredSha`/`seq`/`pending` 这些 watch 字段、`watch:` 任务分支、
`prWatchLimit`、终态切片与 watch 预算保留额。comment watch 继续骑同一轮询。

去掉可配置上限也去掉了 comment watch 原先的 30 个 PR 扇出上限：每个绑定 PR 都会被
轮询，因此 5,000/小时的 PAT 会比以前更早触及其约 70–75 个绑定 PR 的额度上限。预
算闸仍会在剩余 200 时让出本轮，所以代价是跳过轮次、评论延迟，而不是请求被拒。这
与其余旋钮的移除一并接受；绑定很多的运维者可以调低间隔或关闭 comment watch。

`reconcilePendingWatch` 与订阅关闭时的 park 只为 watch pending 存在；它们在一次性
退休（§7）之后随之去掉。

### 7. 退休持久状态而不伤及 comment 车道

文件**不**改名。升级后首次 connect 时，适配器统计所有 entry 的未投递 `pending` 条目
数、把该计数记录一次，并从每个 entry 剥掉状态 watch 字段，同时保留
`commentBaseline`、`commentSince`、`commentLastFetchAt` 与 `title`。用一个哨兵文件
标记退休已完成，沿用 `migrateLegacyPublicationState`（`GithubAdapter.ts:6020-6048`），
使计数只记一次，且失败的退休会被重试而不是静默跳过。

持久化的 `watch:` 入站任务经 `retireBoundTask`（`:5332`）私有退休——它写死信、记日志
并移除任务，不走 comment 车道的公共兜底。

`title` 保留其最后一次观测值，不再刷新。因此同时开过两种订阅的渠道，其 comment 提示
词会渲染一个陈旧标题；从未订阅状态事件的渠道则如今天一样渲染空值。这是一处用户可见
变化，并按此记录文档（§8）；替代方案——让 comment 路径自己读一次 PR——会给一条本增量
承诺不增加开销的车道按 PR 增加一次 API 调用。

### 8. 弃用面

`connect()` 接受 `prWatchEvents` 与 `watch:*` 键，恰好记录一条点名 `sessionPrWatch`
的告警，且不跑状态检测。今天抛错的校验（`normalizePrWatchEvents`，
`GithubAdapter.ts:882-914`，经 `:982-987` 与 `:2093-2096` 抵达）仅对这些键改为告警；
通知原因键保持现有校验。

由于 descriptor 没有弃用字段，弃用通过字段描述与类型层 `@deprecated` 表达，Web Shell
编辑器则如对待 `senderPolicy` 那样在保存时继续保留这些键。用户页的配置表、状态 watch
段与角色化模板示例一并重写，包括那句「状态 watch 记录标题」。

### 9. 每 tick 的扫描成本

启用把每 workspace 每 tick 零次扫描变成三次（`pr-watch-observation.ts`、
`session-pr-refresh.ts`，以及 `pr-watch-deps.ts` 经 `pr-watch-drain.ts`）。
2026-11-14 用探针实测：两个 workspace、各 32 个 session（每 workspace 上限），
`scanWorkspaceBindings` 预热后 20 次迭代：

- 单次扫描 32 个 session sidecar 及其 transcript：**均值 8.49 ms、中位 8.46 ms、
  p95 10.07 ms**；
- 每 tick 六次扫描（三个调用点 × 两个 workspace）：**50.9 ms**，即默认 5 分钟
  间隔的 **0.017%**、1 分钟下限的 **0.085%**；
- 合并观测与 listing 扫描每 tick 可省下同 tick、同模块的两次扫描：**17 ms**。

**决策：保留三次扫描。** 省下的是每 tick 17 ms，代价是把观测的绑定快照穿到
refresh 里，并给这份快照一条它现在没有的生命周期规则（观测只持有一个 sweep，
listing 在同一 tick 稍后才跑）。drain 的扫描继续独立，沿用其既有的 partial scan
与锁语义。即使在 1 分钟下限，实测成本也远低于 tick 预算；未来若单 session 扫描
成本上升，应先重跑该探针再接受三次扫描。

| 层        | 文件                                                                                                                                         | 改动                                                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| config    | `packages/cli/src/config/settingsSchema.ts`                                                                                                  | `serve.sessionPrWatch`（`events`、`wakeDormant`、`actions`）    |
| config    | `packages/cli/src/config/settingsUtils.ts`                                                                                                   | `WORKSPACE_RESTRICTED_SETTINGS` 加上该 operator-only 键         |
| config    | `packages/cli/src/config/shared-env-keys.ts`                                                                                                 | 两个 env 覆盖加入项目 `.env` 排除表                             |
| config    | `packages/cli/src/serve/fast-path-settings.ts`、`packages/cli/src/serve/fast-path.test.ts`                                                   | 摘要类型、picker 与合并器加上该键；`ignoredKeys` 点名它         |
| daemon    | `packages/cli/src/serve/run-qwen-serve.ts`                                                                                                   | boot 读取、env 覆盖、别名解析、扩展签名、延后的一次性定时器告警 |
| daemon    | `packages/cli/src/serve/server/pr-watch-config.ts`（新增）                                                                                   | 设置解析、按 host 别名、订阅对象                                |
| daemon    | `packages/cli/src/serve/server/pr-watch-store.ts`、`pr-watch-drain.ts`                                                                       | 前序增量新增的 store/drain 模块；本次改动其订阅接缝             |
| daemon    | `packages/cli/src/serve/server/pr-watch-deps.ts`                                                                                             | 透传 `actions` / `wakeDormant`；别名 host                       |
| daemon    | `packages/cli/src/serve/server/pr-watch-observation.ts`                                                                                      | 事件集进入探测器与 tick；失败 streak 生命周期                   |
| daemon    | `packages/cli/src/serve/server/session-pr-refresh.ts`                                                                                        | 启用由有效事件集推导；listing 扫描决策；streak map              |
| channel   | `packages/channels/github/src/GithubAdapter.ts`                                                                                              | 拆分 pass、退休状态与任务、弃用键、保留合并绑定游标             |
| channel   | `packages/channels/github/src/index.ts`                                                                                                      | descriptor 描述与选项                                           |
| web-shell | `packages/web-shell/client/components/channels/channel-editor-state.ts`、`ChannelEditorDialog.tsx`、`client/i18n.tsx`                        | 弃用键按 daemon 的接受方式保存；弃用说明真正到达界面            |
| generated | `packages/vscode-ide-companion/schemas/settings.schema.json`                                                                                 | 由 schema 重新生成                                              |
| docs      | `docs/users/features/channels/github.md`、`docs/users/configuration/settings.md`、`docs/developers/daemon/17-configuration.md`、两版设计文档 | 迁移、设置、标题变化                                            |
| tests     | 每个改动文件旁的 `.test.ts`                                                                                                                  | 见验证                                                          |

## 关键设计决策

1. **设置、迁移与启用一起落地。** 母设计禁止存在两个投递者的构建，因此不可拆。
2. **过滤写在探测器内部，不写在调用点。** 一条规则、一个站点，且这段重复的漂移风险
   已在案。
3. **剥字段，不改文件名。** comment 游标住在同一文件里。
4. **接受 `%title%` 陈旧，而不新增 API 调用。** 空值情形已为 comment-only 渠道记录在
   文档里；这次是把它扩展，并明说。
5. **扩展重建签名。** 启动时冻结的别名，对每个在 daemon 运行期编辑渠道的操作员都是
   死开关。
6. **复用既有 action 校验器。** 三条规则与词表参数已在 `channel-base`。
7. **`actions` 拒绝启动；`events` 告警并回退。** 坏模板会静默关掉投递；坏事件列表只是
   收窄它。
8. **保留 core 的 CI 谓词，并点名取舍。** `FAILING_CHECK_RUN_CONCLUSIONS`
   （`packages/core/src/utils/github-prs.ts:187-194`）把 `CANCELLED` 与 `STALE` 算作
   failing，理由是两者都让该 head 没有通过结果。渠道是刻意排除它们的，且理由实质：
   「a superseded run's cancellation is not a CI failure of this head」
   （`GithubAdapter.ts:9178-9189`）。本仓库经常取消被取代的 run，因此 core 的谓词
   会在其中一些上触发 `ci_failure`。保留单一定义正是 PR A 已发布的形状，而排除它们
   需要枚举 rollup contexts 而不是读 `rollup.state`。这份反复出现的噪声已在下方
   **决策与待定问题**里被明确接受。
9. **该设置是 operator-only。** 它花费 daemon 全局的 `gh` 预算并向跨 workspace 的会话
   注入提示词，因此一个仓库不得为整个 daemon 打开它；受信任门控的别名才是按 workspace
   的路径。这使它位列 `WORKSPACE_RESTRICTED_SETTINGS` 中 `serve.maxSessions` 之侧，
   并使声明站点是四个而不是两个（§1）。

## 约束与风险

- **迁移操作员的延迟上升**，从渠道的 60 秒轮询变为 refresh 间隔（默认 5 分钟）。在撰写
  本设计的这台机器上，primary workspace 的渠道订阅了全部四个事件且没有
  `boundSessionActions`，因此升级后它是按 refresh 间隔的单赢家 watch。母设计 §6 列出
  了让延迟更长的其它情形。
- **渠道尚未投递的跃迁不会被投递。** 撰写本设计时观察到的积压就是具体案例。退休会数
  它，但不会补投它。
- **`%title%` 会变陈旧**，发生在同时开过两种订阅的渠道上（§7）。
- **别名用 daemon 的 `gh`，不是渠道的 token。** 渠道能读而 daemon 的 `gh` 读不到的 PR
  收不到事件，并在连续两次 view 失败后告警。
- **扫描成本**在实测前未定（§9）。
- **适配器保留每 PR 的 pass 与文件。** 读到「watch 移到 daemon」的操作员不应期待渠道
  的每 PR 读取消失；消失的只有状态检测那部分读取。

## 验证计划

- 每个改动文件旁的单元测试：设置的默认值与两个 env 覆盖；fast-path picker 携带该键；
  两个入口的启用口径一致；探测器对四种类型各自的过滤，且 `ciFired` 记账单独钉住；
  `actions` 与 `wakeDormant` 抵达 drain；别名的并集、冲突、角色化保留与信任门控；
  扩展签名在仅改 actions 时也重建。
- 适配器测试：`prWatchEvents` 为空且 comment watch 开启时 pass 仍运行；退休保留三个
  comment 游标与 `title`、剥掉 watch 字段、计数只记一次、且跨重启幂等；`watch:` 任务
  私有退休；弃用告警只发一次。
- 变异见证按守卫计而非按提交计：每条新规则在其自身站点变异，包括两个跃迁生产者与两个
  启用入口。
- 真实环境验证：本地 daemon，workspace `PATH` 上放桩 `gh`——绑定会话按 refresh 间隔经
  daemon 收到跃迁、渠道不投递状态事件、评论投递仍工作且游标完好、仅配别名的操作员在
  升级后仍收到事件。
- `npm run build`、`npm run typecheck`、`npm run bundle`、设置 schema 新鲜度门，以及
  serve fast-path bundle 门。

## 验收标准

1. 无设置且无别名时，daemon 不跑 view、不写 watch 文件、不声明所有权；适配器的状态
   检测已去除。
2. 设了 `events` 时，绑定会话对每个订阅的跃迁恰收一次，未订阅的类型由**两个**生产者
   都不记录、不投递。
3. `actions` 产生角色化投递；`wakeDormant: false` 把休眠接收者的条目保留到其下一次
   活跃回合。
4. 仅配别名的操作员对其渠道 host 上的 PR 仍收到跃迁，对其它 host 收不到；显式设置优先。
5. 在 daemon 运行期编辑 hosted 渠道的 `prWatchEvents` 或 `boundSessionActions`，无需
   重启即生效。
6. 升级后 comment 游标与 `title` 存活，退休计数恰好记录一次，且不剩任何 `watch:` 任务。
7. 没有任何构建同时从适配器与 daemon 投递状态跃迁。

## 决策与待定问题

由维护者于 2026-11-14 决策：

1. **默认关闭。** 依母设计决策 7。别名已保住每个已配置的操作员，默认打开只会增加没人
   要求的 watcher。
2. **保留 core 的 CI 谓词**，含 `cancelled` 与 `stale`（决策 8）。渠道相反的理由已在该处
   引用、并未被驳倒：本仓库经常取消被取代的 run，所以被接受的代价是反复出现的噪声，
   而不是罕见边界。排除它们意味着枚举 rollup contexts 并改动 PR A 已定案的谓词。
3. **接受 `%title%` 陈旧，并记录文档。** 替代方案会给一条本增量承诺不增加开销的车道按
   PR 增加一次 API 调用。空值情形已为 comment-only 渠道记录在文档里；§7 扩展它，用户页
   一并重写为「标题不再刷新」。

仍待定：

1. ~~**扫描：合并两次，还是保留三次并附实测？**~~ 已由 §9 实测决定：保留三次。
