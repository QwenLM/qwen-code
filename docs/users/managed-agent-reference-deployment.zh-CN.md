# Managed Agent 参考部署

[English](managed-agent-reference-deployment.md) | [简体中文](managed-agent-reference-deployment.zh-CN.md)

Managed Agent 参考分发产物仍处于实验阶段。首个已接受拓扑为：一台可信 Linux 主机上的单 Java 控制面及其嵌入式 Runtime Broker、一个 MySQL 数据库，以及一个兼容的 Qwen Hosted Harness。每个发布版本中的兼容性 manifest 是该版本的权威依据。

## 校验并解压

从同一个 GitHub prerelease 下载压缩包、独立 manifest 和 `SHA256SUMS.txt`，解压前完成校验：

```bash
sha256sum --check SHA256SUMS.txt
tar -xzf qwen-managed-agent-reference-<version>.tar.gz
cd qwen-managed-agent-reference-<version>
sha256sum --check SHA256SUMS
```

检查 `manifest.json`。确认 `source.revision` 是已评审的 revision，`compatibility.qwenCodeVersion` 与 CLI/Harness 安装一致，并确认目标数据库可接受 `compatibility.databaseSchema.latestMigrationVersion`。任一校验和或兼容检查失败时，发布产物均视为无效。

## 前置条件

- 可信应用主机使用 Linux。
- JDK 21 或更高版本。
- Node.js 满足 `compatibility.node`，Qwen Code 匹配 `compatibility.qwenCodeVersion`。
- MySQL 8，使用空数据库或由旧版兼容参考分发产物管理的数据库。
- Runtime state 和授权 Workspace 使用私有、持久目录。
- 数据库凭据、Runtime credential key ring 和 Harness token 稳定保存于压缩包之外。

Java 压缩包不包含 npm CLI。请单独安装或构建精确兼容的 Qwen Code revision，并找到供 Runtime worker 使用的 `dist/cli.js`。

## 启动 Hosted Harness

选择一个 token 与 capability digest，并让 Harness 和 Java 服务使用相同值：

```bash
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'

QWEN_SERVER_TOKEN="$QWEN_MANAGED_AGENT_HARNESS_TOKEN" \
QWEN_HOSTED_HARNESS_CAPABILITY_DIGEST="$QWEN_MANAGED_AGENT_CAPABILITY_DIGEST" \
qwen serve --profile hosted-harness --port 4170 --hostname 127.0.0.1 --no-web
```

Harness 保持监听 loopback。Hosted Harness profile 不会换到其他端口：`--port` 被占用时 Harness 启动失败，并给出端口号。

## 启动 Java 控制面

在另一个终端配置同一 Harness、数据库和一个已存在的 Workspace 目录：

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

无法通过环境变量表达的设置（例如 Runtime 凭据密钥环）写在 `config/application.yml` 中。从随包模板复制并收紧权限：

```bash
cp config/application.example.yml config/application.yml
chmod 600 config/application.yml
```

两个启动脚本都会在该文件存在时自动加载。该启动脚本使用压缩包内的 server JAR。Spring Flyway 会在服务 ready 前执行向前数据库 migration。等待：

```bash
curl --fail http://127.0.0.1:8080/actuator/health
```

开启 Harness 即开启 Managed Session Store。Store 的 base URL 默认指向本服务的明文 loopback 监听；workspace ID 默认取 Runtime Broker 从 `QWEN_MANAGED_AGENT_WORKSPACE_CWD` 推导出的值，因此开启下文的工具路径后身份保持不变。已经设置过 `QWEN_MANAGED_AGENT_WORKSPACE_ID` 的部署必须保留它：未绑定 Session 从该 ID 解析其 Store 作用域。只有当 Harness 需要通过其他地址访问本服务，或该监听提供 TLS 时，才设置 `QWEN_MANAGED_AGENT_SESSION_STORE_BASE_URL`。

基础配置支持纯文本 Hosted Session。除非配置签名或认证入口，否则服务只能监听 loopback。完整认证、API 与 capability 配置随包提供于 `docs/server-reference.md`。

## 生成凭据

`bin/qwen-managed-agent-bootstrap` 生成共享的 Harness token 与 capability digest、broker token、Runtime 凭据密钥以及数据库密码。它写出 `config/harness.env`、`config/server.env`、`config/application.yml` 与 `config/mysql-setup.sql`，权限为 0600；目标文件已存在时除非传入 `--force` 否则拒绝覆盖；只打印路径，不打印 secret：

```bash
bin/qwen-managed-agent-bootstrap
```

token 与 digest，以及工具路径所需的 Broker URL 和 token，只写入 `harness.env`：`server.env` 通过 `QWEN_MANAGED_AGENT_HARNESS_CREDENTIALS_FILE` 指向该文件，控制面从中读取这些值。若该文件与 `QWEN_MANAGED_AGENT_HARNESS_TOKEN` 或 `QWEN_MANAGED_AGENT_CAPABILITY_DIGEST` 同时设置，或文件中的 Broker token 与 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN` 同时设置，控制面拒绝启动，因此轮换时只需修改一个文件。生成的 `harness.env` 与 `server.env` 既可直接被 shell source，也可作为 systemd 的 `EnvironmentFile`。

`mysql-setup.sql` 创建 `qwen_managed_agent` 数据库和 `server.env` 中写明的 `qwen` 账号（`localhost` 与 `127.0.0.1` 各一个），并授予 Flyway 需要的 `performance_schema` 权限。以 MySQL 管理员身份运行一次，例如 `mysql -u root < config/mysql-setup.sql`，然后删除它；密码保存在 `server.env` 中。它遇到第一条失败的语句就停止，因此不会改动已有的数据库或账号。容器中的 MySQL 看到的是网关地址而不是 `127.0.0.1`，此时请为那个主机创建账号。

systemd 布局下，以 root 身份运行并传入 `--directory /etc/qwen-managed-agent --service-user qwen-managed-agent`。此时 `harness.env` 与 `application.yml` 归服务账号所有，`server.env` 为 `0640 root:qwen-managed-agent`，新建的目录为 `0750 root:qwen-managed-agent`，`mysql-setup.sql` 仍归 root。账号不存在、或账号无法进入该目录时，bootstrap 拒绝执行。`server.env` 还会记录 `QWEN_MANAGED_AGENT_SERVICE_USER`，因此即使以 root 身份运行预检，它也会按该账号检查文件访问权限。

## 预检

在首次启动前以及每次安装新产物后，用启动脚本运行 `--check`。它绑定与服务器相同的配置（`config/application.yml` 加环境变量），不启动监听，并按输入项逐行输出结果：

```bash
bin/qwen-managed-agent-server --check
```

检查范围包括 JDK、服务账号、配置文件及其权限、凭据密钥环、启动期属性校验、auth 与绑定组合、Harness、Workspace files 与 Shell 的交叉配置（含 mount、creation root 或 SSH 节点要求）、Broker 凭据与目录、Workspace `cwd`、端口占用、上次运行遗留的 Runtime worker，以及 MySQL 连通性、`performance_schema` 授权和 Flyway 版本与 `manifest.json` 的一致性。`WARN` 与 `SKIP` 不导致失败；任一 `FAIL` 退出码为 1。

`harness` 行会像第一个 Session 那样与单个配置的 Harness 协商；使用 Harness pool 时，只有在 Session Store 已启用且配置了 binding key 后，才对 pool 的端点跳过，否则报 FAIL。capability digest 不一致、缺少协议或必需的 feature、或者 Harness 缺少某个已配置 Workspace profile 所需的 lifecycle 时报 FAIL；Harness 运行的 Qwen Code 版本与 `manifest.json` 写明的不同，或者 Harness 没有说明版本时报 WARN。端口检查会实际绑定配置地址，`workers` 行会对仍在 Runtime 状态目录中运行的 worker 给出警告，因此应先停止服务。服务运行期间请加上 `--online`：端口相关的行改为检查是否有进程在监听；`workers` 行只报告已停止的服务端遗留的 worker，对持久模式的 Broker 则跳过，因为它会接管这些 worker。该命令不校验原生 Workspace storage 注册。

## systemd

分发产物包含面向既定单机拓扑的 `systemd/` unit 与环境模板。控制面 unit 使用 `KillMode=process`，使 Runtime worker 在 Broker 重启后继续存活；Harness unit 使用 `KillMode=mixed`，使其工具进程随 Harness 终止。安装步骤见 `systemd/README.zh-CN.md`。

## 开启已接受的 local-process 工具路径

工具执行需要既有的 fail-closed Runtime 与 Workspace 配置。在基础配置之上，至少配置：

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

## 升级

1. 下载并校验新压缩包，读取新旧两个 manifest。在改动运行中部署前，确认新的 Qwen Code/Harness、Java、协议与数据库要求。
2. 停止新的入口准入，按照部署既有 drain 流程等待已准入工作完成结算。
3. 备份 MySQL、`QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`、完整 Runtime credential key ring、运维自有的 `server.env` 与 `harness.env`，以及精确旧版分发产物。分发产物升级期间不要轮换 credential key。
4. 停止 Java 服务与 Hosted Harness，保留 Workspace 和 durable Runtime state。随包的控制面 unit 使用 `KillMode=process`，`systemctl stop` 不会终止 Runtime worker；启动新版本前先用 `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` 回收。
5. 安装与 manifest 匹配的 Qwen Code/Harness，并使用既有 token 与 capability digest 启动。工具路径的主机需先把 `harness.env` 中的 `QWEN_HOSTED_HARNESS_BROKER_ARGS` 行换成 `QWEN_MANAGED_RUNTIME_BROKER_URL` 和 `QWEN_MANAGED_RUNTIME_BROKER_TOKEN`：已经没有组件读取那一行，不替换的话 Harness 启动时没有 Broker。如果 `server.env` 启用了 Harness 并把 `harness.env` 指定为凭据文件（bootstrap 生成的文件就是这样），还要从 `server.env` 中删除 `QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN`：此后控制面从 `harness.env` 读取 token，两份都保留会拒绝启动。旧版分发产物不读取这两个新键，缺少被删除的 token 时也不会启动其 Broker，因此回滚到旧版时要从第 3 步的备份恢复这两个文件。新版发行产物的 `--check` 会在 `workers` 行列出现在仍存活的 worker；请在此处以离线模式运行——服务仍停止、Harness 已启动——因为在线模式下持久模式的 Broker 会让该行 SKIP。
6. 使用相同数据库和 durable 配置启动新版 `bin/qwen-managed-agent-server`，由 Flyway 向前迁移 schema。
7. 要求 actuator 健康检查通过，读取一个既有 Session 与历史，再完成一个新的无工具 Turn，之后才能恢复入口流量。任何可选工具 capability 都必须在重新验收后才能开启。

不支持数据库降级。如果在恢复流量前启动或验证失败，应修正配置并重试同一产物。如需退回到 manifest 声明较旧 schema 范围的版本，必须在接受任何新写入前同时恢复升级前的数据库与 Runtime-state 备份；不得假设旧 server 可以直接运行在已迁移数据库上。任何退回旧版分发产物的操作，都要从同一份备份恢复 `server.env` 与 `harness.env`，因为第 5 步已为新版本改写了它们。

## 轮换 Runtime credential key

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

## 运维恢复

`bin/qwen-managed-agent-operator-recovery` 启动独立打包的 recovery 入口。除非设置 recovery 专用环境，否则该入口保持关闭，并且不会启动 HTTP 服务或 worker。严格遵循 `docs/hosted-workspace-recovery.zh-CN.md`；不得推断物理停止，也不得通过删除 durable row 清除安全围栏。

## 范围边界

该分发产物不认证多 Java 控制面、跨主机接管、公开 CSI、Kubernetes retirement、public Shell、v2 advertisement 或稳定生产支持。这些能力需要独立发布证据。
