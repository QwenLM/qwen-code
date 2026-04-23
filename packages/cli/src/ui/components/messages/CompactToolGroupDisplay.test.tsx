/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { CompactToolGroupDisplay } from './CompactToolGroupDisplay.js';
import { ToolCallStatus } from '../../types.js';
import type { IndividualToolCallDisplay } from '../../types.js';

// ToolStatusIndicator pulls in GeminiRespondingSpinner which requires
// StreamingContext; stub it out so we can test the elapsed/timeout
// plumbing in isolation.
vi.mock('../shared/ToolStatusIndicator.js', () => ({
  ToolStatusIndicator: () => <Text>•</Text>,
  STATUS_INDICATOR_WIDTH: 2,
}));

const NOW = 1_700_000_000_000;

function shellTool(
  overrides: Partial<IndividualToolCallDisplay> = {},
): IndividualToolCallDisplay {
  return {
    callId: 'c1',
    name: 'Shell',
    description: 'sleep 10',
    status: ToolCallStatus.Executing,
    executionStartTime: NOW,
    resultDisplay: undefined,
    confirmationDetails: undefined,
    ...overrides,
  };
}

describe('<CompactToolGroupDisplay />', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces shell timeoutMs inline via ToolElapsedTime', () => {
    const tool = shellTool({
      resultDisplay: {
        ansiOutput: [],
        totalLines: 0,
        totalBytes: 0,
        timeoutMs: 30_000,
      },
    });
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />,
    );
    expect(lastFrame()).toContain('(0s · timeout 30s)');
  });

  it('falls back to quiet elapsed-only when no timeout is surfaced', () => {
    const tool = shellTool({
      resultDisplay: {
        ansiOutput: [],
        totalLines: 0,
        totalBytes: 0,
      },
    });
    const { lastFrame } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />,
    );
    // Sub-3s without a timeout budget → indicator is quiet.
    expect(lastFrame()).not.toContain('timeout');
    expect(lastFrame()).not.toContain('0s');
  });

  it('ignores non-ansi resultDisplay shapes', () => {
    const tool = shellTool({
      resultDisplay: 'plain text output',
    });
    const { lastFrame, rerender } = render(
      <CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />,
    );
    vi.advanceTimersByTime(5_000);
    rerender(<CompactToolGroupDisplay toolCalls={[tool]} contentWidth={80} />);
    // No timeout in display → legacy 3s-threshold elapsed.
    expect(lastFrame()).toContain('5s');
    expect(lastFrame()).not.toContain('timeout');
  });
});
