/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandSource, SlashCommand } from '../ui/commands/types.js';
import { getEffectiveSupportedModes } from './commandUtils.js';

export type CommandSourceGroup = {
  key: 'built-in' | 'bundled-skill' | 'custom' | 'plugin' | 'mcp' | 'other';
  title: string;
  order: number;
};

export function getCommandSourceBadge(
  command: Pick<SlashCommand, 'source' | 'sourceLabel'>,
): string | null {
  switch (command.source) {
    case 'bundled-skill':
      return '[Skill]';
    case 'skill-dir-command':
      if (command.sourceLabel === 'User') return '[User]';
      if (command.sourceLabel === 'Project') return '[Project]';
      return '[Custom]';
    case 'plugin-command':
      return command.sourceLabel?.startsWith('Extension:')
        ? '[Extension]'
        : '[Plugin]';
    case 'mcp-prompt':
      return '[MCP]';
    case 'builtin-command':
    default:
      return null;
  }
}

export function getCommandSourceGroup(
  command: Pick<SlashCommand, 'source'>,
): CommandSourceGroup {
  switch (command.source) {
    case 'builtin-command':
      return { key: 'built-in', title: 'Built-in Commands', order: 0 };
    case 'bundled-skill':
      return { key: 'bundled-skill', title: 'Bundled Skills', order: 1 };
    case 'skill-dir-command':
      return { key: 'custom', title: 'Custom Commands', order: 2 };
    case 'plugin-command':
      return { key: 'plugin', title: 'Plugin Commands', order: 3 };
    case 'mcp-prompt':
      return { key: 'mcp', title: 'MCP Commands', order: 4 };
    default:
      return { key: 'other', title: 'Other Commands', order: 5 };
  }
}

export function formatSupportedModes(command: SlashCommand): string {
  const modes = getEffectiveSupportedModes(command);
  const hasInteractive = modes.includes('interactive');
  const hasNonInteractive = modes.includes('non_interactive');
  const hasAcp = modes.includes('acp');

  if (hasInteractive && hasNonInteractive && hasAcp) {
    return '[all]';
  }

  if (!hasInteractive && hasNonInteractive && hasAcp) {
    return '[headless]';
  }

  if (hasInteractive && !hasNonInteractive && !hasAcp) {
    return '[interactive]';
  }

  return modes
    .map((mode) => {
      switch (mode) {
        case 'interactive':
          return '[i]';
        case 'non_interactive':
          return '[ni]';
        case 'acp':
          return '[acp]';
        default:
          return `[${mode}]`;
      }
    })
    .join(' ');
}

export function getCommandDisplayName(
  command: Pick<SlashCommand, 'name' | 'altNames'>,
  options: {
    prefix?: string;
    matchedAlias?: string;
    includeAliases?: boolean;
  } = {},
): string {
  const prefix = options.prefix ?? '';
  const baseLabel = `${prefix}${command.name}`;

  if (options.matchedAlias) {
    return `${baseLabel} (alias: ${options.matchedAlias})`;
  }

  if (options.includeAliases === false) {
    return baseLabel;
  }

  const altNames = command.altNames?.filter(Boolean);
  if (!altNames || altNames.length === 0) {
    return baseLabel;
  }

  return `${baseLabel} (${altNames.join(', ')})`;
}

export function getCommandSubcommandNames(command: SlashCommand): string[] {
  return (
    command.subCommands
      ?.filter((subCommand) => !subCommand.hidden)
      .map((subCommand) => subCommand.name) ?? []
  );
}

export function formatCommandSourceLabel(
  command: Pick<SlashCommand, 'source' | 'sourceLabel'>,
): string {
  if (command.sourceLabel) {
    return command.sourceLabel;
  }

  const fallbackLabels: Record<CommandSource, string> = {
    'builtin-command': 'Built-in',
    'bundled-skill': 'Skill',
    'skill-dir-command': 'Custom',
    'plugin-command': 'Plugin',
    'mcp-prompt': 'MCP',
  };

  return command.source ? fallbackLabels[command.source] : 'Unknown';
}
