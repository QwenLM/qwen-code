# Managed Agent Session Store 默认值

[English](2026-10-21-managed-agent-session-store-defaults.md) | [简体中文](2026-10-21-managed-agent-session-store-defaults.zh-CN.md)

状态：已提出，并在同一变更中实现。

## 问题

每个 Hosted Harness 部署都必须同时开启并接好 Managed Session Store，但 Store 的三项配置重复了服务端已经知道的值：

- `qwen.managed-agent.session-store.enabled` 默认 `false`，而启动时拒绝"开启 Harness 但未开启 Store"。只要 Harness 开启，它的取值永远是 `true`。
- `session-store.base-url` 没有默认值，而单机参考拓扑下它永远指向本服务自己的 loopback 监听。
- `session-store.workspace-id` 没有默认值，而 Broker 有 workspace ID 时它必须与之相等。local-process Broker 从规范化的 Workspace 路径推导该 ID，并拒绝任何不同的显式值。

结果是文档中的路径按原文无法启动：

- 参考部署文档"启动 Java 控制面"一步开启了 Harness 却没开 Store，启动失败并报 `Hosted Harness requires the Managed Session Store`。
- `server.env` 模板、凭据 bootstrap 和部署文档的工具路径示例都设置了 `QWEN_MANAGED_AGENT_WORKSPACE_ID=reference-workspace`。该值同时也是 Broker 的 workspace ID，因此开启文档中的 local-process 工具路径会失败，报 `Runtime Broker workspace ID must match the canonical workspace path hash`。运维只能手工计算 SHA-256 前缀。
- preflight 不检查 Store 接线，会放行一个随后被启动拒绝的配置。

## 目标

- 开启 Harness 即隐含开启 Session Store，除非运维显式关闭。
- 单机参考拓扑下，Store 的 base URL 和 workspace ID 无需配置。
- Session Store 与 Runtime Broker 从同一组输入解析出同一个 workspace 身份。
- preflight 报告启动会拒绝的 Store 接线。
- 随包的模板、bootstrap 和文档按原文可以启动。

## 非目标

- 改变任何显式配置的值。所有推导值只在该配置为空时生效。
- 为远端或容器化的 Harness 推导 Store URL。这些拓扑仍需显式配置。
- 改变共享凭据模型（Harness token 与 capability digest）、CLI 的 broker 参数或端口选择。这些是单独的后续工作。
- 把已有部署迁移到推导出的 workspace ID。

## 设计

### Store 开关

`application.yml` 中 `session-store.enabled` 的默认值改为 `${QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED:${qwen.managed-agent.harness.enabled:false}}`。该默认值在 Spring `Environment` 中解析，因此由 Store 门控的 `@ConditionalOnProperty` bean 与绑定后的配置看到同一个值。它跟随任意来源的 Harness 设置，包括 `config/application.yml`。显式设为 `false` 且 Harness 开启时，启动仍以原有消息失败。

### Store base URL

Store 开启且 `session-store.base-url` 为空时，`ManagedAgentProperties` 在启动校验中根据承载内部 Store 路由的监听推导：

- `internal-server.port` 为正数时，用独立内部监听（`internal-server.address` 和 `internal-server.port`）；
- 否则用公共监听（`server.address`，以及 `server.port`，缺省为 Spring Boot 默认的 `8080`）。

地址为空、`0.0.0.0`、`::` 或 `127.0.0.1` 时 URL 为 `http://127.0.0.1:<port>`，地址为 `::1` 时为 `http://[::1]:<port>`。其他地址或非正端口（例如测试用的随机端口）不推导，原有启动拒绝仍要求显式 URL。提供 TLS 的公共监听同样不推导：Spring Boot 在 `server.ssl` 已绑定且启用时开启 TLS，推导出的 URL 却是明文，而 HTTPS URL 必须使用证书覆盖的主机名。独立内部监听始终是明文，因此在 TLS 公共监听之后它仍然推导。loopback 字面地址满足现有的明文传输检查和内部端口检查，因此其他校验不变。

推导需要 Spring `Environment` 来读取 `server.*`。preflight 在没有 Spring 上下文的情况下绑定配置，因此现在把它的 environment 传给绑定出的配置对象。不带 environment 的 `new ManagedAgentProperties()` 不推导 URL。

### Store workspace ID

Store 开启且 `session-store.workspace-id` 为空时：

1. 若设置了 `runtime-broker.workspace-id`，Store 使用它。
2. 否则，若设置了 `runtime-broker.workspace-cwd` 且 provisioner 为 `local-process` 或 `kubernetes`，Store 使用 Broker 会推导出的 ID：规范化 Workspace 路径 SHA-256 的前 16 个十六进制字符。推导直接调用 Broker 自己的解析逻辑，两者不会分叉。
3. 否则 ID 保持为空，原有启动拒绝生效。

两项配置都读取 `QWEN_MANAGED_AGENT_WORKSPACE_ID` 和 `QWEN_MANAGED_AGENT_WORKSPACE_CWD`，因此参考配置用路径命名 Workspace（`QWEN_MANAGED_AGENT_WORKSPACE_CWD=/srv/qwen-workspace`）并省略 ID。这样纯文本部署和之后开启 local-process 工具路径时保持同一身份。Broker 关闭时推导同样生效，因此纯文本部署以后开启工具路径时，已有未绑定 Session 的 Store 作用域不会改变。

local-process 推导会解析真实路径，因此目录必须存在。路径无法解析时，启动在接收任何流量之前以 Broker 原有的 `Runtime Broker workspace cwd could not be resolved` 消息失败。

### Preflight

新增 `session-store` 一行，报告推导后的实际接线：

- Harness 或 Store 关闭时为 `SKIP`（已有的 `validation` 行已经对"开启 Harness 但未开启 Store"报 FAIL）；
- base URL 或 workspace ID 仍为空时为 `FAIL`，并在修复提示中给出要设置的变量；
- 其余情况为 `PASS`，并显示实际 URL 和 workspace ID。

URL 或 ID 为空时的启动拒绝消息也会给出要设置的变量。

### 模板、bootstrap 与文档

- `server.env.example` 和 bootstrap 生成的 `server.env` 去掉 `QWEN_MANAGED_AGENT_SESSION_STORE_ENABLED`、`QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL` 和 `QWEN_MANAGED_AGENT_WORKSPACE_ID`，改为设置 `QWEN_MANAGED_AGENT_WORKSPACE_CWD=/srv/qwen-workspace`，即 systemd README 已经创建的目录。
- 参考部署文档（中英文）在基础启动中加入 Workspace 目录，并从工具路径示例中删去冲突的 ID。
- server README 和 systemd README 说明推导出的默认值。
- 开发启动器继续写入显式值，显式值仍然优先。

## 兼容性与风险

- 已有部署显式设置了 Store 的各项值，显式值不受影响。在本变更之前，Harness 开启而 Store 关闭的部署无法启动。
- 不带 Harness 运行 Store 的部署保留其显式设置。其默认值保持 `false`，因为它跟随关闭的 Harness。
- 未绑定 Session 从全局 workspace ID 解析其 Store 作用域。运维若把已有的显式 `QWEN_MANAGED_AGENT_WORKSPACE_ID` 换成推导默认值，就会改变该作用域。部署文档要求保留已有 ID。
- Store 的 workspace ID 仍只与 Broker 的显式 ID 比较，而不与其推导值比较。只设置 `session-store.workspace-id`、而 Broker 自行推导的拆分配置保持现有行为。本变更不会扩大这一缺口。

## 验证计划

- `ManagedAgentProperties` 单元测试：`application.yml` 默认值跟随 Harness，显式 `false` 仍然优先；公共监听和内部监听、每种接受的地址形式以及 IPv6 loopback 都能推导 URL；指定的非 loopback 地址、端口 `0` 和提供 TLS 的公共监听时 URL 保持为空，而 TLS 公共监听之后的内部监听仍然推导；显式值从不被替换；workspace ID 跟随 Broker ID，否则取规范化 cwd 哈希，并与 Broker 自身的解析一致。
- preflight 测试：`session-store` 行报告 `SKIP`、`FAIL` 和 `PASS`，且 preflight 通过其 environment 推导 URL。
- 模板测试：bootstrap 输出和 `server.env.example` 不再包含被删除的变量，并设置了 Workspace 目录。
- 模块验证：在 `packages/managed-agent-server` 中运行 `mvn verify`。
- 端到端：构建参考发行包，然后按部署文档原文对接 MySQL 和真实的 `qwen serve --profile hosted-harness`。依次运行 `--check`、启动，并完成一个纯文本 Turn。再按文档列出的变量开启 local-process 工具路径，重复上述步骤。以 `main` 上的同样步骤作为基线。

## 验收标准

- 部署文档的基础启动不设置任何 `QWEN_MANAGED_AGENT_SESSION_STORE_*` 变量和 workspace ID，能够启动并完成一个 Turn。
- 在此基础上开启文档中的工具路径变量，启动不再出现 workspace ID 不匹配。
- preflight 恰好对启动会拒绝的 Store 接线报 FAIL。
- 显式配置的行为与之前一致。

## 后续工作

- 让两个进程从同一个共享 secret 文件读取 Harness token 和 capability digest。
- 为 CLI 的 broker URL 和 token 提供环境变量或文件来源，并让 Hosted Harness profile 在端口被占用时直接失败而不是顺延。
