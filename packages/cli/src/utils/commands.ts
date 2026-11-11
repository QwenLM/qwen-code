/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { type SlashCommand } from '../ui/commands/types.js';
import { findCommandByPart } from './commandMatching.js';
import { CommandService } from '../services/CommandService.js';

export const MCP_PROMPT_MARKER = '(MCP)';

export type ParsedSlashCommand = {
  commandToExecute: SlashCommand | undefined;
  args: string;
  canonicalPath: string[];
  /** Whether any resolved path segment used displayName or altNames. */
  isAlias: boolean;
};

/**
 * Parses a raw slash command string into its command, arguments, and canonical path.
 * If no valid command is found, the `commandToExecute` property will be `undefined`.
 *
 * @param query The raw input string, e.g., "/memory add some data" or "/help".
 * @param commands The list of available top-level slash commands.
 * @returns An object containing the resolved command, its arguments, and its canonical path.
 */
export const parseSlashCommand = (
  query: string,
  commands: readonly SlashCommand[],
): ParsedSlashCommand => {
  const trimmed = query.trim();
  if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
    return { commandToExecute: undefined, args: '', canonicalPath: [], isAlias: false };
  }

  const parts = trimmed.substring(1).trim().split(/\s+/);
  // MCP prompt display names contain a space + "(MCP)" suffix (e.g.
  // "server:prompt (MCP)"). Re-merge the marker into the command token so the
  // display name can be matched as a single part.
  if (parts.length >= 2 && parts[1] === MCP_PROMPT_MARKER) {
    parts.splice(0, 2, `${parts[0]} ${MCP_PROMPT_MARKER}`);
  }
  const commandPath = parts.filter((p) => p); // The parts of the command, e.g., ['memory', 'add']

  let currentCommands = CommandService.readCurrentCommands(commands);
  let commandToExecute: SlashCommand | undefined;
  let pathIndex = 0;
  const canonicalPath: string[] = [];
  const aliasMatches: boolean[] = [];
  let parentCommand: SlashCommand | undefined;

  for (const part of commandPath) {
    const match = findCommandByPart(currentCommands, part);

    if (match) {
      parentCommand = commandToExecute;
      commandToExecute = match.cmd;
      canonicalPath.push(match.cmd.name);
      aliasMatches.push(match.matchedAs !== 'name');
      pathIndex++;
      if (match.cmd.subCommands) {
        currentCommands = match.cmd.subCommands;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const args = parts.slice(pathIndex).join(' ');

  // Backtrack if the matched (sub)command doesn't take arguments but some were provided,
  // AND the parent command is capable of handling them.
  if (
    commandToExecute &&
    commandToExecute.takesArgs === false &&
    args.length > 0 &&
    parentCommand &&
    parentCommand.action
  ) {
    return {
      commandToExecute: parentCommand,
      args: parts.slice(pathIndex - 1).join(' '),
      canonicalPath: canonicalPath.slice(0, -1),
      isAlias: aliasMatches.slice(0, -1).some(Boolean),
    };
  }

  return {
    commandToExecute,
    args,
    canonicalPath,
    isAlias: aliasMatches.some(Boolean),
  };
};
