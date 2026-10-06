# Managed AgentDefinition 生效（Stage D8b 与 D8c）

[English](2026-10-07-managed-agent-definition-execution.md) | [简体中文](2026-10-07-managed-agent-definition-execution.zh-CN.md)

状态：方案；第 7 节的决策待评审
日期：2026-10-07
Issue：[#12867](https://github.com/QwenLM/qwen-code/issues/12867)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
基于：[AgentDefinition revision（D8a）](2026-10-01-managed-agent-definitions.zh-CN.md)
基线：`main` @ `ac497aeed9`，OpenAPI 1.33.0

## 1. 问题

D8a 在 `/v1/agents` 下存储不可变的定义 revision，但没有任何会话使用它们：

- **准入不使用定义。** 创建会话时，`agent_revision` 写入的是部署配置
  `QWEN_MANAGED_AGENT_REVISION`（默认 `1`），请求其他 revision 一律返回
  `400 unsupported_feature`（`ManagedAgentStore.java:370-375`）。
- **`qwen-code` 写死在三处：** 会话准入（`ManagedAgentStore.java:266`）、
  Workspace 执行授权（`WorkspaceExecutionStore.java:67,98`），以及绑定会话
  后续 Turn 的准入（`ManagedAgentService.java:871`）。
- **Harness 没有 revision 的概念。** Java 发给 Hosted Harness 的
  `POST /session` 只带 `approvalMode`、`approvalTimeoutMs`、`toolProfile` 和
  Session Store 描述（`QwenHostedHarnessConnector.java:322-345`）。模型、
  system prompt、cwd、sampling 和轮次预算都来自 Harness 进程：每个 Turn 用
  `loadSettings(cwd, {skipWorkspaceSettings, workspaceTrusted: false})` 与
  `loadCliConfig` 加载（`hosted-harness-model.ts:82-104`）。
- **已有两项按会话固定的配置。**
  - **审批模式：** `managed_agent_session.approval_mode`（V24）。取自部署
    配置 `QWEN_MANAGED_AGENT_APPROVAL_MODE`（默认 `yolo`），只为绑定会话
    写入。
  - **工具 profile：** `managed_agent_session.tool_profile`（V35）。绑定会话
    固定写入 `hosted-workspace-files/1`（`ManagedAgentStore.java:409`）。
  - Harness 把这两项记录在不可变的 `managed-definition` 资源中
    （`hosted-harness-session.ts:1704-1727`），每次 load 时比对，不一致则返回
    `409 hosted_tool_profile_conflict`。

## 2. 上游设计的约束

[code_agent 设计][upstream]（v1.13，固定在 `6891216`）确定了以下规则，本设计
沿用：

1. **会话固定 revision，不漂移。** 创建时固定 `agentRevision`；新的
   revision 不会改变已有会话。升级定义需要新建会话，不支持热切换。
2. **"最新版本"只在会话创建前解析一次。**
3. **不静默丢弃配置。** 定义要求的能力无法运行时，准入直接拒绝；不能去掉这部分
   配置照常运行，再宣称兼容。
4. **凭据不进定义。** 模型凭据只在 Harness 内通过既有的凭据引用解析。
5. **核验摘要。** Harness 核对装载的 revision 和 digest，不一致就拒绝运行。

上游描述了一个可信发布步骤，把 `AgentBundle` 写入共享目录。本设计不增加独立的
发布服务：D8a 的 revision 本身已经不可变、按摘要寻址，存储一个 revision 就等于
发布它（第 7 节决策 1）。

## 3. 目标

- **D8b：** 新会话可以选择已存储的定义，并固定 `(agent_id, revision, digest)`。
  省略 revision 时在准入时解析为最新版本，重放不会再次解析。
- **D8c-1：** `permission_policy` 和 `tools` 通过现有的两项按会话固定配置生效。
  只改 Java。
- **D8c-2：** `model` 和 `instructions` 生效。Harness 增加按会话覆盖模型和追加
  指令段的能力，并在 load 时核验摘要。
- **不静默丢弃：** 定义中有无法生效的内容时，准入拒绝并指出字段。

## 4. 非目标

- 独立的发布步骤、默认 revision 指针，以及定义的列表和删除（与 D8a 相同）。
- 让 `skills` 和 `mcp_servers` 生效，这属于 Stage H。在此之前，非空值会被拒绝
  准入。
- 让 `environment_template_id` 生效，这属于 Environment 与 Runtime 模板。非 null
  值会被拒绝准入。
- 切换已有会话的定义。
- 契约第 10 节的 reader、operator 与 owner 角色矩阵。
- 改变内置 `qwen-code` agent 的任何行为。

## 5. 设计

### 5.1 两类 agent

|                        | `qwen-code`（内置）                | 已存储的定义（`agent_<32 位十六进制>`）       |
| ---------------------- | ---------------------------------- | --------------------------------------------- |
| 来源                   | 部署配置，没有存储行               | D8a 的 `managed_agent_definition`             |
| revision               | 仍为 `QWEN_MANAGED_AGENT_REVISION` | 准入时解析：显式指定，或最新版本              |
| digest                 | 无（`NULL`）                       | 所固定 revision 的 `digest`                   |
| 审批模式与工具 profile | 不变（部署默认值、`files/1`）      | 由定义编译得到（5.3）                         |
| 模型与 instructions    | Harness 进程配置                   | D8c-2 之前为部署默认值（5.3），之后由定义决定 |

`qwen-code` 不做成种子定义。种子定义需要为每个租户插入一行，而它的行为由部署
配置决定，存储的副本可能与实际运行的行为不一致。三处
`"qwen-code".equals(...)` 改为"会话是 `qwen-code`，或固定了一个可执行的定义"。

### 5.2 会话准入（D8b）

现有的创建事务增加以下步骤：

1. **解析 revision。** `qwen-code` 保持现有路径。其他情况：
   - 显式给出 `agent_revision` 时读取该行；
   - 省略时在会话插入的同一事务中，用 `SELECT … FOR SHARE` 读取该 agent 的
     最新一行，避免与并发更新交错；
   - agent 或 revision 不存在时返回 `404 agent_not_found`。创建路由已声明
     `404`，补上其描述。
2. **按 5.3 的规则编译执行配置。** 无法生效的内容返回
   `409 agent_definition_unsupported`，字段写在 `details.field` 中。
3. **写入** `agent_id`、`agent_revision`（十进制字符串）和新增列
   `agent_definition_digest CHAR(64) NULL`，`approval_mode` 与 `tool_profile`
   取编译结果。
4. **请求摘要与重放。**
   - 请求摘要保持现有规则：只有调用方显式传入时，`agentRevision` 才计入。
   - 重放经由创建回执返回原会话，不会再次解析最新版本。现有回执已保证这一点；
     增加一个测试锁定：在两次重试之间发布 revision 2，重放仍返回 revision 1。
5. **公开字段。** `PublicSession.agent_revision` 已存在；新增可选字段
   `agent_digest`，便于调用方核对固定的版本。契约升一个小版本。

revision 不可变，也没有删除路由，所以被固定的 revision 在恢复和 load 时始终
可读。将来如果增加删除，必须先处理仍被会话固定的 revision。

### 5.3 字段规则（v1）

D8a 把 `model`、`permission_policy` 和 `tools` 的元素作为开放对象存储，不做
校验。本设计不改动 D8a 的存储，只在准入时编译：已存储的定义仍然有效，不支持的
内容在用它创建会话时给出明确错误。

| 字段                      | v1 接受的形状                                                                                                | 效果                                                                                                                  | 阶段    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------- |
| `permission_policy`       | `{}`（部署默认值），或 `{"approval_mode": "default" \| "auto-edit" \| "yolo", "approval_timeout_ms"?: 整数}` | 写入 `approval_mode`。超时不得超过部署的 `QWEN_MANAGED_AGENT_APPROVAL_TIMEOUT`，省略时取该值。`plan` 与其他键一律拒绝 | D8c-1   |
| `tools`                   | `[]`，或恰好一项 `{"type": "hosted_profile", "profile": "<id>"}`                                             | 写入 `tool_profile`。绑定会话需要一项；未绑定会话必须为 `[]`（仅模型）                                                | D8c-1   |
| `model`                   | D8c-1：只接受 `{}`（部署默认值）。D8c-2：`{}` 或 `{"id": "<模型 id>"}`                                       | D8c-2 在 Harness 中按会话覆盖                                                                                         | D8c-2   |
| `instructions`            | D8c-1：只接受 `""`。D8c-2：不超过 64 KiB 的 UTF-8                                                            | D8c-2 作为 agent 指令段追加（5.5）                                                                                    | D8c-2   |
| `skills`、`mcp_servers`   | 省略、`null` 或 `[]`                                                                                         | 无；非空则拒绝                                                                                                        | Stage H |
| `environment_template_id` | 省略或 `null`                                                                                                | 无；非 null 则拒绝                                                                                                    | 以后    |
| `metadata`                | 任意                                                                                                         | 不影响执行                                                                                                            | —       |

**可选择的 profile 由部署白名单决定**，即
`QWEN_MANAGED_AGENT_DEFINITION_TOOL_PROFILES`，默认
`hosted-workspace-files/1,hosted-workspace-files/2`。

- **`shell/1` 与 `shell/2`** 等待公开前台 Shell 准入（#13271），且必须搭配
  `default` 审批模式，见下文。
- **`mcp/1`** 等待 Stage H。

**组合规则**，不满足时均返回 `409 agent_definition_unsupported`：

- Shell profile 不能搭配 `yolo`。这是 #13271 的强制询问门槛，在白名单开放
  Shell 之前先写进规则。
- `files/2`（glob）要求部署已启用对应的 worker，沿用 #13166 的协同发布要求；
  Java 检查同一个开关。
- 未绑定会话不能选择 profile。

### 5.4 D8c-1：只改 Java

审批模式和工具 profile 已经在 create 和 load 时下发给 Harness，并由它固定和
核验。因此 D8c-1 只需要：

- 准入时写入编译结果，替换写死的 `files/1` 和部署默认审批模式；
- 把后续 Turn 准入和 Workspace 执行授权中的 `qwen-code` 判断，改为
  "`qwen-code`，或固定了已编译的定义"；
- 让 `maySubmitShape` 等判断读取会话的列，而不是假定某个 profile。

Harness、Runtime Broker 和 WebShell 都不变。WebShell 已能显示审批卡片
（#13107），由 `default` 审批的定义创建的会话会通过它询问。

### 5.5 D8c-2：模型与 instructions（Java 与 Harness）

- **下发。** Java 在 create 时的 `POST /session` 中增加可选对象
  `agentDefinition`：`{agentId, revision, digest, model?: {id},
instructionsRef?}`。
  - instructions 不放在请求体中。Java 把它发布为按摘要寻址的 Session Store
    资源（`managed-agent-instructions`），只发送引用。
  - load 只发送 `{agentId, revision, digest}`。
- **Harness 固定。** create 时 Harness 把 `agentDefinition` 记录在
  `managed-definition` 资源中，与 `toolProfile`、`approvalMode` 放在一起。
  load 时比对摘要，不一致则返回 `409 hosted_agent_definition_conflict`，处理
  方式与 `hosted_tool_profile_conflict` 相同。
- **应用。**
  - **模型：** 每个 Turn 的 `loadCliConfig` 之后，用固定的 `model.id` 覆盖
    模型选择。它必须是部署已配置的模型（存在于 `modelProviders` 且凭据可解析）；
    否则该 Turn 以 `model_unavailable` 失败，不执行任何内容。为了让准入能提前
    拒绝，Java 维护白名单 `QWEN_MANAGED_AGENT_DEFINITION_MODELS`，由部署保证与
    Harness 一致。
  - **instructions：** 作为单独一段，放在核心系统指令之后、项目上下文
    （#13168 的 QWEN.md 与 AGENTS.md）之前。它不替换核心指令，因为工具使用与
    安全规则都在核心指令里。
- **不下发：** 凭据、sampling 参数和轮次预算。在增加对应字段之前，它们仍由部署
  决定。

### 5.6 契约变更

- 创建：补充 `404 agent_not_found` 和 `409 agent_definition_unsupported` 的
  描述，并把 `agent_revision` 描述为"省略时在准入时解析为最新 revision 并固定"。
- `PublicSession` 增加可选字段 `agent_digest`。
- 不收紧 `AgentDefinitionRequest`，D8a 已存储的 revision 保持有效。v1 的形状
  写在路由描述和本文中。
- WebShell 创建走同一条准入路径（已有 `agentId`），无需单独修改。

## 6. 交付

两个 PR：

1. **PR A，D8b 与 D8c-1（只改 Java）：** 固定版本、编译审批模式与工具 profile、
   拒绝规则、新增列（取合入时 `main` 上下一个空闲的 Flyway 版本号）以及契约
   1.34。之后定义就有了第一批实际效果：选择 `files/2` 与 `default` 审批。
2. **PR B，D8c-2（Java 与 Hosted Harness）：** 模型与 instructions 的下发、
   固定、核验和应用。

D8b 不单独发布。固定一个字段都不生效的定义，就是静默丢弃配置（第 2 节规则 3）。
替代做法只有两种：像现在一样继续拒绝 `qwen-code` 以外的 agent，或者至少让部分
字段生效。

## 7. 待评审的决策

每项先给建议，再写由谁确认。

1. **不设发布步骤；省略 revision 即最新版本。** 已存储的 revision 立即可用。
   以后可以为灰度发布增加默认 revision 指针，不影响已固定的会话。→ wenshao
2. **D8b 与 D8c-1 放在同一个 PR**，不单独发布（第 6 节）。→ wenshao
3. **`qwen-code` 保持内置**，不做成种子定义。→ wenshao
4. **字段顺序：** 先 `permission_policy` 和 `tools`（只改 Java），再 `model` 和
   `instructions`；`skills` 和 `mcp_servers` 随 Stage H。→ wenshao
5. **`tools` 选择一个冻结的 profile**，而不是列出单个工具；profile 受部署白名单
   限制，Shell 必须使用询问模式。→ doudouOUC（工具 profile），并与
   DragonnZhang 的 #13271 对齐
6. **instructions 的位置：** 在核心系统指令之后、项目上下文之前，不替换核心指令，
   上限 64 KiB。→ wenshao
7. **D8c-2 Harness 部分的归属：** 由 yiliang114 实现，doudouOUC review profile
   与定义资源的改动。→ doudouOUC

## 8. 验证

- **Java 单元与契约测试：**
  - 省略 revision 与显式指定 revision；
  - 两次重试之间发布新 revision，重放返回原 revision；
  - 并发更新下不会读到部分更新的状态；
  - 拒绝矩阵：每个字段的每种不支持形状，以及组合规则；
  - 跨租户返回 `404`；
  - `qwen-code` 路径不变。
- **Harness 单元测试（PR B）：**
  - create 固定 `agentDefinition`；
  - load 时摘要不一致返回 `409`；
  - 模型覆盖生效，未配置的模型 fail closed；
  - instructions 出现在系统指令的正确位置。
- **真实环境验收**，沿用 #13101 和 #13107 的验证方法：
  - 运行 MySQL、Java、Hosted Harness 与 Chromium；
  - 存储一个 `files/2` + `default` 的定义，并用它创建绑定会话；
  - 确认 glob 可用，写文件时出现审批卡片；
  - 存储 revision 2 并改为 `yolo`：旧会话仍然询问，新会话不再询问；
  - PR B 再增加模型切换与 instructions 生效的验证。

## 9. 风险

- **Java 的模型白名单与 Harness 配置不一致：** 准入成功而 Turn 失败。fail closed
  加明确错误码兜底，部署文档写明两份列表必须一致。
- **默认审批模式是 `yolo`：** 定义写 `{}` 会继承它。这符合"部署默认值"的含义，
  但文档必须写明，生产部署应把默认值改为 `default`。
- **D8a 下存储的 revision 可能使用 v1 不支持的形状：** 用它们创建会话会被拒绝。
  这是有意为之（不静默丢弃），错误会指出字段。

[upstream]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-java-hosted-runtime.md
