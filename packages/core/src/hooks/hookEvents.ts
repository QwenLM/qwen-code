/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hook event system for broadcasting hook execution lifecycle events.
 *
 * Three events:
 *  - `started`: emitted once when a hook begins execution.
 *  - `progress`: streamed during execution; carries cumulative stdout/stderr.
 *    Emitted via a 1000 ms polling interval per invocation (lazy-armed on
 *    first output byte). Only emits when output has changed since last tick.
 *  - `response`: emitted once after the hook completes (success, error, or
 *    cancellation). Carries final stdout/stderr/exit_code/outcome plus duration.
 *
 * Ordering invariant: any pending `progress` data is flushed in one final
 * `progress` event BEFORE the `response` event, so consumers can render the
 * tail chunks without waiting for the next snapshot.
 */

import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Hook events that are always emitted regardless of the includeHookEvents
 * option. These are low-noise lifecycle events that are backwards-compatible.
 */
const ALWAYS_EMITTED_HOOK_EVENTS = new Set(['SessionStart', 'Setup']);

let allHookEventsEnabled = false;

/**
 * Enable emission of all hook event types (beyond SessionStart and Setup).
 * Called when the SDK `--include-hook-events` option is set or when running
 * in remote worker mode.
 */
export function setAllHookEventsEnabled(enabled: boolean): void {
  allHookEventsEnabled = enabled;
}

function shouldEmit(hookEvent: string): boolean {
  return ALWAYS_EMITTED_HOOK_EVENTS.has(hookEvent) || allHookEventsEnabled;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

// hookEvents 是**独立于 coreEvents 的另一条通道**（本文件末尾的模块级单例
// HookEventEmitter），所以 coreEvents 的会话化改造（payload 强制带 sessionId +
// onSessionEvent 作为唯一过滤点）覆盖不到它。而它同样是进程级单例——文档原文
// 「Singleton emitter shared by all hook invocations. Subscribers attach once and
// receive events for every hook the process executes」——单进程多会话（daemon）下
// 每个会话的订阅者都会收到所有会话的 hook 事件。
//
// 因此三个 payload 都带**必填** sessionId，字段名与 coreEvents 的 SessionScopedPayload
// 对齐（而不是沿用本文件其余字段的 snake_case），让「有 sessionId 就是会话级」这条
// 判据在两条通道上保持一致。消费侧必须自己比对——hookEvents 没有 onSessionEvent，
// 这是它与 coreEvents 的差别，也是这里的订阅方必须显式过滤的原因。
export interface HookStartedEvent {
  sessionId: string;
  hook_id: string;
  hook_name: string;
  hook_event: string;
}

export interface HookProgressEvent {
  sessionId: string;
  hook_id: string;
  hook_name: string;
  hook_event: string;
  /** Cumulative stdout received so far. */
  stdout: string;
  /** Cumulative stderr received so far. */
  stderr: string;
  /** Cumulative interleaved output (stdout + stderr in arrival order). */
  output: string;
}

export interface HookResponseEvent {
  sessionId: string;
  hook_id: string;
  hook_name: string;
  hook_event: string;
  exit_code?: number;
  duration_ms: number;
  outcome: 'success' | 'error' | 'cancelled';
  stdout: string;
  stderr: string;
  /** Concatenated output (stdout + stderr). Computed by the emitter. */
  output: string;
}

export type HookEventName = 'started' | 'progress' | 'response';

// ---------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------

export class HookEventEmitter extends EventEmitter {
  emitStarted(payload: HookStartedEvent): void {
    if (!shouldEmit(payload.hook_event)) return;
    this.emit('started', payload);
  }

  emitProgress(payload: HookProgressEvent): void {
    if (!shouldEmit(payload.hook_event)) return;
    this.emit('progress', payload);
  }

  emitResponse(payload: HookResponseEvent): void {
    this.emit('response:any', payload);
    if (!shouldEmit(payload.hook_event)) return;
    this.emit('response', payload);
  }

  onStarted(listener: (payload: HookStartedEvent) => void): () => void {
    this.on('started', listener);
    return () => this.off('started', listener);
  }

  onProgress(listener: (payload: HookProgressEvent) => void): () => void {
    this.on('progress', listener);
    return () => this.off('progress', listener);
  }

  onResponse(listener: (payload: HookResponseEvent) => void): () => void {
    this.on('response', listener);
    return () => this.off('response', listener);
  }

  onAnyResponse(listener: (payload: HookResponseEvent) => void): () => void {
    this.on('response:any', listener);
    return () => this.off('response:any', listener);
  }

  // ── 会话级订阅 ────────────────────────────────────────────────────────────
  //
  // 过滤只在这里实现一处，与 coreEvents.onSessionEvent 的取舍相同：让每个消费者自己
  // 写 `if (p.sessionId !== mine) return` 会漏、会写错，而且无法被门禁检查。
  // 单会话运行时（TUI / worker / remote）继续用上面那组不过滤的方法即可——那些进程里
  // 只有一个会话，过滤是多余的；单进程多会话（daemon）必须用这组。
  //
  // 三个方法各自写字面量频道名而不抽公共辅助：抽成 `scoped(channel: string, …)` 会
  // 丢掉 EventEmitter 在具体频道上的监听器类型，需要 `as` 到 never/any 才能过编译，
  // 那点重复换来的是与上面 onStarted/onProgress/onResponse 完全同形、可直读的代码。
  onSessionStarted(
    sessionId: string,
    listener: (payload: HookStartedEvent) => void,
  ): () => void {
    const wrapped = (payload: HookStartedEvent): void => {
      if (payload.sessionId === sessionId) listener(payload);
    };
    this.on('started', wrapped);
    return () => this.off('started', wrapped);
  }

  onSessionProgress(
    sessionId: string,
    listener: (payload: HookProgressEvent) => void,
  ): () => void {
    const wrapped = (payload: HookProgressEvent): void => {
      if (payload.sessionId === sessionId) listener(payload);
    };
    this.on('progress', wrapped);
    return () => this.off('progress', wrapped);
  }

  onSessionResponse(
    sessionId: string,
    listener: (payload: HookResponseEvent) => void,
  ): () => void {
    const wrapped = (payload: HookResponseEvent): void => {
      if (payload.sessionId === sessionId) listener(payload);
    };
    this.on('response', wrapped);
    return () => this.off('response', wrapped);
  }
}

/**
 * Singleton emitter shared by all hook invocations. Subscribers attach once
 * and receive events for every hook the process executes.
 */
export const hookEvents = new HookEventEmitter();
