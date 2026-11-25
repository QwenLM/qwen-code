# Managed Agent Spring Boot Starter

[English](2026-11-25-managed-agent-spring-boot-starter.md) | [简体中文](2026-11-25-managed-agent-spring-boot-starter.zh-CN.md)

状态：#18311 的实现候选。DataAgent 的专属装配、身份及执行 Provider 选择不属于本次底层改动。

## 问题与现状

Spring Boot 宿主可以依赖普通的 `qwen-managed-agent-server` 库，但该依赖不会启用 `ManagedAgentConfiguration`。每个宿主都必须显式导入 Qwen 的内部配置，导致嵌入依赖包扫描知识而不是官方制品契约。

现有嵌入代码已经隔离了 Managed 数据源、事务管理器、Mapper、执行资源与调度器。核心配置刻意不挂载公共和内部 Controller，这些性质必须保持不变。

## 目标与范围

新增可独立发布的薄 Maven 模块 `qwen-managed-agent-spring-boot-starter`。设置 `qwen.managed-agent.enabled=true` 时，通过 Boot 自动装配导入现有 `ManagedAgentConfiguration`。默认不启用，因此引入依赖本身没有副作用。

Starter：

- 暴露现有 Java 服务及已有的、允许宿主替换的对象存储 SPI；
- 保留由宿主显式 Maven 依赖选择 Runtime Provider 的方式，不打包任一执行后端；
- 不挂载 Managed 公共、WebShell 或内部 Controller；
- 支持部署托管 schema：在 `qwen.managed-agent.schema.initialize-enabled=false` 时只校验既有基线，在缺失、部分结构或外部 schema 时拒绝，不执行 DDL；
- 支持宿主提供 `managedAgentDataSource` 或沿用 `qwen.managed-agent.datasource.*` 配置。

各默认值保留现有行为：独立服务启动和显式导入 `ManagedAgentConfiguration` 不检查 `enabled`，既有初始化设置在缺省时仍为启用。

Starter 不实现宿主身份认证、业务 Session 路由、定义或材料所有权、Muster 编排、第二套 Session 门面、Runtime Provider 选择或 DataAgent 专属配置。内部回调继续是独立的显式配置，未来确有嵌入回调契约时再使用。

## 实现

`ManagedAgentAutoConfiguration` 位于新的 `com.alibaba.qwen.code.managedagent.starter` 包，只负责按条件导入 `ManagedAgentConfiguration`。Maven 模块位于 `packages/managed-agent-server/qwen-managed-agent-spring-boot-starter/`，目录名与 artifactId 保持一致。Starter POM 依赖普通 server library 和直接使用的 Boot 自动配置 API，并注册到 `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`。

`ManagedAgentProperties` 拥有新增的 `enabled`、`schema.initialize-enabled` 属性。`ManagedAgentPersistenceConfiguration.managedJdbcTemplate` 在关闭初始化时调用 `ManagedSchema.validate(source)`，否则保留 `ManagedSchema.initialize(source)`。两条路径都使用现有公开 `ManagedSchema` 方法，不增加绕过、修复或放宽的数据库准入。

父 reactor 在 `verification` 之前加入 Starter，并在 dependency management 中保持同版。verification 直接使用 Starter 类型；独立宿主夹具只依赖新制品，以证明没有依赖 reactor 私有装配。

## 宿主契约

自带 Managed catalog 的宿主引入 Starter 和所需 Runtime 制品，配置如下：

```yaml
qwen:
  managed-agent:
    enabled: true
    schema:
      initialize-enabled: false
    datasource:
      url: ${MANAGED_JDBC_URL}
      username: ${MANAGED_JDBC_USER}
      password: ${MANAGED_JDBC_PASSWORD}
```

Managed catalog 与宿主业务 catalog 不同。其表结构和应用账号由部署流程准备。Starter 不把 `spring.datasource` 解释成 Managed 数据源。

宿主不希望新增 Controller 时使用默认 Java 面。独立服务保留现有 Web 装配，Starter 不移除它。

扩展归档存储由 `ManagedAgentConfiguration` 导入，不再单独注册到 server 的全局自动配置索引。现有工厂方法继续以参数注入 `ManagedAgentProperties`，并通过 `@ConditionalOnMissingBean` 优先使用宿主自备的 `ExtensionArchiveStorage`；不再依赖该配置注册属性 Bean 前就会求值的类级 `@ConditionalOnBean`。设置 `qwen.managed-agent.enabled=false` 时，Starter 不导入 `ManagedAgentConfiguration`，也不创建 Managed 资源。

## 验证

- 上下文测试：默认依赖无效果、显式启用、独立或宿主提供的 Managed 数据源，以及没有公共/内部 Controller Bean。
- Schema 测试：默认仍初始化；仅校验接受已建基线，拒绝空库且不建表；可用时用真实 MySQL 验证该边界。
- 架构测试：Starter 类型只属于本模块且仅依赖 server 装配，不依赖宿主类型。
- 独立夹具：使用 Spring Boot 3.5.3 消费新制品，无 `@Import`，覆盖独立连接池和宿主提供的连接池。验证宿主声明的 `@Transactional` Bean 是 AOP 代理。原显式导入测试继续执行。
- 配置参考与 README 同步新属性和制品契约。
- 聚焦 Maven/Checkstyle 检查及独立夹具提供本地证据；完整 Java、MySQL 和打包测试集保留为 CI 门禁。

## 验收与边界

只有依赖默认无副作用、显式启用可启动、宿主资源保持隔离、无新增 Controller，以及仅校验模式不执行 DDL，制品才算满足装配验收。

Starter 成功不能证明 DataAgent 的业务适配、真实 Runtime 供给、多副本恢复、端到端 Issue/AgentRun 或部署 E2E 已验收。这些结果以及 DataAgent 消费的固定 Qwen 制品版本分别跟踪。回退删除新模块及新增属性，不改变既有 Managed catalog 或独立服务行为。
