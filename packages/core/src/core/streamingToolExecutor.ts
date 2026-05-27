/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallRequestInfo, ToolCallResponseInfo } from './turn.js';

/**
 * Canonical discard reasons emitted by Turn lifecycle transitions. The union
 * is closed — downstream telemetry and dispatchers may branch on it
 * exhaustively.
 */
export type StreamingToolExecutorDiscardReason =
  | 'aborted'
  | 'retry'
  | 'unauthorized'
  | 'stream-error';

/**
 * Thrown from `getRemainingResults()` when the executor's buffer was wiped
 * before every accepted request produced a result. Both `discard()` (terminal)
 * and `reset()` (re-arm) reject pending consumers with this Error — the type
 * is named for the discard case but the wipe semantics are the same. The
 * `reason` field is a stable public contract callers may branch on.
 *
 * Callers should treat the rejection as "the buffered results are gone, fall
 * back to the post-stream scheduling path or surface a clean error", never
 * as "swallow silently".
 */
export class StreamingToolExecutorDiscardedError extends Error {
  /** The reason supplied to the `discard()` or `reset()` that wiped the buffer. */
  readonly reason: StreamingToolExecutorDiscardReason | undefined;
  constructor(reason?: StreamingToolExecutorDiscardReason) {
    super(
      reason
        ? `StreamingToolExecutor discarded: ${reason}`
        : 'StreamingToolExecutor discarded',
    );
    this.name = 'StreamingToolExecutorDiscardedError';
    this.reason = reason;
  }
}

/**
 * Buffers tool-call requests surfaced during a streaming model response and
 * the matching results deposited by an external dispatcher.
 *
 * It is intentionally execution-free — calling `CoreToolScheduler.schedule()`,
 * sibling-suppression for `structured_output`, and history submission of
 * `functionResponse` parts all stay with the caller.
 *
 * Lifecycle states (mutually exclusive):
 *   - Open: accepting requests and recording results.
 *   - Closed: producing stream ended; no more accepts; existing buffer
 *     remains drainable via `getCompletedResults()` / `getRemainingResults()`.
 *   - Discarded: terminal error path; buffer wiped, pending consumers
 *     rejected, all further accepts / records are no-ops. Supersedes Closed
 *     (`discard()` after `close()` clears the closed flag).
 *
 * Transition picker — when the producing side signals an event, the caller
 * picks one of three methods:
 *
 * | Trigger                              | Method      | Buffer | Pending consumers | Final state |
 * |--------------------------------------|-------------|--------|-------------------|-------------|
 * | normal stream end / consumer break   | `close()`   | kept   | kept pending      | Closed      |
 * | mid-stream retry                     | `reset(r)`  | wiped  | rejected (reason) | Open        |
 * | abort / unauthorized / stream-error  | `discard(r)`| wiped  | rejected (reason) | Discarded   |
 *
 * Pending `getRemainingResults()` consumers stay pending across `close()`
 * when the buffer isn't complete — the caller must deposit the missing
 * results (success path) or call `discard()` / `reset()` to release them.
 *
 * Single-Turn ownership is assumed — sharing an executor across concurrent
 * Turns would let `reset()` from one Turn surprise the other.
 */
export class StreamingToolExecutor {
  private readonly requests: ToolCallRequestInfo[] = [];
  /** Insertion order of callIds, so completed results stay in dispatch order. */
  private readonly order: string[] = [];
  private readonly responses = new Map<string, ToolCallResponseInfo>();
  /** callIds we've seen at least once, to make accept() idempotent. */
  private readonly acceptedIds = new Set<string>();
  private discarded = false;
  private discardReason: StreamingToolExecutorDiscardReason | undefined;
  private closed = false;
  private readonly pending: Array<{
    resolve: (results: ToolCallResponseInfo[]) => void;
    reject: (error: Error) => void;
  }> = [];
  private readonly cancellationListeners = new Set<
    (reason: StreamingToolExecutorDiscardReason | undefined) => void
  >();

  /**
   * Record a completed tool-call request surfaced by the stream. Subsequent
   * calls with the same `callId` are ignored — providers occasionally
   * redeliver the same tool call on resume / continuation, and the buffer
   * must stay in one-result-per-call shape. No-op after `close()` or
   * `discard()`.
   *
   * The request is deep-cloned at accept time so caller-side mutation
   * (including nested `args` objects) does not leak into the executor's
   * view. State that needs to change post-accept — e.g. truncation under
   * `MAX_TOKENS` — must go through {@link markTruncated}.
   *
   * Assumes `args` is JSON-shaped (the shape the model emits). A non-
   * cloneable value here would throw `DataCloneError` synchronously.
   */
  accept(request: ToolCallRequestInfo): void {
    if (this.discarded || this.closed) return;
    if (this.acceptedIds.has(request.callId)) return;
    this.acceptedIds.add(request.callId);
    this.requests.push(structuredClone(request));
    this.order.push(request.callId);
  }

  /**
   * Deposit a tool response keyed by `callId`. Silently ignored if the
   * matching request was never accepted (or its accept was wiped by
   * `discard()` / `reset()`), or after `discard()`. Callers are expected to
   * enforce the accept-before-record ordering. A dispatcher whose tool
   * completes *after* the executor was wiped should treat the late
   * `recordResult()` as a no-op — the matching `functionCall` is no longer
   * in (or being added to) history.
   *
   * **Stale-callback hazard:** if the same `callId` is re-accepted after
   * `reset()` (e.g. a provider redelivers it on the retry attempt) and the
   * previous attempt's dispatcher is still running, its eventual
   * `recordResult()` will land on the *new* attempt's slot and be silently
   * misattributed. Dispatchers MUST cancel their in-flight work
   * synchronously inside `reset()` / `discard()` — typically by aborting
   * an `AbortController` owned alongside the executor — so no stale
   * callbacks survive a wipe.
   */
  recordResult(response: ToolCallResponseInfo): void {
    if (this.discarded) return;
    if (!this.acceptedIds.has(response.callId)) return;
    if (this.responses.has(response.callId)) return;
    this.responses.set(response.callId, response);
    this.maybeSettlePending();
  }

  /**
   * Mark a previously-accepted request as truncated. Mirrors the
   * `wasOutputTruncated` flag that `Turn` flips on `pendingToolCalls` when
   * `MAX_TOKENS` fires — kept as an explicit API rather than ref-sharing so
   * the executor's view is otherwise immutable. No-op for unknown callIds
   * or after `discard()`.
   *
   * @internal Intended for `Turn` only. Other callers should treat
   * `getAcceptedRequests()` entries as immutable.
   */
  markTruncated(callId: string): void {
    if (this.discarded) return;
    const idx = this.order.indexOf(callId);
    if (idx === -1) return;
    this.requests[idx].wasOutputTruncated = true;
  }

  /**
   * Snapshot of results landed so far, in the order their matching requests
   * were accepted. Calls whose requests have no result yet are skipped — the
   * snapshot is not padded.
   */
  getCompletedResults(): ToolCallResponseInfo[] {
    const out: ToolCallResponseInfo[] = [];
    for (const callId of this.order) {
      const r = this.responses.get(callId);
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Resolves once every accepted request has a recorded result, returning
   * them in accept order. Rejects with {@link StreamingToolExecutorDiscardedError}
   * if `discard()` *or* `reset()` runs first — the rejection's `reason`
   * field distinguishes the two (`'aborted' | 'unauthorized' | 'stream-error'`
   * for discard, `'retry'` for reset). Resolves immediately if already
   * complete (including the empty-accept case, which resolves to `[]`).
   * Stays pending across `close()` when the buffer isn't complete — the
   * caller must record the remaining results or call `discard()` / `reset()`.
   */
  getRemainingResults(): Promise<ToolCallResponseInfo[]> {
    if (this.discarded) {
      return Promise.reject(
        new StreamingToolExecutorDiscardedError(this.discardReason),
      );
    }
    if (this.isComplete()) {
      return Promise.resolve(this.getCompletedResults());
    }
    return new Promise<ToolCallResponseInfo[]>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
  }

  /**
   * Terminally drop all buffered requests/results and reject any pending
   * `getRemainingResults()` consumers. Idempotent; subsequent `accept()` /
   * `recordResult()` calls become no-ops so a late stream event cannot
   * resurrect a discarded executor — and so a tool whose dispatch finishes
   * *after* `discard()` is silently dropped (the matching `functionCall`
   * is no longer in history). Supersedes `close()`: discarding a closed
   * executor clears the closed flag so `isClosed()` and `isDiscarded()`
   * remain mutually exclusive. First reason wins on repeated calls so a
   * downstream fallback discard doesn't overwrite the canonical reason.
   *
   * For a non-terminal wipe (mid-stream retry) call {@link reset} instead.
   */
  discard(reason?: StreamingToolExecutorDiscardReason): void {
    if (this.discarded) return;
    this.discarded = true;
    this.discardReason = reason;
    this.wipeBuffer(reason);
  }

  /**
   * Non-terminal wipe: drop buffered requests/results and reject pending
   * `getRemainingResults()` consumers as if `discard()` ran, but leave the
   * executor in the Open state so subsequent `accept()` calls populate a
   * fresh batch. Used by Turn on mid-stream retry, where the previous
   * attempt's tool calls are thrown away but the next attempt's still need
   * to flow through the executor.
   *
   * No-op on already-discarded executors (the canonical terminal reason
   * stays put) AND on Closed executors — the documented lifecycle table
   * has Closed→Open as a non-transition, and `wipeBuffer()` clears the
   * `closed` flag, so without this guard a stray `reset()` after `close()`
   * would silently reopen a finished batch. The only intended caller
   * (`Turn.run` on retry) always invokes reset BEFORE the post-stream
   * close() — Closed is only reachable via Turn's finally — so this
   * guard is preserving the invariant rather than rejecting a real
   * caller. See the state-machine note at the top of this class.
   */
  reset(reason?: StreamingToolExecutorDiscardReason): void {
    if (this.discarded) return;
    if (this.closed) return;
    this.wipeBuffer(reason);
  }

  /**
   * Shared buffer-wipe used by both `discard()` and `reset()`. Clears every
   * field that represents accepted-but-not-yet-drained work, rejects any
   * pending `getRemainingResults()` consumer, and fires the cancellation
   * listeners — keeps the two lifecycle paths in lockstep so a future field
   * added here cannot silently survive one path while being cleared by the
   * other. `discard()` additionally sets `discarded` / `discardReason`
   * before calling this; `reset()` calls it as-is (leaving the executor
   * Open for the next batch).
   */
  private wipeBuffer(reason?: StreamingToolExecutorDiscardReason): void {
    this.closed = false;
    this.requests.length = 0;
    this.order.length = 0;
    this.responses.clear();
    this.acceptedIds.clear();
    this.rejectPending(reason);
    this.notifyCancellation(reason);
  }

  /**
   * Signal that the producing stream has ended (normal completion or caller
   * break-out from the consuming loop). Unlike `discard()`, this preserves
   * buffered state so a consumer can still drain `getCompletedResults()` /
   * `getRemainingResults()` — it only stops further `accept()` calls.
   * Idempotent; no-op on already-discarded executors.
   *
   * Pending `getRemainingResults()` consumers are intentionally **not**
   * settled here: the all-or-nothing contract still holds, so a caller whose
   * stream closes with un-recorded results must either deposit those results
   * (success path) or `discard()` (give-up path) to release the promise.
   */
  close(): void {
    if (this.discarded || this.closed) return;
    this.closed = true;
  }

  isDiscarded(): boolean {
    return this.discarded;
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * The reason recorded by the terminal `discard()` call, if any. Note that
   * `reset()` does NOT set this — its reason is observable only on the
   * rejection {@link StreamingToolExecutorDiscardedError} delivered to
   * pending `getRemainingResults()` consumers.
   */
  getDiscardReason(): StreamingToolExecutorDiscardReason | undefined {
    return this.discardReason;
  }

  isComplete(): boolean {
    return this.order.length === this.responses.size;
  }

  size(): number {
    return this.order.length;
  }

  /**
   * Accepted requests in arrival order; deep-cloned at accept time. The
   * returned array is a fresh shallow copy but its elements remain the
   * executor's live entries — `markTruncated()` flips `wasOutputTruncated`
   * on them in place. Treat the elements as immutable from outside.
   */
  getAcceptedRequests(): ToolCallRequestInfo[] {
    return this.requests.slice();
  }

  /**
   * Subscribe to buffer-wipe events. The listener fires exactly once per
   * `discard()` / `reset()` call (in registration order) with the supplied
   * reason — same value the matching `StreamingToolExecutorDiscardedError`
   * carries. Used by external dispatchers (e.g. `StreamingToolDispatcher`)
   * that own in-flight tool runs and must abort them synchronously when the
   * executor's buffer goes away — see the stale-callback hazard note on
   * {@link recordResult}.
   *
   * Listeners are invoked AFTER the buffer is wiped and AFTER pending
   * `getRemainingResults()` consumers are rejected, so a listener calling
   * back into the executor sees the post-wipe state. Throws from a
   * listener are **swallowed** — the only in-tree listener
   * (`StreamingToolDispatcher`) calls `AbortController.abort()`, which
   * synchronously fans out to every attached `'abort'` handler
   * (child-process kills, fetch teardowns); any of those throwing must
   * not skip the remaining listeners or escape `discard()`/`reset()`
   * into Turn's lifecycle code. Listeners needing observability should
   * log inside their own body.
   *
   * Returns an unsubscribe function. Safe to call after the executor has
   * been wiped (it just removes the listener for any future events; a
   * subsequent `reset()` would still fire surviving listeners).
   */
  addCancellationListener(
    fn: (reason: StreamingToolExecutorDiscardReason | undefined) => void,
  ): () => void {
    this.cancellationListeners.add(fn);
    return () => {
      this.cancellationListeners.delete(fn);
    };
  }

  private notifyCancellation(
    reason: StreamingToolExecutorDiscardReason | undefined,
  ): void {
    if (this.cancellationListeners.size === 0) return;
    // Snapshot so a listener that unsubscribes itself (or another) mid-fire
    // doesn't perturb the iteration we're currently dispatching.
    const snapshot = [...this.cancellationListeners];
    for (const fn of snapshot) {
      try {
        fn(reason);
      } catch {
        // Listener throws are intentionally swallowed — see the contract
        // documented on addCancellationListener().
      }
    }
  }

  private maybeSettlePending(): void {
    if (!this.isComplete() || this.pending.length === 0) return;
    // Per-consumer snapshot — otherwise consumer A mutating the resolved
    // array (e.g. `.shift()` while feeding history) would leak into
    // consumer B's view.
    const pending = this.pending.splice(0);
    for (const p of pending) p.resolve(this.getCompletedResults());
  }

  private rejectPending(
    reason: StreamingToolExecutorDiscardReason | undefined,
  ): void {
    if (this.pending.length === 0) return;
    const error = new StreamingToolExecutorDiscardedError(reason);
    const pending = this.pending.splice(0);
    for (const p of pending) p.reject(error);
  }
}
