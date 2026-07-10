/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from '../ui/commands/types.js';

/** Maximum number of stacked skill commands that can be loaded in one prompt. */
export const MAX_STACKED_SKILLS = 5;

export type ParsedSlashCommand = {
  commandToExecute: SlashCommand | undefined;
  args: string;
  canonicalPath: string[];
};

export type ParsedStackedSkillCommands = {
  /** All matched skill commands (up to MAX_STACKED_SKILLS). */
  skills: SlashCommand[];
  /** Text remaining after the last matched skill token. */
  remainingText: string;
  /** True when more than MAX_STACKED_SKILLS leading tokens were found. */
  exceededMax: boolean;
};

/**
 * Parses a raw slash command string into its command, arguments, and canonical path.
 * If no valid command is found, the `commandToExecute` property will be `undefined`.
 *
 * @param query The raw input string, e.g., "/config set theme dark" or "/help".
 * @param commands The list of available top-level slash commands.
 * @returns An object containing the resolved command, its arguments, and its canonical path.
 */
export const parseSlashCommand = (
  query: string,
  commands: readonly SlashCommand[],
): ParsedSlashCommand => {
  const trimmed = query.trim();

  const commandText = trimmed.substring(1).trim();
  const parts = commandText.split(/\s+/);
  const commandPath = parts.filter((p) => p); // The parts of the command, e.g., ['memory', 'add']

  let currentCommands = commands;
  let commandToExecute: SlashCommand | undefined;
  let pathIndex = 0;
  const canonicalPath: string[] = [];
  let argsStart = 0;

  for (const part of commandPath) {
    // TODO: For better performance and architectural clarity, this two-pass
    // search could be replaced. A more optimal approach would be to
    // pre-compute a single lookup map in `CommandService.ts` that resolves
    // all name and alias conflicts during the initial loading phase. The
    // processor would then perform a single, fast lookup on that map.

    // First pass: check for an exact match on the primary command name.
    let foundCommand = currentCommands.find((cmd) => cmd.name === part);

    // Second pass: if no primary name matches, check for an alias.
    if (!foundCommand) {
      foundCommand = currentCommands.find((cmd) =>
        cmd.altNames?.includes(part),
      );
    }

    if (foundCommand) {
      commandToExecute = foundCommand;
      canonicalPath.push(foundCommand.name);
      pathIndex++;
      const partIndex = commandText.indexOf(part, argsStart);
      argsStart = partIndex + part.length;
      if (foundCommand.subCommands) {
        currentCommands = foundCommand.subCommands;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  const args = commandToExecute
    ? commandText.slice(argsStart).trim()
    : parts.slice(pathIndex).join(' ');

  return { commandToExecute, args, canonicalPath };
};

/**
 * Detects multiple leading `/skill-name` tokens in user input.
 *
 * For input like `/feat-dev /e2e-testing implement X`, returns all matched
 * skill commands (up to MAX_STACKED_SKILLS) and the remaining text.
 *
 * Only matches commands with `kind === CommandKind.SKILL`. Stops at the first
 * non-skill token or unmatched `/token`.
 *
 * @param query The raw input string starting with `/`.
 * @param commands The list of available slash commands.
 * @returns Matched skill commands and the remaining text after them.
 */
export const parseStackedSlashCommands = (
  query: string,
  commands: readonly SlashCommand[],
): ParsedStackedSkillCommands => {
  const trimmed = query.trim();
  if (!trimmed.startsWith('/')) {
    return { skills: [], remainingText: trimmed, exceededMax: false };
  }

  const commandText = trimmed.substring(1);
  const skills: SlashCommand[] = [];
  let pos = 0;
  let restPos = 0;
  let exceededMax = false;

  while (pos < commandText.length) {
    // Skip whitespace between tokens (matches spaces, tabs, etc.).
    while (pos < commandText.length && /\s/.test(commandText[pos]!)) pos++;
    if (pos >= commandText.length) {
      restPos = pos;
      break;
    }

    const tokenStart = pos;
    while (pos < commandText.length && !/\s/.test(commandText[pos]!)) pos++;
    const token = commandText.slice(tokenStart, pos);

    if (skills.length === 0) {
      if (token.startsWith('/')) break;
      const cmd = findCommandByName(token, commands);
      if (!cmd || cmd.kind !== CommandKind.SKILL) break;
      skills.push(cmd);
      restPos = pos;
      continue;
    }

    if (!token.startsWith('/')) break;
    const name = token.substring(1);
    if (!name) break;

    const cmd = findCommandByName(name, commands);
    if (!cmd || cmd.kind !== CommandKind.SKILL) break;

    if (skills.length >= MAX_STACKED_SKILLS) {
      exceededMax = true;
      break;
    }

    skills.push(cmd);
    restPos = pos;
  }

  if (skills.length < 2) {
    return { skills: [], remainingText: trimmed, exceededMax: false };
  }

  const afterSkills = commandText.slice(restPos).trim();
  return { skills, remainingText: afterSkills, exceededMax };
};

function findCommandByName(
  name: string,
  commands: readonly SlashCommand[],
): SlashCommand | undefined {
  return (
    commands.find((cmd) => cmd.name === name) ??
    commands.find((cmd) => cmd.altNames?.includes(name))
  );
}
