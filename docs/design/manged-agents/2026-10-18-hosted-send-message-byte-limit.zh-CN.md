# Hosted send_message 字节超限的可恢复拒绝

[English](2026-10-18-hosted-send-message-byte-limit.md) | [简体中文](2026-10-18-hosted-send-message-byte-limit.zh-CN.md)

状态：已在工作区按下述有边界范围实施，本地验证完成，物理栈尚未验收。更新日期：2026-10-19。

## 1. 问题与证据

[#14062](https://github.com/QwenLM/qwen-code/issues/14062) 报告：Hosted `send_message` 通过原始 UTF-8 大小检查后，仍可能在 `encodeToolInput` 处使发送方整个 Turn 失败。模型拿不到工具响应，无法修正参数。另一个分支缺口使团队成员 `to: "parent"` 缺少普通子 agent 已有的原始正文大小检查。

本设计基于本地分支 `feat/managed-agents/mirror` 的 HEAD `7d6dcc8c95ec85b94a1836de17f192c4a2a2113e`。添加本文档前工作区干净。下文基线源码索引固定引用该版本。2026-10-18 使用 `gh` 读取到的 GitHub 状态如下：

- #14062 为 OPEN，标签为 `priority/P2`。已检查正文、全部四条评论和关联的[真实栈报告](https://github.com/QwenLM/qwen-code/pull/13955#issuecomment-6139614564)。报告中的运行结果属于原作者证据，本文不声称已复现。
- [#13822](https://github.com/QwenLM/qwen-code/pull/13822)（H4d-b）和 [#13955](https://github.com/QwenLM/qwen-code/pull/13955)（成员消息）均已 MERGED。当前源码包含相应路由。
- [#14118](https://github.com/QwenLM/qwen-code/pull/14118) 为 OPEN，head 为 `96c0b290578e7cbcee29da6a2921f17d3fad3568`。其生产代码补丁已提出下文两个小改动；报告和审查记录披露了 assistant record 超限的残留问题。它是参考提案，不能视为上游已实现或已接受的修复。
- [#14054](https://github.com/QwenLM/qwen-code/issues/14054) 是故障门禁总索引；FG9 跟踪项 [#14164](https://github.com/QwenLM/qwen-code/issues/14164) 已 CLOSED。[本地 FG9 设计](../2026-10-15-session-relay-fault-gates.md) 明确写明，小消息夹具不覆盖、也不修复 #14062。FG9 完成不是本修复的验收证据。

Issue 的一条评论称“没有任何消息”能同时通过原始大小检查并容纳编码，范围过宽：小消息可以同时满足两者。准确结论是：65,536 字节原始上限不代表保证可用的消息大小，包装与转义也消耗同一个 inline 预算。

## 2. 当前执行过程与限制

### 2.1 源码索引

| 源码                                                                                                                                                                                           | 职责与已观察行为                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [hosted-harness-model.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-harness-model.ts#L719)                               | 复制完整模型 parts，恢复工具 call ID，调用 `toolTurn.execute`，再将返回响应送入下一轮模型调用。                                                                                 |
| [hosted-workspace-tool-turn.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-workspace-tool-turn.ts#L2943)                  | `prepareRequests` 校验并编码每个调用。成员路由从第 3380 行开始，成员分支绕过后面的原始正文检查。第 3545 行的 encode catch 仅恢复有效 `workflow`，或本来已有校验拒绝的调用。     |
| [encodeToolInput](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-workspace-tool-turn.ts#L4791)                                | 将 `{toolName,input}` 编为 `payloadJson`，再编码 `{harnessSessionId,runtimeSessionId,payloadJson}`。当这些 UTF-8 字节超过 65,536 时抛出私有 `HostedToolInputInlineLimitError`。 |
| [hosted-harness-session.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-harness-session.ts#L3145)                          | 提供完整 ChatRecord 构造、持久提交回调和 `messageFitsInline` 判定，包括记录元数据、model 和全部 parts。                                                                         |
| [managed-session-message-record.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/core/src/managed-runtime/managed-session-message-record.ts#L32) | `MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes = 64 * 1024`。                                                                                                                  |
| [managed-child-operations.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/core/src/managed-runtime/managed-child-operations.ts#L46)             | `MANAGED_CHILD_LIMITS.maxEnvelopeBytes = 32 * 1024`。                                                                                                                           |
| [http-managed-session-store.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/core/src/managed-runtime/http-managed-session-store.ts#L58)         | `HTTP_MANAGED_SESSION_STORE_CONTRACT.maxInlineResourceBytes = 64 * 1024`。                                                                                                      |
| [hosted-session-message-session.ts](https://github.com/QwenLM/qwen-code/blob/7d6dcc8c95ec85b94a1836de17f192c4a2a2113e/packages/cli/src/serve/hosted-session-message-session.ts#L128)           | `memberMessageContent` 添加发送者头尾，成员信封检查会计算这部分字节。                                                                                                           |

该表记录修复前的 HEAD，源码永久链接固定到该版本，不随实现后的行号移动。第 8 节记录工作区实现与验证。

### 2.2 正文、编码输入与 transcript 预算

设 `R` 为消息 UTF-8 字节数，`W` 为成员信封字节数，`E` 为 `encodeToolInput` 实际生成的字节数，`A` 为完整 assistant ChatRecord 序列化字节数。必须同时满足所有适用限制。通过原始正文或信封检查，不代表精确编码输入或完整 assistant record 一定可容纳：

| 通道                                | 当前本地正文限制                          | 校验后的投递路径                                      |
| ----------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| 成员 → 成员 / `"*"`                 | `W <= 32,768`                             | `session_command` 的 `member_message`，随后由队长投递 |
| 成员 → `"parent"`                   | 缺失                                      | 发往 lineage parent 的 `session_message`              |
| 普通子 agent → `"parent"`           | `R <= 65,536`                             | 发往 lineage parent 的 `session_message`              |
| parent / lead → task 或成员 / `"*"` | `R <= 65,536`，以及既有下游信封、路由限制 | 子 agent funnel、团队扇出或 continuation              |

所有调用还要求 `E <= 65,536`。完整 assistant record 要求 `A <= 65,536`；取消响应、最终拒绝或结果记录也各有 inline 预算。检查按字节计算，不能使用 JavaScript 字符串长度。等于上限可容纳，现有检查以 `>` 拒绝。

Issue 的 JSON 数组示例原始正文为 32,501 字节，成员信封为 32,549 字节，报告中的编码请求为 71,710 字节。精确编码大小受 Session ID 和规范化参数影响，应由真实 encoder 测量，不能把报告数字当作所有夹具的固定值。

### 2.3 执行顺序与持久证据

普通路径顺序如下：

1. 准备参数、校验、编码。
2. 检查完整 assistant record 和取消响应记录。
3. 任一 prepared request 有校验错误时，为本批所有调用生成错误响应，检查完整响应记录，提交 assistant 和 tool result，返回模型。兄弟调用沿用“同批另一个调用参数无效”的既有回答。
4. 否则继续准入、提交 assistant、执行审批和 `PreToolUse`，然后派发已接受调用。`PreToolUse.updatedInput` 在原 assistant record 已提交后重新进入参数准备；更新后的校验错误通过现有 Hook 后路径变成逐调用拒绝。

`PermissionRequest.updatedInput` 发生在首次参数准备之前，也可能与原始 assistant parts 不同。两次参数准备必须使用同样的窄范围超限策略。

assistant record 在首次参数准备**之后**检查，并非每次编码之前都已写入；它在 `PreToolUse` 改写前写入。当前首次编码抛错使执行无法到达 assistant-record 检查；恢复该异常后，可能暴露第二个独立的 assistant-record 失败。

## 3. 目标与范围决策

对于原本有效、且 assistant 与拒绝记录可容纳的原生 Hosted `send_message`，将输入编码超限转为持久、关联原调用的 `byte_limit` 拒绝，使模型能缩短消息并在同一个 Turn 重试。补齐成员→parent 的原始正文检查。

这是有边界的修复。模型直接生成 65,400 字节 ASCII 正文时，虽然未超过原始正文上限，完整 assistant record 仍可能超限。本设计保留该失败，不截断参数、不伪造 transcript 证据。仅扩展编码 catch **不能**使其恢复。Hook 可以产生在自身资源预算内、但使工具输入编码超限的高转义有效参数，从而在小型原始 assistant record 之后得到编码大小拒绝。原始正文超过 65,536 字节的消息不能通过正常 Hook 路径到达这里：[HostedHookSession](../../../packages/cli/src/serve/hosted-hook-session.ts#L90) 在返回 `updatedInput` 前，把序列化原始结果和聚合输出限制在 60 KiB（61,440 字节）。原始 Hook 结果超限会变为 `non_blocking_error`；聚合输出超限会变为阻断性的 `byteLimitOutput`。这些既有 Hook 结果不属于 send-message 恢复。

**已接受的实现范围：**用户于 2026-10-19 授权实施本有边界切片，明确保留 assistant-record 超限问题。这不等于可以完整关闭 #14062；若要求超大 assistant record 也可恢复，需要另行设计 transcript 持久化。

本切片不涉及：扩大 Store 上限、外置或分块 transcript、截断参数、自动拆分或重试、新配置、新公共错误 schema、Legacy `send_message`、message/command relay 语义，以及 #14063 讨论的跨 Turn 重发重复投递。不新增 daemon route，不改变其 ownership scope，也不改 Java schema、迁移或 core 常量。

## 4. 修复方案

### 4.1 补齐成员→parent 的原始正文检查

在既有成员分支内，非空正文校验之后、成员信封检查之前，当 `!memberMessageCommand && Buffer.byteLength(text, 'utf8') > MANAGED_SESSION_MESSAGE_LIMITS.maxContentBytes` 时拒绝。

沿用原始正文拒绝文案：`Hosted send_message message exceeds 65536 bytes.` 成员寻址消息继续使用含包装的 32 KiB 上限。保留无效收件人、自发消息、`leader`、plan mode、不支持参数的校验优先级，不把大小检查移到这些更具体的拒绝之前，也不重构整条分支链。

该检查是领域上限，不是安全传输大小的估计。模型直接生成超过它的输入时，通常也会超过 assistant 预算；它恢复领域校验的一致性；但在当前 HEAD 的正常路径中，更早的 transcript 与真实 Hook 预算使超过该上限的原始消息无法到达可恢复拒绝。隔离的直接调用或 stub `Hook.fire` 测试可以证明 guard 与优先级，不能证明生产可达性或端到端恢复。

### 4.2 复用编码 catch

在现有 `HostedToolInputInlineLimitError` catch 中，仅在以下情况转换：已有 `validationError`，或有效调用名为 `workflow`、`send_message`。其他异常类型、其他有效工具沿用现有传播行为，不扩展到所有工具。无需新增 MCP 条件：[HostedMcpSession.toolName](../../../packages/cli/src/serve/hosted-mcp-session.ts#L1026) 只以 `mcp_<32-character digest>` 声明、解析 MCP 工具，因此有效 MCP 工具不可能名为 `send_message`。

使用 `validationError ??=` 保留既有收件人、原始大小、plan mode 等拒绝。新增消息编码超限的文案为：

```text
Hosted send_message exceeds the 65536-byte inline Session Store limit once encoded (byte_limit); shorten the message or other arguments and retry.
```

成员通道的文案写明该通道实际执行的上限。此类消息已通过 32768 字节的成员包装上限，因此编码超限来自转义膨胀，而不是原始消息体积：

```text
Hosted send_message to a member exceeds the 65536-byte inline Session Store limit once encoded (byte_limit) although it fits the 32768-byte member wrapper; shorten escape-dense content and retry.
```

保留现有 `workflow` 文案。`byte_limit` 是函数错误文本中的 token，不是新增响应字段。通过 `convertToFunctionErrorResponse` 保留原函数名和 call ID。

仅给已拒绝 request 赋现有 `UNENCODED_TOOL_INPUT` sentinel。该占位数据不得被发布、作为有效执行证据计算摘要、派发，或用于生成投递记录。当前摘要计算针对规范化 `input`，不针对 sentinel 字节。首次校验拒绝在 capture 前返回；存在 Hook 时禁止后续 capture，reservation 循环也跳过被拒调用。保留这些边界及空输入不可 capture 的限制。

### 4.3 拒绝、批次与重试

- 首次参数准备保持既有整批拒绝：一个消息超限，兄弟调用也不执行。仅在完整记录可容纳时提交原 assistant 与全部配对错误结果。
- `PreToolUse` 改写后，保留既有逐调用拒绝和兄弟调用行为。原 assistant 保持完整，有效超限参数不得到达投递 funnel。
- 被拒绝的成员发送不得产生 `session_command`、队长 `msgc_` 投递或属于该调用的 command-wait 条目。被拒绝的 lineage 发送不得产生 `session_message`；被拒绝的 parent 发送不得产生 continuation `child_run` 或扇出投递。
- 此修复不新增 Broker 执行或 Workspace acquisition。构造时预热、已经运行的 Hook 可能存在；此处“无副作用”指没有消息、命令、continuation 派发，不代表 journal 为空或没有 Hook 活动。
- 将拒绝返回模型。缩短后的新调用使用新的 call ID，沿用既有投递路径。已提交工作的 replay 沿用既有 identity 规则；对投递结果不确定的消息不自动重试。
- assistant/refusal record 超限或持久写失败时，保留既有 Turn failure 或 recovery-required 行为，不把未提交的拒绝报告为恢复成功。

### 4.4 方案理由

encoder 已是精确大小判据。捕获其私有大小异常，可以避免第二套序列化、猜测预留字节及按通道计算阈值。降低固定原始上限会不必要地拒绝可容纳的低转义消息，也无法表达可变元数据；扩大 Store 上限或更改 transcript 存储会跨越本小修复不必触及的协议、持久化边界。

应与 #14118 协调，避免再做一份竞争实现。其按名称扩展 catch 的方式符合已核实的 MCP 命名不变量，足以满足本范围。

## 5. 实现与验证计划

预计唯一生产代码改动为 `packages/cli/src/serve/hosted-workspace-tool-turn.ts`。扩展 command 和 session-message 测试，使用既有 workflow 套件做回归。通过既有 model/Hook 测试接口添加真实 Harness 层用例，验证 transcript 与重试承诺。若实现时变更 H4d-b 的限制、验收措辞，同时更新其中英两版；链接本补充设计，不重写历史架构。

下表是验收计划；第 8 节区分已执行检查与尚未完成的物理栈验收：

| 场景                                                          | 必须具备的判据                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 成员 → 成员及成员 → `"*"`：issue JSON 数组或等效高转义输入    | 断言原始信封可容纳、精确编码超限、完整 assistant 可容纳；得到消息专用 `byte_limit`，保留原名称/ID；无命令、无投递记录。                                                                                                 |
| 成员和普通子 agent → `"parent"`：高转义正文                   | 同样返回可恢复拒绝，无 `session_message`；缩短后重试到达既有路径。                                                                                                                                                      |
| parent/lead → `task_id`、成员名及 `"*"`                       | 编码超限在子 agent 路由、continuation、扇出前拒绝，无新增投递或 child 记录；夹具须通过收件人检查。                                                                                                                      |
| 成员→parent 原始正文检查                                      | 使用直接调用或 stub `Hook.fire` 返回超过 65,536 字节的消息，隔离参数准备；断言原始拒绝优先于编码超限，并验证普通子 agent 一致性。明确该测试绕过生产 Hook 限制。                                                         |
| 真实 Hook 编码超限                                            | 原始 assistant 很小，`updatedInput` 为高转义正文；断言完整原始 Hook 结果和聚合输出各自可容纳于 61,440 字节，但精确工具编码超过 65,536。经真实 `PreToolUse` 验证编码拒绝；超大 Hook 输出仍沿用既有 Hook 错误或阻断行为。 |
| 临界 ASCII，`"x".repeat(65_400)`，成员和普通子 agent → parent | 使用真实完整记录判据，断言 assistant 超限仍使 Turn 失败且不生成消息；不可称为已恢复。                                                                                                                                   |
| UTF-8 与精确边界                                              | 包含中文、emoji、引号、反斜杠、换行、控制字符；真实 encoder 的 `E = 65,536` 可容纳，`E = 65,537` 失败；分别测试 `R`/`W` 等号与端到端记录可容纳性。                                                                      |
| 已有拒绝且编码超限                                            | 保留无效收件人、plan mode、原始大小文案，不覆盖成 workflow/message 编码超限文案。                                                                                                                                       |
| 批次语义                                                      | 首次无效批次为每个调用配对错误、全部不执行；Hook 改写后沿用逐调用拒绝。                                                                                                                                                 |
| 异常与 surface 隔离                                           | workflow 保留原拒绝；其他有效工具大小异常仍抛出；不相关 encoder/Store 异常仍传播；MCP 名称保留已核实的 `mcp_` 命名空间，不进入新增 catch 豁免。                                                                         |
| 持久恢复                                                      | assistant 与配对结果可持久化并重载；脚本模型收到拒绝后发出较短调用，在同一个 Turn 完成；记录写失败不得算恢复。                                                                                                          |

不能只依赖 command/session-message 测试当前的 `messageFitsInline = () => true`，它无法证明真实 transcript 可容纳。直接 `execute` 测试可隔离编码和分支逻辑，但同 Turn 重试承诺必须经过实际 model loop 与 Harness 注入的生产 ChatRecord 大小判定。不得在测试内抄一份简化 ChatRecord 就当作生产判据；复用既有测试接口，不为测试单独新增公共 serializer API。

实现前，若全局 `qwen` 可访问 Hosted 路径，先记录基线行为，将版本、环境写到 `.qwen/e2e-tests/`；仅 CLI 启动不算复现。先运行失败用例，再修复，并从 `packages/cli` 重跑：

```bash
npx vitest run src/serve/hosted-workspace-tool-turn.commands.test.ts src/serve/hosted-workspace-tool-turn.session-message.test.ts src/serve/hosted-workspace-tool-turn.workflow-child.test.ts
```

从该包运行选定的 Harness 回归文件，再于仓库根目录运行 `npm run build && npm run typecheck`。物理验收复用既有打包 Hosted 栈：真实 server、MySQL、Broker、Harness，仅模型脚本化；断言发送方 Turn 完成、配对拒绝、被拒调用无 outbox、短消息重试仅投递一次。若需要变更 Java 测试，遵循 server 的局部 AGENTS.md。macOS 遇到仅 Linux 支持的 runtime 边界不能算通过，应明确记录未运行项。本小修复不需要新增故障门禁轮次。

两个区分性检查必须直接失败，而非只等超时：恢复旧 catch 应使高转义用例抛错；单独移除成员-parent guard，应使明确使用 stub 或直接调用的 guard 测试丢失指定原始拒绝；该测试绕过真实 Hook 资源限制，不能作为生产恢复证据。基线与修复后均须确认临界 ASCII Turn 失败；编码恢复后，回归还须明确断言 assistant-record guard，不能接受任意不相关的 Turn 失败。

## 6. 验收、风险与 review 问题

只有满足以下条件，才能接受有边界的实现：

1. 在所有 transcript 预算可容纳时，各范围内原生通道均返回持久、消息专用的编码拒绝，脚本模型缩短重试后在同一个 Turn 完成。
2. 成员→parent 与普通子 agent 一样具有 65,536 字节原始正文检查；既有 32 KiB 成员信封、收件人、plan-mode 校验优先级不变。
3. 被拒调用不产生 message、command、扇出、continuation 记录；首次批次及 Hook 后行为符合前文。
4. workflow、其他工具和异常行为不变，不改 Store/协议常量或公共工具声明。
5. 真实记录测试暴露临界 ASCII 残留，验证证据区分直接测试、真实 Harness 执行与真实栈验收。完成两轮干净自审与独立审查后，才能声称实现完成。

主要风险是宽松 transcript mock 造成虚假恢复、catch 范围意外扩大、覆盖具体错误，以及 sentinel 逃出拒绝路径。精确编码边界测试、真实 Harness 覆盖和两次参数准备路径审查用于约束这些风险。

用户已接受本有边界实现。完整关闭 #14062 时，仍需维护者决定 assistant-record 恢复要求；若要求该恢复，应保留 issue OPEN 并另行设计 transcript 持久化，不能暗中缩小验收标准。本文不提出能力启用或部署开关变更。

## 7. 审计记录

一个独立 Sub Agent 对照固定版本源码和实时 issue/PR 证据审计了中英两版。初审发现一项 P2 设计准确性问题、三项 P3 建议，已全部纳入修订：

- D1：移除不可能通过真实 Hook 到达的原始超限恢复承诺，补充更早的 60 KiB Hook 预算，区分隔离 raw-guard 测试与真实 Hook 编码超限验证。
- S1：核实工具名称生成不变量后，移除多余 MCP guard，保留最小的名称 catch 扩展。
- S2：修正原始正文或信封、编码输入、transcript 预算之间的关系表述。
- S3：将源码锚点调整到实际相关符号。

审计报告保留在本地 `.qwen/pr-reviews/issue-14062-design-audit.md`（git-ignored）。独立复核：已完成，D1、S1–S3 均已闭环，无未处理审计发现，也未发现新的实质问题。用户随后授权实施有边界修复，第 8 节记录其证据与完整 issue 的剩余边界。

## 8. 实现证据（2026-10-19）

工作区仅实施第 4 节的两个生产代码改动：成员→parent 的原始正文检查，以及窄范围的 `send_message` 编码超限拒绝。Store 上限、公共声明、schema、relay 行为不变。

- 独立测试工程师在源码修改前复现五项基线失败，并先实际尝试全局 `qwen` 0.23.3。其普通 CLI 返回 `Tool "send_message" not found in registry`，未到达 Hosted 工具，不能算 Hosted 验收。
- command、session-message、workflow 套件共 102 项通过，覆盖成员、广播、parent 通道、UTF-8 原始限制、65,536 与 65,537 字节精确编码边界、首次批次拒绝、收件人错误优先级、拒绝写入失败，以及普通工具超限行为不变。成员通道被告知的是自身的 32768 字节包装上限，而非 Store 上限。宽松 transcript 判据下的直接调用测试仍仅作为 guard/encoder 的隔离证据。
- 完整 Harness 套件共 611 项通过，其中七项新增回归使用实际模型循环、本地 OpenAI-compatible 脚本端点、生产 ChatRecord 大小判定及 HTTP resource-store inline 检查。原有五项覆盖成员与普通子 agent 发往 `parent`、两项 assistant record 场景，以及真实 Hook 改写；新增两项覆盖成员→`bob` 与成员→`*`（广播）的命令通道恢复。成员、命令通道与普通子 agent 的高转义消息可在同一 prompt 内拒绝后缩短重试；真实 `HostedHookSession` 先处理、持久化脚本化 worker 结果，再让改写消息获得拒绝并缩短。两项 65,400 字节 ASCII 场景仍在 assistant record 处失败，不产生消息记录。
- 上述 Harness 测试使用本地 journal/resources，并 mock Broker/worker 访问。一条本地排队的 `session_message` 不代表远端收件人已收到。真实 managed-agent-server/MySQL/Broker/Harness/worker 验收尚未执行：Docker 已安装，但 daemon 不可用。
- `npm run build`、`npm run bundle`、完整 workspace/integration `npm run typecheck`、针对性 ESLint、Prettier 及引用检查均通过。两项源码变异均被直接识别，固定源码按字节恢复。独立修复后验证通过原始五项复现及 24 项选定验收/正常路径用例。独立代码审查的两项建议已纳入，无未处理发现。本地报告及 E2E 计划位于 `.qwen/issues/issue-14062.md` 与 `.qwen/e2e-tests/issue-14062/`；代码审查记录位于 `.qwen/pr-reviews/issue-14062-implementation-review.md`。

可以按有边界修复 review 本实现；不能把超大 assistant record 或未执行的物理验收算作已修复、已验证。
