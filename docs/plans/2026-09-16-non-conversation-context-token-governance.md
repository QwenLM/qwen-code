# 非对话上下文的 Token 治理

日期：2026-09-16
跟进 issue：[#12028](https://github.com/QwenLM/qwen-code/issues/12028)（伞）· [#12029](https://github.com/QwenLM/qwen-code/issues/12029) · [#12030](https://github.com/QwenLM/qwen-code/issues/12030) · [#12032](https://github.com/QwenLM/qwen-code/issues/12032) · [#12033](https://github.com/QwenLM/qwen-code/issues/12033)

结论先行：**大头是配置和内容组织，不是缺机制。qwen-code 已经有延迟加载、skill 三层渐进披露和四套工具开关；把它们用对，空载成本可以从 47k 降到 15k 以内，不需要新增意图分类器一类的新逻辑。** 需要的代码改动只有两处，都已开 issue。

---

## 1. 指标：不要用"占窗口百分比"

一份实测样本里，非对话上下文占窗口 6.5%，看起来非常健康。但同一份配置换到 128k 窗口的模型上就是 37%——**配置没变、花的钱没变，指标从 6.5% 变成 37%**。分母是任意的，不能用来设目标。

应该用的指标：

> **空载成本 = 一个不调用任何工具的最简问答，实际发出去的输入 token。**

它与窗口无关、与模型无关，而且无法通过"把 token 从工具挪到消息里"来虚假达标。

### 健康线

| 分项 | 实测 | 健康线 | 依据 |
| --- | ---: | ---: | --- |
| 内置工具 | 21,461 | **≤ 6k** | 常驻集要覆盖 ≥90% 的工具调用。文件工作七件套（`run_shell_command`/`edit`/`read_file`/`write_file`/`grep_search`/`glob`/`tool_search`）合计 4,080，再留 1–2 个领域工具余量 |
| 上下文文件 | 15,400 | **≤ 5k** | 只放"永远成立、且模型推不出来"的事实 |
| 系统提示词 | 5,253 | **4–5k** | 已达标。约 30% 是删不得的安全条款；其余应随工具集自动收缩（#12032） |
| skill 清单 | 4,620 | **≤ 2.5k** | 约 55 token/个本身健康，问题是装了 84 个 |
| **空载成本** | **46,734** | **12–16k** | 约 -70% |

### 第二个判据：多少轮能摊薄

前缀是固定成本，对话是变动成本。健康的系统应当**在 5–10 轮之内让对话 token 超过前缀**。

- 实测 46.7k：按每轮增长约 2k 计，需 **23 轮**才追平。
- 目标 14k：**7 轮**追平。

会话越短，这个判据越重要——三五轮的会话永远摊不薄 46.7k。

---

## 2. 实测样本

某次交互会话开场第一轮的 `/context detail`，1M 上下文窗口：

| 类别 | token | 占非对话 |
| --- | ---: | ---: |
| 内置工具 | 21,461 | 45.9% |
| 上下文（`QWEN.md`）文件 | 15,400 | 33.0% |
| 系统提示词 | 5,253 | 11.2% |
| skill 清单 | 4,620 | 9.9% |
| MCP 工具 | 0 | — |
| **非对话合计** | **46,734** | |
| 消息 | 614 | |

**这轮请求 98.7% 的输入是前缀。**

内置工具块前十四项：

| 工具 | token | | 工具 | token |
| --- | ---: | --- | --- | ---: |
| `workflow` | 3,829 | | `web_fetch` | 693 |
| `agent` | 3,613 | | `edit` | 612 |
| `run_shell_command` | 1,495 | | `exit_plan_mode` | 592 |
| `cron_create` | 1,103 | | `read_file` | 585 |
| `report_findings` | 1,016 | | `web_search` | 499 |
| `record_artifact` | 842 | | `send_message` | 498 |
| `update_goal` | 783 | | `monitor` | 475 |
| `ask_user_question` | 751 | | `write_file` | 446 |

其余：`create_sub_session` 409、`tool_search` 375、`get_goal` 365、`enter_plan_mode` 343、`grep_search` 301、`list_agents` 292、`notebook_edit` 291、`zoom_image` 279、`glob` 266、`record_source` 220、`read_mcp_resource` 191、`cron_delete` 116、`task_stop` 102、`cron_list` 80。

上下文文件中，9 个 extension 的贡献为 9,989 token（由大到小 2,164 / 1,602 / 1,548 / 1,487 / 1,124 / 1,078 / 650 / 172 / 164），其余为项目 `QWEN.md` 4,021、auto-memory 1,180、输出语言文件 210。**extension 占了整个常驻上下文层的 65%。**

---

## 3. 现有机制盘点

决定"某个工具的 schema 是否进入首轮请求"的全部机制：

| 机制 | 位置 | 急/懒 | 是否作用于子 agent |
| --- | --- | --- | --- |
| `shouldDefer=true` | `tools/tools.ts:233-240` | 懒 | **否**（子 agent 带 `includeDeferred: true`） |
| `alwaysLoad=true` | `tools/tools.ts:241-246` | 急，覆盖延迟 | — |
| `tools.eager` 白名单 | `tools/tool-registry.ts:384-419` | 懒（降级，仍可用） | **是** |
| `tools.visible` | `config/config.ts:6969-6977` | 急（强制常驻） | — |
| `tools.disabled` | `tools/tool-registry.ts:289-321` | 不注册，不可达 | 是 |
| `permissions.deny`（整工具） | `permissions/permission-manager.ts:848-866` | 不注册，不可达 | 是 |
| `toolSearch.threshold` 预加载 | `core/client.ts:1746-1774` | 急，全有全无，仅会话开始 | — |
| 历史回放揭示 | `core/client.ts:1783-1822` | 恢复会话时急 | — |
| 无 ToolSearch 时的兜底 | `core/client.ts:1847-1884` | 急，**揭示全部** | — |
| ToolSearch (`select:` / 关键词) | `tools/tool-search.ts` | 懒，**唯一的意图驱动加载** | — |

几条容易踩错的语义：

- **审批模式和 `permissions.allow` 不省 token。** `permission-manager.ts:798-801` 原文："`permissions.allow` is pure auto-approval: it never demotes, hides, or removes a tool"。
- **`tools.eager` 不是禁用。** 白名单外的工具仍然注册、仍然可用，只是首轮不发 schema，模型通过 `tool_search` 取。
- **`tools.eager` 有一组豁免**：`mcp__*`、`structured_output`、plan 相关、`ask_user_question`、`task_stop`、`tool_search`。要省这几个只能 `permissions.deny`。
- **被 `tools.eager` 降级的工具会同时被排除出预加载候选集**（`tool-registry.ts:1061`）。因此**在没有 MCP 工具时，`tools.eager` 一个开关就够了，不必再设 `threshold`**；MCP 豁免于 eager 降级，只受 threshold 管。

### skill 的三层（外加条件激活）

| 层 | 内容 | 何时进上下文 |
| --- | --- | --- |
| 1 | `name` + frontmatter `description`(+`whenToUse`) | 常驻，放在 `history[0]` 的 prelude，**不在工具描述里**（`environmentContext.ts:322-336` 注释说明了这是为了不打掉 tools→system→messages 前缀缓存） |
| 2 | SKILL.md 正文 | 调用 `skill` 工具时；重复调用只回一行确认 |
| 3 | `references/*.md`、`scripts/` | 正文指引模型用 `read_file` 自取 |
| 4 | `paths:` 条件激活 | 命中匹配文件的工具调用之前，**连第 1 层都不出现**（`skills/skill-activation.ts:41-56`） |

上游默认提示词本身就在用这个机制：`## New Applications` 全段只有 214 字符，内容是"去调 `skill="new-app"`"。**把大段用法外置成 skill 是有先例的写法，不需要新机制。**

---

## 4. 三个杠杆与顺序

按 收益/风险 排序。前三步全是配置，0 代码。

### 步骤 1：关掉默认就该关的功能（0 代码，无风险）

样本里最大的一项 `workflow`（3,829）在上游 `isWorkflowsEnabled` **默认为 false**。同类带 feature gate 的还有：`isAgentTeamEnabled`（默认 false，一开会带进 7 个 team 工具）、`isCronEnabled`、`isArtifactEnabled` / `isRecordArtifactEnabled`、`isLspEnabled`、`isTodoWriteEnabled`、`isLsToolEnabled`。

**先确认部署里这些开关的状态**，关掉用不上的比任何 deny 规则都干净。

### 步骤 2：`tools.eager` 白名单（0 代码，低风险）

```jsonc
{
  "tools": {
    "eager": [
      "read_file", "write_file", "edit",
      "glob", "grep_search",
      "run_shell_command",
      "skill"
    ]
    // 若部署有 MCP 工具，再加 "toolSearch": { "threshold": 0 }
  }
}
```

白名单外的工具不是被禁用，仍可通过 `tool_search` 加载。分类时**不能只按调用频次排序**，要分两类：

- **需求驱动型**（用户显式要求 → 模型自然会去找）：降级安全。
- **机会驱动型**（需要模型自己想到才会用）：降级等于静默失效，**不报错，只表现为"效果变差"**，回放评估很难抓到。

延迟工具的清单会以 `名字 + 描述首行（截断到 160 字符）` 注入 prelude（`environmentContext.ts:131-142`），所以工具命名和描述首行要能自解释；另有 `searchHint` 字段（`tools.ts:252`）可改善 ToolSearch 关键词召回，且不占常驻 token。

### 步骤 3：extension 上下文文件迁移（0 代码，低风险）

extension 的内容按性质分三层：

| 内容性质 | 放哪 | 常驻成本 |
| --- | --- | --- |
| 永远成立的少量事实（身份、术语、硬约束） | `contextFileName` | 常驻，应当很小 |
| 场景性指引（怎么写查询、怎么配调度） | **`paths:` 门控的 skill** | 清单 100–200 token，正文按需 |
| 固定流程 | saved workflow（见 #11631） | 只写名字 |

依据：extension 可以携带 skill（`extensionManager.ts:1715-1717`），而 `.qwen/rules/` 的 `paths:` 条件机制**不对 extension 开放**（`rulesDiscovery.ts:305-324`）。更新的 `agent-plugins-v1` 格式已经完全跳过 `contextFileName`、只带 skill（`extensionManager.ts:1702-1705`）——方向上游已经选了，经典 extension 没跟上。

### 步骤 4：系统提示词（低收益，先不动）

不改上游的话，唯一合法的按段选择机制是 output style 的 `keepCodingInstructions: false`，它精确删掉 `## Software Engineering Tasks`（3,068 字符，`prompts.ts:369-372`），**不多不少**。20,801 → 17,733，约 -15%。

**不建议整体替换**（`--system-prompt` / `QWEN_SYSTEM_MD`）：默认提示词里约 6,349 字符（30.5%）是安全与行为边界，替换后要自己维护副本，而 `prompts.ts` 上游约每周 2 次提交，脱节了没有任何测试会失败。正确的方向是 #12032——让提示词按常驻工具集装配，砍工具时提示词自动跟着缩。

---

## 5. 预期收益

| 分项 | 现状 | 动作 | 目标 |
| --- | ---: | --- | ---: |
| 内置工具 | 21,461 | 步骤 1 + 2 | 4,080–5,766 |
| 上下文文件 | 15,400 | 步骤 3 | ~5,000 |
| 系统提示词 | 5,253 | 步骤 4（可选） | 4,478 |
| skill 清单 | 4,620 | 按场景装 / `paths:` 门控 | ~2,500 |
| **空载成本** | **46,734** | | **~16,000（-66%）** |

其中仅"关 `workflow`" + "`tools.eager` 降级 `agent`" 两项就是 7,442 token。

---

## 6. 成本模型

以 1M 窗口、输入 ¥12/百万 token、隐式缓存命中 20%（¥2.4/百万）计：

| | 每轮 |
| --- | ---: |
| 空载 46.7k，未命中 | ¥0.561 |
| 空载 46.7k，隐式缓存命中 | ¥0.112 |
| 目标 16k，未命中 | ¥0.192 |
| 目标 16k，隐式缓存命中 | ¥0.038 |

**缓存命中率决定收益相差约 5 倍**，因此会话长度分布是必须先拿到的数据。另外显式缓存（10%）比隐式（20%）再省一半，且不改变任何行为，值得优先确认。

### `threshold: 0` 不是白捡的收益

`docs/design/toolsearch-preload-threshold.md` 说明了这个权衡：一次会话中途的 ToolSearch 揭示会重写函数声明列表，而它在前缀最前面，**整段 prompt KV 缓存作废**。

| | 代价 |
| --- | --- |
| 保持预加载 | 每轮多付延迟集合的 schema（样本中 4,166 token）→ 命中缓存约 ¥0.010/轮 |
| 设 0 后中途揭示一次 | 约 42k 前缀重算 → 该轮多付约 ¥0.40 |
| 平衡点 | 约 **40 轮** |

结论：**只有当会话基本不会用到那些延迟工具时，设 0 才划算。** 对数据分析类场景（`web_fetch`/`web_search`/`cron_*`/`monitor`/`send_message`/`create_sub_session` 基本用不上）是净赚，但这是个判断，不是无条件的。

大窗口下这个门限必然失效的问题见 #12029。

---

## 7. 影响面与坑

1. **子 agent 拿到全部工具，包括延迟的。** `agents/runtime/agent-core.ts:841-851` 使用 `includeDeferred: true`，未声明 `tools` 列表的子 agent 会拿到所有 schema，不走 ToolSearch。threshold 对子 agent 完全无效，**唯一能过滤的是 `tools.eager` 和 `permissions.deny`**。若部署会起子 agent，其工具 token 可能比主会话还多，需单独统计。
2. **后台记忆 agent 依赖六个工具**（`read_file`/`grep`/`glob`/`shell`/`write_file`/`edit`）。被 deny 会静默降质，不报错。开了自动记忆就不要 deny 这六个。
3. **token 可能只是换了类别。** 去掉 `grep`/`glob` 后模型会改用 shell 里的 `find`/`grep`，输出进对话上下文。验收必须看**每任务总 input token 与实际计费**，不能只看非对话那几类。
4. **旧会话恢复。** 被 `tools.eager` 降级的工具若出现在历史里会自动补发 schema（`client.ts:1783-1822`）；被 deny 的不会。上线前拿几条旧会话恢复试一下。
5. **skill 的 `allowedTools` 只给自动放行，不声明也不加载工具**（`skills/types.ts:38-56`）。依赖被 deny 工具的 skill 要到运行时才失败。
6. **作用域外溢。** `permissions.deny` 写在 settings 里会作用于所有读这份 settings 的客户端（CLI、web-shell）；`--system-prompt` 只能按进程生效。需要独立的 settings 与进程池。
7. **DeepSeek 系模型上整条路线不成立。** `cli/src/config/config.ts:1993-2013`：模型名匹配 `/deepseek-(v3|v4|chat)/i` 且未显式配置时，`tool_search` 被推进 deny 列表，随后 `client.ts:1851-1880` **主动揭示所有延迟工具**。这是有意为之——注释说明 DeepSeek 的前缀缓存折扣最高到 1/120，稳定前缀比省 token 更值钱。这类部署只剩 `tools.eager` + `permissions.deny` + 压缩描述三条路。
8. **`tools.disabled` 存在已知缺口**：#11814 报告 `zoom_image` 已移出 registry 但 schema 仍会发给模型。以"被禁用工具不得出现在请求 schema 中"为验收项的部署需要关注。

---

## 8. 评估方案

分三层，从便宜到贵，每层通过再做下一层。

**第 1 层 · 静态检查（秒级，可进 CI）**
- 若做了提示词裁剪：安全条款关键句逐条 grep。可 grep 的锚点包括 `**UserPromptSubmit Context:**`、`**Denied Tool Calls:**`、`**Respect Tool Decisions:**`、`**Security First:**`、`Carefully consider the reversibility`、`- Destructive operations:` 等。
- 提示词与工具描述中出现的工具名，必须都在当前声明的工具集中。
- 记录裁剪版基于哪个上游版本生成，升级时 diff 默认提示词。

**第 2 层 · 离线回放（小时级，上线前必做）**
- 任务集：真实会话抽 100–200 条，按类型分层（纯问答、文件处理、Shell、数据查询、多步任务），每类 ≥20 条；另备 10–20 条安全用例（危险命令、伪装成用户指令的 hook 文本、被拒后是否绕路）。
- 跑法：headless 模式对同一任务集跑新旧配置，模型与温度固定，每条跑 3 次以估噪声。
- 指标：空载成本 · 每任务总 input token · 缓存命中/未命中与实际计费 · 工具召回率 · `tool_search` 调用率（即"路由遗漏比例"）· 坏调用率（相对路径、未声明工具名、参数校验失败）· 任务成功率 · 安全用例通过率（必须 100%）。

**第 3 层 · 线上灰度（天级）**
- 独立进程池跑新配置，切 5–10% 流量，指标同第 2 层，另加重试率与负反馈。一周无异常再放量。

---

## 9. 仍需补齐的数据

1. 会话长度分布（决定缓存命中率，收益相差约 5 倍）。
2. 各工具的调用频次与覆盖率、无工具调用会话的占比（决定白名单）。
3. 工具输出占对话 token 的比例——对数据分析类场景，查询结果与表结构 dump 可能比 schema 更大，且**永远命中不了缓存**。若这一项显著，优先级应整个翻转，先治输出（截断、分页、子 agent 隔离）。
4. 当前用的是隐式还是显式缓存。
5. `/context` 的口径问题（#12033）会影响以上所有测量：分类相加 47,348 vs 报告总数 65,267，比值 1.378，落在代码自记的 CJK 低估区间内。**中文内容为主的部署，读到的每个分类数字都可能低约三分之一。**
