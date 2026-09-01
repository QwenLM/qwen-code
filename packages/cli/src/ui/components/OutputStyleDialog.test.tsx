/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '../../test-utils/render.js';
import { OutputStyleDialog } from './OutputStyleDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';

// Mock only the keypress hook so we can exercise the Escape handler directly.
// RadioButtonSelect is left real so the rendered frame contains the style list.
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

describe('OutputStyleDialog', () => {
  beforeEach(() => {
    mockedUseKeypress.mockClear();
  });

  it('renders the title, the default entry, and all built-in styles', () => {
    const { lastFrame } = renderWithProviders(
      <OutputStyleDialog onSelect={vi.fn()} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Output Style');
    for (const name of [
      'default',
      'Concise',
      'Proactive',
      'Explanatory',
      'Learning',
    ]) {
      expect(frame).toContain(name);
    }
    expect(frame).toContain('Use Enter to select, Esc to cancel');
  });

  it('reports cancellation via onSelect(undefined) on Escape', () => {
    const onSelect = vi.fn();
    renderWithProviders(<OutputStyleDialog onSelect={onSelect} />);

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    keypressHandler({ name: 'escape' } as Parameters<
      typeof keypressHandler
    >[0]);

    expect(onSelect).toHaveBeenCalledWith(undefined);
  });

  it('does not cancel on other keys', () => {
    const onSelect = vi.fn();
    renderWithProviders(<OutputStyleDialog onSelect={onSelect} />);

    const keypressHandler = mockedUseKeypress.mock.calls[0][0];
    keypressHandler({ name: 'return' } as Parameters<
      typeof keypressHandler
    >[0]);

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('pre-selects the active style', () => {
    const { lastFrame } = renderWithProviders(
      <OutputStyleDialog onSelect={vi.fn()} currentStyleName="Concise" />,
    );

    expect(lastFrame()).toContain('› 2. Concise');
  });
});
