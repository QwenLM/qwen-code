/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  PET_BACKGROUND_SIZE,
  buildPetSequence,
  petBackgroundPosition,
} from './pet-animation';

describe('Electron desktop pet animation', () => {
  it('uses the original Qwen 8 by 9 atlas geometry', () => {
    expect(PET_BACKGROUND_SIZE).toBe('800% 900%');
    expect(
      petBackgroundPosition({
        rowIndex: 8,
        columnIndex: 7,
        durationMs: 1,
      }),
    ).toBe('100% 100%');
  });

  it('maps running activity to the original running row before idle', () => {
    const sequence = buildPetSequence('running');
    expect(sequence.frames.slice(0, 6).map((frame) => frame.rowIndex)).toEqual([
      7, 7, 7, 7, 7, 7,
    ]);
    expect(sequence.loopStartIndex).toBe(18);
    expect(sequence.frames[sequence.loopStartIndex]?.rowIndex).toBe(0);
  });
});
