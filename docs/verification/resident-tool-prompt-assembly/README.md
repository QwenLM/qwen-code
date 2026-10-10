# 交接：按常驻工具集装配系统提示词的验证

配套方案：[`docs/design/2026-09-18-resident-tool-prompt-assembly.md`](../../design/2026-09-18-resident-tool-prompt-assembly.md) · [中文](../../design/2026-09-18-resident-tool-prompt-assembly.zh-CN.md)
实现：PR #12145（issue #12032，属于伞 #12028）

> **本文档中的所有数字都是静态推算，没有在任何真实会话中实测过。** 实现者（这台机器）不执行构建与测试，CI 只证明单元测试通过——它不证明 token 真的下降，也不证明别的模块没被影响。这两件事是本文档要交出去做的。
> 每节都标注了「已核实 / 待验证 / 待决策」。先读第 1 节，它决定后面值不值得做。

---

## 0. 一句话

门控按会话实际声明的工具集裁剪指导，并保留桥接可达的 Agent 的两条委派指引。**不传声明快照或声明全部工具时，门控不删任何内容**；这不等于真实 CLI 的默认配置，因为 `monitor` 默认延迟加载，首次声明集合通常不含它。测量 `tools.eager` 的额外收益时，应比较同一版本、同一模型和同一会话阶段的实际声明集合与 Agent 可达性。

---

## 0.5 哪些已经由 CI 覆盖，不用再手工做

`prompts.test.ts` 已有以下结构化测试；合并前仍需确认当前 HEAD 的 CI 结果，不能把历史通过记录当作当前验证：

| 已自动覆盖                                                           | 测试                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 无快照与声明全部工具的渲染一致                                       | 17 份完整提示词快照 + `renders identically when every tool is declared`                                                                                                                                  |
| 无快照到文件白名单的节省量按 Agent 可达性区分                        | `saves about 1.1k characters of policy text for a file-work allowlist when Agent is not bridge-reachable`；`saves only the monitor policy text for a file-work allowlist when Agent is bridge-reachable` |
| 只有两个被门控段落发生变化                                           | `changes nothing outside the two gated sections`                                                                                                                                                         |
| 被门控段落只出现已声明工具，或桥接可达的 Agent（机械扫描全部工具名） | `never names an undeclared tool inside the gated sections`                                                                                                                                               |
| code mode 完全不受门控影响（反向检查）                               | `leaves CodeModeOnly guidance untouched by the declared set`                                                                                                                                             |
| 快照确实从 `Config` 传到提示词构建器                                 | `keeps Agent guidance when Agent is bridge-reachable`（#13033 重命名后同时断言 `getPromptAgentReachable()` 快照）                                                                                        |

**因此这份文档只剩两类事需要真实会话：** 一是**真实请求的 token 是否真的下降**（单元测试只能量字符数，量不到 provider 的计费口径，也证明不了 `tools.eager` 在你们部署上真的被接受）；二是**召回率与其他模块在真实会话中的表现**（§5、§6）。

---

## 1. 预期收益（静态推算，待验证）

被门控的只有两段：`## Using Your Tools` 的部分条目，以及 `# Examples` 中的示例块。以下是第二轮精简（PR #12546）后、**Todo 关闭**（未设 `tools.todoWrite.enabled`）时的 direct 模式口径；文件七件套指 read_file / write_file / edit / glob / grep_search / run_shell_command / skill，加上豁免工具：

| 对比基线 → 文件七件套白名单                                                                  | 节省字符 | 节省 UTF-8 字节 | 移除内容                                                     |
| -------------------------------------------------------------------------------------------- | -------: | --------------: | ------------------------------------------------------------ |
| 无声明快照（假定全部工具可用），白名单侧 Agent 不可达                                        |    1,135 |           1,139 | Subagent Delegation、Codebase Search、Monitor Processes 三条 |
| 基线已不声明 monitor，且白名单侧 Agent 被 `tools.disabled: ["agent"]` 整体移除（桥保持完整） |      818 |             822 | Subagent Delegation、Codebase Search 两条                    |

字符采用 JavaScript `string.length` 口径，字节采用 UTF-8 口径；`wc -c` 量的是字节，不能直接与字符数比较。两种对比都保留全部示例，因为示例只调用文件类工具和 shell。若继续移除 `edit`、`write_file`、`glob` 或 shell，示例也会被裁剪，必须按当前模型模板重新测量，不能沿用旧版范围。若 A/B 两边都开启 Todo，B 还会少 `- **Task Management:**` 一条（228 字符——该条按 `todo_write` 是否被**声明**门控，见 `prompts.ts` 的 `TOOL_GUIDANCE_LINE_GATES`，而 `todo_write` 不在文件七件套内）：无快照行差值变为 1,364 字符 / 1,368 字节，monitor 未声明行变为 1,047 字符 / 1,051 字节。

上表两行的白名单侧都须额外在 settings 里设 `tools.disabled: ["agent"]` 才能让 Agent 真正不可达——`tools.eager` 名单做不到这一点（桥接两件套免于白名单降级，Agent 始终可通过桥接调用，可达性例外因此总是生效）。两行数字分别描述各自基线在这一配置下的差值。

这些数字不是 token 计费数据，也不是所有真实 CLI 配置的固定收益。默认延迟加载的 `monitor` 若在 A/B 两边均未声明，就不能把它的 317 字符算入 A/B 差值。

> **更正：** 本文档早先版本写的"节省 4,012 字符 / 约 1,003 token"是错的。那个数字出自一个有 bug 的静态脚本——它解析 `tool-names.ts` 时把 `ToolDisplayNames` 混进了工具名表，`ReadFile` 覆盖了 `read_file`，导致所有示例块被误判为"调用了未声明工具"而算作节省。修正后的数字见上表。

基础提示词、工具 schema 和上下文文件的总量随版本与会话变化；不再沿用旧版字符数推断当前 token 降幅。**本改动的主要价值是正确性（不再向模型推荐不可调用的工具），而不是承诺固定 token 收益。** 工具声明裁剪与提示词门控的收益应分别归因。

**待决策：** 按这个量级，这个改动值不值得承担 §5 的风险，是产品判断。

---

## 2. 测量一：提示词本身降了多少（0 代码，最直接）

不需要改任何代码，用现成的 `QWEN_WRITE_SYSTEM_MD` 把会话实际发出的基础提示词导出成文件，前后对比。导出路径同样接收了声明集合，因此导出的就是门控后的文本。

```bash
# A：默认配置（不设 tools.eager）
QWEN_WRITE_SYSTEM_MD=/tmp/prompt-default.md qwen -p "hi"

# B：裁剪配置。在 <projectRoot>/.qwen/settings.json 的 tools 对象里加：
#   "eager": ["read_file","write_file","edit","glob","grep_search","run_shell_command","skill"]
QWEN_WRITE_SYSTEM_MD=/tmp/prompt-eager.md qwen -p "hi"

wc -c /tmp/prompt-default.md /tmp/prompt-eager.md
diff /tmp/prompt-default.md /tmp/prompt-eager.md
```

**预期：** A/B 必须使用同一构建、模型、output style、Todo 状态及其他配置，并记录实际声明集合与 Agent 可达性。默认配置与文件七件套都保留完整桥接，且 `agent` 已注册并列在延迟摘要中时，即使 B 不直接声明 Agent，也会保留 Subagent Delegation 和 Codebase Search 两条（设计 §4.6）。Todo 关闭且 `monitor` 在两边均未声明时，两份提示词可以完全相同，预期差值为 **0 字节**。只有 B 侧把 Agent 整体移除（`tools.disabled: ["agent"]`，桥保持完整）时，才适用 §1 第 2 行的 818 字符 / 822 字节差值。Todo 或更窄白名单造成的其他差异须按实际声明与 diff 逐项归因，不使用历史总量作通过阈值。

**如果 B 和 A 一样大**，先用 `/tools` 及首个真实请求的 schema 确认设置是否被读取、白名单外工具是否按需加载，再核对 Agent 是否桥接可达。提示词相等本身不能证明 `tools.eager` 未被接受：声明裁剪仍可能生效，而 Agent 指引因可达性例外被保留。

---

## 3. 测量二：请求真的变小了（以账单为准）

提示词文件变小不等于请求变小。用两个口径核对：

1. **provider 的真实计数**：会话记录里第一条 `qwen-code.api_response` 的 `input_token_count`。这是账单依据。
2. **`/context detail` 的系统提示词一行**：分类估算值。注意 `/context` 的分类闭合问题正在 #12119（#12033）修，未合入前它的分类合计与总数可能对不上；系统提示词那一行本身可用。

**预期：** 系统提示词的下降量应与 §2 中实际移除的文本相符，不预设 1,000 token 阈值。`input_token_count` 还包含工具 schema 与其他上下文；不要把 `tools.eager` 裁剪 schema 的收益记到提示词门控头上。

**要分离两者的贡献**，跑三档：默认；只设 `tools.eager`；只设 `tools.eager` + 门控改动（本节「本 PR」指门控 PR #12145）。第二、三档的构建必须只差门控这一项：本文 §1 已改用第二轮精简（PR #12546）后的口径，若第三档构建同时带有 #12546，差值里会混入它删掉的未门控文本（该提交实测：非 git 1,197 字符 / 含 git 1,422 字符，见 `docs/design/2026-09-23-system-prompt-second-pass.md`），须先分离这部分变化，再按 §1/§2 的可达性条件核对实际提示词 diff。第三档相对第二档的差值，才是本改动的收益。

---

## 4. 正确性检查（比省 token 更重要）

> 这三条的**单元测试版本已经在 CI 里**（见 §0.5）。这里保留的是**真实会话**版本：它额外证明 settings 真的被读取、快照真的被记录，而不只是函数层面成立。

**第 1 条 · 无快照与声明全集的路径一致（已核实的机制）**
单元测试比较无声明集合与声明全部工具的渲染，17 份完整快照保护预期文本。第二轮精简会有意修改快照，不能据此要求跨版本的默认提示词逐字节一致；真实会话的 A/B 应使用同一构建，并按实际声明差异检查门控内容。

**第 2 条 · 不推荐不可调用的工具（声明与桥接可达性须一起检查）**

```bash
# 分类检查白名单外名称；Agent 桥接可达时允许保留两条委派指引
for t in agent web_fetch web_search notebook_edit list_directory monitor cron_create; do
  grep -n "$t" /tmp/prompt-eager.md | grep -vE '^\s*$' && echo "^^ $t 仍出现，核对声明、桥接可达性和所在段落（见下）"
done
```

**Agent 可达性例外：** `agent` 已声明，或已注册、桥接两端均可用且列在延迟摘要中时，Subagent Delegation 和 Codebase Search 两条允许点名 Agent。桥接不完整且 Agent 未声明时，两条都应删除。不能仅凭名称出现在提示词中判定回归（设计 §4.6）。

**已知残留（不是回归）：** `ask_user_question` 在被门控段落内仍无条件出现（它豁免于 `tools.eager`，且那条文案同时承载 headless 下"不得提问"的策略）。另外， `read_file` 在 persisted-output 条目与 plan mode 提醒里是无条件出现的，位于被门控段落之外；`subagent_type=Explore` 同样保持无条件；`# Task Management` 小节在 Todo 开启时保留并点名 `todo_write`，也位于被门控段落之外。设计文档 §4.3 与 §6 有记录。所以上面的检查只针对 `## Using Your Tools` 与 `# Examples` 两段。

**第 3 条 · 安全条款一条都没少**

```bash
for k in '**UserPromptSubmit Context:**' '**Denied Tool Calls:**' '**Respect Tool Decisions:**' \
         '**Security First:**' '**Explain Critical Commands:**' '**Report outcomes faithfully:**' \
         'did not run a verification step' \
         'Carefully consider the reversibility' '- Destructive operations:'; do
  grep -qF -- "$k" /tmp/prompt-eager.md || echo "缺失：$k"
done
```

预期无输出。注意 `**Report outcomes faithfully:**` 位于 `## Software Engineering Tasks` 段内，若该部署用了 `keepCodingInstructions: false` 的 output style，它会连带消失——那是另一件事，见伞 issue 方案文档中关于该开关的说明。

---

## 5. 影响面清单（逐条过，这是"对别的模块没影响"的依据）

| #   | 模块                  | 为什么可能受影响                                                                            | 怎么验                                                          | 预期                                                                                                                      |
| --- | --------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | 主会话（交互）        | 提示词内容变了                                                                              | 裁剪配置下跑几轮真实任务                                        | 文件类任务正常完成，不出现"调用不存在的工具"                                                                              |
| 2   | `/context`            | 它读同一份快照来生成提示词                                                                  | `/context detail` 的系统提示词一行                              | 与请求一致，不报错                                                                                                        |
| 3   | Arena                 | 它直接调 `getCoreSystemPrompt`，没有快照                                                    | `/arena --models a,b "简单任务"`                                | 同一构建内门控前后一致（无快照 = 不门控）；跨版本比较时，提示词精简（如 #12546）带来的文案差异属预期                      |
| 4   | 子 agent              | 定义型子 agent 渲染自己的提示词；fork 与恢复的后台 agent 逐字继承父级已渲染（已门控）的指令 | 用 `subagent_type: "fork"` 跑一次委派，与同一构建的父提示词对比 | 定义型子 agent 不受影响；fork / 恢复 agent 同一构建内与父提示词一致（继承是共享缓存前缀的前提），跨版本随父提示词有意变化 |
| 5   | output style          | `keepCodingInstructions: false` 与门控叠加                                                  | 选一个自定义 style 再看提示词                                   | 两者各自生效，不互相吃掉                                                                                                  |
| 6   | code mode             | 该模式下工具在 `exec` 内调用，实现里**明确不门控**                                          | `tools.codeModeOnly: true` 起一个会话                           | `tools.<name>` 那些条目一条不少                                                                                           |
| 7   | `QWEN_SYSTEM_MD` 覆盖 | 覆盖分支完全绕过默认提示词                                                                  | 设一个覆盖文件起会话                                            | 提示词就是该文件，门控不参与                                                                                              |
| 8   | 提示词缓存            | 静态前缀内容变了                                                                            | 同一会话连发 3 轮，看缓存命中 token                             | 命中率与改动前同阶；前缀只在会话开始时重写一次                                                                            |
| 9   | 压缩                  | 压缩走 `startChat`，会重算快照                                                              | 触发一次 `/compress`                                            | 压缩后提示词与压缩前一致（同一会话工具集没变）                                                                            |
| 10  | 恢复会话              | 恢复也走 `startChat`                                                                        | `--continue` 恢复一条旧会话                                     | 正常恢复，提示词按当前工具集门控                                                                                          |

第 6、7 条是**最容易被忽略的反向检查**：它们必须**没有**变化。

---

## 6. 召回率：没有现成设施，只能弱化验证（待决策）

仓库里没有 `evals/` 目录，唯一的 agent 任务测试台（`integration-tests/terminal-bench`）在其头部注明"仅手动运行，不在任何 CI 任务中"。所以"模型仍然选对工具"**无法在 CI 中断言**。

能做的弱化验证：

1. 在裁剪配置下，用 10–20 条该部署的真实任务（文件处理为主）各跑一次，记录：是否完成、调用了哪些工具、`tool_search` 被调用几次。
2. 与"只设 `tools.eager`、不带门控改动"的版本对比——两臂同样只能相差门控：第二轮精简（#12546）删改的是模型拿得到的通用规则文本，两臂必须同时带或同时不带它，否则成功率变化无法归因到门控。**关注方向而不是绝对值**：门控删掉的是模型本来就拿不到的工具的说明，因此成功率不应下降；如果下降了，说明删多了（例如某条策略条目对仍然存在的工具也有指导意义）。
3. `tool_search` 调用次数应当**不增加**。若增加，说明删掉的文本原本在引导模型别去找那些工具。

**待决策：** 这个弱化验证够不够。如果不够，先落一套最小 eval 设施再谈裁剪——这是伞 issue 里 #12054 也遇到的同一道闸门。

---

## 7. 请报告回来什么

1. §2 的版本、模型、实际声明集合、Todo 状态、`wc -c` 字节数与 diff 摘要，并注明 Agent 可达性；完整桥接、Todo 关闭且两边均未声明 monitor 时，默认配置与文件七件套提示词可同为 0 字节差值（见 §2）。
2. §3 三档的 `input_token_count` 与 `/context` 系统提示词一行。
3. §4 三条检查的输出及名称分类。第 2 条须区分已声明、Agent 桥接可达性例外、未门控残留和不可调用工具；例外名称出现不是失败。
4. §5 表格逐行结论，尤其第 6、7 条（必须无变化）。
5. §6 的任务集结果：成功率、工具调用分布、`tool_search` 次数，新旧对照。
6. **本文档中任何与实测不符的结论。** §1 的数字是静态推算，§5 的"预期"是按代码推断的，都可能错。

---

## 8. 未验证的前提，以及怎么推翻它们

- **「无快照与声明全集的路径一致」** 依赖"无快照即不门控"这条早退。推翻方式：在同一构建下分别传入无快照与工具全集，渲染出现差异即证伪；这不等于真实会话默认声明全部工具。
- **「字符减少代表计费 token 减少」** 不能仅靠字符数或粗略换算证明。以 provider 的 `input_token_count` 为准，并按 §3 分离工具 schema 的贡献。
- **「不影响子 agent 与 Arena」** 依赖它们不读快照。推翻方式：**同一构建内** §5 第 3、4 行的提示词 diff 出现差异（跨版本差异属预期，见 §4 第 1 条）。
- **「缓存前缀重写频率不变」** 依赖会话中途的揭示不重建提示词。推翻方式：会话中途触发一次 `tool_search`，若系统提示词随之变化即证伪。
