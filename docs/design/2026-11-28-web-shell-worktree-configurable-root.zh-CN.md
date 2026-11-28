# 可配置的托管 Worktree 根目录（P7）

[English](2026-11-28-web-shell-worktree-configurable-root.md) | [简体中文](2026-11-28-web-shell-worktree-configurable-root.zh-CN.md)

- 状态：已定稿并在分支 `feat/web-shell-worktree-p7`（基于 `origin/main` `32d857ab81`）实施中。
- 跟踪：[#17237](https://github.com/QwenLM/qwen-code/issues/17237)（P7），并一并覆盖 [#15292](https://github.com/QwenLM/qwen-code/issues/15292) 提出的共享配置诉求。
- 前置设计：`2026-11-14-web-shell-codex-worktree-parity.zh-CN.md`（D2 / P7）与 `2026-11-21-web-shell-worktree-retention-restore.zh-CN.md`（P6 U4/U5）。
- E2E 测试计划：`.qwen/e2e-tests/2026-11-28-web-shell-worktree-configurable-root.md`。

## 问题与变更前现状

CLI 通用 worktree（`--worktree`、`enter_worktree`、`exit_worktree`、`agent` 的 `isolation: "worktree"`、workflow 隔离）与 Web Shell / daemon 托管会话 worktree（`POST /session`、handoff、branch、reset、restore、孤儿清理、保留清扫）共用 `GitWorktreeService.getUserWorktreesDir()`，当前硬编码为 `<repoRoot>/.qwen/worktrees`。

当项目的构建系统、IDE 或文件监听器会扫描点目录或对 `.qwen/` 有特殊处理时，用户无法将托管 worktree 调整到仓库内其它相对目录。变更前存在以下缺口：

- `settingsSchema.ts` 仅有 `worktree.defaultForNewSessions`、`worktree.symlinkDirectories`、`worktree.maxRetained`，没有根目录配置项。
- `GitWorktreeService.getUserWorktreesDir()`、`ensureWorktreesExcludeRule()`、`removePreparedUserWorktree()` 与 `symlinkConfiguredDirectories()` 硬编码 `.qwen/worktrees`，符号链接防递归检查也只排除了 `.git` 和 `.qwen`。
- 安全敏感的包含性、所有权与路径核验逻辑（`worktreeSessionService.ts`、`session.ts`、`session-restore.ts`、`worktree-orphan-cleanup.ts`、`worktree-retention.ts`、`worktree-snapshot-binding.ts`、`worktree-snapshot-pairs.ts`、`session-worktree-restore.ts`、`branch-worktree-preparation.ts`、`workspace-route-runtime.ts`、`workspace-git-worktrees.ts`）硬编码 `.qwen/worktrees` 或构造 `GitWorktreeService` 时未传入配置根。
- 嵌套 worktree 守卫（`worktreeStartup.ts`、`enter-worktree.ts`、`agent.ts`、`workflow-orchestrator.ts`）、启动陈旧清扫（`Config.initialize()`、`worktreeCleanup.ts`）、`--resume` 项目哈希匹配（`sessionService.ts`）、工作区产物路径工具（`workspace-artifact-path.ts`、`workspace-artifact-directory.ts`）以及 Web Shell UI（`GitModePopover.tsx`、`SettingsMessage.tsx`）均硬编码 `.qwen/worktrees`。

## 目标与范围边界

### 目标

1. 新增 `worktree.root` 作为统一的仓库内相对路径配置（默认 `.qwen/worktrees`），同时作用于 CLI 通用 worktree 与 Web Shell / daemon 托管会话 worktree。
2. 实施严格的路径校验与包含性约束（非法配置、绝对路径、`..` 穿越、`.git`、直接指向 `.qwen`，以及自定义根经 symlink/junction 逃出仓库根时一律失败关闭）。
3. 将 `packages/core`、`packages/cli`、`packages/web-shell` 中全部 `.qwen/worktrees` 硬编码站点迁移至单一的 `worktree.root` 解析与校验模块。
4. 保证 `worktree.symlinkDirectories` 对任意自定义 `worktree.root` 都具备递归防护（拒绝自定义根自身、其子目录及其祖先目录）。
5. 在 Web Shell 设置接口（`GET`/`POST` `/workspace/settings` 与 `/workspaces/:workspace/settings`）暴露 `worktree.root`，同步重新生成 `settings.schema.json`，并在 `GitModePopover` 中展示生效的根目录。

### 不在范围内

- 仓库外绝对路径形式的 `worktree.root`（保持托管检出位于已信任仓库子树内，使 daemon shell 守卫包含性无需放宽信任边界）。
- Arena 多模型 worktree（继续由 `agents.arena.worktreeBaseDir` 控制 `~/.qwen/arena`）。
- 用户修改 `worktree.root` 时对磁盘上既有旧目录的自动搬迁。
- 独立跟踪的其它 daemon guard issue（[#11503](https://github.com/QwenLM/qwen-code/issues/11503) 与 [#13705](https://github.com/QwenLM/qwen-code/issues/13705)）。

## 设计决策与依据

### 1. 配置键名与统一作用范围（`worktree.root`）

在 `settingsSchema.ts` 与 `WorktreeSettings` 中新增 `worktree.root`（类型 `string`，默认值 `'.qwen/worktrees'`，`requiresRestart: false`）。由于 CLI worktree 与 Web Shell 会话 worktree 本就共用 `GitWorktreeService.getUserWorktreesDir()`，统一使用单一键名即可保持两端一致，并覆盖 `#15292` 的诉求而无需引入重复别名（`worktree.baseDir`）。Arena 继续保留独立的 `agents.arena.worktreeBaseDir`。

`worktree.root` 在 User 作用域（`~/.qwen/settings.json`）、System 作用域以及已信任 Workspace 作用域（`<repo>/.qwen/settings.json`）均生效，与 `worktree.symlinkDirectories`、`worktree.defaultForNewSessions`、`worktree.maxRetained` 保持一致；未信任工作区不会加载 `.qwen/settings.json`。

### 2. 校验与规范化规则

在零外部依赖的核心模块 `packages/core/src/utils/worktree-root.ts` 中集中提供 `DEFAULT_WORKTREE_ROOT`、`InvalidWorktreeRootError`、`validateWorktreeRoot` 与 `parseWorktreeRoot`：

- `undefined` 解析为默认值 `.qwen/worktrees`（`isDefault: true`）。
- 拒绝非字符串、空/纯空白、首尾带空白、含控制字符（`[\x00-\x1f\x7f]`）/ NUL / 换行符、以及长度超过 240 字符的值。
- 拒绝 POSIX 绝对路径（`/…`）、Windows 盘符或 UNC 路径（`C:…`、`\\…`）、波浪号路径（`~`、`~/…`）以及含冒号（`:`）的分段。
- 拒绝任何 `..` 分段；折叠冗余的 `.` 与尾部斜杠后若结果为空（如 `.`、`./`）同样拒绝。
- 拒绝首段为 `.git`（大小写不敏感）的路径。
- 拒绝单段 `.qwen`（大小写不敏感），防止 worktree 与 `.qwen/settings.json`、`.qwen/commands/` 冲突或导致 `.git/info/exclude` 隐藏整个 `.qwen/`；`.qwen/` 下的子目录（如 `.qwen/worktrees`、`.qwen/wt`）仍允许。
- 规范化形式统一为 POSIX 正斜杠拼接的 `segments.join('/')`。

### 3. 非法配置失败关闭与 symlink/junction 包含性

- **设置写入接口**：`validateSettingValue` 调用 `validateWorktreeRoot` 校验 `worktree.root`，在 `/workspace/settings` 与 `/workspaces/:workspace/settings` 上对非法值返回 HTTP `400`（`code: 'invalid_value'`）。
- **运行时读取**：daemon 路由与服务统一通过 `readRuntimeWorktreeRoot(runtime)` / `readWorkspaceWorktreeRoot(cwd, ...)` 经 `readSettingsSnapshot` 只读读取（不写盘、遵守 `workspaceTrusted`、校验 `worktree` 段为普通对象）。遇到非法配置时抛出 `InvalidWorktreeRootError`，绝不静默回退到 `.qwen/worktrees`：
  - 创建 / handoff / branch 路由返回 `400`（`code: 'invalid_worktree_root'`）。
  - 保留清扫置 `settingsError` 并暂停清扫（失败关闭），且在逐候选执行时与 `maxRetained` 一同重检 `worktree.root`。
  - 孤儿清理保留检出并输出诊断日志。
  - CLI `restoreWorktreeContext` 记录告警并跳过恢复，不删除 sidecar。
  - CLI `--worktree`、`enter_worktree`、`exit_worktree`、`agent` 与 workflow 隔离返回明确错误。
- **符号链接 / junction 处理**：
  - 对所有根（默认与自定义），解析后的托管目录均不得落到 `canonicalRepoTop` 本身或 `canonicalGitDir` 内部；叶节点符号链接（`<root>/<slug> -> outside`）始终由 realpath 包含性拒绝。
  - 对自定义根（`!isDefault`），`assertWorktreeRootContainment` 额外要求解析后的托管目录及仓库内每个已存在中间目录都严格位于 `canonicalRepoTop` 内部，拒绝任何指向仓库外的 symlink 或 Windows junction。
  - 保留运维人员将默认 `.qwen/worktrees` 符号链接到外部目录的既有测试契约；`isBranchWorktreeCreationSupported` 继续通过 `lstat().isDirectory()` 逐段检查自定义根的每一级前缀并拒绝符号链接；`removePreparedUserWorktree` 继续要求严格的规范路径恒等 `<canonicalRepo>/<root>/<slug>`。

### 4. Git ignore、`symlinkDirectories`、产物路径与 daemon shell 守卫

- **`.git/info/exclude`**：`ensureWorktreesExcludeRule()` 针对配置后的 `worktree.root` 生成锚定规则并执行 `check-ignore -v` 探针。仅当 `isDefault === true` 时才执行旧版 `.qwen/.gitignore` 迁移，避免切换 `worktree.root` 后误删仍在保护旧 `.qwen/worktrees/` 的 `.qwen/.gitignore`。
- **`worktree.symlinkDirectories`**：除 `.git` 和 `.qwen` 外，同时拒绝（词法与 realpath 两个维度）位于自定义 `worktree.root` 内部或是其祖先目录的任何配置项（例如 `worktree.root: "tmp/wts"` 时拒绝 `symlinkDirectories: ["tmp"]`），防止递归嵌套循环。
- **嵌套 worktree 守卫**：`worktreeStartup.ts`、`enter-worktree.ts`、`agent.ts`、`workflow-orchestrator.ts` 在 cwd 位于当前 `worktree.root` 或默认 `.qwen/worktrees` 内时均拒绝嵌套创建。
- **工作区产物与 `--resume` 匹配**：`resolveBoundWorkspaceRoot`、`toCanonicalWorkspaceArtifactPath`、`stripWorktreeArtifactPrefix`、`pathHasSkippedDirectoryComponent` 与 `SessionService.matchesProject` 接收 `worktreeRoot`，使以点开头的自定义根（如 `.worktrees`）不会触发产物目录跳过规则，且 `--resume` 能正确命中仓库哈希。
- **Daemon git worktree 守卫（`daemon-git-worktree-guard.ts`）**：由于自定义 `worktree.root` 严格受限于 `canonicalRepoTop` 内，隔离 sub-agent 上报的 `canonicalReported` 仍在 `sessionCwd` 内部，`resolveDiscoveredRepository(canonicalReported, sessionCwd) === canonicalReported` 会自动将 sub-agent 边界锁定到其自身 worktree，无需硬编码路径。新增回归测试显式覆盖自定义根下的 sub-agent 边界隔离。

### 5. Daemon 路由归属分类

- `GET`/`POST` `/workspace/settings`：legacy-primary 工作区范围（读写主工作区或用户范围设置）。
- `GET`/`POST` `/workspaces/:workspace/settings`：selected-runtime 范围（受信任门禁保护，仅写工作区范围）。
- `POST /session`、`POST /session/:id/worktree-{reset,branch,handoff,restore}`、`POST /session/:id/branch`、`DELETE /session/:id`：live-session-owner / selected-runtime 范围；均从目标 runtime 自身的工作区配置解析 `worktree.root`，绝不回落到 primary runtime。
- `GET /workspaces/:workspace/git`、`GET /workspaces/:workspace/git/worktrees`：selected-runtime 范围；仅从所选 runtime 解析 `worktree.root`。
- 后台保留清扫（`worktree-retention.ts`）：daemon 全局按每个活跃 runtime 独立评估；冲突检测按各 runtime 解析后的托管根计算，同仓库存在非活跃 sibling 或配置不可读/非法时一律失败关闭。

## 风险与缓解

- **已有会话存在时修改 `worktree.root`**：旧根下的检出在新根下无法通过严格包含性校验（失败关闭：既不会被静默删除，也不会被静默接管）；用户切回原值或手动清理即可恢复。
- **受信任仓库内提交了指向仓库外的自定义根 symlink**：在 `mkdir` / `git worktree add` 之前由 `assertWorktreeRootContainment` 直接拦截，且全部读取/恢复/清扫路径同样拒绝。
- **`settings.schema.json` 漂移**：在同一提交中通过 `scripts/generate-settings-schema.ts` 重新生成并纳入校验。

## 验证计划与验收标准

1. **单元测试与集成测试**：
   - `worktree-root.test.ts`：完整校验矩阵（合法单段/多段相对路径、规范化、拒绝绝对/盘符/UNC/`~`/`..`/`.`/空/控制字符/`.git`/`.qwen`/超长）、路径匹配工具及 symlink/junction 包含性测试（仓库内 vs 仓库外逃逸 vs `.git` vs repoTop）。
   - `gitWorktreeService` 测试：自定义根创建、`.git/info/exclude` 写入且不误删旧 `.qwen/.gitignore`、`symlinkDirectories` 祖先/子孙防递归拦截、`removePreparedUserWorktree` 路径身份校验。
   - `worktreeSessionService`、`worktreeCleanup`、`enter-worktree`、`exit-worktree`、`agent`、`worktreeStartup`、`workspace-artifact-path`、`workspace-artifact-directory`、`sessionService`：自定义根全链路测试及非法根失败关闭测试。
   - Daemon 服务端测试：`workspace-settings`（读写校验 + i18n）、`session`（创建、handoff、branch、reset、restore、删除）、`worktree-orphan-cleanup`、`worktree-retention`、`session-worktree-restore`、`branch-worktree-preparation`、`workspace-route-runtime`、`workspace-git-worktrees`、`daemon-git-worktree-guard`。
   - Web Shell 测试：`GitModePopover` 自定义根展示、`SettingsMessage` 渲染与保存 `worktree.root`、多语言键覆盖校验。
2. **E2E 验证**：使用隔离的真实 Git 仓库运行 CLI `--worktree` 与真实 `qwen serve` HTTP 接口，验证自定义 `worktree.root` 全生命周期（创建、`.git/info/exclude`、handoff、保留快照与恢复、symlink 逃逸拒绝、非法设置 400）。
3. **构建、静态检查与 schema 同步**：`npm run build`、`npm run typecheck`、`npm run lint` 全绿，且 `packages/vscode-ide-companion/schemas/settings.schema.json` 无漂移。
