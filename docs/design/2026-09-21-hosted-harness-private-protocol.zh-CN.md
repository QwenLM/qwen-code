# Hosted Harness 私有协议

[English](2026-09-21-hosted-harness-private-protocol.md) | [简体中文](2026-09-21-hosted-harness-private-protocol.zh-CN.md)

## 状态

本文定义已经实现的协议基础。在 `qwen serve` 部署中启用它、通过 `/capabilities` 发布它，以及连接 Java Runtime Broker，仍属于后续工作。

## 问题

Java 控制面将通过私有 Session 路由调用长期运行的 qwen Hosted Harness。普通 bearer token 可以认证调用方，但不能证明双方对私有协议、部署 capability 集合或当前 Harness 进程代际达成一致。缺少显式协议时，客户端可能继续向已经重启或不兼容的 Harness 发送工作，并把另一个内存代际误认为原来的所有者。

## 目标

- 为 Java 到 Harness 的 Session 流量定义一个带版本的私有协议。
- 为每个 Harness 进程代际提供全新且不持久化的 boot identifier。
- 使用规范的 SHA-256 digest 表示部署 capability 集合。
- 当版本或进程代际不匹配时，以稳定的 HTTP 状态和错误码 fail closed。
- 保持该协议与 Runtime Broker transport 和 server profile 接线相互独立。

## 非目标

- 本次变更不增加 Hosted Harness CLI profile 或环境变量。
- 本次变更不在 `qwen serve` 中挂载 middleware，也不改变普通 Session 路由。
- 本次变更不实现 Java client、Runtime Broker、Session recovery 或公共 Agent API。
- 本次变更不定义动态的 per-session agent configuration。协议 v1 描述单个部署级 capability 集合。

## 协议信封

部署系统针对可用的 agent configuration、model routing、tool allowlist 和 policy revision 生成 canonical JSON，再把它的 SHA-256 digest 提供给后续 Hosted Harness profile。qwen 进程只校验 `sha256:<64 lowercase hex characters>` 表示形式，不读取源配置，也不把 secret 纳入 digest。

Harness 在进程启动时创建 RFC UUID v1-v5 `bootId`，默认生成器产生 UUID v4。该标识在协议信封中使用小写，每次进程启动都会改变，并且永不持久化。Capability 信封结构如下：

```json
{
  "protocolVersions": { "current": 1, "supported": [1] },
  "bootId": "c3ea0f85-7c21-43c0-9705-ce127416587a",
  "capabilityDigest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

## 请求 fencing

后续 Hosted Harness profile 只在私有 `/session` 路由上挂载协议 middleware。每个请求发送 `X-Qwen-Harness-Protocol-Version: 1`，以及 capability negotiation 返回的 `X-Qwen-Harness-Boot-Id`。每个受保护响应都返回当前 `X-Qwen-Harness-Boot-Id`，包括失败响应和 SSE 响应。

校验按以下顺序执行：

| 条件                               | HTTP 状态 | 错误码                               |
| ---------------------------------- | --------: | ------------------------------------ |
| 缺少协议版本或版本不受支持         |       426 | `hosted_harness_protocol_required`   |
| 缺少 boot ID 或格式错误            |       400 | `invalid_hosted_harness_boot_id`     |
| boot ID 格式正确但属于另一进程代际 |       409 | `hosted_harness_generation_mismatch` |

426 响应还返回 `Upgrade: qwen-hosted-harness/1`。版本和 boot ID 匹配时，请求继续进入 Session 路由。UUID 文本不区分大小写，因此比较也不区分大小写，但发布的标识始终保持小写。

## 所有权与安全

Boot ID 是进程代际 fence，不是认证 secret 或公共标识。后续 Hosted Harness profile 仍必须启用 bearer authentication，并在私有 Session 操作之前完成认证。Capability digest 不是 credential；它把 admission 固定到控制面选择的部署 capability。两个字段都不能从模型请求中接受，也不能通过公共 Agent API 暴露。

## 集成边界

本基础层导出协议创建、digest 校验和 Express request handler。本次变更刻意不增加 production caller。下一条 Hosted Harness profile 变更必须在 listener 接受流量前只创建一次协议对象，在 bootstrap 与 steady-state capabilities 中复用同一对象，并且只在 bearer authentication 之后为私有 Session 路由挂载 handler。普通 `qwen serve` 部署必须保持不变。

## 验证

聚焦单元测试覆盖协议信封创建、随机 boot ID、严格 digest 格式、版本协商、非法和过期 boot ID、成功匹配请求、响应 header，以及 middleware mount point 之外路由的隔离性。

## 验收标准

- 创建协议时拒绝格式错误的 capability digest 和 boot ID。
- 一个协议对象只具有一个稳定的小写 boot ID，协议版本为 1。
- 请求 fence 缺失或不兼容时，以文档定义的稳定状态和错误码失败。
- 匹配的请求可以到达下游路由。
- 后续私有 mount point 之外的路由保持不变。
- 在后续 profile 接线完成之前，不发布或启用 Hosted Harness 模式。
