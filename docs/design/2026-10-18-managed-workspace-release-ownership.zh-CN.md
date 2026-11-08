# Managed Workspace：worker 拒绝或挂起时的释放所有权

[English](2026-10-18-managed-workspace-release-ownership.md) | [简体中文](2026-10-18-managed-workspace-release-ownership.zh-CN.md)

- **状态：** 提案
- **日期：** 2026-10-18
- **基线：** `0fac9973df`
- **Issue：** [#12937](https://github.com/QwenLM/qwen-code/issues/12937)（拆自 [#12868](https://github.com/QwenLM/qwen-code/pull/12868)）
- **模块：** `packages/managed-agent-server`、`packages/cli/src/serve`、`packages/core/src/tools`

「现状」一节中的每项主张都在上述基线提交上重新读过。「提案」标记尚未实现的行为；§2.6 的状态表区分两者。

## 1. 问题

一个 Workspace Runtime Session 通过一行持久记录持有其存储。释放路径只在 worker 应答之后清除该行，因此 worker 的拒绝、超时或挂起会让存储被一个再也无法使用它的 Session 永久持有：

- 之后对该存储的每次 `acquire` 都在 `claim()` 处失败，返回 `409 workspace_busy`；
- 同一 Runtime Session 的重试停在 `RELEASING`；
- 没有任何其他自动路径会清除该行。

修复必须在不要求 worker 成功应答的路径上释放持久租约，同时不削弱 acquire 侧规则：响应缺失不能证明任何事。

## 2. 现状

### 2.1 acquire 在结果不确定时保留所有权

`WorkspaceRuntimeTransport.acquire` 在安装或激活任何东西之前先占用存储，并在安装结果不确定时有意保留占用（`WorkspaceRuntimeTransport.java:104-105`）：

```java
ownership.claim(context.binding(), context.session());
// Failure retains ownership: a missing response cannot prove the worker did nothing.
```

随后 `acquireUncertain` 报告一个可重试失败。这条不变量正是不能在 transport 失败时盲目补偿释放的原因。

### 2.2 release 只在 worker 应答后清除所有权

`WorkspaceRuntimeTransport.release`（`:409-435`）分三个阶段：

```java
return delegate.release(lease, session).thenCompose(released -> {
    if (!Boolean.TRUE.equals(released)) {
        throw WorkspaceExecutionStore.unavailable();      // :424-426
    }
    return delegate.activateWorkspace(context.runtime(), context.session(), context.binding(), false);
})
.thenApply(ignored -> {
    ownership.release(context.binding(), context.session()); // :430
    detachOwed.remove(detach);
    return true;
});
```

最后阶段之前的任何抛出或超时都会跳过 `ownership.release`。`:416-421` 的 `RELEASING` 捷径没有帮助：它要求 `!ownership.isHeld(...)`，而持有者恰恰就是卡住的东西。

今天 `ownership.release` 有两个调用点，不是一个：`:430`（完整释放）与 `:455`（`releaseMount`）。后者属于独立的挂载归还操作，不是完整释放失败后的补偿路径。

### 2.3 Broker 把 Session 留在 RELEASING

`RuntimeBrokerService.completeSessionRelease`（`:3085`）在调用 transport 之前先把 Session 迁到 `RELEASING`（`:3101`），调用 `transport.release(...)`（`:3112`），只在成功时调用 `finishSessionRelease`（`:3124`）。出错时它清除闩锁并以异常完成（`:3116-3121`）；持久 Session 行保持 `RELEASING`。

重试会重建同一条链并撞上同一个 worker 拒绝。真正让它永久化的是 worker 备忘的释放 promise（见 2.5）。

### 2.4 holder 行是持久且精确匹配的

`ma_storage_owner`（`V1__managed_schema.sql:861-891`）存储 `holder_key`、`binding_id`、`runtime_generation`、`runtime_session_id`，以及维护占用列。没有 holder 代数、过期时间或心跳列。

- `WorkspaceExecutionStore.claim`（`:337`）以 `FOR UPDATE` 读取该行，遇到不同持有者就以 `busy()`（`:703`，`409 workspace_busy`，可重试）拒绝。没有任何取代规则。
- `WorkspaceExecutionStore.release`（`:422`）只在 `(binding_id, generation)` 处的 binding 仍为 `READY` 或 `DRAINING` 时清除该行，且只清精确的 `holder_key`（`:447-450`）。binding 为 `LOST` 或 `RELEASED` 时它会抛 `workspace_unavailable`。

### 2.5 worker 释放是备忘的且无界

`managed-runtime-provider-worker.ts:297-327`：

```ts
if (session.release) return session.release;              // :308
...
entry.release = (async () => {
  await entry.value?.runtime.releasePrepared();           // :316
  ...
})().catch((error) => { entry.release = undefined; throw error; }); // :323-326
```

`ManagedToolRuntime.releasePrepared()`（`managed-tool-runtime.ts:919-932`）在执行未完成时拒绝：

```ts
throw new Error('Managed Runtime still owns unfinished execution.');
```

否则它以无截止时间的方式等待 `entry.cancellation` promise。两个后果：

1. 拒绝是一个普通 `Error`。worker 的响应映射（`managed-runtime-provider-worker.ts:726-731`）把它变成 `409` 加 `code: managed_runtime_provider_operation_failed`，因此 Broker 无法区分一次有意的拒绝与无关的 provider 失败。
2. 挂起会让 `entry.release` 永远处于 pending；每次重试都返回同一个 promise。Broker 的 HTTP 客户端会超时（`HttpRuntimeTransport.java:50`，`REQUEST_TIMEOUT = Duration.ofSeconds(30)`），但 worker 从不重试。

### 2.6 其他会清除 holder 的路径

| 路径                                                           | 要求的证据                                               | 能覆盖卡住场景吗           |
| -------------------------------------------------------------- | -------------------------------------------------------- | -------------------------- |
| `WorkspaceRuntimeTransport` 中的 `ownership.release`（`:430`） | worker 已应答                                            | 否                         |
| `releaseMount`（`:455`）                                       | 独立的挂载归还操作                                       | 否                         |
| `WorkspaceExecutionStore.releaseLost`（清除于 `:650`）         | binding `LOST` + `hasStoppedWriters()` + operation lease | 否（binding 仍为 `READY`） |
| `WorkspaceMaintenanceRecovery`（`:162`）                       | maintenance hold                                         | 否（仅由维护流程驱动）     |
| `WorkspaceOperatorRecoveryStore`                               | operator recovery 操作                                   | 否（人工）                 |

`RuntimeBrokerService.releaseStoppedSession`（`:5838`）是唯一**不**调用 transport 就能持久退役 Session 的路径：它要求与 binding 匹配的 drain receipt 且没有活跃 execution，随后调用 `finishSessionRelease` 并移除内存中的 session。它从不清除 `ma_storage_owner`，因此即便成功的关闭级联也可能在存储仍被持有时退役 Session。

`releaseUnusableSession`（`:3137`）处理已死的 worker：它把 `READY` binding 置为 `LOST`，并以 `runtime_reconciliation_required` 失败。holder 随后属于 W0e（`releaseLost`）的职责，后者要求持久停止证据。

| 行为                                                     | 基线 `0fac9973df` |
| -------------------------------------------------------- | ----------------- |
| acquire 在结果不确定时保留所有权                         | 已实现            |
| release 只在 worker 应答后清除所有权                     | 已实现            |
| 卡住的 holder 有自动逃生路径（Session 处于 `RELEASING`） | **未实现**        |
| 本地退役 Session 时清除 holder                           | **未实现**        |
| worker 释放有界且可安全重试                              | **未实现**        |
| 拒绝携带可区分的可重试错误码                             | **未实现**        |

## 3. 失败模式

**F1 —— 拒绝。** Broker 已结算了一个 worker 仍认为未完成的 execution。`releasePrepared()` 抛出；worker 应答 `409`；Broker 释放失败；Session 停在 `RELEASING`；holder 残留。worker 可能永远不会完成，因此重试永不收敛。

**F2 —— 挂起。** `releasePrepared()` 等待一个永不 settle 的 cancellation promise。备忘的 `entry.release` 同样永不 settle，因此之后每次尝试都返回同一个挂起的 promise。Broker 每次超时；holder 永久残留。

**F3 —— 崩溃窗口。** Broker 在 `claim` 与 `release` 之间（或释放中途）死亡会留下该行。本设计本身不解决 F3；现有 reconcile 与 `releaseLost` 路径仍是其归属。

## 4. 目标与非目标

**目标**

- G1：Broker 持久退役 Session 之后，其存储 holder 无需 worker 成功应答即可清除。
- G2：单纯的 transport 失败不触发补偿释放；§2.1 的 acquire 侧不变量保持不变。
- G3：挂起的 worker 释放在界限处被放弃，并可重试。
- G4：worker 拒绝可以与无关的 provider 失败区分。

**非目标**

- 把 `claim` 改成仅凭时间或代数取代 holder（§6，D-1）。
- 在没有停止证据时对 `releaseUnusableSession` 做补偿（§6，D-4）。
- 改动公共/WebShell API、OpenAPI 契约或 schema。
- 在 N 次普通释放失败后自动 drain Workspace；那是控制面策略，不是所有权原语。

## 5. 方案

### 5.1 worker：有界且可区分的释放

文件：`packages/cli/src/serve/managed-runtime-provider-worker.ts`。

1. 给 `ProviderSession` 增加单调递增的 `releaseAttempt`。
2. 让第一步与截止时间竞争：

   ```ts
   const attempt = ++entry.releaseAttempt;
   try {
     await withDeadline(
       entry.value?.runtime.releasePrepared(),
       RELEASE_DEADLINE_MS,
     );
   } catch (error) {
     throw isDeadline(error)
       ? conflict(
           'Managed Runtime release timed out.',
           'managed_runtime_release_timeout',
         )
       : conflict(messageOf(error), 'managed_runtime_owner_hold_pending');
   }
   ```

   `managed_runtime_owner_hold_pending` 已存在（`managed-runtime-provider-worker.ts:312`），含义就是「worker 仍持有工作」。`managed_runtime_release_timeout` 是新增的可重试错误码。

3. 在改变 provider 状态（`closeSessionAdmission`、`forgetSession`、`closed = true`、压入 `released`）之前，要求该 attempt 仍拥有该 identity：

   ```ts
   if (this.sessions.get(id) !== entry || entry.releaseAttempt !== attempt) {
     return true; // an abandoned attempt must not retire a re-acquired Session
   }
   ```

4. 被放弃的 `releasePrepared()` promise 会继续运行；给它挂一个空 rejection 处理器，避免变成 unhandled rejection。

5. 只有失败 attempt 仍是当前 attempt 时才清除 `entry.release`，使超时的 attempt 可以用新的 attempt 重试。

`RELEASE_DEADLINE_MS` 必须低于 `HttpRuntimeTransport.REQUEST_TIMEOUT`（30 秒），使 Broker 看到干净的可重试 `409`，而不是客户端超时。初始值取 20 秒；见 §11。

core 不变：截止时间属于做备忘的调用方，core runtime 保留其同步拒绝契约。

### 5.2 Broker：带持久证据谓词的 `releaseRetired`

新增一个 transport 钩子。默认是空操作，因为只有 Workspace transport 拥有持久存储：

```java
/**
 * Finishes durable ownership for a Session the Broker has already retired.
 * The caller must hold durable proof that the Runtime no longer holds the
 * Session: a persisted drain receipt matching the binding and no active
 * executions. Never call this on a mere transport failure.
 */
default CompletionStage<Boolean> releaseRetired(RuntimeLease lease, RuntimeSession session) {
    return CompletableFuture.completedFuture(true);
}
```

`WorkspaceRuntimeTransport` 覆盖它，并针对其已注入的持久行（`bindings`、`sessions`）重新验证证据：

```java
@Override
public CompletionStage<Boolean> releaseRetired(RuntimeLease lease, RuntimeSession session) {
    if (!managed(session)) {
        return CompletableFuture.completedFuture(true);
    }
    Context context = context(lease, session, false);
    RuntimeBindingRecord binding = bindings.findById(context.binding().getBindingId());
    if (binding != null && binding.getState() == RuntimeBindingRecord.State.LOST) {
        // The LOST family owns this holder; its evidence gate is stricter.
        return CompletableFuture.completedFuture(true);
    }
    boolean proven = binding != null
            && binding.getGeneration() == context.binding().getGeneration()
            && binding.getState() == RuntimeBindingRecord.State.DRAINING
            && binding.getDrainReceipt() != null
            && binding.getDrainReceipt().matches(binding);
    if (!proven) {
        // Held without proof is a refusal; nothing held is already settled.
        return CompletableFuture.completedFuture(
                !ownership.isHeld(context.binding(), context.session()));
    }
    ownership.release(context.binding(), context.session());
    detachOwed.remove(detachKey(context));
    return CompletableFuture.completedFuture(true);
}
```

返回契约：`true` 表示调用方可以继续（已清除、从未持有，或由 `LOST` 证据路径负责）；`false` 表示 holder 存在但本路径证据不足，调用方必须让释放失败，而不是留下静默的卡死。

证据谓词被刻意收窄：

- **P1** `(binding_id, generation)` 处的 binding 为 `DRAINING` —— drain claim 同时也是拒绝新 `claim` 的栅栏（`WorkspaceExecutionStore.claim` 要求 `!drain_requested`）；
- **P2** `drain_receipt` 非空且与 binding 匹配 —— worker 是被停止了，而不仅仅是不可达；
- **P3** 调用方已确认 `(binding_id, generation)` 没有活跃 execution —— `releaseStoppedSession` 在退役 Session 之前已经检查；
- **P4** `WorkspaceExecutionStore.release` 只清除精确的 `(holder_key, binding_id, runtime_generation, runtime_session_id)` 元组，因此旧退役永远清不到新持有者。

`LOST` binding 被刻意排除：其停止证据与 holder 清除属于 `releaseLost`。

### 5.3 Broker：drain 臂的升级

如果 drain 级联在停止 worker 之前等待 worker，那么 F1/F2 下 D1–D2 不可达。今天 `drainClaimedBinding` 先释放每个 Session，之后才调用 `stopAcknowledgedRuntime`；拒绝的 worker 会让第一步失败，于是停止永远不会被尝试。

修改 `drainClaimedBinding`，使一次 worker 拒绝触发一次升级：

1. 照旧运行 `drainSessions`。
2. 若某个 session 释放以 `managed_runtime_owner_hold_pending` 或 `managed_runtime_release_timeout` 失败，则调用 `provisioner.stopDrained(binding)`，用 `renewal.persistDrainReceipt(...)` 持久化 receipt，并再次运行 `drainSessions`。
3. 第二遍中每个活跃 Session 都走 `releaseStoppedSession`（有 receipt、无活跃 execution），它在 `finishSessionRelease` 之前调用 `transport.releaseRetired(...)`。
4. 第二次拒绝，或 provisioner 不支持 `supportsDrainedStop`，则以现有错误使 drain 失败。holder 随后留给 operator recovery；失败是显式的，不是静默的。

这符合已记录的 drain 语义（「drain 臂先停止活跃的东西」），同时保持普通释放（`drain = false`）非破坏性：只有关闭级联可以停止 worker。

### 5.4 顺序与崩溃窗口

`releaseStoppedSession` 在 `finishSessionRelease` **之前**调用 `releaseRetired`：

- 补偿成功，然后提交持久 `RELEASED` —— 正常路径；
- 补偿失败 —— 释放失败，Session 保持 `RELEASING`，drain claim 仍可重试，holder 未被触碰；
- Broker 在两者之间崩溃 —— Session 仍活跃且没有 holder。重试走现有的无持有者捷径（`WorkspaceRuntimeTransport.java:416-421`）并完成。不会卡死，也没有把存储交给第二个写者。

在 `finishSessionRelease` 之后补偿严格更差：中间崩溃会留下 `RELEASED` 加一个卡住的 holder，而重试会在 `RELEASED` 行上短路，永远到不了补偿。

`releaseStoppedSession` 今天是同步的（`:5838`）。它将改为返回 `CompletionStage`；两个调用方（`:747` 的 `releaseSavedSession` 与 `drainSessions`）本来就是异步组合。

### 5.5 不改动的部分

- `claim` 冲突语义与 `409 workspace_busy` 契约。
- acquire 侧保留规则与 `acquireUncertain`。
- `releaseUnusableSession` 与 `releaseLost`。
- `ma_storage_owner` schema。
- `RuntimeBrokerService.mapFailure`（`:5538`），它已经原样保留 `RuntimeBrokerException`，因此新的 worker 错误码能完整到达 drain 升级。

## 6. 决策与理由

**D-1：证据门控的补偿，而不是 holder 过期或代数取代。**
过期时间或代数计数只能证明 holder 是「旧的」，永远不能证明 worker「停了」。按时间取代会让第二个 Session 占用一个活跃 worker 可能仍在写入的存储，这正是 §2.1 保护的不变量。issue 把过期列为备选；本设计拒绝它，因为它所需证据同样是 drain receipt，而持久化该证据只增加一列、不增加能力。

**D-2：补偿放在持久释放之前，而不是之后。** 见 §5.4。失败与崩溃窗口都收敛到可重试状态，而不是 `RELEASED` 行加卡住的 holder。

**D-3：只在 drain 臂升级。** 普通释放被要求不停止任何东西。关闭级联本来就拥有停止语义，因此该升级是对这个臂顺序的修补，不是新策略。

**D-4：不在 `releaseUnusableSession` 中补偿。** 进程已死比响应缺失更强，但它不是「孤儿子进程或存储挂载已停止写入」的证据。`releaseLost` 已经编码了更严格的证据，仍是 `LOST` 路径的归属。

**D-5：在备忘的地方加界。** 挂起存在于备忘的 promise 中，而不在 `releasePrepared` 的单个 await 中。在 provider 加界让 core 不必引入超时契约，并让现有 `.catch` 能重置备忘。

**D-6：不改 schema。** drain receipt、binding 状态与精确 holder 列已经携带证据。新增列会成为第二个事实来源。

## 7. 不变量

1. 只有 worker 被证明已停止（与 binding 匹配的 drain receipt、无活跃 execution）或已应答释放时，才清除 holder。
2. 单纯 transport 失败永不清除 holder。
3. 清除是精确匹配的；永远不会清除更新持有者。
4. 被放弃的 worker 释放 attempt 永远不会为它已不拥有的 identity 改变 provider 状态。
5. 普通释放永不停止 worker。

## 8. 风险与缓解

| 风险                                                | 缓解                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 补偿清除了活跃 worker 仍在写入的 holder             | P1–P3；排除 `LOST`；`releaseLost` 保留自己的证据门                                   |
| 过期的 worker attempt 退役了重新 acquire 的 Session | `releaseAttempt` 令牌加 await 之后的 identity 检查（§5.1）                           |
| 截止时间已到而 `releasePrepared` 之后成功           | 被放弃的 attempt 只返回；下一次 attempt 重新运行 `releasePrepared`，对已结算条目幂等 |
| 升级停止了服务其他 Session 的共享 worker            | 关闭级联按设计就是 binding 级的；`drainSessions` 会释放该 binding 上所有活跃 Session |
| provisioner 不支持 `supportsDrainedStop`            | 显式失败，保留 operator recovery；记录为残留缺口                                     |
| `releaseStoppedSession` 签名变化扩散                | 只有两个调用方，且都已是 `CompletionStage` 组合                                      |
| 被放弃 promise 的 rejection 变成 unhandled          | 在 `withDeadline` 中挂空 rejection 处理器                                            |

## 9. 验证计划

**Java（H2，然后 `mysql-integration`）**

- `WorkspaceExecutionStoreTest`：`release` 仍拒绝 `LOST`/`RELEASED` binding；精确匹配清除；不清除更新持有者。
- `WorkspaceRuntimeTransportTest`（新增用例）：
  - worker 拒绝时 holder 保持（不变量）；
  - `releaseRetired` 在没有匹配 receipt 时返回 `false` 且不清除；
  - `releaseRetired` 在 `DRAINING` binding 与 receipt 匹配时清除；
  - 未持有时 `releaseRetired` 幂等。
- `RuntimeBrokerServiceTest`：
  - drain 级联：拒绝 → `stopDrained` → 第二遍清除 Session 与 holder；
  - 普通释放：拒绝不停止 worker 也不清除；
  - 第二次拒绝使 drain 显式失败。
- 事务/SQL 行为需要 MySQL profile（按模块 AGENTS）。

**TypeScript**

- `managed-runtime-provider-worker.test.ts`：
  - 拒绝映射为 `managed_runtime_owner_hold_pending`；
  - 超时映射为 `managed_runtime_release_timeout` 并清除备忘；
  - 下一次 attempt 重新运行 `releasePrepared`；
  - 之后才 resolve 的被放弃 attempt 不会关闭重新 acquire 的 Session（identity 令牌）。
- `managed-tool-runtime.test.ts` 不变；core 行为未改。

**端到端**

- 强制 worker 拒绝 `release` 的 Managed Workspace：关闭 Session；断言 `ma_storage_owner.holder_key IS NULL`、Session 到达 `RELEASED`，之后对同一存储的 `acquire` 成功。
- 反向：没有 receipt 的 transport 级失败保持 `holder_key` 已设置，Session 停在 `RELEASING`。

**参考检查**

- 对改动的 TS/Java 相邻文档运行 `npm run lint` 与 Prettier；Java 模块运行 `mvn verify`（按模块 AGENTS，在根 lint 前删除 `target/`）。

## 10. 验收标准

1. 当 worker 以 `managed_runtime_owner_hold_pending` 拒绝释放时，关闭级联会清除该 Session 的 `ma_storage_owner.holder_key`，之后对同一存储的 acquire 成功。
2. 当 worker 的 `releasePrepared()` 永不 settle 时，释放在 `RELEASE_DEADLINE_MS` 内返回可重试错误；下一次释放是全新 attempt；Broker 不会等待超过自己的请求超时。
3. 没有 drain receipt 的单纯 transport 失败（连接错误、客户端超时）保持 holder 已设置，Session 停在 `RELEASING`。
4. `releaseRetired` 无法清除与精确 `(holder_key, binding_id, runtime_generation, runtime_session_id)` 元组不匹配的 holder。
5. 无 schema 迁移，无 OpenAPI 改动。
6. §9 的新测试通过，现有模块套件保持绿色。

## 11. 未决问题

1. **截止时间取值。** 20 秒选在 30 秒 HTTP 超时之下。是否应可配置，还是固定以保证各部署行为一致？
2. **升级触发条件。** drain 应在第一次拒绝时升级，还是在重试预算之后（例如连续两次拒绝），以免停止一个本将结算的 worker？
3. **控制面重试预算。** 控制面是否应在 N 次普通释放失败后自动 drain？本设计有意不动该策略。
4. **`releaseMount` 对称性。** `releaseMount` 已经不需要 worker 应答就清除 holder。它今天安全，因为执行挂载与安装是分开的，但两种证据应在后续文档中一并说明。

## 12. 实施顺序

1. worker 拒绝错误码与有界释放（§5.1）—— 可独立测试，已经关闭 F2。
2. `RuntimeTransport.releaseRetired` 与 `WorkspaceRuntimeTransport` 覆盖（§5.2）。
3. `releaseStoppedSession` 补偿及其异步签名（§5.4）。
4. drain 臂升级（§5.3）。
5. §9 的测试，然后 MySQL profile。
