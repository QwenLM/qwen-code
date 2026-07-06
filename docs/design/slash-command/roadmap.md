# Slash Command 重构路线图

## 总体目标

用 Qwen 内部架构风格，交付一个在外部体验上 95% 对齐 Claude Code 的 command 平台，同时修复三模式分裂、命令来源单一、prompt command 无法被模型调用三个核心问题。

---

## 核心设计原则

1. **每个 Phase 可独立 ship**：完成后行为是自洽的，不依赖未来 Phase 才能运行
2. **Phase 1 是纯基础设施**：除修复 MCP_PROMPT 被错误拦截外，不改变任何现有可用命令集
3. **行为变化与架构变化分开**：Phase 1 做架构，Phase 2 做能力扩展
4. **不照搬 Claude Code 内部架构**：但对齐用户可感知的能力面

---

## Phase 1：基础设施重建（纯架构，零行为变化）

### 目标

建立统一的命令元数据模型和跨模式管理机制，为后续所有 Phase 提供底层支撑。

### 功能点

#### 1.1 扩展 `SlashCommand` 元数据模型

在现有 `SlashCommand` 接口上新增以下字段：

**来源字段**

- `source: CommandSource`：命令来源枚举（`builtin-command` / `bundled-skill` / `skill-dir-command` / `plugin-command` / `mcp-prompt` 等）
- `sourceLabel?: string`：展示用的来源标签（如 `"Built-in"` / `"MCP: github-server"`）

**模式能力字段**

- `supportedModes: ExecutionMode[]`：声明在哪些运行模式下可用（`interactive` / `non_interactive` / `acp`）

**执行类型字段**

- `commandType: CommandType`：声明执行类型（`prompt` / `local` / `local-jsx`）

**可见性字段**

- `userInvocable: boolean`：用户是否可通过 slash command 调用（默认 `true`）
- `modelInvocable: boolean`：模型是否可通过 tool call 调用（默认 `false`）

**辅助元数据字段**（为 Phase 3 预留，Phase 1 仅定义，不使用）

- `argumentHint?: string`：参数提示，如 `"<model-id>"` / `"show|list|set"`
- `whenToUse?: string`：何时调用该命令的说明（供模型使用）
- `examples?: string[]`：使用示例

#### 1.2 Loader 填充 source/commandType 字段

每个 Loader 在构建 `SlashCommand` 时必须填充 `source` 和 `commandType`：

| Loader                           | source              | commandType                           |
| -------------------------------- | ------------------- | ------------------------------------- |
| `BuiltinCommandLoader`           | `builtin-command`   | 由各命令声明（`local` / `local-jsx`） |
| `BundledSkillLoader`             | `bundled-skill`     | `prompt`                              |
| `FileCommandLoader`（用户/项目） | `skill-dir-command` | `prompt`                              |
| `FileCommandLoader`（插件）      | `plugin-command`    | `prompt`                              |
| `McpPromptLoader`                | `mcp-prompt`        | `prompt`                              |

#### 1.3 内置命令声明 `supportedModes` 和 `commandType`

为所有 built-in 命令显式声明：

- `commandType`：`local`（无 UI 依赖）或 `local-jsx`（依赖 dialog/React）
- `supportedModes`：`local` 类命令声明 `['interactive', 'non_interactive', 'acp']`；`local-jsx` 类命令声明 `['interactive']`

#### 1.4 用 capability-based 过滤替换硬编码白名单

- 删除 `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` 常量
- 删除 `filterCommandsForNonInteractive` 函数
- 新增 `filterCommandsForMode(commands, mode)` 函数，基于 `supportedModes` 字段过滤
- 新增 `getEffectiveSupportedModes(cmd)` 工具函数（考虑 CommandKind 默认策略）
- 修改 `handleSlashCommand` / `getAvailableCommands` 函数签名，移除 `allowedBuiltinCommandNames` 参数

#### 1.5 CommandService 升级为统一 Registry

- 新增 `getCommandsForMode(mode: ExecutionMode)` 方法
- 新增 `getModelInvocableCommands()` 方法（Phase 2/3 使用，Phase 1 提供接口）
- 现有 `getCommands()` 保持不变（interactive 使用）

### 验收标准

- [ ] `SlashCommand` 接口包含所有新字段，TypeScript 编译通过
- [ ] 所有 Loader 填充 `source` 和 `commandType` 字段
- [ ] 所有 built-in 命令声明 `commandType` 和 `supportedModes`
- [ ] `ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE` 已删除，被 capability filter 取代
- [ ] **non-interactive 下可用命令集与重构前完全一致**（现有测试不 break）
- [ ] MCP prompt commands 在 non-interactive/acp 下可正常执行（修复原有错误限制）
- [ ] `CommandService.getCommandsForMode('non_interactive')` 返回正确的命令集
- [ ] 所有现有测试通过

---

## Phase 2：能力扩展（命令整理与 prompt command 模型调用）

### 目标

基于 Phase 1 的元数据基础，扩展三种模式下的命令可用范围，并打通 prompt command 的模型调用通路。

### 功能点

#### 2.1 扩展 non-interactive / acp 可用命令集

**ACP 语义设计原则**

将命令扩展到 ACP/non-interactive 模式前，需遵循以下设计原则：

1. **接收方不同**：ACP 模式下消息的接收方是 IDE（Zed/VS Code 插件），而非终端用户。消息内容以纯文本或 Markdown 格式为宜，不应包含 terminal 专用的 ANSI 样式。
2. **实现策略是增加模式分支，而非替换**：正确做法是在命令的 `action` 内部新增模式判断——interactive 路径保持现有 UI 渲染逻辑不变，non_interactive/acp 路径返回适合机器消费的 `message` 或 `submit_prompt`。两条路径共存于同一个 `action` 函数中。
3. **有状态操作需说明语义**：在单次非交互调用中（如 CLI `-p` 参数），`/model set`、`/language set` 等有状态命令的变更仅在本次 session 内有效，应在命令响应文本中注明。
4. **只读 vs 有副作用**：只读命令（如 `/about`、`/stats`）直接返回当前状态文本；有副作用命令（如 `/model set`、`/language set`）需在响应中确认操作结果。
5. **避免环境相关副作用**：打开浏览器（`/docs`、`/insight`）、操作剪贴板（`/copy`）等依赖图形环境的操作，在 non_interactive/acp 路径下应跳过，改为在响应文本中返回相关 URL 或内容本身。

**待扩展命令总览**

> 注：`btw`、`bug`、`compress`、`context`、`init`、`summary` 已在 Phase 1 中扩展到全模式，不在本阶段列表中。

以下 13 个命令将在 Phase 2 中扩展到 `non_interactive` 和 `acp` 模式：

**A 类：action 已返回 `message` 或 `submit_prompt`，只需扩展 `supportedModes` 并设计 ACP 消息内容**

| 命令          | 返回类型        | ACP/non-interactive 处理要点                       |
| ------------- | --------------- | -------------------------------------------------- |
| `/copy`       | `message`       | ACP 下无剪贴板，改为在响应文本中返回内容本身或提示 |
| `/export`     | `message`       | 返回导出文件的完整路径                             |
| `/plan`       | `submit_prompt` | 无需改动，直接扩展模式                             |
| `/restore`    | `message`       | 返回恢复操作的结果描述                             |
| `/language`   | `message`       | 返回当前语言设置或变更确认文本                     |
| `/statusline` | `submit_prompt` | 无需改动，直接扩展模式                             |

**A' 类：有参数时正常执行，无参数时触发 dialog（需增加无参数路径的 non-interactive 处理）**

| 命令             | 无参数 interactive 行为 | 无参数 non_interactive/acp 行为 |
| ---------------- | ----------------------- | ------------------------------- |
| `/model`         | 打开模型选择 dialog     | 返回当前模型名称及说明文本      |
| `/approval-mode` | 打开审批模式 dialog     | 返回当前审批模式及说明文本      |

**B 类：action 内部使用 `context.ui.addItem()` 渲染 React 组件，需增加模式分支返回纯文本**

| 命令       | interactive 行为          | non_interactive/acp 返回内容                                                        |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `/about`   | 渲染版本/配置 React 组件  | 版本号、当前模型、关键配置的纯文本摘要                                              |
| `/stats`   | 渲染 token/费用统计组件   | session 统计数据的纯文本格式                                                        |
| `/insight` | 渲染分析组件 + 打开浏览器 | `non_interactive` 同步生成返回文件路径；`acp` 通过 `stream_messages` 推送进度和结果 |
| `/docs`    | 渲染文档入口 + 打开浏览器 | 返回文档 URL，不打开浏览器                                                          |

**C 类：特殊处理**

| 命令     | interactive 行为                       | non_interactive/acp 行为                                                                            |
| -------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `/clear` | 调用 `context.ui.clear()` 清空终端显示 | 返回上下文边界标记 message，内容为 `"Context cleared. Previous messages are no longer in context."` |

#### 2.2 prompt command 模型调用打通

- 在 `CommandService`（或 `CommandRegistry`）中实现 `getModelInvocableCommands()`，返回所有 `modelInvocable: true` 的命令
- 将 `BundledSkillLoader`、`FileCommandLoader`（用户/项目命令）加载的命令标记为 `modelInvocable: true`
- **MCP prompt 不标记为 `modelInvocable`**：MCP prompt 通过独立的 MCP tool call 机制由模型调用，无需经过 `SkillTool` 中转
- 改造 `SkillTool`：从只消费 `SkillManager.listSkills()` 改为同时消费 `CommandService.getModelInvocableCommands()`
- 构建统一的模型可调用命令描述，注入 `SkillTool` 的 description

#### 2.3 mid-input slash command 检测（基础版）

- 在 `InputPrompt` 中检测光标附近的 slash token（不限于行首）
- 检测到 slash token 后通过 inline ghost text 提示最佳匹配命令名（Tab 接受）
- **不**包含 dropdown 补全菜单、argument hints、source badge 等（Phase 3 做）
- ghost text 候选集仅限 `modelInvocable: true` 的命令（skill / file command）

### 验收标准

**2.1 命令扩展**

- [ ] A 类：`/copy`、`/export`、`/plan`、`/restore`、`/language`、`/statusline` 在 non-interactive 和 acp 模式下可正常执行并返回有意义的文本输出
- [ ] A' 类：`/model`、`/approval-mode` 无参数时在 non-interactive/acp 下返回当前状态文本（不触发 dialog）；有参数时执行变更并返回确认文本
- [ ] B 类：`/about`、`/stats`、`/docs` 在 non-interactive/acp 下返回纯文本，`/docs` 不打开浏览器；`/insight` 在 `non_interactive` 下同步生成并返回文件路径 message，在 `acp` 下通过 `stream_messages` 推送进度
- [ ] C 类：`/clear` 在 non-interactive/acp 下返回上下文边界标记 message，不调用 `context.ui.clear()`
- [ ] 所有扩展命令在 interactive 模式下行为与重构前完全一致（无退化）

**2.2 模型调用**

- [ ] 模型在对话中可以通过 `SkillTool` 调用 bundled skill、file command（用户/项目）
- [ ] MCP prompt 不经过 `SkillTool`，通过 MCP tool call 机制由模型原生调用
- [ ] 模型不可以调用 built-in commands（`userInvocable: true`，`modelInvocable: false`）
- [ ] `SkillTool` 的 description 包含所有 `modelInvocable` 命令的描述

**2.3 mid-input slash**

- [ ] mid-input slash：在正文中输入 `/` 后通过 inline ghost text 提示最佳匹配命令（Tab 接受）

---

## Phase 3：体验对齐（补全增强 + Claude Code 命令补齐）

### 目标

在 Phase 1/2 的元数据和命令能力基础上，补齐补全体验，并补充 Claude Code 中存在而 Qwen Code 缺失的命令。

### 功能点

#### 3.1 补全体验增强

**source badge**

- 在补全菜单中展示命令来源标签（`[MCP]` 已有，扩展为 `[Skill]`、`[Custom]` 等）
- 使用 `source` / `sourceLabel` 字段渲染

**argument hint**

- 补全菜单中命令名后展示 `argumentHint`（如 `set <model-id>`）
- `argumentHint` 由 Phase 1 元数据字段提供

**recently used 排序**

- 记录用户最近使用的命令（session 级别，无需持久化）
- 在补全排序中给近期使用的命令加权

**alias 命中高亮**

- 当补全命中 `altNames` 而非主名时，在展示时注明（如 `help (alias: ?)`）

**冲突策略对齐**

- 明确优先级：built-in > bundled/skill-dir > plugin > mcp
- 冲突时将低优先级命令重命名（如 `pluginName.commandName`）

#### 3.2 mid-input slash command 完整版

- 在 Phase 2 基础版上增加 argument hints 和 source badge 展示
- ghost text 提示（输入 `/he` 时显示 `/help` 的淡色提示）
- 有效命令 token 高亮（已完成匹配的 slash command 显示不同颜色）

#### 3.3 Help 目录重构

将 `/help` 从平铺列表改为分组目录：

- **Built-in Commands**（local + local-jsx，注明 mode）
- **Bundled Skills**
- **Custom Commands**（用户/项目 file commands）
- **Plugin Commands**
- **MCP Commands**

每条命令展示：名称、argumentHint、description、source、supportedModes 标记

#### 3.4 ACP available commands 元数据增强

在 `sendAvailableCommandsUpdate()` 中将更多元数据暴露给 ACP 客户端：

- `argumentHint`
- `source`
- `supportedModes`
- `subcommands`（名称列表）
- `modelInvocable`

#### 3.5 Claude Code 缺失命令补齐

确认并回归 Qwen Code 已有的 `/doctor` 命令；`/release-notes` 不纳入本阶段，避免引入无明确产品需求的 built-in 命令表面。

| 命令      | 类型    | 说明                                 |
| --------- | ------- | ------------------------------------ |
| `/doctor` | `local` | 环境自检，输出配置/连接/工具状态诊断 |

> 注：`/review`、`/commit` 等任务类命令以 bundled skill 形式提供，不在此列。

### 验收标准

- [ ] 补全菜单展示 source badge（`[MCP]`、`[Skill]`、`[Custom]`）
- [ ] 补全菜单展示 argumentHint（如 `set <model-id>`）
- [ ] 近期使用的命令在补全列表中优先出现
- [ ] alias 命中时在补全项中注明原名
- [ ] mid-input slash：ghost text 提示正确渲染
- [ ] `/help` 以 Claude Code 风格分 tab 展示，避免命令堆砌，并在命令页展示支持模式标记
- [ ] ACP available commands 包含 `argumentHint`、`source`、`subcommands` 字段
- [ ] `/doctor` 命令可用
- [ ] `/doctor` 在 non-interactive 模式下可执行（返回 `message`）
- [ ] 不新增 `/release-notes`

---

## 各 Phase 依赖关系

```
Phase 1（元数据 + 统一过滤）
    │
    ├──► Phase 2（能力扩展）
    │        │
    │        ├──► slash command 子命令拆分
    │        └──► prompt command 模型调用（需要 getModelInvocableCommands()）
    │
    └──► Phase 3（体验对齐）
             │
             ├──► source badge（需要 Phase 1 source 字段）
             ├──► argument hint（需要 Phase 1 argumentHint 字段）
             └──► Help 分组（需要 Phase 1 source 字段）
```

Phase 2 和 Phase 3 不互相依赖，可以并行推进（或根据优先级调换部分子项）。
