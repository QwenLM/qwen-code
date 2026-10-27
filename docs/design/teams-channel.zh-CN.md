# Microsoft Teams 渠道

[English](teams-channel.md) | [简体中文](teams-channel.zh-CN.md)

状态：实现与自动化宿主契约验证完成，2026-10-27。

## 问题与现状

Qwen Code 可通过扩展清单加载 Channel 插件，并使用 standalone 或 daemon
bridge 运行。实现基线 `816d04181b` 尚无 Microsoft Teams 适配器。通用适配器
还应能由拥有 HTTP 入口、持久处理和执行身份的应用承载，应用无需复制
Microsoft 协议实现。

初版实现只通过 `TeamsChannel` 暴露入站入口。只负责接收事件的网关因此
必须构造没有执行用途的 channel、bridge、router 和执行钩子。将验签 HTTP
入口与渠道执行分开，同时保留唯一的 SDK 处理路径。

## 范围

支持私聊文本、群聊与团队频道中显式 @ 机器人、正确线程回复及有界文本分片。
首期每个机器人配置单个 Microsoft 商业云租户。Graph 历史、附件、卡片、定时
消息、共享频道与跨租户聊天不在范围内。真实租户安装和送达验收与自动化协议
测试分别记录。

## 组件

| 组件               | 职责                                                             |
| ------------------ | ---------------------------------------------------------------- |
| Microsoft SDK 适配 | 验签、入站 Activity 处理与主动文本发送                           |
| Activity 规范化    | 可信 actor、规范 conversation、帖子根 thread、mention 和回复目标 |
| Teams 入站入口     | 独立的验签 HTTP 入口，只等待一个接收回调                         |
| TeamsChannel       | 复用 ChannelBase 路由、bridge 执行、命令与最终文本输出           |
| Reference store    | 可替换的会话引用持久化及 standalone 本地实现                     |
| 宿主钩子           | ACK 前等待接收、可信持久事件派发、准入与受保护的发送回执         |
| 扩展清单           | 同一插件可独立安装，无需修改内置 provider registry               |

使用 Microsoft SDK 的认证，不自行实现 JWT 校验。接收消息正文前校验配置
租户和目标机器人。使用 tenant 范围内的 AAD object ID 识别 actor，显示名不
作为执行身份。频道 conversation 与线程后缀分别规范化，保留精确回复目标的
原始 SDK reference。忽略群内非 @ 消息及机器人自身消息。

为当前机器人显式配置单一 SDK connection 和路由。宿主的 `Connections__*`
注册表不能替换其 audience、tenant 或必要的 issuer 校验。两个入站入口
共用该隔离配置。

插件不拥有应用特定的用户绑定或数据库结构。应用通过既有 bridge 和 router
选择执行身份。群共享使用既有 `chat_thread`，操作员与可提问成员分开；无需
新增 session scope 或修改推理核心。当前 base 的 `operators` 配置为空时，
不授予共享命令权限。

## 宿主契约

`createTeamsIngress(name, credentials, acceptInbound)` 返回带有
`handleWebhook(input)` 的对象。`TeamsCredentials` 仅包含 `appId`、
`appPassword` 和 `tenantId`；回调接收 `TeamsInboundEvent` 并返回
`Promise<void>`。构造时不启动监听器，不创建 bridge 或 router，不访问
reference store，也不需要 approval mode。没有 connect/disconnect 生命周期。
宿主负责 HTTP 路由、入口对象生命周期、持久化去重和后续执行；机器人凭据或
渠道名变化时重新构造入口。

Standalone 模式拥有本地 webhook 监听器。宿主执行仍使用 `TeamsChannel`；
它的 webhook 方法与独立入口共用 SDK adapter 构造、认证和规范化实现。
独立入口不实例化 ChannelBase。成功 HTTP 响应必须等待宿主接收回调完成；
持久化失败返回请求失败，不能提前成功 ACK。接收不等待 Agent 最终回答。绑定命令可由宿主在
普通 prompt 派发之前消费。

两个入口使用相同的正文大小限制，构造全新 SDK request 后验签，不信任调用方
提供的身份；保留 SDK invoke 的状态码、响应头和响应体。认证失败返回 401，
规范化拒绝返回 400，接收或 SDK 处理失败返回 503。忽略的
Activity 不调用宿主。入站 API 不增加队列、去重、重试、恢复或应用绑定。

只有可信应用代码可派发持久事件，不提供跳过验签的 HTTP 参数。事件保留
不可变的来源、actor 和目标事实，便于宿主再次检查原始配置和绑定代际。
每个实际发送的分片均执行宿主检查，并报告平台回执。后来的消息不能替换
先前在途任务的回复目标或身份。检查拒绝必须阻止外部发送，不确定发送错误
不触发盲目重试。

插件在 bridge 提交前等待 `beforePrompt`，在 bridge 调用完成前等待
`onPromptSettled`。实际交付全文由 `beforeSend.fullText` 确定，可能包含
base 添加的来源标签。宿主可以用 `sendEventText` 的 `startChunkIndex`
恢复确定未发送的后续分片，保持原始分片序号与全文不变。

prompt 完成结果为空白或 UTF-8 文本超过 64 KiB 时，通过 ChannelBase 正常
回复路径返回简短完成提示。宿主 settlement 钩子仍收到原始结果。独立执行和
宿主执行均遵循此规则，取消检查、发送保护与回执维持原有顺序。settlement
钩子不能直接发送此提示，否则会绕过 base 的取消检查。这里只处理当前调用
已知的结果，不新增存储或恢复。

只有 prompt 进入既有会话队列。目标 prompt 仍在运行时必须能接收取消。
宿主持久化不能增加等待整个 `handleInbound` 完成才接收控制命令的第二层
队列。宿主可以收紧命令权限，普通 standalone 用户行为保持独立。

## 持久化与失败边界

默认 reference store 服务单个本地进程，不承诺分布式租约、持久执行队列或
精确一次交付。需要重启恢复和 fencing 的宿主替换存储与接收流程。持久引用
不能证明 Agent 结果可恢复。宿主须区分未提交事件、已知 prompt 与不确定
提交，不能因为响应丢失就重新执行工具。

## 文件与打包

新增 `packages/channels/msteams/`、扩展清单、测试和 README，以及既有根
workspace 声明与 lockfile。协议代码只存在于该包，依赖 ChannelAgentBridge，
不新增数据库驱动或应用网关依赖。包名及正式收录由维护者评审决定。外部
宿主将插件作为可部署依赖前，必须取得不可变包制品。

版本发布同步更新扩展清单、当前精确 channel-base peer 和开发依赖，同时保留明确支持
的旧版 peer。发布不能安装第二份 base，也不能排除本次发布的 base 版本。

## 验证

自动化覆盖 SDK 拒绝认证、tenant/bot 校验、mention、规范 conversation、
帖子隔离、重复事件、等待接收与失败、宿主重放、回复关联、逐片发送保护、
停止及长 prompt 中取消。宿主契约尽可能使用真实本地 HTTP 监听器和 SDK；
模拟的 Microsoft 发送明确标注，不能作为真实 Teams 送达证据。

已验证的 peer 版本仅为 0.23.0 与 0.26.1。0.23.0 只支持宿主模式，宿主必须在
dispatch 前授权所有控制命令；旧版缺少共享会话 operators 与停止后的排队门禁，
因此插件明确拒绝独立启动。0.26.1 支持两种模式。不声明中间版本兼容。
插件使用 peer dependency，始终复用宿主的单份 ChannelBase。

51 个插件单测通过；编译产物在 0.26.1 的 18 个适用 channel 用例及 0.23.0
宿主模式的 16 个 channel 用例通过。独立验证采用真实 Fastify、Microsoft SDK JWT 处理、临时
RSA/JWKS 和云端发送记录器。consumer 类型检查与单份 base 实例验证通过；
严格检查第三方声明时，ACP SDK 诊断与只导入 base 的基线相同。

独立入口在两版 base 上各通过 12 组编译产物公共 API 用例，过程中不构造
channel、bridge 或 router；覆盖真实 SDK JWT 验证、宿主 connection 注册表
隔离、回调完成与失败、invoke 响应保留、忽略 Activity 和并发调用。部分
畸形 Activity 在规范化之前被 SDK 拒绝并返回 503，均不会进入接收回调。
两个发布脚本回归用例通过，其中包含 prerelease；独立 0.26.2 发布 fixture
打包实际插件和 base 编译产物，共同安装后验证公共入口可加载且只有一份
物理 base。以上检查均不代表真实租户验收完成。

完成结果与取消验证在 0.26.1 通过 11 组、0.23.0 宿主模式通过 8 组，覆盖
空白与超长提示、恰好 64 KiB 边界、原始宿主 settlement、正常发送保护与
回执，以及 settlement 期间取消后不发送提示。撤销会阻止交付，后续任务
仍可正常完成。

分别验证当前 ChannelBase 与宿主锁定版本。只在契约测试证明实际缺口时
修改共享接口。`.qwen/e2e-tests/teams-channel.md` 与
`.qwen/e2e-tests/teams-minimal-ingress-v4.md` 记录基线、命令与依赖租户的待验项。
功能贡献遵循上游提案和评审流程，本地实现不代表获得批准。

## 待验证点

- 真实 Teams 租户安装、mention Activity 和回复送达。
- 下游部署使用的可复现、不可变插件制品。
