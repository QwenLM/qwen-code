# Managed Workspace 执行接入（W0c-3）

[English](2026-09-26-managed-workspace-execution.md) | [简体中文](2026-09-26-managed-workspace-execution.zh-CN.md)

状态：draft 实现，基于 W0c-2 #12730 的 `5e443797` 与已合入的 worker 后续修复 #12747。属于 #12724 和 proposal #12380。

## 问题与现状

W0b 持久化 Session 的 Workspace 绑定与配置引用。W0c-1 在 worker 中安装目录。W0c-2 供给 boot v2 并验证上下文回执。内嵌服务仍解析单一全局目录并拒绝绑定 Session；其 HTTP transport 无法 acquire/release Runtime Session。目前 Java 没有将共享文件的两个 Session 串行化的租约。

worker 当前用固定的预批准配置构造四种普通工具。目录回执不能证明任意冻结配置已经安装。Hosted provider 还需要 worker 尚未实现的 manifest、prepare、approval 和 history 控制。因此，打开公开 Turn 门禁会宣称超出目录接入范围的能力。

## 范围与验收

本切片把持久化的绑定 Session 接入私有 Broker 的 acquire、execute、status、cancel 和 release 路径。以真实 Read/Write/Edit/前台 Shell 验证两个 Workspace 及子目录的执行，并串行化共享存储的工具轮次。公开绑定 Turn/生命周期门禁、Hosted 模型/工具编排、文件历史结算、WebShell 选择、W0e 恢复启用、Kubernetes 和任意配置加载不在本切片内。继续不广播 `workspace_context`。

首个部署是共享 SQL 权威、由管理员管理可信目录的单个 local-process 宿主。进程供给器不是文件系统沙箱：面向不可信产品用户执行任意 Shell 前还需要部署隔离。同一宿主上的多个 Broker 进程使用相同的持久化存储租约；过期时间不会授权替换结果未知的写入者。

## 可信 Session 与存储解析

解析器读取原始 Session，校验完整绑定，并要求 ACTIVE 状态。它精确核对当前 Registry 的租户、Workspace ID、generation、存储身份与 ACTIVE 状态。它使用原始创建回执中的 actor，在获取执行权和每次新执行时重检该 actor 的读/创建授权。私有 Broker 凭据代表可信服务，不提供浏览器 actor。支持其他操作用户的产品流程需要独立的授权准入。

管理员配置提供租户/存储 ID/本地根目录映射列表。根必须是存在的规范目录；拒绝重复或重叠根，包括跨租户别名。映射缺失或 Registry 身份变化返回 `workspace_unavailable`。客户端路径、默认 Workspace 和当前 Registry 配置都不能替换已记录绑定。挂载根进入 Runtime placement；`cwdRelative` 保留在 Session 上下文中。托管执行初期要求 Session 隔离的本地进程。未绑定的 legacy placement 保留原协议和目录。

将 `qwen.managed-agent.runtime-broker.workspace-mounts` 配置为包含 `tenant-id`、`storage-id` 和 `root` 的对象列表。空列表不允许任何绑定 Session 执行。共享数据库的所有 Broker 必须使用相同的、由管理员控制的物理映射。解析器启动时保存规范路径和文件系统身份快照，拒绝被替换的根目录。供给过程不创建目录。

## 冻结配置与激活

只支持一个明确的不可变档案：配置引用 `managed-runtime-tools/1` 与策略引用 `preapproved-workspace-tools/1`。它允许 Read、Write、Edit 和前台 Shell，不含项目配置、MCP、Hooks、checkpoint 或后台工具模式。前台 Shell 仍可自行创建脱离的后代进程；本切片串行化已准入调用的生命周期，不证明任意 Shell 创建的守护进程已经停止。生产启用此类命令前需要可终止的隔离域。仅冻结引用对精确匹配的 `qwen-code` Session 可以执行。已有 W0b SHA-256 派生值必须匹配 `contextConfigRef`。独立固定的 capability digest 标识该 worker 档案；不会用普通 Harness digest 替代。

worker 新增独立于封闭目录安装信封的有界、鉴权激活路由。请求绑定 Runtime Session ID、原始 context digest、冻结配置引用和档案；回执还绑定 Runtime 身份、incarnation 和 epoch。在该档案的 capability digest 下，仅安装目录不能执行工具：激活必须校验支持的冻结档案及已安装绑定。旧 worker 会拒绝新路由，因此 acquire 在任何 execute 前失败。其他已有的目录协议 fixtures 保留其原 capability 身份。

每个 Runtime Session 的激活不可变且幂等。release 只有在该 Session 的日志不存在运行中的调用时才关闭门禁。已释放 Session 不能再次激活；后续工具轮次使用新的 Runtime Session ID。授权或目录丢失后，仍可查询和取消原调用。工具以已验证的 Session 目录为起点，并将可信 Workspace 根识别为允许的文件根；不修改共享进程 cwd。

## Workspace 轮次归属

新增以租户和存储 ID 为键的 SQL 归属行，不按 cwd 或 Workspace generation 分割。持有者包含 Runtime binding/generation 和 Runtime Session。获取操作在事务中完成，同一持有者可幂等重试；其他持有者收到可重试的 `workspace_busy`。整个 Runtime Session 持有归属，使其工具轮次（包括建立写入基线的读取）串行化。独立存储可并发执行。

归属行没有自动接管期限。Broker 崩溃、安装失败、execute 结果不明或物理状态未知时仍保留占用。原 Runtime Session 可重试并核对证据；新 Session 不能假定计时器已经停止旧进程。恢复/管理清理需要物理停止证据，属于 W0e。

release 先请求原 worker 关闭激活门禁并报告没有已准入的活动调用，再按原持有者条件清除 SQL 归属。失败或过时 release 不能清除其他持有者。Broker 的已有执行日志也会阻止释放未解决调用。release 响应丢失时，对同一已关闭门禁重试。完整 Hosted Turn 还必须将归属延续到 history commit，之后才能为产品使用广播此能力。

已有 Broker 可以在未调用 transport 的情况下，将不可用/LOST 的 Runtime Session 在本地标为已释放；这不会清除存储归属。撤权后仍可通过已经获取的本地路由清理，但重启后接管路由需要当前授权。无法接管时，保留的占用行需要 W0e 恢复，不能未经验证就解锁。

## 接线与消费方

内嵌服务注入绑定 Session 解析器与 transport 适配器。本地 provisioner 对符合条件的 Session 接收显式 managed placement request，对 legacy 请求保留 boot v1。适配器读取精确的持久化 Runtime binding，获取存储归属，安装目录上下文，并核验激活后才完成 acquire。每次新 execute 重检当前 Session/Registry 授权、scope 和存储归属。观察和取消使用已保存的身份，确保撤权不会阻止物理清理。

私有 Broker HTTP 路由保留现有请求结构和服务鉴权。归属为解析得到的持久化 Session 及选定 Runtime；绑定 Session 绝不使用主/全局目录。公开 API 和 WebShell 读取保留 W0b 行为。本 PR 不移除公开绑定 Turn 门禁。

影响组件：服务端内嵌 Broker、配置与 Registry/store 适配器；SQL 归属迁移；HTTP transport 激活支持；worker 激活门禁和工具配置；相关 Java/TypeScript 测试及真实进程验证。迁移也会将未使用的预览时代 placement 列改为可空，让已合入的 Broker 仓库能够向服务端 Flyway schema 插入，而无需伪造 placement 权威。

## 验证

- 先用全局 CLI 建立基线，再用本地构建 bundle 验证私有 Broker→worker 全路径。
- 使用真实 W0b SQL 创建回执与持久化绑定。创建后修改默认值和 Registry 配置引用；执行必须保留原引用对或拒绝。
- 在两个根与嵌套目录运行真实 Read/Write/Edit/Shell；相同存储的 Session 必须串行，不同存储可并发。
- 未知档案、缺失根、符号链接、错误存储/generation、撤权、已删除 Session 和外来激活回执必须在新执行之前拒绝。
- 验证两个 SQL 客户端竞争同一存储行、过时 release、结果不明后保留归属、release 重试，以及目录丢失后原调用的 status/cancel。
- 保持 legacy 测试通过；执行 build、typecheck、bundle、Java verify/Checkstyle、相关 worker 测试、独立 E2E 和两轮无发现自审。

## 尚未覆盖的边界

不接受任意冻结配置。更丰富的档案需要独立的版本化配置契约。跨宿主物理挂载身份、失联持有者恢复、产品鉴权、完整 Hosted 工具控制和 history commit 是后续工作。本 draft 验证限定的私有执行路径，不代表可以生产启用。
