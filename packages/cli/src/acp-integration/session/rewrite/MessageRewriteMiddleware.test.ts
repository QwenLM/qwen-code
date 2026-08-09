/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { Config } from '@qwen-code/qwen-code-core';

// Mock core to avoid Vite https resolution issue
vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock LlmRewriter to avoid real LLM calls
vi.mock('./LlmRewriter.js', () => ({
  LlmRewriter: vi.fn().mockImplementation(() => ({
    rewrite: vi.fn().mockResolvedValue('rewritten text'),
    commitOutput: vi.fn(),
  })),
}));

// Import after mocks are set up
const { MessageRewriteMiddleware } = await import(
  './MessageRewriteMiddleware.js'
);

function createMiddleware(
  target: 'message' | 'thought' | 'all' = 'all',
  sendUpdate?: ReturnType<typeof vi.fn>,
  getOwnerPromptId?: () => string | undefined,
) {
  const mockSendUpdate = sendUpdate ?? vi.fn().mockResolvedValue(undefined);
  const middleware = new MessageRewriteMiddleware(
    {} as Config,
    { enabled: true, target, prompt: 'test prompt' },
    mockSendUpdate,
    getOwnerPromptId ?? (() => undefined),
  );
  return { middleware, mockSendUpdate };
}

describe('MessageRewriteMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('interceptUpdate — pass-through', () => {
    it('should pass through non-message updates unchanged', async () => {
      const { middleware, mockSendUpdate } = createMiddleware();
      const update = {
        sessionUpdate: 'tool_call_update',
        content: { text: 'progress' },
      } as unknown as SessionUpdate;

      await middleware.interceptUpdate(update);
      expect(mockSendUpdate).toHaveBeenCalledWith(update);
    });

    it('should always send original message/thought as-is', async () => {
      const { middleware, mockSendUpdate } = createMiddleware();
      const msgUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      } as unknown as SessionUpdate;

      await middleware.interceptUpdate(msgUpdate);
      expect(mockSendUpdate).toHaveBeenCalledWith(msgUpdate, {
        turnIndex: 1,
        rewritten: false,
        replacesMessageText: true,
      });
    });
  });

  describe('interceptUpdate — target filtering', () => {
    it.each(['message', 'all'] as const)(
      'does not carry slash-command metadata into the next %s rewrite',
      async (target) => {
        const { middleware, mockSendUpdate } = createMiddleware(target);

        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Context compressed.' },
          _meta: { source: 'slash_command' },
        } as unknown as SessionUpdate);
        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Normal model response.' },
        } as unknown as SessionUpdate);

        await middleware.flushTurn();
        await middleware.waitForPendingRewrites();

        expect(mockSendUpdate).toHaveBeenNthCalledWith(
          3,
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'rewritten text' },
            _meta: { rewritten: true, turnIndex: 1 },
          },
          { turnIndex: 1, rewritten: true, replacesMessageText: true },
        );

        const { LlmRewriter } = await import('./LlmRewriter.js');
        const rewriter = vi.mocked(LlmRewriter).mock.results[0]?.value as {
          rewrite: ReturnType<typeof vi.fn>;
        };
        expect(rewriter.rewrite).toHaveBeenCalledWith(
          {
            thoughts: [],
            messages: ['Normal model response.'],
            hasToolCalls: false,
          },
          expect.any(AbortSignal),
        );
      },
    );

    it('should accumulate messages when target is "message"', async () => {
      const { middleware, mockSendUpdate } = createMiddleware('message');

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'msg' },
      } as unknown as SessionUpdate);

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thought' },
      } as unknown as SessionUpdate);

      // Flush and wait
      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      // Original pass-through (2) + rewritten (1)
      expect(mockSendUpdate).toHaveBeenCalledTimes(3);
    });

    it('should not accumulate thoughts when target is "message"', async () => {
      const { middleware, mockSendUpdate } = createMiddleware('message');

      // Only thought, no message — flush should produce nothing
      await middleware.interceptUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thought only' },
      } as unknown as SessionUpdate);

      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      // Only the original pass-through, no rewrite
      expect(mockSendUpdate).toHaveBeenCalledTimes(1);
    });

    it('should accumulate both when target is "both"', async () => {
      const { middleware, mockSendUpdate } = createMiddleware('all');

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'msg' },
      } as unknown as SessionUpdate);

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thought' },
      } as unknown as SessionUpdate);

      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      // 2 pass-throughs + 1 rewrite
      expect(mockSendUpdate).toHaveBeenCalledTimes(3);
    });
  });

  describe('discardTurn', () => {
    it('drops buffered automatic-turn content before the next prompt', async () => {
      const { middleware } = createMiddleware('message');

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'aborted background residue' },
      } as unknown as SessionUpdate);
      middleware.discardTurn();
      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'new prompt answer' },
      } as unknown as SessionUpdate);
      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      const { LlmRewriter } = await import('./LlmRewriter.js');
      const rewriter = vi.mocked(LlmRewriter).mock.results[0]?.value as {
        rewrite: ReturnType<typeof vi.fn>;
      };
      expect(rewriter.rewrite).toHaveBeenCalledWith(
        {
          thoughts: [],
          messages: ['new prompt answer'],
          hasToolCalls: false,
        },
        expect.any(AbortSignal),
      );
    });

    it('drops an in-flight automatic-turn rewrite before the next prompt', async () => {
      const { middleware, mockSendUpdate } = createMiddleware('message');
      const { LlmRewriter } = await import('./LlmRewriter.js');
      const rewriter = vi.mocked(LlmRewriter).mock.results[0]?.value as {
        rewrite: ReturnType<typeof vi.fn>;
      };
      let resolveRewrite!: (value: string) => void;
      rewriter.rewrite.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            resolveRewrite = resolve;
          }),
      );

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'automatic turn answer' },
      } as unknown as SessionUpdate);
      await middleware.flushTurn();
      const rewriteSignal = rewriter.rewrite.mock.calls[0][1] as AbortSignal;
      middleware.discardTurn();
      expect(rewriteSignal.aborted).toBe(true);
      resolveRewrite('late automatic rewrite');
      await middleware.waitForPendingRewrites();

      expect(mockSendUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('flushTurn — tool_call boundary', () => {
    it('commits rewrite context only after successful delivery', async () => {
      const { LlmRewriter } = await import('./LlmRewriter.js');
      const sendUpdate = vi.fn().mockImplementation(async (update) => {
        if (update._meta?.rewritten === true) {
          const rewriter = vi.mocked(LlmRewriter).mock.results[0]?.value as {
            commitOutput: ReturnType<typeof vi.fn>;
          };
          expect(rewriter.commitOutput).not.toHaveBeenCalled();
        }
      });
      const { middleware } = createMiddleware('message', sendUpdate);
      const rewriter = vi.mocked(LlmRewriter).mock.results[0]?.value as {
        commitOutput: ReturnType<typeof vi.fn>;
      };

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'main answer' },
      } as unknown as SessionUpdate);
      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      expect(rewriter.commitOutput).toHaveBeenCalledWith('rewritten text');
    });

    it('does not commit rewrite context when delivery fails', async () => {
      const sendUpdate = vi.fn().mockImplementation(async (update) => {
        if (update._meta?.rewritten === true) {
          throw new Error('delivery failed');
        }
      });
      const { middleware } = createMiddleware('message', sendUpdate);
      const { LlmRewriter } = await import('./LlmRewriter.js');
      const rewriter = vi.mocked(LlmRewriter).mock.results[0]?.value as {
        commitOutput: ReturnType<typeof vi.fn>;
      };

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'main answer' },
      } as unknown as SessionUpdate);
      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      expect(rewriter.commitOutput).not.toHaveBeenCalled();
    });

    it('should flush before passing through tool_call', async () => {
      const { middleware, mockSendUpdate } = createMiddleware();

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'before tool' },
      } as unknown as SessionUpdate);

      await middleware.interceptUpdate({
        sessionUpdate: 'tool_call',
        callId: '123',
      } as unknown as SessionUpdate);

      await middleware.waitForPendingRewrites();

      // pass-through msg + tool_call + rewrite
      expect(mockSendUpdate).toHaveBeenCalledTimes(3);
    });
  });

  describe('waitForPendingRewrites', () => {
    it('should wait for multiple pending rewrites', async () => {
      const { middleware, mockSendUpdate } = createMiddleware();

      // Simulate 3 turns
      for (let i = 0; i < 3; i++) {
        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `turn ${i}` },
        } as unknown as SessionUpdate);
        await middleware.flushTurn();
      }

      await middleware.waitForPendingRewrites();

      // 3 pass-throughs + 3 rewrites
      expect(mockSendUpdate).toHaveBeenCalledTimes(6);
    });

    it('should be safe to call when no rewrites are pending', async () => {
      const { middleware } = createMiddleware();
      await expect(
        middleware.waitForPendingRewrites(),
      ).resolves.toBeUndefined();
    });
  });

  describe('rewrite metadata', () => {
    it('keeps prompt ownership in callback context instead of wire metadata', async () => {
      const { middleware, mockSendUpdate } = createMiddleware(
        'message',
        undefined,
        () => 'prompt-a',
      );
      const original = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'raw answer' },
      } as unknown as SessionUpdate;

      await middleware.interceptUpdate(original);
      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      expect(mockSendUpdate.mock.calls).toEqual([
        [
          original,
          {
            ownerPromptId: 'prompt-a',
            turnIndex: 1,
            rewritten: false,
            replacesMessageText: true,
          },
        ],
        [
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'rewritten text' },
            _meta: { rewritten: true, turnIndex: 1 },
          },
          {
            ownerPromptId: 'prompt-a',
            turnIndex: 1,
            rewritten: true,
            replacesMessageText: true,
          },
        ],
      ]);
    });

    it('should emit rewritten message with _meta.rewritten=true', async () => {
      const { middleware, mockSendUpdate } = createMiddleware();

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'content' },
      } as unknown as SessionUpdate);

      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      const rewriteCall = mockSendUpdate.mock.calls.find(
        (call: unknown[]) =>
          (call[0] as Record<string, unknown>)['_meta'] !== undefined,
      );
      expect(rewriteCall).toBeDefined();
      const meta = (rewriteCall![0] as Record<string, unknown>)[
        '_meta'
      ] as Record<string, unknown>;
      expect(meta['rewritten']).toBe(true);
      expect(meta['turnIndex']).toBe(1);
    });

    it('preserves background discrete metadata on rewritten messages', async () => {
      const { middleware, mockSendUpdate } = createMiddleware('message');

      await middleware.interceptUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'background response' },
        _meta: {
          source: 'background_notification_response',
          qwenDiscreteMessage: true,
          backgroundTask: {
            taskId: 'monitor-1',
            status: 'completed',
            kind: 'monitor',
            toolUseId: 'tool-1',
          },
          customTraceId: 'trace-1',
        },
      } as unknown as SessionUpdate);

      await middleware.flushTurn();
      await middleware.waitForPendingRewrites();

      const rewriteCall = mockSendUpdate.mock.calls.find(
        (call: unknown[]) =>
          (
            (call[0] as Record<string, unknown>)['_meta'] as
              | Record<string, unknown>
              | undefined
          )?.['rewritten'] === true,
      );
      expect(rewriteCall).toBeDefined();
      expect((rewriteCall![0] as Record<string, unknown>)['_meta']).toEqual({
        source: 'background_notification_response',
        qwenDiscreteMessage: true,
        backgroundTask: {
          taskId: 'monitor-1',
          status: 'completed',
          kind: 'monitor',
          toolUseId: 'tool-1',
        },
        customTraceId: 'trace-1',
        rewritten: true,
        turnIndex: 1,
      });
    });
  });

  describe('timeoutMs config', () => {
    it('should use configured timeoutMs for the rewrite abort signal', async () => {
      vi.useFakeTimers();
      try {
        const capturedSignals: AbortSignal[] = [];
        const { LlmRewriter } = await import('./LlmRewriter.js');
        (
          LlmRewriter as unknown as {
            mockImplementation: (fn: unknown) => void;
          }
        ).mockImplementation(() => ({
          rewrite: vi.fn((_content: unknown, signal: AbortSignal) => {
            capturedSignals.push(signal);
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            });
          }),
        }));

        const mockSendUpdate = vi.fn().mockResolvedValue(undefined);
        const middleware = new MessageRewriteMiddleware(
          {} as Config,
          {
            enabled: true,
            target: 'all',
            prompt: 'test prompt',
            timeoutMs: 5_000,
          },
          mockSendUpdate,
        );

        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'content' },
        } as unknown as SessionUpdate);
        await middleware.flushTurn();

        expect(capturedSignals).toHaveLength(1);
        expect(capturedSignals[0].aborted).toBe(false);

        // Advance past the configured 5s timeout
        await vi.advanceTimersByTimeAsync(5_100);
        expect(capturedSignals[0].aborted).toBe(true);

        await middleware.waitForPendingRewrites();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should default to 30s when timeoutMs is not provided', async () => {
      vi.useFakeTimers();
      try {
        const capturedSignals: AbortSignal[] = [];
        const { LlmRewriter } = await import('./LlmRewriter.js');
        (
          LlmRewriter as unknown as {
            mockImplementation: (fn: unknown) => void;
          }
        ).mockImplementation(() => ({
          rewrite: vi.fn((_content: unknown, signal: AbortSignal) => {
            capturedSignals.push(signal);
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new Error('aborted')),
              );
            });
          }),
        }));

        const mockSendUpdate = vi.fn().mockResolvedValue(undefined);
        const middleware = new MessageRewriteMiddleware(
          {} as Config,
          { enabled: true, target: 'all', prompt: 'test prompt' },
          mockSendUpdate,
        );

        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'content' },
        } as unknown as SessionUpdate);
        await middleware.flushTurn();

        expect(capturedSignals).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(29_000);
        expect(capturedSignals[0].aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_500);
        expect(capturedSignals[0].aborted).toBe(true);

        await middleware.waitForPendingRewrites();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('waitForPendingRewrites — draining late arrivals', () => {
    it('waits for a rewrite enqueued while it is already draining', async () => {
      const { LlmRewriter } = await import('./LlmRewriter.js');
      const mockable = LlmRewriter as unknown as {
        mockImplementation: (fn: unknown) => void;
      };

      // Hand out a controllable promise per rewrite so we can complete the
      // first turn's rewrite while a second turn is enqueued mid-drain.
      const deferreds: Array<{
        resolve: (v: string) => void;
        promise: Promise<string>;
      }> = [];
      const nextDeferred = () => {
        let resolve!: (v: string) => void;
        const promise = new Promise<string>((r) => (resolve = r));
        const d = { resolve, promise };
        deferreds.push(d);
        return d;
      };

      try {
        mockable.mockImplementation(() => ({
          rewrite: vi.fn(() => nextDeferred().promise),
        }));

        const mockSendUpdate = vi.fn().mockResolvedValue(undefined);
        const middleware = new MessageRewriteMiddleware(
          {} as Config,
          { enabled: true, target: 'all', prompt: 'test prompt' },
          mockSendUpdate,
        );
        const flushMicrotasks = () =>
          new Promise((resolve) => setImmediate(resolve));

        // Turn 1 → enqueues the first pending rewrite (awaiting deferreds[0]).
        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'turn one content' },
        } as unknown as SessionUpdate);
        await middleware.flushTurn();

        // Start draining; it captures the first rewrite and awaits it.
        let drained = false;
        const waitPromise = middleware.waitForPendingRewrites().then(() => {
          drained = true;
        });

        // Turn 2 lands *during* the drain → enqueues a second pending rewrite.
        await middleware.interceptUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'turn two content' },
        } as unknown as SessionUpdate);
        await middleware.flushTurn();

        // Complete only the first rewrite.
        deferreds[0].resolve('rewritten one');
        await flushMicrotasks();
        await flushMicrotasks();

        // The second rewrite is still pending, so the drain must not be done.
        // Pre-fix, waitForPendingRewrites snapshotted only the first rewrite
        // and returned here, dropping the second.
        expect(drained).toBe(false);

        // Complete the second rewrite; the drain now resolves and both
        // rewritten messages have been emitted.
        deferreds[1].resolve('rewritten two');
        await waitPromise;
        expect(drained).toBe(true);

        const rewriteCalls = mockSendUpdate.mock.calls.filter(
          (call: unknown[]) =>
            (
              (call[0] as Record<string, unknown>)['_meta'] as
                | Record<string, unknown>
                | undefined
            )?.['rewritten'] === true,
        );
        expect(rewriteCalls).toHaveLength(2);
      } finally {
        // Restore the default mock so later runs are unaffected.
        mockable.mockImplementation(() => ({
          rewrite: vi.fn().mockResolvedValue('rewritten text'),
        }));
      }
    });
  });
});
