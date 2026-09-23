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

| 段落                                                                           | 规则                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## Using Your Tools` 各条目                                                   | 只有条目点名的**每一个**工具都已声明时才保留——若仍保留一个点名了缺失工具的条目，就会指引模型去调用它拿不到的东西，而这正是本改动要修的缺陷。子条目按它点名的那一个工具判断；当"优先使用专用工具"的全部子条目都被删除时，该父条目也一并删除。                                                                                                                                     |
| `# Examples` 记录                                                              | 只有 `<example>` 块调用的每个工具都已声明时才保留。按 `<example>`/`</example>` 成对匹配，而不是按空行切分：示例内部本身可能含空行，按空行切会让它后续段落里的工具调用脱离门控它的标签（实现过程中被测试抓到）。现存的每个块都至少调用一个工具，因此都可能被门控；没有块存活时 `# Examples` 标题随整段省略；模型特定的 XML 与 JSON 格式不使用 `[tool_call: …]` 记法，因此不门控。 |
| `## Software Engineering Tasks`、语气、沟通                                    | 不变；已由开关门控。                                                                                                                                                                                                                                                                                                                                                             |
| `getActionsSection`、安全规则、Core Mandates                                   | 无条件生成。危险操作或被拒调用类条款绝不能取决于声明了哪些工具。                                                                                                                                                                                                                                                                                                                 |
| 散文中裸写的工具名（`:420`、`:901`、`:1152`、`:1270`、`:1355`、`:913` 及同类） | 第一步不改写。示例中裸写的 `read_file` 随包裹它的块一起被门控。persisted-output 条目（`:420`）与 plan mode 提醒（`:1480`）仍无条件点名 `read_file`——这是已知残留，记录在 §6。`GlobTool` 一处保持原文：`ToolDisplayNames.GLOB` 的值是 `Glob`，插值该常量会改变默认提示词，破坏逐字节不变的守卫。                                                                                  |
| `subagent_type=Explore`                                                        | 第一步保持无条件。子 agent 可用性不是注册表状态，门控它需要 subagent manager，属于待决问题（§9）。                                                                                                                                                                                                                                                                               |

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
- **`prompt-tool-examples.test.ts:99` 仍然通过。** 它渲染的是未门控的提示词，因此"示例中的工具名恰好等于 validator 键"这一完全相等断言不受影响。只有当门控从可选变为默认时，它才需要改写。
- **被门控段落内 `ask_user_question` 不门控。** 点名它的那条交互模式条目同时承载"headless 运行中不得向用户提问"的策略，门控整条会把真实约束一起删掉。该工具豁免于 `tools.eager`，实际总是声明；只有 `permissions.deny` 能移除它，而那种配置下仍会读到这条。§7 的穷举测试恰好只排除这一个名字。
- **两处散文引用仍未门控。** persisted-output 条目（`prompts.ts:420`）与 plan mode 提醒（`:1480`）在 `## Using Your Tools` 之外点名 `read_file`，因此未声明该工具的会话仍会读到它们。这是既有行为而非本改动引入的回归，也是 §7 的不变量测试只覆盖被门控段落的原因。
- **误删某个确实已声明工具的指引会是回归**，而今天没有任何 CI 测试能发现它。§7 增加了堵住这一点的不变量测试。
- **core 门禁。** 改动落在 `packages/core/src/core/**`，按 core 门禁的 100% 信心标准评审；`feat` 类若生产逻辑达 500+ 行会升级到 maintainer 知会。
- **不存在召回率测试设施。** 仓库没有 `evals/` 目录，唯一的 agent 任务测试台（`integration-tests/terminal-bench`）仅供手动运行，因此"模型仍然选对工具"无法在 CI 中断言。缓解方式在于第一步只删除关于模型并未拿到的工具的文本。

## 7. 验证计划

第 1-4 项已在本 PR 的 `prompts.test.ts` 中自动化，每次推送都会重新检查；第 5 项需要真实会话，交接文档为 [`docs/verification/resident-tool-prompt-assembly/README.md`](../verification/resident-tool-prompt-assembly/README.md)。

1. **默认会话回归（已在 CI）。** 现有 17 份完整提示词快照覆盖"无快照"路径，`renders identically when every tool is declared` 覆盖"全部声明"路径。两者共同构成让改动对常见场景安全的守卫。
2. **效果，以及效果之外不漂移（已在 CI）。** 两条测试夹住节省量：文件七件套白名单必须减少 900-1,400 字符（实测 1,104，约 276 token——只有策略条目，因为该白名单保留了全部示例），更窄的白名单必须减少 3,800-5,000 字符（实测 4,327，约 1,082 token，含三个示例块）。第三条断言四种按模型选择的示例写法都被门控，而不只是方括号写法。三者合起来能在收益丢失与新增未门控工具文案时失败。`changes nothing outside the two gated sections` 从两次渲染中剥掉 `## Using Your Tools` 与 `# Examples`，断言其余部分完全相同。
3. **不变量，双向（已在 CI）。** `never names an undeclared tool inside the gated sections` 以词边界匹配把每个 `ToolNames` 取值扫一遍被门控文本；`gates every tool name the gated sections can mention, on every example set` 把它变成与配置无关的检查——逐个withhold 全部 66 个名字、对四套示例模板各跑一遍，这正是能抓住"按模型选择的写法未被门控"的那条。`keeps the policy text of every tool that is declared` 钉住相反方向，防止门控过度。之所以限定这两段，是因为 §6 中的那些残留。
4. **反向检查与接线（已在 CI）。** `leaves CodeModeOnly guidance untouched by the declared set` 断言 code mode 在有无快照时渲染完全一致；`takes the declared set from the Config snapshot` 断言 `getMainSessionBaseSystemPrompt` 确实读取 `Config.getPromptToolSnapshot()`——这正是让 `/context` 与真实请求同源的性质。
5. **Token 度量（已交接）。** 在设置了裁剪版 `tools.eager` 白名单的会话上，对比改动前后的系统提示词一行，以 provider 的 `input_token_count` 为基准（分类标尺本身正在 #12119 中修复）。交接文档还包含把本改动与 `tools.eager` 自身收益分离的三档跑法，以及在仓库缺少 eval 设施下只能做的弱化召回验证。

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
