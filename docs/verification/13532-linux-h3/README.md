# H3 Linux physical acceptance — 2026-10-09

This records the acceptance requested by [#13532](https://github.com/QwenLM/qwen-code/issues/13532) at production commit `669b2f0f91b0c787f7d8a26971c7c34210b935e1`. The five H3 behaviours remain blocked, not passed. This report does not enable a capability or implement the findings tracked by [#13533](https://github.com/QwenLM/qwen-code/issues/13533).

## Exact source state

At this commit, the [plain enabled-domain list](../../../packages/core/src/managed-runtime/managed-session-records.ts) contains nine entries: `goal_state`, `session_metadata`, `file_history`, `session_source`, `mcp_configuration`, `mcp_operation`, `hook_registration`, `hook_execution` and `child_acceptance`. `monitor_run` remains disabled. `child_run` is enabled by kind: `child_agent` is admitted, while the background Shell kind `shell` remains disabled. The [extension-body registry](../../../packages/core/src/managed-runtime/managed-extension-projection.ts) contains eleven bodies. These counts supersede the older eight-domain/six-body snapshot in the issue.

The [Hosted Shell/Monitor admission checks](../../../packages/cli/src/serve/hosted-workspace-tool-turn.ts) refuse background Shell and Monitor requests before dispatch. Selecting a Shell profile alone does not exercise publication: the [Harness session configuration](../../../packages/cli/src/serve/hosted-harness-session.ts) chooses the publication lane only when `captureBytes` is supplied.

## Native environment and legacy control

The packaged stack ran in an isolated Ubuntu 24.04 arm64 VM with Linux 6.8.0-146-generic, Node 22.23.3, Java 21.0.12.1, Maven 3.9.9 and MySQL 8.4.11. A non-root `qwen` service received a delegated cgroup v2 subtree. A real child cgroup accepted `cgroup.kill`, reached `populated 0` and was removed. This establishes an available Linux prerequisite; it does not establish an H3 run's stop/drain behaviour.

The Broker, Spring SQL store, packaged CLI and Runtime worker were real processes. Only the model endpoint returned deterministic tool calls. The production bundle SHA256 was `11db529ca76a62e3b19c95269da45583ffb6b820b5e9619ae38bb973661c5c2d`. A 5,042-file manifest matched core/CLI src/**, Java src/main/** and four existing Node helpers; it excludes the separate #12904 test overlays in the guest checkout. No production file was patched for this acceptance.

The first probe used `hosted-workspace-shell/1` without `captureBytes`, so it exercised the **legacy saved-result lane**. UTC 09:08:32–09:08:40 on 2026-10-09, the probe recorded:

| Request                                 | Observed result                                                                                                                                          | SQL and host evidence                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Background Shell, `is_background: true` | `Hosted Shell requires a foreground command in the saved directory. Background jobs and Monitor are unavailable; correct the arguments before retrying.` | No execution, publication or Artifact row; no background marker file |
| Monitor                                 | `Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.`                                                   | No execution, publication or Artifact row; no Monitor marker file    |
| Foreground Shell control                | `H3_FOREGROUND_CONTROL` bytes and physical marker; execution SETTLED/success, capture complete, delivery committed                                       | Real worker executed; zero publication/Artifact rows                 |

The probe exited 0 because its refusal/control assertions passed. This is not a pass for any of the five H3 behaviours. In particular, zero publication rows from the legacy control are not output-as-Artifact evidence. A final `cgroup.events: populated 1` included the live wrapper and is not a drain assertion. Broker restart, worker reattach and incomplete-capture stop injection were not exercised in this probe.

## Publication prerequisite

Production [publication configuration](../../../packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/config/ToolPublicationConfiguration.java) is disabled by default. Enabling it requires explicit capacity/deadline budgets and a real regional HTTPS OSS endpoint, region, private bucket without versioning and configured credentials. The [OSS object store constructor](../../../packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/AliyunToolPublicationObjectStore.java) validates bucket versioning and ACL even before a small inline-output control can run.

No explicit Managed Agent test bucket/namespace or publication configuration was found in the bounded acceptance configuration search. General cloud login profiles are not evidence of an approved test bucket. No cloud credentials were copied to the VM or used for this probe.

## Publication-parameter probe

A second native run at the same production head used `hosted-workspace-shell/2` with `captureBytes: 67108864`. The session configuration selected the publication lane; the Spring fixture still had publication disabled and no OSS configuration. UTC 10:07:07–10:07:10 on 2026-10-09, it observed:

| Request                        | Actual output/state                                                                                                             | SQL and host evidence                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background Shell               | `Hosted Shell requires one foreground command.`; `recoveryBlocked=false`                                                        | Zero execution/publication/Artifact rows; marker absent                                                                                                            |
| Monitor                        | `Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.`; `recoveryBlocked=false` | Zero execution/publication/Artifact rows; marker absent                                                                                                            |
| Foreground publication control | `recoveryBlocked=true`, marker `ENOENT`, no tool reply or terminal turn event                                                   | Execution SETTLED with `executionStatus=not_started`, `capture=null`; zero publication/Artifact rows; checkpoint remains `await_runtime` with in-progress dispatch |

The diagnostic recorder exited 0 after preserving the blocked foreground result. It does **not** establish a successful publication control, producer process, manifest or readable Artifact. The publication configuration/route absence is separately confirmed from the unchanged source and fixture arguments; the blocked status alone is not a complete causal trace. No H3 restart/stop fault was injected. The owned delegated unit was removed: `LoadState=not-found`, `ActiveState=inactive`.

Second native log SHA256: `d24a8361568be5853191794809babfdb41c847ac10999eb8e64fa201c695a14a`. The exact command, input changes and recorded output are included in [the input record](probe-inputs.md).

## Five required behaviours

All rows below refer to the same named production commit and the native probe commands in [the input record](probe-inputs.md). No restart or drain result is inferred from the admission refusal.

| Behaviour                                                       | Recorded outcome | Reason and evidence                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — process owner survives Broker restart                       | **Blocked**      | Background Shell admission is refused before a run exists. No H3 owner identity was created; Broker restart was not injected.                                                         |
| 2 — background/Monitor output remains readable as Artifacts     | **Blocked**      | Both H3 entries are refused before capture/publication. The legacy foreground control produced no publication/Artifact row. A real test OSS publication configuration is also absent. |
| 3 — Runtime hold while live, then release                       | **Blocked**      | No background/Monitor run was admitted, so there was no H3 hold to measure. Foreground settlement does not substitute for it.                                                         |
| 4 — stop/drain terminal outcome and incomplete-capture blocking | **Blocked**      | No live H3 run was available for a stop or incomplete-capture injection. The generic cgroup.kill prerequisite check is not this behaviour.                                            |
| 5 — restart reattach or accurate blocking                       | **Blocked**      | No H3 run existed to restart. The pre-start refusal is named, but it is not the required post-restart result.                                                                         |

## Remaining acceptance work

Provision an explicit test publication configuration, then rerun at a named production head when the H3 Shell/Monitor admission gates allow the intended capability. Observe the actual process identity across a Broker restart, read manifest and bytes after producer exit, measure live and released holds, inject stop plus incomplete capture, and record reattach or a named post-restart blocked reason. Retain per-case commands, output and SQL/process identities. Enabling domains and implementing #13533 are separate work; this report neither changes them nor establishes production readiness.

<details>
<summary>中文说明</summary>

# H3 Linux 物理验收 — 2026-10-09

本报告记录 [#13532](https://github.com/QwenLM/qwen-code/issues/13532) 要求的验收，生产 commit 为 `669b2f0f91b0c787f7d8a26971c7c34210b935e1`。五项 H3 行为均受阻，未通过。本报告不启用能力，也不实现 [#13533](https://github.com/QwenLM/qwen-code/issues/13533) 跟踪的发现。

## 精确源码状态

该提交的[普通开放域列表](../../../packages/core/src/managed-runtime/managed-session-records.ts)有九项：`goal_state`、`session_metadata`、`file_history`、`session_source`、`mcp_configuration`、`mcp_operation`、`hook_registration`、`hook_execution`、`child_acceptance`。`monitor_run` 仍禁用。`child_run` 按 kind 开放：`child_agent` 已允许，后台 Shell 的 `shell` 仍禁用。[extension body 注册表](../../../packages/core/src/managed-runtime/managed-extension-projection.ts)有十一项；这些计数更新了 issue 中八域/六 body 的旧快照。

[Hosted Shell/Monitor 的接纳检查](../../../packages/cli/src/serve/hosted-workspace-tool-turn.ts)在 dispatch 前拒绝后台 Shell 与 Monitor。仅选择 Shell profile 不代表已经走 publication；[Harness Session 配置](../../../packages/cli/src/serve/hosted-harness-session.ts)只有提供 `captureBytes` 时才选择 publication 链路。

## 原生环境与 legacy 控制

打包栈运行于独立 Ubuntu 24.04 arm64 VM，Linux 6.8.0-146-generic、Node 22.23.3、Java 21.0.12.1、Maven 3.9.9、MySQL 8.4.11。非 root 的 `qwen` 服务获得 delegated cgroup v2 子树。真实子 cgroup 接受 `cgroup.kill`，达到 `populated 0` 后被移除；这只证明 Linux 前置条件可用，不证明 H3 run 的 stop/drain 行为。

Broker、Spring SQL Store、打包 CLI 与 Runtime worker 均为真实进程；只有模型端点返回确定性工具调用。bundle SHA256：`11db529ca76a62e3b19c95269da45583ffb6b820b5e9619ae38bb973661c5c2d`。5,042 个文件的清单匹配 core/CLI src/**、Java src/main/** 及四个既有 Node helper；排除了 guest 中另一个 #12904 的测试覆盖文件。验收没有修改生产文件。

首次探测使用 `hosted-workspace-shell/1`，未提供 `captureBytes`，因此覆盖 **legacy saved-result 链路**。2026-10-09 UTC 09:08:32–09:08:40 的实际结果：

| 请求                                    | 观察结果                                                                                                                                                 | SQL 与宿主证据                                                |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Background Shell，`is_background: true` | `Hosted Shell requires a foreground command in the saved directory. Background jobs and Monitor are unavailable; correct the arguments before retrying.` | execution、publication、Artifact 均零行；无 background marker |
| Monitor                                 | `Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.`                                                   | execution、publication、Artifact 均零行；无 Monitor marker    |
| Foreground Shell 控制                   | `H3_FOREGROUND_CONTROL` 字节与实际 marker；execution SETTLED/success、capture complete、delivery committed                                               | 真实 worker 执行；publication/Artifact 零行                   |

退出码 0 表示拒绝/控制断言通过，不代表五项 H3 行为通过。legacy 前台控制的 publication 零行不是 Artifact 证据。最后的 `cgroup.events: populated 1` 包含仍存活的 wrapper，不是 drain 断言。首次探测未注入 Broker 重启、worker reattach 或不完整 capture 的 stop 故障。

## Publication 前置条件

生产 [publication 配置](../../../packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/config/ToolPublicationConfiguration.java)默认关闭。启用要求显式容量/时限预算、真实区域 HTTPS OSS endpoint、region、私有且未开启版本控制的 bucket，以及配置好的凭据。[OSS 对象存储构造器](../../../packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/store/AliyunToolPublicationObjectStore.java)会先校验 bucket 版本控制与 ACL，即使只想跑小型 inline-output 控制也一样。

限定范围的验收配置搜索未找到明确的 Managed Agent 测试 bucket/namespace 或 publication 配置。一般云登录 profile 不能证明某 bucket 已指定用于测试。本次没有向 VM 复制或使用云凭据。

## 带 publication 参数的探测

第二次原生运行在相同生产 head 上使用 `hosted-workspace-shell/2` 与 `captureBytes: 67108864`。Session 配置选择了 publication 链路，Spring fixture 仍关闭 publication 且没有 OSS 配置。2026-10-09 UTC 10:07:07–10:07:10 的结果：

| 请求                        | 实际输出/状态                                                                                                                   | SQL 与宿主证据                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background Shell            | `Hosted Shell requires one foreground command.`；`recoveryBlocked=false`                                                        | execution/publication/Artifact 零行；marker 不存在                                                                                                    |
| Monitor                     | `Hosted Monitor is unavailable on this Session profile; read output through the task surface instead.`；`recoveryBlocked=false` | execution/publication/Artifact 零行；marker 不存在                                                                                                    |
| Foreground publication 控制 | `recoveryBlocked=true`、marker `ENOENT`、没有工具回答或回合终态事件                                                             | execution SETTLED，`executionStatus=not_started`、`capture=null`；publication/Artifact 零行；checkpoint 留在 `await_runtime`，dispatch 仍 in-progress |

诊断记录器保存前台阻塞结果后退出 0，不能据此称 publication 控制成功，也没有证明生产者进程、manifest 或可读 Artifact。publication 配置/路由缺失另由未修改源码及 fixture 参数确认；单凭 blocked 状态并不构成完整因果链。本次未注入 H3 重启/stop。所拥有的委派 unit 已移除：`LoadState=not-found`、`ActiveState=inactive`。

第二次原生日志 SHA256：`d24a8361568be5853191794809babfdb41c847ac10999eb8e64fa201c695a14a`。准确命令、输入差异及实际输出见[输入记录](probe-inputs.md)。

## 五项必需行为

以下各行对应相同的生产 commit 与[输入记录](probe-inputs.md)中的原生命令，不从接纳拒绝推断重启或 drain 结果。

| 行为                                      | 记录结果 | 原因和证据                                                                                               |
| ----------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| 1 — Broker 重启前后保留进程所有者         | **受阻** | 创建 run 前就拒绝后台 Shell，没有 H3 owner identity；未注入 Broker 重启                                  |
| 2 — 生产者退出后可读后台/Monitor Artifact | **受阻** | 两个 H3 入口在 capture/publication 前拒绝，legacy 前台控制无 publication/Artifact；也缺真实测试 OSS 配置 |
| 3 — live 期间持有 Runtime，之后释放       | **受阻** | 未接纳后台/Monitor run，没有 H3 hold 可测；前台 settlement 不能代替                                      |
| 4 — stop/drain 终态及不完整 capture 阻断  | **受阻** | 没有 live H3 run 可注入 stop 或不完整 capture；一般 cgroup.kill 前置检查不等于该行为                     |
| 5 — 重启后 reattach 或准确阻塞            | **受阻** | 没有 H3 run 可重启；启动前拒绝虽有名称，但不等于所要求的重启后结果                                       |

## 剩余验收

准备明确的测试 publication 配置，并在 H3 Shell/Monitor 接纳门禁允许目标能力时，于指定生产 head 重跑。观察跨 Broker 重启的真实进程身份，在生产者退出后读取 manifest 与字节，测量 live/released hold，注入 stop 和不完整 capture，并记录 reattach 或具名的重启后阻塞原因。保留每项命令、输出及 SQL/进程身份。域启用及 #13533 实现属于独立工作；本报告不修改它们，也不证明生产就绪。

</details>
