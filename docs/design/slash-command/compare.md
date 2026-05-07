# Qwen Code Command 模块重构方案

## 1. 目标定义

本方案以以下原则为唯一前提：

- **代码架构可以不照搬 Claude Code**
- **但命令系统的核心功能、使用体验、交互体验必须 95% 对齐 Claude Code**

这里的“对齐”指用户可直接感知的能力，包括：

1. 命令来源覆盖
2. 命令帮助与发现性
3. 命令补全与 mid-input slash command 体验
4. ACP / non-interactive 可用性
5. prompt command / skill 的模型调用能力

本次重构不是补几个字段，也不是把现有 `SlashCommand` 小修小补，而是把 command 模块从“interactive UI 附属能力”升级为“跨 interactive / ACP / non-interactive / model 的统一命令平台”。

---

## 2. 重写后的结论

Qwen 现有 command 系统的问题，不是完全没有能力，而是：

1. 只在 interactive 主路径上较完整
2. 类型模型太薄，无法承载 Claude 级别的产品面
3. ACP / non-interactive 依赖白名单，扩展性极差
4. command 来源虽然存在，但没有形成对用户可见的统一心智
5. prompt command 与模型 skill 暴露体系割裂

因此新的方案必须同时解决四件事：

1. **补齐 Claude Code 的能力面**
2. **保留 Qwen 统一 outcome 模型的工程优势**
3. **建立统一 registry / resolver / executor / adapter 架构**
4. **让帮助、补全、ACP available commands、文档共用同一套元数据**

---

## 3. 重构原则

### 3.1 功能对齐优先于实现对齐

允许不同：

- 内部类名
- 模块拆分方式
- 执行器实现
- effect / outcome 结构

不允许不同：

- 命令来源覆盖明显缩水
- 命令帮助和补全体验明显缩水
- ACP / non-interactive 可用性明显缩水
- prompt command 与模型能力融合明显缩水

如果出现取舍，优先级应为：

1. 用户体验对齐
2. 命令能力覆盖对齐
3. 模式一致性对齐
4. 内部实现简洁

### 3.2 保留 Qwen 的统一 outcome 模型

不建议机械复制 Claude 的执行实现。

Qwen 当前统一结果模型仍然值得保留，因为它天然适合：

- UI 接管
- 审批/确认
- tool 调度
- prompt 提交
- 跨模式适配

但它必须被升级为能够承载 Claude 级别的 command 能力，而不是继续作为简化版 UI 命令框架存在。

### 3.3 类型、来源、模式、可见性必须彻底解耦

新的 command 模型至少要把以下维度拆开：

1. **类型**：命令怎么执行
2. **来源**：命令从哪里来
3. **模式能力**：在哪些运行环境可用
4. **可见性**：对用户可见还是对模型可见

---

## 4. 需要对齐的 Claude Code 能力面

### 4.1 命令类型

Qwen 需要显式支持三类命令：

1. `prompt`
2. `local`
3. `local-jsx`

### 4.2 命令来源

Qwen 的 command schema 从第一阶段开始就必须覆盖以下来源：

1. built-in commands
2. bundled skills
3. skill dir commands
4. workflow commands
5. plugin commands
6. plugin skills
7. dynamic skills
8. mcp prompts
9. mcp skills

这里不能再退回到“先只支持当前已有那几类”。

### 4.3 命令元数据

至少补齐以下字段：

1. `argumentHint`
2. `whenToUse`
3. `examples`
4. `sourceLabel`
5. `userFacingName`
6. `alias`
7. `immediate`
8. `isSensitive`
9. `userInvocable`
10. `modelInvocable`
11. `supportedModes`
12. `requiresUi`

### 4.4 体验能力

至少补齐以下体验：

1. alias 命中补全
2. source badge
3. 参数提示
4. recently used 排序
5. mid-input slash command 检测与补全
6. 命令目录式 Help
7. ACP available commands 的完整表达

---

## 5. 新 command 模型

## 5.1 核心结构

建议引入统一 `CommandDescriptor`，作为所有命令的注册格式。

它至少包含四部分：

1. `identity`
2. `metadata`
3. `capabilities`
4. `handler`

### `identity`

- `id`
- `name`
- `altNames`
- `canonicalPath`

### `metadata`

- `description`
- `argumentHint`
- `whenToUse`
- `examples`
- `group`
- `source`
- `sourceLabel`
- `userFacingName`
- `hidden`

### `capabilities`

- `type`: `prompt | local | local-jsx`
- `supportedModes`: `interactive | acp | non_interactive`
- `requiresUi`
- `supportsDialog`
- `supportsStreaming`
- `supportsToolInvocation`
- `supportsConfirmation`
- `remoteSafe`
- `readOnly`
- `immediate`
- `isSensitive`
- `userInvocable`
- `modelInvocable`

### `handler`

- `resolveArgs()`
- `execute()`
- `completion()`
- `fallback()`

---

## 5.2 三种命令类型的职责

### `prompt`

用于：

- skills
- file commands
- workflow prompt commands
- plugin skills
- mcp prompt / skill

特点：

- 产生 prompt / skill 资产
- 默认支持 interactive / ACP / non-interactive
- 可以被用户调用，也可以被模型调用

### `local`

用于：

- 查询类命令
- 配置类命令
- headless 可执行的状态类命令
- 大多数 built-in commands 的核心执行入口

特点：

- 不依赖 UI
- 应成为 ACP / non-interactive 的主承载类型

### `local-jsx`

用于：

- picker
- 面板
- wizard
- interactive UI shell

特点：

- 只处理 interactive UI
- 不能再作为唯一执行入口
- 必须提供 fallback 或对应 local 子命令

---

## 6. 命令来源模型

## 6.1 外部来源模型

这是给用户看的来源模型，必须和 Claude Code 的心智尽量一致：

- `builtin-command`
- `bundled-skill`
- `skill-dir-command`
- `workflow-command`
- `plugin-command`
- `plugin-skill`
- `dynamic-skill`
- `builtin-plugin-skill`
- `mcp-prompt`
- `mcp-skill`

这组字段将直接用于：

- Help 分组
- Completion source badge
- ACP available commands
- 文档导出

## 6.2 内部归一化模型

为了不被外部命名绑死，内部再补一层实现字段：

- `providerType`
- `artifactType`
- `activationMode`
- `builtinProvided`
- `originPath`
- `namespace`

这样可以做到：

- 外部体验按 Claude 对齐
- 内部实现仍保持 Qwen 可维护性

## 6.3 冲突策略

统一按稳定 `id` 管理，展示名和输入名分离：

1. `id`：稳定唯一标识
2. `name`：输入主名
3. `userFacingName`：帮助/补全展示名

冲突优先级建议：

1. built-in
2. bundled / skill-dir / workflow
3. plugin / builtin-plugin
4. dynamic
5. mcp 独立 namespace

---

## 7. 统一执行架构

## 7.1 `CommandRegistry`

职责：

1. 聚合所有 loader/provider
2. 建立多维索引
3. 输出帮助、补全、ACP、文档视图
4. 提供用户可见命令和模型可见命令的独立视图

必须支持的 provider：

1. `BuiltinCommandLoader`
2. `BundledSkillLoader`
3. `FileCommandLoader`
4. `McpPromptLoader`
5. `WorkflowCommandLoader`
6. `PluginCommandLoader`
7. `PluginSkillLoader`
8. `DynamicSkillProvider`
9. `BuiltinPluginSkillLoader`

即便部分 provider 首期未完全落地，schema 和 API 也必须先支持。

## 7.2 `CommandResolver`

职责：

1. 解析 slash command
2. 解析 alias
3. 解析 subcommand path
4. 识别 mid-input slash token
5. 输出 canonical resolved command

## 7.3 `CommandExecutor`

职责：

1. 做 capability 检查
2. 执行 `prompt | local | local-jsx`
3. 统一产出 outcome
4. 处理 fallback / unsupported

## 7.4 `ModeAdapter`

必须拆出三种 adapter：

1. `InteractiveModeAdapter`
2. `AcpModeAdapter`
3. `NonInteractiveModeAdapter`

这样三种模式才能共用同一套 command registry 和 executor，而不是各自硬编码。

---

## 8. UI 命令重构原则：核心命令与交互壳分离

这是 ACP 和 non-interactive 真正可用的关键。

凡是当前本质为“打开 dialog”的命令，都必须改造成：

1. 一个 interactive shell
2. 一组 local 子命令

### 第一批必须拆分的命令

1. `/model`
2. `/permissions`
3. `/mcp`
4. `/resume`
5. `/hooks`
6. `/extensions`
7. `/agents`
8. `/approval-mode`

### 目标形态示例

#### `/model`

- `/model`
- `/model show`
- `/model list`
- `/model set <id>`

#### `/permissions`

- `/permissions`
- `/permissions show`
- `/permissions set <mode>`
- `/permissions allow <tool>`
- `/permissions deny <tool>`

#### `/mcp`

- `/mcp`
- `/mcp list`
- `/mcp show <server>`
- `/mcp enable <server>`
- `/mcp disable <server>`

---

## 9. Prompt Command / Skill 统一设计

这是重构里的 P0，不是后补能力。

## 9.1 目标

建立统一的 **Model-Invocable Prompt Command Registry**，把以下资产合并为一个模型可调用视图：

1. bundled skills
2. file commands
3. workflow prompt commands
4. plugin skills
5. mcp prompts / mcp skills

## 9.2 关键字段

必须新增：

1. `userInvocable`
2. `modelInvocable`
3. `allowedTools`
4. `whenToUse`
5. `argSchema` 或最小参数描述
6. `contextMode: inline | fork`
7. `agent`
8. `effort`

## 9.3 与 `SkillTool` 的关系

重构后不应再由 `SkillTool` 只消费狭义 skills。

应改成：

1. `CommandRegistry.getModelInvocablePromptCommands()` 产出统一视图
2. `SkillTool` 或未来统一 command tool 消费该视图
3. 用户 slash command 与模型 skill invocation 共用同一套 prompt-command 资产池

这样 Qwen 才能在体验上接近 Claude 对 `/review`、`/commit`、`/openspec-apply` 这类能力的处理方式。

---

## 10. Help / Completion / Discoverability 重做

## 10.1 Completion

补全项至少要展示：

1. `label`
2. `description`
3. `argumentHint`
4. `sourceBadge`
5. `modeBadges`
6. `aliasHit`
7. `recentlyUsedScore`

排序至少考虑：

1. 精确命中
2. alias 命中
3. 最近使用
4. prefix 命中
5. fuzzy 命中

## 10.2 Mid-input slash command

必须补齐：

1. 光标附近 slash token 检测
2. ghost text 提示
3. Tab 完成
4. 有效命令 token 高亮

第一阶段先对齐输入体验；是否引入更强的“内嵌命令执行语义”可在后续迭代。

## 10.3 Help

Help 不再是平铺列表，而是完整命令目录。

至少分组为：

1. Built-in Commands
2. Bundled Skills
3. Skill Dir Commands
4. Workflow Commands
5. Plugin Commands
6. Plugin Skills
7. Dynamic Skills
8. Builtin Plugin Skills
9. MCP Commands / MCP Skills

每条命令至少展示：

1. 名称
2. 参数提示
3. 描述
4. 来源
5. 支持模式
6. 是否模型可调用
7. 子命令摘要

---

## 11. ACP / Non-Interactive 重构

## 11.1 彻底废弃白名单思路

旧方案：

- built-in allowlist
- FILE / SKILL 特判
- 其它结果类型 unsupported

新方案：

- 每个命令自己声明 capability
- registry 负责过滤
- adapter 负责执行和 fallback

## 11.2 outcome 支持目标

### interactive

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `dialog`
- `load_history`
- `confirm_action`
- `confirm_shell_commands`

### acp

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `confirm_action`
- `confirm_shell_commands`
- `dialog fallback`

### non_interactive

- `submit_prompt`
- `message`
- `stream_messages`
- `tool`
- `confirm_action`
- `confirm_shell_commands`
- `dialog fallback / structured failure`

## 11.3 ACP available commands 输出

必须至少包含：

1. `name`
2. `description`
3. `argumentHint`
4. `source`
5. `examples`
6. `supportedModes`
7. `interactiveOnly`
8. `subcommands`
9. `modelInvocable`

---

## 12. 文档、帮助、补全共用同一份元数据

重构后以下内容必须由同一个 registry 视图导出：

1. Help
2. Completion
3. ACP available commands
4. 文档导出

这是为了解决当前“实现、帮助、文档三套命令面不一致”的问题。

---

## 13. 实施分期

## Phase 1：底座重建

交付：

1. 新 `CommandDescriptor`
2. 完整来源 schema
3. capability 模型
4. `userInvocable / modelInvocable`
5. `CommandRegistry`
6. `CommandResolver`
7. `CommandExecutor`
8. 三种 `ModeAdapter`
9. `getModelInvocablePromptCommands()`

## Phase 2：核心命令迁移

交付：

1. `/model`
2. `/permissions`
3. `/mcp`
4. `/resume`
5. `/hooks`
6. `/extensions`
7. `/agents`
8. `/approval-mode`

这些命令都必须完成“interactive shell + local 子命令”重构。

## Phase 3：模型能力打通

交付：

1. `SkillTool` 接入统一 registry 视图
2. file command / bundled skill / mcp prompt / plugin skill 进入统一 model-invocable 集合
3. prompt command 与 skill 资产彻底统一

## Phase 4：体验层对齐 Claude

交付：

1. recently used 排序
2. source badge
3. argument hint
4. mode badge
5. 完整 help 目录
6. mid-input slash command 体验
7. 文档自动导出或校验

---

## 14. 验收标准

完成后至少满足：

1. 帮助、补全、ACP、文档都能表达完整来源模型
2. 除纯 UI 壳命令外，大多数 built-in command 可在 ACP / non-interactive 使用
3. prompt command 与模型 skill 调用使用同一套资产池
4. 命令体验在帮助、补全、来源表达、参数提示、mid-input 体验上达到 Claude Code 95% 水平
5. 不再依赖 built-in allowlist 维持 ACP / non-interactive 命令能力

---

## 15. 最终判断

这次重构的本质不是“给现有 SlashCommand 多加几个字段”，而是：

- **用 Qwen 的内部架构风格，交付一个在外部体验上 95% 对齐 Claude Code 的 command 平台**

如果必须二选一：

- 内部实现更像 Claude
- 外部体验更像 Claude

本方案明确选择后者。
