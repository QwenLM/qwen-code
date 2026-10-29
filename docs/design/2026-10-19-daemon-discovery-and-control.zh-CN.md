# 本地 daemon 发现与控制命令

[English](2026-10-19-daemon-discovery-and-control.md) | [简体中文](2026-10-19-daemon-discovery-and-control.zh-CN.md)

## 状态

本变更已实现，新增单元测试与类型检查通过。`qwen serve` 的协议、认证与工作区隔离行为不变；新增面仅面向本地操作者。

## 问题

`qwen serve` 可以零配置启动本地 HTTP daemon 并托管 Web Shell，但启动后不留下任何机器可读的痕迹。操作者只能从 stdout 解析绑定端口、用 `ps` 找进程、并自行记住运行时目录下的日志路径。第二个终端无法回答“这个工作区是不是已经有一个 daemon 在跑”，只能猜端口再探测。`GET /daemon/status` 虽然存在，但没有 CLI 命令能到达它。

## 目标

- 为每个存活的监听器发布一条小型发现记录。
- 提供 `qwen daemon status`、`qwen daemon logs`、`qwen daemon stop`。
- 发现记录不得包含 bearer token。
- 记录写入失败时，`qwen serve` 的行为保持不变。

## 非目标

- 不做远程注册表、跨主机联邦或多 daemon 协调。
- 本切片不提供 restart 命令。
- 不做 token 持久化；`--token` 与 `QWEN_SERVER_TOKEN` 仍是唯一的 bearer 来源。
- 不改变 `qwen serve` 的 HTTP 协议或 Web Shell。

## 发现记录

监听器绑定成功后，daemon 写入一条 JSON 记录：

```text
${QWEN_RUNTIME_DIR:-${QWEN_HOME:-~/.qwen}}/daemon/daemon-<port>.json
```

```json
{
  "v": 1,
  "pid": 12345,
  "port": 4170,
  "hostname": "127.0.0.1",
  "url": "http://127.0.0.1:4170",
  "workspaces": ["/repo/project"],
  "primaryWorkspace": "/repo/project",
  "startedAt": "2026-10-19T06:00:00.000Z",
  "auth": "none",
  "logPath": "/home/user/.qwen/debug/daemon/daemon.log",
  "pidNamespace": "pid:[4026531836]"
}
```

- 目录以 `0700` 创建；记录在 POSIX 上以 `0600` 原子写入。
- `auth` 取值 `none` 或 `bearer`；仅当 daemon 生成了临时 token 时才出现 `tokenGenerated`。两者都不包含 token 本身。
- `logPath` 是 daemon 当前写入的活跃日志；旧记录缺失时回退到稳定的 `debug/daemon/daemon.log`。
- `pidNamespace` 是写入方的 PID 命名空间（`/proc/self/ns/pid`）。pid 只在其所属命名空间内指代进程，因此空间外的读取方（共享 runtime 目录的容器，或另一台内核）把该 pid 视为不可寻址，既不当作存活证据也不当作已死证据，并且绝不向它发信号。内核没有 PID 命名空间时该字段缺失，早于该字段写入的 v1 记录同样缺失。
- 通配绑定（`0.0.0.0` / `[::]`）的 `url` 改写为 loopback，便于本地客户端探测；`hostname` 保留实际请求的绑定地址。

记录刻意不携带凭证。被 serve 的工作区可以通过 daemon 的文件路由暴露自身文件，因此落在工作区内的记录绝不能成为 token 存储。

## 命令面

```bash
qwen daemon status [--json] [--prune]
qwen daemon logs [--port <port>] [--lines <n>] [--follow]
qwen daemon stop [--port <port>] [--all] [--force]
```

- `status` 列出所有记录及其健康状态：`running`、`unreachable`、`stale`。`/health` 返回任何 HTTP 响应都证明监听器存活，包括 `--require-auth` 下的 `401`。
- `status --prune` 清理进程已消失的记录。
- `logs` 打印末尾若干行；带 `--follow` 时轮询记录中的文件直到中断，遇到截断会重置偏移，轮转时先排空旧文件再跟随新文件。
- `stop` 仅在监听器有响应或 PID 仍存活时发送 `SIGTERM`，且进程启动时间必须接近记录、命令行为 `serve` 进程（POSIX，或 Windows 上可通过 PowerShell 读取时）；窗口之外或身份读不到的 PID 绝不发信号。Windows 上 `stop` 是硬杀且必须显式 `--force`，关闭处理器不会执行；POSIX 上 `--force` 在优雅超时后发送 `SIGKILL`。`stale` 记录只删除，不发信号。
- 只注册了一个 daemon 时，`logs` 与 `stop` 隐式选中它；多个注册必须用 `--port`，`stop` 也支持 `--all`。

## 生命周期

- 监听器绑定成功后写入记录；优雅关闭与进程退出时删除。
- 崩溃可能留下记录。`status` 将其标为 `stale`；`status --prune` 与 `stop` 负责清理。
- 记录写入失败只在 stderr 报告，绝不导致启动失败。

## 安全

- 文件仅属主可读写（目录 `0700`，记录 `0600`）。
- 记录中不写入 bearer token、prompt、transcript 或任何凭证。
- `stop` 拒绝向当前进程发信号；对已判定为 `stale` 的记录不发信号。对启动时间晚于记录的 PID 不发信号；无法读取启动时间时同样拒绝。
- `--force` 需显式开启，且只在优雅超时后生效。

## 验证

- 单元测试覆盖：记录往返、POSIX 权限、损坏记录、按 PID 删除保护、运行时目录解析、通配 URL 改写、进程启动时间判定、条目选择、年龄格式化、日志尾部读取。
- 全仓类型检查通过。
- 手工验证：启动 `qwen serve`，执行 `qwen daemon status`，跟随日志，再执行 `qwen daemon stop`，确认记录被删除。

## 验收标准

- 第二个终端无需解析 stdout、无需预先知道端口即可发现本地存活 daemon。
- `qwen daemon stop` 能干净退出默认 loopback daemon 并删除记录。
- 任何发现文件都不包含 bearer token。
- 发现目录不可写时，`qwen serve` 仍能启动。

## 后续

- `qwen daemon restart` 与启动 Ready 区块。
- `qwen daemon token`，以及 `--open-with-auth` 的可选 token 持久化。
- 终端一等客户端（`qwen attach`）。
