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
      ex.discard('again');
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
  });
});
