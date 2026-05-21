# SSE Event Bus & Backpressure (English)

## Overview

`EventBus` (`packages/acp-bridge/src/eventBus.ts`) is the per-session in-memory pub/sub that feeds the daemon's `GET /session/:id/events` SSE route. It assigns each event a monotonic id, buffers recent events in a bounded ring for `Last-Event-ID` replay, fans publishes out to all subscribers, applies per-subscriber backpressure (warning at 75% queue fill, eviction at the cap), and emits two synthetic terminal frames (`client_evicted`, `slow_client_warning`) that the SDK treats as first-class events but the bus marks **without an `id`** so they don't burn a slot in the per-session sequence.

`EventBus` is currently package-private to `acp-bridge` and consumed by the bridge factory through one closed-over instance per session. A future refactor (called out at line 150–159 of `eventBus.ts`) will lift it to a top-level building block so channels, dual-output, and future WebSocket transports can subscribe through the same bus instead of running parallel streams.

## Responsibilities

- Assign per-session monotonic event ids starting at 1.
- Buffer the last `ringSize` events for replay on subscribe-with-`lastEventId`.
- Fan publishes out to ≤ `maxSubscribers` concurrent subscribers.
- Apply per-subscriber bounded queues; drop overflowing subscribers with a synthetic `client_evicted` terminal frame.
- Emit `slow_client_warning` once per overflow episode at 75% queue fill, with 37.5% hysteresis to prevent flap-spam.
- Tear subscriptions down promptly on `AbortSignal.abort()`.
- Cleanly close every subscriber on bus close (e.g. session teardown).
- Never throw from `publish` (the contract is "publish is always safe to call").

## Architecture

| Constant | Value | Purpose |
|---|---|---|
| `EVENT_SCHEMA_VERSION` | `1` | Stamped on every `BridgeEvent.v`; bumped on breaking frame changes. |
| `DEFAULT_RING_SIZE` | `8000` | Per-session replay ring. Operator override via `--event-ring-size`. |
| `DEFAULT_MAX_QUEUED` | `256` | Per-subscriber backlog cap. |
| `DEFAULT_MAX_SUBSCRIBERS` | `64` | Per-session subscriber cap. |
| `WARN_THRESHOLD_RATIO` | `0.75` | `slow_client_warning` trigger fraction of `maxQueued`. |
| `WARN_RESET_RATIO` | `0.375` | Hysteresis re-arm fraction. |
| `MAX_EVENT_RING_SIZE` (in `bridge.ts`) | `1_000_000` | Soft upper bound on `BridgeOptions.eventRingSize` to catch typo OOMs. |

### `BridgeEvent`

```ts
interface BridgeEvent {
  id?: number;                  // monotonic per session; absent on synthetic terminal frames
  v: 1;                          // EVENT_SCHEMA_VERSION
  type: string;                  // one of the 29 known types or future-extensible
  data: unknown;                 // payload (typed per-type by the SDK; see 09-event-schema.md)
  originatorClientId?: string;   // set when the event derives from a clientId-stamped request
}
```

### `SubscribeOptions`

```ts
interface SubscribeOptions {
  lastEventId?: number;   // replay from after this id (Last-Event-ID resume)
  signal?: AbortSignal;   // aborts the subscription promptly
  maxQueued?: number;     // per-subscriber backlog cap; default 256
}
```

`subscribe()` returns an `AsyncIterable<BridgeEvent>`. The SSE route consumes it with `for await`. Registration is **synchronous** — by the time `subscribe()` returns, the subscriber is already attached, so a `publish()` that races with the consumer's first `next()` is still delivered.

### `BoundedAsyncQueue`

The per-subscriber queue. Two pivotal behaviors:

- **Live cap is on LIVE items only.** Items inserted via `forcePush()` carry a `forced: true` tag per entry and never count toward `maxSize`. This lets the `Last-Event-ID` replay path force-push hundreds of historical frames into a fresh subscriber without immediately tripping the live cap and evicting the just-resumed subscriber.
- **`liveCount` is maintained as a field**, not derived from `forcedInBuf` position. The earlier position-based heuristic broke when `slow_client_warning` started force-pushing mid-stream (warnings go to the BACK of the queue, not the front like replays). Per-entry `forced` tags are position-independent.

`push(value)` returns `false` (instead of blocking or throwing) when the LIVE backlog is at the cap — the bus uses that signal to evict the subscriber. `forcePush(value)` bypasses the cap. `close({drain?: boolean})` drains pending items by default; abort-path passes `drain: false` to drop them immediately.

## Workflow

### Publish

```mermaid
flowchart TD
    P["publish({type, data, originatorClientId?})"] --> C{"bus closed?"}
    C -->|yes| RU["return undefined"]
    C -->|no| AID["assign id = nextId++, v = 1"]
    AID --> PR["push to ring (shift if &gt; ringSize)"]
    PR --> FAN["snapshot subscribers, for each sub:"]
    FAN --> EVCK{"sub.evicted?"}
    EVCK -->|yes| NEXT[next subscriber]
    EVCK -->|no| PUSH["sub.queue.push(event)"]
    PUSH --> OK{"accepted?"}
    OK -->|no| EVICT["mark evicted; force-push client_evicted; queue.close; sub.dispose"]
    OK -->|yes| WARN{"!warned && liveSize &gt;= warnThreshold?"}
    WARN -->|yes| FW["force-push slow_client_warning; warned = true"]
    WARN -->|no| RES{"warned && liveSize &lt;= warnResetThreshold?"}
    RES -->|yes| RA["warned = false (hysteresis re-arm)"]
    RES -->|no| NEXT
```

`publish` never throws. Closing the bus mid-publish (the shutdown path closes per-session buses before awaiting `channel.kill()`) returns `undefined` rather than throwing because the agent may still emit `sessionUpdate` notifications in the small window between bus close and channel kill.

### Subscribe + replay (with ring-eviction detection)

```mermaid
sequenceDiagram
    autonumber
    participant SR as SSE route
    participant EB as EventBus
    participant Q as BoundedAsyncQueue

    SR->>EB: subscribe({lastEventId: 42, maxQueued: 256, signal})
    EB->>EB: refuse if subs.size >= maxSubscribers<br/>(throws SubscriberLimitExceededError)
    EB->>Q: new BoundedAsyncQueue(256)
    EB->>EB: subs.add(sub)
    EB->>EB: earliestInRing = ring[0]?.id
    alt earliestInRing > lastEventId + 1 (gap evicted)
        EB->>Q: forcePush state_resync_required<br/>{ reason: 'ring_evicted', lastDeliveredId: 42, earliestAvailableId: earliestInRing }
        Note over EB,Q: id-less synthetic, frame goes BEFORE replay.<br/>Stream stays open; SDK reducer flips awaitingResync.
    end
    loop ring scan
        EB->>EB: for e in ring where e.id > 42
        EB->>Q: forcePush(e)
    end
    EB->>EB: attach AbortSignal listener<br/>(onAbort → queue.close({drain:false}); dispose)
    EB-->>SR: AsyncIterable
    SR->>Q: next() in for-await loop
```

If `subs.size >= maxSubscribers` at subscribe time, `SubscriberLimitExceededError` is thrown — the SSE route catches it and serializes a `stream_error` synthetic frame to the rejected client so they don't see a silent empty stream. Returning an empty iterable instead would leave oncall blind to "some clients get events, some don't" under load.

### Ring-eviction → `state_resync_required` (the recovery flow)

When a consumer reconnects with `Last-Event-ID: N` and the ring's earliest surviving event has `id > N + 1`, the events in `[N+1, earliestInRing-1]` were evicted before the consumer reconnected. The naïve replay would silently succeed with a non-contiguous suffix, the SDK reducer would keep applying deltas as if the stream were contiguous, and its state would diverge from the daemon's truth — with no terminal signal.

Implemented at `packages/acp-bridge/src/eventBus.ts:359-402`:

1. Compute `earliestInRing = this.ring[0]?.id`.
2. If `earliestInRing > opts.lastEventId + 1`, force-push a synthetic frame **before** the replay frames:
   ```jsonc
   {
     "v": 1,
     "type": "state_resync_required",
     "data": {
       "reason": "ring_evicted",
       "lastDeliveredId": <opts.lastEventId>,
       "earliestAvailableId": <earliestInRing>
     }
   }
   ```
3. Continue the normal replay loop afterwards.

Critical contracts (and what the wenshao #4360 review corrected):

- **NO `id`** — same no-burn pattern as `client_evicted`, so it doesn't occupy a slot in the per-session monotonic sequence other subscribers observe.
- **Stream stays OPEN** — unlike `client_evicted` (genuinely terminal), `state_resync_required` is recovery-oriented. Replay + live frames continue flowing afterward.
- **Reducer auto-skips deltas** — the SDK side flips `awaitingResync = true` and only applies `state_resync_required` itself + the four terminal frames (`session_died`, `session_closed`, `client_evicted`, `stream_error`) until consumer code calls `loadSession` and clears the flag. See [`09-event-schema.md`](./09-event-schema.md) for `RESYNC_PASSTHROUGH_TYPES`.
- **Network-friendly** — frames stay on the wire so the SDK can compute a "what you missed" diff later if it wants to. No extra reconnect cycle is required.

### Eviction terminal flow

When a subscriber's live backlog has been at `maxQueued` and the next `push()` returns `false`:
1. Mark `sub.evicted = true`.
2. Construct `client_evicted` frame **without `id`** — `{ v: 1, type: 'client_evicted', data: { reason: 'queue_overflow', droppedAfter: <last delivered id> } }`.
3. `queue.forcePush(evictionFrame)` so the consumer iterator sees one terminal frame.
4. `queue.close()` so iteration unwinds after the terminal frame.
5. Call `sub.dispose()` — removes from `subs` AND detaches the `AbortSignal` listener (the **BmJT1 fix**: without this, stalled consumers' closures stay live until `AbortSignal` GC).

### Abort flow

`AbortSignal.abort()` → `onAbort()`:
1. `queue.close({drain: false})` — drop buffered items so the SSE route doesn't keep serializing events to a socket nobody is listening to.
2. `dispose()` — idempotent through a `disposed` flag.

Already-aborted signals at subscribe time call `onAbort()` synchronously before returning the iterator.

## State & Lifecycle

- `nextId` starts at 1 and only ever increments. `lastEventId` getter returns `nextId - 1`.
- `ring` is bounded; eviction-by-shift is O(n) once full. At `ringSize=8000` that measures in low milliseconds on chatty sessions — well below per-frame latency budget. A circular-buffer refactor is deferred until profiling actually flags it or operators bump `--event-ring-size` an order of magnitude.
- `close()` flips `closed`, closes every subscriber's queue, and clears `subs`. Subsequent `publish()` / `subscribe()` are no-ops (`publish` returns undefined; `subscribe` returns `emptyAsyncIterable`).
- Each session owns one `EventBus`. Bus close happens before `channel.kill()` so in-flight publishes during shutdown return undefined rather than throwing.

## Dependencies

- Consumed by `packages/acp-bridge/src/bridge.ts` (`BridgeClient.sessionUpdate` / `BridgeClient.extNotification` → `events.publish(...)`).
- Consumed by `packages/cli/src/serve/server.ts` (SSE route handler → `events.subscribe(...)` then formats `BridgeEvent` to SSE wire frames).
- Re-export shim: `packages/cli/src/serve/eventBus.ts` → `@qwen-code/acp-bridge/eventBus`.
- SDK consumer: `packages/sdk-typescript/src/daemon/sse.ts` (`parseSseStream`), then `narrowDaemonEvent` (see [`09-event-schema.md`](./09-event-schema.md), [`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md)).

## Configuration

- `--event-ring-size <n>` — per-session ring depth; soft-capped at `MAX_EVENT_RING_SIZE = 1_000_000`.
- Subscriber `?maxQueued=N` query parameter on `GET /session/:id/events`, range `[16, 2048]`. SDK clients pre-flight `caps.features.slow_client_warning` before opting in.
- `BridgeOptions.eventRingSize` (overrides daemon default for embedded usage).
- Capability tags: `session_events`, `slow_client_warning`, `typed_event_schema`.

## Caveats & Known Limits

- **Synthetic frames have no `id`.** SDK consumers using `Last-Event-ID` resume must not assume contiguity — gaps in the live stream that look like "events 3, 5, 6" with the 4 missing are normal when `slow_client_warning` or `client_evicted` was force-pushed in between (those frames are private to the subscriber that received them).
- `client_evicted` is **per-subscriber**, not per-session. The same client can reconnect.
- `BoundedAsyncQueue` iterator is **not safe for concurrent drivers** — two simultaneous `.next()` calls would race for the same event. Daemon usage is sequential (`for await ... of` in the SSE route handler), so this is safe in production.
- The bus is currently package-private; channels and webui that want to subscribe must do so through the daemon's HTTP SSE route, not by reaching into the bus directly. Stage 1.5 lifts this.

## References

- `packages/acp-bridge/src/eventBus.ts` (entire file)
- `packages/acp-bridge/src/bridge.ts` (publish sites, esp. `BridgeClient.sessionUpdate` and the F3 permission events)
- `packages/cli/src/serve/server.ts` (SSE route handler — formats `BridgeEvent` to wire SSE)
- `packages/sdk-typescript/src/daemon/sse.ts` (SSE wire parser on the client side)
- Wire reference: [`../qwen-serve-protocol.md`](../qwen-serve-protocol.md) (the `Last-Event-ID` reconnect contract).

---

# SSE 事件总线与反压 (中文)

## 概览

`EventBus`（`packages/acp-bridge/src/eventBus.ts`）是每 session 一份的内存 pub/sub，喂给 daemon 的 `GET /session/:id/events` SSE 路由。它给每个事件分配单调 id、用有界环形缓冲缓存最近事件给 `Last-Event-ID` 重放、把 publish 扇出到所有订阅者、对订阅者实施反压（队列 75% 满时发警告、达到上限时驱逐），还会合成两种终态帧（`client_evicted`、`slow_client_warning`），SDK 把它们当一等事件，但 bus 故意**不**给它们分配 `id`，防止它们占掉本 session 的序列号让其他订阅者看到断档。

`EventBus` 目前是 `acp-bridge` 包内部的实现，bridge 工厂为每 session 闭包持有一份。未来 refactor（文件 line 150–159 提到）会把它升到顶层组件，channels、dual-output 以及未来 WebSocket 传输都能通过同一 bus 订阅，而不必各跑一条并行流。

## 职责

- 给每 session 分配单调事件 id（从 1 起）。
- 在环形缓冲缓存最近 `ringSize` 个事件，供 `lastEventId` 重放。
- 把 publish 扇出到至多 `maxSubscribers` 个订阅者。
- 每订阅者用有界队列；超过上限的订阅者收一个合成终态帧 `client_evicted` 后被关掉。
- 队列 75% 满时合成 `slow_client_warning` —— 每个 overflow episode 只发一次，37.5% 滞回重新装填。
- `AbortSignal.abort()` 触发后及时拆订阅。
- bus close 时（session 拆除）干净地关闭所有订阅者。
- `publish` 永远不抛（合约：调 `publish` 永远安全）。

## 架构

| 常量 | 值 | 用途 |
|---|---|---|
| `EVENT_SCHEMA_VERSION` | `1` | 每帧 `v`；frame 形状破坏性改动时 bump |
| `DEFAULT_RING_SIZE` | `8000` | per-session 重放环；operator 通过 `--event-ring-size` 覆盖 |
| `DEFAULT_MAX_QUEUED` | `256` | per-subscriber 队列上限 |
| `DEFAULT_MAX_SUBSCRIBERS` | `64` | per-session 订阅者上限 |
| `WARN_THRESHOLD_RATIO` | `0.75` | 触发 `slow_client_warning` 的占比 |
| `WARN_RESET_RATIO` | `0.375` | 滞回重置占比 |
| `MAX_EVENT_RING_SIZE`（在 `bridge.ts`） | `1_000_000` | `BridgeOptions.eventRingSize` 软上限，挡打错值 OOM |

### `BridgeEvent`

```ts
interface BridgeEvent {
  id?: number;                  // per session 单调；合成终态帧无 id
  v: 1;                          // EVENT_SCHEMA_VERSION
  type: string;                  // 29 已知 type 之一或未来扩展
  data: unknown;                 // payload，SDK 按 type typed（详见 09）
  originatorClientId?: string;   // 由带 clientId 的请求派生
}
```

### `SubscribeOptions`

```ts
interface SubscribeOptions {
  lastEventId?: number;   // 从该 id 之后重放（Last-Event-ID 重连）
  signal?: AbortSignal;   // 及时拆订阅
  maxQueued?: number;     // per-subscriber 队列上限；默认 256
}
```

`subscribe()` 返回 `AsyncIterable<BridgeEvent>`。SSE 路由用 `for await` 消费。注册是**同步**的 —— `subscribe()` 返回时订阅者已经挂上，所以与消费者第一次 `next()` race 的 `publish()` 仍会被投递。

### `BoundedAsyncQueue`

每订阅者的队列，两个关键行为：

- **上限只算 LIVE 项**。`forcePush()` 进的项每条带 `forced: true` 标签，不计入 `maxSize`。这让 `Last-Event-ID` 重放可以强推数百历史帧到新订阅者而不会立刻撞到 live 上限把刚 resume 的订阅者驱逐。
- **`liveCount` 是字段**，不是由 `forcedInBuf` 位置推导的。之前位置推导在 `slow_client_warning` 开始 mid-stream 强推（推到队尾，不是像 replay 那样推到队头）后就坏了；每条 `forced` 标签位置无关。

`push(value)` 在 LIVE 上限时返回 `false`（既不阻塞也不抛），bus 据此驱逐订阅者。`forcePush(value)` 绕过上限。`close({drain?: boolean})` 默认 drain 已有项；abort 路径用 `drain: false` 直接丢弃。

## 流程

### Publish

> 见英文版「Publish」flowchart。

`publish` 永远不抛。关闭 bus 之中 publish（shutdown 路径在 await `channel.kill()` 前关每个 session 的 bus）返回 `undefined` 而不是抛，因为 agent 在 bus close 与 channel kill 之间的窗口里还可能发 `sessionUpdate` 通知。

### Subscribe + replay（带环驱逐检测）

> 见英文版「Subscribe + replay (with ring-eviction detection)」时序图。

subscribe 时 `subs.size >= maxSubscribers` 抛 `SubscriberLimitExceededError`，SSE 路由捕获并给被拒客户端序列化一个 `stream_error` 合成帧，免得他们看到一片空。返回空 iterable 会让 oncall 在高负载下分不清「有的客户端收到了，有的没收到」。

### 环驱逐 → `state_resync_required`（恢复流）

当消费方带 `Last-Event-ID: N` 重连，但环里最早留存事件的 `id > N + 1`，说明 `[N+1, earliestInRing-1]` 这段在重连前被 evict 了。朴素重放会默默成功但拿到一个非连续后缀，SDK reducer 当作连续流继续 apply delta，状态就与 daemon 真相分叉 —— 全程没有终态信号。

实现在 `packages/acp-bridge/src/eventBus.ts:359-402`：

1. 算 `earliestInRing = this.ring[0]?.id`。
2. 若 `earliestInRing > opts.lastEventId + 1`，在重放帧**之前**强推一帧合成：
   ```jsonc
   {
     "v": 1,
     "type": "state_resync_required",
     "data": {
       "reason": "ring_evicted",
       "lastDeliveredId": <opts.lastEventId>,
       "earliestAvailableId": <earliestInRing>
     }
   }
   ```
3. 之后照常做重放循环。

关键契约（以及 wenshao #4360 review 修正过的几点）：

- **无 `id`** —— 与 `client_evicted` 同样的「不占位」模式，不会占掉 per-session 单调序列号让其他订阅者看到断档。
- **流保持打开** —— 不同于 `client_evicted`（真终态），`state_resync_required` 面向恢复。重放和 live 帧继续。
- **reducer 自动跳过 delta** —— SDK 端 `awaitingResync = true`，只放行 `state_resync_required` 本身加四个终态帧（`session_died`、`session_closed`、`client_evicted`、`stream_error`），直到调用方调 `loadSession` 清掉标志。详见 [`09-event-schema.md`](./09-event-schema.md) 的 `RESYNC_PASSTHROUGH_TYPES`。
- **省网络** —— 帧仍然走线，SDK 之后可以计算「漏了什么」的 diff，不需要额外重连一次。

### 驱逐终态

订阅者 LIVE 队列已到 `maxQueued`，再来一次 `push()` 返回 `false`：
1. 标 `sub.evicted = true`。
2. 构造 `client_evicted` 帧，**无 `id`** —— `{ v: 1, type: 'client_evicted', data: { reason: 'queue_overflow', droppedAfter: <最后投递的 id> } }`。
3. `queue.forcePush(evictionFrame)` 让消费者 iterator 看到一个终态帧。
4. `queue.close()` 让 iterator 在终态帧后 unwind。
5. `sub.dispose()` —— 从 `subs` 移除**并且**解绑 `AbortSignal` listener（**BmJT1 修复**：不这么做时，卡住的消费者闭包会一直存活到 `AbortSignal` 自己 GC）。

### Abort 流

`AbortSignal.abort()` → `onAbort()`：
1. `queue.close({drain: false})` —— 丢弃已缓冲项，免得 SSE 路由继续往没人看的 socket 序列化事件。
2. `dispose()` —— 通过 `disposed` 标志幂等。

subscribe 时已 abort 的 signal 会在返回 iterator 前同步调一次 `onAbort()`。

## 状态与生命周期

- `nextId` 从 1 起只增不减；`lastEventId` getter 返回 `nextId - 1`。
- `ring` 有界；满了之后 `shift` 是 O(n)。`ringSize=8000` 在聊天密集 session 上每次 publish 几毫秒，远低于 per-frame 延迟预算。circular-buffer refactor 推迟到 profiling 真的标出它，或 operator 把 `--event-ring-size` 提一个数量级时再做。
- `close()` 翻转 `closed`、关掉所有订阅者队列、清空 `subs`。之后 `publish()` / `subscribe()` 都是 no-op（`publish` 返 undefined，`subscribe` 返 `emptyAsyncIterable`）。
- 每 session 一个 `EventBus`。bus close 发生在 `channel.kill()` 之前，shutdown 中飞行的 publish 返 undefined 而不抛。

## 依赖

- 被 `packages/acp-bridge/src/bridge.ts` 消费（`BridgeClient.sessionUpdate` / `extNotification` → `events.publish(...)`）。
- 被 `packages/cli/src/serve/server.ts` 消费（SSE 路由 → `events.subscribe(...)`，再把 `BridgeEvent` 序列化为 SSE wire）。
- re-export shim：`packages/cli/src/serve/eventBus.ts` → `@qwen-code/acp-bridge/eventBus`。
- SDK 消费方：`packages/sdk-typescript/src/daemon/sse.ts`（`parseSseStream`），之后接 `narrowDaemonEvent`（详见 [`09-event-schema.md`](./09-event-schema.md)、[`13-sdk-daemon-client.md`](./13-sdk-daemon-client.md)）。

## 配置

- `--event-ring-size <n>` — per-session 环深度，软上限 `MAX_EVENT_RING_SIZE = 1_000_000`。
- `GET /session/:id/events` 上的 `?maxQueued=N` query 参数，范围 `[16, 2048]`，SDK 在 opt-in 前 pre-flight `caps.features.slow_client_warning`。
- `BridgeOptions.eventRingSize`（嵌入用例覆盖 daemon 默认）。
- 能力 tag：`session_events`、`slow_client_warning`、`typed_event_schema`。

## 注意 & 已知局限

- **合成帧无 `id`**。SDK 用 `Last-Event-ID` 重连时不能假设序号连续 —— live 流里看到 「事件 3、5、6，缺 4」是正常的（如果 4 是当时强推给该订阅者的 `slow_client_warning` 或 `client_evicted`，那帧是私有的）。
- `client_evicted` 是 **per-subscriber** 不是 per-session，同一客户端可以重连。
- `BoundedAsyncQueue` iterator **不支持并发驱动** —— 两次同时 `.next()` 会 race 同一事件。生产环境是顺序消费（SSE 路由的 `for await`），安全。
- bus 目前包私有；channels 和 webui 想订阅必须走 daemon HTTP SSE 路由，不能直接 reach 进 bus。Stage 1.5 会把它升到顶层。

## 参考

- `packages/acp-bridge/src/eventBus.ts`（整文件）
- `packages/acp-bridge/src/bridge.ts`（publish 站点，特别是 `BridgeClient.sessionUpdate` 和 F3 权限事件）
- `packages/cli/src/serve/server.ts`（SSE 路由 handler — 把 `BridgeEvent` 序列化为 wire SSE）
- `packages/sdk-typescript/src/daemon/sse.ts`（客户端 SSE wire 解析器）
- wire 参考：[`../qwen-serve-protocol.md`](../qwen-serve-protocol.md)（`Last-Event-ID` 重连合约）。
