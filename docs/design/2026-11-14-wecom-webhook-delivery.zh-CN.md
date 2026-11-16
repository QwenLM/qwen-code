# 企业微信群 Webhook 投递

[English](2026-11-14-wecom-webhook-delivery.md) | [简体中文](2026-11-14-wecom-webhook-delivery.zh-CN.md)

## 状态与范围

本设计对应 [#17215](https://github.com/QwenLM/qwen-code/issues/17215)，于
2026-11-14 对照主干 `114694062b83f69093a936a3caea4c35bdbeb41d` 与企业微信
官方文档核验。实现验证单独记录；本设计不声称已完成真实企业微信发送。

扩展既有[出站频道设计](2026-11-10-outbound-webhook-channels.zh-CN.md)，分为
两个 PR：先适配器及注册，再共享 Web 配置。两个 PR 均保持 Draft，等待后续
评审。不需要新的公开投递契约。

## 问题与现有行为

Qwen Code 已通过 Bot ID/Secret 和 WebSocket 支持企业微信智能机器人，并通过
独立的 WeCom Callback 接入自建应用。两者都不接受群「消息推送」URL。
钉钉和飞书已有仅发送 Webhook 插件，支持配置目标、敏感凭证编辑、工作区
归属校验和共享 Web 控件。

仅需将定时结果发送到内部群的用户，应能配置群 URL，而无需应用凭证、公网
入站服务器、已观察联系人或手动输入聊天 ID。Uptime Kuma 与 Apprise 都已
实现钉钉、飞书、企业微信群 Webhook；它们当前的企业微信文本实现证明功能
覆盖的先例，不定义本适配器的 Markdown 协议或错误处理策略。

## 目标与边界

提供命名的 `wecom-webhook` 频道、本地启动/停止就绪状态、可读 Markdown
结果及既有配置目标投递流程。保留企业微信智能机器人、独立 Callback
入口、旧任务目标和既有手动触发/每次新会话投递语义。

不包含入站事件、可配置 mentions、成员查询、媒体上传、交互卡片、自动重试、
队列、分片、测试发送 UI/API、Generic Webhook 或新任务生命周期事件。不重排
无关频道入口，也不引入通用通知框架。

## 后端与配置

从既有企业微信包导出 `webhookPlugin` 和适配器，保留会话及回调导出。
沿用钉钉、飞书的加载模式注册新增内置类型。为既有代理传输模式直接声明
Undici 依赖。

插件声明 `outboundOnly: true`、必填敏感字段 `webhookUrl`，以及标签为
`Configured group` 的 `chat/default` 默认投递目标。复用既有环境变量引用、
脱敏回读和保留/替换行为。管理校验可接受合法环境变量引用；连接时校验解析后
的 URL。必填 URL 不可为空。

只允许 `qyapi.weixin.qq.com` 的 HTTPS
`/cgi-bin/webhook/send` 地址，且恰有一个非空 `key` 参数。拒绝用户凭证、
片段、自定义端口、其他参数、编码/规范化路径变体及不支持的主机。凭证值只接受
单个 URL 非保留字符序列（字母、数字、`-`、`.`、`_`、`~`）；这是保守的本地
校验策略，不是对平台未来所有 key 格式的断言。不增加 signing-secret 字段：
URL 的 key 即凭证。不跟随重定向；传输覆盖方式仍是工作区配置的代理。

一个频道对应一个 URL。任务保存既有逻辑目标而非凭证；修改 URL 会影响该
命名频道后续发送。只接受本适配器自己的群目标，chat ID 和 sender ID 均为
`default`，且无 thread。拒绝任意收件人、会话循环任务目标及入站
webhook-task 执行目标。显式 Notify、提示词结果和支持的持久定时任务投递
复用现有频道边界，不创建会话代理会话。

## 载荷、正文限制与 mentions

每次发送一个 JSON，包含 `msgtype: "markdown_v2"` 和
`markdown_v2: { content: text }`。保留输入文本；无需格式转换器、额外标题、
mention 转换或降级消息。普通文本也是合法输入。官方子集包括标题、强调、
列表、链接、引用、代码和表格，不承诺完整 GFM。

用 `Buffer.byteLength(text, "utf8")` 度量实际正文字符串。接受不超过
**4096 字节**的正文，更长内容在网络 I/O 前拒绝。这是正文的字节上限，
不是序列化 JSON 上限。测试 ASCII、中文、emoji 和大量 JSON 转义字符的
精确边界及越界情况。保留既有共享投递上限，不静默截断、分片或发送降级请求。

与旧 text/markdown 格式不同，`markdown_v2` 不支持 `<@userid>`、
`<@all>` 或字体颜色语法。不发送 mention 数组，也不把任务文本转换为
mentions。单测验证载荷和内容保留；真实客户端呈现及无 mention 通知仍需
真实 smoke 验证。4.1.36 以下客户端（Android 4.1.38 以下）显示纯文本。

## 传输、失败与生命周期

沿用经过评审的飞书/钉钉传输模式，不重构这些适配器或新增共享框架。
一次尝试最多一个请求，使用 **15 秒超时**、**16,384 字节响应上限**，
配置工作区代理时使用请求独享的 Undici dispatcher。遵循既有 `NO_PROXY`
行为，不替换全局 dispatcher。

成功要求 HTTP 成功响应及解析为对象的数字安全整数 `errcode === 0`。
缺失/字符串错误码、数组、无效 JSON 和超大响应均不能报成功。不暴露远端
`errmsg`、原始响应、URL key 或任意抛出错误文本。

复用 `ChannelProactiveDeliveryError` 和现有结果传播：

| 失败                                       | 分类                           |
| ------------------------------------------ | ------------------------------ |
| HTTP 408、425、429 或 5xx                  | 临时                           |
| 其他 HTTP 非成功状态                       | 永久                           |
| 企业微信 -1、45009 或 45033                | 临时：系统繁忙、频率或并发限制 |
| 其他非零企业微信错误码                     | 永久                           |
| 网络、被拒绝的重定向、无效响应、超时或取消 | 临时；绝不自动重试             |
| 无效目标、未就绪或正文超长                 | 永久                           |

官方发送频率为**每个 Webhook 每分钟 20 条**。显式报告限流，不增加本地队列。
API 接受不代表收件人收到或阅读；超时/取消也可能发生在远端已经接受请求之后。

连接只校验本地配置，不发送远端测试消息。断开时清除就绪状态、终止全部在途
请求，并提供排空 promise。生命周期代数防止较早的 connect 在 stop 后恢复
就绪。重连等待排空；各请求独立清除定时器、释放 reader/dispatcher 资源。

## 共享 Web 集成

仅包含后端 PR（#17223）、尚未包含 Web 集成（#17224）的版本，其 Web Shell
不识别 `wecom-webhook`：频道管理器没有创建入口，并隐藏已有实例。过渡期请
通过 `settings.json` 和 `qwen serve --channel <name>` 管理频道。以下 Web
集成补齐创建入口及已有实例的展示和管理。

将 `wecom` 和 `wecom-webhook` 归入企业微信平台，方式分别准确标注为
`Intelligent bot` 和 `Webhook sending`。保留 `wecom-callback` 的独立
入口。复用当前平台 helper、本地化标签、凭证控件、仅发送模式的设置显隐和
配置目标选择器，不新增 SDK 或 daemon 路由。

Webhook 编辑器只有必填敏感 URL，没有 signing-secret 字段。新增/编辑/保留/
替换及必填校验必须正确。宿主启用相关页面并提供 daemon 工作区时，
`qwen serve` 和 `WebShellWithProviders` 使用相同控件。回归验证已有
智能机器人和独立 Callback 入口。

## 文件与交付顺序

后端改动限于企业微信适配器/插件及测试、依赖清单/锁文件、内置注册及测试、
本双语设计、用户指南和文档导航。Web 改动包括平台分组、标签、既有编辑器/
选择器回归测试、浏览器场景及用户指南中的 Web 段落。保留包边界和既有归属校验。

后端 PR 引用 #17215 但不关闭它；Web PR 依赖后端，在两部分合入后完成该
issue。两份均以 Draft 创建。Web 分支包含后端，供本地端到端测试。

## 验证与待补证据

实现前记录基线缺少内置类型及 Web 方式。如果没有全局 CLI，明确记录构建产物/
源码替代方案。运行针对性包测试、build、typecheck、bundle 及改动文件的
格式/lint 检查。覆盖 URL 校验、环境变量引用、凭证脱敏、精确字节边界、
业务/HTTP 错误、取消/并发、代理/绕过及原有企业微信行为不变。

用本地 daemon/worker、模拟模型和本地 CONNECT 代理后的 HTTPS 模拟端点，
验证配置目标定时投递及失败，不发送到真实群。浏览器验证 Web 新增/编辑/
启动/停止和定时目标流程，包括非主工作区及窄屏。模拟验证证明我们的集成
行为，不证明真实平台渲染。

真实企业微信验证需要有权限的内部群及消息推送 URL。官方设置指南描述了内部群
及管理员控制，没有证明所有账号一律需要或豁免企业认证。个人测试账号可用性
影响 E2E 排期，不影响提出或实现功能。真实客户端 Markdown/mention 呈现及
真实凭证在实际测试前均明确标记待验证。

## 参考资料

- [消息推送协议](https://developer.work.weixin.qq.com/document/path/91770)
- [设置及创建条件](https://open.work.weixin.qq.com/help2/pc/14931)
- [全局错误码](https://developer.work.weixin.qq.com/document/path/90313)
- [Uptime Kuma 企业微信发送器](https://github.com/louislam/uptime-kuma/blob/4f6661cfa83a06be0353d5536ef3d9ee0064f534/server/notification-providers/wecom.js)
- [Apprise 企业微信群机器人发送器](https://github.com/caronc/apprise/blob/c6f76f3599ec9bc1591abfd4fc8c27a5124f88fa/apprise/plugins/wecombot.py)
- [发送错误协同 #7521](https://github.com/QwenLM/qwen-code/issues/7521)
