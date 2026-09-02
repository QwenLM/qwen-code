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
  MAX_EXTENSION_OWNER_LABEL_WIDTH,
  extensionOwnerLabel,
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

  it('returns [Custom] for skill-dir-command with User label but no source detail', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'skill-dir-command', sourceLabel: 'User' }),
      ),
    ).toBe('[Custom]');
  });

  it('returns [User] for localized skill-dir-command with user source detail', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({
          source: 'skill-dir-command',
          sourceLabel: '用户',
          sourceDetail: 'user',
        }),
      ),
    ).toBe('[User]');
  });

  it('returns [Custom] for skill-dir-command with Project label but no source detail', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'skill-dir-command', sourceLabel: 'Project' }),
      ),
    ).toBe('[Custom]');
  });

  it('returns [Project] for localized skill-dir-command with project source detail', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({
          source: 'skill-dir-command',
          sourceLabel: '项目',
          sourceDetail: 'project',
        }),
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

  it('returns [Plugin] for plugin-command with Extension: prefix but no source detail', () => {
    // `sourceDetail` — not the wording of a display label — is what routes the
    // decision, so a command that never declared itself an extension still
    // reads as a plugin.
    expect(
      getCommandSourceBadge(
        makeCmd({ source: 'plugin-command', sourceLabel: 'Extension: my-ext' }),
      ),
    ).toBe('[Plugin]');
  });

  it('badges an extension command with its owner, localization and all', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({
          source: 'plugin-command',
          sourceLabel: '扩展：my-ext',
          sourceDetail: 'extension',
        }),
      ),
    ).toBe('[扩展：my-ext]');
  });

  it('badges an extension skill command with its owner', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({
          source: 'plugin-command',
          sourceLabel: extensionOwnerLabel({
            name: 'rust',
            displayName: 'Rust',
          }),
          sourceDetail: 'extension',
        }),
      ),
    ).toBe('[Extension: Rust]');
  });

  it('bounds the badge so a long display name cannot widen the label column', () => {
    // The popup sizes its label column to the longest row and renders the
    // badge in a `flexShrink: 0` box, so an unbounded display name squeezes
    // the description column instead of truncating.
    const badge = getCommandSourceBadge(
      makeCmd({
        source: 'plugin-command',
        sourceLabel: extensionOwnerLabel({
          displayName: 'Alibaba Cloud Database Suite for Production Workloads',
        }),
        sourceDetail: 'extension',
      }),
    );

    expect(badge).toBe('[Extension: Alibaba Cloud Database …]');
    expect(badge?.length).toBe(MAX_EXTENSION_OWNER_LABEL_WIDTH + 2);
  });

  it('falls back to [Extension] for an extension command with no owner label', () => {
    expect(
      getCommandSourceBadge(
        makeCmd({
          source: 'plugin-command',
          sourceDetail: 'extension',
          sourceLabel: undefined,
        }),
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
// extensionOwnerLabel
// ---------------------------------------------------------------------------
describe('extensionOwnerLabel', () => {
  it('derives the owner from the display name and falls back to the id', () => {
    expect(extensionOwnerLabel({ name: 'rust', displayName: 'Rust' })).toBe(
      'Extension: Rust',
    );
    expect(extensionOwnerLabel({ name: 'rust' })).toBe('Extension: rust');
  });

  it('names an unknown owner rather than an empty label', () => {
    // A row whose extension fields were never populated still has to say it
    // came from an extension; a bare `Extension:` reads as a formatting bug.
    expect(extensionOwnerLabel({})).toBe('Extension: unknown');
  });

  it('treats an empty display name as no display name', () => {
    // `"displayName": ""` in a manifest is legal and reaches here as an empty
    // string, so an `??` fallback would print `Extension: ` with no owner.
    expect(extensionOwnerLabel({ name: 'rust', displayName: '' })).toBe(
      'Extension: rust',
    );
    expect(extensionOwnerLabel({ displayName: '' })).toBe('Extension: unknown');
  });
});
