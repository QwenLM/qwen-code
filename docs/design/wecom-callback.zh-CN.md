# 企业微信自建应用 Callback 渠道

[English](wecom-callback.md) | [简体中文](wecom-callback.zh-CN.md)

## 问题与范围

现有 `wecom` 渠道使用 Bot ID 和 Secret，通过 WebSocket 连接智能机器人。
企业自建应用则向 HTTP 回调地址发送加密 XML，并使用企业和应用凭据发送回复。
这类应用目前无法接入 Qwen Code。

新增 `wecom-callback` 渠道，支持文本私聊，每个命名渠道对应一个企业自建应用。
多个应用分别配置渠道和监听端口。本次不包含媒体、群聊、应用事件、流式回复、
单个监听器内的多应用路由，以及持久化的消息接收和发送保障。

## 设计

从 `@qwen-code/channel-wecom` 导出独立的 `callbackPlugin`，在 CLI 注册表中显式
注册，并在 Web Shell 中提供配置描述。保留现有 `wecom` 插件和凭据要求。
独立类型避免了条件必填字段，也无需新增包或修改共享渠道运行时。

配置必填 `corpId`、`agentId`、`corpSecret`、`token` 和 `encodingAESKey`。
凭据支持环境变量引用。将三个秘密字段声明为 secret 描述符，以便现有设置服务
正确脱敏和保留。`webhookHost` 默认为 `127.0.0.1`，`webhookPort` 默认为 `8645`，
固定路径为 `/wecom/callback`。部署时通过自己的 HTTPS 反向代理或隧道暴露该地址。

每个适配器在所属渠道 worker 内拥有自己的 HTTP 监听器，不增加 daemon 路由或
进程全局监听器。监听失败会导致渠道启动失败；断开连接时关闭连接，并禁止该
适配器实例继续派发入站消息或调用出站 API。

GET 验证时校验 SHA-1 签名，解密 `echostr`，验证接收方 Corp ID，原样返回明文。
POST 限制请求体大小，先验签再解密，验证 PKCS#7 填充、数据结构、接收方 Corp ID、
XML 接收方和 Agent ID。使用 `saxes` 解析扁平 XML，拒绝 DTD、重复字段和嵌套结构。
使用 Node crypto 实现协议要求的 AES-256-CBC 数据结构及恒定时间签名比较。
仅接受近期签名请求以限制重放；通过有界内存消息 ID 缓存对同一进程内的平台重试去重。
只有准入发送者占用缓存条目，至少保留五分钟，且覆盖签名时间戳的整个有效窗口，
包括时间戳超前于本机时钟的情况。

已认证文本消息转换为私聊 envelope，进入 `ChannelBase.handleInbound`，保留现有
访问策略、配对、命令、权限和会话路由。无需等 agent 执行完成即可确认收到有效回调。
不支持的消息类型和生命周期事件直接确认，不启动任务。回复收件人必须是单个用户，
拒绝广播和多收件人标识。

通过固定的企业微信 `message/send` API 发送文本。缓存应用 access token，并共享
并发刷新请求；平台明确拒绝过期 token 时刷新并重试一次。API 请求设置超时，断开
连接时中止。错误信息脱敏，不包含 API URL 或凭据。按 Unicode 字符边界拆分回复，
每条不超过 2048 个 UTF-8 字节。共享运行时请求主动发送时，仅支持直接用户目标，
不支持群组或线程。

## 影响组件

- `packages/channels/wecom`：回调插件、配置、协议解析、加解密、HTTP 监听器、
  出站应用 API 和同目录测试。
- `packages/cli/src/commands/channel`：显式内置注册和测试。
- `packages/web-shell/client/components/channels`：平台可用性和回归测试，复用
  已有基于描述符的编辑器。
- 用户渠道文档、导航，以及现有固定版本 `saxes` 依赖对应的工作区锁文件。

共享工厂、独立 ACP 服务、daemon worker、设置存储、目录端点和 Web Shell 编辑器
通过现有契约使用插件。不改变核心协议、SDK 传输类型或 daemon 所有权规则。

## 验证与验收

使用企业微信官方 SDK 的固定密文样例作为独立已知答案，并独立构造加密消息。
单元和集成测试启动真实 loopback 回调服务器，配合模拟 agent bridge 和企业微信
API 响应。验证握手、提前确认、每个消息 ID 仅产生一次 prompt、访问控制、收件人
隔离、非法认证或 XML、请求体限制、token 缓存和刷新、字节安全拆分及监听器清理。
运行现有智能机器人测试，覆盖回归。

记录全局 CLI 基线，再验证本地构建 CLI 和协议测试脚本。执行 build、typecheck、
bundle 和聚焦测试；完成两轮干净的自查及独立审查。准确命令和证据保存在
`.qwen/e2e-tests/wecom-callback.md`。

真实平台验收需要企业微信管理员配置公网回调地址、应用可见范围和出站可信 IP，
然后验证 URL 校验、允许用户、拒绝用户及较长 Unicode 回复。离线测试无法证明
这些租户专属设置正确。PR 必须披露未执行的真实平台检查。确认接收后的进程中断
可能丢失执行中的任务，持久化恢复应作为独立变更。

## 开放问题

没有阻塞当前范围实现的问题。若没有企业测试应用，真实企业微信验证保留为明确的
评审者验收步骤。
