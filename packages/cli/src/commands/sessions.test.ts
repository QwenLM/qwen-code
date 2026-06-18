/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('./sessions/list.js', () => ({
  listCommand: {
    command: 'list',
    describe: 'List sessions',
  },
}));

import { sessionsCommand } from './sessions.js';
import { type Argv } from 'yargs';
import yargs from 'yargs';

describe('sessions command', () => {
  it('should have correct command definition', () => {
    expect(sessionsCommand.command).toBe('sessions');
    expect(sessionsCommand.describe).toBe('Manage Qwen Code sessions');
    expect(typeof sessionsCommand.builder).toBe('function');
    expect(typeof sessionsCommand.handler).toBe('function');
  });

  it('should not inherit global flags', async () => {
    const yargsInstance = yargs();
    const builder = sessionsCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('sessions command builder must be a function');
    }
    const builtYargs = await builder(yargsInstance);
    // getOptions() exists at runtime but is not in @types/yargs.
    // mcp.test.ts uses the same pattern and is excluded from typecheck.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options = (builtYargs as any).getOptions();

    // Should have exactly 1 option (help flag)
    expect(Object.keys(options.key).length).toBe(1);
    expect(options.key).toHaveProperty('help');
  });

  it('should register list subcommand', () => {
    const mockYargs = {
      command: vi.fn().mockReturnThis(),
      demandCommand: vi.fn().mockReturnThis(),
      version: vi.fn().mockReturnThis(),
    };

    const builder = sessionsCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('sessions command builder must be a function');
    }
    builder(mockYargs as unknown as Argv);

    expect(mockYargs.command).toHaveBeenCalledTimes(1);

    const commandCalls = mockYargs.command.mock.calls;
    const commandNames = commandCalls.map((call) => call[0].command);

    expect(commandNames).toContain('list');

    expect(mockYargs.demandCommand).toHaveBeenCalledWith(
      1,
      'You need at least one command before continuing.',
    );
  });
});
