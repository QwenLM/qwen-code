# Daemon 频道运行时控制

[English](daemon-channel-runtime-control.md) | [简体中文](daemon-channel-runtime-control.zh-CN.md)

## 概述

为 daemon 管理的频道 worker 增加运行时目标状态控制。daemon 可以不带
`--channel` 启动，然后在不重启 daemon 的情况下启用、替换、查看、重载和停止
频道选择。运行时变更不会持久化。下次 daemon 启动优先使用显式 `--channel`，
否则恢复每个可信已注册 workspace 各自的 `serve.channels`；两者都没有时保持禁用。

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
ready 后才报告启动成功的行为。不带频道参数启动时，daemon 从每个可信已注册 workspace
恢复 `serve.channels`，各自贡献本 workspace 作用域设置里的名单。启动选择使用
持久化的文件夹信任设置；worker 启动前会再次检查 workspace 归属和信任。名字由
哪个 workspace 列出，就在归属本来有歧义时判给它，并在 daemon 整个生命周期内
一直按此判定，所以停掉后再启用仍然落回启动时那个 workspace；只由非主 workspace
贡献的名字若解析不了，只记日志跳过，而不是让整份恢复失败，而主 workspace 列出的
名字仍然会让整份恢复失败。`all` 仍然只对主 workspace 生效，配在别处会被跳过并记录。
启动后才注册进来的可信非主 workspace 也会恢复自己的名单，不占着注册请求，且只在
本 daemon 第一次见到它时做一次——只要它要了任何名字就记下——因为之后的移除重注册、
或信任重新物化，都不能撤销操作者在这期间停掉某个频道的决定。晚恢复逐个执行，每次
以一次变更把该 workspace 的名字并入已提交选择，因此与启动不同，一个无法归属的名字
会让该 workspace 整份名单都不恢复；没起来的每个名字都会按下文所述被报告。`DELETE /workspace/channel` 停掉托管之后，注册
不恢复任何东西——注册一个 workspace 不等于要求把托管重新打开，要等一次提交成功的
`PUT /workspace/channel` 或下次启动。这个停止是在发生处记录的：从未托管过任何东西的
manager 与被停掉的 manager 状态相同，靠状态分辨不出来。显式 `--channel` 选择不会被
之后注册的 workspace 扩充，已提交的 `all` 选择保持原样。注册不在频道控制队列上等待：
晚恢复与对已托管频道的对账都只是排进队列，钩子随即返回，所以一个永远就绪不了的
worker 只会拖住排在它后面的频道工作，不会拖住另一次注册或信任对账（两者共用一个
daemon 级闸门）。队列自己保证这些工作的先后，晚恢复在队列内计算要新增的名字，所以
每一次都建立在上一次提交的结果之上。没有显式选择、持久化选择，或上面这种注册时，daemon 直到首次运行时
变更才会预留频道服务或加载较重的频道 runtime。

持久化启动名称必须非空、没有首尾空白，且不含不安全的控制字符或不可见字符。
非法条目会逐项跳过，并按数组索引记录日志。启动过程不会去除这些名称的空白后
将其解释为其他实例，也不会改写持久化配置。worker 以 `--channel=<value>`
接收每个名称，因此开头的短横线仍属于名称值。

启动字段无效，或 worker 启动前发生验证或租约错误时，daemon 会跳过自动恢复，
并记录标明 `serve.channels` 来源的日志；无关设置继续生效。worker 启动失败后，
只有清理成功才允许 daemon 继续运行。全局 runtime 启动超时，以及无法确认 worker
停止的情况，保留既有的启动失败行为。worker 终止尚未确认时，服务租约继续保留。

频道管理报告持久化的启动设置和实际运行时状态。启动恢复丢掉的 `serve.channels`
名字、以及晚恢复没能拉起的名字，也会被报告，而不只是记日志：它们从未进入已提交
选择，没有任何 worker 快照带着它们，频道列表原本会把它们显示为 `stopped`。daemon
在内存里按 workspace 与频道记下这些失败；频道列表把这样的频道报告为 `error`，
`lastError` 即记录的错误，daemon 状态为每个 workspace 发出一条
`channel_restore_failed` 警告。记录只影响运行时状态：已配置实例和启动开关仍从
设置读取。操作者对该频道或整份选择有所动作、或该 workspace 被移除时，
记录即清除。

既有 `runtime.channelWorker`、分组后的 `runtime.channelWorkers`、pidfile
字段、独立的 `qwen channel start` 和 `qwen channel reload` 保持兼容。新的 CLI
控制通过 `qwen channel set` 以及远程 `stop` 和 `status` 变体提供。
