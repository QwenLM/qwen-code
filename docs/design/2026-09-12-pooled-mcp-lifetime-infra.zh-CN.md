# 池化 MCP 连接的生命周期与销毁加固

[English](./2026-09-12-pooled-mcp-lifetime-infra.md) · 关联 Issue：https://github.com/QwenLM/qwen-code/issues/11272

## 状态

本改动从 #11392 中拆出，是评审建议拆分后的前半部分，覆盖按需恢复将要依赖的池归属与销毁路径。其中有一处会改变线上行为：池管理的 client 现在会把意外的 transport 关闭反映到状态上，从而逐出 entry 并移除该 session 的 MCP 工具。本改动不重新获取任何连接；针对 issue #11272 的恢复改动单独进行。

## 问题

传输连接池假设共享连接只在配置变化或显式关闭时被替换。因此它有三条规则仅在该前提下成立，而当父 agent 与派生子 agent 在同一个逻辑 session id 下共享一个池时，这三条都会暴露：

- 订阅只按逻辑 session id 记账，于是子 agent 的注册表与父注册表落在同一个键上。获取第二个注册表会覆盖第一个的 view，释放其中任意一个都会丢掉共享引用。
- 释放只报 session，因此一个被取代的 handle 可能 detach 掉接替它的连接。
- entry 在销毁**开始**时就从池索引移除，而不是在结束时，因此并发 acquire 可能在旧进程尚未退出前，为同一连接指纹启动第二个进程。

另有一处：被 EOF 杀掉的 stdio server 此前是不可见的——SDK 在该路径不会调用 `onerror`，于是 entry 保持 `active`，工具仍注册在一个已死的 transport 上。而且 SDK 的关闭路径没有超时，挂住的 transport 会让销毁永远无法结束。

## 目标

- 当连接被替换、或由多个注册表共享时，让池归属与销毁顺序正确，同时不改变健康路径上的现有行为。
- 为池管理的 client 检测意外的 transport 关闭，使掉线可观测并逐出其 entry。

## 非目标

- 重新获取失败连接、重注册 session 声明、发出恢复提示。那是 #11272 的后续改动。
- 工作区预算拒绝记账、runtime 新增的串行化、跨注册表继承、重试冷却——在后续改动有调用方之前一律延后。
- 任何新的命令、路由、开关或配置项。

## 设计

1. **按 seat 归属。** 每个池订阅以 seat 为索引——即逻辑 session id 与 `ToolRegistry` 身份的组合。`release` 与 `releaseSession` 按 seat 释放，因此一个注册表无法移除另一个的引用。unpooled entry 同样记录其所属 session。
2. **handle 身份释放。** 连接 handle 携带自身身份，并在释放回调中把自己传回。只有当该 handle 仍是当前绑定到该 seat 的那一个时，detach 才成功。重新 attach 一个 seat 会处置被取代的 handle（清空其监听、标记为失效）；它随后的池释放因身份不符而成为空操作，而唯一的非池化调用方每次 acquire 都新建 entry。
3. **cleanup 屏障。** 关闭连接时，先发布 cleanup promise，再通知订阅者。acquire 会等待同一连接指纹（包括已从索引移除的 entry）的在途清理，其截止时间**不小于**销毁预算加子进程扫描的余量。超时则 acquire 失败关闭并保留屏障，因此绝不会在旧进程尚未退出时启动新进程。
4. **有界销毁。** `transport.close()` 与 `client.close()` 由 `TRANSPORT_CLOSE_TIMEOUT_MS` 约束；`MCP_TEARDOWN_TIMEOUT_MS` 是由它推导出的最坏情况断开预算。子进程在此前已被 SIGTERM，因此超时的 close 不会泄漏进程树。

## 行为变化：意外 transport 关闭现在可见

对池管理的 client（`trackTransportClose`），意外的 SDK 关闭现在会记录 `lastTransportError` 并把 client 状态翻成 `DISCONNECTED`。这会到达 entry 的状态监听器，使 entry 转为 `failed`、发出 `failed`、detach 每个订阅者（每个 `view.teardown()` 移除该 session 的 MCP 工具），并把 entry 从池中逐出。

改动之前，被 EOF 杀掉的 server 不可见：entry 保持 `active`、状态保持 `CONNECTED`、工具仍注册在已死的 transport 上。改动之后，状态翻转且工具被移除——可通过 `/mcp`、`GET /workspace/mcp` 以及模型的工具列表观测到。这是 #11272 的检测那一半；重新获取是后续改动。

## 不变量

- 一次释放只能移除它真正拥有的 seat 与 handle。
- 在同一连接指纹的旧连接仍在销毁时，不会启动第二个同名连接。
- 销毁有界，因此 cleanup 屏障一定会结束。

## 风险与限制

- 在旧的销毁进行期间，acquire 最多可等待"销毁预算 + 余量"；超时则失败关闭而非跨过它启动新进程。若某次销毁（有界地）永不结束，该 server 在 drain 或进程重启前不可用；本改动不提供强制绕过通道。
- 在恢复后续落地之前，死掉的池连接会保持断开：工具被移除，且没有任何东西重新获取。
- seat 与 handle 语义要求调用方把 handle 传给 `release`。省略 handle 的既有调用方会释放该 session 的所有 seat，即此前行为。

## 验证计划

- 单元测试：同一逻辑 session 下两个注册表的 seat 隔离、handle 身份 detach 与被取代 handle 的处置、cleanup 屏障（含超时与 draining）、退役记账、`onclose` 驱动的状态转换。
- core 包 `tsc --noEmit` 与受影响套件通过。
- 两个 seat 测试覆盖了上述父/子 agent 别名路径，并在旧的"仅按 session 记账"下失败。

## 验收标准

- 现有连接池与 MCP client 测试通过。
- 新增测试钉住上述每一条不变量，且别名回归在旧记账下可复现。
- 没有新路由、命令或配置项；没有被延后的原语的生产调用方。

## 后续

按需恢复（#11272）：在模型发送前重新获取失败连接并重注册 session 声明，且不重放被中断的调用。被延后的原语——按指纹的重试冷却、工作区预算拒绝保留、原始配方访问——随它有调用方时一起落地。
