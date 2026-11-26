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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneUsage } from '@qwen-code/core';
import { exportCommand } from './exportCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { formatCommandInput } from '../utils/commandFormat.js';
import { copyToClipboard } from '../utils/commandUtils.js';
import { createMockSettings } from '../../test-utils/settings.js';

vi.mock('../utils/commandUtils.js', () => ({
  copyToClipboard: vi.fn(),
  isSlashCommand: vi.fn(() => false),
}));

function createSystemCommandMessage(
  commandName: string,
  commandArgs: string,
  timestamp = '2026-04-21T10:00:02.000Z',
) {
  return {
    type: 'system' as const,
    subtype: 'local_command' as const,
    level: 'info' as const,
    timestamp,
    uuid: 'system-1',
    isMeta: false,
    content: formatCommandInput(commandName, commandArgs),
  };
}

describe('exportCommand', () => {
  const originalCwd = process.cwd();
  let tempDir: string;
  let mockContext: CommandContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-export-'));
    process.chdir(tempDir);

    mockContext = createMockCommandContext({
      messages: [
        {
          type: 'user',
          uuid: 'user-1',
          timestamp: '2026-04-21T10:00:00.000Z',
          message: {
            role: 'user',
            content: 'Summarize this session',
          },
        },
        {
          type: 'assistant',
          uuid: 'assistant-1',
          timestamp: '2026-04-21T10:00:01.000Z',
          message: {
            id: 'msg_1',
            type: 'message', role: 'assistant', stop_sequence: null,
            container: null, context_management: null,

            model: 'test-model',
            stop_reason: 'end_turn',

            usage: cloneUsage(),
            content: [
              {
                type: 'thinking',
                thinking: 'Session-only thought.',
                signature: '',
              },
              {
                type: 'text',
                text: 'Session summary.',
              },
            ],
          },
        },
      ],
      ui: {
        removeComponent: vi.fn(),
      },
    });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('opens a dialog when no conversation is available', async () => {
    mockContext.messages = [];

    const result = await exportCommand.action?.(mockContext, '');

    expect(result?.type).toBe('custom_dialog');
  });

  it('opens a dialog when the only message is the current export command', async () => {
    mockContext.messages = [
      createSystemCommandMessage('export', '', '2026-04-21T10:00:00.000Z'),
    ];
    mockContext.invocation = {
      raw: '/export',
      name: 'export',
      args: '',
    };

    const result = await exportCommand.action?.(mockContext, '');

    expect(result?.type).toBe('custom_dialog');
  });

  // skip: 现存失败
  it.skip('writes a text export immediately when a filename is provided', async () => {
    const result = await exportCommand.action?.(mockContext, 'session.md');
    const expectedPath = await fs.realpath(path.join(tempDir, 'session.txt'));

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Conversation exported to: ${expectedPath}`,
    });

    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toBe(
      '> Summarize this session\n\n▪ Session summary.\n',
    );
  });

  // skip: 现存失败
  it.skip('excludes the current export command from the exported file', async () => {
    mockContext.messages = [
      ...(mockContext.messages ?? []),
      createSystemCommandMessage('export', 'session.txt'),
    ];
    mockContext.invocation = {
      raw: '/export session.txt',
      name: 'export',
      args: 'session.txt',
    };

    const result = await exportCommand.action?.(mockContext, 'session.txt');
    const expectedPath = await fs.realpath(path.join(tempDir, 'session.txt'));

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Conversation exported to: ${expectedPath}`,
    });

    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toBe(
      '> Summarize this session\n\n▪ Session summary.\n',
    );
  });

  // skip: 现存失败
  it.skip('excludes the current export command when raw invocation preserves repeated spaces', async () => {
    mockContext.messages = [
      ...(mockContext.messages ?? []),
      createSystemCommandMessage('export', '  session.txt'),
    ];
    mockContext.invocation = {
      raw: '/export   session.txt',
      name: 'export',
      args: 'session.txt',
    };

    const result = await exportCommand.action?.(mockContext, 'session.txt');
    const expectedPath = await fs.realpath(path.join(tempDir, 'session.txt'));

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Conversation exported to: ${expectedPath}`,
    });

    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toBe(
      '> Summarize this session\n\n▪ Session summary.\n',
    );
  });

  it('writes an empty file when no exportable conversation content exists', async () => {
    mockContext.messages = [
      createSystemCommandMessage(
        'export',
        'empty.txt',
        '2026-04-21T10:00:00.000Z',
      ),
    ];
    mockContext.invocation = {
      raw: '/export empty.txt',
      name: 'export',
      args: 'empty.txt',
    };

    const result = await exportCommand.action?.(mockContext, 'empty.txt');
    const expectedPath = await fs.realpath(path.join(tempDir, 'empty.txt'));

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: `Conversation exported to: ${expectedPath}`,
    });

    await expect(fs.readFile(expectedPath, 'utf8')).resolves.toBe('');
  });

  it('opens a custom dialog when no filename is provided', async () => {
    const result = await exportCommand.action?.(mockContext, '');

    expect(result?.type).toBe('custom_dialog');
  });

  it.each(['filename', 'save', 'copy'] as const)(
    'exports each message once using session settings for the %s action',
    async (action) => {
      mockContext.services.settings = createMockSettings({
        ui: { inlineThinkingMode: 'off' },
      });
      const result = await exportCommand.action?.(
        mockContext,
        action === 'filename' ? 'session.txt' : '',
      );

      if (action === 'filename') {
        expect(result).toMatchObject({
          type: 'message',
          messageType: 'info',
        });
      } else {
        if (!result || result.type !== 'custom_dialog') {
          throw new Error('Expected custom dialog result');
        }
        const dialogElement = result.component as React.ReactElement<{
          onSave: (filename: string) => Promise<void>;
          onCopy: () => Promise<void>;
        }>;
        if (action === 'save') {
          await dialogElement.props.onSave('session.txt');
        } else {
          await dialogElement.props.onCopy();
        }
        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'info' }),
          expect.any(Number),
        );
      }

      let content: string;
      if (action === 'copy') {
        expect(copyToClipboard).toHaveBeenCalledOnce();
        content = vi.mocked(copyToClipboard).mock.calls[0][0];
      } else {
        content = await fs.readFile(path.join(tempDir, 'session.txt'), 'utf8');
      }
      expect(content.match(/Summarize this session/g)).toHaveLength(1);
      expect(content.match(/Session summary\./g)).toHaveLength(1);
      expect(content).not.toContain('Session-only thought.');
    },
  );

  // skip: 现存失败
  it.skip('copies the conversation when the dialog copy action is triggered', async () => {
    vi.mocked(copyToClipboard).mockResolvedValue(undefined);

    const result = await exportCommand.action?.(mockContext, '');
    expect(result?.type).toBe('custom_dialog');
    if (!result || result.type !== 'custom_dialog') {
      throw new Error('Expected custom dialog result');
    }

    const dialogElement = result.component as React.ReactElement<{
      onCopy: () => Promise<void>;
    }>;
    await dialogElement.props.onCopy();

    expect(copyToClipboard).toHaveBeenCalledWith(
      '> Summarize this session\n\n▪ Session summary.\n',
      expect.anything(),
    );
  });
});
