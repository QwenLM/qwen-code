/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, ExecutionMode } from '../ui/commands/types.js';
import type { ICommandLoader } from './types.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { filterCommandsForMode } from './commandUtils.js';

const debugLogger = createDebugLogger('CLI_COMMANDS');

/**
 * Orchestrates the discovery and loading of all slash commands for the CLI.
 *
 * This service operates on a provider-based loader pattern. It is initialized
 * with an array of `ICommandLoader` instances, each responsible for fetching
 * commands from a specific source (e.g., built-in code, local files).
 *
 * The CommandService is responsible for invoking these loaders, aggregating their
 * results, and resolving any name conflicts. This architecture allows the command
 * system to be extended with new sources without modifying the service itself.
 */
export class CommandService {
  /**
   * Private constructor to enforce the use of the async factory.
   * @param commands A readonly array of the fully loaded and de-duplicated commands.
   */
  private constructor(private readonly commands: readonly SlashCommand[]) {}

  /**
   * Asynchronously creates and initializes a new CommandService instance.
   *
   * This factory method orchestrates the entire command loading process. It
   * runs all provided loaders in parallel, aggregates their results, handles
   * name conflicts for extension commands by renaming them, and then returns a
   * fully constructed `CommandService` instance.
   *
   * Conflict resolution:
   * - Extension commands that conflict with existing commands are renamed to
   *   `extensionName.commandName`
   * - Non-extension commands (built-in, user, project) override earlier commands
   *   with the same name based on loader order
   *
   * @param loaders An array of objects that conform to the `ICommandLoader`
   *   interface. Built-in commands should come first, followed by FileCommandLoader.
   * @param signal An AbortSignal to cancel the loading process.
   * @param disabledNames Optional set of command names to exclude. Matched
   *   case-insensitively against the final (post-rename) command name. Intended
   *   for settings- or flag-driven denylists that gate the CLI surface (see
   *   `slashCommands.disabled` and `--disabled-slash-commands`).
   * @returns A promise that resolves to a new, fully initialized `CommandService` instance.
   */
  static async create(
    loaders: ICommandLoader[],
    signal: AbortSignal,
    disabledNames?: ReadonlySet<string>,
  ): Promise<CommandService> {
    const results = await Promise.allSettled(
      loaders.map((loader) => loader.loadCommands(signal)),
    );

    const allCommands: SlashCommand[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allCommands.push(...result.value);
      } else {
        debugLogger.debug('A command loader failed:', result.reason);
      }
    }

    const commandMap = new Map<string, SlashCommand>();
    for (const cmd of allCommands) {
      let finalName = cmd.name;

      // Extension commands get renamed if they conflict with existing commands
      if (cmd.extensionName && commandMap.has(cmd.name)) {
        let renamedName = `${cmd.extensionName}.${cmd.name}`;
        let suffix = 1;

        // Keep trying until we find a name that doesn't conflict
        while (commandMap.has(renamedName)) {
          renamedName = `${cmd.extensionName}.${cmd.name}${suffix}`;
          suffix++;
        }

        finalName = renamedName;
      }

      commandMap.set(finalName, {
        ...cmd,
        name: finalName,
      });
    }

    if (disabledNames && disabledNames.size > 0) {
      const normalizedDisabled = new Set<string>();
      for (const entry of disabledNames) {
        const trimmed = entry.trim();
        if (trimmed) normalizedDisabled.add(trimmed.toLowerCase());
      }
      if (normalizedDisabled.size > 0) {
        for (const name of Array.from(commandMap.keys())) {
          if (normalizedDisabled.has(name.toLowerCase())) {
            commandMap.delete(name);
          }
        }
      }
    }

    const finalCommands = Object.freeze(Array.from(commandMap.values()));
    return new CommandService(finalCommands);
  }

  /**
   * Retrieves the currently loaded and de-duplicated list of slash commands.
   *
   * This method is a safe accessor for the service's state. It returns a
   * readonly array, preventing consumers from modifying the service's internal state.
   *
   * @returns A readonly, unified array of available `SlashCommand` objects.
   */
  getCommands(): readonly SlashCommand[] {
    return this.commands;
  }

  /**
   * Returns commands available in the specified execution mode.
   * Hidden commands are excluded.
   */
  getCommandsForMode(mode: ExecutionMode): readonly SlashCommand[] {
    return Object.freeze(
      filterCommandsForMode(
        this.commands.filter((cmd) => !cmd.hidden),
        mode,
      ),
    );
  }

  /**
   * Returns commands that the model is allowed to invoke (modelInvocable === true).
   * Hidden commands are excluded.
   */
  getModelInvocableCommands(): readonly SlashCommand[] {
    return this.commands.filter(
      (cmd) => !cmd.hidden && cmd.modelInvocable === true,
    );
  }
}
