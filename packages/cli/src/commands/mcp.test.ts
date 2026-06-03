/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { mcpCommand } from './mcp.js';
import { type Argv } from 'yargs';
import yargs from 'yargs';

describe('mcp command', () => {
  it('should have correct command definition', () => {
    expect(mcpCommand.command).toBe('mcp');
    expect(mcpCommand.describe).toBe('Manage MCP servers');
    expect(typeof mcpCommand.builder).toBe('function');
    expect(typeof mcpCommand.handler).toBe('function');
  });

  it('should have exactly one option (help flag)', () => {
    // Test to ensure that the global 'gemini' flags are not added to the mcp command
    const yargsInstance = yargs();
    const builder = mcpCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('mcp command builder must be a function');
    }
    const builtYargs = builder(yargsInstance);
    const options = builtYargs.getOptions();

    // Should have exactly 1 option (help flag)
    expect(Object.keys(options.key).length).toBe(1);
    expect(options.key).toHaveProperty('help');
  });

  it('should register add, remove, and list subcommands', () => {
    const mockYargs = {
      command: vi.fn().mockReturnThis(),
      demandCommand: vi.fn().mockReturnThis(),
      version: vi.fn().mockReturnThis(),
    };

    const builder = mcpCommand.builder;
    if (typeof builder !== 'function') {
      throw new Error('mcp command builder must be a function');
    }
    builder(mockYargs as unknown as Argv);

    expect(mockYargs.command).toHaveBeenCalledTimes(6);

    // Verify that the specific subcommands are registered
    const commandCalls = mockYargs.command.mock.calls;
    const commandNames = commandCalls.map((call) => call[0].command);

    expect(commandNames).toContain('add <name> <commandOrUrl> [args...]');
    expect(commandNames).toContain('remove <name>');
    expect(commandNames).toContain('list');
    expect(commandNames).toContain('reconnect [server-name]');
    expect(commandNames).toContain('approve [name]');
    expect(commandNames).toContain('reject [name]');

    expect(mockYargs.demandCommand).toHaveBeenCalledWith(
      1,
      'You need at least one command before continuing.',
    );
  });
});
