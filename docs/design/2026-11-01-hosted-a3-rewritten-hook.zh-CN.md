# Hosted A3 — 改写命令输入与 Hook 不重跑

状态：已实现；打包 MySQL/Linux 验收已通过，待评审/合并。Issue #14481（G3 Step 3 恢复矩阵）**A3** 行（「混合调用与改写输入」）的剩余切片，仅覆盖改写输入 / Hook 不重跑半。

English: [2026-11-01-hosted-a3-rewritten-hook.md](2026-11-01-hosted-a3-rewritten-hook.md).
父文档：[G3 Step 3 恢复](2026-10-09-hosted-g3-step3-recovery.zh-CN.md).

## 问题与当前状态

已合并的 native A3 臂证明先前决定与 pending 兄弟身份/顺序。它刻意不覆盖改写输入或 Hook：native continuation 拒绝 Hook/MCP owner，而输入改写与 Hook occurrence 只存在于 commandStep 路径。

生产已经具备所需机制，本切片不预设新的生产缺陷：

- `commandPermission` 先应用 PreToolUse/PermissionRequest 改写，再构造审批。新的 `command_approval_*` Action 保存最终输入及其 commandStep continuation（`hosted-workspace-tool-turn.ts:8660-8813`）。
- 重入已有 Action 时比较保存输入与当前最终输入，冲突则抛 `Command step approval input changed.`（`hosted-workspace-tool-turn.ts:8730-8749`）。`inputRevision: 1` 不是内容版本；防护来自不可变 Action options、`inputRef` 身份与该比较。
- `HostedHookSession.fireOccurrence` 校验保存的 occurrence 后直接返回持久 `resultRef` 输出，不再次物理 dispatch Hook（`hosted-hook-session.ts:995-1037`）。
- `expandHostedExtensionCommand` 复用保存的 `tool_stage` 及结果，但仍调用 `options.completed`；因此正是保存的 PostToolUse occurrence 防止物理 Hook 重跑（`hosted-extension-command.ts:121-246`）。

缺失的是这些机制跨 Harness replacement 的组合证据。现有夹具没有同时包含真实 commandStep、Hook 输入改写、持久 Hook occurrence 与新 owner；`command_approval_*` 没有直接测试，打包 runner 当前也只假设 native `tool_approval_*` Action 与 native 工具执行。

打包反例在 Action 1 投影前暴露了一个真实生产缺陷：TypeScript 发出 `command_approval_<48 hex>`，Java 却仍只接受 `tool_approval_<32 hex>`。因此本切片让 managed Java Action ID 语法在 journal 投影、详情查找与公共/子分页游标中接受这两种既有形状，也让独立 SDK 客户端的 resolveAction 接受同样两种形状。回归输入在旧语法上先失败；修复后受影响的 managed Java 套件 68/68、SDK HostedHarnessClient 套件 235/235 通过。

Action 1 持久化后，同一真实反例暴露了第二个恢复缺陷，且必须同时修两半。HTTP 提交闭包漏掉 `managed-extension-config-bundle` 与 `managed-extension-contributions`，导致 contribution manifest/parts 根本没有上传；active `config_install` 投影也只保留最新记录，不保留包配置的恢复闭包。因此原 owner 封存后，active bundle 与 contributions 可能缺失，replacement 的 load 读取返回 `managed_session_resource_not_found`。现在提交会持久化 bundle→contribution 链，投影拥有 record 链及 Session 中存在的恢复依赖。闭包见证在修复前失败，删除新增子句后再次失败，逐字节还原后转绿；两个受影响 Java 套件在修复后 39/39 通过。

随后的 load 边界又暴露两个 commandStep 专属路由缺口。workspace 校验在 extensions 已启用时仍拒绝 `config_install` 与 `tool_stage`；两个预回答入口又在既有 `resumeApproval` 分支之前尝试展开等待审批的 Skill。现在校验接受这些扩展 domain，保存的 commandStep continuation 跳过普通预回答，并经 Hooks load 路由进入审批恢复。提前的 commandStep 读取只用于 gating 预回答；native takeover 路径仍执行自己的 approval-continuation 查找，四个既有 native recovery 测试要求这一点。

replacement load 接着暴露 owner 构造顺序缺口：`manager.open()` 执行时 `session.hooks` 尚不存在，放在那里的采用逻辑无法绑定保存 continuation 的 owner。现在当 active extension bundle 提供 Hook catalog 时，Hook session 在构造点直接接收确定性的 `extensions-components-<hash>` runtime id。

另外两个打包失败属于执行生命周期缺口，而非审批身份缺口。极快的 extension Shell 可能在 `owners.start()` 返回前就发射 `close`；后注册的监听器于是永久等待，并在命令效果与 stop receipt 已存在时仍报 output closure unknown。现在 Shell 会采用已经关闭的 stdout/stderr，对应真实 ChildProcess 回归在旧监听器上失败。另一个问题是 extension command receipt 已 settled，却没有 acknowledge 其 legacy native executor entry，导致 reliable close 持续以 HTTP 409 拒绝 retirement。现在 command runtime 只在 durable receipt settled 后 acknowledge；unknown 结果仍不 acknowledge。

## 目标与范围

共同证明 A3 剩余两个观察：

1. 不同的改写命令输入绝不继承前一步的 Allow。每一步都有自己的 Action、最终输入与原 deadline。
2. 恢复重新进入命令展开或完成回调时，已完成的 PreToolUse/PostToolUse occurrence 不物理重跑；对应命令只以改写后的输入执行一次。

第一份交付是使用真实 `ManagedSession`、`HostedHookSession` 与 commandStep continuation 的三代定向见证。第二份是通过真实 load route、Broker、Runtime、extension command 与物理 Hook 进程的 MySQL/Linux 打包臂。本切片最初只计划补证据；打包反例暴露了下述小范围生产缺口，每项都先有失败输入，再修复并验收。

范围外：native+Hook 混合 continuation、已合并 native A3 臂、R2 reader/bundle 兼容、真实供应商验收、多实例 binding fencing，以及新的通用恢复架构。

## 提议的反例

使用一个外层 `skill` 调用，其展开包含两个 `!{...}` command steps。真实 PreToolUse Hook 把每一步改成不同的最终输入并返回 `ask`，强制人工审批。

| 代际 | 持久边界                   | 必须观察                                                                                                                                                         |
| ---- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| gen1 | 第一步等待首个决定         | PreToolUse 改写第一步；Action 1 与 `await_action` 已持久；无步骤效果                                                                                             |
| gen2 | Allow 第一步后，第二步等待 | Action 1 以原身份 decided；第一步执行一次且其 PostToolUse 有 `resultRef`；Action 2 以第二步改写输入与固定 deadline 处于 requested；第二步无 `tool_stage`、无效果 |
| gen3 | 恢复后 Allow 第二步        | Action 2 保留 ID/deadline，未被 Action 1 授权；第一步保存的 stage 与 PostToolUse 重放而无再次物理执行；第二步以自己的改写输入执行一次；Turn 恰一个终态           |

gen2 崩溃不需要生产故障钩子。requested command Action 在被回答前会持续等待，因此 runner 可在证明 Action 2、`await_action`、第一步 settled stage 与已完成 PostToolUse 后直接崩溃。该屏障还证明 Hook 在崩溃前已完成；更晚且跳过 `decide()` 的窗口无法证明不重跑。

## 设计决定

- **两步而非一步。** 恢复在到达第二步前会重新进入第一步的 `completed`。只有这个形状能区分无害回调重放与物理 PostToolUse 重跑。
- **仅 runner 的崩溃屏障。** 不新增 `QWEN_E2E_*` 生产钩子、审批 hold 或 A5a Broker proxy；requested Action 自身就是 hold。
- **断言证据而非 HTTP 成功。** 读取 Action options、`commandStep.inputRef`、`tool_stage`、`hook_execution.resultRef`、模型流量、物理 Hook 计数、extension command 回执与终态数。不套用在何处都不适用的 native prepare-key 或 `HOSTED_CLEANUP` 断言。
- **路由级覆盖不可缺席。** 直接 `resumeSavedNativeBatch` 测试有用，但不足以支撑打包主张；打包臂必须在 Hooks 与 extensions 开启时经真实 load route 进入。
- **变异见证必需。** 至少：绕过保存 Hook 输出必须增加指定物理 Hook 计数；绕过保存 stage 结果必须重执行第一步命令；第二步复用第一步审批必须使双 Action 身份断言变红。每次变异逐字节还原。

## 涉及文件（预计）

- `packages/cli/src/serve/hosted-approval-continuation.test.ts` 或相邻 commandStep 恢复套件：三代定向见证。
- `packages/cli/src/serve/hosted-harness-session.ts`：扩展 domain 校验与 commandStep 审批 load 路由。
- `packages/core/src/managed-runtime/http-managed-session-store.ts` 及其测试：扩展 bundle/contribution 提交闭包。
- `packages/managed-agent-server/{contracts,persistence,control-plane}`：共享 Action ID 语法及其 journal/detail/cursor 消费方，以及包配置恢复闭包保留。
- `packages/sdk-java/qwencode/.../HostedHarnessClient.java` 及其测试：经真实 SDK 客户端投递 command Action。
- `ManagedActionStoreTest`、`ManagedActionsTest`、`ManagedExtensionConfigurationAdmissionTest`：command Action 与恢复闭包回归见证。
- `scripts/run-managed-agent-server-e2e.ts`：两步 Hook/extension 夹具、仅 runner 屏障与打包断言。
- `scripts/tests/managed-agent-server-e2e.test.js` 与 `scripts/tests/hosted-process-ci.test.js`：runner 与 CI 契约。
- `package.json` 与 `.github/workflows/sdk-java.yml`：一条命名臂及其 CI step。
- 本双语设计文档与 `.qwen/e2e-tests/2026-11-01-hosted-a3-rewritten-hook.md`。

## 验收标准

- 定向 gen1/gen2/gen3 边界符合表格，包含两个不同改写输入与两个不同 Action。
- Action 2 跨 replacement 保留原 ID 与 deadline；Action 1 的 Allow 不结算也不授权 Action 2。
- 第一步 PreToolUse 与 PostToolUse 的物理计数在 gen3 后仍各为 1，其 extension command 不重执行；第二步以自己的改写输入执行一次。
- 打包臂在 SIGKILL 与 Harness-home 删除后经真实 load route 到达同一边界，并在 MySQL/Linux 上证明相同持久与物理观察。
- 每个命名变异使命名断言变红并逐字节还原；既有 A3/A5/A5a 与 Hook/extension 套件保持绿色。
- build、typecheck、bundle、定向单测、runner/CI 契约、格式与 lint 通过；双语文档和 E2E 账本记录真实证据边界。

## 开放问题

- 所选 Linux 主机上的真实栈 extension 夹具是否需要单独 delegated cgroup 配置；记录实际设置，不削弱该臂。
- 定向反例是否暴露生产缺陷。若是，先按证据收窄修复并重跑基线再继续。

## 定向证据（已实现）

`hosted-command-step-hook-recovery.test.ts` 在不改生产代码的情况下实现三代
见证，在未修改 main 上 1/1 通过。它使用物理 `hook-execute` 与
`extensionCommand` 记录，而不是与生产 helper 同源的期望值。gen3 先等第一步
PostToolUse 的重放入口发生，再检查其物理计数仍为 1，因此不会因恢复尚未
到达回调而空过。

三个顺序变异均使命名测试变红并逐字节还原
（`tmp/a3-command-hook-mutations.py`）：忽略保存的 Hook `resultRef`、忽略
保存的 `tool_stage.resultRef`、两个步骤共用一个审批 ID。CLI typecheck、
ESLint 与 Prettier 通过。定向结果本身不声称 MySQL/Linux 打包验收。

## 打包证据（已实现）

命名臂在真实 ARM Linux/MySQL 主机上以退出码 0 通过
（`owner-r44`，Temurin 21、已注册 storage、delegated cgroup v2）。部署的
CLI bundle sha256 为
`ed8796473dd19b04eaab3247cb0e4e9d6dcd85985bb669d41e8713683c2f18b0`。
crash/final/summary 证据已复制到 `.qwen/e2e-tests/`
（`command-rewrite-crash-barrier.json`、`command-rewrite-result.json`、
`summary.json`，以及配套 approval/post-turn 文件）。

最终证据显示两个不同的 `command_approval_*` Action 分别保存两个改写输入；
Action 2 跨 gen3 保持 ID、`createdAt`、`expiresAt` 与 `inputRef`，随后才变为
decided。两个 stage 均 settled 且有 `resultRef`；每个 stage 的实际
PreToolUse/PostToolUse Hook 各有一条 durable settled 结果和一次物理执行；
两条 extension-command receipt 均 settled；模型流量为一次初始请求加一次
结果后请求。relief Turn 完成，Session 恰有两个终态，reliable close 完成。

runner 证据读取还做了三处修正：用 HEX 解码 MySQL 资源，而不是信任
`--batch` 文本转义；从持久化 `tool_use_id` 匹配 Hook 的 command stage，
而不是 opaque 的 `hook-plan-*` occurrence；从实际 Hook 计数中排除
`__plan__` marker。Hook-profile 臂跳过 native `hosted-cleanup` receipt
等待，因为其 component Runtime 在 Turn 间保持挂载；但仍证明 relief 与
reliable close。
