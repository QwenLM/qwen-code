# Workspace 绑定 Session 的可靠 close

[English](workspace-session-reliable-close.md) | [简体中文](workspace-session-reliable-close.zh-CN.md)

## 状态与范围

已实现并完成本地验证。本切片通过现有 public 和 WebShell lifecycle operation，为空闲的公开 `hosted-workspace-files/1` Session 开放 close。运行中、取消中、已接受或等待审批的 Turn 仍返回 `409 turn_active`。Shell、MCP、archive/delete 和新增 UI 按钮不在范围内。close 保留历史、Artifacts 和共享 Workspace 文件。

## 问题

D4 持久接纳生命周期操作，但拒绝 Workspace 绑定。Embedded Broker 的 drain 只在内存记录退休 Session，不停止 worker。纯文本 Turn 结束时后台 warm 可能仍在创建 worker。writer 租约过期或替换后的 Harness 返回 404，都不能证明物理资源已清理。

## API 与准入

沿用 close 路由，返回 202 和原 actor 范围的幂等 operation。当前有读权限的 Workspace 创建者可以接纳 close；不可读返回 404，可读但非创建者返回 403。幂等重放先于生命周期状态校验。在公共 Session 锁内检查活跃 Turn 和未完成操作，持久保存 operation，并将 ACTIVE 改为 CLOSING。新 writer acquire 先锁公共 Session，再锁 journal；绑定会话非 ACTIVE 时拒绝获取新 writer。已有 writer 可完成结算并 seal。

新增可选能力 `session_close` / `sessionClose`，缺省 false。绑定 close 仅对支持持久 local-process 停机证明的 files/1 开放；`session_lifecycle` 保持 false。完成时将 CLOSING 改为 CLOSED，发出既有 close 事件并确认 operation。已接纳的清理使用保存的身份，权限或挂载变化不影响继续处理。

## Broker 栅栏与释放

在既有 tenant placement 锁下持久保存永久 tenant/Harness-Session drain 栅栏。binding 创建及新 Session/execution 准入在同一锁域检查栅栏。栅栏在资源退休后仍保留，阻止延迟 warm 创建新代际。既有 receipt 仍可读。close 同时预约已有的进程内 binding operation 槽，避免复用同一 Broker 正在 provisioning 的 claim。

按 tenant、Session isolation class 和 isolation key 分页枚举保存的 binding 代际；身份按字节精确匹配，不依赖数据库排序规则。标记 draining 时不重新授权当前 Workspace 执行。按精确 binding/generation 枚举 Runtime Sessions，使用保存的记录按顺序释放：provider release、activation=false 确认、条件释放原 holder、持久 RELEASED。close 不进行 acquire、安装、执行重放或模型调用。未知执行或启动身份阻止完成。原 worker 不可用时返回身份失败并阻塞，不进入通用租约恢复。共享存储上的新 holder 必须保留。

## Worker 停机与完成

新增缺省拒绝的 `RuntimeProvisioner.stopDrained(binding)` 和独立 `RuntimeDrainReceipt`，在 binding 上持久保存。既有丢弃资源的 release 语义不变，正常停机不归类为 JOURNAL_LOST。只有已排空的文件 profile worker 可以产生该凭据。

持久 local provider 在永久 registration 锁下校验 seed、handle、host/boot/namespaces 和 PID/start identity。先退休原 registration，再向精确进程发送信号；TERM 后等待 5 秒，必要时 KILL 后再等待 5 秒，并确认进程已消失。INTENT 可不启动进程而退休。没有持久 PID 的 LAUNCHING、缺失 registration 或不可验证身份保持阻塞。重试继续处理原 registration，不能创建替代 worker。

binding 退休前必须确认：无活跃逻辑 Session、无未结算 execution、原代际 holder 已消失、停机证明已持久保存。公共完成还要求持久 close 栅栏和无数据库时间下的有效 journal writer。writer 检查锁住 journal head，等待正在提交的续租、结算或封存事务，再核对数据库时间；未提交的续租不能被误判为 writer 已过期。租约使用数据库时间并续租，阻止旧 claim 提交完成。临时故障沿用退避重试；身份或执行结果不明时暴露 recovery_blocked 和稳定 failure code，生命周期恢复仅核对原资源。通用 Runtime maintenance 跳过已封闭的 binding，避免将正常退休伪造成 JOURNAL_LOST；已记录 LOST 证据仍可沿用既有 recovery/operator 路径完成清理。

## 实现区域

Managed Agent lifecycle service/store/coordinator、capabilities、权威 OpenAPI 与生成的 WebShell 类型；Runtime Broker repository/service/provider 与 schema；Hosted Harness 准入和同目录测试。close 迁移使用 V27，接在上游工具结果投影的 V26 迁移之后。public 和 WebShell capability 同时保留上游 Artifact 读取与可选 close 支持。不新增 lifecycle orchestrator 或大范围核心重构。与 [#12867](https://github.com/QwenLM/qwen-code/issues/12867) 对齐生命周期契约，与 [#12740](https://github.com/QwenLM/qwen-code/issues/12740) 对齐 Harness 恢复。

## 验证与验收

覆盖正常关闭、无 Runtime、重复幂等键、actor 隔离、两个入口、活跃和待审批 Turn 拒绝、延迟纯文本 warm、启动中关闭、多 Runtime Sessions、release/stop 响应丢失、完成前崩溃、第二服务接管、权限撤销和挂载失效、旧 claim/callback、未知结果及保留新 holder。运行 build/typecheck/bundle、定向 TS/Java 测试、SQL 并发测试；有可信 Linux 身份的环境中运行真实持久 worker 测试。如实记录环境限制。

只有准入已永久封闭，原 writer、Sessions、worker 和 holder 全部结算，close 才算完成；历史数据保留。没有未决产品问题。

本地已通过 build/typecheck/bundle、定向 TS/Java 测试、真实 MySQL 准入与 claim 并发，以及注入测试主机身份的真实 POSIX worker 停机。既有 Hosted 文件与审批 E2E 通过。持久 close E2E 在 macOS 本地实际跳过；后续 Linux CI 已通过包含生产 host/boot/PID namespace 校验的正常 close 验收。完整物理恢复故障矩阵仍未执行。上游 #13037 已实现公开 Artifact 读取，其 API 回归验证 writer seal 且 Session CLOSED 后仍能读取已提交内容；close 路径保留这些行和对象。这些读取回归补充原有 close 对历史、resources 和文件的保留断言。命令与详细结果记录在 `.qwen/e2e-tests/workspace-session-reliable-close.md`。
