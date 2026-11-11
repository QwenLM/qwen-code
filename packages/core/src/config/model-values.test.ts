/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  readIntegerCoerce,
  readNumberCoerce,
  reasoningEffortFromThinkingBudget,
} from './model-values.js';

describe('reasoningEffortFromThinkingBudget', () => {
  it.each([
    [undefined, undefined],
    [0, 'none'],
    [1, 'low'],
    [1024, 'low'],
    [1025, 'medium'],
    [8192, 'medium'],
    [8193, 'high'],
    [24576, 'high'],
    [24577, 'xhigh'],
    [49152, 'xhigh'],
    [49153, 'max'],
  ] as const)('maps %s to %s', (budget, effort) => {
    expect(reasoningEffortFromThinkingBudget(budget)).toBe(effort);
  });
});

describe('numeric coercion', () => {
  it.each(['', ' ', '\t\n'])('rejects an empty numeric string %j', (value) => {
    expect(readNumberCoerce(value)).toBeUndefined();
    expect(readIntegerCoerce(value)).toBeUndefined();
  });

  it('accepts a finite numeric string surrounded by whitespace', () => {
    expect(readNumberCoerce(' 42.5 ')).toBe(42.5);
    expect(readIntegerCoerce(' 42.5 ')).toBe(42);
  });
});
