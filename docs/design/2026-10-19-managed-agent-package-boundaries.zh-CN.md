# Managed Agent Server 包边界

[English](2026-10-19-managed-agent-package-boundaries.md) | [简体中文](2026-10-19-managed-agent-package-boundaries.zh-CN.md)

状态：已在主干基点 `f37e003d9450` 上实现并完成本地验证。远端 CI 与正式评审状态见 [PR #14710](https://github.com/QwenLM/qwen-code/pull/14710)。本次包调整未在本地运行可选的 MySQL、Hosted 和 Linux 故障专项 profile。

## 问题与现状

Managed Agent Server 是一个 Spring Boot 应用和 Maven 模块。调整前，`service` 和 `store` 包混合了多个业务能力，应用与持久化代码还从 `api` 引用请求模型、租户上下文、Workspace 选择及异常。Runtime Broker 则将编排、供应器和 HTTP 适配器放在同一个包中，难以直接看出职责和依赖方向。

既有[源码布局决策](2026-10-15-managed-agent-server-layout.zh-CN.md)仍然适用：Broker 只有一个生产消费方，无需为此单独发布产物。本次调整应用内部的 Java 包组织。

## 目标与范围

- 保留一个 Maven 模块和一个服务部署。
- 消除应用与持久化代码对 HTTP 控制器包的依赖。
- 按职责组织 Session、Workspace、Artifact、Channel、Automation、目录和事件组件。
- 将 Broker 的供应、传输和凭据保护与执行及仓储核心分开。
- 保留 HTTP 契约、认证、SQL 字节、事务边界、持久化身份和恢复行为。

本次仅调整源码组织，不重新设计持久化，不引入新的服务接口，不拆分部署，也不改变维护应用的组件扫描边界。

## 目标结构

```text
com.alibaba.qwen.code
├── managedagent
│   ├── api              HTTP 控制器、过滤器与响应映射
│   ├── model            共享请求响应与存储值类型
│   ├── exception        共享应用异常
│   ├── security         Writer 凭据与路由策略
│   ├── session          Session 与命令编排
│   ├── workspace        Workspace 服务与选择
│   │   └── runtime      Workspace Runtime 集成与恢复命令
│   ├── artifact         产物访问与对象存储契约
│   ├── channel          Channel 服务与适配器模型
│   ├── automation       调度与自动化服务
│   ├── catalog          Agent 定义、Skill、Hook 和 MCP 目录
│   ├── event            已提交事件的发布与投递
│   ├── persistence      共享 SQL 聚合与事务实现
│   ├── harness          Hosted Harness 接入
│   ├── config           Spring 配置
│   └── preflight        启动检查
├── runtimebroker
│   ├── provisioning     物理 Runtime 供应器及供应协议
│   ├── transport        Runtime HTTP 传输与线上协议
│   ├── security         凭据加密
│   ├── managedschema    共享数据库结构
│   └── managedworkspace Workspace 契约
└── maintenance          独立配置的维护应用
```

## 决策与约束

请求响应记录与校验注解一起迁移，不改变 JSON 名称、反序列化器或校验规则。共享应用异常保留现有状态、错误码、详情和 cause 语义，只调整名称与归属。HTTP 错误信封映射仍放在 `api`。

Session、Workspace 和发布持久化共享包内事务操作。将该聚合保留在同一个 `persistence` 包中，不为按业务名称拆包而公开锁及变更辅助方法。独立的对象存储契约和事件接口归入对应能力。将规范请求摘要移出原服务包，让持久化继续复用同一份摘要实现。

Broker 供应器和传输组件复用现有协议校验及值操作，只公开新包边界实际需要访问的既有成员。本地进程状态与 SQL 实现辅助类保留包内可见性。测试跟随其实际验证的内部实现所在包，不仅为了测试而公开生产代码内部成员。两个仅供测试使用的访问夹具跨包转发现有 Broker 核心与 HTTP 传输访问点，避免公开对应的生产代码内部成员。

Broker 核心仓储通过 `transport.ManagedHoldFamily` 识别已存储的 dispatch mode。该查询对跨包的核心消费方公开；`ToolHoldRow` 与相关仓储保留在核心包。变基验证需要一起编译更新后的核心与传输层消费方。

保留服务端 Spring Boot 应用原有根包，维护配置继续位于该根包之外。同时更新 import、完整类名、启动配置、当前文档链接和源码文件引用。保留资源路径、Maven 测试 profile、故障门禁及 Broker 单独的 Checkstyle 执行。

## 风险与验证

主要风险是隐式同包引用、Spring 组件发现意外变化、命令入口残留旧名称、测试辅助代码依赖包内访问，以及文档链接更新不完整。迁移前后核对全部生产与测试类清单，编译所有源码，使用 JDK 21 运行相关测试和完整 Maven 验证，并检查打包应用。Java SDK 使用当前检出源码构建，同时准备原生一致性测试所需的 Core/CLI 输出。

规范化包名、import 和必要可见性变化后，对比源码主体。检查应用与持久化包不再引用 `managedagent.api`，Broker 继续独立于 Spring 和控制面类，SQL/OpenAPI 资源保持不变。执行格式、引用检查及两遍干净自审。单独报告未运行的环境专用 profile，普通 Java 测试不代表 MySQL 或 Linux 恢复验收。

JDK 21 本地验证通过：

- `mvn clean verify`：4,796 项测试，零失败、零错误，18 项既有跳过；两项 Checkstyle 执行和 SpotBugs 均为零问题。全部既有 Maven 验证门禁保持开启。
- 根目录 `npm run build`、`npm run typecheck`、全部 39 项相关脚本测试、针对性 ESLint 和 Javadoc 引用检查均通过。
- 规范化包名、import 和可见性后，全部 322 个生产源码主体保持不变。全部 877 个编译类及 16,860 个声明签名完整保留，既有公开访问权限没有收窄。
- 7 个可执行 JAR 均包含预期入口和未变的资源。4 个维护入口在访问文件、数据库或云服务之前正确拒绝空参数。

## 验收标准

所有原有类和资源按新归属完整保留，既有路由与线上契约通过回归测试，标准 Maven 验证通过且未关闭门禁。共享 SQL 事务辅助代码保留包内可见性。应用与持久化代码不从控制器包导入类型。两份设计文档及当前构建、维护说明反映最终结构。

## 待定问题

本次包调整没有待定问题。后续出现独立消费方或明确的编译隔离需求时，再评估 Maven 多模块。
