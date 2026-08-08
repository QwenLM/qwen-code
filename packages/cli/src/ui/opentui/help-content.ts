/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Help content for the OpenTUI renderer (PR1 slice 1), mirroring the original
 * ink `Help` dialog (packages/cli/src/ui/components/Help.tsx): same tabs,
 * same shortcut list, same command grouping/signature/truncation rules — so
 * `/help` output matches the original. The ink dialog renders these with Box
 * widgets; here the identical data is produced as plain lines the OpenTUI
 * backend draws in its help overlay, plus a text formatter for tests.
 *
 * Pure + unit-testable; no renderer imports.
 */

import type { SlashCommand } from '../commands/types.js';
import { t } from '../../i18n/index.js';
import {
  formatSupportedModes,
  getCommandDisplayName,
  getCommandSourceBadge,
  getCommandSourceGroup,
  getCommandSubcommandNames,
} from '../../services/commandMetadata.js';

export const HELP_DEFAULT_WIDTH = 100;
export const HELP_KEY_COL_WIDTH = 20;
export const HELP_COMMAND_LIST_VISIBLE_LINES = 18;
export const HELP_DOCS_URL = 'https://qwenlm.github.io/qwen-code-docs/';

export type HelpTab = 'general' | 'commands' | 'custom-commands';

export const HELP_TABS: ReadonlyArray<{ tab: HelpTab; label: string }> = [
  { tab: 'general', label: 'general' },
  { tab: 'commands', label: 'commands' },
  { tab: 'custom-commands', label: 'custom-commands' },
];

export interface HelpShortcut {
  key: string;
  description: string;
}

/** General tab shortcuts — identical list to the original GeneralHelp. */
export function getHelpShortcuts(): HelpShortcut[] {
  return [
    { key: '@', description: t('Add files or folders as context') },
    { key: '!', description: t('Run shell commands') },
    { key: '/', description: t('Open command menu') },
    { key: 'Tab', description: t('Accept ghost text or completion') },
    { key: 'Esc Esc', description: t('Clear input or cancel operation') },
    { key: 'Ctrl+L', description: t('Clear the screen') },
    { key: 'Ctrl+Q', description: t('Queue message for the next turn') },
    {
      key: process.platform === 'win32' ? 'Ctrl+Enter' : 'Ctrl+J',
      description: t('Insert a newline'),
    },
    {
      key: process.platform === 'win32' ? 'Tab' : 'Shift+Tab',
      description: t('Cycle approval modes'),
    },
    { key: 'Alt+←/→', description: t('Jump through words') },
    { key: '↑/↓', description: t('Cycle prompt history') },
  ];
}

export type HelpLine =
  | { type: 'group'; text: string; count: number }
  | { type: 'signature'; text: string; meta: string }
  | { type: 'description'; text: string }
  | { type: 'subcommands'; text: string }
  | { type: 'blank' };

interface CommandGroup {
  key: string;
  title: string;
  order: number;
  commands: SlashCommand[];
}

/** Identical grouping logic to the original Help dialog. */
export function groupHelpCommands(
  commands: readonly SlashCommand[],
  customOnly: boolean,
): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();

  commands
    .filter((cmd) => cmd.description && !cmd.hidden)
    .forEach((cmd) => {
      const group = getCommandSourceGroup(cmd);
      if (customOnly ? group.key === 'built-in' : group.key !== 'built-in') {
        return;
      }
      const existing = groups.get(group.key);
      if (existing) {
        existing.commands.push(cmd);
      } else {
        groups.set(group.key, {
          key: group.key,
          title: group.title,
          order: group.order,
          commands: [cmd],
        });
      }
    });

  return Array.from(groups.values())
    .sort((a, b) => a.order - b.order)
    .map((group) => ({
      ...group,
      commands: group.commands.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function truncateText(text: string, maxLength: number): string {
  if (maxLength <= 1 || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

/** Same line model as the original CommandsHelp (signature/meta/desc/subs). */
function buildCommandLines(groups: CommandGroup[], width: number): HelpLine[] {
  const lines: HelpLine[] = [];
  groups.forEach((group, groupIndex) => {
    lines.push({
      type: 'group',
      text: group.title,
      count: group.commands.length,
    });
    group.commands.forEach((cmd) => {
      const badge = getCommandSourceBadge(cmd);
      const name = getCommandDisplayName(cmd, {
        prefix: '/',
        includeAliases: false,
      });
      const signature = [name, cmd.argumentHint].filter(Boolean).join(' ');
      const meta = [
        badge,
        formatSupportedModes(cmd),
        cmd.modelInvocable ? '[model]' : undefined,
      ]
        .filter(Boolean)
        .join(' ');
      lines.push({
        type: 'signature',
        text: truncateText(signature, Math.floor(width * 0.42)),
        meta,
      });
      if (cmd.description) {
        lines.push({
          type: 'description',
          text: truncateText(cmd.description, Math.max(20, width - 4)),
        });
      }
      const subcommands = getCommandSubcommandNames(cmd);
      if (subcommands.length > 0) {
        const descWidth = Math.max(20, width - 4);
        lines.push({
          type: 'subcommands',
          text: `${t('subcommands:')} ${truncateText(subcommands.join(', '), descWidth - 13)}`,
        });
      }
    });
    if (groupIndex < groups.length - 1) {
      lines.push({ type: 'blank' });
    }
  });
  return lines;
}

/** Commands tab lines (built-in commands), widths mirroring the dialog. */
export function buildHelpCommandsLines(
  commands: readonly SlashCommand[],
  width: number = HELP_DEFAULT_WIDTH,
): HelpLine[] {
  const safeWidth = Math.max(72, width);
  const bodyWidth = safeWidth - 6;
  return buildCommandLines(groupHelpCommands(commands, false), bodyWidth);
}

/** Custom-commands tab lines (everything except built-ins). */
export function buildHelpCustomCommandLines(
  commands: readonly SlashCommand[],
  width: number = HELP_DEFAULT_WIDTH,
): HelpLine[] {
  const safeWidth = Math.max(72, width);
  const bodyWidth = safeWidth - 6;
  return buildCommandLines(groupHelpCommands(commands, true), bodyWidth);
}

function shortcutLine(shortcut: HelpShortcut): string {
  const key = shortcut.key.padEnd(HELP_KEY_COL_WIDTH);
  return `${key}${shortcut.description}`;
}

/**
 * Full `/help` output as plain text — all three tabs plus the dialog footer,
 * matching the original Help dialog's content.
 */
export function formatHelpText(
  commands: readonly SlashCommand[],
  width: number = HELP_DEFAULT_WIDTH,
): string {
  const out: string[] = [];
  const tabLabels = HELP_TABS.map(({ tab, label }) =>
    tab === 'general' ? `[${t(label)}]` : ` ${t(label)} `,
  );
  out.push(`Qwen Code ${tabLabels.join('')}`);

  out.push('');
  out.push(
    t(
      'Qwen Code understands your codebase, makes edits with your permission, and executes commands right from your terminal.',
    ),
  );
  out.push('');
  out.push(t('Shortcuts'));
  for (const shortcut of getHelpShortcuts()) {
    out.push(`  ${shortcutLine(shortcut)}`);
  }

  out.push('');
  out.push(t('Browse built-in commands:'));
  for (const line of buildHelpCommandsLines(commands, width)) {
    out.push(renderHelpLine(line));
  }

  out.push('');
  const customLines = buildHelpCustomCommandLines(commands, width);
  if (customLines.length > 0) {
    out.push(t('Browse custom, skill, plugin, and MCP commands:'));
    for (const line of customLines) {
      out.push(renderHelpLine(line));
    }
    out.push('');
  }

  out.push(`${t('For more help:')} ${HELP_DOCS_URL}`);
  out.push(t('Tab/Shift+Tab to switch tabs  ·  Esc to cancel'));
  return out.join('\n');
}

/** Renders one command-list line as plain text (for overlay + text output). */
export function renderHelpLine(line: HelpLine): string {
  switch (line.type) {
    case 'group':
      return `${line.text} (${line.count})`;
    case 'signature':
      return ` ${line.text}${line.meta ? ` ${line.meta}` : ''}`;
    case 'description':
      return `    ${line.text}`;
    case 'subcommands':
      return `    ${line.text}`;
    case 'blank':
      return ' ';
    default:
      return '';
  }
}
