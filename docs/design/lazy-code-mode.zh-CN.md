# 懒加载 Code Mode

[English](lazy-code-mode.md) | [简体中文](lazy-code-mode.zh-CN.md)

## 问题与范围

CodeModeOnly 目前把所有可调用工具的签名和描述写入初始 `exec` 声明，包括 deferred 工具，因此失去了延迟加载节省提示词的效果。现有 `tool_call` 桥接层还把目标参数描述为通用对象；issue #12889 记录了 Responses provider 下反复生成空参数的问题。Code Mode 允许模型通过 JavaScript 表达参数，并保留正常的运行时校验。

本次修改让现有实验性 `tools.codeModeOnly` 模式通过 `tool_search` 按需加载 deferred 工具的描述和 schema。Direct 模式保持现有协议。这扩展了最初 CodeModeOnly MVP 的范围。

## 设计

### 声明与执行

将 `tool_search` 与 `exec` 和现有直接控制工具一起暴露在顶层，继续隐藏 `tool_call`。当前工具范围内搜索可用时，`exec` 描述及其内嵌元数据只包含 eager 或显式可见的绑定。说明其他工具的发现方式，但不列出它们的名称和描述。保留完整的绑定计划和运行时 `ALL_TOOLS`：schema 是否可见不决定执行权限。

当搜索被禁用或被排除在代理范围外时，该范围的 `exec` 声明保留完整签名，以兼容现有配置。沿用现有 deferred 状态、`tools.visible` 和 `tools.eager`，不增加设置。CodeModeOnly 继续跳过 deferred 预算预加载和启动工具清单提醒。

### 工具发现

复用 ToolSearch 的关键词评分、精确查找、结果上限和 JSON 转义。CodeModeOnly 只搜索当前可调用绑定计划中的工具。结果返回原始描述和 JSON Schema，以及实际规范化后的 JavaScript 名称、签名，并引导模型在后续轮次通过 `exec` 调用。TypeScript 风格签名无法表达的约束以原始 schema 为准。Code Mode 搜索排除只能直接调用的工具和名称冲突中被省略的工具。

搜索不修改 registry 的工具可见状态，也不重写声明。结果作为工具输出追加到对话。其他配置不变时，搜索和调用 deferred 工具保持 provider 的工具数组不变。缓存是否命中仍由 provider 决定。

### 调用提示与上下文压缩

明确 `tool_search` 是 JavaScript 运行时之外的独立顶层调用。嵌套调用准确使用返回的 `jsName`。当前上下文中已有的 schema 可以复用；压缩后缺失的 schema 应先重新搜索，再构造参数。

Code Mode 的精确名称查找未命中时，提示 `select:` 需要注册名称，MCP 工具包括 `mcp__<server>__<tool>` 前缀，并建议去掉 `select:` 使用关键词发现。精确匹配规则和作用域可见性保持不变；提示不列举其他工具。Direct 模式保留现有响应。

压缩可能用摘要替换早期搜索结果。通过实际历史重写，验证重新发现、执行和后续复用。压缩前后的工具声明应保持稳定；历史替换可能减少缓存复用，因此分别观察保留的前缀与后续缓存建立过程。沿用现有压缩流程，不增加 schema 持久化或另一套恢复机制。

### 代理范围

将搜索作为受限代理的发现入口，并遵循显式 disallowed-tool 规则。通过现有工具调用运行时上下文，在搜索请求上传递与 `exec` 相同的实际嵌套工具白名单。关键词和精确查找都按该范围的绑定计划过滤。因权限配置而延迟加载的工具仍可供获准使用它们的代理发现。搜索不能扩大执行权限。

Core scheduler 已负责受限代理的执行。ACP session 适配器使用共享暴露策略和顶层完整 registry，其嵌套执行路径保持不变。Fork 继承工具名称，并在运行前解析当前声明。其执行白名单同样约束搜索；禁用搜索时，为允许的嵌套工具生成完整签名。

## 受影响组件

- `packages/core/src/tools/code-mode.ts`：暴露策略、签名格式和条件描述生成。
- `packages/core/src/tools/tool-registry.ts`：范围内搜索是否可用。
- `packages/core/src/tools/tool-search.ts`：Code Mode 描述和搜索结果。
- `packages/core/src/core/coreToolScheduler.ts` 和 `packages/core/src/agents/runtime/agent-core.ts`：受限搜索上下文。
- 相邻测试和 Code Mode 运行时测试；设置文档及其源 schema 描述。

## 约束与验证

不新增沙箱、provider 适配器、持久 guest 状态或另一条执行路径。参数校验、权限、hooks、取消和输出限制继续通过现有 scheduler。生成的 JavaScript 仍可能包含无效参数，因此需要使用问题对应的 provider 组合进行真实模型验证。

手动压缩测试验证了重新发现和后续缓存复用，同时暴露了已有的摘要清理缺陷：摘要正文引用字面量 `<analysis>` 时，后续正文可能被删除，而压缩仍报告成功。这会丢失任务状态，需要单独修复压缩逻辑。工具声明稳定和缓存命中本身无法证明摘要保留了继续任务所需的信息。

验收条件：

- 搜索可用时，初始请求的 `exec` 不包含 deferred 工具的名称、描述和签名；保留 eager 和显式可见绑定的信息。
- 搜索返回完整工具信息和可用的 JavaScript 名称，随后嵌套执行成功；无效参数仍被校验拒绝。
- 搜索和嵌套调用不改变 provider 工具声明。
- 精确查找和关键词搜索遵循范围白名单、排除项、工具可用性和规范化名称冲突规则。禁用搜索时，仅为允许的工具回退到完整签名。
- Direct 模式保持原有行为。通过构建、类型检查、定向单元测试、确定性 CLI 检查和 Responses 模型测试验证改动。
- 精确名称未命中时提供不泄露作用域外工具的恢复提示。压缩后能够重新发现缺失的 schema，完成调用和复用；通过实际请求历史和 provider usage 确认缓存行为。

E2E 计划与结果保存在 `.qwen/e2e-tests/lazy-code-mode.md`。首版没有待定设计问题。
