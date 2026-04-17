/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSlashCommand } from './commands.js';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

// Mock command structure for testing
const mockCommands: readonly SlashCommand[] = [
  {
    name: 'help',
    description: 'Show help',
    action: async () => {},
    kind: CommandKind.BUILT_IN,
  },
  {
    name: 'commit',
    description: 'Commit changes',
    action: async () => {},
    kind: CommandKind.FILE,
  },
  {
    name: 'config',
    description: 'Manage configuration',
    altNames: ['cfg'],
    subCommands: [
      {
        name: 'set',
        description: 'Set configuration',
        action: async () => {},
        kind: CommandKind.BUILT_IN,
      },
      {
        name: 'reset',
        description: 'Reset configuration',
        altNames: ['r'],
        action: async () => {},
        kind: CommandKind.BUILT_IN,
      },
    ],
    kind: CommandKind.BUILT_IN,
  },
];

describe('parseSlashCommand', () => {
  it('should parse a simple command without arguments', () => {
    const result = parseSlashCommand('/help', mockCommands);
    expect(result.commandToExecute?.name).toBe('help');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['help']);
  });

  it('should parse a simple command with arguments', () => {
    const result = parseSlashCommand(
      '/commit -m "Initial commit"',
      mockCommands,
    );
    expect(result.commandToExecute?.name).toBe('commit');
    expect(result.args).toBe('-m "Initial commit"');
    expect(result.canonicalPath).toEqual(['commit']);
  });

  it('should parse a subcommand', () => {
    const result = parseSlashCommand('/config set', mockCommands);
    expect(result.commandToExecute?.name).toBe('set');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['config', 'set']);
  });

  it('should parse a subcommand with arguments', () => {
    const result = parseSlashCommand('/config set theme dark', mockCommands);
    expect(result.commandToExecute?.name).toBe('set');
    expect(result.args).toBe('theme dark');
    expect(result.canonicalPath).toEqual(['config', 'set']);
  });

  it('should handle a command alias', () => {
    const result = parseSlashCommand('/cfg set theme dark', mockCommands);
    expect(result.commandToExecute?.name).toBe('set');
    expect(result.args).toBe('theme dark');
    expect(result.canonicalPath).toEqual(['config', 'set']);
  });

  it('should handle a subcommand alias', () => {
    const result = parseSlashCommand('/config r', mockCommands);
    expect(result.commandToExecute?.name).toBe('reset');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['config', 'reset']);
  });

  it('should return undefined for an unknown command', () => {
    const result = parseSlashCommand('/unknown', mockCommands);
    expect(result.commandToExecute).toBeUndefined();
    expect(result.args).toBe('unknown');
    expect(result.canonicalPath).toEqual([]);
  });

  it('should return the parent command if subcommand is unknown', () => {
    const result = parseSlashCommand(
      '/config unknownsub some args',
      mockCommands,
    );
    expect(result.commandToExecute?.name).toBe('config');
    expect(result.args).toBe('unknownsub some args');
    expect(result.canonicalPath).toEqual(['config']);
  });

  it('should handle extra whitespace', () => {
    const result = parseSlashCommand(
      '  /config   set  theme dark  ',
      mockCommands,
    );
    expect(result.commandToExecute?.name).toBe('set');
    expect(result.args).toBe('theme dark');
    expect(result.canonicalPath).toEqual(['config', 'set']);
  });

  it('should return undefined if query does not start with a slash', () => {
    const result = parseSlashCommand('help', mockCommands);
    expect(result.commandToExecute).toBeUndefined();
  });

  it('should handle an empty query', () => {
    const result = parseSlashCommand('', mockCommands);
    expect(result.commandToExecute).toBeUndefined();
  });

  it('should handle a query with only a slash', () => {
    const result = parseSlashCommand('/', mockCommands);
    expect(result.commandToExecute).toBeUndefined();
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual([]);
  });
});
