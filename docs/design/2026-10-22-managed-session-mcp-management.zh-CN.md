# Managed 会话 MCP 管理

[English](2026-10-22-managed-session-mcp-management.md) | [简体中文](2026-10-22-managed-session-mcp-management.zh-CN.md)

状态：设计和实现进行中。与[普通 Workspace 工具和 MCP 组合](2026-10-21-managed-mcp-management-reuse.zh-CN.md)共同完成 [#15079](https://github.com/QwenLM/qwen-code/issues/15079) 的运行期管理范围。

## 问题

Managed 提供已提交的 MCP 目录，但没有公开管理命令。daemon 管理操作自己的 ACP 进程；Managed 调用这些路由会改错执行环境。Hosted 已持久化配置和操作回执，支持重新配置连接，并在关闭时排空。其私有 configure 路由还不能直接成为公开 API：空闲检查不完整，只授权准入时的 server 标识，也没有用户可见的设置修订号。

## 版本与授权策略

保持会话原始 AgentDefinition revision/digest 不变，包括 Skills 和审批策略。显式 MCP 命令创建独立的会话设置修订，因此同一 Workspace 的两个会话可以选择不同 MCP 集合。任何命令都不会自动跟随最新 AgentDefinition 或最新 recipe。

只有具备现有 Workspace 执行权限的 actor 可以管理可见且活动的公开会话。保留创建者执行授权、迁移和准入检查、生命周期互斥、Plan 拒绝、snapshot read-only 空能力，以及原 Runtime 所有权。已提交目录仍使用现有读取授权。管理不能回退到 daemon primary 或本地 Runtime。

新增和编辑从选定 Runtime 按租户和 Workspace 隔离的私有 manifest 中选择精确 server revision/digest。只返回标识、修订、摘要和 transport，不返回命令、参数、环境、URL、header 或凭据。API 不接受未发布的可执行 recipe。发布私有 recipe 仍属于部署管理，Workspace 权限不包含该权限。没有初始 MCP pins 的会话，也可在普通 shell/1 生命周期和 Harness 能力支持时显式选择已发布 server。

## 持久设置与命令

在已注册的配置安装日志域存储有界的会话设置快照，使用 envelope 提供的修订、操作身份和前序引用。闭合的 MCP 内容包含精确 pins 以及 enabled/removed 状态；移除项保留墓碑，使恢复可以授权历史配置记录。上限为 32 个不同的历史 server 身份（包含移除项），其中最多 16 个启用。同一 server 身份在移除后也不能降低定义修订；部署需要重置定义谱系时应发布新身份。准入 pins 对应修订零。兼容没有设置快照的旧日志。

每条命令携带 actor 范围的稳定操作身份和预期设置修订。重试查询原命令，同一身份下内容不同则冲突。并发修订在执行前冲突。先持久化请求设置，再改变物理连接，随后用现有 MCP 配置和释放回执记录完成。原效果不确定时阻止新工作，只向原 owner 对账，不能在另一 Runtime 重放。重启在 release 和 configure 之间中断时也保留原命令身份。历史排空状态只检查该命令持久意图之前已存在的配置，后续启用不会逆转已完成的禁用回执。设置 append 事务在 Plan、Turn 和生命周期变更使用的同一会话锁下重新核对准入。

公开 API 和 WebShell API 提供管理快照、可用已发布 pins、管理命令和命令状态。管理快照区分请求设置、已完成物理配置和过期目录元数据，不能把旧成功目录的修订作为并发令牌。通过能力声明阻止旧 Harness 被误认为支持新命令。

管理只能挂载到当前 Harness 已驻留的会话。重新挂载核对身份并返回原引用，不执行清理、恢复或唤醒派发。Harness 重启后，先通过正常执行流程继续或恢复会话，再打开管理；否则返回 `hosted_mcp_session_load_required`。没有初始输入的新会话可以通过管理创建首份日志，无需提交 Turn。创建冲突和创建结果未知时，只能重新挂载同一驻留会话，不能隐式加载冷日志。命令状态查询绝不创建会话。仅用于恢复清理的挂载也拒绝管理挂载、查询和命令，必须先由显式的普通执行加载升级；管理不能通过该受限挂载初始化扩展或提交设置。控制面将管理专用引用与普通挂载引用分别缓存，管理读取不能证明 Turn 接管或取消恢复已经完成。空会话经管理初始化后，首个普通 Turn 先对该驻留会话执行正常的被动挂载，再发布普通引用；generation 变更与最终 detach/close 清理两类引用。

普通 rewind 通过 MCP owner 获取共享 broker，保持挂载记账与有序释放一致。历史 Hook 回执用于选择原 owner 并完成清理，不能单独证明当前仍持有挂载。MCP 目录查询中的待启动工作只限制对应 Runtime Session，Workspace 排空检查仍统计全局总数。MCP 设置的原子准入拒绝在传输重试后仍表示确定未提交，因为存储先重放已提交的同一命令，再检查准入门禁。

## 操作

| 操作    | 行为                                                          |
| ------- | ------------------------------------------------------------- |
| 新增    | 选择精确已发布 pin 并连接，无需重建会话。                     |
| 编辑    | 显式替换所选 server 的已发布修订，保留其他选择。              |
| 移除    | 排空该 server，保留移除墓碑，其他 server 和普通工具继续运行。 |
| 禁用    | 排空 server，将选中 pin 持久化为禁用。                        |
| 启用    | 重连精确的选中 pin，保留会话和对话。                          |
| Reload  | 重新配置已启用的选中 server，并发布当前目录。                 |
| Restart | 先证明旧连接已排空，再配置替代连接。                          |

活动 Turn、Hook、rewind、生命周期阶段、并发 MCP 命令或未结算原效果存在时，拒绝所有操作。禁用和移除的 server 不进入模型工具声明，也不能执行 resource/prompt。关闭时排空所有保留的物理配置，包括设置变更前的配置，最后只释放一次原共享 owner。普通 Shell、文件历史保留既有所属关系和备份语义。不能通过关闭或重启共享 worker 来重启一个 server。

## Runtime 与界面复用

复用既有 MCP configure/release 协议和操作 grant，只新增有界、按范围隔离的已发布 pin 元数据查询。inventory 不代表连接健康。重启成功必须具备已观察到的释放回执和后续配置回执，刷新目录不能代替。

从 daemon 管理页提取小型 server 卡片、工具 schema 和资源元数据展示组件。daemon 保留 ACP 生命周期、epoch、发现轮询和 OAuth 控制器。Managed 管理页使用自己的 provider 命令和会话设置，不伪造 daemon epoch、连接状态或工具验证结果。界面选择已发布定义，不提供原始可执行 recipe 表单。

使用 Plugin 管理中的 MCP 页签作为 Managed MCP 管理的可见入口，通过既有应用状态接收当前选中的 Managed Session 与 Workspace。移除对话顶部和会话行菜单中重复的 Manage MCP 入口，独立对话视图也不保留该按钮。输入框的 MCP 目录继续绑定当前选中的对话，从 Plugin 管理返回时，通过既有视图可见性范围变化刷新目录。请求范围包含 provider、client、Workspace 和 Session，目标切换时取消请求并丢弃迟到结果；重试保留原目标的操作身份。用户显式重试时先查询原操作，仅在仍 pending 或需要恢复时用相同身份重新提交保存的原命令。查询失败不能触发变更，刷新也不能自动重新提交。provider 具有显式租户和 actor 存储命名空间时，只将未确认命令的公开 pin 元数据和请求身份保存到当前 tab 的 session storage，确认终态后删除；没有该命名空间的 provider 只在内存保留。可执行 recipe 和凭据不能进入浏览器存储。使用共享 WebShell 基础组件和隔离 portal root。资源正文和 prompt 展开不属于本次管理改动。

## API 所属范围

| 接口             | 所属范围                                                 |
| ---------------- | -------------------------------------------------------- |
| 已提交目录       | 持久化会话和 Workspace 读取授权                          |
| 管理命令与状态   | 获授权的公开会话、其日志 writer 和原 Runtime owner       |
| 已发布 inventory | 选定 Runtime、精确租户和 Workspace；私有 recipe 留在该处 |
| daemon 管理页    | 现有选定 ACP Workspace，不变                             |

递增 OpenAPI 版本、重新生成 WebShell 类型，并更新映射接口和契约门禁。不新增 daemon 路由或可变 AgentDefinition 默认值。

## 验证

先用全局 `qwen` dry-run 基线，将管理能力缺失与既有组合验证分开记录。使用一次性 MySQL、两个真实 stdio server 和确定性模型，联合验证构建后的 CLI、Java 服务和 WebShell。在同一会话中执行全部操作，验证对话身份稳定、原定义 pins 不变、响应不含凭据、模型声明变化、Harness 重启并冷加载后保留禁用状态、重试幂等、旧修订拒绝、会话隔离和最终关闭。

验证失败或未知的释放不会报告重启成功或启动替代连接，活动 Turn 和未获授权的 actor 不能变更。覆盖空会话、只读会话、不支持的 profile、旧日志、provider/会话切换、响应式管理控件，以及既有 daemon 管理回归。运行受影响包测试、根 build/typecheck/bundle、Java API/surface 门禁、Maven verify 和适用的 MySQL/Hosted profile。完整自审两遍并独立审查。局部进程和浏览器证据不代表 Linux cgroup、SSH/CSI、Windows 或真实上游 provider 验收。

入口统一到 Plugin 管理的专项 UI 计划位于 `.qwen/e2e-tests/managed-mcp-plugin-only/plan.md`：以正在运行的 main 版本服务作为基线，验证 Plugin 管理查询当前选中的会话并保留对话草稿，在独立工作树构建静态前端后发布，不重启服务。本次 UI 调整不改变管理命令、授权、Runtime 所有权或更广泛的验收矩阵。
