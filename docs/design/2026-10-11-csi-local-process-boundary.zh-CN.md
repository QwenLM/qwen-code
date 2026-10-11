# 私有 CSI 文件能力的本地进程边界

[English](2026-10-11-csi-local-process-boundary.md) | [简体中文](2026-10-11-csi-local-process-boundary.zh-CN.md)

## 问题和范围

私有 `csi-files-retirement/1` 能力预留给专用 Kubernetes worker。本地进程
provisioner 不能为此能力解析存储、启动或接管子进程、修改持久注册、观察运维
终止证据或释放进程。只检查 provisioner kind 不够：调用者可以在本地进程请求
或另一种隔离类型中提交这个预留摘要。

本改动从 PR #13526 独立拆出，定义已有的能力身份并关闭 Java 本地进程入口。
Kubernetes 执行、Node worker 准入、SQL Session pin、恢复、CSI unpublish
和卷复用仍是后续独立工作。

## 决策和契约

保留原始能力 manifest 和 SHA-256 摘要。能力请求保留规范 Session UUID
隔离、Workspace generation 和存储身份、根相对工作目录以及规范绝对挂载根。
已有请求编码继续与 Broker 兼容。

本地 provisioner 在解析存储、两个 provision 重载、资源创建或接管、
reconciliation、confirmation、运维注册或停止观察、release 之前检查能力。
命中时返回不可重试的 HTTP 409 `runtime_provision_failed`，同时覆盖
`session` 和 `workspace` 隔离。异步操作返回失败的 completion stage。
普通能力继续走已有路径。

本改动不增加路由、schema migration、worker 协议或公开选择入口。摘要检查
不建立 native authority，也不授予退役权限。后续 native 接入必须保留这些
本地拒绝行为。

## 验证和验收

用相同预留能力对比当前主干和本拆分分支。确认拒绝发生在存储 resolver 调用、
子进程 marker 创建以及持久目录条目变更之前。覆盖内存和持久 provisioner、
两种隔离类型、两个 provision 重载、已有和缺失资源 handle、reconciliation、
confirmation、运维观察和 release。固定 manifest 摘要，拒绝不规范的能力
请求身份。已有普通本地进程和持久 worker 测试必须继续通过。

验收要求在拆分分支上完成定向 Java 测试、Checkstyle、SpotBugs、打包、根目录
build/typecheck、独立验证和完整 diff 自审。这些检查只证明 Java 本地边界；
真实 Kubernetes 或 CSI 生命周期资格不在本 PR 范围内。
