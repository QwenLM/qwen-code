# 从 Git 地址创建 Web Shell 工作区

[English](2026-10-23-web-shell-git-clone-workspace.md) | [简体中文](2026-10-23-web-shell-git-clone-workspace.zh-CN.md)

状态：提案

## 问题描述

Web Shell 的「添加工作区」对话框目前只能注册守护进程主机上已存在的目录，或通过 scratch 路径创建一个空目录。想从仓库开始工作的用户必须先离开浏览器，在那台机器的终端里 clone，再回来注册路径。对远程守护进程来说这是常见场景，这段绕行是工作区创建中最明显的体验缺口。

期望行为是把「Git 仓库」作为一等来源：粘贴 clone 地址、选择落盘位置、观察进度，完成后直接进入新工作区。

## 现状

- `packages/web-shell/client/components/dialogs/AddWorkspaceDialog.tsx` 接受绝对路径或 `ssh://` 工作区地址，通过 `onAdd` 提交。
- `packages/cli/src/serve/routes/workspace-management.ts` 的 `POST /workspaces` 注册已存在的目录，或只接受 `{ "kind": "scratch" }`，在守护进程私有的 scratch 根目录（`~/.qwen/scratch-workspaces/scratch-*`）下创建并注册空目录。
- 仓库里没有任何 clone 路径；`workspace-git*` 路由都是只读的（status、diff、log、branches、worktrees）。
- 除 managed scratch 与 live conversation 运行时外，新工作区默认是 `untrusted`，信任确认仍由用户完成。

## 目标

- 在「添加工作区」对话框里直接从 Git clone 地址创建工作区，带进度和取消。
- 注册语义与现在完全一致：容量、嵌套、展示名称、持久化以及守护进程的信任策略不变。clone 路径既不授予也不绕过信任。
- 收紧新增的文件系统写入面：明确的 URL 校验、必须不存在的显式目标路径、失败后的清理。
- 通过能力标签对外通告，旧守护进程和旧客户端保持可用。

## 非目标

- 从另一个守护进程页面经代理在远程守护进程上 clone（现有的就地远程添加代理）。第一版只对当前连接的守护进程提供 Git 来源，与现有「非连接位置不展示无法验证的能力」保持一致。
- 分支、tag、commit 选择，浅克隆，submodule 递归，Git LFS 特殊处理。
- 在浏览器里收集 Git 凭据。私有仓库依赖守护进程主机上的 SSH agent，或者把 token 放进粘贴的 URL。
- 页面关闭后恢复 clone 进度。守护进程会继续 clone 并把目录留在磁盘上，用户之后可以注册。

## 方案

### 守护进程 API

`POST /workspaces` 增加第二个判别变体：

```json
{
  "kind": "git",
  "url": "https://example.com/org/repo.git",
  "target": "/home/me/src/repo"
}
```

请求有界并立即返回：

```json
202 { "kind": "git-workspace-clone", "jobId": "..." }
```

新增两个任务路由：

- `GET /workspace-git-clone-jobs/:jobId` 返回状态、百分比、一条有界消息，成功时返回规范化后的 `cwd`。
- `DELETE /workspace-git-clone-jobs/:jobId` 取消正在运行的 clone。

任务终态为 `succeeded`、`failed` 或 `cancelled`。成功的任务只负责写入目录；客户端随后通过现有 `POST /workspaces { "cwd": ... }` 注册它。这一拆分刻意复用当前注册路径，避免在 clone 任务里重复容量、嵌套、持久化和信任逻辑。

### 目标路径策略

- `target` 必须是绝对路径；开头的 `~` 在守护进程主机上展开。
- 父目录必须存在、是目录且可写。
- 目标必须不存在。守护进程用非递归 `mkdir` 抢占该路径，避免两个并发请求 clone 到同一位置。
- 目标不能位于已注册工作区内部、不能包含已注册工作区、不能等于保留工作区根目录、不能与 managed scratch 根目录冲突。这些检查复用管理路由里已有的判定函数。
- 失败时守护进程删除自己抢占的目录；成功时不动目录内容。

### Clone 执行

- 通过参数数组执行 `git clone --progress -- <url> <target>`：URL 与目标从不经过 shell。唯一的例外是 URL 带凭据时注入的内联 `credential.helper`，它由 git 自己经 `/bin/sh` 执行，因此用 `printf` 输出而不用 `echo`。
- 设置 `GIT_TERMINAL_PROMPT=0`，缺少凭据时立即失败而不是挂起。
- 拒绝非 `http(s)://`、`ssh://`、`git://`、`git+ssh://`、scp 形式（`user@host:path`）或 `file://` 的 URL；拒绝以 `-` 开头的 URL（选项注入）和 `ext::` remote-helper 传输。
- Clone 上限 15 分钟并允许取消。取消会杀掉整个进程树，而不只是直接子进程。
- 最多两个并发 clone、保留八个已结束任务、终态任务十分钟后回收，进度上报有界（百分比加一条脱敏短消息）。
- 把 URL 的 userinfo 移出 git 的 argv：传给 git 的 URL 不含凭据，通过命令行 credential helper 从子进程环境读取密钥。因此 `.git/config` 里保存的 remote URL 也不含凭据，任务状态、进度消息和错误响应同样会脱敏。
- 为 clone 子进程禁用全局/系统 git config（`GIT_CONFIG_NOSYSTEM=1`，`GIT_CONFIG_GLOBAL` 指向平台空设备），并从子进程环境里清扫同类通道（`GIT_CONFIG_PARAMETERS`、`GIT_CONFIG_COUNT`、`GIT_ASKPASS`、`SSH_ASKPASS`、`GIT_SSH*`、`GIT_PROXY_COMMAND`、`GIT_EXEC_PATH`、`GIT_TEMPLATE_DIR`），使仓库提交的 `.gitattributes` 无法在 clone 的 checkout 阶段选中宿主机配置的 filter 命令，浏览器选定的地址也无法借用宿主凭据或传输配置。代价是宿主上配置的 `credential.helper`、`url.*.insteadOf`、`http.*` 对 clone 不生效：可用的是 SSH agent（继承 `SSH_AUTH_SOCK`）和 URL 自带凭据。

### 能力

当动态工作区注册可用且守护进程主机上的 `git` 可执行文件可响应时，通告新的 `git_workspace_clone` 能力。看不到该标签的客户端保持现有对话框。

### Web Shell

- 对话框增加来源选择器，两个值：目录与 Git 仓库。只有当前连接的守护进程、且通告了能力时才提供 Git 来源。
- Git 模式收集 URL 和目标目录，父位置可通过「浏览」选择。
- 提交后启动任务，表单替换为进度面板：百分比条、最新消息和取消。
- 轮询在终态停止。成功后对话框调用现有添加动作并传入返回的 `cwd`，然后关闭。
- 若 clone 成功但注册失败，对话框保留已 clone 的路径，下次提交只重试注册，避免瞬时注册错误导致第二次 clone。
- 若轮询期间网络失败、任务状态未知，对话框提示结果未知且不自动开始新的 clone；用户可重新检查工作区列表。

## 关键设计决策

| 决策                               | 理由                                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 使用异步任务而不是单个长请求       | 客户端变更预算为 30 秒，代理也会限制请求时长；clone 时间不可控，必须可观察、可取消。                                |
| 先 clone 目录，再用现有接口注册    | 容量、嵌套、持久化和信任只有一份实现。若在任务内部单独注册，逻辑会漂移。                                            |
| clone 本身不授予信任               | 任务只负责写入目录，信任由普通注册路径决定。关闭 folder trust 的主机会像注册任何已有目录一样把 clone 注册为受信任。 |
| 显式且必须不存在的目标             | 既不覆盖用户文件，也让失败清理没有歧义。                                                                            |
| Git 来源只对当前连接的守护进程开放 | 页面无法验证远程守护进程的能力，现有对话框对非连接位置已经采用「不展示无法验证的能力」的规则。                      |
| clone 后重试复用记住的 `cwd`       | clone 不幂等，注册幂等。把两者分开，重试才安全。                                                                    |

## 约束

- 包之间不允许相对导入；使用 ESM 与严格 TypeScript。
- `packages/core` 与 `packages/cli` 下新的 `.ts` 文件使用 `kebab-case`。
- 路由必须遵循现有 mutation gate 与错误信封。
- 任务状态是进程内的；守护进程重启会忘记运行中的任务，已完成的目录仍留在磁盘上。
- 关闭流程必须杀掉正在运行的 clone。

## 风险

- clone 不可信仓库不会运行宿主机配置的 smudge/clean filter，因为 clone 子进程忽略全局/系统 git config。仓库内容仍可定义 hook 或 filter，它们只会在用户之后于工作区执行命令时运行；clone 路径不授予信任，工作区沿用守护进程信任策略的判定，工具审批仍然生效。
- 超大仓库可能占满磁盘。15 分钟上限、取消和每守护进程并发限制可以约束影响，但不会预留空间。
- 页面关闭后才完成的 clone 会留下未注册目录；它在文件系统里可见，之后可以添加。

## 验证计划

- 用注入的进程运行器为 URL 与目标校验、进度解析、凭据脱敏、任务上限、取消和失败清理编写单元测试。
- 一个真实 Git 测试：在临时目录创建仓库后再 clone。
- 对话框测试覆盖来源切换、启动/轮询/成功、失败、取消，以及只重试注册。
- `npm run build`、`npm run typecheck`，以及针对改动包的聚焦 Vitest 运行。
- 用本地构建启动守护进程，在 Web Shell 的「添加工作区」对话框里做一次浏览器 E2E。

## 验收标准

- 用户可以粘贴公开的、走 SSH agent 的或自带 token 的 clone 地址、选择目标、看到进度、取消，并进入 clone 后的工作区。
- 失败或取消的 clone 不留下目标目录。
- clone 出的工作区与注册已有目录完全一致：clone 路径既不授予也不绕过信任，并像其他动态注册的工作区一样出现在列表中。
- 没有该能力的守护进程和旧客户端行为不变。
- 任务响应中绝不出现 URL 凭据。

## 待定问题

- 是否在后续版本提供浅克隆开关？改动很小，但不在本次范围内。
- 客户端断开后是否由守护进程完成注册？后续可以把任务持久化并在服务端完成注册。
