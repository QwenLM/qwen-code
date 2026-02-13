# `/context` 命令 — 上下文窗口用量分解

## 概述

`/context` 命令展示当前模型上下文窗口的 token 使用情况。它将整个上下文窗口拆分为多个分类，帮助用户理解 token 花在了哪里，以及还剩多少空间。

## 上下文窗口的组成

一次 API 请求发送给模型的完整 prompt 包含以下部分：

```
┌─────────────────────────────────────────────┐
│             Context Window (总容量)           │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ System Prompt (系统提示词)            │    │
│  │  └─ 核心指令 + 行为规则              │    │
│  ├─────────────────────────────────────┤    │
│  │ Tool Declarations (工具声明)         │    │
│  │  ├─ Built-in tools (内置工具)       │    │
│  │  ├─ MCP tools (MCP 工具)            │    │
│  │  └─ SkillTool (技能工具) ◄──────────┼─── 包含所有 skill 的名称+描述
│  ├─────────────────────────────────────┤    │
│  │ Memory (用户记忆)                    │    │
│  │  └─ QWEN.md + extension configs    │    │
│  ├─────────────────────────────────────┤    │
│  │ Messages (对话消息)                  │    │
│  │  ├─ 用户消息                        │    │
│  │  ├─ 模型回复                        │    │
│  │  └─ 工具调用 & 工具结果 ◄───────────┼─── skill body 在此加载
│  ├─────────────────────────────────────┤    │
│  │ Free Space (可用空间)                │    │
│  ├─────────────────────────────────────┤    │
│  │ Autocompact Buffer (自动压缩缓冲)    │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

**不变量**：所有分类之和 = Context Window 总容量。

## 各分类详解

### 1. System Prompt（系统提示词）

| 属性         | 说明                                                               |
| ------------ | ------------------------------------------------------------------ |
| **数据来源** | `getCoreSystemPrompt(undefined, modelName)`                        |
| **包含内容** | 模型的核心行为指令、输出格式要求、安全规则等                       |
| **不包含**   | Memory 内容（单独计算）                                            |
| **计算方式** | 对系统提示词文本调用 `estimateTokens()`                            |
| **变化频率** | 基本固定，除非修改了 `QWEN_SYSTEM_MD` 环境变量或 `.qwen/system.md` |

> **注意**：`getCoreSystemPrompt` 接受 `userMemory` 参数，这里传入 `undefined` 以排除 memory，因为 memory 作为独立分类统计。

### 2. Built-in Tools（内置工具）

| 属性         | 说明                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| **数据来源** | `toolRegistry.getAllTools()` 中非 MCP、非 SkillTool 的工具                                            |
| **包含内容** | `read_file`、`edit`、`run_shell_command`、`grep_search`、`glob`、`list_directory` 等核心工具的 schema |
| **计算方式** | `allToolsTokens - skillsTokens - mcpToolsTotalTokens`                                                 |
| **详情列表** | 逐项展示每个内置工具的名称和 token 占用，按 token 数降序排列                                          |

> **SkillTool** 虽然也是内置工具，但因其内容动态性（嵌入所有 skill 列表），独立作为 **Skills** 分类展示，不在 Built-in tools 中出现。

### 2b. MCP Tools（MCP 工具）

| 属性         | 说明                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| **数据来源** | `toolRegistry.getAllTools()` 中 `DiscoveredMCPTool` 实例                |
| **包含内容** | 通过 MCP 协议连接的外部工具服务器提供的工具 schema                      |
| **计算方式** | 各 MCP 工具 `estimateTokens(JSON.stringify(tool.schema))` 之和          |
| **详情列表** | 逐项展示每个 MCP 工具的名称（`serverName__toolName` 格式）和 token 占用 |
| **条件显示** | 仅当存在 MCP 工具时才显示此分类行和详情                                 |

### 3. Skills（技能）⭐ 渐进式披露

Skills 采用**两阶段加载**设计：

| 阶段         | 加载内容                                       | Token 归属        | 何时加载                        |
| ------------ | ---------------------------------------------- | ----------------- | ------------------------------- |
| **第一阶段** | 每个 skill 的 name + 短 description + 使用说明 | **Skills 分类**   | 每次 API 请求都发送             |
| **第二阶段** | 完整的 SKILL.md body 内容（详细指令、模板等）  | **Messages 分类** | 模型调用 `skill` 工具后按需注入 |

**`/context` 中 Skills 分类展示的是第一阶段的常驻开销。**

#### 第一阶段的实现细节

SkillTool 在初始化时将所有 skill 信息嵌入其 `description` 字段：

```
Execute a skill within the main conversation

<skills_instructions>
... 使用说明（~600 字符）...
</skills_instructions>

<available_skills>
<skill>
<name>pdf</name>
<description>Convert PDF files to text (project)</description>
<location>project</location>
</skill>
<skill>
<name>xlsx</name>
<description>Process Excel spreadsheets (user)</description>
<location>user</location>
</skill>
...更多 skills...
</available_skills>
```

这整块文本是 SkillTool 的 tool declaration 的一部分，每次 API 请求都会发送。

#### Token 计算方式

```
skillsTokens = estimateTokens(JSON.stringify(skillTool.schema))
```

直接从 ToolRegistry 中获取 SkillTool 的完整 schema 进行估算，确保包含：

- 使用说明文本（`<skills_instructions>`）
- 所有 skill 的 XML 列表（`<available_skills>`）
- schema 参数定义

#### 第二阶段（按需加载）

当模型调用 `skill` 工具时，`SkillToolInvocation.execute()` 会加载完整的 SKILL.md：

```typescript
const skill = await this.skillManager.loadSkillForRuntime(this.params.skill);
const llmContent = `Base directory: ${baseDir}\n\n${skill.body}\n`;
```

这个 body 内容作为工具调用结果注入到对话中，token 开销归入 **Messages** 分类。

#### Skills 详情列表

每个 skill 的详情行展示该 skill 在第一阶段中的大致占用，按 token 数降序排列。注意：

- 各 skill 详情的 token 之和 **< Skills 分类总数**，差值是 skills_instructions 指令文本的开销
- 详情仅展示名称和描述的 token，不包含 schema 参数定义部分

### 4. Memory Files（用户记忆）

| 属性         | 说明                                                                       |
| ------------ | -------------------------------------------------------------------------- |
| **数据来源** | `config.getUserMemory()`                                                   |
| **包含内容** | `QWEN.md`、extension 配置、`output-language` 等用户级配置文件              |
| **加载位置** | 拼接到 System Prompt 末尾（通过 `getCoreSystemPrompt(userMemory, model)`） |
| **计算方式** | 解析 memory 文本中的 `--- Context from: <path> ---` 标记，分文件估算 token |

**Memory 内容格式**：

```
--- Context from: ~/.qwen/QWEN.md ---
用户自定义规则和偏好...
--- End of Context from: ~/.qwen/QWEN.md ---
--- Context from: ~/.qwen/extensions/config.md ---
扩展配置内容...
--- End of Context from: ~/.qwen/extensions/config.md ---
```

> **为什么 System Prompt 不包含 Memory？** 计算 System Prompt token 时传入 `userMemory = undefined`，Memory 作为独立分类展示，避免两个分类重叠。实际 API 请求中 memory 是拼接在 system prompt 末尾的。

### 5. Messages（对话消息）

| 属性         | 说明                                                             |
| ------------ | ---------------------------------------------------------------- |
| **数据来源** | 反推：`totalTokens - systemPrompt - allTools - memory`           |
| **包含内容** | 所有用户消息、模型回复、工具调用参数、工具返回结果               |
| **特别包含** | skill body（第二阶段按需加载的内容）、文件读取结果、shell 输出等 |
| **计算方式** | `max(0, apiTotalTokens - estimatedOverhead)`                     |

> **注意**：Messages 是通过 API 返回的 `totalTokens` 减去其他分类的估算值得出的，因此它吸收了估算误差。如果 overhead 被高估，Messages 会被相应低估。

### 6. Free Space（可用空间）

| 属性         | 说明                                                  |
| ------------ | ----------------------------------------------------- |
| **计算方式** | `contextWindowSize - totalTokens - autocompactBuffer` |
| **含义**     | 在触发自动压缩之前，还能容纳多少 token 的对话内容     |

### 7. Autocompact Buffer（自动压缩缓冲区）

| 属性         | 说明                                                              |
| ------------ | ----------------------------------------------------------------- |
| **计算方式** | `(1 - compressionThreshold) × contextWindowSize`                  |
| **默认值**   | `(1 - 0.7) × 131072 = 39322`（约 30% 的上下文窗口）               |
| **含义**     | 当 token 用量达到 70% 时触发自动压缩，这 30% 的空间作为缓冲区预留 |

## 两种展示模式

### 模式 A：无 API 数据（首次使用，尚未发送消息）

```
Context Usage

  No API response yet. Send a message to see actual usage.

  Estimated pre-conversation overhead
  Model: glm-5  Context window: 131.1k tokens

  █ System prompt         4.8k tokens (3.7%)
  █ System tools          5.2k tokens (4.0%)
  █ Memory files          845 tokens (0.6%)
  █ Skills                5.1k tokens (3.9%)
  ░ Free space            75.8k tokens (57.8%)
  ░ Autocompact buffer    39.3k tokens (30.0%)
```

- **不显示进度条和 total 数字**：避免估算值与后续 API 实际值产生不合理的对比
- **不显示 Messages 行**：尚无对话
- 各分类基于本地启发式估算（`estimateTokens`），可能与实际 API tokenizer 有 ~10% 偏差

### 模式 B：有 API 数据（已进行对话）

```
Context Usage

  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  glm-5
  25.3k/131.1k tokens (19.3%)

  Usage by category
  █ System prompt         4.5k tokens (3.4%)
  █ System tools          4.9k tokens (3.7%)
  █ Memory files          790 tokens (0.6%)
  █ Skills                4.8k tokens (3.7%)
  █ Messages              10.3k tokens (7.9%)
  ░ Free space            66.5k tokens (50.7%)
  ░ Autocompact buffer    39.3k tokens (30.0%)
```

- **`totalTokens` 来自 API 响应**（`usageMetadata.promptTokenCount`），是最准确的值
- **当本地估算 > API total 时**：按比例缩放各 overhead 分类，确保分类之和 = totalTokens
- **Messages** = `totalTokens - scaledOverhead`，包含所有对话内容 + 按需加载的 skill body

## Token 估算方法

由于无法直接访问模型的 tokenizer，使用基于字符的启发式估算：

```
tokens ≈ ⌈asciiChars / 4 + nonAsciiChars × 1.5⌉
```

| 字符类型                          | 比例            | 依据                             |
| --------------------------------- | --------------- | -------------------------------- |
| ASCII（英文、JSON 结构字符等）    | ~4 字符/token   | BPE tokenizer 对英文的平均压缩率 |
| 非 ASCII（中文、日文等 CJK 字符） | ~1.5 token/字符 | CJK 字符通常映射为 1-2 个 token  |

**已知局限**：

- 不同模型的 tokenizer 有差异，估算可能偏差 ±10-20%
- JSON 结构字符（`{`, `"`, `:` 等）的实际 token 化比率与自然语言不同
- 当估算偏高时，通过 `overheadScale` 按比例缩放校正

## 数据流图

```
                    ┌──────────────────┐
                    │   API Response   │
                    │ promptTokenCount │ ─── totalTokens (ground truth)
                    └──────────────────┘
                              │
   ┌──────────────────────────┼──────────────────────────┐
   │                          │                          │
   ▼                          ▼                          ▼
estimateTokens()      estimateTokens()          estimateTokens()
   │                          │                          │
   ▼                          ▼                          ▼
systemPromptTokens    allToolsTokens            memoryFilesTokens
                          │
                    ┌─────┴──────┐
                    │            │
                    ▼            ▼
        systemToolsTokens   skillsTokens
        (allTools - skills)  (from SkillTool schema)
                    │            │
                    └─────┬──────┘
                          │
                          ▼
                    rawOverhead = systemPrompt + allTools + memory
                          │
              ┌───────────┼───────────┐
              │ overheadScale         │ (= min(1, totalTokens/rawOverhead))
              ▼                       ▼
       scaled categories        messages = totalTokens - scaledOverhead
              │                       │
              └───────────┬───────────┘
                          ▼
                   breakdown output
```
