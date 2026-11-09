# Web Shell 对 Email 渠道的配置支持

[English](2026-11-09-web-shell-email-channel-config.md) | [简体中文](2026-11-09-web-shell-email-channel-config.zh-CN.md)

状态：已实现。单元、DOM、插件 parity 与真实 daemon 验证均在本地通过。浏览器
E2E 组已编写，但因既有环境问题受阻；见[验证计划](#验证计划)。

## 问题陈述

Email 渠道是一个已完整发布的内置渠道。`packages/channels/email` 提供 IMAP 轮询与
SMTP 回信，已在 CLI 渠道注册表中注册，声明了完整的管理元数据，并且已有用户文档
（`docs/users/features/channels/email.md`）以及被 `managed-agent-server` 使用的托管
适配器。

但 Web Shell 无法配置它。
`packages/web-shell/client/components/channels/channel-platform.ts` 中的
`SUPPORTED_CHANNEL_TYPES` 是一份硬编码白名单，只含七个平台（`dingtalk`、`dws`、
`wecom`、`wecom-callback`、`feishu`、`github`、`gitlab`），不包含 `email`。

该白名单在 `ChannelsManagerPage.tsx` 中有两个消费点，因此缺口造成两种后果：

| 消费点                                                                          | 对 Email 的影响                                             |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `catalog.filter(isChannelPlatformAvailable)` —— “新建渠道”类型选择器            | 无法选中 Email                                              |
| `Object.values(channels).filter(isSupportedChannelType(...))` —— 已配置实例列表 | `settings.json` 中已存在的 Email 渠道**完全不出现在页面上** |

第二种后果更严重：渠道其实在运行，但管理页面上看不到任何痕迹，用户会理解成“配置没
生效”。

这是遗漏而非有意排除。引入该渠道的提交（`612a5529599`，
`feat(channels): add IMAP and SMTP email channel (#12939)`）没有改动
`packages/web-shell` 下的任何文件。兄弟平台都各自有一次显式的前端接入改动，例如
`41f0e3ca5d0`（`feat(channels): add Web Shell management support for GitHub and
GitLab (#8310)`）。

## 现状

### daemon 早已把 Email 作为可管理类型 advertise

`packages/cli/src/commands/channel/channel-registry.ts` 中的
`supportedChannelCatalog()` 以 `manageable: management !== undefined` 上报。Email
插件声明了带十七个字段和一个 `validateConfig` 钩子的 `management`，因此 daemon 一直
在把 Email 作为可管理类型上报。前端白名单是唯一的闸门。

### 共享准入字段按“插件未声明才注入”的规则追加

`managementFieldsWithSharedControls()` 以 `!declared.has(field.key)` 过滤后追加
`SHARED_ACCESS_FIELDS`。对 Email 而言结果是：

| 字段                                   | Email 是否声明                                                 | 结果                                                          |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `privatePolicy`                        | 是 —— 枚举 `disabled` / `allowlist` / `open`，默认 `allowlist` | 共享版本（默认 `pairing`）**不会**被注入                      |
| `groupPolicy`                          | 否                                                             | 被注入：枚举、`required: true`、默认 `disabled`、含 `pairing` |
| `allowedUsers`、`operators`            | 否                                                             | 被注入 —— 两者对 Email 都有意义                               |
| `messageRoutes`、`defaultMessageRoute` | 否                                                             | 被注入 —— Email 支持（ChannelBase 路由）                      |
| `sessionScope`                         | 否                                                             | 被注入，取插件默认值 `chat_thread`                            |
| `multiSession`、`instructions`         | 否                                                             | 被注入                                                        |
| `outputMode`                           | 未设置 `supportsOutputMode`                                    | 不注入                                                        |

由此得到两个结论。第一，“新建 Email 渠道会被写成 `privatePolicy: "pairing"`（适配器
不支持该值）”这一担忧并不成立：插件自己的枚举胜出，编辑器走 descriptor 声明策略的
分支（`hasDescriptorPrivatePolicy`），而不是那个提供 `pairing` 的四卡片单选组。

第二，Email 会拿到一个它永远用不上的 `groupPolicy` 控件。
`packages/channels/email/src/email-channel.ts` 构造的每个 envelope 都是
`isGroup: false`，因此群组门从不被查询。被注入的控件是惰性的；而在它上面选择
`pairing` 还会额外弹出一个永远收不到请求的配对面版。

### 镜像问题已有先例

GitHub 是“仅仓库”渠道：每个 envelope 都是群组流量，因此被注入的**私聊**字段毫无
意义。代码库用 `channel-platform.ts` 中的 `REPOSITORY_ONLY_CHANNEL_TYPES` /
`isRepositoryOnlyChannelType()` 以及 `channel-editor-state.ts` 中的
`PRIVATE_ONLY_FIELD_KEYS` 来建模：保存路径跳过这些字段、把它们从构建出的 config 中
删除，对话框把它们从准入区块过滤掉。

Email 恰好是相反的形状——“仅私聊”——需要对被注入的**群组**字段做对称处理。

### 省略 `groupPolicy` 是合法的

`WorkspaceChannelSettingsStore.upsert()` 通过
`assertManagedConfig(..., plugin.management.fields)` 校验——用的是**插件原始字段**，
而不是带共享注入的 catalog descriptor。因此 `assertRequiredFields` 只强制 Email
自己声明的必填键。`groupPolicy` 转由 `assertSharedField()` 作为可选枚举处理。省略它
的保存会被接受。

### 密钥与环境变量引用已被保留

对于标记了 `envResolvable` 的字段上的 `preserve` 操作，store 会还原磁盘上的 `$VAR`
引用而不是解析后的字面量。Email 插件把七个必填字段全部标记为
`envResolvable: true`，因此保留 `imapPassword` / `smtpPassword` 会让
`$AGENT_IMAP_PASSWORD` 原样留存。这需要一条回归测试，而不是新代码。

### 标签是唯一真实的渲染缺口

`ChannelEditorDialog.tsx` 中的 `fieldLabel()` 按
`FIELD_LABEL_KEYS[type]?.[key] ?? SHARED_FIELD_LABEL_KEYS[key]` 解析，否则回退到
descriptor 的 `label`。Email 插件用 `label: key` 构造它的七个必填字段，因此在没有
覆盖的情况下，表单会把原始标识符（`imapHost`、`smtpPassword`）当作字段标签渲染。
每个兄弟插件都声明了可读的英文标签（`'Client ID'`、`'Personal Access Token'`）；
Email 是唯一的例外。

## 目标

1. 可以从 Web Shell 渠道管理器新建与编辑 Email。
2. 在 Web Shell 之外配置的 Email 渠道会被管理器列出。
3. 编辑器不呈现任何 Email 适配器无法作用的控件。
4. 保存时保留编辑器未建模的内容，包括 `$VAR` 引用。
5. 字段标签在英文与中文下都渲染为可读文本。

## 范围边界

范围内：Web Shell 白名单、与既有“仅仓库”处理对称的“仅私聊”处理、Email 字段标签
及其翻译，以及 Email 插件 descriptor 中那七个原始键名标签。

范围外，及原因：

- **放开 `telegram`、`weixin`、`qqbot`。** 白名单存在的意义就是每个平台在其编辑器
  体验被验证后才接入。一次放开四个平台会把下文每条风险都乘以四。
- **Provider OAuth（XOAUTH2）、富 HTML 输出、Email 的 pairing。** 明确属于适配器
  当前版本之外；任何前端改动都无法提供它们。
- **`multiSession` 的门控。** 被注入的开关与 `chat_thread` 默认值在 `github`、
  `gitlab`、`dws` 上有相同的相互作用，而这三个平台已被接入。那里的任何缺陷都是
  继承且共享的，并非 Email 特有。
- **保存一个 `$VAR` 在 daemon 环境中未设置的必填密钥。** 编辑器会起草一个空替换值
  而被 store 拒绝。这是所有带环境可解析密钥的渠道的共享行为。
- **用 `manageable` 单独取代白名单。** 更大的产品决策；作为下文遗留问题记录。

## 提议的改动

### 渠道平台模块

`packages/web-shell/client/components/channels/channel-platform.ts`：

- 把 `email` 加入 `SUPPORTED_CHANNEL_TYPES` 以及 `isSupportedChannelType` 的返回
  联合类型。
- 新增 `PRIVATE_ONLY_CHANNEL_TYPES` 与 `isPrivateOnlyChannelType()`，形状与既有的
  “仅仓库”那一对保持一致。
- **不**新增 `PLATFORM_MARKS` 条目。两个调用点都已回退到
  `displayName[0].toUpperCase()`，结果为 `E`；显式条目会是一行空操作。

### 编辑器状态

`packages/web-shell/client/components/channels/channel-editor-state.ts`：

- 新增含 `groupPolicy` 的 `GROUP_ONLY_FIELD_KEYS`，并注明它是
  `PRIVATE_ONLY_FIELD_KEYS` 的镜像。
- `createChannelEditorDraft()` 与 `buildChannelUpsertRequest()` 对“仅私聊”渠道跳过
  群组专属字段。必须在**两处**都跳过：只从 draft 中省略该键会让 `assignField()`
  读到 `undefined` 并删除已存储的值。
- 在保存路径上给 `hasDescriptorGroupPolicy(descriptor)` 代码块加上 `!privateOnly`
  条件，使 `assignGroups()` 与 `assignGroupSenders()` 对 Email 永不执行。

已存储的 `groupPolicy` 与 `groups` 键被**保留而非删除**。“仅仓库”路径之所以删除它
注入的字段，是因为陈旧的私聊白名单否则会被配对面版当作权威列表呈现。一旦 Email 的
群组控件既不被渲染也不被读取，已存储的群组键就无法弹出那个面版，因此不存在可比的
危害，也没有理由丢弃用户数据。

### 编辑器对话框

`packages/web-shell/client/components/channels/ChannelEditorDialog.tsx`：

- 在 `FIELD_LABEL_KEYS` 中新增 `email` 条目。
- 在准入区块中，把群组专属字段从渲染的准入字段里过滤掉，并对“仅私聊”渠道把生效
  群组策略解析为 `''`，与 `repositoryOnly` 把生效私聊策略解析为 `''` 的做法对称。
  这会同时抑制群组策略选择器、允许群组 ID 输入框、群组发送者下拉框，以及任何由
  群组派生的配对面版。

### 翻译

`packages/web-shell/client/i18n.tsx`：在英文与中文两张表中，为未被
`SHARED_FIELD_LABEL_KEYS` 覆盖的十七个 Email 自声明字段新增
`channels.editor.field.email.*` 标签键。仅在能承载标签之外信息的地方新增
`.description` 条目，例如两个 TLS 开关上的 STARTTLS 回退说明，以及
`proactiveRecipients` 的精确匹配规则。即每种语言 17 个标签键加 3 个描述键，
共 40 条。

### Email 插件 descriptor

`packages/channels/email/src/index.ts`：把七个必填字段上的 `label: key` 替换为可读
英文标签，与每个兄弟插件一致。descriptor 是由 `DaemonChannelTypeDescriptor` 承载的
公开契约，因此其回退值应当对任何客户端都可读，而不仅是对 Web Shell。

### 依赖

`packages/web-shell/package.json`：新增 `@qwen-code/channel-email` 作为
devDependency，与既有的 `@qwen-code/channel-github` 条目对称，使 parity 测试可以驱动
真实的插件 descriptor。同时更新 `pnpm-lock.yaml`。

### 用户文档

`docs/users/features/channels/email.md`：记录该渠道可以在 Web Shell 中新建与编辑，
且编辑器隐藏群组控件、同时原样保留任何已存储的 `groupPolicy` / `groups`。

`docs/users/features/channels/overview.md`：Group Chats 一节已经描述了 `github` 与
`gitlab` 的“仅仓库”情形；把相反的 Email 情形补在它旁边，使两个例外并列陈述。

## 关键设计决策

| 决策                                            | 理由                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 在客户端把 Email 建模为“仅私聊”，与“仅仓库”对称 | 沿用一个既有且已被测试的模式；不改渠道契约，也不触发跨包升级                                    |
| 不新增 `supportsGroups` 插件能力                | 为一个平台的 UI 关切而跨 `channel-base`、注册表与每个适配器改契约，代价不成比例                 |
| 保留已存储的群组键而不是删除                    | 对准入无影响，且是在门处实测而非假设——见下文。从 UI 无法恢复被丢弃的用户配置                    |
| 在新增 i18n 覆盖之外也修正那七个插件标签        | descriptor 是公开的；`label: key` 相对每个兄弟插件都是例外，会降低任何非 Web Shell 客户端的体验 |
| 新增由真实插件驱动的 parity 测试                | 手工构造的 descriptor 夹具无法发现插件字段列表与编辑器假设之间的漂移                            |

“保留而非删除”这个决定是在门处核实的，而不是从 UI 推断的。`GroupGate.check()`
对任何 `isGroup` 为 false 的信封，**在读取策略或配对存储之前**就返回
`{ allowed: true }`，而 Email 构造的每个信封都是这样，因此任何群组设置都无法准入
或拒绝任何人。`SenderGate` 只在私聊策略为 `pairing` 时读取配对存储，而 Email 的
枚举无法表达该值。

有一处残留副作用是真实存在、且经实测而非被轻率否定的：保留的
`groupPolicy: "pairing"` 仍会让渠道构造配对存储，并启用 daemon 的配对管理路由。
它是惰性的——组门只为组信封创建请求，私有门只在 pairing 策略下创建请求，两者都
不可能创建出请求；批准恒报 not-found，批准列表为空，编辑器也不渲染配对面版。存储
以渠道名与工作区为键，因此不存在跨渠道影响。删除该存储键确实能清掉这点惰性残留，
代价是静默丢弃操作者可能仍然需要的配置。

## 约束

- 编辑器由每个已接入平台共享。对准入区块的改动不得改变 `dingtalk`、`dws`、
  `wecom`、`wecom-callback`、`feishu`、`github`、`gitlab` 的行为。
- 在 daemon 边界上 `groupPolicy` 对 Email 必须保持可选；构建出的 config 是针对插件
  原始字段校验的。
- 两张语言表必须在同一次改动中更新，且每种语言都必须由测试渲染到。

## 风险

| 风险                                                    | 缓解                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| “仅私聊”门控泄漏到兄弟平台                              | 谓词只 keyed 在一个仅含 `email` 的显式集合上；断言既有平台仍渲染群组控件          |
| 在 draft 中跳过字段但在保存中没跳过，从而删除已存储配置 | 在两条路径上都跳过；新增一条测试证明已存储的 `groupPolicy` 能在一次无关保存后存活 |
| 某个翻译键只存在于一种语言                              | 在测试中以两种 locale 各渲染一次编辑器                                            |
| parity 夹具与插件漂移                                   | 在测试中 import 插件，而不是复述它的字段                                          |

## 验证计划

1. `packages/web-shell` 中的定向 vitest 套件：
   `channel-platform.test.ts`、`channel-editor-state.test.ts`、
   `ChannelEditorDialog.test.tsx`、`ChannelsManagerPage.test.tsx`、
   `channel-editor-parity.test.ts`。
2. Playwright `client/e2e/web-shell.channels.spec.ts`，配一个 advertise Email
   descriptor 并存储一个 Email 实例的 mock daemon：该实例被列出，且其编辑器打开后
   不含群组控件。
3. 一次真实 daemon 往返：针对一个 `settings.json` 中声明了带 `$VAR` 密码的 Email
   渠道的工作区运行 `qwen serve`；确认 catalog 把 Email 上报为可管理、该实例被返回，
   且一次无关的 upsert 在磁盘上保留了这些引用。
4. 仓库门禁：`npm run build`、`npm run typecheck`、`npm run lint`、
   `npm run format`，以及上述定向套件。

### 验证结果

| 组                                       | 结果                    |
| ---------------------------------------- | ----------------------- |
| 1 —— vitest（整个 `channels/` 目录）     | 451 通过                |
| 1 —— Email 适配器包                      | 82 通过                 |
| 1 —— CLI catalog 消费者                  | 8 通过                  |
| 2 —— Playwright 浏览器 E2E               | **受阻**，见下文        |
| 3 —— 真实 daemon 往返                    | 本地 bundle 上 9/9 通过 |
| 4 —— build / typecheck / lint / prettier | 通过                    |

web-shell 计数的变化是 385 → 449 → 451：下文代码评审之前是 385，评审新增用例后
是 449，分支纳入 `main` 后是 451——后者把上游两条 `prCommentWatch` 用例带进了同一
个 parity 文件。评审期间一次完整的 `packages/web-shell` 运行报告 15598 通过；
`packages/cli` 在无关文件上超时，且失败集合在两次运行之间漂移——该套件本轮无判决，
不归因于本次改动。

完整 `npm run lint` 门禁在本检出报 658 个错误，全部位于
`packages/sdk-java/qwencode/target/reports/apidocs/`——那是未跟踪的本地 Javadoc
产物，CI 上不存在。排除该目录后门禁 exit 0，且没有任何报错文件落在该目录之外。

daemon 探针分别对已发布的 `qwen` 0.27.0 与本地 bundle 各跑一次。其中八项在两者
上都通过，证实 daemon 侧本就完备。第九项——线上必填字段标签可读——在已发布二进制
上失败（`label: "imapHost"`），在本地 bundle 上通过（`label: "IMAP Host"`），
这就是 descriptor 改动的见证。

把四个前端生产文件回退到 `HEAD`、同时保留新测试，会让其中 12 个用例变红，包括
管理页列出用例的 `expected … to contain 'Agent Mailbox'`。这证明新用例是见证，
而不是在未修复树上也能通过的测试。该检查中发现并修正了一个空过用例：英文标签测试
原先的夹具自带最终标签文案，因此把整个 i18n 层删掉它照样通过。现在夹具携带原始键名
与占位描述。

**浏览器 E2E 受阻原因。** Playwright 组无法在本检出中运行：
`node_modules/playwright` 与 `node_modules/@playwright/test/node_modules/playwright`
是两份独立的 1.61.1 副本，因此 runner 与 spec 加载到不同的模块实例，`test()` 被
拒绝并报 "Playwright Test did not expect test() to be called here"。一个未改动的
spec 同样失败，且本次改动的 lockfile 差异只有新增的 devDependency 链接，因此该状况
早于本次改动。用例已提交，应当在 CI 中运行——那里是干净的
`--frozen-lockfile` pnpm 安装树。

### 代码评审结果

一轮十 agent 的评审走查捕获 diff 后，发现了一条实现与其测试都漏掉的 Critical，
以及若干覆盖缺口。全部先对照代码核实，再动手。

**原始 base 上的 Critical —— 保存时静默降级隐式 TLS。** `initialFieldValue()`
把所有缺席的布尔字段一律初值为 `false`，忽略 `field.default`。Email 的
`imapSecure` / `smtpSecure` 声明 `default: 'true'`，而 `assignField()` 恒写显式
布尔，因此在编辑器里新建 Email 渠道——或打开一个用 CLI 配好的渠道只改无关字段再
保存——都会把两者落盘为 `false`，把邮箱从 993/465 上的隐式 TLS 移到 143/587 上的
STARTTLS。在本工作起始的 base（`7ad260bceb`）上，Email 这两个开关是所有渠道插件中
唯一声明 true 默认值的布尔字段，因此任何已接入平台都触不到该缺陷。

**在本工作进行期间由上游修复。** 那个 base 落后 main 16 个提交。rebase 时发现
`e867340c68`（#16602）已经为 GitHub 新增的 `prCommentWatch` 落地了逐字相同的
一行修复——`field.default === 'true'`；`prCommentWatch` 也是当前树上另一个
true 默认值布尔字段。因此该生产代码行属于上游，不再出现在本 diff 中；rebase 冲突
按取上游注释原文解决，parity 文件同时保留上游的 GitHub 块与本次新增的 Email 块。

本 PR 保留的是 Email 专属的回归覆盖。两条 parity 用例驱动真实 Email 插件描述符，
钉住 draft 初值、保存值与无关编辑路径；上游那条只覆盖 `prCommentWatch`，因此少了
这两条，未来改动可能在无人察觉的情况下再次破坏 Email 的 TLS 默认值。相对原始
base 实测，把那一行回退会让两条 Email 用例都以 `expected false to be true` 变红。

**其余已处理的发现：**

| 发现                                                                                                              | 处理                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 重新生成的 `NOTICES.txt` 写入了 committed lockfile 不会解析出的版本，会让 CI 的 notices 门禁变红                  | 已回退；随后一次 `npm run build` 把它重新生成为与 `HEAD` 逐字相同，证实回退后的状态正是生成器的产物                                                                |
| 插件标签修复没有 committed 测试，且一处夹具注释谎称 parity 套件钉住了它                                           | 在 `packages/cli/src/commands/channel/email-baseline.test.ts` 补生产者侧断言（可读标签、注入的 `groupPolicy`、TLS 默认值），并把注释改为指向该文件                 |
| parity 中两条关于 `groupPolicy` 的断言是空过的——真实插件描述符根本没有该字段                                      | 已移除；注入形状由 `channel-editor-state` 夹具钉住，现在也在生产者侧钉住                                                                                           |
| 17 个 Email i18n 键中只有 6 个被任何测试渲染过                                                                    | 把对话框夹具补齐到完整字段表，并新增双语扫描，断言没有标签泄漏原始 `channels.editor.field.` 键                                                                     |
| Email 的端点与 TLS 开关渲染在“应用凭据”区                                                                         | 把六个 Email 专属键加入 `CONNECTION_FIELD_KEYS`，并补分区归属用例                                                                                                  |
| `descriptorGroupPolicy` 上的 `!privateOnly &&` 是同一规则的第二个、无法被钉住的承重者                             | 已移除。后续一轮验证进一步纠正了配套注释：通常使策略为空的是 draft skip；ternary 守的是 stored-config 回退臂，而非整条规则                                         |
| 六个 Email 数字字段未声明 `maximum`，而运行时强制上界，导致越界值通过内联校验、仅在保存时以横幅失败               | 按 `MAX_POLL_INTERVAL_MS` 的惯例把上界作为命名常量在 config 解析器与描述符之间共享，并新增 parity 用例钉住每个上界与内联 `outOfRange`；删除一个 `maximum` 实测变红 |
| 新增浏览器用例用精确标签文本定位必填控件，而标签带 aria-hidden 星号故永不匹配；群组零数量守卫朝危险方向有同样缺陷 | 改用 role＋无障碍名称，群组轴改用子串名称匹配并覆盖整条轴；真实 Chromium 实测（旧形式 0 匹配、新形式 1、守卫 0）                                                   |

**判定为范围外而未采纳的发现（既有、与平台无关）：** 配置保留审计实证了两处本
diff 未触碰代码中的缺陷，且各自在已接入平台（DingTalk 对照）上复现，因此放开
Email 只是延续既有缺陷而非新造：编辑器会丢弃 `messageRoutes` 中值为空白的条目
（当 `defaultMessageRoute` 指向它时还会卡死保存）；注册表注入的共享字段
（`instructions`、`defaultMessageRoute`）里的 `$ENV_VAR` 会被烘焙成解析后的字面
量，因为 store 的还原只覆盖插件自声明的 `envResolvable` 字段。两者都应单独立项；
前者还与"该记录是否有路由"的判定共用 `parseRouteRecord`，不是一行能修的。

**未采纳的发现：** 把流量形状这一事实放进插件/descriptor 能力位，而不是客户端
集合。这正是「关键设计决策」中已经否决的备选方案——为一个平台的 UI 关切做跨包
契约变更。同一条发现还观察到 `gitlab` 不在 `REPOSITORY_ONLY_CHANNEL_TYPES` 中，
因此至今仍渲染私聊控件；那是未改动代码中的既有行为，在此记为后续工作，不在本
diff 中修复。

## 验收标准

1. Email 出现在 Web Shell 的“新建渠道”选择器中。
2. 在 `settings.json` 中配置的 Email 渠道出现在渠道列表中。
3. Email 编辑器不渲染群组策略、允许群组 ID、群组发送者控件，也不渲染配对面版。
4. `privatePolicy` 恰好提供 `disabled`、`allowlist`、`open`，并在新建渠道上默认为
   `allowlist`。
5. 保存新建的 Email 渠道不写入 `groupPolicy`，也不写入 `groups` 键。
6. 一次无关保存保留已存储的 `groupPolicy` / `groups` 键以及 `$VAR` 密码引用。
7. 每个 Email 字段标签在 `en` 与 `zh` 下都渲染为可读文本；不出现原始 camelCase
   标识符。
8. `proactiveRecipients` 能从逗号分隔输入往返为字符串数组并还原。
9. 七个已接入的兄弟平台行为不变。
10. 新建 Email 渠道从描述符默认值取 `imapSecure` / `smtpSecure` 初值并保存为
    `true`；对一个省略了这两个键的渠道编辑无关字段，不会把它们翻成 `false`。
11. Email 的端点与 TLS 开关渲染在 Connection 区，其凭据渲染在 Credentials 区。

## 遗留问题

- 白名单最终是否应当被 `descriptor.manageable` 单独取代，而把逐平台验证交给测试而
  不是一个集合？本次改动有意不决定这一点。
- 当解析出的会话作用域无法支持 `multiSession` 时，是否应当隐藏它？该行为与三个已
  接入平台共享，应属于另一次改动。
- `gitlab` 不在 `REPOSITORY_ONLY_CHANNEL_TYPES` 中，尽管其适配器只发出群组
  envelope，因此编辑器仍向它提供私聊控件。评审把这识别为与本次为 Email 修复的
  同一类缺陷；它是既有问题，应属于另一次改动。
