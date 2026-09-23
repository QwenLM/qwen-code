# Bailian Batch API 探测脚本

配套 `docs/plans/2026-09-14-batch-api-feasibility.md` §6 的三个待测问题。
脚本只打百炼接口，不碰仓库代码；跑完把 `out/*.result.json` 贴回来即可。

**依赖**：`regression.sh` 与 `fake-dashscope.mjs` 驱动的是 `qwen batch` 命令本身，
它由 [#11874](https://github.com/QwenLM/qwen-code/pull/11874) 引入。在 #11874
合并之前，本目录里的四个线上探测（`00`–`03`，只依赖 `openai` SDK 与百炼接口）
可以独立运行，`regression.sh` 则需要那个分支的 CLI。

**`--batch` 已不存在。** headless 置换按下方「判定」表的第二行被否掉，已从 #11874
移出（保存在 `archive/headless-batch-mode-11874`）。`regression.sh` 原有的
R4/R5/R6/R8/R9 与 R7 的 SIGINT 部分随之删除；`fake-dashscope.mjs` 里
`tools` / `failed` / `unpollable` 三个场景暂时保留但已无人驱动，若确认不再恢复可一并删掉。

**已知待修（留给本 PR 自己的 review 轮）**：`00-plumbing.mjs` 默认的
`batch-test-model` 跑不通——官方要求该模型的 `url`/`endpoint` 填
`/v1/chat/ds-test`，而脚本硬编码 `/v1/chat/completions`，实测三行全拒
（`mismatched_test_url`）；实跑改用 `qwen3.7-max` 才 PASS。
`03-queue-timing.mjs::drain()` 的清理是 fire-and-forget 且紧接着
`process.exit(0)`，实测会遗留文件，需要在退出前 `await Promise.allSettled(...)`。

## 工作流 E2E（`/batch-api` 的确定性执行层）

`workflow-e2e.mjs` 验证 agent-prepared 工作流（`qwen batch check|run|collect|retry|list|clean`、
`cancel --task`）：自带假 Batch API、隔离 `HOME`，驱动构建产物 `dist/cli.js`
走完整链路——预检、提交、运行中收取、`--wait` 收取、文件交付、幂等重收（不重下载、
不重删远端）、截断失败、截断项不带更高上限时被跳过、提高上限后重试、目标冲突 held、
解决后交付、任务取消、清理（未收取时拒绝），共 27 项断言。

```sh
npm run build && npm run bundle
node docs/verification/batch-api/workflow-e2e.mjs "$(pwd)/dist/cli.js"
```

不需要网络与真实凭证；与上面四个线上探针（需要 `DASHSCOPE_API_KEY`）互补。
PR #12492 的后续提交未在本地运行过这个脚本，需要在可构建的机器上重跑并回贴结果。

## 阶段 B：真实付费闭环（待执行，会产生费用）

首轮人工实测（小文档、qwen-plus）的数据与分析见
[`results-2026-09-23.md`](./results-2026-09-23.md)，其第六节是本节的补充方法。

对应设计 §10 阶段 B 与 §5.2 的两层比较。以下都**没有**做过；在跑完之前，任何
"省钱"都只是估算。**第 1 步写下的判定规则在跑之前冻结，看到结果后不许改。**

### 要回答的两个问题

| 层     | 比什么                                         | 对照组                                      |
| ------ | ---------------------------------------------- | ------------------------------------------- |
| 第一层 | 同一批已组织好的请求，Batch 与实时的生成费用   | 臂 A 的生成 vs 臂 B（原样重放 A 的请求）    |
| 第二层 | 完整工作流：准备 + 生成 + 补救，同等质量下总价 | 臂 A 全流程 vs 臂 C（普通实时会话做同一事） |

### 0. 前置（不花钱）

1. 在 PR 分支构建：`npm run build && npm run bundle`，跑
   `node docs/verification/batch-api/workflow-e2e.mjs "$(pwd)/dist/cli.js"`，
   必须 27/27。不通过就停，先修代码。
2. 让实验里的 `qwen` 一定是这次构建的版本。skill 执行的是
   `"${QWEN_CODE_CLI:-qwen}"`，回落到 PATH 上的 `qwen` 时，旧的全局安装没有
   `batch run` 等子命令：

   ```sh
   export REPO=$(pwd)
   mkdir -p ~/stage-b/bin && printf '#!/bin/sh\nexec node %s/dist/cli.js "$@"\n' "$REPO" > ~/stage-b/bin/qwen
   chmod +x ~/stage-b/bin/qwen && export PATH=~/stage-b/bin:$PATH
   qwen batch --help | grep -q 'batch check' && echo "qwen 指向 PR 构建"   # 旧版本没有 check
   ```

   后面所有步骤都在这个 shell 里做。

3. 准备一个仓库外的实验目录，臂 A 与臂 C 各一份干净副本（避免互相覆盖、避免
   git 噪音；臂 B 只重放请求，不需要项目目录）：

   ```sh
   export SB=~/stage-b && mkdir -p $SB/src
   ls docs/users/features/*.md | sort | head -30 | xargs -I{} cp {} $SB/src/
   for arm in a c; do mkdir -p $SB/$arm && cp -r $SB/src $SB/$arm/src; done
   ```

   样本是 30 篇英文用户文档（约 1.5–31 KB），任务是译成简体中文。**样本清单
   一旦选定不再更换。**

4. 固定设置并记录：模型、地域、思考开关、输出上限。在 `$SB/a` 里执行
   `qwen batch check`，把输出整段抄进记录表；臂 C 用同一份 settings（同一
   `~/.qwen/settings.json`，不要中途改）。如果 `check` 显示
   `max output provider default`，在 settings 里设
   `model.generationConfig.samplingParams.max_tokens: 16384`（最大的文档约
   31 KB，避免截断），再跑一次 `check`。
5. 价格：从百炼价格页查该模型的实时输入/输出单价（元或美元均可，全程同一币种），

   ```sh
   export QWEN_BATCH_INPUT_PRICE_PER_1M_USD=<输入单价/百万>
   export QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD=<输出单价/百万>
   export QWEN_BATCH_PRICE_SOURCE="<价格页 URL>, checked <日期>"
   ```

   同时记下隐式缓存命中价（默认假设为输入价的 20%，若价格页不同，以价格页为准，
   下面公式里的 r 随之修改）。

6. 共同的任务指令与术语表写成一个文件 `$SB/brief.md`（术语对照 20–40 条、
   "代码块与链接目标原样保留"、"只输出完整译文"），再复制进两个项目目录，
   让 agent 不必读项目外的文件：`cp $SB/brief.md $SB/a/ && cp $SB/brief.md $SB/c/`。
   之后不再修改。

### 1. 预注册（跑之前写进 `results-stage-b.md`）

复制文末模板，填好"预注册"一节并提交到 PR 分支，然后才开始第 2 步。建议默认值
（可以改，但只能在跑之前改）：

- **语义抽查样本**：排序后的第 3、6、9 … 30 篇，共 10 篇。
- **结构通过**：`stage-b-structure-check.mjs` 判为 pass。
- **"更省"**：第二层 A 总价 ≤ C 总价 × 0.8，且 A 的结构通过数 ≥ C − 1，
  且抽查中"需返工"篇数 ≤ C + 1，且除第一句指令外用户介入 ≤ 2 次。
- **"更贵"**：A 总价 ≥ C 总价。
- 其他情况一律记为 **"收益未确认"**，不宣传任何节省比例。
- **中止条件**：`run` 的估算超过预算上限；或 A 的结构失败 > 6 篇（说明准备/
  指令有问题，停下分析，不做循环重试）。

### 2. 臂 A：`/batch-api` 全流程

1. `cd $SB/a && qwen`，**记下开始时间（UTC）**。输入一句话：

   ```
   /batch-api 按 brief.md 把 src/ 下所有 .md 译成简体中文，写到 out/ 下同名文件；maxCostUsd 设为 <预算>
   ```

2. 照常审批 agent 写计划和执行 `qwen batch run`。`run` 打印的整段输出（任务 ID、
   冻结设置行、估算、盈亏平衡命中率）原样抄进记录表。**记下准备结束时间**
   （`run` 打印 `collect later with` 的时刻）。
3. 等待期间不要在这个会话里做别的事（否则准备用量里会混进无关调用）。可以退出
   会话。每隔一段时间执行 `qwen batch collect <task-id>`，记录**提交到可收取的
   时长**。
4. 收取后：
   - 失败项：只允许一轮 `qwen batch retry <task-id>`（截断项加
     `--max-output-tokens`），记为补救；
   - held 项：说明原因，按真实用户会做的方式处理，记入"介入次数"；
   - 需要人工或实时修改的译文：在新的会话里修，**该会话的用量计入补救**。
5. 记录 `collect` 最后一行的 "Batch usage, all attempts"（若有 INCOMPLETE，照抄
   并以控制台账单为准）。
6. 准备用量：

   ```sh
   ls -t ~/.qwen/projects/*/chats/*.jsonl | head   # 找到臂 A 的会话文件
   node docs/verification/batch-api/stage-b-session-usage.mjs <会话.jsonl> \
     --from <开始时间> --to <准备结束时间>
   ```

   与会话里 `/stats` 的数字交叉核对；差异写进记录表。

### 3. 臂 B：原样实时重放（第一层）

```sh
# 与臂 A 同一账号、同一地域：base URL 取 `qwen batch check` 显示的那个
DASHSCOPE_API_KEY=... DASHSCOPE_BASE_URL=https://<check 显示的 host>/compatible-mode/v1 \
  node docs/verification/batch-api/stage-b-realtime-replay.mjs \
  ~/.qwen/batch/tasks/<task-id>/attempt-001/input.jsonl --concurrency 4
```

在仓库根目录运行（脚本从 workspace 的 node_modules 解析 `openai`）。
请求体与臂 A 第一次提交逐字节相同（同模型、同冻结参数）。`summary.json` 的
`promptTokens / cachedTokens / completionTokens` 抄进记录表。**`cacheHitRate`
就是第一层公式里的 h 的实测值**——这是 `run` 只能给出盈亏平衡点、给不出结论的
那个未知数。

### 4. 臂 C：普通实时会话（第二层对照）

1. 换一个时间段（和臂 A/B 的账单错开至少 1 小时，便于在控制台按时间区分），
   `cd $SB/c && qwen`，记下开始时间，输入同一句任务（去掉 `/batch-api` 和
   `maxCostUsd`）：

   ```
   按 brief.md 把 src/ 下所有 .md 译成简体中文，写到 out/ 下同名文件
   ```

2. 让它用自己的方式完成（可以自行调用子 agent），审批按真实用户的习惯；记录
   介入次数和墙钟时长。
3. 完成后同样修正到"可交付"，修正也在这个会话里做。
4. 用 `stage-b-session-usage.mjs` 汇总整个会话（子 agent 记录在同一文件里）。

### 5. 质量评分（每个臂同一套规则）

```sh
node docs/verification/batch-api/stage-b-structure-check.mjs $SB/src $SB/a/out
node docs/verification/batch-api/stage-b-structure-check.mjs $SB/src \
  docs/verification/batch-api/out/stage-b-realtime/out   # 臂 B，路径随计划的 target
node docs/verification/batch-api/stage-b-structure-check.mjs $SB/src $SB/c/out
```

语义抽查：对预注册的 10 篇，把 A 与 C 的译文随机标成 X/Y（不告诉评审是哪个臂），
按"准确 / 通顺 / 术语一致"各 1–5 分打分，并判断"可直接交付 / 需返工"。B 只做
结构检查（它和 A 的请求相同，差异只来自采样随机性）。

### 6. 算钱

单价 Pin、Pout（每百万 token），命中价系数 r（默认 0.2），Batch 系数 b = 0.5：

```text
实时调用费 = [(prompt − cached) + cached × r] × Pin + (output + thought) × Pout
Batch 费   = b × (prompt × Pin + completion × Pout)        # 只计成功请求，以账单为准

第一层： Batch(A 生成，所有尝试) 对比 实时调用费(B)
第二层： A 总价 = 实时调用费(A 准备会话) + Batch(A 生成) + 实时调用费(A 补救会话)
         C 总价 = 实时调用费(C 会话)
```

最后到控制台核对账单：能按时间段分开的，以账单为准并注明；分不开的，写明
"按 usage × 单价推算"。

### 7. 结论与回贴

按预注册规则给出"更省 / 收益未确认 / 更贵"，只对"30 篇英译中文档"这一场景成立，
不外推。把 `results-stage-b.md` 与三个脚本的 JSON 输出（去掉正文）提交到 PR 分支，
并在 PR 里评论一句结论 + 链接。

### 记录表模板（`results-stage-b.md`）

```markdown
# 阶段 B 结果：30 篇英译中

## 预注册（跑之前填写并提交）

- 提交 SHA / 日期：
- 模型 / 地域 / `qwen batch check` 输出：
- 单价 Pin / Pout / r、价格来源与核对日期：
- 抽查样本：
- "更省 / 更贵 / 收益未确认"规则与中止条件：
- 预算上限：

## 记录

| 项目                       | 臂 A（/batch-api） | 臂 B（重放） | 臂 C（实时会话） |
| -------------------------- | ------------------ | ------------ | ---------------- |
| 开始 / 结束（UTC）         |                    |              |                  |
| 准备用量 prompt/cached/out |                    | —            | —                |
| 生成用量 prompt/cached/out |                    |              | （含在会话里）   |
| 补救用量                   |                    | —            |                  |
| 实测缓存命中率             | 0（Batch）         |              |                  |
| 提交到可收取 / 总墙钟时长  |                    |              |                  |
| 用户介入次数               |                    | —            |                  |
| 结构通过 / 30              |                    |              |                  |
| 抽查"需返工" / 10          |                    | —            |                  |
| 推算总价                   |                    |              |                  |
| 账单核对（能否分开、差异） |                    |              |                  |

## 结论

- 第一层：
- 第二层：
- 判定（按预注册规则）：
- 偏离预注册的地方及原因：
```

## 准备

```sh
export DASHSCOPE_API_KEY=sk-...          # 北京 region 的 API key，只从 env 读，不落盘
# 可选
export BATCH_MODEL=qwen-plus             # 默认 qwen-plus；01/02/03 用
export DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

在仓库根目录运行（`openai` 从 workspace 的 node_modules 解析）。所有输出落在
`docs/verification/batch-api/out/`（已 gitignore）。每个脚本跑完会 `files.delete`
自己上传/产出的文件，账号里不留东西。

预估总花费不到 1 元；`00` 用免费的 `batch-test-model`。

## 脚本

| 脚本                  | 回答的问题                                                                           | 通过标准                                                                                                                                                                    | 耗时                 |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `00-plumbing.mjs`     | JSONL 格式、状态流转、结果下载是否通                                                 | `status=completed`，output 3 行且每行 `response.status_code=200`，0 行在 error（provider 会把失败行也写进 output，并把 `request_counts.failed` 记成 0，所以只看行数会漏判） | 分钟级               |
| `01-tools.mjs`        | `tools` / `tool_calls` / 带 assistant+tool 历史的 `messages[]` 是否直通（§6 问题 1） | L1 `finish_reason=tool_calls` 且工具名 `get_time`；L2 回答含 `10:30`；L3 有内容；error 为空                                                                                 | 等一次 batch         |
| `02-cache.mjs`        | batch 内能否命中 context cache（§6 问题 2）                                          | 对照组实时 `cached_tokens>0`；看两个 batch 臂是否也 >0；`cost_vs_realtime` <1 才是真省                                                                                      | 等两次 batch（并行） |
| `03-queue-timing.mjs` | 1 行 batch 的排队 / 执行时长分布（§6 问题 3，§7 经验 ETA 的种子）                    | 无 pass/fail，看 `queue_s` / `total_s` 的 p50 / p90                                                                                                                         | 24h 后台             |

```sh
node docs/verification/batch-api/00-plumbing.mjs
node docs/verification/batch-api/01-tools.mjs
node docs/verification/batch-api/02-cache.mjs

# 03：后台跑一天，每小时提交一个 1 行 batch，每分钟轮询未完成的
nohup node docs/verification/batch-api/03-queue-timing.mjs --hours 24 \
  > docs/verification/batch-api/out/03.log 2>&1 &
# 规模对照：一个 1000 行的 batch
node docs/verification/batch-api/03-queue-timing.mjs --once --lines 1000
# 随时看统计（可与后台循环同时跑）
node docs/verification/batch-api/03-queue-timing.mjs --summarize
# 换模型再跑一份
BATCH_MODEL=qwen3-max nohup node docs/verification/batch-api/03-queue-timing.mjs --hours 24 \
  > docs/verification/batch-api/out/03-max.log 2>&1 &
```

`03` 把 pending 的 batch id 存在 `out/03-pending.json`，中途挂了重跑即续。

## 02 的成本假设

`02` 只算相对成本（以实时 input 单价为 1）：
`(prompt - cached)·1 + cached·CACHE_RATIO + completion·P_OUT`，batch 臂再 ×`BATCH_RATIO`。
默认 `P_OUT=2.5`、`CACHE_RATIO=0.2`、`BATCH_RATIO=0.5`；换模型请按百炼价格页覆盖：

```sh
P_OUT=4 CACHE_RATIO=0.2 node docs/verification/batch-api/02-cache.mjs
```

## 贴回来什么

- `out/00-plumbing.result.json`、`out/01-tools.result.json`、`out/02-cache.result.json` 的 `verdict` 段
- `out/03-queue-timing.summary.json`
- 任何 `FAIL` 时对应 result 文件里的 `errors` / `raw` 段（含百炼的报错原文）

## 用 `qwen batch` 代替脚本

同一分支里 `qwen batch submit/status/fetch/cancel` 已经实现（`packages/cli/src/commands/batch.ts`），
`00` 的管线验证也可以直接用它做：把 `out/00-plumbing.jsonl` 喂给 `qwen batch submit`，再 `status` / `fetch`。
注意命令与脚本读的是不同的环境变量：命令走 CLI 的凭证解析，需要
`OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL`（或 `QWEN_MODEL`）三者齐备
（见 `docs/users/configuration/auth.md`），上面准备块里的 `DASHSCOPE_API_KEY` 它并不读。
记得 body 里显式写 `enable_thinking: false`，否则新模型默认开 thinking。

## `--batch`（置换 v1）的验收——已判定不做

原计划：01 通过即跑一次带工具调用的 `qwen -p "..." --batch` 作为验收。
**实测结果让这一步失去意义**：01 通过，但 02 不通（batch 内隐式与显式缓存臂
均 `cached_tokens: 0`，实时对照 0.647，`cost_vs_realtime = 1.03`），
落在下方判定表的第二行——「只做形态 A（扇出）」。

置换 v1 已从 #11874 移出，本节保留作记录。

## 本地回归（不花钱、不联网）

`fake-dashscope.mjs` 是一个假的百炼兼容服务（`/files`、`/batches`、`/batches/:id/cancel`、
`/files/:id/content`、`/chat/completions`），按场景推进 batch 状态并记录每条请求；
`regression.sh` 驱动**真实 CLI 进程**跑完 happy / stuck 两个场景，
断言退出码、stdout 与请求序列（`fake-dashscope.mjs` 支持 `SLOW_SECONDS`，但本脚本没有启动
slow 场景，`pollJob` 的 slow 分支未被覆盖）：

```sh
bash docs/verification/batch-api/regression.sh   # 约 10–15 分钟（受 tsx 冷启动影响），断言数以脚本末尾的 === N passed === 汇总为准
```

覆盖（R1–R4）：submit 只创建一个 batch（不被内存重启重复提交）、四个子命令退出码、
已结算作业的 cancel 被拒绝（与真实提供方一致）、运行中作业的 cancel 成功、
远端文件在 `--delete` 后被清掉、鉴权门禁（QWEN_OAUTH 下退出 1 且不落进主流程）、
未 settle 时拒绝 fetch。

它证明的是 qwen-code 这一侧的进程行为，**不能**替代上面三个线上探针——百炼是否接受这些请求、
工具调用能否穿过 batch body、batch 内是否命中缓存，只有真打接口才知道。

## 判定

| 01     | 02       | 结论                                                     |
| ------ | -------- | -------------------------------------------------------- |
| 通     | 通       | 值得做 §6 的 headless `--batch` 置换                     |
| **通** | **不通** | **置换技术可行但主循环账是亏的，只做 §3 形态 A（扇出）** |
| 不通   | —        | agent 没有工具，放弃置换，只做形态 A                     |

**实测落在第二行**（2026-09-18/19，华北2·北京，`qwen3.7-max`）：01 通过
（`tools` / `tool_calls` / assistant+tool 历史都能穿过 batch body，
`finish_reason: "tool_calls"` 保留）；02 不通（两条臂 `cached_tokens: 0`，
实时对照 0.647，`cost_vs_realtime = 1.03`）。按本表执行：只做形态 A。
