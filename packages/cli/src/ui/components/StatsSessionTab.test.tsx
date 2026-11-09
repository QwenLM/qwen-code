/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { SessionMetrics } from '../contexts/SessionContext.js';
import * as SessionContext from '../contexts/SessionContext.js';
import { SessionTab } from './StatsSessionTab.js';

vi.mock('../contexts/SessionContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionContext>();
  return {
    ...actual,
    useSessionStats: vi.fn(),
  };
});

const useSessionStatsMock = vi.mocked(SessionContext.useSessionStats);

const baseMetrics = (): SessionMetrics => ({
  models: {},
  tools: {
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    totalDurationMs: 0,
    totalDecisions: {
      accept: 0,
      reject: 0,
      modify: 0,
      auto_accept: 0,
    },
    byName: {},
  },
  files: {
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
  },
});

function renderSessionTab(metrics: SessionMetrics) {
  useSessionStatsMock.mockReturnValue({
    stats: {
      sessionId: 'session-1',
      sessionStartTime: new Date(),
      metrics,
      lastPromptTokenCount: 0,
      promptCount: 1,
    },
    startNewSession: vi.fn(),
    getPromptCount: () => 1,
    startNewPrompt: vi.fn(),
    seedPromptCount: vi.fn(),
  });

  return render(<SessionTab />).lastFrame();
}

describe('<SessionTab /> generation metrics', () => {
  it('shows latest-request and weighted session timing', () => {
    const metrics = baseMetrics();
    metrics.generation = {
      timedRequests: 2,
      totalTtftMs: 800,
      totalGenerationDurationMs: 7000,
      totalThroughputOutputTokens: 300,
      totalTimedGenerationDurationMs: 7000,
      totalOutputSpeedTokens: 300,
      totalOutputSpeedDurationMs: 7800,
      last: {
        model: 'qwen3-coder',
        ttftMs: 342,
        generationDurationMs: 4210,
        outputTokens: 187,
      },
    };

    const output = renderSessionTab(metrics);

    expect(output).toContain('Generation Metrics');
    expect(output).toContain('qwen3-coder');
    expect(output).toContain('342ms');
    expect(output).toContain('4.2s');
    // 187 tokens over 342 ms + 4210 ms; 300 tokens over 800 ms + 7000 ms.
    expect(output).toContain('41.1 tok/s');
    expect(output).toContain('400ms');
    expect(output).toContain('38.5 tok/s');
  });

  it('hides the section until a timed response exists', () => {
    expect(renderSessionTab(baseMetrics())).not.toContain('Generation Metrics');
  });

  it('measures a single-chunk response from the request start', () => {
    const metrics = baseMetrics();
    metrics.generation = {
      timedRequests: 1,
      totalTtftMs: 100,
      totalGenerationDurationMs: 0,
      totalThroughputOutputTokens: 0,
      totalTimedGenerationDurationMs: 0,
      totalOutputSpeedTokens: 3,
      totalOutputSpeedDurationMs: 100,
      last: {
        model: 'qwen3-coder',
        ttftMs: 100,
        generationDurationMs: 0,
        outputTokens: 3,
      },
    };

    expect(renderSessionTab(metrics)).toContain('30.0 tok/s');
  });

  it('renders unavailable TPS without reported output tokens', () => {
    const metrics = baseMetrics();
    metrics.generation = {
      timedRequests: 1,
      totalTtftMs: 100,
      totalGenerationDurationMs: 400,
      totalThroughputOutputTokens: 0,
      totalTimedGenerationDurationMs: 400,
      totalOutputSpeedTokens: 0,
      totalOutputSpeedDurationMs: 0,
      last: {
        model: 'qwen3-coder',
        ttftMs: 100,
        generationDurationMs: 400,
        outputTokens: 0,
      },
    };

    const output = renderSessionTab(metrics);
    expect(output).not.toContain('tok/s');
    expect(output).toContain('—');
  });
});
