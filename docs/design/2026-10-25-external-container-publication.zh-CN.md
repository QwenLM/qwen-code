# 外部容器 boot 与 publication

[English](2026-10-25-external-container-publication.md) | [简体中文](2026-10-25-external-container-publication.zh-CN.md)

## 范围与现状

这是 [#15512](https://github.com/QwenLM/qwen-code/issues/15512) 中继[阶段二设计](https://github.com/QwenLM/qwen-code/pull/15520)之后的 worker 侧步骤。容器模式此前接受 boot-v1 session worker 和专用 CSI profile，但拒绝普通 boot-v2。本次变更接受显式的 external-storage 扩展，并提供前台 publication。本地 boot-v2 和 CSI boot 文档仍使用各自独立的契约。broker、adapter、注册 HTTP API、provider probe 和 PUBLIC K8s 路径均不在本次范围内。

worker 仍为 session 隔离，沿用现有 workspace capability digest、context 安装和 activation 检查。publication 覆盖前台进程管道（`stdout` 和 `stderr`）；此 external profile 不接受 PTY、后台 Shell、monitor、hook 和 MCP 执行。adapter 和 broker 消费端属于后续工作；只有它们提供注册描述符、安装并激活 context、为每次 capture 调用 begin 后，此表面才会执行实际工作。

## 注册存储准入

容器 boot-v2 保留现有 context 字段，并严格增加：

```json
{
  "storage": {
    "kind": "external",
    "physicalKey": "physical-a",
    "aliasPath": "/external/workspace-a",
    "mountRoot": "/workspace",
    "registrationRevision": 1
  }
}
```

context 的 `mountRoot` 必须等于 storage 的 `mountRoot`。路径必须是规范化的绝对 POSIX 路径，不能为 `/`，不能包含点路径段、尾部分隔符或符号链接解析。标识符与路径段使用 ASCII 字母、数字、点、下划线和连字符，每段不超过 128 个字符，路径不超过 2048 个字符。revision 必须是正安全整数。

boot 不能通过字段自比证明注册。adapter 必须在启动 worker 前，在 workspace 之外、规范化且归 owner 所有的 `0700` boot 目录中写入同级 `registration.json`。这个 closed JSON 文档严格包含 `providerId`、`physicalKey`、`aliasPath`、`mountRoot` 和 `registrationRevision`。worker 要求它是归 owner 所有的普通 `0600` 文件，拒绝符号链接和额外硬链接，大小不超过 16 KiB，并严格解码 UTF-8。四个 storage 字段必须全部与 boot 相等。provider 身份来自这个可信 adapter 信道，boot 不独立选择 provider。

信任链是中心注册表 → broker storage provision → adapter durable journal → 私有描述符 → worker 比对。本 PR 只实现最后的读取与比对。描述符缺失、格式错误或不匹配时，用通用错误拒绝启动，不回退选择其他 physical key。worker 以 `0700` 创建缺失的 mount root，检查 owner 与读、写、遍历权限，在准入工具前固定其文件系统身份。后续 mount 检查拒绝目录替换或权限变化。注册内容和文件系统错误详情不会回显到响应。

## Publication 契约

external 准入成功后，在容器内启动普通 worker 监听端口 `43190` 和独立 publication 端口 `43191`。ready 回执增加 `publication: { url, paths }`。adapter 必须显式转发 publication 端口，它不是公开 HTTP 服务。普通监听器以及 v1、本地 v2 和 CSI worker 均不提供 publication 路径。

所有 publication 路由均为 POST，要求 `Cache-Control: no-store`、现有 bearer token 和 lease ID/epoch 请求头，并额外要求 `X-Qwen-Managed-Runtime-Incarnation` 与 `X-Qwen-Managed-Storage-Revision`。请求体为 closed JSON，上限 64 KiB；响应也保持在 64 KiB 以内。认证、revision 和 incarnation 失败不会返回存储身份或原始错误详情。

- `/internal/managed-runtime/v2/publication:begin`：`{ protocolVersion: 2, reference, capture, expiresAt }`。reference 和 capture 复用现有 Tool-v3 解析器及精确的 captured-input 身份。`expiresAt` 是经认证 broker 提供的绝对毫秒时间戳，必须仍在未来，重试时不能改变。响应包含不透明 `channelId`。每个 worker 最多安装 64 个前台 channel。同一 execution 和输入的重试返回原 channel，重新绑定则关闭式拒绝。
- `/internal/managed-runtime/v2/publication:read`：`{ protocolVersion: 2, channelId, streamId, sequence, acknowledgedSequence }`。stream 为 `stdout` 或 `stderr`。sequence 从零开始，acknowledgement 从 `-1` 开始，只能推进到已交付的 sequence。前台 capture finalize 前返回 `pending`，之后返回 `ready`，含 base64 字节与持久回执：channel、stream、sequence、长度、SHA-256 digest 和 EOF。每块不超过 32 KiB。EOF 是独立空 sequence。确认收到 EOF 时，重读该 sequence，并将 `acknowledgedSequence` 设置为 EOF sequence。停止后仍可重放旧 sequence。
- `/internal/managed-runtime/v2/publication:stop-drained`：`{ protocolVersion: 2, channel: "all" }`。封闭新执行与新 publication。未结束或未确认的 channel 返回 `undrained` 及 channel ID。每个 stream 的 EOF 都确认后，现有 executor retirement 检查要求结果已 committed acknowledgement，并证明进程组已停止。证明缺失或失败返回 `unknown`。成功 retirement 后，先持久化 worker 域的 stop 回执，再返回 `drained`；所有 channel lease 仍有效时，重试返回同一证明。

未知 channel、过期 publication lease、冲突输入或过时 Runtime 域均关闭式拒绝。到期不构成 drain 证明，即使已有 stop 证明，也拒绝到期后的重放。64 个 channel 的上限按 worker 整个生命周期计算；过期 channel 保留其证据，不会被静默回收。不会静默替换 channel，也不会回退为无 capture 执行。重启创建新的私有 publication 目录，不认识旧 channel，因此不能证明旧 channel 已排空。

## 存储与失败语义

publication 复用本地前台 capture、segment store、Session resource store 和 writer lease。begin、final、read、acknowledgement 与 stop 回执持久化在 boot 同级、workspace 之外的 worker 私有 `0700` 目录中；资源文件为私有文件，回执被确认前先完成同步写入。原始字节沿用现有本地 capture 上限。经认证的 read 端点会按契约交付捕获字节，不做脱敏或过滤。publication 元数据与错误响应不包含凭据、注册描述符或私有文件系统路径。

准入封闭后仍可重放读取。不完整 capture、未确认结果、物理停止状态不确定、存储失败及 lease 到期都不能转化为成功 drain。worker 在 executor 关闭后关闭两个监听器并释放本地 writer lease。保留的输出不会自动删除；保留策略和恢复属于后续 adapter/broker 集成。

## 验证与验收

| 验证手段                             | 可证伪的问题                                             | 限制                                   |
| ------------------------------------ | -------------------------------------------------------- | -------------------------------------- |
| 真实私有 boot 文件及文件系统检查     | 注册缺失或不匹配、不安全路径与权限、拒绝时错误创建 mount | 本地 POSIX 文件系统，不是生产 sandbox  |
| 真实 HTTP 监听器                     | 端口隔离、认证和过时 lease/revision/incarnation 拒绝     | 不含 adapter 转发                      |
| 真实子进程和本地持久 capture         | 二进制 stdout/stderr 完整性、有界重放、显式 EOF 确认     | 仅前台进程管道                         |
| 真实 executor 和进程 ledger          | 结果确认前不能 drain；持久且可重放的 stop 证明           | 不含 broker Session 事务或崩溃恢复 E2E |
| 现有 container、worker、Tool-v3 套件 | 已有 worker profile 的回归                               | 完整跨平台 CI 单独运行                 |

验收要求 external boot 只在注册匹配后成功、输出为私有存储、读取字节准确且有界，以及未知、过期和 drain 路径关闭式失败。Linux 容器与真实 adapter E2E 验证仍为后续集成工作。Windows 不接受这个 POSIX external-storage profile。
