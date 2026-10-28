# Managed 主会话 worktree

[English](2026-10-28-managed-session-worktrees.md) | [简体中文](2026-10-28-managed-session-worktrees.zh-CN.md)

## 状态与范围

基于 `32f6713ce6` 实施本机首版。新建主会话可选择独立 Git worktree，默认仍为当前目录。
支持 macOS/Linux 上 LOCAL 存储、持久化且按 Session 隔离的 local-process Runtime。
本次不包含 SSH、CSI、重开关闭的会话、自动合并及运行中切换 worktree。
worktree 隔离编辑目录，不隔离主机权限及共享 Git refs。

## 所有权与持久化

现有 ROOT Workspace 继续持有授权和存储。一对一 `ma_session_worktree` 记录会话、actor、
存储身份、Git common directory、源目录偏移、目标根目录及 cwd、初始分支、冻结 commit、
状态与修订号。准备和清理使用持久化 `ma_operation`，关闭、归档或删除聊天后仍保留身份。

服务端在存储根内分配 `.qwen-managed-worktrees/<id>`，初始分支为
`worktree-managed-<id>`，所有权元数据置于工作树外。实际 cwd 保留源目录相对仓库的偏移，
该目录必须存在于选定 commit。仓库和 Git 元数据必须位于已授权存储内。
linked source 的 common directory 越出存储根时拒绝，不自动扩大挂载。

## 创建与执行

1. 在检查可用性或解析 HEAD 前重放 actor 范围的创建回执。摘要包含请求的模式和 ref；
   首次准入另行冻结解析出的 commit。
2. 只读预检源目录权限、存储身份、Git 布局和 ref，不创建分支或目录。
3. 单一事务复核源身份，并写入最终目标绑定的 Session、worktree 身份、准备命令、
   可选首 Turn 和创建回执。context revision 从一开始。
4. worker 取得 claim 及物理存储维护占用后，从冻结 commit 创建并验证身份，再改为 ready。
   存储忙仅延后，不消耗失败预算。
5. 仅 ready 放行 warm、attach、dispatch、新输入和文件访问；准备前仍可取消及排空生命周期。

worktree 状态独立于会话状态：`preparing`、`ready`、`failed`、`blocked`、`removing`、
`removed`。准备中关闭后，即使 Git 完成也不再启动 Runtime。已知准备失败使首 Turn 失败。
重试返回相同身份，不分配另一份目录。

普通会话沿用现有共享执行模型。准备和清理独占整个物理存储，可能等待其他执行。
复用安全 Git runner 和布局检查，不复用 child 的重建、强制丢弃或合并语义。

## 恢复与清理

ready 会话使用前验证原目录、Git 注册项、common directory 和所有权。正常编辑、提交及
分支改名不触发重置。源 checkout 无需一直存在。目标丢失或替换时阻止执行，不回退源目录。
cwd 调整限制于自身目标根内。

claim 过期不证明物理进程已停止。Git 结果未知时保留维护占用并进入 blocked，直到既有
停止证据允许对账。本次不新增 macOS 在 Git 中强杀 JVM 后的自动恢复。
重新检查不能强制解除占用。

关闭、归档及删除保留目录。清理要求记录所有者、当前 Workspace 写权限、终态会话，
并确认 Runtime、子任务、上传及准备均已排空。在维护占用下复核所有权、已跟踪/未跟踪/
忽略文件、进行中的 Git 操作、嵌套仓库及子模块。当前 HEAD 必须仍由保留的普通分支、tag
或 remote ref 可达。使用非强制移除，始终保留分支；拒绝时保留目录。
保留的 worktree 阻止物理存储迁移/删除；已完成的历史 child 不永久阻塞清理。

## API、文件与 WebShell

创建 Session 接受可选 `worktree: {baseRef?}`（公开字段为 `base_ref`）。省略即当前目录，
空对象即 HEAD。路径及分支由服务端分配。Session GET/list 返回描述。
Workspace 下增加 options、query、inspect、cleanup，提供支持情况、保留目录、进度及幂等
清理，覆盖已删除聊天。读取遵循 Workspace 授权，删除还检查所有权与写权限。

文件请求严格二选一：Session ID，或 Workspace ID 加 cwd。前者解析持久绑定并将 worktree
修订纳入 scope revision；后者保留用于创建前浏览，禁止进入内部 worktree 路径。
仅服务端解析的 Session base 可通过内部保留目录，用户相对路径仍沿用原有验证。

WebShell 提供当前目录/worktree 和可选起始 ref，显示解析版本与未提交内容不带入的说明，
冻结待提交请求，并显示准备、等待、失败和受阻。目标创建前暂停目录文件引用与上传，
普通输入附件仍可用；ready 后按目标恢复文件能力。旧目录引用提示重选，保留文字草稿。

项目指令从目标 cwd 读取。模型、审批、Skills、MCP 和 Extensions 沿用当前 Session pin。
不复制被忽略配置、环境文件、依赖或软链接。子 Agent 仍可派生并合回该主 worktree。
Workspace 管理入口列出保留目录并提供检查、清理。

## 发布与验证

部署的 `session-worktrees-enabled` 默认关闭，受控本机启动器对支持的主机启用。
Git 缺失或版本不支持只禁用此选项，不影响当前目录会话。关闭新增能力不影响既有身份的
执行、查询和清理。

同步 canonical V1 SQL、严格 schema 校验、OpenAPI、surface 契约及生成的 WebShell 类型，
不新增 V2 迁移，不提升 schema version。

验收覆盖并发独立编辑、HEAD 移动后的创建重放、源 dirty 保留、准备中断与停止证据、
关闭竞争、目标丢失、权限撤销、文件/上传 scope、分支变化后的安全清理及子任务合并位置。
执行聚焦单元/契约、真实 MySQL 8.4、支持平台的真实 Git/Runtime/浏览器验证。
明确记录不可用的平台及故障覆盖；Java 本地验证共享模块十分钟预算，完整矩阵交给 CI。
