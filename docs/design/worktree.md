# Worktree 通用能力设计

## 问题陈述

qwen-code 目前仅有面向 Arena 多模型对比场景的内部 worktree 实现（`GitWorktreeService`），用户无法在普通会话中使用 worktree 隔离工作，AgentTool 也不支持为 subagent 创建隔离的 worktree 环境。

目标是将 worktree 做成通用能力，支持用户会话级隔离和 Agent 级隔离，同时保证现有 Arena 功能体验完全不变。

## 现状对比

| 功能                              | qwen-code       | claude-code |
| --------------------------------- | --------------- | ----------- |
| `EnterWorktree` 工具              | ❌              | ✅          |
| `ExitWorktree` 工具               | ❌              | ✅          |
| AgentTool `isolation: 'worktree'` | ❌              | ✅          |
| worktree 会话状态持久化与恢复     | ❌              | ✅          |
| 过期 worktree 自动清理            | ❌              | ✅          |
| Post-creation setup（hooks 配置） | ❌              | ✅          |
| StatusLine worktree 状态展示      | ❌              | ✅          |
| WorktreeExitDialog（退出提示）    | ❌              | ✅          |
| 符号链接目录（node_modules 等）   | ❌              | ✅          |
| sparse checkout                   | ❌              | ✅          |
| `--worktree` CLI 启动标志         | ❌              | ✅          |
| tmux 集成                         | ❌              | ✅          |
| Arena 多模型 worktree 隔离        | ✅（qwen 独有） | ❌          |
| 脏状态覆盖（stash + copy）        | ✅              | ✅          |
| Baseline commit 追踪              | ✅（qwen 独有） | ❌          |

## 设计原则

**worktree 是通用能力，Arena 是其上层应用。**

- 通用 worktree 层：`EnterWorktree`/`ExitWorktree` 工具、AgentTool `isolation` 参数、会话状态管理、自动清理
- Arena 层：多模型并行调度、`worktreeBaseDir` 自定义路径、批量创建与 diff 对比，继续使用 `GitWorktreeService.setupWorktrees()` 的现有逻辑，不受通用层改动影响

AgentTool 的 `isolation: 'worktree'` 只走通用路径，Arena 内部不经过这个参数创建 worktree，两者路径独立。

## 路径与配置

### 通用 worktree 路径

由 `EnterWorktree` 工具或 AgentTool `isolation: 'worktree'` 创建的 worktree 固定存放在：

```
{git 仓库根}/.qwen/worktrees/{slug}
```

路径不可配置。slug 命名规则：

- 用户会话 worktree：用户指定名称，或自动生成（格式：`{形容词}-{名词}-{4位随机}`）
- Agent worktree：`agent-{7位随机 hex}`

### Arena worktree 路径（已有，保持不变）

Arena 的 worktree 路径由 `agents.arena.worktreeBaseDir` 控制，默认 `~/.qwen/arena`（`ArenaManager.ts:125`），与通用路径完全独立，不做任何改动。

### 扩展配置（暂缓至 Phase C/D）

| 配置项                        | 类型       | 用途                                                           | 阶段    |
| ----------------------------- | ---------- | -------------------------------------------------------------- | ------- |
| `worktree.symlinkDirectories` | `string[]` | 符号链接指定目录（如 `node_modules`）到 worktree，避免磁盘浪费 | Phase C |
| `worktree.sparsePaths`        | `string[]` | git sparse-checkout cone 模式，大型 monorepo 只写入指定路径    | Phase D |

Phase A / B 不新增任何配置项。

## 工具设计

### EnterWorktree

**触发条件：** 用户明确说 "start a worktree"、"use a worktree"、"create a worktree" 等词语。不应在用户说"修复 bug"、"开发功能"时自动触发。

**输入 schema：**

```
name?: string  // 可选，slug 格式：字母/数字/点/下划线/破折号，最大 64 字符
```

**行为：**

1. 验证当前未在 worktree 中（防止嵌套）
2. 解析到 git 仓库根（处理已在子目录的情况）
3. 调用 `GitWorktreeService` 创建 worktree，路径为 `.qwen/worktrees/{slug}`
4. 将 worktree 会话写入 `SessionService`
5. 切换工作目录到 worktree 路径
6. 清除文件缓存

**输出：** `worktreePath`、`worktreeBranch`、`message`

### ExitWorktree

**触发条件：** 用户说 "exit the worktree"、"leave the worktree"、"go back" 等。

**输入 schema：**

```
action: 'keep' | 'remove'
discard_changes?: boolean  // 仅 action='remove' 时有效
```

**安全守卫：**

- 仅操作本会话通过 `EnterWorktree` 创建的 worktree
- `action='remove'` 且存在未提交变更时，拒绝执行（除非 `discard_changes: true`）

**行为：**

- `keep`：清空会话中的 worktree 状态，保留 worktree 目录和分支，恢复原始工作目录
- `remove`：删除 worktree 目录，删除对应 git 分支，清空会话状态，恢复原始工作目录

**输出：** `action`、`originalCwd`、`worktreePath`、`worktreeBranch`

## 用户触发方式

| 方式           | 示例                                                     | 实现阶段 |
| -------------- | -------------------------------------------------------- | -------- |
| 会话中明确请求 | 用户说 "在 worktree 中开始工作" → 模型调用 EnterWorktree | Phase A  |
| Agent 隔离     | 模型为 subagent 设置 `isolation: 'worktree'`             | Phase B  |
| CLI 启动标志   | `qwen --worktree my-feature`                             | Phase D  |

无斜杠命令。会话中 worktree 的触发依赖用户明确提及，`isolation: 'worktree'` 才是模型自主决策的场景。

## 分阶段实现计划

### Phase A：核心工具（用户会话级 worktree）

**目标：** 用户能在会话中进入 / 退出 worktree。

**要实现的功能：**

- `EnterWorktree` 工具：创建 worktree，切换工作目录，记录会话状态
- `ExitWorktree` 工具：keep / remove 两种退出方式，安全守卫
- `GitWorktreeService` 扩展：新增面向单用户会话的 `createUserWorktree()` / `removeUserWorktree()` 方法，复用现有 git 操作逻辑，不改动 Arena 使用的批量接口
- `SessionService` 扩展：新增 `WorktreeSession` 字段，记录 `{ slug, worktreePath, worktreeBranch, originalCwd, originalBranch }`；`--resume` 时恢复 worktree 工作目录
- 工具 prompt：为每个工具编写使用说明，明确何时调用、何时不调用

**影响文件：**

| 文件                                               | 变更类型                                      |
| -------------------------------------------------- | --------------------------------------------- |
| `packages/core/src/tools/tool-names.ts`            | 新增 `ENTER_WORKTREE`、`EXIT_WORKTREE` 常量   |
| `packages/core/src/tools/EnterWorktreeTool/`       | 新建目录：`EnterWorktreeTool.ts`、`prompt.ts` |
| `packages/core/src/tools/ExitWorktreeTool/`        | 新建目录：`ExitWorktreeTool.ts`、`prompt.ts`  |
| `packages/core/src/services/gitWorktreeService.ts` | 新增用户会话级接口（不改动 Arena 接口）       |
| `packages/core/src/services/sessionService.ts`     | 新增 `WorktreeSession` 字段及读写方法         |
| `packages/core/src/tools/` 注册入口                | 注册新工具                                    |

**不在 Phase A 范围内：**

- Agent 隔离（Phase B）
- hooks 配置等 post-creation setup（Phase C）
- UI 状态展示（Phase C）

---

### Phase B：Agent 隔离（AgentTool `isolation: 'worktree'`）+ 描述更新

**目标：** 模型可为 subagent 创建临时隔离 worktree，agent 结束后自动清理；同步更新受影响的工具描述和提示词。

**要实现的功能：**

_Agent 隔离核心：_

- `AgentTool` 新增 `isolation?: 'worktree'` 参数
- Agent 启动时创建临时 worktree（slug：`agent-{7hex}`，路径：`.qwen/worktrees/agent-{7hex}`）
- Agent 结束后：无变更则自动删除；有变更则保留，将路径和分支返回在结果中
- 过期 worktree 自动清理：扫描 `.qwen/worktrees/`，匹配 `agent-{7hex}` 模式，超过 30 天且无未推送提交则删除，fail-closed 策略

_描述与提示词更新：_

- `AgentTool` description 补充 `isolation: 'worktree'` 参数说明（参考 claude-code `AgentTool/prompt.ts:272`）
- 新增 `buildWorktreeNotice()`：当 fork subagent 在 worktree 中运行时，向其注入上下文提示，说明其处于隔离 worktree、路径继承自父 agent、编辑前需重新读取文件（参考 claude-code `forkSubagent.ts:buildWorktreeNotice`）

_无需改动：_

- review skill（`SKILL.md`）：review 使用独立机制（路径 `.qwen/tmp/review-pr-<n>`，通过 `qwen review fetch-pr` 命令创建），与通用 worktree 路径和机制完全不同，不存在混淆

**Arena 兼容保证：** Arena 内部不经过 `isolation` 参数创建 worktree，此改动不触碰 Arena 代码路径。

**影响文件：**

| 文件                                               | 变更类型                                               |
| -------------------------------------------------- | ------------------------------------------------------ |
| `packages/core/src/tools/agent/agent.ts`           | 新增 `isolation` 参数及 worktree 创建/清理逻辑         |
| `packages/core/src/tools/agent/fork-subagent.ts`   | 新增 `buildWorktreeNotice()` 并在 worktree 模式下注入  |
| `packages/core/src/services/gitWorktreeService.ts` | 新增 `createAgentWorktree()` / `removeAgentWorktree()` |
| `packages/core/src/services/worktreeCleanup.ts`    | 新建：过期 worktree 自动清理逻辑                       |

---

### Phase C：体验优化（Post-creation setup + UI）

**目标：** worktree 创建后自动初始化环境，状态在界面上可见。

**要实现的功能：**

- Post-creation setup：配置 `core.hooksPath` 指向主仓库（qwen-code 无 `settings.local.json` 概念，不需要复制）
- StatusLine 展示当前 worktree 名称 / 分支
- WorktreeExitDialog：会话退出时（检测到 worktree 仍活跃）提示用户选择 keep 或 remove
- 新增 `worktree.symlinkDirectories` 配置项，实现目录符号链接

---

### Phase D：高级功能

**目标：** 对齐 claude-code 的完整特性集。

**要实现的功能：**

- `--worktree [name]` CLI 启动标志：启动时直接创建 worktree，整个会话在隔离环境中运行
- sparse checkout 支持：新增 `worktree.sparsePaths` 配置项
- `.worktreeinclude` 文件：支持将 gitignore 的文件复制到 worktree
- tmux 集成：`--worktree --tmux` 在 tmux 会话中启动
- PR 引用解析：`--worktree=#123` 自动 fetch 并基于 PR 创建 worktree
