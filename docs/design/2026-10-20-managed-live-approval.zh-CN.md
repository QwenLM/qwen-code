# Managed 在轮次执行中修改审批模式

[English](2026-10-20-managed-live-approval.md) | [简体中文](2026-10-20-managed-live-approval.zh-CN.md)

## 状态与行为

已实现并完成本地验证，本地部署已更新。与当前 daemon 输入框一致：修改执行审批模式会影响当前轮后续的权限检查。Full Access 也会放行正在等待的普通工具审批；Auto Edit 会放行待审批的文件编辑。已经派发的工具不取消、不重放。手动切换 Plan 仍是单独的空闲时设置，显式 Hook ask/deny 和退出 Plan 的审批保留原有含义。

此前实现会在用户轮次准入时固定审批策略，并在执行中拒绝修改。保留该准入快照不可变，继续用于重复请求身份和恢复。新增读取既有持久化 Session 选择的能力，不重写已准入输入，也不建立第二份策略存储。

## 控制面与执行

Harness 宣告 `live-approval-selection/1`。已有审批选项响应新增可选 `liveSupported`；缺失时旧提供方继续仅允许空闲时修改。只有持有当前 Workspace OPERATOR 权限的会话所有者，且 Harness 支持该能力时，才能在普通轮次执行或等待审批时修改执行策略。保留 revision CAS、幂等回执、原始定义、Workspace 注册事实、生命周期和恢复屏障。修改 Plan 继续使用原有空闲门槛。开启执行中修改前必须升级所有 Java/Broker 写入方。

在既有 Managed Session Store 接口新增内部 `approval:query`。它在 Session 锁下校验租户、Workspace、writer 凭证、当前 writer generation 和租约，以及普通 Session 准入，然后从 SQL 读取当前生效的模式与修订。HTTP store 客户端复用既有 writer 传输。读取失败、缺失、格式错误或修订倒退都会阻断工具准入；不得退回过期且更宽松的策略。

符合条件的 Hosted 工具轮次在每个审批边界前读取该选择，保留准入时的超时和 Plan 状态。不可变轮次快照提供最低可接受修订。已越过审批边界的工具保留原决定，与 daemon 一致。恢复重新读取持久化 SQL，Harness 替换不能恢复旧模式。活跃轮次的准入修订早于当前选择时，控制面的挂载要求 live 能力。在维护窗口共同升级控制面和 Harness：新 Harness 会拒绝旧控制面缺失的 live 读取，重新开放执行前必须隔离旧 Java 写入方。

等待普通 Action 时，以有界异步轮询重新检查策略。新模式允许该工具时，通过已有持久化 `allow` 决策解决准确的请求并唤醒等待方。不得覆盖已有拒绝、过期或取消。强制 Hook ask 和退出 Plan 的 Action 不参与自动放行。用户明确允许退出 Plan 后，以同一仍活跃的原始轮次身份清除 Plan 覆盖层；期间切换执行策略增加的修订不阻止退出，已结束或取消轮次的旧决定不得清除后来的 Plan。工具是否获准仍以 Action 日志为准；选择模式不等于合成一份工具完成结果。

新 Tool Hook occurrence 使用当前实时模式。历史 Hook 校验与重放保留每次 occurrence 当时记录的模式，包括结果和批次 Hook。只保留摘要的拒绝计划，仅在完整语义输入摘要匹配时恢复一个合法模式；工具输入、响应和 Hook 顺序仍完整校验。中断后的 Skill 拒绝恢复复用同一证明。

## 浏览器与涉及范围

复用已有持久化审批意图与回读 hook。仅在 `liveSupported` 存在时，在执行和等待阶段开放执行模式菜单；取消、恢复以及未确认操作继续阻断，保留草稿。执行模式控件开放时，Plan 控件仍在活跃轮次中单独禁用。提示文字说明当前轮生效。旧提供方保留下一轮提示和空闲控件。

改动涉及 Managed Store 准入与内部控制器、Harness 能力协商、HTTP writer 客户端、Hosted 审批与工具执行、WebShell 选项/hook/输入框、生成的 API 类型及对应定向测试。不新增 schema 迁移、公开 REST 操作、工具类型或运行时权限。

## 验证与验收

先核对当前 daemon 源码和定向测试。覆盖双向执行策略切换、同轮后续工具、等待中的普通文件/Shell 审批、强制 ask、Plan 边界、准入身份不可变、writer 隔离、过期修订、响应丢失与浏览器草稿保留。在 MySQL 8.4 上验证 SQL 准入/修改并发与重复回执，用受控 Hosted 工具证明实际副作用仅发生一次。执行受影响单元测试、Java verify、契约检查、根 build/typecheck/bundle、格式检查、连续两次干净自审及独立评审。无法运行的进程/平台检查单独报告；mock 测试不构成生产验收。

## 待决事项

无。确认 daemon 会即时影响当前轮权限检查后，用户要求与之保持一致。
