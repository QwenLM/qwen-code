/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { runLogger, coreEvents, type BuiltinPluginContributions } from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import type { ICommandLoader, CommandConflict } from './types.js';
import { SlashCommandResolver } from './SlashCommandResolver.js';
import { appendAppPluginSlashCommands } from '../app-plugins/commands.js';

/**
 * Orchestrates the discovery and loading of all slash commands for the CLI.
 *
 * This service operates on a provider-based loader pattern. It is initialized
 * with an array of `ICommandLoader` instances, each responsible for fetching
 * commands from a specific source (e.g., built-in code, local files).
 *
 * It uses a delegating resolver to reconcile name conflicts, ensuring that
 * all commands are uniquely addressable via source-specific prefixes while
 * allowing built-in commands to retain their primary names.
 */
export class CommandService {
  private static readonly sources = new WeakMap<readonly SlashCommand[], CommandService>();

  static readCurrentCommands(commands: readonly SlashCommand[]): readonly SlashCommand[] {
    const source = this.sources.get(commands);
    if (!source) return commands;
    try {
      return source.getCommands();
    } catch (error) {
      runLogger.warn('Failed to read app plugin slash commands:', error);
      return commands;
    }
  }

  /**
   * Private constructor to enforce the use of the async factory.
   * @param commands Original declarations, before plugin overrides or conflict renaming.
   * @param conflicts A readonly array of conflicts that occurred during loading.
   */
  private constructor(
    private readonly commands: readonly SlashCommand[],
    private readonly conflicts: readonly CommandConflict[],
    private readonly rejectedDynamicCommands: Set<string>,
    private readonly contributions?: BuiltinPluginContributions,
  ) {}

  /**
   * Asynchronously creates and initializes a new CommandService instance.
   *
   * This factory method orchestrates the loading process and delegates
   * conflict resolution to the SlashCommandResolver.
   *
   * @param loaders An array of loaders to fetch commands from.
   * @param signal An AbortSignal to allow cancellation.
   * @returns A promise that resolves to a fully initialized CommandService.
   */
  static async create(
    loaders: ICommandLoader[],
    signal: AbortSignal,
    contributions?: BuiltinPluginContributions,
  ): Promise<CommandService> {
    const loadedCommands = await this.loadAllCommands(loaders, signal);
    signal.throwIfAborted();
    const rejectedDynamicCommands = new Set<string>();
    const { conflicts } = this.resolveCommands(appendAppPluginSlashCommands(loadedCommands, contributions), rejectedDynamicCommands);
    if (conflicts.length > 0) this.emitConflictEvents(conflicts);
    signal.throwIfAborted();
    return new CommandService(Object.freeze(loadedCommands), conflicts, rejectedDynamicCommands, contributions);
  }

  private static resolveCommands(loadedCommands: SlashCommand[], rejectedDynamicCommands: Set<string>): {
    commands: readonly SlashCommand[];
    conflicts: readonly CommandConflict[];
  } {
    const regularCommands = loadedCommands.filter(
      (command) => !command.fallback && !this.isPluginDynamicCommand(command),
    );
    const { finalCommands, conflicts } = SlashCommandResolver.resolve(regularCommands);
    const dynamicCommands = this.resolvePluginDynamicCommands(
      loadedCommands.filter(
        (command) => !command.fallback && this.isPluginDynamicCommand(command),
      ),
      [...regularCommands, ...finalCommands],
      rejectedDynamicCommands,
    );
    finalCommands.push(...dynamicCommands);

    const fallbackCommands = this.registerMissingCommands(
      loadedCommands.filter((command) => command.fallback),
      finalCommands,
    );
    finalCommands.push(...fallbackCommands);

    return { commands: Object.freeze(finalCommands), conflicts: Object.freeze(conflicts) };
  }

  /** A fallback catalog cannot validate dynamic commands against all command sources. */
  static resolveFallbackCommands(
    loadedCommands: SlashCommand[],
    signal: AbortSignal,
    contributions?: BuiltinPluginContributions,
  ): readonly SlashCommand[] {
    signal.throwIfAborted();
    const availableCommands = appendAppPluginSlashCommands(loadedCommands, contributions).filter(
      (command) => command.kind !== CommandKind.DYNAMIC,
    );
    const { finalCommands } = SlashCommandResolver.resolve(
      availableCommands.filter((command) => !command.fallback),
    );
    const fallbackCommands = this.registerMissingCommands(
      availableCommands.filter((command) => command.fallback),
      finalCommands,
    );
    finalCommands.push(...fallbackCommands);
    return Object.freeze(finalCommands);
  }

  private static isPluginDynamicCommand(command: SlashCommand): boolean {
    return command.kind === CommandKind.DYNAMIC && Boolean(command.pluginName);
  }

  private static commandNames(command: SlashCommand): string[] {
    return [
      command.name,
      ...(command.displayName ? [command.displayName] : []),
      ...(command.altNames ?? []),
    ];
  }

  private static hasValidNames(
    command: SlashCommand,
    names: readonly string[],
  ): boolean {
    const dynamic = command.kind === CommandKind.DYNAMIC;
    const pattern = dynamic ? /^[a-z0-9][a-z0-9_-]*$/ : /^[a-z][a-z0-9-]*$/;
    return (
      new Set(names).size === names.length &&
      names.every(
        (name) => pattern.test(name) && (!dynamic || name.length <= 64),
      )
    );
  }

  /** Fallback declarations fill gaps and never displace a registered command. */
  private static registerMissingCommands(
    candidates: SlashCommand[],
    registered: readonly SlashCommand[],
  ): SlashCommand[] {
    const occupiedNames = new Set(
      registered.flatMap((command) => this.commandNames(command)),
    );
    return candidates.filter((command) => {
      const names = this.commandNames(command);
      if (
        !this.hasValidNames(command, names) ||
        names.some((name) => occupiedNames.has(name))
      ) {
        return false;
      }
      for (const name of names) occupiedNames.add(name);
      return true;
    });
  }

  /** Plugin dynamic commands are rejected on conflict, never renamed. */
  private static resolvePluginDynamicCommands(
    commands: SlashCommand[],
    regularCommands: SlashCommand[],
    previouslyRejected: Set<string>,
  ): SlashCommand[] {
    const occupiedNames = new Set(
      regularCommands.flatMap((command) => this.commandNames(command)),
    );
    const rejected = new Set<string>();
    const accepted = commands.filter((command) => {
      const names = this.commandNames(command);
      if (
        !this.hasValidNames(command, names) ||
        names.some((name) => occupiedNames.has(name))
      ) {
        const key = JSON.stringify([command.pluginName, command.loadedFrom, command.name]);
        if (!previouslyRejected.has(key) && !rejected.has(key)) {
          runLogger.warn(`[commands] Rejected command '/${command.name}'`);
        }
        rejected.add(key);
        return false;
      }
      for (const name of names) occupiedNames.add(name);
      return true;
    });
    // Record transitions, not every read of an unchanged rejected declaration.
    previouslyRejected.clear();
    for (const key of rejected) previouslyRejected.add(key);
    return accepted;
  }

  /**
   * Invokes all loaders in parallel and flattens the results.
   */
  private static async loadAllCommands(
    loaders: ICommandLoader[],
    signal: AbortSignal,
  ): Promise<SlashCommand[]> {
    const results = await Promise.allSettled(
      loaders.map((loader) => loader.loadCommands(signal)),
    );

    const commands: SlashCommand[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        commands.push(...result.value);
      } else {
        runLogger.debug('A command loader failed:', result.reason);
      }
    }
    return commands;
  }

  /**
   * Reports command conflicts to the UI feedback handler.
   */
  private static emitConflictEvents(conflicts: readonly CommandConflict[]): void {
    coreEvents.emitSlashCommandConflicts(
      conflicts.flatMap((c) =>
        c.losers.map((l) => ({
          name: c.name,
          renamedTo: l.renamedTo,
          loserPluginName: l.command.pluginName,
          winnerPluginName: l.reason.pluginName,
          loserMcpServerName: l.command.mcpServerName,
          winnerMcpServerName: l.reason.mcpServerName,
          loserKind: l.command.kind,
          winnerKind: l.reason.kind,
        })),
      ),
    );
  }

  /**
   * Reads current app plugin contributions and combines them with loaded host commands.
   *
   * Plugin getters read in-memory state; host loaders are not rerun here.
   * Rebuilding from the host catalog withdraws removed declarations and overrides.
   *
   * @returns A readonly, unified array of available `SlashCommand` objects.
   */
  getCommands(): readonly SlashCommand[] {
    const commands = CommandService.resolveCommands(
      appendAppPluginSlashCommands(this.commands, this.contributions),
      this.rejectedDynamicCommands,
    ).commands;
    CommandService.sources.set(commands, this);
    return commands;
  }

  /**
   * Retrieves the list of conflicts that occurred during command loading.
   *
   * @returns A readonly array of command conflicts.
   */
  getConflicts(): readonly CommandConflict[] {
    return this.conflicts;
  }
}
