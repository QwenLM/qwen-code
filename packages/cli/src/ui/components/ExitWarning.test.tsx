/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ExitWarning } from './ExitWarning.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';

function frameHeight(frame: string): number {
  return frame.length === 0 ? 0 : frame.split('\n').length;
}

const renderWarning = (overrides: Partial<UIState> = {}) =>
  render(
    <UIStateContext.Provider
      value={
        {
          dialogsVisible: false,
          ctrlCPressedOnce: false,
          ctrlDPressedOnce: false,
          ...overrides,
        } as UIState
      }
    >
      <ExitWarning />
    </UIStateContext.Provider>,
  );

describe('ExitWarning', () => {
  it('renders nothing when no exit is armed', () => {
    const { lastFrame } = renderWarning();
    expect(lastFrame() ?? '').toBe('');
  });

  it('renders a single-row Ctrl+C warning over a dialog, with no extra spacer', () => {
    const { lastFrame } = renderWarning({
      dialogsVisible: true,
      ctrlCPressedOnce: true,
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Press Ctrl+C again to exit.');
    expect(frameHeight(frame)).toBe(1);
  });

  it('renders a single-row Ctrl+D warning over a dialog, with no extra spacer', () => {
    const { lastFrame } = renderWarning({
      dialogsVisible: true,
      ctrlDPressedOnce: true,
    });
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Press Ctrl+D again to exit.');
    expect(frameHeight(frame)).toBe(1);
  });
});
