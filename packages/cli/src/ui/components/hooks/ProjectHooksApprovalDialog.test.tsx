/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { Box } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import {
  PROJECT_HOOKS_DIALOG_DESCRIPTION,
  ProjectHooksApprovalChoice,
  ProjectHooksApprovalDialog,
  fitProjectHooksDescription,
  layoutProjectHooksLines,
} from './ProjectHooksApprovalDialog.js';

/** The dialog inside the main-area box `DefaultAppLayout` gives it. */
const renderAt = (lines: string[], width: number, height?: number) =>
  renderWithProviders(
    <Box width={Math.min(width - 4, 100)} marginX={2}>
      <ProjectHooksApprovalDialog
        lines={lines}
        terminalWidth={width}
        availableTerminalHeight={height}
        onSelect={vi.fn()}
      />
    </Box>,
  );

const lines = Array.from(
  { length: 30 },
  (_, i) => `SessionStart  hook-${i}.sh`,
);

describe('ProjectHooksApprovalDialog', () => {
  it('lists every hook when the height is unconstrained', () => {
    const frame = renderAt(lines.slice(0, 2), 80).lastFrame() ?? '';
    expect(frame).toContain('Untrusted hooks in .qwen/settings.json');
    expect(frame).toContain('hook-0.sh');
    expect(frame).toContain('hook-1.sh');
    expect(frame).toContain('Approve these hooks');
  });

  it.each([
    [80, 11],
    [80, 12],
    [80, 16],
    [80, 20],
    [80, 24],
    [40, 24],
    [100, 18],
  ])(
    'keeps both options on screen at %ix%i, capping the list',
    (width, height) => {
      const frame = renderAt(lines, width, height).lastFrame() ?? '';
      expect(frame.split('\n').length).toBeLessThanOrEqual(height);
      expect(frame).toContain('Approve these hooks');
      expect(frame).toContain('Reject');
      expect(frame).toMatch(/… and \d+ more/);
    },
  );

  it('clips the description, not the options, on a short terminal', () => {
    // The real frame budgets terminalHeight - 5 rows; at 80x16 that is 11,
    // less than the fixed chrome plus the full description.
    const frame = renderAt(lines, 80, 11).lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(11);
    expect(frame).toContain('Reject');
    expect(frame).not.toContain('This workspace declares hooks');
  });

  it.each([
    ['unconstrained', undefined, 30],
    ['roomy', 40, 25],
    ['one row past the chrome', 16, 1],
    ['shorter than the chrome', 6, 1],
  ])('lays out the list when %s', (_label, height, rows) => {
    // Chrome at 80 columns: 9 fixed rows, the title and a 5-row description.
    const header = ['title', `${'word '.repeat(64)}`];
    const shown = layoutProjectHooksLines(lines, header, 80, height);
    expect(shown).toHaveLength(rows);
    if (rows < lines.length) {
      expect(shown.at(-1)).toBe(
        `… and ${lines.length - rows + 1} more (see .qwen/settings.json)`,
      );
    }
  });

  it('cuts a long hook to one row with a marker', () => {
    const long = lines.map((line) => `${line} ${'x'.repeat(250)}`);
    const frame = renderAt(long, 80, 24).lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(frame).toMatch(/… \[\+\d+ chars\]/);
    expect(frame).toContain('Reject');
  });

  it.each([
    [ProjectHooksApprovalChoice.APPROVE, ['\r']],
    [ProjectHooksApprovalChoice.REJECT, ['\u001b[B', '\r']],
  ])('emits %s for its row', async (choice, keys) => {
    const onSelect = vi.fn();
    const { stdin } = renderWithProviders(
      <ProjectHooksApprovalDialog
        lines={lines.slice(0, 1)}
        terminalWidth={80}
        onSelect={onSelect}
      />,
    );
    for (const key of keys) {
      act(() => {
        stdin.write(key);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(choice);
  });

  it('dismisses on Esc without choosing reject', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderWithProviders(
      <ProjectHooksApprovalDialog
        lines={lines.slice(0, 1)}
        terminalWidth={80}
        onSelect={onSelect}
      />,
    );
    act(() => {
      stdin.write('\u001b');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSelect).toHaveBeenCalledWith(ProjectHooksApprovalChoice.DISMISS);
  });

  describe('fitProjectHooksDescription', () => {
    it('keeps the full description when unconstrained', () => {
      expect(
        fitProjectHooksDescription(
          PROJECT_HOOKS_DIALOG_DESCRIPTION,
          80,
          undefined,
        ),
      ).toBe(PROJECT_HOOKS_DIALOG_DESCRIPTION);
    });

    it('cuts rows to the budget the chrome and one list row leave', () => {
      // At 80 columns the title takes one row, so the budget is height - 11.
      expect(
        fitProjectHooksDescription(PROJECT_HOOKS_DIALOG_DESCRIPTION, 80, 11),
      ).toBe('');
      const three = fitProjectHooksDescription(
        PROJECT_HOOKS_DIALOG_DESCRIPTION,
        80,
        14,
      );
      expect(three.split('\n')).toHaveLength(3);
      expect(
        PROJECT_HOOKS_DIALOG_DESCRIPTION.startsWith(three.split('\n')[0]),
      ).toBe(true);
      const full = fitProjectHooksDescription(
        PROJECT_HOOKS_DIALOG_DESCRIPTION,
        80,
        40,
      );
      expect(full.replace(/\n/g, ' ')).toBe(PROJECT_HOOKS_DIALOG_DESCRIPTION);
    });
  });
});
