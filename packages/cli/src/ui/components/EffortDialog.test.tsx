/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { EffortDialog } from './EffortDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';

// Mock only the keypress hook so we can exercise the Escape handler directly.
// RadioButtonSelect is left real so the rendered frame contains the tier list.
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

describe('EffortDialog', () => {
  beforeEach(() => {
    mockedUseKeypress.mockClear();
  });

  it('renders the title and all five reasoning-effort tiers', () => {
    const { lastFrame } = renderWithProviders(
      <EffortDialog onSelect={vi.fn()} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Reasoning Effort');
    for (const tier of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(frame).toContain(tier);
    }
    expect(frame).toContain('Use Enter to select, Esc to cancel');
  });

  it('shows the "no effort configured" hint when currentEffort is unset', () => {
    const { lastFrame } = renderWithProviders(
      <EffortDialog onSelect={vi.fn()} />,
    );

    expect(lastFrame() ?? '').toContain(
      'No effort configured — using the model/provider default.',
    );
  });

  it('hides the "no effort configured" hint when currentEffort is set', () => {
    const { lastFrame } = renderWithProviders(
      <EffortDialog onSelect={vi.fn()} currentEffort="high" />,
    );

    expect(lastFrame() ?? '').not.toContain('No effort configured');
  });

  it('registers an active Escape handler that cancels with undefined', () => {
    const onSelect = vi.fn();
    renderWithProviders(<EffortDialog onSelect={onSelect} />);

    expect(mockedUseKeypress).toHaveBeenCalled();
    const [handler, options] = mockedUseKeypress.mock.calls[0];
    expect(options).toEqual({ isActive: true });

    handler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('does not cancel on non-Escape keys', () => {
    const onSelect = vi.fn();
    renderWithProviders(<EffortDialog onSelect={onSelect} />);

    const [handler] = mockedUseKeypress.mock.calls[0];
    handler({
      name: 'return',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '\r',
    });

    expect(onSelect).not.toHaveBeenCalled();
  });
});
