# Permission System 实现方案

## 概述

本文档描述了将 qwen-code 现有的 `tools.core` / `tools.exclude` / `tools.allowed` 配置方案升级为统一 Permission System 的完整实现方案。新方案对齐 Claude Code 的 Permission 设计，引入 `allow` / `ask` / `deny` 三态规则体系，并通过 `PermissionManager` 统一管控，同时提供完整的交互式 `/permissions` 对话框 UI。

---

## 背景与动机

### 现有方案的局限性

当前系统通过三个配置项管控工具权限：

- **`tools.core`**（白名单）：只有列出的工具才能注册启用。一旦非空，未列出的工具全部禁用。
- **`tools.exclude`**（黑名单）：列出的工具从注册中排除，模型无法调用。优先级最高。
- **`tools.allowed`**（免确认列表）：列出的工具调用时跳过用户确认弹窗，不影响工具是否可用。

主要不足：

1. **无 `ask` 独立规则**：无法针对某个工具单独设定"每次必须询问"，只能依赖全局 `approvalMode`。
2. **文件/路径级别无法控制**：无法表达"允许读文件但禁止读 `.env`"这类精细权限。
3. **Shell 命令通配符能力弱**：`tools.allowed` 的命令匹配只支持简单前缀，无法表达 `git * main` 这类中间通配。
4. **规则分散**：权限逻辑散落在 `tool-utils.ts`、`shell-utils.ts`、`coreToolScheduler.ts` 多处，维护困难。
5. **无 UI 管理入口**：缺少交互式规则管理界面，用户只能手动编辑 `settings.json`。

---

## 设计原则

1. **旧配置项彻底删除**：`tools.core` / `tools.exclude` / `tools.allowed` 随新版本完全移除，代码中不保留任何对旧配置的读取或兼容逻辑；存在旧配置的用户须通过启动时一键迁移功能完成迁移，迁移前旧配置不会生效。
2. **Manager 模式**：完全对齐项目现有的 `SkillManager` / `SubagentManager` 编码风格，通过 `config.getPermissionManager()` 对外暴露唯一实例。
3. **不引入系统级 managed-settings**：不新增 macOS `/Library/Application Support/` 等系统级配置文件支持。
4. **配置层级精简为三层**：User（`~/.qwen/settings.json`）、Workspace（`.qwen/settings.json`）、System（已有的 `getSystemSettingsPath()`），与现有 `LoadedSettings` / `SettingScope` 体系完全一致。

---

## 核心概念

### 规则格式

```
Tool                    # 匹配该工具的所有调用
Tool(specifier)         # 匹配带特定参数的调用
```

**示例**：

- `Bash` — 匹配所有 Shell 命令
- `Bash(git *)` — 匹配所有以 `git` 开头的命令
- `Bash(git * main)` — 匹配如 `git checkout main`、`git merge main`
- `Bash(* --version)` — 匹配任意工具的 `--version` 查询
- `read_file(./secrets/**)` — 匹配读取 `secrets/` 目录下任意文件（gitignore 路径语法）
- `run_shell_command(rm -rf *)` — 匹配危险删除命令

### 规则求值顺序（first-match-wins）

$$\text{deny} \rightarrow \text{ask} \rightarrow \text{allow}$$

`deny` 规则优先级最高。第一条匹配的规则即为最终决策，后续规则不再评估。

### 三种决策结果

| 决策      | 含义                                          |
| --------- | --------------------------------------------- |
| `allow`   | 自动批准，无需用户确认                        |
| `ask`     | 每次调用前弹出确认对话框                      |
| `deny`    | 直接拒绝，工具调用返回错误                    |
| `default` | 无规则匹配，回退到 `defaultMode` 全局模式处理 |

### 配置存储位置

规则存储在各级 `settings.json` 的 `permissions` 字段下：

```json
{
  "permissions": {
    "allow": ["Bash(npm run *)", "Bash(git commit *)"],
    "ask": ["Bash(git push *)"],
    "deny": ["Bash(rm -rf *)", "read_file(./.env)"]
  }
}
```

---

## 模块结构

### 新增模块：`packages/core/src/permissions/`

```
packages/core/src/permissions/
├── types.ts                 # 类型定义
├── rule-parser.ts           # 规则解析与匹配
├── permission-manager.ts    # 核心 Manager 类
└── index.ts                 # 对外导出
```

### 文件职责说明

#### `types.ts`

定义以下核心类型：

- **`PermissionDecision`**：`'allow' | 'ask' | 'deny' | 'default'`
- **`PermissionRule`**：解析后的规则对象，包含原始字符串、工具名、可选 specifier
- **`PermissionRuleSet`**：三组规则的集合（allow / ask / deny 数组）
- **`PermissionCheckContext`**：权限检查时的上下文，包含工具名和可选的调用参数
- **`RuleWithSource`**：带来源信息的规则，用于 `/permissions` 对话框展示（规则内容 + 规则类型 + 来源 scope）

#### `rule-parser.ts`

负责规则的解析和匹配逻辑，是纯函数模块，无副作用：

- **规则解析**：将 `"Bash(git *)"` 字符串解析为结构化的 `PermissionRule` 对象
- **工具名规范化**：处理工具别名映射（如 `ShellTool` / `run_shell_command` / `Bash` 的等价关系）
- **Shell 命令 glob 匹配**：
  - `*` 通配符可出现在命令的任意位置（头部、中间、尾部）
  - 空格前的 `*` 强制单词边界：`Bash(ls *)` 匹配 `ls -la` 但不匹配 `lsof`
  - 无空格的 `Bash(ls*)` 匹配 `ls -la` 和 `lsof` 两者
  - 识别 shell 操作符（`&&`、`|`、`;` 等），前缀匹配规则不跨操作符生效
- **文件路径匹配**（用于 `read_file` / `edit_file` 类规则）：
  - 遵循 gitignore 路径规范
  - `//path`：从文件系统根开始的绝对路径
  - `~/path`：相对于用户主目录
  - `/path`：相对于项目根目录
  - `./path` 或无前缀：相对于当前工作目录
  - `*` 匹配单层目录内文件，`**` 递归匹配多层

#### `permission-manager.ts`

`PermissionManager` 类，是整个权限系统的核心。

**构造器**：接收 `config: Config`，与 `SkillManager` 完全一致。

**初始化逻辑**：

1. 读取 `settings.permissions.allow` / `ask` / `deny`，合并为最终规则集
2. 初始化会话级规则集合（内存中，不持久化）

**核心方法**：

- **`evaluate(context: PermissionCheckContext): PermissionDecision`**
  主决策方法。按 deny → ask → allow 顺序评估规则，first-match-wins。无匹配时返回 `'default'`，由调用方根据 `getDefaultMode()` 处理。供 `CoreToolScheduler` 使用。

- **`isToolEnabled(toolName: ToolName): boolean`**
  判断工具是否应被注册。内部通过 `deny` 规则集合和 `allow` 规则集合综合判断，仅基于 `permissions.*` 新格式规则。供 `Config.createToolRegistry()` 使用。

- **`isCommandAllowed(command: string): PermissionDecision`**
  Shell 命令级权限检查，供 `shell-utils.ts` 中的 `checkCommandPermissions()` 调用，替代现有散乱的 `getCoreTools()` / `getExcludeTools()` 调用。

- **`listRules(): RuleWithSource[]`**
  返回所有生效规则（含来源 scope 信息），供 `/permissions` 对话框展示。来源标注为 `'system'` / `'user'` / `'workspace'` / `'session'`。

- **`addSessionAllowRule(rule: string): void`**
  在会话期间动态添加 allow 规则（内存中，不写入 settings 文件）。当用户在确认弹窗中点击"Always allow"时调用，替代现有的 `ToolConfirmationOutcome.ProceedAlways` 机制。

- **`addPersistentRule(ruleStr: string, type: 'allow' | 'ask' | 'deny', scope: SettingScope): void`**
  持久化写入规则到指定 scope 的 settings.json 文件，同时更新内存中的规则集。供 `/permissions` 对话框的"Add rule"操作调用。

- **`removeRule(ruleStr: string, type: 'allow' | 'ask' | 'deny', scope: SettingScope): void`**
  从指定 scope 的 settings.json 中删除规则，同时更新内存。供 `/permissions` 对话框的"Delete rule"操作调用。

- **`getDefaultMode(): ApprovalMode`**
  返回当前全局审批模式（`DEFAULT` / `AUTO_EDIT` / `YOLO` / `PLAN`），供 `CoreToolScheduler` 的回退逻辑使用。

---

## 配置迁移

`tools.core` / `tools.exclude` / `tools.allowed` 三个旧配置项在 Permission System 功能开发完成并发布后将**正式删除**，不再保留兼容逻辑。新版本启动时若检测到这些旧字段，会主动引导用户完成一键迁移。

### 旧配置映射规则

迁移逻辑需要将每个旧字段转换为等价的新格式规则：

| 旧配置项        | 旧值示例                       | 迁移为新字段                                                                                 | 说明                                               |
| --------------- | ------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `tools.core`    | `["read_file", "list_dir"]`    | `permissions.allow: ["Tool(read_file)", "Tool(list_dir)"]` + `permissions.deny: ["Tool(*)"]` | 白名单模式：列出工具加入 allow，追加全量 deny 兜底 |
| `tools.exclude` | `["run_shell_command"]`        | `permissions.deny: ["Tool(run_shell_command)"]`                                              | 黑名单直接映射为 deny                              |
| `tools.allowed` | `["run_shell_command(git *)"]` | `permissions.allow: ["Tool(run_shell_command(git *))"]`                                      | 免确认列表映射为 allow                             |

> **`tools.core` 特殊处理**：由于旧白名单语义等价于"允许列出的工具 + 拒绝其余所有工具"，迁移时须在 `permissions.deny` 末尾追加 `Tool(*)` 兜底规则。若用户 `permissions.deny` 中已存在 `Tool(*)`，不重复添加。

### 启动时迁移检测与提示

**触发条件**：应用启动、`Config.initialize()` 执行完毕后，`PermissionManager` 检测到以下任意条件成立：

- `settings.tools.core` 非空数组
- `settings.tools.exclude` 非空数组
- `settings.tools.allowed` 非空数组

**交互流程**：

1. 在 CLI 启动 banner 区域（首次 prompt 渲染之前）展示迁移提示，内容包括：
   - 检测到哪些旧字段及其当前值
   - 对应会迁移成哪些新规则（展示预览）
   - 影响哪个 settings 文件（user / workspace / local）
2. 询问用户是否立即迁移，提供三个选项：
   - **`[Y] 立即迁移`**：执行迁移，写入新字段，删除旧字段，打印成功信息
   - **`[n] 跳过`**：本次启动不迁移，旧字段本次**不会生效**，下次启动继续提示
   - **`[?] 查看详情`**：打印完整的字段对照表，然后重新展示选项

**迁移写入逻辑**：

迁移函数 `migrateLegacySettings(loadedSettings)` 实现以下步骤，按 scope（user / workspace / local）分别处理：

1. 读取该 scope 下 `tools.core` / `tools.exclude` / `tools.allowed` 的原始值（未合并）
2. 按映射规则生成等价的 `permissions.allow` / `permissions.deny` 条目
3. 调用 `LoadedSettings.setValue(scope, 'permissions.allow', [...existing, ...newAllow])` 追加新规则（避免覆盖该 scope 中已有的新格式规则）
4. 调用 `LoadedSettings.setValue(scope, 'permissions.deny', [...existing, ...newDeny])` 同上
5. 调用 `LoadedSettings.setValue(scope, 'tools.core', undefined)` 删除旧字段
6. 同样删除 `tools.exclude`、`tools.allowed`
7. 调用 `saveSettings(settingsFile)` 持久化

**CLI 参数的处理**：`--allowedTools` / `--disallowedTools` CLI 参数在 Permission System 完成后同步废弃，替换为 `--allow` / `--deny`，旧参数名在同一版本保留别名直至下一个 major 版本删除，不进入 settings 文件迁移流程。

### Settings Schema 同步清理

`tools.core` / `tools.exclude` / `tools.allowed` 字段在 `settingsSchema.ts` 中随 Permission System 一同**删除**。`LoadedSettings` 的类型定义、合并逻辑及相关单元测试同步清理。

---

## 改动清单

### 1. Settings Schema（`packages/cli/src/config/settingsSchema.ts`）

**目标**：新增 `permissions` 顶层配置字段，并删除旧字段。

**方案**：在 `settingsSchema` 的 `tools` 同级位置新增 `permissions` 配置节，包含：

- `permissions.allow`：array of strings，`MergeStrategy.UNION`（多层级数组合并）
- `permissions.ask`：array of strings，`MergeStrategy.UNION`
- `permissions.deny`：array of strings，`MergeStrategy.UNION`

同步删除 `tools.core`、`tools.exclude`、`tools.allowed` 字段定义。

**合并策略**：与现有 `tools.exclude` 的 `MergeStrategy.UNION` 一致，多层级的 `permissions.*` 数组会被合并而非覆盖，低优先级 scope 的规则会追加到高优先级 scope 的规则后面。

### 2. 核心权限模块（新建 `packages/core/src/permissions/`）

按上述模块结构说明创建全部文件。

`packages/core/src/index.ts` 中新增导出：

```
export { PermissionManager } from './permissions/index.js';
export type { PermissionDecision, PermissionRule, RuleWithSource } from './permissions/index.js';
```

### 3. Config 类（`packages/core/src/config/config.ts`）

**目标**：将 `PermissionManager` 作为 `Config` 的托管实例，对齐 `SkillManager` 模式。

**改动点**：

- 新增私有字段 `private permissionManager: PermissionManager | null = null`
- 在 `initialize()` 方法中（`skillManager` 初始化之后）实例化：`this.permissionManager = new PermissionManager(this)`
- 新增 getter：`getPermissionManager(): PermissionManager | null`
- `shutdown()` 中无需特殊处理（PermissionManager 无文件 watcher）
- 原有的 `getCoreTools()` / `getExcludeTools()` / `getAllowedTools()` 方法**删除**，所有调用方统一切换到 `PermissionManager`

### 4. 工具注册（`packages/core/src/config/config.ts` - `createToolRegistry`）

**目标**：工具注册时使用 `PermissionManager.isToolEnabled()` 替代现有的 `isToolEnabled()` 工具函数。

**方案**：`createToolRegistry()` 内部获取 `this.permissionManager`，调用其 `isToolEnabled(toolName)` 判断是否注册该工具。底层 `tool-utils.ts` 中的 `isToolEnabled()` 函数**保留**，作为 `PermissionManager` 内部的工具函数被调用，不对外破坏接口。

### 5. Shell 命令权限检查（`packages/core/src/utils/shell-utils.ts`）

**目标**：`checkCommandPermissions()` 改为调用 `PermissionManager`，移除对 `config.getCoreTools()` / `config.getExcludeTools()` 的直接调用。

**方案**：函数内部通过 `config.getPermissionManager().isCommandAllowed(command)` 获得 `PermissionDecision`，并据此返回结果。原有对 `getExcludeTools()` / `getCoreTools()` 的调用全部删除。

### 6. CoreToolScheduler（`packages/core/src/core/coreToolScheduler.ts`）

**目标**：权限决策逻辑集中到 `PermissionManager`，移除散落的 `getAllowedTools()` 调用。

**方案**：在工具调用确认流程中，替换原有逻辑：

- **原逻辑**：取 `getAllowedTools()` 列表，调用 `doesToolInvocationMatch()` 判断是否自动通过
- **新逻辑**：调用 `permissionManager.evaluate({ toolName, invocation })` 获取决策

三态决策处理：

- `allow`：`setToolCallOutcome(ProceedAlways)`，自动通过
- `deny`：直接设置 error 状态，返回拒绝消息
- `ask` 或 `default`（且 defaultMode 不是 YOLO）：进入用户确认流程
- `default` 且 defaultMode 为 YOLO：自动通过

用户在确认弹窗选择"Always allow"时，调用 `permissionManager.addSessionAllowRule(rule)` 记录会话级规则。

### 7. ShellProcessor（`packages/cli/src/services/prompt-processors/shellProcessor.ts`）

**目标**：移除对 `config.getAllowedTools()` 的直接调用，通过 `PermissionManager` 统一处理。

**方案**：`doesToolInvocationMatch()` 的调用替换为 `permissionManager.evaluate()` 调用，保持现有的 `sessionShellAllowlist` 逻辑不变（会话白名单通过 `addSessionAllowRule` 映射）。

### 8. `/permissions` 命令（`packages/cli/src/ui/commands/permissionsCommand.ts`）

**目标**：命令触发时打开新的权限管理对话框，替代现有仅打开文件夹信任设置的 dialog。

**方案**：命令 action 返回 `{ type: 'dialog', dialog: 'permissions' }`（已有），新增对应的对话框组件处理此 dialog 类型。

### 9. Settings 迁移映射（`packages/cli/src/config/settings.ts`）

**目标**：更新 V1→V2 的 `MIGRATION_MAP`，将旧的平铺键名映射移除。

**背景**：`settings.ts` 中存在 `MIGRATION_MAP`，记录了 V1（平铺格式）→ V2（嵌套格式）的键名映射，其中包含：

```
allowedTools: 'tools.allowed'
coreTools: 'tools.core'
excludeTools: 'tools.exclude'
```

**改动点**：

- 从 `MIGRATION_MAP` 中删除 `allowedTools`、`coreTools`、`excludeTools` 三条映射
- `needsMigration()` 和 `migrateSettings()` 中基于这三个键的逻辑随之清理
- 同步更新 `settings.test.ts` 中相关迁移场景的测试用例

> **注意**：`settings.ts` 里的旧迁移逻辑处理的是格式层面（V1 平铺 → V2 嵌套），与本次 Permission System 的语义迁移（`tools.*` → `permissions.*`）不同。本次迁移逻辑由独立的 `migrateLegacySettings()` 函数承担，不耦合到已有 `migrateSettings()`。

### 10. 遥测（`packages/core/src/telemetry/types.ts`）

**目标**：`SessionStartEvent` 中 `core_tools_enabled` 字段改为基于新权限规则。

**改动点**：

- `core_tools_enabled` 字段原值为 `config.getCoreTools()` 的 join 结果
- 替换为读取 `config.getPermissionManager()` 的 deny/allow 规则摘要，或改为记录 `permissions.deny` 规则数量
- 相关测试文件（`loggers.test.ts`、`qwen-logger.test.ts`）中 mock 的 `getCoreTools()` 同步替换

### 11. NonInteractive 控制器（`packages/cli/src/nonInteractive/control/controllers/systemController.ts`）

`systemController.ts` 中对 `config.excludeTools` 的直接引用，随 `Config` 类删除 `getExcludeTools()` 方法后，需改为通过 `config.getPermissionManager()` 获取等效决策。NonInteractive 场景下的 `coreTools`、`excludeTools`、`allowedTools` **对外参数接口保持不变**，内部实现切换到 `PermissionManager` 即可。

### 12. SDK API

**TypeScript SDK（`packages/sdk-typescript/`）和 Java SDK（`packages/sdk-java/`）**：

`coreTools`、`excludeTools`、`allowedTools` 三个参数**保持不变**，不做任何参数接口的改动。SDK 使用者传入的这些参数，在 CLI 内部由启动时的迁移流程或 `PermissionManager` 初始化时处理——即 CLI 启动参数层面仍接受 `--coreTools` / `--excludeTools` / `--allowedTools`，进入进程后由 `PermissionManager` 在初始化阶段将其转换为等价的 `permissions.allow` / `permissions.deny` 规则（内存中，不写入 settings 文件）。

> **注意**：`packages/core/src/skills/types.ts` 中的 `allowedTools?: string[]` 是 **Skills（QWEN.md frontmatter）** 的独立字段，用于限制 skill 可调用的工具，与权限系统无关，**不在本次改动范围内**。同样，`mcpServers.<name>.excludeTools` 是 MCP server 配置的工具过滤字段，**不在本次改动范围内**。

### 13. 国际化（i18n）

**目标**：为新增 UI 文本添加多语言翻译条目。

**需要新增翻译的文件**：

- `packages/cli/src/i18n/locales/en.js`（基准，其余语言参照翻译）
- `packages/cli/src/i18n/locales/zh.js`
- `packages/cli/src/i18n/locales/de.js`
- `packages/cli/src/i18n/locales/ja.js`
- `packages/cli/src/i18n/locales/pt.js`
- `packages/cli/src/i18n/locales/ru.js`

**需要新增的 UI 文本分类**（在 `// Dialogs - Permissions` 区块下扩展）：

| 文本 key（英文原文）                                                                                             | 用途                             |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Allow` / `Ask` / `Deny` / `Workspace`                                                                           | Tab 标签                         |
| `Add a new rule…`                                                                                                | 规则列表首行操作                 |
| `Add allow permission rule` / `Add ask permission rule` / `Add deny permission rule`                             | 新增规则对话框标题               |
| `Permission rules are a tool name, optionally followed by a specifier in parentheses.`                           | 输入提示说明                     |
| `Enter permission rule...`                                                                                       | 输入框 placeholder               |
| `Where should this rule be saved?`                                                                               | 保存位置选择提示                 |
| `Project settings (local)` / `Project settings` / `User settings`                                                | 保存位置选项                     |
| `Saved in .qwen/settings.local.json` / `Checked in at .qwen/settings.json` / `Saved in at ~/.qwen/settings.json` | 保存位置说明                     |
| `Any use of the {{tool}} tool`                                                                                   | 规则描述模板                     |
| `{{tool}} commands starting with '{{prefix}}'`                                                                   | 命令前缀规则描述                 |
| `Delete allowed tool?` / `Delete ask rule?` / `Delete denied tool?`                                              | 删除确认标题                     |
| `Are you sure you want to delete this permission rule?`                                                          | 删除确认正文                     |
| `From user settings` / `From project settings` / `From project settings (local)`                                 | 规则来源标注                     |
| `Add directory…`                                                                                                 | Workspace Tab 操作               |
| `Add directory to workspace`                                                                                     | 新增目录对话框标题               |
| `Enter the path to the directory:`                                                                               | 目录输入提示                     |
| `Directory path...`                                                                                              | 目录输入框 placeholder           |
| `Original working directory`                                                                                     | 初始目录标注                     |
| 迁移提示相关文本                                                                                                 | 启动时迁移检测提示及三个操作选项 |

**需要删除的翻译条目**：与 `tools.core` / `tools.exclude` / `tools.allowed` 对应的旧 UI 文本（如果存在）。

### 14. 用户文档与开发者文档

**需要更新的文档文件**：

| 文件                                   | 改动内容                                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/users/configuration/settings.md` | 删除 `tools.core`、`tools.exclude`、`tools.allowed` 的配置项说明行，新增 `permissions.allow`、`permissions.ask`、`permissions.deny` 说明 |
| `docs/developers/tools/shell.md`       | 将 Shell 命令权限限制的示例从 `tools.core` / `tools.exclude` 改为 `permissions.deny` / `permissions.allow` 的等价写法                    |
| `docs/developers/sdk-typescript.md`    | 更新 SDK 选项表，删除 `coreTools`、`excludeTools`、`allowedTools`，新增 `permissions` 选项说明                                           |
| `docs/developers/sdk-java.md`          | 同上，更新 Java SDK 选项说明                                                                                                             |

**不需要改动的文档**：

- `docs/users/features/mcp.md` 和 `docs/developers/tools/mcp-server.md` 中的 `excludeTools` 是 MCP server 级别的独立过滤配置，与权限系统无关，保持不变

---

## UI 实现

### 对话框整体结构

`/permissions` 命令触发后打开一个全屏交互式对话框，顶部有四个 Tab 页：

```
Permissions: [ Allow ]  Ask  Deny  Workspace  (←/→ or tab to cycle)
```

Tab 说明：

- **Allow**：显示所有 allow 规则列表
- **Ask**：显示所有 ask 规则列表
- **Deny**：显示所有 deny 规则列表
- **Workspace**：显示当前工作目录及附加目录

### Allow / Ask / Deny Tab

每个 Tab 的布局：

```
Permissions: [ Allow ]  Ask  Deny  Workspace

Claude Code won't ask before using allowed tools.
（或对应 tab 的描述文字）

  ○ Search...

› 1. Add a new rule…
  2. run_shell_command(git *)    [来源：workspace settings]
  3. mcp__server              [来源：user settings]

Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel
```

**交互行为**：

- 搜索框过滤规则列表
- 选中"Add a new rule…"进入新增规则流程
- 选中已有规则进入删除确认流程

### 新增规则流程

**步骤一**：输入规则字符串

```
Add allow permission rule

Permission rules are a tool name, optionally followed by a specifier in parentheses.
e.g., WebFetch or Bash(ls:*)

┌─────────────────────────────────────────┐
│ Enter permission rule...                │
└─────────────────────────────────────────┘

Enter to submit · Esc to cancel
```

**步骤二**：确认规则含义并选择保存位置

```
Add allow permission rule

  WebFetch
  Any use of the WebFetch tool

Where should this rule be saved?
› 1. Project settings (local)    Saved in .qwen/settings.local.json
  2. Project settings            Checked in at .qwen/settings.json
  3. User settings               Saved in at ~/.qwen/settings.json

Enter to confirm · Esc to cancel
```

步骤二中实时展示规则的人类可读描述：

- `Bash` → `Any use of the Bash tool`
- `Bash(git *)` → `Bash commands starting with 'git'`
- `WebFetch` → `Any use of the WebFetch tool`
- `read_file(./.env)` → `Reading the file .env`

### 删除规则确认

```
Delete allowed tool?

  mcp__pencil
  Any use of the mcp__pencil tool
  From user settings

Are you sure you want to delete this permission rule?

› 1. Yes
  2. No

Esc to cancel
```

### Workspace Tab

```
Permissions:  Allow  Ask  Deny  [ Workspace ]

Claude Code can read files in the workspace, and make edits when auto-accept edits is on.

  -  /Users/mochi/code/qwen-code  (Original working directory)
› 1. Add directory…

Press ↑↓ to navigate · Enter to select · Type to search · Esc to cancel
```

**新增目录流程**：

```
Add directory to workspace

Claude Code will be able to read files in this directory and make edits when auto-accept edits is on.

Enter the path to the directory:

┌─────────────────────────────────────────┐
│ Directory path...                       │
└─────────────────────────────────────────┘

Tab to complete · Enter to add · Esc to cancel
```

新增的目录持久化写入到 `permissions.additionalDirectories`（workspace settings），同时调用 `config.getWorkspaceContext()` 更新运行时工作目录范围。

### 新增 React 组件与 Hook

**新增组件**：

- `packages/cli/src/ui/components/PermissionsDialog.tsx`：完整的 `/permissions` 对话框，包含四个 Tab 的状态管理与渲染
- `packages/cli/src/ui/components/AddPermissionRuleDialog.tsx`：新增规则的二步流程对话框
- `packages/cli/src/ui/components/DeletePermissionRuleDialog.tsx`：删除规则确认对话框
- `packages/cli/src/ui/components/AddWorkspaceDirectoryDialog.tsx`：新增工作目录对话框

**新增 Hook**：

- `packages/cli/src/ui/hooks/usePermissionsDialog.ts`：管理 `/permissions` 对话框的开关状态（对齐 `useAgentsManagerDialog` 模式）
- `packages/cli/src/ui/hooks/usePermissionRules.ts`：从 `PermissionManager` 读取规则列表，提供新增/删除操作

**`AppContainer.tsx` 改动**：

- 新增 `usePermissionsDialog` hook 调用
- 将现有的 `isPermissionsDialogOpen` 状态（当前用于旧的文件夹信任对话框）迁移，新增 `PermissionsDialog` 组件的渲染条件
- 在 `DialogManager` 中注册 `'permissions'` dialog 类型到新 `PermissionsDialog` 组件

---

## 数据流

```
settings.json (各层级的 permissions.allow/ask/deny)
    + CLI 参数 (--allow / --deny)
    + 会话动态规则（用户确认弹窗选择 Always allow）
              ↓
       PermissionManager（Config 内唯一实例）
           ↙         ↓           ↘
CoreToolScheduler  shell-utils  /permissions dialog
(evaluate)     (isCommandAllowed)  (listRules / addRule / removeRule)
                        ↓
              工具注册（isToolEnabled）
```

---

## 实现顺序建议

1. **`packages/core/src/permissions/`**（types + rule-parser + permission-manager）
2. **`settingsSchema.ts`** 新增 `permissions` 字段
3. **`Config`** 挂载 `PermissionManager` 实例
4. **`createToolRegistry`** 切换到 `PermissionManager.isToolEnabled()`
5. **`shell-utils.ts`** 切换到 `PermissionManager.isCommandAllowed()`
6. **`CoreToolScheduler`** 切换到 `PermissionManager.evaluate()`
7. **`shellProcessor.ts`** 适配改动
8. **UI 组件**（PermissionsDialog 及相关子组件）
9. **`AppContainer.tsx`** 接入新 dialog
10. **集成测试与单元测试**

---

## 测试策略

### 单元测试

- `rule-parser.ts`：覆盖所有匹配规则的 glob 变体、路径规范、工具别名
- `permission-manager.ts`：
  - 三态决策的 first-match-wins 逻辑
  - `addSessionAllowRule` 的会话隔离性
  - `addPersistentRule` / `removeRule` 的文件写入逻辑

### 集成测试

- `CoreToolScheduler` 三态决策流程
- Shell 命令 glob 匹配的安全边界（防止 shell 操作符绕过）
- 启动时检测到旧配置项时，迁移流程正确写入新字段并删除旧字段
