# Daemon 频道运行时控制

[English](daemon-channel-runtime-control.md) | [简体中文](daemon-channel-runtime-control.zh-CN.md)

## 概述

为 daemon 管理的频道 worker 增加运行时目标状态控制。daemon 可以不带
`--channel` 启动，然后在不重启 daemon 的情况下启用、替换、查看、重载和停止
频道选择。运行时变更不会持久化。下次 daemon 启动优先使用显式 `--channel`，
否则恢复可信主 workspace 的 `serve.channels`；两者都没有时保持禁用。

控制层位于按 workspace 分组的 worker 实现之上。它负责已提交的频道选择，
串行执行生命周期变更，保留归 serve 所有的频道服务租约，并仅协调有序频道选择
发生变化的 workspace 分组。

## 公开契约

`GET /workspace/channel` 返回已提交的选择、可选的待处理选择、当前状态转换，
以及带 workspace 信息的 worker 快照。

`PUT /workspace/channel` 接受：

```json
{ "selection": { "mode": "names", "names": ["telegram", "feishu"] } }
```

或 `{ "selection": { "mode": "all" } }`。按名称指定的选择会去除首尾空白并
去重，但不会排序。空选择无效。在多 workspace 模式下，`all` 仍仅限主 workspace。

`DELETE /workspace/channel` 幂等地禁用运行时选择。
`POST /workspace/channel/reload` 仍然可用，并为已提交的选择重新读取设置。
变更操作采用严格的操作员权限检查。

`channel_control` 能力声明该资源可用。只有 manager 持有已提交且可重载的选择时，
才会继续声明 `channel_reload`。

## 生命周期

manager 提供不可变快照，所有变更通过同一个 FIFO 队列执行。更新选择时，先验证
workspace 归属和信任，再停止 worker。未变化的 workspace 项保留；发生变化和被
移除的项先停止，再启动替代项，期间 daemon 始终持有全局频道服务租约。

如果替换失败，manager 会尝试停止新启动的项并重新启动原有项。客户端需要检查
`rolledBack`、`rollbackError` 和 `state`，因为清理或恢复也可能失败。在发送
SIGKILL 后仍无法确认子进程退出属于硬停止失败：supervisor 保留子进程引用，
manager 保留服务租约，并且不会启动替代 worker。

worker 回调携带代际标识。被替换项的回调可以记录日志，但不能更新当前 pidfile
或路由状态。成功提交会一起切换选择、webhook 配置和 worker 映射，然后重写
完整的 pidfile 快照。

适配器部分连接保留既有行为：只要至少一个请求的频道连接成功，worker 就达到
ready 状态。控制结果报告 `partial`，daemon 状态继续发出
`channel_worker_partial_connect`。

## 兼容性

启动时的 `--channel` 使用同一个 manager，并保留监听前预留租约和 worker
ready 后才报告启动成功的行为。不带频道参数启动时，daemon 从可信主 workspace
恢复 `serve.channels`。启动选择使用持久化的文件夹信任设置；worker 启动前会
再次检查 workspace 归属和信任。次级 workspace 不会各自自动恢复自己的设置。
没有显式或持久化选择时，daemon 直到首次运行时变更才会预留频道服务或加载较重的
频道 runtime。

持久化启动名称必须非空、没有首尾空白，且不含不安全的控制字符或不可见字符。
非法条目会逐项跳过，并按数组索引记录日志。启动过程不会去除这些名称的空白后
将其解释为其他实例，也不会改写持久化配置。worker 以 `--channel=<value>`
接收每个名称，因此开头的短横线仍属于名称值。

启动字段无效，或 worker 启动前发生验证或租约错误时，daemon 会跳过自动恢复，
并记录标明 `serve.channels` 来源的日志；无关设置继续生效。worker 启动失败后，
只有清理成功才允许 daemon 继续运行。全局 runtime 启动超时，以及无法确认 worker
停止的情况，保留既有的启动失败行为。worker 终止尚未确认时，服务租约继续保留。

频道管理报告持久化的启动设置和实际运行时状态。通过 daemon 日志诊断跳过或失败
的自动恢复；这些失败不会用保留的启动失败快照替代已配置实例或启动开关。

既有 `runtime.channelWorker`、分组后的 `runtime.channelWorkers`、pidfile
字段、独立的 `qwen channel start` 和 `qwen channel reload` 保持兼容。新的 CLI
控制通过 `qwen channel set` 以及远程 `stop` 和 `status` 变体提供。
