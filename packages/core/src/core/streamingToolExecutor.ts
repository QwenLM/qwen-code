/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallRequestInfo, ToolCallResponseInfo } from './turn.js';

/**
 * Thrown from `getRemainingResults()` when the executor is discarded before
 * every accepted request has produced a result. Callers should treat this as
 * "the buffered results are gone, fall back to the post-stream scheduling
 * path or surface a clean error", never as "swallow silently".
 */
export class StreamingToolExecutorDiscardedError extends Error {
  constructor(reason?: string) {
    super(
      reason
        ? `StreamingToolExecutor discarded: ${reason}`
        : 'StreamingToolExecutor discarded',
    );
    this.name = 'StreamingToolExecutorDiscardedError';
  }
}

/**
 * Phase 2 skeleton for stream-driven tool dispatch (RFC: issue #4387).
 *
 * Responsibility today:
 *   - Observe `ToolCallRequestInfo` events as they arrive on the Turn stream.
 *   - Buffer matching `ToolCallResponseInfo` results that a future early
 *     dispatcher will deposit via `recordResult()`. Phase 2 has no in-tree
 *     caller of `recordResult()` in production; the post-stream
 *     `CoreToolScheduler` path remains the default and is unchanged.
 *   - Surface `getCompletedResults()` / `getRemainingResults()` so a Phase 3+
 *     owner can drain results without re-implementing ordering or
 *     cancellation bookkeeping.
 *   - Support `discard()` so retry / fallback / abort / stream-error paths
 *     can drop everything without leaking orphan `functionResponse` entries
 *     into history.
 *
 * Out of scope until later phases:
 *   - Calling `CoreToolScheduler.schedule()` itself.
 *   - Sibling-suppression for `structured_output`.
 *   - Submitting results to model history (still gated on the matching
 *     `functionCall` being present, which is the caller's invariant).
 */
export class StreamingToolExecutor {
  private readonly requests: ToolCallRequestInfo[] = [];
  /** Insertion order of callIds, so completed results stay in dispatch order. */
  private readonly order: string[] = [];
  private readonly responses = new Map<string, ToolCallResponseInfo>();
  /** callIds we've seen at least once, to make accept() idempotent. */
  private readonly acceptedIds = new Set<string>();
  private discarded = false;
  private discardReason: string | undefined;
  private readonly pending: Array<{
    resolve: (results: ToolCallResponseInfo[]) => void;
    reject: (error: Error) => void;
  }> = [];

  /**
   * Record a completed tool-call request surfaced by the stream. Subsequent
   * calls with the same `callId` are ignored — providers occasionally redeliver
   * the same tool call on resume / continuation, and the buffer must stay in
   * one-result-per-call shape.
   */
  accept(request: ToolCallRequestInfo): void {
    if (this.discarded) return;
    if (this.acceptedIds.has(request.callId)) return;
    this.acceptedIds.add(request.callId);
    this.requests.push(request);
    this.order.push(request.callId);
  }

  /**
   * Deposit a tool response keyed by `callId`. Silently ignored if the
   * matching request was never accepted, or after `discard()`. Callers in
   * Phase 3+ are expected to enforce the accept-before-record ordering.
   */
  recordResult(response: ToolCallResponseInfo): void {
    if (this.discarded) return;
    if (!this.acceptedIds.has(response.callId)) return;
    if (this.responses.has(response.callId)) return;
    this.responses.set(response.callId, response);
    this.maybeSettlePending();
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
   * if `discard()` is called first. Resolves immediately if already complete
   * (including the empty-accept case, which resolves to `[]`).
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
   * Drop all buffered requests/results and reject any pending
   * `getRemainingResults()` consumers. Idempotent; subsequent `accept()` /
   * `recordResult()` calls become no-ops so a late-arriving stream event
   * cannot resurrect a discarded executor.
   */
  discard(reason?: string): void {
    if (this.discarded) return;
    this.discarded = true;
    this.discardReason = reason;
    this.requests.length = 0;
    this.order.length = 0;
    this.responses.clear();
    this.acceptedIds.clear();
    const error = new StreamingToolExecutorDiscardedError(reason);
    const pending = this.pending.splice(0);
    for (const p of pending) p.reject(error);
  }

  isDiscarded(): boolean {
    return this.discarded;
  }

  isComplete(): boolean {
    return this.order.length === this.responses.size;
  }

  size(): number {
    return this.order.length;
  }

  /** Accepted requests in arrival order; copied so callers can't mutate. */
  getAcceptedRequests(): ToolCallRequestInfo[] {
    return this.requests.slice();
  }

  private maybeSettlePending(): void {
    if (!this.isComplete() || this.pending.length === 0) return;
    const results = this.getCompletedResults();
    const pending = this.pending.splice(0);
    for (const p of pending) p.resolve(results);
  }
}
