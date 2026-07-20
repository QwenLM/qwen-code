/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { describe, it, expect, vi } from 'vitest';
import { LoopDetectionConfirmation } from './LoopDetectionConfirmation.js';

describe('LoopDetectionConfirmation', () => {
  const onComplete = vi.fn();

  it('renders correctly', () => {
    const { lastFrame } = renderWithProviders(
      <LoopDetectionConfirmation onComplete={onComplete} />,
    );
    expect(lastFrame()).toMatchSnapshot();
  });

  it('contains the expected options', () => {
    const { lastFrame } = renderWithProviders(
      <LoopDetectionConfirmation onComplete={onComplete} />,
    );
    const output = lastFrame()!.toString();

    expect(output).toContain('A potential loop was detected');
    expect(output).toContain('Keep loop detection enabled (esc)');
    expect(output).toContain('Disable loop detection for this session');
    expect(output).toContain(
      'This can happen due to repetitive tool calls or other model behavior',
    );
    // The note must scope skipLoopDetection to the heuristics, flag the
    // always-on guards as unaffected by it, and point at the cap's own knob.
    // (Assertions stay within single rendered lines — the frame wraps text.)
    expect(output).toContain('heuristic loop checks for future sessions');
    expect(output).toContain('always-on guards');
    expect(output).toContain('model.skipLoopDetection');
    expect(output).toContain('model.maxToolCallsPerTurn');
    expect(output).toContain('suppresses everything');
    expect(output).toContain('settings.json');
  });
});
