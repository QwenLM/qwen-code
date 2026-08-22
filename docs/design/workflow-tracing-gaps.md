---
description: "Analyze Qwen Code workflow tracing gaps and identify missing span boundaries for clearer agent execution observability."
---

# Workflow 级 Span 粒度不足分析 (P1)

> 基于 2026-05-13 对 qwen-code origin/main 的复核

## 现状

qwen-code 已具备 tracing 基础设施：

| 组件          | 位置                                             | 说明                                                     |
| ------------- | ------------------------------------------------ | -------------------------------------------------------- |
| Span 类型定义 | `packages/core/src/telemetry/session-tracing.ts` | `interaction`、`llm_request`、`tool`、`tool.execution`   |
| Tracer 工具   | `packages/core/src/telemetry/tracer.ts`          | session root context、`withSpan`、`startSpanWithContext` |
| 交互入口      | `packages/core/src/core/client.ts`               | 顶层交互显式启动 `interaction` span                      |
| 生命周期管理  | —                                                | AsyncLocalStorage + WeakRef + TTL cleanup                |

当前 runtime 中稳定接入的主要是两类 generic spans：

- `api.generateContent` / `api.generateContentStream`
- `tool.<toolName>`

**结论：已进入"有 tracing 主干"阶段，但尚未把 agent workflow 的阶段边界完整编码进 trace 树。**

### 对比：claude-code 已实现的 span 类型

参考 `claude-code/src/utils/telemetry/sessionTracing.ts` (line 49)：

- `interaction`
- `llm_request`
- `tool`
- `tool.blocked_on_user`
- `tool.execution`
- `hook`

## 缺失项

| 缺失 span / 机制                           | 影响                                            |
| ------------------------------------------ | ----------------------------------------------- |
| `permission_wait` / `blocked_on_user` span | 无法区分审批等待 vs 工具执行耗时                |
| `hook` span                                | hook 耗时被折叠进 tool span，定位边界不清       |
| `subagent` root span                       | subagent 内部 llm/tool 调用无法形成 trace 子树  |
| `tool.execution` 真实接线                  | helper 已定义但主链路未调用                     |
| 稳定的 parent-child wiring                 | spans 多为 session root 下的 sibling 而非层级树 |

## 逐项分析

### 1. 用户审批等待不在 trace 中

工具调用等待审批时，状态迁移路径为 `awaiting_approval` → `scheduled` → 执行。

- "等待用户确认"只是状态迁移，不是 trace 节点
- trace 上看不到审批等待耗时
- 工具慢时无法区分是"卡在等用户"还是"工具本身执行慢"

### 2. Hook 有事件记录但没有独立 span

Pre/Post hook 执行后产出 `HookCallEvent`，走 `logHookCall()`，但不建立独立 OTel span。

- hook 变慢时表现为外层 tool span 变慢
- hook 失败时表现为 "tool 失败"
- trace 无法回答"时间花在 hook 还是 tool.execution 上"

### 3. Subagent 是 log/metric 而非 trace subtree

subagent 启动/完成时记录 `SubagentExecutionEvent` 并进入 log/metric，但没有形成显式 span 子树。

- 能统计"哪个 subagent 跑过"
- 不能顺着 trace 看"这个 subagent 触发了哪些 llm/tool 调用"
- 并发 subagent 场景下因果链不清

### 4. tool.execution helper 已定义但未接入主链路

`session-tracing.ts` 中已有 `startToolExecutionSpan()` / `endToolExecutionSpan()`，但非测试代码中未见调用点。

当前实际 trace 树：

```
session-root
  interaction
    api.generateContent
    tool.Bash
  subagent_execution        (log/metric)
  hook_call                 (event/QwenLogger)
```

理想 trace 树：

```
interaction
  llm_request
    tool
      tool.blocked_on_user
      hook(pre)
      tool.execution
      hook(post)
  subagent
    interaction
      llm_request
        tool
```

### 5. Parent-child wiring 不够稳定

interaction span 已存在，但很多运行中的 spans 挂在 session root 下作为 sibling，而不是 interaction 的子节点。

- 调用树偏平
- 节点间因果关系不直观
- 从一个用户轮次追到内部 llm/tool/hook/subagent 的体验不连续

## 影响

- traces 有基础价值，但不足以支撑 workflow 级排障
- 无法直接回答"这轮慢在等用户、hook，还是 tool 真执行"
- 无法把 subagent 运行过程还原为可阅读的 trace 子树
- hook 问题被折叠进 tool span，定位边界不清
- 在 Jaeger / Tempo / ARMS 上的树比 claude-code 更平、更难读

---

## claude-code 方案复用分析

> 基于 2026-05-13 对 claude-code 源码的深度对比

### claude-code 的 tracing 架构

claude-code 在 `src/utils/telemetry/sessionTracing.ts` 中实现了一个**统一的、基于双 ALS 的 span 管理系统**：

```
                    interactionContext (ALS)          toolContext (ALS)
                          │                                │
                          ▼                                ▼
              ┌─────────────────────┐           ┌─────────────────────┐
              │  interaction span   │           │    tool span        │
              │  (session root)     │           │  (child of intxn)   │
              └─────────────────────┘           └─────────────────────┘
                   ▲ parent of                       ▲ parent of
                   │                                 │
           ┌───────┴───────┐              ┌──────────┼──────────┐
           │               │              │          │          │
      llm_request      tool          blocked    execution    hook
                                     _on_user
```

**核心机制：**

| 机制        | 实现                                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 双 ALS      | `interactionContext` 存当前 interaction span；`toolContext` 存当前 tool span                                                                                                              |
| parent 解析 | 每种 span 类型硬编码从哪个 ALS 取 parent：`llm_request`/`tool` 取 `interactionContext`；`blocked_on_user`/`execution`/`hook` 取 `toolContext`；`hook` 有 fallback 到 `interactionContext` |
| 生命周期    | enterWith 注入 → span 运行 → enterWith(undefined) 清除                                                                                                                                    |
| 查找 span   | 非 ALS 存储的 span（如 blocked_on_user）通过 `activeSpans` Map 按 `span.type` 反查                                                                                                        |
| 内存管理    | ALS 持有的 span 用 WeakRef；非 ALS 持有的 span 用 strongRef 防 GC；TTL 30min 自动清理                                                                                                     |

**claude-code tool span 完整生命周期** (`toolExecution.ts`):

```
startToolSpan(name, attrs)                    // → toolContext.enterWith(spanCtx)
  startToolBlockedOnUserSpan()                // → parent = toolContext.getStore()
    [permission resolution / user prompt]
  endToolBlockedOnUserSpan(decision, source)
  startToolExecutionSpan()                    // → parent = toolContext.getStore()
    [tool.call()]
  endToolExecutionSpan({ success })
endToolSpan(result)                           // → toolContext.enterWith(undefined)
```

**claude-code hook span** (`hooks.ts`):

```
startHookSpan(event, name, count, defs)       // → parent = toolContext ?? interactionContext
  [parallel hook execution]
endHookSpan(span, { success, blocking, ... })
```

### qwen-code 现有架构 vs claude-code

#### 根本差异：两套断裂的 span 创建路径

这是 qwen-code 当前最关键的架构问题：

| 层                 | 文件                 | 用法                                                                                        | parent 解析                                               |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| session-tracing 层 | `session-tracing.ts` | `startInteractionSpan` / `startLLMRequestSpan` / `startToolSpan` / `startToolExecutionSpan` | 显式从 `interactionContext` ALS 取 parent                 |
| tracer 层          | `tracer.ts`          | `withSpan` / `startSpanWithContext`                                                         | 从 `context.active()` 取 parent，fallback 到 session root |

**runtime 实际调用情况：**

- `startInteractionSpan` → **已接入** (`client.ts` line 956)，写入 `interactionContext` ALS
- `startLLMRequestSpan` / `endLLMRequestSpan` → **未接入**，runtime 用的是 `withSpan('api.generateContent', ...)` (在 `loggingContentGenerator.ts`)
- `startToolSpan` / `endToolSpan` → **未接入**，runtime 用的是 `withSpan('tool.${name}', ...)` (在 `coreToolScheduler.ts`)
- `startToolExecutionSpan` / `endToolExecutionSpan` → **未接入**

**后果：**

`withSpan` 的 `getParentContext()` 先检查 `context.active()`（OTel 原生 context），找不到活跃 span 时回退到 session root context。它**完全不读取 `interactionContext` ALS**。

因此 interaction span 和 LLM/tool spans 变成了 session root 下的**平级 sibling**，而不是 parent-child 树：

```
session-root
  ├── interaction         (来自 session-tracing, 写入了 interactionContext ALS)
  ├── api.generateContent (来自 withSpan, 不读 interactionContext → 挂到 session root)
  ├── tool.Bash           (来自 withSpan, 同上)
  └── tool.Read           (来自 withSpan, 同上)
```

**而 claude-code 中，只有一套 span 创建路径（sessionTracing.ts），所有 span 都走同一套 ALS → OTel context 转换逻辑，所以树是完整的。**

#### 逐项复用评估

##### 1. 双 ALS + 显式 parent 解析 — 可复用，是核心修复

| 维度         | claude-code                                           | qwen-code                                    |
| ------------ | ----------------------------------------------------- | -------------------------------------------- |
| ALS 数量     | 2 (`interactionContext` + `toolContext`)              | 1 (`interactionContext`，无 `toolContext`)   |
| parent 解析  | 每种 span 类型显式指定从哪个 ALS 取 parent            | `withSpan` 统一走 `context.active()`         |
| context 注入 | `trace.setSpan(otelContext.active(), parentCtx.span)` | `withSpan` 内部由 `startActiveSpan` 隐式注入 |

**复用方案：**

qwen-code 的 `session-tracing.ts` 已经实现了与 claude-code **几乎相同的 parent 解析模式**：

```typescript
// qwen-code session-tracing.ts (已有但未用)
export function startLLMRequestSpan(model, promptId): Span {
  const parentCtx = interactionContext.getStore();
  const ctx = parentCtx
    ? trace.setSpan(otelContext.active(), parentCtx.span)
    : otelContext.active();
  // ...
}
```

这段代码与 claude-code 的 `startLLMRequestSpan` 逻辑**完全一致**。

**核心修复路径：废弃 runtime 中的 `withSpan('api.*')` / `withSpan('tool.*')` 调用，改为调用 session-tracing 的 typed helpers。** 不需要重写 session-tracing 层——它的 API 已经就绪。

需要新增的只有：

- 增加 `toolContext` ALS（仿 claude-code）
- 增加 `blocked_on_user` 和 `hook` span 类型及 helper 函数

##### 2. tool.blocked_on_user — 需要适配审批流差异

| 维度          | claude-code                                | qwen-code                                                                  |
| ------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| 审批位置      | 在 `toolExecution.ts` 内，tool span 内部   | 在 `coreToolScheduler._schedule()` 内，tool span 之前                      |
| 审批模式      | 同步等待 `resolveHookPermissionDecision()` | 状态机驱动：`validating` → `awaiting_approval` → `scheduled` → `executing` |
| span 覆盖范围 | tool span 包含 blocked + execution         | tool span(`withSpan`) 只包含 execution（从 `executeSingleToolCall` 开始）  |

**关键差异：** qwen-code 的 `executeSingleToolCall` 入口检查 `toolCall.status !== 'scheduled'` 才继续——也就是说调用到这里时审批已经完成。Tool span 的 `withSpan` 包不住审批等待。

**适配方案（两种）：**

**方案 A — 前移 tool span 起点（推荐）：**

将 `startToolSpan` 调用从 `executeSingleToolCall` 移到 `_schedule` 中审批检查之前，使 tool span 覆盖完整生命周期。在进入 `awaiting_approval` 状态时 `startToolBlockedOnUserSpan`，在审批完成（`scheduled`）时 `endToolBlockedOnUserSpan`。

```
_schedule():
  startToolSpan(name)                         // ← 新增
    startToolBlockedOnUserSpan()              // ← 新增，进入 awaiting_approval 时
      [状态机等待]
    endToolBlockedOnUserSpan(decision)        // ← 新增，进入 scheduled 时
executeSingleToolCall():
    startToolExecutionSpan()                  // ← 接入已有 helper
      [hook + execute]
    endToolExecutionSpan()
  endToolSpan()                               // ← 需要在 finally 中
```

**方案 B — 保持 tool span 位置不变，单独追踪审批：**

在 `_schedule` 中独立创建 `approval_wait` span（不作为 tool 的 child），挂到 interaction 下。好处是改动更小，坏处是与 claude-code 模型不一致、trace 树可读性差。

**建议采用方案 A**，因为：

- 与 claude-code 的 trace 树结构一致
- trace 上一个 tool 节点就能看到"等了多久 + 执行了多久"
- 状态机驱动的特性只影响 span start/end 的触发时机，不影响 parent-child 建模

##### 3. hook span — 可直接复用

| 维度          | claude-code                         | qwen-code                                                            |
| ------------- | ----------------------------------- | -------------------------------------------------------------------- |
| hook 执行入口 | `executeHooks()` in `hooks.ts`      | `firePreToolUseHook`/`firePostToolUseHook` via `hookEventHandler.ts` |
| 现有记录方式  | OTel span + Perfetto span           | `HookCallEvent` → `QwenLogger` (无 OTel)                             |
| parent        | `toolContext ?? interactionContext` | —                                                                    |

**复用方案：**

1. 在 `session-tracing.ts` 新增 `startHookSpan` / `endHookSpan`（parent = `toolContext ?? interactionContext`，与 claude-code 一致）
2. 在 `coreToolScheduler.ts` 的 `executeSingleToolCall` 中，pre/post hook 调用前后分别 start/end hook span
3. 保留现有 `logHookCall` 事件记录（两套并行，不互斥）

改动量低，不影响现有 hook 逻辑。

##### 4. tool.execution — 已有 helper，只需接线

qwen-code 的 `startToolExecutionSpan(parentToolSpan)` / `endToolExecutionSpan(span, metadata)` 已经完整实现，只需在 `executeSingleToolCall` 中调用：

```typescript
// coreToolScheduler.ts executeSingleToolCall 内部
const toolSpan = startToolSpan(toolName, attrs);
// ... hook pre ...
const execSpan = startToolExecutionSpan(toolSpan);
try {
  // ... invocation.execute() ...
  endToolExecutionSpan(execSpan, { success: true });
} catch (e) {
  endToolExecutionSpan(execSpan, { success: false, error: e.message });
}
// ... hook post ...
endToolSpan(toolSpan);
```

注意：qwen-code 的 `startToolExecutionSpan` 接收显式 `parentToolSpan` 参数，而 claude-code 的是从 `toolContext` ALS 隐式获取。这不影响功能，只是风格差异。如果引入 `toolContext` ALS，可以统一改为隐式获取。

##### 5. subagent trace tree — 双方都不完整，不建议直接复用

| 维度            | claude-code                                                             | qwen-code                                            |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------------------------- |
| OTel trace 传播 | **无** — subagent 的 interaction 是新 root                              | **无** — subagent 无显式 trace 传播                  |
| 身份关联        | Perfetto metadata（agent process/thread）+ `teammateContextStorage` ALS | `subagentNameContext` ALS + `SubagentExecutionEvent` |
| 并发隔离        | OTel ALS 有泄漏风险（`enterWith` 是进程级，并发 subagent 会互覆盖）     | 同样的风险                                           |

claude-code 在 subagent OTel tracing 上**自己也没解决好**：

- `interactionContext.enterWith()` 是进程级的，并发 subagent 会覆盖彼此的 ALS 值
- 真正的 agent 层级树只存在于 Perfetto（一个 Anthropic 内部 feature-flagged 的系统），不在 OTel 中

**建议：**

- 短期：沿用 qwen-code 现有的 `subagentNameContext` + 事件日志方案
- 中期：在 subagent 启动时创建一个 `subagent` span（parent = 当前 toolContext），并用 `context.with()` 而非 `enterWith()` 来隔离并发 subagent 的 OTel context
- 这是需要独立设计的工作项，不建议直接照搬 claude-code

##### 6. LLM request span — 路径明确

qwen-code 当前在 `loggingContentGenerator.ts` 中用 `withSpan('api.generateContent', ...)` 和 `startSpanWithContext('api.generateContentStream', ...)`。

改为调用 `startLLMRequestSpan` / `endLLMRequestSpan`（session-tracing 层已有实现）即可。streaming 场景需要注意：

- `startLLMRequestSpan` 返回 `Span` 对象
- 需要手动传入 `endLLMRequestSpan(span, metadata)` 终结
- 这与 `startSpanWithContext` 的手动管理模式兼容

### 复用总结

| 改造项                                                                    | 可复用程度                            | 改动量                                        | 优先级 |
| ------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------- | ------ |
| 统一 span 创建路径（废弃 runtime `withSpan`，用 session-tracing helpers） | **核心修复** — 解决 parent-child 断裂 | 中（~5 个调用点）                             | P0     |
| 新增 `toolContext` ALS                                                    | 直接照搬 claude-code 模式             | 低（session-tracing.ts 内部）                 | P0     |
| tool.blocked_on_user span                                                 | 方案 A 需适配状态机                   | 中（\_schedule + executeSingleToolCall 协调） | P1     |
| tool.execution 接线                                                       | helper 已有，只需调用                 | 低（executeSingleToolCall 内 3 行）           | P1     |
| hook span                                                                 | 新增 helper + 调用点                  | 低                                            | P1     |
| LLM request span 切换                                                     | 替换 withSpan 为 typed helper         | 低（2 个调用点）                              | P1     |
| subagent trace tree                                                       | **不建议直接复用** — 需独立设计       | 高                                            | P2     |

### 推荐实施顺序

```
Phase 1 — 修复 trace 树结构 (P0)
├── 1a. session-tracing.ts 新增 toolContext ALS + blocked_on_user / hook span helpers
├── 1b. loggingContentGenerator.ts: withSpan → startLLMRequestSpan/endLLMRequestSpan
└── 1c. coreToolScheduler.ts: withSpan → startToolSpan/endToolSpan

Phase 2 — 补齐 workflow span (P1)
├── 2a. coreToolScheduler._schedule: blocked_on_user span 接入
├── 2b. coreToolScheduler.executeSingleToolCall: tool.execution span 接入
└── 2c. hook pre/post 调用处: hook span 接入

Phase 3 — Subagent trace tree (P2)
├── 3a. 设计 context.with() 隔离方案（替代 enterWith）
├── 3b. subagent 启动时创建 subagent root span
└── 3c. 并发 subagent 场景验证
```
