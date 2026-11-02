# Managed Runtime Provider 插件

[English](2026-10-31-managed-runtime-provider-plugins.md) | [简体中文](2026-10-31-managed-runtime-provider-plugins.zh-CN.md)

状态：初始 Local/External 设计，已完成本地实现，最终验收待 CI。本次调研基线为 `5f5664e596`，本文记录该初始增量。[后端模块设计](2026-10-31-managed-runtime-backend-modules.zh-CN.md) 已将模块/装配范围扩展到五个后端并修订依赖 SPI，后续以该设计为准。

## 问题与范围

#15871 的 Maven 边界分离了编排和适配器，但服务仍直接创建 Local 和 External 实现。Provider 选择、校验、预检和离线维护仍了解具体实现类。单一 adapters 产物还让只使用一个 provider 的使用方引入无关的 Harness、OSS 和 RocketMQ 依赖。

本次让 Local 和 External 成为可独立使用的插件。服务从已安装的 JAR 发现工厂，只创建配置选中的 provider。兼容现有协议的新 provider 应通过增加 JAR 和配置接入，无需在服务中增加选择分支。现有 SSH 路由、驻留 CSI 装配和 static provider 保留原有路径；它们各自的插件提取留待后续。

本次实现启动时发现和按配置初始化，不实现运行中替换 JAR、自动下载、通用插件框架或首次工具调用才启动 Worker。现有 Session/Turn 预热、协议、HTTP 接口、凭据、数据库结构、持久化 provider kind 和恢复算法继续作为行为依据。

## 模块边界

采用 reactor 下平铺的同级目录，沿用现有构建、缓存和发布惯例。全部产物继承相同父工程版本。

| 模块               | 职责                                                                               | 内部依赖                                                          |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `contracts`        | 现有 Runtime SPI、工厂契约、插件诊断、运维恢复能力和只读配置                       | 无                                                                |
| `runtime-http`     | 现有 Runtime HTTP 传输，包括有界响应读取                                           | `contracts`                                                       |
| `runtime-host`     | Local 与 Workspace 恢复共同使用的原生主机身份和私有 Runtime 状态文件校验           | `contracts`                                                       |
| `runtime-local`    | 本地进程 provider、持久化本地注册表、Local 工厂及注册信息                          | `contracts`、`runtime-http`、`runtime-host`                       |
| `runtime-external` | External scratch/workspace provider、供应服务 HTTP 客户端、External 工厂及注册信息 | `contracts`、`runtime-http`                                       |
| `adapters`         | 其余 Harness、SSH、CSI、static、OSS、MQ、Git 和文件适配器                          | `contracts`、`runtime-http`、`runtime-host`                       |
| `server`           | 发现、按配置选择、公共安全/Workspace 装配和维护入口                                | 现有实现模块及共享适配器；Local/External 为 optional runtime 依赖 |
| `verification`     | 既有和新增测试、独立 classpath、打包和聚合覆盖率                                   | 直接依赖全部生产模块；不发布                                      |

两个共享模块只容纳已经被多处使用的 I/O，不作为通用工具集合。不把 I/O 移入 contracts。Local 和 External Java 类迁入独立 provider 包，包内测试一起迁移。每个生产 package 只有一个产物所有者。server 必须能在编译 classpath 不包含 Local/External 实现类时编译。

## 发现、配置与创建

使用 JDK 服务提供者机制，定义小型 `RuntimeProviderFactory` 契约，由各 JAR 提供注册信息。工厂声明支持的确切持久化 kind，校验配置，返回预检诊断并创建 provider。发现过程只创建轻量工厂，不打开客户端、不探测主机、不创建目录、不启动 Worker，也不分配线程池。

服务注册表拒绝重复 kind，并明确报告已配置但缺失的 provider。选择沿用 `runtime-broker.provisioner`。内置工厂通过只读配置视图保留原配置键和默认值。`runtime-broker.provider-options` 字符串 Map 为插件提供额外配置，避免每增加 provider 都修改服务配置字段。插件自行解释和校验这些值，诊断不得打印秘密。

只有被选中的工厂校验并创建实现。Runtime Broker 未启用时不要求安装任何一个插件。已安装但未选中的 Local 不要求 Node、本地状态目录或主机探测；未选中的 External 不要求供应服务凭据。预检必须能够复用工厂校验，而不创建 provider。

Local 负责启动命令、持久化状态目录检查、托管扩展客户端配置及关闭行为。External 负责端点/客户端配置及既有 scratch/workspace 限制。需要时由服务提供已有 External 存储注册表端口，保留原 JDBC 权威。兼容插件继续使用现有 Runtime HTTP 协议；增加不同执行协议不属于本次范围。

## 生命周期、维护与持久化身份

Broker 继续作为所选 provider 的唯一生命周期所有者，通过原有责任链关闭资源。工厂创建失败时应释放部分创建的资源。SSH 路由继续对每个已选择的 delegate 关闭一次，插件发现不增加第二个关闭责任方。

离线运维恢复和迁移退休通过 Local 工厂创建实现，不再导入 Local 类。限定用途的运维恢复能力承接现有注册校验和停止证明操作。独立的维护创建入口保留不会启动 Worker 的命令以及原状态目录和可信重启配置，维护操作不得转为正常供应。

已保存的 binding kind、资源 handle、身份字节、存储注册、writer/generation 校验和恢复拒绝行为保持。缺失或不匹配的 provider 不得回退到另一实现。发现成功或配置合法不证明 provider 能恢复既有资源，仍由原持久化校验决定。

## 预检与嵌入

Provider 专属校验和诊断由插件拥有。移除预检中拒绝新注册 kind 的白名单。保留公共监听地址、凭据、Workspace 授权和保留策略校验。Provider 声明 Workspace 路径是否位于本机，使预检不要求远端 provider 提供本地目录。

保留现有 External workspace 前置能力警告和 Local 可执行文件/状态目录检查。普通 server 依赖不传递安装 Local/External，嵌入宿主显式选择插件。默认可执行分发通过 optional runtime 依赖包含两者。验证必须让插件类和注册资源真实缺席，不能仅用模拟的 disabled 标志代替。

## 构建、使用方与实施顺序

同时更新 reactor 模块、依赖管理、各模块 Checkstyle/SpotBugs、verification 直接依赖和字节码依赖矩阵。更新固定版本 Maven 缓存的清理/回写列表及对应工作流元测试。保留全部既有 Java profile、聚合覆盖率、可执行/维护 classifier、嵌入夹具及嵌套 JAR 内的服务注册资源。

实施顺序为：定义契约与注册表；提取共享 I/O 和两个 provider；迁移正常创建、预检和维护；更新打包与使用方；验证并评审。插件实现范围与无关的大类清理分开。

## 验证与验收

E2E 计划位于 `.qwen/e2e-tests/runtime-provider-plugins.md`。全局 CLI 用于其能暴露的托管 Worker 基线；工厂加载需要 Java 集成夹具，因为 CLI 不能向服务注入 Java provider。

要求的证据：

- 独立生产编译和字节码检查约束新模块矩阵及唯一 package 归属。
- Provider JAR 可缺省、单独选择，或由使用自有 options 的独立测试 provider 替代。缺失和重复 kind 明确失败；发现及预检不初始化未使用实现。
- 既有 Local/External、路由、配置、预检和维护测试保留行为断言。已选择资源关闭一次，不匹配的持久化身份继续拒绝。
- 真实本地 Worker 及 HTTP External 供应路径保留行为，包括启动和清理。既有 MySQL/Hosted/故障 profile 仍由 CI 完整执行，定向本地证据不能替代它们。
- 可执行/维护产物包含预期 provider JAR 和注册信息；独立嵌入夹具覆盖 optional 依赖；聚合覆盖率纳入新模块。
- 完成工作流/缓存元测试、格式及引用检查、两遍连续干净自审和独立评审。

本地 Java 环境准备、编译、测试及重试共享模块的十分钟预算。记录确切命令、源码状态、结果及未完成门禁，新提交或评审轮次不重置预算。在要求的 CI 门禁通过被验收版本前，最终验收仍待完成。

## 已定决策与后续工作

使用现有可信应用 classpath，插件发现不提供对不可信代码的隔离。内部产物统一版本，保留现有配置兼容性和 Worker 预热行为。动态 JAR 加载和首次工具调用才启动 Worker 仍留待后续。SSH/CSI/Static 拆分已在后续后端增量中实现。本次没有需要用户决策的阻塞项。

全部后端拆分与可选择后端的分发见[后端模块设计](2026-10-31-managed-runtime-backend-modules.zh-CN.md)。其实现现已位于同一工作区。此前 Local/External 定向结果不能证明修订后的 SPI 或产物变体；该修订的验收仍待完成。
