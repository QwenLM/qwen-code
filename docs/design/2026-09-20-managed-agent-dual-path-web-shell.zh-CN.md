# Managed Agent 双通道 WebShell

[English](./2026-09-20-managed-agent-dual-path-web-shell.md) |
[简体中文](./2026-09-20-managed-agent-dual-path-web-shell.zh-CN.md)

> PR #12692 范围修正（2026-09-25）：下文的实现与验证记录来自完整集成预览，不是本次拆分的验收证据。当前能力、修复与未完成门禁以[评审修正](2026-09-25-managed-agent-review-corrections.zh-CN.md)为准。

## 状态

本地开发链路已实现，并于 2026-09-20 完成验证。生产产品通过现有 WebShell provider 属性显式启用。

## 问题

Java Managed Agent 链路此前只有一个不依赖 daemon 的 Managed-only 入口。这个入口可以证明浏览器到
Java 的协议闭环，但无法展示 Managed Session 如何与 `qwen serve` 使用的完整 WebShell 共存。

Java 不应为了复用完整 UI 而实现 daemon 协议。普通链路和 Managed 链路的 owner 不同，必须保持独立
部署能力。

## 目标与范围

- 在同时具备普通 daemon 和 Java Managed Agent 服务的部署中复用完整 WebShell 外壳。
- 每个界面继续路由到原有 owner，不在两个协议之间增加转换层。
- 为不运行普通 daemon 的产品保留无 daemon 的 Managed-only 组件。

本次变更不合并 Java 与 daemon 的 Session 状态，不给独立 Spring 服务新增鉴权，也不开放 Harness 和
Runtime 的私有 API。

## 决策

完整 WebShell 保留现有 daemon providers，同时给 Managed 面板显式注入 Java
`ManagedAgentProvider`：

```text
完整 WebShell
├── 普通会话、workspace、设置、终端 ──> Qwen daemon
└── Managed Sessions ──> Spring WebShell API ──> Hosted Harness
                                             └──> Runtime Broker ──> Tool Runtime
```

`App` 已支持 `managedAgentProvider`，不需要替换任何 daemon API。标准 Vite 入口新增 Java API
代理，并且只在开发环境显式传入 `managedProvider=java` 时创建 provider。`managed=1` 继续选择现有
Managed 面板，`managedSession` 继续作为 Managed Session 深链标识。

对于没有普通 daemon 的产品，`ManagedAgentWebShell` 仍是推荐入口。生产双通道宿主自行创建 Java
provider，并传给 `WebShellWithProviders`；通过 URL 选择 tenant 不属于生产契约。

## 安全与所有权

- 浏览器只调用 Spring 公共 WebShell API。Harness、Runtime Broker、Tool Runtime 的 endpoint 和凭证
  始终留在私网。
- 开发环境的 `tenant` 查询参数只用于测试。生产上游负责推导租户身份并注入 Java API header。
- 普通 WebShell 请求继续使用 daemon 凭证和 daemon workspace 所有权规则。
- Java Session ID 与 daemon Session ID 是两个独立命名空间。打开 Managed 深链不会恢复 daemon
  Session。
- Java API 代理使用精确路径前缀，并位于 daemon 路由之前，Managed 流量不会误落到 daemon。

## 风险与缓解

- 缺少普通 daemon 时，非 Managed 面板不可用；该拓扑应继续使用 Managed-only 组件。
- 将浏览器传入的 tenant 当作生产身份不安全；URL 适配只在开发环境启用，生产宿主负责推导租户身份。
- 两个后端可能造成 owner 模糊；精确的 Java 路由前缀和显式 provider 选择保证路由确定。

## 本地启用

同时运行普通 daemon、Spring/Hosted-Harness/Runtime 链路以及 WebShell 开发服务器：

```bash
QWEN_DAEMON_URL=http://127.0.0.1:4170 \
QWEN_MANAGED_AGENT_JAVA_URL=http://127.0.0.1:8080 \
  npm run dev:managed-agent-web
```

打开
`http://127.0.0.1:5174/?managed=1&managedProvider=java&tenant=local-java-demo`。

## 验证计划

- 单测覆盖显式选择 Java、tenant header 透传，以及未选择时行为保持不变。
- 在现有 daemon 代理旁验证精确的 Java 代理目标。
- 用真实浏览器跑通 Java、Hosted Harness、Runtime Broker、Tool Runtime，并在同一页面打开 daemon
  所有的面板。

## 验收标准

1. 页面展示标准 WebShell 外壳，并自动打开 Managed 面板。
2. Managed 列表、创建、回放、提交、取消和事件流只访问
   `/api/agent/web-shell/v1/**`，并携带开发租户。
3. 现有 daemon 面板继续访问普通 daemon。
4. 不传 `managedProvider=java` 时，standalone WebShell 行为不变。
5. 已导出的 Managed-only 组件仍然不依赖 daemon。

## 验证结果

完整页面成功加载已有 Java Managed Session，新回合精确返回 `FULL_SHELL_OK`，随后在同一个浏览器页面
打开了 daemon 所有的 Status 面板。开发代理能够同时返回 Java Session 列表和 daemon health。定向
WebShell 测试覆盖了启动适配、代理注册，以及 daemon workspace context 尚未就绪时 Managed 面板保持
可用的行为。
