/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SlashCommand, ExecutionMode } from '../ui/commands/types.js';
import { CommandKind } from '../ui/commands/types.js';
import type { ICommandLoader } from './types.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { filterCommandsForMode } from './commandUtils.js';
import { skillCommandMatchesSettingName } from '../config/skill-settings.js';

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
   * - Extension skills arrive pre-namespaced as `<extension>:<name>` from the
   *   SkillManager. Collisions on that full name get numeric suffixes
   *   (`<extension>:<name>1`). The suffix branch only sees collisions that
   *   arrive earlier, so SkillCommandLoader must come after FileCommandLoader;
   *   otherwise a file command claiming a qualified skill name silently
   *   overwrites the skill. A name withheld by a loader's own denylist stays
   *   occupied for this probe, so a rename cannot mint a name the user disabled
   *   (#9408).
   * - Other extension commands that conflict with existing commands are renamed
   *   to `extensionName.commandName`
   * - Non-extension commands (built-in, user, project) override earlier commands
   *   with the same name based on loader order
   *
   * @param loaders An array of objects that conform to the `ICommandLoader`
   *   interface. Built-in commands should come first, followed by FileCommandLoader.
   * @param signal An AbortSignal to cancel the loading process.
   * @param disabledNames Optional set of command names to exclude. Matched
   *   case-insensitively against the final (post-rename) command name. Intended
   *   for settings- or flag-driven denylists that gate the CLI surface (see
   *   `slashCommands.disabled` and `--disabled-slash-commands`). Each non-blank
   *   entry is also kept out of the collision probe, so a renamed command is
   *   never registered under a name that appears here.
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
    // Names the collision probe below must keep treating as taken even though
    // no command registers under them. A loader that applies `skills.disabled`
    // to its own output drops that skill before any rename runs, so the disabled
    // name is missing from `commandMap` and reads as free; handing it to a
    // renamed sibling would make a name the user disabled invocable again, with
    // a different skill behind it. `skills.disabled` is not re-checked after the
    // rename, so reserving the name is what enforces it (#9408).
    const reservedNames = new Set<string>();
    for (const entry of disabledNames ?? []) {
      const trimmed = entry.trim();
      if (trimmed) reservedNames.add(trimmed.toLowerCase());
    }
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        allCommands.push(...result.value);
      } else {
        debugLogger.debug('A command loader failed:', result.reason);
      }
      for (const name of loaders[index]?.reservedNames?.() ?? []) {
        const trimmed = name.trim();
        if (trimmed) reservedNames.add(trimmed.toLowerCase());
      }
    }

    const commandMap = new Map<string, SlashCommand>();
    for (const cmd of allCommands) {
      let finalName = cmd.name;

      // Shared collision scheme: probe the base, then numeric suffixes, so
      // skill commands and other extension commands resolve free names
      // identically (#9408). Reserved names are never handed out, whether a
      // denylist hid the command that owns them or nothing holds them yet.
      const claimFreeName = (base: string): string => {
        const isFree = (candidate: string): boolean =>
          !commandMap.has(candidate) &&
          !reservedNames.has(candidate.toLowerCase());
        if (isFree(base)) return base;
        let suffix = 1;
        while (!isFree(`${base}${suffix}`)) suffix++;
        return `${base}${suffix}`;
      };

      if (cmd.extensionName && commandMap.has(cmd.name)) {
        if (cmd.kind === CommandKind.SKILL) {
          // Skill commands already carry their extension prefix, so adding
          // another would be wrong. Suffix a number instead.
          finalName = claimFreeName(cmd.name);
        } else {
          // Non-skill extension commands get renamed to
          // `extensionName.commandName`.
          finalName = claimFreeName(`${cmd.extensionName}.${cmd.name}`);
        }
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
        for (const [name, cmd] of Array.from(commandMap.entries())) {
          const matchesPrimary =
            normalizedDisabled.has(name.toLowerCase()) ||
            (cmd.kind === CommandKind.SKILL &&
              skillCommandMatchesSettingName(cmd, normalizedDisabled));
          const matchesAlias = (cmd.altNames ?? []).some((a) =>
            normalizedDisabled.has(a.toLowerCase()),
          );
          if (matchesPrimary || matchesAlias) {
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
   * Hidden and non-user-invocable commands are excluded.
   */
  getCommandsForMode(mode: ExecutionMode): readonly SlashCommand[] {
    return Object.freeze(
      filterCommandsForMode(
        this.commands.filter(
          (cmd) => !cmd.hidden && cmd.userInvocable !== false,
        ),
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
