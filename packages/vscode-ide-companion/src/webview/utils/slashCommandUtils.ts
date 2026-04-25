/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { CompletionItem } from '../../types/completionItemTypes.js';
import {
  EXPORT_PARENT_COMMAND_NAME,
  EXPORT_SUBCOMMAND_SPECS,
} from '../../utils/exportSlashCommand.js';

export function shouldAllowCompletionQuery(
  trigger: '@' | '/',
  query: string,
): boolean {
  if (query.includes('\n')) {
    return false;
  }

  if (trigger === '/') {
    return true;
  }

  return !query.includes(' ');
}

export function isExpandableSlashCommand(commandName: string): boolean {
  return commandName === EXPORT_PARENT_COMMAND_NAME;
}

function matchesQuery(
  query: string,
  label: string,
  description?: string,
): boolean {
  const normalizedQuery = query.toLowerCase();
  return (
    label.toLowerCase().includes(normalizedQuery) ||
    (description?.toLowerCase().includes(normalizedQuery) ?? false)
  );
}

function buildExportSubcommandItems(childQuery: string): CompletionItem[] {
  return EXPORT_SUBCOMMAND_SPECS.filter((subcommand) =>
    matchesQuery(
      childQuery,
      `/export ${subcommand.name}`,
      subcommand.description,
    ),
  ).map((subcommand) => ({
    id: `export:${subcommand.name}`,
    label: `/${EXPORT_PARENT_COMMAND_NAME} ${subcommand.name}`,
    description: subcommand.description,
    type: 'command' as const,
    group: 'Slash Commands',
    value: `${EXPORT_PARENT_COMMAND_NAME} ${subcommand.name}`,
  }));
}

export function buildSlashCommandItems(
  query: string,
  availableCommands: readonly AvailableCommand[],
): CompletionItem[] {
  const normalizedQuery = query.trimStart().toLowerCase();

  if (
    normalizedQuery === EXPORT_PARENT_COMMAND_NAME ||
    normalizedQuery.startsWith(`${EXPORT_PARENT_COMMAND_NAME} `)
  ) {
    const childQuery =
      normalizedQuery === EXPORT_PARENT_COMMAND_NAME
        ? ''
        : normalizedQuery
            .slice(EXPORT_PARENT_COMMAND_NAME.length + 1)
            .trimStart();
    return buildExportSubcommandItems(childQuery);
  }

  return availableCommands
    .map((cmd) => ({
      id: cmd.name,
      label: `/${cmd.name}`,
      description: cmd.description,
      type: 'command' as const,
      group: 'Slash Commands',
      value: cmd.name,
    }))
    .filter((item) => matchesQuery(query, item.label, item.description));
}
