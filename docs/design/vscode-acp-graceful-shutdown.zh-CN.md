# VS Code ACP 优雅退出

[English](./vscode-acp-graceful-shutdown.md)

## 问题

VS Code companion 在面板断开时会立即终止 ACP 子进程。Windows 上这种方式会绕过 CLI 的退出流程，可能遗留 shell 和 ConPTY 后代进程。优雅退出期间旧进程还可能与新连接短暂并存，因此旧进程的退出事件或异步响应不能清理新连接持有的状态。

## 决策

companion 首先关闭 ACP 子进程的 stdin。CLI 将传输关闭作为正常退出处理，触发 SessionEnd hooks、排空 MCP 客户端、释放会话并执行进程清理。

退出流程有明确上限：

- POSIX 上 ACP 子进程作为进程组组长。75 秒后 companion 向该进程组发送 SIGTERM，再等待 75 秒后发送 SIGKILL。
- Windows 上等待 75 秒后，companion 使用 System32 下的绝对 `taskkill.exe` 路径和 `/f /t` 参数终止进程树。
- 退出处理器和异步响应绑定到创建它们的子进程与连接，已退役进程不能修改替代连接。
- EOF 与信号触发的重叠退出共享同一次 SessionEnd、MCP 排空、会话释放和已注册进程清理。所有 SessionEnd hooks 并发启动，并共享 30 秒的中止时限。

## 范围

本次只处理 ACP 进程退出，以及优雅退出引入的连接竞态。不处理用户切换会话时关闭旧会话，也不改变 hook 进程树的归属；后者由独立改动处理。

## 验证

- 断开连接时先关闭 stdin，不立即强制终止。
- POSIX 升级路径针对 ACP 子进程所在的进程组；Windows 升级路径通过 `taskkill /f /t` 针对进程树，taskkill 失败时退化为只终止直接子进程。
- 子进程正常退出后取消升级计时器。
- 已退役子进程的退出或响应不能清理或更新替代连接。
- EOF 与信号重叠时每个清理阶段只执行一次，且所有 SessionEnd hooks 都在共享时限内启动。
