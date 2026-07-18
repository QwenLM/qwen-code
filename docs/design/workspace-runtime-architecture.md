# Qwen Serve 工作区运行时中心架构

## 1. 文档定位

本文是 `qwen serve` 从 Session-centric 迁移到
Workspace-runtime-centric 的设计、当前落地边界与验收契约。

核心目标只有一个：

> Workspace 是运行时、隔离和管理边界；Session 只是 Workspace Runtime
> 中用于对话与执行的消费者。

本文中的所有权、状态和接口语义必须与本次落地保持一致；仍保留的旧入口会明确标为
兼容 adapter，而不是另一套架构。实现只有通过第 14 节的验收条件后，才算完成迁移。

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
9. GET 状态和 Catalog 请求不隐式启动 ACP。启动只能来自显式 `ensure`、其他
   runtime command 或 Session 创建。对外不提供按 capability 选择的启动接口。
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

每个 `WorkspaceRuntime` 持有一个 Coordinator。Coordinator 是以下状态的唯一
可写所有者：

- capability prepare 的合并与执行；
- 当前 epoch 的 capability status；
- Extension desired/applied generation 的工作区投影；
- MCP/Skills capability revision 和“最新尝试获胜”的收敛顺序；
- workspace runtime operation 状态（当前为 MCP）；Extension config operation 仍由
  创建它的全局或 qualified controller 独占；
- 配置变更后的 capability 失效和收敛。

调用方不得直接根据 Session 数量或某个模块缓存推断 capability 状态。

### 6.3 Bridge

Bridge 是 WorkspaceRuntime 内由 Coordinator 和兼容 adapter 调用的通信驱动，负责：

- 启动和停止 ACP 子进程；
- 建立、复用和关闭 Channel；
- 分配单调递增的 runtime epoch；
- 记录 session、handshake、workspace control、discovery 和 auth 的物理 lease；
- 在物理 lease 全部释放后投影 sticky idle，并在显式正值兼容 timeout 下计时回收；
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
WorkspaceRuntime 的底层生命周期事实，不是第二个 Session runtime。Coordinator
从 Bridge 读取这些事实并负责 capability 投影；它不复制一套相互竞争的 Channel
状态机。Bridge 只能在所有物理 lease 均为空时回收，不能仅依据 Session 数量结束
Channel。

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
idle -> stopping -> cold         opt-in positive compatibility timeout
active/idle -> cold              child crash
```

- `cold`：没有 ACP Channel，也没有正在进行的启动；
- `starting`：Channel 正在创建或 handshake 尚未完成。它是物理 runtime 生命周期
  状态，不等于某个 capability 的 `starting`；
- `active`：Channel 已 live，且至少有一个 session、workspace-control、discovery、
  auth、spawn/restore 或其他物理 work lease；
- `idle`：Channel 已 live，且没有任何物理 work lease；runtime 继续保留进程和已加载
  资源，后续工作复用同一 epoch；
- `stopping`：workspace removal、daemon shutdown、显式 restart 或可选的正值兼容
  idle timer 已决定停止 runtime；并发新工作等待停止完成后启动新 epoch。

注册 WorkspaceRuntime 不启动 ACP child。Primary 与 secondary 一致，只有显式
runtime command（包括 `ensure`）或 Session create/load/resume 才从 `cold` 启动。

若 Channel 已 live，Coordinator 中存在 capability reconcile 并不能单独把顶层状态
标为 `starting`；实际 RPC 持有 workspace-control/discovery/auth lease 时顶层为
`active`，lease 释放后为 `idle`。Capability 自己仍可保持 `starting`。顶层投影
的优先级是 `stopping`，然后是 cold Channel 上的 `starting/cold`，再是 live Channel
上的 `active`；只有 live 且无物理 work 时，capability error 才把 `idle` 覆盖为
`error`。该 `error` 是聚合健康状态，不是第二套物理生命周期。

### 8.2 Lease 模型

当前 Bridge 用 session 集合、spawn/restore 计数、workspace-control 计数、MCP discovery
标记和带 `operationId` 的 MCP auth Map 表示物理 work。Coordinator 通过 Bridge 的外层
runtime-control lease 包住一次完整 runtime command；其中的 Catalog、Extension
refresh、Skills refresh 和普通 runtime mutation 仍可嵌套使用 workspace-control
计数，但不能在阶段之间释放最后一个物理 lease。Coordinator 不再建立第二套用于
物理生命周期的可写“逻辑 lease”。这些计数和 Map 不对调用方开放。Coordinator 另外维护仅用于
workspace removal admission 的 daemon-local management operation 计数；它覆盖尚未进入
Bridge 的配置持久化和 Extension 后台提交，但不参与顶层 `active/idle` 投影或 ACP idle
回收判断。

约束：

- Session create/load 获取 session lease，close 只释放自己的 lease；
- ensure 和需要启动 runtime 的 mutation 在 Channel 创建/handshake 之前取得外层
  runtime-control lease，并连续持有到所有 capability 阶段和最终状态投影完成；不能在
  preheat、Catalog、refresh、discovery 之间留下 idle 回收窗口；
- 单独的 Catalog RPC、MCP discovery/auth、Extension reconciliation 和 runtime
  mutation 在进入物理工作前取得对应的 workspace-control/discovery/auth lease；
- handshake、callback、等待用户输入和清理阶段仍属于操作，lease 不得提前释放；
- 所有请求结束、成功取消或完成 safe drain 后都必须释放自己的 lease；没有取消
  契约的失败/超时不能仅因观察者停止等待就释放 auth lease；
- 最后一个 Session 关闭不能越过其他 lease 结束 runtime；
- Bridge 的 status/Catalog 请求必须在整个 RPC 期间持 workspace-control lease，
  避免被 idle 回收中断。

### 8.3 Sticky idle

最后一个物理 work lease 释放后进入 `idle`。WorkspaceRuntime 默认保持 live，直到
workspace removal、daemon shutdown、child crash 或显式 restart；Session 数量归零和
管理请求结束都不会自动停止它：

1. 新 lease 直接复用当前 runtime 和 epoch；
2. 合法的 runtime 请求更新 `lastActivityAt`；
3. 未配置 `channelIdleTimeoutMs`（默认）时禁用自动回收；
4. 显式正值启用兼容 idle timer；到期时 Bridge 再次确认 session、spawn/restore、
   workspace-control、MCP discovery 和 auth work 均为空后停止 runtime；
5. daemon shutdown 和 workspace removal 可以统一结束对应子进程。

`0` 不代表另一种生命周期策略，而是非法配置。默认常驻通过未配置表达，兼容自动
回收只接受正数，避免管理命令退化为每次拉起和销毁 ACP Runtime。

Session 数量不是回收条件，只是 lease 集合的一部分。

### 8.4 Draining 与移除

Workspace removal 的 activity 判断必须包含 Session 之外的所有 runtime work：外层
runtime-control、Catalog/refresh、MCP discovery/auth、后台 capability 收敛和未终结
operation，以及已接纳但尚未完成的 workspace-scoped 配置和管理操作。非 `force`
移除遇到任一活动项都返回 `workspace_busy`。

进入 `draining` 后，Registry 先阻止新的路由解析，Coordinator 同时关闭新的 ensure、
reconcile 和 runtime operation admission；已经解析但尚未开始物理工作的请求也必须以
`workspace_draining` 失败。若移除在持久化提交前回滚，Registry、Coordinator 和其他
admission gate 一并恢复；draining 期间收到的 User/global MCP 或 Skills 配置失效必须
保留为待 reconcile 状态，回滚后立即重放，且重放成功前 ensure 不得把旧 Catalog
重新标成 ready。提交后的强制清理才可以终止现有 work。

## 9. Runtime epoch、Catalog 与缓存

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

调用方不选择 capability，也不传初始化顺序。Coordinator 在内部固定准备当前标准能力
`extensions -> (mcp, skills, tools)`，并合并同一工作区、同一 capability 的并发工作：

1. 校验工作区解析和 trust 状态；
2. 通过 Bridge 获取外层 runtime-control lease；
3. 确保 Workspace ACP Runtime 存在并等待 handshake；
4. 在当前 epoch 加载 Extension desired generation，或捕获 MCP/Skills 当前
   capability revision；
5. 初始化完整标准 capability 集合；
6. 更新可轮询的统一状态；
7. 请求完成、失败或达到后台收敛 deadline 后释放物理 work lease。

这里第 2 步取得的是一次调用的外层连续 runtime-control lease。它覆盖第 3 至第 7 步，
默认未配置的 idle timeout 禁用自动回收，不能导致 preheat 成功后、首个 capability
RPC 前换 epoch。正值兼容回收策略也只能在整个命令完成且 lease 排空后执行。命令返回
的 `status` 在外层 lease 释放后重新投影，因此 child 在释放期间退出时不会返回已经
过期的 `runtimeLive: true`，而是准确反映 `stopping` 或 `cold` 状态。

Coordinator 内部先 prepare Extensions，再并行处理其派生的 MCP、Skills、Tools，
避免后处理的 Extension generation 变化立即使本次其他 Catalog 过期。Extensions 未
ready 时不能用旧 runtime snapshot 把派生 capability 重新标为 ready。

`ensure` 是幂等状态收敛：当前 epoch 的全部标准 capability 已 ready 时直接返回状态，
不重复刷新，也不为每次 HTTP 调用创建独立 operation record。请求预算
耗尽时返回 capability `starting`，客户端轮询 `/runtime/status`。Coordinator 可以在
一个有界后台 deadline 内继续当前收敛；到期必须进入明确 `error`，不能无限续期。
后续显式 ensure、领域 runtime command 或配置事件可以发起新的收敛尝试。

按 capability 的 prepare 只是 Coordinator 的内部实现，不暴露 HTTP 或 SDK 接口。
新增 capability 时只修改 Coordinator 的标准能力集合和初始化逻辑。

### 11.2 Operation 状态

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

每次 ensure 或 operation 在入口创建绝对 deadline。每个阶段只使用剩余预算，
不得让 preheat、discovery、refresh 或每次 UI poll 各自重新获得一份完整 timeout。
当前 ensure 同时有调用方等待 deadline 和一次性创建的有界后台收敛 deadline；前者
到达可以先返回 `starting`，后者不会随 poll 重置。MCP auth 从首次 Bridge 调用到状态
observer 共用同一个 `deadlineAt`。

HTTP/SDK 请求超时与 operation deadline 是不同概念：

- ensure 的 HTTP 等待预算结束时返回 `starting`，命令型 operation 返回
  `operationId`；
- 请求断开不自动宣告 operation 失败；
- operation 是否继续、取消或超时由其 deadline 和取消策略决定；
- UI 通过 operation/status 查询观察终态。

若底层有取消契约，deadline 到达时先请求取消。只有底层任务已经停止、完成必要
清理，或已被安全地从 ACP 生命周期中分离后，才可以进入 timeout 终态并释放 lease。
当前 MCP OAuth 没有取消契约，因此 observer deadline 到达不能释放 auth lease 或
认证全局 lane；具体 safe-drain 语义见第 12 节。

### 11.4 持久化提交与激活

配置接口先提交 durable state，再在同一个扁平 domain result 或 operation result 中
单独表达 runtime activation。当前 wire contract 不包一层虚构的 `commit` 对象：

```ts
interface DurableMutationResult {
  // name/scope/config/changed 等领域字段；Extensions 可携带 generation
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

OAuth 是 workspace-scoped operation，但 callback listener/port 是 daemon
process-global 资源。锁和路由必须匹配真实资源作用域。

当前 ACP OAuth provider 没有取消契约，并使用可能冲突的 process-global callback
资源。因此本次落地采用保守但可证明安全的模型：

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

- config 路由负责安装、CRUD、enable/disable 和 durable commit；
- runtime 路由负责 ensure、status、Catalog、领域 reload/auth 和 operation；
- runtime 命令必须使用与其他敏感 daemon mutation 相同的严格认证和 trust gate；
- qualified 路由必须先解析唯一 WorkspaceRuntime，禁止 fallback；
- scope/owner 约束必须由 daemon 路由强制执行；SDK 类型只是调用侧约束，raw HTTP
  客户端不能通过 singular 路由写 Workspace scope；
- 旧路由仅作为兼容 adapter，不得成为新页面的隐藏兜底。

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

SDK 应直接提供：

- config mutation 及其 durable result/activation；
- 无参数 `ensureRuntime()`、`getRuntimeStatus` 和 Catalog 查询；
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

管理区域在进入目标 workspace 或切换 workspace 时调用一次
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

### 13.3 状态观察

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
6. OAuth 在零 Session 时可完成；不同 workspace/server 的并发由 daemon-global lane
   串行化，不会抢占 callback。
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
- 最后一个物理 lease 释放后进入 `idle`；关闭最后一个 Session 或离开管理页面后再次
  打开会复用同一 runtime/epoch；
- 外层 runtime-control lease 连续覆盖一次 ensure；未配置 idle timeout 时禁用自动
  回收，正值 timer 只能在同一 epoch 完成所请求的 RPC 后执行，`0` 配置明确失败；
- 非 `force` workspace removal 会把零 Session 的 ensure、Catalog、reconcile、OAuth
  等 runtime work 计为 busy；进入 draining 后的新管理命令明确失败；
- Session create/load/close 不再作为任何管理 capability 的初始化或失效信号；
- 所有 config/runtime mutation 经过严格 daemon 认证。

## 15. 渐进落地顺序

### 阶段一：收口所有权

- 让 WorkspaceRuntime 聚合成为唯一运行时边界；
- Bridge 收口 channel、epoch、物理 lease 和 idle 回收；
- Coordinator 收口 capability、Extension generation、MCP/Skills revision 和 runtime
  operation 投影；
- 分离全局 config controller 与 qualified workspace config controller 的 operation、
  interaction 和 mutation 权限；
- 移除“最后 Session 关闭即结束 Channel”的语义；
- 为所有 workspace 路由标注 control/runtime/session scope。

### 阶段二：收口状态与 operation

- 所有 capability 状态绑定 epoch；
- 清除跨 epoch ready 合并；
- 将 Extension desired/applied generation 更新改为同一 runtime 回执，MCP/Skills 使用
  revision + epoch 丢弃迟到结果；
- 使用绝对 deadline；幂等收敛由 status、命令型长任务由 operation 暴露终态；
- 将 durable result 与 activation 响应拆开，不发明嵌套 commit wire object；
- 让 MCP OAuth 使用 daemon-global authentication lane，并在无取消契约时 safe drain。

### 阶段三：迁移模块和 SDK

- Workspace SDK 对 config/runtime 路由显式使用 REST；
- Extensions、MCP、Skills 页面迁移到统一 config/runtime/operation 模型；
- 管理区域以无参数 runtime ensure 启动完整标准能力，各页面不再传 capability；
- Extensions 页面从 runtime Catalog 取得实际状态，不从 config refresh 调 Bridge；
- User scope 状态失效覆盖所有受影响工作区；可选事件也要 fan out；
- 新页面不再调用 legacy preheat、initialize 或 Session API。

### 阶段四：清理兼容入口

- 在所有调用方迁移并有回归测试后，标记旧 preheat、MCP initialize 和
  `/workspace/extensions/refresh` 路由 deprecated；
- 删除重复的前端轮询和模块级可写状态投影；
- 根据 Bridge 剩余职责决定是否重命名，不为了命名本身扩大改动。

## 16. 验证策略

实现不能只验证单个路由成功，至少覆盖：

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
6. **生命周期**：最后 Session 关闭、waiting_for_input、在途 Catalog RPC、sticky
   idle 复用和 daemon shutdown。
7. **隔离与安全**：unknown/draining/removed 均不 fallback；untrusted workspace 的
   runtime command 和敏感 Workspace scope mutation 必须通过严格认证与 trust gate，
   daemon-local config GET 仍可读，global config owner 不受 primary trust 影响。
8. **SDK transport**：REST、ACP HTTP/WS 模式下 Workspace client 都不会把 daemon
   runtime 路由误发为 ACP method。
9. **连续 lease**：idle timeout 为 `0` 时不自动回收；显式极小正值时，preheat、
   capability RPC 与最终状态投影不跨 epoch，物理回收只发生在外层
   runtime-control lease 释放后。
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
