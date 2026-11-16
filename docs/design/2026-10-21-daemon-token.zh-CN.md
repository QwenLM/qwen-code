# Daemon token persistence

[English](2026-10-21-daemon-token.md) | [简体中文](2026-10-21-daemon-token.zh-CN.md)

状态：已实现。

## 范围

为 `qwen daemon start --save-token` 启动的 daemon 增加可选的、仅 owner 可读的 bearer token sidecar，并提供 `qwen daemon token` 读取或删除。discovery record 与 daemon log 永不包含 token。

## 命令

```bash
qwen daemon start --token <token> --save-token
qwen daemon token [--port <port>] [--json]
qwen daemon token --remove [--port <port>]
```

## 存储

- 路径：runtime discovery 目录下的 `daemon-<port>-<pid>.token`，与 `daemon-<port>.json` 同级；pid 将 sidecar 绑定到单个 daemon 实例。
- 目录 `0700`，文件 `0600`（POSIX）。
- 仅在显式 `--save-token` 且提供了 bearer token 时写入。
- `daemon stop` 随 discovery record 一起删除 sidecar；`daemon token --remove` 显式删除。

## 行为

- `start --save-token` 在没有 `--token` 或 `QWEN_SERVER_TOKEN` 时，在 spawn 前拒绝。
- token 在 discovery record 发布后写入；写入失败会报错并以非零退出，但 daemon 仍在运行。
- `daemon token` 只选择一个 record，读取 sidecar，并且只在显式调用时打印。`--json` 返回 `{ port, token }`；`--remove` 返回 `{ port, removed: true }`。
- `daemon stop` 在 stale、优雅停止与强制停止时都删除 sidecar。

## 安全

- 持久化是 opt-in；默认仍使用环境变量/CLI 提供的 token。
- sidecar 不被 record 引用，也不写入日志。
- 持有该文件等同于持有 bearer token。删除文件不会轮换运行中 daemon 的 token；轮换需要 stop 后用新 token start。

## 限制与后续

- 本切片覆盖显式 `--token` / `QWEN_SERVER_TOKEN`。`--open-with-auth` 生成的 token 不会被 `daemon start` 持久化，因为 daemon start 没有生成 token 的路径；该场景留作后续。
- 没有 token 轮换命令；轮换通过 stop + 新 token start 完成。

## 验证

- 单测：命令注册、sidecar 写入/读取/删除、0600 权限、stop 清理。
- E2E：`start --save-token`、`daemon token`、`stop`，并确认 sidecar 已删除。
