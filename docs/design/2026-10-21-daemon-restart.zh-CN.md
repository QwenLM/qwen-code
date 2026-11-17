# Daemon restart

[English](2026-10-21-daemon-restart.md) | [简体中文](2026-10-21-daemon-restart.zh-CN.md)

状态：已实现。

## 范围

`qwen daemon restart` 重启恰好一个已注册的本地 `qwen serve` daemon。它请求记录中的 port 与 hostname，重放记录中的启动 workspaces、Web Shell 模式与 `--require-auth` 设置，保留 bearer 凭据，并等待新 runtime 就绪。不引入 supervisor、Windows 服务或跨 runtime 目录发现。

## 命令

```bash
qwen daemon restart [--port <port>] [--token <token>]
                     [--web | --no-web] [--require-auth | --no-require-auth]
                     [--force]
```

注册多个 daemon 时必须传 `--port`。`--web` 与 `--require-auth` 默认取记录中的值，显式传入则覆盖记录。对 bearer daemon，或对 `auth: none` daemon 显式请求 `--require-auth` 时，必须提供 `--token` 或 `QWEN_SERVER_TOKEN`。

## Discovery record

`qwen serve` 在 discovery record 中新增三个可选字段，使 restart 能复现 daemon 的启动参数：

- `startupWorkspaces`：显式的启动 workspaces。`workspaces` 还包含 daemon 启动时恢复的持久化注册；若把它们作为 `--workspace` 重放，可被 forget 的注册会变成启动 workspace，之后移除路由会拒绝移除它。
- `web`：是否启用 Web Shell。
- `requireAuth`：是否设置了 `--require-auth`。

这些字段都是可选的，旧版 CLI 仍能读取 record，record 版本保持为 1。record 仍不包含 bearer token。

## 行为

- 只选择一个 discovery record。没有 record，或有多个 record 且未传 `--port` 时，restart 报错并只提示 `--port`，不接受 `stop` 的 `--all`。
- 凡是能在 daemon 仍在运行时做出的拒绝，都在 stop 之前完成：
  - 拒绝 HTTPS discovery URL。`daemon start` 无法恢复 TLS 设置，restart 不能把加密 listener 降级为明文 HTTP。
  - 对没有 `startupWorkspaces` 且列出多个 workspace 的旧 record 拒绝，因为无法区分其中恢复的注册与启动 workspace。只有一个 workspace 的旧 record 照常重放，并提示所假定的 Web Shell 与 `--require-auth` 默认值。
  - 从 `--token` 或 `QWEN_SERVER_TOKEN` 解析 bearer token。记录为 bearer 的 daemon、`--require-auth` 或显式 `--token` 都要求提供 token。错误信息会指出启动时生成、record 无法恢复的 token，并说明 `qwen daemon` 不读取 workspace `.env` 或 settings 文件中的 token。
  - 对 listener 身份已校验、仍在运行的 bearer daemon，把 token 发给 `/daemon/status`。返回 401 时拒绝 restart，错误的 token 不会静默轮换 daemon 的凭据。身份未校验或不可达的 listener 不会收到 token。
  - restart 进程是目标 daemon 的后代时拒绝，例如在它托管的 Web Shell 终端中运行。停止 daemon 会在 start 之前销毁该 shell，连同本命令。
  - 用 `daemon start` 相同的检查校验启动 workspaces，避免 daemon 运行期间消失的 workspace 导致健康的 daemon 被停止。
- 通过现有 `daemon stop` 路径停止，保留 PID/启动时间/命令行校验。只有操作者传 `restart --force` 时才转发 `--force`：它确认 Windows 硬杀，并在 POSIX 上 SIGTERM 超时后允许 SIGKILL；restart 不代替操作者添加它。
- 通过现有 `daemon start --wait` 路径启动，使用记录的 port、hostname、启动 workspaces、Web Shell 模式与 `--require-auth`；新进程报告 runtime serving 后才返回。
- 两步分别以 `qwen daemon stop` 与 `qwen daemon start` 子进程运行。每一步都是带自身检查与输出的公开命令，restart 进程可以为子进程设置环境（添加或移除 token），而不改变自身环境。
- 对 JavaScript/TypeScript 入口保留 `process.execArgv`，使 `npm run dev -- daemon restart` 保留 loader。
- `auth: none` 且未传 `--require-auth` 或 `--token` 时，从子进程环境移除 `QWEN_SERVER_TOKEN`，避免继承的 token 静默加上 bearer 认证。显式 `--token` 会配置 bearer 认证，与 `daemon start` 一致。

## 安全与失败

- stop 被拒绝或超时时保留 discovery record，restart 不会 start。stop 因 record 已不存在而失败时（daemon 在 stop 启动期间自行退出），restart 会启动 daemon。
- stop 或 start 子进程无法启动时，报告 spawn 错误。
- start 失败有三种结果，均来自 `daemon start`：
  - `daemon start` 在 spawn 之前拒绝（workspace 无效、缺少 token、重复 daemon、spawn 失败）：daemon 处于停止状态，可安全重试。
  - 30 秒内没有 discovery record：分离的子进程仍可能启动。重试前先查看 `qwen daemon status`。
  - record 已发布但 runtime 在 30 秒内未报告就绪：daemon 通常仍在运行但未就绪，也可能已在启动期间退出。查看 `qwen daemon status`，再次启动前先执行 `qwen daemon stop --port <port>`；它运行期间直接执行 `qwen daemon start` 会被拒绝。
- 记录的端口被占用时，`serve` 会改用下一个空闲端口。此时 restart 返回非零，因为 daemon 没有回到记录的端口；start 摘要会打印实际 URL。
- restart 不持久化、不打印 bearer token。

## 限制与后续

- restart 只复现 port、hostname、启动 workspaces、Web Shell 模式、`--require-auth` 与 bearer 凭据。其他 `qwen serve` 选项，例如 `--profile`、`--http-bridge`、`--channel`、`--join`、`--local-control`、`--allow-origin`、`--rate-limit-*` 以及会话与内存限制，都会恢复默认值。使用这些选项的 daemon 请通过 `qwen serve` 重新启动。
- 轮换 bearer token 时，先停止 daemon，再用新 token 启动。
- restart 目前输出 stop 与 start 的摘要；结构化 `--json` 结果属于后续工作。

## 验证

- 单测：新字段的 discovery record 校验；restart 计划（record 重放、旧 record、token 与认证决策、flags、loader 参数）；目标选择；祖先进程检查；token 探测；以及执行顺序，覆盖每个 stop 前的拒绝、record 消失路径、spawn 错误与端口变化。
- E2E：启动分离式 `--no-web` daemon，restart 后确认端口不变、PID 更新，再停止。分别验证 bearer daemon 带与不带 token 的 restart、在 Web Shell 终端内 restart，以及删除启动 workspace 后的 restart。
