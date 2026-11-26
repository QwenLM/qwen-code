/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
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
    kind: CommandKind.SKILL,
  },
  {
    name: 'memory',
    description: 'Manage memory',
    altNames: ['mem'],
    subCommands: [
      {
        name: 'add',
        description: 'Add to memory',
        action: async () => {},
        kind: CommandKind.BUILT_IN,
      },
      {
        name: 'clear',
        description: 'Clear memory',
        altNames: ['c'],
        action: async () => {},
        kind: CommandKind.BUILT_IN,
      },
    ],
    kind: CommandKind.BUILT_IN,
  },
];

describe('parseSlashCommand', () => {
  it('preserves the question-mark command prefix', () => {
    const result = parseSlashCommand('?help', mockCommands);
    expect(result.commandToExecute?.name).toBe('help');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['help']);
  });

  it('should parse a simple command without arguments', () => {
    const result = parseSlashCommand('/help', mockCommands);
    expect(result.commandToExecute?.name).toBe('help');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['help']);
    expect(result.isAlias).toBe(false);
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
    const result = parseSlashCommand('/memory add', mockCommands);
    expect(result.commandToExecute?.name).toBe('add');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['memory', 'add']);
    expect(result.isAlias).toBe(false);
  });

  it('should parse a subcommand with arguments', () => {
    const result = parseSlashCommand(
      '/memory add some important data',
      mockCommands,
    );
    expect(result.commandToExecute?.name).toBe('add');
    expect(result.args).toBe('some important data');
    expect(result.canonicalPath).toEqual(['memory', 'add']);
  });

  it('should handle a command alias', () => {
    const result = parseSlashCommand('/mem add some data', mockCommands);
    expect(result.commandToExecute?.name).toBe('add');
    expect(result.args).toBe('some data');
    expect(result.canonicalPath).toEqual(['memory', 'add']);
    expect(result.isAlias).toBe(true);
  });

  it('should handle a subcommand alias', () => {
    const result = parseSlashCommand('/memory c', mockCommands);
    expect(result.commandToExecute?.name).toBe('clear');
    expect(result.args).toBe('');
    expect(result.canonicalPath).toEqual(['memory', 'clear']);
    expect(result.isAlias).toBe(true);
  });

  it('should return undefined for an unknown command', () => {
    const result = parseSlashCommand('/unknown', mockCommands);
    expect(result.commandToExecute).toBeUndefined();
    expect(result.args).toBe('unknown');
    expect(result.canonicalPath).toEqual([]);
    expect(result.isAlias).toBe(false);
  });

  it('should return the parent command if subcommand is unknown', () => {
    const result = parseSlashCommand(
      '/memory unknownsub some args',
      mockCommands,
    );
    expect(result.commandToExecute?.name).toBe('memory');
    expect(result.args).toBe('unknownsub some args');
    expect(result.canonicalPath).toEqual(['memory']);
  });

  it('should handle extra whitespace', () => {
    const result = parseSlashCommand(
      '  /memory   add  some data  ',
      mockCommands,
    );
    expect(result.commandToExecute?.name).toBe('add');
    expect(result.args).toBe('some data');
    expect(result.canonicalPath).toEqual(['memory', 'add']);
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

  describe('backtracking', () => {
    const backtrackingCommands: readonly SlashCommand[] = [
      {
        name: 'parent',
        description: 'Parent command',
        kind: CommandKind.BUILT_IN,
        action: async () => {},
        subCommands: [
          {
            name: 'notakes',
            description: 'Subcommand that does not take arguments',
            kind: CommandKind.BUILT_IN,
            takesArgs: false,
            action: async () => {},
          },
          {
            name: 'takes',
            description: 'Subcommand that takes arguments',
            kind: CommandKind.BUILT_IN,
            takesArgs: true,
            action: async () => {},
          },
        ],
      },
    ];

    it('should backtrack to parent if subcommand has takesArgs: false and args are provided', () => {
      const result = parseSlashCommand(
        '/parent notakes some prompt',
        backtrackingCommands,
      );
      expect(result.commandToExecute?.name).toBe('parent');
      expect(result.args).toBe('notakes some prompt');
      expect(result.canonicalPath).toEqual(['parent']);
      expect(result.isAlias).toBe(false);
    });

    it('should NOT backtrack if subcommand has takesArgs: false but NO args are provided', () => {
      const result = parseSlashCommand('/parent notakes', backtrackingCommands);
      expect(result.commandToExecute?.name).toBe('notakes');
      expect(result.args).toBe('');
      expect(result.canonicalPath).toEqual(['parent', 'notakes']);
    });

    it('should NOT backtrack if subcommand has takesArgs: true and args are provided', () => {
      const result = parseSlashCommand(
        '/parent takes some args',
        backtrackingCommands,
      );
      expect(result.commandToExecute?.name).toBe('takes');
      expect(result.args).toBe('some args');
      expect(result.canonicalPath).toEqual(['parent', 'takes']);
    });

    it('should NOT backtrack if parent has NO action', () => {
      const noActionCommands: readonly SlashCommand[] = [
        {
          name: 'parent',
          description: 'Parent without action',
          kind: CommandKind.BUILT_IN,
          subCommands: [
            {
              name: 'notakes',
              description: 'Subcommand without args',
              kind: CommandKind.BUILT_IN,
              takesArgs: false,
              action: async () => {},
            },
          ],
        },
      ];
      const result = parseSlashCommand(
        '/parent notakes some args',
        noActionCommands,
      );
      // It stays with the subcommand because parent can't handle it
      expect(result.commandToExecute?.name).toBe('notakes');
      expect(result.args).toBe('some args');
      expect(result.canonicalPath).toEqual(['parent', 'notakes']);
    });

    it('should NOT backtrack if subcommand is NOT marked with takesArgs: false', () => {
      const result = parseSlashCommand(
        '/parent takes some args',
        backtrackingCommands,
      );
      expect(result.commandToExecute?.name).toBe('takes');
      expect(result.args).toBe('some args');
      expect(result.canonicalPath).toEqual(['parent', 'takes']);
    });

    it('should backtrack if subcommand has takesArgs: false and args are provided (like /plan copy foo)', () => {
      const result = parseSlashCommand(
        '/parent notakes some prompt',
        backtrackingCommands,
      );
      expect(result.commandToExecute?.name).toBe('parent');
      expect(result.args).toBe('notakes some prompt');
      expect(result.canonicalPath).toEqual(['parent']);
    });
  });

  describe('MCP prompt marker', () => {
    const mcpCommands: readonly SlashCommand[] = [
      ...mockCommands,
      {
        name: 'mcp__server__prompt',
        displayName: 'server:prompt (MCP)',
        description: 'An MCP prompt',
        action: async () => {},
        kind: CommandKind.MCP_PROMPT,
      },
    ];

    it('should merge the (MCP) marker into the command token without args', () => {
      const result = parseSlashCommand('/server:prompt (MCP)', mcpCommands);
      expect(result.commandToExecute?.name).toBe('mcp__server__prompt');
      expect(result.args).toBe('');
      expect(result.canonicalPath).toEqual(['mcp__server__prompt']);
    });

    it('should merge the (MCP) marker into the command token and keep remaining args', () => {
      const result = parseSlashCommand(
        '/server:prompt (MCP) arg1 arg2',
        mcpCommands,
      );
      expect(result.commandToExecute?.name).toBe('mcp__server__prompt');
      expect(result.args).toBe('arg1 arg2');
      expect(result.canonicalPath).toEqual(['mcp__server__prompt']);
    });

    it('should leave normal commands unaffected', () => {
      const result = parseSlashCommand('/commit arg', mcpCommands);
      expect(result.commandToExecute?.name).toBe('commit');
      expect(result.args).toBe('arg');
      expect(result.canonicalPath).toEqual(['commit']);
    });

    // Intentional edge case (matches upstream behavior): the merge happens
    // purely lexically, so "(MCP)" after a non-MCP command still gets merged
    // into the command token, which then matches nothing.
    it('should merge "(MCP)" even when the preceding token is not an MCP prompt', () => {
      const result = parseSlashCommand('/help (MCP) hi', mcpCommands);
      expect(result.commandToExecute).toBeUndefined();
      expect(result.args).toBe('help (MCP) hi');
      expect(result.canonicalPath).toEqual([]);
    });
  });
});
