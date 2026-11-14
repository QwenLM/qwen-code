# 工具输出发布单一校验模式

[English](2026-11-10-managed-tool-publication-single-verification-mode.md) | [简体中文](2026-11-10-managed-tool-publication-single-verification-mode.zh-CN.md)

## 状态与范围

已实现并完成本地验证；验收仍需完整 CI 门禁通过。本变更依据
[首发契约](2026-10-23-managed-first-release-contract.zh-CN.md)，把
[异步校验设计](2026-10-07-managed-tool-publication-async-verification.zh-CN.md)
收敛为仅保留异步模式：只支持同一构建版本的 Server、Broker、Harness、WebShell
和 Managed SDK，在全新状态上运行，不迁移开发数据库。

## 问题

Issue [#13242](https://github.com/QwenLM/qwen-code/issues/13242) 把发布读回和流扫描
移到了持久化的 verifier，但为滚动升级保留了同步路径。只有当
`qwen.managed-agent.tool-publication.async-verification-enabled` 为 `true`（默认
`false`）且请求携带 `X-Qwen-Tool-Publication-Async: 1` 时，操作才会异步受理。

- 唯一的生产者（CLI 远程 Shell 发布器）总是发送该 header。
- 没有任何部署、Spring profile、CI 作业或 E2E 测试打开该开关。因此所有部署仍在
  HTTP 请求线程上校验，这正是 #13242 要消除的；verifier 只在单元测试中运行。
- 两种模式共用生产者存储方法。线程本地的 verifier 上下文、`asynchronous` 参数、
  `preparing` 参数和持久化的 `ma_operation.execution_mode` 在两者之间选择；每个生产者
  路由都有第二个重载；模式粘滞、"遗留 claim" 重试和回滚排空只为混合版本存在。

首发契约已删除同类混合版本路径，但没有覆盖这一处。

## 决策

1. **异步受理是唯一的生产者模式。** segment、resource、seal、prefix 和 finish 请求
   校验输入、占用 slot 和 operation、持久化校验输入（对象 PUT 或 inline 字节）、
   把操作标记为就绪，并返回 HTTP 202 和 `state: PENDING`。重放返回当前状态：
   带 `receipt` 的 `SUCCEEDED`、带 `error` 的 `FAILED`，或 `PENDING`、`RETRYABLE`、
   `EXPIRED`。所有读回、扫描和 finish 校验都由 verifier 执行并安装结果。状态表、
   截止时间、epoch、租约、隔离栅栏、恢复和配额计量保持现有异步行为。
2. **删除模式选择输入。** 删除 `async-verification-enabled` 配置及其环境变量和
   settings 访问器、`X-Qwen-Tool-Publication-Async` header、各路由的模式重载、上传的
   同步 claim/读回/安装路径、`preparing` 参数以及所有区分两种模式的检查。通过就地
   修改 V1 基线，删除 `ma_operation.execution_mode`、它的 CHECK 约束以及它在
   `idx_ma_operation_verification` 中的列。`verification-concurrency` 保留。
3. **保留 verifier 上下文，去掉模式开关。** 线程本地变量仍把已受理操作的授权和
   epoch 传入共享读取辅助方法，使隔离写入和心跳继续受当前尝试的栅栏约束。seal、
   prefix 和 finish 显式分派：没有 verifier 上下文时受理请求，在 verifier 上下文中
   执行校验。verifier 的心跳只针对就绪操作运行，因此总是续期下一次尝试时间。
4. **客户端要求响应带状态。** 每个生产者响应都必须携带 `state`；删除接受直接回执的
   分支，无状态的响应会作为意外状态失败。收到 `PENDING` 后，轮询从 25 ms 开始并
   翻倍，直到现有的 250 ms 间隔，使几毫秒内完成校验的操作不必各等一个完整间隔。
   串行队列、30 分钟观察截止时间、三次恢复和其他重试延迟不变。
5. **重放遵循异步契约。** 精确的成功重放直接返回历史回执，不做对象 I/O；同步路径
   会重新读取对象。读取、finish、回执校验和 ACK 仍检查当前字节。

## 兼容性与约束

- 启用工具发布的部署现在以异步方式校验。Spring 会忽略已删除的配置项，残留的
  环境变量不产生任何效果。
- 只支持匹配版本的生产者构建。已发布的 CLI 构建已经发送该 header 并能处理
  HTTP 202。
- V1 基线发生变化，开发库需要重建。Server 和 Broker 仍校验同一套最终列、索引和
  约束。
- 校验失败以安全的 `{status, code}` 报告，而不是同步路径的异常消息。

## 风险

- verifier 首次成为生产路径。它的 H2 和 MySQL 测试套件保持不变；原先驱动同步
  路径的测试改为先受理再排空 verifier，使这些断言覆盖异步路径。Hosted CI profile
  会端到端执行该路径。
- 更短的初始轮询在达到 250 ms 前每个操作最多多出四次状态读取，每次都是一条只读
  查询。
- 完成延迟现在包含 verifier 拾取和一次轮询。提交后会立即唤醒 verifier；25 ms 的
  初始轮询限制了快速操作增加的等待。

## 验证

- Java 定向测试：异步校验套件，以及发布存储、controller、配置、ACK、回收、查询
  预算、schema 和 CSI 清单测试，外加 Checkstyle。
- 真实 MySQL 8.4：异步校验套件和选定的发布 MySQL 测试。
- CLI：远程 Shell 发布测试、根目录 build 和 typecheck。
- 重新生成配置参考，并通过其 `--check`。
- CI：带 SpotBugs 的完整单元/H2 套件、`mysql-integration` 和 Hosted profile。

只用于固定已删除组合的测试（开关与 header 矩阵、模式粘滞、关闭受理时的排空）
随这些行为一起删除。客户端测试对每个生产者请求都返回带状态的结果；查询预算和清单
测试中的固定值随删除的列和新增的 verifier 授权一起更新。

## 验收标准

- 生产代码中不再引用已删除的配置项、header、`execution_mode` 或同步生产者路径。
- 每个生产者路由都返回带状态的结果，生产者字节只由 verifier 读回或扫描。
- 异步套件固定的状态、恢复、隔离和配额行为在 H2 和 MySQL 上保持不变。
- 分别报告本地结果、跳过的检查和待完成的 CI 门禁。
