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
- 数据库凭据、Runtime credential key 和 Harness token 稳定保存于压缩包之外。

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

该启动脚本使用压缩包内的 server JAR。Spring Flyway 会在服务 ready 前执行向前数据库 migration。等待：

```bash
curl --fail http://127.0.0.1:8080/actuator/health
```

基础配置支持纯文本 Hosted Session。除非配置签名或认证入口，否则服务只能监听 loopback。完整认证、API 与 capability 配置随包提供于 `docs/server-reference.md`。

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
3. 备份 MySQL、`QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`、Runtime credential key 和精确旧版分发产物。升级期间不要轮换 credential key。
4. 停止 Java 服务与 Hosted Harness，保留 Workspace 和 durable Runtime state。
5. 安装与 manifest 匹配的 Qwen Code/Harness，并使用既有 token 与 capability digest 启动。
6. 使用相同数据库和 durable 配置启动新版 `bin/qwen-managed-agent-server`，由 Flyway 向前迁移 schema。
7. 要求 actuator 健康检查通过，读取一个既有 Session 与历史，再完成一个新的无工具 Turn，之后才能恢复入口流量。任何可选工具 capability 都必须在重新验收后才能开启。

不支持数据库降级。如果在恢复流量前启动或验证失败，应修正配置并重试同一产物。如需退回到 manifest 声明较旧 schema 范围的版本，必须在接受任何新写入前同时恢复升级前的数据库与 Runtime-state 备份；不得假设旧 server 可以直接运行在已迁移数据库上。

## 运维恢复

`bin/qwen-managed-agent-operator-recovery` 启动独立打包的 recovery 入口。除非设置 recovery 专用环境，否则该入口保持关闭，并且不会启动 HTTP 服务或 worker。严格遵循 `docs/hosted-workspace-recovery.zh-CN.md`；不得推断物理停止，也不得通过删除 durable row 清除安全围栏。

## 范围边界

该分发产物不认证多 Java 控制面、跨主机接管、公开 CSI、Kubernetes retirement、public Shell、v2 advertisement 或稳定生产支持。这些能力需要独立发布证据。
