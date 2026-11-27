# 单 Store 多版本扩展管理

[English](2026-11-27-multi-version-extension-store.md) | [简体中文](2026-11-27-multi-version-extension-store.zh-CN.md)

- **状态**：Draft（已完成 Core 与 CLI 最小闭环；Daemon V2 / TUI / Web Shell 后续跟进）
- **日期**：2026-11-27
- **关联 Issue**：[#18339](https://github.com/QwenLM/qwen-code/issues/18339)

## 问题背景与现状

在现有 Extension Management V2（[extension-management-v2.md](extension-management-v2.md)）架构下，所有已安装扩展都唯一存放在 `<QWEN_HOME>/extensions/<name>/`，且 `ExtensionStore` 在全局强制校验扩展名唯一。传入 `--scope workspace` 只是为这唯一一份产物写入 `defaultActivation: 'disabled'` 及对应工作区的 `enabled` 覆盖策略。

因此，开发者无法在同一台机器的不同工作区里同时运行同名扩展的不同版本或不同本地 `link` 分支，也无法在共享同一版本产物时隔离不同工作区的配置。

`#18339` 早期讨论的方案是把扩展物理装进 `<workspace>/.qwen/extensions/<name>/` 并另建第二套按工作区隔离的事务 Store。虽然形态上与 `.qwen/skills/` 对称，但 Extension 具备可执行能力（MCP 进程、Shell/HTTP Hooks、LSP、JS Workflows、Channels），将可执行产物放入业务 Git 仓库会引入显著的安全与架构复杂度：包括 `git pull` 绕过项目级 Hook/MCP 审批、在工作区内暴露新的 Auto-Mode 自我修改提权面、维护双 Store 事务与同盘 `.extension-tmp/`、双 generation 同步以及跨 Store 凭证引用计数。

## 目标与非目标

### 目标

- 在单一本机 `ExtensionStore` 下支持同名扩展多版本及多本地 `link` 分支并存，同时保持 `<QWEN_HOME>/extensions/` 根目录整洁。
- 将额外版本产物收进与 `extension-store/` 同盘平级的树状目录 `<QWEN_HOME>/extension-versions/<name>/<versionSlot>/`（无跨盘 `EXDEV`、无第二套 Store、不污染业务仓库）。
- 基于解析后的精确版本定位键计算确定性 64 位小写 hex `extensionId`，使同一真实版本在跨工作区安装时 100% 幂等去重复用。
- 在单 Store 锁事务内强制“单工作区同名互斥”，确保同一工作区同一时刻至多激活一个同名版本，且禁用后绝不回退到其他版本。
- 为共享的不可变版本产物提供按工作区隔离的 `.env` 与 Keychain 存储，不修改共享代码目录。
- 通过切换版本时的零引用自动回收与显式 `qwen extensions prune` 命令防止版本目录无限堆积。
- 修复 CLI 文件夹信任检查为 fail-closed（`isTrusted === true`），避免未表态（`undefined`）目录被默认放行。

### 非目标

- 不将可执行扩展产物直接写入 `<workspace>/.qwen/extensions/`（团队项目级声明式推荐清单作为独立后续工作）。
- Daemon V2 路由扩展、TypeScript SDK 增量接口、Ink/OpenTUI 管理弹窗及 Web Shell 前端 UI 留待 Core 与 CLI 契约验证后以独立 PR 跟进。
- 云端托管扩展包体系（`managed-agent-server`）不在本次范围内。

## 架构设计

### 存储布局

```text
<QWEN_HOME>/
├── extensions/                       # 保持不变：全局默认安装（每个扩展最多 1 个目录）
│   ├── extension-enablement.json     # V1 投影（同名多版本时投影主/默认策略）
│   ├── extension-preferences.json
│   └── <name>/
├── extension-versions/               # 平级树状版本库，存放工作区级多版本槽位
│   └── <name>/
│       ├── 2.0.0/                    # 可读版本号目录（撞名 / link / 本地包时补 -<8位ID>）
│       └── link-feature-a1b2c3d4/
└── extension-store/                  # 唯一事务型 V2 Store（1 把锁、1 份 state.json、1 套 generation）
    ├── lock
    ├── state.json                    # 可选 policy.versionSlot 指向 extension-versions/
    ├── state.previous.json
    ├── staging/ | rollback/ | transactions/
    ├── plugin-data/agent-plugins/<extensionId>/
    └── workspace-env/<extensionId>/<sha256(canonicalWorkspace)>.env
```

全局单版本扩展继续留在 `<QWEN_HOME>/extensions/<name>/`，避免顶层目录膨胀并保持对既有工具与旧版二进制的兼容性。

### 确定性版本键与幂等安装

非私有凭证的多版本安装会计算确定性 `versionKey` 并写入 `.qwen-extension-install.json`：

| 来源类型                        | `versionKey` 计算规则                            | 是否幂等复用   |
| ------------------------------- | ------------------------------------------------ | -------------- |
| `npm`                           | `npm:<registry>:<name>@<resolvedVersion>`        | 是             |
| `github-release`                | `gh-release:<source>:<releaseTag>`               | 是             |
| 公开 `git`                      | `git:<source>:<gitCommit \|\| ref \|\| version>` | 是             |
| 本地 `link`                     | `link:<canonicalTargetPath>`                     | 是             |
| `local` / `archive-url`         | `content:<name>:<directoryContentSha256>`        | 是             |
| `snapshot` / `stored` HTTPS Git | 不设 `versionKey`（沿用随机 `installId`）        | 刻意隔离不共享 |

64 位 hex `extensionId` 由 `sha256("v2:" + baseId + ":" + versionKey)` 生成。不同工作区安装同一真实版本（例如 `@acme/foo@2.0.0` 或内容完全一致的压缩包）时，会算出完全相同的 `extensionId`；若该产物已在磁盘与 `state.json` 中存在，Store 将幂等复用既有目录并仅更新 `workspaceOverrides`，不产生重复副本。

### 单 Store 互斥与双视图

- **同名互斥**：在单次 Store 锁事务（`commitArtifact`、`setWorkspaceActivation`、`setDefaultActivation`、`setActivationScope`）中，为某工作区启用某版本时，自动将该工作区下其他同名版本的 `workspaceOverrides[canonicalWs]` 置为 `'disabled'`。禁用某版本时不会重新启用其他版本（严格不回退）。
- **生效视图 vs 管理视图**：`ExtensionManager.extensionCache` 改为按 `extension.id` 索引。`getLoadedExtensions()` 对 `this.workspaceDir` 每个扩展名至多返回一条（优先当前激活版本，其次非版本化主副本），保证所有下游运行时注册表（MCP、Skills、Hooks、Commands、Agents、Workflows、LSP）零同名冲突；`getAllLoadedExtensions()` 暴露全部已安装版本供管理命令（`list --all`、`uninstall --version`、`prune`）使用。

### 按 Workspace 隔离配置

由于多个工作区可能共享 `extension-versions/<name>/<slot>/` 下的同一份不可变代码产物，版本化扩展的工作区级 `.env` 存放在 `<QWEN_HOME>/extension-store/workspace-env/<extensionId>/<sha256(canonicalWorkspace)>.env`，敏感配置 Keychain 命名空间绑定 `(extensionName, extensionId, canonicalWorkspaceDir)`。

### 版本自动回收与清理

- **切换版本自动回收**：提交新的工作区版本安装后，`ExtensionStore.pruneUnusedVersions()` 自动清理所有满足 `policy.versionSlot !== undefined`、`defaultActivation === 'disabled'`、无任何 `'enabled'` 工作区覆盖且无遗留路径规则的零引用版本目录。`<QWEN_HOME>/extensions/<name>/` 下的主副本绝不会被自动回收。
- **显式清理**：`qwen extensions prune [--dry-run] [--keep-missing-workspaces]` 清除指向已不存在工作区目录的失效覆盖，并回收因此归零的版本目录及关联的 `workspace-env` 和 `plugin-data`。

### CLI 接口

- `qwen extensions install <source> --scope workspace`：安装到版本槽位（若完全同版已存在则幂等复用），并仅为当前工作区互斥激活。
- `qwen extensions link <path> --scope workspace`：将本地源码分支链接到当前工作区专属的版本槽位。
- `qwen extensions list [--all]`：默认展示全局主副本及当前工作区激活的版本；`--all` 展示全机所有已安装版本及其绑定的工作区（并标注已缺失目录）。
- `qwen extensions uninstall <name> [--version <version|slot|idPrefix>]`：支持按版本/槽位/ID 前缀精确卸载，且在仍有其他同名副本时保留共享偏好。
- `qwen extensions prune [--dry-run]`：回收无引用版本槽位与失效工作区引用。

## 约束与风险

- **旧版二进制兼容**：旧版二进制忽略 `<QWEN_HOME>/extension-versions/`，继续读写 `<QWEN_HOME>/extensions/` 与 `extension-enablement.json`（同名多版本时按主/默认条目确定性投影）。
- **目录重命名与临时 Worktree**：按路径索引的 `workspaceOverrides` 在目录重命名后会重置，与既有 Folder Trust 及 V2 激活语义一致；可通过 `qwen extensions prune` 清理残留引用。
- **团队共享**：通过 Git 共享项目推荐扩展有意与二进制产物存储解耦，留待后续声明式项目清单方案实现。

## 验证计划与验收标准

1. **多版本并存与互斥**：全局 `foo@1.0.0`（位于 `extensions/foo/`）与工作区 `foo@2.0.0`（位于 `extension-versions/foo/<slot>/`）并存；工作区 A 运行 `1.0.0`、工作区 B 运行 `2.0.0`，在 B 禁用 `2.0.0` 不回退到 `1.0.0`，且 `getLoadedExtensions()` 对每个工作区至多返回 1 份 `foo`。
2. **同版本幂等复用**：在工作区 B 重复安装或在新工作区 C 安装同一份 `foo@2.0.0` 产物时，算出同一 `extensionId`，`extension-versions/foo/` 下仅存 1 份目录，并各自独立激活。
3. **自动回收与显式 `prune`**：工作区 B 从 `2.0.0` 切到 `3.0.0` 时，若无其他工作区引用则自动回收 `2.0.0`（若工作区 C 仍在使用则保留）；删除工作区 C 后执行 `prune` 可清除失效引用并回收 `2.0.0`。
4. **按工作区配置隔离与 `link --scope workspace`**：两个工作区共享 `2.0.0` 时各自读写独立的 `workspace-env/` 文件；两个工作区可同时 `link` 同一扩展的两个本地分支。
5. **CLI 信任 fail-closed**：未表态（`isTrusted: undefined`）目录在 CLI 扩展安装时被拒绝，不再默认信任。

## 后续工作

- 将多版本管理与版本化安装接入 Daemon V2、TypeScript SDK、Ink/OpenTUI 与 Web Shell。
- 在 `.qwen/settings.json` 中支持项目级声明式扩展推荐清单，提示用户一键确认安装到版本库。
