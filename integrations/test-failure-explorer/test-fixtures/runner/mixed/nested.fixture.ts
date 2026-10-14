/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'vitest';

describe('outer suite', () => {
  describe('nested suite', () => {
    test('adds correctly', () => {
      expect(1 + 1).toBe(2);
    });
    test('preserves the failing assertion', () => {
      expect(1 + 1).toBe(3);
    });
  });
  test('passes outside the inner suite', () => {
    expect(true).toBe(true);
  });
});
