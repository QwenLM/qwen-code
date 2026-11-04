/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { act } from 'react';
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

type KeypressTestKey = { name: string };
const keypressSubscribers = new Set<(key: KeypressTestKey) => void>();

vi.mock('../contexts/KeypressContext.js', () => ({
  useKeypressContext: () => ({
    subscribe: (handler: (key: KeypressTestKey) => void) => {
      keypressSubscribers.add(handler);
    },
    unsubscribe: (handler: (key: KeypressTestKey) => void) => {
      keypressSubscribers.delete(handler);
    },
  }),
}));

function sendKey(key: KeypressTestKey) {
  act(() => {
    for (const handler of keypressSubscribers) {
      handler(key);
    }
  });
}

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

function renderSessionTab(metrics: SessionMetrics, height?: number) {
  return renderSessionTabInstance(metrics, height).lastFrame();
}

function renderSessionTabInstance(metrics: SessionMetrics, height?: number) {
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

  return render(<SessionTab height={height} />);
}

describe('<SessionTab /> generation metrics', () => {
  it('shows latest-request and weighted session timing', () => {
    const metrics = baseMetrics();
    metrics.generation = {
      timedRequests: 2,
      totalTtftMs: 800,
      totalGenerationDurationMs: 7000,
      totalThroughputOutputTokens: 300,
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
    expect(output).toContain('44.4 tok/s');
    expect(output).toContain('400ms');
    expect(output).toContain('42.9 tok/s');
  });

  it('hides the section until a timed response exists', () => {
    expect(renderSessionTab(baseMetrics())).not.toContain('Generation Metrics');
  });

  it('renders unavailable TPS for a zero generation duration', () => {
    const metrics = baseMetrics();
    metrics.generation = {
      timedRequests: 1,
      totalTtftMs: 100,
      totalGenerationDurationMs: 0,
      totalThroughputOutputTokens: 0,
      last: {
        model: 'qwen3-coder',
        ttftMs: 100,
        generationDurationMs: 0,
        outputTokens: 3,
      },
    };

    expect(renderSessionTab(metrics)).toContain('—');
  });
});

describe('<SessionTab /> height budget', () => {
  const metricsWithModel = () => {
    const metrics = baseMetrics();
    metrics.models = {
      'qwen3-coder': {
        api: {
          totalRequests: 3,
          totalErrors: 0,
          totalLatencyMs: 0,
        },
        tokens: {
          prompt: 100,
          candidates: 50,
          total: 150,
          cached: 0,
          thoughts: 0,
        },
        bySource: {},
      },
    };
    return metrics;
  };

  it('clips to the height budget and scrolls to the Tokens and Models sections', () => {
    const { lastFrame } = renderSessionTabInstance(metricsWithModel(), 10);

    expect(lastFrame()).toContain('Session ID');
    expect(lastFrame()).not.toContain('Tokens');
    expect(lastFrame()).not.toContain('qwen3-coder');
    expect(lastFrame()).toContain('Use ↑/↓ to scroll');

    sendKey({ name: 'pagedown' });
    sendKey({ name: 'pagedown' });
    sendKey({ name: 'pagedown' });

    expect(lastFrame()).not.toContain('Session ID');
    expect(lastFrame()).toContain('Tokens');
    expect(lastFrame()).toContain('qwen3-coder');

    sendKey({ name: 'pageup' });
    sendKey({ name: 'pageup' });
    sendKey({ name: 'pageup' });
    expect(lastFrame()).toContain('Session ID');
  });

  // The frame's viewport rows, without the scroll-hint row below them and
  // with the live wall-clock value masked, since it ticks between renders.
  const viewportRows = (frame: string | undefined) =>
    (frame ?? '')
      .split('\n')
      .slice(0, -1)
      .map((row) => row.replace(/(Wall Time:\s+)\S+/, '$1<t>'));

  it('scrolls one row per down/up key', () => {
    const { lastFrame } = renderSessionTabInstance(metricsWithModel(), 10);
    const top = viewportRows(lastFrame());
    expect(top.length).toBeGreaterThan(3);

    // One press moves the content by exactly one row in either direction:
    // a two-row step, or a page, would drop a second row off the top.
    sendKey({ name: 'down' });
    const oneDown = viewportRows(lastFrame());
    expect(oneDown.slice(0, -1)).toEqual(top.slice(1));

    sendKey({ name: 'down' });
    expect(viewportRows(lastFrame()).slice(0, -1)).toEqual(oneDown.slice(1));

    sendKey({ name: 'up' });
    expect(viewportRows(lastFrame())).toEqual(oneDown);
    sendKey({ name: 'up' });
    expect(viewportRows(lastFrame())).toEqual(top);
  });

  it('pages by the viewport height', () => {
    const { lastFrame } = renderSessionTabInstance(metricsWithModel(), 10);
    const top = viewportRows(lastFrame());

    sendKey({ name: 'pagedown' });
    const paged = viewportRows(lastFrame());
    expect(paged).not.toEqual(top);

    // A page is as many rows as the viewport holds: the same frame as that
    // many single-row steps, and pageup is the exact inverse.
    sendKey({ name: 'pageup' });
    expect(viewportRows(lastFrame())).toEqual(top);
    for (let i = 0; i < top.length; i++) sendKey({ name: 'down' });
    expect(viewportRows(lastFrame())).toEqual(paged);
    sendKey({ name: 'pageup' });
    expect(viewportRows(lastFrame())).toEqual(top);
  });

  it('renders everything without a scroll hint when the content fits', () => {
    const output = renderSessionTab(metricsWithModel(), 60);

    expect(output).toContain('Tokens');
    expect(output).toContain('qwen3-coder');
    expect(output).not.toContain('Use ↑/↓ to scroll');
  });

  it('is content-sized, not padded to the budget, when the content fits', () => {
    const fitted = renderSessionTab(metricsWithModel(), 60) ?? '';
    const unbudgeted = renderSessionTab(metricsWithModel()) ?? '';
    const rows = (frame: string) => frame.split('\n').length;
    expect(rows(fitted)).toBe(rows(unbudgeted));
    expect(rows(fitted)).toBeLessThan(60);
  });
});
