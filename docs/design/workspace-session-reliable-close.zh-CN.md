# Workspace 绑定 Session 的可靠 close

[English](workspace-session-reliable-close.md) | [简体中文](workspace-session-reliable-close.zh-CN.md)

本设计保留 L1/L2 与可靠 close 的原有协议。新接纳的 ACTIVE files 会话 close/delete 采用 [L3 设计](workspace-session-active-delete-l3.zh-CN.md)：close 仅运行 SessionEnd，delete 顺序运行 SessionEnd 与 SessionDelete，先提交 Hook 证据再永久停机。CLOSED/ARCHIVED 的 L2 删除仍不依赖 Harness；升级前接纳的 operation 按原版本恢复。

## 状态与范围

已实现并完成本地验证。本切片通过现有 public 和 WebShell lifecycle operation，为空闲的公开 `hosted-workspace-files/1` Session 开放 close。运行中、取消中、已接受或等待审批的 Turn 仍返回 `409 turn_active`。Shell、MCP、archive/delete 和新增 UI 按钮不在范围内。close 保留历史、Artifacts 和共享 Workspace 文件。

## 问题

D4 持久接纳生命周期操作，但拒绝 Workspace 绑定。Embedded Broker 的 drain 只在内存记录退休 Session，不停止 worker。纯文本 Turn 结束时后台 warm 可能仍在创建 worker。writer 租约过期或替换后的 Harness 返回 404，都不能证明物理资源已清理。

## API 与准入

沿用 close 路由，返回 202 和原 actor 范围的幂等 operation。当前有读权限的 Workspace 创建者可以接纳 close；不可读返回 404，可读但非创建者返回 403。幂等重放先于生命周期状态校验。在公共 Session 锁内检查活跃 Turn 和未完成操作，持久保存 operation，并将 ACTIVE 改为 CLOSING。新 writer acquire 先取得上游输出保留的 tenant 锁并检查退休状态，再依次锁公共 Session 和 journal；绑定会话非 ACTIVE 时拒绝获取新 writer。已有 writer 可续租、完成结算并 seal。requested Action 仅在保存的 expiresAt 按数据库时间仍未过期时阻止接纳；过期或缺失过期时间的 Action 保留历史，不得让空闲 Session 永远无法关闭。

新增可选能力 `session_close` / `sessionClose`，缺省 false。绑定 close 仅对支持持久 local-process 停机证明的 files/1 开放；`session_lifecycle` 保持 false。完成时将 CLOSING 改为 CLOSED，发出既有 close 事件并确认 operation。已接纳的清理使用保存的身份，权限或挂载变化不影响继续处理。

Harness prompt 和既有 Runtime 恢复准入路由在本地 close 开始后拒绝新请求，包括等待归还接管 Runtime 租约期间。恢复路由在异步授权后重新核对原 attachment 和 closing 状态；已 detach 或被替换的 attachment 不能接纳迟到的继续或取消请求。这保留上游 Turn 恢复边界，不为 close 增加恢复编排。

能力位表示部署支持，不代表 actor 已获授权；创建者和读权限在接纳时检查。不支持关闭的实例接管已接纳的绑定 close 时，返回 recovery_blocked 和 workspace_close_identity_unverified，并保留 CLOSING，等待能够核对原停机证明的实例继续处理。

## Broker 栅栏与释放

在既有 tenant placement 锁下持久保存永久 tenant/Harness-Session drain 栅栏。binding 创建及新 Session/execution 准入在同一锁域检查栅栏。栅栏在资源退休后仍保留，阻止延迟 warm 创建新代际。既有 receipt 仍可读。close 同时预约已有的进程内 binding operation 槽，避免复用同一 Broker 正在 provisioning 的 claim。

栅栏查询在取得 placement 锁后进行普通读取，避免缺失行上的 InnoDB 间隙锁阻塞其他租户插入栅栏。Execution 准入在准入事务之外读取不可变的 binding tenant；事务的首次一致性读发生在取得锁之后，避免 REPEATABLE READ 隐藏等待期间已提交的栅栏。

按 tenant、Session isolation class 和 isolation key 分页枚举保存的 binding 代际；身份按字节精确匹配，不依赖数据库排序规则。标记 draining 时不重新授权当前 Workspace 执行。按精确 binding/generation 枚举 Runtime Sessions，使用保存的记录按顺序释放：provider release、activation=false 确认、条件释放原 holder、持久 RELEASED。close 不进行 acquire、安装、执行重放或模型调用。未知执行或启动身份阻止完成。没有活跃 Runtime Session 或 execution 的 LOST binding，可以经过同样的 holder 检查与持久停机凭据完成退休；提交凭据并进入 RELEASED 前保持 LOST。有未结算资源的 LOST binding 仍需要恢复。原 worker 不可用且仍有未释放的 Session 时返回身份失败并阻塞，不进入通用租约恢复。共享存储上的新 holder 必须保留。

## Worker 停机与完成

新增缺省拒绝的 `RuntimeProvisioner.stopDrained(binding)` 和独立 `RuntimeDrainReceipt`，在 binding 上持久保存。既有丢弃资源的 release 语义不变，正常停机不归类为 JOURNAL_LOST。只有已排空的文件 profile worker 可以产生该凭据。已配置的同主机可信重启策略也可证明原 boot 已停止；持久保存退休和 drain receipt，不向其他 boot 的 PID 发信号，不生成丢失证据。已保存 handle 却缺少 registration、外部主机或不可信 boot 仍保持阻塞。这不会绕过仍活跃的逻辑 Session 释放，也不新增通用恢复编排。

持久 local provider 在永久 registration 锁下校验 seed、handle、host/boot/namespaces 和 PID/start identity。先退休原 registration，再向精确进程发送信号；TERM 后等待 5 秒，必要时 KILL 后再等待 5 秒，并确认进程已消失。INTENT 可不启动进程而退休。尚未保存 handle、lease 或 attestation generation 时，local 启动尚未跨过 Broker 的 handle 提交屏障。drain claim 阻止迟到的启动回调；provider 可在永久锁下为原空目录创建并退休 INTENT，持久保存正常 drain receipt。已有锁却缺少有效 registration 时仍保持阻塞。原 boot 内没有持久 PID 的 LAUNCHING 保持阻塞；已保存 handle 却缺失 registration 或不可验证身份也保持阻塞。重试不能创建替代 worker。

binding 退休前必须确认：无活跃逻辑 Session、无未结算 execution、原代际 holder 已消失、停机证明已持久保存。公共完成还要求持久 close 栅栏和无数据库时间下的有效 journal writer。writer 检查锁住 journal head，等待正在提交的续租、结算或封存事务，再核对数据库时间；未提交的续租不能被误判为 writer 已过期。租约使用数据库时间并续租，阻止旧 claim 提交完成。每个 binding drain 使用既有四倍租期的 operation 超时；超时后停止续租，尽力释放 claim，并允许重试。迟到回调不能提交 binding 退休。DRAINING 在停机证明允许 RELEASED 前持续阻止原 storage 或 canonical directory 的竞争 placement，包括停机失败后。临时故障沿用退避重试；身份或执行结果不明时暴露 recovery_blocked 和稳定 failure code，生命周期恢复仅核对原资源。通用 Runtime maintenance 跳过已封闭的 binding，避免将正常退休伪造成 JOURNAL_LOST；已记录 LOST 证据仍可沿用既有 recovery/operator 路径完成清理。

## 实现区域

Managed Agent lifecycle service/store/coordinator、capabilities、权威 OpenAPI 与生成的 WebShell 类型；Runtime Broker repository/service/provider 与 schema；Hosted Harness 准入和同目录测试。close 迁移使用 V32，接在主干 V28 Hook admission 索引、V29 回填、V30 工具输出保留及 V31 workspace recovery bundle 迁移之后，SQL 字节不变。public 和 WebShell capability 同时保留上游 Artifact 读取与可选 close 支持。不新增 lifecycle orchestrator 或大范围核心重构。与 [#12867](https://github.com/QwenLM/qwen-code/issues/12867) 对齐生命周期契约，与 [#12740](https://github.com/QwenLM/qwen-code/issues/12740) 对齐 Harness 恢复。

## 验证与验收

覆盖正常关闭、无 Runtime、重复幂等键、actor 隔离、两个入口、活跃和待审批 Turn 拒绝、延迟纯文本 warm、启动中关闭、多 Runtime Sessions、release/stop 响应丢失、完成前崩溃、第二服务接管、权限撤销和挂载失效、旧 claim/callback、未知结果及保留新 holder。运行 build/typecheck/bundle、定向 TS/Java 测试、SQL 并发测试；有可信 Linux 身份的环境中运行真实持久 worker 测试。如实记录环境限制。

只有准入已永久封闭，原 writer、Sessions、worker 和 holder 全部结算，close 才算完成；历史数据保留。[维护者的 F1 报告](https://github.com/QwenLM/qwen-code/pull/13135#issuecomment-5945097553)仍有一项接纳前策略待决定：原命名空间已经不可验证时，当前仍会接纳 close，保持 DRAINING 并阻塞同存储的其他 Session。接纳前拒绝已知失效条件，还是明确部署限制，等待作者选择；本次集成更新不改变准入或放宽停机证明。

MySQL close 测试为每个测试使用独立数据库，不能提前迁移共享库而破坏旧数据的分级升级测试。并发回归要求栅栏提交后所有等待中的准入均被拒绝，并要求无栅栏记录的查询尚在事务内时，其他租户仍可完成栅栏写入。移除数据库隔离、placement 锁或取得锁后的快照顺序，都必须让这些检查失败。

本地已通过 build/typecheck/bundle、定向 TS/Java 测试、真实 MySQL 准入与 claim 并发，以及注入测试主机身份的真实 POSIX worker 停机。既有 Hosted 文件与审批 E2E 通过。持久 close E2E 在 macOS 本地实际跳过；后续 Linux CI 已通过包含生产 host/boot/PID namespace 校验的正常 close 验收。完整物理恢复故障矩阵仍未执行。审查回归补充挂起 stop/reconcile/release 的有界超时、第二 Broker 接管和迟到回调，JDBC 与内存中的 pending/failed drain placement，偏移应用时钟下的数据库时间审批过期判断，关闭期间的 prompt 错误码，以及模拟可信与不可信 boot 身份；模拟重启不代表物理重启覆盖。上游 #13037 已实现公开 Artifact 读取，其 API 回归验证 writer seal 且 Session CLOSED 后仍能读取已提交内容；close 路径保留这些行和对象。这些读取回归补充原有 close 对历史、resources 和文件的保留断言。命令与详细结果记录在 `.qwen/e2e-tests/workspace-session-reliable-close.md`。
