# 把主会话的 auto-memory 指南移入内置参考 skill

[English](2026-11-04-auto-memory-reference.md) | [简体中文](2026-11-04-auto-memory-reference.zh-CN.md)

**状态：** 实现 [#16291](https://github.com/QwenLM/qwen-code/issues/16291)，属于 [#12028](https://github.com/QwenLM/qwen-code/issues/12028) 和 [#12781](https://github.com/QwenLM/qwen-code/issues/12781)。复用 [#12323](https://github.com/QwenLM/qwen-code/pull/12323) 与 [#11013](https://github.com/QwenLM/qwen-code/issues/11013) 的内置参考路由。

## 1. 问题

默认配置下（`memory.enableManagedAutoMemory: true`），主会话的 system prompt 在每个界面的每次请求里都带着 `# auto memory` 段，界面包括 Ink、OpenTUI、headless 与 SDK、ACP，子 agent 也会继承。在 main 上（2026-11-04）抓取一次 `qwen -p` 请求：system prompt 共 35,792 字符，这一段占 16,140 字符（45%），其中 `## Types of memory` 一节就有 7,939 字符。

主模型自己写 memory 的轮次很少，大多是用户明确要求记住或忘掉某件事的时候；其余 memory 由后台抽取 agent 用它自己的 prompt 写入。所以详细的类型说明和示例只在这少数几轮用得上，费用却由每一次请求承担。

## 2. 移走了什么，保留了什么

主会话现在使用 `buildResidentAutoMemoryPrompt`（`memory/prompt.ts`）生成的**常驻策略**。它保留会话不加载任何东西也能正确保存和使用 memory 所需的内容：

- catalog 说明，以及 USER、PROJECT 目录（开启 team memory 时还有 TEAM）；
- 用户要求记住或忘掉时立即处理；
- 四种类型各一行，附上决定目录的 scope，以及 **Why:** / **How to apply:** 正文规则；
- 开启 team memory 时：TEAM 的路由、禁止把密钥存入 TEAM，以及 team 索引是自动生成的；
- 不保存哪些内容（一句话），并说明即使用户要求也不例外；
- 保存的两个步骤、原样的 frontmatter 模板，以及 category 名称；
- 去重，删除错误的 memory；
- 何时读取 memory、遵守“不要用 memory”的要求，以及依赖某条 memory 或推荐它提到的文件、函数、flag 之前先核实当前状态；
- 一个指向 `auto-memory` skill 的指针。

**内置 `auto-memory` skill**（`skills/bundled/auto-memory/SKILL.md`）收录以下常量的全文：

- `TYPES_SECTION_INDIVIDUAL`，包括全部示例；
- `MEMORY_CATEGORY_SECTION`、`WHAT_NOT_TO_SAVE_SECTION` 和 `WHEN_TO_ACCESS_SECTION`；
- `MEMORY_WRITING_RULES`，即 keyword、usage_scenario 与正文长度规则，连同 `MEMORY_METADATA_ITEM_BOUNDS`；
- `TEAM_SCOPE_SECTION`、`TRUSTING_RECALL_SECTION` 和 `MEMORY_PERSISTENCE_SECTION`。

这些常量仍是唯一来源，因为其他 prompt 也由它们生成：

- 抽取、Dream、User Dream、`/remember` 和导入 agent 依旧用完整常量构建自己的 prompt。
- `buildManagedAutoMemoryPrompt` 在所有参数组合下的输出逐字节不变。这次重构只是把 `TEAM_SCOPE_SECTION`、`MEMORY_WRITING_RULES` 和 `MEMORY_PERSISTENCE_SECTION` 提取为常量。
- `SKILL.test.ts` 断言每个常量的每一行都在 skill 里，参考内容因此不会与这些 agent 收到的内容脱节。
- 它还断言每个移走的锚点都不出现在常驻策略和 skill 的 frontmatter 中，每个保留的锚点都出现在常驻策略中。

## 3. 路由如何决定

`MainSessionAutoMemoryPolicy`（`skills/auto-memory-skill.ts`）调用 `resolveBundledReferenceRoute`，与 Workflow、Agent 工具用的是同一个解析器：

| 路由                                                                    | 主会话策略                           |
| ----------------------------------------------------------------------- | ------------------------------------ |
| `skill`                                                                 | 常驻策略 + 指针                      |
| `skill-via-tool-search`                                                 | 常驻策略 + 指针 + tool_search 桥接句 |
| `inline`（没有任何途径加载 skill）                                      | 完整策略，与改动前相同               |
| `withheld`（`skills.disabled` 列出 `auto-memory`，或关闭了 bundled 层） | 只有常驻策略                         |

这里按路由决定，而不是按工具描述使用的 surface 决定。那个 surface 在参考文件读不到时会退回为指针，但完整策略并不需要这个文件。

**何时决定路由。** 刷新时只保存策略的输入，`Config.getAutoMemoryPrompt()` 每次被读取时，按读取它的那个 Config 解析路由；每种路由的文本只构建一次。需要这样做的情况有三种：

- 第一次刷新运行在会话启动时，早于工具注册表的创建，看不到 Skill 工具。
- 子 agent 通过从会话 Config 派生出的 Config 读取策略。工具策略里没有 `skill` 的子 agent 不持有 skill manager（[#12424](https://github.com/QwenLM/qwen-code/issues/12424)），所以它的路由是 `inline`，拿到完整策略。
- 两次刷新之间 Skill 工具可能变得不可用，例如通过 `tools.disabled`；下一次请求就会跟上。

**列表。** 只有开启 managed auto-memory 且召回处于 legacy 模式时才列出这个 skill。否则 `Config.isSkillEnabled` 会把它隐藏；`SkillManager` 在列表和按名加载时都使用这个开关，与 `generated-ui` 的处理方式一样。daemon 的 skills 目录根据工作区设置回答同一个问题。

**审批。** 写入私有 memory 目录不需要审批，所以加载这个参考也不能需要，否则每次保存都会先弹一次确认。Skill 工具默认会询问；当名字解析到 bundled 的 `auto-memory` 时直接放行，它是只读文本，没有 `allowedTools`，也没有 hooks。同名的项目、用户或扩展 skill 优先级更高，加载它们仍会询问；权限规则照常在此之上生效。

## 4. 实测效果

长度单位为字符，使用常见路径（`/home/alice/.qwen/memories` 与 `/home/alice/.qwen/projects/-home-alice-work-app/memory`）：

| 形态                         | 未开 team | 开启 team |
| ---------------------------- | --------- | --------- |
| 改动前（完整策略）           | 15,868    | 17,243    |
| 指针路由                     | 4,686     | 5,470     |
| 经 tool_search 的指针        | 4,804     | 5,588     |
| withheld                     | 4,451     | 5,235     |
| inline（没有途径加载 skill） | 15,868    | 17,243    |

默认会话**每次请求减少 11,182 字符（约 2.8k tokens）**。

列表上的代价很小：

- 这个 skill 在 `<available_skills>` 中增加一个 233 字符的条目。
- 为此 `BUNDLED_LISTING_BUDGET` 从 6,800 调到 7,050，原因记录在 `bundled-skills.integration.test.ts` 中。

一旦加载了 skill，它的正文（约 14.6k 字符）会一直留在该会话的历史里，直到压缩。只有保存或整理 memory 的会话才承担这部分。

## 5. 风险

- **元数据变弱。** 不加载 skill 就保存时，keyword 可能选得差一些，正文结构也可能松散一些。有三点限制了这一影响：
  - 常驻策略保留了 frontmatter 模板、category 名称和正文规则。
  - 写入校验的提示信息仍会引用 `MEMORY_METADATA_ITEM_BOUNDS`。
  - 后台抽取和 Dream 仍按完整规则工作。
- **结构化召回。** 与结构化召回（[#12947](https://github.com/QwenLM/qwen-code/issues/12947)）互不影响，它的 prompt 本来就很短。本改动只涉及默认的 legacy 路径，结构化召回下也不会列出这个 skill。

## 6. 验证

- **单元测试：**
  - `skills/bundled/auto-memory/SKILL.test.ts`：skill 包含每个常量的每一行，以及双向锚点；
  - `skills/auto-memory-skill.test.ts`：四种路由、读取方 Config 的路由，以及体积预算；
  - `config/config.test.ts`：各路由下的策略、没有 Skill 工具的注册表、没有 skill manager 的派生 Config，以及列表开关；
  - `tools/skill.test.ts`：加载 bundled 参考无需询问，被同名 skill 覆盖时仍会询问；
  - `memory/prompt.test.ts` 与 `skills/bundled-skills.integration.test.ts`。
- **逐字节一致：** `buildManagedAutoMemoryPrompt` 的输出在五种参数组合下与 merge base 对比，全部一致。
- **行为：** 用真实模型在九个场景下做改动前后对比。场景覆盖：保存到正确的层级且元数据合法、绝对日期、reference、拒绝保存可推导的内容、更新而非重复、忘掉、对照代码核实过时的 memory、遵守“不要用 memory”，以及一个既不应加载 skill、也不应写 memory 的无关任务。结果写在 PR 中。
