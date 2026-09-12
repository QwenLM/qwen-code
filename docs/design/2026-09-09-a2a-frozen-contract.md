# P1：冻结的外部契约

状态：契约已冻结并有可执行落点；尚未实现任何传输层，也没有跑通任何互通。2026-09-09。

上游为[接续架构](./2026-09-09-agent-service-collaboration.md)与[实施计划](../plans/2026-09-09-agent-service-collaboration-plan.md)的 P1。本文只记录“说定了什么”，不宣称“跑通了什么”。

可执行部分在 `packages/core/src/agents/workspace-agents/a2a-contract.ts`，由 `scripts/audit/run-workspace-agents.mjs` 第 29 节断言（本轮 227 passed / 0 failed）。文档与代码不一致时以代码为准——文档会过期，断言不会。

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

**A2A `Task` = 本地一个 `Thread`，不是一个 `ThreadRun`。**

Task 会经历 `INPUT_REQUIRED` 再收到后续输入，这正是一个 thread 被回答后继续被推进；而 run 是单次 turn，在协议里没有对应物。相应地 **A2A `contextId` = `rootThreadId`**——规范把它称作“the contextual collection of interactions”，那正是一个父 thread 连同它分裂出的子 thread。`Message` ↔ `ThreadMessage`。

| 本地 `ThreadStatus` | A2A `TaskState`             | 说明                     |
| ------------------- | --------------------------- | ------------------------ |
| `open`              | `TASK_STATE_SUBMITTED`      |                          |
| `in_progress`       | `TASK_STATE_WORKING`        |                          |
| `blocked`           | `TASK_STATE_INPUT_REQUIRED` |                          |
| `in_review`         | `TASK_STATE_INPUT_REQUIRED` | 见下                     |
| `done`              | `TASK_STATE_COMPLETED`      | 唯一映射到终态的本地状态 |

`in_review` 映到 `INPUT_REQUIRED` 而不是 `WORKING`：工作没有在推进，且要由人解除，这正是该状态对“我该不该继续等”的调用方的含义。代价是**“提了问题”与“提交待评审”的区别在边界上丢失**，只在扩展 metadata 里保留。

新增 `ThreadStatus` 而不决定它对外长什么样，会让 `toA2ATaskState` 抛错而不是默认——这是断言覆盖的一项。

## 4. 不支持项（逐项）

- **远端用量不随 Task/Message 回报。** A2A 1.0 的数据模型里根本没有用量或 token 字段。因此**不能要求**第三方 agent 报告用量。我们自己的数字走 `Task.metadata` 下的扩展；**准入必须把“缺失”当作未知而非 0**，否则一个拒绝报告的远端 agent 就等于免费调用。
- **幂等只有 `MAY`。** 规范说 agent _may_ 用 `Message.messageId` 去重，而这个 id 由客户端自己生成、且没有作用域。两个不同调用方可以给出同一个 id。所以服务端自己加作用域键：`externalRequestKey(callerId, targetAgentId, messageId)`，按认证调用方与目标 agent 限定。三段用长度前缀拼接而非分隔符连接——id 是外部来的不透明字符串，能把分隔符塞进 id 的调用方本可以伪造出别人的键（这一点有断言，且变异验证过）。
  **该键必须与“接单”写在同一次写入里。** 事后补写的键无法回答它存在的那个问题（重试是否与正在接受的请求是同一个），而“同键不同内容明确拒绝”也就无从判断。
- **三处本地状态缺口：** `TASK_STATE_REJECTED`（agent 拒绝接活）与 `TASK_STATE_AUTH_REQUIRED` 在本地模型里没有对应物；**thread 级的取消也没有**——`ThreadStatus` 没有该成员，只有 run 有。所以**入站 `cancelTask` 今天无法在本地表达**，P2 必须先补上，才能声称取消可用。

## 5. run 帧的非 `_meta` 通道

本地用 ACP prompt 的 `_meta` 传 run 帧，那是 daemon 的信任边界，**外部不可达也不应可达**。外部任务另用一条：在 `AgentCapabilities.extensions` 里声明扩展 URI `https://qwenlm.github.io/qwen-code/a2a/workspace-agents/v1`，帧与用量都放在 `Task.metadata` 该 URI 下。

声明为 `required: false`：忽略该扩展的客户端仍能拿到正确的 Task / Message 语义，只是看不到用量。

## 6. 互通验收者

选 **`a2a-sdk`（Python，PyPI 1.1.2，requires-python ≥ 3.10）**，仓库 `a2aproject/a2a-python`。

它与我们服务端所用的 `@a2a-js/sdk` 是不同语言、不同代码库，因此“两端都用自家客户端自测”这条被架构 §6 排除的情形不成立。用 `@a2a-js/sdk` 自带的 client 顶多算冒烟，不作为兼容证据。

## 7. 仍需人来定的事（阻塞 P2，不阻塞 P1）

1. 实际 A/B 环境与可达方式（谁能到达谁；是否需要 P4 的出站通道提前）。
2. 首个对外开放的 Agent 及其执行权限范围。
3. 审批接收人。

另有一项来自架构 §5、须在 P3 前定：Codex turn 结束时“什么信号算明确任务结果”的映射。

## 8. 本轮没有做的事

没有实现任何 A2A 路由、没有 Agent Card 发布、没有认证、没有接单存储、没有装 `@a2a-js/sdk`（依赖尚未加入 `package.json`）。P1 的门槛是“逐项记录映射与不支持项并选定验收者”，本文与 `a2a-contract.ts` 是那个记录；跑通互通是 P2 的事。
