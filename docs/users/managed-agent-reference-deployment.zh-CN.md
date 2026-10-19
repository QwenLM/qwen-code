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

Harness 保持监听 loopback。记录实际报告的端口；请求端口被占用时，`--port` 可能递增。

## 启动 Java 控制面

在另一个终端配置同一 Harness 与数据库：

```bash
export SPRING_DATASOURCE_URL='jdbc:mysql://127.0.0.1:3306/qwen_managed_agent'
export SPRING_DATASOURCE_USERNAME='qwen'
export SPRING_DATASOURCE_PASSWORD='<private-password>'
export QWEN_MANAGED_AGENT_HARNESS_ENABLED='true'
export QWEN_MANAGED_AGENT_HARNESS_BASE_URL='http://127.0.0.1:4170'
export QWEN_MANAGED_AGENT_HARNESS_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_CAPABILITY_DIGEST='sha256:<64-hex-digest>'

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

基础配置支持纯文本 Hosted Session。除非配置签名或认证入口，否则服务只能监听 loopback。完整认证、API 与 capability 配置随包提供于 `docs/server-reference.md`。

## 生成凭据

`bin/qwen-managed-agent-bootstrap` 生成共享的 Harness token 与 capability digest、broker token 以及 Runtime 凭据密钥。它写出 `config/harness.env`、`config/server.env` 与 `config/application.yml`，权限为 0600；目标文件已存在时除非传入 `--force` 否则拒绝覆盖；只打印路径，不打印 secret：

```bash
bin/qwen-managed-agent-bootstrap
```

生成的 `harness.env` 与 `server.env` 既可直接被 shell source，也可作为 systemd 的 `EnvironmentFile`。systemd 布局下传入 `--directory /etc/qwen-managed-agent`，随后填写 `SPRING_DATASOURCE_PASSWORD`，并把文件属主调整为服务账号。

## 预检

在首次启动前以及每次安装新产物后，用启动脚本运行 `--check`。它绑定与服务器相同的配置（`config/application.yml` 加环境变量），不启动监听，并按输入项逐行输出结果：

```bash
bin/qwen-managed-agent-server --check
```

检查范围包括 JDK、配置文件及其权限、凭据密钥环、启动期属性校验、auth 与绑定组合、Harness 可达性、Workspace files 与 Shell 的交叉配置（含 mount、creation root 或 SSH 节点要求）、Broker 凭据与目录、Workspace `cwd`、端口占用，以及 MySQL 连通性、`performance_schema` 授权和 Flyway 版本与 `manifest.json` 的一致性。`WARN` 与 `SKIP` 不导致失败；任一 `FAIL` 退出码为 1。端口检查会实际绑定配置地址，因此应先停止服务。该命令不校验 Harness capability digest，也不校验原生 Workspace storage 注册。

## systemd

分发产物包含面向既定单机拓扑的 `systemd/` unit 与环境模板。控制面 unit 使用 `KillMode=process`，使 Runtime worker 在 Broker 重启后继续存活；Harness unit 使用 `KillMode=mixed`，使其工具进程随 Harness 终止。安装步骤见 `systemd/README.zh-CN.md`。

## 开启已接受的 local-process 工具路径

工具执行需要既有的 fail-closed Runtime 与 Workspace 配置。至少配置：

```bash
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_ENABLED='true'
export QWEN_MANAGED_AGENT_RUNTIME_BROKER_TOKEN='<private-random-token>'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY_ID='reference-v1'
export QWEN_MANAGED_AGENT_RUNTIME_CREDENTIAL_KEY='<base64-encoded-32-byte-key>'
export QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY='/var/lib/qwen-managed-agent/runtime'
export QWEN_MANAGED_AGENT_NODE_EXECUTABLE='/usr/bin/node'
export QWEN_MANAGED_AGENT_RUNTIME_WORKER_ENTRY='/opt/qwen-code/dist/cli.js'
export QWEN_MANAGED_AGENT_WORKSPACE_ID='reference-workspace'
export QWEN_MANAGED_AGENT_WORKSPACE_CWD='/srv/qwen-workspace'
export QWEN_MANAGED_AGENT_RUNTIME_VERIFIED_WORKSPACE_RECOVERY_ENABLED='true'
```

在准入文件、Shell 或 child Git 工作前，必须完成 `docs/server-reference.md` 中 “Verified physical Workspace recovery” 所述的原生 storage 注册与 mount identity 校验。未注册或有歧义的 mount 必须保持不可用。Public Shell 与 v2 capability advertisement 在各自独立资格验收完成前继续关闭。

## 升级

1. 下载并校验新压缩包，读取新旧两个 manifest。在改动运行中部署前，确认新的 Qwen Code/Harness、Java、协议与数据库要求。
2. 停止新的入口准入，按照部署既有 drain 流程等待已准入工作完成结算。
3. 备份 MySQL、`QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`、完整 Runtime credential key ring 和精确旧版分发产物。分发产物升级期间不要轮换 credential key。
4. 停止 Java 服务与 Hosted Harness，保留 Workspace 和 durable Runtime state。随包的控制面 unit 使用 `KillMode=process`，`systemctl stop` 不会终止 Runtime worker；启动新版本前先用 `systemctl kill --kill-whom=all -s TERM qwen-managed-agent-server` 回收。
5. 安装与 manifest 匹配的 Qwen Code/Harness，并使用既有 token 与 capability digest 启动。
6. 使用相同数据库和 durable 配置启动新版 `bin/qwen-managed-agent-server`，由 Flyway 向前迁移 schema。
7. 要求 actuator 健康检查通过，读取一个既有 Session 与历史，再完成一个新的无工具 Turn，之后才能恢复入口流量。任何可选工具 capability 都必须在重新验收后才能开启。

不支持数据库降级。如果在恢复流量前启动或验证失败，应修正配置并重试同一产物。如需退回到 manifest 声明较旧 schema 范围的版本，必须在接受任何新写入前同时恢复升级前的数据库与 Runtime-state 备份；不得假设旧 server 可以直接运行在已迁移数据库上。

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
