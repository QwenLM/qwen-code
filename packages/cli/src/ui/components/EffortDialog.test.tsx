/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
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

  it('lists only the tiers the resolved model exposes', () => {
    const { lastFrame } = renderWithProviders(
      <EffortDialog onSelect={vi.fn()} efforts={['high', 'max']} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.');
    expect(frame).toContain('2.');
    expect(frame).not.toContain('3.');
    expect(frame).not.toContain('medium');
    expect(frame).not.toContain('xhigh');
  });

  it('reports a configured tier the resolved model does not expose', () => {
    // A global `model.reasoningEffort` carried over from another model reaches
    // the picker; mapping that miss onto the first listed tier would read as
    // "high is current" and a bare Enter would persist it over the stored value.
    const { lastFrame } = renderWithProviders(
      <EffortDialog
        onSelect={vi.fn()}
        currentEffort="low"
        efforts={['high', 'max']}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('low is not available for this model');
    expect(frame).not.toContain('No effort configured');
  });

  it('cancels rather than persisting the forced cursor on a bare Enter', async () => {
    // The stored tier is not in this model's list, so the cursor sits on a row
    // that is not the user's setting. Confirming without moving is the "just
    // looking" gesture: it must leave the stored global value alone instead of
    // overwriting it with the row the clamp forced the cursor onto.
    const onSelect = vi.fn();
    renderWithProviders(
      <EffortDialog
        onSelect={onSelect}
        currentEffort="xhigh"
        efforts={['high', 'max']}
      />,
    );

    await act(async () => {
      mockedUseKeypress.mock.calls.at(-1)![0]({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith(undefined);
    expect(onSelect).not.toHaveBeenCalledWith('high');
  });

  it('persists a tier chosen after moving off the forced cursor', async () => {
    const onSelect = vi.fn();
    renderWithProviders(
      <EffortDialog
        onSelect={onSelect}
        currentEffort="xhigh"
        efforts={['high', 'max']}
      />,
    );

    act(() => {
      mockedUseKeypress.mock.calls.at(-1)![0]({ name: 'down' } as never);
    });
    await act(async () => {
      mockedUseKeypress.mock.calls.at(-1)![0]({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith('max');
  });

  it('still persists the highlighted tier when nothing is configured', async () => {
    // The guard is scoped to a stored tier this model does not expose: with
    // nothing stored there is no preference to overwrite, so Enter still picks.
    const onSelect = vi.fn();
    renderWithProviders(<EffortDialog onSelect={onSelect} />);

    await act(async () => {
      mockedUseKeypress.mock.calls.at(-1)![0]({ name: 'return' } as never);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onSelect).toHaveBeenCalledWith('low');
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
