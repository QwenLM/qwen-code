/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand } from '../ui/commands/types.js';

export type CommandMatchKind = 'name' | 'displayName' | 'altName';

export interface CommandMatchResult {
  cmd: SlashCommand;
  matchedAs: CommandMatchKind;
}

/**
 * Locate the command in a flat list whose canonical name, displayName, or
 * altName is exactly equal to the provided segment. Matching is case-sensitive
 * (`===`) — fuzzy or case-insensitive lookup belongs to the popup search path,
 * not routing.
 *
 * Tier order (each tier returns the first match found):
 *   1. cmd.name === part
 *   2. cmd.displayName === part
 *   3. cmd.altNames includes part
 */
export function findCommandByPart(
  commands: readonly SlashCommand[],
  part: string,
): CommandMatchResult | undefined {
  const byName = commands.find((c) => c.name === part);
  if (byName) {
    return { cmd: byName, matchedAs: 'name' };
  }

  const byDisplay = commands.find((c) => c.displayName === part);
  if (byDisplay) {
    return { cmd: byDisplay, matchedAs: 'displayName' };
  }

  const byAlt = commands.find((c) => c.altNames?.includes(part));
  if (byAlt) {
    return { cmd: byAlt, matchedAs: 'altName' };
  }

  return undefined;
}
