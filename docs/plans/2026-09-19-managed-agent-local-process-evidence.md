# Managed Agent 本地完整进程运行链路证据

状态：本地 Hosted Harness 运行切片通过；E4 整体部分通过

验证日期：2026-09-19（Asia/Shanghai）

关联方案：[Managed Agent 公共 Agent API 适配层执行方案](./2026-09-18-managed-agent-public-api-adapter.md)

## 1. 结论

从当前源码重新执行 `npm run build && npm run bundle` 后，以真实独立进程和真实本地 HTTP 运行 Hosted
Harness、Java Runtime Broker fixture、Managed Runtime Worker 与 Java SDK 客户端。四个场景全部通过：

| 场景                                       | 结果                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 冷 Runtime + 同轮续跑 + execution 响应丢失 | 首个模型事件 `278 ms`，Runtime ready `15518 ms`，Turn 完成 `16607 ms`；物理执行 1 次，并从一次丢失响应恢复 |
| Runtime ready 前取消                       | 首个模型事件 `265 ms`，取消请求 `268 ms`，Runtime ready `15553 ms`；物理执行 0 次                          |
| 物理 Tool 启动后取消                       | execution 启动 `1350 ms`，取消请求 `1409 ms`；物理执行 1 次、物理取消 1 次，进程树和延迟副作用被清理       |
| 两个 Hosted Session 隔离                   | 2 个 logical Session、2 次独立 acquire、2 次物理执行，共享 1 次物理 provision                              |

第一条链路直接证明本方案的核心时序：模型 TTFT 不等待冷 Runtime；同一轮在 Runtime ready 后继续执行
Tool，而不是要求用户发第二轮；丢失 Broker execution 响应也没有造成第二次物理副作用。

## 2. 进程与边界

本门禁使用的不是单元 mock：

- `dist/cli.js` 以 `hosted-harness` profile 启动独立 Harness 进程；
- `dist/managed-runtime-worker.js` 启动独立 Runtime Worker 进程；
- Java Runtime Broker fixture 是独立 JVM 和真实 HTTP 服务；
- Java SDK 通过 Hosted Harness 的真实 HTTP/SSE 接口创建 Session、提交 Prompt、消费事件并取消；
- Runtime 通过工作区文件写入形成可观察副作用；主动取消用父子进程树和延迟写入验证清理。

模型端使用本地 fake OpenAI server，Runtime provisioning 使用可控本地 Broker fixture。因此该门禁证明进程、
协议、时序、重放、幂等和清理语义，但不证明供应商模型网络、产品 Java `LspApplication`、真实登录鉴权、
BFF/反向代理或 DataAgent/ACS 调度。这些仍属于 E3/E4 的环境验收。

## 3. 可重复执行

```bash
npm run build && npm run bundle
npx tsx scripts/run-managed-hosted-runtime-e2e.ts
npx tsx scripts/run-managed-hosted-runtime-e2e.ts --cancel-before-ready
npx tsx scripts/run-managed-hosted-runtime-e2e.ts --cancel-after-start
npx tsx scripts/run-managed-hosted-runtime-e2e.ts --two-sessions
```

本轮四个 Java SDK 测试均为：

```text
Tests run: 1, Failures: 0, Errors: 0, Skipped: 0
BUILD SUCCESS
```

四个场景分别产生 3、1、1、6 次模型请求，符合脚本的最小请求数和恢复断言。所有临时工作区、Harness
home、Runtime home、状态目录和子进程都由脚本在退出时清理。

## 4. E4 剩余验收

- 用完整产品 Java 和真实鉴权链路替换 Java fixture；
- 用 DataAgent/ACS Tool Runtime 替换本地进程 provisioner，执行冷启动、超时、invalid ready 和三个
  provision crash window；
- 验证 Java、Harness、Runtime 各自重启以及 SSE 断流续传；
- 执行 delete/close、idle detach/reattach，保存 binding、lease、进程残留和 trace 证据；
- 在真实 Tool 上以 `executionCallId` 证明重试最多产生一次业务副作用。

在这些环境项完成前，E4 仍为“部分通过”，生产开关继续保持关闭。
