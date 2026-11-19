/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WRITER_IDLE_TIMEOUT_MS,
  resolveWriterIdleBudgetMs,
} from './sse-events.js';

describe('SSE writer-stall budget resolution', () => {
  it('defaults the reaper ON at 60s when the flag is unset', () => {
    // The production incident accumulated stalled writers for hours
    // because the reaper was opt-in. The default must be a positive
    // budget — a regression back to "unset = disabled" fails here.
    expect(DEFAULT_WRITER_IDLE_TIMEOUT_MS).toBe(60_000);
    expect(resolveWriterIdleBudgetMs(undefined)).toBe(60_000);
  });

  it('lets an explicit positive flag value win', () => {
    expect(resolveWriterIdleBudgetMs(200)).toBe(200);
    expect(resolveWriterIdleBudgetMs(300_000)).toBe(300_000);
  });

  it('treats non-positive values as disabled (direct embeds only)', () => {
    expect(resolveWriterIdleBudgetMs(0)).toBe(0);
    expect(resolveWriterIdleBudgetMs(-5)).toBe(0);
  });
});
