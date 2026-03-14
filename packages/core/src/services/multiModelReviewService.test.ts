/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MultiModelReviewService,
  type ModelReviewResult,
} from './multiModelReviewService.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from '../models/types.js';
import { AuthType } from '../core/contentGenerator.js';

// Mock createContentGenerator
vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const mod =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return {
    ...mod,
    createContentGenerator: vi.fn(),
  };
});

import { createContentGenerator } from '../core/contentGenerator.js';

const mockedCreateContentGenerator = vi.mocked(createContentGenerator);

function makeModel(id: string): ResolvedModelConfig {
  return {
    id,
    name: id,
    authType: AuthType.USE_OPENAI,
    baseUrl: 'https://api.openai.com/v1',
    generationConfig: {},
    capabilities: {},
  };
}

function makeGeneratorResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
  };
}

describe('MultiModelReviewService', () => {
  let config: Config;
  let service: MultiModelReviewService;

  beforeEach(() => {
    vi.clearAllMocks();
    config = {} as Config;
    service = new MultiModelReviewService(config);
  });

  describe('collectReviews', () => {
    it('should collect reviews from multiple models in parallel', async () => {
      const models = [makeModel('model-a'), makeModel('model-b')];

      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi
          .fn()
          .mockResolvedValue(makeGeneratorResponse('Review from A')),
      } as any);
      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi
          .fn()
          .mockResolvedValue(makeGeneratorResponse('Review from B')),
      } as any);

      const result = await service.collectReviews('diff content', models);

      expect(result.modelResults).toHaveLength(2);
      expect(result.modelResults[0].modelId).toBe('model-a');
      expect(result.modelResults[0].reviewText).toBe('Review from A');
      expect(result.modelResults[1].modelId).toBe('model-b');
      expect(result.modelResults[1].reviewText).toBe('Review from B');
      expect(result.diff).toBe('diff content');
    });

    it('should handle partial failures gracefully', async () => {
      const models = [makeModel('model-a'), makeModel('model-b')];

      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi
          .fn()
          .mockResolvedValue(makeGeneratorResponse('Review from A')),
      } as any);
      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi
          .fn()
          .mockRejectedValue(new Error('API key invalid')),
      } as any);

      const result = await service.collectReviews('diff content', models);

      // Only successful results are returned
      expect(result.modelResults).toHaveLength(1);
      expect(result.modelResults[0].modelId).toBe('model-a');
    });

    it('should return empty results when all models fail', async () => {
      const models = [makeModel('model-a'), makeModel('model-b')];

      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi.fn().mockRejectedValue(new Error('fail 1')),
      } as any);
      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi.fn().mockRejectedValue(new Error('fail 2')),
      } as any);

      const result = await service.collectReviews('diff content', models);

      expect(result.modelResults).toHaveLength(0);
    });

    it('should treat empty responses as errors', async () => {
      const models = [makeModel('model-a')];

      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi.fn().mockResolvedValue(makeGeneratorResponse('')),
      } as any);

      const result = await service.collectReviews('diff content', models);

      expect(result.modelResults).toHaveLength(0);
    });

    it('should respect abort signal', async () => {
      const models = [makeModel('model-a')];
      const controller = new AbortController();
      controller.abort();

      const result = await service.collectReviews(
        'diff content',
        models,
        controller.signal,
      );

      // Aborted tasks should be treated as errors
      expect(result.modelResults).toHaveLength(0);
    });
  });

  describe('arbitrateIndependently', () => {
    it('should produce arbitrated report from collected reviews', async () => {
      const collected = {
        modelResults: [
          { modelId: 'model-a', reviewText: 'Found bug X' },
          { modelId: 'model-b', reviewText: 'Found bug Y' },
        ] as ModelReviewResult[],
        diff: 'some diff',
      };
      const arbitrator = makeModel('arbitrator');

      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi
          .fn()
          .mockResolvedValue(
            makeGeneratorResponse('Unified report: bugs X and Y'),
          ),
      } as any);

      const result = await service.arbitrateIndependently(
        collected,
        arbitrator,
      );

      expect(result.report).toBe('Unified report: bugs X and Y');
    });

    it('should throw when arbitrator returns empty response', async () => {
      const collected = {
        modelResults: [
          { modelId: 'model-a', reviewText: 'Found bug X' },
        ] as ModelReviewResult[],
        diff: 'some diff',
      };
      const arbitrator = makeModel('arbitrator');

      mockedCreateContentGenerator.mockResolvedValueOnce({
        generateContent: vi.fn().mockResolvedValue(makeGeneratorResponse('')),
      } as any);

      await expect(
        service.arbitrateIndependently(collected, arbitrator),
      ).rejects.toThrow(/empty response/i);
    });
  });

  describe('buildSessionArbitrationPrompt', () => {
    it('should build prompt containing all model reviews but not the diff', () => {
      const collected = {
        modelResults: [
          { modelId: 'model-a', reviewText: 'Review A content' },
          { modelId: 'model-b', reviewText: 'Review B content' },
        ] as ModelReviewResult[],
        diff: 'the diff',
      };

      const prompt = service.buildSessionArbitrationPrompt(collected);

      expect(prompt).toContain('Review by model-a');
      expect(prompt).toContain('Review A content');
      expect(prompt).toContain('Review by model-b');
      expect(prompt).toContain('Review B content');
      // Diff content is excluded because the session model already has it in context
      expect(prompt).not.toContain('<diff>');
      expect(prompt).toContain('already available in context');
    });
  });
});
