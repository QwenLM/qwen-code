# Daemon restart

状态：已实现。

[English](2026-10-21-daemon-restart.md) | 中文

## 范围

`qwen daemon restart` 重启恰好一个已注册的本地 `qwen serve` daemon。它复用记录中的 port、hostname 与 workspaces，并等待新 runtime 就绪。不引入 supervisor、Windows 服务或跨 runtime 目录发现。

## 命令

```bash
qwen daemon restart [--port <port>] [--token <token>]
                     [--web | --no-web] [--require-auth]
```

注册多个 daemon 时必须传 `--port`。`auth: bearer` 的 daemon 必须提供 `--token` 或 `QWEN_SERVER_TOKEN`。

## 行为

- 只选择一个 discovery record；无 daemon 或多 daemon 未指定 `--port` 均报错。
- 对 bearer daemon，**先解析 token 再 stop**；缺少 token 时不能杀掉可用 daemon。
- 通过现有 `daemon stop` 路径停止，保留 PID/启动时间/命令行校验与 Windows 的 `--force` 要求。
- 通过现有 `daemon start --wait` 路径启动，复用记录的 port、hostname 与 workspaces；新进程报告 runtime serving 后才返回。
- `auth: none` 时从子进程环境移除 `QWEN_SERVER_TOKEN`，避免 restart 静默加上 bearer 认证。

## 安全与失败

- stop 失败即中止，不尝试 start。
- start 失败时 daemon 处于停止状态并返回非零；操作者可查看启动日志后重试 `daemon start`。
- restart 不持久化、不打印 bearer token。

## 限制与后续

- discovery record 尚未保存原始 `web` 与 `require-auth`。restart 默认开启 Web Shell、`require-auth` 关闭；bearer 记录会强制开启 `require-auth`，并接受显式 `--no-web` / `--require-auth`。把两者写入 record 属于后续工作。
- restart 目前输出 stop 与 start 的摘要；结构化 `--json` 结果属于后续工作。

## 验证

- 单测：命令注册与现有 daemon 套件。
- E2E：启动分离式 `--no-web` daemon，restart 后确认端口不变、PID 更新，再停止。
