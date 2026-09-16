/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { HookType } from '@qwen-code/qwen-code-core/hooks/types.js';
import { formatHookTimeout } from './hook-timeout-label.js';

describe('formatHookTimeout', () => {
  it.each([
    [HookType.Command, 999, '999 s'],
    [HookType.Command, 1000, '1000 ms'],
    [HookType.Function, 5, '5 ms'],
    [HookType.Http, 1000, '1000 s'],
    [HookType.Prompt, 30, '30 s'],
  ])('formats %s timeout %s', (hookType, timeout, expected) => {
    expect(formatHookTimeout({ hookType, timeout })).toBe(expected);
  });
});
