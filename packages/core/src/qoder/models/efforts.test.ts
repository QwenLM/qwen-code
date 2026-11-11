/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getSupportedReasoningEfforts } from './efforts.js';

describe('getSupportedReasoningEfforts', () => {
  it("returns 'none' when the model can disable thinking", () => {
    const model = {
      efforts: ['low', 'medium', 'high'],
      supports_disabled: true,
    };
    expect(getSupportedReasoningEfforts(model)).toEqual([
      'low',
      'medium',
      'high',
      'none',
    ]);
  });

  it('preserves the advertised efforts when thinking cannot be disabled', () => {
    const model = {
      efforts: ['medium', 'high', 'max'],
      supports_disabled: false,
    };
    expect(getSupportedReasoningEfforts(model)).toEqual([
      'medium',
      'high',
      'max',
    ]);
  });

  it("returns 'none' for the supports-disabled-only edge case", () => {
    const model = { efforts: [], supports_disabled: true };
    expect(getSupportedReasoningEfforts(model)).toEqual(['none']);
  });
});
