/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

export interface AcpSupportedCommand {
  name: string;
  description: string;
  argumentHint?: string | readonly string[] | null;
}

const ACP_SUPPORTED_BUILT_IN_COMMANDS = new Set(['rewind', 'rename', 'goal']);
const ACP_EXCLUDED_DYNAMIC_COMMANDS = new Set(['loop']);

export function isCommandAvailableInAcp(command: SlashCommand): boolean {
  if (command.hidden === true) {
    return false;
  }

  if (ACP_EXCLUDED_DYNAMIC_COMMANDS.has(command.name)) {
    return false;
  }

  if (command.kind === CommandKind.BUILT_IN) {
    return ACP_SUPPORTED_BUILT_IN_COMMANDS.has(command.name);
  }

  return (
    command.kind === CommandKind.SKILL ||
    command.kind === CommandKind.PLUGIN ||
    command.kind === CommandKind.MCP_PROMPT ||
    command.kind === CommandKind.WORKFLOW ||
    command.kind === CommandKind.DYNAMIC
  );
}

export function toAcpSupportedCommand(
  command: SlashCommand,
): AcpSupportedCommand {
  if (command.name === 'rewind') {
    return {
      name: command.name,
      description:
        'Rewind conversation and checkpointed files to before a user message by id',
      argumentHint: '<message-id>',
    };
  }

  if (command.name === 'rename') {
    return {
      name: command.name,
      description: command.description ?? '',
      argumentHint: '<title>',
    };
  }

  return {
    name: command.name,
    description: command.description ?? '',
    argumentHint: command.argumentHint ?? command.argNames ?? null,
  };
}
