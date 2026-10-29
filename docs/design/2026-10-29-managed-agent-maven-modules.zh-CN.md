# Managed Agent Server Maven 多模块

[English](2026-10-29-managed-agent-maven-modules.md) | [简体中文](2026-10-29-managed-agent-maven-modules.zh-CN.md)

状态：已在工作树实现，最终验收待 CI。调研基线为 `523be857db`。本设计取代
[源码布局](2026-10-15-managed-agent-server-layout.zh-CN.md)及
[Java 包设计](2026-10-19-managed-agent-package-boundaries.zh-CN.md)中的单模块边界。

## 问题与约束

基线包含 391 个生产 Java 源文件、614 个测试 Java 源文件和 18 个 Maven profile。
词法依赖分析发现分别涉及 83 和 35 个生产文件的循环。模型引用仓储，编排识别具体 JDBC
类，服务包含 SQL，仓储调用业务服务和外部工具。配置、测试夹具、启动器和 CI 也假定
只有一个源码目录。

本次通过一次完整迁移建立工程内部的编译边界。模块统一版本和发布。允许调整 Java
源码接口，仓库内使用方同步迁移。HTTP 路由、JSON、配置键及默认值、数据库字节、事务
边界、身份、隔离栅栏和恢复行为保持不变。不迁移数据库、不拆服务、不增加产品功能、
不独立维护模块版本，也不附带拆解大类。产品专用集成继续放在本应用之外。

## 模块与依赖

父工程为 `com.alibaba:qwen-managed-agent-parent`，使用 `pom` packaging。生产子模块
使用 `qwen-managed-agent-<目录名>`；`server` 保留
`com.alibaba:qwen-managed-agent-server`。所有子模块继承父工程版本。

| 目录             | 职责                                                              | 内部生产依赖     |
| ---------------- | ----------------------------------------------------------------- | ---------------- |
| `contracts`      | 接口、值类型、异常、只读配置与纯协议规则                          | 无               |
| `control-plane`  | Session、Workspace、任务、生命周期、自动化、Channel 和扩展编排    | `contracts`      |
| `runtime-broker` | Runtime 绑定、执行、租约、取消、排空及恢复                        | `contracts`      |
| `persistence`    | 控制面和 Broker 的 JDBC/内存仓储、schema 与事务                   | `contracts`      |
| `adapters`       | Harness SDK、物理供应器、HTTP 客户端、OSS、MQ、Git 和文件系统实现 | `contracts`      |
| `server`         | HTTP 服务端、Spring 装配、启动、预检与运维入口                    | 其他所有生产模块 |
| `verification`   | 现有测试、夹具、架构检查和产物验收；不发布                        | 所有生产模块     |

四个实现模块不相互依赖，由 server 通过契约注入实现。一个生产 Java package 只属于
一个产物。不通过兄弟源码目录、聚合编译 classpath、shading、通用服务注册框架或
大而全的 common 模块绕过边界。

契约可以使用现有 JSON、校验注解和 Commons 库，不能引用 Spring、JDBC、Java SDK 或
云产品客户端，也不能执行数据库、网络或进程操作。控制面可以保留 Spring 组件、调度
和事务支持，但不能引用 JDBC 或具体外部客户端。Broker 编排继续独立于 Spring。

## 契约与实现调整

将现有存储、Harness、Runtime、事件和对象存储接口及共享值类型迁入契约。只在真实
模块边界提取接口。跨模块使用的仓储嵌套记录类型连同值语义迁移，共享模型不再依赖
仓储实现。应用 HTTP 状态改用整数，在 HTTP 层转换，保持错误码、详情和 cause。
保留协议字符串、JSON 名称、空值、顺序、编码和摘要输入。将纯请求身份计算和 provider
kind 常量移出 JDBC/provider 类。

`ManagedAgentSettings` 提供现有配置组的只读视图。`ManagedAgentProperties` 仍归 server
并实现这些视图，保留绑定注解、时间单位、环境访问、凭据文件读取和启动检查。使用方
接收视图或原有标量，不引入配置快照或动态刷新。

在 JDBC 实现中显式覆盖 `AgentStateStore` 的七个默认事务入口，保持原事务语义。
移除接口注解不能丢失委托重载入口的代理拦截。现有 Spring 与原生 JDBC 事务机制分别
保留。同连接操作和包内锁辅助方法留在 persistence，普通仓储契约不暴露 `Connection`。
每个原事务体整体迁移，不拆成分别提交的 CRUD 操作。

`NativeCsiExecutionRepository` 承接现有私有 CSI prepare 和 batch read 能力。原 JDBC
binding 仓储实现它，内存仓储不实现。Broker 使用能力接口而非具体 JDBC 类型。能力
发现不替代事务 admission、原 DataSource 身份、writer/generation 校验及锁。缺失能力
保持原拒绝行为。中立存储异常保留真实存储故障分类，不暴露 JDBC 异常类型。Broker
操作接口只包含实现模块外的实际消费操作。

恢复查询和 SQL 证据读取进入 persistence。Channel 服务注入现有仓储接口，不自行
创建 JDBC 仓储。分离扩展事务、归档访问和业务协调，保持原顺序。提取用户消息授权及
输入策略，不将授权移出原事务，也不引入策略对消息仓储的依赖。Git 和 SSH 在原调用
位置通过明确的接口访问。

仅 adapters 直接依赖 Java SDK 和云产品客户端。将 Harness 结果以及同步、异步和回调
异常映射为契约值。保留 HTTP、传输、协议、generation、能力不匹配和拒绝的区别，包含
重试所需输入、状态、原因和 cause。SDK payload digest 与 permission rules 算法通过
小接口委托复用，不复制实现。Workspace 范围和授权 wrapper 留在控制面，物理供应及
通信进入适配器，实例创建和监听器归 server 装配。

CSI 维护保留持久化顺序：锁定并保存原操作尝试，执行限定的 Kubernetes 操作，然后
通过栅栏校验保存回执或未知结果。保留 UID/resourceVersion、请求字节及回执摘要。
响应丢失保持 UNKNOWN，不允许盲目重放。运维入口保留独立应用上下文，不启动公共服务
或业务调度器。

## 构建、资源与验证

保留 JDK 21、Spring Boot 3.5.16 和既有构建插件版本。父工程管理版本，各子模块声明
自身依赖。reactor 构建全部模块，仅 `server` 执行 Boot repackage。保留可执行及运维
classifier 和服务发布坐标，产物移至 `server/target`。SDK 保留现有单独安装的构建前提。
父 POM 与全部生产依赖同版本发布，verification 不发布。

server 装配保留无 Servlet 嵌入、显式内部回调和独立服务三种方式。专用数据源、事务
管理器、mapper、执行器和调度器保留名称，与宿主默认 Bean 隔离。限定组件扫描，并让
每项资源只有一个关闭责任方。

| 资源                        | 归属           |
| --------------------------- | -------------- |
| OpenAPI 和共享协议 schema   | `contracts`    |
| V1 schema 和 CSI 持久化声明 | `persistence`  |
| 应用 YAML 与 Spring 注册    | `server`       |
| 测试夹具与 JUnit 服务注册   | `verification` |

classpath 资源名保持不变，每份资源只有一个产物所有者。TypeScript 工具结果 schema
仍为权威来源。同步更新启动器、Docker、分发和版本检查、WebShell 契约读取、历史路径
回退及 CI 使用方。资源移动不增加协议/schema 版本。

将全部现有测试和夹具迁至 verification，保留执行族和全部 18 个 profile。产物测试
在 server 打包之后读取其输出目录。保留 MySQL fork 路由、JUnit 扩展、故障测试环境及
真实进程参数。报告完整性检查核对完整的新测试树。Checkstyle 与 SpotBugs 继续覆盖
每个生产模块。聚合覆盖率包含生产类和源码，而不只包含测试执行数据。verification
为此以 compile scope 直接依赖生产模块，自身仍不发布。

使用测试范围的 `com.tngtech.archunit:archunit:1.5.1`，在现有 JUnit 下验证模块矩阵、
禁止依赖、包归属及非空扫描，不增加测试引擎。框架/客户端类型不得从签名、继承、注解
或异常引用中泄漏。

## 实施与验收

一次整体交付：记录源码、测试、资源和入口清单；提取契约、解除循环；移动源码并建立
POM；迁移装配、测试和交付工具；验证并自审完整结果。同步维护双语设计与开发说明。

验收覆盖独立模块编译、契约纯度、配置及宿主隔离、七个事务入口回滚、原生 CSI 拒绝和
admission、重启/接管/响应丢失恢复、SDK 转换和摘要一致性、HTTP/tenant/actor/Workspace
安全、全部普通/可执行/运维产物与唯一嵌套 JAR 资源，以及原 CI 测试族完整性。

本地 Java 验证遵守模块 AGENTS.md 共享十分钟预算，优先架构、事务和装配回归及受影响
的真实集成路径。完整 Java、MySQL、Hosted、故障和 MQ/OSS 门禁由 CI 承担。跨语言
修改还需仓库 build、typecheck 及相关脚本/meta-test。跳过或不可用的集成不能记为通过。
完整 diff 和证据需连续两遍干净自审。分别报告本地、CI、跳过和待验证结果。回退替换
应用及分发产物，不重写持久化数据。

## 实现说明与本地证据

七模块 reactor、契约提取、装配调整、测试/资源迁移及交付脚本更新作为同一批次实现。
原有 614 个测试源文件和 18 个 profile 名称全部保留。六份原有生产资源保持字节不变，
各有唯一生产模块归属。新增回归覆盖编译后模块边界、默认事务方法的实现覆盖、SDK
异常转换及单实例 Harness 装配。

Harness SDK 边界同时包装单实例和池化 connector。单实例工厂显式向被包装的 connector
提供 skills、扩展记录和专用 mapper；Spring 无法向返回 wrapper 后隐藏的 delegate
注入字段。配置视图保留原有集合引用和读取时机。现有文件系统身份/admission 检查留在
原业务/事务位置；物理 Git、SSH、provider 和存储身份操作通过提取的接口调用。

本地证据来自 macOS、JDK 21、Maven 3.9.14、隔离的 Maven 仓库、Node 26.12.1，以及
用于工作流 Shell 夹具的 Bash 5，不能证明 Linux、远端云环境或生产行为。

| 范围              | 本地观测结果                                                                                                        | 限制                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 生产 reactor      | 六个生产模块均按声明依赖编译；生产 Checkstyle 与 SpotBugs 通过；普通、可执行及六个运维 JAR 已构建                   | 这组完整质量/打包结果早于最后的装配与集合引用修正                                                                     |
| 架构与事务        | 字节码架构检查通过；七个原默认事务入口经真实 Spring 代理和专用 H2 事务管理器完成提交及回滚；44 个锁顺序用例通过     | H2 与代理证据不能证明 MySQL 并发行为                                                                                  |
| 配置与嵌入        | 31 个属性绑定用例、无 Servlet 嵌入及显式内部回调测试通过                                                            | 独立 Maven embedding-host 夹具尚未运行                                                                                |
| Broker 与生命周期 | 199 个 Broker、33 个驻留 Workspace 退休，以及 47 个取消/命令/自动化用例通过                                         | 完整重启、Hosted、故障及 MySQL profile 待验收                                                                         |
| SDK、HTTP 与打包  | SDK 转换、23 个 API 契约及三个打包用例通过；检查过的可执行包包含五个内部依赖 JAR，无重复生产类/资源                 | 这些产物早于最终自审修正                                                                                              |
| 最后装配修正      | 两个改动的生产类和新增 Harness 装配回归完成编译，回归方法执行成功                                                   | 该定向检查不是完整 Maven/Surefire 执行；随后仅涉及集合引用的修正仍需 CI 编译                                          |
| TypeScript 与脚本 | 仓库 build 和 typecheck 通过；受影响 CLI 测试 288 项、集成辅助测试 22 项通过；定向 ESLint 及相关脚本/工作流复查通过 | 首次较广脚本执行因 macOS Bash 3.2 失败，Bash 5 复查解决了这些失败；其中一个未修改的 600 ms 时序用例仅在隔离执行时通过 |

共享本地 Java 账本累计约 598 秒。较早的质量检查在验证模块格式处停止，修正后已复查。
后续定向执行中的配置失败已修正，31 个用例全部重跑通过。最后一次
`mvn -DskipTests verify` 到达 server SpotBugs 后触发限定超时，**不能记为完整 reactor
通过**。最后的定向装配检查后未再启动 Java 验证。

验收仍要求最终源码版本通过未过滤的 Java reactor、聚合覆盖率生成、独立
embedding-host 夹具及现有 MySQL、Hosted、故障、MQ 和 OSS CI 门禁。新增 Java 测试
格式和最后的集合引用修正也等待该次执行。尚未派发 CI、尝试 Central 发布、部署服务或
迁移数据库。使用或发布前须从最终版本重新构建交付物；本地中间 JAR 仅是验证产物。

## PR 整合基线

准备 PR 时，在原调研基础上接入了 `main@68f181b885`。较新的有界历史查询及模型保留在
仓储契约和持久化实现中。主干新增的清理重试协调器依赖清理债务仓储契约及中立 Harness
异常；SQL 扫描和原有 keyset/退避行为保持不变。配置解析入口和升级打包留在 server
装配层。当前主干的 619 个测试源文件及两个嵌入夹具源文件全部保留，包括调研后新增的
五个测试。六份生产资源与这一较新的主干版本字节一致，重构不再附加协议/schema 变更。

整合后，仓库 build 和 typecheck 再次通过。参考包测试通过 25 项、保留一个既有跳过项，
五组相关脚本测试通过 196 项、CLI 使用方测试通过 288 项、定向 Maven/工作流检查通过
22 项。上文的 Java 证据早于本次整合。共享 598 秒预算没有重置：
整合版本的编译、格式检查及 Java 回归仍待 CI，包括新增仓储边界和迁入的主干测试。
最终验证完成前，PR 保持草稿状态。
