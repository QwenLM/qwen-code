/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from '../ui/commands/types.js';
import { t } from '../i18n/index.js';
import { truncateToWidth } from '../ui/utils/textUtils.js';
import { getEffectiveSupportedModes } from './commandUtils.js';

export type CommandSourceGroup = {
  key: 'built-in' | 'bundled-skill' | 'custom' | 'plugin' | 'mcp' | 'other';
  title: string;
  order: number;
};

/**
 * The two fields that identify which extension owns something: the canonical
 * name (the id) and the localized display name.
 *
 * A `SkillConfig` spells these `extensionName` / `extensionDisplayName` and an
 * `Extension` spells them `name` / `displayName`, so callers adapt rather than
 * rename — this stays the only place that knows which of the two wins.
 */
export type ExtensionOwner = {
  name?: string;
  displayName?: string;
};

/**
 * Names the extension that owns a command or skill, for display: `Extension:
 * Rust`.
 *
 * Every surface that attributes something to an extension prints this and
 * nothing else, so "the same owner on every surface" is structural rather than
 * a property each surface has to reproduce correctly. The display name wins
 * because it is what the extension author chose to be seen as; the id is the
 * fallback for an extension that declared none.
 *
 * Never recovered by parsing a name: `:` is legal inside a skill name, so a
 * prefix split can attribute a skill to the wrong owner. Use the stored
 * fields.
 *
 * Lives in `services/` because both a service (this file, for command badges)
 * and a ui util (skill level labels) need it, and ui importing services is
 * this codebase's direction.
 */
export function extensionOwnerLabel(owner: ExtensionOwner): string {
  // `||`, not `??`: an extension whose manifest declares `"displayName": ""`
  // reaches here with an empty string (`resolveLocalizableString` passes a
  // plain string through untouched and nothing validates the field), which
  // would print a label with no owner in it.
  return `${t('Extension:')} ${owner.displayName || owner.name || 'unknown'}`;
}

/**
 * Caps the owner text a surface prints, so an unbounded display name cannot
 * widen the layout it sits in.
 *
 * The completion popup sizes its label column to the longest
 * `label + argumentHint + sourceBadge` row and caps that column at half the
 * content width (`SuggestionsDisplay.tsx`), while the badge renders in a
 * `flexShrink: 0` box — so a long display name squeezes the description column
 * instead of truncating. The help overlay's meta column has the same shape.
 * 35 leaves the display name the 24 columns every fixed text column here
 * already uses (`NAME_COLUMN` in the skills dialog) on top of the
 * `Extension: ` prefix, and keeps the bracketed badge inside the popup's
 * half-width cap at 80 columns. Measured in terminal columns, not UTF-16
 * units: the layouts consuming the badge count cells, and wide characters
 * (CJK display names) take two.
 */
export const MAX_EXTENSION_OWNER_LABEL_WIDTH = 35;

export function getCommandSourceBadge(
  command: Pick<SlashCommand, 'source' | 'sourceLabel' | 'sourceDetail'>,
): string | null {
  switch (command.source) {
    case 'bundled-skill':
      return '[Skill]';
    case 'skill-dir-command':
      if (command.sourceDetail === 'user') {
        return '[User]';
      }
      if (command.sourceDetail === 'project') {
        return '[Project]';
      }
      return '[Custom]';
    case 'plugin-command':
      if (command.sourceDetail !== 'extension') {
        return '[Plugin]';
      }
      // The loader already named the owner; a generic `[Extension]` would
      // throw away the one piece of provenance the reader needs when several
      // extensions are installed. `sourceLabel` is display text and may be
      // localized — that is correct here, this is a display surface.
      return command.sourceLabel
        ? `[${truncateToWidth(command.sourceLabel, MAX_EXTENSION_OWNER_LABEL_WIDTH)}]`
        : '[Extension]';
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
