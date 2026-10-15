# Hosted SSE 断流故障门禁（FG6e）

[English](hosted-sse-gap-fault-gates.md) | [简体中文](hosted-sse-gap-fault-gates.zh-CN.md)

## 问题与范围

Issue #12872 要求公开和 WebShell 事件流在 Hosted 工具回合中断开后仍可续传。
D3 已实现持久回放；FG6e 增加使用打包 Harness、真实 Workspace Edit worker
及 MySQL/MariaDB 的多进程门禁。观察者断开不能取消工具或重放 Prompt，
重新连接后必须准确收到每个持久化事件一次。

公开 GET 流通过 `Last-Event-ID` 续传，优先级高于 `after`。
WebShell POST 流使用现有请求体字段 `afterSequence`。
两种游标均指向最后收到的 SSE `id`，但两端事件投影不同。
本设计不改变协议或产品行为。

## 测试边界

公开 Workspace Turn 准入仍不可用。复用现有私有 Hosted Workspace 夹具，
不为了测试开放准入。仅测试使用的 Java 转发器通过 `HostedHarnessClient`
读取真实私有流，使用产品中的 `HarnessEventProjector`，再通过
`appendPublicEventIfAbsent` 提交投影，保留原 Prompt 与源事件身份。
实际路径仍经过正常 SQL 序号分配、身份推导、提交后事件 hub、
公开/WebShell controller 和 SSE 服务。

转发器不伪造工具或终态事件，也不证明公开 Turn 准入、coordinator 批处理或
公开 Turn 状态转换；这些不属于本切片。夹具内可信主体提供已保存 Workspace
的读取身份，产品鉴权检查仍然执行。

## 场景

1. 打开两个事件流，启动一次真实私有 Hosted Edit。
2. 备份准备后，在转发 start 前创建 `proof.txt.read-gate`。worker 导入
   `hosted-file-read-gate.mjs`，原生 Edit 读取时写入 `proof.txt.read-entered`，
   等待后才调用原 reader。要求已出现该标记，且普通文件仍为 `x`。记录已接收前缀，
   在私有 Turn 活跃且效果尚未完成时断开两个观察者。
3. 删除读取 gate。在两个观察者均断开时，要求只有一次 `x` 到 `xx` 的效果，
   原执行及私有 Turn 成功。转发器提交真实的最终助手消息，随后暂扣实际收到的
   终态，尚不提交其投影。私有流投影的是已提交消息，而不是逐个模型 delta 或工具日志记录。
4. 两个观察者各自从最后收到的 id 重连。公开请求同时提供冲突的 `after=0`，
   固定 header 优先级。等待两端追上持久化水位，再在同一连接上提交暂扣的终态。
5. 将每端原前缀加续传后缀与完整持久序列及其 JSON 投影逐条比较。
   要求 id 连续、载荷一致、唯一成功终态、预期文本及私有工具记录、原执行身份、
   唯一派发和效果、没有取消，并释放存储所有权。

所有等待和 HTTP 调用均有时限。失败时驱动关闭所属流和监听器，父夹具负责 worker
退出清理。清理必须只终止并回收夹具拥有的 worker，不能仅为解除等待而放行未知 Edit。
断言失败路径的清理覆盖仍为 #13124 后续事项。保留普通流程及 FG6a–FG6d 门禁。

## 实现与验证

为 `HostedWorkspaceToolTurnIT` 增加独立 SSE 驱动及仅测试使用的 Java
转发器/探针；现有 Hosted MySQL CI 会纳入新增测试。
假模型保持确定性，不需要真实模型或凭据。

先尝试全局 CLI 基线，记录其是否无法进入私有 Hosted 配置。
随后用真实 SQL 验证本地打包产物，并运行 build、typecheck、相关测试与
Checkstyle。独立核对 SQL 身份、序号和终态数量，不只信任驱动结果。

保持门禁不变，逐个移除受覆盖的回放保护：忽略任一种续传游标、
破坏任一流回放的 SSE id，或将 SQL 游标的严格 `>` 边界改为 `>=`。每项突变必须因行为断言失败，
基础设施失败不计入。最终验证前恢复源码和运行产物。
对完整差异做无方向与反向审计，直到连续两轮无问题；第五轮之后只接受 Critical 修复。

浏览器 UI 重连、回放分页、保留窗口/resync、慢消费者溢出、进程崩溃恢复、自动续跑、
Shell/provider 控制和原生 Windows 执行验证不在本切片内。读取屏障使用普通文件；
当前进程夹具仍依赖 POSIX 进程清理。
D3 现有测试继续覆盖更广泛的回放契约。没有尚未解决的设计问题。
