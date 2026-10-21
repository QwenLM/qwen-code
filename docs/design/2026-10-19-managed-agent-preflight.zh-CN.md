# Managed Agent 预检命令

[English](2026-10-19-managed-agent-preflight.md) | [简体中文](2026-10-19-managed-agent-preflight.zh-CN.md)

状态：本次改动已实现。

## 问题

参考分发只用文字列出前置条件，而服务要到启动时或第一条 Turn 执行时才逐项校验。缺少 `performance_schema` 授权、空的凭据密钥环、非 loopback 绑定下的 `auth mode=auto`、不可达的 Harness、长度不足的凭据密钥、不可写的 Runtime 状态目录、被占用的端口，各自以不同错误出现，其中一部分只在 Session 创建后才暴露。运维只能一次踩一个坑。

## 范围

`bin/qwen-managed-agent-server --check`（等价于
`java -jar qwen-managed-agent-server-<version>.jar --check`）运行预检后退出。它复用现有 server 产物，参考分发不新增组件。

命令绑定与 Spring 相同的输入：

- classpath 中把 `QWEN_MANAGED_AGENT_*` 变量映射为属性的 `application.yml`；
- 命令行参数（`--server.address=...`、`--qwen.managed-agent.*`），保持 Spring 的优先级；
- `--spring.config.additional-location` 指定的外部 YAML（运维可显式传入），或 `SPRING_CONFIG_ADDITIONAL_LOCATION`（启动脚本在 `config/application.yml` 存在时会设置）；
- 进程环境变量，其优先级高于前两者。

## 检查项

| 检查         | 通过条件                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `java`       | Runtime feature version 不低于 21。                                                                                          |
| `config`     | 外部 YAML 存在且可读；含 secret 的文件不得对 group 或 others 可读。                                                          |
| `key-ring`   | 至少配置了 active key ID；同时输出 previous key ID。                                                                         |
| `validation` | 绑定后的配置通过启动期属性校验。                                                                                             |
| `auth`       | 非 loopback 绑定不使用 `auto`；signed 模式配置了签名密钥；insecure bind 会给出告警。                                         |
| `harness`    | 启用的 Harness 具备 token、格式正确的 digest，且 `GET /capabilities` 返回 200。                                              |
| `tool-path`  | Workspace files 与 Shell 的启用组合、isolation class，以及 mount、creation root 或 SSH 节点的要求满足启动期规则。            |
| `broker`     | token、active 与 previous 凭据密钥均可解码为 32 字节；状态目录可写；provisioner 所需的 Node/worker 或 static endpoint 齐备。 |
| `workspace`  | 配置的 Workspace `cwd` 存在且可写。                                                                                          |
| `*-port`     | server 端口与已启用的 broker 端口可绑定。                                                                                    |
| `database`   | MySQL 能执行 `SELECT 1`，`performance_schema` 授权可用，且 Flyway 版本与发布 manifest 一致（manifest 存在时）。              |

`WARN` 与 `SKIP` 不导致失败；任一 `FAIL` 使退出码为 1。端口检查会实际绑定配置地址，因此应在服务停止时运行。

## 非目标

- 不校验 Harness capability digest。该值只能通过需要认证的 Hosted Session 请求观察，命令只报告可达性，digest 留给第一条 Turn。
- 不校验 Workspace mount 注册与 storage identity；这些仍由 “Verified physical Workspace recovery” 流程负责。
- 不比对已安装的 Qwen Code 版本与 manifest。
- 不执行修复、migration 或任何写入，只做只读探测。

## 实现

`ManagedAgentServerApplication` 在 `SpringApplication.run` 之前拦截 `--check`，因此不会启动监听、调度器、数据源连接池或 worker。`StandardEnvironment` 依次加载外部与打包内的 YAML 属性源，`Binder` 生成 `ManagedAgentProperties`，Harness 探测使用 JDK HTTP client，数据库探测使用 JDBC，连接与 socket 超时均为 5 秒。

## 验收

- 单元测试覆盖 digest 与密钥校验、配置位置优先级、auth 判定、基于本地 HTTP server 的 Harness 探测，以及 broker 与 tool-path 检查。
- `mvn verify` 通过两个 Checkstyle execution 与 SpotBugs。
- 无数据库时运行打包 jar，会打印检查表、报告连接失败并退出 1。依赖齐备的部署预期退出 0；本次改动未在本地验证该路径，因为本机没有可用 MySQL 实例。
