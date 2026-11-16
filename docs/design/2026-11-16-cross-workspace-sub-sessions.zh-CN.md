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
- B 里的工作使用 B 的 runtime、目录、设置、信任与权限。启动器根据 A 的实际模式选择子会话的审批模式。

## 步骤

工作分三次改动落地，每一步都能单独使用。

1. **在另一个 workspace 中新建会话。** `create_sub_session` 接受 `workspace`。即本次改动。
2. **给调用方自己建的会话发后续 prompt。** `create_sub_session` 接受 `sessionId`。
3. **Web Shell。** 会话页上的"发送到会话"操作。

## 第 1 步：在另一个 workspace 中新建会话

### 工具

`create_sub_session` 新增可选参数 `workspace`：本 daemon 已注册 workspace 的绝对路径或 workspace id。不填时使用调用方的 workspace，即现有行为。

`first-turn` 等待第一轮结束并返回文本。指定 workspace 的 `sent` 调用在 bridge 派发 prompt 后返回，派发前的拒绝会直接返回。跨 workspace 的 `sent` 还要求调用方开启聊天记录。任务结束时，调用方会收到结果通知。如果目标 runtime 停止而调用方仍然活跃，调用方会收到取消通知。工具结果和通知都提供目标 workspace 的子会话链接。确认后，指向调用方自身 workspace 的选择器沿用同 runtime 的执行和完成路径。

每次指定 workspace 的调用都要求用户在调用会话中单次确认。daemon 在确认前解析选择器，确认内容显示已注册 workspace 的路径和完整 prompt。批准绑定到当时的 runtime generation。如果启动时选择器解析到另一个 runtime，调用方须重新请求批准。拒绝规则适用于原始选择器、已注册路径和 workspace ID。已有永久授权继续适用于省略选择器的调用。

### 解析目标

工具在请求批准前通过 `qwen/control/resolve-sub-session-workspace` 解析目标。批准后的启动请求依次经过工具、会话的派发器、`qwen/control/create-sub-session` ext 方法和调用方启动器。各启动器按 runtime generation 注册到 daemon。调用方的启动器检查深度、调用方信任状态，以及调用方是否属于 standalone 或 Live。目标启动器在自己的 bridge 上新建会话、发送 prompt 和等待结果，并应用自己的并发上限和回滚逻辑。完成通知通过调用方的 bridge 投递。

目标从注册表的公开列表中解析。内部 runtime 和 Live conversation runtime 无法被指名。两个 workspace 都必须受信，包括主 workspace。未知或不受信的目标会被拒绝，错误信息会列出可以指名的 workspace。启动器在派发前复核两边的 runtime generation 和会话审批版本。目标接收 prompt 时也核对实际审批模式。如果模式变更，待派发请求失效，调用方可在新模式下重试。

standalone 和 Live 调用方不能指定 workspace。它们的子会话位于 daemon 自有的目录里，这些目录在另一个 workspace 中没有意义。

### 审批模式

启动器从活跃的 ACP 配置读取双方会话的实际审批模式。双方模式相同时沿用该模式，任何一方为 `yolo` 时采用另一方的模式。剩余兼容组合中，`plan` 优先，`default` 优先于 `auto-edit` 或调用方的 `auto`。

处于 `auto` 的目标只接受使用 `auto` 或 `yolo` 的调用方。退出 `auto` 会恢复目标在该模式下抑制的权限规则。使用 `auto` 的调用方也不能委派给 `auto-edit` 目标，因为分类器和自动编辑放行的操作范围不同。模式调整只作用于子会话。模式缺失、未知、不兼容或调整失败时，启动器会在派发前关闭未使用的子会话。

### 并发上限与血缘

跨 workspace 的启动计入目标启动器的上限，每个调用方 16 个、每个 workspace 24 个。这些上限保护 B 的交互会话容量。任务结束时先释放 B 的并发槽，再投递结果。A 用自己的 `serve.maxConcurrentSubSessionsTotal` 单独限制待完成的跨 workspace `sent`，每项预留在投递完成或超时后释放。

子会话记录调用方为父会话，深度限制会拒绝子会话继续创建子会话。完成通知的 task id 是新会话的 id，第 1 步每次启动都会新建会话，因此该 id 唯一。

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

- 单元测试覆盖按绝对路径和 id 解析，拒绝未知和不受信的目标和调用方，深度限制，在目标 bridge 派发、在调用方 bridge 通知，指定 workspace 时旧授权仍需单次确认，读取实际审批模式，拒绝不兼容模式和启动期间的模式变更，以及目标 runtime 停止时通知取消。
- 端到端验证使用两个受信 workspace。从 A 在 B 中新建子会话，通过 `first-turn` 读取 B 的 `QWEN.md`，再验证 `sent` 在 A 中收到通知。通过 A 的子会话链接打开 B。指定不受信目标应收到拒绝与可用 workspace 列表。
