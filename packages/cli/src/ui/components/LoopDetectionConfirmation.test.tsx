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
    // The note must scope skipLoopDetection to the heuristics and flag the
    // consecutive-identical guard as always-on (it cannot be turned off there).
    expect(output).toContain('heuristic loop checks for future sessions');
    expect(output).toContain('always-on guard against consecutive identical');
    expect(output).toContain('model.skipLoopDetection');
    expect(output).toContain('settings.json');
  });
});
