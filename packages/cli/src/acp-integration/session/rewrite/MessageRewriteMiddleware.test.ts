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
  })),
}));

// Import after mocks are set up
const { MessageRewriteMiddleware } = await import(
  './MessageRewriteMiddleware.js'
);

function createMiddleware(
  target: 'message' | 'thought' | 'all' = 'all',
  sendUpdate?: ReturnType<typeof vi.fn>,
) {
  const mockSendUpdate = sendUpdate ?? vi.fn().mockResolvedValue(undefined);
  const middleware = new MessageRewriteMiddleware(
    {} as Config,
    { enabled: true, target, prompt: 'test prompt' },
    mockSendUpdate,
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
      expect(mockSendUpdate).toHaveBeenCalledWith(msgUpdate);
    });
  });

  describe('interceptUpdate — target filtering', () => {
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

  describe('flushTurn — tool_call boundary', () => {
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
  });
});
