/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalIdleTracker } from './terminalIdleTracker.js';

describe('TerminalIdleTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits for the deadline when no output has been observed', async () => {
    vi.useFakeTimers();
    const tracker = new TerminalIdleTracker();
    let completed = false;

    const wait = tracker.wait(1000, 100).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(completed).toBe(true);
  });

  it('returns after first output has been idle for the requested duration', async () => {
    vi.useFakeTimers();
    const tracker = new TerminalIdleTracker();
    let completed = false;

    const wait = tracker.wait(1000, 100).then(() => {
      completed = true;
    });

    await vi.advanceTimersByTimeAsync(50);
    tracker.markOutput();
    await vi.advanceTimersByTimeAsync(99);
    expect(completed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await wait;
    expect(completed).toBe(true);
  });
});
