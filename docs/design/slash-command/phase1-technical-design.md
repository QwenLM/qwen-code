# Phase 1 技术设计文档：基础设施重建

## 1. 设计目标与约束

### 1.1 目标

- 建立统一的命令元数据模型，覆盖来源（source）、执行类型（commandType）、模式能力（supportedModes）、可见性（userInvocable / modelInvocable）四个维度
- 用 capability-based 过滤替换 non-interactive/acp 中的硬编码白名单
- 为 Phase 2/3 的能力扩展提供稳定的底层接口

### 1.2 硬性约束

- **零行为变化**：non-interactive 和 acp 模式下现有可用命令集保持不变（例外：修复 MCP_PROMPT 被错误拦截，属于 bug fix）
- **向后兼容**：`SlashCommand` 接口的新增字段全部为可选或有合理默认值，现有命令代码无需立即修改
- **不新增执行器**：不创建 ModeAdapter / CommandExecutor 等新执行架构，只扩展现有 CommandService 和过滤逻辑
- **不改变现有命令能力**：不为任何命令新增 local 子命令，不修改任何命令的 action 实现

---

## 2. 新增类型定义

### 2.1 文件位置

所有新增类型定义在 `packages/cli/src/ui/commands/types.ts`，与现有 `SlashCommand` 接口共文件。

### 2.2 `ExecutionMode`

```typescript
/**
 * 运行模式枚举。
 * - interactive：React/Ink UI 模式（终端交互）
 * - non_interactive：无交互 CLI 模式（文本/JSON 输出）
 * - acp：ACP/Zed 集成模式
 */
export type ExecutionMode = 'interactive' | 'non_interactive' | 'acp';
```

### 2.3 `CommandSource`

```typescript
/**
 * 命令来源枚举，用于 Help 分组、补全 badge、ACP available commands。
 *
 * 与 CommandKind 的区别：
 * - CommandKind 是内部加载器分类（4 种），影响加载逻辑
 * - CommandSource 是面向用户的来源分类（9 种），影响展示和心智模型
 *
 * 两者可能重叠，但职责不同，不合并。
 */
export type CommandSource =
  | 'builtin-command' // 内置命令（BuiltinCommandLoader）
  | 'bundled-skill' // 随包分发的 skill（BundledSkillLoader）
  | 'skill-dir-command' // 用户/项目 .qwen/commands/ 下的文件命令（FileCommandLoader，非插件）
  | 'plugin-command' // 插件提供的命令（FileCommandLoader，extensionName 不为空）
  | 'mcp-prompt'; // MCP server 提供的 prompt（McpPromptLoader）
// 以下来源预留，Phase 1 不实现对应 Loader，但 schema 先定义：
// | 'workflow-command'
// | 'plugin-skill'
// | 'dynamic-skill'
// | 'builtin-plugin-skill'
// | 'mcp-skill'
```

### 2.4 `CommandType`

```typescript
/**
 * 命令执行类型，描述命令"怎么执行"。
 *
 * - prompt：产生 submit_prompt，将内容提交给模型。适用于 skill、file command、MCP prompt。
 *   默认 supportedModes 为所有模式，默认 modelInvocable 为 true。
 *
 * - local：在本地执行逻辑，不依赖 React/Ink UI。可返回 message、stream_messages、
 *   submit_prompt、tool 等类型。适用于查询类、配置类、状态类 built-in 命令。
 *   默认 supportedModes 为 ['interactive']，需显式声明 supportedModes 才能开放给其他模式。
 *   这与 Claude Code 的 supportsNonInteractive: true 语义一致——非交互支持需要显式声明，而非自动推断。
 *
 * - local-jsx：依赖 React/Ink UI 的命令（打开 dialog、渲染 JSX 组件等）。
 *   默认 supportedModes 仅为 ['interactive']。
 */
export type CommandType = 'prompt' | 'local' | 'local-jsx';
```

### 2.5 扩展 `SlashCommand` 接口

在现有接口上追加新字段，**全部为可选**以保证向后兼容：

```typescript
export interface SlashCommand {
  // ── 现有字段（保持不变） ──────────────────────────────────────────────
  name: string;
  altNames?: string[];
  description: string;
  hidden?: boolean;
  completionPriority?: number;
  kind: CommandKind;
  extensionName?: string;
  action?: (...) => ...;
  completion?: (...) => ...;
  subCommands?: SlashCommand[];

  // ── Phase 1 新增：来源与执行类型 ──────────────────────────────────────
  /**
   * 命令来源，用于 Help 分组、补全 badge、ACP available commands 展示。
   * 由各 Loader 填充，不由命令自身声明。
   * 未来废弃 CommandKind 时，source 将成为唯一来源标识。
   */
  source?: CommandSource;

  /**
   * 展示用的来源标签，面向用户。
   * - builtin-command → "Built-in"
   * - bundled-skill → "Skill"
   * - skill-dir-command → "Custom"
   * - plugin-command → "Plugin: <extensionName>"
   * - mcp-prompt → "MCP: <serverName>"
   * 由各 Loader 填充，可被命令自身覆盖。
   */
  sourceLabel?: string;

  /**
   * 命令执行类型。
   * - 由各 Loader 填充默认值（prompt/local-jsx）
   * - built-in 命令由各命令文件自身声明（local 或 local-jsx）
   * 未声明时的默认策略见 getEffectiveCommandType()。
   */
  commandType?: CommandType;

  // ── Phase 1 新增：模式能力 ──────────────────────────────────────────
  /**
   * 此命令在哪些运行模式下可用。
   * 未声明时根据 commandType 推断默认值（见 getEffectiveSupportedModes()）。
   * 显式声明优先于推断值。
   */
  supportedModes?: ExecutionMode[];

  // ── Phase 1 新增：可见性 ──────────────────────────────────────────────
  /**
   * 用户是否可通过 slash command 调用此命令。
   * 默认 true（几乎所有命令都是 userInvocable）。
   */
  userInvocable?: boolean;

  /**
   * 模型是否可通过 tool call 调用此命令。
   * 默认 false。prompt 类型的命令（skill、file command、MCP prompt）应设为 true。
   * built-in commands 不允许模型调用（始终为 false）。
   */
  modelInvocable?: boolean;

  // ── Phase 3 预留：体验元数据（Phase 1 仅定义，不使用）──────────────────
  /**
   * 参数提示，显示在补全菜单命令名后。
   * 示例："<model-id>" / "show|list|set <id>" / "[--fast] [<model-id>]"
   */
  argumentHint?: string;

  /**
   * 供模型理解何时调用此命令的说明。
   * 将被注入 modelInvocable 命令的 description 中。
   */
  whenToUse?: string;

  /**
   * 使用示例，供 Help 目录和补全展示。
   */
  examples?: string[];
}
```

---

## 3. 各 Loader 的字段填充规范

### 3.1 填充原则

- `source` 和 `sourceLabel` 由 Loader 在构建 `SlashCommand` 时填充，命令自身不声明
- `commandType`：Loader 填充默认值；built-in 命令由命令文件自身声明
- `supportedModes`：通过 `getEffectiveSupportedModes()` 推断，不需要显式填充（除非需要覆盖默认值）
- `modelInvocable`：Loader 填充，built-in 命令始终为 `false`，prompt 类型命令为 `true`

### 3.2 `BuiltinCommandLoader`

```typescript
// 不填充 source/sourceLabel/commandType — 由各命令文件自声明
// 因为 built-in 命令的 commandType 是 local 或 local-jsx，需要逐个标注

// 注入 source 和 sourceLabel：
for (const cmd of rawCommands) {
  enrichedCommands.push({
    ...cmd,
    source: 'builtin-command',
    sourceLabel: 'Built-in',
    userInvocable: cmd.userInvocable ?? true,
    modelInvocable: false, // built-in 命令不允许模型调用
  });
}
```

### 3.3 `BundledSkillLoader`

```typescript
return skills.map((skill) => ({
  name: skill.name,
  description: skill.description,
  kind: CommandKind.SKILL,
  source: 'bundled-skill' as CommandSource,
  sourceLabel: 'Skill',
  commandType: 'prompt' as CommandType,
  userInvocable: true,
  modelInvocable: true,
  action: async (...) => { ... },
}));
```

### 3.4 `FileCommandLoader`

```typescript
// 在 createSlashCommandFromDefinition 中：
return {
  name: baseCommandName,
  description,
  kind: CommandKind.FILE,
  extensionName,
  // source 根据 extensionName 决定：
  source: extensionName ? 'plugin-command' : 'skill-dir-command',
  sourceLabel: extensionName ? `Plugin: ${extensionName}` : 'Custom',
  commandType: 'prompt',
  userInvocable: true,
  modelInvocable: !extensionName, // 插件命令暂不允许模型调用，用户/项目命令允许
  action: async (...) => { ... },
};
```

> **注**：插件命令（plugin-command）暂不标记为 `modelInvocable`，避免安全隐患。后续 Phase 可以按需开放，由用户通过配置控制。

### 3.5 `McpPromptLoader`

```typescript
const newPromptCommand: SlashCommand = {
  name: commandName,
  description: prompt.description || `Invoke prompt ${prompt.name}`,
  kind: CommandKind.MCP_PROMPT,
  source: 'mcp-prompt',
  sourceLabel: `MCP: ${serverName}`,
  commandType: 'prompt',
  userInvocable: true,
  modelInvocable: true,
  // ... 其余现有字段
};
```

---

## 4. Built-in 命令的 `commandType` 声明规范

### 4.1 分类标准

| commandType | 判断标准                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`     | action 只使用 `ui.addItem`（文本类型）、返回 `message` / `stream_messages` / `submit_prompt` / `tool`，不依赖 React 组件渲染                                               |
| `local-jsx` | action 返回 `dialog`，或 action 中调用 `ui.addItem` 时传入含 JSX 的复杂类型（如 `HistoryItemHelp`、`HistoryItemStats`），或依赖 `confirm_action` / `load_history` / `quit` |

> **注意**：`ui.addItem(message/error/info 类型)` 是 `local`；`ui.addItem(help/stats/tools/about 等复杂 UI 类型)` 是 `local-jsx`。

### 4.2 Built-in 命令分类表

**`local` 类**（声明 `commandType: 'local'`，`supportedModes` 推断为 all modes）：

| 命令文件             | 命令名     | 说明                                                    |
| -------------------- | ---------- | ------------------------------------------------------- |
| `btwCommand.ts`      | `btw`      | 返回 `submit_prompt` 或 `stream_messages`               |
| `bugCommand.ts`      | `bug`      | 返回 `submit_prompt` 或 `stream_messages`               |
| `compressCommand.ts` | `compress` | 已有 executionMode 适配，返回 `message`/`submit_prompt` |
| `contextCommand.ts`  | `context`  | 返回 `message`（含 UI 渲染但文本可替代）                |
| `exportCommand.ts`   | `export`   | 文件 I/O，返回 `message`                                |
| `initCommand.ts`     | `init`     | 返回 `submit_prompt`/`message`/`confirm_action`         |
| `memoryCommand.ts`   | `memory`   | 子命令返回 `message`（文件 I/O）                        |
| `planCommand.ts`     | `plan`     | 返回 `submit_prompt`                                    |
| `summaryCommand.ts`  | `summary`  | 已有 executionMode 适配，返回 `submit_prompt`/`message` |
| `insightCommand.ts`  | `insight`  | 返回 `stream_messages`                                  |

> **注意**：`contextCommand` 和 `insightCommand` 虽然当前返回 `addItem` 调用，但其本质是文本内容，属于 `local`。

**`local-jsx` 类**（声明 `commandType: 'local-jsx'`，`supportedModes` 推断为 `['interactive']`）：

| 命令文件                  | 命令名           | 不能 headless 的原因                       |
| ------------------------- | ---------------- | ------------------------------------------ |
| `aboutCommand.ts`         | `about`          | `addItem(HistoryItemAbout)` — 复杂 UI 组件 |
| `agentsCommand.ts`        | `agents`         | `dialog: subagent_create/subagent_list`    |
| `approvalModeCommand.ts`  | `approval-mode`  | `dialog: approval-mode`                    |
| `arenaCommand.ts`         | `arena`          | `dialog: arena_*`                          |
| `authCommand.ts`          | `auth`           | `dialog: auth`                             |
| `clearCommand.ts`         | `clear`          | `ui.clear()` 直接操作终端                  |
| `copyCommand.ts`          | `copy`           | 剪贴板操作，无 headless 路径               |
| `directoryCommand.tsx`    | `directory`      | JSX 组件                                   |
| `docsCommand.ts`          | `docs`           | 打开浏览器                                 |
| `editorCommand.ts`        | `editor`         | `dialog: editor`                           |
| `extensionsCommand.ts`    | `extensions`     | `dialog: extensions_manage`                |
| `helpCommand.ts`          | `help`           | `addItem(HistoryItemHelp)` — 复杂 Help UI  |
| `hooksCommand.ts`         | `hooks`          | `dialog: hooks`                            |
| `ideCommand.ts`           | `ide`            | IDE 进程检测与交互                         |
| `languageCommand.ts`      | `language`       | `dialog` + `reloadCommands`                |
| `mcpCommand.ts`           | `mcp`            | `dialog: mcp`                              |
| `modelCommand.ts`         | `model`          | `dialog: model/fast-model`                 |
| `permissionsCommand.ts`   | `permissions`    | `dialog: permissions`                      |
| `quitCommand.ts`          | `quit`           | `quit` result 类型                         |
| `restoreCommand.ts`       | `restore`        | `load_history` result 类型                 |
| `resumeCommand.ts`        | `resume`         | `dialog: resume`                           |
| `settingsCommand.ts`      | `settings`       | `dialog: settings`                         |
| `setupGithubCommand.ts`   | `setup-github`   | `confirm_shell_commands` + 交互式操作      |
| `skillsCommand.ts`        | `skills`         | `addItem(HistoryItemSkillsList)` — 复杂 UI |
| `statsCommand.ts`         | `stats`          | `addItem(HistoryItemStats)` — 复杂 UI      |
| `statuslineCommand.ts`    | `statusline`     | UI 状态配置                                |
| `terminalSetupCommand.ts` | `terminal-setup` | 终端配置向导                               |
| `themeCommand.ts`         | `theme`          | `dialog: theme`                            |
| `toolsCommand.ts`         | `tools`          | `addItem(HistoryItemTools)` — 复杂 UI      |
| `trustCommand.ts`         | `trust`          | `dialog: trust`                            |
| `vimCommand.ts`           | `vim`            | `toggleVimEnabled()` — UI 状态             |

---

## 5. `getEffectiveSupportedModes` 推断规则

此函数是 Phase 1 的核心逻辑，替代原有白名单，将被 `filterCommandsForMode` 调用。

```typescript
/**
 * 获取命令的实际支持模式列表。
 *
 * 推断优先级（从高到低）：
 * 1. 命令显式声明的 supportedModes（最高优先级）
 * 2. 基于 commandType 的推断
 * 3. 基于 CommandKind 的兜底（向后兼容）
 */
export function getEffectiveSupportedModes(cmd: SlashCommand): ExecutionMode[] {
  // 优先级 1：显式声明
  if (cmd.supportedModes !== undefined) {
    return cmd.supportedModes;
  }

  // 优先级 2：基于 commandType 推断
  if (cmd.commandType !== undefined) {
    switch (cmd.commandType) {
      case 'prompt':
        // prompt 类型无 UI 依赖，天然全模式可用
        return ['interactive', 'non_interactive', 'acp'];
      case 'local':
        // local 类型保守默认：仅 interactive。
        // 需要非交互支持的命令须显式声明 supportedModes（对应 Claude Code 的 supportsNonInteractive: true）。
        // Phase 2 中逐个验证并解锁，防止未适配的命令意外暴露给 headless 调用者。
        return ['interactive'];
      case 'local-jsx':
        return ['interactive'];
    }
  }

  // 优先级 3：兜底（基于 CommandKind，向后兼容旧代码）
  switch (cmd.kind) {
    case CommandKind.BUILT_IN:
      // built-in 命令未声明 commandType 时保守默认（interactive only）
      // 这个分支在 Phase 1 完成后应不再被命中（所有 built-in 都有 commandType）
      return ['interactive'];
    case CommandKind.FILE:
    case CommandKind.SKILL:
    case CommandKind.MCP_PROMPT:
      // 这三类命令的 action 天然无 UI 依赖，历史行为也是全模式可用
      return ['interactive', 'non_interactive', 'acp'];
    default:
      return ['interactive'];
  }
}
```

```typescript
/**
 * 根据 supportedModes 过滤适合当前模式的命令。
 * 替代原 filterCommandsForNonInteractive 函数。
 */
export function filterCommandsForMode(
  commands: readonly SlashCommand[],
  mode: ExecutionMode,
): SlashCommand[] {
  return commands.filter((cmd) =>
    getEffectiveSupportedModes(cmd).includes(mode),
  );
}
```

---

## 6. `CommandService` 接口扩展

在 `packages/cli/src/services/CommandService.ts` 中新增两个方法：

```typescript
export class CommandService {
  // ── 现有方法（保持不变）────────────────────────────────────────────────
  getCommands(): readonly SlashCommand[] {
    return this.commands;
  }

  // ── Phase 1 新增方法 ──────────────────────────────────────────────────

  /**
   * 返回在指定执行模式下可用的命令列表。
   * 替代原有白名单 + filterCommandsForNonInteractive 的组合。
   *
   * @param mode 目标运行模式
   * @returns 适合该模式的命令列表（不含 hidden 命令）
   */
  getCommandsForMode(mode: ExecutionMode): readonly SlashCommand[] {
    return this.commands.filter((cmd) => {
      if (cmd.hidden) return false;
      return getEffectiveSupportedModes(cmd).includes(mode);
    });
  }

  /**
   * 返回所有 modelInvocable 为 true 的命令。
   * Phase 2 中 SkillTool 将消费此方法；Phase 1 仅提供接口。
   *
   * @returns 模型可调用的命令列表
   */
  getModelInvocableCommands(): readonly SlashCommand[] {
    return this.commands.filter(
      (cmd) => !cmd.hidden && cmd.modelInvocable === true,
    );
  }
}
```

> **注意**：`getEffectiveSupportedModes` 和 `filterCommandsForMode` 应作为 `CommandService` 内部使用的工具函数，或提取到独立的 `packages/cli/src/services/commandUtils.ts` 文件并导出，以便测试和复用。

---

## 7. `nonInteractiveCliCommands.ts` 重构

### 7.1 删除内容

```typescript
// ❌ 删除
export const ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE = [
  'init', 'summary', 'compress', 'btw', 'bug', 'context',
] as const;

// ❌ 删除
function filterCommandsForNonInteractive(
  commands: readonly SlashCommand[],
  allowedBuiltinCommandNames: Set<string>,
): SlashCommand[] { ... }
```

### 7.2 新增内容

```typescript
// ✅ 新增（或从 commandUtils 导入）
import { filterCommandsForMode } from '../services/commandUtils.js';
```

### 7.3 `handleSlashCommand` 函数签名变更

```typescript
// ❌ 旧签名
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
  allowedBuiltinCommandNames: string[] = [...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE],
): Promise<NonInteractiveSlashCommandResult>

// ✅ 新签名（移除 allowedBuiltinCommandNames）
export const handleSlashCommand = async (
  rawQuery: string,
  abortController: AbortController,
  config: Config,
  settings: LoadedSettings,
): Promise<NonInteractiveSlashCommandResult>
```

### 7.4 内部实现变更

```typescript
// 旧：
const filteredCommands = filterCommandsForNonInteractive(
  allCommands,
  allowedBuiltinSet,
);

// 新：
const executionMode = isAcpMode ? 'acp' : 'non_interactive';
const filteredCommands = filterCommandsForMode(allCommands, executionMode);
```

### 7.5 `getAvailableCommands` 函数签名变更

```typescript
// ❌ 旧签名
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  allowedBuiltinCommandNames: string[] = [...ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE],
): Promise<SlashCommand[]>

// ✅ 新签名
export const getAvailableCommands = async (
  config: Config,
  abortSignal: AbortSignal,
  mode: ExecutionMode = 'acp',
): Promise<SlashCommand[]>
```

> 新增 `mode` 参数替代原来的白名单参数，ACP Session 调用时可明确指定 `'acp'`，non-interactive 调用时指定 `'non_interactive'`。

---

## 8. `Session.ts`（ACP）调用变更

```typescript
// ❌ 旧调用
const slashCommandResult = await handleSlashCommand(
  inputText,
  abortController,
  this.config,
  this.settings,
  // 不传，使用默认白名单
);

// ✅ 新调用（无变化，移除了不再存在的默认参数）
const slashCommandResult = await handleSlashCommand(
  inputText,
  abortController,
  this.config,
  this.settings,
);

// ─────────────────────────────────────────

// ❌ 旧调用
const slashCommands = await getAvailableCommands(
  this.config,
  abortController.signal,
);

// ✅ 新调用（明确指定 mode）
const slashCommands = await getAvailableCommands(
  this.config,
  abortController.signal,
  'acp',
);
```

---

## 9. 文件变更总览

### 9.1 修改的文件

| 文件                                                                    | 修改内容                                                                                         |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/cli/src/ui/commands/types.ts`                                 | 新增 `ExecutionMode`、`CommandSource`、`CommandType` 类型；扩展 `SlashCommand` 接口              |
| `packages/cli/src/services/CommandService.ts`                           | 新增 `getCommandsForMode()`、`getModelInvocableCommands()` 方法                                  |
| `packages/cli/src/nonInteractiveCliCommands.ts`                         | 删除白名单常量和旧过滤函数；更新两个导出函数的签名；引入 `filterCommandsForMode`                 |
| `packages/cli/src/acp-integration/session/Session.ts`                   | 更新 `handleSlashCommand` 和 `getAvailableCommands` 调用                                         |
| `packages/cli/src/services/BuiltinCommandLoader.ts`                     | 在构建命令时注入 `source: 'builtin-command'`、`sourceLabel: 'Built-in'`、`modelInvocable: false` |
| `packages/cli/src/services/BundledSkillLoader.ts`                       | 注入 `source: 'bundled-skill'`、`commandType: 'prompt'`、`modelInvocable: true`                  |
| `packages/cli/src/services/FileCommandLoader.ts` / `command-factory.ts` | 注入 `source`、`commandType: 'prompt'`、`modelInvocable`（根据 extensionName）                   |
| `packages/cli/src/services/McpPromptLoader.ts`                          | 注入 `source: 'mcp-prompt'`、`commandType: 'prompt'`、`modelInvocable: true`                     |
| **各 built-in 命令文件（10 个 local + 27 个 local-jsx）**               | 声明 `commandType: 'local'` 或 `commandType: 'local-jsx'`                                        |

### 9.2 新增的文件

| 文件                                        | 内容                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/cli/src/services/commandUtils.ts` | `getEffectiveSupportedModes()`、`filterCommandsForMode()` 工具函数及其导出 |

### 9.3 不变的文件

- `packages/cli/src/utils/commands.ts`（`parseSlashCommand` 无需修改）
- `packages/cli/src/ui/hooks/slashCommandProcessor.ts`（interactive 路径无需修改）
- `packages/cli/src/ui/noninteractive/nonInteractiveUi.ts`（stub UI 无需修改）
- 所有命令的 `action` 实现（Phase 1 不修改任何命令行为）

---

## 10. 行为影响分析

### 10.1 变化汇总

| 场景                                 | 旧行为                       | 新行为                                                   | 性质        |
| ------------------------------------ | ---------------------------- | -------------------------------------------------------- | ----------- |
| non-interactive 下执行 `/init`       | ✅ 允许（白名单）            | ✅ 允许（`commandType: local`）                          | 无变化      |
| non-interactive 下执行 `/summary`    | ✅ 允许                      | ✅ 允许                                                  | 无变化      |
| non-interactive 下执行 `/compress`   | ✅ 允许                      | ✅ 允许                                                  | 无变化      |
| non-interactive 下执行 `/btw`        | ✅ 允许                      | ✅ 允许                                                  | 无变化      |
| non-interactive 下执行 `/bug`        | ✅ 允许                      | ✅ 允许                                                  | 无变化      |
| non-interactive 下执行 `/context`    | ✅ 允许                      | ✅ 允许                                                  | 无变化      |
| non-interactive 下执行 `/model`      | ❌ unsupported               | ❌ unsupported（`commandType: local-jsx`）               | 无变化      |
| non-interactive 下执行 file command  | ✅ 允许（CommandKind.FILE）  | ✅ 允许（`commandType: prompt`）                         | 无变化      |
| non-interactive 下执行 bundled skill | ✅ 允许（CommandKind.SKILL） | ✅ 允许（`commandType: prompt`）                         | 无变化      |
| non-interactive 下执行 MCP prompt    | ❌ 被 CommandKind 拦截       | ✅ 允许（`commandType: prompt`）                         | **Bug fix** |
| non-interactive 下执行 `/export`     | ❌ 不在白名单                | ❌ 不允许（`commandType: local`，默认 interactive only） | 无变化      |
| non-interactive 下执行 `/memory`     | ❌ 不在白名单                | ❌ 不允许（`commandType: local`，默认 interactive only） | 无变化      |
| non-interactive 下执行 `/plan`       | ❌ 不在白名单                | ❌ 不允许（`commandType: local`，默认 interactive only） | 无变化      |

> **关于 `local` 命令的保守默认策略**：`commandType: 'local'` 的默认 `supportedModes` 为 `['interactive']`，这与 Claude Code 的设计一致——`local` 类型命令需要显式声明 `supportsNonInteractive: true` 才能在非交互模式下运行。Phase 1 中白名单内的 6 个命令（`init`、`summary`、`compress`、`btw`、`bug`、`context`）通过显式声明 `supportedModes: ['interactive', 'non_interactive', 'acp']` 来等价替换原白名单效果。Phase 2 中需要扩展的命令（如 `/export`、`/memory`、`/plan`）在验证 action 实现 headless-friendly 之后，再逐个解锁。

---

## 10.2 Phase 2 模式差异命令：双注册模式

对于 Phase 2 中需要"交互模式有 UI，非交互模式有文本输出"的命令（如 `/model`），应采用 **双注册模式**，而非在单个命令的 `action` 内部分支。

这是 Claude Code 的标准模式，以 `/context` 为例（参见 `src/commands/context/index.ts`）：两个同名 `Command` 对象，一个 `local-jsx` 仅 interactive，另一个 `local` 仅 non-interactive，通过 `isEnabled()` 互斥。

Qwen Code 在 Phase 2 中应采用等价方式，以 `supportedModes` 替代 `isEnabled()` 实现互斥：

```typescript
// ① 交互模式版：local-jsx，仅 interactive
export const modelCommandInteractive: SlashCommand = {
  name: 'model',
  kind: CommandKind.BUILT_IN,
  commandType: 'local-jsx',
  supportedModes: ['interactive'], // 显式限定
  // action: 打开 dialog 选择 model
};

// ② 非交互/acp 版：local，显式开放给 headless 调用者
export const modelCommandHeadless: SlashCommand = {
  name: 'model',
  kind: CommandKind.BUILT_IN,
  commandType: 'local',
  supportedModes: ['non_interactive', 'acp'], // 显式限定
  // action: 读取/设置 model，返回 message（纯文本）
};
```

两个对象同名，`supportedModes` 互斥，`filterCommandsForMode` 自动选择正确版本。与 Claude Code 的 `isEnabled()` 互斥相比，`supportedModes` 过滤更显式、更易测试，且不需要运行时环境检测。

**Phase 1 不实现任何双注册命令**，该模式仅作为 Phase 2 的实施规范预留在此。

---

## 11. 测试策略

### 11.1 新增工具函数测试

在 `packages/cli/src/services/commandUtils.test.ts`（新文件）中：

```typescript
describe('getEffectiveSupportedModes', () => {
  it('显式 supportedModes 优先于 commandType 推断', () => {
    const cmd: SlashCommand = {
      name: 'test', description: '', kind: CommandKind.BUILT_IN,
      commandType: 'local',
      supportedModes: ['interactive'], // 显式限制
    };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: local 推断为 all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN, commandType: 'local' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('commandType: local-jsx 推断为 interactive only', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN, commandType: 'local-jsx' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('commandType: prompt 推断为 all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.SKILL, commandType: 'prompt' };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('未声明 commandType 且 CommandKind.BUILT_IN，兜底为 interactive', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.BUILT_IN };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive']);
  });

  it('未声明 commandType 且 CommandKind.FILE，兜底为 all modes', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.FILE };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });

  it('未声明 commandType 且 CommandKind.MCP_PROMPT，兜底为 all modes（修复原有限制）', () => {
    const cmd: SlashCommand = { name: 'test', description: '', kind: CommandKind.MCP_PROMPT };
    expect(getEffectiveSupportedModes(cmd)).toEqual(['interactive', 'non_interactive', 'acp']);
  });
});

describe('filterCommandsForMode', () => {
  it('正确过滤 non_interactive 模式下的命令', () => { ... });
  it('正确过滤 acp 模式下的命令', () => { ... });
  it('不过滤 hidden 命令（filterCommandsForMode 不处理 hidden，CommandService 处理）', () => { ... });
});
```

### 11.2 更新 `nonInteractiveCliCommands.test.ts`

- 删除对 `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` 的所有引用
- 删除对 `allowedBuiltinCommandNames` 参数的测试用例
- 新增：验证 commandType: local 的命令在 non-interactive 下通过过滤
- 新增：验证 commandType: local-jsx 的命令在 non-interactive 下被过滤
- 保留：验证 file command / skill command 在 non-interactive 下通过过滤

### 11.3 更新 `CommandService.test.ts`

- 新增 `getCommandsForMode` 的测试用例
- 新增 `getModelInvocableCommands` 的测试用例

### 11.4 各 Loader 测试

- `BuiltinCommandLoader.test.ts`：验证所有命令都有 `source: 'builtin-command'`
- `BundledSkillLoader.test.ts`：验证 `source: 'bundled-skill'` 和 `modelInvocable: true`
- `FileCommandLoader.test.ts`：验证用户命令有 `source: 'skill-dir-command'`，插件命令有 `source: 'plugin-command'`
- `McpPromptLoader.test.ts`：验证 `source: 'mcp-prompt'` 和 `modelInvocable: true`

---

## 12. 实施顺序

建议按以下顺序实施，每步可独立 commit 和 review：

**Step 1**（~30min）：修改 `types.ts`，新增 `ExecutionMode`、`CommandSource`、`CommandType` 和 `SlashCommand` 新字段
→ 纯类型变更，TypeScript 编译检查

**Step 2**（~1h）：新建 `commandUtils.ts`，实现 `getEffectiveSupportedModes` 和 `filterCommandsForMode`，同步新建 `commandUtils.test.ts`
→ 单元测试覆盖核心逻辑

**Step 3**（~1h）：重构 `nonInteractiveCliCommands.ts`，删除白名单，引入 `filterCommandsForMode`，更新函数签名
→ 行为等价（Phase 1 保守策略：local 类命令显式写 `supportedModes: ['interactive']`）

**Step 4**（~30min）：更新 `CommandService.ts`，新增两个方法

**Step 5**（~2h）：为所有 built-in 命令文件添加 `commandType` 声明
→ 逐个确认分类正确性

**Step 6**（~1.5h）：更新所有 Loader，注入 `source`、`sourceLabel`、`commandType`、`modelInvocable`

**Step 7**（~30min）：更新 `Session.ts` 的调用签名

**Step 8**（~1h）：运行所有测试，修复失败用例，更新快照

**Step 9**（~30min）：CR 自查：确认白名单已完全移除，无遗漏调用

---

## 13. 验收 Checklist

- [ ] TypeScript 编译无错误（`npm run typecheck`）
- [ ] `npm run lint` 无新增 lint 错误
- [ ] 所有现有测试通过（`cd packages/cli && npx vitest run`）
- [ ] `commandUtils.test.ts` 新增测试全部通过
- [ ] `getEffectiveSupportedModes` 覆盖所有 7 种 case
- [ ] `filterCommandsForMode` 覆盖 interactive / non_interactive / acp 三种模式
- [ ] `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` 在整个代码库中无任何引用（`grep` 验证）
- [ ] `filterCommandsForNonInteractive` 函数在整个代码库中无任何引用
- [ ] 所有 built-in 命令有 `commandType` 字段
- [ ] 所有 Loader 输出的命令有 `source` 和 `sourceLabel` 字段
- [ ] `BundledSkillLoader` / `FileCommandLoader`（用户命令）/ `McpPromptLoader` 输出的命令 `modelInvocable: true`
- [ ] `BuiltinCommandLoader` 输出的命令 `modelInvocable: false`
- [ ] `CommandService.getCommandsForMode('non_interactive')` 返回与重构前等价的命令集
- [ ] MCP prompt 命令在 non-interactive 模式下不再被错误拦截
