# 百炼 Batch API 与 Qwen Code 结合的可行性评估

日期：2026-09-14
结论先行：**Batch 不能进 agent 主循环，但可以作为旁路能力落地。卖点是"便宜一半 + 不吃实时限流"，前提是场景选对。**

## 1. Batch API 的硬约束（百炼 OpenAI 兼容批量接口）

| 约束 | 值 | 对 agent 的影响 |
| --- | --- | --- |
| `completion_window` | 最短 24h，最长 14d | agent 一跳要秒级，差 4~5 个数量级 |
| 流式 | 不支持 | TUI 流式渲染、`streamingToolCallParser.ts` 的增量工具调用解析全部失效 |
| 工具调用 / 多轮 | 文档未列出 function calling，且不支持多轮会话 | agent loop 本质是"模型 → 工具 → 模型"的多跳；即使单跳能跑，10 跳任务 = 10 天 |
| 同质性 | 同一文件内必须同模型、同 thinking 配置 | 一个 session 里模型/effort 会切换，无法整包提交 |
| 规模 | 单行 ≤6MB，单文件 ≤500MB / 5 万条；1000 并发作业 | 对批量场景足够宽裕 |
| 上下文 | batch 场景下封顶 256K | 长上下文会话会被截断 |
| 计价 | 成功请求按实时价 **5 折**，失败不计费 | 唯一的卖点 |

## 2. 算一笔账：主循环用 batch 反而更贵

关键两个数字：
- **Batch：input / output 双双 5 折**（0.5x）。
- **Context Cache：命中的 input 按 `cached_token` 计价，百炼自部署模型大多是 input 单价的 20%**（0.2x）。

也就是说，**缓存命中的 input 比 batch 的 input 还便宜 2.5 倍**。

设 input 缓存命中率为 h（以标准 input 单价为 1 计）：

| | input 单价 | output 单价 |
| --- | --- | --- |
| 实时 + 缓存 | `1 - 0.8h` | 1.0 |
| Batch | 0.5 | 0.5 |

- 只看 input：`1 - 0.8h < 0.5` → **h > 62.5% 时，实时调用比 batch 更便宜**。
- 只看 output：batch 恒赢（output 没有缓存可吃）。

合起来，batch 更便宜的条件是 `h < 0.625 + 0.625 · p · O/I`
（p = output/input 单价比，O/I = 输出/输入 token 比）。

代入 qwen-code agent loop 的真实形状：单轮 input 几万~十几万 token、output 几百~两千，
即 `O/I ≈ 0.01`，`p ≈ 2.5~4` → 阈值仍在 **h ≈ 64%** 附近。
而 agent loop 每轮重发整段会话前缀，`prefix-caching.ts` + DashScope `cache_control`
下的命中率通常在 80%+ —— **远在阈值之上，主循环换 batch 是净亏，还要额外付 24h 延迟。**

反过来，形态 A 那种扇出（每条请求是不同文件、前缀几乎不复用，h ≈ 0）正好落在 batch 侧：
5 折是干净的 5 折。这就是"batch 只在没有缓存可吃的形状上真香"的量化版本。

> **待验证的开放问题**：batch 作业内部还能不能命中 context cache？
> 批量文件里成千上万条请求往往共享同一段长 system prompt，如果隐式缓存在 batch 里照常生效，
> 形态 A 的收益还能再叠一层；如果不生效，共享前缀那部分就要按全价的 5 折算。
> 百炼文档没写，**上线前必须实测一次**（提交两批同前缀请求，看 `cached_tokens` 是否非零）。

## 3. 三种可落地形态

### 先问一句：qwen-code 的增量在哪？

Batch 是 OpenAI 兼容接口，用户拿 curl / 十行 Python 就能提交。所以做进 CLI 之前先确认增量，
否则就是 YAGNI。实际有三条，都成立：

1. **鉴权与端点复用**：QWEN_OAUTH、DashScope 多 region、代理/内网网关的解析已经在
   `provider/dashscope.ts` 里了，用户不用再配一遍 key 和 base URL。
2. **请求体由 agent 生成**：JSONL 的 `body` 用 `converter.ts` 现成的 Content → ChatCompletion
   转换，跟交互式跑的是同一套 prompt / 模型 / 参数，不会出现"调好的 prompt 搬到批量里跑歪了"。
3. **结果回写工作区**：按 `custom_id` 映射回文件路径，agent 直接接着处理。

如果这三条对目标用户都不重要，那就别做——写篇文档教他们用 curl 更划算。

### A. `qwen batch`：把 CLI 当批量作业的客户端（推荐）

模式是 **agent 决策、batch 执行、agent 收结果**：用户说"把这 5000 个文件按同一个 prompt 处理一遍"，
agent 生成作业、提交、第二天回收，自己全程保持交互式。
典型场景：i18n 文案翻译、批量补 JSDoc、给历史 issue/PR 打标签、日志/告警分类、
（若将来做代码语义索引）全仓 embedding 首次构建。

实现成本很低，因为依赖已经在仓库里：
- `packages/core/package.json:86` 已依赖 `openai@5.11.0` → `client.files` / `client.batches` 开箱可用；
- DashScope 就是 OpenAI 兼容端点，`core/openaiContentGenerator/provider/dashscope.ts` 已识别官方 host 与鉴权；
- 请求体可直接复用 `openaiContentGenerator/converter.ts` 的 Content → ChatCompletion 转换。

三步即可：
1. 生成 JSONL（`custom_id` + `method` + `url: /v1/chat/completions` + `body`）；
2. `files.create({ purpose: 'batch' })` → `batches.create({ completion_window: '24h' })`；
3. 轮询 `batches.retrieve`，取 `output_file_id` 下载，按 `custom_id` 回写。

**不碰 `ContentGenerator` 接口，不碰 agent loop**，新增一个子命令 + 一个同名工具（让模型能自己提交作业）即可。

### B. 后台任务的"省钱档"（暂不建议）

仓库已有 background tasks / workflow runner / fleet。理论上可以给**单跳、无工具**的 side-call
加一个 `--batch` 档：`services/sessionRecap.ts`、`services/toolUseSummary.ts`、
`goals/goalJudge.ts`、`memory/forget.ts`、`followup/suggestionGenerator.ts`。

问题是这些调用的语义都是"现在就要"——摘要要当场显示，judge 要当场决策。24h 后返回等于没有。
只有**离线重放**（把过去一周的 session 重新打标签、批量生成周报）才成立，而那本质上就是形态 A。

### C. 仓库自己的 CI 离线活（最快见效，0 产品改动）

docs 翻译流水线、weekly report、issue/PR 分类（`.github/workflows/auto-minimize-spam.yml` 这类）、
评测集打分。这些天然容忍 24h、量大、无工具、前缀不复用——正好落在 batch 最划算的区间。
不需要改 qwen-code 任何代码，写脚本即可，可以拿来先验证真实省了多少。

## 4. 卖点怎么讲（以及不能怎么讲）

- ✅ **省一半**：只对"大批量、独立、无缓存复用"的活成立。不要宣传成"agent 便宜一半"，
  主循环用 batch 既跑不通，账也是亏的（见 §2：缓存命中 0.2x < batch 0.5x）。
- ✅ **不吃实时限流**：batch 走独立配额（1000 并发作业、单文件 5 万条），
  把全仓扫描类任务从实时 QPS 里挪走，顺带缓解限流报错。
- ✅ **差异化**：Claude Code / Codex / Gemini CLI 都没有把 batch 接进 CLI
  （Anthropic 有 Message Batches API，但 Claude Code 不用它）。
  这是差异点，但也印证了"主循环跑 batch"是死路——要卖就卖 A 这种"agent 指挥 batch"的形态。

## 5. 建议

1. 先做 **C** 验证真实收益（0 改动，拿仓库自己的翻译/周报/分类任务试）。
2. 同时做 **A** 的最小版：`qwen batch submit/status/fetch` + 一个同名工具。
3. **B 不做**，`ContentGenerator` 和 agent loop 不动。
4. 落地前先实测 §2 的开放问题（batch 内能否命中 context cache），它直接决定 A 的收益量级。

命令形态照 `packages/cli/src/commands/sessions.ts` 的 `CommandModule` 写一个
`commands/batch.ts`（submit / status / fetch 三个子命令），在
`packages/cli/src/config/config.ts:1088-1103` 那串 `.command(...)` 里挂上去即可。

## 6. 追问：能不能"置换 API、不改交互、由 qwen-code 抹平差异"？

### 接口层面：能，缝很窄

- `ContentGenerator` 是逐次调用的 `generateContent / generateContentStream`
  （`core/contentGenerator.ts:38-52`），本身不关心底下是同步还是异步完成。
- OpenAI 管线里"构建请求"和"发出请求"已经分开：
  `buildRequest`（`openaiContentGenerator/pipeline.ts:949`，走 converter + `provider.buildRequest`）
  之后，只有一行真正打网络——非流式 `pipeline.ts:475`、流式 `pipeline.ts:519`
  的 `this.client.chat.completions.create(...)`。
- `provider.buildClient()` 返回的就是 `openai` SDK 实例（`provider/default.ts:77-92`），
  `client.files` / `client.batches` 天然在上面。

所以 batch 模式 = 把那一行换成
"写单行 JSONL → `files.create({purpose:'batch'})` → `batches.create` → 轮询 `batches.retrieve`
→ `files.content(output_file_id)` → 取第一行 `response.body`"，
其余 converter、provider 差异、错误处理、telemetry、工具调用解析全部复用。
流式那条不做 SSE：拿到完整响应后一次性 yield 一个 chunk，上层看到的是"一次收完"。

### 语义层面：三样抹不平，也不该抹

1. **时间**。batch 是"最晚 24h 内完成"，不是固定等 24h——空闲时可能几分钟，但不可控。
   一个 30 跳的 agent 任务 = 30 次提交-等待。交互式 TUI 里就是"按下回车，屏幕不动，几分钟到几小时"。
   抹平的办法不是藏起来，而是换产品形态：**只开放 headless**（`qwen -p ... --batch`），
   进程可以退出，完成后走 channels 通知（钉钉 webhook 那套已经在）。
2. **进程生命周期**。一次模型调用可能跨越 CLI 进程生死：
   `batch_id` 必须持久化进 session；重启 resume 时先 `batches.retrieve` 再决定继续等还是重发
   （`core/session-recovery.ts` 要多一种 recovery kind：pending batch）；
   Esc / 中断映射到 `batches.cancel`（已完成部分仍计费）。**真正的工程量在这，不在 API 调用。**
3. **成本**。§2 算过：主循环 h > 64% 就是亏。交互抹平了，账抹不平。
   "置换 API 省钱"这个前提在主循环上不成立，剩下的卖点是"不占实时配额、夜间大扫描不被限流"。

### 三个必须先测的问题（决定做不做）

| # | 问题 | 不通的后果 |
| --- | --- | --- |
| 1 | batch body 里 `tools` / `tool_calls` / 含 assistant+tool 历史的 `messages[]` 是否直通 | 不通则 agent 没有工具，"置换"无从谈起，回到形态 A |
| 2 | batch 内是否命中 context cache（返回 `cached_tokens` 非零） | 决定 §2 的成本结论是否翻转 |
| 3 | 实际排队时长分布（空闲时几分钟？高峰时几小时？） | 决定 headless 体验是"喝杯咖啡"还是"明天见" |

"不支持多轮"大概率指没有服务端会话，而非拒绝带历史的 `messages[]`——但必须实测。
三条都是几十行脚本 + 一个 key 的事。

### 建议

先测 1/2/3，**不要先写 BatchContentGenerator**。
- 1 通 + 2 通：值得做"置换"，形态是 headless `--batch` + 持久化 `batch_id` + channel 通知，
  改动点就是 `pipeline.ts:475/519` 那一处 + session recovery 一种新 kind。
- 1 不通：回到 §3 的形态 A（agent 指挥 batch 做扇出），主循环不动。

## 7. 时间不可控，那进度能知道多少？

`GET /batches/{id}` 能给的全部信号：

| 信号 | 内容 | 对进度的意义 |
| --- | --- | --- |
| `status` | `validating → in_progress → finalizing → completed`，分支 `failed / expired / cancelling / cancelled` | 阶段机，没有百分比 |
| `request_counts` | `{ total, completed, failed }` | **扇出型有真进度**（95/100）；置换型 total=1，退化成 0/1 |
| 时间戳 | `created_at / in_progress_at / finalizing_at / completed_at / expires_at` | `in_progress_at` 出现 = 排队结束、开始执行；`expires_at` = 最晚回来的死线 |
| `output_file_id` | 完成后才可下载，**没有部分结果** | 扇出型"完成 95%"也拿不到那 95 条 |
| 排队位置 / ETA | **没有** | — |

配套：
- 查询限额 1000 次/分钟，30~60s 轮询一次绰绰有余。
- 不想轮询：metadata 里的 `ds_batch_finish_callback`（仅北京 region）或 EventBridge。
  只在完成时通知一次，不是进度；本地 CLI 没有公网地址收不到回调，只有 serve / Web Shell 常驻时才用得上。

能自己补的两样：
1. **阶段感**：用 `in_progress_at` 区分"排队中"和"执行中"，比一个转圈有信息量得多。
2. **经验 ETA**：本地记录每个 batch 的 `created_at → completed_at`，按模型/时段取中位数，
   显示"通常 X 分钟，最晚 `expires_at`"。这是唯一能给用户的时间感，也是 §6 问题 3 的数据来源。

结论：**扇出型能做真进度条；置换型只能做"阶段 + 已等待 + 经验中位数 + 死线"。**

## 8. 三个待测之外还有什么问题，以及怎么圈住影响面

### 8.1 剩下的问题清单

**A. 与现有语义碰撞**
1. **重试 / 超时体系不兼容**。管线的 `executeWithErrorHandling` 有限流重试、SDK `timeout`、
   `streamIdleTimeoutMs`、`streamMaxLifetimeMs`。batch 调用要么被这些误杀，要么绕过它们。
   需要一套独立的等待策略：轮询间隔、上限 = `expires_at`，以及"重试"的定义
   ——重新提交前必须先 `batches.cancel` 旧作业，否则两份都计费。
2. **中断 → 取消**。`abortSignal` 触发要映射到 `batches.cancel`；已完成部分仍计费，要告知用户。
3. **压缩阈值**。batch 场景 context 封顶 256K，`chatCompressionService` 的触发线要取
   `min(模型上限, 256K)`；而压缩本身是一次 LLM 调用，必须留在实时通道，否则压一次等一天。
4. **thinking 默认开启**。新模型在 batch 下默认开 thinking，必须显式发 `enable_thinking`，
   否则 5 折被 thinking token 吃回去。

**B. 生命周期**
5. **孤儿作业**。`batches.create` 成功但进程在持久化 `batch_id` 前崩溃 → 花了钱、丢了结果。
   顺序必须是 create → 立刻落盘 → 再轮询；resume 时用 `batches.list` 对账，回收无主作业。
6. **子 agent 继承策略**。fleet / team / subagent 在 batch 会话里是否也走 batch？
   默认继承会让"快问一句"的子任务也变成小时级；需要显式策略（建议：子 agent 一律实时）。

**C. 范围与门禁**
7. **只有 DashScope 官方 host + API key 支持**。QWEN_OAUTH 走的是门户 token，
   第三方 OpenAI 兼容端点（OpenRouter 等）没有 `/batches`。开关必须在
   `DashScopeOpenAICompatibleProvider.isDashScopeProvider` 且非 OAuth 时才生效，否则启动即报错。
8. **流式路径上的附属校验被跳过**。`pipeline.ts:519` 之后的 `withResponse()` SSE content-type 检查、
   `streamingToolCallParser` / `taggedThinkingParser` 的增量路径在"一次 yield 完整 chunk"下是未测过的形状。

**D. 数据与合规**
9. **prompt 变成了云上文件**。实时请求是瞬态的，batch 要先 `files.create` 把整段上下文（含代码）
   上传成可列举的文件，且输出文件也留在账号里。企业用户会在意；完成后要 `files.delete` 输入和输出。

**E. 计量**
10. **成本与延迟指标失真**。首 token 延迟等指标无意义；footer / status line 的费用估算要按 0.5x 记，
    telemetry 打 `execution_mode=batch` 标签，否则 batch 会话的数据会污染实时基线。

### 8.2 最关键的一条：开关必须在请求上，不能在生成器上

`config.ts:3693` 和 `:3718-3719` 证实 `BaseLlmClient` 与主循环**共用同一个 `ContentGenerator` 实例**。
仓库里挂在它上面的 side-call 有 17 种 purpose：
`session-title / tool-use-summary / permission_classifier_stage1&2 / goal-verifier / next-speaker /
chat-compression / prompt-suggestion / recap / session-recap / auto-memory-recall / auto-memory-forget-selection /
subagent-generator / vision-bridge / web-fetch / arena-approach-summary / p`。

如果在 `createContentGenerator` 层换成 batch 生成器，这 17 种调用会**静默**全部变成小时级：
UI 等一个 session title 等一天，权限分类器卡死整个 tool 调度。

所以：
- 开关放在 `GenerateContentParameters.config` 上（例如 `executionMode: 'batch'`），
  **只有主循环那一次 `generateContent` 设置它**；side-call 一行不改就天然留在实时通道。
- 管线里只有一处分支：`pipeline.ts:475` 处 `if (executionMode === 'batch') return this.executeBatch(...)`。
  其余 converter / provider / 错误处理原样复用。

### 8.3 四层圈住影响面

| 层 | 措施 | 效果 |
| --- | --- | --- |
| 入口 | 只在 headless（`qwen -p ... --batch`）接受该 flag；交互式 TUI 直接拒绝并给出原因 | TUI 代码路径零改动 |
| 门禁 | provider 必须是 DashScope 官方 host + API key，否则启动即 fail-fast | 第三方端点、OAuth 用户完全不受影响 |
| 请求 | 8.2 的请求级开关；子 agent、压缩、side-call 一律实时 | 17 种 side-call 与现状比特级一致 |
| 默认 | flag 默认关闭、标记 experimental；telemetry 打标签 | 关掉 = 代码不可达，回滚就是删 flag |

测试面：现有 `pipeline.test.ts` 不动；新增一个小文件 mock `client.files` / `client.batches`，
覆盖 create→persist→poll→fetch、abort→cancel、resume 对账三条路径。CI 本来就慢，测试文件保持最小。
