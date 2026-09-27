# Managed Runtime 进程接管

[English](2026-09-23-managed-runtime-process-adoption.md) | [简体中文](2026-09-23-managed-runtime-process-adoption.zh-CN.md)

状态：已实现。更新日期：2026-09-24。承接[attestation 客户端](2026-09-23-java-runtime-attestation-client.zh-CN.md)。

## 本切片

Broker 启动 worker 进程，证明通过之后才把 lease 记为 READY。之后再次在 _binding_ 入口使用这条内存中的 lease（`warm`、`acquire`）时，会通过 `RuntimeProvisioner.confirm` 重新证明；证明失败则让该 binding 失效并释放它的 lease，下一次调用会重新 provision 一个新的 worker，而不是对着一条死记录永远重试，也不会让被拒绝的 worker 继续监听。

承载流量的 session 级动词（`dispatch`、`control`、`cancel`、`releaseSession`）不按调用重新证明。它们在使用 lease 之前先做一次廉价的本地存活检查（`RuntimeProvisioner.isUsable`，即 provisioner 的 owned 表加 `isAlive()` 查询）；进程已死则同样让 binding 失效，使后续调用重新 provision。worker 已经死亡的 session，其 `release` 在本地完成：仍有未结算执行时返回 `runtime_session_busy`，否则把 session 置为 `RELEASED`，不再调用 transport。只有 binding 入口做 HTTP 身份验证。ready 记录里的 `url` 必须是 `127.0.0.1` 上的 `http`，也就是 worker 唯一会绑定的地址；其它 origin 视为无效 ready 记录，不会收到 bearer token。

在接管进程之后才丢掉认领权的 provision 调用（`runtime_provision_fenced`）会经由 `RuntimeProvisioner.release` 释放这条 lease，被 fence 的尝试不会遗留运行中的 worker。关闭 service 会连带关闭构造时传入的 provisioner。

worker 使用已经合入的 `managed-runtime-worker`：标准输入一份 boot JSON，标准输出一条 ready 记录。不使用预览里的 `--boot-config` 文件启动。ready 记录的读取有上限（32 KiB），并且 worker 的 stdout 在其整个生命周期内保持打开并持续排空，因为 worker 把 stdout 管道关闭视为致命错误。

Java 客户端提供工具 HTTP（`POST /internal/managed-runtime/v2/execute`）。已经合入的 worker 仍然只暴露 attestation，所以对这个进程执行工具会得到不可重试的 404。真正的工具处理留在 Hosted 普通工具那一笔。

## 不在本切片

session 级动词上的按调用 HTTP 重新证明：只有 binding 入口做 attestation，动词只做本地存活检查。Broker 进程崩溃仍可能让 worker 变成孤儿，这需要 worker 侧监视父进程。`stop` 和 `close` 仍然只发送 SIGTERM，不会升级到 SIGKILL。Spring 配置和 Flyway 跟 Java 控制面模块走，那个模块还不在 `main` 上。Kubernetes provisioner 不包含在内。本切片使用现有的内存和 JDBC Repository，不新增服务器。
