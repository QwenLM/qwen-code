# 项目级 Extensions 支持

## 背景

目前，extensions 仅支持**用户级**安装（`~/.qwen/extensions/`）。虽然代码中已有 `Storage.getExtensionsDir()` 返回 `<project>/.qwen/extensions/` 路径，以及公开方法 `loadExtensionsFromDir(dir)`，但两者在正常启动流程中均未被调用。

本设计方案旨在支持项目级 extension 安装，使 extension 可以限定在特定项目范围内，仅在该项目中生效。

## 现有架构

### 存储路径

| 级别   | 方法                                      | 路径                          |
| ------ | ----------------------------------------- | ----------------------------- |
| 用户级 | `Storage.getUserExtensionsDir()` (static) | `~/.qwen/extensions/`         |
| 项目级 | `Storage.getExtensionsDir()` (instance)   | `<project>/.qwen/extensions/` |

### 加载流程

1. `Config.initialize()` 创建 `ExtensionManager`（传入 `workspaceDir`），并调用 `refreshCache()`
2. `refreshCache()` 仅从 `ExtensionStorage.getUserExtensionsDir()`（`~/.qwen/extensions/`）加载
3. `loadExtensionsFromDir(dir)` 作为公开方法存在，但从未被调用
4. `performWorkspaceExtensionMigration()` 是死代码（已定义但从未被调用）

### 安装流程

- `installExtension()` 始终安装到 `ExtensionStorage.getUserExtensionsDir()`
- 目标目录：`~/.qwen/extensions/<extension-name>/`

### 关键文件

| 文件                                              | 职责                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| `packages/core/src/extension/extensionManager.ts` | 核心：Extension 接口、refreshCache、安装/卸载、启用管理              |
| `packages/core/src/config/storage.ts`             | 存储路径：getUserExtensionsDir（用户级）、getExtensionsDir（项目级） |
| `packages/core/src/extension/storage.ts`          | ExtensionStorage：每个 extension 的目录管理                          |
| `packages/cli/src/commands/extensions/install.ts` | CLI install 命令处理                                                 |
| `packages/cli/src/commands/extensions/utils.ts`   | CLI 工具函数、list 输出格式化                                        |

## 设计方案

### 1. 新增类型：`ExtensionScope`

在 `packages/core/src/extension/extensionManager.ts` 中新增：

```typescript
export enum ExtensionScope {
  User = 'user',
  Project = 'project',
}
```

扩展 `Extension` 接口，添加 `scope` 字段：

```typescript
export interface Extension {
  // ... 现有字段 ...
  scope: ExtensionScope;
}
```

### 2. 加载：`refreshCache()` 修改

修改 `refreshCache()`（第 544 行），增加项目级 extensions 加载：

1. 优先加载用户级 extensions，标记 `scope: User`
2. 若 `isWorkspaceTrusted === true`，从 `<project>/.qwen/extensions/` 加载项目级 extensions，标记 `scope: Project`
3. **冲突处理**：当两个级别存在同名 extension 时，用户级优先；项目级被忽略并输出 debug 日志警告
4. 若 `isWorkspaceTrusted === false`，完全跳过项目级加载（与 project hooks 的信任策略一致）

```typescript
async refreshCache(options?: { names?: string[] }): Promise<void> {
  this.extensionCache = new Map<string, Extension>();
  // ...现有的按名称加载逻辑...

  // 1. 加载用户级 extensions
  const userExtensions = await this.loadExtensionsFromExtensionsDir(
    ExtensionStorage.getUserExtensionsDir(), this.workspaceDir,
  );
  userExtensions.forEach(ext => ext.scope = ExtensionScope.User);
  const extensions = [...userExtensions];

  // 2. 加载项目级 extensions（需信任检查）
  if (this.isWorkspaceTrusted && this.workspaceDir) {
    const projectExtensionsDir = new Storage(this.workspaceDir).getExtensionsDir();
    const projectExtensions = await this.loadExtensionsFromExtensionsDir(
      projectExtensionsDir, this.workspaceDir,
    );
    projectExtensions.forEach(ext => ext.scope = ExtensionScope.Project);

    const userNames = new Set(userExtensions.map(e => e.name));
    for (const projExt of projectExtensions) {
      if (userNames.has(projExt.name)) {
        // 用户级优先，跳过项目级同名 extension
      } else {
        extensions.push(projExt);
      }
    }
  }

  extensions.forEach(ext => this.extensionCache!.set(ext.name, ext));
}
```

### 3. `loadExtensionByName()` 修改

修改 `loadExtensionByName()`（第 580 行），在用户级未找到时，继续在项目级目录中搜索：

```typescript
async loadExtensionByName(name: string, workspaceDir?: string): Promise<Extension | null> {
  // ... 现有用户级搜索逻辑 ...

  // 用户级未找到，尝试项目级（需信任检查）
  if (this.isWorkspaceTrusted && cwd) {
    const projectExtensionsDir = new Storage(cwd).getExtensionsDir();
    // 搜索 projectExtensionsDir 子目录...
  }

  return null;
}
```

### 4. `installExtension()` 修改

新增 `scope` 参数（第 842 行）：

```typescript
async installExtension(
  installMetadata: ExtensionInstallMetadata,
  requestConsent?: ...,
  requestSetting?: ...,
  cwd?: string,
  previousExtensionConfig?: ExtensionConfig,
  scope?: ExtensionScope,  // 新增
): Promise<Extension> {
```

关键改动：

- **目标目录**（第 868 行）：根据 scope 确定安装位置
  ```typescript
  const installScope = scope ?? ExtensionScope.User;
  const extensionsDir =
    installScope === ExtensionScope.Project
      ? new Storage(currentDir).getExtensionsDir()
      : ExtensionStorage.getUserExtensionsDir();
  ```
- **启用设置**（第 1113 行）：项目级安装使用 `SettingScope.Workspace`
- **加载后的 extension 对象**：设置 `extension.scope = installScope`

### 5. `uninstallExtension()` 修改

根据已加载 extension 的 `scope` 字段确定删除目录：

- `scope === Project` → 从 `<project>/.qwen/extensions/<name>/` 删除
- `scope === User` → 从 `~/.qwen/extensions/<name>/` 删除（现有逻辑）

### 6. CLI 改动

#### `install` 命令

在 `packages/cli/src/commands/extensions/install.ts` 中添加 `--scope` 选项：

```typescript
.option('scope', {
  describe: '安装范围："user"（全局，默认）或 "project"（仅当前项目）',
  type: 'string',
  choices: ['user', 'project'],
  default: 'user',
})
```

使用方式：

```bash
qwen extensions install <source> --scope project
```

#### `list` 命令

在输出中显示 scope（`packages/cli/src/commands/extensions/utils.ts`）：

```typescript
output += `\n Scope: ${extension.scope ?? 'user'}`;
```

#### `uninstall` / `link` 命令

添加 `--scope` 选项以支持歧义消除。

#### `enable` / `disable` 命令

无需修改 — 启用/禁用已通过路径规则支持 workspace 级别。

## 设计决策

| 决策     | 方案                                 | 理由                                            |
| -------- | ------------------------------------ | ----------------------------------------------- |
| 存储位置 | `<project>/.qwen/extensions/<name>/` | 沿用已有的 `Storage.getExtensionsDir()` 约定    |
| 信任控制 | 加载项目级 extensions 须通过信任检查 | 与 workspace settings 和 project hooks 保持一致 |
| 冲突处理 | 用户级优先                           | 与 MCP server 合并优先级一致                    |
| 版本控制 | 由用户/团队决定                      | `.qwen/extensions/` 可选择 gitignore 或提交     |

## 验证计划

1. `qwen extensions install <source> --scope project` 安装到 `<project>/.qwen/extensions/`
2. `qwen extensions list` 显示 scope 标识（user/project）
3. 切换到其他项目目录 — 该项目级 extension 不被加载
4. 在不受信任的 workspace 中，项目级 extensions 不被加载
5. 当用户级和项目级存在同名 extension 时，用户级优先
6. `qwen extensions uninstall <name>` 能正确从对应 scope 目录中删除
