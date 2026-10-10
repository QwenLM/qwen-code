# Managed Tool 发布契约:后台 Shell 与 Monitor 臂

[English version](2026-10-09-managed-tool-publication-background-arm.md)

状态:设计提案。属于 [#13533](https://github.com/QwenLM/qwen-code/issues/13533)([Linux 验收评论](https://github.com/QwenLM/qwen-code/issues/13533#issuecomment-6081348948)的 A1 发现),阶段 H 在 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 下,提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)。建立在 O2 发布归属设计([2026-09-27](2026-09-27-managed-tool-publication-ownership.zh-CN.md))与 H3 Shell/Monitor 运行时设计([2026-10-03](2026-10-03-managed-shell-monitor-runtime.zh-CN.md))之上。

## 问题陈述与现状

hosted turn 的后台 Shell 启动(以及 Monitor 启动)无法为其捕获预留发布。reserve 在服务端、任何进程存在之前就失败,并把失败转成 recovery-blocked 的 turn:

1. turn 先准入后台 `run_shell_command`(持有发布通道、`child_run` 经其闸门准入)或 `monitor` 调用(持有发布通道、`monitor_run` 经其闸门准入),提交 `toolIntent`、`childRuns.admit` / `monitors.admit`、`dispatchStarted`,然后向 `POST /internal/managed-tool-publications/v1/sessions/{id}/grants` 发出 `operation: "reserve"` 的预留请求。
2. 服务端的 `ToolPublicationContract.requirePayload`(`packages/sdk-java/managed-agent-server/.../store/ToolPublicationContract.java:145`)硬拒绝该荷载:它要求 `toolName == "run_shell_command"`,对任何带 `is_background: true` 的输入抛出 `IllegalArgumentException("Only foreground Shell can publish")`,并把输入键集封闭为 `{command, timeout, description}`。后台 shell 荷载(`is_background: true`)与一切 Monitor 荷载(`toolName == "monitor"`、输入带 `is_monitor: true`)都在这里失败 → **400 `invalid_request`**。
3. turn 取消启动执行;清理路径的 `close_not_started` 同样 400(reserve 从未建行);turn 进入 recovery-blocked。该链路已在 macOS 上于 `f20ed558e3` 与 rig 提交 `ac497aeed9` 两端点逐 wire 复现(见 `.qwen/issues/issue-13533.md` 复现报告)。

前台独占臂是落地范围所致,不是安全不变量:契约随 O2 的 durable _remote Shell_ 结果投递(#12894)而来,而 O2 只覆盖前台 Shell。被拒绝的荷载族恰好是 H3 运行时就已经在产生的那些(turn 侧的后台/Monitor 准入、dispatch 与 detached 捕获接线都已落地;reserve 是卡点)。在当前 `f20ed558e3` 已核实:门禁文本与行号原样;`observeBackgroundProcess` 仍无生产调用者(B1);`monitor_run`/`child_run` 仍在 `MANAGED_SESSION_ENABLED_DOMAINS` 之外。

现有闸门带来一个有用的推论:**在域被准入之前,这条契约臂在生产上不可达。** 生产 turn 只有穿过准入闸门(`childRunAdmissionsEnabled()` / `monitorRunAdmissionsEnabled()`)才能到达 reserve,而这两个闸门读的是本切片不触碰的启用域/kind 闸门常量。测试与验收走查一样,经声明性测试开关驱动该路径。

## 决策:给唯一契约加后台臂(方案 A)

issue 点名了两个方向:

- **A(采纳)。扩展现有契约,加后台臂。** `requirePayload`(Java)与其 TypeScript 镜像 `assertToolPublicationPayload`(`packages/core/src/managed-runtime/managed-tool-publication.ts`)在保持不变的前台族之外,再准入两个封闭的荷载族——后台 Shell 与 Monitor。reserve 路由、binding 形状、grant 生命周期(`reserve`/`renew`/`fence`/`close_not_started`)、摘要与捕获/回执机器全部原样不动。
- B(否决)。让后台捕获走另一条 reserve(第二个 operation/endpoint/binding 族)。这把整个 grant 生命周期——reserve 校验、租约续约、fencing、not-started 关闭、目录、GC——在两种语言里完整复制一份,却换不来任何不变量:发布的安全基线是荷载、参数与请求之间摘要精确的绑定,而该绑定与工具族无关。方案 A 严格增量;旧服务端对新族的拒绝方式与今天完全相同(这些族不在允许列表内),而已确立的 server-first 部署顺序(H1/H2/H4)原样适用——因为生产 writer 在域启用之前根本发不出这些荷载,而域启用是之后单独的变更。

H3 设计本就设定了这个方向:其留存一节说"H3 background publications"并入同一 Session 留存根(O4 前台收集器的覆盖缺口已在那里记为跟进项,本切片不改变它)。

## 准入的荷载族(两种语言,摘要逐字节一致)

荷载为 `{toolName, input}`,且 `requestDigest == sha256(荷载字节)`、`reference.argsDigest == sha256(canonical(input))`——两项检查都已存在。本臂只是重新定义哪些 `toolName`/`input` 形状被接受:

| 族               | toolName            | input 键(封闭集)                                                            | 约束                                                                                                                                                                        |
| ---------------- | ------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 前台 Shell(不变) | `run_shell_command` | ⊆ {`command`, `timeout`, `description`}                                     | `command` 非空字符串;`timeout` 整值数字 1..600000(如 `6e5`/`600000.0` 的整值 double 与 TS 镜像在 JSON.parse 规范化后接受的是同一整数);`description` 字符串                  |
| 后台 Shell(新)   | `run_shell_command` | {…前台键…, `is_background`}                                                 | 前台约束;`is_background` 出现时必须是布尔 `true`(字符串形态与 `false` 一律拒绝——turn 不会产生它们:任何未经准入的 `is_background` 值都被 turn 拒绝,标记只以准入布尔形态发出) |
| Monitor(新)      | `monitor`           | ⊆ {`command`, `idle_timeout_ms`, `max_events`, `description`, `is_monitor`} | `command` 非空字符串;`idle_timeout_ms` 整值数字 1..600000;`max_events` 整值数字 1..10000(整值 double 规则同 `timeout`);`description` 字符串;`is_monitor` 必填,布尔 `true`   |

约束集镜像 `hosted-workspace-tool-turn.ts` 里 turn 自己的准入校验(含数值范围),因此 turn 能发出的荷载恰为契约接受的荷载,此外无他。布尔与整值数字在两侧规范化下逐字节兼容(`"true"`/`"false"` 与整值 `longValue()` 渲染在两侧相同),新 fixture 用例会证明这一点。

## 分层改动方案

1. **Java 契约**(`ToolPublicationContract.requirePayload`):把单一前台臂重构为按上表的按族分支;族的准入改由共享常量 `PUBLISHABLE_TOOL_NAMES` 门控(改动 2),switch 退化为纯按族分派;数值界接受整值数字(含整值 double),与 TS 镜像在 JSON.parse 规范化后一致。拒绝文案 `"Only foreground Shell can publish"` 随它所命名的臂消失,代之以按族的拒绝原因。binding/request/grant 解析、摘要与任何其他方法不变。
2. **Store 的 checkpoint 门禁**(`ToolPublicationStore.requireCheckpoint`,改动 1 之后由端到端见证发现):同一条 reserve 路径把 checkpoint 工具项的 `toolName == "run_shell_command"` 写死,在契约的下一层用 "Checkpoint execution identity conflicts" 拒绝 Monitor 绑定。两个门都改为从共享常量 `ToolPublicationContract.PUBLISHABLE_TOOL_NAMES` 取族列表,使它们不可能再次发散——这次发散本身就是本 bug。
3. **Turn 的 checkpoint 分叉**(`hosted-workspace-tool-turn.ts`,改动 2 之后由见证钉住的第三处同形状的前台独占分叉):checkpoint 工具项的 `inputDigest` 只在 `isShell && publication` 时写规范化输入摘要,Monitor 项落回整荷载摘要,使 store 的 argsDigest 身份比对仍然不匹配。分叉放宽为 `(isShell || monitoring) && publication`——即同一请求的 reserve 绑定本来就携带的那个规范化输入摘要。
4. **TypeScript 镜像**(`assertToolPublicationPayload`):同样的三个族(今天它没有显式 `is_background` 检查,只靠键允许列表拒绝;补上显式布尔类型检查,使两个实现接受与拒绝完全相同的输入)。
5. **共享 fixture**(`packages/core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json`):后台 Shell 与 Monitor 的正例荷载向量;新拒绝边的负例(`is_background: "true"` 字符串、`is_background: false`、Monitor 缺 `is_monitor`、未知键、越界数字、错误 toolName);整值 double 拼写形态以手写原始荷载字符串给出(`6e5`、`600000.0`、`1e4`——`JSON.stringify` 会把这些向量存在所钉的拼写抹掉);以及边界正例(`idle_timeout_ms` 的 1 与 600000、`max_events` 的 1 与 10000)。摘要由 TypeScript 规范化器钉住——一个被接受的向量同时也证明了 Java 侧的规范化逐字节一致。两种语言回放同一语料,与每个契约切片一致。
6. **契约 schema**(`managed-tool-publication-v1.schema.json`):核实(且仅当它约束了荷载族才改)——schema 覆盖 binding/request/grant 信封;荷载位于 args 资源内,是摘要绑定而非 schema 绑定。
7. **端到端见证**——重校准的 A1/A2 复现 harness(`HostedRecoveryBlockedWedgeIT.java`,A2 楔死探针保留为回归覆盖,其阻断 session 夹具改为经中继注入的 reserve 400 供给),外加新的 `HostedBackgroundPublicationIT.java`,在同一个声明性测试开关下,把准入的后台 Shell 与准入的 Monitor 驱动到 reserve → dispatch → 启动(ephemeral provisioner 车道);断言钉在本切片已落地机器所连贯产生的状态上(见验收)。
8. **单元测试**:`ToolPublicationContractTest`(Java)与 `managed-tool-publication.test.ts` 按族补齐,含摘要不匹配与字段封闭拒绝。

不改动:reserve 路由与 grant 生命周期、准入闸门、记录体、域/kind 闸门常量、broker 台账。turn 接线的改动仅是改动 3 的那一处 checkpoint 分叉。

## 受影响文件

- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/ToolPublicationContract.java`
- `packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/ToolPublicationStore.java`
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`
- `packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/ToolPublicationContractTest.java`
- `packages/core/src/managed-runtime/managed-tool-publication.ts`
- `packages/core/src/managed-runtime/managed-tool-publication.test.ts`
- `packages/core/src/managed-runtime/contracts/managed-tool-publication-v1.fixtures.json`(必要时 `+.schema.json`)
- `packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedRecoveryBlockedWedgeIT.java`(重校准)与 `integration-tests/helpers/hosted-recovery-blocked-wedge-driver.ts`
- `packages/sdk-java/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/HostedBackgroundPublicationIT.java`(新见证)

## 范围边界

- **不做域启用。** `monitor_run`、`child_run`(shell kind)继续在 `MANAGED_SESSION_ENABLED_DOMAINS`/kind 闸门之外;按 issue 的表述,为准入提交启用它们是 B1、B2 与 Linux 验收走查之后的单独变更。
- **B1(退出观测)与 B2(捕获背压)不在范围内。** 特别是,后台进程在 turn 完成后的自然退出仍没有生产观测臂;本切片只是移除让该通路根本无法被行使的 reserve 拒绝。
- **A2 单独关账**:在 `ac497aeed9` 与 `f20ed558e3` 两端点的 macOS 上均不复现;剩余机制载体只在 rig 环境(Linux cgroup、真 OSS、分离 connector),留待下一次 Linux 验收走查复核。见证 IT 的楔死探针 arm 保留为回归覆盖。
- 后台发布的 O4 留存覆盖缺口维持 H3 设计记录的跟进项,不属本切片。
- Java store 在 reserve 的两个族门禁(荷载族、checkpoint 工具项)之外的服务端行为不变——执行状态、owner fencing、checkpoint phase 检查全部原样。
- **观察到的毛边,记为具名跟进(不属本切片):** 在环境性 `not_started` 拒绝路径上(如无 cgroup 根的 ephemeral 车道),阻断 turn 的终因以 broker 409 `managed_runtime_identity_conflict`(proof-close 之后)呈现,而不是该路径本该备好的、模型可读的被拒拒绝。由见证 IT 的证据记录;属 #13533 线索里 A3/记录一致性族。

## 验收

1. **契约单元层**(两种语言、fixture 驱动):三个族恰好接受自己的形状、拒绝其余;把 `is_background`/`is_monitor` 翻成未准入形态的 fixture 在两侧都失败;摘要重算跨语言逐字节一致。变异检查:拿掉后台臂后,新的正例 fixture 与契约测试必须失败。
2. **端到端见证**(`hosted-harness-mysql` 车道,`-Dqwen.wedge.probe=true` 门控):准入后台 Shell 的 reserve 返回 `OPEN` grant(而非 400),执行在 ephemeral 车道 dispatch 并启动,快速退出命令的结果由当前已落地的机器连贯处理——断言钉在本切片的连贯状态上;准入 Monitor 的 reserve 同理。若完整结果结算依赖未落地的 B1 侧臂,见证改钉 reserve-OPEN + dispatch-started + 记录在案的中间态并点名依赖,不硬断言结算。
3. **回归**:前台 Shell 发布 E2E(`HostedWorkspaceToolTurnIT` shell 车道)不变;A2 楔死探针 arm 继续通过。

## 未决问题

1. `monitor` 臂对 `description` 不设长度上界(全局 256 KiB 荷载上限除外),镜像 turn 准入(它只限显示长度)。可以接受,还是要在契约里限长?
2. 重校准后的见证命名:保留 `HostedRecoveryBlockedWedgeIT`(它的 A2 arm 仍是其名之所指)还是把 A1 arm 拆成新的 `HostedBackgroundPublicationIT`?倾向拆分,让每个 IT 的名字对应它所见证的事。
