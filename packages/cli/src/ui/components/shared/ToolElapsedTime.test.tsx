/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'ink-testing-library';
import { ToolCallStatus } from '../../types.js';
import { ToolElapsedTime } from './ToolElapsedTime.js';

describe('<ToolElapsedTime />', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing for non-executing status', () => {
    const { lastFrame } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Success}
        executionStartTime={NOW}
      />,
    );
    expect(lastFrame()).toBe('');
  });

  it('stays quiet for the first 3s when no timeout is set', () => {
    const { lastFrame, rerender } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
      />,
    );
    expect(lastFrame()).toBe('');

    vi.advanceTimersByTime(2_000);
    rerender(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
      />,
    );
    expect(lastFrame()).toBe('');
  });

  it('shows elapsed seconds past the 3s threshold (no timeout)', () => {
    const { lastFrame, rerender } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
      />,
    );
    vi.advanceTimersByTime(5_000);
    rerender(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
      />,
    );
    expect(lastFrame()).toContain('5s');
  });

  it('renders combined (elapsed · timeout N) from t=0 when timeout is set', () => {
    const { lastFrame } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={30_000}
      />,
    );
    expect(lastFrame()).toContain('(0s · timeout 30s)');
  });

  it('keeps fractional timeout precision', () => {
    const { lastFrame } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={5_500}
      />,
    );
    expect(lastFrame()).toContain('(0s · timeout 5.5s)');
  });

  it('advances elapsed inside the combined format', () => {
    const { lastFrame, rerender } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={30_000}
      />,
    );
    vi.advanceTimersByTime(7_000);
    rerender(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={30_000}
      />,
    );
    expect(lastFrame()).toContain('(7s · timeout 30s)');
  });

  it('formats combined output once elapsed crosses into the minute range', () => {
    const { lastFrame, rerender } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={5 * 60 * 1000}
      />,
    );
    vi.advanceTimersByTime(65_000);
    rerender(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={5 * 60 * 1000}
      />,
    );
    expect(lastFrame()).toContain('(1m 5s · timeout 5m)');
  });

  it('ignores non-positive timeouts (falls back to elapsed-only mode)', () => {
    const { lastFrame } = render(
      <ToolElapsedTime
        status={ToolCallStatus.Executing}
        executionStartTime={NOW}
        timeoutMs={0}
      />,
    );
    // With no effective timeout, sub-3s = quiet.
    expect(lastFrame()).toBe('');
  });
});
