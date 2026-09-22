// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/eventBus.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";

// packages/acp-bridge/src/replay-summary.ts
init_esbuild_shims();
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
__name(record, "record");
function isSummaryReplayEvent(event) {
  if (event.type !== "session_update") return true;
  const data = record(event.data);
  const update = record(data?.["update"]) ?? data;
  const meta = record(update?.["_meta"]);
  if ((update?.["sessionUpdate"] === "tool_call" || update?.["sessionUpdate"] === "tool_call_update") && update["status"] === "in_progress" && typeof update["kind"] !== "string" && (meta?.["shellProgress"] !== void 0 || meta?.["subagentProgress"] === true))
    return false;
  const parent = meta?.["parentToolCallId"];
  return typeof parent !== "string" || parent.length === 0 || parent === update?.["toolCallId"];
}
__name(isSummaryReplayEvent, "isSummaryReplayEvent");
function summarizeReplayEvent(event) {
  if (!isSummaryReplayEvent(event)) return void 0;
  if (event.type !== "session_update") return event;
  const data = record(event.data);
  const update = record(data?.["update"]) ?? data;
  if (!update) return event;
  const meta = record(update["_meta"]);
  let projected = update;
  if (update["sessionUpdate"] === "tool_call" || update["sessionUpdate"] === "tool_call_update") {
    const output = record(update["rawOutput"]);
    const agent = output?.["type"] === "task_execution" || meta?.["toolName"] === "agent" || meta?.["toolName"] === "task";
    if (agent) {
      if (output) {
        const status = output["status"] ?? update["status"];
        const settled = status === "completed" || status === "failed" || status === "cancelled";
        const {
          toolCalls: _toolCalls,
          taskPrompt: _taskPrompt,
          tokenCount: _tokenCount,
          ...summary
        } = output;
        const executionSummary = record(summary["executionSummary"]);
        if (!settled && executionSummary) {
          const {
            inputTokens: _inputTokens,
            outputTokens: _outputTokens,
            thoughtTokens: _thoughtTokens,
            cachedTokens: _cachedTokens,
            totalTokens: _totalTokens,
            ...stats
          } = executionSummary;
          summary["executionSummary"] = stats;
        }
        projected = {
          ...projected,
          rawOutput: {
            ...summary,
            ...settled && _tokenCount !== void 0 ? { tokenCount: _tokenCount } : {}
          }
        };
      }
      const input = record(update["rawInput"]);
      if (input && "prompt" in input) {
        const { prompt: _prompt, ...summary } = input;
        projected = { ...projected, rawInput: summary };
      }
    }
  }
  return projected === update ? event : {
    ...event,
    data: record(data?.["update"]) ? { ...data, update: projected } : projected
  };
}
__name(summarizeReplayEvent, "summarizeReplayEvent");
function summarizeReplay(events) {
  return events.flatMap((event) => {
    const projected = summarizeReplayEvent(event);
    return projected ? [projected] : [];
  });
}
__name(summarizeReplay, "summarizeReplay");

// packages/acp-bridge/src/eventBus.ts
var EVENT_SCHEMA_VERSION = 1;
var DEFAULT_MAX_QUEUED = 256;
var DEFAULT_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
var DEFAULT_REPLAY_BUDGET_BYTES = 4 * DEFAULT_MAX_QUEUED_BYTES;
var DEFAULT_RING_SIZE = 8e3;
var WARN_THRESHOLD_RATIO = 0.75;
var WARN_RESET_RATIO = 0.375;
var DEFAULT_MAX_SUBSCRIBERS = 64;
function getServerTimestamp(meta) {
  const existing = meta?.["serverTimestamp"];
  return typeof existing === "number" && Number.isFinite(existing) ? existing : Date.now();
}
__name(getServerTimestamp, "getServerTimestamp");
function normalizeMaxQueuedBytes(value) {
  if (value === void 0) return DEFAULT_MAX_QUEUED_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maxQueuedBytes must be a positive safe integer");
  }
  return value;
}
__name(normalizeMaxQueuedBytes, "normalizeMaxQueuedBytes");
function normalizeReplayBudgetBytes(value) {
  if (value === void 0) return DEFAULT_REPLAY_BUDGET_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("replayBudgetBytes must be a positive safe integer");
  }
  return value;
}
__name(normalizeReplayBudgetBytes, "normalizeReplayBudgetBytes");
function serializedBridgeEventByteLength(event) {
  try {
    const serialized = JSON.stringify(event);
    if (serialized === void 0) return void 0;
    return Buffer.byteLength(serialized, "utf8");
  } catch {
    return void 0;
  }
}
__name(serializedBridgeEventByteLength, "serializedBridgeEventByteLength");
function logEventSizingFailed(type) {
  try {
    process.stderr.write(
      `qwen serve: EventBus event sizing failed ${JSON.stringify({ type })}
`
    );
  } catch {
  }
}
__name(logEventSizingFailed, "logEventSizingFailed");
function logSubscriberEvicted(data) {
  try {
    process.stderr.write(
      `qwen serve: EventBus subscriber evicted ${JSON.stringify(data)}
`
    );
  } catch {
  }
}
__name(logSubscriberEvicted, "logSubscriberEvicted");
function logSlowClientWarning(data) {
  try {
    process.stderr.write(
      `qwen serve: EventBus slow_client_warning ${JSON.stringify(data)}
`
    );
  } catch {
  }
}
__name(logSlowClientWarning, "logSlowClientWarning");
function subscriberDiagnosticHandled(sub, diagnostic) {
  try {
    return sub.onSubscriberDiagnostic?.(diagnostic) === true;
  } catch {
    return false;
  }
}
__name(subscriberDiagnosticHandled, "subscriberDiagnosticHandled");
var SubscriberLimitExceededError = class extends Error {
  static {
    __name(this, "SubscriberLimitExceededError");
  }
  limit;
  constructor(limit) {
    super(`EventBus subscriber limit reached (${limit})`);
    this.name = "SubscriberLimitExceededError";
    this.limit = limit;
  }
};
var EventBus = class {
  constructor(ringSize = DEFAULT_RING_SIZE, maxSubscribers = DEFAULT_MAX_SUBSCRIBERS, compactionEngine, opts = {}) {
    this.ringSize = ringSize;
    this.maxSubscribers = maxSubscribers;
    this.compactionEngine = compactionEngine;
    this.maxQueuedBytes = normalizeMaxQueuedBytes(opts.maxQueuedBytes);
    this.replayBudgetBytes = normalizeReplayBudgetBytes(opts.replayBudgetBytes);
    this.onCompactionError = opts.onCompactionError;
  }
  static {
    __name(this, "EventBus");
  }
  nextId = 1;
  /**
   * Identity token for this bus instance. Regenerated on every construction
   * (daemon restart / bus rebuild), never persisted — a cursor minted under
   * a different epoch is provably stale no matter its numeric value.
   */
  epoch = randomUUID();
  compactionDegraded = false;
  onCompactionError;
  ring = [];
  subs = /* @__PURE__ */ new Set();
  maxQueuedBytes;
  replayBudgetBytes;
  closed = false;
  snapshotReplay(liveReplayMode = "full") {
    const snapshot = this.compactionEngine?.snapshot(liveReplayMode);
    if (snapshot && this.compactionDegraded) {
      return { ...snapshot, degraded: true };
    }
    return snapshot;
  }
  /**
   * Events ingested since the last turn boundary (the boundary itself is
   * folded into the replay window), without flattening that window.
   * Undefined when no compaction engine is wired or it exposes no journal
   * snapshot.
   */
  liveJournalSnapshot(liveReplayMode = "full") {
    return this.compactionEngine?.liveJournalSnapshot?.(liveReplayMode);
  }
  /**
   * The engine's current live-journal caps — may have grown past the
   * configured baseline under adaptive growth. Read by the bridge's
   * growth policy to account granted headroom across its live sessions
   * and by daemon status for the per-session effective limits.
   */
  journalLimits() {
    return this.compactionEngine?.journalLimits?.();
  }
  /** The byte half of `journalLimits()`; the growth-policy hot path. */
  journalLimitBytes() {
    return this.journalLimits()?.maxBytes;
  }
  markCompactionDegraded(err) {
    if (this.compactionDegraded) return;
    this.compactionDegraded = true;
    try {
      this.onCompactionError?.(err);
    } catch {
    }
  }
  /** Most recent id ever assigned by `publish`. 0 if no events published. */
  get lastEventId() {
    return this.nextId - 1;
  }
  /** Snapshot of the live subscriber count. */
  get subscriberCount() {
    return this.subs.size;
  }
  seedReplayEvents(inputs) {
    if (this.closed) return [];
    if (inputs.length === 0) return [];
    const events = [];
    for (const input of inputs) {
      const existingMeta = input._meta;
      const event = {
        id: this.nextId++,
        v: EVENT_SCHEMA_VERSION,
        ...input,
        _meta: {
          ...existingMeta ?? {},
          serverTimestamp: getServerTimestamp(existingMeta)
        }
      };
      events.push(event);
    }
    try {
      this.compactionEngine?.seedReplayEvents(events);
    } catch (err) {
      this.markCompactionDegraded(err);
    }
    this.ring.length = 0;
    return events;
  }
  eventDetailMode = "full";
  setEventDetailMode(mode) {
    this.eventDetailMode = mode;
  }
  /**
   * Publish an event to the bus. Returns the constructed `BridgeEvent`
   * (with `id` + `v` assigned) on success, or `undefined` when the bus
   * is closed, the event is unserializable, or summary mode filters it.
   * Filtering is a normal no-op; rejected events do not consume an ID.
   *
   * **Never throws** (never-throws contract). Closed-bus and unserializable
   * events are handled as return-undefined no-ops;
   * subscriber-enqueue failures are caught internally and
   * translated to per-subscriber eviction. Call sites can rely on
   * this — the historical `try { publish(...) } catch {}` blocks in
   * `httpAcpBridge.ts` are defense-in-depth, not load-bearing, and
   * may be removed in a future cleanup pass without changing
   * behavior. Don't add new try/catch wrappers around `publish()`.
   */
  publish(input) {
    if (this.closed) return void 0;
    const existingMeta = input._meta;
    let event = {
      // Read WITHOUT incrementing: a rejected event must not burn an id —
      // other subscribers would see a sequence gap (3 → 5) that resume
      // logic misreads as ring eviction. `nextId` advances only after the
      // event has passed the serializability gate below.
      id: this.nextId,
      v: EVENT_SCHEMA_VERSION,
      ...input,
      _meta: {
        ...existingMeta ?? {},
        serverTimestamp: getServerTimestamp(existingMeta)
      }
    };
    if (this.eventDetailMode === "summary") {
      const projected = summarizeReplayEvent(event);
      if (!projected) return void 0;
      event = projected;
    }
    const eventBytes = serializedBridgeEventByteLength(event);
    if (eventBytes === void 0) {
      logEventSizingFailed(event.type);
      return void 0;
    }
    this.nextId += 1;
    this.ring.push(event);
    try {
      this.compactionEngine?.ingest(event, eventBytes);
    } catch (err) {
      this.markCompactionDegraded(err);
    }
    if (this.ring.length > this.ringSize) this.ring.shift();
    const getEventBytes = /* @__PURE__ */ __name(() => eventBytes, "getEventBytes");
    for (const sub of Array.from(this.subs)) {
      if (sub.evicted) continue;
      const pushResult = sub.queue.push(event, getEventBytes);
      if (!pushResult.ok) {
        sub.evicted = true;
        const evictionData = {
          reason: pushResult.reason,
          droppedAfter: event.id,
          queueSize: pushResult.liveSize,
          maxQueued: sub.maxQueued,
          queuedBytes: pushResult.liveBytes,
          maxQueuedBytes: sub.maxQueuedBytes,
          ...pushResult.reason === "queue_bytes_overflow" ? { eventBytes: pushResult.eventBytes } : {}
        };
        const evictionDiagnostic = {
          type: "client_evicted",
          data: {
            ...evictionData,
            triggerEventType: event.type,
            triggerEventBytes: eventBytes
          }
        };
        if (!subscriberDiagnosticHandled(sub, evictionDiagnostic)) {
          logSubscriberEvicted(evictionData);
        }
        const evictionFrame = {
          v: EVENT_SCHEMA_VERSION,
          type: "client_evicted",
          data: evictionData
        };
        sub.queue.forcePush(evictionFrame);
        sub.queue.close();
        sub.dispose();
        continue;
      }
      const liveSize = pushResult.liveSize;
      const liveBytes = pushResult.liveBytes;
      if (sub.warned && liveSize <= sub.warnResetThreshold && liveBytes <= sub.warnBytesResetThreshold) {
        sub.warned = false;
      }
      const frameThresholdReached = liveSize >= sub.warnThreshold;
      const byteThresholdReached = liveBytes >= sub.warnBytesThreshold;
      if (!sub.warned && (frameThresholdReached || byteThresholdReached)) {
        sub.warned = true;
        const threshold = frameThresholdReached && byteThresholdReached ? "frames_and_bytes" : byteThresholdReached ? "bytes" : "frames";
        const warningData = {
          queueSize: liveSize,
          maxQueued: sub.maxQueued,
          // `event.id` is always defined here — the just-published
          // `event` is constructed at the top of `publish()` with
          // `id: this.nextId++`. No `??` fallback needed.
          lastEventId: event.id,
          queuedBytes: liveBytes,
          maxQueuedBytes: sub.maxQueuedBytes,
          threshold
        };
        const warningDiagnostic = {
          type: "slow_client_warning",
          data: {
            ...warningData,
            triggerEventType: event.type,
            triggerEventBytes: eventBytes
          }
        };
        if (!subscriberDiagnosticHandled(sub, warningDiagnostic)) {
          logSlowClientWarning(warningData);
        }
        const warningFrame = {
          v: EVENT_SCHEMA_VERSION,
          type: "slow_client_warning",
          data: warningData
        };
        sub.queue.forcePush(warningFrame);
      }
    }
    return event;
  }
  /**
   * Note: registration is synchronous — by the time `subscribe()` returns,
   * the subscriber is already attached and will receive any subsequent
   * `publish()` even if the consumer hasn't started iterating yet. (A
   * generator-style implementation would defer registration to the first
   * `next()` call, which races with publishes that happen before the
   * consumer's first await.)
   *
   * The returned iterator is NOT safe to drive from concurrent callers —
   * two simultaneous `.next()` calls would race for the same event from
   * the underlying queue. Daemon usage is sequential (`for await ... of`
   * inside the SSE route), so this is safe in production. Callers that
   * fan an iterator out to multiple consumers must serialize themselves.
   */
  subscribe(opts = {}) {
    if (this.closed) {
      return emptyAsyncIterable();
    }
    if (this.subs.size >= this.maxSubscribers) {
      throw new SubscriberLimitExceededError(this.maxSubscribers);
    }
    const maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
    const queue = new BoundedAsyncQueue(
      maxQueued,
      this.maxQueuedBytes
    );
    const sub = {
      queue,
      evicted: false,
      maxQueued,
      warnThreshold: WARN_THRESHOLD_RATIO * maxQueued,
      warnResetThreshold: WARN_RESET_RATIO * maxQueued,
      maxQueuedBytes: this.maxQueuedBytes,
      warnBytesThreshold: WARN_THRESHOLD_RATIO * this.maxQueuedBytes,
      warnBytesResetThreshold: WARN_RESET_RATIO * this.maxQueuedBytes,
      warned: false,
      onSubscriberDiagnostic: opts.onSubscriberDiagnostic,
      dispose: /* @__PURE__ */ __name(() => {
      }, "dispose")
    };
    this.subs.add(sub);
    if (opts.lastEventId !== void 0) {
      const epochMismatch = opts.epoch !== void 0 && opts.epoch !== this.epoch;
      const epochReset = epochMismatch || opts.lastEventId >= this.nextId;
      if (epochReset) {
        queue.forcePush({
          v: EVENT_SCHEMA_VERSION,
          type: "state_resync_required",
          data: {
            reason: "epoch_reset",
            ...epochMismatch ? { detail: "epoch_mismatch" } : {},
            lastDeliveredId: opts.lastEventId,
            // Ring is typically empty right after a restart; fall back to
            // `nextId` (the first id this epoch will assign) so the field
            // stays meaningful ("fresh sequence starts here").
            earliestAvailableId: this.ring[0]?.id ?? this.nextId
          }
        });
      } else {
        const earliestInRing = this.ring[0]?.id;
        if (earliestInRing === void 0 && opts.lastEventId < this.nextId - 1) {
          queue.forcePush({
            v: EVENT_SCHEMA_VERSION,
            type: "state_resync_required",
            data: {
              reason: "seeded_replay_not_in_ring",
              lastDeliveredId: opts.lastEventId,
              earliestAvailableId: this.nextId
            }
          });
        } else if (earliestInRing !== void 0 && earliestInRing > opts.lastEventId + 1) {
          queue.forcePush({
            v: EVENT_SCHEMA_VERSION,
            type: "state_resync_required",
            data: {
              reason: "ring_evicted",
              lastDeliveredId: opts.lastEventId,
              earliestAvailableId: earliestInRing
            }
          });
        }
      }
      const replayFrom = epochReset ? 0 : opts.lastEventId;
      let replayedCount = 0;
      let lastReplayedId;
      let replayBytes = 0;
      let budgetExceededAtId;
      for (const e of this.ring) {
        if (e.id !== void 0 && e.id > replayFrom) {
          if (budgetExceededAtId !== void 0) continue;
          replayBytes += serializedBridgeEventByteLength(e) ?? 0;
          if (replayBytes > this.replayBudgetBytes && replayedCount > 0) {
            budgetExceededAtId = e.id;
            continue;
          }
          queue.forcePush(e);
          replayedCount += 1;
          lastReplayedId = e.id;
        }
      }
      if (budgetExceededAtId !== void 0) {
        queue.forcePush({
          v: EVENT_SCHEMA_VERSION,
          type: "state_resync_required",
          data: {
            reason: "replay_budget_exceeded",
            lastDeliveredId: lastReplayedId ?? opts.lastEventId,
            earliestAvailableId: budgetExceededAtId
          }
        });
      }
      queue.forcePush({
        v: EVENT_SCHEMA_VERSION,
        type: "replay_complete",
        data: {
          // Note: `lastReplayedEventId`
          // is the canonical wire name — the old `lastEventId` collided
          // semantically with the SSE protocol's `Last-Event-ID` (envelope
          // `id`) in raw daemon traces. Emit both: `lastReplayedEventId`
          // for current SDKs and `lastEventId` as a deprecated alias so
          // pre-rename consumers keep working (additive, non-breaking).
          ...lastReplayedId !== void 0 ? {
            lastReplayedEventId: lastReplayedId,
            lastEventId: lastReplayedId
          } : {},
          replayedCount
        }
      });
    }
    let disposed = false;
    const dispose = /* @__PURE__ */ __name(() => {
      if (disposed) return;
      disposed = true;
      this.subs.delete(sub);
      opts.signal?.removeEventListener("abort", onAbort);
    }, "dispose");
    sub.dispose = dispose;
    const onAbort = /* @__PURE__ */ __name(() => {
      queue.close({ drain: false });
      dispose();
    }, "onAbort");
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    return {
      [Symbol.asyncIterator]: () => ({
        async next() {
          const r = await queue.next();
          if (r.done) dispose();
          return r;
        },
        async return() {
          queue.close();
          dispose();
          return { value: void 0, done: true };
        }
      })
    };
  }
  /** Close all live subscribers and prevent further `publish`/`subscribe`. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subs) {
      sub.queue.close();
      sub.dispose();
    }
    this.subs.clear();
    this.compactionEngine?.close();
  }
};
function emptyAsyncIterable() {
  return {
    [Symbol.asyncIterator]: () => ({
      async next() {
        return { value: void 0, done: true };
      }
    })
  };
}
__name(emptyAsyncIterable, "emptyAsyncIterable");
var BoundedAsyncQueue = class {
  constructor(maxSize, maxBytes) {
    this.maxSize = maxSize;
    this.maxBytes = maxBytes;
  }
  static {
    __name(this, "BoundedAsyncQueue");
  }
  buf = [];
  resolvers = [];
  closed = false;
  /**
   * O(1) snapshot of how many LIVE (non-forced) entries are in `buf`.
   * Maintained directly by `push()`/`next()`: any time a forced entry
   * is added or removed `liveCount` is untouched; any time a live entry
   * is added or removed `liveCount` moves with it. Replaces the
   * position-dependent `forcedInBuf` heuristic — `liveCount` is correct
   * no matter where in the queue the forced entries are.
   */
  liveCount = 0;
  liveBytes = 0;
  /**
   * Number of LIVE (non-force-pushed) items currently waiting in the
   * buffer. Backpressure decisions in `EventBus.publish()` (the
   * `slow_client_warning` threshold) read this value.
   */
  get size() {
    return this.liveCount;
  }
  get bytes() {
    return this.liveBytes;
  }
  push(value, getBytes) {
    if (this.closed) {
      return {
        ok: false,
        reason: "queue_overflow",
        liveSize: this.liveCount,
        liveBytes: this.liveBytes
      };
    }
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
      return {
        ok: true,
        liveSize: this.liveCount,
        liveBytes: this.liveBytes
      };
    }
    if (this.liveCount >= this.maxSize) {
      return {
        ok: false,
        reason: "queue_overflow",
        liveSize: this.liveCount,
        liveBytes: this.liveBytes
      };
    }
    const bytes = getBytes();
    if (this.liveCount > 0 && this.liveBytes + bytes > this.maxBytes) {
      return {
        ok: false,
        reason: "queue_bytes_overflow",
        liveSize: this.liveCount,
        liveBytes: this.liveBytes,
        eventBytes: bytes
      };
    }
    this.buf.push({ value, forced: false, bytes });
    this.liveCount += 1;
    this.liveBytes += bytes;
    return {
      ok: true,
      liveSize: this.liveCount,
      liveBytes: this.liveBytes
    };
  }
  /** Bypasses the size cap. Used for replay frames, eviction terminal,
   * and slow-client warnings. */
  forcePush(value) {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) {
      r({ value, done: false });
      return;
    }
    this.buf.push({ value, forced: true, bytes: 0 });
  }
  /**
   * Mark the queue closed. By default `next()` continues to drain
   * any items already in `buf` before returning `done: true` —
   * that's what the eviction path relies on (the synthetic
   * `client_evicted` frame is force-pushed THEN close is called,
   * and we want the consumer to see the terminal frame before the
   * iterator unwinds).
   *
   * Pass `{ drain: false }` to drop buffered items immediately
   * (the AbortSignal-driven unsubscribe path uses this — the
   * subscribe docstring says abort should close the iterator
   * promptly, but draining hundreds of queued events first
   * contradicts that and adds post-abort work to the SSE route).
   */
  close(opts = {}) {
    if (this.closed) return;
    this.closed = true;
    if (opts.drain === false) {
      this.buf.length = 0;
      this.liveCount = 0;
      this.liveBytes = 0;
    }
    while (this.resolvers.length > 0) {
      this.resolvers.shift()({
        value: void 0,
        done: true
      });
    }
  }
  next() {
    if (this.buf.length > 0) {
      const entry = this.buf.shift();
      if (!entry.forced) {
        this.liveCount -= 1;
        this.liveBytes -= entry.bytes;
      }
      return Promise.resolve({ value: entry.value, done: false });
    }
    if (this.closed) {
      return Promise.resolve({
        value: void 0,
        done: true
      });
    }
    return new Promise((resolve) => this.resolvers.push(resolve));
  }
};

export {
  isSummaryReplayEvent,
  summarizeReplayEvent,
  summarizeReplay,
  EVENT_SCHEMA_VERSION,
  DEFAULT_RING_SIZE,
  serializedBridgeEventByteLength,
  logEventSizingFailed,
  SubscriberLimitExceededError,
  EventBus
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
