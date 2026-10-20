/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import {
  PROJECT_HOOKS_DIALOG_CHROME_ROWS,
  ProjectHooksApprovalChoice,
  ProjectHooksApprovalDialog,
} from './ProjectHooksApprovalDialog.js';

const lines = Array.from(
  { length: 30 },
  (_, i) => `SessionStart  hook-${i}.sh`,
);

describe('ProjectHooksApprovalDialog', () => {
  it('lists every hook when the height is unconstrained', () => {
    const { lastFrame } = renderWithProviders(
      <ProjectHooksApprovalDialog
        lines={lines.slice(0, 2)}
        onSelect={vi.fn()}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Untrusted hooks in .qwen/settings.json');
    expect(frame).toContain('hook-0.sh');
    expect(frame).toContain('hook-1.sh');
    expect(frame).toContain('Approve these hooks');
  });

  it('caps the list so Approve stays on screen in a short terminal', () => {
    const { lastFrame } = renderWithProviders(
      <ProjectHooksApprovalDialog
        lines={lines}
        availableTerminalHeight={PROJECT_HOOKS_DIALOG_CHROME_ROWS + 4}
        onSelect={vi.fn()}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('hook-2.sh');
    expect(frame).not.toContain('hook-3.sh');
    expect(frame).toContain('… and 27 more (see .qwen/settings.json)');
    expect(frame).toContain('Approve these hooks');
  });

  it('dismisses on Esc without choosing reject', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderWithProviders(
      <ProjectHooksApprovalDialog
        lines={lines.slice(0, 1)}
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
