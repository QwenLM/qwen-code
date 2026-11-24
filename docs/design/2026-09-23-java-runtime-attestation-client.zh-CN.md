# Java Runtime Attestation Client

[English](2026-09-23-java-runtime-attestation-client.md) | [简体中文](2026-09-23-java-runtime-attestation-client.zh-CN.md)

状态：已实现。更新日期：2026-09-23。前置契约见[身份证明契约](2026-09-22-managed-runtime-attestation-contract.zh-CN.md)。

## 问题

预览分支 `feature/managed-agents-p0-p8` 已经在 `HttpRuntimeTransport.attest` 里向 `/internal/managed-runtime/v2/attest` 发送请求并解析 `RuntimeAttestation`。这份实现和 prepare、execute、cancel、release 写在同一个类里，响应上限是 8 MiB，也还没有按已经合入的共享 fixture 校验 16 KiB 和失败分类。当前 `main` 的 worker 会拒绝缺少 `Cache-Control: no-store` 的请求。

## 本切片

从预览摘出 attestation 调用，保留原来的入参：`RuntimeLease`、`RuntimeProvisionRequest` 和 `RuntimeProvisionSeed`。请求体仍然带上协议版本、provision request 和 workspace scope。

相对预览，只加已经合入契约所要求的约束：

- 请求带 `Cache-Control: no-store`，否则已合入的 worker 会直接拒绝。
- 响应体上限改为路由契约里的 16 KiB，不再沿用工具调用的 8 MiB。
- `401/403`、`400/413`、`409`、`404/405` 按共享 fixture 分类，并且都不可重试。连接失败和 `5xx` 仍可重试。
- 成功响应必须是闭合对象。身份是否与 lease、seed 的 gateway incarnation、scope、provision request 一致，沿用预览 Broker 里的 `validAttestation` 比较；不一致则拒绝，不把证明交回调用方。

## 非目标

不实现 prepare、execute、cancel、release，也不把 `attest` 加进 `RuntimeTransport`。不修改 `RuntimeBrokerService`，不做 reconcile、数据库 CAS 或进程内 ready gate，不接入 Spring/Flyway，不启动 TypeScript worker。`RuntimeProvisionSeed` 只保留身份字段，持久化编码留到 reconcile。

## 验证

测试读取 `managed-runtime-attestation-v2.fixtures.json`。成功用例核对实际发出的 path、Authorization、`no-store` 和 body。每个 fixture 的预期 status 都经过同一次响应解析。身份不一致、超限响应、404 和可重试的 503 另有失败用例。
