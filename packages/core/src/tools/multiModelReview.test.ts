/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MultiModelReviewTool } from './multiModelReview.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig, AvailableModel } from '../models/types.js';
import { AuthType } from '../core/contentGenerator.js';

// Mock the service
vi.mock('../services/multiModelReviewService.js', () => ({
  MultiModelReviewService: vi.fn().mockImplementation(() => ({
    collectReviews: vi.fn(),
    arbitrateIndependently: vi.fn(),
    buildSessionArbitrationPrompt: vi.fn(),
  })),
}));

import { MultiModelReviewService } from '../services/multiModelReviewService.js';

const MockedService = vi.mocked(MultiModelReviewService);

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

function makeConfig(overrides: {
  reviewModels?: ResolvedModelConfig[];
  arbitratorModel?: ResolvedModelConfig;
  allConfiguredModels?: AvailableModel[];
}): Config {
  return {
    getReviewModels: vi.fn().mockReturnValue(overrides.reviewModels ?? []),
    getArbitratorModel: vi.fn().mockReturnValue(overrides.arbitratorModel),
    getAllConfiguredModels: vi
      .fn()
      .mockReturnValue(overrides.allConfiguredModels ?? []),
  } as unknown as Config;
}

describe('MultiModelReviewTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return guidance when fewer than 2 models configured', async () => {
    const config = makeConfig({
      reviewModels: [makeModel('only-one')],
      allConfiguredModels: [],
    });
    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain(
      'Multi-model review requires at least 2 configured models',
    );
  });

  it('should return guidance when zero models configured', async () => {
    const config = makeConfig({
      reviewModels: [],
      allConfiguredModels: [],
    });
    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain(
      'Multi-model review requires at least 2 configured models',
    );
  });

  it('should list available models in guidance text', async () => {
    const config = makeConfig({
      reviewModels: [makeModel('only-one')],
      allConfiguredModels: [
        { id: 'gpt-4o', label: 'GPT-4o', authType: AuthType.USE_OPENAI },
        {
          id: 'claude-sonnet',
          label: 'Claude Sonnet',
          authType: AuthType.USE_OPENAI,
        },
      ] as AvailableModel[],
    });
    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });

    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('gpt-4o');
    expect(result.llmContent).toContain('claude-sonnet');
  });

  it('should return error when all review models fail', async () => {
    const models = [makeModel('model-a'), makeModel('model-b')];
    const config = makeConfig({ reviewModels: models });

    const serviceInstance = {
      collectReviews: vi.fn().mockResolvedValue({
        modelResults: [],
        failedModels: [
          { modelId: 'model-a', reviewText: '', error: 'timeout' },
          { modelId: 'model-b', reviewText: '', error: 'rate limit' },
        ],
        diff: 'some diff',
      }),
      arbitrateIndependently: vi.fn(),
      buildSessionArbitrationPrompt: vi.fn(),
    };
    MockedService.mockImplementation(() => serviceInstance as any);

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    const text = Array.isArray(result.llmContent)
      ? result.llmContent[0].text
      : result.llmContent;
    expect(text).toContain('All review models failed');
    expect(text).toContain('model-a');
    expect(text).toContain('timeout');
    expect(result.returnDisplay).toContain('model-a');
    expect(result.returnDisplay).toContain('model-b');
  });

  it('should return independent arbitration result when arbitrator is configured', async () => {
    const models = [makeModel('model-a'), makeModel('model-b')];
    const arbitrator = makeModel('arbitrator');
    const config = makeConfig({
      reviewModels: models,
      arbitratorModel: arbitrator,
    });

    const serviceInstance = {
      collectReviews: vi.fn().mockResolvedValue({
        modelResults: [
          { modelId: 'model-a', reviewText: 'Review A' },
          { modelId: 'model-b', reviewText: 'Review B' },
        ],
        failedModels: [],
        diff: 'some diff',
      }),
      arbitrateIndependently: vi.fn().mockResolvedValue({
        report: 'Final unified report',
      }),
      buildSessionArbitrationPrompt: vi.fn(),
    };
    MockedService.mockImplementation(() => serviceInstance as any);

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.returnDisplay).toContain('Multi-model review complete');
    const text = Array.isArray(result.llmContent)
      ? result.llmContent[0].text
      : result.llmContent;
    expect(text).toContain('Final unified report');
    expect(text).toContain('model-a, model-b');
    expect(text).toContain('arbitrator');
  });

  it('should fall back to session arbitration when arbitrator fails', async () => {
    const models = [makeModel('model-a'), makeModel('model-b')];
    const arbitrator = makeModel('arbitrator');
    const config = makeConfig({
      reviewModels: models,
      arbitratorModel: arbitrator,
    });

    const serviceInstance = {
      collectReviews: vi.fn().mockResolvedValue({
        modelResults: [
          { modelId: 'model-a', reviewText: 'Review A' },
          { modelId: 'model-b', reviewText: 'Review B' },
        ],
        failedModels: [],
        diff: 'some diff',
      }),
      arbitrateIndependently: vi
        .fn()
        .mockRejectedValue(new Error('arbitrator down')),
      buildSessionArbitrationPrompt: vi
        .fn()
        .mockReturnValue('arbitration prompt'),
    };
    MockedService.mockImplementation(() => serviceInstance as any);

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.returnDisplay).toContain('Collected');
    const text = Array.isArray(result.llmContent)
      ? result.llmContent[0].text
      : result.llmContent;
    expect(text).toContain("Arbitrator model 'arbitrator' failed");
    expect(text).toContain('session model');
  });

  it('should use session arbitration when no arbitrator configured', async () => {
    const models = [makeModel('model-a'), makeModel('model-b')];
    const config = makeConfig({ reviewModels: models });

    const serviceInstance = {
      collectReviews: vi.fn().mockResolvedValue({
        modelResults: [
          { modelId: 'model-a', reviewText: 'Review A' },
          { modelId: 'model-b', reviewText: 'Review B' },
        ],
        failedModels: [],
        diff: 'some diff',
      }),
      arbitrateIndependently: vi.fn(),
      buildSessionArbitrationPrompt: vi
        .fn()
        .mockReturnValue('session arbitration prompt'),
    };
    MockedService.mockImplementation(() => serviceInstance as any);

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.returnDisplay).toContain('Collected');
    const text = Array.isArray(result.llmContent)
      ? result.llmContent[0].text
      : result.llmContent;
    expect(text).toContain('Please act as the arbitrator');
  });

  it('should skip arbitration when only 1 model succeeds', async () => {
    const models = [makeModel('model-a'), makeModel('model-b')];
    const config = makeConfig({ reviewModels: models });

    const serviceInstance = {
      collectReviews: vi.fn().mockResolvedValue({
        modelResults: [{ modelId: 'model-a', reviewText: 'Only review' }],
        failedModels: [
          { modelId: 'model-b', reviewText: '', error: 'timeout' },
        ],
        diff: 'some diff',
      }),
      arbitrateIndependently: vi.fn(),
      buildSessionArbitrationPrompt: vi.fn(),
    };
    MockedService.mockImplementation(() => serviceInstance as any);

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    const text = Array.isArray(result.llmContent)
      ? result.llmContent[0].text
      : result.llmContent;
    expect(text).toContain('Only review');
    expect(text).toContain('Arbitration skipped');
    expect(serviceInstance.arbitrateIndependently).not.toHaveBeenCalled();
    expect(
      serviceInstance.buildSessionArbitrationPrompt,
    ).not.toHaveBeenCalled();
  });

  it('should surface arbitrator resolution failure in output', async () => {
    const models = [makeModel('model-a'), makeModel('model-b')];
    const config = {
      getReviewModels: vi.fn().mockReturnValue(models),
      getArbitratorModel: vi.fn().mockImplementation(() => {
        throw new Error("Arbitrator model 'bad' not found");
      }),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
    } as unknown as Config;

    const serviceInstance = {
      collectReviews: vi.fn().mockResolvedValue({
        modelResults: [
          { modelId: 'model-a', reviewText: 'Review A' },
          { modelId: 'model-b', reviewText: 'Review B' },
        ],
        failedModels: [],
        diff: 'some diff',
      }),
      arbitrateIndependently: vi.fn(),
      buildSessionArbitrationPrompt: vi
        .fn()
        .mockReturnValue('arbitration prompt'),
    };
    MockedService.mockImplementation(() => serviceInstance as any);

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    const text = Array.isArray(result.llmContent)
      ? result.llmContent[0].text
      : result.llmContent;
    expect(text).toContain('could not be resolved');
    expect(text).toContain('falling back to session model');
  });

  it('should handle config resolution errors gracefully', async () => {
    const config = {
      getReviewModels: vi.fn().mockImplementation(() => {
        throw new Error("Model 'bad-model' not found");
      }),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
    } as unknown as Config;

    const tool = new MultiModelReviewTool(config);
    const invocation = (tool as any).createInvocation({ diff: 'some diff' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('configuration error');
  });

  describe('validateToolParams', () => {
    it('should reject empty diff', () => {
      const config = makeConfig({});
      const tool = new MultiModelReviewTool(config);

      expect(tool.validateToolParams({ diff: '' })).toBe(
        'Parameter "diff" must be a non-empty string.',
      );
    });

    it('should reject whitespace-only diff', () => {
      const config = makeConfig({});
      const tool = new MultiModelReviewTool(config);

      expect(tool.validateToolParams({ diff: '   ' })).toBe(
        'Parameter "diff" must be a non-empty string.',
      );
    });

    it('should accept valid diff', () => {
      const config = makeConfig({});
      const tool = new MultiModelReviewTool(config);

      expect(tool.validateToolParams({ diff: '+ added line' })).toBeNull();
    });
  });
});
