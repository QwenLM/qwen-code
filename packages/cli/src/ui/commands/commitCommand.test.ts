/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { commitCommand } from './commitCommand.js';
import { CommandKind } from './types.js';

describe('commitCommand', () => {
  it('should have the correct name and kind', () => {
    expect(commitCommand.name).toBe('commit');
    expect(commitCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should have alt name "ci"', () => {
    expect(commitCommand.altNames).toEqual(['ci']);
  });

  it('should support all execution modes', () => {
    expect(commitCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('should return an error when no message is provided', async () => {
    const result = await commitCommand.action!({} as never, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Commit message required'),
    });
  });

  it('should return an error when only whitespace is provided', async () => {
    const result = await commitCommand.action!({} as never, '   ');
    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: expect.stringContaining('Commit message required'),
    });
  });

  it('should return a tool action for run_shell_command with the commit message', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: resolve login bug',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description: expect.stringContaining('Stage all changes'),
        command: 'git add -A && git commit -m "fix: resolve login bug"',
        is_background: false,
      },
    });
  });

  it('should escape double quotes in the commit message', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: resolve "login" bug',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description: expect.stringContaining('Stage all changes'),
        command: 'git add -A && git commit -m "fix: resolve \\"login\\" bug"',
        is_background: false,
      },
    });
  });

  it('should trim whitespace from the message', async () => {
    const result = await commitCommand.action!(
      {} as never,
      '  fix: something  ',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description: expect.stringContaining('Stage all changes'),
        command: 'git add -A && git commit -m "fix: something"',
        is_background: false,
      },
    });
  });
});
