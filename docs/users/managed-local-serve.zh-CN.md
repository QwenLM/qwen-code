# 本地运行 Managed Session

[English](managed-local-serve.md) | [简体中文](managed-local-serve.zh-CN.md)

Managed 本地模式使用持久化嵌入式 H2 数据库。在普通 Qwen 安装之外，另装匹配的
managed-runtime archive，提供 Java 控制面，可选附带 Java 21。复用运行本地 Qwen 的 Node、
Hosted Harness、原生 worker 入口和生产 WebShell。用户无需安装 MySQL、Docker、
Maven 或 systemd。带 Java 的 runtime 无需预装 Java；轻量版要求本机已安装 Java 21。

此模式处于实验阶段，实现支持 arm64、x64 的原生 macOS 和 Linux。各平台分别
记录验收结果；存在打包目标不代表该平台已通过 E2E。Managed runtime archive
需要按下文显式构建；普通 CLI 包不含 Java payload。可选的完整 Managed
standalone archive 则包含所有组件。

## 启动与停止

先使用包含 Managed 本地支持的 Qwen 版本。旧版本需要升级 CLI，仅安装 runtime
不能补上启动器。下载匹配的 `qwen-code-managed-runtime-<platform>-<arch>.tar.gz`
及其 `.sha256` 文件，校验后解压到 Qwen home：

```sh
shasum -a 256 -c qwen-code-managed-runtime-darwin-arm64.tar.gz.sha256
mkdir -p "${QWEN_HOME:-$HOME/.qwen}"
tar -xzf qwen-code-managed-runtime-darwin-arm64.tar.gz -C "${QWEN_HOME:-$HOME/.qwen}"
qwen serve --managed --open
```

archive 安装在 `<Qwen home>/managed-runtime/<cli-version>/<platform>-<arch>/`。
Qwen 自动查找精确匹配其版本和平台的目录。runtime 不再附带另一份 Node、CLI、
Harness、worker 或 WebShell 安装。

需要更小的下载时，选择 `qwen-code-managed-runtime-lite-<platform>-<arch>.tar.gz`，
按相同方式校验和解压，只包含服务 JAR 和 manifest。请在新的版本/平台目录中
安装其中一种版本，不要把轻量版和带 Java 版叠加解压。轻量启动器在 JAVA_HOME
非空时使用 `JAVA_HOME/bin/java`，否则选择 PATH 中第一个可执行的 `java`。要求
版本恰为 Java 21，在创建应用状态前检查实际可执行文件。JAVA_HOME 配置错误时
直接报错，即使 PATH 中有另一份可用 Java。例如：

```sh
JAVA_HOME=/absolute/java-21-home qwen serve --managed --open
```

macOS 的 JAVA_HOME 通常以 `Contents/Home` 结尾。Java 缺失或版本不兼容时会提示
安装/配置错误，Qwen 不会自动下载。带 Java 版始终使用自己的 Java，payload
损坏时不会回退本机 Java。

也可使用完整 `qwen-code-managed-local-<platform>-<arch>.tar.gz`，解压后运行
`./qwen-code/bin/qwen serve --managed --open`。

应用监听 `127.0.0.1:4170`。可以用 `--port 0` 选择空闲端口，或指定固定端口。
保持终端打开；Ctrl+C 会关闭前门、Java 服务和 Harness。运维部署可以自行使用
systemd，此命令不依赖它。

终端会打印带 token fragment 的浏览器地址，请把它当作本地密码。浏览器为每次
API 请求携带 token，Java 签名密钥和内部凭据不会传给浏览器。监听仅限 loopback。
无图形界面时省略 `--open`，在该机器打开打印的地址，或自行使用认证隧道。

Harness 使用正常的 Qwen 模型配置与 provider 凭据。第一次发送 prompt 前，按
普通 Qwen CLI 流程配置模型。文件和 Shell 使用 `default` 审批模式，需要审批的
操作会在 Managed UI 中等待批准。

重启后继续已有 Session 时，可能需要等待原 SQL writer 租约到期（默认 60 秒）。
保留原数据目录，等待后重试；重启进程不会清除所有权。

## Workspace 与持久数据

私有数据目录默认是 `<Qwen home>/managed-local`，通常为
`~/.qwen/managed-local`。可以覆盖：

```sh
qwen serve --managed --managed-data-dir /absolute/private/data --open
```

目录必须位于所有 Git 工作树外，每次只允许一个启动器使用，Java 还会持有独占
数据库文件锁。私有服务端口和凭据跨重启保持稳定。私有端口被其他应用占用时会
拒绝启动；应使用新的数据目录或停止冲突服务，不要直接修改持久事实。

启动通过现有幂等 Workspace API 创建应用管理的默认 Workspace 和 OWNER 授权。
Managed UI 可以创建更多 Workspace 和选择项目子目录。命令不会导入其启动目录。
Managed 本地模式拒绝 `--workspace`，接入外部已有 Git 工作树需要独立注册流程。
请把项目放在创建的 Workspace 的子目录，使 `.qwen-managed-storage.json` 维护
标记始终位于 Git 工作树外。不要编辑、删除、stash 或提交该标记。

请整体保存数据目录，包括 `state.json`、`database/`、`runtime/`、`worker-home/`
和 `workspaces/`。文件系统备份前先完成或取消活动工作、关闭相关 Session，再
停止应用。原持久 worker 可以在控制面退出后继续存在，需要确认所有 Workspace
写入者已停止。执行结果未知时，离线备份前应先完成现有原所有者恢复流程。
凭据、数据库、worker 历史和 Workspace 身份属于同一次安装，仅恢复部分数据可能
导致恢复接入关闭。启动不会
重建丢失标记或替换损坏凭据，服务诊断日志位于 `logs/`。

macOS 支持原生 worker 和同一次系统启动内的持久接管。本地启动器仍禁用可信
整机重启恢复。未知工具结果沿用原所有者恢复规则，不会盲目重放。此模式不增加
登录时自动启动或阻止笔记本睡眠的功能。

## 构建发行包

以下命令面向发行构建者，最终用户不需要执行。使用 Node 22+、Java 21、Maven
3.8.9+ 从同一份源码构建 CLI 和 Java 服务：

```sh
corepack pnpm install --frozen-lockfile
npm run build
npm run typecheck
npm run bundle
npm run prepare:package
mvn -f packages/sdk-java/qwencode/pom.xml -DskipTests -Dgpg.skip=true install
mvn -f packages/managed-agent-server/pom.xml verify
npm run package:managed-runtime -- \
  --target darwin-arm64 \
  --server-jar packages/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  --jre-home /verified/java-21-home \
  --out-dir /output/managed-runtime
```

runtime 构建器只要求匹配的服务 JAR、Java runtime 和本 checkout 中的 CLI 版本，
不依赖编译好的 CLI 资源或 Node archive。默认输出到
`packages/managed-agent-server/target/managed-runtime`，位于 CLI 的 `dist/` 资源树
之外。输出 runtime archive 及单独的 `.sha256`
文件。普通 CLI 独立构建和发行。

构建轻量 runtime 时，使用相同的服务 JAR，以 `--without-jre` 替代 `--jre-home`：

```sh
npm run package:managed-runtime -- \
  --target darwin-arm64 \
  --server-jar packages/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  --without-jre \
  --out-dir /output/managed-runtime
```

输出 `qwen-code-managed-runtime-lite-darwin-arm64.tar.gz` 及其校验和，轻量构建器不
需要 Java 输入。也可构建可选的完整发行包：

```sh
npm run package:standalone -- \
  --target darwin-arm64 \
  --node-archive /verified/node-v22-darwin-arm64.tar.gz \
  --managed-server-jar packages/managed-agent-server/target/qwen-managed-agent-server-0.1.0-alpha.jar \
  --managed-jre-home /verified/java-21-home \
  --out-dir /output/managed-local
```

传入完整解压的 runtime home，包含 `bin/java`、`lib/modules`、`release` 和
`legal/`。macOS JRE 可能将它放在 `Contents/Home`。构建器检查 Java 主版本、
操作系统与架构，保留许可证，在 payload manifest 记录服务 SHA-256 和匹配的
CLI 版本。完整 standalone 使用 `lib/managed-runtime/` 并输出 `SHA256SUMS`。
构建前应校验 runtime 输入的发行方校验和。拒绝 Windows 和 Bun Managed 执行，
启动器要求 Node 22+。

需要显式选择 runtime 位置时，可设置
`QWEN_MANAGED_LOCAL_RUNTIME_DIR=/absolute/managed-runtime`，让本地 CLI 使用
直接包含 `manifest.json`、`server.jar`（带 Java 版还有 `jre/`）的目录。它优先于相邻 payload 和
Qwen home 下的版本化安装。存在相邻 payload 时，它优先于 Qwen home 安装。
选中的 payload 无效或不完整时不会改用另一份。缺少 payload、CLI 版本、平台、
Java 主版本或服务校验和不匹配，
都会在启动子进程前失败。应用启动时不执行 Maven，也不联网下载 runtime。

所有权边界和验收条件见双语[设计文档](../design/2026-10-20-managed-local-serve.zh-CN.md)，
面向运维的 MySQL 部署见 [Java 服务参考](../../packages/managed-agent-server/README.md)。
