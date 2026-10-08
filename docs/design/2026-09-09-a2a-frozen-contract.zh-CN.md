# P1：冻结的外部契约

[English](2026-09-09-a2a-frozen-contract.md) | [简体中文](2026-09-09-a2a-frozen-contract.zh-CN.md)

状态：冻结契约与轮询式 JSON-RPC 传输已经实现；尚未完成跨实现互通验证。更新于 2026-10-06（任务由 thread 改为落到聊天会话）。

本文最初是[接续架构](https://github.com/QwenLM/qwen-code/blob/8ff056f1c7e5842393bc8d0f5b8a6ab1502462b6/docs/design/2026-09-09-agent-service-collaboration.zh-CN.md)与[实施计划](https://github.com/QwenLM/qwen-code/blob/8ff056f1c7e5842393bc8d0f5b8a6ab1502462b6/docs/plans/2026-09-09-agent-service-collaboration-plan.md)的 P1。现在记录 core workspace-agent A2A 模块与 daemon 传输层已经实现的契约；文档与代码不一致时以代码为准。

## 1. 冻结的版本与绑定

| 项              | 取值                                              | 出处                                          |
| --------------- | ------------------------------------------------- | --------------------------------------------- |
| 协议版本        | `1.0`（`Major.Minor`，wire header `A2A-Version`） | 规范；`@a2a-js/sdk` 的 `A2A_PROTOCOL_VERSION` |
| 传输绑定        | `JSONRPC`（唯一一个）                             | `AgentInterface.protocolBinding`              |
| SDK             | `@a2a-js/sdk@1.1.0`，Apache-2.0，node ≥ 20        | npm registry                                  |
| Agent Card 路径 | `.well-known/agent-card.json`                     | 规范 §8（RFC 8615）                           |
| Content-Type    | `application/a2a+json`                            | SDK 常量                                      |

选 JSON-RPC 而非 gRPC：daemon 本来就是 Express，SDK 直接提供 `./server/express`；gRPC 会为我们用不到的能力引入 `@grpc/grpc-js` 与 `@bufbuild/protobuf` 两个运行时 peer。

规范定义三种绑定但**不强制任何一种**，所以“支持 A2A”必须落到具体绑定才有意义。

## 2. 必需与可选操作

必需（`A2ARequestHandler` 的命名）：`sendMessage`、`getTask`、`listTasks`、`cancelTask`、`getAuthenticatedExtendedAgentCard`。五个全部应答之前不得对外声称 A2A。

可选，第一版**一个都不取**：`sendMessageStream` / `resubscribe`（需 `streaming`）、四个 push notification 操作（需 `pushNotifications`）。两者都只是“更早知道任务状态”的手段，轮询 `getTask` 回答同一个问题，而且不引入第二条需要单独做可靠的投递路径。

## 3. 单位映射（本文最要紧的一条决定）

**A2A `Task` = 聊天会话里的一次 Agent 运行（run）；A2A `contextId` = 该聊天会话的 id。**（本节原先描述的 thread 模型已随会话多 Agent 重做删除，见 [会话多 Agent 设计](2026-10-05-session-multi-agent.zh-CN.md) §6。）

- 不带 `contextId` 的消息：daemon 为调用方新建一个普通聊天会话（在 WebShell 中显示为 `A2A · <callerId>`，`sourceType: 'default'`，`sourceId: 'a2a:<callerId>'`），并以 `@<获授权 Agent> <正文>` 的形式发到该会话。这条消息触发的 run 就是任务，任务 id 即 run id。
- 带有调用方为同一 Agent 拿到的 `contextId` 的消息：发到同一个会话，Agent 的原生会话随之延续，记得之前的轮次。其他 `contextId` 一律按未知拒绝。携带 `taskId` 的消息会被拒绝：一个任务就是一轮，后续输入应作为同一 context 下的新消息。
- 授权只绑定一个 Agent，因此调用方只能找这个 Agent：正文里其他所有 `@名字` 在发出前都会被中和。获授权 Agent 自己的回复仍可像任何聊天会话一样 @ 其他工作区 Agent。
- 若同一 context 中上一个 run 仍在排队，新消息会并入该 run（编排器会合并排队中的触发），两条消息报告同一个任务。
- 回答产物是获授权 Agent 的回复（该 run 的 `agent_message` 记录）。首次观察到的终态保存在调用方的映射文件里，因此不受会话 run 列表裁剪或会话被删除的影响。

| 本地 run 状态       | A2A `TaskState`             | 说明 |
| ------------------- | --------------------------- | ---- |
| `queued`            | `TASK_STATE_SUBMITTED`      |      |
| `running`           | `TASK_STATE_WORKING`        |      |
| `awaiting_approval` | `TASK_STATE_INPUT_REQUIRED` | 见下 |
| `completed`         | `TASK_STATE_COMPLETED`      |      |
| `failed`、`offline` | `TASK_STATE_FAILED`         |      |
| `cancelled`         | `TASK_STATE_CANCELED`       |      |

`toA2ATaskState` 是穷尽映射：新增 run 状态而不决定它对外长什么样，会让映射器抛错而不是默认。已结束但回复尚未写入会话记录的 run（会话里主模型正在跑时记录会被延后）保持 `WORKING`，因此回复写入之前不会发布 `COMPLETED`。没有文本的回复（空回合，例如小队 leader 的 `no_action`）以 `COMPLETED` 结束但不带 `answer`，`answer` 是可选字段。回复写入失败的 run 报 `FAILED`。

**审批。** A2A 调用方无法回答工具审批。等待审批的 run 报 `INPUT_REQUIRED`，扩展元数据里带 `localStatus: 'awaiting_approval'`，状态消息也会说明；再发输入并不能回答它。由工作区所有者在 WebShell 的该聊天会话中处理。

## 4. 不支持项（逐项）

- **远端用量不随 Task/Message 回报。** A2A 1.0 的数据模型里根本没有用量或 token 字段。因此**不能要求**第三方 agent 报告用量。我们自己的数字走 `Task.metadata` 下的扩展；**准入必须把“缺失”当作未知而非 0**，否则一个拒绝报告的远端 agent 就等于免费调用。
- **幂等只有 `MAY`。** 规范说 agent _may_ 用 `Message.messageId` 去重，而这个 id 由客户端自己生成、且没有作用域。两个不同调用方可以给出同一个 id。所以服务端自己加作用域键：`externalRequestKey(callerId, targetAgentId, messageId)`，按认证调用方与目标 agent 限定。三段用长度前缀拼接而非分隔符连接——id 是外部来的不透明字符串，能把分隔符塞进 id 的调用方本可以伪造出别人的键（这一点有断言，且变异验证过）。
  **该键必须在开始干活之前持久化。** 事后补写的键无法回答它存在的那个问题（重试是否与正在接受的请求是同一个），而“同键不同内容明确拒绝”也就无从判断。具体做法：先在一次加锁写入中把键预留到调用方映射文件（`<agentsDir>/a2a/<callerId>.json`，权限 0600），再在锁外建会话、发消息（编排器在同一把锁下持久化 run，锁不可重入），最后记录 run；重试会续上尚无 run 的预留，消息 id 由键派生，半途中断的接单会被编排器自身的幂等挡住。
- **两处本地状态缺口：** `TASK_STATE_REJECTED`（agent 拒绝接活）与 `TASK_STATE_AUTH_REQUIRED` 在本地模型里没有对应物。取消排队中的 run 立即生效；执行中的 run 会被要求停止，程序真正停下后才进入 `CANCELED`（取消响应里的 `runsStillLive` 说明是哪种）。不能给已有任务追加消息，但可以在同一 context 中继续。

## 5. 本地 run 状态的非 `_meta` 通道

本地用 ACP prompt 的 `_meta` 传 run 帧，那是 daemon 的信任边界，**外部不可达也不应可达**。外部任务另用一条：在 `AgentCapabilities.extensions` 里声明扩展 URI `https://qwenlm.github.io/qwen-code/a2a/workspace-agents/v1`，本地 run 状态（`localStatus`）、错误与用量（`tokensUsed`）都放在 `Task.metadata` 该 URI 下。

声明为 `required: false`：忽略该扩展的客户端仍能拿到正确的 Task / Message 语义，只是看不到用量。

## 6. 互通验收者

选 **`a2a-sdk`（Python，PyPI 1.1.2，requires-python ≥ 3.10）**，仓库 `a2aproject/a2a-python`。

它与我们服务端所用的 `@a2a-js/sdk` 是不同语言、不同代码库，因此“两端都用自家客户端自测”这条被架构 §6 排除的情形不成立。用 `@a2a-js/sdk` 自带的 client 顶多算冒烟，不作为兼容证据。

## 7. 仍需人来定的事

1. 生产环境的连接模型：谁能访问 daemon，是否需要提前实现出站通道。
2. ~~外部任务的审批接收人。~~ 2026-10-06 已定：工作区所有者，在 WebShell 的该聊天会话中处理（见 §3）。

一份授权只绑定一个调用方和一个 Agent，不携带为未来预留的权限 scope；能力边界继续由 Agent 现有的工具策略决定。

授权跟随 Agent 的当前配置（2026-09-30 定）：每次请求都按 Agent 的实时定义校验，因此分享发出后再修改 Agent 的指令、角色、工具或执行位置，也会作用于这份分享。Agent 在本机与 managed-host 执行之间迁移时不会撤销已有授权；之后的请求会在当前分配的 Runtime 工作区中执行。分享对话框中已写明这一点。若要保留原来的边界，请在修改 Agent 前撤销分享，或单独分享另一个 Agent。

另有一项来自架构 §5、须在 P3 前定：Codex turn 结束时“什么信号算明确任务结果”的映射。

## 8. 实现状态

daemon 已发布 Agent Card，并提供带认证的轮询式 JSON-RPC 路由，支持提交（新建或延续 context）、查询、列出和取消任务，仅在启用 Agent 协作时挂载。授权只保存密钥摘要，接单具备幂等性并按调用方隔离。代码：`core/src/agents/workspace-agents/{a2a-contract,external-intake,a2a-server}.ts`、`cli/src/serve/session-agents/a2a-sessions.ts`（编排器适配层）与 `cli/src/serve/routes/a2a.ts`。流式传输、push notification，以及使用 Python 客户端做跨实现验收仍不在本轮范围内。
