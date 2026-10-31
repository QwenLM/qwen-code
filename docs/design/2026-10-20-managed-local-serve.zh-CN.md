# Managed 本地一键启动

[English](2026-10-20-managed-local-serve.md) | [简体中文](2026-10-20-managed-local-serve.zh-CN.md)

状态：本地 serve、首次 JAR 下载与发行集成已实现；生产发布待执行。日期：2026-10-21。

## 问题与现状

Hosted Managed Session 已有 Java 控制面、内嵌 Runtime Broker、私有 Node Hosted
Harness 和原生本地工具 worker。参考部署需要单独配置 MySQL、Harness、凭据和生产
WebShell 接线；开发启动器依赖源码、Maven 和 Vite。两者都不是用户可以一条命令
启动的本地应用。

H2 MySQL 模式已在测试中运行规范 Flyway schema 和 JDBC store。原生 worker 支持
Linux 和 macOS；macOS 支持同一次系统启动内接管，不支持可信整机重启恢复。
systemd 是可选的运维部署选择。

## 目标与范围

Managed 本地模式运行 `qwen serve --managed --open`，无需 MySQL、Docker、
systemd、Maven 或源码。默认首次安装仅下载匹配的服务 JAR，要求本机 Java 21。
独立安装的 managed-runtime archive 可同时提供匹配的 Java 服务 JAR 和
Java 21 runtime，复用本地安装的 Qwen CLI、它的 Node 进程、
Hosted Harness、原生 worker 入口及编译好的 WebShell。可选的完整 standalone
发行包包含所有组件。轻量 archive 不带 Java，要求本机已安装 Java 21。
首批目标为 x64、arm64 的原生 Linux 和 macOS；本次不交付
Windows 和 Bun。

这是单个可信用户使用的 loopback 应用，每个私有数据目录只有一个 Java 控制面。
保留 SQL 所有权、租约、fencing、幂等、原 Runtime 路由和未知结果语义。MySQL
参考部署沿用现有默认配置。公网多用户托管、HA、SSH/Kubernetes 配置和恢复事实
自动修复不在范围内。

初始 Workspace 由应用管理。用户可通过“工作区 → 选择已有目录”按绝对路径
显式导入已有本机项目。启动器在回环签名认证下启用已有的[本机目录导入](2026-10-21-managed-local-directory-import.zh-CN.md)
能力，沿用存储登记、OWNER 授权、物理身份校验和恢复流程。文件保留原处，
维护标记位于 Git 工作树之外。启动目录不会自动导入。

## 组件方案

| 组件                           | 职责                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| CLI Managed 启动器             | 解析发行 runtime、锁定私有数据、保留密钥、启动与监督子进程、等待就绪、通过现有 API 初始化并提供浏览器地址 |
| `managed-local` Spring profile | 持久化嵌入式 H2、loopback 与私有目录校验、规范迁移、本地进程配置                                          |
| 普通 daemon 前门               | 托管发行静态资源与普通 daemon API/传输、认证浏览器、以服务端签名身份代理 Java WebShell API                |
| 融合 standalone WebShell       | 读取认证后的启动选项、创建现有 Java provider、在当前 origin 使用共享工作区与会话导航                      |
| Managed 发行构建器             | 独立打包 JAR 和 JRE，或将其加入完整 standalone 包；记录版本与校验和，保留 runtime 许可证                  |

### 启动与持久化

`--managed` 是延迟加载、显式启用的应用启动器。同时启动普通 daemon、Java 和私有
Harness，拒绝冲突的执行 profile 或参数。普通 daemon 拥有公开的 loopback 监听，
始终要求 bearer token。参见[融合 WebShell 设计](2026-10-21-managed-daemon-web-shell.zh-CN.md)。
`--port`、`--open`、`--open-with-auth` 沿用现有含义。
`--managed-data-dir` 可指定私有状态目录，默认位于用户 Qwen home 下。相同目录的
并发启动器会拒绝进入。

私有目录包含稳定安装身份、分别独立的公开入口、Harness、Broker、签名、writer
binding、Runtime credential 密钥，以及文件数据库、Runtime 状态、持久 worker
文件历史、应用管理的 Workspace 创建根目录和服务日志。目录仅所有者可访问，
凭据文件仅所有者可读写。启动不轮换凭据、不删除持久事实；损坏或不完整的凭据
文件会拒绝启动。密钥不出现在进程命令参数或浏览器启动选项中。

使用 loopback 监听启动私有 Hosted Harness 和 Java 进程。当前 Qwen 进程将其规范
CLI 入口和 Node 可执行文件传给 Harness 与 worker，不通过 PATH 寻找另一份 CLI。
runtime archive 必须与该 CLI 版本精确匹配。Harness 使用用户正常的 Qwen 模型
配置；worker 仅执行工具。文件与 Shell
沿用现有 `default` 审批模式。显式开启已有的 `hosted-workspace-shell/1` 生命周期
profile，并在 Harness 认证 capability 检查中要求它存在，使 Session 关闭能够结算
Shell 资源。Java readiness 和这些 capability 检查成功后才开放公开前门。
内置 `qwen-code` agent 使用用户配置的模型。通过现有签名
API，以稳定幂等键创建默认 Workspace。重试重放原 receipt，不生成替代身份。
私有旧式 Workspace ID 沿用规范目录的既有哈希规则，应用管理的 Workspace ID
则由现有 API 生成。

H2 使用私有文件数据库和 MySQL 模式，启用 `DATABASE_TO_LOWER=TRUE`、
`DB_CLOSE_ON_EXIT=FALSE`、`WRITE_DELAY=0`。不启用 TCP、`AUTO_SERVER` 或 Web
console。H2 文件锁提供额外的单控制面保护。保留现有全新 catalog、Flyway 和共享
schema 校验，继续拒绝外来、部分、仅历史表或不支持的 catalog。现有 resource kind
名称是持久协议标识，inline bytes 存入 H2 时也保留名称。

控制面修改先锁定 Session 行，再通过独立的锁定查询读取其事件流计数。H2 外连接
在等待锁之后可能只刷新 Session 行，仍保留等待前的旧计数。重新读取事件流使事件
分配和修改尝试边界保持最新，任何 batch 都不得回退已提交的事件流计数。

### 浏览器与 API 所有权

服务端在 HTML 放入公开的 Managed 模式标记。浏览器从认证后的
`GET /managed/boot` 获取 `mode`、`productScope`、`agentId` 和 Workspace 绑定
选项，不包含 tenant、actor、私有 endpoint 或密钥。Managed 模式忽略 `?daemon=`
和 fanout 目标，provider 固定使用页面 origin。

`GET /capabilities` 是认证后的进程级浏览器认证探针，返回普通 daemon 的真实能力
与 Workspace。认证 boot 创建 Java provider，传给正常 standalone WebShell 已有
的共享项目导航，不再提供执行方式 tab。Local 会话使用启动目录，这不代表把该目录导入 Managed
存储。
代理 API 面限于 `/api/agent/web-shell/v1/**`，以及精确的附件内容 GET/HEAD 路径
`/v1/agents/sessions/:sessionId/artifacts/:artifactId/content`，后者是现有 Java
client 所需路径。前门清除调用者身份和私有认证头，
使用服务端固定 tenant、actor 对经过大小限制的原始请求字节签名。持久 Workspace
和实时 Session 授权继续由 Java 校验。SSE 流式转发、保留背压，客户端断连即中止
上游。前门不暴露内部 writer、Runtime Broker、维护接口或其他 Java 路由。

### 生命周期与故障

启动器仅跟踪自己创建的子进程并独占进程信号，禁用内嵌 daemon 的信号处理。
SIGINT/SIGTERM 关闭 daemon 与传输、停止新接入，然后在
有界等待内优雅停止 Java 和 Harness。两个子进程分别使用独立进程组，使终端信号
先由启动器处理。强制停止仅针对 Java 进程和 Harness 进程组，持久 worker 保留
既有所有权。公开监听绑定后再次检查子进程失败和中断，确认后才报告启动成功。
启动失败会清理已创建子进程并释放锁，不
删除无关进程或私有数据。子进程意外退出时关闭应用并返回非零状态。不盲目重启或
重放未知副作用。原持久 worker 和 SQL 恢复保留既有所有权规则。macOS 显式禁用
可信整机重启恢复。

重启后的 Session 可能需要等待原 SQL writer 租约到期（默认 60 秒）；进程退出
不会释放或缩短租约。存储标记缺失时，仍可启动 UI 和重放原 Workspace 创建
receipt；受影响的绑定工具 Turn 会在 Runtime 接入时返回 `workspace_unavailable`，
不会重建标记或改去其他位置执行工具。

本次不承诺阻止笔记本睡眠或登录时自动启动。普通前台使用只需保持终端打开，
运维之后可自行选择服务管理器。

### 发行与 runtime 定位

独立 `qwen-code-managed-runtime-<target>.tar.gz` 仅包含
`managed-runtime/<cli-version>/<target>/manifest.json`、`server.jar` 和 `jre/`。
保留 Java 许可证，不包含 Node、CLI、Hosted Harness、worker 副本或 WebShell
资源。用户将其解压到 Qwen home，本地 `qwen serve --managed --open` 自动发现
精确匹配的版本和平台目录。模型仍通过已安装的 CLI 配置。

轻量 `qwen-code-managed-runtime-lite-<target>.tar.gz` 只包含相同的
`manifest.json` 和 `server.jar`。构建时显式选择 `--without-jre`，与
`--jre-home` 互斥。安装到相同的版本/平台目录，用户选择其中一种版本，不叠加解压。
manifest 用 `javaSource: system` 表示轻量发行，`javaSource: bundled` 表示带 Java
发行。旧 manifest 缺少此字段时仍按内置 Java 处理，未知值拒绝启动。

轻量发行在 `JAVA_HOME` 非空时只使用其 `bin/java`；否则解析 PATH 中第一个可执行
`java` 的规范路径。用有时间和输出上限的 Java 属性/版本命令探测该可执行文件，
要求 `java.specification.version=21`，然后才创建应用状态或服务子进程。Java
缺失、无法执行或不兼容时给出可操作的错误。不自动安装、下载或寻找另一个 Java
版本。带 Java 发行仍要求自身 runtime，JRE 缺失或损坏绝不回退本机 Java。服务
启动使用已验证的同一可执行文件。

manifest 绑定 CLI 版本、目标平台、Java 来源、Java 主版本和服务摘要。显式设置
`QWEN_MANAGED_LOCAL_RUNTIME_DIR` 时仅选择该 payload。否则优先使用存在的相邻
`managed-runtime` 目录；相邻目录缺失时才查找 Qwen home 下的版本化安装。选中的
payload 损坏或不完整会拒绝启动，不尝试其他位置。在创建私有状态或子进程前完成
兼容性校验。不包含该启动器的旧 Qwen 版本需要先升级 CLI；仅安装 runtime 不能
补上缺失的 CLI 行为。

现有完整 Managed standalone 构建器保留可选 JAR/JRE 输入和
`lib/managed-runtime/` 布局。两个构建器共用 payload 复制和校验逻辑。独立
runtime 构建不要求编译好的 CLI 资源或 Node archive，默认将 archive 输出到 CLI
资源树之外。缺失 payload 的错误会说明
期望的版本、平台和安装位置。既无选中的 payload、也无版本化缓存时，启动器会先
验证本机 Java 21，再安装匹配的服务 JAR。离线用户可预装任意一种 archive，或选择
显式 runtime 目录。发布 archive 或 npm 包仍是
独立发行操作。

### 首次下载与发布

普通 CLI 包不包含 Java payload。仅 `qwen serve --managed` 会下载缺失的默认
runtime。版本化发行产物为 `qwen-managed-agent-server-<cli-version>.jar` 及匹配的
`.sha256` 文件。安装器优先使用现有官方阿里云 OSS 发行前缀，再尝试相同 GitHub
Release tag。不选择 `latest`，不解析 Maven 依赖，也不下载 Java。两个下载源都必须
提供精确匹配 CLI 版本的产物。

按版本和平台设置安装锁，在多个进程间串行化下载。安装器将内容流式写入私有的
临时相邻目录，限制下载时间与大小，校验 JAR SHA-256 和 ZIP 文件头，写入现有的
`javaSource: system` manifest，再原子重命名到缓存。下载失败或被中断不会发布部分
runtime，后续调用可以重试。已有显式、相邻或已安装的 payload 仍是权威来源：
内容无效时拒绝启动，不静默替换或触发下载。缓存启动无需联网。安装发生在创建
应用凭据、数据或服务子进程之前。

独立的受保护发行 workflow 从已存在的 CLI release tag 构建，检查 package 版本，
并使用 Java 21 验证 Java SDK 和服务。完整验证通过后，可执行服务 JAR 和校验文件
附加到 CLI GitHub Release，再复制到现有版本化 OSS 前缀，位于 standalone archive
允许列表之外。workflow 优先选择 `-exec.jar` 构建产物，对旧 tag 回退到主 JAR；
公开的版本化 JAR 名称保持不变。workflow 将两个公开渠道的制品与暂存字节核对。runtime 分发不探测
服务坐标在 Maven Central 上是否存在，不向 Central 发布或等待该发布完成。Central
发布授权与制品同步状态不再阻塞安装器实际使用的渠道交付。分发需要 OSS 凭据和
GitHub release 权限，无需加载 Central 发布凭据或 GPG 私钥。

Java 编译与正常 Maven 依赖解析、完整 SDK/server 验证、测试 fork 隔离和现有
`central-release` 构建 profile 保持不变。验证时跳过 GPG 签名；该 profile 在 Maven deploy 阶段之前不会
执行发布。需要服务于 Maven 使用者时，仍可通过该 profile 独立签名发布
`com.alibaba:qwen-managed-agent-server:<cli-version>`，包含源码和 Javadoc，
排除辅助运维 JAR。该操作与 runtime 分发独立，分发 workflow 不依赖它。

可重现时间戳和校验和比较防止重试时用不同字节
替换已有版本。dry-run 只构建和验证，不发布。生产凭据与发布操作继续受现有
`production-release` environment 保护。

Maven Central 用于 Java 制品发布，不作为 CLI 启动下载依赖。按照 [Sonatype 对
runtime 制品的指导](https://central.sonatype.org/faq/429-operational-dependencies/)，发行下载使用项目自身的 OSS/GitHub 渠道。新 CLI 版本必须先
发布匹配的 runtime 产物，其 Managed 首次使用流程才能成功；发行产物不可用时，
错误说明所需版本，并保留离线安装方式。

## 影响文件

- `packages/cli/src/serve/managed-local-download.ts` 及定向安装测试；`.github/workflows/release-managed-runtime.yml`、`scripts/managed-runtime-release.js` 及发布契约测试。
- `packages/cli/src/commands/serve.ts`、新的本地 Managed 启动器/前门模块及定向测试。
- `packages/cli/src/serve/web-shell-static.ts` 及相关测试。
- `packages/web-shell/client/main.tsx`、Managed 独立启动组件及测试。
- `packages/managed-agent-server/pom.xml`、本地 Spring profile/配置、Session 事件流的最新锁定读取，以及文件数据库/并发测试。
- `scripts/create-standalone-package.js`、独立 runtime 构建器、Managed 打包辅助模块/测试和双语使用文档。

## 验证与验收

修改前用全局 `qwen` 记录基线。实现后验证本地 bundle，包括源码仓库外的发行布局。
验收覆盖参数处理、缺失/不兼容 runtime 拒绝、同目录互斥、凭据权限和持久化、私有
监听认证、生产 UI 启动、Workspace 创建、一次真实本地 worker 文件/Shell Turn
与同 Session 第二轮、优雅重启后的历史保留，以及故障清理。无 provider 凭据时
使用确定性模型 fixture，并明确标注证据范围。

运行定向 CLI/WebShell 测试、根目录 build/typecheck/bundle、Java `mvn verify`，
以及文件 H2 重启、锁、回滚和 schema 拒绝测试。可用时保留 MySQL integration
回归验证，不以 H2 结果代替 MySQL 验证。Linux/macOS 分别验收；当前机器只验证
其原生目标。实际结果和限制记录在 E2E 计划中。

拆分发行需验证不依赖 Node 或 CLI 构建输入的 archive 内容与校验和、隔离 Qwen
home 下的自动发现、显式与相邻 payload 的优先级，以及选中无效 payload 时在创建
状态或子进程前拒绝。使用源码树外安装的普通 Qwen 运行真实原生 worker Session，
证明 Java 来自独立 runtime，而 Harness、worker 和 WebShell 使用该本地 Qwen。
验证等待已有事件提交的 Harness batch 不会重用或回退事件序号，分别覆盖有、无公开
投影的 batch，并对共用锁定读取改动保留 MySQL store 回归验证。

轻量发行需验证 archive 只有 JAR 和 manifest、JAVA_HOME 与 PATH 两种定位方式、
Java 缺失/版本错误在应用状态创建前拒绝，以及带 Java payload 损坏时不回退本机
Java。用外部 Java 21 重跑已安装 CLI 的生命周期测试，测量实际 archive/payload
字节并与带 Java runtime 对比。现有 Java 服务行为不变。

独立 runtime 已使用源码树外安装的普通 npm CLI 0.25.3 和现有 Node 22.14.0 通过
上述生命周期验收。Qwen home 自动发现和选中无效 payload 时拒绝均通过。进程路径
确认 Java 来自独立 runtime，Harness 与 worker 使用该 Node 和 npm CLI；托管的
WebShell 字节与 npm 安装一致。Session/事件流锁定读取改动的 H2 与 MySQL 8.4
并发回归也已通过。

macOS arm64 archive 已在源码树外、PATH 中无 Java 的条件下通过完整本地生命周期
验收：文件和 Shell 审批、流式响应、后续轮次、重启后的上下文保留、取消、Session
关闭、子进程故障清理和存储标记缺失拒绝。浏览器检查确认生产 Managed UI 启动和
同源路由。模型使用确定性 OpenAI 兼容 fixture，工具由真实原生 worker 执行。
真实 provider 推理和其他平台目标尚未验收。

轻量 macOS arm64 archive 使用外部 Java 21 和相同确定性模型 fixture，通过已安装
CLI 的生命周期验收。十五项选择检查通过，包括 JAVA_HOME/PATH 正向、Java 缺失或
版本错误拒绝、保留已有状态，以及损坏的带 Java 或旧 payload 不回退系统 Java。
普通 npm 包不含 JAR 或 JRE。轻量 archive 压缩后为 78,299,321 字节，payload 文件
合计 86,278,025 字节；带 Java runtime 分别为 278,836,538 和 437,061,513 字节。
本次复用此前验证的服务 JAR，没有改动 Java 源码。

在原始本地交付试验中，根目录 build/typecheck/bundle、定向 CLI/WebShell/打包测试、
持久 H2 测试、Java 单元测试和 SpotBugs 通过。该次完整 Maven 验证被原始基线中
未修改文件的两项 MySQL 集成断言和六项 Checkstyle 问题阻塞。这些基线失败仍与
本地验收分别记录，不代表当前 main 分支状态。上述结果属于拆分前试验；当前
拆分 head 的验证和限制记录在 PR 测试报告中。

首次下载路径使用真实 Java 21 服务与 Hosted Harness，通过十四项 built-bundle 场景：首次安装、离线重启、OSS 转 GitHub 回退、中断下载后重试，以及无效下载和选中 payload 拒绝。测试在精确生产 URL 处拦截 transport，提供本地构建的 JAR；公开生产产物尚未发布或验证。发布 profile 已在本地构建主可执行 JAR、源码与 Javadoc。runtime 分发改动仍需受保护的 GitHub/OSS 生产发行及空缓存首装验收；Central 签名发布独立进行。

## 未决问题

本次交付无阻塞设计决策。后续发行自动化可在构建时下载并验证 JRE archive。
本机项目导入复用已有的显式登记流程，启动时不会未经用户选择自动导入项目。
