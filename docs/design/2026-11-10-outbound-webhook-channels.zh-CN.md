# 出站 Webhook Channel

[English](2026-11-10-outbound-webhook-channels.md) | [简体中文](2026-11-10-outbound-webhook-channels.zh-CN.md)

## 问题与范围

Issue #16751、#16752 和 #16753 希望降低向群机器人投递结果的配置成本。
现有钉钉应用机器人需要应用凭证及用户或会话 ID；自定义机器人使用配置好的
群 webhook URL，并可通过签名密钥保护。

第一阶段实现钉钉 webhook Markdown 发送，以及共享 Web Shell 中的配置、定时任务
目标选择。Notify、显式 prompt 结果和 persistent 定时任务结果继续
复用现有 Channel 投递链路。本设计使用受限逻辑目标，不新增线上 target 类型。

实现拆为 #16752 对应的后端 PR，以及依赖它的 #16753 Web PR。下文 Web 行为
描述的是后续依赖变更；后端可通过配置和现有投递 API 直接使用。

## 现有行为

持久化、daemon、ACP、worker IPC 和 SDK 的投递格式均接受 user 或 chat 加 ID。
ChannelBase 校验归属后调用适配器主动投递 hook，这条路径不创建 Agent 会话。
管理能力已有 secret 字段、环境变量引用、workspace 归属、reload 和运行状态；
定时任务也已经有 Channel 选择器。

Observed contacts 表示入站观测，有时间和容量限制，不是永久目标目录。
Worker 已在适配器 connect 成功后标记 connected，不要求持有 socket。

## 目标与管理契约

在 ChannelPlugin 和脱敏后的 Channel 类型目录中增加可选 outboundOnly 与
defaultDeliveryTarget 元数据。后者描述 user/chat 目标 ID 和可选显示名称，
不包含凭证。发布前验证元数据；既有插件不填写新字段时保持原有行为。

目录校验检查元数据结构、长度，并拒绝 `scheme://` 形式的 ID；它不是通用凭证
检测器。插件作者必须确保公开的 ID 和 label 不含凭证。除此之外，ID 保留既有
user/chat 不透明字符串语义，不引入仅允许 ASCII 字符的语法。

新 dingtalk-webhook 插件声明 outboundOnly 为 true，固定目标为 chat/default。
一个具名 Channel 绑定一个配置 endpoint；更换 URL 会改变通过该 Channel
进行的后续投递目的地。

适配器仅接受这一精确目标且不允许 thread，拒绝任意 ID、通用 loop 目标和
入站 webhook 任务目标。ID 是有文档说明、由适配器拥有的逻辑地址，既不是 URL，
也不是观察到的联系人。既有授权元组仍为 Channel 名称、type 和 ID。

管理面不为 outbound-only 插件添加接收策略和 Agent 会话控制。Web 从目录
元数据发现默认目的地，不依赖插件名称约定或伪造联系人。旧 daemon 没有这些
元数据时继续提供现有手填目标行为；旧客户端仍可读取未改变的投递格式。
旧 daemon 可能无法加载新插件，但新任务不会引入导致整份 cron 文件不可读的
未知 target kind。

## 钉钉适配器

在现有钉钉包中导出独立 webhook 插件，要求 secret 类型的 webhookUrl，可选
secret 类型的 signingSecret，复用现有环境变量引用及凭证编辑机制。既有应用
机器人配置保持不变。

验证 HTTPS 钉钉机器人 endpoint 和必需的 access token。每次发送使用
`msgtype: markdown`，复用现有钉钉 `extractTitle` 工具生成 `markdown.title`，
将传入正文保留在 `markdown.text` 中。普通文本也可作为消息正文。公共 Channel
投递契约仍是文本字符串，不新增消息格式设置或 Markdown 转换。钉钉文档列出了
[Markdown 子集](https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type)。
本适配器原样保留表格及其他 Markdown 语法，具体渲染由钉钉客户端完成；不转换
表格，也不承诺完整的 GitHub 风格 Markdown 渲染。

启用签名时按钉钉文档算法生成新的毫秒时间戳和 HMAC-SHA256 签名，不缓存已签名
URL。传输错误、无效响应、非成功 HTTP 状态及非零业务码均按 #7521 以有界、脱敏
原因拒绝。错误不得暴露凭证 URL、签名、密钥或消息正文，不进行隐式重试。

HTTP 408、425、429 和 5xx 按包内共享的钉钉策略分类为 transient。业务响应按
官方[自定义机器人错误码表](https://open.dingtalk.com/document/development/custom-robots-send-group-messages)，
将系统繁忙 `-1` 和限流 `410100` 分类为 transient；其他业务码保持 permanent，
除非有该 endpoint 的证据支持不同分类。通用传输失败无法确定投递是否已被接受，
因此脱敏错误保留这种不确定性。

Connect 验证本地配置并初始化发送资源，不发送消息或建立长连接。
Connected 表示本地已就绪，不代表远端凭证已验证。请求具有有界超时；disconnect
取消在途请求，关闭时等待请求结束。

首期长消息策略是保留共享链路现有 100,000 长度保护，将其结果作为一条消息提交。
这是本地安全边界，不保证钉钉接受该长度的消息。适配器不进行二次截断或拆分。
钉钉拒绝超长消息时，投递以脱敏错误报告失败，不发送缩短版本，也不自动重试。
由平台拒绝超长消息是首期明确选择的取舍。

截至 2026-11-10 查阅的官方[发送 API](https://open.dingtalk.com/document/orgapp/custom-robots-send-group-messages)
及消息类型文档未给出 Markdown 的精确长度上限或计量单位。平台阈值仍未验证，
需要权威协议证据或有记录的真实机器人边界探测才能确定。本地协议测试及真实
客户端成功渲染 Markdown 均不能证明该阈值。

## Web 行为

在钉钉平台入口下组织应用机器人和 webhook 两种方式，后端 plugin type 保持
独立。仅发送编辑器展示 endpoint 凭证和生命周期控制，不显示接收策略、配对和
Agent 会话设置；清空必填 URL 时不得保存无效配置。

定时任务选择配置目标后，自动填写声明的逻辑目标，不要求输入用户/聊天 ID。
保留既有手填目标、不可用的已存目标，以及创建、编辑、清除的往返行为。
不得把已保存的不支持 ID 静默改写成默认值。Persistent/per_run 限制继续有效。

qwen serve 与启用相关导航和 daemon workspace 的 WebShellWithProviders 使用
相同共享组件。

## 受影响组件

| 组件                    | 变化                                               |
| ----------------------- | -------------------------------------------------- |
| Channel base 类型与导出 | 可选管理元数据，保留现有运行时 hooks               |
| CLI registry 与管理     | 注册 webhook 插件，验证/投影元数据，不追加接收控制 |
| TypeScript SDK 目录     | 镜像可选元数据，投递格式不变                       |
| 钉钉包                  | Webhook 适配器、插件及协议/生命周期测试            |
| Web Shell               | 平台方式选择、编辑器、配置目标及测试               |
| 用户与设计文档          | 配置、逻辑目标、行为和验证限制                     |

## 替代方案与边界

新的无 ID configured kind 语义直接，但需要同步修改解析器、IPC、授权、SDK
和 cron 文件。旧 reader 对未知 kind 会拒绝整份任务文件，新 writer 无法改变
旧 reader。受限逻辑地址可以实现首期目标而不增加此迁移成本。

伪造 observed contacts 会引入过期与虚假观测语义；复用入站 targetRef 会把
Agent 执行混入直接投递，均不纳入本设计。不另建通知路由器或 worker。

飞书及其他平台适配、通用 webhook JSON 契约、任务生命周期事件、卡片、附件、
持久重试、通知历史和 per_run 投递仍在本阶段范围外。在第二个适配器证明共同
行为之前，不要求预先构建通用 HTTP 抽象。

## 验证与验收

验证严格目标归属与拒绝、Markdown payload/标题生成、普通文本及 Markdown
正文保留、签名、HTTP 成功但业务失败、无效响应、超时、
关闭取消及错误脱敏。验证目录兼容性、凭证编辑、无需联系人的默认目标选择、
已存目标往返、旧 daemon 回退及 workspace 内配置与投递；覆盖既有应用机器人和
手填 user/chat 目标回归。

完成 build、typecheck、bundle 和针对性测试。在无模型凭证条件下，以本地 HTTP
fixture 验证投递路径，并验证共享 Web Shell 浏览器流程，准确记录模拟的传输
边界。如无测试机器人凭证，明确把真实平台冒烟标为待验证，不宣称已通过。
详细 E2E 计划和结果位于 `.qwen/e2e-tests/outbound-webhook-channels.md`。
