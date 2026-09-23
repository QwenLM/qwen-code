# Managed Runtime Broker 状态基础

[English](managed-runtime-broker-state.md) | [简体中文](managed-runtime-broker-state.zh-CN.md)

状态：已实现的基础能力

## 问题

Managed Agent 管控面可能在多个服务实例并发处理请求时启动、复用、排空和
替换工具 Runtime。仅依赖进程内存无法在重试和所有权切换过程中稳定维护
Runtime 代次或 Session 绑定。

## 当前状态

主干目前没有 Managed Runtime Broker 模块。Runtime 调度、传输、Hosted
Harness 集成和生产级持久化仍属于后续工作。本次变更只增加这些后续层所需的
状态边界。

本模块以 Java 21 作为编译和运行基线。嵌入其 JAR 的服务必须使用 JDK 21 或
更高版本。现有 Java SDK 继续保持独立的 Java 11 兼容基线。

这些记录是 Java 管控面私有的调度与所有权状态，既不同于 Harness Session
Authority 日志，也不同于公共 Agent Event/Item/Snapshot 存储。持久化适配器可以
与这些存储共用同一个数据库部署，但必须保持独立的 schema 和所有权契约。

## 目标

- 定义 Runtime 范围、调度、租约和 Session 的不可变身份。
- 定义带 compare-and-set 版本控制和可过期操作所有权的 Repository 契约。
- 为每个兼容的调度请求保持唯一活跃 Runtime 代次。
- 为单元测试和单进程原型提供线程安全的内存实现。

## 非目标

- 启动或停止 Runtime 进程。
- 暴露 HTTP 服务。
- 调用 Hosted Harness 或模型。
- 在 Runtime Broker 内部鉴权租户身份。
- 跟踪工具执行或解析结果不明确的派发。
- 提供 MySQL 实现。
- 声称内存实现具备重启恢复能力。

## 状态模型

### Runtime 绑定

**RuntimeProvisionRequest** 由管控面提供的 **RuntimeScope** 和隔离键组成。
**RuntimeBindingRecord** 为该请求分配单调递增的代次，并遵循：

    PROVISIONING -> READY -> DRAINING -> RELEASED

**FAILED** 和 **RELEASED** 是终态。后续分配会创建新代次。变更使用乐观
版本号和可过期的操作所有者，确保同一时刻只有一个服务实例执行调度动作。
本基础层只枚举状态，状态转换策略由后续生命周期服务负责校验。

### Runtime Session

**RuntimeSessionRecord** 将一个逻辑 Runtime Session 绑定到指定 Runtime
代次，其生命周期为：

    ACQUIRING -> READY -> RELEASING -> RELEASED

**FAILED** 和 **RELEASED** 是终态。Repository 查询会计算某个绑定代次上的
活跃 Session 数量，供后续生命周期层做排空和空闲回收判断；Session 状态
转换策略也由该生命周期层负责校验。Repository 身份由 Runtime scope 与
`runtimeSessionId` 共同组成；同一 scope 下的标识如果与不同的 Session 不可变
字段冲突，会直接失败，而不会返回已有记录。

## Repository 语义

- **findOrCreate** 对 Repository 身份执行原子创建。
- Runtime binding **compareAndSet** 仅在版本、不可变身份和有效操作声明均为
  当前值，且替换记录保留该操作声明时成功；Runtime Session
  **compareAndSet** 要求当前版本和不可变身份匹配。
- 操作声明包含所有者、过期时间和单调递增代次。
- 内存实现会同步复合操作，但不能代替共享持久化存储。

## 安全与租户

**RuntimeScope** 携带 tenant、workspace、workspace generation、规范化工作
目录、capability digest 和隔离类型。独立 Broker 不鉴权这些值：Java 调用方
负责提供这些值，并负责所需的上游鉴权。Broker 会将这些值纳入调度和 Session
身份，且不得允许 Runtime 或 Harness 替换它们。

## 验证计划

- 在 JDK 21 上使用 Java 21 release target 编译并测试模块。
- 运行 Repository 单元测试，覆盖并发创建、代次轮换、仅版本过期的
  compare-and-set 拒绝、有效操作续租、租约过期后的操作接管、Session 计数、
  跨租户身份冲突和跨 scope 替换拒绝。
- 按仓库 Java 规范运行 Checkstyle。
- 验证 hosted 与 self-hosted Java CI 仅在 Java 21 matrix 中执行 Runtime
  Broker 模块，并覆盖 Linux、macOS 和 Windows。

## 验收标准

- 模块不依赖 Spring、CLI 内部实现或具体调度器。
- 并发创建对每个调度请求只返回一个活跃绑定代次。
- 租户范围参与调度和 Session 身份计算，发生 Runtime Session 标识冲突时也
  不能覆盖已有身份。
- 终态的绑定和 Session 记录不能通过 Repository compare-and-set 重新激活。
- 过期版本和过期所有权代次不能修改当前状态。
- 公共记录会校验必填身份及不可变关系。
- 文档不声称 Runtime 生命周期或持久化存储已经实现。

## 后续工作

后续 PR 可以增加工具执行身份、调度种子、持久化 Repository 适配器、Runtime
传输与调度、Hosted Harness 集成、Spring wiring 和端到端测试。每个后续 PR
都必须依赖本状态边界，而不是增加另一套进程内事实来源。
