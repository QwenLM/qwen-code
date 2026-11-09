# Web Shell 渠道管理支持 QQ 与浏览器内扫码登录

[English](2026-11-09-web-shell-qq-qr-login.md) | [简体中文](2026-11-09-web-shell-qq-qr-login.zh-CN.md)

## 状态

部分实现。第 1、2 层(`channels/base` 契约,以及 QQ 管理描述符与 `qrLogin` 接线)
已实现并有单元测试覆盖;`channel-base`、`channel-qqbot`、`channel-email` 均可构建,
`channel-registry` 与 `qqbot` 测试套件通过。

**尚未实现:** 第 3 层(daemon 登录会话资源与路由)、第 4 层(SDK 接线)、
第 5 层(Web Shell UI、白名单、i18n)、共享 `requireMention` 控件,以及编辑器对
布尔默认值的使用。因此 QQ 目前在 Web Shell 中仍不可见,浏览器扫码尚不可用。
`qrcode` 依赖未添加。未执行任何端到端或人工扫码验证。

下文的调研结论于 2026-11-09 从工作树中读取得到并附带引用出处。

## 问题陈述

QQ Bot 适配器已经存在且可用,但完全无法从 Web Shell 配置,而它唯一的登录路径是把
二维码画进终端。因此从浏览器管理渠道的用户既无法添加 QQ,也无法完成 QQ 推荐的扫码
绑定 —— 承载该渠道的 daemon worker 没有用户看得见的终端。

目标是让用户在 Web Shell 里添加 QQ 渠道,并通过扫描浏览器中渲染的二维码完成绑定,
全程不需要手工处理 `appSecret`。

## 现状

以下结论均通过阅读所引用的代码行核实。

### 适配器已存在,但不可管理

- `packages/channels/qqbot` 实现了该适配器。它的 `channelType` 是 `qq`,
  不是 `qqbot`(`packages/channels/qqbot/src/index.ts:7`)。
- 它已注册为内置渠道(`packages/cli/src/commands/channel/channel-registry.ts:348`)。
- 该 plugin 未声明 `management` 元数据,因此 `supportedChannelCatalog()`
  报告 `manageable: false` 与 `fields: []`
  (`packages/cli/src/commands/channel/channel-registry.ts:442`)。
- `ChannelManagementDescriptor` 目前只暴露 `fields` 与 `validateConfig`
  (`packages/channels/base/src/types.ts:539-550`)。不存在交互式登录的扩展点。

### Web Shell 有两道门禁把 QQ 挡在外面

- `SUPPORTED_CHANNEL_TYPES` 是硬编码的六项白名单 —— dingtalk、dws、
  wecom、feishu、github、gitlab
  (`packages/web-shell/client/components/channels/channel-platform.ts:18`)。
- 可用性要求两道门禁同时通过:`descriptor.manageable && isSupportedChannelType(descriptor.type)`
  (`packages/web-shell/client/components/channels/channel-platform.ts:36`)。
- 实例列表套用同一份白名单,因此已经存在于 `settings.json` 中的 QQ 渠道会被
  完全隐藏,不出现在页面上
  (`packages/web-shell/client/components/channels/ChannelsManagerPage.tsx:265`)。

这不是针对 QQ 的特殊处理:`telegram` 与 `weixin` 同样缺少 `management`,
`email` 声明了 `management` 但不在白名单里。适配器是逐个接入管理面的;先例是提交
`41f0e3ca5d0`("add Web Shell management support for GitHub and GitLab",#8310)。

### 今天的扫码路径只能在终端进行

`QQChannel.fetchToken()` 按顺序解析凭据:配置值、已持久化的凭据文件、交互式扫码登录
(`packages/channels/qqbot/src/QQChannel.ts:1896-1922`)。最后一步往
`process.stderr` 写提示并 await `qrCodeLogin()`,后者委托给 `qrConnect()`
(`packages/channels/qqbot/src/login.ts:22`)。凭据以 `0o600` 权限持久化到
`{qwenDir}/channels/{name}-credentials.json`
(`packages/channels/qqbot/src/accounts.ts:14`、`:47-58`)。

`requiredConfigFields` 被刻意设为 `[]`,这样 `parseChannelConfig()` 不会在扫码路径
有机会运行之前就拒绝一份没有凭据的配置
(`packages/channels/qqbot/src/index.ts:9-15`)。

### 连接器本身已支持浏览器渲染二维码

`@tencent-connect/qqbot-connector@1.1.0` 锁定时只有一个依赖,
`qrcode-terminal@0.12.0`(`pnpm-lock.yaml:4758`、`:14017`)。它发布的类型声明导出两个入口:

- `qrConnect(options)` —— 总是打印到控制台;今天使用的就是这个。
- `startQrConnect(callbacks, options)` —— 接受
  `displayQrCodeToConsole: false`、一个 `AbortSignal` 和一个 `source` 标记;
  在开始轮询前触发 `onQrDisplayed(url)`,随后触发 `onSuccess(credentials)`、
  `onQrExpired()` 或 `onFailure(error)`;返回一个 dispose 函数。

两处控制台写入都位于 `if (displayQrCodeToConsole)` 之内,而 `onQrDisplayed`
无条件触发,因此回调模式不产生任何终端输出。不需要 monkey-patch,也不需要重新实现协议。

二维码载荷是
`https://q.qq.com/qqbot/openclaw/connect.html?task_id=<id>&source=<source>&_wv=2`。
它只携带一个 task id。`createBindTask` 生成的 AES-256-GCM 密钥留在库的闭包内,
`decryptSecret` 在 daemon 中运行,因此 `appSecret` 只可能在服务端出现。二维码过期时,
库会创建新任务并无限循环,直到被 abort。

### 传输与契约约定

- 渠道管理使用带 `Cache-Control: no-store` 的普通 JSON 快照,不使用 SSE;
  UI 在每次 mutation 之后重新加载
  (`packages/web-shell/client/daemon/workspace/hooks/useDaemonChannels.ts:90-97`)。
- 渠道路由**没有**被描述在
  `docs/developers/daemon-rest-api.openapi.json` 中(该文件不含任何
  `channels` 条目)。那份 spec 及其四方对齐测试只覆盖 guide 面。
  `packages/web-shell/scripts/generate-managed-agent-api.mjs` 下的生成类型管线
  是 managed-agent 专用的,与此无关。渠道的 SDK 类型是手写的
  (`packages/sdk-typescript/src/daemon/types.ts:4811-4909`)。
- 路由在两个前缀下注册:`/workspace`(legacy-primary)与
  `/workspaces/:workspace`(workspace-qualified)
  (`packages/cli/src/serve/routes/workspace-channel-management.ts:587-588`)。
  每个请求都经过 `resolveTarget`,它强制执行
  `requireTrustedWorkspaceRuntime`,并以 `live_channel_management_reserved`
  拒绝来自 `live-conversation` runtime 的非 GET 请求
  (`packages/cli/src/serve/routes/workspace-channel-management.ts:299-307`)。
- 服务按 runtime 缓存在
  `WeakMap<WorkspaceRuntime, Promise<ChannelManagementService>>` 中,每个都持有自己的
  `WorkspaceChannelSettingsStore(targetRuntime.workspaceCwd)`
  (`packages/cli/src/serve/run-qwen-serve.ts:8227-8256`)。

### 最接近的有状态登录先例

OAuth device flow 提供了可模仿的入口形状:POST 启动,新流程返回 201、幂等接管返回
200;GET 读取状态;DELETE 取消并返回幂等的 204
(`packages/cli/src/serve/routes/workspace-auth.ts:155`、`:223`、`:256`)。
`DeviceFlowRegistry` 在内存中保存带 `expiresAt` 的条目
(`packages/cli/src/serve/auth/device-flow.ts:451`)、每条目一个 `AbortController`
(`:471`)、一个 30 秒且已 unref 的清扫器(`:61`、`:701-709`),以及一个以
409 `too_many_active_flows` 形式暴露的并发上限。状态变更以
`auth_device_flow_*` workspace 事件扇出
(`packages/cli/src/serve/server/device-flow-registry.ts:56-79`),浏览器把它折算成
版本计数器以触发重新加载。

该先例有两个属性不能盲目照抄。第一,它的 registry 被刻意设计为 **daemon 全局**,
因为 OAuth 凭据是进程级的。第二,它的发起者校验在文档中被明确写为
**尽力而为的归属判断,不是认证** —— bearer token 才是 auth 边界
(`packages/cli/src/serve/routes/workspace-auth.ts:52-72`)。

## 目标

- 把 QQ 加入 Web Shell 渠道管理面,暴露完整的 `QQChannelConfig` 字段集。
- 让用户通过扫描浏览器中显示的二维码绑定 QQ 机器人。
- 让 `appSecret` 完全不上 wire、不进浏览器。
- 把扫码协议留在 QQ 适配器内;daemon 只传输一个渠道无关的能力。
- 保持既有 CLI 终端扫码路径不变。

## 范围边界

范围内:`channels/base` 的契约新增、QQ 管理描述符与登录能力、daemon 中按 workspace
隔离的登录会话资源、SDK 接线,以及 Web Shell 编辑器 UI(含中英文文案)。有两处共享
面被有意改动:布尔字段默认值,以及群组区的 `requireMention` 控件 —— 两者都影响所有
适配器。

范围外:为其他适配器提供扫码登录;改动 CLI 扫码流程;把渠道路由提升到 OpenAPI guide
面;专用 SSE 子资源;迁移已经存放在凭据文件中的凭据。

## 方案设计

### 第 1 层 —— `packages/channels/base`

在 `ChannelManagementDescriptor` 上新增可选的 `qrLogin` 能力。它接受一组与连接器
回调对应的 handler 以及一个 `AbortSignal`,并返回一个 dispose 函数。daemon 永远
不需要知道 QQ 协议细节。

扩展布尔字段的默认值支持。`ChannelConfigFieldDescriptorBase.default` 目前是
`string`(`packages/channels/base/src/types.ts:459`),无法表达布尔默认值;见决策 D6。

### 第 2 层 —— `packages/channels/qqbot`

声明覆盖 `QQChannelConfig` 的 `management.fields`
(`packages/channels/qqbot/src/types.ts:66-101`):`appID` 与 `appSecret`
(可用环境变量解析,且为可选,以便扫码路径提供它们)、`sandbox`、
`groupAllPolicy`、`keywordTriggers`、`allowMention`、`chatTypes`、
`cron-msg-experimental`、`bufferFlushLength`、`maxReconnectAttempts`、
`maxFlushRetries`、`maxGwRetries`。共享的访问控制、session-scope、output-mode 与
instructions 字段由 `managementFieldsWithSharedControls()` 自动追加,不得重复声明。

把 `management.qrLogin` 接到 `startQrConnect`,并设置
`displayQrCodeToConsole: false`。为 D7 中的跨字段约束新增 `management.validateConfig`。

### 第 3 层 —— `packages/cli/src/serve`

把临时登录会话 registry 挂在 `ChannelManagementService` 上,而不是做成进程级单例
(见 D1)。在 pairing 路由旁边新增三条路由,注册在既有的两个前缀下,并走同一个
`resolveTarget` 门禁:启动、读取状态、取消。用 `packages/cli` 新增的 `qrcode`
依赖在服务端把二维码渲染成 data URL(见 D4)。成功后,通过既有的
`ChannelSecretUpdate` 路径把 `appID` 与 `appSecret` 写入渠道配置(见 D3)。

在 `channel_management` 旁边新增一个 capability key
(`packages/cli/src/serve/capabilities.ts:448`),以便旧客户端能探测支持情况。

### 第 4 层 —— SDK

在 `packages/sdk-typescript/src/daemon/types.ts` 中新增描述符标志与登录会话类型,
在 `DaemonClient.ts` 的 primary 与 workspace-scoped 两个类中都新增客户端方法,
并通过 `src/daemon/index.ts` 与 `src/index.ts` 重新导出。

### 第 5 层 —— Web Shell

把 `qq` 加入白名单、其返回类型联合以及 `PLATFORM_MARKS`。扩展
`workspace/types.ts`、`workspace/actions.ts` 与 `useDaemonChannels.ts`,再接上导出链。
在 `ChannelEditorDialog` 中新增扫码面板,包含等待、已扫码、已过期与失败四种状态、
一个取消动作,以及手工填凭据的兜底入口。在共享群组区新增 `requireMention` 控件
(见 D7)。为每个新字段与新状态补齐中英文文案,并更新当前枚举了五个平台的空态文案
(`packages/web-shell/client/i18n.tsx:4065`、`:8167`)。

## 设计决策与理由

**D1 —— 登录 registry 按 persisted-workspace 隔离,而非进程级。**
Device flow 是 daemon 全局的,因为 OAuth 凭据是进程级的。而 QQ 登录的终点是写入
某一个 workspace 的渠道配置,且 `ChannelManagementService` 本就按 runtime 划分、
各自持有 settings store。把 registry 挂在那里,隔离性由构造保证,可直接复用既有的
信任门禁与 live-conversation 门禁,并让 `WeakMap` 随 runtime 一起回收会话。
新路由的所有权类:**legacy-primary + persisted-workspace**,与其兄弟渠道路由一致。

**D2 —— 轮询 JSON 快照;不新增 SSE 子资源。** 渠道管理已经采用这种方式。
登录会话生命周期很短,既有的「mutation 后重新加载」hook 足以覆盖。若确实需要推送
信号,应复用 workspace 事件加版本计数器的模式,而不是新造一条流。

**D3 —— 凭据以受管 secret 形式落入渠道配置。** 这样编辑器才能展示绑定状态并支持
替换或解绑,与钉钉、飞书保持一致。快照只暴露 `secrets[key].present`,从不暴露值,
因此读取路径也不会把 secret 送到浏览器。

存储权限是实测得到的,不是假设。`saveSettings` 最终走到 `writeWithBackupSync`,
它保留已存在文件的权限并拒绝发布更宽权限,但在新建文件时传入 `mode: undefined`
(`packages/cli/src/utils/write-with-backup.ts:81-105`)。在 umask 022 下直接驱动该
函数的探针得到:新建文件 `0644`,已存在的 `0600` 保持不变,已存在的 `0644` 保持不变,
暂存目录 `0700` 且成功后清理。落点是 workspace settings 激活时的
`<repo>/.qwen/settings.json`,否则为 `~/.qwen/settings.json`
(`packages/cli/src/serve/channel-settings-store.ts:489-491`);本仓库忽略 `.qwen/*`
(`.gitignore:32`)。

因此在常见情况下 —— settings 文件早已以 `0644` 建好 —— secret 会变成本机其他用户
可读,而 QQ 凭据文件恒为 `0600`。为了与钉钉、飞书一致而接受这一点,它们的 secret
今天就已具有该属性。这是平台既有的全局特征,不是 QQ 引入的;secret 静态存储的加固
属于独立改动,不应塞进本功能的共享写入路径。

**D4 —— 在 daemon 侧把二维码渲染成 data URL。** 让浏览器 bundle 不含二维码编码器,
并把二维码生成集中在一处。代价是 `packages/cli` 增加一个依赖。

**D5 —— 把二维码 URL 当作验证材料。** 只回显给发起方客户端,与 device flow 一致。
这是加固,不是安全边界:该 header 是未经认证的归属信息,bearer token 仍是真正的
边界。值得直说的威胁是:谁扫码就绑定谁的机器人,因此 URL 泄漏可能把某 workspace 的
渠道指向攻击者控制的机器人。

**D6 —— 布尔默认值需要契约支持。** `allowMention` 的读取方式是 `!== false`,
因此其有效默认值是 true
(`packages/channels/qqbot/src/QQChannel.ts:659`)。编辑器把缺省布尔初始化为
`false`,且 `assignField` 无条件写入该值
(`packages/web-shell/client/components/channels/channel-editor-state.ts`),
所以今天就暴露该字段会在每次保存时静默关闭 mention 透传。允许布尔 `default`
需要同步改动描述符类型、`assertManagementField`(它目前拒绝非字符串默认值,
`packages/cli/src/commands/channel/channel-registry.ts:213-215`)以及编辑器的初值逻辑。

**D7 —— 跨字段约束变成编辑器可见的校验。**
`groupAllPolicy` 取 `keyword` 或 `all` 时需要 `sessionScope: 'thread'` 以获得
按群共享的上下文,并且需要至少一个群设置 `requireMention: false`,否则 `GroupGate`
会静默丢弃所有非 @ 消息。适配器只在 stderr 警告,且不再覆盖用户选择的 scope,
因此在 daemon worker 里警告不可见,UI 会展示一份「保存干净、随后丢流量」的配置。
`validateConfig` 必须用可操作的报错拒绝不受支持的组合。

上游在本设计初稿之后修正了这些语义:所需 scope 是 `thread` 而非 `single`
(`single` 会把所有群与私聊并入同一上下文);`multiSession` 把 scope 钉在 `user`,
因此与这两种策略互斥;群组闸接受任意群的 `requireMention: false`,而不只是通配条目。
已实现的校验及其测试均以当前上游行为为准。

`groups['*'].requireMention` 同时在共享群组区获得一个编辑器控件,使 `keyword` 与
`all` 可以完全从 UI 配置,而不需要手工编辑。由于该区被所有适配器共用,此改动需要
对六个已可管理的渠道类型做一轮回归,且该控件在未被使用时必须原样保留既有群组配置。

**D8 —— 保留终端兜底,但受管启动不得走到它。** CLI 扫码路径不变。
一个没有可解析凭据的受管 QQ 渠道必须以清晰报错失败,而不是让 worker 阻塞在
一个看不见的终端提示上。

**D9 —— 能力是渠道无关的,协议不是。** daemon 只转发 handler,从不解析 QQ 的
URL 或 task id,因此未来的适配器可以复用该传输层。

## 约束

- 连接器会无限刷新过期二维码。会话 TTL 必须通过调用 dispose 来约束它,
  否则一个被遗忘的会话会一直轮询腾讯接口。
- 定时器必须 unref,使登录会话绝不撑住进程,与 device-flow 清扫器一致。
- 会话存在于内存中,重启即消失;UI 必须把「会话不存在」当作已过期处理,而不是挂起。
- `appSecret` 绝不可出现在响应体、事件载荷或日志行中。路由错误已经过
  `redactLogCredentials` 与 `sanitizeLogText`
  (`packages/cli/src/serve/routes/workspace-channel-management.ts:269`)。

## 风险

- **静态存储的 secret 发生变化(已实测并接受).** QQ 凭据目前存放在 `0o600` 的
  文件里;`settings.json` 在常见情况下是 `0644`,因此 secret 会变成本机其他用户可读。
  D3 记录了实测数据与接受理由。平台级的 secret 静态存储加固属于后续工作,不在本次
  改动内。
- **真实扫码无法自动化。** 没有 harness 能把手机对准屏幕。自动化覆盖必须用
  fake 驱动连接器回调;真实绑定需要一次人工验证。这是两类不同的证据,必须分开报告。
- **共享编辑器的影响面。** D6 改动布尔初始化,D7 在共享群组区新增控件,两者都影响
  所有渠道类型而不只是 QQ。六个已可管理的适配器需要一轮回归,覆盖布尔字段与群组
  配置的往返保真。
- **静默分叉陷阱。** D6 与 D7 是本功能可能「看起来能用、实际行为错误」的两条路径。
  两者都需要专门的回归测试,而不只是 happy path 覆盖。

## 验证计划

单元测试,按项目约定与源码同目录放置:QQ 描述符形状与 `validateConfig` 拒绝矩阵;
registry 对新能力与布尔默认值的校验;登录会话生命周期,含过期、取消、并发上限与
接管;两个前缀上的路由所有权与信任门禁;快照与事件载荷中绝不出现 secret;
真默认值字段的编辑器布尔初始化;中英文文案按语种分别断言渲染。

端到端:用 fake connector 驱动真实 daemon,覆盖等待、已扫码、过期后刷新、已取消
与失败五条路径,断言凭据落入该 workspace 的渠道配置,且没有 secret 上 wire。
另外单独进行一次人工运行,通过扫描浏览器渲染的二维码绑定真实机器人。

两个陷阱各配显式回归:保存新建 QQ 渠道不得写入 `allowMention: false`;
在缺少所需群组设置时选择 `groupAllPolicy: keyword` 必须在编辑器中被拒绝,而不是被保存。

由于有两处共享面发生变化,六个已可管理的适配器各配一条往返回归:在编辑器中打开、
不做任何修改直接保存,断言结果配置除预期的规范化之外保持不变。该回归必须覆盖布尔
字段与任何既有的 `groups` 条目,包括并非由新控件写入的 `requireMention` 值。

## 验收标准

1. QQ 出现在 Web Shell 平台列表中,且已存在于 `settings.json` 的 QQ 实例会被列出
   而非隐藏。
2. 从编辑器启动登录会在浏览器中渲染出可扫描的二维码图片,且 daemon 不产生终端输出。
3. 扫码成功会把 `appID` 与 `appSecret` 写入该 workspace 的渠道配置,
   且编辑器展示已绑定状态。
4. 任何响应体、workspace 事件或日志行都不含 `appSecret`。
5. 从编辑器取消会停止上游轮询;被弃置的会话会过期,并在没有客户端的情况下停止轮询。
6. 在一个 workspace 中启动的登录,无法从另一个 workspace 读取或取消。
7. 保存新建 QQ 渠道后,`allowMention` 保持其有效默认值 true。
8. 在缺少所需 session scope 与群组设置时,`groupAllPolicy: keyword` 或 `all`
   会被拒绝,并给出可操作的编辑器报错。
9. `groups['*'].requireMention` 可从编辑器配置,且 `keyword` 或 `all` 能够端到端
   配齐,无需手工编辑 `settings.json`。
10. 对六个已可管理的适配器,布尔字段与群组配置经编辑器往返后保持不变。
11. CLI 终端扫码路径仍然照常工作。
12. 每个新文案在中英文下都能渲染。

## 待定问题

- 登录会话是否需要 workspace 事件推送信号,还是实践中「轮询时重新加载」就足够?
  应根据 fake-connector 运行中实测的延迟来决定,而不是预先加上扇出。

## 已决问题

- `groups['*'].requireMention` 在共享群组区获得编辑器控件(D7),接受由此扩大的
  回归面。
- 凭据只写入渠道配置,为与其他适配器一致而接受实测到的 `0644` 暴露面(D3)。
  受管路径不再写凭据文件。
