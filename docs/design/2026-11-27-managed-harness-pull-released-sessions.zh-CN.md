# Managed Harness 对已释放 Session 的拉取（P1）

[English](2026-11-27-managed-harness-pull-released-sessions.md) | [简体中文](2026-11-27-managed-harness-pull-released-sessions.zh-CN.md)

状态：设计提案，2026-11-27。现状描述已对照 `main` 的 `8327d40b17`（已包含 #18557）核实。本文是 #18514 拉取调度提案中的 P1 阶段，基于[挂起时释放 placement](2026-11-26-managed-suspension-placement-release.zh-CN.md) 和 [Harness 事件上报](2026-11-27-managed-harness-event-ingest.zh-CN.md)。第一个切片不依赖上报，第二个切片依赖。

## 1. 问题与现状

自 #18404 起，干净的空闲挂起或 Action 停靠会让 Session 进入一个明确的已释放状态：placement 为 `RELEASED`，head 为 `SEALED`，且该 placement epoch 有一份 release 回执。任何成员都可以接管这样的 Session，无需等待租约。

由谁接管由 Java 在 `HarnessPoolConnector.select` 中决定。当某个调用需要该 Session 且 placement 不是 `ACTIVE` 时，Java 按轮询挑一个接受新工作的成员，为它执行 `JdbcHarnessPlacementStore.takeover`，然后调用该成员。已释放 Session 的每一种工作来源最终都落到这一次调用上：

| 工作                           | 现在的 Java 路径                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wake 输入（seal 时的戳或输入） | `WakeRecovery.scan`（每 2 秒）和 `TransportWakeActivator` 调用 `recoverForWake`，即一次被动 load。被加载的 Session 由其 wake pump 处理这些输入                                 |
| 停靠的 Action 决定             | 决定受理时解除 Turn 的停靠。`ActionResponseCoordinator` 调用 `resolveAction`，缓存未命中时会先 load。`HarnessCoordinator` 的扫描认领该 Turn，并在事件流上走它的恢复路径        |
| Relay 工作                     | `SessionMessageRelay`、`ChildResultRelay`、`ManagedChannelService` 等调用 `runMessageOperation`、`runChildOperation` 或 `runChannelOperation`；每次应答推动 relay 自己的状态机 |

由此产生三个问题。

1. **Java 在知道容量之前就做了放置。** 达到冷启动上限（`HOSTED_COLD_OPEN_LIMIT`，默认 8 个并发冷启动）的成员会回答 409 `hosted_session_open_busy`。Session 随后一直等这个成员，而空闲的成员只有在轮询轮到它时才会拿到 Session。
2. **分配与准入共用一个有效期。** takeover 消费 release 回执时，会把已 seal 的 writer 租约截到当前时间（`takeover` 中的注释："A successor that never acquires a writer must not inherit the released writer's lease"）。下一次 takeover 因此会立即通过"租约已过期"分支。在推模式下这无害，因为分配成员的那个 Java 实例会立即调用它。在拉模式下，认领响应可能丢失，而其他 poller 仍在不断 poll，于是另一个 poller 可能在认领者获取 writer 之前就把它挤掉。fence 仍然成立，被挤掉的认领者获取 writer 时会因 placement epoch 失败，但 Session 会反复易主。#18514 中提出这一点的评论建议在分配与获取 writer 之间加一个有上限的预留。
3. **Java 必须知道并能连到每一个 Harness。** 每次调用都经 HTTP 发往静态池列表中的某个成员，因此 Java 没有配置、或连不到的 Harness 永远无法持有 Session。拉取调度要去掉的正是这一点：Harness 只需要能连到 Java。

## 2. 目标与范围

### 目标

- 有待处理工作的已释放 Session，由有空闲容量并认领它的 Harness 放置，而不是由 Java 轮询放置。
- 一次分配只有一次认领：认领响应丢失、重复 poll、第二个 poller、以及先前持有者的迟到写入，都不会产生第二个有效 writer；丢失响应的认领者在有限时间内保有其认领。
- 经由认领持有的 Session，在 Java 不知道也连不到持有者地址的情况下得到服务。Java 为它发出的每一次调用，包括决定、relay 工作、取消、下一个 Turn 和生命周期操作，都经由持有者自己的 poll 送达，且该 Session 上的任何 Turn 都不需要 Harness 事件流。
- 已释放 Session 的 wake 工作不经过任何 Java 到 Harness 的调用。
- 开关关闭时，行为与现在一致。开关开启时，已释放 Session 等待认领的时间不超过兜底时长。

### 非目标

- 放置还没有 placement 的 Session，例如新 Session 的第一个 Turn。这部分在 P3 之前仍由推送池负责，P3 还需要为没有 head 的 Session 定义预留规则。side query 也仍然挑选推送成员。
- 从存活的、由推送放置的持有者手中接管 Session。推送放置的 placement 保持其 owner 路由。
- Java 侧读取（P5），移除 Harness 私有监听器或静态池（P6）。
- poller 的逐实例身份（例如 mTLS）。在它出现之前，P1 要求持有该 token 的每个 Harness 都同等可信（§15）。
- 消息队列提示、比"最早优先"更细的租户公平性，以及针对取消和决定的专用低延迟信号。P3 会把通道与现在的直接调用做对比测量，只在未达到延迟预算的地方加原生信号。

## 3. 设计决策

| 决策                    | 选择                                                                                                                                                                                               | 理由                                                                                                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 由谁放置已释放 Session  | 认领它的 poller。推送路径不再为它分配成员                                                                                                                                                          | 只有 Harness 知道自己是否有空闲槽位                                                                                             |
| 工作的来源              | 推送路径在将要接管非 `ACTIVE` 的 placement 时，在 Session 行上记录认领需求（`harness_claim_requested_at`）。获取 writer 或推送兜底时清除                                                           | 复用每种工作来源自己的持久记录和重试循环。不需要按类型写谓词，同一列也是扩缩容信号                                              |
| 路由                    | 内部监听器上的 `POST /internal/managed-harness-work/v1/poll`                                                                                                                                       | 由 Harness 向外调用；内部 origin 后面的任一 Java 实例都能处理                                                                   |
| poller 认证             | Harness bearer token。每次 poll 都对照 Java 配置的 capability digest 和必需特性检查兼容性。不查成员表                                                                                              | Java 不需要知道有哪些 Harness 实例。token 不能表明是哪个实例在 poll，因此持有它的每个 Harness 都被信任可以拿到每一个认领（§15） |
| 认领                    | 现有 `takeover` CAS 加一个预留，在同一事务中完成                                                                                                                                                   | 不引入第二套所有权协议；Store 的 placement fence 不变                                                                           |
| 预留                    | 数据库时间 30 秒。同一 boot 再次 poll 会拿回同一个认领。获取 writer 时在 placement 锁下消费它。过期后 Session 对任一 poller 重新开放                                                               | 即 #18514 中"分配到准入"的契约，不需要新的注册表就有了上限                                                                      |
| 认领内容                | Java 原本会发给成员的被动 load 请求                                                                                                                                                                | 只有一份 load 实现；Harness 不需要自己读取 Session 配置                                                                         |
| 对已持有 Session 的调用 | 经拉取认领的 placement 标记为 pull-held。对它的每一次连接器调用都变成 SQL 中的一个请求项，在持有者的 poll 中下发、由持有者应答（§7）                                                               | Java 永远不需要持有者的地址。连接器和 SDK 的逻辑原样运行在另一种传输上                                                          |
| 事件流                  | pull-held Session 上的 Turn 永不打开 Harness 事件流。派发器原本要打开事件流的地方，改为把 Turn 交给持有者并请它从游标处开始推送（§8）                                                              | 事件流是请求项唯一承载不了的交换                                                                                                |
| 取消                    | 在 pull-held Session 上，取消作为一个请求送达持有者；Turn 留在 Harness 手中，由它通过上报写入终态                                                                                                  | 收回 Turn 需要事件流                                                                                                            |
| 长轮询                  | 最长 20 秒。处理程序每 500 毫秒重查一次 SQL，本实例记录需求或请求时提前唤醒                                                                                                                        | 无需消息队列即可跨 Java 实例工作                                                                                                |
| 容量                    | poll 上报空闲的冷启动槽位；Java 最多返回同等数量的认领，最早的需求优先。发给已持有 Session 的请求不受容量限制                                                                                      | 满载的 Harness 不再认领，但继续服务已持有的 Session                                                                             |
| 活性兜底                | 需求 30 秒无人认领时，推送路径按现在的方式分配                                                                                                                                                     | 只要还有推送成员，poller 故障就不会让工作卡住                                                                                   |
| 启用                    | `qwen.managed-agent.harness-pull.enabled`（默认 `false`）以及 Harness 特性 `work-pull/1`。持有者通道还要求 `qwen.managed-agent.event-ingest.enabled`，并要求认领的 Harness 声明 `holder-channel/1` | 可按部署回滚                                                                                                                    |
| 时钟                    | 预留、需求和请求截止时间都使用数据库时间（`ManagedSchemaTime.SQL_NOW`）                                                                                                                            | 多个实例同时读写它们；避免重蹈 Turn 租约的时钟问题（#14248）                                                                    |

## 4. 工作拉取协议

### 请求

```json
{
  "instanceId": "harness-b",
  "bootId": "1f0c…",
  "capabilityDigest": "sha256:…",
  "features": ["work-pull/1", "holder-channel/1", "event-ingest/1"],
  "freeSlots": 3,
  "waitMillis": 20000
}
```

请求带 `Authorization: Bearer <harness token>`。`freeSlots` 是冷启动上限减去进行中的冷启动数。Harness 只要还有空闲槽位或持有任何 pull-held Session 就持续 poll；正在静默的 Harness 上报零空闲槽位，并继续为已持有的 Session poll。

### 处理

1. **认证。** 以常数时间比较 bearer token 与 `qwen.managed-agent.harness.token`。要求 `capabilityDigest` 等于 `qwen.managed-agent.harness.capability-digest`，`features` 包含 `work-pull/1` 以及本 Java 实例对任何 Harness 都要求的特性。用现有的标识符规则校验 `instanceId` 和 `bootId`。否则回答 403 `harness_work_poller_refused`。不查成员表；唯一的例外是过渡规则：停留在 P1.1 的 poller 只能以已配置成员的身份认领（§9）。
2. **请求。** 下发本实例和 boot 在当前 epoch 所持有 Session 的待处理请求项（§7）。它们不计入 `freeSlots`。一次 poll 回复最多携带 32 个请求项、16 MiB 请求体，请求体以 base64 编码传输；其余请求项保持 `PENDING`，留给紧接着的下一次 poll。
3. **重新提供。** 返回所有 placement 为 `ACTIVE`、属于本实例和 boot、且预留未被消费也未过期的 Session。epoch、token 和截止时间保持不变。它们计入 `freeSlots`。
4. **认领。** 按需求从早到晚读取候选：`harness_claim_requested_at IS NOT NULL` 且没有有效预留。对每个候选执行认领事务（§5）。是否可接管完全由 takeover CAS 按现有规则判断：带回执的已释放 placement，或 writer 租约已过期且 activation 已知。遇到拒绝（`harness_owner_still_live`、`harness_placement_changed`、`harness_placement_not_admitted`）则跳过该候选。
5. **构造内容。** 对每个认领，构造成员连接器为 `recoverForWake` 会发送的被动 load 请求，所用 pool call 携带新的 placement 及其 writer token；构造后返回而不发送。
6. **等待。** 没有可返回的内容且还有剩余时间时，等到本实例记录需求或请求、或过了 500 毫秒，然后回到第 2 步。

### 应答

```json
{
  "claims": [
    {
      "tenantId": "…",
      "sessionId": "…",
      "placementEpoch": 8,
      "reservedUntil": 1764260000000,
      "load": {
        "sessionId": "…",
        "managedSessionStore": { "…": "…" },
        "harnessPlacement": { "…": "…" },
        "passiveManagedRuntimeRecovery": true
      }
    }
  ],
  "requests": [
    {
      "requestId": "…",
      "sessionId": "…",
      "placementEpoch": 8,
      "method": "POST",
      "path": "/session/…/actions/…",
      "headers": { "content-type": "application/json" },
      "body": "…",
      "deadline": 1764260030000
    }
  ]
}
```

列表为空表示等待时间已到。Harness 立即再次 poll。

### Harness 侧

- 在 `hosted-harness` profile 下，设置了 `QWEN_MANAGED_HARNESS_WORK_URL` 时运行 poll 循环，使用 `QWEN_HOSTED_HARNESS_INSTANCE_ID` 和 `QWEN_SERVER_TOKEN`。该 URL 是控制面的内部 origin，只有 loopback 上允许明文 HTTP。缺少实例 ID，或 Harness 监听器启用了 TLS（认领要经这个监听器加载）时，启动会拒绝。只有设置了该 URL，Harness 才声明 `work-pull/1`；池要求各成员能力完全一致，所以每个池成员都要设置它。
- 每个认领的 `load` 请求体交给现有的 load 处理逻辑执行，就像 Java 发来的一样：Harness 把它提交到自己 loopback 监听器上的 `/session/{sessionId}/load`。它像任何 load 一样占用一个冷启动槽位。load 会像现在一样拒绝没有把本进程列为 writer 和 placement owner 的描述符。这项检查只保护这条 load 路径（§15）。
- load 中的 writer 获取会消费预留。load 失败时，Harness 记录日志，让预留自然过期。
- 带有认领的应答会列出本进程的全部有效预留，所以只有上一次这样的应答没有带上的认领才是新的。空应答不改变任何记录，因为 poll 的截止时间可能在某个认领提交的过程中到达，下一次 poll 会重提供它。对加载中或已失败的认领的重提供不会再次加载。应答只带这类重提供时，Harness 先暂停一秒再 poll，而不是立即 poll，因为 writer 获取之前 Java 会立即应答。
- Harness 只在有空闲冷启动槽位时 poll，排空中的 Harness 没有空闲槽位：没有槽位，收到的重提供本来也加载不了。上报的槽位已扣除在途冷启动（包括认领的 load），所以认领的 load 占到槽位之后、writer 获取之前，这个认领被计了两次，这段时间 Harness 少认领一个；这是安全的方向。
- 每个请求在进程内交给 Harness 自己的 HTTP 处理逻辑执行。Harness 用请求项的方法、路径、请求头和请求体构造请求，加上用自己的 `QWEN_SERVER_TOKEN`（即现在 Java 发给成员的 token）生成的 `Authorization: Bearer`，并重新计算分帧头。它把状态码、固定白名单内（SDK 客户端会读取的）响应头（其中包括 `X-Qwen-Harness-Boot-Id`）、响应体以及自己的 `instanceId` 和 `bootId` 提交到 `POST /internal/managed-harness-work/v1/requests/{requestId}:reply`。应答路由像 poll 一样校验 bearer token（第 1 步）。
- 传输失败和其他失败的 poll（例如控制面开关关闭时的 404）从一秒开始退避，每次翻倍，最多五秒，远小于兜底窗口。收到 403 时退避一分钟并记录日志，因为这说明 Harness 与 Java 对契约的认识不一致。失败在首次出现或变化时记录一次，恢复时记录一次。

## 5. 认领预留

`ma_session` 在 V1 baseline 中新增三列（按本模块在首次发布前的规定，原地修改 V1）：可空的 `harness_claim_requested_at` 和 `harness_claim_reserved_until`，单位都是数据库时间的毫秒；以及 `is_harness_pull_held`，默认 `FALSE`。`(harness_claim_requested_at)` 上的索引用于候选查询。

**认领事务。** 按现有 placement 锁顺序，以 poller 的实例和 boot、针对刚读到的 placement 执行 `takeover`，然后在同一次更新中设置 `harness_claim_reserved_until = now + 30 s`，并把 `is_harness_pull_held` 设为“持有者通道已启用且 poller 声明了 `holder-channel/1`”的结果。认领在两种情况下都会写这个标记，因此不含该特性的 poller 认领一个曾是 pull-held 的 placement 后，该 placement 改由推送服务。takeover 消费 release 回执时仍像现在一样截断已 seal 的 writer 租约；现在保护认领者的是预留，而不是那个租约。

**接管。** `takeover` 增加一种拒绝：`ACTIVE` 且 `harness_claim_reserved_until > now` 的 placement 回答 `harness_owner_still_live`，无论 head 处于何种状态。推送路径的接管和离开成员 placement 回收器都经过同一个 CAS，因此同样遵守它。推送路径的接管会设置 `is_harness_pull_held = FALSE`。release 不改动这个标记，由下一次接管或认领重写。

**消费。** `JournalWriterLifecycle.acquireWriter` 在 `requirePlacement` 中已先锁住 placement 行，再处理 head。它在同一事务中，针对已核验的 placement epoch 清除 `harness_claim_reserved_until` 和 `harness_claim_requested_at`。此后的每次接管都由现有的 writer 租约和恢复规则决定。

| Placement 状态                        | 同一实例和 boot 再次 poll                        | 另一个 poller poll                     | 推送路径                                                          |
| ------------------------------------- | ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------- |
| `RELEASED`，已记录需求                | 认领（新 epoch）                                 | 认领；最先成功的 CAS 胜出              | 记录需求并回答 `harness_placement_released`，最长到兜底时间（§6） |
| `ACTIVE`，预留有效，尚未获取 writer   | 再次拿到同一个认领：不产生新 epoch，截止时间不变 | 什么也拿不到                           | 送达认领者；接管以 `harness_owner_still_live` 被拒绝（§6）        |
| `ACTIVE`，预留已过期，尚未获取 writer | 可以重新认领（新 epoch）                         | 可以经"租约已过期"分支认领（新 epoch） | 认领者可达时送达它；否则立即接管（§6）                            |
| `ACTIVE`，已获取 writer（预留已消费） | 什么也拿不到；它已持有该 Session                 | 什么也拿不到；按 writer 租约规则       | 送达持有者（§6）                                                  |

来自更早 epoch 的授权在获取 writer 时会以 `harness_placement_changed` 被拒绝。在截止时间之前刚好获取到 writer 的认领者，会在 writer 租约下保有该 Session；截止时间永远不构成接管存活 writer 的理由。

## 6. 推送侧闸门与兜底

在 `HarnessPoolConnector.select` 中，当 `mayAcquire` 为真、没有生命周期操作且开关开启时，对非 `ACTIVE` placement 的接管不再走轮询；§7 再加上持有者不可达的 pull-held placement。闸门在 `select` 查找可接收的成员之前执行，因此即使没有可达的推送成员也会记录需求，在闸门内只有第 3 步的兜底才可能像现在一样返回 `harness_pool_unavailable`。其他选择都保持现在的路径。没有 placement 的 Session（例如新 Session 的第一个 Turn）立即分配，因为认领是对已有 placement 的 `takeover`，没有 poller 能认领它（§2）。从不可达或正在静默的成员手中接管 `ACTIVE` placement，也与现在一样。在 P1.1 中，闸门还要求池契约包含 `work-pull/1`，因为只有成员能认领。在 P1.2 中，闸门不查阅池，因为 poller 不必是成员。

1. 如果 `harness_claim_requested_at` 为空，则把它设为当前时间（`IS NULL` CAS），并唤醒本实例的 poll 等待者。
2. 如果需求存在不到 30 秒，抛出 409 `harness_placement_released`。
3. 否则按现在的方式分配，并在同一事务中清除 `harness_claim_requested_at`，使推送成员打开该 Session 期间 poller 不再把它当作候选。这个兜底让没有 poller 运行时工作仍能推进；兜底次数是上线时的观测指标。

预留在获取 writer 之前就过期的认领不会再等第二次。在 P1.1 中，认领者的 placement 是 `ACTIVE`，不在闸门范围内。在 P1.2 中，需求早于认领，因此已经超过兜底时长。无论哪种情况，发现认领者不可达的推送路径都会立即接管，所走的正是放行 poller 的同一个 CAS（§5）。预留有效期间，这次接管以 `harness_owner_still_live` 被拒绝，而 `HarnessCoordinator` 已经把它当作池等待。

`harness_placement_released` 现在就会在 owner 于选择与调用之间释放时到达调用方。`HarnessCoordinator` 把它当作不扣重试预算的池等待；`WakeRecovery` 在认领候选时已把 `wake_retry_at` 推后 30 秒。实现时需确认 `ActionResponseCoordinator`、消息、子结果和 channel relay 以及自动化扫描器都会重试它而不进入终态，并在不满足的地方补上。

认领之后，各推送路径的下一次尝试会看到属于认领者的 `ACTIVE` placement。推送放置的 owner 像现在一样经 HTTP 调用。pull-held 的 owner 经持有者通道调用（§7）。认领者自己的 load 尚未结束时到达的调用，会在同一套 attachment 规则（#17521）下收敛到同一个驻留实例；正是这套规则让现在的决定投递 load 与派发 load 收敛。

## 7. 持有者通道

**路由。** 当 `select` 返回一个 pull-held 的 placement 时，`call` 用同一套 `QwenHostedHarnessConnector` 逻辑，作用在一个 SDK 客户端上，该客户端的 HTTP 交换走通道而不是 socket。SDK 客户端接受注入的 `HttpClient`，由通道来实现它：一次交换变成一个请求项，请求项的应答变成响应。通道客户端像任何客户端一样协商能力，也是通过一个请求项，因此从未见过该持有者 poll 的 Java 实例也能得知它的契约。路由覆盖每一个通过 `select` 解析 owner 的连接器方法，而不只是 `call`：`observe` 系列（`inspectRecovery`、`cachedRecoveryAttachment`、`discardManagedRecovery`）、`inspectUnattachedRecovery`、`clientFilesOperation`、运行时技能 owner 调用、`releaseOwnership`，以及 `prepareContextCompression` 和它返回的 submission。现在其中 `select(..., false)` 的调用方对池外的持有者找不到成员，会各自走“没有 owner”的分支；`prepareContextCompression` 则不经过 `call`，直接调用选中的成员。`observeStream` 是流，通道拒绝它（见“限制”）。

**持有者存活。** Java 没有成员条目可以把 pull 持有者标为不可达，因此从 Store 读取存活状态。`select` 在读 placement 的同时读取 head 的 writer 租约。当持有者已获取 writer 且 writer 租约已过期，或预留在任何获取之前就已过期时，pull-held placement 视同不可达的 owner。此时 `select` 按 §6 记录需求，而不是排入请求，由某个 poller 经"租约已过期"分支认领该 Session。仍处于预留期内的 placement 路由到通道，认领者一旦 poll 就会看到该请求。

进程还活着但已不再 poll 的持有者会保住 writer 租约，因为续租由 Store 客户端负责，与 poll 循环无关；发给它的请求只能等到每个调用方超时。因此 Harness 把租约与 poll 循环绑定：45 秒（超过长轮询等待的两倍）内没有完成任何一次 poll 时，它停止所持有的每个 pull-held Session 的 writer 续租（`stopWriterRenewal`）。租约随之过期，适用上面的规则。因此 poll 循环停滞后的恢复时间是 45 秒窗口加上 writer 租约的剩余时长，后者至多为 Store 描述符中的租约时长（`MAX_LEASE_MILLIS` 把它限制在 300 秒）。403 退避也计入这个窗口：poll 被 Java 拒绝的 Harness 同样收不到请求，因此它的 Session 应当转移。

**请求项。** 新表 `ma_harness_request` 保存 `request_id`、`tenant_id`、`session_id`、`placement_epoch`、`holder_boot_id`、`method`、`path`、固定白名单内（Harness 路由会读取的）请求头（绝不含 `authorization`）、`body`（`MEDIUMBLOB`，能容纳 8 MiB 的附件输入）、`deadline`、`state`（`PENDING`、`DELIVERED`、`ANSWERED`、`EXPIRED`）、`reply_status`、`reply_headers`、`reply_body` 以及时间戳。请求项按租户隔离，以 `request_id` 为键。`deadline` 是调用方调用超时的截止时刻：poll 不下发超过它的请求项，超过它的应答被拒绝。`(holder_boot_id, state, placement_epoch)`、`(tenant_id, session_id, placement_epoch)` 和 `(state, deadline)` 三个索引分别服务于下发、takeover 过期与退役清理，以及清扫。通道不复用 `ma_client_files_request`：那个队列以 client-files 绑定代次为围栏、由绑定的浏览器取走，而这里的请求项以 placement epoch 和持有者 boot 为围栏，承载的是一次 HTTP 交换。通道不保存任何凭据。实现时列出通道转发的每种请求体中的凭据字段；通道在插入前移除它们，poll 处理程序在下发请求项时恢复它们。`managedSessionStore.writerToken` 为该请求项的 placement 重新签发。client-files 注册的 `token`（Java 只保存它的哈希）重新生成，poll 处理程序在下发 CAS 的同一事务中替换该绑定代次的 token 哈希。凭据无法恢复的调用不走通道，返回带码的等待。

**下发。** 一次 poll 选出持有者当前 epoch 中仍在截止时间内的 `PENDING` 请求项，最旧优先，数量受 §4 第 2 步的上限约束。它用一个 CAS 只把选出的这些改为 `DELIVERED` 并返回；其余保持 `PENDING`。应答是一个从 `DELIVERED` 到 `ANSWERED` 的 CAS，只有当应答的 `bootId` 等于请求项的 `holder_boot_id` 时才接受。epoch 不需要单独的输入，因为 takeover 已经让更早 epoch 的所有请求项过期。通道把应答中的响应头交给 SDK 客户端，因此客户端的 boot 校验看到的是实际执行该请求的 boot。takeover 在其事务中让旧 epoch 的所有请求项过期。尚未下发的请求项，其调用方看到 `harness_placement_changed`，重新选择。已下发的请求项，其调用方与超时时一样得到结果未知，因为旧持有者可能已经执行了它；旧 boot 的迟到应答会发现请求项已是 `EXPIRED`，被拒绝。

**等待。** 调用方最多等待其现有的调用超时时间。应答落在调用方所在的 Java 实例上时立即唤醒它；否则每 100 毫秒重查一次 SQL。超时时，调用方得到的异常与"请求可能已送达后发生传输失败"时相同。调用方现在已把这种情况视为结果未知，并以自己的操作 ID 或命令 ID 重试，而 Harness 路由今天就会对其去重。

**限制。** 一个请求就是一次交换。通道拒绝流式交换，Harness 事件流就是其中之一；§8 让 pull-held Session 不再需要事件流，实现时再列出 pull-held Session 可能用到的其他流式路由。每个 Java 实例上都有一个定时清扫（与 client-files 中继的清扫类似），分批让超过截止时间的请求项过期，并在截止时间 10 分钟后删除请求项。Session 退役时，其请求项与它的其他队列一起删除。

## 8. pull-held Session 上的 Turn

pull-held Session 永不打开 Harness 事件流。

- **全新提交**按 #18557 的定义使用上报：提交请求 `eventDelivery`，受理时把 Turn 交给 Harness。
- **其他所有打开事件流的位置。** `HarnessCoordinator` 在 `runClaimed` 末尾（恢复受理、续跑或取消之后）、`observeBlockedHarness` 和 `replaySettledTurn` 中打开事件流。对于 pull-held Session，这些位置改为：
  1. 以派发器的有效租约和已记录的事件 epoch 为条件做 CAS，把 Turn 的派发租约交给 `harness:` + 持有者的 boot，适用于 `RUNNING` 或 `CANCELLING` 的 Turn；
  2. 经通道调用一条新的 Harness 路由 `POST /session/:id/events/push`，带上 `turnId`、`promptId`、`eventEpoch`，以及设为 Turn 已消费游标的 `afterSequence`；Harness 启动一个上报器，替换该 prompt 已有的上报器；
  3. 不打开事件流，直接返回。

  这种事件流位置的交接是 P1.2 新增的。#18557 的准入交接（`AgentTurnHandOff.recordAdmissionHandOff`）只服务全新提交，且只接受 `RUNNING` 的 Turn，取消中的 Turn 留在派发器。交接必须在前：先启动的上报器会得到 `managed_event_ingest_not_owner` 并停止。如果调用失败，租约在 60 秒内过期，Turn 按现有路径恢复。在 `observeBlockedHarness` 中，recovery-blocked 探测改为经通道读取 Harness 状态，而不是读事件流。

- **取消。** P1.2 收窄 #18557 在 `findDispatchable` 和 `claimTurn` 中加入的收回条件（`AgentTurnHandOff.HARNESS_HELD_CANCEL`），使其排除 pull-held Session。对于 pull-held Session 上由 Harness 持有的 Turn，`HarnessCoordinator.cancel` 和一个每秒一次的扫描经通道投递 `cancelOriginalTurn`，但不收回 Turn。扫描通过 `retry_after` 为每个 Turn 控制节奏，Harness 的租约续期不会改动它。Harness 中止该 Turn，其上报器写入终态。派发器自己在 `runClaimed` 中投递的取消，按上面的方式把 Turn 交还，所以事件流位置的交接允许 `CANCELLING`。如果只有 #18557 的 `RUNNING` 条件，这样的 Turn 会一直等到 60 秒租约过期。

恢复逻辑本身不迁移。Java 仍然执行挂接、接管、恢复受理、续跑以及 `runClaimed` 中的每一项检查；改变的只是传输和事件投递。

## 9. 切片

P1 分两个切片落地，都在同一个开关之后。

1. **P1.1 —— 认领、预留与 wake。** 即 §4 到 §6 的全部内容。已释放 Session 的 wake 工作不再有 Java 到 Harness 的调用。在 P1.2 之前，其他调用经推送送达认领者，因此有一条过渡规则：只向实例和 boot 与已配置、已协商的池成员一致的 poller 发放认领。这是 P1 唯一查阅成员表的地方。P1.2 对声明了 `holder-channel/1`（即能处理请求项和 `events/push` 的特性）的 poller 解除这条规则；不含该特性的 poller 仍受此规则约束，并经推送调用。不依赖上报。
2. **P1.2 —— 持有者通道与无事件流的 Turn。** 即 §7、§8 以及 pull-held 标记。任何声明了 `holder-channel/1` 的兼容 poller 都可以认领，Java 不再向 pull-held Session 发出任何 HTTP 调用。在 #18557 之上新增事件流位置的交接并收窄其收回条件（§8），并依赖 `qwen.managed-agent.event-ingest.enabled`；上报关闭时，部署停留在 P1.1。

提案中 P1 的退出条件是"这些路径不再调用 Harness"：wake 在 P1.1 满足，pull-held Session 上的其余一切在 P1.2 满足。取消和决定的原生信号不属于 P1。P3 会在通道未达到延迟预算（与现在的直接调用对比测量）的地方加上它们，并把认领扩展到没有 placement 的 Session。

## 10. 兼容与上线

| 控制面             | Harness                                   | 行为                                                          |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| 开关关闭，任意版本 | 任意                                      | 不再有 pull-held Session 后与现在一致（见下文“关闭”）         |
| 开关开启，上报关闭 | 池不含 `work-pull/1`                      | 与现在一致；闸门不生效                                        |
| 开关开启，上报关闭 | 含 `work-pull/1`                          | P1.1：已释放 Session 由已配置成员的认领放置；调用经推送       |
| 开关开启，上报开启 | 含 `work-pull/1`、不含 `holder-channel/1` | 该 poller 停留在 P1.1：只能以已配置成员身份认领；调用经推送   |
| 开关开启，上报开启 | 含 `work-pull/1` 和 `holder-channel/1`    | P1.2：已释放 Session 由任一兼容 poller 的认领放置；调用经通道 |
| 开关开启，上报开启 | 没有 poller 运行                          | 每个已释放 Session 都要等满 30 秒兜底，然后由推送放置         |

- **开启。** 先部署带路由、闸门、预留和通道的控制面。再滚动发布带 `work-pull/1` 和 poll URL 的 Harness。最后打开开关。P1.2 中闸门无法判断是否有 poller 在运行，因此在 Harness 发布之前打开开关，会让每个已释放 Session 都多等一个兜底时长。
- **关闭。** 闸门立即打开，不再产生新的认领。未完成的预留在 30 秒内过期。pull-held Session 保留其持有者，并继续使用通道，直到它们释放或持有者死掉；只要还有这样的 Session，poll 和应答路由就继续提供服务。
- **控制面回滚。** 只在 pull-held Session 都已释放之后回滚。持有者无法被 Java 寻址的 pull-held Session 会等到持有者的 writer 租约过期，再由推送恢复。poller 收到 404 后退避。
- **Harness 回滚。** 不含该特性的 Harness 从不 poll；它的 Session 保持由推送放置。

## 11. 失败与竞态语义

| 窗口                                           | 要求的结果                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 认领响应丢失                                   | 同一 poller 下次 poll 时拿回同一个认领；预留过期前其他 poller 什么也拿不到                                        |
| 认领者在获取 writer 之前死掉                   | 预留过期；任一 poller 以新 epoch 认领；死掉的认领者的迟到授权被 fence                                             |
| 持有者在获取 writer 之后死掉                   | 其 writer 租约过期；待处理的工作记录需求；任一 poller 经"租约已过期"分支认领                                      |
| 持有者活着但 poll 循环已停止                   | 45 秒内没有完成任何 poll 后，它停止续租 writer 租约；租约按上一行过期                                             |
| 不同 Java 实例上的两个 poller 认领同一 Session | placement CAS 只放行一个；另一个跳过                                                                              |
| 需求或请求记录在 Java A，poll 挂在 Java B      | B 在下一次 500 毫秒重查时发现                                                                                     |
| 没有 poller 运行                               | 30 秒后推送路径按现在的方式分配                                                                                   |
| 推送兜底与一次 poll 竞争                       | placement CAS 只放行一个；推送路径的下一次尝试送达持有该 placement 的一方                                         |
| 请求的应答丢失或迟到                           | 调用方以结果未知超时并重试；Harness 路由去重                                                                      |
| 有待处理请求时发生接管                         | 旧 epoch 的所有请求项过期：未下发的回答 `harness_placement_changed`，已下发的为结果未知；旧 boot 的迟到应答被拒绝 |
| 交接之后启动上报器失败                         | Turn 租约在 60 秒内过期，Turn 按现有路径恢复                                                                      |
| pull-held 的 Turn 运行中被取消                 | 通道送达取消；Turn 留在 Harness 手中，经上报写入唯一的终态                                                        |
| 先前的持有者迟到写入                           | 与现在一样被 placement epoch 和 writer generation 拒绝                                                            |
| load 比预留更慢                                | 另一个 poller 可能认领；慢的 load 在获取 writer 时因 epoch 失败；作为反复易主计入观测                             |
| Java 重启                                      | 需求、预留和请求都在 SQL 中；poll 在任一实例上继续                                                                |

## 12. 涉及的文件

### 控制面

- `persistence/src/main/resources/db/managed-schema/V1__managed_schema.sql`：`ma_session` 的三列及其索引，以及 `ma_harness_request`。
- `persistence/.../JdbcHarnessPlacementStore.java`：认领事务、`takeover` 中的预留拒绝与 pull-held 清除、需求标记、候选查询和重新提供查询。
- `persistence/.../JournalWriterLifecycle.java`：在 `acquireWriter` 中消费预留。
- `persistence/.../AgentTurnHandOff.java`：事件流位置的交接（也接受 `CANCELLING` 的 Turn），以及 `HARNESS_HELD_CANCEL` 中对 pull-held 的排除。
- `persistence/.../AgentTurnExecution.java`：取消投递扫描。
- `persistence/`（新增 store）：请求项。
- `persistence/.../ManagedSessionRetirementStore.java`：删除已退役 Session 的请求项。
- `persistence/.../ClientFilesRelayStore.java`：在注册请求被下发时替换该绑定代次的 token 哈希。
- `adapters/.../harness/HarnessPoolConnector.java`：闸门、闸门的 `work-pull/1` 池契约检查，以及为 `select` 的每个调用方（包括 `prepareContextCompression`）把 pull-held placement 路由到通道（§7）。
- `adapters/.../harness/QwenHostedHarnessConnector.java`：为 pool call 构造但不发送被动 load 请求。
- `adapters/.../harness/HarnessRequestChannel.java`（新增）：通道 `HttpClient`。
- `adapters/.../harness/HarnessFeature.java`：`work-pull/1` 和 `holder-channel/1`。
- `control-plane/.../session/HarnessWorkPoll.java`（新增）：认证、P1.1 的过渡规则、请求及其凭据恢复、重新提供、认领、长轮询与请求清扫。
- `control-plane/.../session/HarnessCoordinator.java`：事件流位置与 pull-held 的取消。
- `server/.../api/`（新增 controller）：poll 和应答路由。
- `verification/.../api/SurfaceRegistry.java`、`capability-parity/managed-surface.txt` 与 `packages/cli/src/serve/capability-parity.ts`：登记并重新捕获这些路由，并把它们归类为内部路由。
- `packages/sdk-java/qwencode/.../daemon/HostedHarnessClient.java`：接受注入的 `HttpClient`。
- `application.yml` 与 `configuration-descriptions.json`：`qwen.managed-agent.harness-pull.enabled`。

### Harness

- `packages/cli/src/serve/hosted-harness-contract.ts`：`work-pull/1` 和 `holder-channel/1`。
- `packages/cli/src/serve/hosted-harness-work-poll.ts`（新增）：poll 循环、容量、认领与请求的执行、应答、退避，以及 poll 停滞时停止 writer 续租。
- `packages/cli/src/serve/hosted-harness-session/session-open.ts`：用 load 处理逻辑执行认领中的 load 请求体。
- `packages/cli/src/serve/hosted-harness-session/observation-routes.ts`：`events/push` 路由。
- `deploy/kubernetes/chart`：把内部 origin 作为 `QWEN_MANAGED_HARNESS_WORK_URL` 传给每个 Harness。

### 测试

- Java，H2 与 MySQL 8.4：§5 的预留矩阵、闸门与兜底、需求清除、poller 拒绝、请求下发、应答 fence 与过期、事件流位置的交接、pull-held 的取消、开关关闭时的行为，以及现有的接管和回收器测试。
- TypeScript：poll 节奏、容量控制、认领与请求的执行、应答、`events/push`、描述符拒绝、poll 停滞时停止 writer 续租，以及能力一致性矩阵。
- 真实进程：两个 Java 实例和两个 Harness 进程，MySQL 8.4（§13）。

## 13. 验证计划

- **先确认基线。** 在现有 store 上证明：release 被一次从未获取 writer 的 takeover 消费之后，第二次 takeover 会立即成功。这正是预留要消除的反复易主。
- **预留矩阵**，在 H2 和 MySQL 8.4 上：
  - 扣住 A 的认领响应。B 在截止时间之前以 A 当前的 epoch poll，什么也拿不到。B 在截止时间之后 poll，认领成功。A 延迟到达的 load 在获取 writer 时被 fence。
  - A 在截止时间之前刚好获取到 writer。B 随后按 writer 租约规则，什么也拿不到。
  - A 在截止时间之前再次 poll，拿到相同的 epoch 和截止时间。
- **闸门。** 开关关闭以及 Harness 实例不含该特性时与现在一致。开关开启时记录需求、返回等待码，并在 30 秒后兜底。开关开启时，没有 placement 的 Session 立即分配；预留已过期的认领在认领者不可达时立即被接管。没有可达的推送成员时仍会记录需求，并由 poller 认领。不含 `holder-channel/1` 的 poller 只能以已配置成员身份认领，其 placement 不是 pull-held，即使它认领的 placement 原本是。
- **兜底竞争。** 让需求超过兜底窗口，然后在 H2 和 MySQL 8.4 上并发执行推送兜底与 poller 认领。恰好一个 placement epoch 获取到 writer，另一条路径不派发任何工作。单独发生兜底之后，有空闲槽位的 poller 拿不到任何东西，推送成员的 load 成功。
- **通道。** 应答丢失、截止时间之后才到的应答、来自错误 boot 或 epoch 的应答、未经认证的应答、重放后到达目标路由而不是得到 401 的请求、其 boot 头被调用方 boot 校验拒绝的应答、超过截止时间的请求项、清扫、Session 退役删除所有请求项、按条数和字节数截断的 poll 回复、对 pull-held Session 的恢复检查与上下文压缩、有待处理和已下发请求项时发生接管、应答落在另一个 Java 实例上、进程仍在运行但 poll 循环停止的持有者，以及从不保存 writer token 或 client-files token、而下发的调用仍能通过认证的请求体。每次调用的调用方看到的结果，都与对应的 HTTP 失败现在的结果一致。
- **真实进程，P1.1。** 即 #18514 中的第一个 P1 场景：两个 Java 实例和两个 Harness 进程，MySQL 8.4。Harness A 提出一个结构化问题，停靠并释放，同时保持健康。通过 Java 提交答案。B 认领该 Session，原 Turn 继续。再分别在获取 writer 之前丢失认领响应、重复提交答案、A 迟到写入的情况下重复。要求只有一个有效 writer、只应用一次答案、只有一个终态事件。在关闭 RocketMQ 的情况下运行。
- **真实进程，P1.2。** 同一场景，但 B 不在 Java 的池配置中。认领之后，答案、续跑、续跑中的一次取消、下一个 Turn 以及关闭都送达 B，期间没有任何 Java 到 Harness 的 HTTP 调用，每个 Turn 的事件都经上报到达。
- **测量**需求到获取 writer 的延迟、兜底次数、请求往返时间、经通道的取消与审批投递延迟、poll 和请求的查询速率以及锁等待，并与推送基线对比。

## 14. 验收标准

- 开关关闭且不再有 pull-held Session，或在 P1.1 中池不含 `work-pull/1` 时，行为与现在逐字节一致。
- 开关开启时，没有 placement 的 Session（例如新 Session 的第一个 Turn）仍然立即分配。
- 有 poller 运行时，有待处理工作的已释放 Session 只由认领的 poller 放置；没有空闲槽位的 poller 不认领任何东西。
- 认领响应丢失绝不会在预留期内导致第二次认领；来自更早 epoch 的授权绝不会获取到 writer。
- 已释放 Session 的 wake 工作在没有任何 Java 到 Harness 调用的情况下完成。
- P1.2 之后，不在 Java 配置中的 poller 能认领已释放的 Session，并服务它之后的所有调用。Java 不向它发出任何 HTTP 调用，该 Session 上也没有任何 Turn 打开 Harness 事件流。
- 已被认领 Session 的决定、relay 工作和取消以现在的结果完成：Allow 只执行一次，Deny 不执行，被取消的 Turn 只结算一次。
- 没有 poller 运行时，工作在兜底之后继续推进。
- 推送兜底与 poller 认领竞争时，恰好一方获取到 writer。
- 不改变公共路由或投影。schema 变更只在 V1 baseline 中。

## 15. 风险与待定问题

1. **兜底时长。** 只要还有推送成员，30 秒就限定了 poller 故障的代价，但 poller 只是变慢时也会延迟工作。默认开启前需要测量。没有推送成员的部署没有兜底。
2. **预留时长。** 认领者必须在 30 秒内获取 writer。在固定这个常量之前，先在负载下测量认领到获取 writer 的时间。
3. **poller 身份。** bearer token 由所有 Harness 共享，不能表明是哪个实例在 poll，而 boot ID 也不是秘密。持有该 token 的 Harness 可以冒用另一个 Harness 的名义 poll，拿到它的认领、重新提供和请求；在 P1.2 中，它还能以自己的名义认领任何已释放的 Session。每个认领的 load 请求体都带有该 placement 的 writer token，而 Store 接受任何调用方出示的这个 token，只要同时给出该 placement 的 boot ID；load 的描述符拒绝只保护 Harness 自己的 load 路径。因此这样的 Harness 能为这些 Session 获取 writer、提交 journal 记录并应答请求，而不只是读到它们的配置和内容；真正的持有者则会错过被它拿走的请求。在推模式下，Java 只把 writer token 发给它为该 Session 放置的成员。因此只有持有该 token 的每个 Harness 都同等可信、且都在 Java Pod 的信任边界之内时，P1 才是安全的。在其他 Harness 可以 poll 之前，必须有逐实例身份，把 poll 和 writer token 都绑定到实例上。
4. **通道的成本与延迟。** 每次调用需要一次插入、一次下发更新和一次应答更新，跨实例时还有 100 毫秒的应答重查。经通道的取消与审批延迟是 P3 的退出测量项。45 秒的 poll 停滞上限（§7）与之一起测量。
5. **流式路由。** 实现时必须列出 pull-held Session 可能用到的每一种流式交换，并替换掉或以带码的等待拒绝。
6. **load 收敛。** 认领 load 与经通道送达的决定 load 或恢复 load 必须收敛到同一个驻留实例。要用测试覆盖，而不是从现在的双 load 情形推断。
7. **等待码的调用方。** 部分 relay 调用方可能把 `harness_placement_released` 当作终态。P1.1 中逐个核查。
8. **公平性。** 最早需求优先无法阻止单个租户占满队列。
9. **剩余的成员依赖。** 在 P3 之前，新 Session 的首次放置和 side query 仍然需要推送成员。
10. **静态存储的内容。** 请求体和应答体带有 Session 内容（包括最大 8 MiB 的附件），会在 `ma_harness_request` 中保留到清扫删除它们（截止时间后 10 分钟）或 Session 退役为止。Session 内容的保留与访问规则必须覆盖这张表。
