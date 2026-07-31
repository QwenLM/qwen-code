# Phase 3 技术设计文档：体验对齐

## 1. 设计目标与约束

### 1.1 目标

Phase 3 在 Phase 1/2 已落地的命令元数据、跨模式过滤和 prompt command 模型调用基础上，补齐用户可感知的 slash command 体验：

- 补全菜单展示来源、参数提示、alias 命中，并引入 session 级最近使用排序
- 完善 mid-input slash command 的 ghost text、参数提示、来源展示和有效 token 高亮
- 将 `/help` 从当前不可用的命令堆砌重构为 Claude Code 风格的分 tab、清晰、美观的帮助面板
- 增强 ACP `available_commands_update` 的命令元数据
- 确认已实现的 `/doctor` 不重复实现；`/release-notes` 不纳入本阶段

### 1.2 硬性约束

- **代码为准**：Phase 1/2 文档与实现存在差异时，以当前主分支源码为准。
- **不引入新执行架构**：继续复用现有 `SlashCommand`、`CommandService`、`handleSlashCommand`、`useSlashCompletion` 和 `Help` 组件，不新建 `CommandDescriptor` / `CommandExecutor` / `ModeAdapter`。
- **不恢复 `commandType`**：当前实现已删除 Phase 1 早期设计中的 `commandType` 字段，Phase 3 不重新引入该字段。
- **session 级 recently used**：最近使用排序只在当前 CLI session 内生效，不持久化到磁盘。
- **interactive 行为不退化**：补全、help、doctor 等已有 interactive 行为保持可用；Phase 3 只增强展示与补齐缺失命令。
- **ACP 向后兼容**：`availableCommands[].name`、`description`、`input` 三个已有字段保持不变；新增元数据放在兼容字段或 `_meta` 中，避免破坏已有 ACP 客户端。

---

## 2. 当前实现基线（源码审计结论）

### 2.1 已有元数据与 Loader 行为

`packages/cli/src/ui/commands/types.ts` 当前 `SlashCommand` 已包含：

- `source?: CommandSource`
- `sourceLabel?: string`
- `supportedModes?: ExecutionMode[]`
- `userInvocable?: boolean`
- `modelInvocable?: boolean`
- `argumentHint?: string`
- `whenToUse?: string`
- `examples?: string[]`

`CommandSource` 当前支持：

```typescript
export type CommandSource =
  | 'builtin-command'
  | 'bundled-skill'
  | 'skill-dir-command'
  | 'plugin-command'
  | 'mcp-prompt';
```

各 Loader 当前已填充的展示信息：

| Loader                                  | source                                 | sourceLabel                              | argumentHint     | modelInvocable                                   |
| --------------------------------------- | -------------------------------------- | ---------------------------------------- | ---------------- | ------------------------------------------------ |
| `BuiltinCommandLoader`                  | `builtin-command`                      | `Built-in`                               | 多数未声明       | `false`                                          |
| `BundledSkillLoader`                    | `bundled-skill`                        | `Skill`                                  | 来自 skill       | `!disableModelInvocation`                        |
| `FileCommandLoader` / `command-factory` | `skill-dir-command` / `plugin-command` | `Custom` / `Plugin: <extensionName>`     | 来自 frontmatter | 用户/项目默认 true；插件需 description/whenToUse |
| `SkillCommandLoader`                    | `skill-dir-command` / `plugin-command` | `User` / `Project` / `Extension: <name>` | 来自 skill       | 用户/项目默认 true；插件需 description/whenToUse |
| `McpPromptLoader`                       | `mcp-prompt`                           | `MCP: <serverName>`                      | 未生成           | 当前未显式设置 `modelInvocable`                  |

> 注意：Phase 1 路线图曾要求 MCP prompt `modelInvocable: true`，但当前实现没有显式设置。Phase 3 不改变 MCP prompt 的模型调用路径；MCP prompt 仍通过 MCP 原生机制调用，不通过 `SkillTool` 中转。

### 2.2 当前已实现的 Phase 3 相关能力

| 能力                                                 | 当前状态                                                                                                | 关键文件                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| mid-input slash 基础 ghost text                      | 已部分实现，仅对 `modelInvocable` 命令做前缀补全                                                        | `ui/utils/commandUtils.ts`、`ui/hooks/useCommandCompletion.tsx`  |
| line-start 命令 argument ghost text                  | 已部分实现，命令完全匹配且无 args 时展示 `argumentHint`                                                 | `ui/hooks/useCommandCompletion.tsx`                              |
| alias 参与匹配                                       | 已实现匹配与排序，但展示总是显示全部 alias，不区分命中 alias                                            | `ui/hooks/useSlashCompletion.ts`                                 |
| source badge                                         | 仅 MCP 展示 `[MCP]`                                                                                     | `ui/components/SuggestionsDisplay.tsx`、`ui/components/Help.tsx` |
| `/help`                                              | 当前实现视为未完成：虽有分组尝试，但仍是命令堆砌，不具备 Claude Code 风格的分 tab、清晰可读帮助面板体验 | `ui/components/Help.tsx`                                         |
| ACP `argumentHint`                                   | 已映射到 `availableCommands[].input.hint`                                                               | `acp-integration/session/Session.ts`                             |
| ACP source/supportedModes/subcommands/modelInvocable | 未暴露                                                                                                  | `acp-integration/session/Session.ts`                             |
| 冲突处理                                             | extension 命令冲突时已重命名为 `extensionName.commandName`，非 extension 同名为后加载覆盖前加载         | `services/CommandService.ts`                                     |
| `/doctor`                                            | 已实现，支持 `interactive` / `non_interactive` / `acp`                                                  | `ui/commands/doctorCommand.ts`、`utils/doctorChecks.ts`          |

### 2.3 Claude Code 可借鉴点

参考 `/Users/mochi/code/claude-code` 源码：

- `src/types/command.ts`：命令模型包含 `argumentHint`、`whenToUse`、`aliases`、`loadedFrom`、`kind`、`immediate`、`isSensitive`、`userFacingName`、`supportsNonInteractive` 等展示/能力字段。
- `src/utils/suggestions/commandSuggestions.ts`：补全排序同时考虑精确命中、alias 命中、prefix、fuzzy、skill usage；alias 命中时只展示用户实际命中的 alias。
- `src/utils/suggestions/commandSuggestions.ts`：mid-input slash 使用 `findMidInputSlashCommand()`、`getBestCommandMatch()` 和 `findSlashCommandPositions()` 支持 ghost text 与高亮。
- `src/components/HelpV2/Commands.tsx`：Help V2 是可浏览的命令目录，展示描述时会附带来源信息。
- `src/commands.ts`：Claude Code 内置 `/doctor`、`/release-notes` 等命令，Qwen Code 当前已实现 `/doctor`；本阶段不实现 `/release-notes`。

Phase 3 采用“体验对齐，不复制架构”的方式借鉴上述点。

---

## 3. 总体方案

### 3.1 文件变更总览

| 文件                                                    | 变更内容                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/cli/src/ui/components/SuggestionsDisplay.tsx` | 扩展 `Suggestion` 类型，展示 source badge、argumentHint、aliasHit         |
| `packages/cli/src/ui/hooks/useSlashCompletion.ts`       | 生成增强补全项；排序接入 recently used；保留 alias 命中信息               |
| `packages/cli/src/ui/hooks/useCommandCompletion.tsx`    | mid-input ghost text 复用增强匹配；输出 argument/source 元数据供 UI 展示  |
| `packages/cli/src/ui/utils/commandUtils.ts`             | 增加 slash token 高亮辅助函数，或扩展现有函数返回命令有效性               |
| `packages/cli/src/ui/components/InputPrompt.tsx`        | 渲染有效 slash command token 高亮；保留 Tab 接受 ghost text               |
| `packages/cli/src/ui/components/Help.tsx`               | 重构为 Claude Code 风格的分 tab 帮助面板，避免命令堆砌                    |
| `packages/cli/src/ui/commands/helpCommand.ts`           | 如需 non-interactive/acp 帮助文本，扩展 action；否则仅保持 interactive UI |
| `packages/cli/src/acp-integration/session/Session.ts`   | 在 ACP update 中暴露增强元数据                                            |
| `packages/cli/src/ui/commands/*Command.ts`              | 为常用 built-in 命令补充 `argumentHint`                                   |

### 3.2 新增共享展示工具

建议新增 `packages/cli/src/services/commandMetadata.ts`，集中处理 Help、Completion、ACP 共同需要的展示逻辑：

```typescript
export function getCommandSourceBadge(cmd: SlashCommand): string | null;
export function getCommandSourceGroup(cmd: SlashCommand): CommandSourceGroup;
export function formatSupportedModes(cmd: SlashCommand): string;
export function getCommandDisplayName(cmd: SlashCommand): string;
export function getCommandSubcommandNames(cmd: SlashCommand): string[];
```

不建议把这些展示函数放入 Loader，避免 Loader 承担 UI 逻辑。

---

## 4. Phase 3.1：补全体验增强

### 4.1 扩展 `Suggestion` 数据结构

当前：

```typescript
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;
}
```

建议扩展为：

```typescript
export interface Suggestion {
  label: string;
  value: string;
  description?: string;
  matchedIndex?: number;
  commandKind?: CommandKind;

  // Phase 3
  source?: CommandSource;
  sourceLabel?: string;
  sourceBadge?: string;
  argumentHint?: string;
  matchedAlias?: string;
  supportedModes?: ExecutionMode[];
  modelInvocable?: boolean;
}
```

`mode !== 'slash'` 的文件补全、reverse search 不需要填充这些字段。

### 4.2 source badge 展示

当前 `SuggestionsDisplay` 只对 `CommandKind.MCP_PROMPT` 追加 `[MCP]`。Phase 3 改为使用 `source` / `sourceLabel` 统一生成 badge：

| source / sourceLabel              | badge                                      |
| --------------------------------- | ------------------------------------------ |
| `builtin-command`                 | `[Built-in]`（可选：默认不展示，降低噪音） |
| `bundled-skill` / `Skill`         | `[Skill]`                                  |
| `skill-dir-command` / `User`      | `[User]`                                   |
| `skill-dir-command` / `Project`   | `[Project]`                                |
| `skill-dir-command` / `Custom`    | `[Custom]`                                 |
| `plugin-command` / `Plugin: x`    | `[Plugin]` 或 `[Plugin: x]`                |
| `plugin-command` / `Extension: x` | `[Extension]` 或 `[Extension: x]`          |
| `mcp-prompt`                      | `[MCP]`                                    |

推荐实现：

```typescript
function getCommandSourceBadge(cmd: SlashCommand): string | null {
  switch (cmd.source) {
    case 'bundled-skill':
      return '[Skill]';
    case 'skill-dir-command':
      return cmd.sourceLabel === 'User'
        ? '[User]'
        : cmd.sourceLabel === 'Project'
          ? '[Project]'
          : '[Custom]';
    case 'plugin-command':
      return '[Plugin]';
    case 'mcp-prompt':
      return '[MCP]';
    case 'builtin-command':
    default:
      return null;
  }
}
```

> 是否展示 `[Built-in]` 由 UI 可读性决定。Help 中必须展示 Built-in 分组；补全菜单中可以省略 built-in badge，只对非内置来源展示 badge。

### 4.3 argument hint 展示

补全菜单中命令名后追加灰色 `argumentHint`：

```text
/model <model-id>              Switch model
/export md|html|json|jsonl     Export current session
/review [pr-number] [--comment] [Skill] Review changed code
```

实现建议：

- `useSlashCompletion` 在 `finalSuggestions` 中填充 `argumentHint: cmd.argumentHint`
- `SuggestionsDisplay` 在 label 后以 `theme.text.secondary` 渲染 `argumentHint`
- `commandColumnWidth` 计算包含 label + hint + badge，避免描述列错位
- 子命令补全也支持 `argumentHint`

需要先为常用 built-in 命令补充 `argumentHint`。建议首批：

| 命令             | argumentHint            |
| ---------------- | ----------------------- | ------------------ | -------- | ------------- | ------- |
| `/model`         | `[--fast] [<model-id>]` |
| `/approval-mode` | `<mode>`                |
| `/language`      | `ui                     | output <language>` |
| `/export`        | `md                     | html               | json     | jsonl [path]` |
| `/memory`        | `show                   | add                | refresh` |
| `/mcp`           | `desc                   | nodesc             | schema   | auth          | noauth` |
| `/stats`         | `[model                 | tools]`            |
| `/docs`          | 空或不设置              |
| `/doctor`        | 空或不设置              |

### 4.4 recently used 排序

#### 4.4.1 状态存储

在 `useSlashCommandProcessor` 或 `AppContainer` 中维护 session 级最近使用状态：

```typescript
type RecentSlashCommand = {
  name: string;
  usedAt: number;
  count: number;
};
```

建议以 `Map<string, RecentSlashCommand>` 存储，key 使用最终命令名（即冲突处理后的 `cmd.name`）。

#### 4.4.2 记录时机

在 `useSlashCommandProcessor.handleSlashCommand` 成功解析到 `commandToExecute` 后记录使用：

- 未找到命令不记录
- hidden 命令可不记录
- alias 调用按 canonical `commandToExecute.name` 记录
- 子命令调用建议记录父命令和叶子命令完整路径，首期只记录叶子命令也可接受

#### 4.4.3 排序权重

当前 `compareRankedCommandMatches()` 排序顺序是：

1. matchStrength
2. completionPriority
3. fzf score
4. match start
5. item length
6. original index

Phase 3 插入 `recentScore`：

```typescript
return (
  right.matchStrength - left.matchStrength ||
  right.completionPriority - left.completionPriority ||
  right.recentScore - left.recentScore ||
  right.score - left.score ||
  left.start - right.start ||
  left.itemLength - right.itemLength ||
  left.originalIndex - right.originalIndex
);
```

`recentScore` 建议：

```typescript
const RECENT_DECAY_MS = 10 * 60 * 1000;
const recentScore = count * 10 + Math.max(0, 10 - ageMs / RECENT_DECAY_MS);
```

当 query 为空（用户只输入 `/`）时，recently used 命令置顶；当 query 非空时，只在同等匹配强度下加权，避免近期命令压过明显更精确的命令。

### 4.5 alias 命中展示

当前 alias 已参与 `AsyncFzf` 和 prefix fallback，但 `formatSlashCommandLabel()` 总是显示所有 alias：

```text
help (?)
compress (summarize)
```

Phase 3 改为：

- 当用户输入命中主名：不额外展示 alias，或保持现有简洁格式
- 当用户输入命中 alias：展示 `help (alias: ?)`
- `Suggestion.matchedAlias` 由匹配阶段写入

实现要点：

```typescript
function findMatchedAlias(
  cmd: SlashCommand,
  query: string,
): string | undefined {
  return cmd.altNames?.find((alt) =>
    alt.toLowerCase().startsWith(query.toLowerCase()),
  );
}
```

在 FZF 结果中，如果 `result.item` 来自 `altNames`，可直接将其作为 `matchedAlias`；prefix fallback 中同理。

---

## 5. Phase 3.2：mid-input slash command 完整版

### 5.1 当前行为

当前 `findMidInputSlashCommand()` 仅识别“由空白分隔的 `/xxx` token”，且要求 cursor 位于 token 末尾；`getBestSlashCommandMatch()` 只在 `modelInvocable` 命令中做字母序 prefix 匹配。

这符合 Phase 2 基础版目标，但 Phase 3 需要补齐展示与高亮。

### 5.2 ghost text 增强

保留当前策略：mid-input slash 只提示 `modelInvocable` 命令，因为正文中的内置命令不会作为 slash command 执行。

增强点：

- 匹配算法从字母序 prefix 改为复用 `useSlashCompletion` 的排序规则（至少考虑 `completionPriority` 和 recently used）
- 返回结构扩展为：

```typescript
export type BestSlashCommandMatch = {
  suffix: string;
  fullCommand: string;
  command: SlashCommand;
  sourceBadge?: string;
  argumentHint?: string;
};
```

### 5.3 mid-input source badge 与 argument hint

由于 ghost text 位置空间有限，不建议把 badge 和 hint 直接塞入 ghost text 主体。建议展示规则：

- ghost text 仍只渲染命令名后缀，例如输入 `please /rev` 显示 `iew`
- 当 token 已完整匹配命令且命令有 `argumentHint` 时，在 cursor 后显示淡色参数提示，例如 `/review [pr-number] [--comment]`
- source badge 仅在 dropdown 或状态提示中展示；如果 mid-input 不弹 dropdown，则可不强制显示 badge

### 5.4 有效命令 token 高亮

借鉴 Claude Code `findSlashCommandPositions()`，在 `InputPrompt.renderLineWithHighlighting()` 中对正文里的有效 slash command token 着色。

建议新增工具函数：

```typescript
export type SlashCommandToken = {
  start: number;
  end: number;
  commandName: string;
  valid: boolean;
};

export function findSlashCommandTokens(
  text: string,
  commands: readonly SlashCommand[],
): SlashCommandToken[];
```

规则：

- token 必须位于字符串开头或前一个字符为空白
- token 形如 `/[a-zA-Z][a-zA-Z0-9:_-]*`
- 对 mid-input 高亮只判定 `modelInvocable` 命令为 valid
- line-start token 可判定所有 interactive 可见命令为 valid
- valid token 使用 accent 色；invalid token 保持普通文本，避免把路径 `/usr/bin` 误标为命令

---

## 6. Phase 3.3：Help 目录重构

### 6.1 当前问题

`Help.tsx` 当前输出：

- Basics
- 平铺 `Commands:`
- `[MCP]` 说明
- Keyboard Shortcuts

问题：

- 所有来源混在一起，skill、custom、plugin、MCP 难以区分
- 不展示 `argumentHint`
- 不展示 `supportedModes`
- 不展示 `modelInvocable`
- 子命令只缩进一级，不展示来源/mode

### 6.2 分组设计

按 `source` / `sourceLabel` 分组：

1. **Built-in Commands**：`source === 'builtin-command'`
2. **Bundled Skills**：`source === 'bundled-skill'`
3. **Custom Commands**：`source === 'skill-dir-command'`，包含 `Custom` / `User` / `Project`
4. **Plugin Commands**：`source === 'plugin-command'`，包含 `Plugin:*` / `Extension:*`
5. **MCP Commands**：`source === 'mcp-prompt'`
6. **Other Commands**：source 缺失的兼容兜底

每组内部按命令名排序；hidden 命令不展示。

### 6.3 每条命令展示字段

格式建议：

```text
/model [--fast] [<model-id>]  Switch model
  source: Built-in  modes: interactive, non_interactive, acp

/review [pr-number] [--comment]  Review changed code
  source: Skill  modes: interactive, non_interactive, acp  model: yes
```

为避免 Help 过宽，建议压缩为单行：

```text
 /review [pr-number] [--comment] [Skill] [all] [model] - Review changed code
```

mode badge 建议：

| supportedModes                      | badge            |
| ----------------------------------- | ---------------- |
| `interactive` only                  | `[interactive]`  |
| `interactive, non_interactive, acp` | `[all]`          |
| `non_interactive, acp`              | `[headless]`     |
| 其他组合                            | `[i] [ni] [acp]` |

### 6.4 `/help` 是否扩展到 headless

路线图只要求 `/help` 输出按来源分组，没有明确要求 non-interactive/acp。当前 `/help` 是 `supportedModes: ['interactive']`。

Phase 3 建议新增 headless 路径，但作为独立子任务：

- `supportedModes` 改为 all modes
- interactive：继续渲染 `HistoryItemHelp`
- non_interactive/acp：返回纯文本分组目录 `message`

如果 scope 需要收敛，可先只重构 interactive `Help` 组件，headless `/help` 延后。

---

## 7. Phase 3.4：ACP available commands 元数据增强

### 7.1 当前 ACP 输出

`Session.sendAvailableCommandsUpdate()` 当前将 `SlashCommand[]` 映射为：

```typescript
{
  name: cmd.name,
  description: cmd.description,
  input: cmd.argumentHint ? { hint: cmd.argumentHint } : null,
}
```

其中 `argumentHint` 已通过 `input.hint` 暴露。

### 7.2 增强方案

ACP protocol 的 `AvailableCommand` 类型如果不能直接增加字段，使用 `_meta` 保持兼容：

```typescript
const availableCommands: AvailableCommand[] = slashCommands.map((cmd) => ({
  name: cmd.name,
  description: cmd.description,
  input: cmd.argumentHint ? { hint: cmd.argumentHint } : null,
  _meta: {
    argumentHint: cmd.argumentHint,
    source: cmd.source,
    sourceLabel: cmd.sourceLabel,
    supportedModes: cmd.supportedModes ?? getEffectiveSupportedModes(cmd),
    subcommands: cmd.subCommands
      ?.filter((sub) => !sub.hidden)
      .map((sub) => sub.name),
    modelInvocable: cmd.modelInvocable === true,
  },
}));
```

如果 `AvailableCommand` 类型允许扩展字段，则优先输出为一等字段：

```typescript
{
  name,
  description,
  input,
  argumentHint,
  source,
  supportedModes,
  subcommands,
  modelInvocable,
}
```

但仍建议保留 `_meta` 镜像一段时间，便于旧客户端渐进迁移。

### 7.3 subcommands 递归策略

验收标准只要求 `subcommands` 名称列表。首期输出一级子命令即可：

```typescript
subcommands: cmd.subCommands?.map((sub) => sub.name) ?? [];
```

后续如果 ACP 客户端需要多级树，可扩展为：

```typescript
type AcpSubcommandMeta = {
  name: string;
  description?: string;
  argumentHint?: string;
  subcommands?: AcpSubcommandMeta[];
};
```

---

## 8. Phase 3.5：Claude Code 缺失命令补齐

### 8.1 `/doctor`：已实现，不重复实现

当前 `doctorCommand` 已存在：

- 文件：`packages/cli/src/ui/commands/doctorCommand.ts`
- 注册：`BuiltinCommandLoader`
- 模式：`['interactive', 'non_interactive', 'acp']`
- interactive：展示 `HistoryItemDoctor`
- non_interactive/acp：返回 JSON `message`
- 诊断逻辑：`packages/cli/src/utils/doctorChecks.ts`

Phase 3 只需在 Help 和补全中为 `/doctor` 正确展示来源、mode；如需优化，可将 headless JSON 改为更适合人读的 Markdown，但这不是必需项。

### 8.2 `/release-notes`：不纳入本阶段

`/release-notes` 不再作为 Phase 3 需求。本阶段不新增命令、不注册 built-in、不编写相关测试，避免引入无明确产品需求的命令表面。

---

## 9. 冲突策略确认与展示

当前 `CommandService` 冲突策略：

- extension/plugin 命令若与已存在命令同名，重命名为 `extensionName.commandName`
- 若二次冲突，追加数字后缀：`extensionName.commandName1`
- 非 extension 命令同名时，后加载覆盖前加载

Phase 3 不改变执行语义，只在 Help/Completion 中清晰展示最终名称和来源。

建议补充测试确保：

- 被重命名的 plugin command 在补全中显示最终名称和 `[Plugin]` badge
- Help 中按 Plugin Commands 分组展示最终名称
- ACP 输出使用最终名称

> 路线图中“built-in > bundled/skill-dir > plugin > mcp”的优先级，与当前实现“非 extension 后加载覆盖前加载”不完全一致。Phase 3 文档以当前 `CommandService` 源码为准，不在本阶段改冲突语义；如需严格调整优先级，应作为单独 Phase 处理，避免改变已有用户/项目命令覆盖行为。

---

## 10. 测试策略

### 10.1 补全测试

更新或新增：

- `packages/cli/src/ui/hooks/useSlashCompletion.test.ts`
- `packages/cli/src/ui/hooks/useCommandCompletion.test.ts`
- `packages/cli/src/ui/components/SuggestionsDisplay.test.tsx`（如当前无文件则新增）

覆盖：

- source badge：Skill/Custom/Plugin/MCP 正确展示
- argumentHint：命令名后展示 hint，且列宽不破坏描述
- recently used：只输入 `/` 时近期命令排在前面；输入明确 query 时精确命中优先
- alias 命中：输入 `?` 展示 `help (alias: ?)`，输入 `he` 不展示 alias 命中提示
- mid-input ghost：正文 `/rev` 提示 modelInvocable `/review` 后缀
- mid-input 不提示 built-in：正文 `/sta` 不提示 `/stats`（除非未来设计允许内嵌 built-in 执行）

### 10.2 Help 测试

更新：`packages/cli/src/ui/components/Help.test.tsx`

覆盖：

- 按 Built-in/Bundled Skills/Custom/Plugin/MCP 分组
- hidden 命令不展示
- 子命令展示名称列表
- `argumentHint`、source badge、mode badge、model badge 正确出现
- altNames 仍可展示，但不干扰主命令名

### 10.3 ACP 测试

更新：`packages/cli/src/acp-integration/session/Session.test.ts`

覆盖：

- `availableCommands[].input.hint` 保持现有行为
- 新增元数据包含 `argumentHint`、`source`、`sourceLabel`、`supportedModes`、`subcommands`、`modelInvocable`
- 无 `argumentHint` 的命令 `input: null` 保持兼容
- `getAvailableCommands(config, signal, 'acp')` 调用保持不变

### 10.4 新命令测试

本阶段不新增 `/release-notes` 或其他 built-in 命令，因此不需要新增命令测试。仅保留 `/doctor` 既有回归测试。

### 10.5 E2E 测试方案

Phase 3 同时修改 TUI 补全、slash command 执行、ACP command metadata，单元测试不能覆盖完整用户路径。E2E 验证分三类进行：

1. **构建本地 CLI**：先运行 `npm run build && npm run bundle`，后续使用 `node dist/cli.js` 验证本地实现。
2. **Interactive / tmux 场景**：用于验证补全菜单、ghost text、Tab 接受、Help 渲染等 TUI 行为。
3. **Headless / JSON 场景**：用于验证 non-interactive slash command 输出，不依赖 TUI。
4. **ACP integration 场景**：用于验证 `available_commands_update` 元数据。

#### 10.5.1 E2E 前置步骤

```bash
npm run build && npm run bundle
```

Interactive 场景建议使用独立临时目录，避免污染当前仓库：

```bash
tmux new-session -d -s qwen-slash-phase3 -x 200 -y 50 \
  "cd /tmp/qwen-slash-phase3 && /Users/mochi/code/qwen-code-test/dist/cli.js --approval-mode yolo"
sleep 3
```

发送输入时拆分文本和回车，避免 TUI 吞掉提交：

```bash
tmux send-keys -t qwen-slash-phase3 "/help"
sleep 0.5
tmux send-keys -t qwen-slash-phase3 Enter
```

捕获输出：

```bash
tmux capture-pane -t qwen-slash-phase3 -p -S -100
```

清理：

```bash
tmux kill-session -t qwen-slash-phase3
```

#### 10.5.2 E2E 测试清单

| 场景                    | 模式             | 步骤                                                                                    | 预期结果                                                                                                                                  |
| ----------------------- | ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 补全 source badge       | interactive/tmux | 输入 `/`，观察补全菜单                                                                  | skill/custom/plugin/MCP 命令展示对应 source badge；built-in 可不展示 badge                                                                |
| 补全 argument hint      | interactive/tmux | 输入 `/model`、`/export`                                                                | 命令名后展示 `argumentHint`；无参数命令不展示噪声 hint                                                                                    |
| recently used 排序      | interactive/tmux | 先执行 `/help`，再输入 `/`                                                              | `/help` 在同等匹配条件下优先出现；精确 query 仍优先匹配 query                                                                             |
| alias 命中展示          | interactive/tmux | 输入 `/?`                                                                               | 补全项展示 `help (alias: ?)`；输入 `/he` 时不误显示 alias 命中                                                                            |
| mid-input ghost text    | interactive/tmux | 在正文中输入 `please /rev`                                                              | 出现 `/review` 的 ghost text 后缀，Tab 可接受                                                                                             |
| mid-input token 高亮    | interactive/tmux | 输入包含 `/review` 的正文                                                               | 有效 model-invocable slash token 使用命令高亮；路径如 `/usr/bin` 不被高亮为命令                                                           |
| Help 分组目录           | interactive/tmux | 执行 `/help`                                                                            | 输出包含 Built-in Commands、Bundled Skills、Custom Commands、Plugin Commands、MCP Commands 分组；每条命令展示 source/mode/hint            |
| `/doctor` headless 回归 | headless/json    | 执行 `node dist/cli.js "/doctor" --approval-mode yolo --output-format json 2>/dev/null` | 返回 `message`，不触发 TUI-only 组件错误                                                                                                  |
| ACP metadata            | integration      | 运行 ACP session 并触发 `available_commands_update`                                     | 每个 command 保留 `name`、`description`、`input.hint`，并包含 `argumentHint`、`source`、`supportedModes`、`subcommands`、`modelInvocable` |

#### 10.5.3 Headless 命令示例

`/release-notes` 不纳入本阶段；headless 回归仅保留 `/doctor` 等既有命令验证。

### 10.6 回归测试命令

按 AGENTS.md，优先运行单文件测试：

```bash
cd packages/cli && npx vitest run src/ui/hooks/useSlashCompletion.test.ts
cd packages/cli && npx vitest run src/ui/hooks/useCommandCompletion.test.ts
cd packages/cli && npx vitest run src/ui/components/Help.test.tsx
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts
```

最终验证：

```bash
npm run build && npm run typecheck
npm run build && npm run bundle
```

---

## 11. 验收标准

### 11.1 补全菜单

- [ ] 补全菜单展示 source badge（至少 `[MCP]`、`[Skill]`、`[Custom]`、`[Plugin]`）
- [ ] 补全菜单展示 `argumentHint`
- [ ] session 内最近使用命令在只输入 `/` 时优先出现
- [ ] alias 命中时展示 `alias: <alias>`，非 alias 命中不噪声展示
- [ ] plugin/extension 冲突重命名后的命令在补全中展示最终名称和来源

### 11.2 mid-input slash

- [ ] 正文中输入 `/review` 这类 model-invocable 命令时 ghost text 正确提示
- [ ] Tab 可接受 mid-input ghost text
- [ ] 有效 mid-input slash command token 高亮
- [ ] built-in 命令不会在正文中被误提示为可执行内嵌命令
- [ ] 参数提示在命令完整匹配且无 args 时显示

### 11.3 Help

- [ ] `/help` 按来源分组展示命令
- [ ] 每条命令展示名称、`argumentHint`、description、source、supportedModes 标记
- [ ] model-invocable 命令有明确标记
- [ ] 子命令以名称列表或缩进项展示
- [ ] hidden 命令不展示

### 11.4 ACP

- [ ] ACP `available_commands_update` 继续包含 `name`、`description`、`input.hint`
- [ ] ACP command 元数据包含 `argumentHint`、`source`、`supportedModes`、`subcommands`、`modelInvocable`
- [ ] 旧客户端忽略新增字段时不受影响

### 11.5 缺失命令

- [ ] `/doctor` 仍可用，且 non-interactive 返回 `message`
- [ ] 不新增 `/release-notes`，文档、测试和验收标准中均不再要求该命令

---

## 12. 非目标

以下内容不纳入 Phase 3：

- 不实现 workflow command / dynamic skill / mcp skill 新 Loader
- 不引入持久化 command usage tracking
- 不改变 `SkillTool` 的模型调用协议
- 不改变 MCP prompt 的模型调用路径
- 不重构 command 执行器或 mode adapter
- 不改变现有 user/project command 覆盖语义

---

## 13. 建议实施顺序

1. **补全数据结构与 badge/hint 展示**：先扩展 `Suggestion` 和 `SuggestionsDisplay`，风险低、反馈直观。
2. **补充 built-in `argumentHint`**：让已有 ghost text 和 ACP `input.hint` 立即受益。
3. **recently used 排序**：在 `useSlashCompletion` 引入 recent score，补测试。
4. **alias 命中展示**：调整 FZF/prefix 匹配保留 `matchedAlias`。
5. **Help 分 tab 重构**：按 Claude Code 风格提供 General / Commands / Custom Commands 等清晰面板，避免堆砌命令。
6. **ACP 元数据增强**：扩展 `Session.sendAvailableCommandsUpdate()`，保持 `_meta` 兼容。
7. **mid-input 高亮增强**：最后处理渲染层，避免与补全逻辑并行改动过大。
