# 按常驻工具集装配系统提示词

[English](2026-09-18-resident-tool-prompt-assembly.md) | [简体中文](2026-09-18-resident-tool-prompt-assembly.zh-CN.md)

**状态：** [#12032](https://github.com/QwenLM/qwen-code/issues/12032) 的方案稿，属于 [#12028](https://github.com/QwenLM/qwen-code/issues/12028)。仅包含第一步（会话开始时装配）；第二步只作为后续工作点明，不在本文提案范围内。

文中所有代码引用均读自 `main` 的 `8bd2feabba`。本文档未构建、未运行、未实测任何内容；标注来自 #12032 的 token 数字是该 issue 自己的实测值，本文未重新测量。

## 1. 问题

系统提示词对工具的描述来自静态的 `ToolNames` 常量和布尔配置开关，与请求实际声明了哪些工具无关。`getToolGuidanceSection`（`packages/core/src/core/prompts.ts:299`）把工具名插值进策略条目，四个 `# Examples` 段落则是 `[tool_call: …]` 形式的记录（该文件中 `tool_call:` 共出现 21 次）。而"声明了哪些工具"是在另一处决定的——`ToolRegistry.getFunctionDeclarations`（`packages/core/src/tools/tool-registry.ts:850`）——只要部署设置了 `tools.eager`、添加了整工具的 `permissions.deny` 规则，或某个工具仍延迟在 ToolSearch 之后，这个集合就会收缩。

由此产生两个后果，按重要性排序：

1. **正确性。** 提示词会指引模型优先使用它并没有拿到的工具。一个把 `glob` 降级了的会话，提示词里仍写着"文件搜索：使用 glob（不要用 find 或 ls）"，而模型发现这一矛盾的唯一途径是调用失败或多走一轮 ToolSearch。
2. **Token。** 据 #12032，基础提示词中约 7.3 KB 与具体工具结构性绑定（`## Using Your Tools` 约 4,031 字符，其中约 66% 的行点名具体工具；`# Examples` 3,283 字符，全部是工具调用记录）。即使这些工具并不存在，这些文本依然常驻。

对**默认**会话而言所有工具都常驻，因此 token 节省恰好为零。收益只存在于已经裁剪过工具集的部署——所以真正值得投入的是正确性那一半，这也是本单尽管有 P0 下游依赖却仍标为 `priority/P3` 的原因。

## 2. 现状

在 `8bd2feabba` 上核实：

| 事实                                                                                                                                                            | 位置                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基础提示词已按开关做条件装配：`keepCodingInstructions === false` 精确删掉软件工程段落；`todoWriteEnabled` 门控它自己的条目；`codeModeOnly` 整体替换工具指引正文 | `prompts.ts:359`（`buildDefaultBasePrompt`）、`:271`、`:299`                                                                                                               |
| 安全与危险操作指引无条件生成，且保持如此                                                                                                                        | `prompts.ts:733`（`getActionsSection`）                                                                                                                                    |
| 按模型选择的工具调用示例                                                                                                                                        | `prompts.ts:1375`（`getToolCallExamples`）                                                                                                                                 |
| 提示词入口函数，7 个位置参数，并从包根再导出（`export * from './core/prompts.js'`）                                                                             | `prompts.ts:577`、`packages/core/src/index.ts:99`                                                                                                                          |
| `getCoreSystemPrompt` 的非测试调用点：两处                                                                                                                      | `client.ts:403`（位于 `getMainSessionBaseSystemPrompt` 内，`client.ts:397`，其配置形态为 `MainSessionPromptConfig`，`client.ts:380`）、`agents/arena/ArenaManager.ts:1108` |
| "模型拿到了什么"的唯一收敛点                                                                                                                                    | `tool-registry.ts:850`                                                                                                                                                     |
| 会话开始时的顺序本身有利：预热 → 预加载 → 生成提示词 → 声明工具                                                                                                 | `client.ts:2303`、`:2326`、`:2348`、`:2410`                                                                                                                                |
| 缓存前缀在构建系统指令时记录，每次请求读取；Anthropic 转换器只在系统文本仍以该前缀开头时才切分缓存块                                                            | `client.ts:1672`（来自 `:1652`）、`anthropicContentGenerator.ts:772`                                                                                                       |
| 会话中途的声明变更走 `setTools`，它完全不碰提示词；`refreshSystemInstruction` 虽然存在，但被 7 个非测试文件因其他原因调用                                       | `client.ts:1205`、`:1754`                                                                                                                                                  |
| 子 agent 走另一条路径，不受本改动影响                                                                                                                           | `agent-core.ts:796`、`:844`（`includeDeferred: true`）、`:714`（`isHiddenByEagerAllowList`）                                                                               |

提示词中有三处引用**不是**从 `ToolNames` 插值而来，因此不先改动其文本就无法门控：

- `subagent_type=Explore`（`prompts.ts:328`、`:348`）—— 子 agent 的可用性由 subagent manager 数据驱动，不由工具注册表决定。
- 散文中裸写的 `read_file`：四个示例（`:901`、`:1152`、`:1270`、`:1355`）、persisted-output 条目（`:420`）、以及 plan mode 提醒（`:1480`，属于每轮提醒而非基础提示词）。
- 示例中的 `GlobTool` 展示名（`:913`、`:1185`、`:1288`、`:1367`）。

任何此类改动都会牵动的测试面：17 份完整提示词快照（`core/__snapshots__/prompts.test.ts.snap`），以及 `prompt-tool-examples.test.ts:99`——它断言示例中出现的工具名集合恰好等于其 validator 的键集合，只要任一示例变成条件生成，该断言即失败。条件段落断言的现成先例是 `prompts.test.ts:1248`。

## 3. 目标与非目标

**目标。** 基础提示词只描述会话实际声明的工具。`/context` 与真实请求对这个集合的认知一致。提示词缓存前缀的重写频率不高于现状。安全、权限与危险操作文本保持无条件生成。

**非目标。** 会话中途每次揭示都重新生成提示词（第二步，且与 [#11321](https://github.com/QwenLM/qwen-code/issues/11321) 重叠）。子 agent 的提示词。新增面向用户的配置项。修改安全文本。压缩单个工具的描述（[#12054](https://github.com/QwenLM/qwen-code/issues/12054)）。门控 skill 清单或记忆文件（[#12030](https://github.com/QwenLM/qwen-code/issues/12030)）。

## 4. 方案

### 4.1 每个会话只解析一次声明集合

在 `startChat` 中，`warmAll()` 与预算预加载之后、构建系统指令之前（位于 `client.ts:2326` 与 `:2348` 之间），从 `getFunctionDeclarations()` 收集声明的工具名，存为 `ReadonlySet<string>`，并作为"提示词依据的快照"记录到 `Config` 上。提示词构建器接收这个集合，它永远看不到注册表。

记录快照而不是在每次读取时从注册表重算，正是让 `/context` 如实反映现状的关键：会话中途一次 ToolSearch 揭示之后，实时注册表与提示词确实不一致，而 `/context` 必须报告提示词里有什么，而不是注册表现在有什么。当尚不存在快照时（在任何 `startChat` 之前构建提示词的调用方，包括 `ArenaManager`），构建器回退到现有行为，输出全部段落。

### 4.2 API 形态

`getCoreSystemPrompt` 从包根再导出，并在两个非测试调用点以位置参数调用，其参数个数还在 `client.test.ts` 与 `contextCommand.test.ts` 中被断言。新增第 8 个位置参数会打破这些断言以及所有外部调用方的预期，因此新输入以尾部选项对象的形式传入：

```ts
getCoreSystemPrompt(
  userMemory?: string,
  model?: string,
  appendInstruction?: string,
  interactionMode?: SystemPromptInteractionMode,
  outputStyle?: OutputStyleDefinition | null,
  todoWriteEnabled?: boolean,
  codeModeOnly?: boolean,
  options?: { declaredTools?: ReadonlySet<string> },
): string;
```

`declaredTools === undefined` 表示"假定所有工具都已声明"，输出与现状完全一致。`MainSessionPromptConfig`（`client.ts:380`）不增加 `getToolRegistry`：传入已解析的集合可以让 `prompts.ts` 与工具内部实现解耦，而一个能触达注册表的 `Pick<Config, …>` 还会把预热契约拖给每一个构建提示词的调用方。

### 4.3 各段落的门控规则

| 段落                                                                           | 规则                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## Using Your Tools` 各条目                                                   | 只有条目点名的工具在声明集合中时才输出。点名多个工具的条目保留其中存在的，全部不存在时删除整句。                                                                       |
| `# Examples` 记录                                                              | 只有示例调用的每个工具都已声明时才输出。始终至少保留一个示例；当所选模型的示例被全部过滤掉时，提示词保留通用集合中最短的那个，只有这一步也不可行时才回退为不输出示例。 |
| `## Software Engineering Tasks`、语气、沟通                                    | 不变；已由开关门控。                                                                                                                                                   |
| `getActionsSection`、安全规则、Core Mandates                                   | 无条件生成。危险操作或被拒调用类条款绝不能取决于声明了哪些工具。                                                                                                       |
| 散文中裸写的工具名（`:420`、`:901`、`:1152`、`:1270`、`:1355`、`:913` 及同类） | 在同一改动中转为 `ToolNames` 插值，使其参与门控；展示名处改用该工具的展示名常量。                                                                                      |
| `subagent_type=Explore`                                                        | 第一步保持无条件。子 agent 可用性不是注册表状态，门控它需要 subagent manager，属于待决问题（§9）。                                                                     |

### 4.4 提示词缓存

提示词只依赖会话开始时的快照，因此 `setStaticSystemPrefix`（`client.ts:1672`）的重写频率与现状完全相同——每次构建系统指令一次——会话中途的揭示仍然只改变 tools 块。这是明确的设计约束，不是备注：把 `refreshSystemInstruction` 接到各揭示点上，会在每次 ToolSearch 加载时重写全局缓存块，并且与 [#12029](https://github.com/QwenLM/qwen-code/issues/12029) 相互拉扯——后者的全部目的正是让延迟加载（从而让揭示）在大窗口下真正发生。#12029 应引用本约束，使最终的缓存行为是被选择的，而不是被动继承的。

### 4.5 `/context`

`collectContextData` 通过 `getMainSessionBaseSystemPrompt` 构建提示词、并另外读取声明列表，且它不预热注册表。因此它读取同一份快照，使其系统提示词一行与真实请求保持一致。本改动叠加在 [#12119](https://github.com/QwenLM/qwen-code/pull/12119)（#12033）的分类重构之上，后者的数字正是 §7 的度量工具。

## 5. 设计决策

| 决策                               | 理由                                                                      | 被否决的替代方案                                    |
| ---------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------- |
| 仅会话开始时装配                   | 无缓存回退、无需给约 15 个变更点接线，且 `startChat` 中的顺序已使其良定义 | 按揭示重新生成——属第二步，且需先实测                |
| 传入已解析的 `ReadonlySet<string>` | 让 `prompts.ts` 不与注册表耦合，也不承担预热契约                          | 给 `MainSessionPromptConfig` 增加 `getToolRegistry` |
| 尾部选项对象                       | 保留 7 参数的公开签名与参数个数断言                                       | 新增第 8 个位置参数                                 |
| 把快照记录在 `Config` 上           | `/context` 必须报告提示词的内容，而非注册表当前的内容                     | 每次读取时从注册表重算                              |
| 无快照即视为"全部已声明"           | 使 `ArenaManager` 及任何外部调用方的输出逐字节不变                        | 要求每个调用方都传入集合                            |
| 安全段落保持无条件                 | 被拒调用与危险操作类条款与工具可用性无关                                  | 为一致性而一并门控                                  |

## 6. 约束与风险

- **测试快照大面积变动。** 除非 fixture 固定一份声明集合，17 份完整提示词快照都会重新生成。fixture 必须固定一份，否则这些快照就测不出门控行为。
- **`prompt-tool-examples.test.ts:99` 会按设计失败。** 它对"示例中的工具名"与"validator 键"的完全相等断言，需改为"针对该声明集合渲染出的示例恰好使用这些 validator"。
- **误删某个确实已声明工具的指引会是回归**，而今天没有任何 CI 测试能发现它。§7 增加了堵住这一点的不变量测试。
- **core 门禁。** 改动落在 `packages/core/src/core/**`，按 core 门禁的 100% 信心标准评审；`feat` 类若生产逻辑达 500+ 行会升级到 maintainer 知会。
- **不存在召回率测试设施。** 仓库没有 `evals/` 目录，唯一的 agent 任务测试台（`integration-tests/terminal-bench`）仅供手动运行，因此"模型仍然选对工具"无法在 CI 中断言。缓解方式在于第一步只删除关于模型并未拿到的工具的文本。

## 7. 验证计划

1. **默认会话回归：** 没有快照、或快照包含全部已注册工具时，渲染出的提示词与现状逐字节一致。这是让改动对常见场景安全的守卫。
2. **裁剪会话快照：** 为以下三种情况建 fixture：(a) 只有七个文件工作类工具；(b) `codeModeOnly`；(c) 缺少 `glob` 与 `grep_search` 的集合。断言对应的条目与示例消失，且其他内容不变。
3. **不变量测试：** 扫描渲染后的提示词中出现的每个 `ToolNames` 取值，断言找到的每个名字都在声明集合中。这个测试同时能抓住门控过度与门控不足。
4. **`/context` 一致性：** 断言 `/context` 度量的提示词与聊天实际使用的来自同一份快照。
5. **Token 度量：** 在设置了裁剪版 `tools.eager` 白名单的会话上，对比改动前后的系统提示词一行，以 provider 的 `input_token_count` 作为基准（分类标尺本身正在 #12119 中修复）。实测差值在 PR 中报告，不在本文预测。

## 8. 验收标准

- 默认会话的基础提示词逐字节不变。
- 裁剪过的会话中，没有任何条目或示例点名未声明的工具，且每个已声明工具的策略文本仍然存在。
- 所有配置下安全、权限与危险操作文本均存在。
- `setStaticSystemPrefix` 的写入频率不高于本改动之前。
- `/context` 的系统提示词一行与请求的系统指令来自同一份快照。
- 后续任何新决策都同步更新本设计的中英两个版本。

## 9. 待决问题

1. **`subagent_type=Explore`：** 按子 agent 可用性门控（需要 subagent manager，而非注册表），还是保持无条件？第一步保持无条件。
2. **示例下限：** "始终至少保留一个示例"是否合适？对裁剪很彻底的部署，完全没有 `# Examples` 段落是否可以接受？
3. **子 agent 的提示词**仍与今天一样不一致。这应作为 #12028 下的后续 issue，还是明确接受现状？
4. **`ArenaManager`** 为拥有各自独立注册表的 agent 构建提示词。是否应在后续改动中让它传入每个 agent 自己的声明集合？
5. **与 #12029 的先后顺序：** 如果 #12029 先落地、延迟加载在大窗口下开始生效，对 MCP 工具很多的部署，§4.4 的约束是否仍然成立，还是第二步会更早变得必要？
