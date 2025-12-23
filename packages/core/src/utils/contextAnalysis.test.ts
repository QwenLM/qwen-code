/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { analyzeContextUsage } from './contextAnalysis.js';
import type { Content } from '@google/genai';
import type { ContentGenerator } from '../core/contentGenerator.js';

describe('contextAnalysis', () => {
  let mockContentGenerator: ContentGenerator;

  beforeEach(() => {
    mockContentGenerator = {
      countTokens: vi.fn(),
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(),
    } as unknown as ContentGenerator;
  });

  describe('analyzeContextUsage', () => {
    it('should count system prompt tokens', async () => {
      const systemPrompt = 'You are a helpful assistant';
      const history: Content[] = [];

      vi.mocked(mockContentGenerator.countTokens).mockResolvedValue({
        totalTokens: 100,
      });

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.systemInstructions).toBe(100);
      expect(mockContentGenerator.countTokens).toHaveBeenCalledWith({
        model: 'test-model',
        contents: [{ role: 'system', parts: [{ text: systemPrompt }] }],
      });
    });

    it('should count user messages correctly', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
        {
          role: 'user',
          parts: [{ text: 'How are you?' }],
        },
      ];

      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 50 }) // system prompt
        .mockResolvedValueOnce({ totalTokens: 10 }) // first user message
        .mockResolvedValueOnce({ totalTokens: 15 }); // second user message

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.userMessages).toBe(25);
      expect(result.breakdown.systemInstructions).toBe(50);
      expect(result.totalTokens).toBe(75);
    });

    it('should count assistant responses correctly', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
        {
          role: 'model',
          parts: [{ text: 'Hi there!' }],
        },
      ];

      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 50 }) // system prompt
        .mockResolvedValueOnce({ totalTokens: 10 }) // user message
        .mockResolvedValueOnce({ totalTokens: 20 }); // model response

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.userMessages).toBe(10);
      expect(result.breakdown.assistantResponses).toBe(20);
      expect(result.totalTokens).toBe(80);
    });

    it('should handle empty history', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [];

      vi.mocked(mockContentGenerator.countTokens).mockResolvedValue({
        totalTokens: 50,
      });

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.userMessages).toBe(0);
      expect(result.breakdown.assistantResponses).toBe(0);
      expect(result.breakdown.systemInstructions).toBe(50);
      expect(result.totalTokens).toBe(50);
    });

    it('should calculate usage percentage correctly', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      ];

      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 500 }) // system prompt
        .mockResolvedValueOnce({ totalTokens: 500 }); // user message

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000, // session limit
      );

      expect(result.totalTokens).toBe(1000);
      expect(result.sessionLimit).toBe(10000);
      expect(result.usagePercentage).toBe(10); // 1000/10000 * 100
      expect(result.remainingTokens).toBe(9000);
    });

    it('should estimate remaining exchanges', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [];

      vi.mocked(mockContentGenerator.countTokens).mockResolvedValue({
        totalTokens: 500,
      });

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.totalTokens).toBe(500);
      expect(result.remainingTokens).toBe(9500);
      // 9500 / 500 (avg per exchange) = 19
      expect(result.estimatedExchanges).toBe(19);
    });

    it('should handle cached tokens', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      ];

      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 100 }) // system prompt
        .mockResolvedValueOnce({
          totalTokens: 200,
          cachedContentTokenCount: 50,
        }); // user message with cache

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.cached).toBe(50);
      expect(result.totalTokens).toBe(300);
    });

    it('should use estimate when token counting fails', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Hello world this is a test message' }],
        },
      ];

      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 100 }) // system prompt works
        .mockRejectedValueOnce(new Error('Token counting failed')); // user message fails

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.systemInstructions).toBe(100);
      // Should have estimated tokens for user message based on JSON length
      expect(result.breakdown.userMessages).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(100);
    });

    it('should handle function/tool responses', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'function',
          parts: [{ functionResponse: { name: 'test', response: {} } }],
        },
      ];

      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 50 }) // system prompt
        .mockResolvedValueOnce({ totalTokens: 100 }); // function response

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000,
      );

      expect(result.breakdown.toolResponses).toBe(100);
      expect(result.totalTokens).toBe(150);
    });

    it('should not go below zero for remaining tokens', async () => {
      const systemPrompt = 'System prompt';
      const history: Content[] = [
        {
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      ];

      // Total tokens exceed limit
      vi.mocked(mockContentGenerator.countTokens)
        .mockResolvedValueOnce({ totalTokens: 8000 }) // system prompt
        .mockResolvedValueOnce({ totalTokens: 3000 }); // user message

      const result = await analyzeContextUsage(
        history,
        systemPrompt,
        'test-model',
        mockContentGenerator,
        10000, // limit
      );

      expect(result.totalTokens).toBe(11000);
      expect(result.remainingTokens).toBe(0); // Should be 0, not negative
      expect(result.usagePercentage).toBeGreaterThan(100);
      expect(result.estimatedExchanges).toBe(0);
    });
  });
});
