# Managed Workspace：`/3` profile 上的 `todo_write`

[English](2026-10-22-managed-workspace-fetch-and-todos.md) | 中文

> 范围说明：本文最初为一并加入 `web_fetch` 与 `todo_write` 的变更而写。issue
> 上已有维护者裁定暂缓原生网页抓取，因此实际交付的只有 `todo_write` 这一个切片。
> 下面保留了抓取部分的分析，用来说明它为什么没有交付。

## 问题

Managed Agent 的 Workspace 会话只有六个工具：`read_file`、`write_file`、
`edit`、`glob`、`run_shell_command` 和 `monitor`。共享核心已经提供
`todo_write`，`qwen serve` 会话也提供它。Managed 路径没有声明它，所以多步长
任务没有自己的计划面。

对应 issue：[#15076](https://github.com/QwenLM/qwen-code/issues/15076)。

## 现状

Workspace 会话的工具面在一个地方声明与准入
（`packages/cli/src/serve/hosted-workspace-tool-turn.ts`），由 Runtime Broker
及其 Worker 执行，并由 Java 控制面部分重新校验。

| 层次               | 位置                                                                                       | 现状职责                                            |
| ------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| 声明列表           | `HOSTED_WORKSPACE_FILE_TOOLS`、`..._SHELL_TOOLS` 及其 `/2` 变体                            | 提供给模型的工具                                    |
| 准入               | `HostedWorkspaceToolTurn.executeNative` 中的 `prepareRequests`                             | 按工具给出拒绝文案，逐批次处理，不消耗 Runtime 工作 |
| 审批               | `hosted-tool-approval.ts` 中的 `hostedApprovalAsks`                                        | 按模式预先批准                                      |
| Action 预览        | 本侧的 `HOSTED_INPUT_PREVIEW_TOOLS` 与 Java 侧 `ManagedActionService` 中的 `PREVIEW_TOOLS` | 哪些审批携带调用输入                                |
| Broker             | `POST /executions:*`（Java `RuntimeBrokerService`）                                        | 拒绝不是 Worker 已知工具的调用                      |
| Worker             | `managed-runtime-tool-executor.ts` 中的 `ADMITTED_TOOL_NAMES` 与 `createManagedToolSet`    | 真正执行的允许列表                                  |
| Worker（provider） | `managed-runtime-provider-worker.ts` 中的 `ManagedRuntimeProviderWorker.createRuntime`     | 绑定 Workspace 的会话的每会话工具集                 |

当前有两个 profile：`/1`（`files`、`shell`）与 `/2`（各自加上 `glob`）。
profile 名称随 Session 定义持久化，加载时改用其他 profile 会以
`409 hosted_tool_profile_conflict` 拒绝（`hosted-harness-session.ts` 中的
`hostedWorkspaceProfileConflictRefusal`）。因此新工具不能加宽已有 profile：
`/1` 或 `/2` 会话从未被提供的工具，会在下一次加载时变成可调用。

## 变更方案

通过两个新 profile 加入 `todo_write`：

- `hosted-workspace-files/3` —— `read_file`、`write_file`、`edit`、`glob`、
  `todo_write`
- `hosted-workspace-shell/3` —— 同上五个，再加 `run_shell_command` 与
  `monitor`

`/3` 复用 `/2` 的声明数组并追加一个新声明，因此既有声明保持逐字节一致。

`hosted-workspace-team-lead/1` 与 `hosted-workspace-read/1` 不获得该工具。
team lead 是控制面内部创建的会话，read profile 属于不得写入的快照子会话。

### 设计决策

1. **新增 profile 版本，不改 `/1`、`/2`。** 工具准入依赖会话自身 profile 提供
   过的工具名。把名字加进 `/2`，会让既有 `/2` 会话的下一次加载暴露此前的轮次
   从未提供的工具。先例是 `glob` 的变更（`#13166`），出于同样原因新增了 `/2`。
2. **`web_fetch` 不交付，依据已记录的决定。** issue 上有维护者裁定暂缓原生抓取，
   Managed 会话继续用 `run_shell_command` 访问网页。两条事实使该裁定同时是技术
   结论。第一，出站理由对 files profile 不成立：该 profile 没有 shell，抓取会
   新开出站路径而不是复用已有的。第二，Hosted 路径当时也不约束目标地址：那一版
   准入只校验协议、凭据与长度，不校验主机；`isPrivateHost` 仅用于跳过 https
   升级；`yolo` 下 Worker（以 `ApprovalMode.YOLO` 构建）与 Harness 都不会询问。
   因此 files/3 会话本会在无人值守下访问链路本地与 metadata 端点。交付它需要先有
   目标地址策略，这属于后续工作。
3. **`todo_write` 在 Worker 内执行，不写 Workspace 文件。** 清单是 Worker 运行
   目录里的记账数据，不触碰 Session Store schema、Java 存储或 Workspace，这也
   是它可以预先批准的原因。
4. **清单只作用于一轮，工具声明也这样写。** Worker 的工具集以 Runtime session
   id 为键，而 Harness 按轮派生该 id（`hostedRuntimeSessionId(promptId)` 直接
   返回 prompt id）。Worker 的运行目录同样是每 Runtime 实例一份。因此存储的清单
   不会进入下一轮。工具声明因此只承诺当前轮的任务清单，也不宣称提醒能力：本地
   会话显示的提醒由 Harness 中的模型循环注入，该循环看不到这个 Worker 的
   `Config`。要让清单持久，需要 Harness 向 Worker 提供稳定的会话身份——这是一项
   协议变更，记在后续工作中，不由本 profile 隐含。
5. **Worker 显式开启该工具。** 核心把 `todoWriteEnabled` 默认为 false，面向运营
   方的路径据此决定注册。服务 hosted profile 的那个 Worker 配置把它设为 true，
   因此工具被准入是因为 profile 这样声明，而不是因为绕过了默认值。只有这条车道
   注册该工具：provider 车道服务 resident 与 CSI 会话，它们的 manifest 是封闭
   集合，因此与 `glob` 变更时一样保持不动。Worker 内部目前没有任何代码读取这个
   开关，所以它是让 Config 说实话并记录意图，而不是切换行为。
6. **审批。** `default` 与 `auto-edit` 下该工具预先批准：它只写自己的记账数据，
   不改用户拥有的文件。`yolo` 下不询问，与现状相同。
7. **输入校验保持模型可纠正。** 被拒绝的参数从不获取挂载。`todo_write` 要求
   `todos` 为数组，每项重复核心工具校验的形状：非空的 `id` 与 `content`，
   `status` 为三种状态之一，可选的 `blockedBy` 为 id 数组。精确规则仍留在核心
   工具中；准入只校验把畸形调用挡在持久化 Runtime 往返之外所必需的部分。
8. **plan 模式不变。** `todo_write` 会写入，因此不加入公开 plan 模式的读取集合。
   `/3` 会话目前也无法进入公开 plan 模式：构造函数只接受 `files/1`、`shell/1`
   与 `shell/2`，所以本变更没有加入构建无法到达的 plan 分支。

### 本设计不覆盖的后续工作

- **`web_fetch` 的目标地址策略**（允许或拒绝列表，以及私有与 metadata 主机的
  决定）。有了它才能重新提出抓取部分；它今天不是配置开关。
- **任务清单的稳定会话身份**，让计划跨轮存活。需要 Harness 向 Worker 传递稳定的
  Hosted Session id，并决定跨 Runtime 实例时清单存在哪里。
- **`/3` 的 Java profile 判定。** `WorkspaceToolProfiles` 是精确匹配：
  `lifecycleProtocol("hosted-workspace-files/3")` 返回 0，`isPublicShell` 只覆盖
  `/1` 与 `/2`，`supportsApprovalSelection` 要求恰好是 `files/1` 或公共 shell。
  因此启用 `/3` 需要改 Java 判定，而不只是改配置。
- **把任务清单作为持久 Session 记录投影到 Web Shell 或其他客户端。**
- **在生产 connector 中启用 `/3`。** 哪个部署固定 `/3` 属于上线决策，与 `/2`
  相同。

## 涉及文件

| 区域                 | 文件                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Profile              | `packages/cli/src/serve/hosted-workspace-profiles.ts`                                                              |
| 声明、准入、预览集合 | `packages/cli/src/serve/hosted-workspace-tool-turn.ts`                                                             |
| 参数校验             | `packages/cli/src/serve/hosted-workspace-tool-input.ts`                                                            |
| 审批                 | `packages/cli/src/serve/hosted-tool-approval.ts`                                                                   |
| Worker 准入与工具集  | `packages/cli/src/serve/managed-runtime-tool-executor.ts`                                                          |
| Java action 预览     | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedActionService.java` |
| 测试                 | 同目录的 `*.test.ts`，以及 Java 预览集合的测试                                                                     |

不改 `packages/core` 的 TypeScript。不改 Java Broker：Broker 接收 Worker 已知的
任何工具名对应的 payload，`managed-runtime-tools/1` 保持身份不变。

## 验收标准

1. `hosted-workspace-files/3` 会话在四个文件工具旁声明 `todo_write`；
   `hosted-workspace-shell/3` 会话在 shell 工具旁声明它。两者都不声明
   `web_fetch`。
2. `/1` 或 `/2` 会话仍以既有的 `Hosted Workspace profile refused a tool call.`
   错误拒绝 `todo_write`，且不消耗 Runtime 工作。
3. 畸形的 `todo_write` 参数得到模型可纠正的拒绝，作为工具结果提交，不获取、
   不预留、不派发。
4. 在 `default` 与 `auto-edit` 下，`todo_write` 不经审批请求即执行。
5. Worker 准入 `todo_write`，保留会话内调用的清单，并拒绝依赖环。即使核心仍
   实现 `web_fetch`，Worker 也拒绝它。
6. Java 的 action 预览为 `todo_write` 返回输入。
