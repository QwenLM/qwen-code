# 智能体项目归属与 Qwen Host 接入

[English](2026-09-11-agent-project-host-entry.md) | [简体中文](2026-09-11-agent-project-host-entry.zh-CN.md)

## 行为

智能体归属侧边栏已有项目，运行位置为协调端本机 Qwen Code 或使用独立检出的已注册 Qwen Host。本地与远程文件不会自动同步。

侧边栏智能体入口打开智能体列表、任务看板和运行主机。协作线程与普通项目会话一起展示，点击后进入共享 Chat。运行详情复用现有右侧面板；关闭面板不会停止执行，也不会隐藏流式回复。

Qwen Host 只上报当前 prompt 的 ACP 回复、思考和工具活动。服务端保存有界的最新快照，每次更新都校验当前 Host、租约和 attempt。最终结果替换实时预览；失败或取消会保留部分输出。运行期间收到的消息进入后继轮次，重复提交结果不会重复创建任务。

重启或接管执行时分配新的 attempt 和租约，分别记录每次执行的消耗。每次尝试结束后，Host 刷盘并关闭活跃会话；后续轮次恢复持久化历史，不持续占用活跃会话额度。

运行中的 Host 租约到期后，其他已分配的 Host 可以重新领取任务。协调端从最新租约的到期时间起保留两个默认租约周期的恢复时间（目前为 120 秒），之后将仍未被重新领取的任务标记为失败并释放 Agent。续期或重新领取后的租约使用自己的恢复窗口。取消中的任务在租约到期后按已取消收尾，无需等待这段额外恢复时间。

本次增量只开放受管 Host 上的 Qwen Code，不探测或启动 Codex、Claude。其他 provider 需要独立的隔离配置，能够把读取限制在选中工作区，并排除用户环境中的 MCP、插件、Hooks、Skills 和凭据，完成后再单独接入。

## 隔离与连接

智能体协作按工作区显式启用。`experimental.agentCollaboration` 关闭时，不显示智能体协作 UI 和 `@Agent` 入口，不挂载协作与 Host 路由，也不启动 Host 后台连接。

Host 使用短期注册 token 接入，随后保存限定范围的凭据。token 通过 `QWEN_AGENT_HOST_ENROLLMENT_TOKEN` 传递，不进入进程参数。Host 会话使用独立只读初始化配置：不加载用户 MCP、Hooks、Extensions、Skills、LSP，不执行沙箱探测、Cron、Workflow 或 worktree 清理。`read_file`、不带 glob 过滤的 `grep` 和目录列表在 realpath 解析后限定于选中的工作区；Host 会话不提供 glob 展开，也不接受 grep 的 glob 过滤。

主服务也可以连接已运行的远程 Qwen Serve。两端都必须解析到明确注册且可信的工作区。拒绝重定向；回环地址之外默认要求 HTTPS，只有用户为可信演示网络显式开启时才允许 HTTP。此功能不持久化远程 Bearer 凭据。

注册、心跳、取单、租约续期、进度和结果提交都绑定工作区、Host、run、lease 与 attempt。工作区 runtime 被替换或关闭时，中止旧连接及正在执行的任务。结果提交幂等，过期租约不能覆盖新的 attempt。真正接收的结果与终态结算一起持久化回执，只有与回执完全一致的重试才返回 `alreadyApplied`。结算改写了上报状态的结果（如任务已处于 `cancelling`、Host 上报 `completed`）会被接收并结算为 `cancelled`，但不写入回执，因此完全一致的重发返回 `stale_lease`。如果恢复或取消已先行结算任务，仍已注册的 Host 使用匹配 attempt/lease 提交的迟到结果返回 `stale_lease`，不应用答案、消息、父任务结果，也不改动 token 用量：已终态的 attempt 不再具备影响预算的写权限。已被接管的旧 attempt 和已移除的 Host 仍被拒绝。旧终态记录缺少回执时，不推断其结果曾被接收。

## 限制

接入只持续到 daemon 进程结束，不安装操作系统服务。单个 Host 串行处理任务。此功能不负责文件同步、公共中继、NAT 穿透，也不接管已有桌面会话。

[PR 评审线程](https://github.com/QwenLM/qwen-code/pull/12582)中的验收报告标明测试对应的源码 head、环境、模型类型和 UI 证据。较早 head 的跨机器证据不能作为后续源码变更的验证。
