# Managed loop CI 验证

[English](./2026-11-14-managed-loop-ci.md)

## 范围

实现 #17045 的 M 块 CI 子项。通过两个打包进程场景，证明搭在其他入口上的 Managed 路径在共享循环开启时仍实际执行。Hosted Harness 自有循环的评估属于另一项。

## 路径与证据

1. Hosted workflow 子 Session 接收带定义摘要的 `workflow_launch`。脚本调用 `agent()`，实际经过 WorkflowRunner、AgentHeadless 和 AgentCore，连接本地受控 provider。测试断言最终 workflow 结果及实际执行的 AgentCore 循环日志。Hosted workflow 明确禁止子代理工具，因为它们会访问 Harness 主机而非 Session 工作区；测试检查没有对模型声明工具。因此该路径验证推理和完成，不验证 Hosted 工具批。
2. 普通 daemon 开启双引擎并创建 Managed 会话。落盘记录必须证明会话归 Managed 所有，退回 Legacy 会失败。本地 provider 请求实际读取文件，收到唯一文件标记，轮次正常完成。ACP 共享模型轮和共享工具批入口的调试日志证明对应路径实际执行。

两种模式均显式开启共享循环。`shared` 关闭事件总线开关；`kernel` 同时开启事件总线开关。AgentCore 已有日志可以区分这两种执行。ACP 当前在两种模式下均执行共享模型轮和工具批：它的事件总线迁移是 #17045 中由其他人负责的子项。双开关开启不代表 ACP 已运行在事件总线内核上。该迁移合入时，应随实现同步更新路径证据。

## CI 接入

独立的 `managed-agent-loop.yml` 在相关 PR、main push、nightly 和手动触发时执行。两个矩阵任务分别使用本次 checkout 构建的打包 CLI，串行运行两个场景，关闭重试，不依赖 Java gate 的 `none`/`fast`/`full` 分级。仅授予读权限，无需服务密钥；PR 代码使用一次性 runner，或托管 runner 回退。

每个任务要求恰好两个测试通过、没有跳过项，并且两个入口都有通过的证据文件。即使失败，也上传协议请求、进程输出和实际循环日志。缺失构建产物、启动失败、退回 Legacy、缺失执行证据或测试跳过，均不能变成验证成功。

## 边界与验收

模型使用本地受控 OpenAI-compatible 服务。Hosted HTTP store fixture 使用真实本地 journal 实现，不证明 Spring/MySQL 行为。这些场景证明路由、一次工具轮和正常结束；不替代取消/恢复、writer lease 故障测试、跨平台验收或真实 provider 测试，也不意味着 Managed Java gate 已满足成为必需检查的条件。

验收要求两种模式均实际通过两条路径，并保留证据产物。默认值仍由 B 块负责，本项不修改默认值。测试失败应先从首条失败断言或进程日志分类，再调整放开决定。
