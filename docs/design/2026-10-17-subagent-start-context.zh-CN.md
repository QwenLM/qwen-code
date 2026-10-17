# SubagentStart 上下文传递

[English](2026-10-17-subagent-start-context.md) | [简体中文](2026-10-17-subagent-start-context.zh-CN.md)

## 问题与范围

Issue [#14477](https://github.com/QwenLM/qwen-code/issues/14477) 报告：
`SubagentStart.additionalContext` 被存入 `hook_context`，但除非代理的系统提示词显式引用
`${hook_context}`，内容不会进入首次模型请求。前台启动、后台启动和冷恢复都有这个遗漏。
常驻代理的后续轮次已经向 `task_prompt` 追加上下文，但结构化外部输入会绕过这个字段。

本修复传递已有的 Hook 输出，不新增 Hook 事件、设置或执行器 API。容器启动继续跳过父侧代理
Hook。不触发 `SubagentStart` 的工作流派发和内部 fork 辅助入口不在本次范围内。

## 传递方案

在 Hook 调用处、把上下文交给执行器之前应用输出。共用辅助函数保留 `hook_context`，并向实际
执行输入追加输出：存在 `external_inputs_override` 时使用它，否则使用 `task_prompt`。

首次执行时，显式使用 `${hook_context}` 的系统提示词模板继续决定放置位置，不再向任务追加
一份相同内容。后续常驻执行始终使用新输入，因为系统提示词已经渲染过。Fork 通过输入传递上下文，
保留继承的系统指令和历史。空输出和 Hook 失败保留现有任务及失败处理行为。

原生代理冷恢复的首次执行保留完整 `ContextState`，包括结构化输入和模板上下文。常驻启动路径
中的结构化输入通过 `executeExternalInputs` 派发，该接口也支持 ACP 执行器。结束阶段排空的
输入保留现有生命周期，不额外触发启动 Hook。

## 消费者与验证

- 前台原生代理和 ACP/Codex 代理接收完整输入；显式自定义模板继续渲染保留的 `hook_context`。
- 后台原生、fork 和外部执行器启动使用同样的传递规则。
- 常驻原生和 ACP 轮次通过字符串或结构化输入接收当次 Hook 输出。Codex 不支持常驻续跑。
- 原生和 fork 冷恢复接收新的上下文。持久化的外部执行器和容器恢复继续不受支持。

回归测试必须检查执行器输入，而非仅检查 `hook_context` 中的存储。覆盖首次启动、模板放置且不
重复、fork 前缀保持、冷恢复、常驻字符串/结构化输入，以及空输出和失败的 Hook。使用真实 CLI、
命令 Hook 和本地 OpenAI 兼容服务端，在 macOS 和 Docker Linux 上确认首次子代理 HTTP 请求
包含标记。模拟模型验证的是内容传递，不是模型是否遵守注入指令。
