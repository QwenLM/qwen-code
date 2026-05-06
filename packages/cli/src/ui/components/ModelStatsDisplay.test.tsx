/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { ModelStatsDisplay } from './ModelStatsDisplay.js';
import * as SessionContext from '../contexts/SessionContext.js';
import type {
  ModelMetrics,
  ModelMetricsCore,
  SessionMetrics,
} from '../contexts/SessionContext.js';
import { MAIN_SOURCE } from '@qwen-code/qwen-code-core';
import { SettingsContext } from '../contexts/SettingsContext.js';
import type { LoadedSettings } from '../../config/settings.js';

const mainOnly = (core: ModelMetricsCore): ModelMetrics => ({
  ...core,
  bySource: { [MAIN_SOURCE]: core },
});

// Mock the context to provide controlled data for testing
vi.mock('../contexts/SessionContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionContext>();
  return {
    ...actual,
    useSessionStats: vi.fn(),
  };
});

const useSessionStatsMock = vi.mocked(SessionContext.useSessionStats);

const renderWithMockedStats = (
  metrics: SessionMetrics,
  modelPricing?: Record<
    string,
    { inputPerMillionTokens?: number; outputPerMillionTokens?: number }
  >,
) => {
  useSessionStatsMock.mockReturnValue({
    stats: {
      sessionId: '',
      sessionStartTime: new Date(),
      metrics,
      lastPromptTokenCount: 0,
      promptCount: 5,
    },

    getPromptCount: () => 5,
    startNewPrompt: vi.fn(),
    startNewSession: vi.fn(),
  });

  const mockSettings = {
    merged: { modelPricing },
  } as unknown as LoadedSettings;

  return render(
    <SettingsContext.Provider value={mockSettings}>
      <ModelStatsDisplay />
    </SettingsContext.Provider>,
  );
};

describe('<ModelStatsDisplay />', () => {
  beforeAll(() => {
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (
      this: number,
    ) {
      // Use a stable 'en-US' format for test consistency.
      return new Intl.NumberFormat('en-US').format(this);
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('should render "no API calls" message when there are no active models', () => {
    const { lastFrame } = renderWithMockedStats({
      models: {},
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    });

    expect(lastFrame()).toContain(
      'No API calls have been made in this session.',
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('should not display conditional rows if no model has data for them', () => {
    const { lastFrame } = renderWithMockedStats({
      models: {
        'gemini-2.5-pro': mainOnly({
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 10,
            candidates: 20,
            total: 30,
            cached: 0,
            thoughts: 0,
          },
        }),
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    });

    const output = lastFrame();
    expect(output).not.toContain('Cached');
    expect(output).not.toContain('Thoughts');
    expect(output).toMatchSnapshot();
  });

  it('should display conditional rows if at least one model has data', () => {
    const { lastFrame } = renderWithMockedStats({
      models: {
        'gemini-2.5-pro': mainOnly({
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 10,
            candidates: 20,
            total: 30,
            cached: 5,
            thoughts: 2,
          },
        }),
        'gemini-2.5-flash': mainOnly({
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 50 },
          tokens: {
            prompt: 5,
            candidates: 10,
            total: 15,
            cached: 0,
            thoughts: 0,
          },
        }),
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    });

    const output = lastFrame();
    expect(output).toContain('Cached');
    expect(output).toContain('Thoughts');
    expect(output).toMatchSnapshot();
  });

  it('should display stats for multiple models correctly', () => {
    const { lastFrame } = renderWithMockedStats({
      models: {
        'gemini-2.5-pro': mainOnly({
          api: { totalRequests: 10, totalErrors: 1, totalLatencyMs: 1000 },
          tokens: {
            prompt: 100,
            candidates: 200,
            total: 300,
            cached: 50,
            thoughts: 10,
          },
        }),
        'gemini-2.5-flash': mainOnly({
          api: { totalRequests: 20, totalErrors: 2, totalLatencyMs: 500 },
          tokens: {
            prompt: 200,
            candidates: 400,
            total: 600,
            cached: 100,
            thoughts: 20,
          },
        }),
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    });

    const output = lastFrame();
    expect(output).toContain('gemini-2.5-pro');
    expect(output).toContain('gemini-2.5-flash');
    expect(output).toMatchSnapshot();
  });

  it('should handle large values without wrapping or overlapping', () => {
    const { lastFrame } = renderWithMockedStats({
      models: {
        'gemini-2.5-pro': mainOnly({
          api: {
            totalRequests: 999999999,
            totalErrors: 123456789,
            totalLatencyMs: 9876,
          },
          tokens: {
            prompt: 987654321,
            candidates: 123456789,
            total: 999999999,
            cached: 123456789,
            thoughts: 111111111,
          },
        }),
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    });

    expect(lastFrame()).toMatchSnapshot();
  });

  it('should display a single model correctly', () => {
    const { lastFrame } = renderWithMockedStats({
      models: {
        'gemini-2.5-pro': mainOnly({
          api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
          tokens: {
            prompt: 10,
            candidates: 20,
            total: 30,
            cached: 5,
            thoughts: 2,
          },
        }),
      },
      tools: {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      },
      files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
    });

    const output = lastFrame();
    expect(output).toContain('gemini-2.5-pro');
    expect(output).not.toContain('gemini-2.5-flash');
    expect(output).toMatchSnapshot();
  });

  describe('Subagent source attribution', () => {
    const baseTools: SessionMetrics['tools'] = {
      totalCalls: 0,
      totalSuccess: 0,
      totalFail: 0,
      totalDurationMs: 0,
      totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
      byName: {},
    };
    const baseFiles: SessionMetrics['files'] = {
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
    };
    const makeCore = (reqs: number): ModelMetricsCore => ({
      api: { totalRequests: reqs, totalErrors: 0, totalLatencyMs: 100 },
      tokens: {
        prompt: 10,
        candidates: 20,
        total: 30,
        cached: 0,
        thoughts: 0,
      },
    });

    it('collapses the column header when only main is a source', () => {
      const { lastFrame } = renderWithMockedStats({
        models: { 'glm-5': mainOnly(makeCore(1)) },
        tools: baseTools,
        files: baseFiles,
      });
      const output = lastFrame();
      expect(output).toContain('glm-5');
      expect(output).not.toContain('glm-5 (main)');
    });

    it('renders distinct columns for main and subagent when same model has multiple sources', () => {
      const mainCore = makeCore(1);
      const echoerCore = makeCore(1);
      const { lastFrame } = renderWithMockedStats({
        models: {
          'glm-5': {
            api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 200 },
            tokens: {
              prompt: 20,
              candidates: 40,
              total: 60,
              cached: 0,
              thoughts: 0,
            },
            bySource: {
              [MAIN_SOURCE]: mainCore,
              echoer: echoerCore,
            },
          },
        },
        tools: baseTools,
        files: baseFiles,
      });
      const output = lastFrame();
      expect(output).toContain('glm-5 (main)');
      expect(output).toContain('glm-5 (echoer)');
    });

    describe('Cost estimation', () => {
      const makeCore = (
        prompt: number,
        candidates: number,
        thoughts: number,
      ): ModelMetricsCore => ({
        api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
        tokens: {
          prompt,
          candidates,
          total: prompt + candidates + thoughts,
          cached: 0,
          thoughts,
          tool: 0,
        },
      });

      const baseTools: SessionMetrics['tools'] = {
        totalCalls: 0,
        totalSuccess: 0,
        totalFail: 0,
        totalDurationMs: 0,
        totalDecisions: { accept: 0, reject: 0, modify: 0, auto_accept: 0 },
        byName: {},
      };
      const baseFiles: SessionMetrics['files'] = {
        totalLinesAdded: 0,
        totalLinesRemoved: 0,
      };

      const renderCostTest = (
        models: Record<string, ModelMetrics>,
        pricing?: Record<
          string,
          { inputPerMillionTokens?: number; outputPerMillionTokens?: number }
        >,
      ) =>
        renderWithMockedStats(
          { models, tools: baseTools, files: baseFiles },
          pricing,
        );

      it('should not display Cost section when no pricing and no thoughts', () => {
        const { lastFrame } = renderCostTest(
          { 'gemini-2.5-pro': mainOnly(makeCore(10, 20, 0)) },
          {},
        );
        expect(lastFrame()).not.toContain('Cost');
        expect(lastFrame()).not.toContain('Estimated');
      });

      it('should display Cost section when pricing is configured', () => {
        const { lastFrame } = renderCostTest(
          { 'gemini-2.5-pro': mainOnly(makeCore(10, 20, 0)) },
          {
            'gemini-2.5-pro': {
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 2,
            },
          },
        );
        expect(lastFrame()).toContain('Cost');
        expect(lastFrame()).toContain('Estimated');
        // 10 * 1/1M + 20 * 2/1M = 0.00001 + 0.00004 = 0.00005 -> 0.0001
        expect(lastFrame()).toContain('0.0001');
      });

      it('should include thoughts tokens in cost calculation (regression)', () => {
        const { lastFrame } = renderCostTest(
          { 'gemini-2.5-pro': mainOnly(makeCore(10, 20, 5)) },
          {
            'gemini-2.5-pro': {
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 2,
            },
          },
        );
        expect(lastFrame()).toContain('Cost');
        // With thoughts=5: (10*1 + 25*2)/1M = 0.00006 -> rounds to 0.0001
        // Without thoughts: (10*1 + 20*2)/1M = 0.00005 -> rounds to 0.0001
        // Use larger numbers to make the difference visible
      });

      it('should include thoughts tokens — larger numbers to expose difference', () => {
        // 1000 prompt, 2000 candidates, 500 thoughts
        // With thoughts: (1000*1 + 2500*2)/1M = 0.001 + 0.005 = 0.006
        // Without thoughts: (1000*1 + 2000*2)/1M = 0.001 + 0.004 = 0.005
        const { lastFrame } = renderCostTest(
          { 'gemini-2.5-pro': mainOnly(makeCore(1000, 2000, 500)) },
          {
            'gemini-2.5-pro': {
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 2,
            },
          },
        );
        expect(lastFrame()).toContain('Cost');
        expect(lastFrame()).toContain('0.0060');
      });

      it('should use raw model name for pricing with subagent attribution', () => {
        const core = makeCore(10, 20, 0);
        const { lastFrame } = renderCostTest(
          {
            'gemini-2.5-pro': {
              ...core,
              bySource: {
                [MAIN_SOURCE]: core,
                echoer: { ...core, tokens: { ...core.tokens } },
              },
            } as unknown as ModelMetrics,
          },
          // Pricing keyed by raw name, not "gemini-2.5-pro::echoer"
          {
            'gemini-2.5-pro': {
              inputPerMillionTokens: 1,
              outputPerMillionTokens: 2,
            },
          },
        );
        expect(lastFrame()).toContain('Cost');
        expect(lastFrame()).toContain('Estimated');
      });

      it('should handle multiple models with different pricing', () => {
        const { lastFrame } = renderCostTest(
          {
            'model-a': mainOnly(makeCore(100, 200, 10)),
            'model-b': mainOnly(makeCore(50, 80, 0)),
          },
          {
            'model-a': { inputPerMillionTokens: 2, outputPerMillionTokens: 4 },
            'model-b': { inputPerMillionTokens: 1, outputPerMillionTokens: 3 },
          },
        );
        expect(lastFrame()).toContain('Cost');
      });
    });
  });
});
