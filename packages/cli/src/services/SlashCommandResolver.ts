/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import type { CommandConflict } from './types.js';

/**
 * Internal registry to track commands and conflicts during resolution.
 */
class CommandRegistry {
  readonly commandMap = new Map<string, SlashCommand>();
  readonly conflictsMap = new Map<string, CommandConflict>();
  readonly firstEncounters = new Map<string, SlashCommand>();

  get finalCommands(): SlashCommand[] {
    return Array.from(this.commandMap.values());
  }

  get conflicts(): CommandConflict[] {
    return Array.from(this.conflictsMap.values());
  }
}

/**
 * Resolves name conflicts among slash commands.
 *
 * Rules:
 * 1. Built-in commands always keep the original name.
 * 2. Already source-qualified plugin commands keep that qualified name. MCP
 *    prompts live in the isolated `mcp__server__prompt` namespace and can
 *    never collide with other command sources, so they need no handling here.
 * 3. Other non-built-in commands are renamed with a source prefix or suffix.
 * 4. Same-plugin command/skill duplicates collapse to the command.
 */
export class SlashCommandResolver {
  /**
   * Orchestrates conflict resolution by applying renaming rules to ensures
   * every command has a unique name.
   */
  static resolve(allCommands: SlashCommand[]): {
    finalCommands: SlashCommand[];
    conflicts: CommandConflict[];
  } {
    const registry = new CommandRegistry();

    for (const cmd of allCommands) {
      const originalName = cmd.name;
      let finalName = originalName;

      // Plugin skills and commands already carry their `pluginName:` prefix
      // from SkillManager / loadPluginCommands. The resolver only handles
      // name *collisions* — it never proactively adds prefixes.
      if (registry.firstEncounters.has(originalName)) {
        // We've already seen a command with this name, so resolve the conflict.
        const resolvedName = this.handleConflict(cmd, registry);
        if (resolvedName === null) {
          continue;
        }
        finalName = resolvedName;
      } else {
        // Track the first claimant to report them as the conflict reason later.
        registry.firstEncounters.set(originalName, cmd);
      }

      // Store under final name, ensuring the command object reflects it.
      registry.commandMap.set(finalName, {
        ...cmd,
        name: finalName,
      });
    }

    return {
      finalCommands: registry.finalCommands,
      conflicts: registry.conflicts,
    };
  }

  /**
   * Resolves a name collision by deciding which command keeps the name and which is renamed.
   *
   * @param incoming The command currently being processed that has a name collision.
   * @param registry The internal state of the resolution process.
   * @returns The final name to be assigned to the `incoming` command.
   */
  private static handleConflict(
    incoming: SlashCommand,
    registry: CommandRegistry,
  ): string | null {
    const collidingName = incoming.name;
    const originalClaimant = registry.firstEncounters.get(collidingName)!;
    const currentOwner = registry.commandMap.get(collidingName);

    const samePluginResolution = this.resolveSamePluginCommandSkillConflict(
      collidingName,
      incoming,
      currentOwner,
      registry,
    );
    if (samePluginResolution !== undefined) {
      return samePluginResolution;
    }

    // Incoming built-in takes priority. Prefix any existing owner.
    if (incoming.kind === CommandKind.BUILT_IN) {
      this.prefixExistingCommand(collidingName, incoming, registry);
      return collidingName;
    }

    // Incoming non-built-in is renamed to its source-prefixed version.
    const renamedName = this.getRenamedName(
      incoming.name,
      this.getPrefix(incoming),
      registry.commandMap,
      incoming.kind,
    );
    this.trackConflict(
      registry.conflictsMap,
      collidingName,
      originalClaimant,
      incoming,
      renamedName,
    );

    // Prefix current owner as well if it isn't a built-in.
    this.prefixExistingCommand(collidingName, incoming, registry);

    return renamedName;
  }

  /**
   * Safely renames the command currently occupying a name in the registry.
   *
   * @param name The name of the command to prefix.
   * @param reason The incoming command that is causing the prefixing.
   * @param registry The internal state of the resolution process.
   */
  private static prefixExistingCommand(
    name: string,
    reason: SlashCommand,
    registry: CommandRegistry,
  ): void {
    const currentOwner = registry.commandMap.get(name);

    // Only non-built-in commands can be prefixed.
    if (!currentOwner || currentOwner.kind === CommandKind.BUILT_IN) {
      return;
    }

    // If the current owner already carries its source-qualified name
    // (`plugin:command`), leave it in place and rename only the incoming
    // command. This prevents a later workflow/dynamic collision from pushing
    // an already-qualified plugin command to `plugin:command1`.
    // Note: this only protects the first-encountered owner, so it relies on
    // qualified sources (skills, plugin commands) being loaded before
    // unqualified ones (workflow, dynamic) in the loader order.
    // MCP prompts are exempt from conflict handling entirely: they live in
    // the `mcp__server__prompt` namespace and can never collide with other
    // command sources.
    if (
      reason.kind !== CommandKind.BUILT_IN &&
      this.isAlreadySourceQualified(currentOwner)
    ) {
      return;
    }

    // Determine the new name for the owner using its source prefix.
    const renamedName = this.getRenamedName(
      currentOwner.name,
      this.getPrefix(currentOwner),
      registry.commandMap,
      currentOwner.kind,
    );

    // Update the registry: remove the old name and add the owner under the new name.
    registry.commandMap.delete(name);
    const renamedOwner = { ...currentOwner, name: renamedName };
    registry.commandMap.set(renamedName, renamedOwner);

    // Record the conflict so the user can be notified of the prefixing.
    this.trackConflict(
      registry.conflictsMap,
      name,
      reason,
      currentOwner,
      renamedName,
    );
  }

  /**
   * Generates a unique name using numeric suffixes if needed.
   */
  private static getRenamedName(
    name: string,
    prefix: string | undefined,
    commandMap: Map<string, SlashCommand>,
    kind?: CommandKind,
  ): string {
    const isPluginPrefix = kind === CommandKind.SKILL;
    const separator = isPluginPrefix ? ':' : '.';
    const base = prefix ? `${prefix}${separator}${name}` : name;
    let renamedName = base;
    let suffix = 1;

    while (commandMap.has(renamedName)) {
      renamedName = `${base}${suffix}`;
      suffix++;
    }
    return renamedName;
  }

  /**
   * Returns a suitable prefix for a conflicting command.
   * Returns undefined if the name already carries its source prefix
   * (plugin skills/commands are prefixed at load time by SkillManager /
   * loadPluginCommands, so re-prefixing would produce duplicates).
   */
  private static getPrefix(cmd: SlashCommand): string | undefined {
    switch (cmd.kind) {
      case CommandKind.SKILL:
      case CommandKind.PLUGIN: {
        const prefix = cmd.pluginName;
        // Already prefixed at load time — don't double-prefix
        if (prefix && cmd.name.startsWith(`${prefix}:`)) return undefined;
        return prefix;
      }
      case CommandKind.WORKFLOW:
        return 'workflow';
      case CommandKind.DYNAMIC:
        return 'dynamic';
      default:
        return undefined;
    }
  }

  /**
   * Same-plugin command/skill duplication is a plugin composition detail, not
   * a user-facing slash-command conflict. Plugin command files shadow
   * same-named plugin skills.
   */
  private static resolveSamePluginCommandSkillConflict(
    name: string,
    incoming: SlashCommand,
    currentOwner: SlashCommand | undefined,
    registry: CommandRegistry,
  ): string | null | undefined {
    if (
      !currentOwner ||
      !incoming.pluginName ||
      incoming.pluginName !== currentOwner.pluginName
    ) {
      return undefined;
    }

    const incomingIsPluginCommand = incoming.kind === CommandKind.PLUGIN;
    const incomingIsSkill = incoming.kind === CommandKind.SKILL;
    const currentIsPluginCommand = currentOwner.kind === CommandKind.PLUGIN;
    const currentIsSkill = currentOwner.kind === CommandKind.SKILL;

    if (incomingIsPluginCommand && currentIsSkill) {
      registry.firstEncounters.set(name, incoming);
      return name;
    }

    if (incomingIsSkill && currentIsPluginCommand) {
      return null;
    }

    return undefined;
  }

  private static isAlreadySourceQualified(cmd: SlashCommand): boolean {
    switch (cmd.kind) {
      case CommandKind.SKILL:
      case CommandKind.PLUGIN:
        return Boolean(
          cmd.pluginName && cmd.name.startsWith(`${cmd.pluginName}:`),
        );
      default:
        return false;
    }
  }

  /**
   * Logs a conflict event.
   */
  private static trackConflict(
    conflictsMap: Map<string, CommandConflict>,
    originalName: string,
    reason: SlashCommand,
    displacedCommand: SlashCommand,
    renamedTo: string,
  ) {
    if (!conflictsMap.has(originalName)) {
      conflictsMap.set(originalName, {
        name: originalName,
        losers: [],
      });
    }

    conflictsMap.get(originalName)!.losers.push({
      command: displacedCommand,
      renamedTo,
      reason,
    });
  }
}
