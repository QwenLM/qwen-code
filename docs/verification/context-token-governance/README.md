# 交接：非对话上下文 Token 治理的验证与落地

配套方案：[`docs/plans/2026-09-16-non-conversation-context-token-governance.md`](../../plans/2026-09-16-non-conversation-context-token-governance.md)
上游跟进：[#12028](https://github.com/QwenLM/qwen-code/issues/12028)（伞）· [#12029](https://github.com/QwenLM/qwen-code/issues/12029) · [#12030](https://github.com/QwenLM/qwen-code/issues/12030) · [#12032](https://github.com/QwenLM/qwen-code/issues/12032) · [#12033](https://github.com/QwenLM/qwen-code/issues/12033) · [#12037](https://github.com/QwenLM/qwen-code/issues/12037)

> **这份文档里的所有代码位置都是读 `origin/main`（2026-09-16，`c46933ce56`）得出的，没有跑过任何构建或测试。**
> **所有运行时数字来自一个真实部署的 `/context detail` 与会话记录，不是基准测试。**
> 每一节都标注了「已核实 / 待验证 / 待决策」。
>
> **⚠️ 2026-09-20 起点已变，先读 §0.1 再读别的。** `v0.24.2` 含 [#10410](https://github.com/QwenLM/qwen-code/pull/10410)，它改了默认行为，使 §1 的基线与 §2.6 的成本模型**双双作废**。**任何验证都必须先在 ≥ 0.24.2 上重新取基线**，否则会把 #10410 免费带来的收益记到白名单头上。

---

## 0. 一句话

这件事约 95% 是配置和内容组织，不是代码。上游的延迟加载机制（ToolSearch + `tools.eager`）从 2026-04 就在做，已经可用；需要做的是**把它打开**，并把常驻的知识挪到按需层。

---

## 0.1 2026-09-20 更新：`v0.24.2` 改变了起点（**先做这一节**）

### 变了什么

`v0.24.2`（2026-09-20 14:12 发布，含 [#10410](https://github.com/QwenLM/qwen-code/pull/10410)，squash 提交 `70edbf47`）把"揭示一个延迟工具"从**改写声明列表**换成了 `tool_search` → `tool_call` **桥接**：声明列表保持字节稳定，因此**会话中途取用一个延迟工具不再作废 prompt 前缀缓存**。基于这一点，`tools.toolSearch.threshold` 的**默认值从 `10` 改为 `0`**。

两个直接后果：

1. **按需加载现在默认真的生效了。** 此前默认 10 意味着"延迟池总量 < 窗口 10% 就在开场全部预加载"，而 1M 窗口下这个条件永远满足——也就是说**过去看到的"一上来几万"里，有一块是本该按需的工具被预加载回去了**。现在零配置就不再预加载。
2. **§2.6 的成本模型整节作废。** 那一节算的是"一次中途揭示 ≈ ¥0.28–0.40 重建前缀、因此 `tool_search` ≤2 次/会话"。桥接之后，中途取用的代价是**首次使用前多一次往返**，不是一次前缀重算。平衡点、40 轮、≤2 次这些数字都不再成立。

### 这一节的其余内容哪些还成立

| 小节                              | 状态                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| §1 实测基线（21,461 / 47,931 等） | **作废**，必须在 ≥ 0.24.2 上重测                                                                                           |
| §2.1–2.5 白名单的机制与语义       | **仍成立**，但豁免族多了 `tool_call`（桥接的另一半），写进白名单也无效                                                     |
| §2.4 子 agent 会拿到全量延迟工具  | **仍成立**（2026-09-20 复核：`agent-core.ts` 仍用 `getFunctionDeclarations({ includeDeferred: true })`），仍是唯一的真风险 |
| §2.6 降级的成本模型与运营指标     | **作废**，见上                                                                                                             |
| §3 上下文文件                     | 仍成立；机制侧另有进展：extension 现在可以贡献 `paths:` 条件规则（#12030 已由 #12034 实现）                                |
| §4 工具输出                       | 仍成立，未验证                                                                                                             |
| §5 系统提示词                     | 仍成立（#12032 已由 #12145 实现，实测只省约 276 token，价值在正确性）                                                      |
| §6 影响面清单                     | 部分作废：第 7 行断言的 DeepSeek 自动退出已被 #10410 删除，已在 §6 就地更正                                                |
| §7 待决策                         | 第 3 条已收口（#10410 已合入并随 `v0.24.2` 发布，见本节开头）；其余仍待决策                                                |

### 重新取基线：第 0–1 步

```bash
qwen --version        # 必须 ≥ 0.24.2；0.24.1 及之前不含 #10410，会量到旧行为
```

新会话**第一轮**（对话为空时，看到的全部是前缀）执行：

```
/context detail
```

**预期**：内置工具那一类应显著低于原先实测的 21,461。**推算约 17,300**（差额即不再预加载的按需池，原测约 4.2k）——**这是推算，不是实测，你这次的读数就是新的事实**。

**若仍接近 21,461**，按顺序查三件事：① 版本是否真的 ≥ 0.24.2；② `settings.json` 里是否**显式**写了 `tools.toolSearch.threshold: 10`（显式值覆盖新默认）；③ 是否有 `tools.visible` 把那些工具强行拉回常驻。

### `v0.24.2` 对既有行为的风险（需要担心的不只延迟加载一条）

按 `packages/core/src/{tools,permissions}` 口径统计，`v0.24.1...v0.24.2` 之间去重后有 15 个非测试文件变更。**紧接的提交清单不用这个目录口径**，而是按主题（与工具/权限/注册表相关）：共 6 个 —— #10410、#12142、#12271、#12198、#12096、#12346。两个口径的差别是实的，照上面那套"非测试 + 这两个目录"去数会得到 3 个而不是 6 个：#12198 的 21 个文件里**没有一个**落在这两个目录下，#12271 与 #12346 在这两个目录下只碰**测试**文件（分别是 `tools/read-file.test.ts`、`permissions/eager-surface-report.test.ts`）；符合该口径的是 #10410、#12142、#12096。**改变了默认行为的不只 #10410 一个**：**#12096 改变了带注释 Bash 命令的权限判定**（`echo 'a' # comment ; …` 一类命令的 deny→ask / deny→allow 翻转，`packages/core/src/permissions/permission-manager.ts` +98/−5，无开关门控）；**#12198 改变了未决工作区的信任门控**（`isTrustedFolder()` 的未决默认值从 `?? true` 改为 `?? !this.folderTrust`）。#12142（teammate 指引按 team 开关门控 + 体积预算测试）与 #12271（`zoom_image` 提示按可达性发送）是门控与提示，#12346 是纯测试。区间内另有 #12119 重写了 `/context detail` 的分类推导口径（影响 §8 第 0 条的升级前后对比，见该条），#12034 新增了 `MEMORY_CONTEXT_WARNING_MAX_TOKENS = 10_000` 默认上限。

所以风险分两类——默认延迟，与上面两个无开关的行为翻转：

| 风险                                     | 代价                                                                                                                                    | 怎么尽快发现                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 首次使用某个延迟工具前多一次往返         | 延迟 + 一轮                                                                                                                             | 会话里观察是否出现 `tool_search` → `tool_call` 两步        |
| **模型压根没想到去找**（路由未命中）     | **静默**：能力不再被使用，不报错                                                                                                        | 对比升级前后同类任务的成功率；以及"某个工具的调用频次归零" |
| MCP 较多的部署变化最大                   | 之前 MCP 工具只要塞得进窗口 10% 就被预加载，现在全在桥接后面                                                                            | 先看 `/context detail` 里 MCP 那一类是否归零               |
| 桥接两半缺一                             | 普通延迟工具回退为急加载（安全）；被 `tools.eager` 降级的工具不再向模型提供、也无法经桥接加载（仍注册，按名直呼仍走正常审批），并记警告 | 检查日志里的相关 warning                                   |
| 带注释 Bash 命令的权限判定翻转（#12096） | 此前被 deny 的带注释命令可能变为 ask，或在宽泛 `Bash(echo *)` 规则下变为 allow                                                          | 拿带注释的命令重新核对现有 `Bash(...)` deny 规则           |
| 未决工作区的信任门控收紧（#12198）       | 升级后未表态的工作区按不信任处理，需重新确认 trust                                                                                      | 升级后首次启动是否弹出 trust 确认                          |

**一行回滚**（只回滚默认延迟这一条；#12096/#12198 的行为翻转没有开关，只能按上表逐条核对）：

```jsonc
{ "tools": { "toolSearch": { "threshold": 10 } } }
```

显式值会覆盖新默认，重启会话即恢复 `v0.24.1` 的预加载行为。**先量再回滚**——否则你会把"没量到的收益"也一起退掉。

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

**豁免名单**（列不列都常驻）：`ask_user_question` 751 · `exit_plan_mode` 592 · `enter_plan_mode` 343 · `tool_search` 394 · `tool_call` 148；另有 `mcp__*`、`structured_output`、`computer_use__*` 同样豁免。合计约 **2,230 token 的地板**。

> **2026-09-20 更正**：原文写的地板是 2,163（含 `task_stop` 102、`tool_search` 375、且没有 `tool_call`）。三处都变了——`tool_call` 是 #10410 新增的桥接另一半、豁免且常驻（实测 148）；`tool_search` 已从 375 漂到 394；`task_stop` 自身 `shouldDefer=true`，本来就不常驻、不该计入。上面这几个数字来自评审在本仓已构建产物上用快照自带的估算器实测（不是我测的），**按你自己的 `/context detail` 读数为准**。

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

关键差别：新工具输出首次进入请求时增加输入；后续包含该输出的不变历史也可能命中前缀缓存。不能把 schema 视为始终命中、工具输出视为始终未命中；应分别统计整项任务的缓存与非缓存输入。

该部署的缓存命中率实测 **92.8%**（15 次调用，总输入 906,871，已缓存 841,520）。这是整个请求集合的命中率，不能据此认定工具输出的边际成本固定为 schema 的 5 倍；需要结合每轮新增输出、后续复用和对应的 provider usage 评估。

**待执行**：从会话记录统计工具输出占对话 token 的比例。若显著，优先级应高于 §3。治理手段：结果截断/分页、只读需要的片段、用 subagent 隔离大输出。

---

## 5. 第四步：系统提示词（建议最后做）

**5,253 token 已在健康线 4–5k 内。** 不改上游能省的只有 **775**：output style 的 `keepCodingInstructions: false` 精确删掉 `## Software Engineering Tasks`（3,068 字符，`packages/core/src/core/prompts.ts:369-372`），不多不少。

⚠️ 这一段里含下面锚点列表中的 `- **Report outcomes faithfully:**`（`prompts.ts:285`，位于 `getSoftwareEngineeringTasksSection`）。若采用该开关，须在该 output style 的 `prompt` 正文中补回这条，否则静态检查必然失败。**待验证**：开启后跑一次 `QWEN_WRITE_SYSTEM_MD` 导出——注意它导出的是不带 style 的基础提示词，所以要看的是会话实际发出的系统指令里 `Report outcomes faithfully` 是否仍在。

**不建议整体替换**（`--system-prompt` / `QWEN_SYSTEM_MD`）：默认提示词里约 6,349 字符（30.5%）是安全与行为边界——被拒工具调用不得绕路、hook 注入内容不算用户输入、危险操作四分类、不泄露密钥、如实汇报。替换后要自己维护副本，而 `prompts.ts` 上游约每周 2 次提交，脱节了不会有任何测试失败。对于 skill 中大量存在生产写确认、`fail-closed`、禁止 `DROP TABLE` 一类约束的部署，这层兜底尤其不该动。

可 grep 断言的安全条款锚点（若最终仍要裁剪，用它们做静态检查）：`**UserPromptSubmit Context:**` · `**Denied Tool Calls:**` · `**Respect Tool Decisions:**` · `**Preserve Existing Work:**` · `**Explain Critical Commands:**` · `**Security First:**` · `- **Report outcomes faithfully:**` · `Carefully consider the reversibility` · `- Destructive operations:` · `- Hard-to-reverse operations:` · `- Actions visible to others` · `- Uploading content to third-party` · `When you encounter an obstacle`。

---

## 6. 影响面清单（上线前逐条过）

| #   | 项目                        | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **subagent**                | ⚠️ 见 §2.4。`tools.eager` 降级会过滤 subagent 的显式 tools 列表，静默失效                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | 后台记忆 agent              | ✅ 它依赖的 6 个工具（read_file/grep_search/glob/shell/write_file/edit）全在白名单里                                                                                                                                                                                                                                                                                                                                                              |
| 3   | token 换类别                | ⚠️ 去掉 `grep_search`/`glob` 后模型会改用 shell 的 `find`/`grep`，输出进对话上下文。**验收必须看每任务总 input token，不能只看非对话几类**                                                                                                                                                                                                                                                                                                        |
| 4   | 旧会话恢复                  | ✅ 历史里引用过的降级工具会自动补发 schema（`packages/core/src/core/client.ts:1783-1822`）；被 deny 的不会                                                                                                                                                                                                                                                                                                                                        |
| 5   | skill 的 `allowedTools`     | ✅ 只给自动放行，不声明也不加载工具（`packages/core/src/skills/types.ts:38-56`）。降级不影响，deny 会在运行时失败                                                                                                                                                                                                                                                                                                                                 |
| 6   | 作用域外溢                  | ⚠️ `permissions.deny` 写在 settings 里会作用于所有读这份 settings 的客户端；配置应放工作区级                                                                                                                                                                                                                                                                                                                                                      |
| 7   | DeepSeek 系模型             | ⚠️ 不适用于本部署。**2026-09-20 更正**：#10410 已删除按模型名自动退出 ToolSearch 的分支，`packages/cli/src/config/config.ts` 里已无任何 `deepseek` 引用；现在唯一的桥接开关是显式 `tools.toolSearch.enabled: false`（`packages/cli/src/config/config.ts` 里的 `shouldDisableToolSearch`，它会同时 deny `tool_search` 与 `tool_call`；引符号名而不引行号，行号会随文件漂移）。换用前缀缓存模型的部署若想要旧的「全部急揭示」行为，需手工设置该开关 |
| 8   | `tools.disabled` 的已知缺口 | ⚠️ [#11814](https://github.com/QwenLM/qwen-code/issues/11814)：`zoom_image` 已移出 registry 但 schema 仍会发给模型。**以"被禁用工具不得出现在请求 schema 中"为验收项的部署需要关注**                                                                                                                                                                                                                                                              |

---

## 7. 待决策（不是验证，需要人拍板）

1. **`agent` 留常驻还是降级**（3,613 token）。盈亏平衡是「用到 subagent 的会话占比 < 46%」。先测：`grep -l '"name":"agent"' <chats目录>/*.jsonl | wc -l` 除以总会话数。
2. **验收指标是否改写**。原指标「内置工具相比 20.6k 降低 50%」可以靠把 token 从工具挪进消息来假性达成；建议改成 **「空载成本 ≤ 15k」**，这个挪不动。
3. ~~**是否推动上游 [#10410](https://github.com/QwenLM/qwen-code/pull/10410)**~~ **已收口**：#10410 已于 2026-09-20 合入（`70edbf47`）并随 `v0.24.2` 发布；§2.6 的成本模型随之作废，见 §0.1。
4. **是否切显式缓存**。该部署实测缓存命中 92.8%，显式缓存按 10% 计价、隐式按 20%——若当前是隐式，切显式可将输入成本再砍一半，且不改变任何行为。这可能是整个清单里性价比最高的一项。

---

## 8. 请报告回来什么

0. **（新，最先做）§0.1 的重新取基线读数**，填这张表——**第 2 行必填**（§0.1 已把它定为任何验证的前提）；第 1 行只在还留着升级前的环境时填，缺它就用 §0.1 推算的 ~17,300 代替；第 3 行是白名单归因所必需，做到了再填：

   |                           | `/context detail` 内置工具 | 首轮 input token | 每会话 `tool_search` 次数 | 版本 |
   | ------------------------- | -------------------------: | ---------------: | ------------------------: | ---- |
   | 升级前（若还留着旧环境）  |                            |                  |                           |      |
   | `≥ 0.24.2`，未改任何配置  |                            |                  |                           |      |
   | 加上 `tools.eager` 白名单 |                            |                  |                           |      |

   第二行减第一行 = #10410 白送的量（我推算约 4.2k）；第三行减第二行 = 白名单真正的贡献（我推算约 11.4k）。**这两个归因分开，是这次重测唯一的目的**——合在一起算会把上游的收益记到你的配置头上。注意：**#12119 在同一版本重写了 `/context detail` 的分类推导口径**，升级前的读数与 ≥0.24.2 的读数是两台不同的量具——所以两行都要记录**完整的 `/context detail` 输出**，不要只记内置工具这一个类别的数字。

   ⚠️ **但第一行与第二行不是同一把尺子。** 同一个 `v0.24.2` 里还含 #12119（`ef16196c`），它重写了 `/context detail` 里内置工具那一行的推导方式。所以升级前后的两个读数**是两台仪器量出来的**，直接相减会把口径差混进去。**两次都请保留 `/context detail` 的完整输出**（不只记内置工具那一个数），这样口径差事后还能被识别；如果只能留一个数字，第一行就只能当参考、不能当基线。

1. §2.5 的 `builtinTools` 实测值（预期 9,481 或 5,868；**注意这两个预期值是 `v0.24.1` 口径的，`≥ 0.24.2` 上应更低**）；若无变化，附上 debug 日志里的 `Unknown setting` 行与它报的 settings 路径。
2. §2.4 的 subagent 清单及各自的 `tools` 字段。
3. §3.3 两条命令的输出。
4. 3–5 个"真干过活"的长会话记录（`<QWEN_HOME>/projects/*/chats/*.jsonl`），用于算 §4 的工具输出占比与上下文增长曲线。每条 `assistant` 记录里的 `usageMetadata.promptTokenCount` 就是完整的增长曲线。
5. 改动后同一任务的每任务总 input token（§6 第 3 条）——防止 token 只是换了类别。
6. **本文档中任何与实测不符的结论**。所有代码位置读自 `origin/main` 而非部署所用版本，运行时结论来自单一部署的少量样本。
7. **升级到 `v0.24.2` 后是否出现路由未命中**：某个此前常用的工具调用频次归零、或同类任务成功率下降。这是默认延迟唯一的静默失败模式，目前**没有自动化闸门**（缺口见 [#12333](https://github.com/QwenLM/qwen-code/issues/12333)：本仓那半已由 #12346 合入，A/B 那半需要 benchmark 池给 `submit` 加 settings 覆盖能力）。所以这一条只能靠你这边的观察，**它比前面任何一个 token 数字都重要**。
