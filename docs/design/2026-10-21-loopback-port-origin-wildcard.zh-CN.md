# `--allow-origin` 的 loopback 端口通配

[English](2026-10-21-loopback-port-origin-wildcard.md) | [简体中文](2026-10-21-loopback-port-origin-wildcard.zh-CN.md)

- 状态：已实现
- 日期：2026-10-21
- Issue：[#14939](https://github.com/QwenLM/qwen-code/issues/14939)

## 问题

桌面端由自带的 daemon 在 `http://127.0.0.1:<操作系统分配的端口>` 提供 Web Shell。
因此它对远程 `qwen serve` 的每个请求都是跨源的，且页面 origin 每次启动都会变化。
`--allow-origin` 按规范化 origin 精确匹配，任何固定条目都无法命中该 origin。使用静态条目时，
每个 `OPTIONS /capabilities` 预检都返回 `403`，连接门无限重试。

`--allow-origin '*'` 能打通 REST，但打不通 WebSocket 升级门——后者有意忽略任意源字面量。
所以终端和语音通道即使在 `*` 下也不可用。在此改动之前，没有任何配置能让桌面端的远程 daemon 流程工作。

## 当前行为

- `parseAllowOriginPatterns` 只接受 `*` 或规范化 origin，并按 scheme、host、port 的完整字符串精确匹配。
- CORS 墙之前有两个剥离 Origin 的中间件。一个要求请求端口等于 daemon 自身端口；另一个要求请求与
  daemon 的 `Host` 真同源。两者都命中不了桌面端页面 origin。
- WebSocket CSRF 门只查静态 origin 集合，因此 `*` 在那里不生效。

## 目标

- 桌面端无需 `--allow-origin '*'` 即可访问远程 daemon。
- REST CORS 门与 WebSocket 门使用同一套准入规则。
- 继续以 bearer token 作为鉴权边界。

## 非目标

- host 或子域通配。
- 改变 `*` 的语义，或让 `*` 作用于 WebSocket 门。
- 把桌面 webview 导航到远程 daemon 的同源方案（issue 中影响面更大的设计选项）。
- 任何桌面客户端代码改动。

## 语法

`--allow-origin <scheme>://<loopback-host>:*`

- scheme 只能是 `http` 或 `https`，且必须与请求 origin 一致。
- host 必须是 loopback（`127.0.0.0/8`、`localhost` 或 `[::1]`），并且精确匹配。
  `127.0.0.1`、`localhost`、`[::1]` 是三个不同条目。
- 条目本身不得再写端口；通配符会替代端口。
- 必须配置 bearer token。无 token 的 loopback daemon 遇到通配条目会拒绝启动，与现有 `*` 守卫一致：
  否则本机任意端口上的任意页面都能驱动 daemon。

示例：`qwen serve --hostname 0.0.0.0 --token <token> --allow-origin http://127.0.0.1:*`

## 实现

- 解析器把通配条目与精确 origin 分开存储；非法或非 loopback 的通配会抛出既有的
  `InvalidAllowOriginPatternError`，并给出具体原因。
- `allowOriginMatches` 是 REST 匹配器：先 `*`，再精确 origin，最后 loopback 通配。
  `originIsExplicitlyAllowed` 是 WebSocket 匹配器：相同的显式条目，但不含 `*`。
- `runQwenServe` 与内嵌的 `createServeApp` 都执行 token 校验，直接构造 app 的调用方无法绕过。
- MCP App sandbox 的 `hostOrigin` 信任回调复用同一 allowlist。因此通配条目也允许该 loopback host
  上的页面嵌入预鉴权 sandbox 文档。该文档不含 bearer、不含数据；data 模式资源仍需通过鉴权路由签发。

## 安全

- 通配条目允许该 loopback host 上任意端口的任意页面。所有 API 路由仍强制 bearer，
  `Origin: null` 始终拒绝，新语法也无法表达非 loopback host。
- `*` 保持现有行为，且对 WebSocket 升级仍然不生效。
- 残余风险：已持有 bearer 的本机页面可以读取响应，这与任何其他被允许的浏览器 origin 属于同一主体模型。
  该改动不构成鉴权绕过。

## 验证

- 解析与匹配单元测试，覆盖 IPv6、`localhost`、scheme 不匹配、`Origin: null`、非 loopback host、
  显式端口以及 scheme 默认端口。
- `runQwenServe` 回归测试：带通配启动，对临时 loopback origin 断言 `204` 与
  `Access-Control-Allow-Origin`；另有无 token 绑定的拒绝测试。
- WebSocket 测试通过解析器生成 allowlist，断言通配 origin 返回 `101`，错误 host、错误 scheme
  和非 loopback origin 返回 `403`。
- macOS 运行时验证：改动前静态条目返回 `403`，`*` 在 WebSocket 上返回 `403`；改动后通配在 REST 上返回
  `204`、在 WebSocket 上返回 `101`，`localhost` 与非 loopback 对照仍为 `403`。

## 验收标准

- 桌面端使用 `--allow-origin http://127.0.0.1:*` 加 bearer token，可按文档访问远程 daemon。
- 无 token 的 daemon 在启动时拒绝该条目。
- 非 loopback host、`Origin: null`、不匹配的 scheme/host 仍被拒绝。
- `*` 行为不变，包括 WebSocket 门。

## 后续工作

- 在 Windows 上用桌面二进制对远程 daemon 做 E2E；该验证无法在本仓库的单测环境中运行。
- 如果 loopback 通配仍不够，issue 中的同源导航方案（选项 3）需要单独设计。
