/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_FORTUNE_COMMAND } from '../../config/constants.js';

describe('fortune', () => {
  it('should use DEFAULT_FORTUNE_COMMAND constant', () => {
    expect(DEFAULT_FORTUNE_COMMAND).toBe('fortune -s -n 45');
  });
});
