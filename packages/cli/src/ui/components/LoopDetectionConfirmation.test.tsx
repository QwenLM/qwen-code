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
    // The note must name model.loopProtection, scope skipLoopDetection to
    // the heuristics, and point at the cap's own knob.
    // (Assertions stay within single rendered lines — the frame wraps text.)
    expect(output).toContain('"model.loopProtection"');
    expect(output).toContain('turns loop protection off');
    expect(output).toContain('model.skipLoopDetection');
    expect(output).toContain('model.maxToolCallsPerTurn');
    expect(output).toContain('Disabling for this session above suppresses');
    expect(output).toContain('settings.json');
    expect(output).not.toContain('Cause:');
  });

  it('shows the cause of the stop when it is known', () => {
    const { lastFrame } = renderWithProviders(
      <LoopDetectionConfirmation
        cause="the provider replayed a tool call id that had already run"
        onComplete={onComplete}
      />,
    );
    const output = lastFrame()!.toString();

    expect(output).toContain('Cause: the provider replayed a tool call id');
    expect(output).toContain('A potential loop was detected');
  });

  it('quotes setting names in the cause like the note does', () => {
    const { lastFrame } = renderWithProviders(
      <LoopDetectionConfirmation
        cause="the turn reached the limit set by `model.maxToolCallsPerTurn` (3)"
        onComplete={onComplete}
      />,
    );
    const output = lastFrame()!.toString();

    expect(output).toContain('"model.maxToolCallsPerTurn" (3).');
    expect(output).not.toContain('`');
  });
});
