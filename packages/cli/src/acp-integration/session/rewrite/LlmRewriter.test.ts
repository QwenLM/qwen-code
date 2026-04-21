/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { TurnContent, MessageRewriteConfig } from './types.js';

// Mock core to avoid Vite https resolution issue
vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Track generateContent calls
const mockGenerateContent = vi.fn().mockResolvedValue({
  candidates: [
    {
      content: {
        parts: [{ text: 'rewritten output' }],
      },
    },
  ],
});

const { LlmRewriter } = await import('./LlmRewriter.js');

function makeConfig(): Config {
  return {
    getContentGenerator: () => ({
      generateContent: mockGenerateContent,
    }),
    getModel: () => 'test-model',
  } as unknown as Config;
}

function makeTurn(messages: string[], thoughts: string[] = []): TurnContent {
  return { messages, thoughts, hasToolCalls: false };
}

describe('LlmRewriter', () => {
  beforeEach(() => {
    mockGenerateContent.mockClear();
    mockGenerateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'rewritten output' }] } }],
    });
  });

  describe('contextTurns', () => {
    it('should include last rewrite output by default (contextTurns=1)', async () => {
      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
      } as MessageRewriteConfig);

      // First call — no context
      await rewriter.rewrite(makeTurn(['first message']));
      const firstInput =
        mockGenerateContent.mock.calls[0][0].contents[0].parts[0].text;
      expect(firstInput).not.toContain('上一轮改写结果');

      // Second call — should include first rewrite output
      await rewriter.rewrite(makeTurn(['second message']));
      const secondInput =
        mockGenerateContent.mock.calls[1][0].contents[0].parts[0].text;
      expect(secondInput).toContain('上一轮改写结果');
      expect(secondInput).toContain('rewritten output');
    });

    it('should include no context when contextTurns=0', async () => {
      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
        contextTurns: 0,
      } as MessageRewriteConfig);

      await rewriter.rewrite(makeTurn(['first']));
      await rewriter.rewrite(makeTurn(['second']));

      const secondInput =
        mockGenerateContent.mock.calls[1][0].contents[0].parts[0].text;
      expect(secondInput).not.toContain('上一轮改写结果');
    });

    it('should include last N rewrites when contextTurns=N', async () => {
      mockGenerateContent
        .mockResolvedValueOnce({
          candidates: [{ content: { parts: [{ text: 'rewrite-A' }] } }],
        })
        .mockResolvedValueOnce({
          candidates: [{ content: { parts: [{ text: 'rewrite-B' }] } }],
        })
        .mockResolvedValueOnce({
          candidates: [{ content: { parts: [{ text: 'rewrite-C' }] } }],
        })
        .mockResolvedValue({
          candidates: [{ content: { parts: [{ text: 'rewrite-D' }] } }],
        });

      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
        contextTurns: 2,
      } as MessageRewriteConfig);

      await rewriter.rewrite(makeTurn(['msg1']));
      await rewriter.rewrite(makeTurn(['msg2']));
      await rewriter.rewrite(makeTurn(['msg3']));

      // 4th call — should include rewrite-B and rewrite-C (last 2), not rewrite-A
      await rewriter.rewrite(makeTurn(['msg4']));
      const input =
        mockGenerateContent.mock.calls[3][0].contents[0].parts[0].text;
      expect(input).not.toContain('rewrite-A');
      expect(input).toContain('rewrite-B');
      expect(input).toContain('rewrite-C');
    });

    it('should include all rewrites when contextTurns="all"', async () => {
      mockGenerateContent
        .mockResolvedValueOnce({
          candidates: [{ content: { parts: [{ text: 'rewrite-1' }] } }],
        })
        .mockResolvedValueOnce({
          candidates: [{ content: { parts: [{ text: 'rewrite-2' }] } }],
        })
        .mockResolvedValue({
          candidates: [{ content: { parts: [{ text: 'rewrite-3' }] } }],
        });

      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
        contextTurns: 'all',
      } as MessageRewriteConfig);

      await rewriter.rewrite(makeTurn(['msg1']));
      await rewriter.rewrite(makeTurn(['msg2']));
      await rewriter.rewrite(makeTurn(['msg3']));

      const input =
        mockGenerateContent.mock.calls[2][0].contents[0].parts[0].text;
      expect(input).toContain('rewrite-1');
      expect(input).toContain('rewrite-2');
    });
  });

  describe('model override', () => {
    it('should use rewriteConfig.model when set', async () => {
      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
        model: 'custom-rewrite-model',
      } as MessageRewriteConfig);

      await rewriter.rewrite(makeTurn(['hello']));
      expect(mockGenerateContent.mock.calls[0][0].model).toBe(
        'custom-rewrite-model',
      );
    });

    it('should fall back to config.getModel() when model is empty', async () => {
      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
      } as MessageRewriteConfig);

      await rewriter.rewrite(makeTurn(['hello']));
      expect(mockGenerateContent.mock.calls[0][0].model).toBe('test-model');
    });
  });

  describe('filtering', () => {
    it('should return null for empty input', async () => {
      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
      } as MessageRewriteConfig);

      const result = await rewriter.rewrite(makeTurn([], []));
      expect(result).toBeNull();
      expect(mockGenerateContent).not.toHaveBeenCalled();
    });

    it('should return null when LLM returns short text', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
      });

      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
      } as MessageRewriteConfig);

      const result = await rewriter.rewrite(makeTurn(['some input text here']));
      expect(result).toBeNull();
    });

    it('should not accumulate failed rewrites in history', async () => {
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: '' }] } }],
      });
      mockGenerateContent.mockResolvedValueOnce({
        candidates: [{ content: { parts: [{ text: 'second rewrite ok' }] } }],
      });

      const rewriter = new LlmRewriter(makeConfig(), {
        enabled: true,
        target: 'all',
      } as MessageRewriteConfig);

      await rewriter.rewrite(makeTurn(['first'])); // returns null
      await rewriter.rewrite(makeTurn(['second']));

      // Second call should have no context (first rewrite returned null)
      const input =
        mockGenerateContent.mock.calls[1][0].contents[0].parts[0].text;
      expect(input).not.toContain('上一轮改写结果');
    });
  });
});
