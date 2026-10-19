# Hosted stdio MCP 进程收容

[English](2026-10-19-mcp-stdio-containment.md) | [简体中文](2026-10-19-mcp-stdio-containment.zh-CN.md)

## 问题与范围

Issue [#14503](https://github.com/QwenLM/qwen-code/issues/14503)（由 FG12 轮次 [#14447](https://github.com/QwenLM/qwen-code/issues/14447) 发现）记录了 Hosted stdio MCP server 由 Runtime worker 直接 spawn、没有任何东西约束其进程树。在 `main` `79362c2ecc`、macOS 26.5.1 上用真实 `ManagedMcpRuntime` 复现出四类泄漏（报告见 `.qwen/issues/issue-14503.md`）：

- worker 被 SIGKILL 后，忽略 EOF 的 server 仍存活，被 PID 1 收养，仍在 Workspace 内并持有 manifest token；
- 优雅 release 在报告 `released: true` 的同时，留下 server 派生的后代进程；
- 后代持有 stdout 时，关闭在 5 s 变成 `managed_mcp_drain_unknown`，且后代仍存活；
- 非转发的 forking wrapper 退出后，内层 server 仍存活，关闭同样变成 `managed_mcp_drain_unknown`。

所有情形中 server 与 worker 共享同一 PGID：既没有独立进程组，也没有 cgroup。在 POSIX 上，本切片让每个 stdio server 拥有自己的进程组，并由 launcher 在 transport 的 stdin 关闭时回收整组——无论关闭来自优雅 release 还是 worker SIGKILL。它不新增 cgroup 单元、不改变 Broker 的 stopped-worker 证明，也不覆盖调用 `setsid` 的后代；Windows 保留之前的启动路径。

## 决策

- 在 POSIX 上，每个 stdio 连接都经一个小型 supervisor（`managed-stdio-supervisor.ts`）启动。它以 `detached: true` spawn 真实命令，使命令成为新 session 与进程组 leader，并为其 stdin 建管道。
- launcher 把 transport 的 stdin 转发给 server。stdin EOF 时，它先关闭 server 的 stdin，等 1 s，向整个进程组发 SIGTERM，等 300 ms，再发 SIGKILL，然后退出。
- launcher 自己留在 server 进程组之外，因此组信号不会打到它。worker 被 SIGKILL 时，launcher 被收养，其 stdin 收到 EOF，触发同一套回收。
- 每 100 ms 检查一次父进程：worker 消失时即使 stdin 管道因背压暂停也能回收。stdin EOF 仍是常规触发。
- SDK 的 `StdioClientTransport.close()` 会关闭 launcher 的 stdin，并在升级信号前等待 2 s。launcher 约 1.5 s 的上界落在第一个窗口内。
- Windows 上 runtime 保留 SDK 原始 transport，cross-spawn 仍能解析 `.cmd`/`.bat` 命令 shim；那里的收容行为不变。
- launcher 不依赖 cgroup root。当前 Hosted 车道与本机开发都没有为 MCP 委派 root；硬拒绝会把收容修复变成可用性回归。

## 为什么本切片不用 cgroup

issue 允许进程组回退，且进程组修复了全部四类已复现泄漏。Shell 与 Hook 的 cgroup 路径需要委派 root，而 MCP 集成测试并不提供。cgroup 单元仍是本切片留下的两个缺口的更强后续：调用 `setsid` 的后代会逃出进程组；Broker 也没有一个可在 stopped-worker close 之前证明为空的单元。两者都需要可持久化的单元身份与 Broker 可见的空证明，属跨语言改动。

## 行为与验收

- launcher 自带测试覆盖三种触发：stdin 关闭、持有 stdin 的进程被 SIGKILL，以及 stdin 管道已被写满时的同一种 SIGKILL；三者都必须回收 server 与其后代。
- 既有 `managed-mcp-runtime` 套件保持全绿；launcher 对 MCP 流量、env、cwd 与退出处理透明。
- 用复现装置对修补后的源码复跑：优雅关闭、worker SIGKILL、drain 超时与 wrapper 四种情形都不再有 server 或后代存活。
- `packages/cli` 的类型检查与 lint 通过。

## 限制

- 调用 `setsid` 的后代会离开进程组并存活；只有 cgroup 单元能抓住它。
- Broker 的 stopped-worker close 仍把 worker PID 消失当作证明。launcher 把孤儿窗口压到约 1.5 s，但 Broker 拿不到空证明。cgroup 单元加可持久化证明属于后续。
- 进程组 id 原则上可被复用。短回收窗口使其不常见，但并非不可能；cgroup 单元可消除该竞态。
- 每个 stdio 连接在其生命周期内保留一个小型 Node launcher。裸 launcher 实测约 44 MB RSS；在 16 连接上限下，每个 Runtime session 约 700 MB（不含 server 自身内存）。Hosted 内存预算必须把这第二个进程算进去；若该上限变紧，更轻量或共享的 supervisor 属于后续工作。
- supervisor 仅限 POSIX。Windows 保留之前的直接 spawn，`npx`、`npm` 与 `.cmd` shim 仍可解析，但不会获得收容。
