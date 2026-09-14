# 工具输出落盘/预览：状态流转与隐私模型

[English](2026-08-10-tool-output-offload-preview.md) | [简体中文](2026-08-10-tool-output-offload-preview.zh-CN.md)

> 本设计说明由 [#4184](https://github.com/QwenLM/qwen-code/issues/4184) 要求
> （验收标准："以一份设计说明记录落盘/预览的状态流转与隐私模型"）。
> 缓解措施在 #4880 中实现；留存诊断随配套的 `/doctor memory` 改动加入。

## 1. 问题

在长会话中，OOM 风险来自两方面：超大的工具输出被保留在对话历史中、并在
之后的每一轮持续产生开销；以及压缩期间历史被复制出重复副本——而不仅仅是
传统意义上的内存泄漏。目标是在热路径上只保留结构化元数据和一段有界预览，
把大载荷持久化到热路径之外，并让诊断能指出内存留存在哪里。

## 2. 状态流转

工具输出在进入对话历史之前会经过以下状态：

```mermaid
graph TB
    A[Raw tool output] --> S{Already truncated? (prefix, marker, or stub)}
    S -- yes --> J[Metadata appended after truncation, never bisected]
    S -- no --> G{Persistence gate: over configured threshold + 3k headroom, not exempt, and no producer budget marker?}
    G -- yes --> F[Full payload persisted to session temp file, mode 0o600]
    G -- no --> B{Per-tool budget declared?}
    B -- yes --> C[Scheduler per-tool bound, e.g. grep 20k]
    B -- no --> D[Scheduler gate: global threshold 25k chars + 1000 lines]
    C --> H[Enters history as-is]
    D --> H
    F --> I2[History retains preview + metadata + read_file pointer]
    I2 --> I[Model recovers full output on demand via read_file]
    H --> J
    I2 --> J
    J -->|non-sentinel body| K{Assembled string over 2x budget?}
    J -->|sentinel body (skip)| M[Per-message batch budget 200k across parallel calls]
    K -- yes --> L[Second pass bounds it once more]
    K -- no --> M
    L --> M
    M --> N[Final tool result recorded in history]
```

关键性质：

- **持久化闸门在前**（针对没有工具内截断的工具）。
  `maybePersistLargeToolResult` 先于调度器的每工具/全局截断运行：任何超过
  配置阈值 + 3k 余量（默认 28k）的非豁免结果会被立即持久化并替换为预览存
  根。按名字豁免：`exec`、`read_file`、`read_mcp_resource`、
  `enter_plan_mode`（自行管理）。第二条豁免路径是生产者预算标记
  （`outputBudgetApplied`；目前由 Shell 前台设置）：生产者已经按自己声明
  的预算为该正文定过尺寸，因此闸门退让，每工具 pass 成为唯一权威——参见
  [Shell 输出预算：每个正文只决策一次](./shell-output-budget-single-entry.zh-CN.md)。
  未带标记的 Shell 路径（显式后台启动，以及前台→后台提升交接，两者都在截
  断块之前返回）仍正常通过闸门；到达截断块的超时与被取消的前台正文则带标
  记。超过 30k 的 Shell 输出与超过 500k 的 MCP 输出在 `execute()` 期间、
  闸门看到结果之前就在工具内截断；入口处的哨兵检测随后让它们绕过闸门。因
  此，高于 28k 的每工具预算（agent 32k、web-search 102k）是未标记结果的
  第二级边界——闸门先落盘。
- **进入历史之前必有界。** 每一层都在结果落账之前生效，因此历史永远不会
  持有无界载荷。
- **可恢复，绝不丢弃。** 超大输出被持久化到会话临时目录的文件：闸门写入
  `tool-results/<callId>.txt`，而工具内截断（shell、MCP）写入
  `~/.qwen/tmp/<project-hash>/<tool>_<hex>.output`。保留的预览携带指针，
  模型可以用 `read_file` 读回完整载荷。截断保留头尾（`keep: 'both'`），
  因为 shell 的失败摘要出现在结尾。
- **可重入防护。** 已截断的结果携带哨兵——开头的
  `TOOL_OUTPUT_TRUNCATED_PREFIX`、文本中的 `... [CONTENT TRUNCATED] ...`
  标记，或 `<persisted-output>` 存根前缀。后续的 pass 检测到其中任何一种
  都会跳过再次截断，因此截断头永远不会嵌套。
- **元数据完整性。** PostToolUse/skill 元数据与系统提醒只在原始正文被限界
  之后才追加，随后装配出的字符串再按两倍预算复查——除非正文已携带截断哨
  兵（可重入跳过），那种情况下只剩批量预算约束它。
- **批量级边界。** 一条消息中的所有并行调用完成后，聚合结果通过落盘最大
  的若干结果被缩减到 `toolOutputBatchBudget`（默认 200k 字符）——覆盖单个
  结果各自合法、合在一起却爆炸的情形。

## 3. 阈值

| 层         | 预算                                                                                                                             | 可配置                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 持久化闸门 | 配置阈值 + 3k 余量（默认 28k）；豁免：exec、read_file、read_mcp_resource、enter_plan_mode，以及携带 `outputBudgetApplied` 的结果 | `settings.tools.truncateToolOutputThreshold`                             |
| 每工具     | shell 30k、grep 20k、mcp 500k、agent 32k/tail、web-search 102k、read-file 自行管理                                               | 否（由工具声明）                                                         |
| 全局       | 25k 字符 + 1000 行                                                                                                               | `settings.tools.truncateToolOutputThreshold` / `truncateToolOutputLines` |
| 合并 pass  | 适用预算的 2 倍                                                                                                                  | 否                                                                       |
| 每条消息   | 200k 字符                                                                                                                        | `settings.tools.toolOutputBatchBudget`                                   |
| 磁盘持久化 | 单文件 50MB，每会话 500MB                                                                                                        | 否                                                                       |

每工具预算只按字符计：当工具声明了预算，全局行数上限对它停用，以免自行管
理分页的 read-file 与按字符计预算的 grep 被悄悄压低。

## 4. 隐私模型

直接对应 #4184 的非目标：

| 非目标                                 | 执行方式                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 不上传工具结果                         | 落盘目标只有会话临时目录下的本地文件；截断代码中不存在任何网络路径                                      |
| 不在诊断中包含隐私内容                 | `/doctor memory` 的留存小节只报告大小与计数，绝不报告内容；可安全粘贴到 bug 报告（`--json` 下同样如此） |
| 不在没有可取回指针的情况下静默丢弃数据 | 超大载荷随预览 + `read_file` 指针一并持久化；如果无法持久化（见下），有界预览仍会说明发生了什么         |
| 仅所有者可读的产物                     | 持久化文件以 `0o600` 权限写入；共享临时目录本身的权限不放宽                                             |

磁盘持久化的失败模式（全部朝有界内存方向失败，绝不朝无界留存或数据暴露方
向）：

- 输出大于 50MB：跳过持久化，内存内截断仍然限界结果。
- 会话预算（500MB）耗尽：跳过持久化，同样保有内存内边界。
- 截断/IO 错误：成功的工具调用绝不会被降级为错误。主持久化失败时，代码回
  退到 `truncateAndSaveToFile`，写入项目临时目录——完整载荷被保留并附带
  `read_file` 指针。只有当回退也失败时，结果才退化为不带指针的有界预览并
  记录一条警告。

## 5. 诊断（阶段一信号）

`/doctor memory` 现在以实时、按引用（不克隆历史）的方式报告：

- 历史中的工具结果、保留的总字符数、最大的单个结果。大小复用压缩管线的
  `estimatePartChars` 模型与同一个 `imageTokenEstimate`（经
  `resolveSlimmingConfig` 按 环境变量 > 设置 > 默认值 解析），因此诊断与压
  缩衡量的是同一份历史：字符串输出按原始字符计量（不产生 JSON 转义膨胀），
  嵌套媒体部分按图像 token 估计值计费。
- 超大结果，按每个结果自己的工具预算判定（从工具注册表按规范化后的
  `functionResponse.name` 解析，与调度器一致；未声明预算的工具回退到配置的
  全局阈值）。已携带截断哨兵（前缀或 `<persisted-output>` 存根）的结果会被
  跳过——已有某一层为它们定界——其余结果只在超过合并 pass 的 2 倍容忍加
  少量信封余量时才被标记，与调度器自己允许的余量一致。一个超过该边界仍被
  保留的结果意味着某道截断层被绕过——这个计数器同时充当回归警报。
- 超大输出是否也被渲染进 UI 历史（扫描 `tool_group` 条目的
  `resultDisplay`，按显示名对照同一个每工具预算——UI 历史存的是显示名而不
  是注册表键，因此扫描时会从工具注册表构建一张 显示名 → 预算 的映射），以
  及是否进入压缩输入（按构造就是肯定的，但压缩通过 `getHistoryShallow` 按
  引用读取历史，因此不持有额外副本）。阶段一范围：只测量字符串类型的
  `resultDisplay`；结构化显示对象（文件 diff、ANSI 捕获、代理结果摘要）携带
  各自的渲染契约，无法以同样方式按字符比较——留给后续 PR。

## 6. 已考虑的替代方案

- **用摘要代替截断。** 会在热路径上增加一次模型往返，并让隐私模型复杂化；
  基于指针的恢复以确定性方式达到同样目的。
- **从磁盘懒加载历史。** 会改变对话契约与提供方载荷形状；预览 + 指针保持
  现有契约不变。
