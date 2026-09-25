# Managed Agent 拆分：评审修正

[English](2026-09-25-managed-agent-review-corrections.md) | [简体中文](2026-09-25-managed-agent-review-corrections.zh-CN.md)

## 范围与状态

本次评审针对 PR #12692 的 `2c68513d3d2c91b27ad59f72cc6eb359833580b4`。此前四组设计文档来自更大的集成预览；其中的实现和真实进程验证声明不能证明本次拆分具备相同能力。本文记录修正后的边界；完整 Hosted Harness / Broker / worker 链路仍是合并门禁。

## 修正

- Managed 面板要求显式传入 provider。普通 daemon 面板继续使用原有路由。本次拆分没有 daemon Managed Session SDK 或端点，因此移除不可用的适配器及仅靠 mock 的测试，浏览器测试改为覆盖 Java HTTP 契约。
- 新私有 Session 先尝试严格创建；已有权威记录冲突或创建结果不确定时再 load。已知存在的 Session 只 load，避免在新权威记录存在之前就要求通过所有权校验的加载。
- 生命周期事件身份使用命令幂等键，而非仅使用语义摘要。第二轮 archive/unarchive 是新操作；重放同一命令键仍保持幂等。
- 公共文本 Part 只聚合相邻且同类的 delta；工具与思考事件切分 Part，保证快照还原后的显示顺序。
- continuation 回退只清除指定 Harness boot 和 event epoch 的输出。在同一事务中失效派生投影、重置物化进度，提交后发布 `stream.reconciled`，使浏览器重新读取保留的历史。这修复投影一致性，不代表缺失的私有 checkpoint 恢复协议已被证明。
- 无本地进程所有权且无法连接的 worker 保持 `UNKNOWN`；attestation 失败不能证明旧进程已停止。
- Broker 实现真正的持久化派发屏障前，`executions:prepare` 与 `executions/{id}:start` 返回不可重试的 501。此前 prepare 会派发执行、start 仅查询，违背设计协议。已有 create-and-dispatch 路由保留原语义。
- Java 21 数据库 CI 任务现已安装本地 SDK/Broker 依赖，并使用独立数据库运行 Spring 模块的单测、Checkstyle 和 MySQL profile 集成测试。共享契约 fixture 变更也会触发工作流。
- WebShell 正确映射 Java `running`、`cancelling`，禁止在非活动 Session 上操作，并在流事件和 Item 中保留工具失败状态及身份。

## 剩余集成门禁

1. 内嵌 transport 对 acquire/control/release 返回 501。当前 TypeScript 树缺少所复制 E2E 脚本假设存在的 Broker provider 和远程 durable-store adapter。必须共同集成这些依赖，才能证明真实工具 Turn 与崩溃恢复。
2. 私有 Store 的 acquire 接受调用方自行选择的 writer token 和 tenant。writer 租约约束先后写入者，但不认证服务身份。必须为这些路由提供可信服务身份或强制私网入口策略，并与浏览器 Agent 路由区分。
3. Harness 级 drain 仅在进程内存中标记 Session 退休，不停止 worker、不持久化退休状态，也不撤销全部私有 Broker 访问。不能把 archive/delete 宣称为 Runtime 回收。
4. HTTP 适配器把 Broker `UNKNOWN` 映射成 `executing`，尚不能表达设计承诺的持久化恢复阻塞。恢复需要明确且兼容的未知结果契约。
5. 新增 CI 接线仍需远端运行通过才能合并。既有 SDK CI、本地 H2 测试与监听器的 401 测试不能作为 Spring/Broker/worker 成功集成的证据。

## 所有权与下游使用方

公共 `/v1/agents/sessions/**` 与 `/api/agent/web-shell/v1/**` 属于持久化 tenant/Session 范围，下游是命令存储、协调器、事件重放、投影和 Java WebShell provider。`/internal/managed-session-store/v1/**` 属于 tenant/workspace/Session 范围，预期由经过服务认证的 Harness writer 调用。独立 Broker listener 使用机器凭证，其 resolver 根据持久化 Session 与部署配置解析租户、工作区；它不是普通 daemon 路由，也不是回退到 daemon primary workspace。标准 WebShell 的普通聊天、设置和工作区操作继续使用原 daemon provider。

## 验证与验收

回归测试必须能拒绝原先的重复生命周期操作、跨代次回退、交错快照文本、新 Session 路由和 Java UI 状态映射行为。执行仓库 build/typecheck、定向 WebShell 测试、Java 21 Maven test/checkstyle，以及基于 Java 契约的浏览器场景。浏览器 fixture 和 H2 测试不能替代真实 MySQL / Hosted Harness / worker 集成或生产安全门禁。在剩余门禁具备明确实现与证据之前，PR 仍应保持需要修改的状态。
