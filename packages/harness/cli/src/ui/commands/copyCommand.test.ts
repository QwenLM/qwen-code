/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cloneUsage, type AssistantMessage } from '@qwen-code/core';
import { copyCommand } from './copyCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { copyToClipboard } from '../utils/commandUtils.js';

vi.mock('../utils/commandUtils.js', () => ({
  copyToClipboard: vi.fn(),
}));

function createAssistantMessage(id: string, texts: string[]): AssistantMessage {
  return {
    type: 'assistant',
    uuid: id,
    timestamp: '2026-04-21T10:00:00.000Z',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      stop_sequence: null,
      container: null,
      context_management: null,
      usage: cloneUsage(),
      model: 'test-model',
      stop_reason: 'end_turn',
      content: texts.map((text) => ({ type: 'text', text })),
    },
  };
}

describe('copyCommand', () => {
  let tempRoot: string;
  let copyDir: string;
  let mockContext: CommandContext;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'copy-command-test-'));
    vi.spyOn(os, 'tmpdir').mockReturnValue(tempRoot);
    const slug = process.env['BRAND_CLI_SLUG'] || 'qwen-code';
    copyDir = path.join(tempRoot, `${slug}-copy`);

    mockContext = createMockCommandContext({
      ui: {
        addItem: vi.fn(),
        removeComponent: vi.fn(),
      },
    });
  });

  afterEach(async () => {
    vi.mocked(os.tmpdir).mockRestore();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function expectMessageResult(
    result: Awaited<ReturnType<NonNullable<typeof copyCommand.action>>>,
  ): asserts result is Extract<
    Awaited<ReturnType<NonNullable<typeof copyCommand.action>>>,
    { type: 'message' }
  > {
    expect(result?.type).toBe('message');
  }

  it('returns an info message when no assistant messages are available', async () => {
    mockContext.messages = [];

    const result = await copyCommand.action?.(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'No assistant message to copy',
    });
    expect(copyToClipboard).not.toHaveBeenCalled();
  });

  it('copies the latest assistant response when there are no code blocks', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      createAssistantMessage('assistant-1', ['Plain reply']),
    ];

    const result = await copyCommand.action?.(mockContext, '');

    expect(copyToClipboard).toHaveBeenCalledWith(
      'Plain reply',
      expect.anything(),
    );
    expectMessageResult(result);
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect(result.content).toContain(
      'Copied to clipboard (11 characters, 1 lines)',
    );
    expect(result.content).toContain(path.join(copyDir, 'response.md'));
  });

  it('joins multiple assistant text blocks with blank lines', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      createAssistantMessage('assistant-1', ['Part 1', 'Part 2']),
    ];

    await copyCommand.action?.(mockContext, '');

    expect(copyToClipboard).toHaveBeenCalledWith(
      'Part 1\n\nPart 2',
      expect.anything(),
    );
  });

  it('opens a picker when the latest response contains code blocks', async () => {
    mockContext.messages = [
      createAssistantMessage('assistant-1', [
        'Here is code:\n```ts\nconsole.log("hi");\n```',
      ]),
    ];

    const result = await copyCommand.action?.(mockContext, '');

    expect(result?.type).toBe('custom_dialog');
  });

  it('copies the selected code block from the picker', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      createAssistantMessage('assistant-1', [
        'Here is code:\n```ts\nconsole.log("hi");\n```',
      ]),
    ];

    const result = await copyCommand.action?.(mockContext, '');
    expect(result?.type).toBe('custom_dialog');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom dialog result');
    }

    const dialogElement = result.component as React.ReactElement<{
      onCopySelection: (selection: number) => Promise<void>;
    }>;
    await dialogElement.props.onCopySelection(0);

    expect(copyToClipboard).toHaveBeenCalledWith(
      'console.log("hi");',
      expect.anything(),
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: expect.stringContaining('Copied to clipboard'),
      },
      expect.any(Number),
    );
    expect(mockContext.ui.removeComponent).toHaveBeenCalled();
  });

  it('writes the selected content to a temp file from the picker', async () => {
    mockContext.messages = [
      createAssistantMessage('assistant-1', [
        'Here is code:\n```ts\nconsole.log("hi");\n```',
      ]),
    ];

    const result = await copyCommand.action?.(mockContext, '');
    expect(result?.type).toBe('custom_dialog');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom dialog result');
    }

    const dialogElement = result.component as React.ReactElement<{
      onWriteSelection: (selection: number) => Promise<void>;
    }>;
    await dialogElement.props.onWriteSelection(0);

    const writtenPath = path.join(copyDir, 'copy.ts');
    await expect(fs.readFile(writtenPath, 'utf8')).resolves.toBe(
      'console.log("hi");',
    );
    expect(mockContext.ui.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: `Written to ${writtenPath}`,
      },
      expect.any(Number),
    );
  });

  it('persists the always-copy-full-response preference from the picker', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      createAssistantMessage('assistant-1', [
        'Here is code:\n```ts\nconsole.log("hi");\n```',
      ]),
    ];

    const result = await copyCommand.action?.(mockContext, '');
    expect(result?.type).toBe('custom_dialog');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom dialog result');
    }

    const dialogElement = result.component as React.ReactElement<{
      onCopySelection: (selection: 'always') => Promise<void>;
    }>;
    await dialogElement.props.onCopySelection('always');

    expect(mockContext.services.settings.setValue).toHaveBeenCalledWith(
      'User',
      'ui.copyFullResponse',
      true,
    );
    expect(copyToClipboard).toHaveBeenCalledWith(
      'Here is code:\n```ts\nconsole.log("hi");\n```',
      expect.anything(),
    );
  });

  it('skips the picker when always-copy-full-response is enabled', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      createAssistantMessage('assistant-1', [
        'Here is code:\n```ts\nconsole.log("hi");\n```',
      ]),
    ];
    (
      mockContext.services.settings.merged as {
        ui: { copyFullResponse: boolean };
      }
    ).ui = {
      copyFullResponse: true,
    };

    const result = await copyCommand.action?.(mockContext, '');

    expectMessageResult(result);
    expect(result?.type).toBe('message');
    expect(copyToClipboard).toHaveBeenCalledWith(
      'Here is code:\n```ts\nconsole.log("hi");\n```',
      expect.anything(),
    );
  });

  it('supports copying the Nth-latest assistant response', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      createAssistantMessage('assistant-1', ['First reply']),
      createAssistantMessage('assistant-2', ['Second reply']),
    ];

    await copyCommand.action?.(mockContext, '2');

    expect(copyToClipboard).toHaveBeenCalledWith(
      'First reply',
      expect.anything(),
    );
  });

  it('returns a usage error for invalid N values', async () => {
    mockContext.messages = [createAssistantMessage('assistant-1', ['Reply'])];

    const result = await copyCommand.action?.(mockContext, 'abc');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Usage: /copy [N] where N is 1 (latest), 2, 3, ... Got: abc',
    });
  });

  it('returns an info message when N exceeds available assistant messages', async () => {
    mockContext.messages = [createAssistantMessage('assistant-1', ['Reply'])];

    const result = await copyCommand.action?.(mockContext, '2');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'Only 1 assistant message available to copy',
    });
  });

  it('skips assistant turns that contain no text', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);
    mockContext.messages = [
      {
        type: 'assistant',
        uuid: 'assistant-1',
        timestamp: '2026-04-21T10:00:00.000Z',
        message: {
          id: 'assistant-1',
          type: 'message',
          role: 'assistant',
          stop_sequence: null,
          container: null,
          context_management: null,

          model: 'test-model',
          stop_reason: 'tool_use',

          usage: cloneUsage(),
          content: [
            {
              type: 'tool_use',
              id: 'tool-1',
              name: 'Read',
              input: {},
            },
          ],
        },
      },
      createAssistantMessage('assistant-2', ['Visible reply']),
    ];

    await copyCommand.action?.(mockContext, '');

    expect(copyToClipboard).toHaveBeenCalledWith(
      'Visible reply',
      expect.anything(),
    );
  });

  it('returns an error message when clipboard copy fails', async () => {
    vi.mocked(copyToClipboard).mockRejectedValue(new Error('Clipboard denied'));
    mockContext.messages = [createAssistantMessage('assistant-1', ['Reply'])];

    const result = await copyCommand.action?.(mockContext, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Failed to copy to the clipboard. Clipboard denied',
    });
  });
});
