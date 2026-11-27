/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createEventLoopYieldBudget } from './handler-support.js';

describe('stream event-loop budget', () => {
  it('batches ready events but lets another task run when the budget expires', async ({
    onTestFinished,
  }) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    onTestFinished(() => clock.mockRestore());
    const checkpoint = createEventLoopYieldBudget();
    for (let i = 0; i < 1000; i++) expect(checkpoint()).toBeUndefined();

    const seen: string[] = [];
    setImmediate(() => seen.push('consumer'));
    clock.mockReturnValue(8);
    const pause = checkpoint();
    expect(pause).toBeInstanceOf(Promise);
    await pause;
    seen.push('producer');
    expect(seen).toEqual(['consumer', 'producer']);
    // Resuming does not immediately yield again for the remaining ready events.
    expect(checkpoint()).toBeUndefined();
  });

  it('keeps each producer budget independent', async ({ onTestFinished }) => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    onTestFinished(() => clock.mockRestore());
    const first = createEventLoopYieldBudget();
    clock.mockReturnValue(4);
    const second = createEventLoopYieldBudget();
    clock.mockReturnValue(8);
    const pause = first();
    expect(pause).toBeInstanceOf(Promise);
    expect(second()).toBeUndefined();
    await pause;
    clock.mockReturnValue(12);
    expect(first()).toBeUndefined();
    await second();
  });
});
