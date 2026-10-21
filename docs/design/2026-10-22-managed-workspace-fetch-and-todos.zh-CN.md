# Managed Workspace：`web_fetch` 与 `todo_write`

[English](2026-10-22-managed-workspace-fetch-and-todos.md) | 中文

## 问题

Managed Agent 的 Workspace 会话只有六个工具：`read_file`、`write_file`、
`edit`、`glob`、`run_shell_command` 和 `monitor`。共享核心已经提供
`web_fetch` 与 `todo_write`，`qwen serve` 会话也提供这两个工具。Managed
路径没有声明它们，所以 Managed 会话既不能读取网页，也不能维护任务清单。

没有 `web_fetch`，需要读变更日志、issue 页面或库文档的会话只能通过
`run_shell_command` 跑 `curl`；在 default 与 auto-edit 审批模式下，每次这样
的调用都要审批。没有 `todo_write`，多步长任务没有持久化的计划记录，进度与
意图会在轮次之间丢失。

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

通过两个新 profile 加入这两个工具：

- `hosted-workspace-files/3` —— `read_file`、`write_file`、`edit`、`glob`、
  `web_fetch`、`todo_write`
- `hosted-workspace-shell/3` —— 同上六个，再加 `run_shell_command` 与
  `monitor`

`/3` 复用 `/2` 的声明数组并追加两个新声明，因此六个既有声明保持逐字节一致。

`hosted-workspace-team-lead/1` 与 `hosted-workspace-read/1` 不获得这两个工具。
team lead 是控制面内部创建的会话，read profile 属于不得抓取也不得写入的快照
子会话。

### 设计决策

1. **新增 profile 版本，不改 `/1`、`/2`。** 工具准入依赖会话自身 profile 提供
   过的工具名。把名字加进 `/2`，会让既有 `/2` 会话的下一次加载暴露此前的轮次
   从未提供的工具。先例是 `glob` 的变更（`#13166`），出于同样原因新增了 `/2`。
2. **`web_fetch` 在 Worker 内执行，走 Runtime 已有的出站通道。** Hosted 会话
   本来就能通过同一个 Worker 里的 `run_shell_command` 访问网络，出站路径与信任
   边界相同。在 Worker 内运行 `web_fetch` 不新增网络策略，也不新增主机。必须
   新增的是去掉本地 `qwen serve` 会话接受的三处本地副作用：

   | 副作用          | 本地行为                                     | Managed 行为                             |
   | --------------- | -------------------------------------------- | ---------------------------------------- |
   | 二进制内容落盘  | PDF 与图片写到工具结果目录，并把路径告诉模型 | 以模型可纠正的拒绝文案拒绝；不写任何文件 |
   | 响应缓存        | 每会话 15 分钟内存缓存                       | 关闭，每次抓取都是真实请求               |
   | 摘要 side query | 由快模型调用对内容做摘要                     | 关闭；直接返回抓取的正文                 |

   side query 是 Worker 内发起的第二次模型调用，会话自身的 token 计量看不到它；
   关闭它也让抓取留在会话记录的成本之内。

3. **`todo_write` 在 Worker 内执行，不作为 Session 记录持久化。** 该工具需要
   自己的文件存储，Worker 为每会话提供一个。这份文件是模型下次调用时读回的
   记账数据。任务清单同时进入模型上下文，因为 Worker 会把活动中的待办追加到
   自己的指令里，所以计划能跨会话内的多个轮次留存。把清单作为持久记录投影给
   客户端是另一项变更；本变更不触碰 Session Store schema、Java 或 Web Shell。
4. **审批。** `yolo` 模式下不询问，与现状相同。`default` 与 `auto-edit` 下，
   `todo_write` 预先批准：它只写自己的记账数据，不改用户拥有的文件。
   `web_fetch` 会询问，因为它访问的是会话中任何人都没有选择的 URL。这与本地
   体验一致：本地可以在设置里维护预先批准的 URL 列表而免去询问；Hosted 路径
   没有每会话的 URL 允许列表，所以询问。审批卡片携带调用输入，因此 URL、prompt
   与 format 在运营方作答之前可见，与 `run_shell_command` 完全相同。
5. **输入校验按工具进行，且保持模型可纠正。** 被拒绝的参数从不获取挂载。
   `web_fetch` 要求非空的 `url`，以 `http://` 或 `https://` 开头，不含内嵌
   凭据，不超过 2048 字节；还要求非空的 `prompt`，以及可选且取值固定的
   `format`。`todo_write` 要求 `todos` 为数组，每项重复核心工具校验的形状：
   非空的 `id` 与 `content`，`status` 为三种状态之一，可选的 `blockedBy` 为
   id 数组。精确校验仍留在核心工具中；准入只校验把畸形调用挡在持久化 Runtime
   往返之外所必需的部分。
6. **plan 模式与 Hook 门禁沿用既有的集合。** 公开 plan 模式的轮次只准入读操作；
   `web_fetch` 加入 `HOSTED_PUBLIC_PLAN_READS`，因为它只读网络；`todo_write`
   不加入，因为它写入。成员 run 在 plan 模式下保持更窄的集合不变。

### 本设计不覆盖的后续工作

- 把任务清单作为持久 Session 记录投影到 Web Shell 或交互式客户端。
- 为托管部署中的 `web_fetch` 提供每会话的 URL 允许或拒绝列表。
- 在生产 connector 中启用 `/3`。本变更新增 profile、Worker 准入与准入规则；
  哪个部署固定 `/3` 属于上线决策，与 `/2` 相同。

## 涉及文件

| 区域                                | 文件                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Profile                             | `packages/cli/src/serve/hosted-workspace-profiles.ts`                                                              |
| 声明、准入、预览集合、plan 读取集合 | `packages/cli/src/serve/hosted-workspace-tool-turn.ts`                                                             |
| 审批                                | `packages/cli/src/serve/hosted-tool-approval.ts`                                                                   |
| Worker 准入与工具集                 | `packages/cli/src/serve/managed-runtime-tool-executor.ts`                                                          |
| Provider worker 工具集              | `packages/cli/src/serve/managed-runtime-provider-worker.ts`                                                        |
| 隧道内抓取行为                      | `packages/core/src/tools/web-fetch.ts`                                                                             |
| Java action 预览                    | `packages/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent/session/ManagedActionService.java` |
| 测试                                | 同目录的 `*.test.ts`，以及 Java 预览集合的测试                                                                     |

不需要修改 Java Broker。Broker 接收 Worker 已知的任何工具名对应的 payload，
`managed-runtime-tools/1` 保持身份不变。

## 验收标准

1. `hosted-workspace-files/3` 会话在四个文件工具旁声明 `web_fetch` 与
   `todo_write`；`hosted-workspace-shell/3` 会话在 shell 工具旁声明它们。
2. `/1` 或 `/2` 会话仍以既有的 `Hosted Workspace profile refused a tool call.`
   错误拒绝这两个名字，且不消耗 Runtime 工作。
3. 畸形的 `web_fetch` 或 `todo_write` 参数得到模型可纠正的拒绝，作为工具结果
   提交，不获取、不预留、不派发。
4. 在 `default` 与 `auto-edit` 下，`todo_write` 不经审批请求即执行，
   `web_fetch` 在派发前询问，且 URL 出现在 Action 的输入预览中。
5. Worker 执行这两个工具，且 `web_fetch` 不写文件，直接返回页面正文。
6. Java 的 action 预览为这两个工具返回输入。
