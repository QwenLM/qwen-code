/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  calculateMainAreaWidth,
  getMainAreaWidthInternal,
} from './ui-sizing.js';
import type { Settings } from '../../config/settings.js';

describe('ui-sizing', () => {
  const createSettings = (useFullWidth?: boolean): Settings =>
    ({
      ui: {
        useFullWidth,
      },
    }) as unknown as Settings;

  describe('getMainAreaWidthInternal', () => {
    it('should return 98% for narrow terminals (80 columns or less)', () => {
      expect(getMainAreaWidthInternal(40)).toBe(39);
      expect(getMainAreaWidthInternal(60)).toBe(59);
      expect(getMainAreaWidthInternal(80)).toBe(78);
    });

    it('should return 90% for wide terminals (132 columns or more)', () => {
      expect(getMainAreaWidthInternal(132)).toBe(119);
      expect(getMainAreaWidthInternal(150)).toBe(135);
      expect(getMainAreaWidthInternal(200)).toBe(180);
    });

    it('should linearly interpolate between 80 and 132 columns', () => {
      expect(getMainAreaWidthInternal(100)).toBe(95);
      expect(getMainAreaWidthInternal(106)).toBe(100);
    });
  });

  describe('calculateMainAreaWidth', () => {
    it('should use full width with 2-char margin when useFullWidth is true', () => {
      expect(calculateMainAreaWidth(80, createSettings(true))).toBe(78);
      expect(calculateMainAreaWidth(100, createSettings(true))).toBe(98);
      expect(calculateMainAreaWidth(132, createSettings(true))).toBe(130);
    });

    it('should use full width with 2-char margin when useFullWidth is undefined (default)', () => {
      expect(calculateMainAreaWidth(80, createSettings(undefined))).toBe(78);
      expect(calculateMainAreaWidth(100, createSettings(undefined))).toBe(98);
    });

    it('should use smart sizing when useFullWidth is false', () => {
      expect(calculateMainAreaWidth(80, createSettings(false))).toBe(78);
      expect(calculateMainAreaWidth(132, createSettings(false))).toBe(119);
    });
  });
});
