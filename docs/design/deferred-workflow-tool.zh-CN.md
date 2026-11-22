# Workflow 工具延迟加载

[English](deferred-workflow-tool.md) | [简体中文](deferred-workflow-tool.zh-CN.md)

## 问题

默认情况下，启用 workflow 后，即使用户没有运行 workflow，Direct 模式请求仍携带完整的
Workflow 描述和参数 schema。已有延迟工具桥接机制支持通过 `tool_search` 查阅
schema，再通过 `tool_call` 调用，无需改变请求中常驻的函数声明。

## 决策

通过 `shouldDefer=true` 将 Workflow 改为默认延迟加载。保持完整描述、参数 schema、
注册条件、编写参考和执行行为不变。启动目录保留现有简短描述。明确的 workflow 意图和
持久 Workflow 模式也按需发现工具，均不自动展示完整 schema。

逐轮调用的 `isToolHiddenBehindToolSearch` 应通过注册表的 `isDeferredAndHidden`
结果识别工具原生的延迟状态。同时保留 permission-deferred lazy factory 的兜底判断，
因为此时工具实例可能尚未构造。保留 CodeModeOnly 排除逻辑：该模式通过 `exec` 调用
发现的工具，不使用 Direct 模式的 `tool_call` 桥。保持独立的 Skill 编写参考构造期
判断不变。

## 兼容性和范围

- `tools.visible` 仍可直接展示 Workflow。与其他延迟工具一致，`tools.eager` 不覆盖
  工具自身的延迟状态。
- 保留现有 schema 预算预加载和桥接工具缺失时的兜底。配置明确要求的延迟与工具原生
  延迟仍分别处理。
  非零预加载预算仍采用全有或全无规则：Workflow 现在计入候选总量，可能使整组延迟工具
  超出预算。默认零预算不预加载工具。
  正常 LLM 初始化会执行 `startChat` 并完成缺桥兜底，随后 Config 才将 Workflow 模式
  标记为就绪、应用初始模式，因此模式激活无需等待首个模型请求。
- 包含直接 Workflow 调用的旧会话可在回放时展示工具；`/clear` 保持现有重置行为。
- 已保存的具名 workflow、name-only 会话、宿主运行和 `/review` 激活保持现有注册及
  执行路径。延迟调用仍遵守目标工具审批、hooks 和子代理限制。
- 无需修改公开 API、配置、参数或持久化格式。其他工具、context-usage 统计和部署不在
  此次改动范围内。

## 验证和验收

使用真实 Workflow 工具进行注册表和发现测试。启用 workflow 的默认请求必须省略完整
声明，保留简短目录条目。精确搜索和关键词搜索必须返回原有 schema，查阅后不能扩展
常驻声明。查阅后的调用必须通过现有桥接执行，未经查阅或被策略禁止的调用仍须拦截。

检查原生延迟 workflow 的意图及模式提示、visible/revealed 工具、CodeModeOnly、
permission-deferred lazy factory、schema 预算预加载、workflow 禁用、桥接任一端
缺失、name-only schema、历史回放、`/clear` 和会话中途 `/review` 激活。执行相关
包内测试、build、typecheck 和 bundle。

先用全局 CLI dry-run 无界面 E2E 流程，再使用完全相同的输入和配置，对比精确未修改
基线与修改版构建的实际请求。使用固定 tokenizer 的估算与 Provider 用量分别报告。
Mock Provider 的 usage 是合成值，不能证明计费用量收益。验收依据是请求内容减少且
发现、调用链路可用，不设固定 token 节省阈值。
