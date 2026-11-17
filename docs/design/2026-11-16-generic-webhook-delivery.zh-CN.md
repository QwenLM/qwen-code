# 通用出站 Webhook 投递

[English](2026-11-16-generic-webhook-delivery.md) | [简体中文](2026-11-16-generic-webhook-delivery.zh-CN.md)

## 问题与当前行为

Issue #17374 将现有 Channel 投递框架扩展到开发者控制的 HTTP 接收端。钉钉、飞书和企业微信已经提供已配置的出站目标。通用接收端应通过相同的定时任务、显式 prompt 和 Notify 流程选择，无需为每个服务编写私有适配器。OpenClaw 的[自动化投递](https://docs.openclaw.ai/automation/cron-jobs/delivery)提供了相近的产品先例；本方案不采用它的完成事件结构。

HTTP Stop hooks 仍是生命周期扩展，其覆盖取决于执行模式，响应也可以影响 agent 是否继续运行。本功能关注命名投递目标，不改变 hooks 或调度语义。适配器收到逻辑目标和文本，不包含任务或会话元数据。

## 范围与交付拆分

后端 PR 增加私有内置包 `@qwen-code/channel-generic-webhook`、注册、共享网络校验、协议和集成测试，以及用户文档。依赖它的 Web PR 在共享 Web Shell 中增加 Generic Webhook 入口、翻译后的配置及目标措辞，也覆盖使用 `WebShellWithProviders` 的宿主。

不增加全局启用开关、新 daemon 接口、测试消息按钮、入站 webhook、模板引擎、任意请求头或方法、逐消息 URL、附件、事件订阅、重试队列或调度行为。手动运行和每次新会话的投递限制保持不变。

## 配置与公共协议

插件类型为 `generic-webhook`，声明 `outboundOnly: true`，沿用逻辑目标 `chat/default`。每个命名 Channel 拥有一个已配置 URL；只接受该目标且不支持 thread。URL 和凭据不会出现在投递目标或任务文件中。修改配置会改变该 Channel 后续投递的接收端。

| 字段                  | 行为                                                 |
| --------------------- | ---------------------------------------------------- |
| `webhookUrl`          | 必填秘密字段，支持现有 `$ENV_VAR` 语法               |
| `bearerToken`         | 可选秘密字段及环境引用，以 Bearer 鉴权发送           |
| `allowPrivateNetwork` | 布尔值，省略即 false；允许已配置接收端位于本机或私网 |

管理层同步校验直接 URL 以及字段、环境引用语法，保存时不查询 DNS，也不发送消息。运行时先解析环境引用，再校验真实配置；每次发送都校验 DNS，并将连接绑定到已检查的地址。环境引用不替换为虚构的平台 URL。沿用已有秘密字段保留、替换、清除和环境引用持久化行为。

发送采用 POST 和 JSON 内容类型，第一版结构严格如下：

```json
{ "version": 1, "text": "传入的结果，包括 Markdown。" }
```

文本保留为适配器收到的原文。接收端应检查版本并容忍未来增加的字段；不兼容的变更需要新版本。不承诺任务 ID、会话 ID、完整记录或稳定去重键。可选 Bearer 值必须是适用于该请求头的有效非空 token；错误不得回显 token 或 URL。

任何 HTTP 2xx（包括无响应体的 204）均表示接收端接受请求，不保证下游处理完成。响应体不作为业务码、agent 指令或替代文本解释。收到 2xx 后，响应清理失败不能将已确认的发送改判为失败。HTTP 408/425/429/5xx 以及传输超时或失败归为 transient；其他 HTTP 失败和非法配置、目标归为 permanent。分类不会新增自动重试。丢失响应也可能发生在接收端已经收到请求之后。

## 地址与传输规则

| 目标                                       | 默认   | `allowPrivateNetwork: true` |
| ------------------------------------------ | ------ | --------------------------- |
| 公网 HTTPS                                 | 允许   | 允许                        |
| 公网 HTTP                                  | 拒绝   | 拒绝                        |
| Loopback/RFC1918/IPv6 ULA 的 HTTP 或 HTTPS | 拒绝   | 允许已配置接收端            |
| 未指定、链路本地、元数据及其他保留目标     | 拒绝   | 拒绝                        |
| 重定向                                     | 不跟随 | 不跟随                      |

本机指 daemon/worker 所在机器或容器。私网选项表达网络意图，不证明配置只能由人修改。已有工作区信任、管理鉴权和文件修改控制继续生效。不增加第二层确认流程、CIDR 编辑器或主机列表。

URL 必须是绝对 HTTP(S) 地址，不含内嵌凭据或 fragment，并符合配置语法。检查全部 DNS 结果；HTTP 还要求所有结果均属于获准的私网或本机地址。HTTPS 可以使用公网地址或明确允许的私网、本机地址。IPv4-mapped IPv6 按内嵌 IPv4 分类。私网例外不允许链路本地、云元数据（包括 `fd00:ec2::254`），也不允许 CGNAT 或保留地址段。每次发送只选择一次已检查地址，并用于实际连接。保持 TLS 证书和主机名验证。

新增小型纯 Node 工作区 `@qwen-code/network-policy`，承载现有 core 的地址校验和连接固定解析逻辑，并扩展私网、本机策略。core 保留当前 public/undefined wrapper 和返回契约，不扩大 `ExtensionNetworkPolicy`。这样避免 Channel 依赖 private core，也避免 core 依赖 Channel 生命周期设施。这是共享解析器，不是新 HTTP 框架。现有公网策略消费者的行为和已有测试保持不变。

core 只在执行公网策略请求时加载共享解析器。为生成设置 schema 或运行其他元数据工具而导入 core 时，不加载新增工作区。CLI 打包器会将延迟加载的模块包含在分发产物中；自动化产物布局和依赖安装工作流保持不变。

适配器使用每个请求独享的 Undici dispatcher。直连和 NO_PROXY 路径采用已检查的 lookup；实际代理路径沿用 Undici 的 `EnvHttpProxyAgent`/`ProxyAgent` 处理隧道、代理鉴权和 TLS，其 client factory 仅将 CONNECT authority 改为已检查的 IP。源站 URL、Host 和 TLS server name 仍为配置中的主机名，因此代理不再单独解析源站域名。不静默绕过代理设置，不修改进程级 dispatcher。

实施前的本地探针已验证此公开 Undici API 路径，覆盖 HTTP/HTTPS 接收端、HTTP/HTTPS 代理、原始 Host/SNI、证书主机名不匹配的拒绝、代理鉴权和 NO_PROXY。这是传输可行性结果，不代表已验证完整 Channel。生产测试必须用实际适配器和 worker 验证相同保证。

## 边界与生命周期

现有共享投递上限为 100,000 个 UTF-16 code units。文本采用最坏 JSON 转义后，加第一版 envelope 共 600,023 字节。适配器允许序列化 UTF-8 JSON 最大为 640 KiB（655,360 字节），发送前计量；不再次截断或拆分。此预算独立于 IM 平台限制。

使用覆盖解析、连接和响应处理的 15 秒总请求期限。不缓冲无用途的响应体；在有界清理中取消、释放它，并释放请求独享的 dispatcher。断开会取消并排空在途操作，重连不能复活已取消的连接代次。Connect 仅校验本地配置并使发送器就绪，不联系接收端或验证远程鉴权。

## Web 行为

增加独立的 Generic Webhook 平台入口，使用已有编辑器、秘密字段控件和布尔字段支持。私网、本机选项放在高级设置。不展示接收策略、配对或 agent 会话控件。已配置目标采用接收端、目标措辞。线上目标保持 `chat/default`；仅修改 label 不够，因为当前任务 UI 按目标类型选择群聊措辞。保留现有平台群聊措辞、已保存及不可用目标、旧 daemon 回退行为。

## 受影响组件

| 组件                                 | 变更                                       |
| ------------------------------------ | ------------------------------------------ |
| Network-policy 工作区与 core wrapper | 共享校验及固定解析，保持已有 core 公网行为 |
| Generic Channel 包                   | 配置、载荷、生命周期、代理传输和描述符     |
| Workspace/CLI 注册及构建引用         | 纳入两个新私有包并注册内置插件             |
| CLI 集成测试                         | 环境及秘密字段处理、实际 worker 投递和鉴权 |
| 共享 Web Shell                       | 入口、字段翻译、私网选项和接收端措辞       |
| 用户文档与接收端示例                 | 第一版协议、网络规则、应答和限制           |

## 验证与验收

E2E 计划位于 `.qwen/e2e-tests/generic-outbound-webhook.md`。全局 `qwen` 不可用，因此改动前运行时基线使用保留的 WeCom Web 构建 `50eb3f9f`，并明确记录为 fallback。该真实 daemon 不包含 Generic，拒绝创建，且不持久化配置、不发送网络或模型请求。源码检查也确认新 main 基线 `7f48cdeb` 存在相同缺口。

验证配置、环境语法、秘密字段编辑及脱敏失败；纯文本、Markdown、Unicode 和最坏转义；2xx/204、错误和无重试；混合 DNS 结果、特殊地址、私网选项和 HTTP 限制；直连、代理路由、Host/SNI/TLS/鉴权和 NO_PROXY；重定向、取消、断开重连与有限清理。用真实 daemon 和 worker 对接本地接收端，并用确定性的模型 fixture 验证受支持的定时投递。不得将这些 fixture 声称为真实外部服务或模型联调。

通过单测及浏览器验证 Web 创建、编辑、高级私网选项、凭据、任务选择和已保存目标行为。运行构建、类型检查、bundle、定向单测和集成测试以及必要的构建元数据检查；完成两轮连续干净的自审及独立 review 后，交付两份 Draft PR。

## 已定决策与剩余限制

每个 Channel 的显式网络策略不需要全局功能开关。代理可行性已通过本地探针确认，交付前还需实际适配器、worker 验证。未来接收端需求可能需要其他鉴权或事件字段，这些不预先加入本版。
