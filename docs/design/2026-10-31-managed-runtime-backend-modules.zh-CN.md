# Managed Runtime 后端模块

[English](2026-10-31-managed-runtime-backend-modules.md) | [简体中文](2026-10-31-managed-runtime-backend-modules.zh-CN.md)

状态：已实现，Java 验收待完成。基于 main `73474ef094ea1c6bb2a95a9a2a33a28b0ec58e9e`，包含其中的 Store 构造注入改动。2026-11-02 将范围收敛为可独立引用的 Maven 后端及其装配。既有共享本地 Java 验证预算已消耗 599.048/600 秒；此前 Local/External 结果不能证明修订后的 SPI 和模块图正确。

## 目标与边界

#15871 之后，后端实现仍共用 adapters 产物，server 装配直接构造实现，SSH 还依赖 Local provider。将 Local、SSH、Kubernetes、External 和 Static 拆为独立 Maven 产物，使其他服务能引用 server 并显式安装所需后端。保留默认完整可执行包和运维分发。

后端是否可用由应用可信 classpath 决定，启用哪个后端由现有配置决定。不引入实时 JAR 加载、自动下载或不可信插件隔离。选择性独立构建、变体归档、部署示例及其 CI 矩阵后置。Kubernetes scratch、Session/Turn 预热调整，以及进一步裁剪数据库/Harness/消息依赖不在本次范围内。

## 模块边界

模块保持为同级 reactor 子模块，统一父版本和发布流程。每个生产 Java package 只有一个产物所有者；包私有测试随实现移动。

| 模块                 | 职责                                                   | 内部依赖                                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------- |
| `contracts`          | Runtime 配置、身份及构造/访问接口                      | 无                                          |
| `runtime-local`      | 本地 Worker、持久状态、工厂及离线恢复                  | `contracts`、`runtime-http`、`runtime-host` |
| `runtime-ssh`        | SSH Worker、连接/隧道及工厂                            | `contracts`、`runtime-http`、`runtime-host` |
| `runtime-kubernetes` | Kubernetes 客户端、常驻/CSI 供给、保护及回收           | `contracts`、`runtime-http`                 |
| `runtime-external`   | 外部 Runtime 客户端、scratch/workspace provider 及工厂 | `contracts`、`runtime-http`                 |
| `runtime-static`     | 预配置 endpoint/lease 及工厂                           | `contracts`                                 |
| `runtime-http`       | 公共 HTTP transport                                    | `contracts`                                 |
| `runtime-host`       | 共享进程/文件交换及主机身份/状态工具                   | `contracts`                                 |
| `runtime-broker`     | lease/执行协调及与具体后端无关的路由                   | `contracts`                                 |
| `adapters`           | Harness、文件系统及其他非 provider 适配器              | 共享模块；不含后端实现                      |
| `server`             | 选择、SQL 权威装配、HTTP 及运维入口                    | 应用/共享模块；五个 optional runtime 后端   |
| `verification`       | 测试及独立 classpath/嵌入夹具；不发布                  | 全部生产模块                                |

五个后端互不依赖。路由属于 `runtime-broker`；Local 与 SSH 共用的进程/文件交换属于 `runtime-host`，不会安装 Local provider。SQL 存储、预留事务、退休授权及共享 CSI application-store 装配保留在原层。Kubernetes Harness 发现仍是独立的 Harness 职责。新模块直接声明使用的库，并接入既有编译、架构、Checkstyle、SpotBugs、源码/Javadoc 及聚合覆盖率检查。

## 工厂与依赖契约

每个后端通过 `META-INF/services` 注册 `RuntimeProviderFactory`。注册表拒绝重复/保留 kind，检查选中工厂并核对返回 provider 的 kind。工厂构造与发现不分配资源；validation 只检查配置。预检保留公共监听、凭据及 Workspace 检查，再委派后端诊断。远程后端不要求本机 Workspace 目录。保留原 Local 可执行文件/状态检查和 External workspace 警告。

创建接口为 `create(settings, transport, dependencies)`。`RuntimeProviderDependencies` 只有四个具名接口：`bindings()` 提供原 Broker 仓储，`externalStorage()` 延迟提供 SQL 存储适配器，`csiReservations()` 提供原数据源/事务权威，`ssh()` 提供借用的节点/存储查询和连接。各后端只获取所需接口。Kubernetes 在构造预留存储前保留 JDBC 仓储、数据源身份、事务管理器及 Workspace 执行检查。

已发现的 SSH 工厂通过 `SshRuntimeSupport` 提供连接构造；Kubernetes 工厂通过 `KubernetesRuntimeSupport` 和类型明确的 `WorkspaceCsiRuntimeSpec` 提供运维/客户端/保护构造。这些是同一工厂的能力，不增加第二套发现机制。内部 SPI 和已移动的实现 import 需要按同版本重新编译。持久化 kind、身份字节、SQL schema、协议及恢复算法不变。只注册 `kubernetes-workspace`；`kubernetes-scratch` 仍未注册，`kubernetes` 仍被拒绝。

其他可信 provider 可以实现契约、注册工厂并使用 `provider-options`，无需增加 server 选择分支；它必须遵守既有 fencing、身份和 HTTP 契约。发现成功不能证明可恢复已有资源，原持久化检查仍具有决定权。

## 选择、准入与资源生命周期

`RuntimeBackendSelection` 在分配资源前计算启用集合。Broker 停用时集合为空，不发现工厂、不创建连接。SSH 主后端要求配置节点，只选择 SSH。Local 主后端配置节点时选择 Local+SSH；其他主后端与节点组合提前拒绝。其余情况只启用主后端。所有选中工厂及配置均在创建客户端、连接或 Worker 状态前检查。

SSH-only 不构造 Local provider/状态或路由包装。Local+SSH 保留共享 endpoint resolver 及原节点身份，Local delegate 使用直接 HTTP transport。SSH-only 拒绝未绑定 Session 的执行、Local workspace 设置和历史 Local 路径解析。Static 保留目录预检；Kubernetes 保留凭据、常驻注册及物理退休授权。

`ssh.enabled` 继续控制新注册、绑定、Session 和文件访问。设为 false 时，已接纳任务仍可按原节点身份执行、关闭、恢复及进行获准的幂等重放。SSH 不在启用集合时，历史注册仍可查询，但不 claim 或分发任务，暂停的 acceptance 保持 unknown，不改写为 FAILED。

在线文件上传对账在交换或状态分发前检查已保存目标所属的后端。切到 SSH-only 后，历史 Local 上传保持 pending 和存储占用，不执行已保存的 Local 命令；恢复后端后可继续对账。该限制不禁用独立离线存储维护。

Spring 唯一负责关闭共享 SSH connections bean；provider 与 `SshWorkspaceService` 仅借用，service 只关闭自己的 executor。启动失败与正常关闭均须释放 controller 所有权。工厂关闭部分构造的资源；常驻装配在后续注册失败时关闭此前 delegate。

## Maven 引用与运维

server 声明五个 `optional`、`runtime` 依赖。library 使用方不会传递引入任何后端，需要显式添加同版本的所选后端产物。例如，Kubernetes 使用方引用普通 server 和 `qwen-managed-agent-runtime-kubernetes`；Local+SSH 使用方引用对应的两个产物。Broker 停用时无需后端。安装多个产物不代表允许任意组合或回退。

独立应用构建仍包含五个后端。保留固定 `exec` classifier、现有运维 classifier 及 Central 发布策略、应用 YAML/配置元数据和 Lombok 排除。普通 library 不含独立应用 YAML。保持参考打包器及发布名称不变，不增加后端选择器或变体元数据。CI 仅更新模块相关的 Maven 缓存排除及配套元测试。

运维按 action 获取能力：缺少 Kubernetes 时拒绝 CSI `serve`、保护渲染和物理退休，但保留 CSI `text`/`retire` 及纯 SQL 的 resident `inspect`/`begin`。依赖 Local 的恢复在持久化副作用前要求 Local。在线校验属于正常配置及显式预检，不放入纯 SQL 维护上下文使用的共享 properties 初始化。缺少能力时不回退到其他后端。

## 验证与剩余风险

保留独立编译及字节码依赖检查。隔离 classpath 覆盖无后端、五种单后端、Local+SSH、full 及独立的 contract-only provider；普通 Maven 嵌入夹具检查 optional 后端不会传递泄漏。默认可执行包检查五个 JAR 及服务注册、配置资源和运维启动器。这些检查不宣称交付七种独立分发产品。

保留未选 provider 初始化、缺失/重复工厂在副作用前拒绝、SSH 准入、pending 上传/注册恢复、启动失败后 controller 锁重新获取及部分构造清理的回归。保留既有完整 unit/H2、Checkstyle、SpotBugs、embedding、MySQL 和 Hosted/fault CI 检查。真实启用的 SSH/Kubernetes 及完整跨平台验收仍是必需项；模拟连接或 H2 不能替代。

共享本地预算已关闭，新增及修订后的 Java 测试等待 CI。根目录脚本/工作流测试、格式、链接检查和静态审查覆盖此次收敛；仅当输入未变化时复用此前根目录 build/typecheck/bundle 证据。详细结果保留在 `.qwen/e2e-tests/runtime-provider-plugins.md`。移除后端前应排空其工作，或明确保留 pending 操作及存储占用直到原后端恢复。当前范围没有待用户决定的设计问题。
