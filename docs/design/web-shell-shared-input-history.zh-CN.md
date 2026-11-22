# Web Shell 跨端共享工作区输入历史

[English Version](./web-shell-shared-input-history.md)

## 背景

当前 Web Shell 的输入框历史（Prompt 历史与 Shell 模式命令历史）完全保存在浏览器本地 `localStorage` 中（`qwen-web-shell-history:<workspaceCwd>` 与 `qwen-web-shell-command-history`）。当用户在手机和电脑上同时使用同一个 Web Shell 会话或工作区时，电脑上提交的历史输入在手机端的 **Input history** 面板中不可见（反之亦然）。此外，Web Shell 的 Shell 命令历史目前未按工作区隔离，也没有与 CLI 的项目级 `shell_history` 互通。

## 目标

1. 让连接到同一 `qwen serve` daemon 的多端设备（电脑、手机、多浏览器）按工作区共享 Prompt 历史与 Shell 模式命令历史。
2. 当电脑与手机同时打开同一会话时，实现近实时同步，且不引入复杂的自定义同步协议。
3. 复用现有项目级 `shell_history` 文件（`Storage(workspaceCwd).getHistoryFilePath()`），实现 Web Shell 与 TUI 共享按工作区隔离的 Shell 命令历史。
4. 完整兼容旧版 daemon、无该能力的托管后端与离线场景，平滑回退到浏览器 `localStorage`。

## 非目标

- 跨 daemon 云端同步或 Managed Host 服务端路由实现（托管端在宣告 `workspace_input_history` 前保持本地回退）。
- 跨设备输入框草稿同步。
- 改造 TUI `logs.json` 的撤销与删会话清理语义。

## 设计方案

### 1. Daemon 持久化存储（`packages/cli/src/serve/workspace-input-history.ts`）

每个工作区在 `Storage(workspaceCwd).getProjectTempDir()` 下按类型最多保存 `100` 条去重历史：

- `kind = 'prompt'`：`<project-temp>/input_history.json`，JSON `string[]`，按**从旧到新**排列（与 Web Shell `useInputHistory` 一致）。
- `kind = 'shell'`：复用 `Storage(workspaceCwd).getHistoryFilePath()`（`<project-temp>/shell_history`），磁盘上保持**最新在前**（与 `packages/cli/src/ui/hooks/useShellHistory.ts` 一致）。读写辅助函数在边界处完成顺序转换，HTTP 接口统一返回从旧到新的 `entries`。

持久化约束：

- 对输入做 `trim`，忽略空字符串及超过 `32_768` 字符的超大条目。
- 去重时将已有相同条目移至最新位置，并截断至最近 `100` 条。
- 按文件路径维护进程内 Promise 写队列，并通过同目录 `0o600` 临时文件 + `rename` 原子写入。
- 文件不存在（`ENOENT`）或 JSON 损坏时安全返回 `[]`。
- 基于规范化结果计算轻量 `revision`（短 SHA-256 摘要），支持 `ETag` / `If-None-Match`（`304 Not Modified`）。

### 2. 服务端自动记录

常规提交由服务端自动写入，无需前端额外发起写请求：

- `POST /session/:id/prompt`：当受理成功（`!admission.deduplicated`）且非外部 channel 中继（`!classification.channelPrompt && !classification.requestedChannelPrompt`）时，优先取 `classification.submittedPrompt`（保留原始 `@file` / `/slash` 文本），否则拼接 `prompt` 中的文本块，写入 `runtime.workspaceCwd` 的 `prompt` 历史。
- `POST /session/:id/mid-turn-message`：在 `enqueueMidTurnMessage` 成功后，若 `trimmed` 非空，写入 `runtime.workspaceCwd` 的 `prompt` 历史。
- `POST /session/:id/shell`：校验 `command.trim()` 通过后，立即写入 `runtime.workspaceCwd` 的 `shell` 历史。

所有自动记录均为 best-effort（异常通过 `daemonLog` 记录，绝不阻塞或导致会话请求失败）。

### 3. HTTP 路由与能力宣告

路由作用域与信任边界：

| 路由                                        | 作用域归属         | 信任与失败语义                                                                                                                  |
| ------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspace/input-history`              | `legacy-primary`   | 检查 primary generation 未关闭；返回 `200 { kind, entries, revision }` 或命中 `If-None-Match` 时返回 `304`。                    |
| `POST /workspace/input-history`             | `legacy-primary`   | 挂载 `mutate()`；检查 primary generation 未关闭；供纯客户端本地命令（如不走 `/prompt` 的本地斜杠命令）追加 `{ kind, entry }`。  |
| `GET /workspaces/:workspace/input-history`  | `selected-runtime` | 走 `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` + generation 守卫；绝不回落 primary。                  |
| `POST /workspaces/:workspace/input-history` | `selected-runtime` | 挂载 `mutate()`；走 `resolveWorkspaceRuntimeFromParam` + `requireTrustedWorkspaceRuntime` + generation 守卫；绝不回落 primary。 |

参数与请求体校验：

- `kind`：`POST` 必填，`GET` 可选（默认 `'prompt'`），仅允许 `'prompt' | 'shell'`（否则 `400 invalid_input_history_kind`）。
- `limit`（`GET` 可选）：`1..100` 的正整数（否则 `400 invalid_limit`）。
- `entry`（`POST` 必填）：trim 后非空且长度不超过 `32_768` 字符的字符串（否则 `400 invalid_entry`）。

能力宣告：

- 在 `packages/sdk-typescript/src/daemon/capabilities.ts` 注册 `workspace_input_history: { since: 'v1' }`（由 `packages/cli/src/serve/capabilities.ts` re-export，`qwen serve` 无条件宣告）。
- 在 `packages/cli/src/serve/capability-parity.ts` 登记为 `NO_MANAGED_EQUIVALENT('no Managed input history route')`。

### 4. Web Shell 同步与降级

- **Workspace Actions（`packages/web-shell/client/daemon/workspace/actions.ts`）**：
  - `loadInputHistory({ kind, limit, workspaceId, ifNoneMatch })`：非 primary 可信工作区请求 `/workspaces/:id/input-history`，primary 请求 `/workspace/input-history`；命中 `304` 返回 `{ notModified: true }`，否则返回 `{ notModified: false, entries, revision }`。
  - `recordInputHistory({ kind, entry, workspaceId })`：best-effort `POST`，用于不经过 `/session/:id/prompt` 的本地斜杠命令。
- **目标工作区解析**：
  - 仅在 `capabilities.features` 包含 `'workspace_input_history'` 时启用。
  - 若指定了非 primary 的 `atWorkspaceCwd`，要求同时具备 `'workspace_qualified_rest_core'`、在 `capabilities.workspaces` 中唯一命中且 `trusted !== false`；未知、歧义或未信任工作区严格保持纯本地模式，绝不回落 primary `/workspace/input-history`。
- **Shell 历史按工作区隔离**：
  - Shell 历史 `localStorage` key 改为按工作区隔离（`qwen-web-shell-command-history:<workspace>`），并在允许回退时兼容旧 key `qwen-web-shell-command-history`。
- **`useComposerCore.ts` 中的同步触发时机**：
  1. 挂载与切换工作区时预拉（预拉 prompt 历史；处于 shell 模式时预拉 shell 历史）。
  2. 打开 Input history 面板时（`openHistorySearch`，桌面 `Ctrl+R` 或手机 `+ -> Input history`），异步返回后若面板仍处于打开状态，立即刷新 `searchMatches`。
  3. 从空闲态首次按 `↑`（`!isNavigating()`）时触发一次条件刷新。
  4. 窗口 `focus` / `visibilitychange`（`visible`）时刷新，覆盖手机切回浏览器标签页的场景。
  5. 实时跨端 SSE 信号（`remotePromptSidechannel.ts`，由 `DaemonSessionProvider.tsx` 在收到来自其他 `originatorClientId` 的实时 `user.text.delta` 或 `midTurnInjected` 时发布），在电脑和手机同时打开同一会话时立即触发条件刷新。
- **合并与竞态防护（`useInputHistory.ts`）**：
  - `mergeRemoteHistory(localEntries, remoteEntries)`：保留仅存在于本地的唯一条目在前，再按服务端顺序追加远端条目，截断至最近 `100` 条。
  - 维护每次本地 `push()` 递增的变更序号，防止请求发起后、响应返回前发生的新本地提交被陈旧的 `GET` 响应覆盖。
  - 搜索面板关闭时不触发宿主组件额外重渲染，保持既有无重渲染不变量。

## 验收标准

1. 在电脑端提交普通 Prompt 或 mid-turn 消息后，同一工作区的手机端无需手动刷新页面即可在 Input history 面板看到该条目。
2. 在电脑端执行 Shell 模式命令后，手机端 Shell Input history 可看到该命令，且持久化于 `<project-temp>/shell_history`。
3. 多工作区路由（`/workspaces/:workspace/input-history`）严格限定在解析出的可信 runtime 内，对未知、未信任或已关闭 generation 的工作区返回明确错误，绝不回落 primary。
4. 不具备 `workspace_input_history` 能力的旧版 daemon、离线浏览器与独立单测继续通过 `localStorage` 正常工作，无报错或多余重渲染。
