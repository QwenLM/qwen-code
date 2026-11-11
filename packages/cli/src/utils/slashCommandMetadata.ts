/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { buildSlashCommandMetadata } from '@qwen-code/core';

/**
 * Formats a raw slash-command invocation for transcript storage and SDK replay.
 * The command name is always the first token; every remaining token belongs to
 * the arguments field, including nested subcommands.
 */
export function buildSlashCommandMetadataFromRawInvocation(
  rawInvocation: string,
): string | null {
  const trimmed = rawInvocation.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const invocation = trimmed.slice(1);
  const separatorIndex = invocation.search(/\s/);
  const commandName =
    separatorIndex === -1 ? invocation : invocation.slice(0, separatorIndex);
  if (!commandName) {
    return null;
  }

  const args =
    separatorIndex === -1
      ? undefined
      : invocation.slice(separatorIndex).trimStart() || undefined;
  return buildSlashCommandMetadata(commandName, args);
}
