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
  HELP_COMMANDS_TAB_CHROME_ROWS,
  HELP_DOCS_URL,
  HELP_KEY_COL_WIDTH,
  HELP_LAYOUT_FIXED_ROWS,
  buildHelpCommandsLines,
  computeHelpBodyRows,
  computeHelpWidthLayout,
  formatHelpText,
  getHelpShortcuts,
  groupHelpCommands,
  helpCommandWindowRows,
  helpScrollMax,
  truncateHelpText,
  type HelpLine,
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

describe('overlay row budget (the popup region owns the surrounding chrome)', () => {
  it('gives the tab body what the region leaves after the overlay chrome', () => {
    // A 24-row terminal hands the popup region 19 rows, and the overlay's own
    // borders, padding, header, footer, hints and separator margins take 10 of
    // them. The banner, the status bar and the composer occupy none of those
    // 19 rows while a dialog is open.
    expect(computeHelpBodyRows(19)).toBe(9);
  });

  it("windows the command list at ink's fixed 18 rows on a 40-row terminal", () => {
    // The region is 35 rows there, so the body is 25 and the commands tab's
    // own chrome 4: 21 rows of list, held to ink's hard-coded 18.
    expect(helpCommandWindowRows(computeHelpBodyRows(35))).toBe(
      HELP_COMMAND_LIST_VISIBLE_LINES,
    );
  });

  it('never goes negative on tiny regions', () => {
    expect(computeHelpBodyRows(0)).toBe(0);
    expect(computeHelpBodyRows(10)).toBe(0);
  });

  it('body + fixed overlay rows never exceeds the region', () => {
    for (const regionHeight of [19, 20, 25, 35, 55]) {
      expect(
        computeHelpBodyRows(regionHeight) + HELP_LAYOUT_FIXED_ROWS,
      ).toBeLessThanOrEqual(regionHeight);
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
  });

  it('grows the columns with the terminal width', () => {
    const narrow = computeHelpWidthLayout(80);
    const wide = computeHelpWidthLayout(140);
    expect(wide.colWidth).toBeGreaterThan(narrow.colWidth);
    expect(wide.descWidth).toBeGreaterThan(narrow.descWidth);
  });

  it('clamps to the ink minimum width of 72', () => {
    const layout = computeHelpWidthLayout(40);
    expect(layout.safeWidth).toBe(72);
    expect(layout.colWidth).toBe(Math.floor((72 - 6 - 2) / 2));
  });
});

describe('helpScrollMax', () => {
  const lines = (count: number): HelpLine[] =>
    Array.from({ length: count }, () => ({ type: 'blank' }));
  const full = HELP_COMMAND_LIST_VISIBLE_LINES;

  it('offers no scrolling while the list fits the window', () => {
    expect(helpScrollMax(lines(full), full)).toBe(0);
    expect(helpScrollMax(lines(0), full)).toBe(0);
  });

  it('stops at the last offset that still moves the window', () => {
    expect(helpScrollMax(lines(full + 5), full)).toBe(5);
  });

  it('tracks a window the body budget narrowed', () => {
    expect(helpScrollMax(lines(20), 16)).toBe(4);
  });
});

describe('helpCommandWindowRows', () => {
  it('keeps the full window while the budget covers the chrome', () => {
    const roomy =
      HELP_COMMAND_LIST_VISIBLE_LINES + HELP_COMMANDS_TAB_CHROME_ROWS;
    expect(helpCommandWindowRows(roomy)).toBe(HELP_COMMAND_LIST_VISIBLE_LINES);
    expect(helpCommandWindowRows(40)).toBe(HELP_COMMAND_LIST_VISIBLE_LINES);
  });

  it('gives the chrome its rows before the list claims any', () => {
    expect(helpCommandWindowRows(20)).toBe(16);
  });

  it('never collapses to zero rows on a tiny budget', () => {
    expect(helpCommandWindowRows(HELP_COMMANDS_TAB_CHROME_ROWS)).toBe(1);
    expect(helpCommandWindowRows(0)).toBe(1);
  });
});
