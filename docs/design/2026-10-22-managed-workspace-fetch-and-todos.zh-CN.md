# Managed Workspace：`/3` profile 上的 `todo_write`

[English](2026-10-22-managed-workspace-fetch-and-todos.md) | 中文

> 范围说明：本文最初为一并加入 `web_fetch` 与 `todo_write` 的变更而写。原生网页
> 抓取随后由 `main` 带着自己的目标地址校验交付，因此本分支只交付 `todo_write`
> 这一片，并从 `main` 继承 `web_fetch`：`files/3` 声明 `files/2` 的全部工具
> （含 `web_fetch` 与 `glob`），再加 `todo_write`。

## 问题

Managed Agent 的 Workspace 会话起初只有 `read_file`、`write_file`、`edit`、
`glob`、`run_shell_command` 和 `monitor`；files profile 另外带有 `web_fetch`，
由 `main` 连同参数与目标地址校验一并加入。共享核心已经提供 `todo_write`，
`qwen serve` 会话也提供它。Managed 路径此前没有声明它，所以多步长任务没有
自己的计划面。

对应 issue：[#15076](https://github.com/QwenLM/qwen-code/issues/15076)。

## 现状

Workspace 会话的工具面在一个地方声明与准入
（`packages/cli/src/serve/hosted-workspace-tool-turn.ts`），由 Runtime Broker
及其 Worker 执行，并由 Java 控制面部分重新校验。

| 层次               | 位置                                                                                                              | 现状职责                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 声明列表           | `HOSTED_WORKSPACE_FILE_TOOLS`、`HOSTED_WORKSPACE_SHELL_TOOLS`、`HOSTED_GLOB_TOOL`，每回合在 `declarations()` 组合 | 提供给模型的工具                                    |
| 准入               | `HostedWorkspaceToolTurn.executeNative` 中的 `prepareRequests`                                                    | 按工具给出拒绝文案，逐批次处理，不消耗 Runtime 工作 |
| 审批               | `hosted-tool-approval.ts` 中的 `hostedApprovalAsks`                                                               | 按模式预先批准                                      |
| Action 预览        | 本侧的 `HOSTED_INPUT_PREVIEW_TOOLS` 与 Java 侧 `ManagedActionService` 中的 `PREVIEW_TOOLS`                        | 哪些审批携带调用输入                                |
| Broker             | `POST /executions:*`（Java `RuntimeBrokerService`）                                                               | 拒绝不是 Worker 已知工具的调用                      |
| Worker             | `managed-runtime-tool-executor.ts` 中的 `ADMITTED_TOOL_NAMES` 与 `createManagedToolSet`                           | 真正执行的允许列表                                  |
| Worker（provider） | `managed-runtime-provider-worker.ts` 中的 `ManagedRuntimeProviderWorker.createRuntime`                            | 绑定 Workspace 的会话的每会话工具集                 |

当前词汇是 `files/1`、`files/2`（另加 `glob`）、统一的 `shell/1`（自身声明
`glob`）、`team-lead/1` 与 `read/1`。每回合在 `declarations()` 里由扁平常量与
profile 谓词组合出工具列表，不存在按 profile 的声明数组。
profile 名称随 Session 定义持久化，加载时改用其他 profile 会以
`409 hosted_tool_profile_conflict` 拒绝（`hosted-harness-session.ts` 中的
`hostedWorkspaceProfileConflictRefusal`）。因此新工具不能加宽已有 profile：
`/1` 或 `/2` 会话从未被提供的工具，会在下一次加载时变成可调用。

## 变更方案

通过一个新 profile 加入 `todo_write`：

- `hosted-workspace-files/3` —— `files/2` 的全部声明（`read_file`、
  `write_file`、`edit`、`web_fetch`、`glob`）再加 `todo_write`

`files/3` 在 `files/2` 已有的组合上追加一个由谓词控制的声明
（`HOSTED_TODO_WRITE_TOOL`），不改动任何既有声明常量。

不存在 `hosted-workspace-shell/3`。先于本改动合并的 `#15330` 把 Shell 统一到
`hosted-workspace-shell/1`、移除了 `/2`，并让 `AgentDefinitionCompiler` 拒绝
其他 `hosted-workspace-shell/…` 标识——即使部署侧仍允许列表包含它。第二个
Shell profile 因此不可达，所以这一半直接移除，而不是留作死代码。

`hosted-workspace-team-lead/1` 与 `hosted-workspace-read/1` 不获得该工具。
team lead 是控制面内部创建的会话，read profile 属于不得写入的快照子会话。

### 设计决策

1. **新增 profile 版本，不改 `/1`、`/2`。** 工具准入依赖会话自身 profile 提供
   过的工具名。把名字加进 `/2`，会让既有 `/2` 会话的下一次加载暴露此前的轮次
   从未提供的工具。先例是 `glob` 的变更（`#13166`），出于同样原因新增了 `/2`。
2. **`web_fetch` 来自 `main`，不是本改动。** 本分支早期版本曾带原生抓取，并在
   issue 维护者裁定后移除。`main` 随后为 files profile 交付了 `web_fetch`，自带
   参数与目标地址校验，因此本分支继承它，只在其上追加 `todo_write`。当初的反对
   意见作为历史保留、不再是约束：没有目标地址策略的抓取会让 files profile 会话
   在无人值守下访问链路本地与 metadata 端点，而该策略现已落在 `main`。
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
   `/3` 会话目前也无法进入公开 plan 模式：`hosted-workspace-tool-turn.ts` 与
   `hosted-harness-session.ts` 的准入名单只列 `files/1` 与 `shell/1`（且 `#15330`
   已移除 `shell/2`），所以本变更没有加入构建无法到达的 plan 分支。
9. **团队看板仍是团队级面板。** hosted profile 已声明 `task_list`、
   `task_create` 与 `task_update`，它们属于团队作用域并由 lead 读取，不是单会话
   计划面，因此不满足本需求。固定到 `/3` 的团队成员会同时获得两者；看板优先，
   `todo_write` 是该成员当前轮自己的临时计划，lead 不会读到。

### 已随本次改动交付

- **`files/3` 的 Java profile 判定。** 只改 TypeScript 会让控制面与 Harness
  判断不一致。`supportsApprovalSelection` 接纳 `files/3`，`approval:query` 读取点
  返回它的选择，`ma_turn` 插入与轮次快照读取都点名它。按 `#15330`，
  `isPublicShell` 保持只认 `/1`，Plan 判定沿用既有的 `FILES || isPublicShell`
  形式——它本就把 `files/3` 排除在外，因此 Plan mode 在 `files/3` 上仍不可用，
  不需要新判定。`lifecycleProtocol` 对 `files/3` 返回 0，与它对 `files/2` 的
  返回值相同；两者都不发起 Workspace 生命周期调用。

### 本设计不覆盖的后续工作

- **`web_fetch` 的目标地址策略**现在随该功能留在 `main`，由它在派发前校验 URL
  与目标地址。本设计不复述也不扩展它。
- **任务清单的稳定会话身份**，让计划跨轮存活。需要 Harness 向 Worker 传递稳定的
  Hosted Session id，并决定跨 Runtime 实例时清单存在哪里。
- **把任务清单作为持久 Session 记录投影到 Web Shell 或其他客户端。**
- **在生产 connector 中启用 `/3`。** 哪个部署固定 `/3` 属于上线决策，与 `/2`
  相同。它要求先升级所有 Worker 并排空旧实例，正如 `/2` 的 ledger 条目所记录：
  `managed-runtime-tools/1` 与 `preapproved-workspace-tools/1` 两个输入、以及由
  它们派生的 `capabilityDigest`，都不区分「准入 `todo_write` 的 Worker」与
  「不准入的 Worker」。未排空的旧 Worker 会在获取与派发之后以
  `409 managed_runtime_identity_conflict` 回应，而不是派发前可由模型纠正的拒绝。

## 涉及文件

| 区域                               | 文件                                                                                                                  |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Profile                            | `packages/cli/src/serve/hosted-workspace-profiles.ts`                                                                 |
| 声明、准入、预览集合               | `packages/cli/src/serve/hosted-workspace-tool-turn.ts`                                                                |
| 参数校验                           | `packages/cli/src/serve/hosted-workspace-tool-input.ts`                                                               |
| 审批                               | `packages/cli/src/serve/hosted-tool-approval.ts`                                                                      |
| 会话接线（live、准入、selectable） | `packages/cli/src/serve/hosted-harness-session.ts`                                                                    |
| 原生工具 continuation 集合         | `packages/cli/src/serve/hosted-approval-continuation.ts`                                                              |
| Worker 准入与工具集                | `packages/cli/src/serve/managed-runtime-tool-executor.ts`                                                             |
| Java action 预览                   | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedActionService.java`    |
| Java profile 判定                  | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/workspace/WorkspaceToolProfiles.java` |
| Java 轮次持久化与快照              | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedAgentStore.java`   |
| Java `approval:query` 读取点       | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/persistence/ManagedSessionStore.java` |
| 测试                               | 同目录的 `*.test.ts`，以及 Java 的预览、审批与 profile 测试                                                           |

不改 `packages/core` 的 TypeScript。不改 Java Broker：Broker 接收 Worker 已知的
任何工具名对应的 payload，`managed-runtime-tools/1` 保持身份不变。

## 验收标准

1. `hosted-workspace-files/3` 会话在 `files/2` 的全部声明旁（含 `web_fetch` 与
   `glob`）声明 `todo_write`；任何 Shell profile 都不声明 `todo_write`。
2. `/1` 或 `/2` 会话仍以既有的 `Hosted Workspace profile refused a tool call.`
   错误拒绝 `todo_write`，且不消耗 Runtime 工作。
3. 准入范围内的畸形 `todo_write` 参数——条目形状、未支持键、`id`/`content`/
   `status`/`blockedBy` 上限、条目/依赖/字节上限——在获取 Runtime 之前得到
   模型可纠正的拒绝。列表级规则（重复 id、重复 `blockedBy` 引用、未知或自依赖、
   依赖环）仍由 core 负责，在派发之后拒绝，与标准 5 一致。
4. 在 `default` 与 `auto-edit` 下，`todo_write` 不经审批请求即执行。
5. Worker 准入 `todo_write`，保留会话内调用的清单，并拒绝依赖环；`web_fetch`
   也和 `main` 一样被准入。
6. Java 的 action 预览为 `todo_write` 返回输入。
