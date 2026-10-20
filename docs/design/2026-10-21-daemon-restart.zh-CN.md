# Daemon restart

状态：已实现。

[English](2026-10-21-daemon-restart.md) | 中文

## 范围

`qwen daemon restart` 重启恰好一个已注册的本地 `qwen serve` daemon。它复用记录中的 port、hostname 与 workspaces，并等待新 runtime 就绪。不引入 supervisor、Windows 服务或跨 runtime 目录发现。

## 命令

```bash
qwen daemon restart [--port <port>] [--token <token>]
                     [--web | --no-web] [--require-auth] [--force]
```

注册多个 daemon 时必须传 `--port`。对 bearer daemon，或对 `auth: none` daemon 显式请求 `--require-auth` 时，必须提供 `--token` 或 `QWEN_SERVER_TOKEN`。

## 行为

- 只选择一个 discovery record；无 daemon 或多 daemon 未指定 `--port` 均报错。
- 停止前拒绝 HTTPS discovery URL。`daemon start` 无法恢复 TLS 设置，restart 不能把加密 listener 降级为明文 HTTP。
- 停止前解析并校验 bearer token。这同时覆盖记录为 bearer 的 daemon，以及对 `auth: none` daemon 显式 `--require-auth` 的加固；token 会保留在子进程环境中。
- 通过现有 `daemon stop` 路径停止，保留 PID/启动时间/命令行校验。Windows 上只有操作者传 `restart --force` 时才转发 `--force`；restart 不代替操作者确认硬杀。
- 通过现有 `daemon start --wait` 路径启动，复用记录的 port、hostname 与 workspaces；新进程报告 runtime serving 后才返回。
- 对 JavaScript/TypeScript 入口保留 `process.execArgv`，使 `npm run dev -- daemon restart` 保留 loader。
- `auth: none` 且未请求 `--require-auth` 时，从子进程环境移除 `QWEN_SERVER_TOKEN`，避免 restart 静默加上 bearer 认证。

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
