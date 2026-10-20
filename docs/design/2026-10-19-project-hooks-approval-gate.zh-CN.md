# 项目 Hooks 审批闸门

[English](2026-10-19-project-hooks-approval-gate.md) | [简体中文](2026-10-19-project-hooks-approval-gate.zh-CN.md)

状态：已实现，2026-10-19。

## 问题

`security.folderTrust.enabled` 默认为 `false`，功能关闭时每个目录都被视为受信任。于是工作区 `.qwen/settings.json` 会被完整合并，包括其中的 `hooks`，而 `Config.getProjectHooks()` 只检查 `isTrustedFolder()`。一个刚克隆的仓库可以自带 `SessionStart` 命令 hook，在仓库目录启动 `qwen` 的瞬间就执行，没有任何提示。同一文件里的项目 MCP 服务器已经有按哈希绑定的审批闸门（issue #4615），项目 hooks 却没有。

## 目标

- 仓库自带的 hooks 在用户审阅之前绝不执行。
- 现有用户一次审批后继续使用项目 hooks；不改目录信任的默认值。
- 闸门与 MCP 的一致：用户本地、按项目、绑定审阅过的配置、变更后重新询问、已拒绝的不再反复询问。

## 非目标

- 修改 `security.folderTrust.enabled` 的默认值。
- 为 ACP 增加审批项目 hooks 的请求（ACP 会话直接不加载未审批的项目 hooks）。
- LSP `.lsp.json` 的命令路径，问题形态相同，另行跟踪。

## 设计

### 审批存储

`packages/cli/src/config/hook-approvals.ts` 把决定持久化到 `~/.qwen/hookApprovals.json`（可用 `QWEN_CODE_HOOK_APPROVALS_PATH` 覆盖），每个项目根目录一条记录：`{ hash, status }`，`status` 为 `approved` 或 `rejected`。`hash` 是项目 `hooks` 对象按键排序序列化后的 SHA-256（使用无原型对象，因此自有的 `__proto__` 键也会参与哈希），因此文件里的键顺序无关，但任何行为上的修改都会改变它。哈希与当前 hooks 不匹配、或状态不是这两个值之一的记录视为 `pending`。项目根目录是 hooks 所在 `.qwen/settings.json` 的目录，而不是会话的工作目录，因此 `/cd` 与 `--worktree` 不会改变键；其规范化方式与 `mcpApprovals.json` 相同。文件以 `0600` 写入（已有的更宽松权限会被收紧），`QWEN_CODE_HOOK_APPROVALS_PATH` 与同类存储路径一样不允许由项目 `.env` 设置。

`isProjectHooksPendingApproval(projectHooks, projectRoot)` 在 hooks 块至少声明了一个可运行的 hook 且状态不是 `approved`（待定或已拒绝）时为 `true`。不存在、为 `null`、为空或没有可运行内容的块永远不受闸门约束。

### Core

`ConfigParameters.projectHooksPendingApproval` 记录启动时的判定；`undefined` 表示该会话完全不对项目 hooks 设闸门。为 `true` 期间，`getProjectHooks()` 在既有的信任检查之后返回 `undefined`，`getUserHooks()` 中旧的合并 `hooks` 回退也同样返回 `undefined`（未拆分作用域时它可能携带同一工作区块）。`setProjectHooksPendingApproval()` 允许 CLI 在会话中途解除闸门，下一次 `HookSystem.reload()` 即注册它们。

### CLI 启动

`loadCliConfig` 根据拆分出的 `projectHooks`（调用方未提供作用域时用合并后的 `hooks`）计算该标志，并以传入的项目根目录为键。在 `--bare`、`--safe-mode` 和 `disableAllHooks` 下（此时不加载任何 hooks），以及命令行要求的 YOLO 审批模式下（`--yolo`、`--approval-mode yolo`），该标志为 `undefined`。来自设置的 YOLO 模式不豁免 hooks，因为工作区自己的 `tools.approvalMode` 就能设置它。

### 交互式审批

`useProjectHooksApproval`（ink 与 OpenTUI 共用）在状态严格为 `pending` 时显示对话框，按 `Event[matcher]  target [details]` 列出每个 hook：命令及其 `env`、`shell`、`async`；URL 及其请求头名称与 `allowedEnvVars`；prompt 文本。仓库提供的每个字符串都压成一行，并去除转义序列、双向控制及其他格式字符；列表按可用高度截断并显示 "… and N more" 行，保证选项始终可见。批准会持久化 `approved`、解除运行中 `Config` 的闸门并重载 hook 系统；拒绝会持久化 `rejected`，hooks 保持不加载；Esc 关闭对话框且不保存任何决定，下次启动会再次询问。该对话框排在 MCP 审批对话框之后。ink 的 `/hooks` 浏览器把被扣留的项目 hooks 标为禁用。

### `/hooks` 重载

在设有闸门的会话中，重载在 `HookSystem.reload()` 之前，用重新读取的工作区 hooks 重新计算闸门，因此修改过的 hooks 块不会进入注册表；当其状态为 `pending` 时发出 `AppEvent.ProjectHooksPendingApprovalChanged`，让对话框再次询问。未设闸门的会话不受影响。

### 无头运行

非交互会话无法提示。未审批的项目 hooks 保持不加载，`qwen -p` 在 stderr 上打印一行说明：待定的块提示交互式运行一次，已拒绝的块则给出审批文件的位置。

## 决策

- **无论目录信任与否都设闸门。** 目录受信任意味着读取其设置，不代表其中每条命令都审阅过；这与 MCP 闸门一致，也不改动目录信任对话框。
- **按项目而非按 hook 决定。** hooks 以文件声明的整个块为单位审阅；逐条排队只会增加 UI，不增加安全性。
- **只有命令行的 YOLO 跳过闸门。** 那是用户自己选择批准一切；设置里的值可能是仓库选的。
- **记住拒绝**，被拒绝的仓库不会每次启动都询问，但任何修改都会重新询问。Esc 不算拒绝，顺手关掉的对话框下次还会出现。

## 验证

- 单元测试：存储语义与哈希绑定（`hook-approvals.test.ts`）、启动闸门条件（两个包的 `config.test.ts`）、对话框 hook（`use-project-hooks-approval.test.ts`）、`/hooks` 重载（`hooksCommand.test.ts`）。
- 手动：在声明了 `SessionStart` hook 的克隆仓库里运行 `qwen -p`，hook 不再执行并在 stderr 给出警告；交互式启动显示对话框，批准后 hooks 在下一次事件时运行，`~/.qwen/hookApprovals.json` 保存了决定。

## 验收标准

- 默认设置下，仓库 hook 在对话框得到回答之前绝不执行。
- 审批一次即可，直到项目 hooks 发生变化。
- 拒绝后 hooks 保持不加载，变化之前不再询问。
- 用户、系统和扩展 hooks 不受影响。

## 后续工作

- ACP：增加列出并审批待定项目 hooks 的请求，与 MCP 的对应。
- LSP：以同样方式为工作区 `.lsp.json` 的命令设闸门。
- 项目 skill frontmatter 中的 hooks：目前仍只需要目录信任。
- 非交互式审批项目 hooks 的方式（用于 CI），与 `qwen mcp approve` 对应。
- OpenTUI 与 ACP 的 hooks 列表：为被扣留的项目 hooks 显示原因行。
