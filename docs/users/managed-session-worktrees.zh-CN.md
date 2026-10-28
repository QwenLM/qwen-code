# Managed 会话 worktree

[English](managed-session-worktrees.md) | [简体中文](managed-session-worktrees.zh-CN.md)

在受支持的本机 Managed 部署中，新建会话时选择 Git 项目，再选择**独立 worktree**。
可填写本地分支、tag 或 commit，默认 HEAD。会话从该已提交版本开始，使用独立分支。
未提交文件、忽略的配置及已安装依赖仍留在源目录。

会话会显示准备状态，可能需要等待使用同一存储的其他工具执行结束。
worktree 就绪后可使用文件引用和 Workspace 上传。项目指令来自目标目录；模型、审批、
Skills、MCP 和 Extensions 继续使用 Managed 会话固定的配置版本。

关闭、归档或删除聊天后，目录和分支都会保留。在 Workspace 的**会话 worktree**中
检查保留目录。清理前需要关闭会话并结束后台工作；先提交或另外保存已跟踪、未跟踪及
忽略的内容。清理只删除干净的目录，保留所有分支，不自动将修改合回源目录。

部署通过 `qwen.managed-agent.runtime-broker.session-worktrees-enabled` 启用，默认关闭；
`qwen serve --managed` 为符合条件的本机主机启用。首版支持 macOS/Linux 的 LOCAL 存储、
按 Session 隔离的持久化 local-process worker，以及 Git 2.40 或更新版本。
仓库及其 Git common directory 必须在已登记存储根内。已有 linked checkout 的 Git
元数据位于外部时，请选择原始 checkout，或由管理员登记同时包含两者的根目录。
首版不支持 SSH 和 CSI。

已就绪会话重启后继续使用原目录。目录丢失或替换会阻止执行。如果服务在 Git 创建或
删除 worktree 时被强杀，原 Git 进程停止状态无法确认，操作将保持受阻及原维护占用。
重新检查不会强制恢复；首版不包含 macOS 对该场景的自动恢复。在原执行能够对账前，
保留目录和分支。

公开 Session 创建请求新增 `worktree: {"base_ref":"main"}`；`worktree: {}` 选择 HEAD，
省略该字段使用当前目录。同时发送已授权的显式 `workspace`，重试沿用原 Idempotency-Key。
发送后续输入前检查返回 Session 的 `worktree.state`。

本开发版本更新了共享 V1 schema baseline，需要按该基线重新创建开发 catalog；本次不提供
旧 catalog 的升级迁移。
