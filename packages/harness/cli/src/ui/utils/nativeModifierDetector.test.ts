/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  getPressedModifiers,
  isModifierPressed,
  isNativeModifierDetectionAvailable,
  prewarmNativeModifierDetector,
} from './nativeModifierDetector.js';

describe('nativeModifierDetector', () => {
  it.runIf(process.platform === 'darwin')(
    'loads and prewarms the bundled binding on macOS',
    () => {
      expect(isNativeModifierDetectionAvailable()).toBe(true);
      expect(prewarmNativeModifierDetector()).toBe(true);

      const state = getPressedModifiers();
      expect(state).toEqual({
        shift: expect.any(Boolean),
        ctrl: expect.any(Boolean),
        alt: expect.any(Boolean),
        cmd: expect.any(Boolean),
      });
      expect(isModifierPressed('shift')).toEqual(expect.any(Boolean));
    },
  );

  it.runIf(process.platform !== 'darwin')(
    'stays unavailable outside macOS',
    () => {
      expect(isNativeModifierDetectionAvailable()).toBe(false);
      expect(prewarmNativeModifierDetector()).toBe(false);
      expect(getPressedModifiers()).toBeNull();
      expect(isModifierPressed('shift')).toBe(false);
    },
  );
});
