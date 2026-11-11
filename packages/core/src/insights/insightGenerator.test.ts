/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import type { ModelStreamRequest } from '../provider/modelStreamRequest.js';
import type { AggregatedData } from './types.js';
import { generateInsightResults } from './insightGenerator.js';

function makeAggregatedData(): AggregatedData {
  return {
    totalSessions: 3,
    totalMessages: 30,
    totalUserMessages: 12,
    dateRange: {
      start: Date.UTC(2026, 0, 1),
      end: Date.UTC(2026, 0, 2),
    },
    topicCounts: new Map([
      ['testing', 2],
      ['debugging', 1],
    ]),
    languageCounts: new Map([['typescript', 3]]),
    intentCounts: new Map([['fix', 2]]),
    hourlyDistribution: Array.from({ length: 24 }, (_, hour) =>
      hour === 10 ? 3 : 0,
    ),
    dailyDistribution: new Map([['2026-01-02', 3]]),
    complexityDistribution: { low: 1, medium: 1, high: 1 },
  };
}

describe('generateInsightResults', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes all seven report sections through select and inference with the selected model', async () => {
    const selectedModel = {
      key: 'provider-selected',
      source: 'fixture-provider',
      limits: { maxOutputTokens: 2048 },
    };
    const select = vi.fn(async () => ({
      model: selectedModel,
      config: { reasoning: { effort: 'none' } },
    }));
    const results = [
      'summary',
      {
        topics: [
          { name: 'testing', count: 2, description: 'Focused on tests.' },
        ],
      },
      { languages: [{ name: 'typescript', count: 3, percentage: 100 }] },
      'activity patterns',
      { tips: ['Batch related fixes.'] },
      'trends',
      {
        whatsWorking: 'Consistent TypeScript work.',
        whatsHindering: 'Few sessions.',
        quickWins: ['Add focused tests.'],
        ambitiousWorkflows: ['Automate reports.'],
      },
    ];
    const inference = vi.fn(async (_request: ModelStreamRequest) => {
      const result = results.shift();
      return {
        completed: Promise.resolve({
          stopReason: 'end_turn',
          blocks: [
            {
              type: 'text',
              text:
                typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
        }),
      };
    });
    const modelProvider = {
      listModels: vi.fn(async () => [
        { ...selectedModel, key: 'fixture-provider/session-model' },
        selectedModel,
      ]),
      setMainModel: vi.fn(),
      select,
      inference,
    };
    const config = {
      getSessionId: () => 'report-session',
      getModelRequestIdentity: () => 'test-account',
      getModel: () => 'fixture-provider/session-model',
      isConfiguredCustomProviderModelKey: () => true,
      getModelProviderManager: () => modelProvider,
    } as unknown as Config;
    const progress = vi.fn();
    const result = await generateInsightResults(
      makeAggregatedData(),
      config,
      new AbortController().signal,
      progress,
    );
    expect(select).toHaveBeenCalledTimes(7);
    expect(inference).toHaveBeenCalledTimes(7);
    for (let i = 0; i < 7; i++) {
      expect(select.mock.calls[i]).toEqual([{ purpose: 'insights' }]);
      expect(select.mock.invocationCallOrder[i]).toBeLessThan(
        inference.mock.invocationCallOrder[i],
      );
      expect(inference.mock.calls[i][0]).toMatchObject({
        resolution: {
          model: selectedModel,
          config: { reasoning: { effort: 'none' } },
        },
        qoder: { identity: { sessionId: 'report-session' } },
      });
    }
    expect(result.summary).toBe('summary');
    expect(result.atAGlance.quickWins).toEqual(['Add focused tests.']);
    expect(inference.mock.calls[6][0].prompt.messages[1].content).toContain(
      'SUMMARY:\nsummary',
    );
    expect(inference.mock.calls[6][0].prompt.messages[1].content).toContain(
      'TOP TOPICS:\n- testing: Focused on tests.',
    );
    expect(progress.mock.calls).toEqual(
      Array.from({ length: 7 }, (_, i) => [i + 1, 7]),
    );
  });
});
