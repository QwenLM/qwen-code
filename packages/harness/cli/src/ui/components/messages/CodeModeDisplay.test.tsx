/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import {
  CoreToolCallStatus,
  type CodeModeDisplay,
} from '@qwen-code/core';
import { CodeModeDisplayView } from './CodeModeDisplay.js';
import { FoldLevel } from '../../constants/messageLayout.js';

describe('CodeModeDisplayView', () => {
  it('keeps Bash output visible alongside a nonzero exit notice without forcing expansion', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <CodeModeDisplayView
        display={{
          isCodeModeDisplay: true,
          children: [
            {
              callId: 'bash',
              name: 'Bash',
              args: { command: 'grep missing file' },
              status: CoreToolCallStatus.Success,
              resultDisplay: 'command output retained',
              notice: 'Bash exited with code 1',
            },
          ],
        }}
        terminalWidth={100}
      />,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('command output retained');
    expect(lastFrame()).toContain('Bash exited with code 1');
    expect(lastFrame()).toMatchSnapshot();
  });
  it('renders each child as its own tool row followed by the script summary', async () => {
    const display: CodeModeDisplay = {
      isCodeModeDisplay: true,
      children: [
        {
          callId: 'read',
          name: 'Read',
          args: { file_path: '/repo/src/a.ts' },
          status: CoreToolCallStatus.Success,
          resultDisplay: 'Read 12 lines',
        },
        {
          callId: 'grep',
          name: 'Grep',
          args: { pattern: 'TODO' },
          status: CoreToolCallStatus.Executing,
        },
        {
          callId: 'bash',
          name: 'Bash',
          args: { command: 'npm test' },
          status: CoreToolCallStatus.Error,
          resultDisplay: 'ignored when an error message exists',
          error: 'Permission denied by rule Bash',
        },
      ],
      summary: 'error: 3 tool calls\npartial output',
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <CodeModeDisplayView display={display} terminalWidth={100} />,
    );
    await waitUntilReady();
    const output = lastFrame() ?? '';
    const order = ['Read', 'Grep', 'Bash', 'partial output'].map((text) =>
      output.indexOf(text),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(output).toContain('Read 12 lines');
    expect(output).toContain('Permission denied by rule Bash');
    expect(output).not.toContain('ignored when an error message exists');
    expect(output).toMatchSnapshot();
  });

  it('renders only the summary when the script made no calls', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <CodeModeDisplayView
        display={{
          isCodeModeDisplay: true,
          children: [],
          summary: 'completed: 0 tool calls\n42',
        }}
        terminalWidth={80}
      />,
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('42');
  });

  describe('script output', () => {
    const longOutput = Array.from(
      { length: 12 },
      (_, i) => `line ${i + 1}`,
    ).join('\n');
    const render = async (
      display: Partial<CodeModeDisplay>,
      foldLevel?: FoldLevel,
    ) => {
      const { lastFrame, waitUntilReady } = await renderWithProviders(
        <CodeModeDisplayView
          display={{
            isCodeModeDisplay: true,
            children: [],
            summary: longOutput,
            ...display,
          }}
          terminalWidth={80}
          foldLevel={foldLevel}
        />,
        { uiState: { constrainHeight: foldLevel !== FoldLevel.FullyExpanded } },
      );
      await waitUntilReady();
      return lastFrame() ?? '';
    };

    it('labels the output and keeps only its head while collapsed', async () => {
      const output = await render({ status: 'completed' });
      expect(output).toContain('Output');
      expect(output).toContain('line 1');
      expect(output).not.toContain('line 12');
    });

    it('shows the full output when fully expanded', async () => {
      const output = await render(
        { status: 'completed' },
        FoldLevel.FullyExpanded,
      );
      expect(output).toContain('line 1');
      expect(output).toContain('line 12');
    });

    it('expands the output of a failed script', async () => {
      const output = await render({ status: 'error' });
      expect(output).toContain('line 12');
    });
  });
});
