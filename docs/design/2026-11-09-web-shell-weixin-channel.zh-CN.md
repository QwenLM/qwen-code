# Web Shell 中的微信（Weixin）Channel 配置

[English](2026-11-09-web-shell-weixin-channel.md) | [简体中文](2026-11-09-web-shell-weixin-channel.zh-CN.md)

状态：提案

## 问题陈述

微信（`weixin`）channel 在终端里可用，但在 Web Shell 里完全无法配置。使用浏览器界面的操作者既看不到这个平台，也无法登录，更无法创建 channel 实例。唯一可行的路径是在 daemon 所在主机上开一个 shell：

```bash
qwen channel configure-weixin   # 扫码登录，把 URL 打到 stderr
qwen channel start my-weixin    # 还要先手工编辑 ~/.qwen/settings.json
```

这是 channel 管理面目前最大的易用性缺口：除 Telegram 外，其它面向消费者的 IM 平台都能在浏览器里配置，企业微信的两种形态（`wecom`、`wecom-callback`）也早已支持。

## 现状

以下均已对照撰写时的工作树核验。

| 层               | 文件                                                                   | 状态                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 插件             | `packages/channels/weixin/src/index.ts`                                | 未声明 `management`，因此 catalog 报 `manageable: false`。                                                                                                   |
| Catalog          | `packages/cli/src/commands/channel/channel-registry.ts:467`            | `manageable: management !== undefined`；不可管理的类型下发空 `fields` 数组。                                                                                 |
| Web Shell 白名单 | `packages/web-shell/client/components/channels/channel-platform.ts:19` | `SUPPORTED_CHANNEL_TYPES` 不含 `weixin`；`channel-platform.test.ts:35` 还断言它被过滤掉。                                                                    |
| 登录             | `packages/channels/weixin/src/login.ts`                                | `startLogin` 只返回二维码 id，把可扫描的 URL 写到 `process.stderr`；`waitForLogin` 是阻塞循环（默认 480 秒），同样往 stderr 写进度，且不接受 `AbortSignal`。 |
| 凭据             | `packages/channels/weixin/src/accounts.ts`                             | 进程全局的唯一 `account.json`，位于 `~/.qwen/channels/weixin/`（可用 `WEIXIN_STATE_DIR` 覆盖），通过不可猜测的临时名加 rename 以 `0600` 写入。               |
| CLI 命令         | `packages/cli/src/commands/channel/configure.ts`                       | 除自身测试外，`startLogin` / `waitForLogin` 的唯一消费者。                                                                                                   |
| Daemon           | `packages/cli/src/serve/routes/`                                       | 不存在任何微信登录路由。                                                                                                                                     |

这张表引出两条约束，它们决定了整个设计的形状。

**凭据是进程全局的，不是 workspace 级的。** `account.json` 位于 daemon 的 home 目录，被所有 workspace 里的所有 `weixin` 实例共享。而 channel 管理路由是 workspace 级的，并以 workspace 信任为门禁。

**登录助手是终端形状的。** 它们用打印代替上报，且轮询循环无法取消。不改 channel 包，两者都无法在 daemon 路由里使用。

## 目标

- 微信出现在 Web Shell 的 channel 平台列表中，并打开标准 channel 编辑器。
- 操作者可以完全在浏览器里完成扫码登录：发起、看到二维码、看到扫描/确认进度、最终拿到已存储的凭据。
- 编辑器显示微信是否已登录，并提供退出登录。
- 终端命令保持现有行为与输出。
- bot token 永不到达浏览器。

## 非目标

- 检测存活会话过期（`errcode -14`）并将其 surfacing 为 channel 运行时状态。今天 `monitor.ts` 只是记日志并暂停 30 秒；改动它会一路传导到适配器与运行时状态契约，属于独立工作。
- 同时支持多个微信账号。凭据存储只容纳一个账号，本设计不改变这一点。
- 在 Web Shell 中支持 Telegram、QQ Bot 或 email。
- 新增 serve capability tag（见下文「Capability 门控」）。

## 方案

### 1. Channel 包：上报登录进度而不是打印

`packages/channels/weixin/src/login.ts`

- `startLogin(apiBaseUrl)` 返回 `{ qrcodeId, qrcodeUrl? }` 而非裸字符串，且不再写 stderr。`qrcodeUrl` 即响应里的 `qrcode_img_content` —— 操作者要扫描的那个值。
- `waitForLogin` 接受 `signal?: AbortSignal` 与 `onEvent?: (event: WeixinLoginEvent) => void`，把每一处 `process.stderr.write` 换成事件。事件联合为 `{ type: 'qrcode'; qrcodeId; qrcodeUrl? }`、`{ type: 'scanned' }` 与 `{ type: 'expired' }`。`qrcode` 只在循环因过期而重新生成时发出 —— 调用方已经从 `startLogin` 拿到首个二维码。`scanned` 在每次报告扫描的轮询时发出，保留原有终端输出。
- 现有重试预算、480 秒默认截止时间、1 秒轮询节奏与 `LoginResult` 形状均不变。预算在生成之前检查，因此连续三次过期会产生两次刷新然后终止。循环检查 `signal`，被 abort 时以取消收场；轮询 fetch 与空闲 sleep 在每条退出路径上都摘除自己的 abort 监听器。

`packages/channels/weixin/src/index.ts`

补上 `management`，让 catalog 把该类型标记为可管理：

- `groupPolicy` —— `enum`、必填、默认值同时也是唯一选项 `disabled`。iLink Bot 只支持私聊（`WeixinAdapter.connect` 把 `isGroup` 硬编码为 `false`），提供另外三种策略只会让操作者配出一个永远不会触发的模式。

**不提供 `baseUrl` 字段。** `connect()` 会用登录时存下的根地址覆盖配置值，而两条登录路径都必然写入该值，因此在编辑器里提供这个字段等于承诺一个永远到不了请求的覆盖项。要暴露它，得先修适配器的优先级；在那之前宁可不放这个旋钮，也不让它说谎。收窄 `groupPolicy` 还需要设置校验器像它的 number 分支那样放行「未改动的历史值」，否则在本次改动之前用 `settings.json` 配过更宽策略的操作者，将无法保存任何无关的编辑。

不设 `requiredConfigFields`：token 来自 `account.json` 而非 channel 配置，因此编辑器绝不能为它渲染凭据输入框。共享的 `privatePolicy`、`allowedUsers`、`sessionScope`、`operators` 字段由 `managementFieldsWithSharedControls` 追加，与其它 channel 一致。

### 2. CLI 命令：保留终端体验

`packages/cli/src/commands/channel/configure.ts` 适配新签名并自行打印，从发出的事件复现今天的 stderr 文案。`qwen channel configure-weixin` 无任何用户可见变化。

### 3. SDK：共享响应类型

`packages/sdk-typescript/src/daemon/types.ts` 新增两个接口，从 `src/daemon/index.ts` 导出 —— 即本次改动中所有消费者 import 的 `@qwen-code/sdk/daemon` 子路径，沿用兄弟 subscription 类型的做法（它们同样没有再经包根 barrel 导出）：

- `DaemonWeixinAccountStatus` —— `{ enabled: boolean; configured: boolean; userId?: string; savedAt?: string }`
- `DaemonWeixinLoginFlow` —— `{ id: string; status: 'waiting' | 'scanned' | 'ready' | 'expired' | 'error'; qrText?: string; qrcodeUrl?: string; errorCode?: string }`

两个类型都不带 token 字段。在 SDK 里定义一次，路由与浏览器即可 import 同一份契约；`routes/subscription-auth.ts` 与 `routes/daemon-update.ts` 已经这样 import 它们的视图类型。

### 4. Daemon：进程全局的登录流程路由

新文件 `packages/cli/src/serve/routes/weixin-auth.ts`，导出 `registerWeixinAuthRoutes(app, mutate, options?): () => void`（返回的函数用于 dispose 在途流程）。它逐条路由镜像 `registerSubscriptionAuthRoutes`，并沿用该文件关于归属的注释：进程全局的账号凭据属于 daemon 的 home，绝不属于某个 workspace runtime。

`options.apiBaseUrl` 默认取包内的 `DEFAULT_BASE_URL`，它只作为测试接缝存在：让路由测试能把流程指向 loopback 上的假 iLink 服务。生产接线没有传它，任何请求 body 字段也无法覆盖它 —— 由操作者提供上游 URL 会把登录流程变成 SSRF 原语。

| 方法   | 路径                     | 门禁                       | 行为                                                         |
| ------ | ------------------------ | -------------------------- | ------------------------------------------------------------ |
| GET    | `/auth/weixin`           | 已认证                     | 仅本地账号状态，不调用上游。                                 |
| POST   | `/auth/weixin/flows`     | `mutate({ strict: true })` | 发起流程，返回 `201` 与初始视图，在后台运行 `waitForLogin`。 |
| GET    | `/auth/weixin/flows/:id` | 已认证                     | 当前流程视图；流程已消失则 `404`。                           |
| DELETE | `/auth/weixin/flows/:id` | `mutate({ strict: true })` | abort 并丢弃流程，`204`。                                    |
| POST   | `/auth/weixin/revoke`    | `mutate({ strict: true })` | 取消所有流程，`clearAccount()`，`204`。                      |

流程生命周期：

- 最多 4 个并发**活动**流程；第五个请求得到 `429` 与 `code: 'too_many_flows'`，与 subscription 路由的上限模式一致。终态视图保留 60 秒供轮询客户端读取结果，且不计入上限——四次已结束的登录不应在没有任何流程运行时拒绝第五次发起。若客户端在 mint 返回之前断开，它拿不到 id 也就无法取消，因此由路由自己丢弃该流程（响应尚未写完而 `res` 已关闭）—— 否则登录途中刷新一次页面就会占住一个槽位直到该流程的截止时间。
- 在 `201` **之后**才消失的客户端由每流程的看门狗覆盖：每次轮询都会重置一个 120 秒的界限，无人轮询的活动流程会被取消，孤儿流程因此不再一直轮询上游到 480 秒截止。该界限按「两次**被服务端处理**的轮询之间的最坏间隙」取值，而不是按轮询节奏：面板要等上一次请求结束才排下一次，而每次轮询自带 15 秒预算（一次卡住的轮询就造成 16.5 秒间隙；发起流程另有 35 秒预算——daemon 的 30 秒生成上限，加上其后渲染二维码所需的余量）；隐藏超过五分钟的标签页会被浏览器节流到大约每分钟一次定时器（约 75 秒）。只按 1.5 秒间隔取值会把操作者仍在注视的登录回收掉，而面板会把随之而来的 404 读成「未登录」且不报错。终态视图改由保留期定时器管理，因此在登录完成前刚好停止轮询的客户端仍能读到结果。更长的界限也换来更长的名额占用：120 秒内四次「刷新登录」会占满四个活跃名额，第五次发起会收到 `429 too_many_flows`，直到最旧的一条被回收。面板会显示该错误并保留登录动作，因此无需刷新页面即可恢复——代价是反复放弃后恢复更慢，而不是面板卡死。
- 发起流程时调用 `startLogin`，把 `qrcodeUrl` 渲染成 `qrText` 并存下视图。若响应带回二维码 id 却没有可扫描 URL，按「生成失败」处理（`502 qr_unavailable`，释放 slot）而不是当作活动流程：既无二维码又无链接时，活动流程不给操作者任何可动作项，也不渲染重试按钮。该 mint 还带 30 秒超时，否则上游卡住会同时占住 slot 与请求。`onEvent` 就地更新视图：`qrcode` 事件替换 `qrText`/`qrcodeUrl`（过期后刷新的二维码），`scanned` 把状态推进到 `scanned`。
- 当 `LoginResult.connected` 时，路由用与 CLI 相同的字段调用 `saveAccount`，然后把状态置为 `ready`。token 只用于这次保存，绝不放进视图。写入失败为 `error` 且 `errorCode: 'credentials_error'`，与上游失败区分开，因为这时要修的是 daemon 的 home 目录。
- 终态视图保留 60 秒以便轮询客户端观察到，随后由一个 `unref` 的定时器丢弃，与 subscription 路由做法相同。
- `expired`（重试预算耗尽）与 `error` 是携带稳定 `errorCode` 的终态视图；上游错误文本不逐字回显。
- dispose 函数 abort 每一个 controller 并清掉每一个定时器。

二维码渲染复用 daemon 在 `routes/workspace-local-control.ts:withUiData` 里的既有做法：动态 `import('qrcode-terminal')`、`setErrorLevel('Q')`、`generate(url, { small: true })`。它是尽力而为的 —— 渲染失败只会让 `qrText` 为 undefined，流程仍携带 `qrcodeUrl`，操作者可以直接打开该 URL。`qrcode-terminal` 已经是 `packages/cli` 的依赖。

接线：`packages/cli/src/serve/server.ts` 在 subscription auth 路由旁注册这些路由，并在关停时调用 dispose 函数。

### 5. Web Shell：白名单、登录面板与标签

- `channel-platform.ts` —— 把 `weixin` 加进 `SUPPORTED_CHANNEL_TYPES` 与返回的类型联合；在 `PLATFORM_MARKS` 加 `weixin: 'WX'`。更新 `channel-platform.test.ts`，它目前断言的是相反结论。
- 新增 `weixin-auth-api.ts` —— 基于 `createDaemonRestRequest(baseUrl, token, client)` 的薄 REST 助手，遵循 `components/local-control-api.ts`。这是浏览器调用进程全局路由的既有模式；它刻意不新增 `WorkspaceDaemonClient` 方法，因为该路由没有 workspace 段。
- 新增 `WeixinLoginPanel.tsx` —— 展示组件加一个轮询 effect。显示账号状态；提供「扫码登录」动作，发起流程并把 `qrText` 渲染进 `<pre>`，样式沿用 `LocalControlQrButton`；为 waiting / scanned / ready / expired / error 各显示状态文案；提供发起新流程的刷新动作；以及退出登录动作。轮询循环自续期，且只以流程 id 为键、不以状态为键：在操作者扫码之前 daemon 会反复报告 `waiting`，只在状态变化时重新挂表的定时器会触发一次就冻住。它在终态与卸载时停止，并在瞬时请求失败后继续重试（下次成功时清除错误），这样一次网络抖动不会把面板卡死 —— 流程处于非终态时面板并不渲染刷新按钮。api 对象存放在 ref 中，宿主重渲染不会重启定时器。卸载时它会取消仍在活动的流程：daemon 在没有浏览器的情况下也会让该流程及其上游轮询继续跑，否则关闭编辑器就会泄漏 slot，累积四次放弃的尝试后所有真正的登录都会被回 `429`。启动请求仍在途的那个窗口也被覆盖：此时卸载清理还拿不到 id，所以由「响应到达后发现已卸载」的分支去取消它刚创建的流程，而不是把它静默丢掉。从「重新生成中」窗口重试时，同理也会取消被它替换掉的那条活动流程。
- 面板显示什么由「是否真的可扫描」决定，而不是由状态决定。活动视图既无 `qrText` 又无安全 `qrcodeUrl` 时，正是 daemon 的重新生成窗口：此时渲染「正在生成新的二维码…」与刷新动作，绝不显示一个无码可扫、也没有任何控件的扫码提示。凭据写入失败（`errorCode: credentials_error`）使用点名本地故障的专属文案，并保留主操作——该流程已是终态、不占名额，操作者修好目录后重试没有任何代价。
- `ChannelEditorDialog.tsx` —— 当 `descriptor.type === 'weixin'` 时在凭据分区顶部渲染该面板。登录 API 以可选 prop 注入，与该 dialog 里其它所有 daemon 调用一致（`listPairingRequests`、`approvePairingRequest`……）；由 `ChannelsManagerPage` 从 `useWorkspace()` 构造。这样 dialog 无需 workspace provider 即可测试。
- `FIELD_LABEL_KEYS.weixin` 以及 `groupPolicy` 的 EN 与 ZH 词条，各带一条 `.description`。俄语目录是有意残缺的、会回落到 EN，因此无需新增词条。
- 保存不以登录状态为前置条件。配置与凭据相互独立，操作者完全可能合理地预先配置一个 channel；面板会明确说明启动需要已登录的账号。

### Capability 门控

不新增 serve capability tag。面板探测 `GET /auth/weixin`，把 `404` 当作「此 daemon 不支持微信登录」，与 `LocalControlQrButton` 处理 `/web-shell/pairing` 返回 `404` 的方式完全一致。已经 dispose 掉这些路由的 daemon 不会返回 `404`——状态路由没有 `allowed` 守卫——而是返回 `enabled: false`，面板对它的处理与 `404` 相同：在那里给出登录按钮也只会得到 `404`。这样就无需为一条已经处于 `channel_management` UI 门禁之后的路由去改动 `CONDITIONAL_SERVE_FEATURES`、`docs/developers/qwen-serve-protocol.md` 里被钉住的表格、以及 `capability-parity.ts`。

## 设计决策与理由

**进程全局路由，而非 workspace 级。** 凭据文件是全局的。一条写它的 workspace 级路由会让某个受信任 workspace 替换掉其它所有 workspace 的 channel 正在使用的账号 —— 这是一条契约上承诺「留在已解析 runtime 内」的路由产生的跨 workspace 副作用。`registerSubscriptionAuthRoutes` 已经在注释里写明这套推理，并使用没有 workspace 段的 `/auth/...` 路径。我们沿用。

**后台流程加轮询端点，而非由客户端驱动上游轮询。** `waitForLogin` 本来就是一个带刷新预算与截止时间的循环。让它在 daemon 里跑一次并暴露进度，可以把重试语义集中在一处，也意味着浏览器标签页无法通过快速轮询把上游请求翻倍。subscription 流程路由用的是同一形状。

**发起、取消、撤销都过严格变更门禁。** 它们要么花费上游请求，要么销毁凭据。channel 配对读取路由出于同样理由已经使用 `mutate({ strict: true })`。

**token 绝不出现在响应里。** `saveAccount` 在路由内部消费它。视图类型没有 token 字段，因此未来的改动若想加一个，就必须先改动这份共享契约。路由测试断言序列化后的 body 不含 token，镜像 `workspace-channel-management.test.ts:939`。

**单选项的 `groupPolicy`。** 只声明 `disabled` 既如实反映平台能力，也满足 `assertManagementDescriptor`（它要求默认值必须是选项之一）。省略它会让共享层注入全部四种策略，使操作者能启用适配器永远产生不了的群聊模式。

**不新增 capability tag。** 见上文；404 探测是既有且已被测试的模式，能让契约测试面保持不变。

## 受影响文件

| 文件                                                                              | 改动                                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/channels/weixin/src/login.ts`                                           | 返回二维码 URL；用事件替代 stderr；支持 `AbortSignal`。 |
| `packages/channels/weixin/src/login.test.ts`                                      | 适配新签名；补 abort 与事件覆盖。                       |
| `packages/channels/weixin/src/index.ts`                                           | 新增 `management` 与 `envResolvableConfigFields`。      |
| `packages/cli/src/commands/channel/configure.ts`                                  | 从事件打印；保留输出。                                  |
| `packages/sdk-typescript/src/daemon/types.ts`                                     | 两个新接口。                                            |
| `packages/sdk-typescript/src/daemon/index.ts`                                     | 导出它们。                                              |
| `packages/cli/src/serve/routes/weixin-auth.ts`                                    | 新路由模块。                                            |
| `packages/cli/src/serve/routes/weixin-auth.test.ts`                               | 新路由测试。                                            |
| `packages/cli/src/serve/server.ts`                                                | 注册与 dispose。                                        |
| `packages/web-shell/client/components/channels/channel-platform.ts`（含测试）     | 白名单、类型联合、平台标记。                            |
| `packages/web-shell/client/components/channels/weixin-auth-api.ts`                | 新 REST 助手。                                          |
| `packages/web-shell/client/components/channels/WeixinLoginPanel.tsx`（含测试）    | 新面板。                                                |
| `packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`（含测试） | 渲染面板；新增可选 prop。                               |
| `packages/web-shell/client/components/channels/ChannelsManagerPage.tsx`（含测试） | 接线 API。                                              |
| `packages/web-shell/client/i18n.tsx`（含测试）                                    | EN 与 ZH 词条。                                         |
| `docs/users/features/channels/weixin.md`                                          | 记录 Web Shell 路径。                                   |
| `docs/developers/qwen-serve-protocol.md`                                          | 在 channel 管理叙述里描述新路由。                       |

## 约束与风险

- **上游契约未在真实租户上验证。** iLink 端点与响应字段取自现有适配器代码。自动化测试不执行真实微信登录，而是使用 loopback 的假 iLink 服务。对真实平台手工扫码仍是发布检查清单的一项。
- **每个 daemon 一个账号。** 从浏览器登录会替换掉所有正在运行的 `weixin` channel 所用的账号。已运行的 channel 在重启前仍持有旧 token，因为 `WeixinAdapter.connect` 只读一次账号。面板必须说明重新登录后需要重启受影响的 channel。
- **二维码材料即登录材料。** 任何扫到所渲染二维码的人都会把自己的微信绑定到这个 bot。流程视图只提供给已认证的调用方，且流程短命并有数量上限。
- **全局路由，没有 workspace 信任门禁。** 与 subscription 路由一样，门禁是操作者权限。这是凭据作用域带来的有意结果，不是疏漏。
- **登录状态可能变旧。** 面板每次拉取状态都通过路由读 `account.json`；不跨 dialog 打开做缓存。

## 验证计划

单元与组件测试：

- `login.test.ts` —— 返回二维码 URL；首次二维码、扫描、刷新各发出事件；abort 让循环收场；重试预算仍以 `expired` 结束。
- `weixin-auth.test.ts` —— 状态反映 `account.json`；发起返回带 `qrText` 的视图；轮询推进 waiting → scanned → ready；ready 持久化账号；序列化 body 永不含 token；取消会 abort；撤销清空账号并取消流程；流程上限返回 429；dispose abort 一切；二维码渲染失败仍产出可用流程。
- `channel-platform.test.ts` —— `weixin` 现在可用且有标记。
- `WeixinLoginPanel.test.tsx` —— 渲染每一种状态；轮询并在终态与卸载时停止；刷新发起新流程；退出登录调用 revoke；文案在 EN 与 ZH 下都能解析。
- `ChannelEditorDialog.test.tsx` —— 面板只对 `weixin` 出现；未登录时保存仍然可用。
- `configure` —— 终端输出不变。

端到端计划与结果记录在 `.qwen/e2e-tests/web-shell-weixin-channel.md`。

仓库门禁：`npm run build`、`npm run typecheck`、`npm run lint`、`npm run format`，以及在各自包目录下运行的上述聚焦套件。

## 验收标准

1. 在 `channel_management` 可用时，Web Shell 平台列表包含微信，并打开标准编辑器。
2. 从未登录状态出发，操作者无需接触终端即可发起登录、看到可扫描二维码、并到达 `ready`；`account.json` 以 `0600` 写入。
3. 编辑器显示已登录账号并能退出登录；退出后状态回到未登录。
4. 新路由的任何 HTTP 响应 body 都不含 bot token。
5. `qwen channel configure-weixin` 产生与之前相同的输出。
6. 取消流程或关停 daemon 后不留下运行中的轮询循环。
7. EN 与 ZH 都能渲染新标签与面板文案，不回落到裸 key。

## 待解问题

- 重新登录成功后是否应自动提议重启正在运行的 `weixin` channel？本设计只告知操作者；重启是他们已经拥有的 channel 动作。
- 会话过期（`errcode -14`）状态最终是否应出现在 channel 卡片上？此处列为非目标；值得开一个后续 issue。
- 私有 iLink 部署仍然无法走浏览器登录：生成二维码固定使用 `DEFAULT_BASE_URL`，而 `connect()` 之后又优先采用登录时存下的根地址而非配置值。这正是不提供 `baseUrl` 字段的原因。要支持它，需要修适配器的优先级，并给全局登录路由一个可用于生成的根地址 —— 若这类部署将来需要浏览器路径，值得重新考虑。
- 保留的终态视图不再受流程上限约束：每次结束的登录会保留一个小视图与一个定时器 60 秒，因此 map 的规模由「保留窗口 × 创建速率」界定，而不是 4。所有路由都在严格 mutation gate 之后，真实确认又需要人工扫码，所以这不构成实际的耗尽路径；若将来需要收紧，做法是对终态条目再加一个更大的上限。
