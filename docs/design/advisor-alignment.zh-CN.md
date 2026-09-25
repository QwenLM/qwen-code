# Advisor 行为对齐

[English](advisor-alignment.md) | [简体中文](advisor-alignment.zh-CN.md)

## 目标与参考

补齐 #9636 引入的 executor/advisor 行为及 #9036 的验收约定。基线为已合并主分支 `90232f0eb0c0`。参考版本为 Claude Code `2.1.282`，于 2026-09-25 通过 npm 确认。较旧的本地源码仅用于理解结构；同版本发布二进制包含调用策略和模型配对的证据。不复制上游实现代码。

发布二进制确认：executor 收到详细指导，在初步了解任务后、确定重要方案前、遇到阻碍时及完成前咨询，并处理与证据冲突的建议。[CLI 文档](https://code.claude.com/docs/en/advisor)确认：调用时机由模型决定，普通子代理继承 Advisor，调用产生额外费用，CLI 不提供次数上限。[API 约定](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)另有可选次数上限，并把建议返回 executor。

## 决策

- 保留无参数 schema 和简短可搜索描述。Advisor 默认延迟加载，经 `tool_search` 发现后由 `tool_call` 调用；仍遵循显式可见性设置和既有的无桥接回退机制。独立任务提醒让执行器在发现工具前就知道咨询时机。普通子代理在工具声明和执行权限允许时获得相同指导。咨询由模型决定，不强制每轮调用，建议不代表用户批准。
- 原生咨询返回可读文本或 Markdown，不要求 JSON 字段，不提供任何工具，包括 schema 工具。手动 `/advisor review` 保留结构化约定。删除原生解析器可消除重复解析问题，无需改变手动解析器或占用合法模型 ID 的大小写变体。
- 在既有异步 agent context 中绑定当前代理会话。普通执行及批准后的继续执行均重新进入此绑定。代理没有绑定会话时直接返回错误，禁止回退到父会话。子代理继承注册，但仍遵循显式工具允许列表、禁用列表、safe/bare 模式及权限。内部单轮侧查询和 Advisor 推理没有可执行工具，因此不会递归咨询。
- 增加 User/System 设置 `advisorMaxUses`，只接受非负整数，`0` 表示无限制。同一 session 的 executor 与派生子代理配置共享计数；发起请求前同步占用次数，失败也计数。关闭或切换模型不重置，新运行时 session 使用新计数。Workspace 设置不能提高或覆盖此成本边界。这是 Qwen issue 验收要求的扩展，不是 Claude CLI 的既有设置。
- 保留当前完整会话、system instruction 和工具声明，并沿用推理与二进制过滤。不为未经测量的载荷预算静默截断证据。说明重复调用的 token 成本，在非选择器命令输出显示上限和已用次数。沿用模型/source telemetry，将咨询归属为 `advisor`。
- 在现有 Advisor 卡片中显示自由文本，同时保留历史结构化评审的显示。非交互 `/advisor` 显示当前模型和预算；配置与关闭遵循既有命令策略。

## 有意保留的差异

Qwen 使用跨 provider 的独立推理，而非 Anthropic 服务端工具。模型资格沿用 Qwen 已配置模型的能力，不硬编码 Anthropic 模型系列排名。不承诺相同的 prompt cache、计费、服务端拒绝信号或供应商模型配对。关闭会移除 Qwen 工具，因此可能改变 executor 的工具前缀。明确记录这些差异，不宣称实现完全相同。

## 验收

1. 原生自由文本建议返回 executor、正确显示，且 executor 继续任务。请求使用所选模型、不包含工具，并覆盖全部会话类别。
2. 空建议、provider 失败、次数耗尽、取消均符合约定。耗尽后不再发出网络请求，子代理共享次数。
3. 子代理证据来自自己的会话并包含工具结果；缺少代理会话时不回退父会话。既有工具和权限策略仍有效。
4. User/System 设置优先于 Workspace 输入。关闭不产生 Advisor 请求。历史结构化卡片和新自由文本卡片均正常显示。
5. 定向单元测试、bundled CLI 集成测试、build 和 typecheck 通过。有界真实模型任务须证明自主咨询及后续 executor 行为，不能只看退出码。明确记录 provider 错误和未验证项。

## 验证状态

实现、定向自动化验收及 Ink 终端 mock 验收已通过。五个 bundled CLI 场景覆盖成功、provider 失败、子代理证据、次数耗尽及关闭。OpenTUI 终端验收发现原始 JSON 显示后已修复适配器，回归测试和严格 OpenTUI 终端复验均通过。全局 CLI 版本早于原生 Advisor。当前本机有可用凭证的两个模型在真实基线调用时均返回模型下架错误。因此真实模型验收仍需要有效配置，不能记为通过。结果将记录在 PR 和验收报告中。
