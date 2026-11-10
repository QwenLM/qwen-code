# Managed Web 终端

[English](2026-11-10-managed-web-terminal.md) | [简体中文](2026-11-10-managed-web-terminal.zh-CN.md)

状态：提案，未实现；产品决策已于 2026-11-10 确认。日期：2026-11-10。

## 问题与现状

本地 daemon 已经具备完整的 Web 终端：Web Shell 的 `TerminalPanel`（xterm）
连接 daemon 的 `/terminal` WebSocket
（`packages/cli/src/serve/routes/terminal.ts`），后端是 core 的
`WebTerminalRegistry`（`packages/core/src/services/web-terminal-registry.ts`，
node-pty/bun-pty、有界 scrollback 重放、断线重连、空闲回收）。UI 入口由
`web_terminal` capability 门控，daemon 把解析后的 workspace runtime 的 cwd
与环境变量交给 PTY（[Web 终端生命周期](web-terminal-lifecycle.md)）。

Managed Agent 没有对应能力。capability parity 矩阵把这登记为有意保留的缺口：
`packages/cli/src/serve/capability-parity.ts` 中的
`web_terminal: NO_MANAGED_EQUIVALENT('no Managed web terminal')`
（issue #15075）。Managed 现有的 "shell" 是 agent 工具而非用户终端：
`hosted-workspace-shell/1` 通过带审批的持久 Broker dispatch 暴露
`run_shell_command` 与 `monitor`，而 H3 背景 Shell 设计
（[Managed Shell/Monitor 运行时](2026-10-03-managed-shell-monitor-runtime.md)）
明确推迟了交互式输入能力 `send_input`。Java 控制平面目前没有任何 WebSocket
surface；Managed Web Shell 只消费 HTTP 与 SSE。

因此，操作 Managed Session 的用户无法临时执行命令、查看进程或交互式调试托管
工作区；每条命令都必须经过一次模型 Turn。

## 目标与范围

目标：

- 在 Managed Session 的托管工作区中提供交互式用户终端，从 Managed Web Shell
  打开，帧协议与 UI 与本地 Web 终端一致。
- PTY 运行在拥有该工作区的 Runtime worker 内，复用 `WebTerminalRegistry`
  语义：scrollback 重放、断线重连、空闲回收、并发上限。
- 租户、actor、Workspace 授权与 Session 生命周期鉴权与现有 WebShell 路由
  同等强度；binding 解析失败即关闭（fail closed）。
- 活跃终端持久持有 Runtime，使 close、delete 与 release 不能悄悄杀掉或
  遗留它们。

非目标：

- 不改变 agent 工具执行、审批模式或 Shell profile 的工具列表。用户终端不是
  模型工具调用。
- 不做 H3 背景 Shell 的 `send_input`；该预留能力仍是独立切片。
- 终端不跨 worker 替换存活，不支持跨 Session close 的 detach，也不持久化
  终端内容的 transcript。
- `external-scratch` 与 K1 Kubernetes scratch runtime 不提供终端；它们的
  契约要求 Workspace files 与 Shell 保持禁用。
- 本增量不新增 public（`/v1/agents/**`）surface；终端是 WebShell 能力。

## 架构

```
浏览器（TerminalPanel / xterm，复用现有帧编解码）
   |  WebSocket，同源 public bearer
   v
Java 控制平面（WebShell surface）
   - 握手鉴权：租户、actor、授权、角色、profile、opt-in
   - Session -> READY binding -> worker endpoint；否则 fail closed
   - 字节级中继；终端 I/O 不产生 tool-execution 行
   - 有终端附着期间持久 hold；生命周期操作触发 drain
   |  WebSocket，worker bearer/lease 协议
   v
Runtime worker（私有 HTTP surface，容器模式端口 43190）
   - owned-route gate 之后的新终端 upgrade 路由
   - WebTerminalRegistry：PTY 位于该 Session 的 workspace cwd/env
```

数据面是无状态直通；控制平面只拥有鉴权与持久 hold。这保持了所有权边界：
Java 控制平面不监管任何进程，worker 仍是唯一的进程 owner。

## 设计

### Worker 终端端点

worker（`packages/cli/src/serve/managed-runtime-attestation-worker.ts`）
在其私有 HTTP surface 上新增一条终端路由，使用现有 bearer/lease 协议鉴权，
并登记进 owned-route gate 清单。由于 server 设置了很短的请求超时
（`requestTimeout`、`headersTimeout`），该路由由同一 `http.Server` 上的
`upgrade` 监听器服务；升级后的 socket 脱离请求生命周期，改由终端心跳与
空闲规则约束。

端点持有一个 `WebTerminalRegistry` 实例。终端带上所属 Session 的身份标记；
attach 只能寻址同一 Session 的终端，PTY 获得该 Session 解析后的 workspace
cwd 与有效环境，与本地 daemon 提供其 workspace runtime 上下文的方式完全
一致。registry 的现有边界原样适用：每 worker
`MAX_CONCURRENT_WEB_TERMINALS`（8）、约 4 MB 重放 scrollback、
`IDLE_RECLAIM_MS`（15 分钟）detach 回收、64 KiB 待处理输入、8 MiB socket
背压上限、15 秒心跳、行列上限 1000。在 worker 全局 8 之内，每 Session
上限 4 个终端（2026-11-10 确认）。

worker 在其 boot capability digest 中声明终端能力。digest 是冻结的 binding
输入（见约束），因此本能力只能随控制平面/Harness/Runtime 协同部署发布。

### 控制平面中继

Java 服务新增其第一个 WebSocket 端点，位于 WebShell surface：
`GET /api/agent/web-shell/v1/sessions/{sessionId}/terminal`（HTTP upgrade）。
握手执行与其他 WebShell Session 路由相同的鉴权链，外加终端专属准入：

1. 租户与 actor 认证；Workspace 读授权；OPERATOR 角色。
2. Session active、未删除、绑定 Workspace，且使用统一的
   `hosted-workspace-shell/1` profile。
3. 部署级 Shell opt-in 与持久化审批仍然有效，且新的终端部署 opt-in 已开启。
4. Session 自己的 binding 在解析出的 runtime 中处于 READY。unknown、
   untrusted、ambiguous、bootstrapping、draining、removed 状态一律以类型化
   错误 fail closed；中继绝不回退到其他 runtime 或 primary。

握手之后，中继在两个方向原样转发二进制帧与 NUL 前缀控制帧。终端 I/O 不产生
tool-execution 行、不产生 journal 事件、不产生 artifact；它是按键量级的
live 数据，没有幂等重放语义，而且持久化它会把终端打印出的任何秘密一并
落库。只有 hold（见下）是持久的。

当 Session 离开 ACTIVE、binding 开始 draining 或 Workspace drain 时，控制
平面主动关闭活跃中继。授权撤销在 attach 时强制生效；生命周期转换额外终止
存活中继，使被撤销授权或正在关闭的 Session 无法保留一条打开的管道。

统一本地启动器（`qwen serve --managed`）把 Java 路由挂在 daemon 认证之后；
其 managed 代理必须同样转发该路由的 WebSocket upgrade。普通 daemon 自己的
`/terminal` 路由及其 `web_terminal` capability 不变。

### 持久 hold 与生命周期

附着的终端是 Runtime 上的活跃工作。设计复用 H3 的双行 ledger 模式：为
Session 准入第一个终端时创建一条非终态的 hold execution，像背景 Shell 的
第二条 execution 一样，通过 `hasActiveByRuntimeSession`/`hasActiveByBinding`
持有 Runtime。最后一个终端被 release、空闲回收或 drain 时，hold 结算。终端
准入与结算都是 owner 侧操作；它们绝不创建模型 Turn。

hold 原样复用现有 execution 表（2026-11-10 确认）：终端 hold 由其 execution
reference 中钉住的操作身份标识，与区分 H3 背景 Shell execution 的机制相同。
不引入新列、新表或新记录域。

close 与 delete 遵循现有的 release 顺序 drain：停止终端（杀掉 PTY）、收集
退出证据、结算 hold，然后继续资源结算。无法证明结果的 stop 使 hold 保持
活跃并阻塞退役，与现有 wedge 语义一致——不确定的终端 stop 绝不伪造成已
结算。

空闲回收无需用户动作即释放 PTY 并结算 hold。worker 替换会丢失全部终端：
registry 是内存态，中继报告显式的 terminal-lost 控制帧。终端绝不在替换
worker 上重放，与 Broker「歧义工作只能凭原 Runtime 的证据结算」的规则
一致。hold 遵循现有的 lost-Runtime 恢复语义；本设计不新增恢复路径。

### 准入与审批模型

终端是人类驱动的表面。按键不是 agent 工具调用，因此 Shell profile 的逐命令
审批（default/auto-edit）不适用；授权边界是部署 opt-in 加上调用者在该
Workspace 上的 OPERATOR 授权。这是一个有意的产品决策：启用终端的部署即
接受「被授权的操作者可以在工作区容器内以 worker 用户身份执行任意命令，
无需逐命令审批」。opt-in 默认关闭，且独立于 Shell opt-in，使部署可以启用
agent Shell 而保持用户终端关闭。

`external-scratch` 与 K1 scratch runtime 拒绝终端准入：它们的契约禁用
Workspace files 与 Shell，终端继承该拒绝。`hosted-workspace-files/1` 的
Session 不在范围内。

### 契约与能力声明

终端是 WebSocket upgrade，不是 REST handler，因此不占用 `SurfaceRegistry`
路由标签（D6 gate 枚举的是 `RequestMappingHandlerMapping` handler），也不占
OpenAPI path。取而代之：

- parity 矩阵该行翻为 `managed`，evidence 用 `docs:` 指向本设计文档；
  `capability-parity.test.ts` 校验该文件存在。
- `ManagedAgentSessionSummary.capabilities` 新增 `terminal?: boolean`
  字段，由服务端按同一准入链计算，使 UI 入口只对真正能 attach 的 Session
  出现。这是唯一的生成类型变更；WebShell 类型用
  `npm run generate:managed-agent-api --workspace=packages/web-shell`
  重新生成。
- upgrade 路由、其准入与类型化拒绝记录在本设计文档，而非 OpenAPI 契约。

### Web Shell UI

Managed 会话复用 `TerminalPanel` 与现有帧编解码；只有连接工厂与本地 daemon
连接不同（带 Session id 的 Java WebShell WS URL、public bearer）。入口由
`capabilities.terminal` 门控。重连通过 registry 重放 scrollback 与退出
状态，与本地一致。页面刷新丢失内存中的 terminal id，因此 detach 的终端被
空闲回收而非恢复——与本地生命周期完全相同。terminal-lost 控制帧渲染显式
通知，而不是静默重连循环。

## 设计决策与理由

| 决策     | 选择                                       | 被否的替代方案                                                                                                                                                            |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PTY 位置 | Runtime worker，复用 `WebTerminalRegistry` | K8s `pods/exec` 绕过 worker attestation、需要额外 RBAC，且 local-process provider 不存在该能力；在 worker 内跑完整 `qwen serve` 会引入 dual-path 设计禁止的第二套安全边界 |
| 数据面   | 无状态字节中继，I/O 不持久                 | 让按键流经 Broker dispatch 持久化误用了幂等重放语义，并会把终端秘密落库                                                                                                   |
| 生命周期 | 按 H3 execution 模式持久 hold              | 仅内存 hold 会让 close/release 杀掉或遗留活跃终端                                                                                                                         |
| 审批     | 部署 opt-in + OPERATOR，无逐命令审批       | 对人类终端逐键审批没有意义；复用 agent 审批会混淆两个不同的行为主体                                                                                                       |

## 受影响组件

| 组件                                  | 变更                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `packages/core` `WebTerminalRegistry` | 如现有接口无法表达，则补充 Session 标记的归属；边界、重放与回收语义不变                                          |
| `packages/cli` managed runtime worker | 终端 upgrade 路由、route-gate 条目、bearer/lease 鉴权、capability digest 升级                                    |
| `packages/cli` 统一启动器代理         | 终端路由的 WebSocket upgrade 转发                                                                                |
| `packages/cli` `capability-parity.ts` | `web_terminal` 行翻为 `managed` 并给 `docs:` evidence                                                            |
| Java WebShell surface                 | 首个 WebSocket 端点：握手鉴权、binding 解析、字节中继、生命周期触发关闭                                          |
| Java hold 准入                        | 按 H3 模式的 owner 侧 hold execution 准入/结算；close/delete 的 drain 顺序                                       |
| 契约                                  | session summary 的 `capabilities.terminal` + 重新生成的 WebShell 类型（WS upgrade 不进 OpenAPI/SurfaceRegistry） |
| Web Shell 客户端                      | `TerminalPanel` 的 Managed 连接工厂、入口门控、terminal-lost 通知                                                |
| 验证                                  | worker/Java/前端聚焦测试、契约门禁、真实进程 E2E 与故障用例                                                      |

## 约束

- 所有权边界保持不变：控制平面拥有生命周期与持久状态，Broker 拥有执行
  binding，worker 拥有进程。中继是第一条 live 通道，不得在 Java 侧长出
  进程监管。
- Harness capability digest 是冻结的 binding 输入；在 Session 已放置之后
  变更它会使既有 binding 全部失效且无解锁路径。因此终端能力只能随协同部署
  发布，正如 Shell profile 合并所要求的那样。
- 在 Managed Agent 首个正式版本发布之前，共享 V1 schema 基线原地编辑；
  hold 若需要新列或新表，加入 `V1__managed_schema.sql` 并重建开发 catalog。
  复用现有 execution 表可以连这一步都省掉。
- Workspace 作用域的中继解析始终留在 Session 解析出的 runtime 内；
  一切歧义状态 fail closed，绝不回退到 primary runtime。
- 终端内容不进 journal、不导出、不作为 artifact 保留；持久足迹仅限 hold
  生命周期行。

## 验证与验收

先做聚焦测试：worker 路由鉴权与 route-gate 拒绝、Session 作用域 attach、
worker 下 registry 的边界/重放/回收；Java 握手鉴权矩阵（租户、授权、角色、
profile、opt-in、binding 状态）、中继字节保真、hold 准入/结算、drain 顺序、
生命周期触发的中继关闭；契约与 parity 门禁；前端入口门控与 terminal-lost
渲染。

Linux 上用 bundled worker 与配套 Java 制品做真实进程验收：attach 并在
workspace cwd 执行命令；resize；detach 后重连并重放 scrollback 与退出状态；
空闲回收结算 hold；带活跃终端的 close 先以退出证据 drain 再结算；终端活跃
期间杀掉 worker 产生 terminal-lost、不在替换 worker 上重放、hold 遵循现有
lost-Runtime 语义。故障用例（attach 期间杀 worker、hold 准入期间切断数据库）
加入现有 fault-gate profile。hold 持久化在一次性 MySQL 8.4 上运行受影响的
`mysql-integration` 用例；仅 H2 不能确立该行为。本地 Java 验证遵循模块共享
预算；完整套件留在 CI。

验收为二元判据：

1. 终端 opt-in 关闭时 attach 被拒绝；开启时，被授权的 `shell/1` Session
   能 attach 并在 workspace cwd 回显输入/输出。
2. 每一种未授权组合（错误租户、缺授权、低于 OPERATOR、files-only profile、
   scratch runtime、非 READY binding）都以类型化错误拒绝且不回退。
3. 终端 I/O 不产生 execution-result 行；有终端附着期间 hold 存在，并在
   release、空闲回收与 drain 时结算。
4. close/delete 以证明的退出证据 drain 终端；未证明的 stop 保持 hold 并
   阻塞退役。
5. worker 替换绝不重放终端；客户端收到显式 terminal-lost 通知。
6. parity 测试通过且 `web_terminal` 行引用本设计文档；重新生成的 WebShell
   类型带 `capabilities.terminal`；既有 `ManagedAgentApiContractTest`/
   `SurfaceRegistryGateTest` 保持绿（WS upgrade 不新增 REST surface）。

## 发布

在启用 opt-in 之前协同部署配套的控制平面、Harness 与 Runtime 制品；
capability digest 变更会使按旧 digest 放置的 binding 失效。终端 opt-in
默认关闭，且独立于 Shell opt-in。既有 Session 只有在其 runtime 放置到新
digest 且准入链通过时才获得终端；已保存的 Session 作用域不被改写。不要
降级仍有活跃 hold 的消费者。

## 风险与后续

- Java WebSocket 基础设施是全新的；握手鉴权与中继背压需要与现有签名路由
  同等的评审严格度。无界缓冲的中继是内存耗尽攻击面；worker 侧 8 MiB 上限
  必须在 Java 侧同样镜像。
- hold 复用双行 execution 模式，不改 schema；drain 与 wedge 语义由本设计
  固定。
- 终端内容逃逸工作区（例如 `cd /`）由容器而非终端约束；治理 agent 工具的
  workspace 包含规则不适用于人类终端。部署必须把该 opt-in 视为授予容器级
  shell 访问。
- 后续工作：背景 Shell 的 `send_input`（H3 预留）、经独立持久 owner 跨
  close 存活的 detach、每 Session 终端配额，以及未来是否向 files-only
  Session 暴露终端的决策。

## 开放问题

本增量没有开放问题。提案提出的三个问题已于 2026-11-10 确认：每 Session
终端上限为 worker 全局 8 之内 4 个；hold 原样复用 execution 表，由其钉住
的操作身份标识；终端只发布 WebShell，任何 public API 暴露推迟到后续增量。
