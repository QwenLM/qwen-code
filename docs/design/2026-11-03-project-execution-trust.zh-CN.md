# 仓库代码执行需要显式信任

[English](2026-11-03-project-execution-trust.md) | [简体中文](2026-11-03-project-execution-trust.zh-CN.md)

状态：已实现，2026-11-03。

## 问题与范围

Issue #14746 指出，关闭目录信任会使所有目录隐式受信任。PR #14748 为 settings 文件中的 hooks 单独增加审批，但项目 skill/subagent 的 frontmatter hooks 和工作区 `.lsp.json` 命令仍接受这种隐式信任。项目 skill 还可以通过同一门禁授予工具自动批准权限。

本次改动关闭这些剩余执行入口。不改变目录信任的默认值，不增加审批存储或对话框，也不修改 #14748 的 settings hooks 审批工作。

## 决策

新增 `Config.isExplicitlyTrustedFolder()`：IDE 明确表示工作区受信任，或已开启目录信任且当前目录受信任时，才授权执行仓库代码。IDE 的拒绝信号优先。缺少信任，以及关闭目录信任且没有 IDE 决策，均拒绝执行。其他使用方继续使用现有 `isTrustedFolder()` 语义。

项目 skill 的副作用与 subagent hooks 在注册和执行时均使用此判定。skill 权限授予也使用同一实时判定，避免 IDE 信任信号消失后，由旧的默认放行语义维持授权。skill/agent 的指令正文仍可用。用户、扩展和内置 skill/agent 的副作用不变。

LSP 加载器记录每项配置来自工作区文件还是扩展。来源只能由加载器确定，JSON 不能覆盖。工作区 LSP 配置在服务准入，以及任何命令探测、连接或进程启动之前，都要求显式信任。这覆盖首次发现、热重载和重启。扩展的现有准入与 `requireTrustedWorkspace` 行为不变。

## 兼容性与风险

项目 frontmatter hooks、项目 skill 权限授予或工作区 LSP 配置的使用者，需要在用户设置中开启 `security.folderTrust.enabled` 并信任目录，或使用明确授信的 IDE。关闭目录信任不再授权这些执行路径，包括 YOLO 会话。警告和功能文档说明这一迁移。现有信任对话框及信任文件持久化提供审批流程。

信任文件的手动修改仍沿用现有重启生效边界；IDE 决策保持实时。本方案属于目录级信任，不是对每个脚本或 hook 的哈希审批，也不能让已被明确授信的恶意仓库变得安全。settings hooks 审批、按 skill 审批以及 LSP 专用审批对话框仍属于独立工作。

## 验证与验收

- 修改源码前，使用全新用户设置和无害标记复现两类路径。
- 默认关闭目录信任时，必须阻止项目 skill hooks/权限授予、项目 subagent hooks 和工作区 LSP 启动，包括探测可执行文件是否存在的命令。
- 开启并授予目录信任，或收到 IDE 明确授信后，恢复这些路径。IDE 拒绝授信后暂停项目 hook/权限；关闭目录信任时，失去 IDE 信号也会暂停它们。
- 工作区 JSON 不能声明扩展来源或关闭自己的信任要求。扩展 LSP 配置与非项目 skill/agent 保持现有行为。
- 运行受影响的 core 单测、构建、打包和类型检查；以隔离标记夹具验证构建后的 CLI；自审完整 diff 并评审最终改动。
