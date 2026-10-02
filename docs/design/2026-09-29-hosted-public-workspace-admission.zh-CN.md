# Hosted 会话的公开 Workspace 准入（G0）

[English](2026-09-29-hosted-public-workspace-admission.md) | [简体中文](2026-09-29-hosted-public-workspace-admission.zh-CN.md)

状态：已实现，审计中。属于 #12952 与 #12380。

## 问题与范围

Hosted Read/Write/Edit 已能经过生产 Broker 和 worker 执行，但目前只有私有集成测试把它接到持久 Workspace 会话。公开创建在 service 和 SQL store 两层拒绝初始输入；coordinator 也拒绝有绑定的会话。Java connector 不传工具 profile，所有 Session Store 连接均使用部署的全局 Workspace。

G0 开放随创建会话准入的一次初始文件工具轮次，使用现有公开 REST 路由及共享 service 的 WebShell 创建适配器。发现接口仍仅广播 Workspace 绑定能力，不宣称完整的 Workspace 执行支持。G0 本身无需修改 UI；后续改动唯一的 UI 变化是为创建者开放输入框与取消控件。

后续改动在同一开关下为会话创建者开放后续 Turn，并允许创建者取消正在运行的 Turn，由 Hosted Harness 中止该 Turn 并按原始 Runtime 身份结算。执行时每个 Turn 都按创建者的 Workspace 授权校验，因此其他 actor 以及未开启该开关的部署仍得到现有拒绝：actor 可读取该 Workspace 时为 `workspace_unavailable`，不能读取时为 `session_not_found`。创建者也可以重命名该会话。工作区关闭通过独立的关闭能力及生命周期准入控制；归档、删除与取消归档遵循可靠工作区关闭后的独立保留能力；cwd 操作仍保持门禁。

## 决策

- 部署显式启用 `harness.workspace-files-enabled`（环境变量 `QWEN_MANAGED_AGENT_WORKSPACE_FILES_ENABLED`），默认关闭。它要求 Hosted Harness、HTTP Session Store，以及同机、会话隔离的 local-process Broker。原有无绑定的无工具会话行为不变。关闭开关后拒绝携带输入的创建请求（包括重试）；空输入的绑定会话创建和读取保持可用。
- 仅接受 `qwen-code` 及现已支持并冻结的 `managed-runtime-tools/1` / `preapproved-workspace-tools/1` Workspace 配置组合。服务端选择 `hosted-workspace-files/1`。公开请求不能选择 profile，也不能通过 metadata 提升权限。
- Workspace 解析、ACTIVE 状态、创建者读取/创建权限、固定 profile 校验、会话创建、初始 Turn 和 actor 范围的幂等继续位于现有创建事务内。重试保留原身份与绑定；载荷改变产生冲突。
- 连接有绑定的会话之前，connector 通过 `WorkspaceExecutionStore.authorize` 重新检查持久绑定。Broker 获取与执行仍保留各自的权限、代数、存储和所有权检查。任何绑定失败都不能回退到全局 Workspace 或无绑定的无工具会话。
- 私有 create 与 load 都传递所选 profile 及持久 Workspace ID，包括创建冲突和创建结果不明后回退到 load 的路径。Harness 现有的不可变 definition 检查固定 profile。
- 冷加载未结算输入仍被阻塞。G0 不启用在飞续接、接管 worker、取消 owner 粘性，也不改动 G1 failover 门禁。

- 取消运行中的 Turn 复用已准入的 Harness 连接，并由当前租约 owner 重试，不根据重新连接的拒绝伪造终态失败。已记录的重命名失败保留 `FAILED` 命令回执与摘要；相同内容重试仍是重放，不同内容继续冲突，并发成功请求仍可完成该回执。

## 改动与归属

| 层                            | 改动                                            | 作用域                        |
| ----------------------------- | ----------------------------------------------- | ----------------------------- |
| Java 配置                     | 文件准入的显式开关及依赖验证                    | 部署                          |
| 创建 service 与 SQL store     | 仅在固定且获授权的 Workspace 配置下接受初始输入 | 租户、创建者及持久 Workspace  |
| Coordinator                   | 仅在开关启用时派发已准入的绑定轮次              | 持久会话及持有租约的 Turn     |
| Java connector 与私有 SDK DTO | 解析会话绑定，create/load 传递 profile          | 持久会话及存活 Harness owner  |
| 现有 Broker/worker            | 复用生产路由与 fencing                          | 所选 Runtime 及持久 Workspace |
| 契约与 README                 | 记录有限的创建能力及剩余门禁                    | 公开 REST 与 WebShell 适配器  |

生产行为在 `packages/sdk-java/managed-agent-server`、`packages/sdk-java/qwencode` 的私有 Hosted DTO，以及 WebShell 托管会话页及其 provider（`packages/web-shell`）中变化，覆盖初始 Workspace Read/Write/Edit Turn 与创建者后续 Turn 的提交、取消和重命名准入。不需要为 core authority、工具执行循环、数据库 schema 或公开请求字段新增抽象。

合入的改动还涉及该范围之外的两处，均不增加运行时行为：

- **Runtime Broker 故障门禁。** `DurableLocalRuntimeFaultGateTest` 在故障代理中扣住 worker 的 `execute` 响应，使第一个 Broker 在被终止前无法记录结果。随后替换 Broker 的 `acquire` 通过 #12964 的接管对账结算该调用，测试断言这一结果（`ALREADY_SETTLED`，且只有一次物理执行），而不再同时接受取决于时序的已结算或已解决两种状态。
- **Core resume 测试。** `background-agent-resume.test.ts` 的一个用例把 Skill 工具报告为已注册，使其列表断言不会空洞通过。该覆盖目前仍在 `main` 上。

## 验证与验收

使用确定性的本地模型和打包 CLI，运行真实 Spring coordinator、SQL Store、按部署配置启动的生产 Broker 及独立 worker。仅模型和可信网关 principal 使用测试夹具。Workspace registry 和 grants 作为部署数据预置；会话必须通过公开 HTTP 创建。

初始轮次必须在所选 Workspace 的相对 cwd 下写、编辑并读取文件，产生持久工具历史和恰好一个公开终态事件，且不改动 Harness 的诱饵目录。重复创建幂等键，验证相同 Session/Turn 且无额外模型/工具副作用。验证改变载荷冲突、未授权租户/actor 无法创建或读取、不支持的 profile 与不可用 Workspace 被拒绝，以及关闭开关后保持原门禁。覆盖共享 WebShell 创建适配器、实际发生变化的后续操作门禁（创建者的后续 Turn 提交、取消与重命名被放行；关闭与保留操作遵循独立能力，cwd 操作仍受限）和无绑定无工具回归路径。

SDK 序列化、connector、store/准入及 coordinator 的定向测试覆盖 create/load 身份、权限复核与关闭的门禁。本地通过 H2 跑 Hosted 集成，并加入现有 Hosted MySQL CI 套件；单独记录本地 MySQL 是否可用。完成前执行 build、typecheck、bundle、定向测试和两轮无发现的完整 diff 自查。

## 边界与待定事项

本次实现把 G0 放在 #12952 下；以后调整到 D 或 W 跟踪不改变契约，也不决定 G3 的范围。Shell、审批、D8 AgentDefinition、公开 profile 选择、后续 Turn（此后已对创建者开放，见上文）、生命周期开放、分布式供给及 W0e/G1–G3 恢复均另行推进。现有 `EmbeddedRuntimeBroker` 是生产组件，可以继续使用；E2E 不得替换它或通过直接调用 store 绕过准入。
