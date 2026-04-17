/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

export type DynamicCommandDescriptionKind =
  | CommandKind.SKILL
  | CommandKind.FILE
  | CommandKind.MCP_PROMPT;

export interface TrackedDynamicDescriptionSource {
  kind: DynamicCommandDescriptionKind;
  sourceText: string;
}

export interface DynamicCommandDescriptionMetadata
  extends TrackedDynamicDescriptionSource {
  formatResolvedText?: (resolvedText: string) => string;
}

const COMMAND_DESCRIPTION_METADATA = Symbol('commandDescriptionMetadata');

export function markDynamicDescriptionSource(
  command: SlashCommand,
  kind: DynamicCommandDescriptionKind,
  sourceText: string,
  options: {
    formatResolvedText?: (resolvedText: string) => string;
  } = {},
): void {
  Object.defineProperty(command, COMMAND_DESCRIPTION_METADATA, {
    value: {
      kind,
      sourceText,
      formatResolvedText: options.formatResolvedText,
    } satisfies DynamicCommandDescriptionMetadata,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

export function getDynamicCommandDescriptionMetadata(
  command: SlashCommand,
): DynamicCommandDescriptionMetadata | null {
  const metadata = (
    command as SlashCommand & {
      [COMMAND_DESCRIPTION_METADATA]?: DynamicCommandDescriptionMetadata;
    }
  )[COMMAND_DESCRIPTION_METADATA];

  if (!metadata) {
    return null;
  }

  if (
    metadata.kind !== CommandKind.SKILL &&
    metadata.kind !== CommandKind.FILE &&
    metadata.kind !== CommandKind.MCP_PROMPT
  ) {
    return null;
  }

  if (
    typeof metadata.sourceText !== 'string' ||
    metadata.sourceText.length === 0
  ) {
    return null;
  }

  return metadata;
}
