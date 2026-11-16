# 后台启动 daemon

[English](2026-10-20-daemon-start.md) | [简体中文](2026-10-20-daemon-start.zh-CN.md)

## 状态

本变更已实现。`qwen daemon start` 只做本地进程管理，不改变 serve 协议、认证或工作区隔离。

## 问题

此前启动本地 daemon 需要 systemd、tmux 或 `nohup`。discovery 记录与 `qwen daemon stop` 已经让运行中的 daemon 可被检查，但缺少一个受支持的启动方式，让用户启动后能回到 shell。

## 行为

`qwen daemon start` 以 detached 子进程启动 `qwen serve`，等待子进程发布 discovery 记录，然后打印绑定 URL、PID、日志路径与停止命令。父进程退出后子进程继续运行。

支持参数：`--port`、`--hostname`、`--workspace`（可重复）、`--no-web`、`--require-auth` 与 `--token`。子进程始终带 `--no-token-qr` 启动，避免启动日志中出现 token QR。

## 环境隔离

子进程是一个新的 daemon，不是启动它的会话的 worker。启动命令在 spawn 前移除父会话的绑定：`QWEN_CODE_SESSION_ID`、`QWEN_CODE_PROMPT_ID`、`QWEN_CODE_PROJECT_DIR`、`QWEN_CODE_SERVE`、`QWEN_CODE_AGENT_ID`、`QWEN_DAEMON_TOKEN`、`QWEN_CODE_MESSAGING_TOKEN`、`QWEN_CODE_MESSAGING_SOCKET`、`QWEN_CODE_CLI`、`QWEN_CODE_NO_RELAUNCH`，以及所有以 `QWEN_CODE_PRIVATE_` 开头的键（包括 Conversations runtime 与 guard-provider 标记）。相对的 `QWEN_RUNTIME_DIR`/`QWEN_HOME` 会在 spawn 前以启动目录为基准固定为绝对路径，使父子进程使用同一 discovery 命名空间。操作者的模型与认证环境保留。

Windows 无盘符根路径也会按启动目录所在盘符解析；只有盘符/UNC 形式原样保留。

显式设置为空的 `QWEN_RUNTIME_DIR`/`QWEN_HOME` 会保留为已设置变量；只删除真正未设置的变量。

启动前会使用与 `serve` 相同的函数规范化工作区，因此 symlink alias 与真实路径在重复启动检查和子进程参数中视为同一工作区。

显式 token 通过 `QWEN_SERVER_TOKEN` 传递，不进入子进程参数。`--token` 会出现在启动 shell 的进程列表中，因此命令会提示并建议使用环境变量。

## 日志与安全

启动 stdout/stderr 写入运行时 daemon 目录下的 `0600` 文件。启动成功后删除该文件；失败时保留并打印尾部。超过 24 小时的启动日志会在下一次启动时清扫。非 loopback 绑定必须提供 `QWEN_SERVER_TOKEN`：命令拒绝让子进程生成临时 token，否则该 token 会写入启动日志。

## 失败处理

- 同一主工作区已有存活 daemon 时，除非显式传 `--port`，否则拒绝启动。
- 工作区不存在、`--require-auth` 缺少 token、非 loopback 缺少 token 时，在 spawn 前失败。
- 子进程退出或 30 秒内未发布记录时，命令以非零码退出，说明 detached 子进程可能仍会启动、指向 `qwen daemon status`，并打印启动日志路径与尾部。

## 非目标

- 不做进程守护、崩溃重启或服务安装。
- 不做 Windows 服务封装。
- 非 loopback 绑定不提供临时 token 模式；请直接使用 `qwen serve`。

## 验证

- daemon 命令测试覆盖参数构造、摘要格式、环境隔离（含私有键前缀与相对运行目录）、工作区 canonicalization（含 Windows 无盘符根路径）、启动日志清扫、记录选择，以及既有 status/log/stop 行为。
- 全仓 typecheck 与 ESLint 通过。
- 本地端到端：`daemon start --port 0 --no-web --json` 发布记录，`daemon status --json` 报 running，`daemon stop --port <port>` 终止进程，随后记录目录为空。

## 验收标准

- 第二个终端无需服务管理器即可启动 daemon 并回到 shell。
- 打印的停止命令能终止子进程。
- 子进程不继承启动会话的标识或私有能力。
- 启动产物中不包含 bearer token。

## 后续

- 可选 restart（按记录的工作区 stop + start）。
- Windows 服务集成。
