/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  getCommandSourceBadge,
  getCommandSourceGroup,
  formatSupportedModes,
  getCommandDisplayName,
  getCommandSubcommandNames,
  formatCommandSourceLabel,
} from './commandMetadata.js';
import type { SlashCommand } from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';

function makeCmd(overrides: Partial<SlashCommand> = {}): SlashCommand {
  return {
    name: 'test',
    description: 'Test command',
    kind: CommandKind.BUILT_IN,
    source: 'builtin-command',
    ...overrides,
    action: async () => {},
  } as unknown as SlashCommand;
}

// ---------------------------------------------------------------------------
// getCommandSourceBadge
// ---------------------------------------------------------------------------
describe('getCommandSourceBadge', () => {
  it('returns null for builtin-command', () => {
    expect(
      getCommandSourceBadge(makeCmd({ source: 'builtin-command' })),
    ).toBeNull();
  });

  it('returns [Skill] for bundled-skill', () => {
    expect(getCommandSourceBadge(makeCmd({ source: 'bundled-skill' }))).toBe(
      '[Skill]',
    );
  });

  it('returns [User] for skill-dir-command with User label', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'skill-dir-command', sourceLabel: 'User' }),
      ),
    ).toBe('[User]');
  });

  it('returns [Project] for skill-dir-command with Project label', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'skill-dir-command', sourceLabel: 'Project' }),
      ),
    ).toBe('[Project]');
  });

  it('returns [Custom] for skill-dir-command with other label', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'skill-dir-command', sourceLabel: 'Other' }),
      ),
    ).toBe('[Custom]');
  });

  it('returns [Extension] for plugin-command with Extension: prefix', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'plugin-command', sourceLabel: 'Extension: my-ext' }),
      ),
    ).toBe('[Extension]');
  });

  it('returns [Plugin] for plugin-command without Extension: prefix', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'plugin-command', sourceLabel: 'My Plugin' }),
      ),
    ).toBe('[Plugin]');
  });

  it('returns [MCP] for mcp-prompt', () => {
    expect(getCommandSourceBadge(makeCmd({ source: 'mcp-prompt' }))).toBe(
      '[MCP]',
    );
  });

  it('returns null for unknown source (default branch)', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'unknown-source' as SlashCommand['source'] }),
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCommandSourceGroup
// ---------------------------------------------------------------------------
describe('getCommandSourceGroup', () => {
  it('returns built-in group for builtin-command', () => {
    const g = getCommandSourceGroup(makeCmd({ source: 'builtin-command' }));
    expect(g.key).toBe('built-in');
    expect(g.order).toBe(0);
  });

  it('returns bundled-skill group', () => {
    const g = getCommandSourceGroup(makeCmd({ source: 'bundled-skill' }));
    expect(g.key).toBe('bundled-skill');
    expect(g.order).toBe(1);
  });

  it('returns custom group for skill-dir-command', () => {
    const g = getCommandSourceGroup(makeCmd({ source: 'skill-dir-command' }));
    expect(g.key).toBe('custom');
    expect(g.order).toBe(2);
  });

  it('returns plugin group for plugin-command', () => {
    const g = getCommandSourceGroup(makeCmd({ source: 'plugin-command' }));
    expect(g.key).toBe('plugin');
    expect(g.order).toBe(3);
  });

  it('returns mcp group for mcp-prompt', () => {
    const g = getCommandSourceGroup(makeCmd({ source: 'mcp-prompt' }));
    expect(g.key).toBe('mcp');
    expect(g.order).toBe(4);
  });

  it('returns other group for unknown source', () => {
    const g = getCommandSourceGroup(
      makeCmd({ source: 'unknown-source' as SlashCommand['source'] }),
    );
    expect(g.key).toBe('other');
    expect(g.order).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// formatSupportedModes
// ---------------------------------------------------------------------------
describe('formatSupportedModes', () => {
  it('returns [all] when all three modes are present', () => {
    const cmd = makeCmd({
      supportedModes: ['interactive', 'non_interactive', 'acp'],
    });
    expect(formatSupportedModes(cmd)).toBe('[all]');
  });

  it('returns [headless] when non_interactive and acp but not interactive', () => {
    const cmd = makeCmd({
      supportedModes: ['non_interactive', 'acp'],
    });
    expect(formatSupportedModes(cmd)).toBe('[headless]');
  });

  it('returns [interactive] when only interactive mode', () => {
    const cmd = makeCmd({ supportedModes: ['interactive'] });
    expect(formatSupportedModes(cmd)).toBe('[interactive]');
  });

  it('formats individual modes with short tokens', () => {
    const cmd = makeCmd({ supportedModes: ['interactive', 'acp'] });
    const result = formatSupportedModes(cmd);
    expect(result).toContain('[i]');
    expect(result).toContain('[acp]');
  });
});

// ---------------------------------------------------------------------------
// getCommandDisplayName
// ---------------------------------------------------------------------------
describe('getCommandDisplayName', () => {
  it('returns plain name with prefix', () => {
    const cmd = makeCmd({ name: 'review' });
    expect(getCommandDisplayName(cmd, { prefix: '/' })).toBe('/review');
  });

  it('appends matched alias when provided', () => {
    const cmd = makeCmd({ name: 'stats', altNames: ['usage'] });
    expect(
      getCommandDisplayName(cmd, { prefix: '/', matchedAlias: 'usage' }),
    ).toBe('/stats (alias: usage)');
  });

  it('appends altNames when includeAliases not false', () => {
    const cmd = makeCmd({ name: 'stats', altNames: ['usage', 'u'] });
    expect(getCommandDisplayName(cmd)).toBe('stats (usage, u)');
  });

  it('omits altNames when includeAliases is false', () => {
    const cmd = makeCmd({ name: 'stats', altNames: ['usage'] });
    expect(getCommandDisplayName(cmd, { includeAliases: false })).toBe('stats');
  });

  it('returns plain name when no altNames', () => {
    const cmd = makeCmd({ name: 'clear', altNames: undefined });
    expect(getCommandDisplayName(cmd)).toBe('clear');
  });
});

// ---------------------------------------------------------------------------
// getCommandSubcommandNames
// ---------------------------------------------------------------------------
describe('getCommandSubcommandNames', () => {
  it('returns empty array when no subCommands', () => {
    expect(getCommandSubcommandNames(makeCmd())).toEqual([]);
  });

  it('returns names of non-hidden subCommands', () => {
    const cmd = makeCmd({
      subCommands: [
        { name: 'add', hidden: false } as SlashCommand,
        { name: 'remove', hidden: true } as SlashCommand,
        { name: 'list', hidden: false } as SlashCommand,
      ],
    });
    expect(getCommandSubcommandNames(cmd)).toEqual(['add', 'list']);
  });
});

// ---------------------------------------------------------------------------
// formatCommandSourceLabel
// ---------------------------------------------------------------------------
describe('formatCommandSourceLabel', () => {
  it('returns sourceLabel when present', () => {
    const cmd = makeCmd({ source: 'builtin-command', sourceLabel: 'My Label' });
    expect(formatCommandSourceLabel(cmd)).toBe('My Label');
  });

  it('returns Built-in for builtin-command without sourceLabel', () => {
    const cmd = makeCmd({ source: 'builtin-command', sourceLabel: undefined });
    expect(formatCommandSourceLabel(cmd)).toBe('Built-in');
  });

  it('returns Skill for bundled-skill', () => {
    const cmd = makeCmd({ source: 'bundled-skill', sourceLabel: undefined });
    expect(formatCommandSourceLabel(cmd)).toBe('Skill');
  });

  it('returns Custom for skill-dir-command', () => {
    const cmd = makeCmd({
      source: 'skill-dir-command',
      sourceLabel: undefined,
    });
    expect(formatCommandSourceLabel(cmd)).toBe('Custom');
  });

  it('returns Plugin for plugin-command', () => {
    const cmd = makeCmd({ source: 'plugin-command', sourceLabel: undefined });
    expect(formatCommandSourceLabel(cmd)).toBe('Plugin');
  });

  it('returns MCP for mcp-prompt', () => {
    const cmd = makeCmd({ source: 'mcp-prompt', sourceLabel: undefined });
    expect(formatCommandSourceLabel(cmd)).toBe('MCP');
  });

  it('returns Unknown when source is falsy', () => {
    const cmd = makeCmd({
      source: undefined as unknown as SlashCommand['source'],
      sourceLabel: undefined,
    });
    expect(formatCommandSourceLabel(cmd)).toBe('Unknown');
  });
});
