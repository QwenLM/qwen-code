# 在另一个 workspace 中运行子会话

[English](2026-11-16-cross-workspace-sub-sessions.md) | [简体中文](2026-11-16-cross-workspace-sub-sessions.zh-CN.md)

状态：第 1 步随本文档实现；第 2、3 步为提议。

## 问题

一个 daemon 可以服务多个已注册的 workspace，Web Shell 也已经能并排显示这些 workspace 的会话。但会话只能在自己的 workspace 里委派工作。`create_sub_session` 会在调用方所在的 workspace 里新建一个会话并在其中运行一条 prompt。它不接受目标 workspace，也不能给自己之前建的会话发后续消息。每个 workspace 的子会话启动器都绑定在自己的 bridge 上，而 bridge 会拒绝为其它 workspace 新建会话。

所以 workspace A 里的会话没法让 workspace B 带着它自己的 `QWEN.md`、skills、设置和历史去做一件事并汇报回来。用户只能切到 B，在那里输入请求，再手工把答案带回 A。

#17419 想通过 Agent Collaboration（一个绑定在 B 上、可以被 `@` 的 agent）达到同样的结果。本设计走会话路线：不需要持久的 agent 身份，也不需要实验开关，并且复用已有的子会话机制，后者已经有并发上限、超时、结果截断和完成通知。两者并不互斥，以后可以在本机制之上构建绑定 workspace 的 agent。

## 目标

- workspace A 里的模型可以在已注册的 workspace B 中新建会话，之后还能给同一个会话发后续 prompt。每条 prompt 都可以选择等待这一轮的结果，或者继续做别的、在这一轮结束时收到通知。
- 用户可以在 Web Shell 的会话页里做同样的事。
- B 里的工作在 B 的 runtime 下运行：B 的目录、设置、信任与权限。它的审批模式永远不比 A 宽松。

## 步骤

工作分三次改动落地，每一步都能单独使用。

1. **在另一个 workspace 中新建会话。** `create_sub_session` 接受 `workspace`。即本次改动。
2. **给调用方自己建的会话发后续 prompt。** `create_sub_session` 接受 `sessionId`。
3. **Web Shell。** 会话页上的"发送到会话"操作。

## 第 1 步：在另一个 workspace 中新建会话

### 工具

`create_sub_session` 新增可选参数 `workspace`：本 daemon 已注册 workspace 的绝对路径或 workspace id。不填时使用调用方的 workspace，即现有行为。

`completion` 保持原来的两个取值。`first-turn` 等待这一轮并返回其文本，与现在一样。`sent` 立即返回，这一轮结束时调用方会收到一条带结果和会话链接的任务通知。目前这个通知只发给 Live conversation runtime。现在它也会发给所有指定了 `workspace` 的调用，因为否则调用方无从得知另一个 workspace 里的工作已经完成。在调用方自己的 workspace 中发出就不管的调用保持现有行为。

工具本来就要求权限确认，这个流程不变：default 模式询问用户，auto 模式交给分类器，yolo 直接放行。调用的描述会写明目标 workspace，批准的人能看到 prompt 去往哪里。

### 解析目标

请求的传递路径与现在相同：工具，然后会话的派发器，然后 `qwen/control/create-sub-session` ext 方法，然后调用方的启动器。各个启动器按 workspace 注册到 daemon。调用方的启动器做调用方一侧的检查：深度限制、拒绝 standalone 和 Live 调用方、调用方的信任。然后把这次启动交给目标 workspace 的启动器，由它在自己的 bridge 上新建会话、发送 prompt、等待结果，使用它自己的并发上限和回滚逻辑。完成通知在调用方的 bridge 上投递，因为调用方在那里。

目标从注册表的公开列表中解析，所以内部 runtime 和 Live conversation runtime 无法被指名。两个 workspace 都必须是受信的。主 workspace 平时在信任检查上的豁免这里不适用，因为这条路径是用一个 workspace 去驱动另一个。未知或不受信的目标会被拒绝，错误信息会列出可以指名的 workspace，方便模型自行纠正。不会回退到调用方的 workspace 或主 workspace。

standalone 和 Live 调用方不能指定 workspace。它们的子会话位于 daemon 自有的目录里，这些目录在另一个 workspace 中没有意义。

### 审批模式

新会话以 B 的默认模式启动。在发送 prompt 之前，目标启动器会比较这个模式与调用方当前的模式，并把会话切换到二者中更严格的那个。从最严到最宽的顺序是：

`plan` < `default` < `auto` < `auto-edit` < `yolo`

`auto` 排在 `auto-edit` 前面，因为在 `auto` 下分类器会审查每个操作，而 `auto-edit` 会不经审查直接应用编辑。这次切换只作用于该会话，不会持久化。只要有一方的模式读不到，启动就失败而不是猜测；已经新建的会话会被关闭。

### 并发上限与血缘

跨 workspace 的启动计入目标启动器的上限：每个调用方 16 个、每个 workspace 24 个。这些上限是为了防止子会话挤占所在 workspace 的交互会话，而这里那个 workspace 是 B。子会话会把调用方记录为父会话，所以如果它试图再创建子会话，会被深度限制拒绝。完成通知的 task id 是新会话的 id；第 1 步每次启动都会新建会话，所以它是唯一的。

## 第 2 步：给调用方自己建的会话发后续 prompt（提议）

`create_sub_session` 新增 `sessionId`。该会话必须是这个调用方建的：它记录的父会话就是调用方。这条血缘是持久化的，所以在 daemon 重启后依然成立。启动器在该会话所属 workspace 的 bridge 上恢复它：如果它还活着就附加上去，否则从对话记录恢复。prompt 排在正在运行的那一轮后面，启动器按自己的 prompt id 等待或观察这一轮。发送 prompt 前会再次应用第 1 步的审批规则。这里每条完成通知都需要自己的 task id，因为调用方会从同一个会话收到多条通知，而接收方会把重复的 task id 当作已经收到的通知。

不是调用方建的会话仍然不可触及。给它们发 prompt，相当于把另一个会话的模型文本作为用户输入放进去；要和它们交流，仍然使用不带用户权限的 `send_message`。由于子会话不能再委派，调用方和它的子会话不可能形成环，所以不需要 daemon 级的委派记录。回滚永远不会关闭或删除被复用的会话。

## 第 3 步：Web Shell（提议）

会话页上的"发送到会话"操作会打开一个选择器：选一个已注册的 workspace，再选"新会话"或本会话在那里建过的某个会话，然后填写消息。发送走与工具相同的 daemon 路径，以当前打开的会话作为调用方，使用 `sent` 模式。目标会话在分屏中打开（分屏已经支持其它 workspace 的会话），它的回复就在那里流式显示。这一轮结束时，发起的会话也会收到完成通知，所以结果在两处都能看到。

## 文件（第 1 步）

- `packages/core/src/tools/create-sub-session.ts`：新参数、校验和描述。
- ACP 会话的派发器和 bridge 的请求校验（`packages/cli/src/acp-integration/session/Session.ts`、`packages/acp-bridge/src/bridgeOptions.ts`、`bridgeClient.ts`）：传递该字段。派发器还会把 daemon 的拒绝原因传给工具：携带原因的 RPC 错误到达会话时是一个普通对象，它的 message 只有 "Internal error"，工具以前会把它打印成 `[object Object]`。
- `packages/cli/src/serve/create-sub-session.ts`：调用方一侧的检查、交给目标启动器、审批规则、通知路由。
- `packages/cli/src/serve/run-qwen-serve.ts`：按 workspace 注册每个启动器，并把解析函数交给各启动器。
- 工具的用户文档。

## 不在范围内

- Agent Collaboration 跨 workspace 的 `@` 提及（#17419）。
- 把目标会话里的 `ask_user_question` 或工具审批转给调用方。它们留在目标会话中，由该会话的所有者回答。
- 在 daemon 重启后保留进行中的 `sent` 启动。重启会丢失待发的通知，与现在一样。

## 待定问题

- 是否所有 `sent` 子会话都应该在完成时通知调用方，而不仅是指定了 workspace 的那些？这样工具的行为更一致，但会给现有的发出就不管的调用多加一轮自动对话。

## 验证（第 1 步）

- 单元测试：按路径和按 id 解析；未知和不受信的目标；不受信的调用方；Live 调用方，以及本身就是子会话的调用方；交接后在目标启动器的 bridge 上运行；通知到达调用方的 bridge；审批规则覆盖整个模式顺序。
- 端到端：一个带两个 workspace 的 daemon。在 A 的 Web Shell 会话里让模型在 B 新建一个会话，读取 B 的 `QWEN.md` 并回答（`first-turn`），再用 `sent` 建一个，看到通知到达 A。指名一个不受信的 workspace 会被拒绝，并列出可以指名的 workspace。
