# Hosted A3 —— 混合兄弟审批崩溃窗口

[English](2026-10-31-hosted-a3-mixed-sibling-approval.md) | [简体中文](2026-10-31-hosted-a3-mixed-sibling-approval.zh-CN.md)

状态：提议中，2026-10-31。属于 [#14481][issue]（G3 Step 3 恢复矩阵验收，跟踪
#12380）。扩展 [G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md)
所述 `hosted-failover-e2e` CI job 的打包故障支路。本切片打包矩阵行 A3 的
**native 混合兄弟**那一半；改写输入 / Hook 那一半是有意安排的后续（见范围）。

## 问题

矩阵行 A3 写道：_「先前决定持久；pending 兄弟 ID/顺序存活；重新审批的输入绝不
继承先前的 Allow；已完成的 Hook 不重跑。」_ 目前 A3 仅有 focused/integration
证据——没有任何打包支路会在一个多调用审批批次内部崩溃替换进程，并证明存活的
兄弟仅凭 MySQL 即可恢复。

这四条子句并不落在同一条可恢复路径上。native 多调用批次 continuation 能证明**前
两条**（先前决定持久；pending 兄弟 ID/顺序存活），外加一个相关的 native 观察项：
pending 兄弟仍需自己的 Allow，绝不被较早兄弟的决策自动放行。矩阵第 3 子句（「重新
审批的输入绝不继承先前的 Allow」）特指被*改写*的输入重新审批，第 4 子句关乎 Hook；
**输入改写与 Hook 不重跑只存在于 Hook/commandStep 路径**，而 native continuation
明确拒绝 Hook/MCP 会话。本支路从不改写输入（`inputRevision` 恒为 1），因此**不**覆盖
第 3 子句的改写输入性质——上述 pending 兄弟观察项更窄，绝不可作为第 3 子句折入 A3
覆盖台账。要把四条捆进一个支路，就必须改生产代码以支持混合 native+Hook
continuation（maintainer-only 的核心改动，超出测试臂切片范围）。因此本切片打包
native 混合兄弟那一半，把改写输入/Hook 那一半延后到 commandStep 后续。

## 现状（在 `main` 的 `0c1b42fa31` 上实证）

- **混合调用。** 一个批次就是一条 assistant 消息里的 N 个 `functionCall` part，
  整体 commit 后按模型顺序一次一个地驱动审批
  （`hosted-workspace-tool-turn.ts:8421` `approve()`，跳过 `index < nextOrdinal`
  与已拒绝的调用）。每次 `ask()`（`hosted-workspace-tool-turn.ts:8835`）新铸一个
  `tool_approval_<hex>` Action ID，发布一份 stage=`approval` 的
  `hosted-approval-continuation` 快照，其 `approvalOrdinal` 即正在询问的调用
  （`captureNativeBatch('approval', requestId, ordinal)`），随后
  `commitDurableWait` 写入 `await_action` checkpoint 与 ACTION 行 `requested`。
  有序的 `calls[]`（每成员含 `runtimeCallId`、`partIndex`、`prepareKey`、
  `requestDigest`、`actionId`、`refusal`）就是兄弟身份与顺序的 durable 记录。
- **恢复判别器。** `findHostedApprovalContinuation`
  （`hosted-approval-continuation.ts:385`）是 `findHostedCommittedModelOutput`
  的审批同构物；它要求 v3 options（任何 v1/v2 都整体放弃恢复），
  `readHostedApprovalContinuation` 深校验 session / definition / snapshot pin、
  `requestDigest`、`argsDigest`、verdict 一致性与 stage/ordinal——任何不符即抛
  `HostedToolRecoveryRequiredError`（阻塞，绝不重放）。
- **pending 兄弟是重挂，而非重铸。** stage=`approval` 恢复时，load 路由
  （`hosted-harness-session.ts:3577`）取 `plan.actionId`（原 pending Action），
  用**原 `options.expiresAt`** 重新挂 waiter（deadline 不重置），只把 verdict
  应用到 `index === plan.approvalOrdinal`，随后调用
  `resumeSavedNativeBatch(plan, plan.approvalOrdinal + 1)`
  （`hosted-harness-session.ts:3875`）。于是 `approve()` loop 跳过每个已决兄弟，
  从 pending 之后继续。
- **file profile 支持 native 多调用捕获。** `captureNativeBatch` 遍历所有
  `batch.requests`，接受
  `read_file`/`write_file`/`edit`/`glob`/`todo_write`/`web_fetch`
  （`hosted-workspace-tool-turn.ts:3621`）。它对
  `(!commandStep && (this.hooks || this.mcp))` 以及无 `publicChildren` 的多调用
  shell profile 返回 `undefined`；`resumeSavedNativeBatch` 对同样的 Hook/MCP
  条件抛 `Unsupported saved batch owner.`（`hosted-workspace-tool-turn.ts:3500`）。
  现有单 `write_file` 支路能成功捕获，这（write_file 非 `planExit`）意味着夹具
  会话跑的是**非 shell 的 file profile**，因此多调用 file 工具批次在同一 profile
  下同样可捕获。
- **改写输入绝不继承 Allow。** producer 写死 `inputRevision: 1`
  （`hosted-workspace-tool-turn.ts:8765`、`:8873`）；版本化靠**新 Action + 新
  inputRef**，且 `hostedActionAllowed`（`hosted-tool-approval.ts:296`）要求决策
  digest 匹配 `(optionId, inputRevision, policyRevision)`。pending 兄弟绝不会被
  先前兄弟的 Allow 自动放行：恢复会在 pending Action 上重挂 waiter，并要求它
  自己的决策。
- **runner 夹具是单调用。** 取证强制
  `originalApprovalPlan.calls?.length !== 1` → 抛错
  （`run-managed-agent-server-e2e.ts:2064`）；fake 模型对 continuation marker 返回
  单个 `write_file` toolCall（`run-managed-agent-server-e2e.ts:1559`）；执行身份
  断言假设只有一个执行。仅存在两个 `QWEN_E2E_*` 钩子，都在
  `hosted-harness-session.ts`（`QWEN_E2E_CRASH_BEFORE_ASSISTANT_COMMIT`、
  `QWEN_E2E_DROP_LOAD_REPLY`）；**不存在审批阶段钩子**。

## 目标与范围

**范围内。** 一个打包的 `hosted-failover-e2e` 支路：在一个两调用 native 审批
批次内部崩溃替换 Harness——sibling[0] 已决、sibling[1] 仍 `requested`——并在
scrash 崩溃代磁盘后仅凭 MySQL 证明：

1. 先前决定持久（sibling[0] 不被重问或重决）；
2. pending 兄弟 ID/顺序存活（恢复出的 plan 与 saved plan 深相等；pending Action
   ID 跨替换保留，deadline 不变）；
3. pending 兄弟不被先前的 Allow 自动放行（它仍需自己的决策）——这是 native
   pending 兄弟观察项，比矩阵第 3 子句的改写输入性质更窄，后者仍在范围外；
4. 每个调用以原执行身份、按 plan 顺序恰好执行一次，Turn 恰好投影一个 terminal
   并带恢复出的答案。

这些是本支路自身的验收观察项；只有项 1–2 直接对应矩阵子句 1–2。项 3 绝不可记录
为矩阵第 3 子句的覆盖。

**范围外。** 改写输入 + Hook 不重跑覆盖（一个 commandStep 后续支路）；混合
native+Hook 可恢复 continuation（需核心生产改动）；real-provider 验收；
full-owner 重启；sibling[1] 的 Deny 变体（先 Allow-only，与其它审批支路一致）。

**无生产行为改动。** 唯一的生产源码改动是一个测试 gated 故障钩子，除非其 env
被设为精确的 session ID 否则完全惰性；在 E2E runner 之外绝不设置。

## 方案

### 窗口选择

崩在**兄弟审批裂缝**（sibling[0] `decided`、sibling[1] `requested`），而非
partial-prepare 裂缝。partial-prepare 裂缝里每个兄弟都已决，因此无法 exercising
子句 3（「pending 兄弟不被自动放行」）以及子句 2 所钉的 pending Action 重挂。
审批裂缝是唯一一个 pending 兄弟必须跨替换存活、并仍需赢得自己决策的窗口。

### 崩溃编排（三代）

- **gen1（原始）。** 驱动批次，`ask()` sibling[0] → `requested`。runner 在此崩溃
  gen1（正如现有支路在第一个 `await_action` 崩溃）。保存的证据：两调用 plan、
  `approvalOrdinal = 0`、`originalApprovalId = Action[0]`。
- **gen2（替换，武装）。** attach，经 load 路由重挂 Action[0]（不经 `ask()`）。
  runner 校验 Action[0] 仍 `requested` 且 deadline 原样，然后 POST Allow[0]。
  `approve()` loop 推进到 ordinal 1，于是 **gen2 的第一次 `ask()` 调用就是
  sibling[1]**。故障钩子在此触发：在 `commitDurableWait` 之后（Action[1]
  `requested` 已 durable）、waiter 阻塞之前，持在一个感知 abort 的 promise 上。
  runner 确认 barrier（MySQL 中 Action[1] `requested` + stderr 行），崩溃 gen2，
  并 scrash 其磁盘。
- **gen3（恢复，未武装）。** attach，用原 deadline 重挂**原** Action[1]。runner
  校验 Action[1] `requested`、deadline 不变、且 Action[0] 仍 `decided`（未被
  重问），然后 POST Allow[1]。gen3 从 ordinal 2 续跑，捕获 final plan，prepare
  并 dispatch 两个调用，settled Turn。

### 测试 gated 钩子

`QWEN_E2E_HOLD_PENDING_SIBLING_APPROVAL`，位于 `ask()`
（`hosted-workspace-tool-turn.ts`），镜像 B3a 钩子：模块级读取 env + 进程级
fire-once 闩；仅当值等于当前 session ID 时触发；仅经新的
`startReplacementHarness(name, holdPendingSiblingApproval = false)` 参数武装在
gen2（gen3 不传）。在 `commitDurableWait` 之后打日志
`qwen serve: E2E holding pending sibling approval for Session <id> call <callId>`，
并 park 在一个 abort signal 触发即 reject 的 promise 上，因此泄漏的 flag 不会把
真实 Session 不可取消地挂死。`process-env-guard.test.ts` allowlist 条目以精确
访问计数钉住新 key。

### 夹具扩展（gated 在 A3 故障上）

所有多调用行为都 gated 在新故障名上，因此现有单调用支路不受影响：

- fake 模型仅在 A3 故障激活时，对 continuation marker 返回**两个写到不同路径的
  `write_file` toolCall**（两个不同的物理写效果）；
- 取证对该故障接受两调用 plan，并记录两个 Action ID 与 saved plan；
- runner 在上述编排点投递**两次**决策（Allow[0] 给 gen2，Allow[1] 给 gen3），
  且在答复 Allow[1] 之前读取 Action[0] 并要求其仍 `decided`、deadline 原样（如此
  重问已决兄弟的恢复会在终态收敛前变红）；
- 执行身份断言检查**两个**执行，各 `SETTLED`、`dispatch_generation = 1`、各带
  自己的原 `prepareKey` / `requestDigest`，并要求其 `settled_at` 按 plan 顺序
  非递减（如此逆序派发会变红）；断言两个文件效果；恰好一个 terminal；恢复出的
  plan 与 saved plan 深相等（顺序、`runtimeCallId`、`partIndex`、Action ID）。

### runner、CI 与契约钉

新增一个 `approvalFaults` 条目（allow-only 叠加，与其它审批支路一致），在穷举
崩溃臂守卫里加一个 barrier 分支（新臂不带 barrier 必须报错），一个 npm script
与一个 `sdk-java.yml` step，并在 `hosted-process-ci.test.js` 抬
`hosted-failover-e2e` 的臂数上限与 timeout。`managed-agent-server-e2e.test.js`
的契约钉钉住 gen2-only 武装、两个调用点与默认值、barrier→crash 切片、以及两
执行身份断言；任何新的 runner 顶层 helper 都配一个注入输入的行为化测试
（`finishedBeforeCommitWindow` 模式）。

### 文档

双语更新 [G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md) §9.1：
十二 → 十三条打包支路，把 A3 的 native 混合兄弟那一半从 focused 移到 packaged，
并记录改写输入 / Hook 那一半的 commandStep 后续。

## 设计决定与理由

- **审批裂缝优于 partial-prepare 裂缝** —— 只有审批裂缝有一个必须赢得自己决策
  的 pending 兄弟（子句 2–3）。
- **`ask()` 里 fire-once 钩子，不数 ordinal** —— gen2 经 load 路由重挂
  sibling[0]，所以它的第一次 `ask()` 必然是 sibling[1]；武装在 gen2 的 fire-once
  闩无需跟踪 ordinal 即落在精确窗口。
- **多调用 gated 在故障名上** —— fake 模型与共享取证/身份断言被每个审批支路
  使用；gating 使单调用支路逐字节不变。
- **钉 Action ID 保留，而非重铸** —— 恢复重挂原 pending Action；支路断言 ID 与
  deadline 存活、且 sibling[0] 绝不被重问。`inputRevision` 保持 1；「Allow 不
  继承」的保证经由独立的 pending Action 及其所需决策来钉，而非 revision 递增。

## 约束与风险

- **共享夹具回归。** fake 模型与执行身份断言是共享的；多调用路径必须完全
  gated，且单调用支路重跑绿。
- **profile 假设。** 多调用 native 捕获依赖于夹具是非 shell file profile（由
  现有单调用捕获推导）；.75 head 运行必须确认两调用 plan 确实捕获。
- **钩子惰性。** 钩子绝不能影响生产：env 在 runner 之外绝不设置、fire-once、
  感知 abort 的 hold。惰性由源码文本契约钉（default-off 标志、env 只传给崩溃代、
  已 allowlist 的 `process.env` 读取）与真机 M1 红钉住；非可选的 `sessionId` 类型
  意味着未设置的 env 永远无法匹配真实 session。专用行为单测（匹配/不匹配/abort）
  延后——见开放问题。
- **CI 预算。** 多一条臂抬 `hosted-failover-e2e` 的上限与 timeout；契约钉住两者。

## 验证计划

- **.75 真机**（qwen-managed-e2e 容器，真实 Java/MySQL/Broker/Runtime，fake
  模型）：head 臂绿——两个执行各一次且身份原样、`settled_at` 按 plan 顺序、一个
  terminal、恢复 plan 深相等、Action ID 与 deadline 保留、Allow[1] 之前 sibling[0]
  仍 decided 且未被重问、scrash 后仅凭 MySQL 恢复。
- **实测变异红**（绿色证据需要红）。真机：M1 禁用钩子 → barrier 超时；M2 跳过
  pending 兄弟决策 → terminal 超时；M3 反转恢复 plan → 恢复阻塞。Fast-tier
  契约钉：R1-4 已决兄弟状态检查（`decided` → `requested`）让答复前的钉变红；
  R1-5 执行顺序列（`settled_at`）变异让 plan 顺序钉变红；R1-6 first-match 计划
  链接选择 → 行为化升序链接用例变红；R1-7 收窄执行计数分支 → 锚定契约钉变红。
  R1-4/R1-5 检查是纵深防御，并非真机变异首先撞上的守卫：重新施加裁决仍让
  Action[0] 保持 `decided`，重新打开／取消 Action[0] 会先被 load 路由的
  cancelled/expired 守卫拦截，而逆序派发在恢复采纳阶段（`Saved native request
digest conflicts`）就变红、尚未到达 `settled_at` 检查。因此它们的承重性由上述
  fast-tier 钉证明，而非真机在新断言处变红。
- 契约套件 + 行为化测试绿；serve `process-env-guard` 绿；`npm run build &&
npm run typecheck && npm run bundle`。专用钩子单测（匹配/不匹配/abort）延后
  ——见开放问题。

## 验收标准

- `hosted-failover-e2e` 中一个打包支路，其 runner 在 scrash 崩溃代后仅凭 MySQL
  断言上述观察项 1–4。
- 每个绿色信号都有一次实测变异红。
- 双语设计文档对齐；CI 绿；除惰性测试 gated 钩子外无生产行为改动。

## 实现中已落定

- 故障名为 `sibling-approval`。第二个工具是**第二个 `write_file`**（写到不同路径，
  而非 `read_file`）：write_file schema 已被现有夹具证明，且两个不同的物理效果强化
  「每个兄弟恰好执行一次」的证明。
- after-results 模型计数为 **1**（一个初始两调用轮 + 一个 after-results 轮；审批恢复
  不重发推理），由 .75 head 运行确认（`initialRequests=1`、`modelAfterResults=1`）。
- 非 shell file-profile 假设成立：.75 head 运行捕获了两调用 plan（`approvalOrdinal=1`，
  两个调用按 plan 顺序）。plan 顺序即 request 顺序——`captureNativeBatch` 由
  `batch.requests.entries()` 构建 `plan.calls`——未必是模型的 part 顺序，因此本臂
  的顺序断言是 plan 顺序断言。

## 开放问题

- 后续 sibling[1] 的 Deny 变体是否值得第二条臂（延后）。
- 工具审批夹具中的专用钩子单测（匹配/不匹配/abort）延后到评审迭代；钩子当前由真机
  支路、M1 变异红、env-guard 访问计数与契约钉覆盖，其感知 abort 的 hold 镜像了已单测
  的 B3a 模式。

[issue]: https://github.com/QwenLM/qwen-code/issues/14481
