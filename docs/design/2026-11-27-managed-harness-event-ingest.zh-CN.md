# Managed Harness 事件上报

[English](2026-11-27-managed-harness-event-ingest.md) | [简体中文](2026-11-27-managed-harness-event-ingest.zh-CN.md)

状态：设计提案，2026-11-27。现状描述已对照 `main` 的 `43dc924882` 核实。§10 的第一步在同一变更中实现。本设计基于[无状态 Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)和[挂起时释放 placement](2026-11-26-managed-suspension-placement-release.zh-CN.md)。

## 1. 问题与现状

运行中的 Turn 有两个 owner。Hosted Harness 持有 Session 的 writer lease 并运行循环。认领该 Turn 的 Java 实例持有它的 `dispatch_owner` 租约（60 秒，每 20 秒续一次），在整个 Turn 期间保持 Harness 事件流打开，并把读到的内容写入。

派发者处理一个 Turn 的步骤：

1. 认领 Turn（`AgentTurnExecution.claimTurn`）。
2. attach、接管或恢复 Harness Session，把 Turn 绑定到 Harness 的 boot，提交或续跑 prompt。这一步同时对齐 event epoch（`HarnessCoordinator.runClaimed`）。
3. 记录准入：状态 `RUNNING`、`harness_event_epoch` 和 `harness_last_event_id`（`recordAdmission`、`recordRecoveryAdmission`）。
4. 从 Turn 的游标打开 `GET /session/:id/events`，运行 `consumeStream`，直到终态事件、Action 停靠或 recovery block。

只有第 4 步需要一个 Java 实例在整个 Turn 期间挂着。`consumeStream` 做以下事情：

| 职责           | 现状                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 投影           | 每个 v1 envelope 都经过 `HarnessEventProjector`。来源键是 `bootId:eventEpoch:sourceId`，`sourceId` 就是 journal 序号。                                                                                         |
| 过滤           | 跳过没有 ID 的 envelope，以及属于其他 prompt 的 envelope。                                                                                                                                                     |
| 攒批           | 文本和推理增量按 75 毫秒、64 条或 64 KiB 攒批。首个可见文本和其他每个投影事件立即写入。终态事件结束所在批次。                                                                                                  |
| 写入           | `recordHarnessEvents` 锁 Session 和 Turn，检查 `dispatch_owner`、租约有效期和 event epoch，然后在一个事务中推进游标、追加公开事件，终态时结算 Turn。                                                           |
| 撤回           | `message_retracted` 先写入待发批次，再调用 `retractHarnessTurnOutput`；撤回可以用 `sourceBootId` 和 `sourceEventEpoch` 限定范围。                                                                              |
| Action 停靠    | 流结束而没有终态事件时，派发者调用 `parkTurnForAction`。停靠本身由持久状态判定：head 已 seal、activation 已释放、`wake_seal_revision = journal_revision`、prompt 是被停靠的那个、且有一个已请求的 Action。     |
| recovery block | 派发者每 15 秒读一次 Harness 状态。若没有活跃 prompt、recovery 被阻塞、游标之后也没有事件，就调用 `markTurnRecoveryBlocked`。Harness 的 `recoveryBlocked` 有一部分只在内存里（MCP 恢复、待处理的 Hook 操作）。 |
| 失败           | 流出错按暂时失败处理：释放租约，下一次扫描从第 2 步重新驱动该 Turn。                                                                                                                                           |

后果：

- 派发的 Java 实例死掉后，该 Turn 的公开事件就停了，要等租约过期、另一个实例重新 attach。最近的多实例工作，例如 #18433、#18440、#18455、#18463，都是在恢复这第二个 owner。
- 每个运行中的 Turn 都占一条长连接，从 Java 连到 Harness。
- 拉模型调度无法开始。Harness 认领并续跑 Turn 后，Java 仍要反向连回它才能拿到事件。

## 2. 目标与范围

### 目标

- 准入之后，由 Harness 把该 Turn 已提交的事件投递给任一 Java 实例，不再有 Java 实例挂着。
- 对同一份 journal，公开事件、撤回和终态结算与现在完全一致。
- 杀掉准入该 Turn 的 Java 实例，不会中断事件投递。
- Harness 死掉或卡住，按与现在相同的租约上限发现，并走现有的恢复路径。
- 混合版本和回退都安全，每个 Turn 只走一条投递路径。

### 非目标

- 把认领、attach、接管、恢复准入和 epoch 对齐（第 1 到 3 步）从派发者移走。这些随拉模型调度迁移。
- 按容量选择 Harness。全新提交仍按池的轮询挑选成员，忙的成员仍返回 `hosted_session_open_busy`。按空余容量认领随拉模型调度到来。
- 让经由恢复、cancel 或 Action 停靠续跑准入的 Turn 走上报。本设计中它们继续走事件流。
- 修改 cancel 的投递方式、公开事件 API、`EventTailPoller` 或投影代码。
- 把派发租约改用数据库时间（#14248）。它保持不变。
- schema 迁移、消息队列，或由 Java 投影 journal 提交。

## 3. 设计决策

| 决策                     | 选择                                                                                                                                         | 理由                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 准入后的归属             | 派发者在同一事务中记录准入并设置 `dispatch_owner = 'harness:' + bootId`                                                                      | 现有的每一处校验（`dispatch_owner = ? AND dispatch_lease_until >= ?`）都原样有效。派发者的 owner 是 UUID，前缀不会冲突。 |
| 租约持有者               | Harness 的每次上报请求都续 Turn 租约；没有事件时按租约续期间隔发心跳                                                                         | `findDispatchable` 仍通过租约过期发现死掉或卡住的 owner，不需要新的扫描条件。                                            |
| 路由                     | `POST /internal/managed-session-store/v1/sessions/{sessionId}/events:ingest`                                                                 | 每个常驻 Session 已经持有 Store 地址和写权限 token。任一 Java 实例都能处理。                                             |
| 认证                     | 与其他 writer 路由一样校验 writer 凭证、placement 和 writer 实例；实例须仍存活，或是一次干净 seal 后的已 seal 实例                           | 只有 Session 的写者能上报。Turn 的正确性仍由 `dispatch_owner` CAS 保证。                                                 |
| 载荷                     | 按 journal 顺序发送现有的 v1 envelope                                                                                                        | 只保留一份投影实现。Java 对每个 envelope 执行与 `consumeStream` 相同的逻辑。                                             |
| 顺序                     | `afterSequence` 和 `throughSequence`；不超过游标的 envelope 忽略，有缺口时返回已提交游标                                                     | 等同于现在的源 ID 单调递增规则，外加显式的缺口修复。                                                                     |
| 开启方式                 | 仅当 `qwen.managed-agent.event-ingest.enabled=true` 且 Harness 声明 `event-ingest/1` 时，派发者才在提交 prompt 时请求上报（`eventDelivery`） | 按 Turn 决定，按准入回退。                                                                                               |
| 结束标记                 | seal 后发 `end: "parked"`；Harness 阻塞时发 `end: "recovery_blocked"`                                                                        | 用 Harness 已有的证据取代"流结束"推断和状态轮询；Java 运行现有的判定逻辑。                                               |
| cancel                   | CANCELLING 通道可以认领 Harness 持有的 Turn，之后走现有的拉流路径                                                                            | cancel 的投递和证明都不变。Harness 的下一次请求会被拒，它随之停止。                                                      |
| recovery blocked 的 Turn | 通过现有方法标记，之后由现有的观察通道按拉流方式处理                                                                                         | 少见的路径保持现有行为。                                                                                                 |

## 4. 上报协议

### 请求

```json
{
  "workspaceId": "...",
  "writerId": "...",
  "writerGeneration": 7,
  "eventEpoch": "...",
  "turnId": "...",
  "promptId": "...",
  "afterSequence": 120,
  "throughSequence": 131,
  "events": [
    {
      "v": 1,
      "id": 121,
      "type": "session_update",
      "promptId": "...",
      "data": {}
    }
  ],
  "end": "parked"
}
```

writer ID 就是 Harness 的 boot ID：Harness 会拒绝 writer 不是自身 boot 的 Store 描述，所以请求里不再单独携带 boot ID。

`events` 包含 Session journal 在 `(afterSequence, throughSequence]` 内投影出的全部 envelope，包括其他 prompt 的，与 `GET /session/:id/events` 会推送的内容相同。每个请求最多 64 个 envelope。心跳时 `events` 可以为空。`end` 可选。

Java 按 SDK 拉流解码器的规则解码每个 envelope，使投影器看到的值与拉流时相同：

- `v` 必须为 1，`type` 不能为空，`id` 必须为正、递增且落在范围内，`data` 必须存在。
- 整数收窄为 `int`、`long`、`BigInteger` 中能容纳它的最小类型，小数解码为 `BigDecimal`。
- 拒绝重复键。

### 处理

1. **认证。**
   - 校验 tenant、Workspace 和 Session 凭证以及写权限 token。
   - 要求当前 placement，以及按数据库时间仍存活的 writer 实例。
   - 带 `end: "parked"` 的请求也可以出示一次干净 seal 后的已 seal 实例，校验与干净 seal 释放分支相同：writer ID、generation、token 哈希和 placement。
2. **定位 Turn。** 按 `turnId` 读取 Turn，并要求其 `prompt_id` 与 `promptId` 一致。
   - Turn 仍活跃但 `harness_event_epoch` 与 `eventEpoch` 不同，说明准入还没记录：返回 `managed_event_ingest_not_ready`。
   - `dispatch_owner` 不是 `harness:` + `writerId`，或租约已过期：返回 `managed_event_ingest_not_owner`。
3. **检查游标。**
   - `afterSequence` 大于 `harness_last_event_id` 时，返回 `managed_event_ingest_cursor_mismatch` 和已提交游标。
   - `throughSequence` 不大于游标时，直接确认，不写入。
4. **写入。** 按 `consumeStream` 的规则依次处理 envelope：
   - 跳过其他 prompt 的 envelope 和没有 ID 的 envelope。
   - 增量最多 64 条或 64 KiB 一组。
   - 其他每个投影事件、每次撤回和每个终态事件各自调用一次现有的 `recordHarnessEvents` 或 `retractHarnessTurnOutput`。owner 用 `harness:` + `writerId`，来源键用 `writerId:eventEpoch:sourceId`。
   - 每次调用保持现有的事务、加锁顺序和校验。中途失败时，已提交的前缀保留。Harness 原样重发该请求，已在游标及以下的 envelope 会被忽略。
   - 由于一个请求本身就是一批，事务边界可能与拉流时不同，但写入的事件相同。
5. **推进并续租。** Turn 未终结时，把游标推进到 `throughSequence`（末尾的 envelope 已被过滤），并以 Harness owner 调用 `renewTurn` 续租。
6. **结束。**
   - `parked` 要求游标等于 head 的已提交序号，然后以 Harness owner 调用 `parkTurnForAction`。
   - `recovery_blocked` 要求同样的游标条件，然后以 `HARNESS_RECOVERY_BLOCKED` 调用 `markTurnRecoveryBlocked`。
   - 两个方法都按现有条件清空 `dispatch_owner`。游标未到或条件不满足时，返回 `managed_event_ingest_end_refused`；该 Turn 之后会在租约过期时恢复。

### 回复

回复为 `{ "cursor": 131, "leaseRenewAfterMillis": 20000 }`。

| 回复                                                          | Harness 的处理                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| 成功                                                          | 从 `cursor` 继续                                             |
| `managed_event_ingest_cursor_mismatch`                        | 从返回的游标重新读 journal                                   |
| `managed_event_ingest_not_ready`                              | 退避重试，最长不超过租约时长                                 |
| `managed_event_ingest_not_owner`、writer 校验被拒、终态已确认 | 停止为这次准入上报                                           |
| `managed_event_ingest_end_refused`                            | 若是游标未到，补发到已提交序号后重试；否则停止为这次准入上报 |
| 传输失败                                                      | 原样重发同一请求                                             |

## 5. 派发者的改动

- **提交。** 开启上报且 Harness 声明了 `event-ingest/1` 时，全新 prompt 的提交请求带上 `eventDelivery: { "mode": "ingest", "turnId": "..." }`。
  - 全新提交指的是这样一次派发：Turn 还没有准入记录（`harness_event_epoch` 为空），并且 `submit` 成功。它包括新 Turn 的第一次派发，以及在任何准入被记录之前的重试，撤回提交标记之后的重新提交也在其中。
  - `submit` 返回 `hosted_prompt_recovery_required` 的不算，Turn 已经有 event epoch 之后的任何派发也不算。
  - 投递方式按每次准入决定，所以同一个 Turn 可以先走上报，恢复之后改为拉流。
- **准入与交接。** `recordAdmission` 增加一个交接版本，在同一事务中设置 `dispatch_owner = 'harness:' + bootId` 和 `dispatch_lease_until = now + lease`。派发者先停掉自己的续租再交接，然后不接流直接返回。`coordinate` 的 `finally` 里的 `releaseTurnLease` 此时什么也匹配不到。记录准入时 Turn 已是 `CANCELLING` 的，不做交接：派发者继续走现有的 cancel 路径，Harness 的上报会得到 `not_owner`。
- **保持不变的路径。** 恢复准入、续跑、cancel 和 recovery blocked 的观察通道，都像现在一样拉流，这些 Turn 仍由派发者持有。
- **cancel 收回。** `findDispatchable` 和 `claimTurn` 额外放行 `status = 'CANCELLING' AND dispatch_owner LIKE 'harness:%'`。认领者成为 owner，执行现有的 cancel 路径，包括 `cancelOriginalTurn` 和拉流。游标是共用的，所以收回时事件既不丢失也不重复。
- **租约过期。** Harness 持有的租约过期后，就是一个普通的过期租约：扫描认领该 Turn，之后由现有的 attach、接管和恢复准入处理。

## 6. Harness 的改动

- **能力。** contract 的 features 加入 `event-ingest/1`。池仍要求成员的 features 完全一致。
- **上报器。** 每个 Session 一个上报器，在存在上报准入时运行。
  - 复用事件路由的 `eventEnvelope` 投影和 `streamedDeltaIds` 初始化，按同样的 250 毫秒节奏从游标调用 `authority.readEvents`。
  - 从准入的 `lastEventId` 开始。
  - 通过 Session Store 客户端新增的 `ingestEvents` 方法发送。
  - 收到终态确认、`not_owner`、writer 校验拒绝，或结束标记被确认后停止。
- **停靠。** 确认 seal 之后、释放 placement 之前（#18404），上报器先补发到已提交序号，再带上已 seal 实例发送 `end: "parked"`。如果失败，挂起照常继续，租约过期后走现有的恢复。
- **recovery block。** 条件与 Java 现在轮询的相同：该 Turn 没有活跃 prompt、`recoveryBlocked` 为真、游标已到已提交序号。条件满足时，上报器发送 `end: "recovery_blocked"`。

## 7. 兼容与上线

| 控制面             | Harness                 | 行为                                |
| ------------------ | ----------------------- | ----------------------------------- |
| 开关关闭，任意版本 | 任意                    | 拉流，与现在相同                    |
| 开关打开           | 未声明 `event-ingest/1` | 拉流，与现在相同                    |
| 开关打开           | 声明 `event-ingest/1`   | 全新提交走上报，§5 列出的路径仍拉流 |

- **开启。** 所有控制面实例都提供上报路由之后，才能打开开关。
- **关闭。** 关闭开关只影响新的准入。Harness 持有的 Turn 继续通过上报结束，路由一直保留。
- **二进制回退。** 等 Harness 持有的 Turn 排空后，再回退控制面二进制。若还有未结束的，它的上报会失败、租约随之过期，该 Turn 走现有路径恢复，代价是一次恢复。
- **Harness 回退。** 没有该 feature 的 Harness 永远不会收到 `eventDelivery`。

## 8. 故障与竞争语义

| 窗口                               | 要求的结果                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| 准入记录前 Harness 就开始上报      | 返回 `not_ready`，Harness 重试，交接后被接受                                                  |
| 提交后确认丢失                     | 重发被直接确认、不写入，或只写入其中尚未记录的尾部                                            |
| 请求乱序到达                       | 越过前一个请求先到达的请求得到 `cursor_mismatch`，Harness 从已提交游标重发                    |
| 一个请求中途失败                   | 已提交的前缀保留，重发的请求只写入剩余部分                                                    |
| 交接后准入该 Turn 的 Java 实例死掉 | 没有影响，下一个请求由任一实例处理                                                            |
| Harness 死掉或停止上报             | 租约在 60 秒内过期，扫描像现在一样恢复该 Turn。接管本来就要等 60 秒的 writer lease。          |
| 上报期间 cancel                    | CANCELLING 通道收回该 Turn，Harness 的下一个请求得到 `not_owner`                              |
| 接管后的过期 Harness               | 被 writer 校验拒绝，或被 `dispatch_owner` CAS 拒绝                                            |
| 停靠标记丢失                       | 租约过期，由现有恢复处理这个已 seal 但未停靠的 Turn，与派发者在流结束后、停靠前死掉的情况相同 |
| 发送结束标记时游标未到已提交序号   | 标记被拒。Harness 补发后重试，或等租约过期。                                                  |

## 9. 涉及的文件

### 控制面

- `server/.../api/ManagedSessionStoreController.java`：`events:ingest` 路由。
- `persistence/.../JournalWriterLifecycle.java`、`JdbcManagedSessionStore.java`：上报认证，分存活和干净 seal 两种情况。
- `persistence/.../AgentTurnExecution.java`：准入交接，`findDispatchable` 与 `claimTurn` 中 CANCELLING 收回的条件，以及无事件时推进游标。
- `control-plane/.../HarnessCoordinator.java`：全新提交时请求上报并交接。`consumeStream` 中逐个 envelope 的逻辑移到一个共用类，供拉流和上报处理共同使用。
- `adapters/.../QwenHostedHarnessConnector.java`、`contracts/.../HarnessConnector.java`：submit 携带 `eventDelivery`，以及 feature 检测。
- `ManagedAgentProperties.java`、`application.yml`：`qwen.managed-agent.event-ingest.enabled`（默认 `false`）。

### Harness 与 Store 客户端

- `packages/core/src/managed-runtime/http-managed-session-store.ts`：`ingestEvents`。
- `packages/cli/src/serve/hosted-harness-contract.ts`：`event-ingest/1`。
- `packages/cli/src/serve/hosted-harness-session/turn.ts`：接受 `eventDelivery`。
- `packages/cli/src/serve/hosted-harness-session/event-ingest.ts`（新增）：上报器。`observation-routes.ts` 导出 envelope 投影。
- `packages/cli/src/serve/hosted-harness-session/session-suspension.ts` 与 Action 停靠流程：在 seal 和释放之间发送 `parked` 标记。

### 测试

- Java：上报认证，包括被取代的 writer、错误的 boot 和干净 seal 分支；游标、重试、缺口和中途失败；与 `recordHarnessEvents` 的一致性，覆盖增量、撤回、有范围撤回和终态；交接和收回的 CAS；租约过期触发恢复。H2 与 MySQL 8.4 都要覆盖。
- TypeScript：上报节奏、心跳、§4 的回复表、停靠标记与 seal 和释放的先后顺序，以及 recovery block 的条件。
- 真实进程：两个 Java 实例、一个 Harness，跑在 MySQL 8.4 上（§10）。

## 10. 验证计划

分三步交付，前两步在生产环境中不生效：

1. **Java 路由。** 上报路由和处理逻辑，没有任何地方请求上报，用直接构造的请求测试。
2. **Harness 上报器。** 上报器、`ingestEvents` 和结束标记。只在收到 `eventDelivery` 时启动，因此在第 3 步之前不生效。
3. **启用。** 开关、提交字段、交接、cancel 收回，以及下面的真实进程场景。

真实进程场景，两个 Java 实例共用一个 Store 地址，Harness 跑在 MySQL 8.4 上：

- 用相同的脚本化 Turn，分别走上报和拉流。Turn 包含增量、一次撤回、工具调用和终态。对比公开事件，序号和时间戳除外。
- 在 Turn 中途杀掉准入它的 Java 实例，在另一个实例上从最后的公开游标重连 SSE。文本增量、撤回和唯一的终态都须一致，且没有重新接流。
- 让两个请求乱序到达、在提交后丢掉确认、在 journal 已提交但尚未上报时终止 Harness，然后按上面的方式对比。
- 在 Turn 中途杀掉 Harness。租约过期，Turn 像现在一样通过接管恢复。
- cancel 一个 Harness 持有的 Turn。收回后它只结算一次。
- 让一个 Turn 因 Action 停靠，然后批准它；再构造一次 recovery block。两者都与拉流路径对比。
- 在相同负载下，测量上报请求速率、锁等待和首个可见文本的延迟，与拉流对比。

在模块预算内运行有针对性的 Java 和 TypeScript 测试。根目录的 build 和 typecheck 必须通过，完整的测试 profile 交给 CI。

## 11. 验收标准

- 开关关闭，或 Harness 没有该 feature 时，行为与现在逐字节一致。
- 对同一份 journal，上报与拉流产生相同的公开事件、撤回和终态结算。
- 交接之后，没有 Java 实例为该 Turn 持有 Harness 事件流；杀掉准入它的实例不会中断它。
- 一个 Turn 永远不会被两条路径同时写入。收回之后、租约过期之后，以及任何过期的上报，Harness 的写入都会被 `dispatch_owner` CAS 拒绝。
- 死掉的 Harness 在现有租约上限内、经现有恢复路径恢复。
- cancel、Action 停靠和 recovery block 保持现有结果，并且只结算一次。
- 不引入 schema 迁移、公开路由或投影改动。

## 12. 风险与开放问题

1. **请求速率。** 每个运行中的 Turn 在产生事件期间约每 250 毫秒一次请求，另加每 20 秒一次心跳。心跳取代了派发者的续租。默认开启前要与拉流对比测量。
2. **两组锁。** Store 认证会锁 placement guard、Session 根和 head；写入调用保持 Session 根、事件流、Turn 的顺序。认证必须在写入前完成，或者保持同样以 Session 根为先的顺序（[锁简化](2026-11-02-managed-agent-lock-simplification.zh-CN.md)）。
3. **已 seal 实例的标记。** `parked` 是唯一接受已 seal 实例的请求。Harness 必须在释放 placement 之前发送它；实现时还要确认 seal 不会在最后一次补发之后再追加 journal 事件。
4. **上报的范围。** 恢复准入和续跑仍然拉流，批准 Action 后的续跑也在其中。拉模型调度会取代它们，因为认领工作的 Harness 同时也投递其事件。
5. **时钟。** Turn 租约仍使用各 Java 实例的时钟（#14248），上报既不修复也不加重这个问题。
6. **Store 地址。** 杀掉 Java 的场景需要一个在单个实例死掉后仍可用的 Store 地址。参考 chart 在 Java 所在的 Pod 里以 loopback 提供 Store，所以杀掉那个 Java 实例，也会让同一 Pod 里的 Harness 连不上 Store。
