# 私网服务的 Hosted Harness 传输配置

[English](2026-11-26-hosted-harness-transport.md) | [简体中文](2026-11-26-hosted-harness-transport.zh-CN.md)

## 部署场景

控制面与 Hosted Harness 可以分别运行在由同一团队管理的私网 Pod 中。默认配置让 Harness 监听回环地址，并要求通过 HTTPS 访问远端 Runtime Broker。若服务间使用明文 HTTP，部署方通常需要入站代理来访问 Harness，还需要出站代理给 Broker 提供回环地址。接受该网络内明文传输的运维方应能让服务直接通信。[Issue #18409](https://github.com/QwenLM/qwen-code/issues/18409)

## 启动参数

| 进程与连接方向                  | 参数（默认值 `true`）                             | 设为 `false` 时的行为                                                                           |
| ------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node，Harness 入站监听          | `--hosted-harness-require-loopback`               | 监听 `--hostname` 显式指定的地址，包括 Pod IP 或 `0.0.0.0`。默认地址仍为 `127.0.0.1`。          |
| Node，Harness → Broker 出站连接 | `--managed-runtime-broker-require-tls`            | 启动和调用工作区工具时都接受符合格式要求的远端 HTTP Broker 源地址。                             |
| Java，MA → Harness 出站连接     | `--qwen.managed-agent.harness.require-remote-tls` | 允许通过远端 HTTP 访问单个 Harness 或池成员。使用远端 HTTPS 的池成员仍使用配置的双向 TLS 身份。 |

两个进程分别读取自己的启动参数。Node CLI 接受字面值 `true` 和 `false`。若 `localhost` 意外解析到非回环地址，Harness 仍拒绝启动。无论监听哪个地址，Harness 都要求配置 bearer token 和 capability digest。HTTPS 仍验证证书。选用远端 HTTP 意味着工作负载之间的网络可以读取或更改请求，包括服务凭据。

内置的 `managed-local` 部署要求所有 Harness 端点（包括池成员）使用回环 HTTP。

## 实现与验证

serve 命令把两个值交给 Hosted Harness 的启动校验。Broker 客户端在构造实际工具请求时使用同一项设置。共用 URL 解析器的其他客户端沿用严格默认值。Java 在启动、预检和发现池成员时使用 Harness 传输策略。Java 预检可以读取共享凭据文件，但无法获知远端 Node 进程的启动参数。

用打包后的 CLI 分别验证省略两个参数、分别将一个设为 `false`、将两个都设为 `false`。检查默认配置会拒绝通配符监听地址和远端 HTTP Broker，缺少凭据的请求会被拒绝，携带凭据的工具调用能通过 HTTP 收到 Broker 的结果。用 Java 启动参数验证单端点、池成员以及启动后发现的池成员。[部署示例](../../packages/managed-agent-server/README.md#private-service-connections)
