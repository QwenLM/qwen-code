/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';

describe('same suite', () => {
  test('same title', () => {
    expect('first').toBe('wrong');
  });
  test('same title', () => {
    expect('second').toBe('wrong');
  });
});
