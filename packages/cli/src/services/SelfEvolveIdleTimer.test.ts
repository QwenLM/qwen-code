/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SelfEvolveIdleTimer } from './SelfEvolveService.js';

describe('SelfEvolveIdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts the idle deadline every time activity is refreshed', async () => {
    const onTimeout = vi.fn();
    const timer = new SelfEvolveIdleTimer(1_000, onTimeout);

    timer.refresh();
    await vi.advanceTimersByTimeAsync(900);
    timer.refresh();
    await vi.advanceTimersByTimeAsync(900);

    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('does not fire after being cleared', async () => {
    const onTimeout = vi.fn();
    const timer = new SelfEvolveIdleTimer(1_000, onTimeout);

    timer.refresh();
    timer.clear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
