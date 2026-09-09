# 后台 Agent 进度看门狗

[English](background-agent-progress-watchdog.md)

## 问题

普通后台 Agent 可能在模型、控制流或某个工具长期没有进展时仍保持运行状态。现有 workflow 看门狗会重试停滞工作，并在任一工具运行期间暂停期限，不适用于这里。普通后台 Agent 应当只以失败状态结算一次。

## 行为

每个新建、恢复及 resident continuation 的后台 turn 都有两个固定的内部期限：

- 模型或控制流 15 分钟无进展。
- 每个执行中工具 10 分钟无进展。

模型流式输出、round 状态变化、用量更新和外部输入会续期模型期限。工具输出和存活心跳只续期该工具的期限。qwen-code 显式上报的重试延迟最多将模型期限延长 6 小时；provider 内部重试仍受普通期限约束。工具期限从调度器报告工具开始执行时起算，因此静默工具不会计入模型期限，并行工具各自计时。

等待用户审批时，相关工具期限由模型期限接替。模型期限仅在无工具 round 真正进入 Monitor 所属的外部输入等待后暂停，并在收到输入后恢复。因主机挂起或本地事件循环间隙而延迟的计时器会重新计时，不会把这段时间算作 Agent 停滞。

期限到达时，看门狗以 `AgentProgressTimeoutError` 中止 turn。可协作中止的模型和工具路径把原因映射为 `TIMEOUT`，后台 registry 与 sidecar 只结算一次 `failed`，不做重试。定义级别的 turn 数量和总耗时限制保持不变。

## 范围

Workflow 调度保持不变。若 Agent 忽略协作式中止，它会继续占用物理槽位，同时 daemon 排空并替换该 Session 的 runtime generation，详见 [后台 Agent runtime generation](background-agent-runtime-generations.zh-CN.md)。
