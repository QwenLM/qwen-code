# CodeModeOnly MVP

[English](code-mode-only.md) | [简体中文](code-mode-only.zh-CN.md)

## 状态

已为 [#10377](https://github.com/QwenLM/qwen-code/issues/10377) 实现。
该功能为可选功能，默认关闭。

## 目标

新增 `tools.mode: "code_mode_only"` 设置，用一个 `exec` JavaScript 工具和少量
必须保留为直接调用的控制面工具，取代面向模型的普通工具面。`exec` 中的代码可通过
`tools.<name>(args)` 调用普通工具，同时不会绕过 Qwen Code 的校验、权限、审批、
hook、遥测、取消、并发或输出预算。

直接模式是兼容性边界：当 `tools.mode` 为 `direct` 时，工具注册、延迟工具行为、
provider 请求和执行均保持不变。

## 非目标

- 定义混合的直接调用和代码调用；详见 [Code Mode](code-mode.zh-CN.md)。
- 在多次 `exec` 调用间持久化 cell、全局变量或值。
- 后台任务、`wait`、`yield`、`store` 或 `load`。
- 原始/freeform provider 调用。
- 在 code mode 中提供 `tool_search` 或 `tool_call` bridge。
- 提供兼容 Node.js 的 sandbox。

## 配置

```json
{
  "tools": {
    "mode": "code_mode_only"
  }
}
```

该设置会解析一次，得到有效的 `ToolMode` 值；`ToolRegistry` 和各执行面使用这一
模式。只有启用某个 code mode 时才注册 `exec`，因此选择 `direct` 也会将它从
诊断信息和 registry 列表中移除。

## 暴露策略

registry 仍是事实来源。暴露只是注册工具之上的视图，而不是第二套 registry。

| 类别                                      | 模型顶层调用             | `exec` 内的 `tools.*` |
| ----------------------------------------- | ------------------------ | --------------------- |
| `exec`                                    | CodeMode 和 CodeModeOnly | 否                    |
| 直接控制工具                              | 是                       | 否                    |
| 已注册的普通工具                          | 仅 CodeMode              | 是                    |
| 隐藏 bridge（`tool_search`、`tool_call`） | 严格模式之外沿用既有行为 | 否                    |

直接控制 allowlist 集中维护且刻意保持精简。它覆盖用户交互
（`ask_user_question`）、委派（`agent`）、终止输出约定、
plan/goal/task/team/worktree/session 控制，以及生命周期无法安全隐藏在解释执行程序
后的 ACP host 控制。新工具默认可在 code mode 中调用；增加仅直接调用或隐藏工具时，
必须显式修改策略。

延迟工具保持注册状态和延迟 registry 状态，并可从 `exec` 调用。生成的 `exec`
描述仍会携带这些工具的完整 schema，以及它们在 `ALL_TOOLS` 中的名称和描述：
CodeModeOnly 会隐藏 `tool_search`，嵌套调用也不会以 `functionCall` 出现在历史记录
中，因此后续 reveal 无法补充描述里遗漏的 schema。CodeModeOnly 会跳过延迟预加载
和 ToolSearch 提醒，因为二者都不属于它面向模型的协议。

## 确定性的 JavaScript 接口

每次向 provider 同步工具前，都会从当前 registry 生成 `exec` 描述。工具按规范
名称排序。名称会通过替换无效标识符字符来规范化为 JavaScript 属性；如果名称以
数字开头，还会添加前缀。如果两个规范名称映射到同一个属性，优先保留与属性精确
一致的规范名称；若都不是精确匹配，则字典序靠前的名称胜出。描述会指出被省略的
冲突项。

描述会定义：

- 全新的异步 JavaScript 执行环境；
- 用于嵌套调用的 `tools.<normalizedName>(args)`；
- 包含规范名称和 JavaScript 名称的 `ALL_TOOLS`；
- `text(value)`、`image(value)`、`audio(value)`、`generatedImage(value)`、
  `setTimeout(callback, delayMs)`、`clearTimeout(timeoutId)` 和 `exit()`；
- 从 JSON Schema 确定性生成的类 TypeScript 签名；
- 不提供 Node.js、`process`、`require`、文件系统、网络、import、`console`、
  `WebAssembly`、`Atomics` 和持久状态。待处理的 timer
  本身不会让 `exec` 保持运行。

嵌套调用返回一个 JSON-safe 对象，其中包含真实 call id、工具名、状态、输出和
structured content。调用失败或取消时，guest promise 会使用 scheduler/ACP 错误
reject。

## Sandbox 与传输

`exec` 在独立子进程中运行编译为 WebAssembly 的 QuickJS。每次调用都会创建全新
的 QuickJS runtime 和 context。子进程通过 stdio 接收精简的 framed JSON 协议；
其中不包含工具实现或 Qwen 配置。父进程把 JavaScript 名称映射回规范 registry
名称，并分派每次调用。

guest 不提供 Node 全局变量、`require`、`process`、文件系统、socket、模块加载器、
`console`、`Atomics`、`SharedArrayBuffer` 或 `WebAssembly`。由于没有安装
模块加载器，动态和静态 import 都会失败。runtime 的内存和 stack 限制固定。
QuickJS 的 interrupt hook 会限制 guest CPU 预算。当 guest 挂起等待已注册的 host
工具时，该预算和父进程的兜底 watchdog 会暂停；在 guest job 再次运行前恢复。
因此，长时间 build 可以继续使用工具声明的 timeout，同时 guest CPU 死循环无法
逃逸固定预算。源码、协议 frame、helper 输出和最终结果都有上限。

取消操作会中止所有嵌套调用并终止子进程。顶层 promise settled 后，也会在 teardown
前取消未 await 的嵌套调用。子进程、timer、promise handle 或 guest 全局变量都不
会在调用结束后存活。

子进程只接收最小化且经过清理的环境，guest 无法检查该环境。独立进程为解释器故障
提供纵深防御；QuickJS/WASM 是 guest 的 capability 边界。

## 重入式分派

`CoreToolScheduler.schedule()` 无法递归调用：子调用会排在仍在运行的父调用之后，
从而形成死锁。因此，scheduler 会在 invocation 边界绑定 async-local
`ToolCallRuntime` context，`exec` 只与该 context 通信。

scheduler runtime 会将同一 event-loop turn 中收到的嵌套调用合并为一批，并通过
使用相同 `Config` 和 observer 配置的 sibling scheduler 执行。这样无需直接调用
`tool.execute()`，仍能沿用现有的构建/校验、权限、确认、hook、执行、截断、遥测和
并发链路。guest 的连续 await 会生成连续 batch；`Promise.all` 调用会进入同一个
batch，由现有的只读并发分类器处理。嵌套 request id 包含父 id，并携带
`source: code_mode` 和 `parentCallId`。

嵌套 scheduler 更新会合并到所属 scheduler 的可见调用中，嵌套 id 的确认响应也会
委派给它。外层模型仍只接收完整的 `exec` 响应。

ACP 沿用其独立审计过的执行链。它的 invocation 边界会绑定相同的 runtime 接口，
嵌套分派通过 `Session.runTool` 重入。因此，ACP 顶层和嵌套调用使用相同的 ACP 权限、
审批、hook、遥测、持久化和取消机制，而不是借用 CLI scheduler 状态或直接执行工具。
ACP 会串行执行普通嵌套调用，与现有直接工具顺序一致；Core scheduler 则保留现有的
安全只读并行 batch。

## Provider 行为

所有 provider 继续使用 `ToolRegistry` 提供的 `FunctionDeclaration[]`。在 Direct
模式下，该数组与现有视图逐字节一致。在 CodeModeOnly 中，它是暴露策略生成的视图，
因此 Gemini/Qwen、OpenAI-compatible 和 Anthropic adapter 都会收到结构化的
`exec` declaration，不需要 provider 专用 prompt。

经过过滤的子智能体 declaration 使用相同策略。对于只读 teammate 或带执行
allowlist 的 fork，`exec` 是经过审计的 gateway，其 invocation context 中携带的嵌套
名称会在 Core 分派前再次校验。显式列出的普通工具会收窄该嵌套集合；继承或显式允许
的 `exec` 则代表所有仍可用的普通 code-mode-callable binding，而智能体自身的
`tools` 列表仍会收窄直接调用面。隐藏 bridge 始终不可用，`exec` 也不能调用自身。

## 失败与回滚

未知、冲突、隐藏、仅直接调用和递归请求的工具都会在调度前 fail closed。无效参数
继续在正常执行链中失败。sandbox 启动、协议、timeout、内存或 teardown 失败会转为
`exec` 工具错误。

回滚方式是将 `tools.mode` 设为 `direct`。无需迁移 session 或清理 registry，
因为 code mode 没有持久状态，且普通 registry 从未被替换。

## 验证

单元和集成测试必须覆盖：

- Direct 和 CodeModeOnly 暴露、延迟保留、冲突处理、确定性描述和显式子智能体过滤。
- 有效/无效 JavaScript、异步顺序、`Promise.all`、helper 输出、throw error、CPU
  死循环、内存限制、import、不可用全局变量、隔离、输出限制、取消、未 await 工作和
  递归调用。
- 嵌套权限、确认、Pre/Post hook、失败、输出预算、真实名称遥测/UI 更新、MCP 工具
  和 scheduler 死锁回归。
- Gemini/Qwen、OpenAI-compatible、Anthropic、headless、interactive、subagent
  和 ACP 调用面。

只有通过相关 package 测试、build、typecheck、E2E probe 和两轮干净的完整 diff
自审，才算实现完成。
