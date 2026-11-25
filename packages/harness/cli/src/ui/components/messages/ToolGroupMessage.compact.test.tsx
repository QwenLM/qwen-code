/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/mockConfig.js';
import {
  ToolGroupMessage,
  classifyToolVariant,
  ToolVariant,
} from './ToolGroupMessage.js';
import {
  CoreToolCallStatus,
  type CodeModeDisplay,
  GLOB_DISPLAY_NAME,
  makeFakeConfig,
  READ_FILE_DISPLAY_NAME,
} from '@qwen-code/core';
import { expect, it, describe } from 'vitest';
import type { IndividualToolCallDisplay } from '../../types.js';
import { FoldLevel } from '../../constants/messageLayout.js';

describe('ToolGroupMessage Compact Rendering', () => {
  const defaultProps = {
    item: {
      id: '1',
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      type: 'help' as const, // Adding type property to satisfy HistoryItem type
    },
    terminalWidth: 80,
  };

  const compactSettings = createMockSettings({
    merged: {
      ui: {
        compactToolOutput: true,
      },
    },
  });

  it.each([false, true])(
    'routes PowerShell to the shell renderer (compact: %s)',
    (compact) => {
      const tool: IndividualToolCallDisplay = {
        callId: 'powershell-call',
        name: 'PowerShell',
        status: CoreToolCallStatus.Executing,
        description: 'Write-Output hello',
        resultDisplay: '',
        confirmationDetails: undefined,
      };
      expect(classifyToolVariant(tool, compact)).toBe(ToolVariant.Shell);
    },
  );

  it('renders consecutive compact tools without empty lines between them', async () => {
    const toolCalls: IndividualToolCallDisplay[] = [
      {
        callId: 'call1',
        name: GLOB_DISPLAY_NAME,
        status: CoreToolCallStatus.Success,
        resultDisplay: 'file1.txt\nfile2.txt',
        description: 'Listing files',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
      {
        callId: 'call2',
        name: GLOB_DISPLAY_NAME,
        status: CoreToolCallStatus.Success,
        resultDisplay: 'file3.txt',
        description: 'Listing files',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
    ];

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ToolGroupMessage {...defaultProps} toolCalls={toolCalls} />,
      { settings: compactSettings },
    );

    await waitUntilReady();
    const output = lastFrame();

    expect(output).toMatchSnapshot();
  });

  it('shows both Grep results and the script summary inside a compact CodeMode group', async () => {
    const display: CodeModeDisplay = {
      isCodeModeDisplay: true,
      status: 'completed',
      children: [14, 2].map((numMatches, index) => ({
        callId: `grep-${index}`,
        name: 'Grep',
        args: { pattern: 'export', path: `/repo/${index}.ts` },
        status: CoreToolCallStatus.Success,
        resultDisplay: {
          mode: 'content',
          numFiles: 0,
          filenames: [],
          numMatches,
          content: `export const result${index} = true;`,
        },
      })),
      summary: 'script done',
    };
    const rendered = await renderWithProviders(
      <ToolGroupMessage
        {...defaultProps}
        toolCalls={[
          {
            callId: 'code-mode',
            name: 'CodeMode',
            description: 'Execute script',
            status: CoreToolCallStatus.Success,
            resultDisplay: display,
            confirmationDetails: undefined,
          },
        ]}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: compactSettings,
        initialFoldLevel: FoldLevel.GroupExpandedToolCollapsed,
        uiState: { constrainHeight: true },
      },
    );
    await rendered.waitUntilReady();
    const output = rendered.lastFrame();
    expect(output).toContain('Found 14 matches');
    expect(output).toContain('Found 2 matches');
    expect(output).toContain('Execute script · Completed · 2 tool calls');
    expect(output).toContain('script done');
    await expect(rendered).toMatchSvgSnapshot();
    rendered.unmount();
  });

  it('does not add an extra empty line between a compact tool and a standard tool', async () => {
    const toolCalls: IndividualToolCallDisplay[] = [
      {
        callId: 'call1',
        name: GLOB_DISPLAY_NAME,
        status: CoreToolCallStatus.Success,
        resultDisplay: 'file1.txt',
        description: 'Listing files',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
      {
        callId: 'call2',
        name: 'non-compact-tool',
        status: CoreToolCallStatus.Success,
        resultDisplay: 'some large output',
        description: 'Doing something',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
    ];

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ToolGroupMessage {...defaultProps} toolCalls={toolCalls} />,
      { settings: compactSettings },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toMatchSnapshot();
  });

  it('does not add an extra empty line if a compact tool has a dense payload', async () => {
    const toolCalls: IndividualToolCallDisplay[] = [
      {
        callId: 'call1',
        name: GLOB_DISPLAY_NAME,
        status: CoreToolCallStatus.Success,
        resultDisplay: 'file1.txt',
        description: 'Listing files',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
      {
        callId: 'call2',
        name: READ_FILE_DISPLAY_NAME,
        status: CoreToolCallStatus.Success,
        resultDisplay: 'file content', // Dense payload
        description: 'Reading file',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
    ];

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ToolGroupMessage {...defaultProps} toolCalls={toolCalls} />,
      { settings: compactSettings },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toMatchSnapshot();
  });

  it('does not add an extra empty line between a standard tool and a compact tool', async () => {
    const toolCalls: IndividualToolCallDisplay[] = [
      {
        callId: 'call1',
        name: 'non-compact-tool',
        status: CoreToolCallStatus.Success,
        resultDisplay: 'some large output',
        description: 'Doing something',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
      {
        callId: 'call2',
        name: GLOB_DISPLAY_NAME,
        status: CoreToolCallStatus.Success,
        resultDisplay: 'file1.txt',
        description: 'Listing files',
        confirmationDetails: undefined,
        isClientInitiated: true,
        parentCallId: undefined,
      },
    ];

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <ToolGroupMessage {...defaultProps} toolCalls={toolCalls} />,
      { settings: compactSettings },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toMatchSnapshot();
  });
});
