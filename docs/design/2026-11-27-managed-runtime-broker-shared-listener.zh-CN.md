# Runtime Broker 复用 Managed Agent HTTP 监听器

[English](2026-11-27-managed-runtime-broker-shared-listener.md) | [简体中文](2026-11-27-managed-runtime-broker-shared-listener.zh-CN.md)

状态为上线前提案，2026-11-27。范围是 Qwen Code 的独立 Managed Agent Server 及其启动器。源码基线是 Qwen Code `main` 的 `94b1d9dc0d42dabab71adc6f94a23eab80d95889`。实现和运行验收待完成。

## 现状与目标

`EmbeddedRuntimeBroker` 创建 Java `RuntimeBrokerService`，并启动独立的 JDK `RuntimeBrokerHttpServer`，默认端口为 4182。Hosted Harness 使用部署提供的 HTTP origin，拼接 `/internal/runtime-broker/v1`，并用部署的 Broker Bearer token 鉴权。独立 Managed Agent Server 已有 Spring Web 监听器，可以为 `/internal/**` 配置内部连接器。

[Broker HTTP 实现](../../packages/managed-agent-server/server/src/main/java/com/alibaba/qwen/code/runtimebroker/http/RuntimeBrokerHttpServer.java) · [Hosted Harness 客户端](../../packages/cli/src/serve/managed-runtime-broker-client.ts) · [MA 内部路由](../../packages/managed-agent-server/server/src/main/java/com/alibaba/qwen/code/managedagent/config/InternalSurfaceConfiguration.java)

Hosted Harness 通过已有的 Managed Agent HTTP 监听器访问 Broker，与 Session Store 共用端口。这是 Broker 的唯一 HTTP 入口。`RuntimeBrokerService` 负责运行时绑定、派发、取消、回执和恢复。

Anthropic 的自托管 Managed Agents 有类似的监听方式，Worker 和应用 API 调用共用服务的 API 地址。Worker 轮询协议是它的另一个设计决策。 [Anthropic 自托管监听器文档](https://platform.claude.com/docs/en/managed-agents/self-hosted-data-and-access#where-the-server-listens)

## 共用监听器与鉴权

当 `qwen.managed-agent.runtime-broker.enabled=true` 时，由 `ManagedAgentWebConfiguration` 注册 Broker 路由。同一次交付移除 Broker 的 JDK 监听器、专用监听配置和端口分配。

保留现有 Broker 启用语义。该属性为 false 时，服务端既不创建 Broker 服务，也不注册其路由；Hosted Harness 在没有 Broker URL 和 token 时，继续支持现有的纯文本会话模式。不新增监听器选择或迁移开关：启用 Broker 即直接使用 Spring 实现，不提供 JDK 监听器回退。

独立 MA 配有内部连接器时使用该连接器。`qwen serve --managed` 复用已有的 Java 回环端口。独立 MA 的主监听器绑定非回环地址且启用 Broker 时，使用独立的 MA 内部连接器。远端 Harness 走部署提供的 TLS 内部入口。

用 Spring 实际用于路由的路径和请求到达的监听器约束路由归属。解析请求体前按原协议校验 Broker Bearer token，沿用恒定时间比较和 Broker 错误响应。业务 API 签名、Session Store 写入凭据和 Broker 凭据各有独立授权范围。路由准入后，沿用 Broker 原有路径解析和资源检查。独立 MA 的公共入口与本地 CLI 前置入口排除该路由。

## 复用现有 HTTP 协议实现

在 server 模块把 Broker 请求分派、限长读取和响应编码移到 Spring 入口，由它调用 `RuntimeBrokerService`。Spring 管理 HTTP 监听器，`EmbeddedRuntimeBroker` 管理服务生命周期。

沿用原始路径与协议版本检查、响应状态和 JSON 字段、8 MiB 请求体上限（含流式请求）、执行回执及重试语义。响应继续异步完成，设置 servlet 异步超时时兼顾现有客户端和操作的截止时间。Spring 路径要保留 Broker 请求的有界准入，覆盖请求体读取，避免工具请求耗尽共享连接器的请求处理能力。客户端断开或 HTTP 超时只结束响应等待，已准入操作由服务按原规则继续处理。

## 部署配置

启动器或部署模板只配置一次 MA 内部 origin，同时用于 Session Store 基础地址和 `QWEN_MANAGED_RUNTIME_BROKER_URL`。Hosted Harness 按现有方式拼接路径。更新 `--check`、systemd bootstrap 和本地启动器，移除本地端口分配和状态中的 `brokerPort`。

## 验收

1. 将现有 Broker HTTP 契约测试迁到 Spring，覆盖获取会话、工具启动与状态、取消、释放、响应丢失后的恢复、非法输入和 8 MiB 上限。按现有契约验证 HTTP 状态、响应字段、重试标记与持久化结果。
2. 使用真实 HTTP 验证独立 MA 内部连接器和本地 CLI 前置入口的隔离。检查路由路径规范化、缺少或使用错误 Broker 凭据时的拒绝，以及其他接口的有效凭据无法授权 Broker。验证独立 MA 的不支持绑定在启动时被拒绝。
3. 用打包版 Hosted Harness 连接 Spring。验证工具执行、取消或响应丢失后的结果回读，以及重启后续用原会话。确认 Broker 和 Session Store 只在 MA 监听器上服务，Broker 专用端口已移除。
4. 对 Broker 施加请求压力，同时调用 MA API 和 Session Store。验证有界准入、其他请求仍能推进以及正常关闭。
5. 验证预检、本地启动和 reload 减少一个端口。分别记录真实进程、MySQL 和协议夹具的结果。
6. 在 Broker 停用时，启动独立服务端和不带 Broker URL 或 token 的真实 Hosted Harness。验证不会创建 Broker 服务或路由，且现有纯文本会话流程仍然可用。
