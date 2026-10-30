# Hosted 进程崩溃故障门禁（FG6c）

[English](hosted-process-crash-fault-gates.md) | [简体中文](hosted-process-crash-fault-gates.zh-CN.md)

## 问题与现状

Issue #12872 要求对打包后的 Hosted Harness、Spring Session Store 和 Runtime
Broker，以及真实 managed worker 提供进程崩溃证据。FG6a 和 FG6b 已覆盖响应丢失和
Store 提交失败，但它们的 Spring 夹具仍位于测试 JVM 内。正常关闭不能证明 SIGKILL
行为。

实际工具执行顺序为 prepare、持久化 intent、`await_runtime`、start、结果消息以及
`results_ready`。因此 prepare 后立即崩溃，可能留下预留和已接受输入，但还没有
持久化工具 intent。

## 测试方案

新增独立 Java 集成测试、Spring 子进程夹具和 TypeScript 驱动，使用打包后的 CLI、
确定性模型和真实文件 Edit 工具。每个场景使用独立租户、已保存工作区、Session 和
运行时目录。数据库必须确认是 MySQL 或 MariaDB，不能以 H2 代替。

| 场景              | 边界                               | 预期持久化状态                              |
| ----------------- | ---------------------------------- | ------------------------------------------- |
| `harness-prepare` | prepare 成功响应尚未交给 Harness   | 一次预留，无派发、无 intent                 |
| `harness-start`   | start 成功，真实工具尚在执行       | 一次派发、`await_runtime`、无结果提交       |
| `harness-result`  | 工具结果消息提交请求尚未到达 Store | 一次已完成效果、`await_runtime`、无结果提交 |
| `spring-kill`     | 真实 worker 正在执行工具           | 杀死 Spring，并使用同一数据库重启           |
| `worker-kill`     | 真实 worker 正在执行工具           | worker 收到 SIGKILL；未知结果保持阻塞       |
| `worker-stop`     | 真实 worker 正在执行工具           | worker 收到 SIGSTOP；未知结果保持阻塞       |

必须通过 worker 内的文件读取屏障证明已进入原生 Edit，再注入信号。不能用猜测时间、模拟
worker、伪造结果或产品调试端点代替证据。测试控制器负责信号和清理；HTTP 代理除
所选 Harness 崩溃边界外，转发真实 Store/Broker 数据。Spring 使用正常应用装配，
在独立 JVM 中运行。测试启动代码只创建已保存 Session 并公布监听地址，不增加
产品路由或恢复行为。

所有场景均使用内容为 `x` 的普通文件 `proof.txt`。执行中的场景在备份准备后、
转发 start 前创建 `proof.txt.read-gate`。worker 导入
`hosted-file-read-gate.mjs`，在原生 Edit 读取时写入 `proof.txt.read-entered`，
等待 gate 消失后再调用原 `fs.promises.readFile`。`harness-start` 在杀死
Harness 后删除 gate，让 Edit 写入 `xx`。Spring/worker 场景在断言期间保持
gate，因此普通文件仍为 `x`，没有产生效果。不替换工具结果或实现。

Spring 丢失后持久化执行保持 `EXECUTING` 且没有结果；重启后的本地 provisioner
不能接管孤儿。worker 丢失或暂停后，在真实传输失败或超时后变为 `UNKNOWN`。
两种状态都保留原 owner 并拒绝续跑。SIGSTOP 场景覆盖真实的 30 秒传输超时。

Spring 场景在重启前让 Store 停机八秒，超过 Harness 的五秒 writer 租约。
它的实时 transcript 可以返回 `503 managed_transcript_unavailable`；若返回 `200`，
每一页仍必须没有 Turn 终态事件。worker 场景必须返回 `200`。这个例外不放宽
独立 SQL 台账检查，也不放宽下文要求的准确冷加载拒绝。

## 断言与恢复边界

记录进程身份和实际信号退出。使用新的 boot 身份重启 Harness，等待短 writer 租约
到期。冷加载必须读取原始 SQL 日志，返回 `409 hosted_turn_recovery_required`，且
不得再调用模型、prepare 或 start。加载被拒绝后不要求提供存活 Session 状态。
加载尝试可能改变 activation 记账。

通过独立 JDBC 检查原始 prompt/runtime/execution/idempotency 身份、派发代次、
已接受输入、checkpoint 阶段以及不存在终态事件。所选边界的工具结果提交尝试必须
没有进入 SQL。工作区物理证据必须显示最多一次效果；把 `x` 改为 `xx` 的 Edit 若
被重放会变成 `xxxx`。Harness 主目录放置诱饵文件，已保存工作区的父目录保持不变。

崩溃和重载期间必须始终保留原存储 owner。夹具不得回收或接管 owner。SIGSTOP
清理必须恢复或杀死并回收准确的 worker；失败和成功路径都要清理所属子进程和
监听器。父夹具负责 worker 退出清理；不能只为完成清理而放行未知 Edit 的读取 gate。

## 范围、文件与风险

修改限于测试夹具、Java 集成测试 profile 和 CI 时间预算，以及这份双语设计。
保留现有响应丢失和 Store 失败门禁。POSIX 信号和进程清理要求 Linux 或 macOS；
Hosted 数据库门禁在 Linux CI 中运行。本增量不覆盖 Windows 进程崩溃测试。取消
语义、SSE 重连、Shell/provider 效果、自动续跑、孤儿接管和 W0e 回收不在此门禁
覆盖范围内。

接受屏障证据前必须在真实工具中验证它。即使文件没有产生效果，进程丢失仍可能
留下未知执行结果；测试不能把未观察到效果解释成允许重放。进程时限必须给真实
传输的不确定结果超时留下空间，同时限制 CI 总执行时间。

## 验证与验收

构建、类型检查并打包仓库；运行相关 Hosted 测试，并在真实 SQL 上运行全部六个
崩溃场景。独立核实每个信号注入及其持久化证据。删除产品中未结算输入的准入
保护，保持故障注入不变，要求每个场景都因行为断言失败。必要时增加针对
checkpoint 和未知结果保护的突变验证。恢复源码后重新运行正常门禁。

对完整差异进行无方向和反向审计，直到连续两轮干净。第五轮之后仅纳入 Critical
修复。当前没有未决设计问题；实现中的观察和已验证限制必须同步更新到两个语言
版本。
