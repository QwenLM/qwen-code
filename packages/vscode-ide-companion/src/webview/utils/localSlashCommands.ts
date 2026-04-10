/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';

const LOCAL_FRESH_SESSION_COMMANDS = ['clear', 'reset', 'new'] as const;
const CLEAR_COMMAND_NAME = 'clear';
const CLEAR_COMMAND_DESCRIPTION =
  'Start a fresh session and clear the current chat. Aliases: /reset, /new.';

const LOCAL_AVAILABLE_COMMANDS: AvailableCommand[] = [
  {
    name: CLEAR_COMMAND_NAME,
    description: CLEAR_COMMAND_DESCRIPTION,
  } as AvailableCommand,
];

export function isLocalFreshSessionCommand(input: string): boolean {
  const token = input.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!token.startsWith('/')) {
    return false;
  }

  const normalized = token.slice(1);
  return LOCAL_FRESH_SESSION_COMMANDS.some((command) => command === normalized);
}

function withClearAliases(command: AvailableCommand): AvailableCommand {
  if (command.name.toLowerCase() !== CLEAR_COMMAND_NAME) {
    return command;
  }

  if (command.description?.includes('/reset')) {
    return command;
  }

  return {
    ...command,
    description: command.description
      ? `${command.description} Aliases: /reset, /new.`
      : CLEAR_COMMAND_DESCRIPTION,
  };
}

export function mergeLocalAvailableCommands(
  commands: AvailableCommand[],
): AvailableCommand[] {
  const normalizedCommands = commands.map(withClearAliases);
  const existingCommands = new Set(
    normalizedCommands.map((command) => command.name.toLowerCase()),
  );

  return [
    ...LOCAL_AVAILABLE_COMMANDS.filter(
      (command) => !existingCommands.has(command.name.toLowerCase()),
    ),
    ...normalizedCommands,
  ];
}
