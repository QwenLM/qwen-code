# Managed Agent 预检命令

[English](2026-10-19-managed-agent-preflight.md) | [简体中文](2026-10-19-managed-agent-preflight.zh-CN.md)

状态：本次改动已实现。

## 问题

参考分发只用文字列出前置条件，而服务要到启动时或第一条 Turn 执行时才逐项校验。缺少 `performance_schema` 授权、空的凭据密钥环、非 loopback 绑定下的 `auth mode=auto`、不可达的 Harness、长度不足的凭据密钥、不可写的 Runtime 状态目录、被占用的端口，各自以不同错误出现，其中一部分只在 Session 创建后才暴露。运维只能一次踩一个坑。

## 范围

`bin/qwen-managed-agent-server --check`（等价于
`java -jar qwen-managed-agent-server-<version>.jar --check`）运行预检后退出。它复用现有 server 产物，参考分发不新增组件。

命令读取服务端读取的配置，按 `SpringApplication` 在创建 context 之前准备环境的方式准备，因此每项输入都保持 Spring 的优先级：

- 命令行参数（`--server.address=...`、`--qwen.managed-agent.*`）；
- 进程环境变量（包括 `SPRING_APPLICATION_JSON`）以及 JVM 系统属性（`-D…`，例如 `JAVA_TOOL_OPTIONS` 中的）；
- Spring Boot 读取的配置文件：由 `spring.config.location`、`spring.config.additional-location` 或 `spring.config.import` 指定的文件，以参数或 `SPRING_CONFIG_*` 变量给出（启动脚本在 `config/application.yml` 存在时设置 `SPRING_CONFIG_ADDITIONAL_LOCATION`，systemd unit 的 `server.env` 指定 `/etc/qwen-managed-agent/application.yml`）；默认位置 `./`、`./config/` 和 `./config/*/` 下的文件，除非 `spring.config.location` 替换了它们；`.yml`、`.yaml`、`.properties` 或 `.xml` 格式，文件名取 `spring.config.name`；以及它们的 profile 变体、它们 import 的文件和 config tree；
- classpath 中把 `QWEN_MANAGED_AGENT_*` 变量映射为属性的 `application.yml`。

相对位置（包括默认位置）与服务端一样在工作目录中解析，因此命令要在服务端的工作目录中运行：分发包根目录，或 unit 的 `WorkingDirectory`。在 [#16057](https://github.com/QwenLM/qwen-code/issues/16057) 之前，它只读取启动脚本或 `server.env` 指定的那个文件，漏掉了服务端从工作目录 `config/application.yml` 读到的 `server.port`。

## 检查项

| 检查         | 通过条件                                                                                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `java`       | Runtime feature version 不低于 21。                                                                                                                                                                                                            |
| `config`     | 服务端读取的每个文件一行：service account 可读；含 secret 时不得对 group 或 others 可读；一个文件都不读时为 WARN。Spring 会拒绝启动时为 FAIL：指定的文件不存在、本进程读不了某个文件，或 YAML 错误（给出行号，通常也给出文件）。               |
| `key-ring`   | 至少配置了 active key ID；同时输出 previous key ID。                                                                                                                                                                                           |
| `validation` | 绑定后的配置通过启动期属性校验。                                                                                                                                                                                                               |
| `auth`       | 非 loopback 绑定不使用 `auto`；signed 模式配置了签名密钥；insecure bind 会给出告警。                                                                                                                                                           |
| `harness`    | 启用的 Harness 具备 token 和格式正确的 digest，`GET /capabilities` 返回 200，且协商过程与第一个 Session 相同，包括 capability digest 和每个 Workspace profile 的 lifecycle；Qwen Code 版本与 manifest 不同时给出警告。不与 Harness pool 协商。 |
| `tool-path`  | Workspace files 与 Shell 的启用组合、isolation class，以及 mount、creation root 或 SSH 节点的要求满足启动期规则。                                                                                                                              |
| `broker`     | token、active 与 previous 凭据密钥均可解码为 32 字节；状态目录可写；provisioner 所需的 Node/worker 或 static endpoint 齐备。                                                                                                                   |
| `workspace`  | 配置的 Workspace `cwd` 存在且可写。                                                                                                                                                                                                            |
| `*-port`     | server 端口与已启用的 broker 端口可绑定；使用 `--online` 时改为可以建立连接。                                                                                                                                                                  |
| `workers`    | local-process 状态目录中没有上次运行遗留、仍在运行的 Runtime worker。                                                                                                                                                                          |
| `database`   | MySQL 能执行 `SELECT 1`，`performance_schema` 授权可用，且 Flyway 版本与发布 manifest 一致（manifest 存在时）。                                                                                                                                |

`WARN` 与 `SKIP` 不导致失败；任一 `FAIL` 使退出码为 1。端口检查会实际绑定配置地址，因此应在服务停止时运行；针对运行中的服务，请加上 `--online`。Harness 协商、`workers` 行和 `--online` 见 [2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md](2026-10-23-managed-agent-preflight-harness-workers-online.zh-CN.md)。

## 非目标

- 不与 Harness pool 的每个端点协商。开启 `harness.pool.enabled` 时，只有在 Session Store 已启用且配置了 binding key 后，`harness` 行才对 pool 的端点 SKIP，否则为 FAIL，与启动期守卫一致。
- 不校验 Workspace mount 注册与 storage identity；这些仍由 “Verified physical Workspace recovery” 流程负责。
- 不执行修复、migration 或任何写入，只做只读探测。

## 实现

`ManagedAgentServerApplication` 在 `SpringApplication.run` 之前拦截 `--check`，因此不会启动监听、调度器、数据源连接池或 worker。`ServerEnvironment` 按 `SpringApplication` 的方式准备 servlet 环境：参数、进程环境，然后经 `EnvironmentPostProcessorApplicationListener` 运行 classpath 上的所有 environment post-processor，并启用宽松绑定。它不创建 context；升级命令读取设置所用的 `ResolvedConfiguration` 也准备同一个环境。`config` 行先列出准备好的属性源来自的文件，再列出 Spring 在某个位置读到但其中没有任何设置的文件。准备过程抛出异常时，该行写明 Spring 拒绝的原因：被当作不存在或不可读的文件，或 YAML 错误所在的文件和行号。由于 Spring 的错误信息不包含这两者，需要在 Spring 会查找的文件中定位：列出自身错误与 Spring 一致（问题相同、位置相同）的每个文件；若参数或环境变量激活的 profile 能确定 Spring 读的是哪一个，则只列那一个。本进程读不了的文件，若 service account 也读不了，就写 service account；否则提示以该账号运行检查。此时其余各行读取参数、进程环境和打包默认值。

文件是否含 secret 只按一条规则判断，即配置参考的规则：键名表示 password、token、key 或 secret（Spring 宽松绑定认可的任何写法都算），且不是 ID，也不是保存 secret 的文件的路径。这条规则作用于文件中的每个键：每个文档里的键（包括没有任何 profile 激活的文档）、注释掉的行里的键、config tree 值文件对应的属性，以及取值中的参数（例如 JDBC URL 的 `?password=`）或 URL 用户信息中的密码。同一路径可以既是配置文件又是 config tree 值文件（例如 config tree 导入在 `config/` 之上时的 `config/application.yml`），此时两种身份都要判断。`Binder` 生成 `ManagedAgentProperties`，Harness 探测使用 JDK HTTP client，数据库探测使用 JDBC，连接与 socket 超时均为 5 秒。

## 验收

- 单元测试覆盖 digest 与密钥校验、配置位置优先级、auth 判定、基于本地 HTTP server 的 Harness 探测，以及 broker 与 tool-path 检查。
- `mvn verify` 通过两个 Checkstyle execution 与 SpotBugs。
- 无数据库时运行打包 jar，会打印检查表、报告连接失败并退出 1。依赖齐备的部署预期退出 0；本次改动未在本地验证该路径，因为本机没有可用 MySQL 实例。
