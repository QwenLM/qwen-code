/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Command,
  Option,
  CommandUnknownOpts,
} from '@commander-js/extra-typings';
import { getAppPlugins } from './registry.js';
import type { BuiltinPluginContributions } from '@qwen-code/core';
import { CommandKind, type SlashCommand } from '../ui/commands/types.js';
import type { SettingsService } from '@qwen-code/resource';
import type { StartFramework } from '../startup/frameworkFactory.js';
import type { CliArgs } from '../config/config.js';
import type {
  AppPlugin,
  AppTerminalCommandResolutionContext,
  BuiltinRootOptionContribution,
  AppTerminalCommandResult,
} from './types.js';

// Each command captures its own startup callback and Settings, never a global owner.
const commandStarts = new WeakMap<
  CommandUnknownOpts,
  (components: 'plugins' | 'auth' | 'local') => ReturnType<StartFramework>
>();
const productTerminalCommands = new WeakSet<CommandUnknownOpts>();

function attachCommandStartup(
  command: CommandUnknownOpts,
  settings: SettingsService,
  startFramework: StartFramework,
): void {
  commandStarts.set(command, async (components) => {
    const { getSettingsResolveOptions } = await import('../config/settings.js');
    const argv = command.optsWithGlobals() as unknown as CliArgs;
    return startFramework(
      command.optsWithGlobals()['remoteControl'] ? 'remoteWorker' : 'command',
      {
        argv,
        settings: settings.resolve(getSettingsResolveOptions(process.cwd())),
        command: components,
      },
    );
  });
}

export function isAppPluginTerminalCommand(
  command: CommandUnknownOpts,
): boolean {
  return commandStarts.has(command);
}

/** Plugin builtins replace host builtins; other sources use the common resolver. */
export function appendAppPluginSlashCommands(
  commands: readonly SlashCommand[],
  contributions?: BuiltinPluginContributions,
): SlashCommand[] {
  const merged = [...commands];
  const hostCommands = new Set(commands);
  for (const command of getAppPlugins(
    contributions,
  )?.getAppPluginSlashCommands() ?? []) {
    if (command.kind === CommandKind.BUILT_IN && !command.fallback) {
      const index = merged.findIndex(
        (existing) =>
          hostCommands.has(existing) &&
          existing.kind === CommandKind.BUILT_IN &&
          existing.name === command.name,
      );
      if (index >= 0) merged.splice(index, 1);
    }
    if (command.kind === CommandKind.DYNAMIC) {
      merged.push(command);
      continue;
    }
    // Skills and other non-builtin sources must reach SlashCommandResolver.
    const names = new Set(
      merged
        .filter(
          (entry) =>
            entry.kind === CommandKind.BUILT_IN &&
            (hostCommands.has(entry) || !entry.fallback),
        )
        .flatMap((entry) => [entry.name, ...(entry.altNames ?? [])]),
    );
    for (const name of [command.name, ...(command.altNames ?? [])]) {
      if (
        !/^[a-z][a-z0-9-]*$/.test(name) ||
        (!command.fallback && names.has(name))
      ) {
        throw new Error(
          `Invalid or duplicate app plugin slash command: ${name}`,
        );
      }
      if (!command.fallback) names.add(name);
    }
    if (command.kind === CommandKind.BUILT_IN && !command.fallback) {
      // Reserve plugin builtin names before Skills without reordering host entries.
      const index = merged.findIndex(
        (entry) => entry.kind !== CommandKind.BUILT_IN || entry.fallback,
      );
      merged.splice(index < 0 ? merged.length : index, 0, command);
    } else {
      merged.push(command);
    }
  }
  return merged;
}

export function registerAppPluginTerminalCommands(
  program: Command,
  declarations: ReadonlyArray<
    Pick<
      AppPlugin,
      'getTerminalCommands' | 'getRootOptions' | 'resolveTerminalCommands'
    >
  > = [],
  settingsService?: SettingsService,
  startFramework?: StartFramework,
): void {
  const hostCommands = new Set(program.commands);
  for (const entry of declarations.flatMap(
    (entry) => entry.getTerminalCommands?.() ?? [],
  )) {
    const { command, hidden, startup } =
      'name' in entry ? { command: entry } : entry;
    // Trusted product declarations replace a complete host command tree. Only
    // matching primary names can replace; alias collisions remain errors.
    const replaced = program.commands.find(
      (existing) =>
        hostCommands.has(existing) &&
        !productTerminalCommands.has(existing) &&
        existing.name() === command.name(),
    );
    const names = new Set(
      program.commands
        .filter((existing) => existing !== replaced)
        .flatMap((existing) => [existing.name(), ...existing.aliases()]),
    );
    reserveCommandNames(command, names);
    const attach = (node: CommandUnknownOpts) => {
      if (settingsService && startFramework && startup !== 'local')
        attachCommandStartup(node, settingsService, startFramework);
      for (const child of node.commands) attach(child);
    };
    attach(command);
    if (startup !== 'local')
      command.hook('preAction', async () => {
        const { initializeOutputListenersAndFlush } = await import(
          '../utils/outputListeners.js'
        );
        initializeOutputListenersAndFlush();
      });
    if (replaced) {
      // Commander has no removeCommand API; its runtime array is mutable even
      // though extra-typings exposes a readonly view.
      (program.commands as CommandUnknownOpts[]).splice(
        program.commands.indexOf(replaced),
        1,
      );
    }
    program.addCommand(command, { hidden });
    productTerminalCommands.add(command);
  }
}

/** Dynamic commands cannot replace any command or alias already mounted. */
export async function resolveAppPluginTerminalCommands(
  program: Command,
  declarations: ReadonlyArray<
    Pick<
      AppPlugin,
      'getTerminalCommands' | 'getRootOptions' | 'resolveTerminalCommands'
    >
  >,
  context: Omit<AppTerminalCommandResolutionContext, 'reservedCommandNames'>,
): Promise<void> {
  const names = new Set(
    program.commands.flatMap((command) => [
      command.name(),
      ...command.aliases(),
    ]),
  );
  for (const declaration of declarations) {
    const commands =
      (await declaration.resolveTerminalCommands?.({
        ...context,
        reservedCommandNames: new Set(names),
      })) ?? [];
    for (const command of commands) {
      reserveCommandNames(command, names);
      program.addCommand(command);
    }
  }
}

export function registerAppPluginRootOptions(
  program: CommandUnknownOpts,
  declarations: ReadonlyArray<
    Pick<
      AppPlugin,
      'getTerminalCommands' | 'getRootOptions' | 'resolveTerminalCommands'
    >
  > = [],
  settingsService?: SettingsService,
  startFramework?: StartFramework,
) {
  const contributions: BuiltinRootOptionContribution[] = declarations
    .flatMap((entry) => entry.getRootOptions?.() ?? [])
    .map((entry) => ('option' in entry ? entry : { option: entry }));
  if (settingsService && startFramework)
    attachCommandStartup(program, settingsService, startFramework);
  // Attribute names of host root options a product contribution took over.
  // Matching the primary long flag replaces the host option; short/alias
  // collisions remain errors below.
  const replacedRootOptions = new Set<string>();
  for (const { option } of contributions) {
    if (!option.long) continue;
    const index = program.options.findIndex(
      (existing) => existing.long === option.long,
    );
    if (index < 0) continue;
    const [removed] = (program.options as Option[]).splice(index, 1);
    replacedRootOptions.add(removed.attributeName());
  }
  const flags = new Set(program.options.flatMap(optionFlags));
  for (const { option } of contributions) {
    for (const flag of optionFlags(option)) {
      if (flags.has(flag)) {
        throw new Error(`Duplicate app plugin root option: ${flag}`);
      }
      flags.add(flag);
    }
    program.addOption(option);
  }
  const actionContributions = contributions.filter((entry) => entry.action);

  // Commander emits distinct CLI and environment events. Track actual Options,
  // not attribute keys: --feature and --no-feature share one parsed attribute.
  // Commander replaces rawArgs for each parse, but omits it from its typings.
  const parsedCommand = program as CommandUnknownOpts & {
    readonly rawArgs: readonly string[];
  };
  let parsedArgs: readonly string[] | undefined;
  const explicitOptions = new Set<Option>();
  for (const { option } of contributions) {
    program.on(`option:${option.name()}`, () => {
      if (parsedArgs !== parsedCommand.rawArgs) {
        explicitOptions.clear();
        parsedArgs = parsedCommand.rawArgs;
      }
      explicitOptions.add(option);
    });
  }
  const selectedActions = () =>
    parsedArgs === parsedCommand.rawArgs
      ? actionContributions.filter(({ option }) => explicitOptions.has(option))
      : [];

  return {
    valueOptionFlags: contributions
      .filter(({ option }) => option.required || option.optional)
      .flatMap(({ option }) => optionFlags(option)),
    actionOptions: actionContributions.map((entry) => entry.option),
    hasAction: () => selectedActions().length > 0,
    replacedRootOptions,
    validate(
      parsedOptions: Readonly<Record<string, unknown>>,
    ): readonly BuiltinRootOptionContribution[] {
      const options = Object.freeze({ ...parsedOptions });
      return contributions.filter(({ option }) =>
        parsedArgs === parsedCommand.rawArgs && explicitOptions.has(option),
      ).filter((contribution) => contribution.validate?.(options) !== false && Boolean(contribution.action));
    },
    selectAction(
      selected: readonly BuiltinRootOptionContribution[],
      parsedOptions: Readonly<Record<string, unknown>>,
    ): ((positionalArgs: readonly string[]) => Promise<void>) | undefined {
      const options: Readonly<Record<string, unknown>> = Object.freeze({
        ...parsedOptions,
      });
      if (selected.length > 1) {
        program.error(
          `Conflicting root option actions: ${selected.map(({ option }) => option.long ?? option.short).join(', ')}.`,
        );
      }
      const action = selected[0]?.action;
      if (!action) return undefined;

      return async (positionalArgs) => {
        const positionals = Object.freeze([...positionalArgs]);
        const { initializeOutputListenersAndFlush } = await import(
          '../utils/outputListeners.js'
        );
        initializeOutputListenersAndFlush();
        await runTerminalCommand(program, (signal) =>
          action({
            options,
            positionalArgs: positionals,
            signal,
          }),
        );
      };
    },
  };
}

function optionFlags(option: Option): string[] {
  return [option.short, option.long].filter(
    (flag): flag is string => flag !== undefined,
  );
}

function reserveCommandNames(
  command: CommandUnknownOpts,
  names: Set<string>,
): void {
  for (const name of [command.name(), ...command.aliases()]) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || names.has(name)) {
      throw new Error(`Invalid or duplicate app plugin command: ${name}`);
    }
    names.add(name);
  }
  const childNames = new Set<string>();
  for (const child of command.commands) reserveCommandNames(child, childNames);
}

export interface TerminalCommandOptions {
  /**
   * Application components the action needs: `plugins` (the default) starts
   * the app plugins and what they use; `auth` starts only the sign-in
   * state, as the CLI does for its own account commands; `local` prepares the
   * command host without signing in or starting app plugins/background sync.
   */
  components?: 'plugins' | 'auth' | 'local';
}

/**
 * Run a Commander action with the CLI terminal-command lifecycle.
 * Omitting the action displays group help without initializing plugins.
 */
export async function runTerminalCommand(
  command: CommandUnknownOpts,
  action?: (signal: AbortSignal) => Promise<AppTerminalCommandResult>,
  { components = 'plugins' }: TerminalCommandOptions = {},
): Promise<void> {
  if (!action) {
    command.outputHelp();
    const { exitCli } = await import('../utils/exitCli.js');
    await exitCli(0);
    return;
  }
  const start = commandStarts.get(command);
  if (!start)
    throw new Error('Terminal command is not attached to an application');
  const abort = new AbortController();
  const onInterrupt = () => abort.abort();
  const signals = ['SIGINT', 'SIGHUP', 'SIGTERM'] as const;
  for (const signal of signals) process.once(signal, onInterrupt);
  let result: AppTerminalCommandResult = { exitCode: 0 };
  try {
    const framework = await start(components);
    if (components === 'plugins') {
      await framework.appPlugins!.whenReady();
      framework.appPlugins!.get().markHostReady();
    }
    result = await action(abort.signal);
    if (typeof result !== 'string' && result.showHelp) command.outputHelp();
    writeTerminalResult(result);
  } finally {
    for (const signal of signals) process.off(signal, onInterrupt);
  }
  const { exitCli } = await import('../utils/exitCli.js');
  await exitCli(typeof result === 'string' ? 0 : result.exitCode);
}
function writeTerminalResult(result: AppTerminalCommandResult): void {
  const output = typeof result === 'string' ? result : result.output;
  const errorOutput =
    typeof result === 'string' ? undefined : result.errorOutput;
  if (output)
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
  if (errorOutput)
    process.stderr.write(
      errorOutput.endsWith('\n') ? errorOutput : `${errorOutput}\n`,
    );
}
