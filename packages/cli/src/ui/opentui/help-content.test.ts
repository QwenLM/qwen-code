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
  HELP_KEY_COL_WIDTH,
  HELP_LAYOUT_FIXED_ROWS,
  HELP_LAYOUT_RESERVED_ROWS,
  buildHelpCommandsLines,
  computeHelpBodyRows,
  computeHelpWidthLayout,
  formatHelpText,
  getHelpShortcuts,
  groupHelpCommands,
  truncateHelpText,
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

describe('truncateHelpText', () => {
  it('shortens long text with an ellipsis', () => {
    expect(truncateHelpText('Clear the screen', 6)).toBe('Clear…');
  });

  it('leaves short text and degenerate widths untouched', () => {
    expect(truncateHelpText('Short', 20)).toBe('Short');
    expect(truncateHelpText('Anything', 1)).toBe('Anything');
    expect(truncateHelpText('Anything', 0)).toBe('Anything');
  });
});

describe('computeHelpWidthLayout (narrow-width /help parity)', () => {
  it('derives fixed shortcut columns and a truncation budget', () => {
    // At 80 cols the overlay previously overlapped its two shortcut columns
    // ("Cleartthe screen"); the layout now sizes fixed columns like the ink
    // dialog (colWidth = floor((safeWidth - 6 - 2) / 2)).
    const layout = computeHelpWidthLayout(80);
    expect(layout.safeWidth).toBe(80);
    expect(layout.bodyWidth).toBe(74);
    expect(layout.colWidth).toBe(36);
    expect(layout.descWidth).toBe(36 - HELP_KEY_COL_WIDTH - 1);
    expect(layout.singleColumn).toBe(false);
  });

  it('grows the columns with the terminal width', () => {
    const narrow = computeHelpWidthLayout(80);
    const wide = computeHelpWidthLayout(140);
    expect(wide.colWidth).toBeGreaterThan(narrow.colWidth);
    expect(wide.descWidth).toBeGreaterThan(narrow.descWidth);
    expect(wide.singleColumn).toBe(false);
  });

  it('clamps to the ink minimum width of 72', () => {
    const layout = computeHelpWidthLayout(40);
    expect(layout.safeWidth).toBe(72);
    expect(layout.colWidth).toBe(Math.floor((72 - 6 - 2) / 2));
    expect(layout.singleColumn).toBe(false);
  });

  it('falls back to a single column only at unusable widths', () => {
    // descWidth < 4 ⇒ single column. With the 72 clamp that needs a body
    // narrower than the clamp allows, so normal terminals stay two-column.
    expect(computeHelpWidthLayout(80).singleColumn).toBe(false);
    expect(computeHelpWidthLayout(1).singleColumn).toBe(false);
  });
});
