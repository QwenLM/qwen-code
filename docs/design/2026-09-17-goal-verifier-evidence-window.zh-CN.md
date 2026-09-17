# 基于当前轮证据窗口的 Goal 验证

[English](2026-09-17-goal-verifier-evidence-window.md) | [简体中文](2026-09-17-goal-verifier-evidence-window.zh-CN.md)

状态：提议中，2026-09-17。跟踪 issue：#12053。行号基线：upstream `main` 的 `b8def02aad`。

## 问题陈述

Goal 的终态提案（`update_goal` 提出 `complete` 或 `blocked`）由独立的 verifier 判定。目前 verifier 收到的是模型从一个有界目录（100 条 / 24 000 字节预览，`goal-evidence.ts:32-33`）里按 UUID 引用的 transcript 记录，另有一个 checkpoint side query 把旧证据压缩成 claim，使其仍可被引用。

2026-09-16 的两个 `/goal-draft` 会话各在一个约一百次工具调用的 Goal turn 里完成了任务。每一步模型输出都记录一条 assistant 记录和一条 tool 记录，目录远在结束前就溢出；`update_goal` 仅因目录被截断就拒收提案（`goal-tools.ts:359-376`）；轮末 checkpoint 要用一次性的 fast model 查询压缩溢出的窗口，其中一个模型三次压缩失败后 Goal 以 usage-limited 停机。`/goal resume` 之后目录为空，工具仍让模型用它不可能拿到的 UUID 重试。两个会话里 verifier 最终采信的证据都是模型在收尾轮重跑的校验输出：交付物在磁盘上，检查可以重跑。

第一次替代方案（PR #12060，已关闭）改变了 verifier 看到的内容，但从零重新推导打包策略，丢掉了旧路径持有的不变式；四轮评审每次都发现同一类边界问题。本文档就是那次尝试跳过的设计步骤：旧路径的每条不变式都列出并标注 keep / drop / replace，运行时其他部分对该路径的每条假设都列出处理方式，之后才把代码切成可评审的步骤。

## 现状

- `update_goal` 要求 `evidenceRefs`，对照最新的 `get_goal` 目录校验，自动补引本轮交付输出，目录被截断时直接拒收提案（`goal-tools.ts:295-376`）。
- verifier 收到被引用记录的全文，仅受被引用内容 256 000 字节总量与 256 000 字节请求上限约束（`goal-evidence.ts:44`、`goal-verifier.ts:14`），超时 30 秒、只尝试一次（`goal-verifier.ts:13`、`:199`）。
- blocked 策略的可判定部分在 `validateBlockerCoverage` 中执行（`goal-evidence.ts:898-966`）：infeasible 需要 `external_fact`；immediate 需要 `user_input` 或 `external_fact`；repeated 需要当前轮与前两个 lineage 轮各有非助手证据。
- 轮末 checkpoint（`goal-checkpoint-verifier.ts`，fast model，`maxAttempts: 1`）把证据压缩为最多 32 条 claim；连续三次停滞停机（`goal-runtime.ts:1292-1308`）；非零停滞计数压制无进展暂停（`goal-runtime.ts:1932`）；evidence-limited 的 Goal resume 时重指 cursor 并丢弃 checkpoint（`goal-reducer.ts:237-252`）。
- 两个会话实测：每个收尾轮约 140–150 条记录、原始内容约 500 kB；工具结果中位数 2–3 kB，p90 约 10 kB，92–99 % 不超过 16 kB。

## 目标

1. 任意长度的轮次都能被判定：提案不会因 transcript 大小被拒收，Goal 不会因记账溢出停机。
2. 模型无需引用：`update_goal` 只接受状态与理由。
3. 旧路径仍有意义的每条保证要么保留、要么换成明确的等价物；每条放弃都是有意为之并写明。
4. verifier 的请求总能放进上限，且按真实请求计算，不靠恰好相等的常量。
5. 关于用户的断言所需的证据，无论 Goal 跑了多久、用户写下时 Goal 处于什么状态，都能拿到。

## 范围边界

- 范围内：verifier 的输入及其构建、`update_goal` / `get_goal` 契约、运行时的验证路径与错误映射、checkpoint 的停用与后续删除、描述判定方式的提示词与用户文档。
- 范围外：去掉 verifier（Codex 式方案已被维护者否决）、Goal 状态机、预算、暂停原因、审批对话框、legacy 的 `active_goal` 投影，以及 Web Shell Goals 页除删 checkpoint 字段以外的部分。

## 方案

### 窗口

`complete` 提案：verifier 收到提出提案那一个 Goal turn 的 `assistant_output` 与 `tool_result` 记录。`blocked` 提案：当前轮加 lineage 中紧邻的前两轮。任何提案：还收到用户自己的 `real_user` 消息，来自会话任意位置，有无 Goal turn 上下文都算；在没有 Goal turn 运行时发出的消息 turn id 记为 `outside_goal_turn`。记录最新在前。

lineage 由现有的 `collectLineageTurnIds` 从 evidence cursor 起向后读取；cursor 之前的记录只为收集用户消息而读，不做 lineage 校验。当前轮尚无记录时得到空窗口，verifier 拒绝并回灌反馈；当前轮在 lineage 中但不在尾部是源故障（`current_turn_not_tail`）。

### 打包

每条记录的内容上限 16 000 字节：保留前 6 000 字节与剩余预算对应的尾部，中间放标记，切口在码点边界。对所有 provenance 一致：工具结果的汇总行在末尾，用户消息的决定在末尾，交付物往往需要超过两千字节才能判定。

一条记录的成本是它的序列化形式（`uuid`、`provenance`、`turnId`、`proofKind`、`content`）加数组逗号。预算 = 256 000 字节请求上限减去实测的 envelope（objective、提案理由、blocked policy、三个 turn id、omitted 计数），最多 224 000 字节。剩余不足 64 000 字节时，Goal 以指明应缩短 objective 的理由停机。

记录按以下顺序装入，每一遍最新在前，放不下的记录跳过而不是结束这一遍：当前轮最新一条；blocked 提案时，前两轮各最新一条非助手记录；最新四条用户消息或预算的八分之一，先到者为准；然后其余所有记录按 transcript 位置装入。记录在某一遍扫描到它时才渲染；剩余预算装不下最小记录时该遍停止。窗口报告有多少条合格记录被留下。

### 覆盖规则与打包解耦

blocked 策略的可判定部分在 lineage 记录上判定，而不是在打包结果上，这样预算紧张不会把证据充分的 blocker 变成拒绝：infeasible 需要当前轮有一条 `tool_result` 记录；authority 或 external 需要会话任意位置有 `real_user` 记录或当前轮有 `tool_result`；repeated 需要 lineage 至少三轮，且最近三轮各有一条 `tool_result` 或 `real_user` 记录。不满足的提案在本地被拒绝并以规则作为反馈，不调用 verifier。运行时对 repeated blocker 的指纹审计（连续三轮、相同 kind 与 reason）仍是第一道门。

### verifier 调用

超时随请求增长：30 秒加每 32 kB 15 秒，上限 180 秒。在整个窗口上失败（超时、provider 错误、上下文长度）的 verifier 用一半预算重建窗口再试一次；第二次失败以真实错误停机。verifier 内的请求大小防护保留为最后兜底，预算既然按 envelope 测量，正常运行中不会触发。

系统提示词说明：evidence 是提出提案那一轮的记录最新在前（blocked 提案为三轮），用户消息来自会话任意位置以及 `outside_goal_turn` 的含义，带标记的截断两侧为原文，omitted 计数的含义。`user_input` 规则不变。

### 错误映射

| 条件                                                                                    | 结果                      | `limitKind`        | 恢复                        |
| --------------------------------------------------------------------------------------- | ------------------------- | ------------------ | --------------------------- |
| 覆盖规则不满足                                                                          | reject，附规则            | —                  | 下一轮                      |
| transcript 无法归属（cursor 缺失或重复、cursor 之后的畸形上下文、重入、当前轮不在尾部） | `usage_limited`           | `evidence_catalog` | resume 重指 cursor          |
| envelope 留不下 64 000 字节                                                             | `usage_limited`，专用理由 | —                  | `/goal edit` 缩短 objective |
| verifier 两次失败                                                                       | `usage_limited`，真实错误 | —                  | resume 重试                 |
| verifier 拒绝                                                                           | 现有路径，下一轮回灌反馈  | —                  | —                           |

### 模型侧契约

`update_goal({ status, reason, blockerKind? })`；`evidenceRefs` 接受并忽略一个版本；schema 只要求 `status` 与 `reason`。`get_goal()` 返回 Goal 摘要与 verifier 反馈；`view` 参数接受并忽略。删除 `invalidEvidenceRefs`、自动补引与 `checkpointRequired` 三道门。continuation prompt 告诉模型 verifier 只看提出提案的那一轮、决定性检查要在 `update_goal` 之前立即执行，对持续存在的 blocker 用"报告"而非"引用"，并带完成审计。`/goal-draft` 技能同样描述判定方式，并写明 `propose_goal` 的 1 500 字符上限。

### checkpoint

运行时创建时不接 checkpoint verifier，因此不再创建 checkpoint attempt（PR #12073）。旧版本留下的待处理 checkpoint 在恢复时丢弃，旧版本记录的停滞计数清除，没有接 checkpoint verifier 时无进展上限忽略停滞计数。窗口接线后再删除 checkpoint 代码、目录与引用校验。

## 设计决策与理由

- **完成只看当前轮**而不是最近 N 轮：与技能的契约一致（提出完成时跑指定检查并贴出那一行），与两个会话实际的完成方式一致，并且避免陈旧证据"证明"当前状态。
- **覆盖规则在 lineage 记录上判定，不在窗口上**：规则关乎模型做了什么，不关乎请求装下了什么；在打包结果上判定使它们依赖预算算术，这正是被关闭的 PR 反复出错的地方。
- **用户消息来自任意位置、不论有无 Goal 上下文、包括 cursor 之前**：它们是用户说过什么的唯一证明且无法再生；Goal blocked 期间或 edit 之前给出的批准仍是批准。相关性交给 verifier 判断。
- **所有 provenance 一样的单条上限、中间截断**：实测工具结果多在 16 kB 以内，决定断言的信息在两端。
- **预算由实测 envelope 得出**而不是固定预留：`/goal set` 接受任意长度的 objective，固定预留不是浪费就是不够。
- **半窗重试而不只是加大超时**：模型装不下的请求不会因为等得久而装得下。
- **保留 verifier**：它是文档写明的 Goal 判定承诺，也是与纯 prompt 自审的差别；它本身成本很小，贵的是喂它的账本。

## 约束

- verifier 请求保持在 256 000 字节以内，是配置的 fast model 上的一次 side query。
- `GoalSnapshotV2` 版本不变；删除的字段都是可选字段；旧快照与旧客户端仍能解析。
- 宿主对 `terminateTurn`、`goalContext` 戳、预算、wind-down、无进展与遥测的处理不变。
- reducer 里 evidence-limited 的 resume 分支保留，源故障依赖它。

## 风险

- 早先轮次跑过的检查必须在提出提案的那一轮重跑，否则 verifier 拒绝；技能与提示词都已说明，拒绝带反馈。
- 超过 16 000 字节的记录丢失中段；写在中段的决定性行看不到。
- 超过用户消息份额的长消息可能被跳过而让位给更短的；最新四条总是先尝试。
- verifier 最多读约 60 000 token；上下文更小的模型退回一次半窗，再失败则以 provider 的错误停机。

## 验证计划

- 窗口构建器的单元测试覆盖：最新在前；两种 provenance 的中间截断与码点边界；按序列化字节的预算与被跳过记录的计数；64 kB 预算下的优先级各遍（当前轮、前两轮与长粘贴后的短批准都在）；无 Goal 上下文的用户消息；以 cursor 为界的 lineage（cursor 之前的异常被忽略，之后的是源故障）；重复 UUID 拒绝；无记录轮次的空窗口。
- 覆盖规则在 lineage 记录上的单元测试，每条规则、每种失败各一。
- 组合测试把真实的 `createGoalVerifier`（provider 打桩）接到按 envelope 剩余预算构建的窗口上，配最长的理由与转义密集的记录，断言请求放得下且装满。
- 运行时测试：140 条记录的轮次完成；四种 blocked；不调 verifier 的覆盖拒绝；resume 通过重指 cursor 恢复的 lineage 故障；250 kB objective 以专用理由停机；半窗重试与第二次失败后的停机；恢复的停滞计数不再豁免空转的 Goal。
- CLI 测试覆盖 continuation prompt 文案与 `terminateTurn` 路径。
- 接线 PR 合入前，用 2026-09-16 的一个 objective 在构建后的 CLI 上做一次真实重放。

## 验收标准

1. 一百次工具调用的 Goal turn 提出完成后，一轮内到达 verifier，收尾检查通过即完成。
2. `update_goal` 不再因目录状态拒收提案；`get_goal` 不返回目录。
3. 下方不变式表中的每一行要么仍有测试钉住，要么标注为放弃并给出理由。
4. 生产中不再运行 checkpoint side query；从旧版本记录恢复的会话既不失败也不保留停滞计数。
5. 用户文档与技能对判定方式的描述与本文一致。

## 交付步骤

| 步骤 | 内容                                                                                        | 行为变化 |
| ---- | ------------------------------------------------------------------------------------------- | -------- |
| 0'   | 本文档                                                                                      | 无       |
| A    | PR #12073：停止运行 checkpoint，恢复时丢弃过期 checkpoint 状态，门控停滞豁免                | 有       |
| B1   | 纯函数：窗口构建器、覆盖规则、envelope 测量、超时函数，含单元与组合测试；不接线             | 无       |
| B2   | 把窗口接入验证路径；错误映射；重试；`update_goal` / `get_goal` 契约；提示词、技能与用户文档 | 有       |
| C    | 删除 checkpoint 代码、目录与引用校验、相关常量与 `checkpoint_request` limitKind             | 无       |
| D    | 从 SDK、Web Shell、CLI 与文档中删除 checkpoint 字段                                         | 无       |

## 未决问题

已于 2026-09-17 与维护者确定：完成只看当前轮；用户消息保底四条或预算的八分之一，同样 16 000 字节截断；前两轮装不下时 verifier 按 blocked policy 与当前轮判定 repeated blocker；用户消息从会话任意位置获取，不限 Goal 创建时间；B1 与 B2 分开。

## 附录 A：现有路径的不变式

K = 原样保留；R = 替换为所述保证；D = 连同测试删除，附理由。测试名指 `b8def02aad` 上的套件。

### `goal-evidence.test.ts`

| 测试                                                                          | 决定  | 说明                                                    |
| ----------------------------------------------------------------------------- | ----- | ------------------------------------------------------- |
| bounds the catalog while retaining the newest evidence                        | D     | 无目录；最新在前由窗口继承                              |
| scopes the truncated catalog gate to full-window coverage proposals           | D     | 无截断门                                                |
| keeps the catalog whole when only ineligible records sit past the entry cap   | D     | 无目录                                                  |
| keeps the catalog whole when a whitespace-only record sits past the entry cap | R     | 空内容既不装入也不计入 omitted                          |
| fails closed when truncation evicts a repeated blocker turn                   | R     | 覆盖在 lineage 记录上判定                               |
| keeps a repeated blocker validatable while its turns stay catalogued          | R     | 同上                                                    |
| does not expand records older than the bounded catalog window                 | R     | 懒渲染：未扫描到的记录不渲染                            |
| bounds the serialized catalog by UTF-8 bytes                                  | R     | 窗口预算按序列化 UTF-8 字节                             |
| requests a checkpoint before the catalog reaches its byte limit               | D     | checkpoint 已停用                                       |
| caps oversized window content with a truncation marker                        | R     | 16 000 字节中间截断带标记                               |
| does not start truncated under a full checkpoint of multi-byte claims         | D     | 无 checkpoint                                           |
| caps window content on a code point boundary for multi-byte text              | K     | 新截断同样按码点                                        |
| does not expand raw evidence below the checkpoint threshold                   | D     | 无 checkpoint                                           |
| bounds reference count, rejects duplicates, and bounds cited bytes            | R     | 无引用；总量由预算约束                                  |
| admits delivered output larger than the catalog preview budget                | R     | 交付输出整条进入直至 16 000 字节，之后保留两端          |
| admits thirteen delivered outputs plus independent evidence                   | D     | 无引用配额                                              |
| uses a stable cursor and exposes only bounded previews                        | R     | 保留 cursor 向后扫描；排除 thought；无预览              |
| treats only display metadata as real-user evidence                            | K     | `evidenceContent` 投影不变                              |
| keeps mid-turn model text instead of its display label                        | K     | 同上                                                    |
| reports `cursor_unset` / `cursor_not_found` as a source failure               | K     | cursor 定位与剩余目录代码共用                           |
| requires coherent type, subtype, provenance, and goal ownership               | K / R | provenance 一致性保留；`real_user` 不再要求 Goal 上下文 |
| keeps completion available after the lineage display window fills             | D     | 无展示上限                                              |
| rejects permit mismatch, malformed ownership, re-entry, and wrong tail        | K     | 错误码相同；wrong tail 仅当该轮在 lineage 中            |
| requires user or tool evidence for an immediate blocker                       | R     | 在 lineage 记录上判定                                   |
| holds an infeasible blocker to external facts                                 | R     | 同上                                                    |
| gates an immediate blocker on checkpoint claims like raw evidence             | D     | 无 checkpoint claim                                     |
| requires non-self-reported evidence from the last three turns                 | R     | 在 lineage 记录上判定                                   |
| keeps source and reference failures distinguishable                           | R     | 源故障与覆盖失败是不同类型、不同结果                    |

### `goal-verifier.test.ts`

| 测试                                                                                             | 决定  | 说明                                                          |
| ------------------------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------- |
| parses only the exact bounded result union; rejects non-exact output; rejects an overlong reason | K     | 不变                                                          |
| returns the side query usage alongside the decision                                              | K     | 不变                                                          |
| uses a tool-free deterministic side query with bounded fields                                    | K / R | 字段改为 `evidenceTurnIds` 与 `omitted`；提示词更新           |
| includes blocked policy only for blocked proposals                                               | K     | 不变                                                          |
| preserves the legacy delivered-output input contract                                             | D     | 删除 `currentDeliveredOutput`；运行时始终发送 `currentTurnId` |
| keeps maximum valid evidence and proposal reason within the request limit                        | R     | 组合测试：按 envelope 预算构建的窗口加最长理由放得下          |
| rejects an unbounded verifier request before calling the provider                                | K     | 保留为兜底                                                    |
| propagates provider failure and clears its timeout                                               | K / R | 超时随请求增长；运行时半窗重试                                |
| combines caller cancellation with its timeout                                                    | K     | 不变                                                          |

### `goal-tools.test.ts`

| 测试                                                                                                                                      | 决定 | 说明                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------- |
| `GetGoalTool`：规范名称、可见性、无 permit 时的 `lastGoal` 摘要、持久化不可达                                                             | K    | 不变；checkpoint 健康行在步骤 D 随字段删除    |
| returns only the bounded worker view for the captured permit                                                                              | R    | 返回 `{ active, snapshot, verifierFeedback }` |
| exposes the view parameter and nothing else                                                                                               | R    | `view` 保留为废弃可选                         |
| collapses checkpoint claims in the summary view; returns the whole catalog in the full view; steady-state summary ceiling                 | D    | 无目录                                        |
| `UpdateGoalTool`: exposes the exact evidence and non-terminal response contract                                                           | R    | 新契约断言                                    |
| rejects lineage turn ids before recording a proposal                                                                                      | D    | 无引用                                        |
| cites this turn's delivered output; does not duplicate cited output; leaves a blocked proposal to cite what it chose                      | D    | 无自动补引                                    |
| checkpoints a truncated catalog before recording completion; keeps truncated repeated blockers eligible                                   | D    | 无 `checkpointRequired` 门                    |
| records one proposal; audit-only proposals; second proposal in the same turn; stale permit; cancellation; disposal; no lifecycle controls | K    | 不变                                          |
| requires a non-empty reason and stable evidence references                                                                                | R    | 只校验 reason                                 |

### `goal-runtime.test.ts`（验证相关）

| 测试                                                                                                                                             | 决定  | 说明                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------- |
| requires evidence source and verifier dependencies as a pair                                                                                     | K     |                                                                 |
| persists verifier usage once; applies the budget gate; stops when the budget is spent                                                            | K     |                                                                 |
| persists verifier acceptance before completing                                                                                                   | K / R | 断言改为 `evidence` 与 `evidenceTurnIds`                        |
| accepts a verified blocker; accepts an evidenced infeasible blocker on its first turn                                                            | K     | 覆盖在 lineage 记录上满足                                       |
| rejects an invalid evidence reference without calling the verifier                                                                               | R     | 覆盖失败在本地拒绝                                              |
| stops continuations when completion evidence exceeds the catalog                                                                                 | R     | 超长 objective 以专用理由停机；长轮次完成                       |
| does not accept catalog exhaustion as an external blocker                                                                                        | D     | 无目录                                                          |
| lets a repeated blocker streak reach the verifier when the catalog truncates                                                                     | R     | 三轮各有工具证据时到达 verifier                                 |
| checkpoint 调度、重放、provider 失败、停滞熔断、分批                                                                                             | D     | 步骤 A 后不可达，步骤 C 删除                                    |
| checkpoints after the verifier rejects; rejection cause below threshold; feedback kept when the checkpoint fails                                 | R     | 拒绝后不再创建 checkpoint；反馈保留                             |
| preserves raw lineage when a repeated blocker verifier rejects                                                                                   | K     | cursor 不变                                                     |
| moves to `usage_limited` when flush / read / cursor / provider fail                                                                              | K / R | 源故障带 `evidence_catalog`；provider 失败先半窗重试            |
| 排队的用户输入、edit / pause / disposal 之后的在途结果、持久化失败、单次 continuation 快照、pause 追加失败时验证继续                             | K     | 不变                                                            |
| returns only a bounded evidence catalog and rejects it after stale I/O                                                                           | R     | `getGoalForWorker` 不读 transcript                              |
| returns a bounded catalog without exposing full evidence content                                                                                 | D     | 无目录                                                          |
| 防御性 worker 状态；超长理由；repeated 审计的规范化、恢复、上限、pause 重置、连续性；authority / external 立即可验证；无 verifier 时的待处理提案 | K     | 不变                                                            |
| 无进展组                                                                                                                                         | K / R | 停滞豁免仅在接了 checkpoint verifier 时生效；恢复的停滞计数清除 |
| lets the checkpoint stall breaker outrank the bound                                                                                              | R     | 仅在注入 checkpoint verifier 时成立；步骤 C 删除                |

### `client-goal.test.ts`、`goal-turn-integration.test.ts`、`Session.test.ts`、`nonInteractiveCli.test.ts`

全部 K：`goalContext` 戳、Goal 工具自身结果的 `goal_runtime` 来源、`terminateTurn` 语义、continuation 中的 verifier 反馈。只有 CLI stream 测试里断言的 continuation 文案字面随提示词改动。

## 附录 B：运行时其他部分的假设

| 假设（位置）                                                                                             | 处理                                                       |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| verifier 30 秒超时、一次尝试（`goal-verifier.ts:13`、`:199`）                                            | 超时随请求增长；运行时半窗重试                             |
| 256 000 字节请求（`goal-verifier.ts:14`）                                                                | 预算由它减去实测 envelope 得出；防护保留                   |
| `maxItems: 100` 隐含被引用内容至多 200 000 字节（`goal-tools.ts:447`）                                   | 由预算替代                                                 |
| 被引用记录整条发送（`goal-evidence.ts:1124-1147`）                                                       | 16 000 字节中间截断，以实测尺寸为据                        |
| `runVerification` 错误映射（`goal-runtime.ts:1165-1185`）                                                | 见上表                                                     |
| `goalLimitKindForReason` 只认两个字符串（`goal-protocol.ts:308-318`）                                    | 不变；源故障显式设置 `limitKind`                           |
| evidence-limited 的 resume 分支（`goal-reducer.ts:237-252`）                                             | 为源故障保留；步骤 C 不删                                  |
| cursor 在 create / edit / resume / checkpoint 时移动                                                     | checkpoint 不再移动它；其余不变                            |
| 无进展的停滞豁免（`goal-runtime.ts:1932`）                                                               | 门控于已接 checkpoint verifier                             |
| 恢复 `checkpointPending` 时缺依赖抛错（`goal-runtime.ts:1628-1641`）                                     | 未接 checkpoint verifier 时丢弃                            |
| `config.ts:10127` 接入 checkpoint verifier                                                               | 已移除                                                     |
| UI、SDK、Web Shell 与遥测读取 `checkpointStalls`、`lastCheckpointFailure`、`limitKind`、`evidenceCursor` | 步骤 D 删字段；`limitKind` 取值收窄；`evidenceCursor` 保留 |
| `chatRecordingService` 打 `goalContext` 戳并排除 `goal_runtime` 结果                                     | 不变                                                       |
| 宿主处理 `terminateTurn`                                                                                 | 不变；只剩 `readyForVerification` 触发                     |
