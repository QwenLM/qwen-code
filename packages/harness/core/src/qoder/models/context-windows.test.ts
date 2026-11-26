/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getSupportedContextWindows,
  parseContextWindowConfig,
  supportsContextWindow,
} from './context-windows.js';

describe('context window model metadata', () => {
  it('returns explicit windows without max_input_tokens filtering', () => {
    const model = {
      available_context_windows: [200_000, 400_000, 1_000_000],
      max_input_tokens: 180_000,
    };

    expect(getSupportedContextWindows(model)).toEqual([
      200_000, 400_000, 1_000_000,
    ]);
  });

  it('supports explicit windows even when they exceed max_input_tokens', () => {
    const model = {
      available_context_windows: [200_000, 400_000, 1_000_000],
      max_input_tokens: 180_000,
    };

    expect(supportsContextWindow(model, 1_000_000)).toBe(true);
    expect(supportsContextWindow(model, 180_000)).toBe(false);
  });

  it('falls back to max_input_tokens when no explicit list is present', () => {
    const model = {
      max_input_tokens: 180_000,
    };

    expect(supportsContextWindow(model, 128_000)).toBe(true);
    expect(supportsContextWindow(model, 200_000)).toBe(false);
  });

  it('parses context_config tiers into sorted windows and the default tier', () => {
    expect(
      parseContextWindowConfig({
        '1M': { token_count: 1_000_000 },
        invalid: { token_count: 'bad' },
        '200K': { token_count: 200_000, is_default: true },
        '400K': { token_count: 400_000 },
      }),
    ).toEqual({
      windows: [200_000, 400_000, 1_000_000],
      defaultWindow: 200_000,
    });
  });
});
