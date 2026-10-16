/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import { createMockCommandContext } from '../test-utils/mockCommandContext.js';
import { setLanguageAsync } from '../i18n/index.js';
import { createSlashCommandFromDefinition } from './command-factory.js';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  permissions: vi.fn(),
  execute: vi.fn(),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPathFromWorkspace: mocks.read,
  checkCommandPermissions: mocks.permissions,
}));
vi.mock('@qwen-code/qwen-code-core/sandbox/runtime-shell.js', () => ({
  executeRuntimeShell: mocks.execute,
}));

describe('createSlashCommandFromDefinition', () => {
  beforeEach(async () => {
    await setLanguageAsync('en');
  });

  it('marks custom file commands with stable source detail', () => {
    const command = createSlashCommandFromDefinition(
      '/workspace/.qwen/commands/review.toml',
      '/workspace/.qwen/commands',
      {
        prompt: 'Review the current changes',
      },
      undefined,
      '.toml',
    );

    expect(command.source).toBe('skill-dir-command');
    expect(command.sourceLabel).toBe('Custom');
    expect(command.sourceDetail).toBe('custom');
  });

  it('marks extension commands with stable source detail', () => {
    const command = createSlashCommandFromDefinition(
      '/workspace/.qwen/extensions/demo/commands/review.md',
      '/workspace/.qwen/extensions/demo/commands',
      {
        prompt: 'Review the current changes',
      },
      'demo',
      '.md',
    );

    expect(command.source).toBe('plugin-command');
    expect(command.extensionName).toBe('demo');
    expect(command.sourceLabel).toBe('Extension: demo');
    expect(command.sourceDetail).toBe('extension');
  });
});

describe('custom command file contents', () => {
  const literal = 'Literal {{args}} !{echo FROM_FILE} and unfinished !{';
  const media = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permissions.mockResolvedValue({
      allAllowed: true,
      disallowedCommands: [],
    });
    mocks.execute.mockResolvedValue({
      result: Promise.resolve({
        output: 'shell @{other} !{echo OUTPUT} {{args}}',
        exitCode: 0,
        error: null,
        aborted: false,
        signal: null,
      }),
    });
  });

  function setup(prompt: string, args = 'USER_ARG') {
    const command = createSlashCommandFromDefinition(
      '/workspace/.qwen/commands/probe.toml',
      '/workspace/.qwen/commands',
      { prompt },
      undefined,
      '.toml',
    );
    const config = {
      getApprovalMode: () => ApprovalMode.DEFAULT,
      getShellExecutionConfig: () => ({}),
      getTargetDir: () => '/workspace',
      getShouldUseNodePtyShell: () => false,
    } as Config;
    const context = createMockCommandContext({
      invocation: { raw: `/probe ${args}`, name: 'probe', args },
      services: { config },
      session: { sessionShellAllowlist: new Set() },
    });
    return { command, context };
  }

  it.each([
    { kind: 'string', content: 'Literal {{args}} !{echo FROM_FILE}' },
    { kind: 'object', content: literal },
  ])(
    'keeps $kind file text and media opaque while expanding template arguments',
    async ({ kind, content }) => {
      mocks.read.mockResolvedValue([
        kind === 'string' ? content : { text: content },
        media,
      ]);
      const { command, context } = setup('{{args}} @{notes.md} Task {{args}}');
      const result = await command.action!(context, 'USER_ARG');
      expect(result).toEqual({
        type: 'submit_prompt',
        content: [
          { text: 'USER_ARG ' },
          { text: content },
          media,
          { text: ' Task USER_ARG' },
        ],
      });
      expect(mocks.permissions).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it('approves only template shell commands and preserves file data when retried', async () => {
    mocks.read.mockImplementation(async () => [{ text: literal }]);
    mocks.permissions.mockResolvedValueOnce({
      allAllowed: false,
      disallowedCommands: ['echo TEMPLATE'],
    });
    const args = '@{from-args} !{echo ARGS} {{args}}';
    const { command, context } = setup(
      '@{notes.md} !{echo TEMPLATE} {{args}}',
      args,
    );
    expect(await command.action!(context, args)).toEqual({
      type: 'confirm_shell_commands',
      commandsToConfirm: ['echo TEMPLATE'],
      originalInvocation: { raw: `/probe ${args}` },
    });
    expect(mocks.execute).not.toHaveBeenCalled();
    context.session.sessionShellAllowlist.add('echo TEMPLATE');
    expect(await command.action!(context, args)).toEqual({
      type: 'submit_prompt',
      content: [
        { text: literal },
        { text: ` shell @{other} !{echo OUTPUT} {{args}} ${args}` },
      ],
    });
    expect(mocks.permissions.mock.calls.map(([command]) => command)).toEqual([
      'echo TEMPLATE',
      'echo TEMPLATE',
    ]);
    expect(mocks.read.mock.calls.map(([path]) => path)).toEqual([
      'notes.md',
      'notes.md',
    ]);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
});
