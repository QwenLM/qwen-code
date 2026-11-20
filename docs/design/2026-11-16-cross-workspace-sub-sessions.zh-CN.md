# 在另一个 workspace 中运行子会话

[English](2026-11-16-cross-workspace-sub-sessions.md) | [简体中文](2026-11-16-cross-workspace-sub-sessions.zh-CN.md)

状态：第 1、2、3 步及审批流程改进均已实现。

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
2. **给已有会话发后续 prompt。** `create_sub_session` 接受 `sessionId`。
3. **Web Shell。** 会话页上的 `/send` 命令。

## 第 1 步：在另一个 workspace 中新建会话

### 工具

`create_sub_session` 新增可选参数 `workspace`：本 daemon 已注册 workspace 的绝对路径或 workspace id。不填时使用调用方的 workspace，即现有行为。

`first-turn` 等待第一轮结束并返回文本。指定 workspace 的 `sent` 调用在 bridge 将 prompt 写入 ACP 后返回。派发前的拒绝或 30 秒派发超时会直接返回。如果超时时已开始写入，工具会提示子会话可能已收到 prompt。跨 workspace 的 `sent` 还要求调用方开启聊天记录。任务结束时，调用方会收到结果通知。如果目标 runtime 停止而调用方仍然活跃，调用方会收到取消通知。工具结果和通知都提供目标 workspace 的子会话链接。确认后，指向调用方自身 workspace 的选择器沿用同 runtime 的执行和完成路径。

daemon 在权限决策前解析指定的选择器，并返回由调用方启动器按 `target.launcher === launcher` 计算的 `sameWorkspace`。工具缓存解析后的绑定，让确认与执行使用同一个 runtime generation。指向调用方自身 runtime 的选择器沿用常规权限流程，与省略选择器完全一致，不再增加目标确认。指向另一个 runtime 的选择器在 `default` 和 `auto-edit` 下要求用户单次批准；`auto` 即使已有旧 allow 规则也要交给分类器，`yolo` 自动批准。拒绝规则适用于原始选择器、已注册路径和 workspace ID，并且始终优先。显式 ask 规则使用同样的身份，仍要求用户单次决定。显式指定 workspace 的调用在 Plan 模式下仍被拦截。

人工确认跨 workspace 调用时，确认内容显示已注册路径和完整 prompt，并绑定到当时的 runtime generation。自动路径使用缓存的解析绑定，并采用异步解析完成后的实际审批决定；如果是 `PermissionRequest` replacement，还要在 replacement 也解析完成后再决定。因此，解析期间切到 `auto` 不会凭空造出分类器批准，已过期的 `default` 决定也不能在模式切换后绕过分类器。如果启动时选择器解析到另一个 runtime，调用方须重新请求批准。已有永久授权继续适用于省略选择器的调用。`yolo` 模式下同样在权限决策前解析目标。解析完成后，工具还会在执行前重新检查调用方模式与已解析绑定，拒绝规则和 generation 检查照常生效。对于需要 AUTO 复核的调用，ACP 权限承载层和统一 agent loop 的 Core 调度器还会在自动 `ProceedOnce` 前，比较实时模式与自动判定所依据的模式。如果模式已变化，就以未启动执行拒绝过期的自动判定，不能把它记录为人工单次目标批准。自动批准还记录它所依据的模式，并在其他异步守卫之后、真正执行前再次复核。若模式已改变，就拒绝启动，不能把自动判定保留为人工单次批准。同 workspace 的真人确认也记录实际批准，基类确认回调不会再把真人行为当作自动 `yolo` 豁免。远程 AUTO 自动批准的请求还会在 bridge 中携带 `requiresAutoMode` 标记。launcher 会复核调用方的实时审批模式，如果 `auto` 已不再生效就拒绝请求。真人确认不携带此要求，`yolo` 保留原有 waiver 检查。同一 invocation 的后续权限求值复用缓存 binding，不再查询目标，但会按原始选择器与已注册路径、ID 重新检查当前 ask/deny 规则。规则新增或移除会正确改变是否必须确认，不会把权限规则更新与 runtime generation 更新混为一谈。对于未经单次批准的调用，daemon 确认调用方仍处于 `yolo`，并在派发前重新检查审批版本。workspace 设置热重载会使受影响的 ACP 通道上的待派发检查失效，直到该通道的重载请求结束。

### 解析目标

工具在请求批准前通过 `qwen/control/resolve-sub-session-workspace` 解析目标。批准后的启动请求依次经过工具、会话的派发器、`qwen/control/create-sub-session` ext 方法和调用方启动器。各启动器按 runtime generation 注册到 daemon。调用方的启动器检查深度、调用方信任状态，以及调用方是否属于 standalone 或 Live。目标启动器在自己的 bridge 上新建会话、发送 prompt 和等待结果，并应用自己的并发上限和回滚逻辑。完成通知通过调用方的 bridge 投递。

目标从注册表的公开列表中解析。内部 runtime 和 Live conversation runtime 无法被指名。两个 workspace 都必须受信，包括主 workspace。未知或不受信的目标会被拒绝，错误信息会列出可以指名的 workspace。prompt 到达 ACP 写队列队首时，启动器复核两边的 runtime generation 和会话审批版本。目标接收 prompt 时也核对实际审批模式。如果模式变更，待派发请求失效，调用方可在新模式下重试。

standalone 和 Live 调用方不能指定 workspace。它们的子会话位于 daemon 自有的目录里，这些目录在另一个 workspace 中没有意义。

### 审批模式

启动器从活跃的 ACP 配置读取双方会话的实际审批模式。双方模式相同时沿用该模式，任何一方为 `yolo` 时采用另一方的模式。剩余兼容组合中，`plan` 优先，`default` 优先于 `auto-edit` 或调用方的 `auto`。

处于 `auto` 的目标只接受使用 `auto` 或 `yolo` 的调用方。退出 `auto` 会恢复目标在该模式下抑制的权限规则。使用 `auto` 的调用方也不能委派给 `auto-edit` 目标，因为分类器和自动编辑放行的操作范围不同。模式调整只作用于子会话。模式缺失、未知、不兼容或调整失败时，启动器会在派发前关闭未使用的子会话。

### 并发上限与血缘

跨 workspace 的启动计入目标启动器的上限，每个调用方 16 个、每个 workspace 24 个。这些上限保护 B 的交互会话容量。任务结束时先释放 B 的并发槽，再投递结果。A 用自己的 `serve.maxConcurrentSubSessionsTotal` 单独限制待完成的跨 workspace `sent`，每项预留在投递完成或超时后释放。

子会话记录调用方为父会话，深度限制会拒绝子会话继续创建子会话。完成通知的 task id 是新会话的 id，第 1 步每次启动都会新建会话，因此该 id 唯一。

## 第 2 步：给已有会话发后续 prompt

`create_sub_session` 新增 `sessionId`；如果该会话在另一个 workspace 里，要同时指定 `workspace`。`model` 和 `name` 只对新会话有意义，所以不能与 `sessionId` 同时使用。

**哪些会话。** 该 workspace 中除调用方自己以外的任意会话：调用方建的子会话、侧任务、定时任务运行、人的会话，或其它会话的子会话都可以。目标保留自己的父会话和来源。启动器从活跃条目读取它们；已经被空闲回收的会话，则读它对话记录开头的创建记录。调用方自己、不存在或已归档的会话，以及 standalone 会话会被拒绝。追问已关闭的 worktree 会话前，需要先打开目标，使 daemon 校验并恢复它的 worktree。对于活跃的 worktree 会话，启动器在附加客户端和派发时都会检查实际工作目录是否位于该 worktree 内。如果 prompt 排队期间持久化的 worktree 元数据发生变化，追问会失败，可以重试。

第一版只允许调用方建的会话，因为后续 prompt 会把调用方模型写的文本作为用户输入放进目标。这排除了 skill 把工作交给人已经在用的会话的场景，用户可以通过 `/send` 完成这类交接。每次后续 prompt 都要通过信任、并发上限和深度检查。使用 `consensus` 的目标会在附加客户端前拒绝工具追问，因为该客户端会计入审批人数却无法投票。在另一个 workspace 里，收紧后的模式在这一轮之后仍留在目标上，所以后续 prompt 可能让人的会话停在比他们选择的更严格的模式。两个顶层会话可以用 `sent` 互相来回发 prompt，只受并发上限约束。

**批准。** 指定了 workspace 的后续 prompt 要满足第 1 步对该 workspace 的全部要求：`default` 和 `auto-edit` 下单次批准，`auto` 交给分类器，`yolo` 可豁免但拒绝规则和显式 ask 规则仍然优先。确认内容会写出目标会话。启动器比较双方的审批模式。同 workspace 的追问沿用工具的常规权限流，包含上述当前 workspace 和分类器规则。跨 workspace 时，如果需要收紧模式，会在追问开始执行时切换。无论在哪个 workspace，受理后变更审批模式都会使待派发的请求失效。

**执行这一轮。** 启动器在该会话所属 workspace 的 bridge 上恢复它：如果它还活着就附加上去，否则从对话记录恢复。归档协调器覆盖查验血缘、恢复和入队。prompt 排在正在运行的轮次后面。等待期间只统计带有自己 prompt id 的输出，所以已经在运行的那一轮或后台轮次都不会被误当成这一轮。后续 prompt 保留会话原来的名字，失败的后续 prompt 永远不会关闭或删除这个会话。恢复会给会话附加一个 client；启动器处理完这一轮后会释放它，所以后续 prompt 不会让附加不断累积，只为这次后续 prompt 而恢复的会话在没有剩余工作时会再次关闭。

**回报。** 每个用 `sent` 发出的后续 prompt 都会回报，无论在哪个 workspace；和跨 workspace 的 `sent` 启动一样，这要求调用方开启了对话记录。新建会话的 `sent` 启动会等到 prompt 开始执行再返回，这是立即发生的；后续 prompt 排进队列就返回。启动器等待结果的时限是 30 分钟，目标等待审批或回答问题时暂停计时。ACP 写入开始前超时会阻止派发并发布失败终态。如果写入已经开始，超时只结束结果等待，后续 prompt 继续等当前 ACP 请求结束。轮到它时各项检查依然会执行，拒绝时会以失败的完成通知回报。如果追问失败后没有其它可执行的排队 prompt，bridge 会释放前一轮的 Todo Stop Guard 等待。它的后台任务 id 是 `<sessionId>:<promptId>`，而不是会话 id：调用方会从同一个会话收到多条完成通知，而接收方会把重复的任务 id 当作已经收到的通知。启动器会返回这个 id，调用方会话会记录它，这样 Todo Stop Guard 就能把这条完成通知和发起它的工作关联起来。工具描述也会告诉调用方的模型：结果会自动回来，不要让子会话再回报，否则结果会送达两次。

深度限制仍然禁止子会话继续委派。daemon 没有全局的委派记录，所以互相发 prompt 的会话只受并发上限约束（见“哪些会话”）。

## 第 3 步：Web Shell

人可以在会话页上做模型用工具做的事：在选定的 workspace 里启动子会话，或者发给那里已有的会话，然后看到回复。

**入口。** 输入框里的斜杠命令：`/send [--workspace <名称|路径|id>] [--session-id <id>] <消息>`。不写 `--workspace` 就发到当前 workspace；不写 `--session-id` 就在那里新建会话。选项写在前面，其后的全部内容都是消息，可以换行；带空格的值可以加引号。补全会提示选项名、受信的已注册 workspace，以及所选 workspace 里的活跃会话（按名称列出，插入的是 id），其中不含调用方自己。只有 daemon 声明了 `session_sub_session_send`、且当前会话运行在已注册的 workspace 中时，才会列出这个命令。被拒绝时（workspace 不受信或未知、会话不存在、达到上限），显示 daemon 给出的原因，并把命令放回输入框。不接受附件：消息只能是文字。

**路由。** 发送时调用 `POST /session/:id/sub-sessions`，请求体为 `{ prompt, workspace?, targetSessionId? }`；`:id` 是当前打开的会话，它就是调用方。路由使用和 `POST /session/:id/prompt` 相同的所有者检查，把请求交给调用方所在 workspace 的启动器，按工具发起的 `sent` 启动来执行：相同的信任和并发上限检查，以及相同的对话记录要求。返回 `{ sessionId, workspaceCwd?, taskId? }`。

有四点和工具不同，因为消息是人写的、目标是人选的。理由都一样：人本来就可以打开目标会话、在那里输入同一条消息。

- 不再单独批准。选定 workspace 并点击发送就是批准；路由在同一个请求里解析目标并启动。
- 目标保持自己的审批模式，调用方的模式不参与比较。使用 `consensus` 权限策略的目标 workspace 会在启动前拒绝 `/send`，因为侧栏接入时审批的投票者名单已经确定。请打开目标会话直接发送。
- 深度限制不适用，所以子会话的页面也能发送：深度限制是为了防止模型无休止地委派，人发的消息不会递归。
- 消息会记到调用方里，回复则以一轮的形式回到调用方，由调用方的模型转告给人（见下面的“调用方里的往来记录”）。

只有这个路由能提出这些；它们不是 ACP 子进程能发送的字段，所以模型无法冒充。工具保持自己的规则，对人建过或发过消息的会话也一样。和工具一样，除调用方自己以外的任意会话都可以作为目标，并保留自己的父会话和来源；新建会话的标题和会话链接都不带线程符号。

**发送之后。** 页面不动。目标在跑这一轮时，输入框上方会出现“1 个其他会话”标记，和后台智能体、shell 的标记排在一起。点击它会在右侧边栏的标签页里打开目标会话：实时显示、只读。MCP 卡片显示保存的输出或摘要。标签页里仍会显示目标会话的工具审批和提问，并且可以直接在那里回答：目标保持它自己的模式，在需要询问的模式下它可能停在某个审批上，而别处没人在看。目标在等待时，标记会换成警示色的“1 个会话等你回答”，因为 daemon 的权限等待默认没有超时，调用方页面上也没有别的东西会说明目标被卡住了。这一轮结束时标记消失。

**调用方里的往来记录。** 看起来就像两个会话在对话：目标回答调用方，调用方再告诉人。发送被接受后，消息作为用户一侧的一行出现在调用方里，上方标着“发给 <workspace> · <会话>”。目标这一轮结束后，调用方自己跑一轮，开头像会话间消息一样标着“跨会话消息 · <workspace> · <会话>”，它的模型在这一轮里用自己的话告诉人目标回了什么，以及需要处理什么。调用方里不再重复显示目标的原话：原话在目标会话里，目标工作时可以从标记打开的标签页看到，之后可以点卡片上的“查看详情”在侧边栏打开。这一轮结束、步骤折叠后，卡片仍然保持可见，所以调用方转述的内容来自哪里始终看得到。

消息这一行通过 daemon 的外部记录调用（`appendExternalRecord`）写入并实时显示，Agent Collaboration 也用这个调用记录另一方发来的消息。模型历史尚未包含这一条发送记录时，自动转述轮会补入记录中经过长度限制的模型文本。这是一条带新字段 `sentTo`（目标的 id、workspace 和标题）的 `agent_mention` 记录，记录的键取自完成任务的 id，所以重复写入不会产生新记录。它不会触发一轮。

回复就是工具发起的 `sent` 启动所发出的完成通知。人发的消息会附带一段摘要，要求模型把目标的回复告诉用户，并重复消息的前 2,000 个字符。模型收到的通知省去会话链接，避免原样复述链接。通知的标签是“<workspace> · <会话>”。结构化的 `fromSession` 元数据为 Web Shell 卡片标识目标会话及其 workspace。

最初的设计不触发一轮，而是把目标的回复作为一条消息显示在调用方里；用户希望由调用方理解回复后再告诉他，就像会话之间发消息那样。更早的版本会触发一轮，但调用方里没有任何发送记录，模型就会怀疑结果的来历；消息这一行解决了这个问题。

回复到达时如果调用方已经不在线，回复会像其他 `sent` 完成通知一样等待送达。

**目标里的消息。** 目标收到的 prompt 在 `inputAnnotations` 里带一条 `source`（发送时调用方的 id、workspace 和标题）。标注随用户记录保存，重放时会带回来，所以目标的对话里，这条消息上方会显示“来自 <workspace> · <会话>”，实时显示和刷新之后都一样。模型看不到它。工具发起的启动也带这条标注；定时任务的运行不带，因为它的调用方并不是发消息的人。这条标注是显示数据，daemon 的任何客户端也能像其他标注一样把它放到自己的 prompt 上；没有任何授权逻辑读取它。

**标记的数据。** 这些启动是由 daemon 而不是调用方的子进程回报的，所以子进程的任务列表里没有它们。调用方的启动器会为每个向调用方回报的 `sent` 启动记一条记录，无论是人发的，还是模型发起的跨 workspace 或后续 `sent` 启动，从启动开始，直到目标这一轮结束（完成、失败，或 daemon 停止时记为取消）。`GET /session/:id/tasks?includeSubSessions=true` 会在子进程的任务旁边以 `subSessions` 返回这些记录。人发给已有会话时，记录用目标的标题称呼它；记录还带有 `waitingForInput`，启动器以目标已有的待处理请求为初始状态，在跟随这一轮时更新它。等待审批或回答问题时会暂停 30 分钟的观察时限。记录开始、结束，或者开始、停止等待时，daemon 会在调用方的 workspace 上发布带调用方 id 的 `sub_session_task_changed`，Web Shell 随之重新读取列表；有记录在运行时，还有一个低频轮询作为事件的后备。所以通过 API 或由模型发出的消息也会显示标记。记录保存在 daemon 内存里，每个调用方最多 20 条，先丢弃最早结束的。20 个名额都在使用时，daemon 会拒绝新的发送，直至有空位。daemon 重启后会丢失记录和尚未送达的通知。

## 文件

- `packages/core/src/tools/create-sub-session.ts`：新参数、校验、描述和批准文本，以及后续 prompt 结果的措辞。
- ACP 会话的派发器和 bridge 的请求校验（`packages/cli/src/acp-integration/session/Session.ts`、`packages/acp-bridge/src/bridgeOptions.ts`、`bridgeClient.ts`）：传递该字段。派发器还会把 daemon 的拒绝原因传给工具：携带原因的 RPC 错误到达会话时是一个普通对象，它的 message 只有 "Internal error"，工具以前会把它打印成 `[object Object]`。
- `packages/cli/src/serve/create-sub-session.ts`：调用方一侧的检查、交给目标启动器、审批规则、通知路由、人发消息的记录，以及后续 prompt 的路径（血缘检查、恢复、释放 client、任务 id、按 prompt id 匹配）。
- `packages/cli/src/serve/run-qwen-serve.ts`：按 workspace 注册每个启动器，并把解析函数交给各启动器；把启动器查询暴露给路由。
- `packages/cli/src/serve/routes/session.ts`、`capabilities.ts`：`POST /session/:id/sub-sessions` 路由、其能力标签，以及 `GET /session/:id/tasks` 的 `includeSubSessions` 视图。
- `packages/core/src/agents/session-agents/contract.ts`、`packages/acp-bridge/src/transcript-replay.ts`：`agent_mention` 记录的 `sentTo` 字段，以及它在实时和重放时的投影。
- `packages/sdk-typescript/src/daemon/`：客户端方法、`subSessions` 任务类型、`sub_session_task_changed` 事件、`sentTo`，以及 `source` 标注类型。
- `packages/web-shell/client/`：`/send` 命令及其补全、输入框上方的标记及其等待状态、右侧边栏里的只读会话标签页，以及用户消息上的“发给”和“来自”行。
- 工具的用户文档。

## 不在范围内

- Agent Collaboration 跨 workspace 的 `@` 提及（#17419）。
- 把目标会话里的 `ask_user_question` 或工具审批转给调用方的模型。它们留在目标会话中；人在那里回答，或者在跟随它的 Web Shell 标签页里回答。
- 在右侧边栏的标签页里回复，或者从那里打开目标会话。
- 在 daemon 重启后保留进行中的 `sent` 启动。重启会丢失待发的通知，与现在一样。

## 待定问题

- 用 `first-turn` 发出的后续 prompt 最多等待五分钟，而一个忙碌的会话可能让它在队列里待得更久。这次等待超时不会撤回 prompt，所以它之后仍可能执行，且没有结果通知。超时结果会提示 prompt 可能仍在排队或运行，并附上已收到的部分输出。无法确定排队时间时可用 `sent`。

- 是否所有 `sent` 子会话都应该在完成时通知调用方，而不仅是指定了 workspace 的那些？这样工具的行为更一致，但会给现有的发出就不管的调用多加一轮自动对话。

## 验证

- 单元测试覆盖按绝对路径和 id 解析，拒绝未知和不受信的目标和调用方，深度限制，在目标 bridge 派发、在调用方 bridge 通知，`default` 和 `auto-edit` 下即使已有旧 allow 规则仍需单次目标确认，当前 runtime 的选择器沿用常规权限流，已有授权或 replacement 也必须交由 AUTO 分类器复核，缓存 workspace 身份期间也应随权限规则新增和移除重新求值，普通 ACP 与统一 agent loop 的 Core 路径都不能把模式切换前的自动判定当作人工单次批准，已在解析前取消的调用不能再解析目标，调用方保持 `yolo` 时无需确认且拒绝规则仍然生效，解析期间或派发前退出 YOLO，控制和次级通道的设置热重载使待派发检查失效，读取实际审批模式，拒绝不兼容模式和启动期间的模式变更，以及目标 runtime 停止时通知取消。
- 端到端验证使用两个受信 workspace。从 A 在 B 中新建子会话，通过 `first-turn` 读取 B 的 `QWEN.md`，再验证 `sent` 在 A 中收到通知。通过 A 的子会话链接打开 B。指定不受信目标应收到拒绝与可用 workspace 列表。
- 第 2 步单元测试：后续 prompt 只返回带有自己 prompt id 的输出；`sent` 后续 prompt 以 `<sessionId>:<promptId>` 回报，并释放它附加的 client；发给忙碌会话的 `sent` 后续 prompt 排进队列就返回，轮到它时被拒的会以失败回报；已回收子会话的血缘从对话记录读取；由其它会话启动的会话（如侧任务）可以被追问，并保留自己的血缘和兼容的模式；同 workspace 的模式不兼容时拒绝派发；调用方自己、不存在的会话、Live 调用方、使用 consensus 的目标、已关闭的 worktree 会话，以及无法接收 `sent` 完成通知的调用方，都会在附加目标会话前被拒绝；`first-turn` 超时会提示待执行状态并附上部分输出；失败的后续 prompt 会释放客户端；在另一个 workspace 的后续 prompt 在该 workspace 的 bridge 上以委派后的模式运行。
- 第 2 步端到端：用 `first-turn` 追问 B 里的子会话，再在 daemon 重启后用 `sent` 追问，看到 B 带着之前几轮的上下文作答；在子会话执行长轮次时追问，只拿到新一轮的文本；调用方没有建过的会话也可以被追问。
- 第 3 步单元测试：路由的校验、所有者检查和能力标签；人发起的启动保持目标的模式，而工具发起的会被收紧或拒绝；人发起的启动能到达不是调用方建的会话，能从子会话发出（工具发起的会被拒），并拒绝调用方自己；回报的启动在调用方的启动器上列出直到结束，daemon 停止时记为取消，每个调用方有上限，工具自己回报的启动不列出；任务路由只在请求时加入它们；`/send` 的解析和补全；运行中的发送显示标记，目标在等回答时显示等待标记；只读面板保留审批、去掉输入框；人发的消息会作为记录写进调用方，回复以要求模型转告的通知送回，在目标的 prompt 上写明调用方，新建会话的标题和工具建的一样不带符号；由会话回复触发的一轮标为跨会话消息；`sentTo` 经过重放和 SDK 解析后保留，格式不对的会被丢弃；用户消息上的“发给”和“来自”行。
- 第 3 步端到端：在 A 的 Web Shell 会话里用 `/send` 发到 B 的新会话：页面不动，A 里出现标着“发给 B”的消息，B 工作时出现标记，点击后在右侧边栏看到 B，其中的消息标着“来自 A”，B 完成后 A 跑一轮，开头标着“跨会话消息 · B · …”，在这一轮里告诉人 B 回答了什么；刷新后这些内容都还在；`/send` 发到 B 里不是 A 建的会话，看到它的血缘不变；发到处于询问模式的目标，在标签页里批准它的工具调用；目标提问时标记变成“等你回答”，直到在标签页里回答；通过 API 发出的消息会在打开的页面上显示标记。
