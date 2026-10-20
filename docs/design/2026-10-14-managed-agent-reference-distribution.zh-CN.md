# Managed Agent 参考分发产物

[English](2026-10-14-managed-agent-reference-distribution.md) | [简体中文](2026-10-14-managed-agent-reference-distribution.zh-CN.md)

状态：拟在 #14157 中实现。

## 问题

仓库已经能够构建包含 Runtime Broker 源码的 `qwen-managed-agent-server`，但受保护的 Java SDK 发布流程只发布 `qwencode-sdk`。因此 Hosted 验收需要应用分发产物。运维人员必须能够下载经过评审的 server 产物、核验其源码 revision、判断兼容的 Harness 与数据库 schema，并遵循明确的升级路径。

## 目标

- 独立于 npm CLI 发布实验性参考分发产物。
- 将每个分发版本绑定到一个精确源码 revision 和明确的兼容性元数据。
- 让 pull request CI 与不发布的手工 dry run 构建同一产物。
- 为单 Java 控制面、单可信 Linux 主机的首版范围提供完整部署和升级步骤。
- 将嵌入式 Broker 包含在带版本的 Server 组件中。

## 非目标

- 开启 public Shell、v2 capability advertisement、Automation、Channels 或留存默认值。
- 发布容器镜像或决定长期使用的容器仓库。
- 支持两个存活 Java 控制面、跨主机接管、公开 CSI 或稳定支持等级。
- 把 npm CLI 或 Hosted Harness 打入 Java 压缩包。

## 分发格式

发布产物为 `qwen-managed-agent-reference-<version>.tar.gz`，其中只有一个顶层目录，内容如下：

```text
bin/qwen-managed-agent-server
bin/qwen-managed-agent-operator-recovery
bin/qwen-managed-agent-bootstrap
bin/qwen-managed-agent-bootstrap.mjs
config/application.example.yml
systemd/qwen-hosted-harness.service
systemd/qwen-managed-agent-server.service
systemd/harness.env.example
systemd/server.env.example
systemd/README.md
systemd/README.zh-CN.md
lib/qwen-managed-agent-server-<component-version>.jar
lib/qwen-managed-agent-server-<component-version>-operator-recovery.jar
docs/deployment.md
docs/deployment.zh-CN.md
docs/server-reference.md
docs/hosted-workspace-recovery.md
docs/hosted-workspace-recovery.zh-CN.md
manifest.json
SHA256SUMS
LICENSE
```

启动脚本只使用 bundle 内的相对 JAR 路径。运维人员在 bundle 根目录创建 `config/application.yml` 后，启动脚本会在该变量未设置时导出 `SPRING_CONFIG_ADDITIONAL_LOCATION`，位置参数原样传给 Java。模板本身不包含生效配置，复制后在编辑前不改变任何行为。Server JAR 包含 Broker 类和资源，不另行提供 Broker 产物或进程。`systemd/` 模板落实了文档要求的 kill mode：控制面使用 `process`，使 Runtime worker 在 Broker 重启后继续存活；Harness 使用 `mixed`，使其工具进程随 Harness 终止。

发布页同时提供独立的 `manifest.json` 副本与 `SHA256SUMS.txt`。外层校验和覆盖压缩包和独立 manifest；bundle 内的校验和覆盖全部载荷文件以及 `manifest.json`。

## 凭据生成

`bin/qwen-managed-agent-bootstrap` 生成共享的 Harness token 与 capability digest、broker token 与 Runtime 凭据密钥，并写出 `harness.env`、`server.env` 与 `application.yml`，权限为 0600。目标文件已存在时除非传入 `--force` 否则拒绝覆盖；只打印路径。digest 是任意共享标识：Harness 回显配置值，而不是从能力集推导。生成器不会编造数据源凭据。

## Manifest 契约

`manifest.json` 的 schema version 为 `1`，记录：

- 分发名称、版本、实验状态、仓库和精确 Git revision；
- 每个组件的 Maven 版本、bundle 路径、字节数和 SHA-256；
- 同一源码树中的精确 Qwen Code 版本与 Hosted Harness profile；
- 从同一源码树读取的 Serve 协议、Runtime Broker 协议、公开 API、Java、Node.js 和 Flyway migration 兼容范围；
- 已接受的单控制面、可信 Linux、嵌入式 Broker 拓扑；
- public Shell 和 v2 advertisement 默认关闭的明确 `false` 值；
- bundle 内的部署与恢复文档路径。

必需产物或兼容性来源缺失、存在歧义时，打包直接失败，不猜测数值，也不发布描述不完整的产物。

## 发布流程

修改分发输入的 pull request 会运行打包单测、构建 Java SDK 和合并后的 Server 模块、组装真实 bundle、核验校验和，并上传为短期 Actions artifact。

手工触发接收 `0.1.0-alpha.1` 一类实验性 SemVer 和 `dry_run` 参数。Dry run 执行相同构建与校验，但不修改 GitHub。非 dry run 只允许从 `main` 执行：先创建不可见的 draft，上传并核对精确资产集合，再在 manifest revision 上原子创建 tag，最后才发布 prerelease。已有 tag 或 release、并发 tag 竞争、上传不完整时都失败关闭。产物永不原地覆盖，不完整的 draft 不会公开。

分发版本与 Maven 组件版本相互独立。Manifest 同时记录两者，从而可以修订实验分发产物，而不伪装嵌入组件的身份发生了变化。

## 部署与升级

运维人员先校验 `SHA256SUMS.txt`，解压产物并读取 `manifest.json`，安装精确兼容的 Qwen CLI/Harness，配置 MySQL 和既有 server 环境，启动 `qwen serve --profile hosted-harness`，再运行 bundle 中的 server 启动脚本。`/actuator/health` 是启动门禁。

在已接受的单控制面拓扑中，升级使用一次停止准入窗口：保留数据库、Runtime credential key 和 durable Runtime state 并完成备份；停止入口流量、server 和 Harness；核验新产物及其兼容性 manifest；启动匹配的 Harness；再启动新 server，由 Flyway 向前迁移。只有健康检查和一个新的无工具 Turn 成功后才恢复流量。数据库不支持降级；发生 migration 后如需回滚，必须在接收新写入前恢复升级前的数据库与状态备份。

## 失败语义

- 组件不匹配、缺失或重复时，打包失败。
- 版本或源码 revision 格式错误时，在 Maven 构建或发布前失败。
- 校验和或 manifest 不匹配时，构建失败并跳过发布。
- 从非 `main` ref 发起生产发布时失败。
- 已存在 tag 或 release、tag 创建竞争或上传不完整时失败关闭；流程永不覆盖，也不公开不完整 draft。
- 缺少兼容性证据时继续阻塞发布，不写入 `unknown` 占位。

## 验证计划

1. 使用合成组件产物运行打包单测并检查解压内容。
2. 构建真实 SDK 和 server JAR，创建 bundle 并核验内外两层校验和。
3. 解压精确压缩包，使用匹配 Hosted Harness 和 MySQL 启动，检查健康状态并完成一个无工具 Session/Turn。
4. 使用同一解压 bundle 重启部署，确认原 Session 仍可读取且后续 Turn 成功。
5. 审查完整分支 diff，执行 ponytail 简化检查，并校验 workflow 语法与受影响的 Java 构建门禁。

## 验收标准

- CI 和手工 dry run 生成同名发布产物且不执行发布。
- Manifest 标识精确源码以及所有声明的兼容边界。
- 使用者无需仓库 checkout 即可核验和解压产物。
- Bundle 中的 server 与 operator-recovery 启动脚本只引用 bundle 内相对文件。
- 精确解压得到的 server 能启动并完成参考 smoke path。
- 生产流程只从 `main` 发布不可覆盖的实验性 prerelease。
- Public Shell 与 v2 advertisement 默认保持关闭。

## 后续工作

合入后的精确 bundle 将用于 public Shell 最终资格验收。容器发布、正式支持、更广拓扑和稳定版晋级均需要独立决策与验收证据。
