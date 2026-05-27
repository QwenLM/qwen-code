/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  StreamingToolExecutor,
  StreamingToolExecutorDiscardedError,
} from './streamingToolExecutor.js';
import type { ToolCallRequestInfo, ToolCallResponseInfo } from './turn.js';

function req(callId: string, name = 'tool'): ToolCallRequestInfo {
  return {
    callId,
    name,
    args: {},
    isClientInitiated: false,
    prompt_id: 'p1',
  };
}

function resp(callId: string): ToolCallResponseInfo {
  return {
    callId,
    responseParts: [{ text: `done:${callId}` }],
    resultDisplay: undefined,
    error: undefined,
    errorType: undefined,
  };
}

describe('StreamingToolExecutor', () => {
  it('starts empty and complete', () => {
    const ex = new StreamingToolExecutor();
    expect(ex.size()).toBe(0);
    expect(ex.isComplete()).toBe(true);
    expect(ex.isDiscarded()).toBe(false);
    expect(ex.getCompletedResults()).toEqual([]);
    expect(ex.getAcceptedRequests()).toEqual([]);
  });

  it('accept() records requests in arrival order', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a'));
    ex.accept(req('b'));
    ex.accept(req('c'));
    expect(ex.size()).toBe(3);
    expect(ex.getAcceptedRequests().map((r) => r.callId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('accept() is idempotent on duplicate callId', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a', 'tool-a'));
    ex.accept(req('a', 'tool-a-redelivered'));
    expect(ex.size()).toBe(1);
    expect(ex.getAcceptedRequests()[0].name).toBe('tool-a');
  });

  it('returned requests array is a copy', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a'));
    const view = ex.getAcceptedRequests();
    view.length = 0;
    expect(ex.size()).toBe(1);
  });

  it('recordResult() buffers results in accept order, not record order', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a'));
    ex.accept(req('b'));
    ex.accept(req('c'));
    ex.recordResult(resp('c'));
    ex.recordResult(resp('a'));
    ex.recordResult(resp('b'));
    expect(ex.getCompletedResults().map((r) => r.callId)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ex.isComplete()).toBe(true);
  });

  it('getCompletedResults() skips unrecorded calls (no padding)', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a'));
    ex.accept(req('b'));
    ex.accept(req('c'));
    ex.recordResult(resp('b'));
    expect(ex.getCompletedResults().map((r) => r.callId)).toEqual(['b']);
    expect(ex.isComplete()).toBe(false);
  });

  it('recordResult() ignores responses without a matching accepted request', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a'));
    ex.recordResult(resp('unknown'));
    expect(ex.getCompletedResults()).toEqual([]);
    expect(ex.isComplete()).toBe(false);
  });

  it('recordResult() ignores a second deposit for the same callId', () => {
    const ex = new StreamingToolExecutor();
    ex.accept(req('a'));
    ex.recordResult(resp('a'));
    const second: ToolCallResponseInfo = {
      ...resp('a'),
      responseParts: [{ text: 'second' }],
    };
    ex.recordResult(second);
    const [only] = ex.getCompletedResults();
    expect(only.responseParts).toEqual([{ text: 'done:a' }]);
  });

  describe('getRemainingResults()', () => {
    it('resolves immediately with [] when nothing was accepted', async () => {
      const ex = new StreamingToolExecutor();
      await expect(ex.getRemainingResults()).resolves.toEqual([]);
    });

    it('resolves immediately when already complete', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.recordResult(resp('a'));
      const results = await ex.getRemainingResults();
      expect(results.map((r) => r.callId)).toEqual(['a']);
    });

    it('resolves when the last missing result lands', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.accept(req('b'));
      const pending = ex.getRemainingResults();
      ex.recordResult(resp('a'));
      // Still pending — only one of two recorded.
      let resolved = false;
      pending.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      ex.recordResult(resp('b'));
      const out = await pending;
      expect(out.map((r) => r.callId)).toEqual(['a', 'b']);
    });

    it('rejects with StreamingToolExecutorDiscardedError when discarded later', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      const pending = ex.getRemainingResults();
      ex.discard('retry');
      await expect(pending).rejects.toBeInstanceOf(
        StreamingToolExecutorDiscardedError,
      );
      await expect(pending).rejects.toMatchObject({
        message: expect.stringContaining('retry'),
      });
    });

    it('rejects immediately when already discarded', async () => {
      const ex = new StreamingToolExecutor();
      ex.discard('aborted');
      await expect(ex.getRemainingResults()).rejects.toBeInstanceOf(
        StreamingToolExecutorDiscardedError,
      );
    });
  });

  describe('discard()', () => {
    it('clears accepted state and is idempotent', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.recordResult(resp('a'));
      ex.discard();
      ex.discard('retry');
      expect(ex.isDiscarded()).toBe(true);
      expect(ex.size()).toBe(0);
      expect(ex.getCompletedResults()).toEqual([]);
      expect(ex.getAcceptedRequests()).toEqual([]);
    });

    it('makes subsequent accept()/recordResult() no-ops', () => {
      const ex = new StreamingToolExecutor();
      ex.discard();
      ex.accept(req('a'));
      ex.recordResult(resp('a'));
      expect(ex.size()).toBe(0);
      expect(ex.getCompletedResults()).toEqual([]);
    });

    it('rejects every pending getRemainingResults() consumer', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      const p1 = ex.getRemainingResults();
      const p2 = ex.getRemainingResults();
      ex.discard();
      await expect(p1).rejects.toBeInstanceOf(
        StreamingToolExecutorDiscardedError,
      );
      await expect(p2).rejects.toBeInstanceOf(
        StreamingToolExecutorDiscardedError,
      );
    });

    it('first reason wins on repeated discard()', () => {
      const ex = new StreamingToolExecutor();
      ex.discard('aborted');
      ex.discard('retry');
      expect(ex.getDiscardReason()).toBe('aborted');
    });

    it('rejection carries the discard reason on the Error instance', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      const pending = ex.getRemainingResults();
      ex.discard('retry');
      await expect(pending).rejects.toMatchObject({
        name: 'StreamingToolExecutorDiscardedError',
        reason: 'retry',
      });
    });
  });

  describe('reference safety', () => {
    it('accept() deep-clones the request so post-accept top-level mutation does not leak', () => {
      const ex = new StreamingToolExecutor();
      const r = req('a');
      r.wasOutputTruncated = false;
      ex.accept(r);
      r.wasOutputTruncated = true;
      const [stored] = ex.getAcceptedRequests();
      expect(stored.wasOutputTruncated).toBe(false);
    });

    it('accept() deep-clones args so caller mutation does not leak (nested)', () => {
      const ex = new StreamingToolExecutor();
      const r: ToolCallRequestInfo = {
        ...req('a'),
        args: { config: { timeout: 100 } },
      };
      ex.accept(r);
      (r.args as { config: { timeout: number } }).config.timeout = 999;
      const [stored] = ex.getAcceptedRequests();
      expect(stored.args).toEqual({ config: { timeout: 100 } });
    });
  });

  describe('markTruncated()', () => {
    it('flips wasOutputTruncated on the matching stored request', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.accept(req('b'));
      ex.markTruncated('b');
      const [a, b] = ex.getAcceptedRequests();
      expect(a.wasOutputTruncated).toBeUndefined();
      expect(b.wasOutputTruncated).toBe(true);
    });

    it('is a no-op for unknown callIds', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.markTruncated('ghost');
      const [a] = ex.getAcceptedRequests();
      expect(a.wasOutputTruncated).toBeUndefined();
    });

    it('is a no-op after discard()', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.discard('aborted');
      ex.markTruncated('a');
      // Discard wipes everything — nothing to flip; should not throw either.
      expect(ex.getAcceptedRequests()).toEqual([]);
    });
  });

  describe('close()', () => {
    it('marks isClosed without discarding or wiping state', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.recordResult(resp('a'));
      ex.close();
      expect(ex.isClosed()).toBe(true);
      expect(ex.isDiscarded()).toBe(false);
      expect(ex.size()).toBe(1);
      expect(ex.getCompletedResults().map((r) => r.callId)).toEqual(['a']);
    });

    it('blocks subsequent accept() but still admits matching recordResult()', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.close();
      ex.accept(req('b')); // post-close accept is dropped
      expect(ex.size()).toBe(1);
      ex.recordResult(resp('a'));
      expect(ex.isComplete()).toBe(true);
      expect(ex.getCompletedResults().map((r) => r.callId)).toEqual(['a']);
    });

    it('keeps pending consumers unrejected when not complete at close time', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      const pending = ex.getRemainingResults();
      ex.close();
      let settled = false;
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      ex.recordResult(resp('a'));
      await expect(pending).resolves.toHaveLength(1);
    });

    it('is idempotent and no-op after discard()', () => {
      const ex = new StreamingToolExecutor();
      ex.discard('aborted');
      ex.close();
      ex.close();
      expect(ex.isClosed()).toBe(false);
      expect(ex.isDiscarded()).toBe(true);
      expect(ex.getDiscardReason()).toBe('aborted');
    });

    it('discard() after close() supersedes — isClosed flips back to false', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      const pending = ex.getRemainingResults();
      ex.close();
      expect(ex.isClosed()).toBe(true);
      ex.discard('aborted');
      expect(ex.isDiscarded()).toBe(true);
      expect(ex.isClosed()).toBe(false);
      await expect(pending).rejects.toBeInstanceOf(
        StreamingToolExecutorDiscardedError,
      );
      expect(ex.getDiscardReason()).toBe('aborted');
    });
  });

  describe('reset()', () => {
    it('wipes buffered state but keeps the executor Open for fresh accepts', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.recordResult(resp('a'));
      ex.reset('retry');
      expect(ex.isDiscarded()).toBe(false);
      expect(ex.isClosed()).toBe(false);
      expect(ex.size()).toBe(0);
      expect(ex.getCompletedResults()).toEqual([]);
      ex.accept(req('b'));
      ex.recordResult(resp('b'));
      expect(ex.getCompletedResults().map((r) => r.callId)).toEqual(['b']);
    });

    it('is a no-op on a Closed (but not Discarded) executor', () => {
      // The lifecycle has Closed→Open as a non-transition: close() is
      // the post-stream stable state and reset() is mid-stream-only.
      // Previously `wipeBuffer()` unconditionally cleared `closed`, so
      // a stray reset after close silently reopened the executor and
      // allowed late `accept()` calls to populate a finished batch.
      // The guard preserves the documented mutual exclusion.
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.close();
      ex.reset('retry');
      // closed flag preserved
      expect(ex.isClosed()).toBe(true);
      expect(ex.isDiscarded()).toBe(false);
      // Buffer is NOT wiped — the original request still drains
      expect(ex.size()).toBe(1);
      // Late accept on a closed executor remains a no-op (existing
      // close() invariant, unchanged by this fix).
      ex.accept(req('b'));
      expect(ex.size()).toBe(1);
    });

    it('rejects pending getRemainingResults() consumers with the reason', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      const pending = ex.getRemainingResults();
      ex.reset('retry');
      await expect(pending).rejects.toMatchObject({
        name: 'StreamingToolExecutorDiscardedError',
        reason: 'retry',
      });
    });

    it('is a no-op on already-discarded executors', async () => {
      const ex = new StreamingToolExecutor();
      ex.discard('aborted');
      ex.reset('retry');
      expect(ex.isDiscarded()).toBe(true);
      expect(ex.isClosed()).toBe(false);
      expect(ex.getDiscardReason()).toBe('aborted');
      // The terminal-discard contract still holds — getRemainingResults
      // rejects with the original reason rather than waiting for a fresh
      // accept after the reset no-op.
      await expect(ex.getRemainingResults()).rejects.toMatchObject({
        reason: 'aborted',
      });
    });

    it('re-accepts the same callId after a reset (acceptedIds cleared)', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a', 'first'));
      ex.reset('retry');
      ex.accept(req('a', 'second'));
      expect(ex.size()).toBe(1);
      const [stored] = ex.getAcceptedRequests();
      expect(stored.callId).toBe('a');
      expect(stored.name).toBe('second');
    });

    it('does not set a discard reason — getDiscardReason stays undefined', () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.reset('retry');
      expect(ex.getDiscardReason()).toBeUndefined();
    });
  });

  describe('multi-consumer settlement', () => {
    it('two concurrent getRemainingResults() both resolve when complete', async () => {
      const ex = new StreamingToolExecutor();
      ex.accept(req('a'));
      ex.accept(req('b'));
      const p1 = ex.getRemainingResults();
      const p2 = ex.getRemainingResults();
      ex.recordResult(resp('a'));
      ex.recordResult(resp('b'));
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.map((r) => r.callId)).toEqual(['a', 'b']);
      expect(r2.map((r) => r.callId)).toEqual(['a', 'b']);
    });
  });

  describe('addCancellationListener()', () => {
    it('fires the listener once per discard() with the reason', () => {
      const ex = new StreamingToolExecutor();
      const seen: Array<string | undefined> = [];
      ex.addCancellationListener((r) => seen.push(r));
      ex.discard('aborted');
      ex.discard('retry'); // idempotent — listener does not refire
      expect(seen).toEqual(['aborted']);
    });

    it('fires the listener once per reset() with the reason', () => {
      const ex = new StreamingToolExecutor();
      const seen: Array<string | undefined> = [];
      ex.addCancellationListener((r) => seen.push(r));
      ex.reset('retry');
      ex.reset('retry');
      expect(seen).toEqual(['retry', 'retry']);
    });

    it('does not fire on close() — close preserves state', () => {
      const ex = new StreamingToolExecutor();
      const seen: Array<string | undefined> = [];
      ex.addCancellationListener((r) => seen.push(r));
      ex.close();
      expect(seen).toEqual([]);
    });

    it('multiple listeners all fire', () => {
      const ex = new StreamingToolExecutor();
      const a: Array<string | undefined> = [];
      const b: Array<string | undefined> = [];
      ex.addCancellationListener((r) => a.push(r));
      ex.addCancellationListener((r) => b.push(r));
      ex.discard('stream-error');
      expect(a).toEqual(['stream-error']);
      expect(b).toEqual(['stream-error']);
    });

    it('unsubscribe stops further notifications', () => {
      const ex = new StreamingToolExecutor();
      const seen: Array<string | undefined> = [];
      const off = ex.addCancellationListener((r) => seen.push(r));
      ex.reset('retry');
      off();
      ex.reset('retry');
      expect(seen).toEqual(['retry']);
    });

    it('listener that unsubscribes itself mid-fire does not perturb other listeners', () => {
      const ex = new StreamingToolExecutor();
      const order: string[] = [];
      const offA = ex.addCancellationListener(() => {
        order.push('a');
        offA();
      });
      ex.addCancellationListener(() => order.push('b'));
      ex.reset('retry');
      expect(order).toEqual(['a', 'b']);
    });
  });
});
