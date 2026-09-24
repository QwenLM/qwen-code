# 交接：按常驻工具集装配系统提示词的验证

配套方案：[`docs/design/2026-09-18-resident-tool-prompt-assembly.md`](../../design/2026-09-18-resident-tool-prompt-assembly.md) · [中文](../../design/2026-09-18-resident-tool-prompt-assembly.zh-CN.md)
实现：PR #12145（issue #12032，属于伞 #12028）

> **本文档中的所有数字都是静态推算，没有在任何真实会话中实测过。** 实现者（这台机器）不执行构建与测试，CI 只证明单元测试通过——它不证明 token 真的下降，也不证明别的模块没被影响。这两件事是本文档要交出去做的。
> 每节都标注了「已核实 / 待验证 / 待决策」。先读第 1 节，它决定后面值不值得做。

---

## 0. 一句话

门控按会话实际声明的工具集裁剪指导。**不传声明快照或声明全部工具时，门控不删任何内容**；这不等于真实 CLI 的默认配置，因为 `monitor` 默认延迟加载，首次声明集合通常不含它。测量 `tools.eager` 的额外收益时，应比较同一版本、同一模型和同一会话阶段的实际声明集合。

---

## 0.5 哪些已经由 CI 覆盖，不用再手工做

`prompts.test.ts` 已有以下结构化测试；合并前仍需确认当前 HEAD 的 CI 结果，不能把历史通过记录当作当前验证：

| 已自动覆盖                                             | 测试                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| 无快照与声明全部工具的渲染一致                         | 17 份完整提示词快照 + `renders identically when every tool is declared` |
| 无快照到文件白名单的节省量在预期区间（900–1,500 字符） | `saves about 1.1k characters of policy text for a file-work allowlist`  |
| 只有两个被门控段落发生变化                             | `changes nothing outside the two gated sections`                        |
| 被门控段落里不出现未声明的工具（机械扫描全部工具名）   | `never names an undeclared tool inside the gated sections`              |
| code mode 完全不受门控影响（反向检查）                 | `leaves CodeModeOnly guidance untouched by the declared set`            |
| 快照确实从 `Config` 传到提示词构建器                   | `takes the declared set from the Config snapshot`                       |

**因此这份文档只剩两类事需要真实会话：** 一是**真实请求的 token 是否真的下降**（单元测试只能量字符数，量不到 provider 的计费口径，也证明不了 `tools.eager` 在你们部署上真的被接受）；二是**召回率与其他模块在真实会话中的表现**（§5、§6）。

---

## 1. 预期收益（静态推算，待验证）

被门控的只有两段：`## Using Your Tools` 的部分条目，以及 `# Examples` 中的示例块。以下是第二轮精简（PR #12546）后的 direct 模式口径；文件七件套指 read_file / write_file / edit / glob / grep_search / run_shell_command / skill，加上豁免工具：

| 对比基线 → 文件七件套白名单              | 节省字符 | 节省 UTF-8 字节 | 移除内容                                                     |
| ---------------------------------------- | -------: | --------------: | ------------------------------------------------------------ |
| 无声明快照（假定全部工具可用）           |    1,135 |           1,139 | Subagent Delegation、Codebase Search、Monitor Processes 三条 |
| 基线已不声明 monitor，其他相关工具均声明 |      818 |             822 | Subagent Delegation、Codebase Search 两条                    |

字符采用 JavaScript `string.length` 口径，字节采用 UTF-8 口径；`wc -c` 量的是字节，不能直接与字符数比较。两种对比都保留全部示例，因为示例只调用文件类工具和 shell。若继续移除 `edit`、`write_file`、`glob` 或 shell，示例也会被裁剪，必须按当前模型模板重新测量，不能沿用旧版范围。

这些数字不是 token 计费数据，也不是所有真实 CLI 配置的固定收益。默认延迟加载的 `monitor` 若在 A/B 两边均未声明，就不能把它的 317 字符算入 A/B 差值。

> **更正：** 本文档早先版本写的"节省 4,012 字符 / 约 1,003 token"是错的。那个数字出自一个有 bug 的静态脚本——它解析 `tool-names.ts` 时把 `ToolDisplayNames` 混进了工具名表，`ReadFile` 覆盖了 `read_file`，导致所有示例块被误判为"调用了未声明工具"而算作节省。修正后的数字见上表。

基础提示词、工具 schema 和上下文文件的总量随版本与会话变化；不再沿用旧版字符数推断当前 token 降幅。**本改动的主要价值是正确性（不再向模型推荐它没有的工具），而不是承诺固定 token 收益。** 工具声明裁剪与提示词门控的收益应分别归因。

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

**预期：** A/B 必须使用同一构建、模型、output style、Todo 状态及其他配置，并确认实际声明集合。默认 `monitor` 在两边均未声明、A 声明 `agent` 且 B 不声明它时，文件七件套的 B 比 A 少 **818 字符 / 822 字节**，只删除 `- **Subagent Delegation:**` 与 `- **Codebase Search:**` 两条，示例不变。若改用无声明快照的函数渲染作 A，才是 §1 的三条 / 1,135 字符 / 1,139 字节口径。更窄白名单需要逐块检查示例差异，不使用历史总量作通过阈值。

**如果 B 和 A 一样大**，说明 `tools.eager` 没被接受（这是最常见的坑，见伞 issue 的交接文档：settings 写漏、scope 覆盖、未知 key 只走 debug 日志），而不是门控没生效。先确认 `/tools` 里那些工具确实变成了按需。

---

## 3. 测量二：请求真的变小了（以账单为准）

提示词文件变小不等于请求变小。用两个口径核对：

1. **provider 的真实计数**：会话记录里第一条 `qwen-code.api_response` 的 `input_token_count`。这是账单依据。
2. **`/context detail` 的系统提示词一行**：分类估算值。注意 `/context` 的分类闭合问题正在 #12119（#12033）修，未合入前它的分类合计与总数可能对不上；系统提示词那一行本身可用。

**预期：** 系统提示词的下降量应与 §2 中实际移除的文本相符，不预设 1,000 token 阈值。`input_token_count` 还包含工具 schema 与其他上下文；不要把 `tools.eager` 裁剪 schema 的收益记到提示词门控头上。

**要分离两者的贡献**，跑三档：默认；只设 `tools.eager`（本 PR 之前的版本）；设 `tools.eager` + 本 PR。第三档相对第二档的差值，才是本改动的收益。

---

## 4. 正确性检查（比省 token 更重要）

> 这三条的**单元测试版本已经在 CI 里**（见 §0.5）。这里保留的是**真实会话**版本：它额外证明 settings 真的被读取、快照真的被记录，而不只是函数层面成立。

**第 1 条 · 无快照与声明全集的路径一致（已核实的机制）**
单元测试比较无声明集合与声明全部工具的渲染，17 份完整快照保护预期文本。第二轮精简会有意修改快照，不能据此要求跨版本的默认提示词逐字节一致；真实会话的 A/B 应使用同一构建，并按实际声明差异检查门控内容。

**第 2 条 · 不再点名未声明的工具（这是本改动的目的）**

```bash
# 白名单外的工具名不应出现在被门控的两段里
for t in agent web_fetch web_search notebook_edit list_directory monitor cron_create; do
  grep -n "$t" /tmp/prompt-eager.md | grep -vE '^\s*$' && echo "^^ $t 仍出现，检查是否在未门控段落（见下）"
done
```

**已知残留（不是回归）：** `ask_user_question` 在被门控段落内仍无条件出现（它豁免于 `tools.eager`，且那条文案同时承载 headless 下"不得提问"的策略）。另外， `read_file` 在 persisted-output 条目与 plan mode 提醒里是无条件出现的，位于被门控段落之外；`subagent_type=Explore` 同样保持无条件。设计文档 §4.3 与 §6 有记录。所以上面的检查只针对 `## Using Your Tools` 与 `# Examples` 两段。

**第 3 条 · 安全条款一条都没少**

```bash
for k in '**UserPromptSubmit Context:**' '**Denied Tool Calls:**' '**Respect Tool Decisions:**' \
         '**Security First:**' '**Explain Critical Commands:**' '**Report outcomes faithfully:**' \
         'did not run a verification step' \
         'Carefully consider the reversibility' '- Destructive operations:'; do
  grep -qF "$k" /tmp/prompt-eager.md || echo "缺失：$k"
done
```

预期无输出。注意 `**Report outcomes faithfully:**` 位于 `## Software Engineering Tasks` 段内，若该部署用了 `keepCodingInstructions: false` 的 output style，它会连带消失——那是另一件事，见伞 issue 方案文档中关于该开关的说明。

---

## 5. 影响面清单（逐条过，这是"对别的模块没影响"的依据）

| #   | 模块                  | 为什么可能受影响                                   | 怎么验                                | 预期                                           |
| --- | --------------------- | -------------------------------------------------- | ------------------------------------- | ---------------------------------------------- |
| 1   | 主会话（交互）        | 提示词内容变了                                     | 裁剪配置下跑几轮真实任务              | 文件类任务正常完成，不出现"调用不存在的工具"   |
| 2   | `/context`            | 它读同一份快照来生成提示词                         | `/context detail` 的系统提示词一行    | 与请求一致，不报错                             |
| 3   | Arena                 | 它直接调 `getCoreSystemPrompt`，没有快照           | `/arena --models a,b "简单任务"`      | 各 agent 提示词与改动前一致（无快照 = 不门控） |
| 4   | 子 agent              | 走 `includeDeferred: true` 另一条路径，本改动不碰  | 跑一次 `agent` 委派                   | 子 agent 提示词与改动前一致                    |
| 5   | output style          | `keepCodingInstructions: false` 与门控叠加         | 选一个自定义 style 再看提示词         | 两者各自生效，不互相吃掉                       |
| 6   | code mode             | 该模式下工具在 `exec` 内调用，实现里**明确不门控** | `tools.codeModeOnly: true` 起一个会话 | `tools.<name>` 那些条目一条不少                |
| 7   | `QWEN_SYSTEM_MD` 覆盖 | 覆盖分支完全绕过默认提示词                         | 设一个覆盖文件起会话                  | 提示词就是该文件，门控不参与                   |
| 8   | 提示词缓存            | 静态前缀内容变了                                   | 同一会话连发 3 轮，看缓存命中 token   | 命中率与改动前同阶；前缀只在会话开始时重写一次 |
| 9   | 压缩                  | 压缩走 `startChat`，会重算快照                     | 触发一次 `/compress`                  | 压缩后提示词与压缩前一致（同一会话工具集没变） |
| 10  | 恢复会话              | 恢复也走 `startChat`                               | `--continue` 恢复一条旧会话           | 正常恢复，提示词按当前工具集门控               |

第 6、7 条是**最容易被忽略的反向检查**：它们必须**没有**变化。

---

## 6. 召回率：没有现成设施，只能弱化验证（待决策）

仓库里没有 `evals/` 目录，唯一的 agent 任务测试台（`integration-tests/terminal-bench`）在其头部注明"仅手动运行，不在任何 CI 任务中"。所以"模型仍然选对工具"**无法在 CI 中断言**。

能做的弱化验证：

1. 在裁剪配置下，用 10–20 条该部署的真实任务（文件处理为主）各跑一次，记录：是否完成、调用了哪些工具、`tool_search` 被调用几次。
2. 与"只设 `tools.eager`、不带本 PR"的版本对比。**关注方向而不是绝对值**：本改动删掉的是模型本来就拿不到的工具的说明，因此成功率不应下降；如果下降了，说明删多了（例如某条策略条目对仍然存在的工具也有指导意义）。
3. `tool_search` 调用次数应当**不增加**。若增加，说明删掉的文本原本在引导模型别去找那些工具。

**待决策：** 这个弱化验证够不够。如果不够，先落一套最小 eval 设施再谈裁剪——这是伞 issue 里 #12054 也遇到的同一道闸门。

---

## 7. 请报告回来什么

1. §2 的版本、模型、实际声明集合、`wc -c` 字节数与 diff 摘要（两边均未声明 monitor 时，文件七件套预期差值为 822 字节；见 §1、§2 的适用条件）。
2. §3 三档的 `input_token_count` 与 `/context` 系统提示词一行。
3. §4 三条检查的输出（第 2、3 条预期无输出）。
4. §5 表格逐行结论，尤其第 6、7 条（必须无变化）。
5. §6 的任务集结果：成功率、工具调用分布、`tool_search` 次数，新旧对照。
6. **本文档中任何与实测不符的结论。** §1 的数字是静态推算，§5 的"预期"是按代码推断的，都可能错。

---

## 8. 未验证的前提，以及怎么推翻它们

- **「无快照与声明全集的路径一致」** 依赖"无快照即不门控"这条早退。推翻方式：在同一构建下分别传入无快照与工具全集，渲染出现差异即证伪；这不等于真实会话默认声明全部工具。
- **「字符减少代表计费 token 减少」** 不能仅靠字符数或粗略换算证明。以 provider 的 `input_token_count` 为准，并按 §3 分离工具 schema 的贡献。
- **「不影响子 agent 与 Arena」** 依赖它们不读快照。推翻方式：§5 第 3、4 行的提示词 diff 出现差异。
- **「缓存前缀重写频率不变」** 依赖会话中途的揭示不重建提示词。推翻方式：会话中途触发一次 `tool_search`，若系统提示词随之变化即证伪。
