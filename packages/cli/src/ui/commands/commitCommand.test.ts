/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { commitCommand } from './commitCommand.js';
import { CommandKind, type ToolActionReturn } from './types.js';

describe('commitCommand', () => {
  it('should have the correct name and kind', () => {
    expect(commitCommand.name).toBe('commit');
    expect(commitCommand.kind).toBe(CommandKind.BUILT_IN);
  });

  it('should have alt name "ci"', () => {
    expect(commitCommand.altNames).toEqual(['ci']);
  });

  it('should support only interactive execution mode', () => {
    expect(commitCommand.supportedModes).toEqual(['interactive']);
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
        description: expect.stringContaining('Show status'),
        command:
          "git status --short && git add -A && git commit -m 'fix: resolve login bug'",
        is_background: false,
      },
    });
  });

  it('should safely escape double quotes via shell-quote', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: resolve "login" bug',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description: expect.stringContaining('Show status'),
        command:
          'git status --short && git add -A && git commit -m \'fix: resolve "login" bug\'',
        is_background: false,
      },
    });
  });

  it('should safely escape backslashes via shell-quote', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: C:\\Users\\test',
    );
    expect(result).toEqual({
      type: 'tool',
      toolName: 'run_shell_command',
      toolArgs: {
        description: expect.stringContaining('Show status'),
        command:
          "git status --short && git add -A && git commit -m 'fix: C:\\Users\\test'",
        is_background: false,
      },
    });
  });

  it('should prevent command substitution via $()', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: $(touch /tmp/pwned)',
    );
    const command = (result as ToolActionReturn).toolArgs['command'] as string;
    // The dangerous content must be inside single quotes so the shell treats it as literal
    expect(command).toContain("git commit -m 'fix: $(touch /tmp/pwned)'");
    expect(command).toContain('git commit -m');
  });

  it('should prevent command substitution via backticks', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: `touch /tmp/pwned`',
    );
    const command = (result as ToolActionReturn).toolArgs['command'] as string;
    // Backtick content must be inside single quotes
    expect(command).toContain("git commit -m 'fix: `touch /tmp/pwned`'");
    expect(command).toContain('git commit -m');
  });

  it('should prevent variable expansion via $VAR', async () => {
    const result = await commitCommand.action!({} as never, 'fix: $HOME');
    const command = (result as ToolActionReturn).toolArgs['command'] as string;
    // $HOME must be inside single quotes, not double quotes
    expect(command).toContain("git commit -m 'fix: $HOME'");
    expect(command).not.toContain('"$HOME"');
    expect(command).toContain('git commit -m');
  });

  it('should prevent command injection via semicolon', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: something; touch /tmp/pwned',
    );
    const command = (result as ToolActionReturn).toolArgs['command'] as string;
    // Semicolon must be inside single quotes so it's not a command separator
    expect(command).toContain(
      "git commit -m 'fix: something; touch /tmp/pwned'",
    );
    expect(command).toContain('git commit -m');
  });

  it('should prevent command injection via newline', async () => {
    const result = await commitCommand.action!(
      {} as never,
      'fix: something\ntouch /tmp/pwned',
    );
    const command = (result as ToolActionReturn).toolArgs['command'] as string;
    // Newline must be inside single quotes so it's not a command separator
    expect(command).toContain("git commit -m 'fix: something");
    expect(command).toContain("touch /tmp/pwned'");
    expect(command).toContain('git commit -m');
  });

  it('should handle single quotes in the message', async () => {
    const result = await commitCommand.action!(
      {} as never,
      "fix: it's working",
    );
    const command = (result as ToolActionReturn).toolArgs['command'] as string;
    expect(command).toContain('git commit -m');
    // shell-quote handles single quotes by wrapping in double quotes
    expect(command).toMatch(/git commit -m "fix: it's working"/);
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
        description: expect.stringContaining('Show status'),
        command:
          "git status --short && git add -A && git commit -m 'fix: something'",
        is_background: false,
      },
    });
  });
});
