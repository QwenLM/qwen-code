/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_FORTUNE_COMMAND } from './fortune.js';

describe('fortune', () => {
  it('should use DEFAULT_FORTUNE_COMMAND constant', () => {
    expect(DEFAULT_FORTUNE_COMMAND).toBe('/usr/games/fortune -s -n 45');
  });
});
