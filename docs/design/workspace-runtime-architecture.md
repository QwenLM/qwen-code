# Qwen Serve 工作区运行时中心架构

## 1. 文档定位

本文是 `qwen serve` 从 Session-centric 迁移到
Workspace-runtime-centric 的目标设计与堆叠交付契约。该设计由四个可独立合并的
PR 渐进落地；本文描述最终形态，不表示 foundation PR 已实现所有 capability。

> **当前落地进度（foundation）**：已实现 Bridge 权威的五态 lifecycle snapshot、
> workspace 级单调 epoch、完整物理 work lease、绝对启动 deadline、无参数
> `ensure/status`、10 分钟可续期保活、drain/removal/shutdown admission，以及
> SDK 的 primary/qualified runtime 方法。第 10～13 节描述的 capability
> generation/revision、Catalog 投影和 operation 状态机仍属于后续阶段；当前
> `ensure` 只保证 ACP runtime 已初始化并可复用，不宣称各领域 Catalog 已 ready。

### 1.1 当前实现与目标设计

为避免把后续阶段的契约误读为 foundation 已有行为，本文使用以下标记：

- **Foundation（已实现）**：当前代码和 API 可以依赖的行为；
- **Target（未实现）**：后续 PR 的目标契约，当前调用方不得依赖；
- **Legacy（兼容）**：迁移期间保留的旧入口，新调用方不应采用。

| 领域              | Foundation（已实现）                                                                           | Target（后续阶段）                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runtime lifecycle | Bridge 权威五态、workspace 单调 epoch、物理 work lease、启动 deadline、drain/removal admission | capability 健康状态参与统一对外投影                                      |
| `ensure`          | 无参数；仅确保 ACP Channel 完成 initialize；成功后续期 10 分钟                                 | 准备 Extensions、MCP、Skills、Tools，并通过 capability status 表达收敛   |
| `status`          | lifecycle、`runtimeLive`、`runtimeEpoch` 快照                                                  | capability、generation、revision、error 和 operation 投影                |
| SDK               | primary/qualified `ensure` 与 `status` 的 REST 方法                                            | config/runtime Catalog、operation 和统一 deadline 的完整 owner-aware API |

除明确标为 Foundation 的段落外，第 9～14 节中 capability、Catalog、generation、
revision 和 operation 的详细状态机均是 Target 契约。

核心目标只有一个：

> Workspace 是运行时、隔离和管理边界；Session 只是 Workspace Runtime
> 中用于对话与执行的消费者。

仍保留的旧入口会明确标为兼容 adapter，而不是另一套架构。整个 stack 只有通过
第 14 节的验收条件后，才算完成迁移。

## 2. 背景

早期 daemon 以 Session 为入口。创建或加载 Session 后才启动 ACP 子进程，
随后初始化 Config、Skills、Tools、MCP 和 Extensions。管理页面因此逐渐出现了
多套兜底流程：

- 为读取运行时状态先预热 ACP；
- 选择一个已有 Session 取得 Config；
- 在前端串联 MCP initialize、reload 和轮询；
- 在最后一个 Session 关闭时顺带回收 ACP；
- ACP 不可用时从 daemon 本地扫描或使用未标明来源的缓存。

这些流程把“管理工作区”和“运行一次对话”绑定在一起。它们也让 daemon、Bridge、
ACP 和前端同时拥有一部分生命周期或状态判断，难以回答以下问题：

- 没有 Session 时，工作区实际可以使用哪些能力？
- 配置已经保存，是否代表当前运行时已经应用？
- ACP 重启后，缓存是否仍属于当前运行时？
- 最后一个 Session 关闭后，仍在执行的认证或刷新由谁保证完成？

Workspace-runtime-centric 架构通过一个工作区级运行时解决这些问题，而不是创建
隐藏 Session 或额外的“管理 Session”。

## 3. 目标与非目标

### 3.1 目标

1. 无 ACP、无 Session 时，仍可完成所有持久化配置和安装操作。
2. 无 Session 时，可按需启动 Workspace ACP Runtime，取得真实的 Extensions、
   MCP、Skills、Tools 等运行时结果。
3. 一个工作区在任意时刻最多只有一个当前 Workspace ACP Runtime；多个 Session
   和管理操作复用它。
4. `WorkspaceRuntime` 聚合是唯一 runtime ownership 边界；Bridge 驱动物理 Channel、
   epoch 和 lease，Coordinator 管理 capability 收敛、operation 和对外投影。二者都是
   同一个 WorkspaceRuntime 的内部组件，不是并列 runtime owner。
5. Session 创建和关闭只获取、释放 session lease，不控制 ACP 进程生命周期。
6. daemon 持久化控制面与工作区实时运行时分离，mutation 结果明确区分 durable
   result 和 runtime activation。
7. 前端只通过无 capability 参数的 `ensureRuntime()` 请求完整 Workspace Runtime，
   再轮询权威 operation/status 和读取 Catalog；前端不编排内部初始化步骤。
8. 工作区路由严格隔离；未知、未信任、移除中或启动失败的工作区绝不回退到
   primary runtime。
9. 保留兼容接口并渐进迁移，不重复实现完整 Config，不同时维护管理 ACP 与
   Session ACP 两套进程。

### 3.2 非目标

- 不让 daemon 重写 ACP 中的完整 Config 初始化。
- 不把每个 WorkspaceRuntime 拆成独立 daemon 进程。
- 不保证 ACP 子进程永久驻留。
- 不为管理和 Session 分别启动两个包含完整 Config 的 ACP 子进程。
- 不在本次迁移中重写 MCP transport pool 或 Session multiplex 协议。
- 不为了命名统一而重写稳定的模块实现。
- 不立即删除旧的 preheat、MCP initialize/reload 等兼容接口。

## 4. 必须保持的架构不变量

以下条件是实现选择的边界，不是建议：

1. Workspace 管理接口不接收 `sessionId`，内部不通过 `sessionOrThrow()`、
   `requestSessionStatus()` 或任意 Session 查找 Config。
2. 管理操作不得创建、恢复、选择或保留隐藏 Session。
3. Workspace ACP Runtime 属于 `WorkspaceRuntime`，不属于第一个 Session，
   也不由最后一个 Session 决定何时退出。
4. 每个已解析工作区只访问自己的 environment、Bridge、service、filesystem、
   Config 和缓存。
5. Qualified runtime command 和敏感 Workspace scope mutation 在目标未知、未信任、
   bootstrapping、draining、removed 或 failed 时明确失败；daemon-local qualified
   config GET 只要求 exact resolve，可读取未信任工作区。global config owner 不以
   primary runtime 的 trust 或 lifecycle 为前提，所有路径都不得回退到其他工作区。
6. 持久化成功与运行时应用成功是两个独立事实；后者失败不能把前者报告成失败。
7. `ready` 只属于当前 runtime epoch；旧 epoch 的数据最多是 `stale`。
8. Runtime 路由不持久化配置；配置启用、禁用、安装和删除只由 config/control
   路由执行。
9. GET 状态和 Catalog 请求不隐式启动 ACP。新调用路径只能通过显式 `ensure`、其他
   runtime command 或 Session 创建来启动；Foundation 暂时保留 production startup
   preheat 兼容策略。对外不提供按 capability 选择的启动接口。
10. 有副作用、需要交互或不能安全重试的长任务通过 operation 暴露终态；幂等的
    capability prepare/reconcile 通过 `/runtime/status` 暴露收敛状态。
11. 全局配置 owner 与 primary WorkspaceRuntime 是两个概念。全局 owner 不得借
    primary runtime 保存运行时状态，qualified config owner 也不得读取或接管全局
    operation。

## 5. 进程与对象模型

```text
qwen serve daemon
├── 持久化控制面
│   ├── Global config owner
│   │   ├── User scope 配置与 Secret
│   │   └── Extension 安装存储与全局 operation
│   ├── Workspace scope 配置
│   └── Skill 安装存储
└── WorkspaceRegistry
    ├── WorkspaceRuntime(A)
    │   ├── WorkspaceRuntimeCoordinator   capability/operation 协调者
    │   ├── Workspace config controller   工作区覆盖与其 operation
    │   ├── WorkspaceService              本地文件与配置边界
    │   └── Bridge                        ACP 通信驱动
    │       └── Workspace ACP Runtime     0..1 个子进程
    │           └── Session               0..N 个逻辑 Session
    └── WorkspaceRuntime(B)
        └── ...                           与 A 完全隔离
```

物理上仍复用现有 `qwen --acp` 子进程和 ACP Channel。迁移改变的是所有权：
它们是 Workspace ACP Runtime 的实现细节，不是 Session 级进程。

## 6. 唯一所有权

### 6.1 持久化控制面与 config owner

daemon 持久化控制面回答“用户配置了什么”，并且不依赖 ACP 或 Session：

- User/Workspace Settings；
- MCP 配置、启用状态和 Secret 引用；
- Extension 安装、更新、卸载、全局默认激活和工作区覆盖；
- Skill 安装、卸载和启用状态；
- Tool 启用状态；
- Agent CRUD；
- 工作区注册与信任信息。

配置提交生成 desired state。它不直接宣称某个 Workspace Runtime 已应用该状态。

全局和工作区 config owner 必须分开：

- 全局 owner 唯一拥有 Extension 安装、更新、卸载、User scope 激活策略，以及这些
  mutation 的 operation/interaction；
- 每个 qualified workspace config controller 只拥有该工作区的覆盖配置，以及由该
  路由创建的 operation/interaction；
- `/workspace/config/extensions` 虽保留了 singular/primary 风格的路径名，逻辑上仍
  指向全局 config owner，不代表 Extension Store 或 operation 属于 primary runtime；
- `/workspaces/:workspace/config/extensions` 必须拒绝安装、更新、卸载和 User scope
  enable/disable，也不能查询或响应其他 controller 的 operation/interaction。

### 6.2 WorkspaceRuntimeCoordinator

每个 `WorkspaceRuntime` 持有一个 Coordinator。Foundation Coordinator 只负责
lifecycle snapshot 投影、ensure/status admission 和 drain/dispose；物理事实仍全部
来自 Bridge。

Target Coordinator 将扩展为以下状态的唯一可写所有者：

- capability prepare 的合并与执行；
- 当前 epoch 的 capability status；
- Extension desired/applied generation 的工作区投影；
- MCP/Skills capability revision 和“最新尝试获胜”的收敛顺序；
- workspace runtime operation 状态（目标初期为 MCP）；Extension config operation
  仍由创建它的全局或 qualified controller 独占；
- 配置变更后的 capability 失效和收敛。

调用方不得直接根据 Session 数量或某个模块缓存推断 capability 状态。

### 6.3 Bridge

Bridge 是 WorkspaceRuntime 内由 Coordinator 和兼容 adapter 调用的通信驱动，负责：

- 启动和停止 ACP 子进程；
- 建立、复用和关闭 Channel；
- 分配单调递增的 runtime epoch；
- 记录 session、handshake、workspace control、discovery 和 auth 的物理 lease；
- 在物理 lease 全部释放后按 idle 策略回收；显式 keepalive 与配置值取剩余时长最大值；
- ACP 请求/响应关联，以及协议支持时的取消；
- 将当前 epoch 的事件和原始 Catalog 快照提供给 Coordinator；
- Session multiplex 的协议适配。

Bridge 不负责：

- 保存跨 epoch 的权威 capability 状态；
- 持久化配置；
- 将旧 runtime 的完成状态合并到新 runtime；
- 把管理请求转发给任意 Session；
- 独立维护另一套 workspace operation 状态机。

`AcpSessionBridge` 的 Channel、epoch、物理 lease 和 idle timer 是同一个
WorkspaceRuntime 的底层生命周期事实，不是第二个 Session runtime。Foundation
Coordinator 只读取 lifecycle snapshot；Target Coordinator 再从这些事实构造
capability 投影。两者都不复制一套相互竞争的 Channel 状态机。Bridge 只能在所有物理
lease 均为空时回收，不能仅依据 Session 数量结束 Channel。

### 6.4 Workspace ACP Runtime

ACP Runtime 回答“这个工作区在当前 epoch 实际可以使用什么”，包括：

- 实际加载的 Extensions 及派生能力；
- 实际加载的 Skills、Commands、Agents、Hooks 和 Context Files；
- 实际注册的 Tools；
- MCP discovery、连接、认证状态、Tools 和 Resources；
- Providers 和依赖完整 Config 的状态；
- 工作区级生成能力。

daemon 不复制这些运行时逻辑，只负责协调和观察。

### 6.5 Session

Session 只拥有对话和执行状态：历史、上下文、Turn、模型、Mode、审批和会话临时
状态。Session 是 Workspace ACP Runtime 的逻辑子对象，不是 Extensions、MCP、
Skills 或 Tools 管理能力的初始化入口。

## 7. User scope 与 Workspace scope

User scope 是 daemon 进程级的持久化 desired state，不属于 primary runtime。
primary workspace 只是 singular `/workspace/runtime/...` 兼容路由所选中的普通
WorkspaceRuntime；它不能因此成为全局配置或全局 operation 的 owner。

规则如下：

1. User scope 变更只通过全局 config owner 提交一次。路径可能保留
   `/workspace/config/...` 这一兼容命名，但其 owner 不能与 primary runtime 的
   Coordinator/controller 合并。
2. `/workspaces/:workspace/config/...` 只允许 Workspace scope；不得借该路由修改
   User scope。
3. Extension Store 的 durable mutation 原子推进全局 Extension generation；
   MCP/Skills 配置不伪造 store generation，而由每个受影响 Coordinator 推进本地
   capability revision。
4. 已运行且受信任的工作区异步 reconcile；cold 工作区返回 `deferred`，在下次
   ensure 或创建 Session 时应用。
5. 对外可观察状态必须在所有受影响的 WorkspaceRuntime 中失效，不能只更新
   primary Bridge。若发布事件，也必须 fan out 到所有受影响客户端。
6. enable/disable 默认属于 config 路由。旧 `/workspace(s)/.../mcp` 控制接口仅为
   兼容保留原有持久化行为；新 `/runtime` 路由不提供 enable/disable。

一个工作区的 effective desired state 由 User scope、Workspace scope 和已启用
Extension 的贡献合并而成；合并规则属于 Config/ACP，不在 Coordinator 中复制。

operation 的查询与 interaction 回复遵循创建者所有权：全局操作只从全局 controller
查询，工作区操作只从相应 qualified controller 查询。相同 `operationId` 即使出现在
另一路由的请求里也必须返回 not found，不能通过 daemon 级 pending map 绕过 owner。

## 8. 生命周期、lease 与回收

### 8.1 生命周期状态机

```text
cold -> starting -> active -> idle
          |           ^        |
          |           └--------┘ 新 lease
          └-> cold + lastError  启动失败

active/idle -> stopping -> cold  workspace removal / daemon shutdown / explicit restart
stopping -> starting/active      新 epoch（admission 开放时，旧 Channel 退出前）
idle -> stopping -> cold         immediate or configured idle timeout
active/idle -> cold              child crash
```

- `cold`：没有 ACP Channel，也没有正在进行的启动；
- `starting`：Channel 正在创建或 handshake 尚未完成。它是物理 runtime 生命周期
  状态，不等于某个 capability 的 `starting`；
- `active`：Channel 已 live，且至少有一个 session、workspace-control、discovery、
  auth、spawn/restore 或其他物理 work lease；
- `idle`：Channel 已 live，且没有任何物理 work lease；runtime 继续保留进程和已加载
  资源，后续工作复用同一 epoch；
- `stopping`：没有可复用的 live Channel，但旧 Channel 仍在异步退出。除 draining、
  removal 或 daemon shutdown 已关闭 admission 外，并发新工作可以在旧 Channel
  完全退出前启动新 epoch；`aliveChannels` 同时跟踪两者以保证最终清理。

注册 WorkspaceRuntime 本身不启动 ACP child。Foundation 暂时保留 production
startup preheat，因此受信任的 primary 可在 daemon listen 后被兼容策略启动；不受
信任的 primary 和所有 secondary 不会被该策略启动。除此之外，Primary 与 secondary
都只由显式 runtime command（包括 `ensure`）或 Session create/load/resume 从
`cold` 启动。后续移除 startup preheat 后，两者完全一致。

若 Channel 已 live，Coordinator 中存在 capability reconcile 并不能单独把顶层状态
标为 `starting`；实际 RPC 持有 workspace-control/discovery/auth lease 时顶层为
`active`，lease 释放后为 `idle`。Capability 自己仍可保持 `starting` 或 `error`，
但不会改变顶层五态。只要存在新的可复用 live Channel，顶层就按该 Channel 的
`active/idle` 投影；旧 epoch 的 Channel 可同时处于退出过程。

### 8.2 Lease 模型

Foundation Bridge 用 session 集合、spawn/restore 计数、workspace-control 计数、
MCP discovery 标记和 server-name 级 MCP auth 集合表示物理 work。已接入的
status、Catalog、Extension refresh、Skills refresh、MCP discovery/auth、普通 runtime
mutation 以及 Session create/load/resume/close 都在对应物理工作期间持 lease。
物理 startup 本身也受启动 lease 和 deadline 保护。当前 `ensure` 只覆盖
preheat/initialize，并在成功后登记 keepalive；它尚不串联 capability 阶段。

Foundation 在 OAuth 返回 pending 后保留 owning Channel 的 auth lease。明确观察到
同一 Channel 上的 server 已变为 non-pending 时释放；Catalog 中缺少 server 不是完成
证据。pending 状态的固定安全期限到达时，Bridge 先对 owning Channel 做最后一次状态确认；
仍无法证明完成时将 owning Channel 标记为待退役。无 Session 时立即终止；有 Session
时允许现有会话继续使用，并在最后一个 Session 排空后终止 Channel，以进程退出完成
safe drain。deadline 是故障恢复上限，不是普通 idle 回收。

Target Coordinator 将通过 Bridge 的外层 runtime-control lease 包住一次完整
capability runtime command。其中的 Catalog、Extension refresh、Skills refresh 和
普通 runtime mutation 仍可嵌套使用更具体的计数，但不能在阶段之间释放最后一个物理
lease。Coordinator 不建立第二套用于物理生命周期的可写“逻辑 lease”。这些计数和
Map 不对调用方开放。

Target Coordinator 还需要仅用于 workspace removal admission 的 daemon-local
management operation 计数。它覆盖尚未进入 Bridge 的配置持久化和后台提交，但不参与
顶层 `active/idle` 投影或 ACP idle 回收判断。

约束：

- Session create/load 获取 session lease，close 只释放自己的 lease；
- Target capability ensure 和需要启动 runtime 的 mutation 在 Channel
  创建/handshake 之前取得外层 runtime-control lease，并连续持有到所有 capability
  阶段和最终状态投影完成；不能在 preheat、Catalog、refresh、discovery 之间留下
  idle 回收窗口；
- 单独的 Catalog RPC、MCP discovery/auth、Extension reconciliation 和 runtime
  mutation 在进入物理工作前取得对应的 workspace-control/discovery/auth lease；
- handshake、callback、等待用户输入和清理阶段仍属于操作，lease 不得提前释放；
- 所有请求结束、成功取消或完成 safe drain 后都必须释放自己的 lease；没有取消
  契约的失败/超时不能仅因观察者停止等待就释放 auth lease；
- 最后一个 Session 关闭不能越过其他 lease 结束 runtime；
- Bridge 的 status/Catalog 请求必须在整个 RPC 期间持 workspace-control lease，
  避免被 idle 回收中断。

### 8.3 可配置的 idle 生命周期

最后一个物理 work lease 释放后，Bridge 按 `channelIdleTimeoutMs` 立即或延迟回收 ACP
child。进程所有权仍属于 WorkspaceRuntime，回收条件由整个 workspace 的物理 work
lease 决定，而不是只看 Session 数量：

1. 新 lease 直接复用当前 runtime 和 epoch，并取消已登记的 idle timer；
2. `lastActivityAt` 保持既有 Session 观测语义，只由 Session spawn/restore 和
   prompt 活动更新；workspace runtime 请求通过 lease/keepalive 控制回收，不伪装成
   Session activity；
3. 未配置或显式设为 `0` 时，普通 runtime work lease 排空后立即回收；裸 preheat
   自身结算不启动立即回收器，而是保留到首次使用；
4. 显式正值或 active keepalive 启用 idle timer，并取两者剩余时长最大值；到期时 Bridge 再次确认 session、spawn/restore、
   workspace-control、MCP discovery 和 auth work 均为空后停止 runtime；
5. daemon shutdown 和 workspace removal 可以统一结束对应子进程。

成功的显式 `ensure` 会把 workspace 级保活窗口从本次成功时刻续期至少 10 分钟；
并发调用取最长窗口，窗口内再次调用会再次续期。通用部署仍可通过显式正数
`channelIdleTimeoutMs` 配置更长的 idle 窗口。两者都不计为 active work，workspace
removal 和 daemon shutdown 可以提前结束 runtime。

Session 数量不是回收条件，只是 lease 集合的一部分。

#### Startup preheat 兼容边界

Foundation 保留 production 默认预热受信任 primary 的既有策略，避免尚未迁移到
`ensure` 的 SDK/API 调用方承担额外首次冷启动延迟。该预热仍通过 primary
WorkspaceRuntime/Bridge 执行，不改变 runtime ownership；不受信任的 primary 不会
启动 ACP。测试或嵌入方可以通过 `preheatBridge: false` 显式关闭。

startup preheat 是迁移期策略，不是目标架构的启动入口。完成调用方迁移和首请求延迟
验证后，再由独立变更移除默认预热；届时 runtime 只由显式 workspace intent 或 Session
需求启动。Bridge 已进入 shutdown 后，legacy preheat 明确失败而不是静默成功，使
调用方不会把一个无法再启动的 runtime 误判为 ready。

### 8.4 Draining 与移除

Foundation 的 workspace removal activity 已包含 Session 之外的 Bridge 物理 work 和
在途 ensure。非 `force` 移除遇到这些活动项返回 `workspace_busy`。进入 `draining`
后，Registry 阻止新的路由解析，
Coordinator 关闭新的 ensure admission；已经解析但尚未开始物理工作的请求以
`workspace_draining` 失败。移除回滚时一并恢复 admission，提交后的强制清理才终止
现有 work。

Target 还必须把后台 capability 收敛和未终结 operation 纳入 activity。draining
期间收到的 User/global MCP 或 Skills 配置失效要保留为待 reconcile 状态；回滚后立即
重放，且重放成功前 ensure 不得把旧 Catalog 标成 ready。

## 9. Runtime epoch、Catalog 与缓存

本节的 Bridge epoch 属于 Foundation；capability status 和 Catalog 规则属于
**Target**。

每次新的 ACP 子进程/Channel 成为当前 runtime 时，Bridge 分配单调递增的
`runtimeEpoch`，Coordinator 将它绑定到 capability 状态。所有 live 状态和缓存必须
携带产生它的 epoch。

```ts
type CapabilityState = 'not_started' | 'starting' | 'ready' | 'stale' | 'error';

interface WorkspaceCapabilityStatus {
  state: CapabilityState;
  runtimeEpoch?: number;
  error?: { code: string; message: string };
}
```

规则：

1. `ready` 必须来自当前 epoch 完成的 ACP 响应。
2. 新 epoch 开始时，旧 epoch 的 `ready` 立即变为 `stale`。
3. 旧 epoch 的 `completed` 不得覆盖新 epoch 的 `not_started` 或空结果。
4. cache key 至少包含 `workspaceId + capability + runtimeEpoch`；跨 epoch 只能作为
   明确标记的 stale 展示数据。
5. 空数组表示当前 epoch 已确认 Catalog 为空，不能兼任“尚未初始化”。
6. 顶层 `runtimeLive` 只表示当前 Channel 是否存在，不替代 capability 状态。
7. Bridge 可以暂存带 epoch 的原始响应，但 Coordinator 的投影是对外 capability
   状态唯一来源。
8. GET status/Catalog 只返回快照；需要 fresh 数据时显式 `ensure` 或领域 runtime
   command。
9. `source: 'config'` 或本地 fallback 可以提供控制面信息，但不能把 runtime
   capability 标记为 `ready`。

Runtime Catalog 与 Coordinator status 是两个互相校验、不能互相替代的投影：

- Extensions、MCP、Skills、Tools Catalog 都携带 `initialized`；live 或 cached
  快照携带产生它的 `runtimeEpoch`。MCP/Skills 还显式携带 `source`，其他 Catalog
  的来源由 initialized/epoch 和 Coordinator status 判定；
- Coordinator capability status 携带 `state`、`runtimeEpoch` 和错误；仅 Extension
  capability 额外携带 `desiredGeneration`、`appliedGeneration` 和 `appliedEpoch`；
- `appliedEpoch` 是 Coordinator 对 Extension generation 回执的投影，不是 Catalog
  自己的 epoch，也不得由前端用“当前 runtime epoch”猜测；
- 页面只有在 capability 为当前 epoch 的 `ready`、Catalog 已 initialized 且
  Catalog `runtimeEpoch` 与当前 runtime 相等时，才把 Catalog 当作 live；Extensions
  还要求 `desiredGeneration === appliedGeneration` 且 `appliedEpoch` 等于当前 epoch。

## 10. Extension generation 与 capability revision

本节全部为 **Target**。

只有具有原子版本化 Store 的 Extension 使用对外可见的 desired/applied generation。
运行时只有在当前 epoch 明确回执加载了该 generation 后，Coordinator 才能推进
applied generation。

```ts
interface GeneratedCapabilityStatus extends WorkspaceCapabilityStatus {
  desiredGeneration: number;
  appliedGeneration?: number;
  appliedEpoch?: number;
}
```

约束：

1. Extension durable mutation 提交时原子地产生 committed generation，并把它 fan
   out 为所有受影响 WorkspaceRuntime 的 desired generation。
2. Extension reconcile attempt 必须绑定
   `generation + runtimeEpoch + reconciliationRevision`；回执必须携带它实际加载的
   generation，不能在 refresh 完成后重新读取
   store 最新 generation 并猜测已应用值。
3. `appliedGeneration` 与 runtime snapshot 在同一次成功响应中更新。
4. 新 epoch 不继承 applied；它必须重新加载 desired state。
5. `ready` 要求 `appliedGeneration === desiredGeneration`、`appliedEpoch` 等于当前
   epoch，并且存在该 epoch 的实际快照。
6. desired 前进时，已有 `ready` 立即变为 `starting`（正在 reconcile）或
   `stale`（尚未开始）；成功后由 Coordinator 一次性更新 generation 和状态。
7. Extension generation 前进时，必须同时失效其派生的 Extensions、Skills、Tools、
   MCP、Agents、Hooks、Commands、Context Files、Settings 和 Channels。
8. Extension generation 在当前 epoch 应用成功后，Coordinator 自动重新 prepare
   此前已经初始化过的 MCP、Skills 和 Tools；从未初始化的能力仍保持按需加载。
9. 旧 generation、旧 epoch 或旧 reconciliation revision 的迟到成功/失败都不能
   覆盖当前投影。

MCP/Skills 不使用伪造的 desired/applied generation。它们由各 WorkspaceRuntime
Coordinator 维护不对外持久化的单调 capability revision：

1. durable config mutation 成功后推进相应 revision；cold runtime 标记
   `not_started/stale` 并返回 `deferred`，live runtime 排队 reconcile；
2. reconcile/prepare 捕获 `revision + runtimeEpoch`，只有两者仍为当前值时才可以写
   `ready/error`；较新的 mutation 会使旧尝试失效；
3. 同 capability 的 reconcile 与 runtime mutation 复用 Coordinator 的串行 lane，
   防止 reload、restart、prepare 并发覆盖；
4. Extension generation 前进会同时推进 MCP/Skills/Tools 的 revision，因为
   Extension 可以改变这些有效 Catalog；
5. readiness 由当前 epoch 的 live Catalog 证明，不通过暴露一个并不存在的
   MCP/Skills applied generation 证明。

## 11. Ensure、内部 prepare、operation 与 deadline

### 11.1 Ensure

`ensure` 是 SDK/UI 唯一的通用 Workspace Runtime 启动命令：

```http
POST /workspaces/:workspace/runtime/ensure
{}
```

primary workspace 使用等价的 `POST /workspace/runtime/ensure`。两个入口都拒绝非空
body；调用方不选择 capability，也不传 timeout、keepalive 或初始化顺序。

#### Foundation（已实现）

当前 Coordinator 的职责刻意很薄：

1. 校验 workspace 已准确解析、受信任且未 draining；
2. 调用 Bridge 的物理 preheat/initialize，等待 ACP Channel handshake 完成；
3. 将本次成功转换为 workspace 级 10 分钟 keepalive；并发调用保留最长窗口；
4. 从 Bridge 读取 lifecycle snapshot 并返回。

`ensure` 成功只证明 ACP Channel 已完成 initialize 且可由后续 Session、MCP、Skills
等请求复用；它不证明 MCP discovery、Extension refresh 或任一 Catalog 已 ready。
若同一物理启动正在进行，并发 `ensure` 复用 Bridge 的启动 Promise；每个成功调用都
从自己的成功时刻续期 keepalive。若启动卡住，Bridge 的绝对启动 deadline 会中止并
清理该次启动，后续显式 `ensure` 可以发起新的尝试。

服务端观察预算为 60 秒。预算耗尽时请求以可重试的
`runtime_still_starting` 错误结束；底层物理启动仍由独立的绝对启动
deadline 约束。当前没有 capability 后台收敛 operation，也不会返回 capability
`starting`。`GET /runtime/status` 只观察 lifecycle，不启动或重试 runtime。

#### Target（未实现）

后续 Coordinator 将在同一次 workspace runtime command 中固定准备标准能力
`extensions -> (mcp, skills, tools)`：

1. 获取覆盖整个命令的外层 runtime-control lease；
2. 确保 Workspace ACP Runtime 已完成 handshake；
3. 在当前 epoch 加载 Extension desired generation，或捕获 MCP/Skills revision；
4. 初始化标准 capability 集合并更新可轮询状态；
5. 命令完成、失败或安全排空后释放 lease。

Target 中 Coordinator 先 prepare Extensions，再并行处理其派生能力；同一 capability
的并发工作合并。HTTP 观察预算耗尽可以先返回 capability `starting`，后台收敛受另一
个固定 deadline 约束，客户端通过 `/runtime/status` 观察终态。此语义在 capability
Coordinator 落地前不得由 SDK/UI 假设。

按 capability 的 prepare 只是 Coordinator 的内部实现，不暴露 HTTP 或 SDK 接口。
新增 capability 时只修改 Coordinator 的标准能力集合和初始化逻辑。

### 11.2 Operation 状态

以下为 **Target**：

```ts
type McpOperationState =
  | 'running'
  | 'waiting_for_input'
  | 'succeeded'
  | 'failed';
```

operation 用于 Extension 安装/更新、MCP OAuth 等有副作用、需要交互或不能靠重复
ensure 表达的工作。一个 operation record 只有一个可写所有者：

- workspace runtime operation 由对应 Coordinator 所有；
- 全局 Extension 安装等控制面 operation 由全局 controller 所有；它驱动每个受影响
  Coordinator 的 generation reconciliation attempt，但不复制 capability 状态，也不
  创建另一份同名 runtime operation。

`waiting_for_input` 不是终态，仍持有带最大期限的 lease。operation 进入终态后保留
有限时间供 SDK/UI 查询。

Extension controller 保留自己的 `queued/running/waiting_for_input/succeeded/
succeeded_with_warnings/failed` 状态和 `preparing/committing/reconciling` phase；MCP
runtime operation 使用上面的较小状态集。当前协议不暴露一个虚假的 `timed_out`
终态：若 deadline 后仍不能安全取消，operation 继续保持非终态；安全 drain 后以
`failed` 和结构化 timeout error 结束。

### 11.3 单一 deadline

**Foundation** 已实现 ACP 物理启动的绝对 deadline。它覆盖 Channel factory 和
initialize；超时会通过 AbortSignal 请求取消、终止迟到创建的 child，并清除启动
Promise，使后续 ensure/Session 可以重试。ensure 的 60 秒 HTTP 观察预算不延长这个
物理 deadline，SDK 使用 62 秒客户端预算为服务端返回预留时间。

**Target** 要求每次 capability ensure 或 operation 在入口创建绝对 deadline。每个
阶段只使用剩余预算，不得让 preheat、discovery、refresh 或每次 UI poll 各自重新
获得一份完整 timeout。Target ensure 具有调用方观察 deadline 和一次性有界后台收敛
deadline；前者到达可先返回 `starting`，后者不随 poll 重置。MCP auth 从首次 Bridge
调用到状态 observer 共用同一个 `deadlineAt`。

HTTP/SDK 请求超时与 operation deadline 是不同概念：

- Foundation ensure 的 HTTP 预算结束时返回可重试错误；Target capability ensure
  才返回 `starting`；命令型 operation 返回 `operationId`；
- 请求断开不自动宣告 operation 失败；
- operation 是否继续、取消或超时由其 deadline 和取消策略决定；
- UI 通过 operation/status 查询观察终态。

若底层有取消契约，deadline 到达时先请求取消。只有底层任务已经停止、完成必要
清理，或已被安全地从 ACP 生命周期中分离后，才可以进入 timeout 终态并释放 lease。
当前 MCP OAuth 没有取消契约，因此 observer deadline 到达不能释放 auth lease 或
认证全局 lane；具体 safe-drain 语义见第 12 节。

### 11.4 持久化提交与激活

以下为 **Target**：

配置接口先提交 durable state，再在同一个扁平 domain result 或 operation result 中
单独表达 runtime activation。当前 wire contract 不包一层虚构的 `commit` 对象：

```ts
interface DurableMutationResult {
  // name/scope/config/changed 等领域字段；Extensions 可携带 generation
  // applied — runtime activation completed for all affected WorkspaceRuntimes.
  // deferred — no live runtime; durable commit persisted, activation on next ensure.
  // reconciling — durable commit persisted, live runtime reconcile in progress (operationId provided).
  // partial — durable commit persisted, activation succeeded for some WorkspaceRuntimes but failed for others.
  activation: 'applied' | 'deferred' | 'reconciling' | 'partial';
  operationId?: string;
  warnings?: Array<{ workspaceCwd: string; error: string }>;
}
```

同步 MCP/Skills mutation 以 HTTP 成功和领域字段表示 durable result；Extensions
mutation 先返回 `operationId`，operation 的 committing phase 成功后，其 result 再
携带 activation/warnings。提交完成后，即使 activation 超时或失败，也必须返回
“配置已保存”；客户端超时不能把已经落盘的变更显示成保存失败。

## 12. MCP OAuth

本节为 **Target**，但约束来源于当前 ACP OAuth provider 缺少可靠取消契约这一既有
事实。

OAuth 是 workspace-scoped operation，但 callback listener/port 是 daemon
process-global 资源。锁和路由必须匹配真实资源作用域。

当前 ACP OAuth provider 没有取消契约，并使用可能冲突的 process-global callback
资源。因此后续 operation 层采用保守但可证明安全的模型：

1. Coordinator operation 归属具体 WorkspaceRuntime，并绑定
   `workspaceCwd + serverName + operationId + runtimeEpoch`；同一 workspace/server
   不能并发认证。
2. daemon 另有一个 process-global authentication lane。任一工作区存在
   `running/waiting_for_input` 的 auth 时，其他工作区或 server 的认证请求明确失败，
   而不是争用 callback listener。
3. operation 在调用 Bridge 前创建唯一绝对 `deadlineAt`；初始 authenticate RPC 和
   后续 observer 使用同一个 deadline，不能各自获得一段新的十分钟。
4. Bridge 在 ACP 返回 `pending` 时，以 `operationId` 记录物理 auth lease，并把实际
   `runtimeEpoch` 返回 Coordinator。`waiting_for_input` 期间最后一个 Session 关闭不
   得回收 Channel。
5. observer 只接受 operation 所属 epoch 的 MCP Catalog。新 epoch 的同名 server
   不能完成旧 operation；旧 Channel 退出或 epoch 替换时，旧 operation 失败。
6. deadline 到达只表示调用方等待预算耗尽。只要 ACP 仍报告
   `authenticationState: pending`，operation 保持 `waiting_for_input`，物理 auth
   lease、per-target lane 和 process-global lane 都不得释放。
7. ACP provider 的 `finally` 在移除 callback listener 和 pending provider 记录后，
   发送带 `operationId + serverName` 的 completion notification。该通知是 Bridge
   释放对应物理 auth lease 的直接排空信号；同 epoch Catalog 中仍存在且明确为
   non-pending 的 server 可以作为兼容佐证。
8. Catalog 中缺少 server、配置已删除、discovery 已完成或一次状态读取失败，都不是
   provider 已停止的证明，不能据此释放 auth lease 或认证 lane。只有上一步的物理
   完成证据，或 owning Channel/epoch 已退出，Coordinator 才完成 safe drain，并把
   超时观察结果写为 `failed/mcp_authentication_timeout`（或 runtime unavailable）。
9. MCP physical lane 按入队顺序执行。普通任务在入队时捕获当时的 auth barrier：已经
   排队的 config reload 不受后来创建的 OAuth barrier 反向阻塞；OAuth 之后入队的
   reload/ensure 则必须等待该认证完成 safe drain。这样不会形成“旧 reload 等新
   auth、而新 auth 又等旧 reload”的环形等待。

未来只有在 ACP 提供可靠 cancellation，或 callback broker 能按不可伪造 token 完整
隔离多个认证时，才可以放宽全局串行化；这不是当前架构成立的前提。

## 13. 接口与 SDK 边界

### 13.1 路由所有权

```text
/workspace/config/...                 全局/User 配置 owner；部分领域兼容 primary 命名
/workspace/runtime/...                primary WorkspaceRuntime
/workspaces/:workspace/config/...     指定工作区的 Workspace scope 配置
/workspaces/:workspace/runtime/...    指定 WorkspaceRuntime 的状态与命令
/sessions/...                         Session 生命周期和执行
```

以上是 Target 路由分类。Foundation 新增的 runtime 路由只有 primary/qualified
`ensure` 与 `status`；现有 MCP、Skills、Extensions 等领域路由仍按 legacy 契约运行。

- config 路由负责安装、CRUD、enable/disable 和 durable commit；
- runtime 路由负责 ensure、status、Catalog、领域 reload/auth 和 operation；
- runtime 命令必须经过 trust gate；敏感 config/runtime mutation 还必须经过 strict
  mutation gate。`ensure` 使用普通 daemon mutation admission；
- qualified 路由必须先解析唯一 WorkspaceRuntime，禁止 fallback；
- scope/owner 约束必须由 daemon 路由强制执行；SDK 类型只是调用侧约束，raw HTTP
  客户端不能通过 singular 路由写 Workspace scope；
- 旧路由仅作为兼容 adapter，不得成为新页面的隐藏兜底。

Foundation 通过 daemon capability `workspace_runtime` 宣告上述 ensure/status
契约。只有当前所有可路由 WorkspaceRuntime 的 Bridge 都提供 lifecycle snapshot 时
才发布该 capability；不支持的注入式或旧 Bridge 调用 runtime 路由时返回
`501 workspace_runtime_not_supported`，服务端不会根据 `isChannelLive` 合成 epoch
或状态。这是迁移兼容边界，不是第二套 lifecycle 实现。

Extensions 的边界尤其需要明确：

- `GET /.../config/extensions` 读取 durable inventory；install/check/update/uninstall 和
  User scope enable/disable 只走全局 config owner；qualified config 路由只写该
  workspace override；
- `GET /.../runtime/extensions` 读取带 epoch 的实际 Catalog，GET 不启动 ACP；
- `POST /.../runtime/ensure` 是管理区域唯一的通用 Runtime 激活入口；页面不选择
  Extension 或其他 capability；
- `/.../config/extensions/refresh` 不得直接调用 Bridge 或启动 runtime。旧
  `/workspace/extensions/refresh` 若暂时保留，只是 legacy Session-centric adapter，
  新 SDK/UI 不调用它；该 legacy-primary adapter 的 operation namespace 与全局 config
  owner、qualified workspace owner 都必须隔离。

MCP 与 Skills 遵循同一分层：

- MCP 的 `GET/PUT/DELETE /.../config/mcp/servers` 和
  `POST /.../config/mcp/:server/{enable,disable}` 只读写 durable desired state；User
  scope 只允许 singular/global owner，qualified 路由只允许 Workspace scope；
- config inventory 同时返回每个禁用 server 的 User/Workspace owner；页面不能用
  server 定义所在 scope 猜测 `mcp.excluded` 的 owner，尤其不能把 secondary workspace
  的覆盖写进 primary workspace；
- `GET /.../runtime/mcp`、runtime reload/restart、approve/authenticate/clear-auth 和
  runtime operation 属于对应 WorkspaceRuntime。runtime 路由不提供持久化
  enable/disable；
- Skills 的 `GET /.../config/skills` 以及 config install/delete/enable 只使用
  daemon-local inventory 和设置，不查询 live ACP Catalog。global scope 只允许
  singular/global owner，qualified 路由只允许 Workspace scope；
- `GET /.../runtime/skills` 返回当前 epoch 的实际 Skills，`ensure` 负责启动和准备完整
  Runtime，
  包括 Extension 注入内容。只存在于 runtime Catalog、未出现在 config inventory 的
  Extension Skill 是只读项；其来源 Extension 的激活通过 Extension config owner
  管理，Skills 页面不能对它执行 enable/delete。

### 13.2 SDK transport

Workspace config/runtime API 是 daemon REST 控制面，不是 ACP Session method。
`WorkspaceDaemonClient` 必须显式使用 REST transport，除非 ACP HTTP/WS route table
完整实现同名路由并有等价测试。不能依赖默认 transport 后再遇到 404。

Foundation SDK 已提供：

- primary `ensureWorkspaceRuntime()` / `workspaceRuntimeStatus()`；
- qualified `WorkspaceDaemonClient.ensureRuntime()` / `runtimeStatus()`；
- REST-only transport，以及 62 秒客户端 ensure timeout。

Target SDK 还应直接提供：

- config mutation 及其 durable result/activation；
- Catalog 查询；
- active operation 查询、`getOperation`/`waitForOperation`（命令型长任务）、runtime
  status polling（幂等 ensure/reconcile）；
- 一个端到端 deadline/AbortSignal，而不是每阶段重置 timeout；
- runtime epoch、source、generation 和 stale 语义的类型。

SDK 方法必须按 owner 收窄，而不是依赖服务端 400/404 纠正错误调用：

- `DaemonClient` 承载全局 Extension install/check/update/uninstall、User scope MCP 和
  global Skill mutation；
- `WorkspaceDaemonClient` 只承载 qualified Workspace config 与对应 runtime API；
- Workspace runtime MCP action 类型只包含 approve/authenticate/clear-auth，
  enable/disable 必须调用 config 方法；
- qualified client 不暴露必然被 global-owner gate 拒绝的 Extension mutation。

Target 管理区域在进入目标 workspace 或切换 workspace 时调用一次
`ensureWorkspaceRuntime()`；当前 epoch 已完整 ready 时 Coordinator 直接返回，不重复
初始化。Extensions、MCP、Skills 页面只读取各自的 config inventory、runtime status
和 runtime Catalog。
页面不存在 capability-selecting prepare，也不调用
`refreshWorkspaceConfigExtensions()` 作为新架构 runtime command。

UI 不直接调用 Bridge/ACP 兼容接口。

WebShell 选择 Session 后，三个管理页必须把该 Session 的规范化 `workspaceCwd`
显式传给 workspace hooks；页面切换工作区时重建本地页面状态。Provider 的 primary
workspace 只作为没有显式 workspace owner 的兼容默认值，不能覆盖活动 Session 的
workspace，也不能让 qualified action 回落到 primary runtime。

#### Web Shell 迁移计划

Web Shell 只有在 capability readiness 和 Catalog freshness 契约可用后才切换到
runtime API。迁移至少满足：

1. ensure 启动标准 capability 收敛，或明确返回可供页面轮询的 capability 状态；
2. Skills snapshot 记录 live ACP 来源、`runtimeEpoch` 和 capability revision；
3. daemon-local Skills fallback 在新 epoch live 后不能遮蔽当前 ACP Catalog；
4. Extension generation 或 Skills mutation 使同一 epoch 的旧 Skills snapshot 失效；
5. primary 使用 singular ensure，secondary 使用 qualified ensure，任何失败都不回退
   到其他 workspace；
6. ensure 成功后的 Catalog 读取只接受当前 epoch/revision 的 live 结果，页面无需 sleep
   或依赖缓存 TTL。

### 13.3 状态观察

以下为 **Target**：

`GET /runtime/status` 是 capability 收敛的权威观察接口；
`GET /runtime/operations` 返回当前 WorkspaceRuntime 中仍为
`running/waiting_for_input` 的命令型任务，`GET
/runtime/operations/:operationId` 返回指定任务的权威状态。active collection 和
by-id 状态都保留 OAuth 的 `deadlineAt` 与 `authUrl`，因此页面刷新或重新进入时可以
恢复观察，而不重复启动认证。Runtime capability 收敛不通过 Session EventBus 广播；
SDK/UI 只通过 operation/status polling 保证最终收敛，也不会为了观察状态创建隐藏
Session。

## 14. 三个管理页面的目标流程与验收

各 capability 的单一所有权和失效条件如下：

| Capability | Desired owner                                           | 顺序 token                            | Runtime initializer                      | Status/cache owner | 主要失效条件                                    | 下游页面                    |
| ---------- | ------------------------------------------------------- | ------------------------------------- | ---------------------------------------- | ------------------ | ----------------------------------------------- | --------------------------- |
| Extensions | daemon Extension Store                                  | Store generation + reconcile revision | 当前 epoch 的 ACP Config refresh         | Coordinator        | Extension generation、revision、epoch           | Extensions、MCP、Skills     |
| MCP        | User/Workspace settings、Secret、Extension contribution | Coordinator capability revision       | 当前 epoch 的 ACP MCP discovery          | Coordinator        | MCP revision、Extension generation、epoch、auth | MCP、Agent Tool selector    |
| Skills     | Skill store、settings、Extension contribution           | Coordinator capability revision       | 当前 epoch 的 ACP Config/Skill discovery | Coordinator        | Skills revision、Extension generation、epoch    | Skills、Agent editor        |
| Tools      | settings、Extension contribution                        | epoch + Extension-derived revision    | 当前 epoch 的 ACP ToolRegistry           | Coordinator        | Extension generation、epoch                     | Agent editor、Tool selector |

模块可以保留自己的原始结果缓存，但它们是 Coordinator 状态的输入，不是第二个
可写状态源。

三个页面共享同一个管理区域 Runtime 入口，但 config inventory 与 runtime Catalog
始终是两份明确的数据：

```text
进入 workspace 的管理区域 -> ensureRuntime()（不传 capability，同 epoch ready 时为 no-op）
  -> Coordinator 确保一个 ACP Runtime 并准备标准能力
  -> 各页面读取 config desired state / runtime status / 自己的 Catalog
  -> 轮询 operation/status 等待终态
  -> 页面切换复用同一 runtime/epoch；手动刷新仍调用统一 ensure 或领域命令
```

任何页面都不得创建隐藏 Session、选择已有 Session、遍历 Session 进行刷新，或自己
组合 preheat/initialize/按 capability 启动/reload/poll 状态机。普通 config/status/
Catalog GET 始终保持只读，不以“页面加载”为理由启动 ACP。

### 14.1 Extensions 管理页

页面需要同时展示：

- 控制面：已安装版本、更新状态、全局默认激活、工作区覆盖；
- 运行时：当前工作区实际加载的 Extensions；
- 协调状态：desired/applied generation、operation 和 warning。

验收条件：

1. 无 ACP、无 Session 时可以安装、更新、卸载和修改激活策略。
2. durable commit 成功后立即显示已保存；cold runtime 返回 `deferred`。
3. live runtime 的变更进入 reconcile operation，页面显示
   `preparing/committing/reconciling/terminal`，不自行刷新 Session。
4. 零 Session 的 live runtime 能刷新基础 Config 和 MCP discovery Config。
5. 有 Session 时同一个 workspace reconciliation 覆盖基础 Config、discovery Config
   和全部 Session Config。
6. 只有当前 epoch 的 applied generation 等于 desired generation 时显示 ready。
7. Extension 变更后，Skills、Tools、MCP、Agents、Hooks 等派生 Catalog 一并失效，
   不继续展示旧的 ready 数据。
8. 全局 Extension 变更对所有受影响工作区分别显示 applied/deferred/warning。
9. 页面本身只读 config/status/Catalog，不隐式 preheat；管理区域统一调用一次
   `ensureRuntime()`。手动刷新调用同一无参数入口后重读 status/Catalog，不调用
   config refresh，也不传 `extensions` capability。
10. runtime 行为只能用当前 epoch Catalog 覆盖 config inventory 中的
    `isActive/capabilities/details`；Catalog 未初始化、epoch 不匹配或 applied epoch/
    generation 未收敛时，保留可编辑的 config inventory 并显示 pending/stale。

### 14.2 MCP 管理页

页面需要区分：

- 控制面：User/Workspace 配置、enable 状态和 Secret 是否已配置；
- 运行时：discovery 状态、连接、认证、Tools 和 Resources；
- operation：ensure/reload/auth 的进行中与终态。

验收条件：

1. 无 ACP、无 Session 时可以安装/导入、编辑、删除、enable/disable MCP 配置。
2. qualified workspace config 路由不能修改 User scope。
3. 配置提交与 runtime reload 分开报告；reload 慢或失败不显示为“保存失败”。
4. `ensureRuntime()` 在当前 epoch 完成 MCP discovery 后才把 MCP 标为 ready；请求预算耗尽后
   后台继续，页面通过 operation/status polling 观察终态，而不是只 reload 一次。
5. Catalog 为空、not_started、starting、stale 和 error 在页面上可区分。
6. OAuth 在零 Session 时可完成；任一工作区存在进行中的认证时，其他
   workspace/server 的认证请求由 daemon-global lane 明确拒绝，不会抢占 callback。
7. auth operation 在 waiting_for_input 期间不会因最后一个 Session 关闭而被回收。
8. ACP 重启后不会用旧 epoch 的 completed cache 跳过 discovery。
9. User scope 变更会失效并通知所有受影响工作区，不只通知 primary UI。
10. pending OAuth 对应的 MCP 配置被删除或 reload 后，Catalog 缺少该 server 不会结束
    operation；只有 provider completion notification 或 owning epoch 退出才释放认证
    lane。
11. 页面刷新、切换后重新进入或客户端等待超时时，通过 active operation collection
    恢复同一 `operationId`、服务端 `deadlineAt` 和 `authUrl`；不得重启认证、延长
    deadline 或把观察失败报告成 daemon 已取消任务。

### 14.3 Skills 管理页

页面需要区分：

- 控制面：本地已安装 Skill 和 enable 配置；
- 运行时：当前工作区实际加载的 Skills，包括 Extension 注入内容；
- 数据来源：live、stale cache 或 config/local fallback。

验收条件：

1. 无 ACP、无 Session 时可以列表、安装、卸载和 enable/disable 本地 Skill。
2. 控制面列表不因 ACP 不存在而失败，也不伪装成 runtime-ready Catalog。
3. 查询实际有效 Skills 时由管理区域先调用无参数 `ensureRuntime()`，Skills 页面只读
   当前 epoch Catalog，不创建 Session。
4. Extension generation 变化会失效 Skills runtime Catalog。
5. ACP 退出后旧列表明确标记 stale；空列表不会表示 not_started。
6. 页面不调用 preheat/MCP initialize，也不依赖 Session create/load/close 事件刷新。
7. config mutation 只以 daemon-local inventory 校验本地 Skill；live Catalog 落后不能让
   已落盘 Skill 的 enable/delete 返回 not found。
8. 只由当前 runtime 的 Extension 注入、未出现在 config inventory 的 Skill 可以查看
   和调用，但 enable/delete 控件保持只读。
9. global Skill 安装或删除会失效所有已注册工作区的 config inventory cache，cold
   workspace 也能立即读到新 durable state。

### 14.4 跨页面共同验收

- daemon 启动后保持零 Session、零 ACP child，三个页面的 config 管理均可用；
- 三个页面共享一次无参数 ensure，同一工作区只启动一个 ACP Runtime；
- 不同工作区不共享 Workspace scope Config、runtime cache、capability revision 或
  operation 状态；User scope desired state、全局 Extension generation 和 OAuth
  authentication lane 是按真实资源作用域刻意共享的，
  但每个 workspace 的 applied generation、epoch 和 auth operation 仍严格隔离；
- 未知工作区不回退 primary；未信任工作区仍可读取 daemon-local config inventory，
  但 runtime command 和敏感 Workspace scope mutation 明确失败，global config owner
  不受 primary workspace trust 影响；
- 最后一个 Session 关闭不影响页面正在进行的 operation；
- 最后一个普通 runtime lease 释放后，默认或 `0` 立即回收 ACP child；裸 preheat
  保留到首次使用；配置正值或 active keepalive 时，在较长窗口内复用同一 runtime/epoch；
- 显式 `ensure` 成功后至少保活十分钟，使紧随其后的状态与 Catalog 读取能够观察到
  已初始化的 runtime；再次 `ensure` 会续期该窗口；
- 外层 runtime-control lease 连续覆盖一次 ensure；回收只能在同一 epoch 完成所请求的
  RPC 且 lease 排空后执行；
- 非 `force` workspace removal 会把零 Session 的 ensure、Catalog、reconcile、OAuth
  等 runtime work 计为 busy；进入 draining 后的新管理命令明确失败；
- Session create/load/close 不再作为任何管理 capability 的初始化或失效信号；
- 敏感 config/runtime mutation 经过 strict mutation gate。`ensure` 与 Session
  创建使用相同的普通 daemon admission：无 token 的 loopback 开发模式可调用；
  配置 token、`--require-auth` 或非 loopback 部署仍要求 bearer auth。

## 15. 渐进落地顺序

### 阶段一：收口所有权（Foundation 已完成）

- 让 WorkspaceRuntime 聚合成为唯一运行时边界；
- Bridge 收口 channel、epoch、物理 lease 和 idle 回收；
- Coordinator 只投影 runtime lifecycle，并提供无 capability 参数的 ensure/status；
- 将 Coordinator 纳入 workspace drain、removal 和 daemon shutdown；
- 保持现有领域 mutation 路由不变，不在 foundation 中引入 MCP、Extension 或 Skills
  专属状态。

### 阶段二：收口状态与 operation（未开始）

- Coordinator 增加 capability、Extension generation、MCP/Skills revision 和
  operation 投影；
- 所有 capability 状态绑定 epoch；
- 清除跨 epoch ready 合并；
- 将 Extension desired/applied generation 更新改为同一 runtime 回执，MCP/Skills 使用
  revision + epoch 丢弃迟到结果；
- 使用绝对 deadline；幂等收敛由 status、命令型长任务由 operation 暴露终态；
- 将 durable result 与 activation 响应拆开，不发明嵌套 commit wire object；
- 让 MCP OAuth 使用 daemon-global authentication lane，并在无取消契约时 safe drain。

### 阶段三：迁移模块和 SDK（部分完成）

- 已完成：Workspace SDK 的 foundation ensure/status 对 runtime 路由显式使用 REST；
- 待完成：SDK config/runtime Catalog、operation 和 capability status 契约；
- 待完成：Skills snapshot 增加 live source、runtime epoch 和 revision freshness；
- 待完成：Web Shell 接入 primary/qualified ensure；
- Extensions、MCP、Skills 页面迁移到统一 config/runtime/operation 模型；
- 管理区域以无参数 runtime ensure 启动完整标准能力，各页面不再传 capability；
- Extensions 页面从 runtime Catalog 取得实际状态，不从 config refresh 调 Bridge；
- User scope 状态失效覆盖所有受影响工作区；可选事件也要 fan out；
- 新页面不再调用 legacy preheat、initialize 或 Session API。

### 阶段四：清理兼容入口（未开始）

- 在所有调用方迁移并有回归测试后，标记旧 preheat、MCP initialize 和
  `/workspace/extensions/refresh` 路由 deprecated；
- 在调用方迁移并验证首请求延迟后，移除 production startup preheat 默认策略；
- 删除重复的前端轮询和模块级可写状态投影；
- 根据 Bridge 剩余职责决定是否重命名，不为了命名本身扩大改动。

## 16. 验证策略

### 16.1 Foundation 已验证范围

Foundation 的自动化验证覆盖：

1. lifecycle 五态、epoch 单调、所有已接入物理 work lease 和 idle 回收；
2. primary/qualified ensure/status 的 scope、trust、draining、removed、501 兼容行为
   以及禁止 primary fallback；
3. 并发 ensure、10 分钟续期、不同 keepalive 取最长窗口和启动失败后的重试；
4. Channel factory/initialize 绝对启动 deadline、AbortSignal、迟到 child 清理；
5. OAuth pending lease、期限到达前的最终状态确认，以及无法证明完成时在现有 Session
   排空后通过 owning Channel 退出安全排空；
6. production 默认预热受信任 primary、不预热 untrusted primary，以及显式
   `preheatBridge: false` 的 opt-out；
7. SDK REST 路由与 timeout。

此外已通过相关单元测试、lint、build 和 typecheck。仍建议在合并前补充或人工执行
真实 ACP child E2E，验证进程级时序而不只验证 mock 契约。

### 16.2 Target 完整迁移验证

后续实现不能只验证单个路由成功，至少覆盖：

1. **零 Session E2E**：分别完成 Extensions、MCP、Skills 页面完整管理流程。
2. **epoch 重建**：准备成功后通过显式正值 idle timeout、child crash 或 restart 重建，
   确认旧 cache 只为 stale，新 runtime 重新初始化。
3. **并发**：同 workspace 并发 ensure、MCP mutation/reconcile 串行化；先入队
   reload 与后创建 OAuth 不互锁，OAuth 后入队的 reload 等待 safe drain；跨
   workspace OAuth 全局拒绝/串行、User scope fan-out。
4. **慢路径**：ACP 启动、MCP discovery、Extension reconcile 超过 HTTP 等待预算后，
   capability status 或命令型 operation 仍到达正确终态。
5. **持久化失败矩阵**：commit 成功但 activation 失败、cold deferred、部分工作区
   reconcile 失败。
6. **生命周期**：最后 Session 关闭、waiting_for_input、在途 Catalog RPC、显式正值
   idle 窗口复用和 daemon shutdown。
7. **隔离与安全**：unknown/draining/removed 均不 fallback；untrusted workspace 的
   runtime command 必须通过 trust gate，敏感 Workspace scope mutation 还必须通过
   strict mutation gate。`ensure` 遵循普通 daemon auth admission；daemon-local
   config GET 仍可读，global config owner 不受 primary trust 影响。
8. **SDK transport**：REST、ACP HTTP/WS 模式下 Workspace client 都不会把 daemon
   runtime 路由误发为 ACP method。
9. **连续 lease**：未配置 idle timeout 或显式配置 `0` 时，普通 runtime work 排空后立即回收；
   裸 preheat 自身保留到首次使用；显式正值或 active keepalive 取较长窗口。兼容 preheat 保留旧资源语义；显式 `ensure` 额外登记
   可续期的 10 分钟 workspace 保活窗口。Capability RPC 与最终状态投影不跨 epoch，
   物理回收只发生在外层 runtime-control lease 释放后。
10. **OAuth 排空**：认证 pending 时删除配置或 reload，Catalog 缺失不释放 auth
    lease；completion notification、listener 清理、operation 终态和全局 lane 释放按
    此顺序发生。
11. **Draining/removal**：零 Session runtime work 使非强制移除返回 busy；已解析请求在
    drain 后不能启动新物理工作；draining 期间的 global config invalidation 在回滚后
    重放，重放失败时后续 ensure 继续重试而不接受旧 Catalog。
12. **控制面独立性**：live 但 Catalog 落后时，本地 Skill 仍可通过 config API
    enable/delete；global Skill mutation 会失效其他 workspace 的 config cache；
    runtime-only Extension Skill 保持只读。
13. **SDK owner contract**：每个 typed mutation 都有与其 owner 对应的可达路由；runtime
    MCP 类型不接受 enable/disable，qualified client 不暴露 global-only Extension
    mutation。
14. **管理页 owner contract**：在 primary 和 secondary workspace 各打开一次三个管理
    页；每个 workspace 只调用无参数 ensure，所有 runtime/status/Catalog/Workspace
    scope mutation 都命中活动 Session 的 workspace，User/global mutation 命中全局
    config owner，且没有 capability 参数或 singular primary runtime fallback。

## 17. 实施原则

1. 优先修正 ownership，再修正局部 symptom。
2. 一个事实只有一个可写所有者；其他层只保存带 epoch/generation/revision 的只读
   投影。
3. 不在 daemon 和 ACP 两处重复构造完整 Config。
4. 配置提交、运行时应用和 UI 观察是三个明确阶段。
5. 所有阶段使用入口计算的绝对 deadline；HTTP 超时不等于 operation 失败；无取消
   契约时 deadline 也不等于可以释放底层资源。
6. 每增加一个 capability，必须列出初始化者、缓存所有者、失效条件和所有下游调用方。
7. 优先复用现有 Bridge 和 ACP 方法，但不保留 Session-centric 的所有权语义。
8. Extension durable commit 不因后续 reconcile 失败而回滚；用 generation、warning
   和 activation 状态表达结果。MCP/Skills 不暴露不存在的 generation，而使用内部
   revision 保证最新尝试获胜。
9. 禁止通过隐藏 Session、任意活跃 Session 或 primary fallback 完成工作区管理。
10. 迁移以第 14 节页面行为为完成标准，不以新增路由或类名为完成标准。
