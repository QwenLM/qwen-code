/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI `/help` content builder reproduces the original ink
 * Help dialog: shortcut list, grouping/sorting, signature + description +
 * subcommand lines, truncation widths, and the docs footer.
 */

import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import {
  HELP_COMMAND_LIST_VISIBLE_LINES,
  HELP_DOCS_URL,
  HELP_LAYOUT_FIXED_ROWS,
  HELP_LAYOUT_RESERVED_ROWS,
  buildHelpCommandsLines,
  computeHelpBodyRows,
  formatHelpText,
  getHelpShortcuts,
  groupHelpCommands,
} from './help-content.js';

function cmd(
  overrides: Partial<SlashCommand> & { name: string },
): SlashCommand {
  return {
    description: `${overrides.name} description`,
    kind: CommandKind.BUILT_IN,
    source: 'builtin-command',
    ...overrides,
  };
}

const commands: SlashCommand[] = [
  cmd({ name: 'zeta' }),
  cmd({ name: 'alpha', argumentHint: '<arg>' }),
  cmd({
    name: 'memory',
    subCommands: [
      cmd({ name: 'add', description: 'add sub' }),
      cmd({ name: 'hidden-sub', description: 'x', hidden: true }),
    ],
  }),
  cmd({ name: 'secret', hidden: true }),
  cmd({ name: 'nodesc', description: '' }),
  cmd({
    name: 'mycommand',
    source: 'skill-dir-command',
    sourceDetail: 'user',
  }),
];

describe('help shortcuts (General tab)', () => {
  it('matches the original shortcut list', () => {
    const keys = getHelpShortcuts().map((s) => s.key);
    expect(keys).toContain('@');
    expect(keys).toContain('!');
    expect(keys).toContain('/');
    expect(keys).toContain('Tab');
    expect(keys).toContain('Esc Esc');
    expect(keys).toContain('Ctrl+L');
    expect(keys).toContain('Ctrl+Q');
    expect(keys).toContain('Alt+←/→');
    expect(keys).toContain('↑/↓');
    expect(keys).toContain(
      process.platform === 'win32' ? 'Ctrl+Enter' : 'Ctrl+J',
    );
  });
});

describe('help command grouping (original Help dialog rules)', () => {
  it('filters hidden and description-less commands; sorts groups by order and names', () => {
    // commands tab (customOnly=false): built-in groups only, like the dialog
    const groups = groupHelpCommands(commands, false);
    expect(groups.map((g) => g.key)).toEqual(['built-in']);
    const builtin = groups.find((g) => g.key === 'built-in');
    expect(builtin?.commands.map((c) => c.name)).toEqual([
      'alpha',
      'memory',
      'zeta',
    ]);
  });

  it('customOnly keeps only non-built-in groups', () => {
    const groups = groupHelpCommands(commands, true);
    expect(groups.map((g) => g.key)).toEqual(['custom']);
  });
});

describe('help command lines (signature/meta/description/subcommands)', () => {
  it('emits group, signature, description and subcommand lines', () => {
    const lines = buildHelpCommandsLines(commands);
    const group = lines.find((l) => l.type === 'group');
    expect(group).toEqual({
      type: 'group',
      text: 'Built-in Commands',
      count: 3,
    });

    const alpha = lines.find(
      (l) => l.type === 'signature' && l.text.includes('/alpha'),
    );
    expect(alpha).toBeDefined();
    if (alpha?.type === 'signature') {
      expect(alpha.text).toBe('/alpha <arg>');
      expect(alpha.meta).toContain('[interactive]');
    }

    const memorySubs = lines.find((l) => l.type === 'subcommands');
    expect(memorySubs).toBeDefined();
    if (memorySubs?.type === 'subcommands') {
      expect(memorySubs.text).toContain('add');
      expect(memorySubs.text).not.toContain('hidden-sub');
    }
  });

  it('truncates long signatures like the dialog (42% of body width)', () => {
    const long = cmd({
      name: 'x'.repeat(200),
      argumentHint: '<very-long-hint>',
    });
    const lines = buildHelpCommandsLines([long], 100);
    const signature = lines.find((l) => l.type === 'signature');
    expect(signature).toBeDefined();
    if (signature?.type === 'signature') {
      // body width = max(72, 100) - 6 = 94; 42% → 39 chars + ellipsis
      expect(signature.text.length).toBeLessThanOrEqual(39);
      expect(signature.text.endsWith('…')).toBe(true);
    }
  });

  it('caps the command listing window at 18 visible lines', () => {
    expect(HELP_COMMAND_LIST_VISIBLE_LINES).toBe(18);
  });
});

describe('overlay row budget (80x24 bounded rows, footer kept visible)', () => {
  it('leaves body rows so header+footer+hints fit at 24 rows', () => {
    // banner (3) + mount margin (1) + status (1) + composer chrome (5) +
    // overlay borders/padding/header/footer/hints/margins (10) = 20, so a
    // 24-row terminal keeps 4 rows for the tab body.
    expect(computeHelpBodyRows(24)).toBe(4);
  });

  it('never goes negative on tiny terminals', () => {
    expect(computeHelpBodyRows(0)).toBe(0);
    expect(computeHelpBodyRows(12)).toBe(0);
    expect(computeHelpBodyRows(19)).toBe(0);
  });

  it('body + fixed overlay rows + reserved chrome never exceeds the screen', () => {
    for (const height of [24, 25, 30, 40, 60]) {
      const total =
        computeHelpBodyRows(height) +
        HELP_LAYOUT_FIXED_ROWS +
        HELP_LAYOUT_RESERVED_ROWS;
      expect(total).toBeLessThanOrEqual(height);
    }
  });
});

describe('formatHelpText (full /help output)', () => {
  it('renders tabs, shortcuts, commands and the docs footer', () => {
    const text = formatHelpText(commands);
    expect(text).toContain('Qwen Code');
    expect(text).toContain('Built-in Commands (3)');
    expect(text).toContain('/alpha <arg>');
    expect(text).toContain('/zeta');
    expect(text).not.toContain('/secret');
    expect(text).toContain('Browse custom, skill, plugin, and MCP commands:');
    expect(text).toContain('/mycommand [User]');
    expect(text).toContain(`For more help: ${HELP_DOCS_URL}`);
    expect(text).toContain('Tab/Shift+Tab to switch tabs  ·  Esc to cancel');
  });
});
