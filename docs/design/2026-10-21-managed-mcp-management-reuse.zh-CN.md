# Managed Workspace 工具与 MCP 组合

[English](2026-10-21-managed-mcp-management-reuse.md) | [简体中文](2026-10-21-managed-mcp-management-reuse.zh-CN.md)

状态：已实现并完成本机进程验证，基于 `e63a0bfc23d2b97eddae7fefd02ab1c13552f30c`。

## 问题与本轮范围

daemon 的 MCP 管理配置其 ACP 进程，并非选定的 Managed Runtime。管理页展示资源元数据；普通 ACP 聊天另有资源读取和 prompt 展开路径。Managed-only 部署也可以没有 daemon。

Managed 通过不可变 AgentDefinition 和 `hosted-workspace-mcp/1` profile 固定私有 MCP recipe。该 profile 提供 Read/Write/Edit 和 MCP，但没有 Shell、备份/撤销或 Plan。通用本机 Workspace 隔离 worker 已支持保持 MCP 连接；专用 CSI 常驻文件 profile 是另一份契约。仅复用页面不能让普通文件/Shell 会话使用 MCP。

用户选择优先交付普通 Managed 文件/Shell 与 MCP 组合。在普通公开 shell/1 profile 上允许可选 MCP pins；它本身已有 Read/Write/Edit 和 Shell。保留审批、备份与生命周期，兼容旧 MCP 会话。文件专用 files/1 继续拒绝 pins。尚未上线的 Shell 变体现统一为 shell/1，并包含原生 glob；部署允许列表不能启用已移除的 Shell 标识。同一 PR 还增加会话对已发布 MCP 定义的管理，并复用 daemon 展示组件，详见[会话 MCP 管理](2026-10-22-managed-session-mcp-management.zh-CN.md)。可执行 recipe 编写和资源/prompt 展开仍单独交付。

## 准入与不可变配置

允许现有 AgentDefinition 的 `mcp_servers` pins 用于 `hosted-workspace-shell/1` 和旧 MCP profile。其他 profile 继续拒绝非空 pins。旧 MCP 仍要求至少一个 server。Shell 组合要求 Harness 的 workspace-shell-mcp/1 feature 及 shell/1 lifecycle v2；拒绝直接 Hosted DELETE，使用有序关闭路径。保留数量、身份、revision、digest 和部署容量校验。

复用 Session 固定确切 AgentDefinition revision/digest 及 connector 传递 pins 的机制，无需新增 Session 扩展 envelope、可变默认值表或携带 recipe 的公开请求。定义缺失/损坏时显式失败，不回退最新定义或宿主 settings。recipe 和凭据仍留在部署拥有的 Runtime manifest。

snapshot-read-only 子会话保持空 MCP 能力。foreground-only 和专用 CSI 常驻文件 profile 不增加 MCP。普通 profile 名称继续表达普通工具，已准入 pins 决定 Session 是否拥有 MCP。

## Runtime 归属与普通工具

MCP 与普通工具共用 Session 级 MCP broker；Hooks 仍共用该 broker。所有调用保留原 runtimeSessionId、binding、generation 和持久执行身份。未知 effect 只能查询原 owner，不能在替代 Runtime 重放。

带 MCP 的普通 profile 通过同一 owner 绑定并持久保存文件历史。Write/Edit 保留前像备份和冲突检查；历史及撤销仍可用。工具描述反映实际语义。只有旧 MCP 保持不备份/不撤销。保留已保存 native 审批 continuation 的限制，不为未知 owner 虚构恢复支持。

MCP 连接或不确定操作存在时，Turn 完成继续保留 Session owner。关闭通过有序生命周期协议排空普通执行、后台 Shell、Hooks 和 MCP。关闭一个逻辑 Session 不能停止共享 Workspace worker 或其他 Session 连接。保留 shell/1 的 lifecycle v2。对带 MCP pins 的会话，将停止普通后台工作与释放 Session owner 分开：先停止并持久化输出，再排空 MCP，最后只释放一次。不带 MCP 的 Shell 会话保留原有排空流程，包括依据原 worker 停止证明恢复清理的路径。同时验证普通结果和 MCP owner 回执。

## Plan 与上下文切换

首期对带 MCP pins 的 Agent 明确拒绝 Plan，保持现有 MCP 安全边界。Session options、创建、Plan 切换与 Hosted 准入必须一致。不能悄悄丢弃配置，也不能接受声称只读的 Plan 后初始化 MCP。MCP annotations 不构成只读授权。

普通文件/Shell 工具保留所选审批模式。Session 级 owner 的 native 审批接管恢复继续 fail-closed。上下文切换尊重 Session owner 和活动 MCP holds：不支持时明确拒绝，不创建第二个 owner，也不在上下文仍旧时报告成功。后续 Plan 需要 MCP 初始化前的持久 owner、只读声明及可恢复 Plan 审批；仅跳过 ensureReady 会泄漏 owner。

## 组合能力之后的 daemon 复用

daemon 的 Runtime 轮询、epoch、ACP reconcile 和 OAuth 留在原 controller。复用小型配置表单和元数据详情组件，Managed 使用独立 provider/controller。不能把 Managed 已提交目录显示为 daemon 实时连接或伪造 epoch。

最小配置发布后续方案是先持久保存 Runtime 私有不可变 recipe，再携带 expected revision 和稳定幂等身份，仅更新选定已保存 AgentDefinition 的 MCP pins。复用定义回执与 Session pinning。Workspace OWNER 并不等于 tenant 全局 Agent 编辑权限：本机管理需要显式单用户 opt-in、loopback/actor 检查，远程部署需要 Agent 编辑策略。可执行 recipe/凭据不进入 AgentDefinition、Session 记录或浏览器缓存。

Runtime transport 已支持 resources/read 和 prompts/get，但普通 Hosted 声明/执行目前只准入 tools/call。后续应扩展持久工具通路，同时保留 raw control 的 operation-grant 要求。确定性 UI 加载应像所选 Skills 一样成为初始 typed tool batch。往 Managed 文本插入普通 @server:uri、/name 或自然语言不等于确定性加载。

## API 归属与失败

| 接口                 | 归属与行为                                                          |
| -------------------- | ------------------------------------------------------------------- |
| 准入                 | 持久 Workspace 和 actor 授权，随后固定定义 pins                     |
| MCP 目录             | 持久 Workspace 读取授权；已提交脱敏快照                             |
| 普通工具、MCP 与撤销 | 活动 Session owner；确切 Runtime/binding/generation；不回退 primary |
| 关闭、取消与恢复     | 原持久 owner/effect；原证据确认前未知保持未知                       |
| 后续配置             | 持久 Workspace 加显式 Agent 编辑权限；发布不等于连接成功            |

不新增 daemon 路由。未知、不可信、不可用、排空和已移除 Runtime 目标保留现有显式失败语义。

## 影响组件

- Java 定义扩展校验、准入/Plan 能力检查及 connector 的 pins 传递。
- Hosted Session 创建/加载与 Plan 校验、生命周期/撤销 owner 选择和普通 tool-turn 备份。
- MCP Session 预热和 broker 使用；Runtime transport 与凭据 manifest 保持兼容。
- 准入、生命周期、Plan、备份和进程测试。改变公开契约描述时递增数字版本并重新生成消费者。

## 验证

先记录全局已安装 CLI 基线，再验证源码匹配 bundle。使用隔离本机 stdio MCP、确定性模型和一次性数据库，不接触用户预览服务、真实 Session 或凭据。

证明普通 Shell Session 能执行 Read/Write/Edit、前台 Shell 和真实 MCP 调用，后续 Turn 复用同一 MCP 进程。验证持久结果、备份/撤销、Plan 能力/准入/切换拒绝且无 transport 副作用、关闭/排空、旧定义 revision 保留及 snapshot 子会话空能力。另测 files-only/1 与被移除 Shell profile 的拒绝，保留原 owner/不重放回归。

执行定向包测试、根 build/typecheck/bundle、受影响 Java 测试后 Maven verify 及适用一次性 MySQL/Hosted profiles。区分定向与全量结果，记录未测矩阵。本机夹具不等于 SSH、CSI、真实上游模型、Windows 或生产验收。最后达到连续两轮自审无发现并完成独立审查。

在 macOS、JDK 21 与一次性 MySQL 8.4 上，本机进程验证已通过 Read/Write/Edit、前台 Shell、两轮 stdio MCP 复用、备份冲突/撤销、明确拒绝 Plan、公开 lifecycle v2 关闭及旧 MCP 回归。后台 Shell 与 MCP 组合仍需要 delegated Linux cgroup v2 验收。测试报告分别记录确切产物 hash、定向回归结果及夹具失败，不声称完成全部平台或上游 provider 验收。
