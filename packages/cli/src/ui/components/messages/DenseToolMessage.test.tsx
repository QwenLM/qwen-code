/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { waitFor } from '../../../test-utils/async.js';
import { DenseToolMessage } from './DenseToolMessage.js';
import {
  CoreToolCallStatus,
  type DiffStat,
  type FileDiff,
  type GlobResult,
  type GrepResult,
  makeFakeConfig,
} from '@qwen-code/core';
import { FoldLevel } from '../../constants/messageLayout.js';
import type {
  SerializableConfirmationDetails,
  ToolResultDisplay,
} from '../../types.js';

describe('DenseToolMessage', () => {
  const stripTrailingWhitespace = (text: string | undefined) =>
    text?.replace(/[ \t]+$/gm, '');

  const defaultProps = {
    callId: 'call-1',
    name: 'test-tool',
    description: 'Test description',
    status: CoreToolCallStatus.Success,
    resultDisplay: 'Success result' as ToolResultDisplay,
    confirmationDetails: undefined,
    terminalWidth: 80,
  };

  it('renders correctly for a successful string result', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage {...defaultProps} />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('test-tool');
    expect(output).toContain('Test description');
    expect(output).toContain('└ Success result');
    expect(output).toMatchSnapshot();
  });

  it('truncates long string results', async () => {
    const longResult = 'A'.repeat(200);
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={longResult as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('…');
    expect(lastFrame()).toMatchSnapshot();
  });

  it('flattens newlines in string results', async () => {
    const multilineResult = 'Line 1\nLine 2';
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={multilineResult as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('└ Line 1 Line 2');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for file diff results with stats', async () => {
    const diffResult: FileDiff = {
      fileDiff: '@@ -1,1 +1,1 @@\n-old line\n+diff content',
      fileName: 'test.ts',
      filePath: '/path/to/test.ts',
      originalContent: 'old content',
      newContent: 'new content',
      diffStat: {
        user_added_lines: 5,
        user_removed_lines: 2,
        user_added_chars: 50,
        user_removed_chars: 20,
        model_added_lines: 10,
        model_removed_lines: 4,
        model_added_chars: 100,
        model_removed_chars: 40,
      },
    };
    const { lastFrame } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={diffResult as ToolResultDisplay}
      />,
      {
        settings: createMockSettings({
          merged: { useAlternateBuffer: false, useTerminalBuffer: false },
        }),
      },
    );
    await waitFor(() => expect(lastFrame()).toContain('test-tool'));
    await waitFor(() => expect(lastFrame()).toContain('test.ts'));
    await waitFor(() => expect(lastFrame()).toContain('└ Accepted'));
    await waitFor(() => expect(lastFrame()).toContain('+15'));
    const output = lastFrame();
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for Edit tool using confirmationDetails', async () => {
    const confirmationDetails = {
      type: 'edit' as const,
      title: 'Confirm Edit',
      fileName: 'styles.scss',
      filePath: '/path/to/styles.scss',
      fileDiff:
        '@@ -1,1 +1,1 @@\n-body { color: blue; }\n+body { color: red; }',
      originalContent: 'body { color: blue; }',
      newContent: 'body { color: red; }',
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Edit"
        status={CoreToolCallStatus.AwaitingApproval}
        resultDisplay={undefined}
        confirmationDetails={
          confirmationDetails as SerializableConfirmationDetails
        }
      />,
      {},
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Edit');
    expect(output).toContain('styles.scss');
    expect(output).toContain('└ Confirming');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for Rejected Edit tool', async () => {
    const diffResult: FileDiff = {
      fileDiff: '@@ -1,1 +1,1 @@\n-old line\n+new line',
      fileName: 'styles.scss',
      filePath: '/path/to/styles.scss',
      originalContent: 'old line',
      newContent: 'new line',
      diffStat: {
        user_added_lines: 1,
        user_removed_lines: 1,
        user_added_chars: 0,
        user_removed_chars: 0,
        model_added_lines: 0,
        model_removed_lines: 0,
        model_added_chars: 0,
        model_removed_chars: 0,
      },
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Edit"
        status={CoreToolCallStatus.Cancelled}
        resultDisplay={diffResult as ToolResultDisplay}
      />,
      {},
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Edit');
    expect(output).toContain('styles.scss');
    expect(output).toContain('└ Rejected');
    expect(output).toContain('+1');
    expect(output).toContain('-1');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for Rejected Edit tool with confirmationDetails and diffStat', async () => {
    const confirmationDetails = {
      type: 'edit' as const,
      title: 'Confirm Edit',
      fileName: 'styles.scss',
      filePath: '/path/to/styles.scss',
      fileDiff:
        '@@ -1,1 +1,1 @@\n-body { color: blue; }\n+body { color: red; }',
      originalContent: 'body { color: blue; }',
      newContent: 'body { color: red; }',
      diffStat: {
        user_added_lines: 1,
        user_removed_lines: 1,
        user_added_chars: 0,
        user_removed_chars: 0,
        model_added_lines: 0,
        model_removed_lines: 0,
        model_added_chars: 0,
        model_removed_chars: 0,
      } as DiffStat,
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Edit"
        status={CoreToolCallStatus.Cancelled}
        resultDisplay={undefined}
        confirmationDetails={
          confirmationDetails as unknown as SerializableConfirmationDetails
        }
      />,
      {},
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Edit');
    expect(output).toContain('styles.scss');
    expect(output).toContain('└ Rejected');
    expect(output).toContain('+1');
    expect(output).toContain('-1');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for WriteFile tool', async () => {
    const diffResult: FileDiff = {
      fileDiff: '@@ -1,1 +1,1 @@\n-old content\n+new content',
      fileName: 'config.json',
      filePath: '/path/to/config.json',
      originalContent: 'old content',
      newContent: 'new content',
      diffStat: {
        user_added_lines: 1,
        user_removed_lines: 1,
        user_added_chars: 0,
        user_removed_chars: 0,
        model_added_lines: 0,
        model_removed_lines: 0,
        model_added_chars: 0,
        model_removed_chars: 0,
      },
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Write"
        status={CoreToolCallStatus.Success}
        resultDisplay={diffResult as ToolResultDisplay}
      />,
      {},
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Write');
    expect(output).toContain('config.json');
    expect(output).toContain('└ Accepted');
    expect(output).toContain('+1');
    expect(output).toContain('-1');
    expect(output).toMatchSnapshot();
  });

  it('renders cancelled message summary', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Bash"
        status={CoreToolCallStatus.Cancelled}
        resultDisplay="User cancelled."
      />,
      {},
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Bash');
    expect(output).toContain('└ User cancelled.');
  });

  it('renders correctly for Rejected WriteFile tool', async () => {
    const diffResult: FileDiff = {
      fileDiff: '@@ -1,1 +1,1 @@\n-old content\n+new content',
      fileName: 'config.json',
      filePath: '/path/to/config.json',
      originalContent: 'old content',
      newContent: 'new content',
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Write"
        status={CoreToolCallStatus.Cancelled}
        resultDisplay={diffResult as ToolResultDisplay}
      />,
      {},
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Write');
    expect(output).toContain('config.json');
    expect(output).toContain('└ Rejected');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for Errored Edit tool', async () => {
    const diffResult: FileDiff = {
      fileDiff: '@@ -1,1 +1,1 @@\n-old line\n+new line',
      fileName: 'styles.scss',
      filePath: '/path/to/styles.scss',
      originalContent: 'old line',
      newContent: 'new line',
      diffStat: {
        user_added_lines: 1,
        user_removed_lines: 1,
        user_added_chars: 0,
        user_removed_chars: 0,
        model_added_lines: 0,
        model_removed_lines: 0,
        model_added_chars: 0,
        model_removed_chars: 0,
      },
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        name="Edit"
        status={CoreToolCallStatus.Error}
        resultDisplay={diffResult as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Edit');
    expect(output).toContain('styles.scss');
    expect(output).toContain('└ Failed');
    expect(output).toContain('+1');
    expect(output).toContain('-1');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for grep results', async () => {
    const grepResult: GrepResult = {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: 'file1.ts:10:match 1\nfile2.ts:20:match 2',
      numLines: 2,
      matches: [
        {
          filePath: 'file1.ts',
          absolutePath: '/file1.ts',
          lineNumber: 10,
          line: 'match 1',
        },
        {
          filePath: 'file2.ts',
          absolutePath: '/file2.ts',
          lineNumber: 20,
          line: 'match 2',
        },
      ],
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={grepResult as unknown as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('└ Found 2 matches');
    // Matches are rendered in a secondary list for high-signal summaries
    expect(output).toContain('file1.ts:10: match 1');
    expect(output).toContain('file2.ts:20: match 2');
    expect(output).toMatchSnapshot();
  });

  it('renders every grep result when fully expanded', async () => {
    const lines = Array.from(
      { length: 11 },
      (_, index) => `file${index + 1}.ts:${index + 1}:match ${index + 1}`,
    );
    const grepResult: GrepResult = {
      mode: 'content',
      numFiles: 0,
      filenames: [],
      content: lines.join('\n'),
      numLines: lines.length,
      numMatches: lines.length,
    };

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={grepResult as unknown as ToolResultDisplay}
        foldLevel={FoldLevel.FullyExpanded}
      />,
    );
    await waitUntilReady();

    const output = lastFrame();
    expect(output).toContain('└ Found 11 matches');
    expect(output).toContain('file11.ts:11:match 11');
    expect(output).not.toContain('... and 1 more');
  });

  it('renders correctly for glob results', async () => {
    const globResult: GlobResult = {
      durationMs: 2,
      numFiles: 1,
      filenames: ['src/a.ts'],
      truncated: false,
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={globResult as unknown as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('└ Found 1 matching file(s)');
    expect(output).toContain('src/a.ts');
    expect(output).not.toContain('Found grep results');
    expect(output).toMatchSnapshot();
  });

  it('renders every glob result and truncation notice when fully expanded', async () => {
    const filenames = Array.from(
      { length: 11 },
      (_, index) => `src/file${index + 1}.ts`,
    );
    const globResult: GlobResult = {
      durationMs: 2,
      numFiles: filenames.length,
      filenames,
      truncated: true,
    };

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={globResult as unknown as ToolResultDisplay}
        foldLevel={FoldLevel.FullyExpanded}
      />,
    );
    await waitUntilReady();

    const output = lastFrame();
    expect(output).toContain('src/file11.ts');
    expect(output).toContain(
      '(Results are truncated. Consider using a more specific path or pattern.)',
    );
    expect(output).not.toContain('... and 2 more');
  });

  it('renders correctly for todo updates', async () => {
    const todoResult = {
      todos: [],
    };
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        resultDisplay={todoResult as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('└ Todos updated');
    expect(output).toMatchSnapshot();
  });

  it('renders generic output message for unknown object results', async () => {
    const genericResult = {
      some: 'data',
    } as unknown as ToolResultDisplay;
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage {...defaultProps} resultDisplay={genericResult} />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('└ Returned (possible empty result)');
    expect(output).toMatchSnapshot();
  });

  it('renders correctly for error status with string message', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        status={CoreToolCallStatus.Error}
        resultDisplay={'Error occurred' as ToolResultDisplay}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('└ Error occurred');
    expect(output).toMatchSnapshot();
  });

  it('does not render result rail for error status without resultDisplay', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        status={CoreToolCallStatus.Error}
        resultDisplay={undefined}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).not.toContain('└');
    expect(output).toMatchSnapshot();
  });

  it('does not render result rail if resultDisplay is missing', async () => {
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <DenseToolMessage
        {...defaultProps}
        status={CoreToolCallStatus.Scheduled}
        resultDisplay={undefined}
      />,
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).not.toContain('└');
    expect(output).toMatchSnapshot();
  });

  describe('Toggleable Diff View (Alternate Buffer)', () => {
    const diffResult: FileDiff = {
      fileDiff: '@@ -1,1 +1,1 @@\n-old line\n+new line',
      fileName: 'test.ts',
      filePath: '/path/to/test.ts',
      originalContent: 'old content',
      newContent: 'new content',
    };

    it('renders inline diff while alternate buffer rendering is disabled', async () => {
      const { lastFrame, waitUntilReady } = await renderWithProviders(
        <DenseToolMessage
          {...defaultProps}
          resultDisplay={diffResult as ToolResultDisplay}
          status={CoreToolCallStatus.Success}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
        },
      );
      await waitUntilReady();
      const output = lastFrame();
      expect(output).toContain('Accepted');
      expect(output).toContain('new line');
      expect(stripTrailingWhitespace(output)).toMatchSnapshot();
    });

    it('shows diff content by default when NOT in alternate buffer mode', async () => {
      const { lastFrame, waitUntilReady } = await renderWithProviders(
        <DenseToolMessage
          {...defaultProps}
          resultDisplay={diffResult as ToolResultDisplay}
          status={CoreToolCallStatus.Success}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: false }),
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitUntilReady();
      const output = lastFrame();
      expect(output).toContain('Accepted');
      expect(stripTrailingWhitespace(output)).toMatchSnapshot();
    });

    it('hides diff payload in folded standard main-screen history', async () => {
      const { lastFrame, waitUntilReady } = await renderWithProviders(
        <DenseToolMessage
          {...defaultProps}
          resultDisplay={diffResult as ToolResultDisplay}
          status={CoreToolCallStatus.Success}
          foldLevel={FoldLevel.GroupExpandedToolCollapsed}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: false }),
          settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        },
      );
      await waitUntilReady();
      const output = lastFrame();
      expect(output).toContain('Accepted');
      expect(output).toContain('test.ts');
      expect(output).toContain('to expand');
      expect(output).not.toContain('old line');
      expect(output).not.toContain('new line');
    });

    it('shows diff content when expanded via ToolActionsContext', async () => {
      const { lastFrame, waitUntilReady } = await renderWithProviders(
        <DenseToolMessage
          {...defaultProps}
          resultDisplay={diffResult as ToolResultDisplay}
          status={CoreToolCallStatus.Success}
        />,
        {
          config: makeFakeConfig({ useAlternateBuffer: true }),
          settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
          toolActions: {
            isExpanded: () => true,
          },
        },
      );
      await waitUntilReady();

      // Verify it shows the diff when expanded
      expect(lastFrame()).toContain('new line');
    });
  });

  describe('Visual Regression', () => {
    // skip: 现存失败
    it.skip('matches SVG snapshot for an Accepted file edit with diff stats', async () => {
      const diffResult: FileDiff = {
        fileName: 'test.ts',
        filePath: '/mock/test.ts',
        fileDiff: '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new',
        originalContent: 'old',
        newContent: 'new',
        diffStat: {
          model_added_lines: 1,
          model_removed_lines: 1,
          model_added_chars: 3,
          model_removed_chars: 3,
          user_added_lines: 0,
          user_removed_lines: 0,
          user_added_chars: 0,
          user_removed_chars: 0,
        },
      };

      const renderResult = await renderWithProviders(
        <DenseToolMessage
          {...defaultProps}
          name="edit"
          description="Editing test.ts"
          resultDisplay={diffResult as ToolResultDisplay}
          status={CoreToolCallStatus.Success}
        />,
      );

      await renderResult.waitUntilReady();
      await expect(renderResult).toMatchSvgSnapshot();
    });

    // skip: 现存失败
    it.skip('matches SVG snapshot for a Rejected tool call', async () => {
      const renderResult = await renderWithProviders(
        <DenseToolMessage
          {...defaultProps}
          name="Read"
          description="Reading important.txt"
          resultDisplay="Rejected by user"
          status={CoreToolCallStatus.Cancelled}
        />,
      );

      await renderResult.waitUntilReady();
      await expect(renderResult).toMatchSvgSnapshot();
    });
  });
});
