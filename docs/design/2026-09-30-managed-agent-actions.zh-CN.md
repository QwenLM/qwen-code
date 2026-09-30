# Managed Agent Actions（阶段 D6）

[English](2026-09-30-managed-agent-actions.md) | [简体中文](2026-09-30-managed-agent-actions.zh-CN.md)

状态：D6a（Hosted Harness）与 D6b（Java 服务端）均已实现。
日期：2026-09-30
Issue：[#12867](https://github.com/QwenLM/qwen-code/issues/12867)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
决定：[#12867 评论](https://github.com/QwenLM/qwen-code/issues/12867#issuecomment-5895205811)
基于：[API 契约（D1）](2026-09-27-managed-agent-api-contract.zh-CN.md)、[持久生命周期（D4）](2026-09-28-managed-agent-durable-lifecycle.zh-CN.md)、[Hosted Workspace 工具回合](2026-09-27-hosted-workspace-tool-turn.zh-CN.md) 与 [Hosted 公开 Workspace 受理（G0）](2026-09-29-hosted-public-workspace-admission.zh-CN.md)

## 1. 问题

[公共 API 契约][contract]第 10 节与[契约收敛][closure]第 3 节定义了 Action：需要人授权的工具调用会暂停，回答者通过任一入口回答，然后工具执行或被拒绝。#12867 为 D6 规定的验收条件是：Harness 发起的审批可以通过任一入口回答，Turn 随之继续；重复的回答返回原结果；无权的回答者得到 `403`。

D6 之前，`main` 已经有持久化所需的部件，但没有任何代码使用它们：

- Session authority 有 `requestToolAction`（只有当前 Harness activation 能开启的权限票据）和 `resolveAction`（可信仲裁者的最终决定），但没有代码调用它们。
- Harness 句柄有 `commitDurableWait` 与 `resolveDurableWait`，审批未决期间保持一个 `await_action` 检查点，此时 Runtime 派发拒绝启动。
- Hosted Harness 从不请求审批。普通回合拒绝工具确认，工具回合在 `preapproved-workspace-tools/1` 下执行每个调用。Java 创建 Hosted Session 时会发送部署级的审批模式（`QWEN_MANAGED_AGENT_APPROVAL_MODE`，默认 `yolo`），但 Harness 忽略它；而开启 Workspace 文件时，只要该模式不是 `yolo`，Java 就拒绝启动。
- 契约中六个 Action 操作及其 schema 都是 `planned`。

## 2. 已在 Issue 上作出的决定

- **Q1：** Hosted Harness 在 D6 中开始请求审批。
- **Q4，首版：** Session 的创建者是其唯一 owner，只有 owner 可以回答它的 Action。工具回合只在绑定 Workspace 的 Session 上运行，而服务端已经在 `managed_workspace_create_command.actor_id` 中记录了创建这些 Session 的 actor。
- **投票：** 单一仲裁者。每个合格的回答都是最终决定（`decided`）；`vote_recorded` 保持 `planned`。

## 3. 目标

- 对审批模式不预批准的工具调用，Hosted Harness 先询问、持久等待，再执行或拒绝该调用。
- Session 的 owner 可以在两个入口上列出、读取并回答 Action。回答是一个持久 command operation，经可信入口到达 Harness 的 `resolveAction`。
- 无人回答的审批会过期，因此无人回答的 Turn 也会结束。

## 4. 非目标

- 问题类 Action。authority 目前没有问题来源；`QuestionAction` 与 `QuestionResponse` 保持 `planned`。
- 多个回答者与投票，以及创建者 owner 之外的角色（Q4）。
- Harness 重启后恢复审批。加载带有未结算输入的 Session 已经返回 `409 hosted_turn_recovery_required`；接管由 Stage G 负责（#12952）。
- 没有 Workspace 的 Session 的审批，这类 Session 不运行工具。
- 工具回合的 `plan` 与 `auto` 审批模式。

## 5. D6a：Hosted Harness 发起询问

### 5.1 审批模式

Harness 遵循 Java 创建 Hosted Session 时已经以 `approvalMode` 发送的审批模式，创建请求另外新增由 D6b 发送的 `approvalTimeoutMs`。该模式与工具配置一起固定在 Session 定义中。加载时使用保存的模式，因此修改部署的模式只影响新的 Session；Harness 读不懂的已保存模式会让加载以 `409` 失败，而不是不经询问就运行。`yolo` Session 不保存模式，因此它的定义保持不变，D6a 之前创建的 Session 按 `yolo` 加载。对于带工具配置的 Session，创建与加载的回答会以 `approvalMode` 报告已固定的模式；D6a 之前的 Harness 不带这个字段。

| 模式        | 预批准                              | 在以下调用之前询问                          |
| ----------- | ----------------------------------- | ------------------------------------------- |
| `yolo`      | 每个调用，与现在相同                | 不询问                                      |
| `default`   | `read_file`                         | `write_file`、`edit` 与 `run_shell_command` |
| `auto-edit` | `read_file`、`write_file` 与 `edit` | `run_shell_command`                         |

每种模式列出的是它预批准的工具，因此之后加入配置的工具在有人把它列入之前都会被询问。Java 目前选择的文件配置 `hosted-workspace-files/1` 没有 shell 工具，因此 `auto-edit` 在其中什么都不询问；shell 那一行适用于 `hosted-workspace-shell/1`。

对于工具配置，`plan` 与 `auto` 返回 `400 invalid_hosted_approval`：plan 模式需要自己的规划语义，auto 模式需要分类器，而 Hosted 路径两者都没有。超出范围的超时也返回同样的错误；`yolo` 从不等待，因此忽略超时。没有工具配置的 Session 继续忽略该模式，因为它不运行工具。

D6b 为 Workspace 文件开启 `default` 与 `auto-edit`，并提供它们的审批入口。默认仍为 `yolo`。

### 5.2 Turn 在哪里等待

一个工具轮次现在的顺序是：校验调用、预热并获取 Workspace、提交模型的助手消息、记录每个调用的意图、派发批次并提交每个结果。审批位于助手消息之后、第一个意图之前：

1. 先提交助手消息，这样在有人回答之前，客户端就能从 Session 的 Item 中展示待审批的调用。
2. 对模式不预批准的每个调用，按模型给出的顺序，Harness 发布该 Action 的选项，用 `commitDurableWait` 开启 Action 并等待。authority 每个检查点只保存一个审批，因此调用逐个询问；Harness 察觉到 Turn 已被取消之后，不再询问后续的调用。
3. Action 得到最终结果后，`resolveDurableWait` 推进检查点。被允许的调用加入批次；其他任何结果都会让该调用得到一个拒绝结果（与无效批次已有的做法相同），模型继续。
4. 只有在本轮每个调用都有结果之后，Harness 才记录意图并派发被允许的调用。如果一个都没有被允许，本轮只提交拒绝结果。

Runtime 绑定保持 `preapproved-workspace-tools/1`，因为决定在派发前由 Harness 作出：Runtime worker 以预批准方式运行 Workspace Session 的调用，也没有可以询问的人。

Workspace 每个 Turn 获取一次，在 Turn 等待期间保持占用，与模型在两轮之间思考时相同。每次审批的过期时间只限制该次等待；累计等待见第 8 节。

`commitDurableWait` 目前复制上一个检查点的 Turn 身份，因此 Turn 第一轮中的审批会让之后的 Runtime 批次拒绝更改未完成的 Turn。D6a 加上 `commitAwaitRuntimeBatch` 已经接受的 Turn 绑定。

### 5.3 Action

| 字段           | 取值                                                       |
| -------------- | ---------------------------------------------------------- |
| 请求 ID        | `tool_approval_` 加 32 位十六进制，在 Session 内唯一       |
| 类型与来源     | `permission` 与 `tool_call`                                |
| 输入版本       | `1`；等待期间调用的输入不会改变                            |
| 策略版本       | `hosted-tool-approval/1`                                   |
| 选项           | `allow`（Allow）与 `deny`（Deny）                          |
| 创建与过期时间 | 由 Harness 设定；过期时间为创建时间加上 Session 的审批超时 |

选项、策略版本、两个时间、Turn、模型的函数调用 ID 与工具名在请求提交之前作为 Action 的 `optionsRef` 资源发布，因此 Java 无需询问 Harness 就能投影出 Action。authority 只把 `tool_call` 记为来源，因此函数调用 ID 放在该资源中；它指向已提交的助手消息中的一个调用。公共 Action 不展示工具参数。

审批超时是 Session 定义的一部分，由创建请求设定，默认 10 分钟，范围 1 秒到 24 小时。

### 5.4 作出决定

新的私有路由 `POST /session/:id/actions/:requestId/resolve` 使用与其他 Session 路由相同的客户端身份、bearer token 与 Harness 协议检查。请求体给出选项与两个版本。随后 Harness：

- 对该 Session 没有的 Action 返回 `404 action_not_found`；
- 对未知选项或不匹配的版本返回 `400 invalid_action_response`；
- 对以过期或取消结束的 Action 返回 `409 action_expired` 或 `409 action_cancelled`，对已决定的 Action 给出不同决定时返回 `409 action_already_resolved`。在过期时间之后到达的回答会把 Action 结为过期，即使计时器还没有触发；
- 否则把决定发布为确定性的字节，以 `decided` 调用 `resolveAction`，唤醒等待中的调用，并以 `200` 返回请求 ID、`decided` 与所选选项。重复同一个决定会返回同样的结果，因为 Harness 会把这些字节的摘要与已记录的决定比较。出于同样的原因，等待中的调用无需回读决定，就能从已记录的摘要判断是否为 `allow`。

决定字节是 `JSON.stringify({ v: 1, optionId, inputRevision, policyRevision })` 的 UTF-8 编码，严格按此键顺序，不含空白或末尾换行。`v` 与 `inputRevision` 是 JSON 数字；`inputRevision` 使用 Action 记录自身的值，而非 checkpoint 中的字符串版本。`optionId` 与 `policyRevision` 是字符串。例如：

```text
{"v":1,"optionId":"allow","inputRevision":1,"policyRevision":"hosted-tool-approval/1"}
```

决定摘要是这些字节的 SHA-256，以不带 `sha256:` 前缀的小写十六进制表示。D6b 比较回答与投影出的 Action 决定摘要时，使用同一编码。

在决定写入之前发生的失败返回 `503 action_resolution_failed`，Action 保持原状，调用方可以重试。journal 写入失败会停止该 Session 之后的所有写入，与任何写入失败一样；因此路由改为唤醒等待中的调用，由它立即（而不是等到过期）把 Session 置为恢复阻塞，并返回 `409 hosted_turn_recovery_required`。等待中的调用还会每秒检查一次该 Session 的写入是否因其他原因停止，因此在这种情况下也不必等到过期。

处于恢复阻塞的 Session 仍按上述规则回答已经记录的内容：重复的决定、不同的决定与已结束的 Action。凡是需要写入的回答，它改为返回 `409 hosted_turn_recovery_required`。决定和过期写入都会在 authority 的串行队列内重新检查该条件，因此写入排队期间发生阻塞时，不会受理新的结果。

### 5.5 过期与取消

- **过期：** 到达过期时间时，Harness 把 Action 结为 `expired` 并拒绝该调用。既然无人回答，该 Turn 之后不再询问：本轮以及模型后续各轮中每个本需询问的调用都会立即被拒绝。绑定的 Session 目前还不能通过 Java 取消（G0），因此过期是结束无人回答的 Turn 的方式，大约在第一次询问之后一个超时。
- **取消：** 当 Turn 因取消请求或 prompt 的截止时间被中止时，Harness 在结算 Turn 之前把等待中的 Action 结为 `cancelled`，并拒绝本轮的每个调用，因此不会有已结算的 Turn 留下 `requested` 的 Action，也不会派发任何调用。Turn 进行中时，关闭或删除 Session 会被拒绝。
- **重启：** 在等待期间停止的 Harness 会让 Action 保持 `requested`、Turn 保持未结算；见第 4 节。

## 6. D6b：Java 提供 Action

### 6.1 投影

Session Store 已经会读取每一行已提交的 journal 来投影 Stage H 记录。它还会在同一个事务中把 `action.changed` 投影到一张新的 Action 表，从 Harness 在提交请求之前发布的 `optionsRef` 资源中读取选项，并追加一个 `action.updated` Session 事件。该表使用 Flyway V24；V20–V22 已由工具发布功能使用，V23 已由 Session MCP 目录使用。投影验证原始选项资源及不可变的版本链。决定回执 ID 是从已记录决定派生的不透明产品句柄，不暴露存储资源 ID。存在对应的 Java Turn 时，从 Hosted prompt ID 解析公共 Turn ID。

### 6.2 路由

- **列表：** `GET …/actions` 与 WebShell `actions/query` 按从新到旧分页列出 Session 中 `requested` 的 Action，使用 Turn 列表的游标与 limit 规则。
- **读取：** `GET …/actions/{actionId}` 与 WebShell `actions/get` 返回任何状态的 Action；已决定的 Action 带有 `decision_receipt_id`。
- **回答：** `POST …/actions/{actionId}/responses` 与 WebShell `actions/respond` 以 `202` 返回 `action_response` command operation。受理前按 Action 的类型、版本、选项、状态与过期时间检查请求。该 operation 在 D4 的幂等域（租户、Session、类型、actor 与键）内幂等。worker 把它转发到 Harness 路由，失败的尝试按 dispatch 退避回到 pending；与 D4 一样，没有最后一次尝试。worker 以 Java 从 journal 投影出的 Action 为准判断结果，从不根据时钟或仅凭失败的调用推断：Harness 已记录的决定可能已经让调用运行，只是它的回答丢失了，或者 Harness 已经重启。Harness 在返回 `200` 之前已经提交了决定，因此投影中已经能看到它。投影出的 Action 进入终态后，该 operation 才完成：若为 `decided` 且决定与本次回答相同（Java 按第 5.4 节的确切决定编码比较摘要），以 `action_resolution`（`decided`，带决定回执）完成；否则以其结束状态（`action_expired`、`action_cancelled` 或 `action_already_resolved`）完成，并通过 `failure_code`（WebShell 为 `failureCode`）公开。Harness 返回 `400` 时以该错误完成。Action 仍为 `requested` 时（例如在恢复阻塞的 Session 上），operation 保持 `running`。WebShell 请求增加 `requestId`。

### 6.3 检查

- 读取保持其他 Session 读取的检查。
- 只有 Session 的 owner（记录为其创建者的可信 actor）可以回答。其他 actor 得到 `403 action_forbidden`。
- 迟到的回答得到 `409 action_expired`、`409 action_cancelled` 或 `409 action_already_resolved`，未知的 Action 得到 `404 action_not_found`。契约会新增这些错误码。
- 对于审批模式可能询问的 Session，Session 能力 `actions` 为 `true`。Java 在 Workspace Session 受理时固定模式；迁移前的 Session 默认为 `yolo`。owner 检查使用已有创建者记录，不新增授权或 owner；无法确定创建者时拒绝回答。
- `allow` 与 `deny` 是稳定的选项 ID。Action 提供两个版本、function call ID、工具名称及过期时间；参数从 Items 读取。每个 Turn 同时最多有一个 Hosted 审批待处理。列表只返回 `requested` Action，按从新到旧排序，不在本地将它们标记为过期。

Turn 在等待期间仍读作 `running`；让客户端知道它在等待的，是它未决的 Action。

### 6.4 Java 配置

开启 Workspace 文件的部署可以设置 `default` 或 `auto-edit`。Java 随模式一起发送 `QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT`（默认 `10m`，范围 `1s` 至 `24h`），默认模式仍为 `yolo`。对于带工具配置的 Session，Java 记录创建时发送的模式，只有当 Harness 在创建和每次加载的回答中都以 `approvalMode` 报告这个模式时才使用该 Session：D6a 之前的 Harness 不带这个字段，它会忽略模式，不经询问就运行每个调用。

## 7. 测试

- **D6a：** 针对第一轮审批 Turn 绑定的核心测试。使用假模型的 Hosted 测试：被允许的写入会执行；被拒绝的写入返回拒绝结果，模型继续；混合批次只执行被允许的调用；过期的审批拒绝该调用；被中止的 Turn 取消其 Action 且不再询问；重复同一决定返回同样的结果；其他决定与迟到的决定返回 `409`；`auto-edit` 模式下拒绝 Shell 调用后编辑仍会执行；过期的审批让该 Turn 不再询问；journal 写入失败会立即阻塞 Session；其他地方的写入失败会在一秒内被察觉；恢复阻塞的 Session 回答已记录的内容，且不受理阻塞前已排队的决定或过期写入；取消请求会释放 Workspace；加载时保持并报告已保存的模式。
- **D6b：** 在 H2 与 MariaDB（MySQL 驱动）上的投影与路由测试，owner 与非 owner 的回答、重放、过期，以及契约测试在两个入口上的请求；还有一个 Hosted 进程测试，由 owner 通过公共 API 与 WebShell 回答，Turn 完成。

## 8. 风险与后续工作

- Turn 等待回答期间，Workspace 保持占用；对无人回答的 Turn，审批等待最长约为一个审批超时。如果 owner 每次都临近过期才回答，累计审批等待可接近询问次数乘以超时，跨越每个 Turn 最多 16 轮模型回复，还需加上模型和工具执行时间。目前没有累计审批等待预算；prompt 截止时间或取消可以提前结束等待。
- Harness 重启会让等待中的审批悬空，直到 Stage G 能接管该 Session。
- 回滚到 D6a 之前版本的 Harness 会忽略已保存的模式；D6b 能够察觉，因为这样的 Harness 不报告 `approvalMode`。
- 在调用的输入能在等待期间改变之前，`input_revision` 始终为 `1`。
- 问题类 Action、投票、owner 之外的角色，以及工具回合的 `plan` 与 `auto` 模式都是后续工作。

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
[closure]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-contract-closure.md
