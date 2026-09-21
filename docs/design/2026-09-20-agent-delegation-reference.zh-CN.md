# 把 Agent 工具的提示词写法指南移入内置参考 skill

[English](2026-09-20-agent-delegation-reference.md) | [简体中文](2026-09-20-agent-delegation-reference.zh-CN.md)

**状态：** 实现 [#12054](https://github.com/QwenLM/qwen-code/issues/12054) 四项验收条件中的一项——给 Agent 描述加上体积预算，且只覆盖 `agent`；其余三项仍让该 issue 开着，PR 正文写的是 `Part of` 而不是 `Closes`。属于 [#12028](https://github.com/QwenLM/qwen-code/issues/12028)。建立在 [#12142](https://github.com/QwenLM/qwen-code/pull/12142) 的 Agent/Shell 体积预算之上（已合入，`36887c49`），并把其中几条预算下调。

下文所有数字都是实测得到的，不是纸面渲染：构造真实的 `AgentTool` 并读取它装配完成的 `description`，代入预算测试所用的两个 subagent 条目、team 关、todo 开。"改动前"那一列用的是同一套量法，只把两个被改的源文件回退到 merge base，因此只有一个变量在动。本地在 Linux 上跑过——构建 `packages/core`，然后三个受影响文件共 98 个测试、内置 skill 集成文件 20 个测试全部通过，§3 的每一行都由构造出来的工具复现。macOS 与 Windows 的单测任务在本 PR 上被 CI `skipped`、并非绿色，所以没有自动化覆盖它们；这次改动是与平台无关的字符串与模块工作，而 `Desktop Shell (windows-2022)` 确实会跑。token 数按字符数 ÷ 4 折算，与 issue 中的口径一致。

## 1. 问题

Agent 工具的描述是请求里最长的内置工具描述，而它在**每个**会话的**每一次**请求中都会发送，无论这一轮是否真的要委派任务。其中约四分之一是"怎么写委派提示词"的手艺建议：给多少上下文、什么不该委派、fork 提示词长什么样，以及一个 `test-runner` 的完整示例。一个只读文件然后回答问题的轮次，也要为这些内容付费。

Workflow 工具此前是同样的形状，并在 [#11013](https://github.com/QwenLM/qwen-code/issues/11013) 中解决：编写参考变成内置 skill `workflow-authoring`，描述里只留一个指针。本次复用这套机制，而不是另造一套。

## 2. 搬走了什么，以及刻意留下了什么

搬入 `packages/core/src/skills/bundled/agent-delegation/SKILL.md`：

- `## Writing the prompt` 整节（"像对聪明同事交代"那段、五条要点、"Terse command-style prompts…"，以及 **Never delegate understanding**）；
- `**Writing a fork prompt.**` 那一段；
- `Usage notes:` 里的两条手艺条目——"Provide clear, detailed prompts…" 与 "Clearly tell the agent whether you expect it to write code or just to do research…"；
- `<example_agent_descriptions>` / `isPrime` / `test-runner` 的完整示例。

刻意留在描述里的部分，因为一个从不加载该 skill 的会话也必须把它们做对：

- 什么时候**不该**用这个工具，以及"复用已有后台 agent"的规则；
- `## Working with background agents` 整节——**Don't peek**、**Don't race**、**Don't relaunch**；
- `## When to fork` 里决定调用形状的事实：fork 默认继承完整对话、`fork_turns` 限定范围、必须显式给 `subagent_type`、fork 上不要设 `model`、要传一个简短的 `name`；
- 并发与写入范围规则、`isolation`/`working_dir` 语义，以及"把 agent 的输出当证据看"。

这条分界线本身就是测试对象，而不是一句注释：`SKILL.test.ts` 对每个搬走的锚点同时断言"**在** skill 里"和"**不在**可加载 skill 的会话所发送的描述里"，对每个保留的锚点则反向断言。只做一半，都会让指南悄悄消失或被粘回来，而测试全绿。

文本是原样搬移，没有重写，只有一处新增和一处删除。新增的是一条"自定义 subagent 自己的定义优先于派发提示词"的规则。#12142 的评审线程里有一个真实派发——它要求一个被定义为只读单个文件的 subagent 去全库搜索，而搬走的 "Provide clear, detailed prompts…" 那条恰恰在鼓励这种覆盖，却从没说清谁的契约优先。这条规则放在这份参考里而不是描述里，因为它属于提示词手艺：从不加载这份参考的会话仍然无法放宽 subagent 的工具，只会白白浪费那次派发。

删除的是一句话，而且它是去重、不是丢失。base 的 `agent.ts` 里有 "After launching an agent, do not fabricate or predict what it found before it returns. If the user asks a follow-up before the result arrives, provide status rather than guessing."；而常驻的 **Don't race** 那条已经用更强的措辞说明了同一条规则——"Never fabricate or predict its results in any format…give status, not a guess"——并且它在任何形态下都留在描述里，所以两处都留等于让每次请求为同一条指令付两遍钱。`SKILL.test.ts` 把这次去重钉住了：被删的那句在两个面里都不出现，而留下来的那条规则在三种形态里都出现。#12142 中一次针对该描述的整体压缩在评审后被回退；把其余部分限定为"搬移"，可以让这两个问题彼此独立。

## 3. 实测效果

描述长度取自构造出来的工具，代入预算测试所用的两个 subagent 条目、team 关、todo 开：

| 形态                                                             | 字符   | ≈token |
| ---------------------------------------------------------------- | ------ | ------ |
| 改动前                                                           | 9,730  | 2,433  |
| 改动后，指针（可加载 skill 的会话）                              | 7,386  | 1,847  |
| 改动后，指针 + 桥接提示（`tools.eager` 白名单扣住了 Skill 工具） | 7,504  | 1,876  |
| 改动后，被 `skills.disabled` 关掉                                | 7,192  | 1,798  |
| 改动后，内联（完全没有 skill 通路）                              | 10,412 | 2,603  |

即常见情形下每次请求省下 **2,344 字符 ≈ 586 token**，代价是 192 字符的指针。新 skill 会在 `<available_skills>` 清单里增加一条，而该清单是由会话启动前奏（session-start prelude）以 **user 角色消息**携带的，不在系统提示词里。这一条渲染后是 **371 字符、≈93 token**——由 `renderAvailableSkillsBlock` 实测得到，不是 frontmatter 里 `description` 那 247 字符，因为渲染还会加上 `<skill>` / `<name>` / `<description>` / `<location>` 外壳、一个 ` (bundled)` 后缀，并把 "the Agent tool's" 里的撇号转义成 `&apos;`。因此**对从不加载该 skill 的会话**，净收益是**每次请求 ≈493 token**——这类会话占多数，也正是本次改动的目标。

这 371 只在一个门槛之下是线性的，而这份账应该把门槛写出来：`MAX_SKILL_LISTING_CHARS = 8000`（`environmentContext.ts:32`）。超过它，`trimSkillEntriesTowardsBudget`（`:322-336`）会原样保留每一条 `entry.level === 'bundled'` 的条目，把其余条目压成 description 的第一行、丢掉 `whenToUse`。新增这一条是 bundled——恰好豁免于它自己可能触发的那次裁剪——而这份快照每个会话只构建一次，所以一旦越界，用户自己的项目/个人 skill 会在整个会话里失去 `whenToUse`，而这一条仍然完整。这一条占据该预算的 372 字符（仓库现有内置参考下，带它渲染为 6,724、不带为 6,352），所以这个区间很窄但确实存在；某个具体部署是否落在其中，此处并未实测（发现这次裁剪的探针用的是合成项目 skill）。§3 漏掉的是这个不连续性本身，不是某个数字。

**而加载过它的会话反而更贵，这一点我上一版藏起来了。** Skill 工具把整篇正文作为 `llmContent` 返回，于是那约 3,270 字符进入对话、并在之后每一轮被重新发送；重复加载只回一句「is already loaded in context」；虽然 `skill` 在 `COMPACTABLE_TOOLS` 里，但要清掉它需要至少一小时的空闲间隔、或上下文超过 500,000 字符。加载之后每轮的账：−2,344（描述）+ 371（清单项）+ 约 3,270（正文留在历史里）= **+1,297 字符 ≈ 比改动前每轮贵 324 token**。

所以这是一个**押注于会话构成**的取舍，不是白赚：交代类散文过去由**每一个**会话承担，现在只由**会派活的**会话承担——一次，然后在该会话余下的轮次里持续。在「多数会话从不委派」的部署里这个注押对了；在「几乎每个会话都要交代 agent」的部署里就押错了。它所效仿的 `workflow-authoring` 参考适用同一笔账，只是那边从未写出来。

桥接那一形态比纯指针多 118 字符：一句话告诉模型，先用 `tool_search` 查看 Skill 工具的 schema，再用 `tool_call` 调用它。（这句话还写作 "reveal it with ToolSearch first" 时只占 77 字符；main 后来把它改成同时点名桥接的两半，因为 `tool_search` 只能查看 schema、无法调用，而这份参考复用同一份共享措辞。）

内联形态比今天的描述多 682 字符，而这 682 可以精确分解：127 是内联前言及其 `---` 分隔符，265 是这份参考自己的标题和开头那段说明，465 是优先级规则连同它的空行，再减去 175——因为搬移过来的那部分文字在这份参考里比在原来的 bullet 列表里更短。其中只有优先级规则是新增文本，不是搬移文本。这个总量是为"无法加载 skill 的会话"刻意付的价：在那里放指针，等于指向模型拿不到的东西。而指针形态的会话一点都不用付，因为只有内联形态才会携带参考正文。

## 4. 路由如何决定

`skills/bundled-reference.ts` 是把 `workflow-authoring` 的判断抽出来，让两份参考不会各自漂移，同时带上两者都需要的桥接辅助函数。它在工具构造时一次性回答四种情况：

| 路由                    | 条件                                                                                                  | 描述里携带        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------- |
| `skill`                 | 存在 skill manager 且 Skill 工具已注册                                                                | 指针              |
| `skill-via-tool-search` | Skill 工具的 schema 可能被 `tools.eager` 白名单扣住，且 `tool_search` 与 `tool_call` **两者都已注册** | 指针 + 桥接那句话 |
| `inline`                | 没有任何 skill 通路（skill 关闭、Skill 被拒、或延迟且桥接不完整）                                     | 参考全文          |
| `withheld`              | 用户按名字关掉了这份参考，或禁用了整个 bundled 层级                                                   | 什么都不带        |

桥接那一行看的是可达性而不是注册：在 `ToolMode.CodeModeOnly` 下两个桥接工具都被隐藏（`code-mode.ts` 的 `HIDDEN_TOOLS`），所以跳过延迟分支、路由保持 `skill`——纯指针在那里依然诚实，因为被延迟的 Skill 工具仍可通过 `exec` 绑定调用。由于该判断是共享的，这对 #11013 已发布的 Workflow 参考同样是一次**路由变更**，不只是新参考的规则：CodeModeOnly 且 Skill 工具被权限延迟的会话，在本 PR 之前解析为 `skill-via-tool-search`，现在解析为 `skill`。钉住它的是本 PR 往 `workflow-authoring-skill.test.ts` 新增的那一行，而不是原有的行。

桥接这条路由要求两半都在，因为 `tool_search` 只能查看 schema——调用仍然要走 `tool_call`，所以只有 `tool_search` 的会话根本没有可用通路，必须直接拿到内联的参考全文。这个判据是本分支切出之后才从 main 进来的；正因为该判断现在只存在于一个共享模块里，两份参考在同一次合并中一起拿到了它，而不是各自漂移。

`AgentTool` 在构造函数里解析并记住它，这样会话中途的 `/skills` 开关不会让两次 `refreshSubagents()` 重建对"参考在哪里"给出不同答案。注册顺序保证了这是安全的：所有核心工具都先以惰性工厂注册、之后才被构造，所以构造 Agent 工具时 Skill 已经在 `getAllToolNames()` 里了。

`workflow-authoring-skill.ts` 保留全部导出名，改为委托给共享模块，因此 #11013 的调用方与测试都不受影响。

## 5. 影响面

- **每次请求**携带的 Agent 声明都变短了。嵌套的 agent 启动与 fork 继承同一份描述。
- **#12142 的预算测试**按新测量值下调，三条下调的描述行各取「实测长度 + 364～380」、总面那行 + 720（#12142 自己的余量是 430～490，所以「与该 PR 同口径」这句话也是错的）（默认 10,200 → 7,750；无 subagent 9,900 → 7,450；全块开启 11,200 → 8,750；整体可见面 14,200 → 11,750）。这四条下调行——三个描述上限加一个整体面上限——只约束**指针**形态，也就是几乎每个会话都会发送的那一种。另有第五条指针行是新增而非下调：桥接形态 7,504 → 7,900，并对桥接那句话自身的差值单独设了 ≤160 的上限，那是 §3 列出的 118 字符唯一的守卫。内联路由另有三行自己的上限：描述 10,412 → 10,750；描述再叠加 team 块后 11,396 → 11,770，这才是真正的最坏情况，并且高于改动前「全块开启」形态的 11,200 上限；整体面 14,056 → 14,430，高于本 PR 之前每个会话付出的 13,374——因为一份无法被加载的参考，每轮成本高于它所替换掉的那些文字。「指针 vs 内联」的差值改为钉在参考正文本身上，而不是钉在一个数量级上：数量级下限看不见「指导文本被贴回描述」这种回退——两个形态一起变大，先触发的是 7,750 那一行；唯一能单独触发它的反而是对参考的合法精简，实测精简 1,350 字符会把差值从 3,026 拉到 1,675。
- **`agent.test.ts`**：六处锚在搬走文本上的断言已改锚，第七处被刻意保留。这七处原本全都会照常通过——因为该文件的 stub `Config` 没有 `getSkillManager`，路由落到 `inline`，描述里嵌入了整篇 `SKILL.md`，每一个搬走的锚点都还在里面。改锚的六处锚到描述在任何形态下都保留的事实（fork 上不要设 `model`、fork 默认继承完整对话、传一个简短的 `name`，以及「需要大量父会话上下文时才选 fork」）。保留的第七处是 `toContain('Never delegate understanding')`（`:989`，与 base 的 `:979` 相同），作为本文件对内联形态的钉子留下：它对 stub 的依赖写在测试自己的注释里（`:984-987`），而内联正文的逐字全文另由 `agent-description-budget.test.ts:255` 断言，所以内联分支被截断或按节拆开时，报警的是那里、不是这里。
- **skills 清单**多出一条内置项，会出现在 `/skills` 中，并与其他 skill 一样受 `skills.disabled` / `skills.enabled` 控制。它是通过会话启动前奏里的 `<available_skills>` 块到达模型的——一条 user 角色消息，不是系统提示词——代价就是 §3 里算过的渲染后 371 字符。
- **打包**无需额外改动：`scripts/copy_bundle_assets.js` 与 `scripts/copy_files.js` 都递归拷贝 `skills/bundled/**`，而 `bundled-skills.integration.test.ts` 会解析每一份随包发布的 `SKILL.md`，新目录因此同时被两者覆盖。
- **没有任何提示词、快照或 ACP 面**引用被搬走的文本：全仓库只有 `agent.ts` 和 `agent.test.ts` 提到它。

## 6. 风险

**从不加载该 skill 的模型会写出更差的提示词。** 这是本次接受的权衡，其边界由"留下来的常驻内容"决定：启动规则、安全规则，以及决定调用形状的 fork 事实都还在描述里，所以跳过这份参考的会话仍然能正确调用工具，只是对 agent 的交代不够好。skill 自己的 description 会说明它装了什么，这正是模型判断"本轮是否需要它"的依据。

**召回率回退不会被单测发现。** 模型是否真的会在写委派提示词前加载这份参考，是评测问题而不是断言问题，而且没有任何仪器在量它：闸门跟踪在 #12333，而那一单**没有归属**——伞 issue #12028 并不承担它。

**常驻的"把 agent 的输出当证据看"这条仍未加限定。** 优先级规则在这份参考里，所以从不加载它的会话读到的仍然是那条 bullet，没有任何一句说明"定义本身就让结果具有权威性的 subagent"是另一种情形。要在描述里加这个限定，就得让每个会话的每一轮都付出只有派发轮次才需要的成本——而这正是本次改动要撤销的权衡——所以那一半留给 #12142 的线程。

## 7. 验证

- `packages/core/src/skills/bundled/agent-delegation/SKILL.test.ts` —— 双向分界表、指针措辞、优先级规则、内联形态、被关掉（withheld）形态（在 Skill 工具已注册与不存在两种情况下都断言，因为用户的退出选择优先于"没有通路"），以及"不要编造结果"那句的去重。
- `packages/core/src/tools/agent/agent-description-budget.test.ts` —— 下调后的预算、内联形态的几条上限（描述、描述叠加可选块、以及整体面），以及「指针 vs 内联」的正文检查：内联形态里逐字携带参考正文，指针形态里一段都不带。
- `packages/core/src/tools/workflow/workflow-description.test.ts` —— 未改动，它钉住的是 Workflow 描述自身那些形态没有移动。`packages/core/src/skills/workflow-authoring-skill.test.ts` **并非**未改动：本 PR 往里加了 27 行（`ToolMode` 的 import、桩上的 `toolMode` 字段与 `getToolMode`、CodeModeOnly 的路由行，以及一行 `resolveWorkflowAuthoringSurface`），且没有动到任何原有行；因此「抽取没有改变 #11013 的路由」这枚钉子来自它原有的那些行——那里变红应当读作「本 PR 新增的行写错了」，而不是「一枚未改动的钉子断了」。
- `packages/core/src/skills/bundled-skills.integration.test.ts` —— 新 `SKILL.md` 能被解析，且 `name` 与目录名一致。
