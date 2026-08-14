/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { petStateForStreaming, petTransitionForSession } from './pet-activity';

describe('Electron desktop pet activity mapping', () => {
  it('maps Web Shell streaming states to companion states', () => {
    expect(petStateForStreaming('idle')).toBe('idle');
    expect(petStateForStreaming('waiting')).toBe('waiting');
    expect(petStateForStreaming('responding')).toBe('running');
  });

  it('uses success and failure animations for terminal turns', () => {
    expect(
      petTransitionForSession({ type: 'turn_complete', failed: false }),
    ).toEqual({ baseState: 'idle', state: 'jumping', transientMs: 1_300 });
    expect(
      petTransitionForSession({ type: 'turn_complete', failed: true }),
    ).toEqual({ baseState: 'idle', state: 'failed', transientMs: 2_600 });
  });
});
