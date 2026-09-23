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

`workflow-e2e.mjs` 验证 agent-prepared 工作流（`qwen batch run|collect|retry|list`、
`cancel --task`）：自带假 Batch API、隔离 `HOME`，驱动构建产物 `dist/cli.js`
走完整链路——提交、运行中收取、`--wait` 收取、文件交付、幂等重收、截断失败、
失败项重试、目标冲突 held、解决后交付、任务取消，共 22 项断言。

```sh
npm run build && npm run bundle
node docs/verification/batch-api/workflow-e2e.mjs "$(pwd)/dist/cli.js"
```

不需要网络与真实凭证；与上面四个线上探针（需要 `DASHSCOPE_API_KEY`）互补。

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
