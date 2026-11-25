/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, memo, type ReactElement } from 'react';
import { Box } from 'ink';
import chalk from 'chalk';
import {
  CoreToolCallStatus,
  HookBlockingErrorAttachment,
  HookNonBlockingErrorAttachment,
  HookStoppedContinuationAttachment,
  type FileDiff,
} from '@qwen-code/core';
import {
  renderWithProviders,
  type RenderWithProvidersInstance,
} from '../../../test-utils/render.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { themeManager } from '../../themes/theme-manager.js';
import { theme } from '../../semantic-colors.js';
import { FoldLevel } from '../../constants/messageLayout.js';
import { DenseToolMessage } from './DenseToolMessage.js';
import { CodeModeToolMessage } from './CodeModeToolMessage.js';
import { buildHookAttachmentHistoryItem } from './HookAttachmentMessage.js';

// The shared Vitest alias discards colors. Exercise real ANSI styling instead.
vi.mock('@alcalzone/ansi-tokenize', async () => {
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const packageJson = createRequire(import.meta.url).resolve(
    '@alcalzone/ansi-tokenize/package.json',
  );
  return import(new URL('./build/index.js', pathToFileURL(packageJson)).href);
});

const originalChalkLevel = chalk.level;

beforeEach(() => {
  chalk.level = 3;
  themeManager.setTerminalBackground('#000000');
  themeManager.setActiveTheme('Default');
});

afterEach(() => {
  chalk.level = originalChalkLevel;
  themeManager.setTerminalBackground(undefined);
  themeManager.setActiveTheme('Default');
});

// Keep both the element and its parent cached: only theme subscriptions may
// refresh the message. Never call the test harness's rerender method.
async function renderCached(element: ReactElement) {
  const parentRender = vi.fn();
  const Parent = memo(() => {
    parentRender();
    return element;
  });
  Parent.displayName = 'CachedMessageParent';
  const result = await renderWithProviders(<Parent />, {
    width: 80,
    settings: createMockSettings({ ui: { useAlternateBuffer: false } }),
  });
  await result.waitUntilReady();
  const parentRenderCount = parentRender.mock.calls.length;
  return {
    ...result,
    async switchTheme() {
      await act(async () => {
        themeManager.setTerminalBackground('#ffffff');
        themeManager.setActiveTheme('Default Light');
      });
      await result.waitUntilReady();
      expect(parentRender).toHaveBeenCalledTimes(parentRenderCount);
    },
  };
}

// Assert the target text's actual terminal cells, not a color that an
// unrelated header or status indicator could contribute to the same SVG.
function expectTextColor(
  result: RenderWithProvidersInstance,
  text: string,
  color: string,
) {
  const buffer = result.terminal.buffer.active;
  for (let row = buffer.baseY; row < buffer.length; row++) {
    const line = buffer.getLine(row)!;
    const column = line.translateToString(true).indexOf(text);
    if (column < 0) continue;
    for (let index = 0; index < text.length; index++) {
      if (text[index] === ' ') continue;
      const cell = line.getCell(column + index)!;
      expect(cell.isFgRGB(), `${text} character ${index}`).toBe(true);
      expect(cell.getFgColor(), `${text} character ${index}`).toBe(
        Number.parseInt(color.slice(1), 16),
      );
    }
    return;
  }
  throw new Error(`Missing terminal text: ${text}`);
}

const toolProps = {
  callId: 'retained-tool',
  name: 'RetainedTool',
  description: 'Unchanged description',
  status: CoreToolCallStatus.Success,
  resultDisplay: undefined,
  confirmationDetails: undefined,
  terminalWidth: 80,
};

describe('cached message theme colors', () => {
  it.each([
    CoreToolCallStatus.Success,
    CoreToolCallStatus.Error,
    CoreToolCallStatus.Cancelled,
  ])('recolors the dense %s summary', async (status) => {
    const result = await renderCached(
      <DenseToolMessage
        {...toolProps}
        status={status}
        resultDisplay="Retained summary"
      />,
    );
    const getColor = () =>
      status === CoreToolCallStatus.Success
        ? theme.status.success
        : theme.status.error;
    try {
      const darkColor = getColor();
      const frame = result.lastFrame();
      expectTextColor(result, 'Retained summary', darkColor);
      await result.switchTheme();
      expect(getColor()).not.toBe(darkColor);
      expectTextColor(result, 'Retained summary', getColor());
      expect(result.lastFrame()).toBe(frame);
      await expect(result).toMatchSvgSnapshot();
    } finally {
      result.unmount();
    }
  });

  it('recolors dense payload text cached by the success builder', async () => {
    const result = await renderCached(
      <DenseToolMessage
        {...toolProps}
        resultDisplay={{ summary: 'Retained summary', payload: 'Retained payload' }}
      />,
    );
    try {
      const darkColor = theme.text.response;
      const frame = result.lastFrame();
      expectTextColor(result, 'Retained payload', darkColor);
      await result.switchTheme();
      expect(theme.text.response).not.toBe(darkColor);
      expectTextColor(result, 'Retained payload', theme.text.response);
      expect(result.lastFrame()).toBe(frame);
      await expect(result).toMatchSvgSnapshot();
    } finally {
      result.unmount();
    }
  });

  it('recolors dense file diff summary and nested stats', async () => {
    const diff: FileDiff = {
      fileName: 'retained.ts',
      filePath: '/project/retained.ts',
      originalContent: 'old',
      newContent: 'new',
      fileDiff: '@@ -1 +1 @@\n-old\n+new',
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
    const result = await renderCached(
      <DenseToolMessage
        {...toolProps}
        resultDisplay={diff}
        foldLevel={FoldLevel.GroupExpandedToolCollapsed}
      />,
    );
    const assertColors = () => {
      expectTextColor(result, 'Accepted', theme.status.success);
      expectTextColor(result, 'retained.ts', theme.text.response);
      expectTextColor(result, '+1', theme.status.success);
      expectTextColor(result, '-1', theme.status.error);
    };
    try {
      const frame = result.lastFrame();
      assertColors();
      await result.switchTheme();
      assertColors();
      expect(result.lastFrame()).toBe(frame);
      await expect(result).toMatchSvgSnapshot();
    } finally {
      result.unmount();
    }
  });

  it('re-highlights a cached expanded CodeMode script', async () => {
    const result = await renderCached(
      <CodeModeToolMessage
        {...toolProps}
        name="CodeMode"
        args={{ code: 'const answer = 42;' }}
        foldLevel={FoldLevel.FullyExpanded}
        isFirst
        borderColor={theme.border.default}
        borderDimColor
      />,
    );
    const getColor = () =>
      themeManager.getActiveTheme().getInkColor('hljs-keyword')!;
    try {
      const darkColor = getColor();
      const frame = result.lastFrame();
      expect(frame).toContain('const answer = 42;');
      expectTextColor(result, 'const', darkColor);
      await result.switchTheme();
      expect(getColor()).not.toBe(darkColor);
      expectTextColor(result, 'const', getColor());
      expect(result.lastFrame()).toBe(frame);
      await expect(result).toMatchSvgSnapshot();
    } finally {
      result.unmount();
    }
  });

  const hookBase = { hookName: 'PreToolUse:Bash', hookEvent: 'PreToolUse', toolUseID: 't' };
  it.each([
    {
      attachment: new HookNonBlockingErrorAttachment({
        ...hookBase,
        type: 'hook_non_blocking_error',
        stderr: 'Retained error body\nHidden second line',
        stdout: '',
        exitCode: 1,
        command: 'hook-command',
      }),
      lines: ['PreToolUse:Bash hook error', 'Retained error body'],
      token: 'error' as const,
    },
    {
      attachment: new HookBlockingErrorAttachment({
        ...hookBase,
        type: 'hook_blocking_error',
        blockingError: { blockingError: 'Retained blocking body', command: 'hook-command' },
      }),
      lines: ['PreToolUse:Bash hook returned blocking error', 'Retained blocking body'],
      token: 'error' as const,
    },
    {
      attachment: new HookStoppedContinuationAttachment({
        ...hookBase,
        type: 'hook_stopped_continuation',
        message: 'Retained stop reason',
      }),
      lines: ['PreToolUse:Bash hook stopped continuation: Retained stop reason'],
      token: 'warning' as const,
    },
  ])('recolors stored $attachment.type content without rebuilding it', async ({ attachment, lines, token }) => {
    // Build only once, as when a hook attachment is appended to history.
    const item = buildHookAttachmentHistoryItem(attachment);
    expect(item).not.toBeNull();
    const result = await renderCached(<Box>{item!.content}</Box>);
    try {
      const darkColor = theme.status[token];
      const frame = result.lastFrame();
      expect(frame.match(/⎿/g)).toHaveLength(lines.length);
      expect(frame).not.toContain('Hidden second line');
      for (const line of lines) {
        expectTextColor(result, line, darkColor);
      }
      await result.switchTheme();
      expect(theme.status[token]).not.toBe(darkColor);
      for (const line of lines) {
        expectTextColor(result, line, theme.status[token]);
      }
      expect(result.lastFrame()).toBe(frame);
      await expect(result).toMatchSvgSnapshot();
    } finally {
      result.unmount();
    }
  });
});
