/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseSlashCommand, parseStackedSlashCommands } from './commands.js';
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

  it('should preserve whitespace inside command arguments', () => {
    const result = parseSlashCommand('/commit foo  bar', mockCommands);
    expect(result.commandToExecute?.name).toBe('commit');
    expect(result.args).toBe('foo  bar');
    expect(result.canonicalPath).toEqual(['commit']);
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

// Mock commands that include skill-type entries for stacked-skill tests
const mockCommandsWithSkills: readonly SlashCommand[] = [
  ...mockCommands,
  {
    name: 'feat-dev',
    description: 'Feature development workflow',
    action: async () => {},
    kind: CommandKind.SKILL,
  },
  {
    name: 'e2e-testing',
    description: 'End-to-end testing',
    action: async () => {},
    kind: CommandKind.SKILL,
  },
  {
    name: 'bugfix',
    description: 'Bug fix workflow',
    action: async () => {},
    kind: CommandKind.SKILL,
  },
  {
    name: 'review',
    description: 'Code review',
    action: async () => {},
    kind: CommandKind.SKILL,
  },
  {
    name: 'simplify',
    description: 'Simplify code',
    action: async () => {},
    kind: CommandKind.SKILL,
  },
  {
    name: 'structured-debugging',
    description: 'Structured debugging',
    altNames: ['debug'],
    action: async () => {},
    kind: CommandKind.SKILL,
  },
];

describe('parseStackedSlashCommands', () => {
  it('should return empty for a single skill (not stacked)', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev implement X',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(0);
    expect(result.remainingText).toBe('/feat-dev implement X');
    expect(result.exceededMax).toBe(false);
  });

  it('should detect two stacked skills', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing implement X',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]?.name).toBe('feat-dev');
    expect(result.skills[1]?.name).toBe('e2e-testing');
    expect(result.remainingText).toBe('implement X');
    expect(result.exceededMax).toBe(false);
  });

  it('should detect three stacked skills with remaining text', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing /bugfix fix the login page',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(3);
    expect(result.skills[0]?.name).toBe('feat-dev');
    expect(result.skills[1]?.name).toBe('e2e-testing');
    expect(result.skills[2]?.name).toBe('bugfix');
    expect(result.remainingText).toBe('fix the login page');
  });

  it('should detect five skills at the maximum', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing /bugfix /review /simplify do it',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(5);
    expect(result.remainingText).toBe('do it');
    expect(result.exceededMax).toBe(false);
  });

  it('should cap at five skills and set exceededMax when six are given', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing /bugfix /review /simplify /structured-debugging do it',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(5);
    expect(result.exceededMax).toBe(true);
    expect(result.remainingText).toContain('/structured-debugging');
  });

  it('should stop at a non-skill token', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /help do something',
      mockCommandsWithSkills,
    );
    // Only feat-dev is a skill before /help (which is BUILT_IN), so only 1 skill → not stacked
    expect(result.skills).toHaveLength(0);
  });

  it('should stop at an unknown /token', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /nonexistent do something',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(0);
  });

  it('should return empty when input does not start with /', () => {
    const result = parseStackedSlashCommands(
      'feat-dev /e2e-testing',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(0);
    expect(result.remainingText).toBe('feat-dev /e2e-testing');
  });

  it('should return empty for an empty query', () => {
    const result = parseStackedSlashCommands('', mockCommandsWithSkills);
    expect(result.skills).toHaveLength(0);
    expect(result.remainingText).toBe('');
  });

  it('should handle skills with no remaining text', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.remainingText).toBe('');
  });

  it('should support alt names (aliases)', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /debug trace the issue',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]?.name).toBe('feat-dev');
    expect(result.skills[1]?.name).toBe('structured-debugging');
    expect(result.remainingText).toBe('trace the issue');
  });

  it('should handle extra whitespace between tokens', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev   /e2e-testing   implement X',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]?.name).toBe('feat-dev');
    expect(result.skills[1]?.name).toBe('e2e-testing');
    expect(result.remainingText).toBe('implement X');
  });

  it('should return empty when the command list has no skills', () => {
    const result = parseStackedSlashCommands(
      '/help /commit',
      mockCommands, // only BUILT_IN and FILE commands, no SKILL
    );
    expect(result.skills).toHaveLength(0);
    expect(result.remainingText).toBe('/help /commit');
  });

  it('should treat first non-skill word as remaining text (not stacked)', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev implement /e2e-testing',
      mockCommandsWithSkills,
    );
    // Only one skill (feat-dev), "implement" is not a skill → not stacked
    expect(result.skills).toHaveLength(0);
  });

  it('should handle trailing whitespace after skills', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing   ',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.remainingText).toBe('');
  });

  it('should handle leading whitespace in query', () => {
    const result = parseStackedSlashCommands(
      '  /feat-dev /e2e-testing do it  ',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]?.name).toBe('feat-dev');
    expect(result.skills[1]?.name).toBe('e2e-testing');
    expect(result.remainingText).toBe('do it');
  });

  it('should return empty for a lone slash', () => {
    const result = parseStackedSlashCommands('/', mockCommandsWithSkills);
    expect(result.skills).toHaveLength(0);
  });

  it('should return empty for double slash (//)', () => {
    const result = parseStackedSlashCommands('//', mockCommandsWithSkills);
    expect(result.skills).toHaveLength(0);
  });

  it('should break on empty token after slash in stacked position', () => {
    // e.g. "/feat-dev / something" — the "/" token has no name
    const result = parseStackedSlashCommands(
      '/feat-dev / something',
      mockCommandsWithSkills,
    );
    // Only one skill before the bare "/" → not stacked
    expect(result.skills).toHaveLength(0);
  });

  it('should handle exactly MAX_STACKED_SKILLS without exceededMax', () => {
    // 5 skills = exactly the limit
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing /bugfix /review /simplify',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(5);
    expect(result.exceededMax).toBe(false);
    expect(result.remainingText).toBe('');
  });

  it('should keep the 6th token in remainingText when exceeded', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev /e2e-testing /bugfix /review /simplify /structured-debugging extra text',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(5);
    expect(result.exceededMax).toBe(true);
    expect(result.remainingText).toBe('/structured-debugging extra text');
  });

  it('should handle tabs between skill tokens', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev\t/e2e-testing\timplement X',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]?.name).toBe('feat-dev');
    expect(result.skills[1]?.name).toBe('e2e-testing');
    expect(result.remainingText).toBe('implement X');
  });

  it('should handle mixed whitespace (spaces and tabs) between tokens', () => {
    const result = parseStackedSlashCommands(
      '/feat-dev \t /e2e-testing \t implement X',
      mockCommandsWithSkills,
    );
    expect(result.skills).toHaveLength(2);
    expect(result.remainingText).toBe('implement X');
  });
});
