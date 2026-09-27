# 非对话上下文的 Token 治理

日期：2026-09-16
跟进 issue：[#12028](https://github.com/QwenLM/qwen-code/issues/12028)（伞）· [#12029](https://github.com/QwenLM/qwen-code/issues/12029) · [#12030](https://github.com/QwenLM/qwen-code/issues/12030) · [#12032](https://github.com/QwenLM/qwen-code/issues/12032) · [#12033](https://github.com/QwenLM/qwen-code/issues/12033) · [#12037](https://github.com/QwenLM/qwen-code/issues/12037)
配套交接文档（带预期数值的验证步骤、影响面清单、待决策项）：[`docs/verification/context-token-governance/README.md`](../verification/context-token-governance/README.md)

结论先行：**大头是配置和内容组织，不是缺机制。qwen-code 已经有延迟加载、skill 三层渐进披露和四套工具开关；把它们用对，空载成本可以从 47k 降到 15k 以内，不需要新增意图分类器一类的新逻辑。** 需要的代码改动只有两处，都已开 issue。

---

> **⚠️ 2026-09-20：本文所有基线数字都是 `v0.24.1` 口径。** `v0.24.2` 含 [#10410](https://github.com/QwenLM/qwen-code/pull/10410)（`70edbf47`）：延迟工具改走 `tool_search` → `tool_call` 桥接，`tools.toolSearch.threshold` 默认 10→0，**按需池不再在开场预加载**。因此 §1 的健康线、§2 的实测样本（21,461 / 46,734 一类）、§5 的预期收益**都必须在 ≥ 0.24.2 上重测之后才能引用**；§6 的成本模型整节作废（告示就在 `## 6. 成本模型` 标题下面）。§3 的机制盘点**已就地更正**：豁免名单补上了桥接的另一半 `tool_call`（同样豁免于 `tools.eager`），"桥接不完整时的兜底"一行也从"揭示全部"改成了代码的实际行为。重测步骤见 [`docs/verification/context-token-governance/README.md`](../verification/context-token-governance/README.md) 的 §0.1。
>
> 连带更正一句：§10 结尾那句「上游这几个 PR 加起来省下的量，不到这一步的十分之一」是旧口径，**已就地改写**为按 #10410 之后的归因（**它自己就贡献了约 4.2k**、白名单还剩约 11.4k）。

## 1. 指标：不要用"占窗口百分比"

一份实测样本里，非对话上下文占窗口 6.5%，看起来非常健康。但同一份配置换到 128k 窗口的模型上就是 37%——**配置没变、花的钱没变，指标从 6.5% 变成 37%**。分母是任意的，不能用来设目标。

应该用的指标：

> **空载成本 = 一个不调用任何工具的最简问答，实际发出去的输入 token。**

它与窗口无关、与模型无关，而且无法通过"把 token 从工具挪到消息里"来虚假达标。

### 健康线

| 分项         |       实测 |     健康线 | 依据                                                                                                                                                                      |
| ------------ | ---------: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置工具     |     21,461 |   **≤ 6k** | 常驻集要覆盖 ≥90% 的工具调用。文件工作七件套（`run_shell_command`/`edit`/`read_file`/`write_file`/`grep_search`/`glob`/`tool_search`）合计 4,080，再留 1–2 个领域工具余量 |
| 上下文文件   |     15,400 |   **≤ 5k** | 只放"永远成立、且模型推不出来"的事实                                                                                                                                      |
| 系统提示词   |      5,253 |   **4–5k** | 已达标。约 30% 是删不得的安全条款；其余应随工具集自动收缩（#12032）                                                                                                       |
| skill 清单   |      4,620 | **≤ 2.5k** | 约 55 token/个本身健康，问题是装了 84 个                                                                                                                                  |
| **空载成本** | **46,734** | **12–16k** | 约 -70%                                                                                                                                                                   |

### 第二个判据：多少轮能摊薄

前缀是固定成本，对话是变动成本。健康的系统应当**在 5–10 轮之内让对话 token 超过前缀**。

- 实测 46.7k：按每轮增长约 2k 计，需 **23 轮**才追平。
- 目标 14k：**7 轮**追平。

会话越短，这个判据越重要——三五轮的会话永远摊不薄 46.7k。

---

## 2. 实测样本

某次交互会话开场第一轮的 `/context detail`，1M 上下文窗口：

| 类别                    |      token | 占非对话 |
| ----------------------- | ---------: | -------: |
| 内置工具                |     21,461 |    45.9% |
| 上下文（`QWEN.md`）文件 |     15,400 |    33.0% |
| 系统提示词              |      5,253 |    11.2% |
| skill 清单              |      4,620 |     9.9% |
| MCP 工具                |          0 |        — |
| **非对话合计**          | **46,734** |          |
| 消息                    |        614 |          |

**这轮请求 98.7% 的输入是前缀。**

内置工具块前十四项：

| 工具                | token |     | 工具             | token |
| ------------------- | ----: | --- | ---------------- | ----: |
| `workflow`          | 3,829 |     | `web_fetch`      |   693 |
| `agent`             | 3,613 |     | `edit`           |   612 |
| `run_shell_command` | 1,495 |     | `exit_plan_mode` |   592 |
| `cron_create`       | 1,103 |     | `read_file`      |   585 |
| `report_findings`   | 1,016 |     | `web_search`     |   499 |
| `record_artifact`   |   842 |     | `send_message`   |   498 |
| `update_goal`       |   783 |     | `monitor`        |   475 |
| `ask_user_question` |   751 |     | `write_file`     |   446 |

其余：`create_sub_session` 409、`tool_search` 375、`get_goal` 365、`enter_plan_mode` 343、`grep_search` 301、`list_agents` 292、`notebook_edit` 291、`zoom_image` 279、`glob` 266、`record_source` 220、`read_mcp_resource` 191、`cron_delete` 116、`task_stop` 102、`cron_list` 80。

上下文文件中，9 个 extension 的贡献为 9,989 token（由大到小 2,164 / 1,602 / 1,548 / 1,487 / 1,124 / 1,078 / 650 / 172 / 164），其余为项目 `QWEN.md` 4,021、auto-memory 1,180、输出语言文件 210。**extension 占了整个常驻上下文层的 65%。**

---

## 3. 现有机制盘点

决定"某个工具的 schema 是否进入首轮请求"的全部机制：

| 机制                            | 位置                                                                                                  | 急/懒                                                                                                                  | 是否作用于子 agent                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `shouldDefer=true`              | `tools/tools.ts` 的 `DeclarativeTool` 构造参数 `shouldDefer`                                          | 懒                                                                                                                     | **否**（子 agent 带 `includeDeferred: true`） |
| `alwaysLoad=true`               | 同上的 `alwaysLoad` 构造参数                                                                          | 急，覆盖延迟                                                                                                           | —                                             |
| `tools.eager` 白名单            | `tools/tool-registry.ts:384-419`                                                                      | 懒（降级，仍可用）                                                                                                     | **是**                                        |
| `tools.visible`                 | `config/config.ts` 的 `getVisibleTools()`（读构造期存入的 `visibleTools`）                            | 急（强制常驻）                                                                                                         | —                                             |
| `tools.disabled`                | `tools/tool-registry.ts:289-321`                                                                      | 不注册，不可达                                                                                                         | 是                                            |
| `permissions.deny`（整工具）    | `permissions/permission-manager.ts` 的 `getToolRegistrationStatus()`（deny 分支 `return 'disabled'`） | 不注册，不可达                                                                                                         | 是                                            |
| `toolSearch.threshold` 预加载   | `core/client.ts:1746-1774`                                                                            | 急，全有全无，仅会话开始                                                                                               | —                                             |
| 历史回放揭示                    | `core/client.ts` 的 `revealDeferredToolsReferencedInHistory`                                          | 恢复会话时急                                                                                                           | —                                             |
| 桥接不完整时的兜底              | `core/client.ts` 的 `resolveDeferredToolsForReminder`                                                 | 急，但**只揭示普通延迟工具**；被 `tools.eager` 降级的那批仍扣留（仍注册，按名直呼走正常审批），只记一次 `console.warn` | —                                             |
| ToolSearch (`select:` / 关键词) | `tools/tool-search.ts`                                                                                | 懒，**唯一的意图驱动加载**                                                                                             | —                                             |

几条容易踩错的语义：

- **审批模式和 `permissions.allow` 不省 token。** `permission-manager.ts:798-801` 原文："`permissions.allow` is pure auto-approval: it never demotes, hides, or removes a tool"。
- **`tools.eager` 不是禁用。** 白名单外的工具仍然注册、仍然可用，只是首轮不发 schema，模型通过 `tool_search` 取。
- **`tools.eager` 有一组豁免**（判据是 `permission-manager.ts` 的 `isExemptFromEagerAllowList`）：`structured_output`、plan 生命周期三件（`enter_plan_mode` / `exit_plan_mode` / `ask_user_question`）、`task_stop`、`tool_search`、**`tool_call`（#10410 新增的桥接另一半，2026-09-20 就地补上）**、`mcp__*`、`computer_use__*`。**豁免 ≠ 常驻**：豁免只说明"写进白名单也无效"，而 `task_stop`、`mcp__*`、`computer_use__*` 自身 `shouldDefer=true`，本来就不进首轮请求，所以也不占常驻地板。要真去掉某个豁免工具，用整工具 `permissions.deny`、`tools.disabled` 或 `--exclude-tools`；桥接那一对还可以用 `tools.toolSearch.enabled: false` 一次摘掉两半，代价见上表最后一行。
- **被 `tools.eager` 降级的工具会同时被排除出预加载候选集**（`tool-registry.ts:1061`）。因此**在没有 MCP 工具时，`tools.eager` 一个开关就够了，不必再设 `threshold`**；MCP 豁免于 eager 降级，只受 threshold 管。

### skill 的三层（外加条件激活）

| 层  | 内容                                             | 何时进上下文                                                                                                                                      |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `name` + frontmatter `description`(+`whenToUse`) | 常驻，放在 `history[0]` 的 prelude，**不在工具描述里**（`environmentContext.ts:322-336` 注释说明了这是为了不打掉 tools→system→messages 前缀缓存） |
| 2   | SKILL.md 正文                                    | 调用 `skill` 工具时；重复调用只回一行确认                                                                                                         |
| 3   | `references/*.md`、`scripts/`                    | 正文指引模型用 `read_file` 自取                                                                                                                   |
| 4   | `paths:` 条件激活                                | 命中匹配文件的工具调用之前，**连第 1 层都不出现**（`skills/skill-activation.ts:41-56`）                                                           |

上游默认提示词本身就在用这个机制：`## New Applications` 全段只有 214 字符，内容是"去调 `skill="new-app"`"。**把大段用法外置成 skill 是有先例的写法，不需要新机制。**

---

## 4. 三个杠杆与顺序

按 收益/风险 排序。前三步全是配置，0 代码。

### 步骤 1：关掉默认就该关的功能（0 代码，无风险）

样本里最大的一项 `workflow`（3,829）在上游 `isWorkflowsEnabled` **默认为 false**。同类带 feature gate 的还有：`isAgentTeamEnabled`（默认 false，一开会带进 7 个 team 工具）、`isCronEnabled`、`isArtifactEnabled` / `isRecordArtifactEnabled`、`isLspEnabled`、`isTodoWriteEnabled`、`isLsToolEnabled`。

**先确认部署里这些开关的状态**，关掉用不上的比任何 deny 规则都干净。

> 2026-09-17 更正（据 #12054 triage）：`workflow` 的 3,829 反映的是旧版本。main 上已按 #11013 第 4 项把写作规范移入内置的 `workflow-authoring` skill，默认 `pointer` 形态的描述上限为 4,800 字符并有 CI 预算测试（`workflow.test.ts`）；只有 Skill 工具不可达时才回落到 ≤26,500 字符的 `inline` 形态。部署升级后需在自己的版本上重新测 `/context detail`，不要把 3,829 当基线。真正没有上限、会随子 agent 数量增长的是 `agent`。

### 步骤 2：`tools.eager` 白名单（0 代码，低风险）

```jsonc
{
  "tools": {
    "eager": [
      "read_file",
      "write_file",
      "edit",
      "glob",
      "grep_search",
      "run_shell_command",
      "skill",
    ],
    // 若部署有 MCP 工具，再加 "toolSearch": { "threshold": 0 }
  },
}
```

白名单外的工具不是被禁用，仍可通过 `tool_search` 加载。分类时**不能只按调用频次排序**，要分两类：

- **需求驱动型**（用户显式要求 → 模型自然会去找）：降级安全。
- **机会驱动型**（需要模型自己想到才会用）：降级等于静默失效，**不报错，只表现为"效果变差"**，回放评估很难抓到。

延迟工具的清单会以 `名字 + 描述首行（截断到 160 字符）` 注入 prelude（`environmentContext.ts:131-142`），所以工具命名和描述首行要能自解释；另有 `searchHint` 字段（`tools.ts:252`）可改善 ToolSearch 关键词召回，且不占常驻 token。

**不需要意图分类器。** ToolSearch 本身就是模型驱动的按需加载，揭示结果在会话内复用、压缩后保留（`client.ts` 的 `resetChat` 注释：只有 `/clear` 清空），延迟工具提醒就是兜底。若上线后 `tool_search` 调用率偏高（§6 那条"盈亏线"已随该节整节作废，≥ 0.24.2 上要按桥接语义重推，别拿旧阈值当判据），退路是让部署后端在**创建会话时**按入口场景（文件分析 / SQL 查询等）设置 `tools.visible`：会话级、零路由开销，也不会在会话中途打掉缓存。

**常驻工具的描述精简（可选，收益小）。** 延迟工具揭示前不占 token，所以只有白名单内的工具值得精简。白名单生效后最大的常驻项是 `run_shell_command`（1,495）：其描述（`shell.ts` 的 `getShellToolDescription`）大半是开发场景示例（dev server、build watcher、`mongod`/`redis-server`、`npm install`、`git push`）和 good/bad 代码块，可换成一两个数据处理示例；**要保留**的是调用约定——超时与 `is_background`、用 `task_stop` 而非按进程名 kill、引号与命令串联、优先专用文件工具、避免 `cd`，删了会直接表现为调用失败。实现上沿用已有写法：`AgentTool.updateDescriptionAndSchema` 已经按 `isAgentTeamEnabled()` / `isTodoWriteEnabled()` 条件拼装描述，给少数大工具加一个由开关控制的精简变体即可，不要在部署侧整段覆盖描述（和替换系统提示词一样会与上游脱节）。跟进在 #12054：triage 已把范围收窄为先治 `agent`（按 `workflow` 的做法外置委派说明，并在 `agent.test.ts` 加描述体积预算），再把 `workflow.test.ts` 的预算测试推广到其余常驻工具；合并文件工具另行讨论。

### 步骤 3：extension 上下文文件迁移（0 代码，低风险）

extension 的内容按性质分三层：

| 内容性质                                 | 放哪                        | 常驻成本                     |
| ---------------------------------------- | --------------------------- | ---------------------------- |
| 永远成立的少量事实（身份、术语、硬约束） | `contextFileName`           | 常驻，应当很小               |
| 场景性指引（怎么写查询、怎么配调度）     | **`paths:` 门控的 skill**   | 清单 100–200 token，正文按需 |
| 固定流程                                 | saved workflow（见 #11631） | 只写名字                     |

依据：extension 可以携带 skill（`extensionManager.ts:1715-1717`），而 `.qwen/rules/` 的 `paths:` 条件机制**不对 extension 开放**（`rulesDiscovery.ts:305-324`）。更新的 `agent-plugins-v1` 格式已经完全跳过 `contextFileName`、只带 skill（`extensionManager.ts:1702-1705`）——方向上游已经选了，经典 extension 没跟上。

### 步骤 4：系统提示词（低收益，先不动）

不改上游的话，唯一合法的按段选择机制是 output style 的 `keepCodingInstructions: false`，它精确删掉 `## Software Engineering Tasks`（3,068 字符，`prompts.ts:369-372`），**不多不少**。20,801 → 17,733，约 -15%。（2026-09-25 就地更正：#12546 第二轮精简后，该段切片（标题到下一标题、`string.length` 口径）为 2,482 字符；严格说开关删掉的是 `getSoftwareEngineeringTasksSection` 的返回值，切片段尾 405 字符的两条通用 bullet 由调用方拼接、不在其内——删除量旧口径实为 2,663 字符，现为 2,077 字符，「精确删掉……不多不少」是按切片口径写成的，并不精确。该函数现位于 `prompts.ts:402`（原文 `:369-372` 已漂移），其中的安全锚点 `**Report outcomes faithfully:**` 现位于 `prompts.ts:415`、仍在被删段内。20,801 → 17,733 的总量仍是 v0.24.1 基线口径，引用前须按交接文档 §0.1 重测。）

⚠️ **这一段里有一条安全条款。** `## Software Engineering Tasks` 由 `getSoftwareEngineeringTasksSection` 生成，其中包含 `**Report outcomes faithfully:**`（`prompts.ts:415`，不得把失败说成成功、不得隐瞒没做的验证）——它正是 §8 静态检查锚点之一。用这个开关时，要在该 output style 自己的 `prompt` 正文里补回这一条（output style 的 `prompt` 渲染在 `# Output Style: <name>` 下，项目级 style 放 `.qwen/output-styles/`，见 #10761）。

各段体积（非 git、非沙箱快照，字符）供 #12032 参考：`Using Your Tools` 4,012 · `Core Mandates` 3,334 · `Examples` 3,240 · `Software Engineering Tasks` 3,043 · `Executing actions with care` 3,042 · `Tone and Style` 1,030 · `Communicating With the User` 632 · `Final Reminder` 603 · `Security and Safety Rules` 535 · `Outside of Sandbox` 361 · `New Applications` 195 · `Interaction Details` 158；在 git 仓库中另有 git 段约 1.9k。注意 `**Respect Tool Decisions:**` 也不在安全段里，而在 `Using Your Tools` 中——按段整删同样会带走它。（2026-09-25 就地更正：#12546 第二轮精简改动了其中四段；按「标题到下一标题切片、`string.length`」口径实测 merge base → #12546 head：`Using Your Tools` 3,706 → 3,217 · `Software Engineering Tasks` 3,068 → 2,482 · `Tone and Style` 689 → 658 · `Communicating With the User` 662 → 571。本句其余数字仍是 2026-09-16 基线，与当前构建已有漂移。）

**不建议整体替换**（`--system-prompt` / `QWEN_SYSTEM_MD`）：默认提示词里约 6,349 字符（30.5%）是安全与行为边界，替换后要自己维护副本，而 `prompts.ts` 上游约每周 2 次提交，脱节了没有任何测试会失败。正确的方向是 #12032——让提示词按常驻工具集装配，砍工具时提示词自动跟着缩。

若仍要替换，还有几件不显眼的事：

- **只能按进程生效。** `Config.systemPrompt` 是只读字段，只能由 `--system-prompt` 或 SDK 传入；没有 settings 键，daemon/ACP 也没有按会话设置主提示词的参数（`serve/acp-http/dispatch.ts` 里的 `systemPrompt` 属于子 agent 的增改接口）。只对某一类会话生效就需要独立进程池，回滚要重启或切流量。
- **`QWEN_SYSTEM_MD` 坑更多。** 相对路径（包括默认的 `.qwen/system.md`）按进程工作目录解析；文件缺失直接抛 `missing system prompt file`，会话起不来而不是回退；每次重建系统指令都重读文件，会话中改文件会改变提示词并打掉缓存；它作用于所有 `getCoreSystemPrompt` 调用方（含 Arena），而 `--system-prompt` 只作用于主会话。
- **动态装配随之消失。** 交互模式说明、output style 层及其每轮提醒（`resolveMainSessionOutputStyle` 在替换时返回 `undefined`）、`QWEN_SYSTEM_IDENTITY_MD`、`todo_write`/code mode 变体、按模型区分的工具调用示例（`getToolCallExamples`）都不再生成。仍会追加的是上下文文件、`appendSystemPrompt`、git status、auto-memory，以及放在消息里的每轮提醒（plan mode、延迟工具清单）。
- **起点要用真实默认值。** 用 `QWEN_WRITE_SYSTEM_MD=<path>` 按部署的模型与模式导出一次再删减，并记录所基于的默认提示词哈希，升级时重新导出 diff。

### 回滚

步骤 1–3 都是配置或内容：改回文件即可，新会话按 settings 文件指纹重新读取（见交接文档 §2.3），无需重启 daemon。output style 切回默认即可。只有 `--system-prompt` 需要重启进程。

---

## 5. 预期收益

| 分项         |       现状 | 动作                     |                目标 |
| ------------ | ---------: | ------------------------ | ------------------: |
| 内置工具     |     21,461 | 步骤 1 + 2               |         4,080–5,766 |
| 上下文文件   |     15,400 | 步骤 3                   |              ~5,000 |
| 系统提示词   |      5,253 | 步骤 4（可选）           |               4,478 |
| skill 清单   |      4,620 | 按场景装 / `paths:` 门控 |              ~2,500 |
| **空载成本** | **46,734** |                          | **~16,000（-66%）** |

其中仅"关 `workflow`" + "`tools.eager` 降级 `agent`" 两项就是 7,442 token。（2026-09-25 就地更正：上表「系统提示词」行的 4,478 派生自已过时的 775 token 开关删除量；#12546 后开关实际删除 2,077 字符 ≈ 525 token，对应目标约 4,728。5,253 基线仍是 v0.24.1 口径，见文首告示。）

---

## 6. 成本模型

> **⚠️ 本节整节作废（含下面的 `threshold: 0` 小节），不要引用其中任何数字。** [#10410](https://github.com/QwenLM/qwen-code/pull/10410) 已于 2026-09-20 合入（`70edbf47`）：`tool_search` → `tool_call` 桥接取代了"揭示即改写声明列表"，声明列表保持字节稳定，**中途发现工具不再作废前缀缓存**，`tools.toolSearch.threshold` 的默认值随之改为 `0`。因此本节的每一个数字与结论——下面这张建立在空载 46.7k 上的每轮 ¥ 表、"**缓存命中率决定收益相差约 5 倍**"、以及 `threshold: 0` 小节里的"平衡点约 40 轮"、"一次揭示 ¥0.28–0.40"、"`tool_search` ≤2 次/会话"——**都不再成立**：延迟加载现在的代价是首次使用前多一次往返，而不是一次前缀重算。要重新论证"预加载是否值得"，必须按桥接语义重推，并在含 #10410 的版本上重新取基线。本节保留只为记录当时的推理过程。

以 1M 窗口、输入 ¥12/百万 token、隐式缓存命中 20%（¥2.4/百万）计：

|                          |   每轮 |
| ------------------------ | -----: |
| 空载 46.7k，未命中       | ¥0.561 |
| 空载 46.7k，隐式缓存命中 | ¥0.112 |
| 目标 16k，未命中         | ¥0.192 |
| 目标 16k，隐式缓存命中   | ¥0.038 |

**缓存命中率决定收益相差约 5 倍**，因此会话长度分布是必须先拿到的数据。另外显式缓存（10%）比隐式（20%）再省一半，且不改变任何行为，值得优先确认。

### `threshold: 0` 不是白捡的收益

> **⚠️ 本小节同样作废**，判据见 `## 6. 成本模型` 标题下的整节告示。具体到这一小节：下面这张表里的"平衡点约 **40 轮**"、"设 0 后中途揭示一次 ≈ ¥0.40"，以及紧随其后的结论"**只有当会话基本不会用到那些延迟工具时，设 0 才划算**"，全部建立在"一次中途揭示会整段重写前缀"上——#10410 之后声明列表字节稳定，这个前提没有了，所以这三个数字都不能再用，也不能拿它们反推"`threshold: 0` 值不值"。

`docs/design/toolsearch-preload-threshold.md` 说明了这个权衡：一次会话中途的 ToolSearch 揭示会重写函数声明列表，而它在前缀最前面，**整段 prompt KV 缓存作废**。

|                     | 代价                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| 保持预加载          | 每轮多付延迟集合的 schema（样本中 4,166 token）→ 命中缓存约 ¥0.010/轮 |
| 设 0 后中途揭示一次 | 约 42k 前缀重算 → 该轮多付约 ¥0.40                                    |
| 平衡点              | 约 **40 轮**                                                          |

结论：**只有当会话基本不会用到那些延迟工具时，设 0 才划算。** 对数据分析类场景（`web_fetch`/`web_search`/`cron_*`/`monitor`/`send_message`/`create_sub_session` 基本用不上）是净赚，但这是个判断，不是无条件的。

大窗口下这个门限必然失效的问题见 #12029。

---

## 7. 影响面与坑

1. **子 agent 拿到全部工具，包括延迟的。** `agents/runtime/agent-core.ts:841-851` 使用 `includeDeferred: true`，未声明 `tools` 列表的子 agent 会拿到所有 schema，不走 ToolSearch。threshold 对子 agent 完全无效，**唯一能过滤的是 `tools.eager` 和 `permissions.deny`**。若部署会起子 agent，其工具 token 可能比主会话还多，需单独统计。
2. **后台记忆 agent 依赖六个工具**（`read_file`/`grep`/`glob`/`shell`/`write_file`/`edit`）。被 deny 会静默降质，不报错。开了自动记忆就不要 deny 这六个。
3. **token 可能只是换了类别。** 去掉 `grep`/`glob` 后模型会改用 shell 里的 `find`/`grep`，输出进对话上下文。验收必须看**每任务总 input token 与实际计费**，不能只看非对话那几类。
4. **旧会话恢复。** 被 `tools.eager` 降级的工具若出现在历史里会自动补发 schema（`client.ts` 的 `revealDeferredToolsReferencedInHistory`；引符号名而不引行号，行号会随文件漂移）；被 deny 的不会。上线前拿几条旧会话恢复试一下。
5. **skill 的 `allowedTools` 只给自动放行，不声明也不加载工具**（`skills/types.ts:38-56`）。依赖被 deny 工具的 skill 要到运行时才失败。
6. **作用域外溢。** `permissions.deny` 写在 settings 里会作用于所有读这份 settings 的客户端（CLI、web-shell）；`--system-prompt` 只能按进程生效。需要独立的 settings 与进程池。
7. **DeepSeek 系模型上整条路线不成立（2026-09-20 起作废）。** 该判断依据的自动退出分支已被 #10410 删除：`cli/src/config/config.ts` 里已无 `deepseek` 引用，唯一的桥接开关是显式 `tools.toolSearch.enabled: false`（同文件的 `shouldDisableToolSearch`，同时 deny `tool_search` 与 `tool_call`；这里引符号名而不引行号，行号会随文件漂移）。这类部署现在与其他部署同路；若想要旧的「全部急揭示」行为，手工设置该开关即可。
8. **`tools.disabled` 的已知缺口，一半已修**：#11814 报告 `zoom_image` 已移出 registry 但 schema 仍会发给模型。经排查该 issue 实为两件事：**指引**无条件推荐 `zoom_image`（已由 PR #12271 修好——指引现在只在该工具可直接调用或能经 `tool_search` 揭示时才发送），以及**schema 泄漏**（未能复现，仍挂在 #11814 下）。以"被禁用工具不得出现在请求 schema 中"为验收项的部署，仍应自己拉一次真实请求体核对，不要只看 `/tools`。

---

## 8. 评估方案

分三层，从便宜到贵，每层通过再做下一层。

**第 1 层 · 静态检查（秒级，可进 CI）**

- 若做了提示词裁剪：安全条款关键句逐条 grep。可 grep 的锚点包括 `**UserPromptSubmit Context:**`、`**Denied Tool Calls:**`、`**Respect Tool Decisions:**`、`**Security First:**`、`**Report outcomes faithfully:**`、`Carefully consider the reversibility`、`- Destructive operations:` 等。用 `keepCodingInstructions: false` 时 `**Report outcomes faithfully:**` 必然检查失败，除非已在 output style 正文补回（见步骤 4）。
- 提示词与工具描述中出现的工具名，必须都在当前声明的工具集中。
- 记录裁剪版基于哪个上游版本生成，升级时 diff 默认提示词。

**第 2 层 · 离线回放（小时级，上线前必做）**

- 任务集：真实会话抽 100–200 条，按类型分层（纯问答、文件处理、Shell、数据查询、多步任务），每类 ≥20 条；另备 10–20 条安全用例（危险命令、伪装成用户指令的 hook 文本、被拒后是否绕路）。
- 跑法：headless 模式对同一任务集跑新旧配置，模型与温度固定，每条跑 3 次以估噪声。
- 指标：空载成本 · 每任务总 input token · 缓存命中/未命中与实际计费 · 工具召回率 · `tool_search` 调用率（即"路由遗漏比例"）· 坏调用率（相对路径、未声明工具名、参数校验失败）· 任务成功率 · 安全用例通过率（必须 100%）。
- 埋点缺口：OTel 属性 `qwen-code.context.usage` 目前只有分类合计。`context-usage-snapshot.ts` 的 `estimateToolCategories` 本来就逐个遍历声明，扩展为输出**每个工具的 token、声明的工具数、加载原因**（常驻 / `tool_search` 揭示 / 预算预加载 / 历史回放 / `tools.visible`），`tool_search` 调用率与"每会话揭示次数 ≤ 2"这条运营线（**该 ≤2 阈值出自已作废的 §6**，桥接之后要重测再定，埋点本身仍值得做）就能直接从线上遥测读，而不用解析会话记录。遥测数字本身的正确性在 #12048（两套估算器、skill 正文归因）；按工具明细与加载原因目前还没有 issue。

**第 3 层 · 线上灰度（天级）**

- 独立进程池跑新配置，切 5–10% 流量，指标同第 2 层，另加重试率与负反馈。一周无异常再放量。

---

## 9. 仍需补齐的数据

1. 会话长度分布（决定缓存命中率，收益相差约 5 倍）。
2. 各工具的调用频次与覆盖率、无工具调用会话的占比（决定白名单）。
3. 工具输出占对话 token 的比例——对数据分析类场景，查询结果与表结构 dump 可能比 schema 更大。新输出首次送入模型增加输入，但后续包含它的不变历史可能命中前缀缓存；需要按整项任务统计 provider 返回的缓存与非缓存输入，再决定是否优先治理输出（截断、分页、子 agent 隔离）。
4. 当前用的是隐式还是显式缓存。
5. `/context` 的历史口径问题（#12033）：分类相加 47,348 vs 报告总数 65,267，不能据此推导中文分类统一低估三分之一。分类展示已经使用 CJK-aware 估算器；历史差额涉及 messages 的缓存扣减口径、未归因的启动上下文及估算误差。#12119 已补充启动上下文和显式残差，验收应在包含该修复的版本上重新采集 provider usage，不对旧分类套用统一修正系数。

---

## 10. 上游进展（截至 2026-09-20）

本文写于 2026-09-16。此后伞 issue #12028 下的几项已经有了结果，逐条对应回上面的章节：

| 上游项                                | 状态                                                                                                    | 对本文的影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #12033 · `/context` 口径              | **已合**（PR #12119）                                                                                   | 第 9 节第 5 条。分类现在多了 `startupContext` / `unattributed` / `cachedTokens` 三项，skill 按实际发送的文本计量（不含 `functionResponse` 里的 skill 正文），历史差额涉及缓存扣减口径和启动上下文归因，不能归结为 CJK 低估。**重新测一遍再引用第 2 节的样本。**                                                                                                                                                                                                                                                                                                                                                                       |
| #12032 · 提示词按声明工具裁剪         | **已合**（PR #12145）                                                                                   | 第 4 节步骤 4。系统提示词现在逐行门控工具指引，并按四种工具调用记法过滤示例块。对一个文件类白名单实测只省 1,421 字符 ≈ 355 token（`prompts.test.ts` 里 `saves about 1.4k characters…` 那条钉住这个量；其中 1,104 是 subagent + codebase 两条，另 317 是 `monitor` 那条——它同样不在这份白名单里。2026-09-25 就地更正：#12546 第二轮精简后实测降为 1,135 字符 ≈ 284 token——subagent + codebase 两条 818、`monitor` 317；钉住它的测试已改名 `saves about 1.1k characters of policy text for a file-work allowlist`，区间 900–1,500 字符未变）——**价值在正确性（不再指引未声明的工具），不在 token**，步骤 4 "低收益、先不动"的结论不变。 |
| #12054 · 内置工具描述                 | **在途**（PR #12323，草稿，叠在 #12142 上）                                                             | 第 5 节。Agent 工具描述里"怎么写委派提示词"那部分（2,344 字符 ≈ 586 token/请求）移入 bundled skill，描述里只留指针；净 ≈524 token/请求。这是第一笔**不需要部署侧配合**的内置工具降量。                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| #12142 · teammate 指引门控 + 体积预算 | **已合**（`36887c49`，随 `v0.24.2` 发布）                                                               | 第 7 节。`run_in_background` 里 341 字符的 teammate 说明此前无条件发送，即使该会话根本没有 `name` 参数；同时给 Agent/Shell 加了每轮体积预算测试，此后这两个描述再长回去会在 CI 红。                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| #12030 · extension 上下文文件         | **已关闭**：第 1 项已合（PR #12318，`fbd6ccc2`），条件规则机制已随 #12034 合入                          | 第 4 节步骤 3。`/context` 现在能把每个上下文文件归到它所属的 extension；extension 也可以贡献 `paths:` 条件规则。**机制到位，但把内容搬过去这件事没人做**——省不省那 10,400 token 取决于作者是否迁移。                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| #11814 · `tools.disabled`             | **指引部分已修**（PR #12271），schema 泄漏未复现                                                        | 第 7 节第 8 条，已就地更新。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| #12029 · 百分比门限                   | **一半收口**：告警上限随 #12034 合入；**预加载预算在 `threshold > 0` 时仍然没有绝对上限**，这一半仍开放 | #10410 改的是**默认值**、没有加上限：`client.ts` 仍按 `Math.floor(窗口 × 百分比 / 100)` 计算，唯一的夹取是把百分比夹到 100——按百分比对称而不是按 token 对称，且预加载是全有全无。默认 `0` 只是让它默认不触发，**而本项目的验证文档恰恰建议"会话确定会用到那些工具时抬高门限"**，一旦抬高这个缺口就回来了。第 6 节的 `threshold: 0` 小节作废（见该小节顶部告示）。                                                                                                                                                                                                                                                                     |

**没有变的是最重要的那条**：第 4 节的步骤 1 和步骤 2（关掉默认就该关的功能、上 `tools.eager` 白名单）依然是 0 代码、低风险、收益最大的一步（内置工具 21,461 → 4,080–5,766），也依然**没有人执行**。上游这几个 PR 加起来省下的量约占这一步的四分之一——按 #10410 之后的归因，**它自己就贡献了约 4.2k**、白名单还剩约 11.4k，其余仍在部署侧。（这句 2026-09-20 就地更正：原文写的是"不到这一步的十分之一"，那是 #10410 合入前的旧口径，见文首告示。）验收线若是"简单轮次的内置工具 token 减半"，唯一能达成它的仍然是这一步。
