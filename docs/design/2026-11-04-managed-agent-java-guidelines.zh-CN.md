# Managed Agent Java 规约整改

[English](2026-11-04-managed-agent-java-guidelines.md) | [简体中文](2026-11-04-managed-agent-java-guidelines.zh-CN.md)

## 状态与范围

2026-11-04 已在本 PR 实现，完整 CI 验收尚未完成。同一个 PR 包含低风险清理、并发与异常处理、聚焦的可维护性整理。数据库规约、持久化实现、表结构修改和大范围生命周期重写不在范围内。验证结果必须区分本地检查与尚未完成的 CI 验收。

## 问题

Alibaba Java 手册审查发现两个没有线程数上限的 cached 平台线程池、未命名的虚拟线程池、请求路径上重复编译的正则、缺少 Override、未使用的私有成员、通过异常进行的空值校验，以及静默的清理失败。

当前本地 provisioner 还通过同一个 executor 执行对账与清理。有界共享队列可能让清理排在 worker 启动之后。Broker 目前会在 managed-context 启动失败后封堵恢复；如果把容量不足当作普通启动失败，就会把临时压力变成永久阻断。worker 返回 READY 后，其 stdout 必须保持打开并持续排空。

## 低风险清理

修复已核实的 Override、未使用私有成员、浮点后缀、虚拟线程名称和高频 action cursor 正则。现有 Checkstyle、SpotBugs、测试和 profile 门禁继续保留。

## 并发与异常处理

Broker 私有 HTTP 分发使用显式平台线程池：最多 64 个线程、`SynchronousQueue`（无等待队列）、命名 daemon 线程及 `AbortPolicy`。饱和时在 JDK HTTP 分发边界关闭或拒绝连接；executor 接收不透明任务，因此不承诺返回 JSON 503。不在分发线程执行被拒绝的任务。该限制覆盖普通路由、native readback 和动态注册的 authority context。

本地 Runtime 操作使用命名虚拟线程。信号量限制最多 32 个并发 worker 启动，不设置等待队列。在异步任务内部、进入 `start` 前获取许可，在 `finally` 释放；取消不能在启动仍运行时提前释放容量，也不能在任务尚未运行时泄漏许可。对账、身份验证、停止和 release 升级强杀独立于启动容量。饱和时在生成进程或进入启动前，通过失败 stage 返回可重试的 `503 runtime_local_capacity`。Broker 启动流程只对这一精确的 local-process 准入失败保留重试，保留 seed 与持久化 handle 并释放操作 claim。首次非持久化启动时，只通过既有 compare-and-set claim 校验清除本轮创建的 v1 占位 handle，否则下次会把占位误判成需要恢复的丢失 worker。compare-and-set 失败时返回 fencing 错误，不能清除其他 owner 的 handle。后续身份验证阶段即使返回相同错误码，也不能触发此例外。其他失败维持现有的恢复封堵行为。

这些固定上限是保守的初始限制，不是经过测量的部署容量，也不限制存活 Runtime 的总数。部署方仍需验证实际负载。本次不增加公共配置项。

每个存活的非持久化 worker 继续使用独立、命名的 daemon 平台线程排空 stdout。Java 21 的同步进程管道读取可能固定虚拟线程载体；将这些长期读取移入启动池或虚拟 executor 可能饿死控制操作。把 reader 生命周期处理从 READY 等待中提取，保留大小限制、超时清理和 READY 后持续排空。等待被中断时保留中断标记。

用显式空值检查替换 deferred-reference 的 `NullPointerException` 捕获，同时保留失败 stage 上的 400 与错误码。清理诊断只标识操作与异常类型，不泄露凭据、worker 输出、请求内容或含路径的异常消息。清理仍尽力执行，不覆盖原始失败。

## 可维护性

将持久化启动失败分类与本地容量识别移入包内可见的处理类，并分离本地 READY 等待与完整生命周期的 stdout reader。失败分类以续租后的持久化 claim 请求为准；既有恢复封堵回调保留其 CAS 和 suppressed-error 行为。进程生成与登记、关闭快照、释放时集合转移及回收继续使用同一把生命周期锁，改用 `ReentrantLock`，避免 Java 21 上竞争进入 monitor 时固定载体线程。清理仍保留在 `finally`。为重复 cursor 与协议大小限制命名。根据实际调用方补充 RuntimeWarmer 生命周期责任与 RuntimeObservation 结果语义。避免通用辅助框架、批量格式化和无关方法拆分。

清除前只识别首次启动时精确匹配的非持久化占位句柄；仅凭不支持启动恢复，不能证明句柄可以安全丢弃。重试回归测试从真实本地 provisioner 获取占位句柄，使生成格式变更会触发测试失败。不新增 provider SPI。提取后下调 Broker 类 pin 和全局类大小上限，不提高任一限制。

公共 snake_case 字段、语义错误码、JSON 规范化、精确二进制浮点转换及现有持久化和租约协议保持原有语义。特别是用于规范化摘要的精确 `BigDecimal(double)` 转换属于有意设计。

## 涉及区域

涉及本地 Runtime provisioner、Broker HTTP 分发与准入失败处理、SSH 清理、action cursor 校验、部分配置与适配器，以及公共生命周期契约。所有 Java 回归测试继续位于 `verification`。

## 验证与验收

遵循模块共享十分钟本地验证预算，使用 JDK 21、任务隔离的 Maven 仓库及与当前源码一致的 sibling SDK 安装。CLI dry-run 无法覆盖这些私有 Java 路径，因此使用聚焦 Java 测试和真实 worker 进程。覆盖启动饱和、拒绝时不生成进程、失败或取消后容量恢复、并发清理、关闭、READY 后 stdout，以及使用原持久化身份的重试。确认其他启动失败仍封堵恢复，空值引用仍以异步失败返回。

运行受影响的 action、SSH、Broker、本地进程测试及两套 Checkstyle 配置。现有完整单元测试、SpotBugs、真实 MySQL、Hosted 和故障门禁继续作为 CI 验收要求。预算内无法本地运行相关真实 MySQL 路径时，明确记录等待 CI，不能用 H2 证据替代。固定并发上限与聚焦测试通过均不代表部署验收。

## 开放问题

实现范围没有待决问题。负载容量设置留待后续依据负载证据决定。
