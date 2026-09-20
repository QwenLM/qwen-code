# 百炼 Batch API 与 Qwen Code 结合的可行性评估

日期：2026-09-14
结论先行：**Batch 不能进 agent 主循环，但可以作为旁路能力落地。卖点是"便宜一半 + 不吃实时限流"，前提是场景选对。**

## 1. Batch API 的硬约束（百炼 OpenAI 兼容批量接口）

| 约束                | 值                                               | 对 agent 的影响                                                              |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| `completion_window` | 最短 24h，最长 14d                               | agent 一跳要秒级，差 4~5 个数量级                                            |
| 流式                | 不支持                                           | TUI 流式渲染、`streamingToolCallParser.ts` 的增量工具调用解析全部失效        |
| 工具调用 / 多轮     | 文档未列出 function calling，且不支持多轮会话    | agent loop 本质是"模型 → 工具 → 模型"的多跳；即使单跳能跑，10 跳任务 = 10 天 |
| 同质性              | 同一文件内必须同模型、同 thinking 配置           | 一个 session 里模型/effort 会切换，无法整包提交                              |
| 规模                | 单行 ≤6MB，单文件 ≤500MB / 5 万条；1000 并发作业 | 对批量场景足够宽裕                                                           |
| 上下文              | batch 场景下封顶 256K                            | 长上下文会话会被截断                                                         |
| 计价                | 成功请求按实时价 **5 折**，失败不计费            | 唯一的卖点                                                                   |

## 2. 算一笔账：主循环用 batch 反而更贵

关键两个数字：

- **Batch：input / output 双双 5 折**（0.5x）。
- **Context Cache：命中的 input 按 `cached_token` 计价，百炼自部署模型大多是 input 单价的 20%**（0.2x）。

也就是说，**缓存命中的 input 比 batch 的 input 还便宜 2.5 倍**。

设 input 缓存命中率为 h（以标准 input 单价为 1 计）：

|             | input 单价 | output 单价 |
| ----------- | ---------- | ----------- |
| 实时 + 缓存 | `1 - 0.8h` | 1.0         |
| Batch       | 0.5        | 0.5         |

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

| #   | 问题                                                                                  | 不通的后果                                        |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | batch body 里 `tools` / `tool_calls` / 含 assistant+tool 历史的 `messages[]` 是否直通 | 不通则 agent 没有工具，"置换"无从谈起，回到形态 A |
| 2   | batch 内是否命中 context cache（返回 `cached_tokens` 非零）                           | 决定 §2 的成本结论是否翻转                        |
| 3   | 实际排队时长分布（空闲时几分钟？高峰时几小时？）                                      | 决定 headless 体验是"喝杯咖啡"还是"明天见"        |

"不支持多轮"大概率指没有服务端会话，而非拒绝带历史的 `messages[]`——但必须实测。
三条都是几十行脚本 + 一个 key 的事。

### 建议

先测 1/2/3，**不要先写 BatchContentGenerator**。

- 1 通 + 2 通：值得做"置换"，形态是 headless `--batch` + 持久化 `batch_id` + channel 通知，
  改动点就是 `pipeline.ts:475/519` 那一处 + session recovery 一种新 kind。
- 1 不通：回到 §3 的形态 A（agent 指挥 batch 做扇出），主循环不动。

## 7. 时间不可控，那进度能知道多少？

`GET /batches/{id}` 能给的全部信号：

| 信号             | 内容                                                                                                  | 对进度的意义                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `status`         | `validating → in_progress → finalizing → completed`，分支 `failed / expired / cancelling / cancelled` | 阶段机，没有百分比                                                        |
| `request_counts` | `{ total, completed, failed }`                                                                        | **扇出型有真进度**（95/100）；置换型 total=1，退化成 0/1                  |
| 时间戳           | `created_at / in_progress_at / finalizing_at / completed_at / expires_at`                             | `in_progress_at` 出现 = 排队结束、开始执行；`expires_at` = 最晚回来的死线 |
| `output_file_id` | 完成后才可下载，**没有部分结果**                                                                      | 扇出型"完成 95%"也拿不到那 95 条                                          |
| 排队位置 / ETA   | **没有**                                                                                              | —                                                                         |

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

**B. 生命周期** 5. **孤儿作业**。`batches.create` 成功但进程在持久化 `batch_id` 前崩溃 → 花了钱、丢了结果。
顺序必须是 create → 立刻落盘 → 再轮询；resume 时用 `batches.list` 对账，回收无主作业。6. **子 agent 继承策略**。fleet / team / subagent 在 batch 会话里是否也走 batch？
默认继承会让"快问一句"的子任务也变成小时级；需要显式策略（建议：子 agent 一律实时）。

**C. 范围与门禁** 7. **只有 DashScope 官方 host + API key 支持**。QWEN_OAUTH 走的是门户 token，
第三方 OpenAI 兼容端点（OpenRouter 等）没有 `/batches`。开关必须在
`DashScopeOpenAICompatibleProvider.isDashScopeProvider` 且非 OAuth 时才生效，否则启动即报错。8. **流式路径上的附属校验被跳过**。`pipeline.ts:519` 之后的 `withResponse()` SSE content-type 检查、
`streamingToolCallParser` / `taggedThinkingParser` 的增量路径在"一次 yield 完整 chunk"下是未测过的形状。

**D. 数据与合规** 9. **prompt 变成了云上文件**。实时请求是瞬态的，batch 要先 `files.create` 把整段上下文（含代码）
上传成可列举的文件，且输出文件也留在账号里。企业用户会在意；完成后要 `files.delete` 输入和输出。

**E. 计量** 10. **成本与延迟指标失真**。首 token 延迟等指标无意义；footer / status line 的费用估算要按 0.5x 记，
telemetry 打 `execution_mode=batch` 标签，否则 batch 会话的数据会污染实时基线。

### 8.2 最关键的一条：开关必须在请求上，不能在生成器上

`Config` 的 `getBaseLlmClient()` 与主循环**共用同一个 `ContentGenerator` 实例**。
仓库里挂在它上面的 side-call 有 21 种 purpose（写作本文时；枚举是活的，接手时重新点算，
不要抄本文的数字），例如 `session-title / tool-use-summary / permission_classifier_stage1&2 /
goal-verifier / next-speaker / chat-compression / prompt-suggestion / session-recap /
auto-memory-recall / auto-memory-forget-selection / subagent-generator / vision-bridge / web-fetch /
arena-approach-summary / acp-rewrite / project-summary` 等。

如果在 `createContentGenerator` 层换成 batch 生成器，这些 side-call 会**静默**全部变成小时级：
UI 等一个 session title 等一天，权限分类器卡死整个 tool 调度。

所以：

- 开关放在 `GenerateContentParameters.config` 上（例如 `executionMode: 'batch'`），
  **只有主循环那一次 `generateContent` 设置它**；side-call 一行不改就天然留在实时通道。
- 管线里只有一处分支：`ContentGenerationPipeline.execute` 里按 `request.executionMode` 分流
  （行号会漂，按符号找；本文最初引用的 `pipeline.ts:475` 等坐标均已漂移，勿再引用）。
  其余 converter / provider / 错误处理原样复用。

### 8.3 四层圈住影响面

| 层   | 措施                                                                             | 效果                               |
| ---- | -------------------------------------------------------------------------------- | ---------------------------------- |
| 入口 | 只在 headless（`qwen -p ... --batch`）接受该 flag；交互式 TUI 直接拒绝并给出原因 | TUI 代码路径零改动                 |
| 门禁 | provider 必须是 DashScope 官方 host + API key，否则启动即 fail-fast              | 第三方端点、OAuth 用户完全不受影响 |
| 请求 | 8.2 的请求级开关；子 agent、压缩、side-call 一律实时                             | 全部 side-call 与现状比特级一致    |
| 默认 | flag 默认关闭、标记 experimental；telemetry 打标签                               | 关掉 = 代码不可达，回滚就是删 flag |

测试面：现有 `pipeline.test.ts` 不动；新增一个小文件 mock `client.files` / `client.batches`，
覆盖 create→persist→poll→fetch、abort→cancel、resume 对账三条路径。CI 本来就慢，测试文件保持最小。

## 9. Handoff（接手者从这里开始）

**一句话状态**：评估写完、探测脚本写完、**四个脚本已对线上跑完**（华北2·北京，`qwen3.7-max`，
2026-09-18/19），结果见 PR #11874 的
[#issuecomment-5732395864](https://github.com/QwenLM/qwen-code/pull/11874#issuecomment-5732395864)（00/01/02）与
[#issuecomment-5738810147](https://github.com/QwenLM/qwen-code/pull/11874#issuecomment-5738810147)（03/04）。
方向已由结果选定：§9.3 判定矩阵的每一个分支都落在「扇出用命令、主循环不用 batch」，
`--batch` 只作为**不占实时配额的夜间开关**保留。

**实测结论（不再是假设）**：

| 探测             | 结果                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00 plumbing      | PASS（`qwen3.7-max`，3/3 在 output、0 在 error）。默认的 `batch-test-model` 跑不通：它要求 `url` 填 `/v1/chat/ds-test`                               |
| 01 tools         | **PASS**：`tools`、`tool_calls`、带 `assistant` + `tool` 历史的 `messages[]` 原样穿过 batch body，`finish_reason: tool_calls` 保留                   |
| 02 cache         | 实时对照 `hit_rate 0.647`；两个 batch 臂 `cached_tokens` **均为 0** ⇒ `cost_vs_realtime = 1.03`（implicit / explicit 同）                            |
| 03/04 延迟与规模 | 3 行 596 s、24 行 1720 s、1000 行 3718 s；终态前 `status` 可 10–30 分钟无变化（889/1000 停滞 28 分钟后 1000/1000 全成）；无共享前缀的扇出形状 `0.50` |

盈亏平衡点因此是实的：设命中率 `h`，实时 `1 − 0.8h` 对批量 `0.5`，交点 `h = 0.625`；
批量内缓存 0 命中意味着主循环形状（`h` 最高）必然贵于实时。

### 9.1 现在有什么

| 物件                            | 位置                                                                                                                                                                                                        | 状态                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 本评估                          | `docs/plans/2026-09-14-batch-api-feasibility.md`                                                                                                                                                            | §1-§8 完成，§9 已按实测结果更新                                                                         |
| 探测脚本 + README               | `docs/verification/batch-api/`                                                                                                                                                                              | **已对线上运行**（00/01/02/03/04），结果见上方两条 PR 评论                                              |
| 草稿 PR                         | https://github.com/QwenLM/qwen-code/pull/11874（分支 `docs/batch-api-feasibility`，基于 `origin/main` `85631a3d`）                                                                                          | 等评审                                                                                                  |
| `qwen batch` 命令（形态 A）     | `packages/cli/src/commands/batch.ts`（+ 同名测试，注册在 `config/config.ts`）                                                                                                                               | 已实现：`submit / status / fetch / cancel`，原生 `fetch`，无新依赖；`submit/status/cancel` 已对线上验证 |
| headless `--batch` 置换（§6）v1 | `core/openaiContentGenerator/batch.ts`（运行器）、`pipeline.ts` 两处分支、`contentGenerator.ts` 的 `executionMode`、`llm-chat.ts` 主循环设置、`Config.getBatchMode()`、CLI `--batch` flag + `.check()` 门禁 | 已实现 v1；01 探测（验收标准）**已通过**，但 `--batch` 本身尚未对线上端到端跑过                         |

### 9.2 当时列的执行步骤（已完成，保留作复现说明）

下列四个探测已于 2026-09-18/19 对线上跑完，结果见 §9 开头的表格与两条 PR 评论。
命令保留在这里，是为了让别人能用自己的 key 复现同一组测量。

前提：北京 region 的 `DASHSCOPE_API_KEY`，只放 env，不落盘。在仓库根目录：

```sh
export DASHSCOPE_API_KEY=sk-...
# 00/01/02 都会阻塞等满整个完成窗口（waitFor 到终态才返回，结果只在最后的 save() 落盘），
# 和 03 一样用 nohup 跑；02 会把两个 batch id 立刻写进 out/02-pending.json，中断后重跑即续。
nohup node docs/verification/batch-api/00-plumbing.mjs > docs/verification/batch-api/out/00.log 2>&1 &
nohup node docs/verification/batch-api/01-tools.mjs    > docs/verification/batch-api/out/01.log 2>&1 &
nohup node docs/verification/batch-api/02-cache.mjs    > docs/verification/batch-api/out/02.log 2>&1 &
nohup node docs/verification/batch-api/03-queue-timing.mjs --hours 24 \
  > docs/verification/batch-api/out/03.log 2>&1 &     # §6 问题 3，明天再看
```

把 `out/00|01|02-*.result.json` 的 `verdict` 段和 `out/03-queue-timing.summary.json`
贴到 PR #11874 的评论里。`FAIL` 时连同 result 文件里的 `errors` / `raw`（含百炼报错原文）一起贴。

### 9.3 结果怎么用

> 注：表里的「接下来开什么」是探测前的计划；形态 A 与置换 v1 都已在本 PR 落地
> （§9.1/§9.4），所以现在要开的不是实施 issue，而是验收结论。

| 01 工具直通 | 02 batch 内缓存 | 方向                                    | 接下来开什么                                         |
| ----------- | --------------- | --------------------------------------- | ---------------------------------------------------- |
| 通          | 通              | §6 置换：headless `qwen -p ... --batch` | 开 issue，按 9.4 的改动点实施                        |
| 通          | 不通            | §3 形态 A：`qwen batch` 扇出命令        | 开 issue，`commands/batch.ts` + 同名工具，主循环不动 |
| 不通        | —               | 只做形态 A                              | 同上；置换永久搁置                                   |

03 不改变方向，只决定 §7 的经验 ETA 数值和产品文案里怎么描述等待。

### 9.4 置换——v1 已实现，对照清单

v1 落地了第 1、2、5（入口门禁 + OAuth 拒绝）、6 的前半（自动成立：side-call 不带 `executionMode`；
后半的 256K 压缩阈值未做）、10 条；第 4 条落地为「重试整体禁止」（放弃的错误按类型不再重试，
见 `batch.ts` 的 `BatchNotRetryableError`），比「重试前先 cancel」更强，但「提示已完成部分仍计费」
只在 `qwen batch cancel` 的 help 里，核心路径没有单独提示。
第 3（`batch_id` 持久化 / resume）、7（显式 `enable_thinking`）、8（计量）**留到 01 验收通过后**。
进程中途挂掉时 batch id 已打到 stderr，用 `qwen batch fetch <id>` 手动收。

原始清单（保留作对照）：

1. **请求级开关**：`GenerateContentParameters.config` 加 `executionMode?: 'batch'`，
   只由主循环那一次 `generateContent` 设置。原因见 §8.2——`BaseLlmClient` 与主循环共用
   `ContentGenerator`（按符号找：`Config.getBaseLlmClient` / `Config.getContentGenerator`；
   本文最初引用的 `config.ts:3693` 等行号已漂移，勿再引用），生成器级置换会把全部 side-call 拖进 24h。
2. **管线分支**：`ContentGenerationPipeline.execute` 里按 `request.executionMode === 'batch'`
   分流（非流式与流式各一处），批式分支落到 `openaiContentGenerator/batch.ts` 的
   `runBatchCompletion`：单行 JSONL → 上传 input 文件（手写的 multipart fetch，原因见该文件注释）
   → `client.batches.create` → 轮询 `batches.retrieve` → `files.content(output_file_id)`
   → 取第一行 `response.body`。`client` 就是 `provider/default.ts` 的 `buildClient()`
   返回的 `openai` 实例，`files` / `batches` 已在上面。
3. **持久化**：`batches.create` 成功后**立刻**把 `batch_id` 写进 session，再开始轮询；
   `core/session-recovery.ts` 加一种 recovery kind（pending batch），resume 时先 `batches.retrieve` 再决定续等或重发；
   启动时 `batches.list` 对账回收孤儿。
4. **取消**：`abortSignal` → `batches.cancel`；提示已完成部分仍计费。重试前必须先 cancel 旧作业。
5. **门禁**：只在 headless 接受 `--batch`；TUI 拒绝并说明原因。
   provider 必须满足 `DashScopeOpenAICompatibleProvider.isDashScopeProvider` 且非 `QWEN_OAUTH`，否则启动即报错。
6. **不走 batch 的**：子 agent、`chatCompressionService`、所有 side-call。压缩阈值取 `min(模型上限, 256K)`。
7. **必须显式发 `enable_thinking`**，否则新模型在 batch 下默认开 thinking，5 折被吃回去。
8. **计量**：费用估算按 0.5x；telemetry 打 `execution_mode=batch`。
9. **收尾**：结果落盘后 `files.delete` 输入和输出文件（§8.1 D）。
10. **测试**：现有 `pipeline.test.ts` 不动；新增一个小文件 mock `client.files` / `client.batches`，
    只盖 create→persist→poll→fetch、abort→cancel、resume 对账三条路径。

### 9.5 扇出（形态 A）——已实现，剩余项

已落地（`packages/cli/src/commands/batch.ts`）：

- `submit <file> [--window]`：每行可以是完整 batch 请求行，也可以是裸的 chat-completions body（自动补 `custom_id` / `url` / 默认模型）；上传后打印 batch id。
- `status <id> [--json]`：一行输出 status、`completed/total`、按时间戳推出的 queued / running / ran 阶段、`expires_at` 死线（§7）。
- `fetch <id> [--out dir] [--delete]`：未 settle 直接拒绝；写 `<id>.output.jsonl` / `<id>.error.jsonl`；`--delete` 顺手删远端输入/输出/错误文件（§8.1 D）。
- `cancel <id>`。
- 门禁：只接受 auth type `openai` + API key（QWEN_OAUTH 直接报错）；凭证解析复用 `resolveCliGenerationConfig`，和交互式一致。
- 用原生 `fetch` + `FormData`，没有给 cli 加 `openai` 依赖（避免动 lockfile）。

没做、刻意留着的：

- 不做同名工具——模型通过 shell 调 `qwen batch` 即可。
- 不自动生成 JSONL、不按 `custom_id` 回写工作区——agent 用 `custom_id` 自己映射。
- 不显式发 `enable_thinking`——由写 body 的一方决定（9.4 第 7 条仍适用，README 里提醒）。
- 未对线上接口跑过（没有 key）；本地 vitest / tsc 已通过，CI 仍会复验。

### 9.6 已知但未验证的假设

- "不支持多轮"指没有服务端会话，而非拒绝带历史的 `messages[]`——由 01 的 L2 验证。
- 百炼缓存命中价为 input 的 20%——来自公开价格页，跑 02 时用 `CACHE_RATIO` 覆盖成目标模型的真实值。
- 排队时长"空闲时几分钟"——纯猜测，由 03 验证。
- `ds_batch_finish_callback` 仅北京 region、只在完成时通知一次——来自文档，未测。

### 9.7 仓库约定（接手者务必遵守）

- PR 有活动时**不要 force-push**，追加 commit。
- PR body 英文在前，`<details><summary>中文说明</summary>` 折叠完整中文；先读 `.github/pull_request_template.md`。
- PR 只开不合，由维护者审阅合并。
- 声明完成前必须本地跑 build / typecheck / 相关单测（AGENTS.md「Development Guidelines」第 3 条；
  单测优先跑改动文件的单个测试文件）。本节曾经误写成「不在本地跑」，那不是仓库约定，作废。
