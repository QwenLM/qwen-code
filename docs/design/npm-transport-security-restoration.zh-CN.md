# npm 传输依赖安全修复续接

[English](npm-transport-security-restoration.md) | [简体中文](npm-transport-security-restoration.zh-CN.md)

## 问题与范围

PR #13169 升级了有漏洞的传输依赖，但早于当前工作区布局，旧 CI 结果不能验证与当前 main 合并后的代码。合并锁中的钉钉和飞书 importer 含有悬空 undici 引用。独立 CUA agent 示例也保留旧 MCP 依赖，并将当前 0.27.0 的本地 SDK 元数据错误记录为 0.20.11。

本次保留作者的 axios 1.20.0、@grpc/grpc-js 1.14.5 目标，恢复与 main 的兼容并升级独立示例。不修改传输实现、认证或应用行为。

## 决策

工作区 7.x 依赖图统一使用 undici 7.30.2，并在 Core、CLI、钉钉、飞书、external-context 及其可复制 provider 示例中声明 ^7.30.2。旧目标 7.30.0 受后续公告影响，包括在 7.30.1 修复的 [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) 和 [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26)。7.30.2 保持当前主版本且满足现有包龄策略。npm、pnpm overrides 保持一致；发布包的使用者必须解析自己的锁，不继承仓库根 overrides。

保留 main 的 MCP、Zod 和 fast-uri 精确安全下限。不恢复已删除的 CUA TypeScript npm 锁，该包现已归属 pnpm 依赖树。重新生成两个锁图，不能只消除冲突标记。

独立 CUA agent 示例使用 Zod 4.6.6、MCP SDK 1.32.2、@hono/node-server 1.19.19、Hono 4.13.18、body-parser 2.4.0、qs 6.17.1、fast-uri 3.1.9、ip-address 10.7.4。保留 node-server 官方 1.x 安全回补以及原第三方 agent SDK 版本。从真实本地 SDK 清单刷新元数据。这些是 #17099 已确定的目标，不能据此认定历史发布包已被替换。

## 消费者与约束

Undici 覆盖 Core 下载、代理/fetch 工具、IDE/图像传输、CLI 预连接和安装/更新路径、channel 传输及 provider 代理分发。Axios 经飞书、企业微信和钉钉 SDK 引入。grpc-js 经 OTLP gRPC exporter 和 A2A SDK 的可选 peer 引入。CUA 示例位于工作区之外，需要独立干净安装及类型检查。

依赖升级不扩展成产品重构。保留 main 的 CI 门禁和 Java 布局，不为过期失败臆造 CI 绕过。不得放宽包龄检查。模型凭据、原生 GUI 操作及其他操作系统属于独立验证边界。

## 验证与验收

要求工作区冻结安装通过且没有悬空 importer 引用，完成锁检查、构建、bundle、类型检查、相关 lint 和生成 notices。运行实际消费者对应的传输、channel、遥测及 A2A 测试，并执行本地 HTTP/重定向和一元 gRPC 集成对照。检查实际解析版本，不能只依赖清单意图。

要求 CUA 示例独立安装、当前本地 SDK 构建、示例类型检查以及无需凭据的 MCP 传输/schema 冒烟验证。对照 main 记录 audit 变化和剩余项。高危门禁通过不等于 audit 清零、发布、部署或原扫描闭环。

状态：实现与验证进行中。仍需新 head 的 PR CI、评审和合并；历史 CI 与评审不是新 head 的通过证据。
