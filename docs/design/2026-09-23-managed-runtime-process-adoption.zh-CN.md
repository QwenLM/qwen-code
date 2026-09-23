# Managed Runtime 进程接管

[English](2026-09-23-managed-runtime-process-adoption.md) | [简体中文](2026-09-23-managed-runtime-process-adoption.zh-CN.md)

状态：已实现。更新日期：2026-09-23。承接[attestation 客户端](2026-09-23-java-runtime-attestation-client.zh-CN.md)。

## 本切片

Broker 启动 worker 进程，证明通过之后才把 lease 记为 READY。之后再次使用这条内存中的 lease 时会重新证明。进程已经不在时，调用失败，不再复用旧 endpoint。

worker 使用已经合入的 `managed-runtime-worker`：标准输入一份 boot JSON，标准输出一条 ready 记录。不使用预览里的 `--boot-config` 文件启动。

Java 客户端提供工具 HTTP（`POST /internal/managed-runtime/v2/execute`）。已经合入的 worker 仍然只暴露 attestation，所以对这个进程执行工具会得到不可重试的 404。真正的工具处理留在 Hosted 普通工具那一笔。

## 不在本切片

Spring 配置和 Flyway 跟 Java 控制面模块走，那个模块还不在 `main` 上。Kubernetes provisioner 不包含在内。本切片使用现有的内存和 JDBC Repository，不新增服务器。
