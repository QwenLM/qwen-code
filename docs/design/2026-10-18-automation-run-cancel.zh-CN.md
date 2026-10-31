# 取消一次 Managed Automation 运行

[English](2026-10-18-automation-run-cancel.md) | [简体中文](2026-10-18-automation-run-cancel.zh-CN.md)

## 状态与问题

这是 [#14460](https://github.com/QwenLM/qwen-code/issues/14460) 的拟实现设计，基于 main `b3c5d3ed1e67`。Automation 运行已投影为任务，但不能声明或接受取消。现有运行结算已经能将已提交的 Turn 结果映射为 `cancelled`。

## 目标与边界

通过现有公开和 WebShell 任务入口取消一次运行，保留定时定义、后续触发、同级运行以及无关前台 Turn。`automation.enabled` 默认仍为 `false`。不增加公开路由、操作种类、记录字段、数据库迁移或 UI 控件。通用 `CANCEL` 恢复、Automation 可观测性、`per_run` Session 和完整 FG11 故障轮次仍单独处理。

## 设计

### 控制面

将 `automation_run` 纳入可取消的任务种类。持久受理、鉴权、幂等和操作租约继续使用 `TASK_CANCEL`。协调器通过私有 Automation 操作 `cancel_run` 指定原 run、schedule 和 occurrence；Hosted 路由先校验这个不可变组合派生的就是指定 run，再寻址它的 Turn。身份不匹配时拒绝请求，不取消任何运行。Hosted 连接器使用停止鉴权和被动挂载，不走新工作鉴权或整个 Session 的取消接管。重新加载可能在 Hosted 接受停止前启动排队运行；Java 受理本身不承诺已物理取消。

### Hosted 权威

取消与 Automation 漏斗的触发、结算写入串行化。仍处于 `intent` 的认领可以直接结算为 `cancelled/not_started_proven`，因为没有受理输入。已派发运行提交针对其 Turn 的 `cancel.requested` 事件，按原运行身份合并。这证明权威接受，不代表物理结算。追加完成后，只中止当前 prompt 身份与目标 Turn 匹配的控制器。

唤醒执行器在异步读取尝试记录后，持有 Turn 槽位并在调用模型前重新读取已提交的取消。尚未尝试且已取消的输入不调用模型，写入自己的取消 Turn 结果，再沿用正常运行结算。如果此写入失败，释放槽位，由调度器重试同一输入，不阻塞 Session，也不伪造错误结果。排队输入等待其他活动 Turn 结束，不中断它。重新打开时再次从日志派生取消。已经尝试的输入保留现有中断 Turn 恢复路径；没有活动控制器不能证明取消。

### 证明与竞争

Java 仅在已提交的 `automation_run` 为 `cancelled` 时完成此种取消操作。网络确认或控制器缺失都不能完成操作。自然完成或失败的结果优先且保持不变，操作报告 `task_already_settled`。响应丢失后仍重试同一目标，运行结算写入丢失则从原 Turn 结果对账。结果无法证明时保留现有有界重试和 `recovery_blocked` 仅凭记录对账；停放操作绝不再次投递。

唤醒执行器同步认领槽位并检查取消，中间没有 await。在认领后到达的取消先提交请求，再中止匹配控制器。更早到达的取消在启动模型前被执行器读到。已尝试运行若在崩溃后没有终态证据，继续遵守现有真实的 `failed/outcome_unknown` 恢复语义。

## 受影响组件

控制面的任务投影、取消协调器和 Hosted 连接器路由停止。Hosted Automation 漏斗提交停止，共用唤醒执行器消费排队取消。OpenAPI 的任务能力说明和生成的 WebShell 类型描述新能力。现有任务 UI 和 SDK 入口无需增加 API。针对性测试覆盖各层及实际 Hosted 路由。

## 验证与验收

先以全局 `qwen` 尝试 E2E 基线，再验证本地 bundle 和 Java 服务。覆盖仅认领和排队取消、匹配活动运行的取消、同级和前台隔离、自然完成竞争、重复请求及重开、未知结果恢复、鉴权、公开与 WebShell 幂等和停放对账。执行受影响 TypeScript 测试、根目录 build/typecheck/bundle、Java 针对性测试和 `mvn verify`；使用一次性 MySQL 8.4 和匹配的 Hosted profile 获取集成证据。明确记录无法执行的平台或已部署环境验收。

[#14446](https://github.com/QwenLM/qwen-code/issues/14446) 的 FG11d 应改为验收单次任务取消和定时定义不变，不再期待 `task_action_unavailable`。提交 PR 时同步该 tracker，但不声称已经完成整轮故障验收。

## 风险与待定问题

主要风险是跨异步边界取消或结算了另一 Turn，由不可变目标身份和唤醒槽位防护。无关工作占有 Session 时，排队取消可能保持待处理。取消确认可早于物理结果，此种任务的公开凭证则有意等待已取消运行的正向证据。没有待定契约决策。
