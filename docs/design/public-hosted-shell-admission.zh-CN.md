# Hosted Workspace Session 公开前台 Shell 准入

[English](public-hosted-shell-admission.md) | [简体中文](public-hosted-shell-admission.zh-CN.md)

## 状态与问题

本设计实现 #13271，基于 main bb66a52c。Harness 已支持持久化
`hosted-workspace-shell/1` 与 Shell 强制审批，但公开 REST 和 WebShell
创建仍固定使用 `hosted-workspace-files/1`，无法进入前台 Shell 路径。
本次通过部署准入开放已有能力，不完成 G3 Step 3 或 Shell L4。

## 范围与决策

部署开关 `qwen.managed-agent.harness.workspace-shell-enabled`
（`QWEN_MANAGED_AGENT_WORKSPACE_SHELL_ENABLED`）默认 false。启用时要求
Workspace files 已开启，并满足其已有可信 local-process、Session 隔离 Broker、
挂载、Session Store 与 Harness 条件。审批模式必须为 `default` 或 `auto-edit`；
`yolo`、缺失、空白及未知模式在启动时拒绝。每个 Session 持久化同一强制审批模式。

开关开启时，新的 Workspace Session（空创建和带输入创建）固定使用
`hosted-workspace-shell/1`，否则使用 files/1。非绑定 Session 与既有 files
Session 行为不变。不添加调用者 profile 选择、metadata 覆盖、数据库迁移、公开
/2 搜索 profile、后台 Shell、Monitor 或新凭证机制。

已有 Shell/1 工具声明含 Monitor，但公开创建不配置 capture bytes 或 H3 publication
通道。既有准入在审批和 Broker 执行前拒绝 Monitor 与后台命令。真实公开测试主动
尝试两种请求并断言零副作用；私有 H3 工具族保持不变。

## 准入与持久化

profile 与审批模式写入已有创建事务。它们是服务端决策，不纳入客户端请求摘要。
部署开关变化后，创建重放仍返回原 Session。

从 main fbde5cf0 合入的 V53 actor-role 存储在同一事务中，将 Session 的 creator
与 owner 初始化为同一已认证 actor key，Shell 和 files 创建均如此。选择 Shell
profile 时保留两个身份列和上游基于 role 的授权；本切片不增加交接或角色管理操作。

关闭 Shell 后，既有 Shell Session 的新 Turn 返回 `409 workspace_unavailable`。
先执行授权，再进行 Service 重放探测；持有 Session 行锁的 Store 也先探测旧命令，
再执行 Shell 新准入门禁。原幂等键可以重放，不接受新工作，Store 为最终准入权威。
仅关闭 Shell 开关时，只要 Workspace files 仍开启且持久化审批仍为 `default` 或
`auto-edit`，已接受回合的审批、取消与收尾仍可运行。files-off 或无效审批可以拒绝
attachment，共用 Connector 不绕过这些守卫。W2 cwd 变更不执行 Shell，保留其已有
files、actor、路径及 context revision 准入；Shell 开关不代表整个 Session 冻结。

## 持久化审批与恢复

返回缓存 attachment 或发出 create/load/recovery 请求前，Connector 检查持久化
Shell profile 的审批模式为 `default` 或 `auto-edit`。无效模式不得静默成为 YOLO。
Harness 确认值仍须匹配存储值。已有 files 的 YOLO 行为不变。助手同时识别既有
Shell /2 记录，但公开创建只生成 /1。

恢复复用当前 G3：普通 owner 重新 attachment 保持 requested 审批，持久化
allow/deny 继续有效。恢复可在 `model_start` 或 `shell_in_flight` 按既有原因拒绝；
不得自动重复 Shell，也不得未经验证清除物理 Workspace fence。本次不承诺完整
owner takeover。

## 能力与生命周期

增加可选公开字段 `foreground_shell` 与 WebShell 字段 `foregroundShell`。
files 和非绑定响应省略该字段，schema 不设置默认值。持久化 Shell Session 仅在强制审批及部署准入有效时
返回 true，禁用时返回 false。显式 false 让客户端区分既有 Shell 与 files Session，
无需开放 profile 选择。`workspaceTurns` 继续表达已有 creator/grant 权限；关闭
Shell 准入时仍可为 true，不能单独证明 Turn 可提交。Shell 新发送还要求
`foregroundShell=true`。仅关闭 Shell 时，满足上述前提的已接受取消仍受支持；
files-off 或无效审批导致的 false 不保证取消可用。`actions` 能力同样不覆盖 attachment
或响应守卫。保留上游与新创建授权分开的 creator-only
取消规则，其独立缓存 attachment 路径执行同一持久化 Shell 审批校验。旧客户端由事务内门禁保护。

Shell 的 close、archive、unarchive、delete 能力均为 false。新的后端生命周期请求
在创建 operation 或 command 前拒绝，包含人工构造的 CLOSED/ARCHIVED Shell
记录。既有命令重放保留原结果。非 Shell 生命周期声明与 L2 行为不变，不据此证明
files/2 的 L3 支持。Turn 取消与 Session 生命周期分开，保留其授权、attachment 和
恢复守卫。

## 分层改动

| 组件                                      | 改动                                               |
| ----------------------------------------- | -------------------------------------------------- |
| ManagedAgentProperties 与 application.yml | 默认关闭开关与启动前提                             |
| ManagedAgentStore / AgentStateStore       | 创建 profile、新 Turn 门禁、生命周期排除及开关读取 |
| ManagedAgentService                       | 按持久化 profile 投影能力及排除 Shell 生命周期     |
| QwenHostedHarnessConnector                | 缓存或 RPC 前强制审批检查                          |
| ApiModels / OpenAPI / 生成 WebShell API   | 可选 Shell 能力字段                                |
| Java WebShell provider                    | 区分新发送与既有取消                               |
| 单元与 Hosted 公开集成测试                | 准入、重放、审批、生命周期与真实进程覆盖           |

## 验证与验收

配置测试覆盖默认关闭、缺失前提及所有审批模式。SQL 准入测试覆盖两个表面、空/带
输入创建、metadata/profile 冻结、开关变化、重放、新请求拒绝、ACL 及零生命周期
operation。两种审批模式下的空/带输入 Shell 创建，以及关开关后的 files 创建，
均须在 creator 和 owner 两列持久化精确 actor key。Connector 覆盖 create/load/缓存/recovery 的校验，无效模式的 Harness
调用为零，并保留 files YOLO 对照。WebShell adapter 证明禁用发送仍可取消活动回合。
两种 wire 响应断言关 Shell 时显式 false，files 和非绑定时省略字段。生命周期负例
先取得 files 成功关闭回执并提供支持关闭的 Runtime，再将持久化 profile 改为 Shell，
避免因 Runtime 不可用而使遗漏 Shell 排除的错误仍通过测试。Connector 覆盖关 Shell
时冷和缓存 attachment 的审批响应，无效持久化审批在任何 Harness 调用前拒绝。
取消测试断言持久化 CANCELLING 状态及 coordinator 派发。绑定 Shell/default 的
Session 在 files 开启、Shell 关闭时，requested Action 必须提交匹配的 decision
receipt、完成 response operation，并在丢失响应后跨表面重放且仅一次 delivery。
该 H2/MockMvc 测试模拟 Harness 决策，不证明真实 Shell 执行或完整部署重启。

真实 Java/Broker/Session Store/Harness 测试须证明公开 Shell Allow 仅一次副作用、
Deny 零副作用、丢失响应与重试不重复执行。冷 attachment 保持 profile 和审批。
FG6f publisher/receipt 故障要求真实 worker 与 SQL 证据；macOS 替代和 H2 不证明
Linux 物理静默。完成前执行 build、bundle、typecheck、定向包测试、Java 打包和
Checkstyle、两轮干净自审及独立审查。结果记录于
`.qwen/e2e-tests/public-hosted-shell-admission.md`。

历史提交 `9c5e2817` 合入 main bb66a52c 后验证通过 181 项定向 Java 测试、30 项 WebShell adapter 测试、
341 项 CLI Harness/恢复测试与六项真实 MySQL/Broker/Harness 公开集成测试。receipt 事务失败和已提交 receipt 丢失响应
两种场景均保留一次 dispatch、一次副作用，receipt 重试字节一致，capture 资源
完整验证。独立关开关/冷恢复探针验证 Store/Service 准入与实际 Connector，包含
已接受审批/取消及等待 writer 租约自然过期后的新 Harness。该探针不重启完整 Java
部署。Linux publisher/worker-kill 物理门禁仍未验证，发布继续受门禁约束。

## 发布、限制与开放问题

在部署具备 #12904、#13010 和公开 FG6f 证据前保持开关关闭。本功能不修复这些独立
问题，不增加完整 Shell 生命周期，不绕过恢复拒绝。创建 Shell Session 前统一升级
Session 读取端，旧二进制不得把持久化 profile 解释为 files。本切片的实现选择已确定，
公开契约与发布顺序仍需维护者审查。缺少物理测试基础设施时明确报告未验证门禁，
不记为通过。

W1c 离线 Workspace 迁移仍只支持 files/1。持久化的 Shell definition 会使其 storage
返回 `migration_profile_unsupported`，因此须在该 storage 创建 Shell Session 前
规划 W1c 迁移。本切片不放宽迁移守卫，也不增加 Shell 迁移支持。
