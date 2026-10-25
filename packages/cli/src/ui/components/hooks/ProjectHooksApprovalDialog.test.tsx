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
  ProjectHooksApprovalChoice,
  ProjectHooksApprovalDialog,
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

  it('keeps hook rows on a terminal shorter than the chrome', () => {
    const frame = renderAt(lines, 80, 6).lastFrame() ?? '';
    expect(frame).toContain('hook-1.sh');
    expect(frame).toContain('… and 28 more');
  });

  it('cuts a long hook to one row with a marker', () => {
    const long = lines.map((line) => `${line} ${'x'.repeat(250)}`);
    const frame = renderAt(long, 80, 24).lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    expect(frame).toMatch(/… \[\+\d+ chars\]/);
    expect(frame).toContain('Reject');
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
});
