# 后台 Agent runtime generation

[English](background-agent-runtime-generations.md)

## 问题

后台 Agent 在取消后仍不结算时，其 ACP child 可能仍能响应传输探测，却已经不适合接收新工作。替换该 child 时不能移动它现有的 Session、无限创建 child，也不能把新工作重新路由到正在排空的 generation。

## 设计

每个 ACP bridge channel 处于 `active`、`draining` 或 `dying` 三种状态之一。已有 Session 在排空期间继续通过自己记录的 channel 路由。只有显式 recycle 请求会把受影响的 generation 标记为 `draining`，新工作随后创建新的 active generation。已有的超时退役路径保持原先的“排空后回收”行为，不会启动另一代 runtime。

新工作最多允许两个尚未 dying 的 generation。若两者都在 draining，admission 返回 `503 runtime_recycling`，直到其中一个退出。restore 和 recycle recovery 可以在 dying 进程等待回收时启动替代进程；dying generation 会持续被追踪到 channel 退出，保证同步 shutdown 仍可访问它们。

逻辑看门狗中止后，Agent 有固定 5 秒的协作退出时间。若仍未结算，registry entry 与 sidecar 只会被标记失败一次，而底层 run 继续占用并发槽。终态通知在不启动额外模型 turn 的情况下记录并展示，随后可信的 child-to-daemon route 请求回收该 Session 的 owner generation。迟到的 Agent 结算会释放物理槽，但不会覆盖已经发布的失败终态。

本设计不改变 Session 持久化格式，也不增加公开的超时配置。
