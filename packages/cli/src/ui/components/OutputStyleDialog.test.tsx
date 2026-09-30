/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Box } from 'ink';
import { renderWithProviders } from '../../test-utils/render.js';
import { BUILT_IN_OUTPUT_STYLES } from '@qwen-code/qwen-code-core';
import { OutputStyleDialog } from './OutputStyleDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';

// Mock only the keypress hook so we can exercise the Escape handler directly.
// RadioButtonSelect is left real so the rendered frame contains the style list.
vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

const REVIEWER_STYLE = {
  name: 'Reviewer',
  source: 'project',
  description: 'Reviews without editing',
  keepCodingInstructions: false,
  prompt: 'Review only.',
} as const;

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

  it('pre-selects default when no style is configured', () => {
    const { lastFrame } = renderWithProviders(
      <OutputStyleDialog onSelect={vi.fn()} />,
    );

    expect(lastFrame()).toContain('› 1. default');
  });

  it('lists custom styles and pre-selects the active one', () => {
    const { lastFrame } = renderWithProviders(
      <OutputStyleDialog
        onSelect={vi.fn()}
        currentStyleName="Reviewer"
        styles={[...BUILT_IN_OUTPUT_STYLES, REVIEWER_STYLE]}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('› 6. Reviewer');
    expect(frame).not.toContain('› 1. default');
  });

  it('pre-selects the active style when the catalog spells it differently', () => {
    // The level that wins can change the casing between startup and open — a
    // project `name: reviewer` taking over from a user-level `Reviewer`. An
    // exact compare would highlight `default` and one Enter would persist it.
    const { lastFrame } = renderWithProviders(
      <OutputStyleDialog
        onSelect={vi.fn()}
        currentStyleName="reviewer"
        styles={[...BUILT_IN_OUTPUT_STYLES, REVIEWER_STYLE]}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('› 6. Reviewer');
    expect(frame).not.toContain('› 1. default');
  });

  it('keeps the source marker at a realistic terminal width', () => {
    // The rows truncate, so a marker asserted at the harness's incidental 100
    // columns proves nothing: pin it at 80 with a description that fills the
    // row, where losing a column would drop the marker off the end.
    const { lastFrame } = renderWithProviders(
      <Box width={80}>
        <OutputStyleDialog
          onSelect={vi.fn()}
          styles={[
            ...BUILT_IN_OUTPUT_STYLES,
            {
              ...REVIEWER_STYLE,
              description: 'Reviews changes without editing any project files',
            },
          ]}
        />
      </Box>,
    );

    expect(lastFrame()).toContain(
      'Reviews changes without editing any project files (project)',
    );
  });

  it('shows a loading row instead of the list before the catalog arrives', () => {
    // `useOutputStyleCommand` opens with an empty list while it reads the
    // style directories. Mounting the rows then would offer `default` alone,
    // pre-selected, so one Enter would clear the user's configured style.
    const { lastFrame } = renderWithProviders(
      <OutputStyleDialog onSelect={vi.fn()} styles={[]} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Loading output styles…');
    expect(frame).not.toContain('1. default');
  });
});
