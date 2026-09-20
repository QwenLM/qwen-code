# 单次 Headless 执行

[English](one-shot-headless-execution.md) | [简体中文](one-shot-headless-execution.zh-CN.md)

状态：已在本次变更中实现。

## 问题

单次调用会携带明确的 prompt 启动，不进入交互界面，并在该 prompt 完成后退出。当前它仍然为两个无法使用的交互设施付出成本：常驻的 relaunch 监督进程，以及每次 shell 命令使用的 PTY 和 headless 终端模拟器。在本地 100 条命令的 mock 负载中，这两条路径约占 200 MiB 的进程树峰值 RSS，并占约一半的 shell 执行时间。

## 当前行为

CLI 会在父进程下重新启动自身，以应用 Node 内存参数。shell 命令默认通过 PTY 执行，但单次模式没有能够向该 PTY 写入输入的界面。交互式 TUI 会使用 PTY 输入和 resize API，单次会话不会。

## 目标

- 当运行时可以替换当前进程时，避免为明确的单次 prompt 保留常驻 relaunch 父进程。
- 让明确的单次 prompt 默认使用基于 pipe 的 shell 执行。
- 保持交互式 TUI、ACP、stream-json 输入、仅 stdin 和文件输入会话的现有行为。
- 保留 `tools.shell.enableInteractiveShell` 作为显式覆盖配置。

## 非目标

- 修改交互式或协议驱动会话的 shell 执行语义。
- 移除 PTY 支持。
- 修改外层安装启动器或 sandbox relaunch 流程。

## 设计

对于 ACP、stream-json 输入、prompt-interactive、文件输入和文件描述符输出模式之外的明确 prompt，内存参数 relaunch 会在可用时调用 `process.execve`。它会保留相同的可执行文件、Node 参数、脚本参数、环境来源和 `QWEN_CODE_NO_RELAUNCH` 防重入标记，同时不再保留已加载的父进程。文件描述符输出会保留监督进程，因为进程替换会关闭标准输入、输出和错误之外的描述符。不支持 `process.execve` 的运行时继续使用现有的受监督 spawn 路径，`process.execve` 调用抛异常的运行时同样如此。

去掉监督进程也意味着去掉它的 update-relaunch 处理逻辑：`onUpdateRelaunch` 不会触发，也没有父进程能根据退出码重新启动。这是有意为之。会请求 relaunch 的退出码来自交互式信任对话框（`RELAUNCH_EXIT_CODE`）和 `/update` 命令（`UPDATE_RELAUNCH_EXIT_CODE`），单次 prompt 到不了这些路径；而在没有 IPC 通道可发送请求时，`requestUpdateOnExit()` 本身就返回 `false`。

当未配置 `tools.shell.enableInteractiveShell` 时，明确的单次 prompt 默认使用 `child_process`。交互式 TUI、ACP、stream-json 输入、仅 stdin 和文件输入会话仍默认使用 PTY。显式配置始终优先。

schema 叶子仍然保留 `default` 成员，因为 `SettingDefinition` 要求它必填，但其值现在是 `undefined`。schema 默认值从不进入加载路径 —— `getDefaultValue()` 只服务于展示和重置路径 —— 所以实际 PTY 默认值一直来自 core 的 `params.shouldUseNodePtyShell ?? shouldDefaultToNodePty()`，Windows 的 ConPTY 版本门槛也包含在内。唯一用户可见的影响是：设置对话框里的“恢复默认值”现在会清除该键，而不是写入 `true`，这对基于模式的默认值来说才是正确语义。

## 风险与约束

Pipe 执行会报告非 TTY 的 stdio，保留回车符输出而不是渲染终端视口，并且不提供交互输入。这些语义符合单次自动化场景，但为避免影响长期运行的集成，本次变更保持了较窄的适用范围。现有 shell 服务继续在两种执行方式下负责超时、取消、后台切换、输出限制和进程树清理。

## 验证计划

- 单元测试进程替换的参数、环境和跳过 spawn 行为。
- 单元测试交互、明确单次、ACP 和显式配置的 shell 默认值矩阵。
- 运行 CLI 构建、typecheck、lint 和受影响的 CLI 测试文件。
- 使用生产 bundle 对接本地 OpenAI 兼容 mock，执行 100 次成功 shell 调用，并比较耗时、峰值 RSS、请求数和进程数。

## 验收标准

- 明确的单次 prompt 以相同的模型请求数和工具成功数完成。
- 交互式 TUI、ACP、stream-json 输入、仅 stdin 和文件输入的默认行为保持不变。
- 显式 PTY 配置仍然具有最高优先级。
- 不支持 `process.execve` 的运行时能够回退，并且启动不失败。

## 开放问题

无。
