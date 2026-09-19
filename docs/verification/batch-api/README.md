# Bailian Batch API 探测脚本

配套 `docs/plans/2026-09-14-batch-api-feasibility.md` §6 的三个待测问题。
脚本只打百炼接口，不碰仓库代码；跑完把 `out/*.result.json` 贴回来即可。

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

| 脚本                  | 回答的问题                                                                           | 通过标准                                                                                    | 耗时                 |
| --------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------- |
| `00-plumbing.mjs`     | JSONL 格式、状态流转、结果下载是否通                                                 | `status=completed`，3 行全在 output，0 行在 error                                           | 分钟级               |
| `01-tools.mjs`        | `tools` / `tool_calls` / 带 assistant+tool 历史的 `messages[]` 是否直通（§6 问题 1） | L1 `finish_reason=tool_calls` 且工具名 `get_time`；L2 回答含 `10:30`；L3 有内容；error 为空 | 等一次 batch         |
| `02-cache.mjs`        | batch 内能否命中 context cache（§6 问题 2）                                          | 对照组实时 `cached_tokens>0`；看两个 batch 臂是否也 >0；`cost_vs_realtime` <1 才是真省      | 等两次 batch（并行） |
| `03-queue-timing.mjs` | 1 行 batch 的排队 / 执行时长分布（§6 问题 3，§7 经验 ETA 的种子）                    | 无 pass/fail，看 `queue_s` / `total_s` 的 p50 / p90                                         | 24h 后台             |

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

## `--batch`（置换 v1）的验收

`qwen -p "..." --batch` 已实现：主循环每一跳走 Batch API，side-call / 压缩 / 子 agent 仍是实时。
它的验收就是 01：如果 01 通，跑一次带工具调用的 `qwen -p "列出当前目录文件并总结" --batch`，
应看到 stderr 打出 `[batch] submitted batch_xxx`，等待后正常完成一轮工具调用。
TUI 下 `--batch` 会被 `.check()` 拒绝；QWEN_OAUTH 或非 DashScope 端点在启动时被门禁直接拒绝
（不发出任何请求）；`pipeline.ts` 里 `runBatch` 的抛错是 core 侧的兜底。

## 本地回归（不花钱、不联网）

`fake-dashscope.mjs` 是一个假的百炼兼容服务（`/files`、`/batches`、`/batches/:id/cancel`、
`/files/:id/content`、`/chat/completions`），按场景推进 batch 状态并记录每条请求；
`regression.sh` 驱动**真实 CLI 进程**跑完 happy / tools / failed / stuck / unpollable 五个场景，
断言退出码、stdout 与请求序列（`fake-dashscope.mjs` 支持 `SLOW_SECONDS`，但本脚本没有启动
slow 场景，`pollJob` 的 slow 分支未被覆盖）：

```sh
bash docs/verification/batch-api/regression.sh   # 约 10–15 分钟（受 tsx 冷启动影响），断言数以脚本末尾的 === N passed === 汇总为准
```

覆盖：submit 只创建一个 batch（不被内存重启重复提交）、四个子命令退出码、已结算作业的 cancel
被拒绝（与真实提供方一致）、鉴权门禁、`--batch` 对 `-i` 的拒绝、`--batch` 两跳工具调用端到端、
失败时透出服务端原因且不重试、未 settle 时拒绝 fetch、SIGINT 触发服务端 cancel、
只有主循环走 batch（side-call 保持实时）、以及不可轮询的作业被放弃时输入文件保留、
错误信息指向 `qwen batch fetch`（R8/R9）。

它证明的是 qwen-code 这一侧的进程行为，**不能**替代上面三个线上探针——百炼是否接受这些请求、
工具调用能否穿过 batch body、batch 内是否命中缓存，只有真打接口才知道。

## 判定

| 01   | 02   | 结论                                                 |
| ---- | ---- | ---------------------------------------------------- |
| 通   | 通   | 值得做 §6 的 headless `--batch` 置换                 |
| 通   | 不通 | 置换技术可行但主循环账是亏的，只做 §3 形态 A（扇出） |
| 不通 | —    | agent 没有工具，放弃置换，只做形态 A                 |
