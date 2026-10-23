# 本地运行 Managed Session

[English](managed-local-serve.md) | [简体中文](managed-local-serve.zh-CN.md)

Managed 本地模式使用持久化嵌入式 H2 数据库。本机安装 Java 21 后，首次 Managed
启动会自动下载匹配的 Java 服务 JAR。复用运行本地 Qwen 的 Node、
Hosted Harness、原生 worker 入口和生产 WebShell。用户无需安装 MySQL、Docker、
Maven 或 systemd。可选的预装完整 runtime 包含 Java；默认下载和轻量版要求本机
Java 21。

此模式处于实验阶段，实现支持 arm64、x64 的原生 macOS 和 Linux。各平台分别
记录验收结果；存在打包目标不代表该平台已通过 E2E。Managed runtime archive
需要按下文显式构建；普通 CLI 包不含 Java payload。可选的完整 Managed
standalone archive 则包含所有组件。

## 启动与停止

先使用包含 Managed 本地支持的 Qwen 版本。旧版本需要升级 CLI，仅安装 runtime
不能补上启动器。安装 Java 21，将 `JAVA_HOME` 指向其 home，或将可执行文件放在
PATH 上，然后运行：

```sh
qwen serve --managed --open
```

创建应用数据或启动服务前，Qwen 检查 Java 21，再从官方阿里云 OSS 发行镜像下载
`qwen-managed-agent-server-<cli-version>.jar` 及其校验文件，失败时回退相同 GitHub
Release。校验后将完整 runtime 原子安装到
`<Qwen home>/managed-runtime/<cli-version>/<platform>-<arch>/`。后续启动直接
使用缓存，无需联网。普通 Qwen 命令不会触发下载。只下载服务 JAR，不安装 Java，
也不运行 Maven。匹配版本尚未发布或下载失败时，不创建应用数据或服务子进程。
可以稍后重试，或预装匹配的 runtime。

需要离线使用或附带 Java 时，向发行构建者取得匹配的
`qwen-code-managed-runtime-<platform>-<arch>.tar.gz` 及其 `.sha256` 文件，启动前
校验并解压：

```sh
shasum -a 256 -c qwen-code-managed-runtime-darwin-arm64.tar.gz.sha256
mkdir -p "${QWEN_HOME:-$HOME/.qwen}"
tar -xzf qwen-code-managed-runtime-darwin-arm64.tar.gz -C "${QWEN_HOME:-$HOME/.qwen}"
qwen serve --managed --open
```

archive 安装在 `<Qwen home>/managed-runtime/<cli-version>/<platform>-<arch>/`。
Qwen 自动查找精确匹配其版本和平台的目录。runtime 不再附带另一份 Node、CLI、
Harness、worker 或 WebShell 安装。

需要更小的离线 payload 时，选择 `qwen-code-managed-runtime-lite-<platform>-<arch>.tar.gz`，
按相同方式校验和解压，只包含服务 JAR 和 manifest。请在新的版本/平台目录中
安装其中一种版本，不要把轻量版和带 Java 版叠加解压。轻量启动器在 JAVA_HOME
非空时使用 `JAVA_HOME/bin/java`，否则选择 PATH 中第一个可执行的 `java`。要求
版本恰为 Java 21，在创建应用状态前检查实际可执行文件。JAVA_HOME 配置错误时
直接报错，即使 PATH 中有另一份可用 Java。例如：

```sh
JAVA_HOME=/absolute/java-21-home qwen serve --managed --open
```

macOS 的 JAVA_HOME 通常以 `Contents/Home` 结尾。Java 缺失或版本不兼容时，在下载
JAR 前提示安装/配置错误，Qwen 不会下载 Java。带 Java 版始终使用自己的 Java，payload
损坏时不会回退本机 Java。

也可使用完整 `qwen-code-managed-local-<platform>-<arch>.tar.gz`，解压后运行
`./qwen-code/bin/qwen serve --managed --open`。

应用监听 `127.0.0.1:4170`。可以用 `--port 0` 选择空闲端口，或指定固定端口。
保持终端打开；Ctrl+C 会关闭普通 daemon、Java 服务和 Harness。运维部署可以自行使用
systemd，此命令不依赖它。
公开端口被占用时沿用普通 daemon 在相邻端口上的有界重试，请使用启动器实际打印的
浏览器地址。

这一条命令同时启动普通 daemon 与 Managed Agent。同一个 WebShell 使用已有的
统一的项目导航同时显示普通与托管工作区及其会话，托管工作区带有标识，不再提供执行方式 tab。“新建任务”跟随所选工作区或当前会话。Local 会话使用命令启动目录，Managed 会话使用应用创建的
Workspace 或显式导入的本机项目。两者共享一个需要认证的浏览器 origin，无需再启动 daemon 命令或打开
第二个页面。

在“添加工作区”中，提交前可选择“本地（daemon）”或“托管（Managed Agent）”，
默认跟随当前会话所属服务。工作区行与“新建任务”显示该服务，新任务继承所选
工作区。daemon 已有的 SSH 工作区支持仍然可用；Managed SSH 登记尚未接入此
统一弹窗。

终端会打印带 token fragment 的浏览器地址，请把它当作本地密码。浏览器为每次
API 请求携带 token，Java 签名密钥和内部凭据不会传给浏览器。监听仅限 loopback。
无图形界面时省略 `--open`，在该机器打开打印的地址，或自行使用认证隧道。

融合应用当前支持本机 loopback 页面。完整界面已有的 Mobile access / Local Control
入口尚未接入 Managed boot，配对的 LAN 监听无法打开此融合页面。移动端共享需要
后续单独接入；普通 daemon 继续保留既有 Local Control 行为。

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
使用已有本机项目时，打开“工作区 → 选择已有目录”，浏览或输入绝对路径后添加
文件夹。服务会自动登记项目父目录并授予 OWNER 权限，已有文件保留原处，
新任务从所选项目启动。也可创建空 Workspace。

启动目录仍供 Local 会话使用，不会自动导入。Managed 本地模式继续拒绝
`--workspace`，请从界面选择项目。`.qwen-managed-storage.json` 维护标记保留在
Git 工作树之外，不要编辑、删除、stash 或提交。导入的项目文件位于私有 Managed
数据目录之外，需要单独备份。

Local 会话历史继续使用普通 Qwen 存储，与 Managed 数据目录独立，仅备份 Managed
目录不会包含 Local 会话历史。

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
选中的 payload 无效或不完整时不会改用另一份。显式选中的 payload 缺失，或 CLI
版本、平台、Java 主版本、服务校验和不匹配时，都会在启动子进程前失败。仅默认
缓存缺失会触发 JAR 安装；已有损坏 payload 不会被替换。应用启动时绝不执行 Maven。

## 发布首次使用的 JAR

`Release Managed server runtime` workflow 从已公开的 CLI release tag 构建，使用
相同源码修订的 SDK 和服务。手动运行必须从 `main` 发起，默认是 dry-run。它验证
CLI 和 Java 模块，构建 `central-release` profile，并将 JAR 与校验文件保留为
workflow artifact，不修改公开仓库。

验证 dry-run 后，发行运维可通过受保护的 `production-release` environment，用
相同 tag 和 `dry_run=false` 运行。workflow 将服务制品版本设为 CLI 版本，向
Maven Central 发布 `com.alibaba:qwen-managed-agent-server:<cli-version>` 及源码、
Javadoc 和签名，再将相同主 JAR 及其 `.sha256` 分发到该 GitHub Release 和现有的
版本化 OSS 镜像。辅助运维 JAR 不附加到 Central 发布。已有产物逐字节比较，绝不
用不同内容替换。公开的 CLI release 事件也会自动运行该 workflow。

CLI 从 OSS/GitHub 下载，不从 Maven Central 下载，也不要求用户单独解析 SDK：
可执行服务 JAR 包含其 Java 依赖。精确匹配 CLI release 的 runtime 产物必须已存在，
首次下载才能成功。本 PR 的本地验证不会发布这些产物，也不会绕过生产发行环境。

所有权边界和验收条件见双语[设计文档](../design/2026-10-20-managed-local-serve.zh-CN.md)，
面向运维的 MySQL 部署见 [Java 服务参考](../../packages/managed-agent-server/README.md)。
