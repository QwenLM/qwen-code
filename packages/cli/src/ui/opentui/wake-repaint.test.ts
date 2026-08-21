/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { startWakeRepaint } from './wake-repaint.js';

describe('startWakeRepaint', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repaints when the heartbeat detects a frozen event loop', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const dispose = startWakeRepaint(repaint);

    // Normal ticks (<= threshold) do not repaint.
    vi.advanceTimersByTime(5_000);
    expect(repaint).not.toHaveBeenCalled();

    // Simulate a suspend: jump the clock well past the threshold so the gap
    // between two heartbeats exceeds it.
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(5_000);
    expect(repaint).toHaveBeenCalledTimes(1);

    dispose();
  });

  it('repaints on SIGCONT and stops after dispose', () => {
    const repaint = vi.fn();
    const dispose = startWakeRepaint(repaint);

    process.emit('SIGCONT');
    expect(repaint).toHaveBeenCalledTimes(1);

    dispose();
    process.emit('SIGCONT');
    expect(repaint).toHaveBeenCalledTimes(1);
  });
});
