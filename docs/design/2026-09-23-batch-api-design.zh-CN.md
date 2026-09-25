# `/batch-api` 设计

[English](./2026-09-23-batch-api-design.md)

状态：已在 PR #12492 中实现。用户指南：`docs/users/features/batch.md`。
实测数据：`docs/verification/batch-api/results-2026-09-23.md`。

## 1. 目标

用户用一句话描述一个批量任务，主动选择异步 Batch 模式，之后直接拿到写好的文件。

- agent 只做语义工作：判断任务是否适合、抽样阅读 2–3 个文件、写共享规则、生成 plan 文件。
- Batch API 负责批量生成。
- 确定性代码负责提交、故障恢复、结果校验、交付和记账。

适用范围：大量**相互独立、单轮**、材料现在就齐全的转换，例如按统一风格翻译一组文档、逐个文件改写或抽取。需要反复反馈的任务、前后有依赖的任务、只有少量条目的任务都不适合。

## 2. 入口

### 2.1 `/batch-api <task>`（交互式 skill）

- 位于 `packages/core/src/skills/bundled/batch-api/SKILL.md`，与实时并行的 `/batch` 并列，不替代它。
- `disable-model-invocation: true`：只有用户能进入 Batch 路径；`/batch` 的描述里只允许模型**建议**用户输入 `/batch-api`。
- `allowedTools` 只预先放行只读工具（`glob`、`grep_search`、`read_file`）；写 plan 和 `qwen batch run`（会花钱）仍要经过审批。
- 流程：
  1. 先用 `qwen batch --help` 确认 CLI 有这些子命令（旧版 CLI 会把 `batch check` 当成计费的提问），再用 `qwen batch check` 检查凭据、endpoint 和 Batch 路由，并显示一次提交会冻结的参数。不产生计费；失败就停止，不在准备上花钱。
  2. 判断任务是否适合。不适合就说明原因并停止，**绝不悄悄改用实时模式自己做**。
  3. 轻量准备：glob 出文件，抽样读 2–3 个，写一份共享规则。
  4. 把 plan 写到 `.qwen/batch/plans/<slug>.json`。
  5. 先用 `qwen batch run <plan> --dry-run` 预览（不上传），把条目数、冻结参数和估算费用展示给用户；再用 `qwen batch run <plan> --expect <digest>` 提交这份快照。批准这条命令就是付费决定，而且是在看过预览之后做出的；预览之后内容有变化的批次会被拒绝。
  6. 以后台 shell 启动 `qwen batch collect <task-id> --wait`，然后结束本轮（§6）。
  7. 后台进程退出时 agent 被唤醒一次：汇报结果，只做用户要求的后续动作；从不重试（重试要再付钱），也不自己重做任何条目。
- 所有命令都以 `"${QWEN_CODE_CLI:-qwen}" batch …` 调用，确保用的是当前会话这个 CLI。

### 2.2 `qwen batch` 子命令（确定性执行器）

| 命令                | 行为                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `check`             | 检查凭据、endpoint 和 Batch 路由；显示 `run` 会冻结的参数；不计费                                                                   |
| `run <plan>`        | 校验 plan → 组装请求 → 估算 → 预算闸门 → 提交 → 记录；`--dry-run` 在上传前停下并打印快照 digest，`--expect <digest>` 只提交这份快照 |
| `collect <task-id>` | 对账 → 轮询（可加 `--wait`）→ 下载 → 校验 → 交付 → 报告                                                                             |
| `retry <task-id>`   | 只把 `failed` 的条目作为新 attempt 重新提交；被截断的需要 `--max-output-tokens`                                                     |
| `list`              | 列出已记录的任务（只读本地，不需要凭据）                                                                                            |
| `cancel <task-id>`  | 取消任务当前的 batch（已完成的请求照样计费）                                                                                        |
| `clean <task-id>`   | 删除本地记录，不取消任何东西；batch 可能仍在跑时拒绝，除非加 `--force`                                                              |

`run` 打印 task id 后立即退出，等待不消耗 agent 轮次。`collect` 可以重复执行任意次。

不提供原始的 `submit` / `status` / `fetch` 命令：超出文档转换契约的需求应做成新的 plan kind，而不是旁路。

## 3. 架构

```text
用户：/batch-api "把 docs/zh 翻译成 docs/en"
        │
        ▼
准备 skill（batch-api/SKILL.md）：只做语义工作，实时运行
        │  plan JSON（§4）
        ▼
执行器 batch-workflow.ts：run / collect / retry / cancel / clean / check / list
  ├─ batch-task.ts    账本：task / item / attempt 记录，原子写入，按任务加锁
  ├─ batch-docs.ts    组装请求、校验结果、交付文件
  └─ batch-client.ts  HTTP 原语；出错时带上 HTTP 状态码
        │
        ▼
batch.ts：endpoint / 鉴权解析，CLI 命令注册

交互式会话：batch-auto-collect.ts（由 startPostRenderPrefetches 启动）
  → 对本项目的未完成任务调用同一个 collectTask
```

### 设计不变量

- **账本不靠猜就能回答"远端可能存在哪些对象"。** 上传前先落盘提交意图，create 前先落盘上传得到的 file id。create 的响应丢失，或进程在 create 途中死掉，都把 attempt 记为 `submit-unknown`；`collect` 按 `input_file_id` 到服务端的 batch 列表里对账，**绝不盲目重交**，因为判断错了就要付两次钱。
- **记录跟着用户，不跟仓库。** 任务记录放在 `~/.qwen/batch`（可用 `QWEN_BATCH_HOME` 覆盖），权限 0700/0600，记录中保存项目根目录，在任何目录下都能操作。只有 agent 写的 plan 文件留在项目里，且被 git 忽略。
- **任务绑定 endpoint。** `run` 冻结 base URL 和 API key 的短哈希（不保存 key 本身）；之后 `collect` / `retry` / `cancel` 发现配置变了就拒绝执行，因为换了账号或地域就看不到原来的 batch。
- **同一任务同一时刻只有一个命令在跑。** 每个任务一个锁文件，记录 pid 和主机名。只有确定释放了才接管：锁写在本机、且那个 pid 已经不存在。另一台主机的锁永远不接管。旧锁恢复通过独占的 `lock.recover` 文件串行执行，删除前再次核对持有者。如果恢复本身崩溃，下一次旧锁恢复会拒绝执行；错误信息列出两个待清理文件，确认没有命令运行后才能删除。
- **custom_id = `<itemId>#<attempt>`**，重试之后结果仍能准确对回条目。每个条目记下拥有它的 attempt，只有这个 attempt 的结果行能改变它：旧 attempt 的失败不会把条目重新打开、导致再付一次钱。
- **交付不覆盖已有文件。** 目标文件已存在且内容不同就判为冲突（held）；内容相同算作已交付，因此重复 collect 是幂等的。写入前重新计算源文件哈希，提交后被改过的源文件会让结果 held。
- **Batch 沿用用户的实时设置。** `run` 把配置里的 `samplingParams` 和 `extra_body` 按实时路径的方式（原样发送、`extra_body` 最后合并）冻结进任务，每次重试都复用。关闭 reasoning 时按实时路径的 Qwen 写法冻结（分档模型用 `reasoning_effort: "none"`，其余用 `enable_thinking: false`），其他模型家族只报告不发送；输出上限写在冻结参数已使用的字段上（`max_completion_tokens` / `max_new_tokens`，否则 `max_tokens`）。
- **没有单价就不给金额估算。** token 估算总会显示（粗略：拉丁文字约 4 字符/token，中日韩文字约 1.5 字符/token）。金额估算需要 `QWEN_BATCH_INPUT_PRICE_PER_1M_USD` / `QWEN_BATCH_OUTPUT_PRICE_PER_1M_USD`。plan 的 `maxCostUsd` 是**估算闸门，不是账单上限**；设了它却没配单价时拒绝提交。
- **记账会说明自己的缺口。** 用量汇总所有 attempt 的结果文件；有结果行缺少用量时，总数标为不完整，绝不静默当作 0。会话里的准备开销执行器看不到，所有报告都会注明。Batch 的用量不计入会话的缓存统计。

## 4. Plan schema（v1）

```json
{
  "version": 1,
  "name": "translate-docs",
  "kind": "document-transform",
  "completionWindow": "24h",
  "maxCostUsd": 2.0,
  "maxOutputTokens": 4096,
  "expectedOutputTokensPerItem": 1500,
  "shared": {
    "system": "可选的 system prompt",
    "instructions": "共享规则：术语、风格、输出约定"
  },
  "items": [
    {
      "id": "intro",
      "source": "docs/zh/intro.md",
      "target": "docs/en/intro.md"
    }
  ]
}
```

- 由 `batch-task.ts` 用 zod `.strict()` 校验：
  - item id 须匹配 `[A-Za-z0-9][A-Za-z0-9_-]{0,59}`，因为它会进入 custom_id；
  - id 和 target 都必须唯一；
  - target 必须在项目内，且不能位于任何隐藏路径下（任意层级的 `.git/`、`.github/`、`.qwen/` 等）：交付发生在批准几小时之后、无人值守，不能生成配置工具或执行代码的文件；写不进去的目标在计费前就被拒绝；
  - 未知字段直接报错，agent 写错字段要大声失败，不能悄悄改变行为。
- `kind` 是字面量；新的 kind 使用新的 schema 版本。
- `enableThinking` 只在用户明确要求时才设置；对必须开 thinking 的模型，设为 `false` 会被拒绝。
- 产品契约：**一个源文档 → 一个完整的目标文档**。模型只返回内容，输出里出现的路径或命令都当作数据，不会执行。
- 交付前只做结构校验：非空、没有截断（看 `finish_reason`）、没有 tool call。语义质量由用户验收。

## 5. 边界行为

| 情况                                                    | 行为                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 源路径逃出项目根目录（包括通过 symlink）                | 组装阶段拒绝，任何内容都不上传                                                |
| 组装后单行超过 1 MB                                     | 上传前拒绝，提示拆分文档                                                      |
| create 明确返回 4xx                                     | 删除孤立的上传文件，条目记为 `failed`，可以安全 `retry`                       |
| create 响应丢失（5xx / 连接断开）                       | 记为 `submit-unknown`，`run` 报错退出；`collect` 按服务端列表对账，不重交     |
| 预览之后 plan、源文件或冻结的设置有变化                 | `run --expect` 拒绝提交；不上传，也不保留任务                                 |
| 对账找到 0 个或 2 个以上候选                            | 报告并停止，以服务端列表为准                                                  |
| collect 时 batch 还没结束                               | 报告状态；`--wait` 不持锁地按 10s → 60s 退避轮询，直到结束或到 `--timeout`    |
| 结果被截断 / 返回 tool call / 内容为空                  | 条目 `failed` 并写明原因；被截断的条目要提高输出上限才能重试                  |
| 结果的 custom_id 未知或重复                             | 警告后忽略                                                                    |
| 条目在所有结果文件中都缺失                              | `failed`（"no result line"；整批被拒时写明服务端原因）                        |
| 有结果文件，但没有一行能对上这个 attempt                | 不判任何失败，保留远端文件，丢弃本地副本以便重新下载；collect 会报告          |
| create 被接受，但响应里没有 batch id                    | 记为 `submit-unknown`，按响应丢失的方式对账                                   |
| 源文件在提交后被改动                                    | `held`；`retry` 按新的源文件重新提交                                          |
| 目标已存在且内容不同 / 经 symlink 指向项目外 / 写不进去 | `held`（其他条目照常交付）；处理后再 collect，从本地记录交付，不产生新费用    |
| collect 完成后                                          | 删除远端的输入、输出、错误文件（404 视为已删除）；删除失败时下次 collect 重试 |

重试语义：

- 只重试 `failed` 的条目和因源文件改动而 held 的条目，作为新 attempt、使用新的 custom_id，同样受 `maxCostUsd` 约束。
- 存在 `submit-unknown` 的提交，或之前的 batch 还在跑、已结束但还没收取时，拒绝重试。
- 因目标冲突而 held 的条目永远不重试：它需要用户做决定，而不是再发一次请求。

## 6. 等待与收取（交互式会话）

等待期间不跑 agent loop：轮询由程序用 HTTP 完成，模型只在结果回来时参与一次。

- **后台等待（主路径）。** `run` 之后，skill 用 shell 工具的 `is_background: true` 启动 `qwen batch collect <task-id> --wait`。进程按 10s → 60s 退避轮询，只在收取时持有任务锁，写完目标文件后打印摘要并退出。随后 shell 注册表给模型发一条带输出末尾的 `task-notification`，唤醒 agent 恰好一轮。它在 `/tasks` 里可见，也可以在那里停止。
- **会话内自动收取（兜底）。** 覆盖会话在批次结束前已关闭的情况，以及不经 skill 提交的任务：
  - 首次渲染后启动。扫描本地记录中属于本项目的未完成任务，对每个任务按 1 → 5 分钟退避用 HTTP 轮询，batch 结束后调用同一个 `collectTask`。
  - 启动时的第一轮会补收会话关闭期间完成的任务。
  - 结果通过更新提示的通道发成一条 info 提示；正在输出回复时先排队。
  - 保证：
    - 不调用模型，也不自动重试；失败条目只给出重试命令。
    - 安全性与手动 collect 一致：同样的锁、幂等、不覆盖。
    - 收不了的情况只提示一次：会话没有可用的 Batch 凭据、某次提交在服务端找不到对应 batch、任务绑定到别的 endpoint 或 key（退避等待会话切回），或者连续三轮收取失败。
  - `general.batchAutoCollect`（默认 `true`）可以关闭它。
  - 不覆盖：headless、`qwen serve`、ACP、web-shell——这些场景没有不经过模型的提示通道，请用 `qwen batch collect`。

## 7. 非目标

- 不做实时 / Batch 自动路由，不做付费探测，不做自动修复循环。模式由用户选择，程序只负责如实执行。
- 不做多阶段依赖图；每个 attempt 只对应一个 batch。
- 不把 agent 的逐轮循环放到 Batch 上跑（#11874 已实测并否决）。
- 只实现文档转换这一种契约。代码补丁类交付（应用补丁、构建、测试）将来作为新的 kind，自带验收检查。
