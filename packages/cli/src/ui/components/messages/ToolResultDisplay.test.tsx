/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import {
  CoreToolCallStatus,
  type GlobResult,
  type GrepResult,
  makeFakeConfig,
} from '@qwen-code/core';

describe('ToolResultDisplay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders compact summary for todos result', async () => {
    const todoResult = {
      todos: [{ description: 'Check feed rendering', status: 'completed' }],
    };
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay={todoResult}
        terminalWidth={80}
        availableTerminalHeight={20}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
      },
    );
    await waitUntilReady();
    const output = lastFrame({ allowEmpty: true });

    expect(output).toContain('Updated 1 todo');
    expect(output).toMatchSnapshot();
    unmount();
  });

  it('shows every CodeMode child and the summary under the compact line cap', async () => {
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay={{
          isCodeModeDisplay: true,
          children: ['a', 'b', 'c'].map((name) => ({
            callId: name,
            name: 'Read',
            args: { file_path: `/repo/${name}.ts` },
            status: CoreToolCallStatus.Success,
            resultDisplay: `Read lines 1-5 of ${name}`,
          })),
          summary: 'completed: 3 tool calls\nscript done',
        }}
        terminalWidth={100}
        availableTerminalHeight={20}
        maxLines={3}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        uiState: { constrainHeight: true },
      },
    );
    await waitUntilReady();
    const output = lastFrame() ?? '';
    expect(output).toContain('Read lines 1-5 of c');
    expect(output).toContain('script done');
    unmount();
  });

  it('does not fall back to plain text if availableHeight is set and not in alternate buffer', async () => {
    // availableHeight calculation: 20 - 1 - 5 = 14 > 3
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay="**Some result**"
        terminalWidth={80}
        availableTerminalHeight={20}
        renderOutputAsMarkdown={true}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
        uiState: { constrainHeight: true },
      },
    );
    await waitUntilReady();
    const output = lastFrame();
    expect(output).toMatchSnapshot();
    unmount();
  });

  it('keeps markdown if in alternate buffer even with availableHeight', async () => {
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay="**Some result**"
        terminalWidth={80}
        availableTerminalHeight={20}
        renderOutputAsMarkdown={true}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: true }),
        settings: createMockSettings({ ui: { useAlternateBuffer: true } }),
      },
    );
    await waitUntilReady();
    const output = lastFrame();

    expect(output).toMatchSnapshot();
    unmount();
  });

  it('renders structured grep result with legacy display text', async () => {
    const grepResult: GrepResult = {
      mode: 'files_with_matches',
      numFiles: 2,
      filenames: ['src/a.ts', 'src/b.ts'],
    };

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay={grepResult}
        terminalWidth={80}
        availableTerminalHeight={20}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
      },
    );
    await waitUntilReady();
    const output = lastFrame();

    expect(output).toContain('Found 2 files');
    expect(output).not.toContain('"filenames"');
    expect(output).not.toContain('src/a.ts');
    unmount();
  });

  it('renders structured glob result with legacy display text', async () => {
    const globResult: GlobResult = {
      durationMs: 3,
      numFiles: 1,
      filenames: ['src/a.ts'],
      truncated: false,
    };

    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <ToolResultDisplay
        resultDisplay={globResult}
        terminalWidth={80}
        availableTerminalHeight={20}
      />,
      {
        config: makeFakeConfig({ useAlternateBuffer: false }),
        settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
      },
    );
    await waitUntilReady();
    const output = lastFrame();

    expect(output).toContain('Found 1 matching file(s)');
    expect(output).not.toContain('"durationMs"');
    expect(output).not.toContain('src/a.ts');
    unmount();
  });
});
