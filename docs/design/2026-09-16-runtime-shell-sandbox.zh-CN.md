# Runtime Shell 沙箱接入

[English](2026-09-16-runtime-shell-sandbox.md) | [简体中文](2026-09-16-runtime-shell-sandbox.zh-CN.md)

## 状态与问题

实现阶段，2026-09-16。结构化进程 API 与 bwrap adapter 已实现并获得 Linux 内核验证。此前生产 ShellTool 通过旧服务启动，未接收操作方策略。本阶段把可信 runtime 接入前台和后台 Shell 执行。它基于 [bwrap 执行底座](2026-09-17-bwrap-execution-foundation.zh-CN.md)，不是面向用户的沙箱发布。

本文记录已完成的 Shell 阶段快照。后续 [runtime 文件工具接入](2026-09-16-runtime-file-sandbox.zh-CN.md)将受限 registry 扩展到 Read/Write/Edit，并替换原型 worker 协议。下文的 registry 和产物说明描述该历史阶段。

## 设计

现有 `loadCliConfig` 的 runtime-only host-policy 参数接收 `shellExecutionSandbox` 并传给 Config，不增加设置、环境变量或公开 CLI 开关。Config 准入并冻结原始规范化 workspace 策略，同时保护 runtime 状态和全局配置目录。派生 Config 继承该权限上限；超出上限的派生或目录切换在修改状态前失败。要授权另一个 workspace，可信宿主必须重新构造并准入 Config。

内部模式要求 bare、非交互 runtime，并拒绝显式扩展、MCP server、工具发现、LSP、旧的整个 CLI 沙箱和 provisional workspace。工具注册表仅包含 `run_shell_command` 与 `task_stop`。Bare 启动关闭 hook 和环境中的扩展/MCP。不支持的模型工具调用无法进入文件工具、子代理、worktree 或 Exec。这是受限的 headless 集成；任意嵌入方式、slash command、TUI、ACP 和其他副作用入口仍是发布前置条件。

Runtime shell helper 在没有策略时保留旧路径。有策略时构造显式 `/bin/bash -c` 启动描述，使用已有清洗后的 shell 环境和当前 session 上下文，再调用 bwrap。前台、后台和转后台保留现有 registry、输出流、取消、超时及宿主 relay PID 行为。准入或启动失败绝不退回无约束命令。

沙箱回执校验同时覆盖普通完成和转后台后的终结回调。已确认的非零退出仍是命令失败。无法确认的终结产生错误，说明命令可能已经执行，不得自动重放。中断不能变成成功。转后台只是运行中快照；此后仍保留终结校验和资源所有权。

禁用 sed 预览/写入优化，让原始命令在沙箱内执行。内部模式暂停 Git notes、PR 绑定的元数据子进程、纯文本 commit/PR 署名改写和系统提示词的 Git 状态快照，因为即使 `git status` 也能在宿主执行仓库配置的 clean filter。仍可通过受约束的 Shell 工具查看 Git 状态。权限默认保守询问，不执行宿主 Git 配置探测，确认阶段也不进行这些探测。普通批准和 YOLO 都不会扩大 OS 策略。后台启动异常会关闭输出流。在工作区 bind 之后，review worktree lease 目录会被私有 tmpfs 遮蔽，因此受约束进程既不能读取真实 lease，也不能伪造随后可授权宿主清理的记录。

Workspace-write 会有意允许修改仓库元数据，包括 `.git` hook 和配置。后续宿主进程因此必须把整个可写工作区视为沙箱输出；没有单独的信任决策时，不得执行由仓库控制的 hook、filter 或配置。

## 影响层次与边界

Core Config 负责不可变准入和受限工具注册。CLI config 传递可信策略。ShellTool 委托启动并关闭尚未覆盖的捷径。bwrap adapter 传递经过校验的终结状态。测试覆盖策略归属、Shell 路由、默认行为和 Linux 生产 headless 执行。

文件工具迁移、完整副作用清单、署名流程迁移、移除整个 CLI 的 bwrap、Landlock 和自动后端选择留到后续阶段。不声明读取机密性或 inode 级不可变性。宿主模型、认证和 session 持久化位于工具沙箱之外。本阶段不交付新的公开启用模式。

## 验证与验收

先使用隔离 HOME、临时 workspace/state 和确定性的假 OpenAI server 执行全局 CLI 基线，证明当前 ShellTool 的无约束行为。随后 build、typecheck、bundle 并执行针对性 package 测试，保留旧 Shell 测试集。

在真实 Linux 上，测试专用 launcher 调用生产 `loadCliConfig`、认证初始化和 `runNonInteractive`，仅注入可信策略。验证模型 HTTP 与宿主 session 持久化、workspace 写入、根外写入和关闭网络的拒绝、真实 sed 约束、不支持文件工具的拒绝、前后台生命周期，以及两个独立 workspace 的策略。准确称为生产 headless pipeline，不宣称公开 `node dist/cli.js` 可以启用该模式。单独 smoke test 普通 bundle。复用进程 adapter 的 Linux 生命周期证据；改动 adapter 时重跑。

验收要求：无宿主回退、无虚假终结成功、派生/切换目录不隐式授权、默认行为不退化。精确 artifact 与测试证据记录在 `.qwen/e2e-tests/`。完成两轮干净自审和独立代码审查。本阶段没有尚未确定的设计问题。

## 验证结果（2026-09-16）

实现通过 2,769 项定向测试（core 2,154 项、CLI 615 项，另有 1 项原有跳过测试）、完整仓库 build、typecheck、bundle、定向 lint 和格式检查。普通 bundle CLI 仍返回 `0.23.4`。实现前的隔离全局 CLI 基线证明了此前可越界写入的行为。

在 Lima `qwen-sbx`（Linux `7.0.0-31-generic`、ARM64、Node `v22.22.1`、bwrap `0.11.1`）上，仓库中的 `scripts/sandbox-runtime` 套件通过生产 headless 链路与真实 ShellTool 生命周期完成 22 项检查，已有 adapter 套件通过 31 项，源码输入 hash 未变化，因此该结果继续有效。证据覆盖同一进程内两个 Config 的不同 session ID 与交叉写入拒绝、宿主模型请求和 session JSONL、内核写入/网络拒绝、受限启动/工具注册、Git clean filter 仅在沙箱内执行，以及前台、后台和转后台时的回执丢失失败。namespace 清理检查比较身份，不依赖数值 PID。review lease 清理的生命周期单测同时覆盖正常回合收尾与退出回调，确认仅普通模式会调用宿主清理；未额外构造破坏性 lease 场景。

最终 runtime v4 manifest 包含 4,787 个源码与测试脚本输入 hash，执行后全部与工作区重新比对一致。launcher SHA-256 为 `3be748159cd10d7b1f1054042061b3e6f6678aab707fabe995cb8e49267dd792`。详细基线、中间 LSP 拒绝契约修正、Git 快照与 review lease 清理修复、最终报告和测试边界位于 `.qwen/e2e-tests/runtime-shell-sandbox.md`。本阶段未验证 Linux x64、其他内核、macOS/Windows 内核约束或公开 CLI 启用入口。
