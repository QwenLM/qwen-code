# Broker 重启后的 Runtime 绑定对账

[English](2026-09-24-runtime-binding-reconciliation.md) | [简体中文](2026-09-24-runtime-binding-reconciliation.zh-CN.md)

状态：已在 `packages/sdk-java/runtime-broker` 实现；尚无生产 provisioner 启用

相关：#12380（Managed Agent 分阶段交付）、#12358 的集成预览，以及该分支上的端点恢复参考设计 `docs/design/2026-09-21-managed-runtime-endpoint-recovery.md`。

## 1. 问题

`READY` 的 Runtime 绑定是持久化的：Broker 进程消亡后它仍留在绑定仓库里。此前重启后的 Broker 完全无法使用这样的绑定——`ensureBinding` 会以 `runtime_reconciliation_required` 失败关闭，因为只有完成 provisioning 的进程才在 `liveBindings` 里持有它。每次重启都会遗弃它供应过的所有 Runtime，调用方只能等遗留租约过期或手工废弃绑定。

仅持久化的元数据绝不能证明恢复成立。绑定表在两个方向上都可能过时：Runtime 进程可能已消失、被替换，或属于与该记录不同的租约。

## 2. 范围

范围内：

- 持久化绑定的可恢复身份：provision seed（加密存储）、调度器资源句柄、attestation 代数，以及最近一次对账时间。
- Broker 侧接管恢复的 `READY` 绑定：先经 provisioner 观察物理资源，再经 transport 重新证明 Runtime 身份，之后才允许会话使用该租约。
- 恢复绑定的终态：Runtime 被证明不存在时进入 `LOST`；证据冲突时进入 `RECOVERY_BLOCKED`。`LOST` 只有在没有任何会话或执行引用它时才回收槽位、创建新代数。
- 有界对账：在同一个操作截止期内做指数退避重试，该截止期独立于循环、同样约束停在 provisioner 或 attestation 调用里的在途操作；操作结束后释放认领，使超时操作的迟到写入被围栏。

范围外：

- 可恢复的 provisioner 实现。本地进程 provisioner 保持当前的进程内所有权模型并报告 `legacy` 类型，其恢复的绑定仍按原样失败关闭。本地进程的可持久接管属于后续切片。
- Drain 生命周期、已接管绑定的后台健康刷新，以及 Kubernetes provisioner。
- 对既有数据库的 schema 迁移。runtime-broker 的 schema 仍以 `CREATE TABLE IF NOT EXISTS` 应用，部署方按原方式重建 schema。

## 3. 设计

### 3.1 绑定记录上的持久身份

`RuntimeProvisionRequest` 新增 `provisionerKind`（两参构造器保持 `legacy` 默认）。类型既不是 `legacy` 也不是 `static` 的请求要求持久身份：仓储在 `findOrCreate` 时分配 `RuntimeProvisionSeed`，且此类请求的 `READY` 记录必须携带 seed、租约、资源句柄、attestation 代数和对账时间。seed 由 binding id 与 generation 生成，因此同一次绑定的 provision 重试保持稳定身份；其 `provisionRequestId`、`provisionalRuntimeId` 与 `gatewayIncarnation` 把记录绑定到唯一一个 Runtime 化身。

JDBC 仓储用必需的 `SecretProtector`（附带 `AesGcmSecretProtector`）按 `runtime-provision-seed:<bindingId>` 上下文加密 seed。带 seed 记录的租约令牌随加密 seed 存储；legacy 记录的租约令牌在 `runtime-lease-token:<bindingId>` 下单独加密。schema 中不再有任何明文令牌列。slot 表与 binding 表同时持久化 `provisioner_kind`，请求哈希也覆盖它，因此恢复出的行绝不会被另一种 provisioner 重新解释。

### 3.2 Provisioner 与 transport SPI

`RuntimeProvisioner` 新增四个默认方法：

- `kind()` 返回 `legacy`；
- `provision(request, seed)` 忽略 seed 并回退到 legacy 的单参 provision——这样的 provisioner 永远无法通过对账；
- `ensureResource(request, seed, knownHandle)` 以 `UnsupportedOperationException` 失败——启用持久类型的 provisioner 必须实现持久 provision 路径；
- `reconcile(request, seed, handle, lastLease)` 返回 `RuntimeObservation.unknown(handle)`——无法观察的 provisioner 什么都证明不了，Broker 选择等待而不是猜测。

`RuntimeTransport` 新增默认 `attest(lease, request, seed)`，以 `runtime_broker_attestation_unavailable` 失败关闭。`HttpRuntimeTransport` 已实现该方法。

### 3.3 持久 provision

对持久请求，`provisionBinding` 先认领操作，再确保调度器资源、用持久化的 seed 执行 provision，然后由 Broker 自己对返回的租约做 attestation。记录经由 `withAttestation(lease, handle, …)` 进入 `READY`，首个 attestation 代数与对账时间随同一次 compare-and-set 写入。不可重试的身份失败——句柄类型冲突、attestation 不匹配——把绑定置为 `RECOVERY_BLOCKED` 而不是 `FAILED`，因此重试不会在状态不明的资源上铸造替代 Runtime。操作结束时释放认领，与对账路径一致，后续 Broker 无需等待租约过期即可接管。

legacy 路径逐字节保持已评审的行为，包括其认领生命周期。

### 3.4 恢复绑定的对账

当 `ensureBinding` 遇到本进程未在 `liveBindings` 持有的 `READY` 记录时：

- legacy 绑定仍以 `runtime_reconciliation_required` 失败关闭；
- 持久绑定进入 `reconcileBinding`，并经 `bindingOperations` 单飞。

对账先认领操作，工作期间续租，并通过 `provisioner.reconcile` 观察资源：

- `READY` 观察：观察中的 runtime 实例、lease id 与 epoch 必须等于持久化 seed 的值，句柄类型必须等于请求的 provisioner 类型；Broker 再经 `transport.attest` 重新证明，并比对完整身份（runtime 实例、incarnation、租约、epoch、scope、provision 请求 id）。成功后租约进入 `liveBindings`，attestation 代数递增；任何不匹配都会阻塞恢复。
- `STARTING` 或 `UNKNOWN`：以 50 毫秒起、上限 2 秒的指数退避重试，直到操作截止期（四倍操作租约）。观察结果从不创建或替换资源。
- `NOT_FOUND`：绑定进入 `LOST`。
- `CONFLICT` 或 provisioner 的不可重试错误：`RECOVERY_BLOCKED`。

截止期是独立的调度任务，而不是重试循环内的检查，因此停在 reconcile 或 attestation 里的调用无法无限期占用绑定。截止期触发时先释放操作认领，再以 `runtime_broker_reconcile_timeout` 使等待者失败；释放后迟到的结果发现认领已消失，被 operation-generation 的 compare-and-set 围栏。provisioner 的迟到结果在新 Broker 取得认领后同样被围栏。

### 3.5 丢失与回收

`LOST` 记录保持活跃，因此既有会话与执行仍指向已丢失的代数，而不会漂移到替代 Runtime。下一次 `warm`/`acquire` 只在 `countActiveByBinding` 与新增的 `ToolExecutionRepository.hasActiveByBinding` 都确认没有引用时才回收槽位——`LOST` 转 `RELEASED`，再经正常 provision 路径创建新代数。只要仍有活跃引用，调用方得到 `runtime_broker_runtime_lost`，绑定保持 `LOST`。

`RECOVERY_BLOCKED` 从不自行迁移；它需要运维介入，与"状态不明的 Runtime 绝不被重试掉"的规则一致。

### 3.6 认领释放

`RuntimeBindingRepository.releaseOperation(bindingId, owner, generation)` 清除调用方的认领，使接管不必等待租约过期。释放已过期的认领是允许的清理；释放他人的认领返回 null。对账与持久 provision 在每个结局都释放认领。

## 4. 验证

在 `packages/sdk-java/runtime-broker` 执行 `mvn test`：123 个测试通过，其中新增 `DurableRuntimeRecoveryTest` 11 例（受门控的对账-接管、unknown 观察永不替换、超时释放认领且新请求可恢复、在途对账受截止期约束、迟到 attestation 被围栏、初始 provision 身份不匹配即阻塞、冲突观察保留最后可信句柄、不可重试 ensure 失败不空转、迟到的 ensure 结果不能覆盖新 owner、丢失仅在空闲时创建新代数、有活跃会话时丢失保持阻塞）。`JdbcRepositoryContract` 在 H2 上往返验证 seed、句柄、attestation 代数与对账时间，断言 seed 与 legacy 租约令牌均为加密存储，并覆盖 `releaseOperation` 移交。`mvn checkstyle:check` 通过。

## 5. 后续工作

- 可恢复的本地进程 provision（ready record 接管），使真实本地 Runtime 能跨越 Broker 重启。
- Drain 生命周期与已接管绑定的健康刷新。
- 执行级 `UNKNOWN` 对账（在 #12380 单独跟踪）。
- Kubernetes provision，以及 schema 版本化之后的迁移。
