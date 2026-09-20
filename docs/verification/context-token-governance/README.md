# 交接：非对话上下文 Token 治理的验证与落地

配套方案：[`docs/plans/2026-09-16-non-conversation-context-token-governance.md`](../../plans/2026-09-16-non-conversation-context-token-governance.md)
上游跟进：[#12028](https://github.com/QwenLM/qwen-code/issues/12028)（伞）· [#12029](https://github.com/QwenLM/qwen-code/issues/12029) · [#12030](https://github.com/QwenLM/qwen-code/issues/12030) · [#12032](https://github.com/QwenLM/qwen-code/issues/12032) · [#12033](https://github.com/QwenLM/qwen-code/issues/12033) · [#12037](https://github.com/QwenLM/qwen-code/issues/12037)

> **这份文档里的所有代码位置都是读 `origin/main`（2026-09-16，`c46933ce56`）得出的，没有跑过任何构建或测试。**
> **所有运行时数字来自一个真实部署的 `/context detail` 与会话记录，不是基准测试。**
> 每一节都标注了「已核实 / 待验证 / 待决策」。接手的人请先读第 1 节，它决定后面做不做。

---

## 0. 一句话

这件事约 95% 是配置和内容组织，不是代码。上游的延迟加载机制（ToolSearch + `tools.eager`）从 2026-04 就在做，已经可用；需要做的是**把它打开**，并把常驻的知识挪到按需层。

---

## 1. 指标与基线

### 用什么指标

**不要用「占上下文窗口百分比」。** 同一份配置在 1M 窗口上显示 6.5%、在 128k 上显示 51%，成本完全相同。

用**空载成本**：一个不调用任何工具的最简问答，实际发出的输入 token 数。

两种读法：

| 方法                                                             | 得到什么                       | 注意                 |
| ---------------------------------------------------------------- | ------------------------------ | -------------------- |
| 新会话直接 `/context detail`（不发消息）                         | `isEstimated: true` 的分项估算 | **少报约 11%**，见下 |
| 会话记录里第一条 `qwen-code.api_response` 的 `input_token_count` | provider 的真实计数            | 这是账单依据         |

### 实测基线（改动前）

| 类别                             |              token |                                                      占非对话 |
| -------------------------------- | -----------------: | ------------------------------------------------------------: |
| 内置工具                         |             21,461 |                                                         45.9% |
| 上下文（`QWEN.md`）文件          |             15,400 |                                                         33.0% |
| 系统提示词                       |              5,253 |                                                         11.2% |
| skills                           |                472 |                                                          1.0% |
| MCP                              |                  0 |                                                             — |
| 分类合计                         |             42,586 |                                                               |
| **真实首轮 `input_token_count`** |         **47,931** |                                                               |
| **未被任何分类计入**             | **5,345（11.2%）** | 见 [#12033](https://github.com/QwenLM/qwen-code/issues/12033) |

另一会话独立验证：总数 48,375 − 分类和 42,835 = 5,540。两次都落在 5.3–5.5k，稳定。这部分是 skill 清单（裁剪后）+ 延迟工具提醒 + 启动环境上下文 + 估算误差。

**环境**：模型 `qwen3.7-max`，窗口 1,000,000，无 MCP 工具，交互式（daemon + ACP），启用了 9 个 extension、84 个 skill、自动记忆。

### 目标

| 分项         |       现在 |                           目标 |
| ------------ | ---------: | -----------------------------: |
| 内置工具     |     21,461 | **≤ 6k**（保守版 9.5k，见 §2） |
| 上下文文件   |     15,400 |                       **≤ 5k** |
| 系统提示词   |      5,253 |       **4–5k**（已达标，不动） |
| skills       |     472 起 |                         ≤ 2.5k |
| **空载成本** | **47,931** |                   **≈ 16,000** |

第二个判据：**前缀应在 5–10 轮之内被对话内容超过**。现状按每轮约 2k 增长要 23 轮，目标 7 轮。

---

## 2. 第一步：打开延迟加载（配置，0 代码）

### 2.1 已核实的机制

| 开关                           | 注册 | 首轮发 schema | 还能用              | 管子 agent |
| ------------------------------ | ---- | ------------- | ------------------- | ---------- |
| 列进 `tools.eager`             | ✅   | ✅            | ✅                  | ✅         |
| **不列进 `tools.eager`**       | ✅   | ❌            | ✅ 走 `tool_search` | ✅         |
| `tools.disabled`               | ❌   | ❌            | ❌                  | ✅         |
| `permissions.deny`（整工具）   | ❌   | ❌            | ❌                  | ✅         |
| 审批模式 / `permissions.allow` | ✅   | ✅            | ✅                  | 不影响     |

代码位置：`packages/cli/src/config/settingsSchema.ts`（`tools.eager` 定义）→ `packages/cli/src/config/config.ts:1935-1953`（读取，**bare/safe 模式下直接忽略**）→ `packages/core/src/permissions/permission-manager.ts:872-882`（判定）→ `packages/core/src/tools/tool-registry.ts:393-402`（`registerPermissionDeferredFactory`）。

文档：`docs/users/configuration/settings.md` 的 `tools.eager` 一行。

**豁免名单**（列不列都常驻，共 2,163 token 的地板）：`tool_search` 375 · `ask_user_question` 751 · `exit_plan_mode` 592 · `enter_plan_mode` 343 · `task_stop` 102；另有 `mcp__*`、`structured_output`、`computer_use__*`。

### 2.2 要写的配置

写在 `<projectRoot>/.qwen/settings.json` 的 `tools` 对象里（与既有的 `approvalMode` / `disabled` 并列）：

```jsonc
"eager": [
  "read_file", "write_file", "edit",
  "glob", "grep_search",
  "run_shell_command",
  "skill",          // 必须：skill 路由的入口，且它不出现在 /context 的 builtinTools 明细里
  "agent"           // 保守版保留；该部署使用 subagent，见 §2.4
]
```

**`skill` 极易漏掉**：它的声明被计入 `skills` 分类而非 `builtinTools`，照着 `/context` 的工具列表写白名单一定会漏，漏了就等于把整个 skill 体系的入口降级了。

### 2.3 三条必须知道的语义

1. **多 scope 是「替换」不是「合并」**：`tools.eager` later scope **replace** earlier list。工作区级会整个覆盖用户级，不会取并集。测试时只放一处。
2. **不需要重启 daemon**。`newSession` 走 `loadSettingsCached(cwd)`（`packages/cli/src/acp-integration/acpAgent.ts:5402`），而该缓存按**文件指纹**判新鲜度（`packages/cli/src/config/settings-cache.ts:168-189`），settings.json 一改，下一个新会话就重新读。schema 里的 `requiresRestart: true` 针对的是**已在运行的那个会话**。
3. **未知 key 的告警只走 `debugLogger`**（`packages/cli/src/config/settings.ts:276`），默认不可见。所以"没报错"不能证明配置被接受。

### 2.4 ⚠️ 该部署使用 subagent —— 这是唯一的真风险

**`tools.eager` 降级的工具，连 subagent 显式声明的 `tools` 列表都会被过滤掉。**

`packages/core/src/agents/runtime/agent-core.ts:714-717` 的 `isHiddenByEagerAllowList`，作用于三处：继承全量工具（`:841`）、**显式 `tools` 列表（`:809`）**、内联声明（`:830`）。而 subagent 是 `includeDeferred: true` 急加载，**不走 ToolSearch，没有补救路径，也不报错**。

→ **白名单必须是「主会话 ∪ 所有 subagent」的工具需求并集。**

**待执行**：

```bash
ls ~/.qwen/agents/ ~/.qwen/extensions/*/agents/ 2>/dev/null
# 逐个看 agent 定义里的 tools 字段，凡是出现在白名单之外的工具名都要补进白名单
```

### 2.5 验证步骤与预期值

```bash
# 1. 确认 JSON 合法
python3 -m json.tool <projectRoot>/.qwen/settings.json

# 2. 开一个新会话，不发消息，直接 /context detail
#    读 isEstimated 快照的 "Built-in tools" 总数
```

| 白名单                 | builtinTools 预期 | 降幅 |
| ---------------------- | ----------------: | ---: |
| 改动前                 |            21,461 |    — |
| 保守版（含 `agent`）   |         **9,481** | −56% |
| 激进版（不含 `agent`） |         **5,868** | −73% |

**没变化 = 配置没被接受**，按 §2.3 的三条逐一排查（先看是不是写漏了、再看 scope 覆盖、再开 debug 日志看 `Unknown setting`）。

### 2.6 降级的代价与运营指标（已核实的成本模型）

`docs/design/toolsearch-preload-threshold.md` 说明了权衡：**一次会话中途的 `tool_search` 揭示会重写函数声明列表，而它在前缀最前面，整段 prompt KV 缓存作废。**

按该部署的价格（输入 ¥12/百万，隐式缓存命中 ¥2.4/百万）与前缀规模测算：

|                               |                                  金额 |
| ----------------------------- | ------------------------------------: |
| 降级 17,361 token，每会话节省 |                                ¥0.625 |
| 一次中途揭示的前缀重建        |                                ¥0.282 |
| 揭示 0 / 1 / 2 / 3 次的净收益 | +0.625 / +0.343 / +0.061 / **−0.221** |

> **运营指标：每会话 `tool_search` 调用次数 ≤ 2。超过 3 次，降级就是净亏。**

这正好对应原需求里的验收项「因路由遗漏导致需要重新请求工具的比例保持在可接受范围」。

推论：**单独降级小工具不划算**，因为重建成本是固定的。各工具单独降级的盈亏平衡使用率：`workflow` <49% · `agent` <46% · `cron_create` <14% · `report_findings` <13% · `record_artifact` <11% · `update_goal` <10% · `notebook_edit` <4%。所以降级要**批量做**，小工具搭便车。

**相关上游 PR：[#10410](https://github.com/QwenLM/qwen-code/pull/10410)（open）`preserve prompt cache for deferred tools`** —— 它一旦合入，上述重建成本大幅下降，这条 ≤2 的规则可以放宽。值得把本节的实测数据贴到该 PR 下推动它。

---

## 3. 第二步：上下文文件（最大的一刀，仍是 0 代码）

### 3.1 现状（已核实）

每个**已启用** extension 的上下文文件都会被无条件拼进每一轮请求的系统提示词层：

`packages/core/src/extension/extensionManager.ts:1710-1714` → `packages/core/src/config/config.ts:8958-8966`（唯一过滤条件是"extension 处于启用状态"）→ `packages/core/src/memory/memoryDiscovery.ts:201-204` → `:385-406`（原样拼接，**无大小上限、不截断、不按 extension 归因**）→ `packages/core/src/core/prompts.ts:698-706`。

该部署 9 个 extension 合计 **9,989 token**（由大到小 2,164 / 1,602 / 1,548 / 1,487 / 1,124 / 1,078 / 650 / 172 / 164），另有父目录 `QWEN.md` 4,021、auto-memory 1,180、输出语言文件 210。**extension 占整个常驻上下文层的 65%。**

唯一的告警是 `packages/core/src/config/config.ts:4702-4727`，阈值 `MEMORY_CONTEXT_WARNING_RATIO = 0.15`——**1M 窗口下要到 150,000 token 才触发**，所以 15,400 一声没响（同属 [#12029](https://github.com/QwenLM/qwen-code/issues/12029) 的参数化问题）。

### 3.2 应该改成什么

extension 的内容按性质分三层：

| 内容性质                                       | 放哪                                                                            | 常驻成本                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| 永远成立的少量事实（身份、术语、硬约束）       | `contextFileName`                                                               | 常驻，应当很小               |
| 场景性指引（怎么写查询、怎么配调度、怎么排障） | **`paths:` 门控的 skill**                                                       | 清单 100–200 token，正文按需 |
| 固定流程                                       | saved workflow（见 [#11631](https://github.com/QwenLM/qwen-code/issues/11631)） | 只写名字                     |

依据：extension **可以**携带 skill（`extensionManager.ts:1715-1717`），skill 支持 `paths:` 条件激活（`packages/core/src/skills/types.ts:155-157` + `packages/core/src/skills/skill-activation.ts:42-56`）；而 `.qwen/rules/` 的条件机制**不对 extension 开放**（`packages/core/src/config/rulesDiscovery.ts:305-324`）。更新的 `agent-plugins-v1` 格式已经完全跳过 `contextFileName`、只带 skill（`extensionManager.ts:1702-1705`）——方向上游已经选了。

参照：默认系统提示词里 `## New Applications` 整段只有 214 字符，内容是"去调 `skill="new-app"`"。把大段用法外置成 skill 是上游自己在用的写法。

### 3.3 待执行

```bash
wc -c ~/.qwen/extensions/*/QWEN.md
ls ~/.qwen/extensions/*/skills/
```

然后**从最大的两个 extension 开始**（2,164 + 1,602 = 3,766，占 38%），逐段判断归属并迁移，验证效果后再铺开其余 7 个。

预期：15,400 → 约 5,000。

---

## 4. 第三步：工具输出（原计划里没有，可能最大）

一个 15 轮的真实会话，对话部分增长 18,533 token，其中 **53% 来自两次工具输出**：

- 一次 `read_file` 读一个 **151,066 行**的状态 JSON 的前 1000 行 = **+6,779 token**
- 一次 skill 正文加载 = **+3,029 token**

关键差别：**schema 是稳定前缀、能命中缓存打两折；工具输出每次都是新内容，永远全价。**

该部署的缓存命中率实测 **92.8%**（15 次调用，总输入 906,871，已缓存 841,520）。所以工具输出的边际成本是 schema 的 5 倍。

**待执行**：从会话记录统计工具输出占对话 token 的比例。若显著，优先级应高于 §3。治理手段：结果截断/分页、只读需要的片段、用 subagent 隔离大输出。

---

## 5. 第四步：系统提示词（建议最后做）

**5,253 token 已在健康线 4–5k 内。** 不改上游能省的只有 **775**：output style 的 `keepCodingInstructions: false` 精确删掉 `## Software Engineering Tasks`（3,068 字符，`packages/core/src/core/prompts.ts:369-372`），不多不少。

⚠️ 这一段里含下面锚点列表中的 `- **Report outcomes faithfully:**`（`prompts.ts:285`，位于 `getSoftwareEngineeringTasksSection`）。若采用该开关，须在该 output style 的 `prompt` 正文中补回这条，否则静态检查必然失败。**待验证**：开启后跑一次 `QWEN_WRITE_SYSTEM_MD` 导出——注意它导出的是不带 style 的基础提示词，所以要看的是会话实际发出的系统指令里 `Report outcomes faithfully` 是否仍在。

**不建议整体替换**（`--system-prompt` / `QWEN_SYSTEM_MD`）：默认提示词里约 6,349 字符（30.5%）是安全与行为边界——被拒工具调用不得绕路、hook 注入内容不算用户输入、危险操作四分类、不泄露密钥、如实汇报。替换后要自己维护副本，而 `prompts.ts` 上游约每周 2 次提交，脱节了不会有任何测试失败。对于 skill 中大量存在生产写确认、`fail-closed`、禁止 `DROP TABLE` 一类约束的部署，这层兜底尤其不该动。

可 grep 断言的安全条款锚点（若最终仍要裁剪，用它们做静态检查）：`**UserPromptSubmit Context:**` · `**Denied Tool Calls:**` · `**Respect Tool Decisions:**` · `**Preserve Existing Work:**` · `**Explain Critical Commands:**` · `**Security First:**` · `- **Report outcomes faithfully:**` · `Carefully consider the reversibility` · `- Destructive operations:` · `- Hard-to-reverse operations:` · `- Actions visible to others` · `- Uploading content to third-party` · `When you encounter an obstacle`。

---

## 6. 影响面清单（上线前逐条过）

| #   | 项目                        | 结论                                                                                                                                                                                                                       |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **subagent**                | ⚠️ 见 §2.4。`tools.eager` 降级会过滤 subagent 的显式 tools 列表，静默失效                                                                                                                                                  |
| 2   | 后台记忆 agent              | ✅ 它依赖的 6 个工具（read_file/grep_search/glob/shell/write_file/edit）全在白名单里                                                                                                                                       |
| 3   | token 换类别                | ⚠️ 去掉 `grep_search`/`glob` 后模型会改用 shell 的 `find`/`grep`，输出进对话上下文。**验收必须看每任务总 input token，不能只看非对话几类**                                                                                 |
| 4   | 旧会话恢复                  | ✅ 历史里引用过的降级工具会自动补发 schema（`packages/core/src/core/client.ts:1783-1822`）；被 deny 的不会                                                                                                                 |
| 5   | skill 的 `allowedTools`     | ✅ 只给自动放行，不声明也不加载工具（`packages/core/src/skills/types.ts:38-56`）。降级不影响，deny 会在运行时失败                                                                                                          |
| 6   | 作用域外溢                  | ⚠️ `permissions.deny` 写在 settings 里会作用于所有读这份 settings 的客户端；配置应放工作区级                                                                                                                               |
| 7   | DeepSeek 系模型             | ⚠️ 不适用于本部署，但若换模型：`packages/cli/src/config/config.ts:1993-2013` 会把 `tool_search` 推进 deny 列表并**主动揭示所有延迟工具**。注释说明这是有意的（DeepSeek 前缀缓存折扣最高到 1/120，稳定前缀比省 token 值钱） |
| 8   | `tools.disabled` 的已知缺口 | ⚠️ [#11814](https://github.com/QwenLM/qwen-code/issues/11814)：`zoom_image` 已移出 registry 但 schema 仍会发给模型。**以"被禁用工具不得出现在请求 schema 中"为验收项的部署需要关注**                                       |

---

## 7. 待决策（不是验证，需要人拍板）

1. **`agent` 留常驻还是降级**（3,613 token）。盈亏平衡是「用到 subagent 的会话占比 < 46%」。先测：`grep -l '"name":"agent"' <chats目录>/*.jsonl | wc -l` 除以总会话数。
2. **验收指标是否改写**。原指标「内置工具相比 20.6k 降低 50%」可以靠把 token 从工具挪进消息来假性达成；建议改成 **「空载成本 ≤ 15k」**，这个挪不动。
3. **是否推动上游 [#10410](https://github.com/QwenLM/qwen-code/pull/10410)**。它直接决定 §2.6 那条 ≤2 次的规则能不能放宽。
4. **是否切显式缓存**。该部署实测缓存命中 92.8%，显式缓存按 10% 计价、隐式按 20%——若当前是隐式，切显式可将输入成本再砍一半，且不改变任何行为。这可能是整个清单里性价比最高的一项。

---

## 8. 请报告回来什么

1. §2.5 的 `builtinTools` 实测值（预期 9,481 或 5,868）；若无变化，附上 debug 日志里的 `Unknown setting` 行与它报的 settings 路径。
2. §2.4 的 subagent 清单及各自的 `tools` 字段。
3. §3.3 两条命令的输出。
4. 3–5 个"真干过活"的长会话记录（`<QWEN_HOME>/projects/*/chats/*.jsonl`），用于算 §4 的工具输出占比与上下文增长曲线。每条 `assistant` 记录里的 `usageMetadata.promptTokenCount` 就是完整的增长曲线。
5. 改动后同一任务的每任务总 input token（§6 第 3 条）——防止 token 只是换了类别。
6. **本文档中任何与实测不符的结论**。所有代码位置读自 `origin/main` 而非部署所用版本，运行时结论来自单一部署的少量样本。
