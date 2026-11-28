# 重新绑定原外部 Workspace Worker

[English](managed-external-reattach.md) | [简体中文](managed-external-reattach.zh-CN.md)

## 问题与方案

Provider 重启可能丢失进程内绑定，而持久记录对应的外部 Worker 仍存在。观察到 UNKNOWN 不能证明 Worker 已消失，也不能因此创建下一代 Worker。常驻外部 Workspace 可以显式重新绑定已保存的原环境，携带其启动文档、作用域、provider handle 和 endpoint。

客户端在现有具备认证及大小限制的 HTTP transport 中增加 reattach 操作。通用外部 provisioner 默认关闭重新绑定，仅常驻 Workspace profile 启用。响应沿用现有观测及所有权校验；endpoint 变化会被拒绝，重新绑定路径不会进入创建流程。

## 兼容性与验证

本次更新补充常驻外部 Workspace 方案。外部 runtime client SPI 的实现方需要实现新增 reattach 方法；使用常驻重新绑定前，provider 需要支持对应端点。Scratch 的观察失败语义保持不变。

评审需要覆盖 UNKNOWN 后在同一 endpoint 返回 READY、原环境证据不匹配、拒绝和超时，以及 scratch 不进行重新绑定。保留的 HTTP、provisioner、启动和所有权回归源码仍需公开分支最新提交的 CI；不声称本地运行或测试通过。
