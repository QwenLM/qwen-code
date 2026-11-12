# 飞书自定义机器人 Webhook 投递

[English](2026-11-12-feishu-webhook-delivery.md) | [简体中文](2026-11-12-feishu-webhook-delivery.zh-CN.md)

## 状态与范围

本文是 [issue #16997](https://github.com/QwenLM/qwen-code/issues/16997) 的设计提案，
已于 2026-11-12 对照仓库基线 `8a8fe0fc4ddc1189d489bf0d711a52f2ebb05723` 和当前
飞书文档核查。实现及验证结果与提案分开记录。本文不声称已完成真实飞书投递。

本功能新增飞书自定义机器人的出站投递，以及配置所需的小范围共享 Web 集成。它扩展
已合入的[出站 Webhook Channel 设计](2026-11-10-outbound-webhook-channels.zh-CN.md)，
沿用现有 Channel 投递、配置和生命周期契约。

工作拆为两个依次推进的 PR：先完成后端适配器、注册和协议测试，再完成共享 Web 配置
及交互测试。第二个 PR 依赖第一个，两者共同完成同一个 issue。

## 问题与现状

现有飞书应用机器人 Channel 需要应用凭证，并支持入站通信。它的入站 Webhook 模式与
向自定义机器人所配置的群发送任务结果是不同的集成。仅需群消息出站投递的用户，不应
必须配置应用凭证、入站服务器、联系人发现或手动输入聊天 ID。

钉钉已提供独立的仅发送 Webhook 插件、公开的 `outboundOnly` /
`defaultDeliveryTarget` 元数据、敏感配置字段和共享 Web 连接方式选择器。
Notify、显式 prompt 结果投递和固定会话定时任务结果投递使用同一条 Channel 投递路径。
ChannelBase 检查目标归属后，将主动发送委托给适配器，不创建 agent 会话。

飞书包已有用于应用机器人消息的 Markdown 卡片构建器。该构建器会添加预览摘要，并
可添加标题、流式状态、折叠面板和控件。应用机器人传输将卡片序列化到使用租户认证的
消息请求中，并按字符数量分片。这些默认行为和传输方式不定义自定义机器人的 Webhook
协议。

## 目标与边界

提供完整流程：选择飞书及其 Webhook 方式，配置命名 Channel，保存并启动，然后在定时
任务中选择它配置的群作为投递目标。保留现有飞书应用机器人方式和已保存目标的行为。
当宿主启用相关页面并提供 daemon workspace 时，`qwen serve` 与
`WebShellWithProviders` 使用同一组共享控件。

通过静态卡片发送可读的纯文本和 Markdown，提供明确的本地限制、可选签名、有界请求
和脱敏错误。公开投递输入仍是文本字符串，不增加消息格式设置。

本次不包含测试发送 UI 或 API、入站回调、交互按钮或卡片回调、CardKit 会话、流式输出
或卡片更新、附件、动态接收方、可配置 mentions、用户 ID 发现、自动请求分片、重试或
outbox、新任务生命周期事件、其他平台以及 Generic Webhook。现有每次新会话和手动
触发的投递语义保持不变。

## Channel 与配置契约

从现有飞书包导出独立的 `feishu-webhook` 插件，保留应用机器人的现有 `plugin` 导出。
通过现有注册表注册为内置类型。不新增 Channel 包、SDK action、投递目标种类、能力
版本或平台专属任务字段。

插件声明 `outboundOnly: true`，并在 `defaultDeliveryTarget` 中声明固定逻辑目标
`chat/default`。一个命名 Channel 对应一个配置的端点。任务仍保存现有 channel/type/ID
元组，不保存端点或凭证。更新端点会改变该命名 Channel 的后续投递位置。适配器只接受
属于自身的 `chat/default` 群目标，且不允许 thread；拒绝任意 ID、一般执行目标和入站
Webhook 任务目标。

配置包含必填敏感字段 `webhookUrl` 和可选敏感字段 `signingSecret`。复用现有环境变量
引用、脱敏和保留/替换/清除机制，包括可选签名密钥的环境变量解析。管理侧校验可以保留
环境变量引用；运行时连接校验解析后的实际值。清除必填 URL 后不得保存无效配置。
敏感值和端点 token 不得出现在公开目录元数据、任务记录、常规配置回读或诊断信息中。

端点策略仅接受 `open.feishu.cn` 上的 HTTPS，路径为
`/open-apis/bot/v2/hook/<nonempty token>`。拒绝其他主机或路径、查询参数、片段、
用户信息及自定义端口。这是有意限制的端点白名单，不表示支持 Lark 域名、编码到 URL
中的任意代理或通用 HTTP 目标。本地校验只接受一个非空的 URL-unreserved token 段
（字母、数字、`-`、`.`、`_`、`~`），排除编码后的分隔符。这是本地约束，不声称覆盖
平台 token 的完整字符语法。拒绝重定向。
传输覆盖仍使用 workspace 的代理配置。

现有目录投影、管理存储、daemon 投递、worker IPC、授权和 SDK 传输类型已经支持此
契约。除非实现发现具体缺口，否则直接复用，不修改其生产代码。

## 静态 Markdown 卡片

发送一个 JSON 请求，使用 `msg_type: "interactive"`，并以 `card` 对象承载
`schema: "2.0"` 卡片。正文仅包含 Markdown 元素：

```json
{
  "msg_type": "interactive",
  "card": {
    "schema": "2.0",
    "body": {
      "elements": [{ "tag": "markdown", "content": "Task result" }]
    }
  }
}
```

官方自定义机器人指南包含这种卡片 schema，并明确说明自定义机器人卡片不支持回传
交互。协议名称 `interactive` 不意味着本功能要引入交互控件或回调。

不添加 header/title、预览摘要、流式状态、折叠控件或停止按钮。摘要会在有大小限制的
请求中重复任务文本，应用机器人构建器的其他默认行为在此也不需要。构建一个小型静态
封装，不修改现有构建器的输出。

通过小范围导出复用纯函数 `splitByTables`，保留应用机器人的卡片结构和传输方式。
同时小范围修正其围栏识别：只有位于行首、允许前置空格或制表符的反引号或波浪号围栏
改变代码块状态，闭合围栏必须与开始围栏匹配。这能保留列表中的嵌套代码块，并避免把
波浪号围栏内类似表格的文本拆成破损的卡片元素。
它将表格片段及周围文本放入同一卡片内不同的 Markdown 元素，不将
投递拆为多个请求。官方 schema 2.0 Markdown 文档规定每个 Markdown 元素最多支持四张
表格，并说明超过五行数据后自动分页；每个元素保留一张表符合这一已知边界。保留代码
围栏中类似表格的文本，验证正文、表格和代码混排。Webhook 投递不使用应用机器人的
`splitChunks` 或其字符数量限制。

曾考虑单独提交这处格式处理修复。将其保留在适配器 PR 中，是因为 Webhook 卡片复用
该辅助函数，首个版本就需要正确保留代码围栏中类似表格的文本。回归测试也覆盖现有
应用机器人的卡片构建器，其传输方式和卡片封装保持不变。

纯文本、标题、列表、链接、代码围栏、表格、中文和 emoji 都是有效输入。保留正文，不
静默截断，也不引入通用 Markdown 转换层。记录飞书支持的语法子集和呈现限制；不承诺
完整的 GitHub-flavored Markdown 或所有客户端呈现一致。

### Mention 标记的字面处理

任务输出不得主动请求 mentions。在构建 Markdown 元素之前，不区分大小写地处理完整
的 `at` 开始和结束标签，将其字面分隔符替换为 `&#60;` 与 `&#62;`。保留标签的其余文本
及无关 Markdown。例如：

```text
<at id=all></at>
→ &#60;at id=all&#62;&#60;/at&#62;
```

对任务文本一致应用该策略，包括代码示例和其他受支持标记内的标签。转义前不解码已有
实体，不引入 ID 查询。测试覆盖个人 mention、`ids` 列表、带引号属性、大小写和空白
变体、结束标签、嵌套 font 标记和已转义文本。

当前官方 Markdown 文档建议使用数字 HTML 实体来显示字面的 `<` 和 `>`，但未说明所有
解析阶段、畸形标签的处理或多次实体解码行为。单元测试能证明我们的转换，不能证明
每个客户端的通知行为。真实平台验收必须检查展示内容及是否没有触发 mention 通知；
尚未明确的解析变体是证据边界，不能据此声称实现了完整 HTML 清理器。
代码示例可能直接显示实体文本，取决于客户端的代码渲染器；这类示例的精确呈现属于
真实平台验证范围。

## 签名与请求大小

配置 `signingSecret` 时，每次发送生成新的秒级时间戳。以
`timestamp + "\n" + signingSecret` 的 UTF-8 字节作为 HMAC-SHA256 密钥，对空字节
消息签名，再将摘要编码为 Base64。把 `timestamp` 和 `sign` 放在外层 JSON 对象中。
不复用钉钉的毫秒级时间戳和查询参数签名算法，也不缓存已签名请求。

以下预期值已用 Python `hmac`/`hashlib`/`base64` 独立计算，应作为固定测试向量：

| Timestamp    | Secret        | 预期 `sign`                                    |
| ------------ | ------------- | ---------------------------------------------- |
| `1599360473` | `test-secret` | `wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=` |
| `1700000000` | `飞书-secret` | `lUmB8m+S7VOLIZHF9rQzsIijqKEqJb5ra9uO6rvwCfE=` |

完成 mention 处理、卡片构造和可选签名后，将最终请求序列化一次。使用
`Buffer.byteLength(body, "utf8")` 测量同一个字符串，并把它传给 fetch。采用
**20,000 字节作为保守的本地请求预算**。接受恰好位于本地边界的请求；超过边界时，必须
在任何网络请求前返回明确且脱敏的大小错误。限制计入 JSON 语法及转义、所有 Markdown
元素和签名字段。

端点专属指南规定整请求体上限为 20 KB，但未定义它表示 20,000 还是 20,480 字节；
通用消息 FAQ 另有不同说明。本地选择 20,000 字节是保守策略，不是已验证的平台精确
最大值，也没有解决文档之间的差异。保留现有共享投递限制作为更早的防护。发生本地或
远端拒绝时，不静默截断、不回退到其他载荷、不分片，也不自动重试。

## 传输、错误与生命周期

直接遵循经过 review 的钉钉适配器请求生命周期。需要代理时，使用请求级的 Undici
fetch/dispatcher 和解析后的 workspace 代理，遵守现有 `NO_PROXY` 绕过行为。不修改
全局 dispatcher。飞书包直接声明所需的 Undici 依赖。第二个适配器不足以要求构建宽泛的
共享 HTTP 框架；只有实际复用足够小且能保持行为时才提取辅助函数。

每次投递尝试至多发送一个请求，设置 **15 秒超时**及 **16,384 字节响应体上限**。
解析 JSON 前限制读取大小，必要时取消并释放 reader；成功、失败和取消时都清理超时
和 dispatcher 资源。不跟随重定向，不将响应正文回显到错误中。保留
`redirect: 'error'`：fetch 会拒绝重定向，不向适配器暴露 HTTP 响应，因此沿用脱敏的
临时传输错误路径，不进入 HTTP 状态码分类。

只有 HTTP 成功且解析出的对象包含数字 `code === 0` 才成功。不把字符串 `"0"`、缺失
code 或历史 `StatusCode` / `StatusMessage` 字段视为成功。通过现有投递结果呈现有界、
脱敏的失败原因：

| 失败情况                              | 分类策略                             |
| ------------------------------------- | ------------------------------------ |
| HTTP 408、425、429 或 5xx             | 临时错误                             |
| 其他非成功 HTTP 响应                  | 永久错误                             |
| fetch 拒绝，包括被 fetch 拒绝的重定向 | 临时错误，不自动重试                 |
| 飞书数字业务码 `11232`                | 临时错误；文档确认的自定义机器人限流 |
| 其他非零业务码                        | 默认永久错误，除非有该端点的明确证据 |
| 畸形或缺失的业务响应，或响应过大      | 失败，不推断为成功                   |

临时错误分类不引入重试。关键词、IP、签名或时间窗口拒绝必须失败，且不暴露平台原始
消息、端点或提交的正文。传输失败和取消不能证明远端是否已接受请求，脱敏诊断应保留
这种不确定性。不假设所有限流都返回 HTTP 429 或提供 `Retry-After`。

`connect()` 校验解析后的本地配置，并将适配器标为可发送状态。它不建立持久连接、不
创建 agent 会话，也不发送认证或测试消息。Connected 表示本地就绪，不表示远端凭证
已验证。显式启动和停止控件遵循现有 Channel 生命周期。

像钉钉适配器一样跟踪进行中的请求和连接 generation。`disconnect()` 阻止后续发送，
取消当前请求并开始 drain；关闭流程等待请求结束和资源清理。重新连接不得与上次
drain 或被中断的启动发生竞态。保留 workspace 重载和删除 Channel 时的现有行为。

## 共享 Web 行为

把 `feishu-webhook` 加入受支持的平台类型，并使用飞书的平台标记。无论 descriptor
顺序如何，都将应用机器人和 Webhook 方式归入同一个飞书入口。连接方式选择器选择底层
插件类型。将原本钉钉专属的标题和说明改为中性的连接方式文案，并在所有支持的语言
（当前为 `en`、`zh-CN` 和 `ru`）中翻译新增及修改的字符串，遵循现有回退约定。

为 Webhook URL 和签名密钥字段映射翻译后的标签及说明。复用现有敏感字段编辑器、保存
校验和生命周期控件。`outboundOnly` 已能隐藏接收策略、配对和 agent 会话设置；不另外
增加飞书专属编辑器。保留现有应用机器人表单和行为。

定时任务从 `defaultDeliveryTarget` 获得配置的群，无需联系人发现或手动输入 ID。
复用创建、编辑、清除、读取和列表的往返行为、已保存但不可用目标的处理，以及 workspace
归属检查。不将已保存但不受支持的目标静默改写为 `chat/default`。通用“已配置的群聊”
标签继续本地化。现有固定会话/每次新会话限制，以及手动 user/chat 目标仍然适用。

## 受影响组件与 PR 顺序

| PR  | 组件                                                                | 预期改动                                 |
| --- | ------------------------------------------------------------------- | ---------------------------------------- |
| 1   | `packages/channels/feishu/src/FeishuWebhookChannel.ts`              | 新增出站适配器、协议、大小和生命周期处理 |
| 1   | `packages/channels/feishu/src/webhook-plugin.ts`、`src/index.ts`    | 插件元数据、敏感字段、工厂与导出         |
| 1   | `packages/channels/feishu/src/markdown.ts` 或小型纯函数文件         | 复用表格分段，并修正代码围栏识别         |
| 1   | `packages/channels/feishu/package.json`、lockfile                   | 所需的直接传输依赖                       |
| 1   | `packages/cli/src/commands/channel/channel-registry.ts`             | 注册内置插件                             |
| 1   | 同目录飞书测试、注册表测试及 CLI 投递 fixture                       | 协议、生命周期、代理、注册和投递覆盖     |
| 1   | 用户/设计文档及 E2E 计划                                            | 配置、限制和验证证据                     |
| 2   | `packages/web-shell/client/components/channels/channel-platform.ts` | 识别 Webhook 类型并使用飞书标识          |
| 2   | 同目录的 `ChannelsManagerPage.tsx`、`ChannelEditorDialog.tsx`       | 平台分组、方式选择和翻译字段映射         |
| 2   | `packages/web-shell/client/i18n.tsx`                                | 中性连接方式文案和所有支持的语言条目     |
| 2   | Channel/编辑器/任务测试及 Web E2E 流程                              | 配置、敏感字段编辑、就绪和配置目标       |

Web PR 合入前，后端 PR 可通过 CLI/配置和现有投递 API 使用。在此过渡阶段，Web Shell
尚不识别 `feishu-webhook`，Channels 管理页既不显示新建入口，也不显示已有实例。
在 PR 2 合入前，无法通过该页面启动、停止、编辑或删除这些实例，应使用 CLI/配置管理。

预计不修改 ChannelBase、
daemon 路由、任务持久化或 SDK 契约。如果实现发现必须修改契约，应重新审视本设计，
不能静默扩大 PR 范围。

## 验证与验收

使用有独立预期载荷的针对性测试，以及上面的固定签名向量。覆盖端点校验和环境变量
引用、精确目标归属、纯文本和 Markdown 元素、表格/代码/正文混排、mention 转换、
中文/emoji 和 JSON 转义、有签名及无签名的最终字节计数，以及 20,000/20,001 字节本地
边界。断言超限请求不执行 HTTP 发送，其他每次尝试至多发送一次。

分别测试 HTTP 和业务错误，包括关键词、IP、签名、限流、畸形/历史/字符串 code 响应及
响应体超限。验证错误脱敏、超时、并发停止/重新连接、drain 完成、workspace 代理和
`NO_PROXY` 路由、dispatcher 清理及不修改全局 dispatcher。通过现有 daemon 或 worker
路径添加本地投递 fixture，不调用模型，也不需要应用凭证。

Web 测试覆盖两种 descriptor 顺序、应用/Webhook 方式选择、敏感字段翻译和保留/替换/
清除行为、隐藏入站设置、启动/停止/就绪、无联系人时选择配置目标、已保存但不可用/
手动目标，以及任务往返。浏览器验证共享 Web 行为，包括窄屏布局和 workspace 隔离。
现有应用机器人和手动目标测试必须保持通过。

运行相关包测试、类型检查、lint/格式检查及构建。在
`.qwen/e2e-tests/feishu-webhook-delivery.md` 中记录基线、详细步骤、模拟的传输和结果。
本地 HTTPS/代理 fixture 证明请求和生命周期处理符合预期，
不能证明飞书接受凭证、渲染卡片或抑制通知。

获得凭证后，单独记录真实自定义机器人 smoke test：按配置验证有签名和无签名投递、
标题/列表/链接、代码、带周围正文的表格、中文/emoji，以及包含已转义文本的字面 mention
变体。同时检查呈现结果及是否没有触发 mention 通知。在此之前，将该检查标记为
**待验证**。没有真实平台访问权限不阻止本地实现和 review，但不得汇报为已完成真实
平台验收。

## 风险、开放问题与后续工作

- 远端精确字节边界，以及与通用 FAQ 的差异尚未验证。首期采用明确的保守本地预算。
- 官方实体转义规则支持所选 mention 转换，但畸形/编码变体和实际客户端解析仍需真实
  平台证据。不能仅因 fixture 通过就扩大对 mention 行为的保证。
- 表格辅助函数是现有的小型格式处理器，不是完整 Markdown 解析器。测试当前代码围栏
  和表格边界，并保持应用机器人的卡片结构和传输方式不变；若需要更深入的 Markdown 解析，应另行处理。
- 另行评估把钉钉和飞书现已重复的传输生命周期提取到 `channel-base`，保持两个适配器的
  请求取消、drain、超时、响应体上限和 workspace 代理行为。
- 另行将同等围栏处理应用到应用机器人的 `splitChunks` 和折叠卡片分段；这两处仍使用
  反引号奇偶计数，其分块和折叠边界需要独立的回归覆盖。
- 当前来源确认 `11232` 为限流。不得从其他飞书 API 或第三方 SDK 复制未经证实的临时
  错误码列表。
- Lark 域名、其他平台、Generic Webhook、更丰富的卡片和重试策略继续分别提出。本功能
  不为它们引入推测性的扩展契约。

## 参考资料

- [Issue #16997](https://github.com/QwenLM/qwen-code/issues/16997)
- [现有出站 Webhook Channel 设计](2026-11-10-outbound-webhook-channels.zh-CN.md)
- [飞书自定义机器人指南](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)
- [Schema 2.0 Markdown 组件](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/rich-text?lang=zh-CN)
- [飞书消息 FAQ](https://open.feishu.cn/document/server-docs/im-v1/faq?lang=zh-CN)
- [Uptime Kuma 飞书通知适配器](https://github.com/louislam/uptime-kuma/blob/c64c6d950db9149b3f0d98daf76ab591bdaabe7c/server/notification-providers/feishu.js)
- [Apprise 飞书适配器](https://github.com/caronc/apprise/blob/dcbd38584f8a9855f2343d369fd1f664ab06b3a7/apprise/plugins/feishu.py)

开源适配器用于实现交叉核查，不是协议权威，也不是新增依赖。本设计以官方端点文档和
仓库现有 Channel 契约为准。
