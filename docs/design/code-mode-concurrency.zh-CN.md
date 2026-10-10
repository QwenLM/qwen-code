# Code Mode 工具并发调用

[English](code-mode-concurrency.md) | [简体中文](code-mode-concurrency.zh-CN.md)

状态：已实现。

## 问题

改动前，Code Mode 建议使用 `Promise.all`。一个工具 promise 被拒绝时，可能使整个
程序失败，并在收集结果前取消其他调用。Core 调度器已经支持安全读取并发执行，
ACP 和 daemon Session 则串行执行所有嵌套调用，相同程序在不同入口表现不同。

## 行为

建议独立搜索和读取使用 `await Promise.allSettled([...])`。示例逐项检查结果，
输出成功调用的结果，并用 `String(reason)` 输出失败原因。模型必须让有依赖的操作、
修改和审批保持顺序执行。JavaScript 已提供该方法，无需新增运行时 API。

Session 在每个 `exec` 内使用 Core 的 `isToolCallConcurrencySafe` 判定，
并发执行连续的安全调用。Code Mode 中的 Bash 调用跳过只读命令判定，由模型判断
哪些命令相互独立；普通 Bash 调用保留只读检查。沿用
`QWEN_CODE_MAX_TOOL_CONCURRENCY`，默认上限为
10。不安全调用等待之前的调用结束，后续调用再等待它结束。JavaScript 中显式的
逐项 await 保留原有顺序。队列按提交顺序接纳调用，无需通过定时器收集批次。

共享安全判定将加载 skill 视为不安全调用：虽然它的工具类型为 `Read`，但它可以
注册 hook、修改会话权限。因此 Core（包括嵌套 Code Mode）、headless 工具分批
和 Session 嵌套调度都会将 skill 执行作为顺序边界。

每个调用仍经过 `Session.runTool` 的校验、权限、hooks、进度、遥测和记录流程。
按调用 ID 完成嵌套结果处理，避免并发完成的调用消耗其他调用的记录。模型看到的
结果保持 promise 提交顺序，进度可以按完成顺序到达。父调用完成前等待派发队列
收尾。

普通工具错误使对应 promise 被拒绝，`allSettled` 允许独立调用继续完成。用户
取消和权限取消会停止待执行工作，并通过嵌套调用共享的 abort signal 传递。即使
程序捕获了拒绝结果，Session 也会将嵌套权限取消传递为停止本轮的结果。未捕获的程序
错误、超时和未 await 调用继续遵循 host 的现有处理行为。

即使嵌套工具实现没有响应 abort signal，取消也会结束对其执行结果的等待。调用仍
需完成取消 hooks 和终态记录，父调用才会结束。迟到的成功、失败和进度不会发布
第二份结果。文件读取在等待内容后、更新缓存前检查取消状态。工具实现仍负责停止
底层工作；取消等待无法撤销副作用。

## 范围和决策

修改 Code Mode 指引和示例、共享的 skill 安全判定、Session 嵌套调度与结果记录，
并添加针对性回归测试。Core 保留先准备权限、再对执行分批的现有顺序；Session
顶层工具批处理保持现有行为。未知工具和有状态的 MCP 工具沿用现有保守的并发
安全判定。无需新增设置、权限策略、工具搜索行为或 provider 专用路径。

实现涉及 `packages/core/src/core/prompts.ts`、
`packages/core/src/core/coreToolScheduler.ts`、
`packages/core/src/tools/code-mode.ts` 和
`packages/cli/src/acp-integration/session/Session.ts`，测试放在现有 prompt、
scheduler、host 和 Session 测试中。

## 风险和验证

并发可能暴露共享结果队列、权限取消时序和 hook 修改参数的问题。测试需要覆盖
结果归属、安全读取重叠、不安全操作的顺序边界、显式逐项 await、并发上限、
失败隔离，以及运行中和排队调用的取消。Session 保守处理 hook 导致的变化：
启用的 `PermissionRequest` hook 可能修改 shell 参数时，shell 调用串行执行。
并发安全性在接纳调用时判定，并等待之前的顺序边界，因为加载 skill 可能注册
新的 hook。

对全局基线和本地 bundle 运行确定性 CLI 和 ACP 探针。使用受控模型工具调用
验证完整 Session 链路；headless CLI 只覆盖 Core 调度器，无法证明 ACP 并发。
通过真实模型冒烟测试观察调用模式。完成构建、类型检查、相关包测试和完整 diff
审查。

验收要求：安全调用在上限内重叠执行，不安全调用保留提交顺序边界，各结果保持
正确调用 ID 和内容，普通错误保留独立调用结果，用户取消阻止排队工具执行。
当 ACP 读取回复被暂缓时，用户取消和 guest 完成都必须让父调用结束，并允许在
释放回复前开始下一轮。迟到的成功或失败不得改变终态记录或更新读取缓存。
Code Mode 继续保持实验性质，需主动开启。

## 待定问题

无。实现和验证中的发现将同步到两个语言版本。
