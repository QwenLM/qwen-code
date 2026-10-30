# Managed Agent 参考部署

[English](managed-agent-reference-deployment.md) | [简体中文](managed-agent-reference-deployment.zh-CN.md)

Managed Agent 参考分发产物仍处于实验阶段。首个已接受拓扑为：一台可信 Linux 主机上的单 Java 控制面及其嵌入式 Runtime Broker、一个 MySQL 数据库，以及一个兼容的 Qwen Hosted Harness。每个发布版本中的兼容性 manifest 是该版本的权威依据。

## 选择部署档位

每一档都建立在前一档之上：

| 档位                     | 运行的内容                                                            | 新增的内容                                                                                                       |
| ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1. 纯文本 Hosted Session | 一台可信 Linux 主机上的 Java 控制面、一个 Hosted Harness 和 MySQL     | —                                                                                                                |
| 2. local-process 工具    | 作用于 Workspace 的 Hosted 工具，例如文件访问，以及开启后的前台 Shell | 嵌入式 Runtime Broker、同一主机上的 Runtime worker、Runtime 凭据密钥、Runtime state 目录和一个已登记的 Workspace |
| 3. Kubernetes            | 集群中的 API、Harness 和 MySQL                                        | 从源码构建的容器镜像，用 Helm chart 安装，不在本分发产物的验收范围内                                             |

即使目标是使用工具，也请从第 1 档开始。完成一个不调用工具的 Turn，能同时证明控制面、Harness、模型和数据库都已就绪；之后由第 2 档在同一部署上开启工具。

## 第 1 档：纯文本 Hosted Session

一台主机上的一个控制面、一个 Harness 和 MySQL。按顺序执行：校验压缩包、生成凭据、启动 Harness、检查配置、启动控制面，最后完成第一个 Session。

### 校验并解压

从同一个 GitHub prerelease 下载压缩包、独立 manifest 和 `SHA256SUMS.txt`，解压前完成校验：

```bash
sha256sum --check SHA256SUMS.txt
tar -xzf qwen-managed-agent-reference-<version>.tar.gz
cd qwen-managed-agent-reference-<version>
sha256sum --check SHA256SUMS
```

检查 `manifest.json`。确认 `source.revision` 是已评审的 revision，`compatibility.qwenCodeVersion` 与 CLI/Harness 安装一致，并确认目标数据库可接受 `compatibility.databaseSchema.latestMigrationVersion`。任一校验和或兼容检查失败时，发布产物均视为无效。

### 前置条件

- 可信应用主机使用 Linux。
- JDK 21 或更高版本。
- Node.js 满足 `compatibility.node`，Qwen Code 匹配 `compatibility.qwenCodeVersion`。
- MySQL 8，使用空数据库或由旧版兼容参考分发产物管理的数据库。
- Harness 使用的模型服务，例如兼容 OpenAI 的服务端点及其模型 ID 和 API key。
- 私有、持久的 Workspace 目录；第 2 档还需要 Runtime state 目录。
- 稳定保存于压缩包之外的数据库凭据和 Harness token；第 2 档还需要 Runtime credential key ring。

Java 压缩包不包含 npm CLI。请单独安装或构建精确兼容的 Qwen Code revision：Harness 以 `qwen serve` 运行它，第 2 档的 Runtime worker 运行它的 `dist/cli.js`。

### 生成凭据

`bin/qwen-managed-agent-bootstrap` 生成共享的 Harness token 与 capability digest、broker token、Runtime 凭据密钥以及数据库密码。它写出 `config/harness.env`、`config/server.env`、`config/application.yml` 与 `config/mysql-setup.sql`，权限为 0600；目标文件已存在时除非传入 `--force` 否则拒绝覆盖；只打印路径，不打印 secret：

```bash
bin/qwen-managed-agent-bootstrap
```

token 与 digest，以及工具路径所需的 Broker URL 和 token，只写入 `harness.env`：`server.env` 通过 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` 指向该文件，控制面从中读取这些值。若该文件与 `QWEN_MANAGED_AGENT_HARNESS_TOKEN` 或 `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST` 同时设置，或文件中的 Broker token 与 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` 同时设置，控制面拒绝启动，因此轮换时只需修改一个文件。生成的 `harness.env` 与 `server.env` 既可直接被 shell source，也可作为 systemd 的 `EnvironmentFile`。

`server.env` 在 `QWEN_MANAGED_AGENT_WORKSPACE_CWD` 中把 `/srv/qwen-workspace` 写为 Workspace 目录；请创建该目录，或把该变量改为一个已存在的目录。Session Store 从该目录推导 workspace ID，因此已有 Session 后不要再改。

`mysql-setup.sql` 创建 `qwen_managed_agent` 数据库和 `server.env` 中写明的 `qwen` 账号（`localhost` 与 `127.0.0.1` 各一个），并授予 Flyway 需要的 `performance_schema` 权限。以 MySQL 管理员身份运行一次，例如 `mysql -u root < config/mysql-setup.sql`，然后删除它；密码保存在 `server.env` 中。它遇到第一条失败的语句就停止，因此不会改动已有的数据库或账号。容器中的 MySQL 看到的是网关地址而不是 `127.0.0.1`，此时请为那个主机创建账号。

systemd 布局下，以 root 身份运行并传入 `--directory /etc/qwen-managed-agent --service-user qwen-managed-agent`。此时 `harness.env` 与 `application.yml` 归服务账号所有，`server.env` 为 `0640 root:qwen-managed-agent`，新建的目录为 `0750 root:qwen-managed-agent`，`mysql-setup.sql` 仍归 root。账号不存在、或账号无法进入该目录时，bootstrap 拒绝执行。`server.env` 还会记录 `QWEN_MANAGED_AGENT_SERVICE_USER`，因此即使以 root 身份运行预检，它也会按该账号检查文件访问权限。

### 启动 Hosted Harness

用 `config/harness.env` 启动 Harness，并配置它调用的模型。该文件包含 Harness 的 token、capability digest 和 Broker 配置。Qwen Code 从 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 读取兼容 OpenAI 的模型服务；其他服务见[认证说明](https://github.com/QwenLM/qwen-code/blob/main/docs/users/configuration/auth.md)。

```bash
set -a; . config/harness.env; set +a
export OPENAI_API_KEY='<model-api-key>'
export OPENAI_BASE_URL='https://<openai-compatible-endpoint>/v1'
export OPENAI_MODEL='<model-id>'
qwen serve --profile hosted-harness --port 4170 --hostname 127.0.0.1 --no-web
```

systemd 布局下，改为把这三个模型变量以纯 `KEY=value` 行写入 `harness.env`。

Harness 保持监听 loopback。Hosted Harness profile 不会换到其他端口：`--port` 被占用时 Harness 启动失败，并给出端口号。

不使用 bootstrap 生成的文件时，选择一个 token 与 capability digest，并让 Harness 和 Java 控制面使用相同值：

```bash
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'

QWEN_SERVER_TOKEN="$QWEN_MANAGED_AGENT_HARNESS_TOKEN" \
QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST="$QWEN_MANAGED_AGENT_CAPABILITY_DIGEST" \
qwen serve --profile hosted-harness --port 4170 --hostname 127.0.0.1 --no-web
```

### 预检

在第二个终端加载 `config/server.env`；不使用 bootstrap 生成的文件时，改为导出下文控制面一节列出的变量。在 Harness 运行的情况下，于首次启动前以及每次安装新产物后，用启动脚本运行 `--check`。它绑定与服务器相同的配置（`config/application.yml` 加环境变量），不启动监听，并按输入项逐行输出结果：

```bash
set -a; . config/server.env; set +a
bin/qwen-managed-agent-server --check
```

检查范围包括 JDK、服务账号、配置文件及其权限、凭据密钥环、启动期属性校验、auth 与绑定组合、Harness、Workspace files 与 Shell 的交叉配置（含 mount、creation root 或 SSH 节点要求）、Broker 凭据与目录、Workspace `cwd`、端口占用、上次运行遗留的 Runtime worker，以及 MySQL 连通性、`performance_schema` 授权和 Flyway 版本与 `manifest.json` 的一致性。`WARN` 与 `SKIP` 不导致失败；任一 `FAIL` 退出码为 1。

`harness` 行会像第一个 Session 那样与单个配置的 Harness 协商；使用 Harness pool 时，只有在 Session Store 已启用且配置了 binding key 后，才对 pool 的端点跳过，否则报 FAIL。capability digest 不一致、缺少协议或必需的 feature、或者 Harness 缺少某个已配置 Workspace profile 所需的 lifecycle 时报 FAIL；Harness 运行的 Qwen Code 版本与 `manifest.json` 写明的不同，或者 Harness 没有说明版本时报 WARN。端口检查会像服务端一样实际绑定配置地址，因此刚停止的服务端留在 `TIME_WAIT` 的端口算作空闲；`workers` 行会对仍在 Runtime 状态目录中运行的 worker 给出警告，因此应先停止服务。服务运行期间请加上 `--online`：端口相关的行改为检查是否有进程在监听；`workers` 行只报告已停止的服务端遗留的 worker，对持久模式的 Broker 则跳过，因为它会接管这些 worker。该命令不校验原生 Workspace storage 注册。

首次启动前数据库是空的：`database` 行报告 schema 尚未迁移，`capacity` 行报 WARN，提示它要读的表不存在。首次启动会建好这些表，之后两行都通过。

数据库的 Flyway 版本低于 `manifest.json` 写明的版本时，`database` 行报 WARN：这是升级后、新版本首次启动迁移之前的数据库状态，首次启动会完成迁移。数据库版本更高时报 FAIL。版本正好等于 `manifest.json` 写明的版本时，该行会像服务端启动时那样校验 schema，不匹配就报 FAIL，例如实验版在原地修改了 schema 基线。

### 启动 Java 控制面

在同一个终端启动控制面：

```bash
bin/qwen-managed-agent-server
```

不使用 bootstrap 生成的文件时，配置同一 Harness、数据库和一个已存在的 Workspace 目录：

```bash
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='<private-password>'
export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4170'
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'
export QWEN_MANAGED_AGENT_WORKSPACE_CWD='/srv/qwen-workspace'

bin/qwen-managed-agent-server
```

无法通过环境变量表达的设置（例如 Runtime 凭据密钥环）写在 `config/application.yml` 中。bootstrap 会生成该文件；否则从随包模板复制并收紧权限：

```bash
cp config/application.example.yml config/application.yml
chmod 600 config/application.yml
```

两个启动脚本都会在该文件存在时自动加载。该启动脚本使用压缩包内的 server JAR。Spring Flyway 会在服务 ready 前执行向前数据库 migration。等待：

```bash
curl --fail http://127.0.0.1:8080/actuator/health
```

开启 Harness 即开启 Managed Session Store。Store 的 base URL 默认指向本服务的明文 loopback 监听；workspace ID 默认取 Runtime Broker 从 `QWEN_MANAGED_AGENT_WORKSPACE_CWD` 推导出的值，因此第 2 档开启工具路径后身份保持不变。已经设置过 `QWEN_MANAGED_AGENT_WORKSPACE_ID` 的部署必须保留它：未绑定 Session 从该 ID 解析其 Store 作用域。只有当 Harness 需要通过其他地址访问本服务，或该监听提供 TLS 时，才设置 `QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL`。

基础配置支持纯文本 Hosted Session。除非配置签名或认证入口，否则服务只能监听 loopback。全部设置及其环境变量和默认值见[配置参考](managed-agent-configuration-reference.zh-CN.md)，随包提供于 `docs/configuration.zh-CN.md`。完整认证、API 与 capability 配置随包提供于 `docs/server-reference.md`。

### 运行第一个 Session

使用默认的 loopback 监听时，API 从 `X-Qwen-Tenant-Id` 请求头读取租户。创建一个 Session，让它的第一个 Turn 向模型提问：

```bash
curl --fail -X POST http://127.0.0.1:8080/v1/agents/sessions \
  -H 'X-Qwen-Tenant-Id: default' -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: first-session' \
  -d '{"agent_id":"qwen-code","input":[{"type":"input_text","text":"Say hello."}]}'
```

`Idempotency-Key` 请求头是必需的：用同一个 key 重试会返回同一个 Session，而不会再创建一个。响应中包含 Session 的 `id`。读取它的事件，重复执行，直到出现 `"terminal": true` 的事件：

```bash
curl --fail -H 'X-Qwen-Tenant-Id: default' \
  'http://127.0.0.1:8080/v1/agents/sessions/<id>/events?after=0&limit=100'
```

成功的 Turn 以 `turn.completed` 结束，模型的回复在它之前的 `item.output_text.delta` 事件的 `text` 中。如果终结事件是 `turn.failed`，或者在 Turn 期限内一直没有终结事件，问题出在 Harness 或模型，Harness 日志会给出原因。这个 Session 是部署成功的第一个证明；每次升级后都再做一次，systemd 布局下的 `verify --turn` 做的就是这件事。

### systemd

分发产物包含面向既定单机拓扑的 `systemd/` unit 与环境模板。控制面 unit 使用 `KillMode=process`，使 Runtime worker 在 Broker 重启后继续存活；Harness unit 使用 `KillMode=mixed`，使其工具进程随 Harness 终止。安装步骤见 `systemd/README.zh-CN.md`。

## 第 2 档：local-process 工具

第 2 档在一个可用的第 1 档部署上开启 Hosted 工具。嵌入式 Runtime Broker 调度 Runtime worker，即同一主机上执行 Workspace 工具的 Node.js 进程。工具执行需要既有的 fail-closed Runtime 与 Workspace 配置。在第 1 档配置之上，至少配置：

```bash
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED='true'
# harness.env 已含 QWEN_MANAGED_RUNTIME_BROKER_TOKEN 时（bootstrap 生成的就是如此）省略这一行。
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID='reference-v1'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY='<base64-encoded-32-byte-key>'
export QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY='/var/lib/qwen-managed-agent/runtime'
export QWEN_MANAGED_AGENT_NODE_EXECUTABLE='/usr/bin/node'
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/opt/qwen-code/dist/cli.js'
export QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED='true'
```

Hosted Harness 通过它自己的环境访问同一个 Broker，既不经命令行，也不经上面这些控制面变量：在 `harness.env`（或启动 Harness 的环境）中设置 `QWEN_MANAGED_RUNTIME_BROKER_URL='http://127.0.0.1:4182'`，并把 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN` 设为 Broker token。`qwen serve` 读取后会把这两个变量从自己的环境中删除，因此 Harness 启动的进程都不会继承该 token；控制面也会把 `QWEN_MANAGED_RUNTIME_BROKER_` 开头的变量挡在 Runtime worker 之外。使用 bootstrap 生成的文件时，`harness.env` 已包含这两项，控制面也从该文件读取 Broker token，因此不要设置 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN`；两份都设置时拒绝启动。Harness 的这两行要么同时设置，要么都不设置，并且每行都写成普通的 `KEY=value`：只有其中一行或其中一行为空的文件（Harness 同样会拒绝），以及 systemd 会忽略的 `export KEY=value` 这类写法，都会拒绝启动。预检的 `broker-url` 行按 Harness 的 URL 解析器的方式读取文件中的 URL，因此 `http://127.1:4182` 等同于 `http://127.0.0.1:4182`。该 URL 以 `http` 直接指向 Broker 自己的监听时，该行通过。以下两种情况报 FAIL：Harness 会拒绝这个 URL（URL 必须是 `http` 或 `https` 的 origin，且只有在回环接口上才可以用明文 `http`）；或者以 `https` 指向这个监听，而明文 HTTP 的 Broker 无法接受。URL 指向其他地址或端口时报 WARN，因为只有代理才可能转发过去；Broker 绑定在回环以外的具体地址时（需要 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_ALLOW_NON_LOOPBACK=true`），总是通过这种方式访问。绑定 `0.0.0.0` 同样需要这项设置，但它仍在回环上提供服务，Harness 直接经 `http://127.0.0.1:4182` 访问，该行通过。此时 `http://[::1]:4182` 这类 IPv6 URL 报 WARN，因为只有控制面 JVM 同时监听两个地址族时，该绑定才接受 IPv6，而在 `-Djava.net.preferIPv4Stack=true` 下并非如此。文件中没有 Broker URL 时也报 WARN：通过自身环境或命令行拿到这两个变量的 Harness，在预检看来就是这样，此时该告警属于预期；若要把这两个变量移进文件，就要从 `server.env` 中删除 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN`。

在准入文件、Shell 或 child Git 工作前，必须完成 `docs/server-reference.md` 中 “Verified physical Workspace recovery” 所述的原生 storage 注册与 mount identity 校验。未注册或有歧义的 mount 必须保持不可用。Public Shell 执行仍默认关闭。Shell lifecycle v2 默认声明；显式生命周期列表替换默认值，空列表禁用它。MCP 生命周期仍须显式加入。能力声明不等于部署资格验收。

## 第 3 档：Kubernetes

[Helm chart](https://github.com/QwenLM/qwen-code/tree/main/deploy/kubernetes) 用你在已评审源码 revision 上构建的镜像，在一个 Pod 中安装签名认证的 Managed Agent API 和私有 Hosted Harness，并在持久卷上运行 MySQL 8.4。默认支持文本 Session；可选设置可开启可信单节点的 Workspace 文件和前台 Shell，以及 Managed WebShell 网关。它从源码安装，而不是从本压缩包安装，遵循自己的说明文档，也不扩大本分发产物的验收范围。K2 CSI 常驻 Workspace 是另一种独立部署，见 [`deploy/k2-resident`](https://github.com/QwenLM/qwen-code/tree/main/deploy/k2-resident)。

## 运维部署

### 维护命令

`bin/qwen-managed-agent-admin <command> [arguments]` 通过 Spring Boot 的 `PropertiesLauncher`，从 server jar 运行各个离线维护入口，例如 `storage-registration`、`workspace-migration` 和各条 CSI 命令。不带参数运行可列出所有命令；某条命令不带参数运行会打印它的用法。与 server 启动脚本一样，当 `config/application.yml` 存在且未设置 `SPRING_CONFIG_ADDITIONAL_LOCATION` 时，它会使用该文件。大多数需要连接数据库的命令使用各自的凭据，而不是 `server.env` 中的 `SPRING_DATASOURCE_*`：Workspace 相关命令读取 `W1_JDBC_URL`、`W1_JDBC_USER` 和 `W1_JDBC_PASSWORD`，CSI 相关命令读取 `K2_JDBC_URL`、`K2_JDBC_USER` 和 `K2_JDBC_PASSWORD`。有两个例外：`operator-recovery` 和 `resident-retirement` 会启动服务端的 Spring 配置并使用其数据源，因此从环境变量和 `config/application.yml` 读取 `SPRING_DATASOURCE_URL`、`SPRING_DATASOURCE_USERNAME`、`SPRING_DATASOURCE_PASSWORD` 以及控制面的其他设置；运行它们时需先载入 `server.env`。`csi-protection` 不连接数据库，`resolved-configuration` 也不连接：它打印服务端配置在其运行环境中解析出的 Runtime 状态目录、认证模式和可信 actor 请求头；升级命令以同样的方式运行它来确定 Runtime 状态。每条命令都是一个离线流程，各有前提条件，写在相应的文档中；运行前请先满足这些条件。Hosted Shell 恢复流程仍以 `bin/qwen-managed-agent-operator-recovery` 为入口，`bin/qwen-managed-agent-admin operator-recovery` 运行的是同一条命令。

### 升级

在 systemd 布局下，新分发产物中的 `bin/qwen-managed-agent-upgrade` 分阶段执行升级。每个阶段都以 root 身份、在已解压并校验过的新压缩包目录中运行：

```bash
cd qwen-managed-agent-reference-<new-version>
# backup 要用的选项（例如 --skip-database）也传给 check。
bin/qwen-managed-agent-upgrade check
# 停止新的入口准入，等待已准入的工作完成结算。
bin/qwen-managed-agent-upgrade stop
bin/qwen-managed-agent-upgrade backup --to /var/backups/qwen-managed-agent/<date>
bin/qwen-managed-agent-upgrade install --backup /var/backups/qwen-managed-agent/<date>
# 执行 check 打印的人工步骤，例如为 Harness 安装 Qwen Code。
bin/qwen-managed-agent-upgrade start
bin/qwen-managed-agent-upgrade verify --tenant <tenant> --turn
# 恢复入口流量。
```

每个阶段都会重新读取 unit、其环境文件和已安装的版本；上一阶段留下的状态不符合预期时就拒绝执行，因此中断的升级可以从失败的阶段继续。unit 名不是 `qwen-managed-agent-server` 和 `qwen-hosted-harness` 时，用 `--server-unit` 和 `--harness-unit` 指定；命令通过这两个 unit 找到已安装的版本、环境文件和服务账号。

- `check` 不做任何改动。它按 `SHA256SUMS` 校验新分发产物，比较新旧两个版本（版本号、服务端 jar 中的 Flyway 脚本、Java、Node.js 与 Qwen Code），并读取 Harness 的 Broker 配置、unit 模板、已安装版本 `config/` 中的运维文件以及版本目录布局。它的 `backup-tools` 和 `runtime-state` 两行说明 `backup` 在给定选项下能否执行，因此备份用的选项也要传给 `check`；打印出的计划会带上这些选项。它为每项输入打印一行，再打印一份计划，把人工步骤放在对应位置；任一 FAIL 时退出码为 1。如果新版本修改或删除了已安装数据库执行过的脚本，`database` 行报 FAIL：在首个正式版发布之前，版本可能会原地重写 schema 基线，这样的版本无法在现有数据库上启动。新版本新增的 versioned 脚本如果没有排在已安装数据库执行过的最新脚本之后，该行同样报 FAIL，因为 Flyway 会拒绝执行它。
- `stop` 重新执行 `backup-tools` 之前的各项检查，检查不通过就什么都不停。`backup-tools` 和 `runtime-state` 两行只约束 `backup`，因此请在 `stop` 之前先用 `check` 让它们通过。它先停止控制面，再停止 `KillMode=process` 留在其 cgroup 中的 Runtime worker 并等待它们退出（`--timeout`，默认 60 秒），最后停止 Harness。它在 systemd 给出的 cgroup 中清点 worker：unified 层级下直接读取，cgroup v1 下读取 systemd 自己的层级；读不到该 cgroup 时拒绝执行。新版本安装之后，`stop` 不再执行这些检查，因此也能停止 `start` 留下仍在运行的控制面。JVM 收到 `SIGTERM` 后以 143 退出，因此没有模板中 `SuccessExitStatus=143` 的已安装控制面 unit 在停止后会显示为 `failed`；`stop` 会说明这一点，把模板的改动同步过去之后，`systemctl reset-failed` 可以清除该状态。
- `backup --to <新的空目录>` 要求两个 unit 都已停止且没有遗留 worker；新版本安装之后它会拒绝执行，因为这时备份的 `from.release` 会指向新版本。已存在的目录必须为空且属于 root。它用 `mysqldump` 写出 `database.sql`，unit 中的 `SPRING_DATASOURCE_*` 凭据通过备份目录之外某个临时目录里的选项文件传入，而不是放在命令行上；`mysqldump` 不读其他选项文件，root 的 `~/.my.cnf` 因此无法替换这些凭据。它写出 Runtime 状态目录的 `runtime-state.tar`；`configuration.tar`，其中包含 unit 文件、它们的环境文件、Harness 凭据文件和 `SPRING_CONFIG_ADDITIONAL_LOCATION` 指向的文件；以及 `release-config.tar`，其中包含已安装版本的 `config/` 和上述文件中位于版本目录内的部分，按它们在版本目录中的路径记录。符号链接形式的文件既以链接本身归档，也归档它指向的文件。所有文件都是 `0600`，所在目录为 `0700`；最后写入的 `backup.json` 记录各文件的校验和、导出的是哪个数据库，以及 `install` 会把旧版本放在哪里。`--mysqldump <path>` 指定其他客户端；数据库已用其他方式备份时，用 `--skip-database` 跳过导出。备份失败，或被 `SIGINT`、`SIGTERM`、`SIGHUP` 中止时，会删除已写出的内容和选项文件。`SIGKILL` 不会删除任何东西；它留下的 `${TMPDIR:-/tmp}/qwen-managed-agent-upgrade-*` 目录里有凭据，请删除该目录。
  - `check` 和 `backup` 从服务端自己的配置中取得 Runtime 状态目录。它们按控制面 unit 运行服务端的方式运行新版本的服务端 jar：使用该 unit 的账号、工作目录和环境；`SPRING_CONFIG_ADDITIONAL_LOCATION` 未设置或为空时，与 launcher 一样默认使用 `config/application.yml`。该 jar 按服务端的方式准备 Spring 环境，因此所有配置文件、import 和 profile 都会生效，`SPRING_APPLICATION_JSON`、`JAVA_TOOL_OPTIONS` 中的系统属性和 relaxed binding 形式的名称也一样；相对路径的目录按 unit 的工作目录解析。它不启动任何组件，也不建立任何连接。如果无法解析配置，或者 unit 给 launcher 传了参数（`systemctl` 打印的参数无法准确还原），`backup` 会拒绝执行，直到用 `--runtime-state <目录>` 指明服务端实际使用的目录，或用 `--runtime-state none` 说明不保存 Runtime 状态。没有配置状态目录时（例如未开启工具路径的部署），`backup` 不归档 Runtime 状态，并明确说明。
- `install --backup <目录>` 拒绝其他版本的备份、内容有变化的备份文件、控制面在备份之后又启动过的备份，以及所导出的数据库与 unit 的 `SPRING_DATASOURCE_URL` 不同的备份。它把新版本复制到 `<分发路径>-releases/<version>`，例如 `/opt/qwen-managed-agent-releases/<version>`（用 `--releases` 指定其他目录，并在每个阶段都传同一个），把已安装版本 `config/` 中的运维文件连同属主和权限复制过去，再用一次 rename 把分发路径指向新版本。副本中属于版本自身的文件（即 `SHA256SUMS` 列出的文件）会设为所有账号可读，所以即使解压时用了严格的 umask，服务账号也能运行该版本。第一次运行会把已安装的目录移到 `<releases>/<旧版本>`，并在原位置放一个链接，因此 unit 中的路径不变。旧版本保留在原处。已存在的 `<releases>/<version>`（例如直接解压到那里的发行包）只有在其 `SHA256SUMS` 与新分发产物相同、且文件与之相符时才会被使用，其中列出的文件同样会设为所有账号可读；复制失败时会删除复制出的内容。如果第一次运行在两次 rename 之间崩溃，分发路径会缺失，旁边留下 `<分发路径>.upgrade-<后缀>`；此后每个阶段都会给出完成安装所需的 `mv -T` 命令。在其他步骤被杀掉的 install，可能在版本目录里留下部分副本 `.<version>.partial-<后缀>`，在分发路径旁留下 `<分发路径>.upgrade-<后缀>` 链接，或在新版本的 `config/` 里留下运维文件的 `.tmp-<后缀>` 副本；`layout` 行会列出它们，下一次 `install` 会删除它们。后缀是 `install` 生成的 8 位十六进制数，因此运维自己的 `<分发路径>.upgrade-backup` 之类不会被删除。版本安装完成后再次运行（例如会话中断后），`install` 会说明已经安装并提示运行 `start`。
- `install` 之前，以及 Harness 的 Broker 配置仍需按下文第 5 步修改时，`start` 会拒绝执行。它先启动 Harness（如果之前某次 `start` 留下了正在运行的 Harness，则重启它，以读入此后修改过的内容），再以服务账号、按 unit 的环境运行 `bin/qwen-managed-agent-server --check`，通过后才启动控制面，并等待 actuator 报告健康（`--timeout`，默认 300 秒；单次探测最多等待 5 秒）。Flyway 在这次启动中迁移 schema。控制面在健康之前退出时会被停止并报告，即使 systemd 的 `Restart=on-failure` 再次运行它就能起来也是如此：迁移 schema 的这次启动中出现了退出，应先查看日志，再重新运行 `start`；超时仍未健康时控制面保持运行，请查看其日志，然后运行 `verify`，或先 `stop` 再重新 `start`。
- `verify` 以同样方式运行 `--check --online` 并读取 actuator，最多等待 `--timeout`（默认 300 秒）让它应答。指定 `--tenant <id>` 时，它在 `--turn` 创建 Session 之前读取该租户最近的 Session 及其 Item；`--turn` 会创建一个 Session 并等待一个 Turn 完成，这会调用模型，轮询遇到 `5xx` 应答或连接中断时会继续；跳过 Session 读取时，`turn` 行会说明这一点。任何请求都不会超过 `--timeout`。不带 actor 的请求只能列出 Workspace 之外的 Session；`--actor <id>` 通过 `QWEN_MANAGED_AGENT_TRUSTED_ACTOR_HEADER` 指定的请求头带上一个 actor。`verify` 按 `backup` 读取 Runtime 状态目录的方式读取认证模式；使用签名认证时两项读取都跳过，请通过入口读取 Session。

该命令只启动和停止 unit，不会停止入口流量、安装 Qwen Code、修改环境文件或 unit 文件，也不会删除任何版本。`check` 提示 unit 模板有变化时，请在 `start` 之前把变化同步到已安装的 unit，并执行 `systemctl daemon-reload`。

#### 手工流程

其他布局按以下步骤操作。在 systemd 布局下，命令执行 `stop`、`backup`、`install`、`start` 和 `verify`，并由 `check` 把留给运维的步骤打印在对应位置：停止和恢复入口流量、第 5 步中安装 Qwen Code 并修改 `harness.env`，以及把有变化的 unit 模板同步到已安装的 unit。

1. 下载并校验新压缩包，读取新旧两个 manifest。在改动运行中部署前，确认新的 Qwen Code/Harness、Java、协议与数据库要求。
2. 停止新的入口准入，按照部署既有 drain 流程等待已准入工作完成结算。
3. 备份 MySQL、Runtime 状态目录、完整 Runtime credential key ring、运维自有的 `server.env` 与 `harness.env`，以及精确旧版分发产物。分发产物升级期间不要轮换 credential key。载入 `server.env` 后运行 `bin/qwen-managed-agent-admin resolved-configuration`，可以打印配置解析出的 Runtime 状态目录。
4. 停止 Java 服务与 Hosted Harness，保留 Workspace 和 durable Runtime state。随包的控制面 unit 使用 `KillMode=process`，`systemctl stop` 不会终止 Runtime worker；启动新版本前先用 `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` 回收。
5. 安装与 manifest 匹配的 Qwen Code/Harness，并使用既有 token 与 capability digest 启动。工具路径的主机需先把 `harness.env` 中的 `QWEN_HOSTED_HARNESS_BROKER_ARGS` 行换成 `QWEN_MANAGED_RUNTIME_BROKER_URL` 和 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`：已经没有组件读取那一行，不替换的话 Harness 启动时没有 Broker。如果 `server.env` 启用了 Harness 并把 `harness.env` 指定为凭据文件（bootstrap 生成的文件就是这样），还要从 `server.env` 中删除 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN`：此后控制面从 `harness.env` 读取 token，两份都保留会拒绝启动。旧版分发产物不读取这两个新键，缺少被删除的 token 时也不会启动其 Broker，因此回滚到旧版时要从第 3 步的备份恢复这两个文件。新版发行产物的 `--check` 会在 `workers` 行列出现在仍存活的 worker；请在此处以离线模式运行——服务仍停止、Harness 已启动——因为在线模式下持久模式的 Broker 会让该行 SKIP。
6. 使用相同数据库和 durable 配置启动新版 `bin/qwen-managed-agent-server`，由 Flyway 向前迁移 schema。
7. 要求 actuator 健康检查通过，读取一个既有 Session 与历史，再完成一个新的无工具 Turn，之后才能恢复入口流量。任何可选工具 capability 都必须在重新验收后才能开启。

不支持数据库降级。如果在恢复流量前启动或验证失败，应修正配置并重试同一产物。如需退回到 manifest 声明较旧 schema 范围的版本，必须在接受任何新写入前同时恢复升级前的数据库与 Runtime-state 备份；不得假设旧 server 可以直接运行在已迁移数据库上。任何退回旧版分发产物的操作，都要从同一份备份恢复 `server.env` 与 `harness.env`，因为第 5 步已为新版本改写了它们。

使用该命令生成的备份时，在两个 unit 都已停止的情况下按以下步骤退回旧版本。尖括号中的名称是 `<backup>/backup.json` 的字段。两行 `mysql` 用当初执行 `config/mysql-setup.sql` 的管理员账号运行：如下所示在数据库主机上运行；数据库在远程主机时，加上 `-h <datasource.host> -P <datasource.port>` 和该账号的凭据。`files` 列表中没有的归档，跳过对应的那一行；`database` 为 `skipped` 时跳过两行 `mysql`，改用当初备份数据库的方式恢复。

```bash
mysql -u root -e 'DROP DATABASE <datasource.database>'
mysql -u root < <backup>/database.sql   # 重新创建数据库
tar -C <runtimeState> --numeric-owner -xpf <backup>/runtime-state.tar
tar -C / --numeric-owner -xpf <backup>/configuration.tar
tar -C <from.release> --numeric-owner -xpf <backup>/release-config.tar
ln -sfn <from.release> <distribution>
systemctl daemon-reload
systemctl start <harness.unit> <server.unit>
```

解压到 Runtime 状态目录之前先清空该目录。`release-config.tar` 直接解压到旧版本目录，而不是经由 `<distribution>`：在执行 `ln` 那一行之前，它仍链接到新版本。如果新控制面因为数据库与其 schema 不匹配而拒绝启动，它没有做任何迁移，只需恢复链接和文件。

### 轮换 Runtime credential key

请把 credential key 轮换与分发产物升级分开执行。先备份数据库和当前密钥，再配置新的 active key pair，并把旧 key pair 保留在 `previous-credential-keys` 下：

```yaml
qwen:
  managed-agent:
    runtime-broker:
      credential-key-id: reference-v2
      credential-key: <base64-encoded-32-byte-v2-key>
      previous-credential-keys:
        '[reference-v1]': <base64-encoded-32-byte-v1-key>
```

请把每个映射键写成 `[ ... ]` 形式。Spring 的宽松绑定会规整普通键——`legacy/v1`、`legacy:v1` 或 `legacy v1` 这类 ID 无论 YAML 中是否加引号都会绑定为 `legacyv1`——导致 ring 永远无法匹配持久化的 key ID：即使密钥已配置，该 ID 下写入的记录仍不可读。方括号形式能按原样保留 key ID。

重启单 Java control plane，验证既有 binding 可以加载，并确认新 binding 记录写入 `reference-v2`。新 secret 只使用 active key；旧记录继续由其已记录的 key ID 加密。服务器不会在读取时重加密旧记录，删除仍被引用的密钥会使这些记录不可读。

只有在没有持久化记录再引用 `reference-v1` 之后，才能退场该密钥。`ma_runtime_binding` 的 `credential_key_id` 与 `runtime_credential_key_id` 是仅有的两处持久化引用；两列都以 UTF-8 字节存储。查询时不要加 `CONVERT`，让去重与密钥选择一样按字节精确比较：转换后的值携带该字符集的默认排序规则，会把仅大小写或重音不同的两个 ID 合并，从而漏掉仍被记录引用的密钥。

```sql
SELECT DISTINCT credential_key_id AS key_id
FROM ma_runtime_binding WHERE credential_key_id IS NOT NULL
UNION
SELECT DISTINCT runtime_credential_key_id AS key_id
FROM ma_runtime_binding WHERE runtime_credential_key_id IS NOT NULL;
```

查询结果列出持久化记录仍需要的 key ID：预期只剩 active ID（`reference-v2`）。只要结果中仍出现 `reference-v1`，就必须继续配置该密钥。

该 key ring 是映射结构，无法通过 `QWEN_MANAGED_AGENT_*` 环境变量提供：宽松绑定会把环境变量形式静默解析为空 ring 或键名错误的 ring，且启动时不报错。`previous-credential-keys` 配置在 `config/application.yml` 中。分发产物随包提供 `config/application.example.yml`，两个启动脚本都会在该文件存在时导出 `SPRING_CONFIG_ADDITIONAL_LOCATION=file:<分发产物根目录>/config/application.yml`，因此加载位置不再取决于进程工作目录，也不会向命令的位置参数注入选项。若该变量已设置，启动脚本保留原值。只依赖环境变量的部署会以空 ring 启动，因此在未配置旧密钥的情况下轮换 `credential-key-id` 会使旧密钥写入的记录不可读。显式的 `--spring.config.additional-location` 命令行参数优先于该环境变量默认值；两者同时存在时命令行值生效，随包的 `config/application.yml` 不会被加载。

`operator-recovery` 入口与服务器读取相同的 active pair 和 `previous-credential-keys` 映射。其启动脚本同样加载 `config/application.yml`；文件位于其他位置时，设置 `SPRING_CONFIG_ADDITIONAL_LOCATION=file:<绝对路径>/application.yml`。保持新密钥为 active，并保留 binding 仍引用的每把旧密钥。CSI/迁移维护入口（含 CSI Hosted 探针）仍只读取单个 credential key pair；这些入口继续以加密目标 binding 的密钥作为 active pair 启动。

密钥环配置成功后，服务器和恢复入口会为每个 protector 实例记录一次解析后的 active ID 和 configured IDs。这些 ID 是已随密文保存的非 secret 标识；诊断通过 JSON 转义控制字符与非 ASCII 字符、保留空格和大小写，绝不包含密钥材料、密文或 token。使用轮换后的部署前，应将 configured IDs 与退场查询返回的精确 ID 对照。密钥不可用错误会同时给出 requested、active 和 configured IDs，便于定位被静默规整或拼错的映射，同时避免泄露 secret。这些诊断不能证明每条持久化记录都能解密。

### 运维恢复

`bin/qwen-managed-agent-operator-recovery` 启动独立打包的 recovery 入口。除非设置 recovery 专用环境，否则该入口保持关闭，并且不会启动 HTTP 服务或 worker。严格遵循 `docs/hosted-workspace-recovery.zh-CN.md`；不得推断物理停止，也不得通过删除 durable row 清除安全围栏。

## 范围边界

该分发产物不认证多 Java 控制面、跨主机接管、公开 CSI、Kubernetes retirement、public Shell、v2 advertisement 或稳定生产支持。这些能力需要独立发布证据。
