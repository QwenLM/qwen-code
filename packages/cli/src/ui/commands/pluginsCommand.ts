/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
  CommandKind,
} from './types.js';
import { MessageType, type HistoryItemInfo } from '../types.js';
import {
  getErrorMessage,
  getPluginErrorMessage,
  refreshActivePlugins,
} from '@qwen-code/core';
import {
  addMarketplaceForCommand,
  disableAllPluginsForCommand,
  formatMarketplaceOperationStatus,
  formatPluginMutationMessage,
  getMarketplaceOperationTimeoutMs,
  getRemainingOperationSeconds,
  installPluginForCommand,
  listMarketplacesForCommand,
  normalizePluginScope,
  parseBooleanFlag,
  parsePluginArgs,
  parseScopeFlag,
  removeMarketplaceForCommand,
  setPluginEnabledForCommand,
  uninstallPluginForCommand,
  updateMarketplaceForCommand,
  updatePluginForCommand,
  validatePluginForCommand,
} from '@qwen-code/core/plugin-management';

function result(
  text: string,
  severity: 'info' | 'error' = 'info',
): SlashCommandActionReturn {
  return { type: 'local_command_result', text, severity };
}

function errorResult(error: unknown): SlashCommandActionReturn {
  return result(getErrorMessage(error), 'error');
}

function requiredArg(args: string[], label: string): string {
  const value = args[0];
  if (!value) {
    throw new Error(`Missing ${label}.`);
  }
  return value;
}

function parseSparseFlag(args: string[]): {
  sparsePaths?: string[];
  rest: string[];
} {
  const rest: string[] = [];
  const sparsePaths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--sparse') {
      while (args[i + 1] && !args[i + 1].startsWith('-')) {
        sparsePaths.push(args[++i]);
      }
      if (sparsePaths.length === 0) {
        throw new Error('--sparse requires at least one path.');
      }
    } else {
      rest.push(arg);
    }
  }
  return {
    sparsePaths: sparsePaths.length > 0 ? sparsePaths : undefined,
    rest,
  };
}

function startMarketplacePending(
  context: CommandContext,
  action: string,
  target?: string,
): {
  onProgress: (message: string) => void;
  stop: () => void;
} {
  const timeoutMs = getMarketplaceOperationTimeoutMs();
  let startedAt = Date.now();
  let detail: string | undefined;
  const render = () => {
    context.ui.setPendingItem({
      type: MessageType.INFO,
      text: formatMarketplaceOperationStatus(action, {
        target,
        detail,
        remainingSeconds: getRemainingOperationSeconds(startedAt, timeoutMs),
      }),
    });
  };

  render();
  const timer = setInterval(render, 1000);
  timer.unref?.();

  return {
    onProgress: (message: string) => {
      startedAt = Date.now();
      detail = message;
      render();
    },
    stop: () => {
      clearInterval(timer);
      context.ui.setPendingItem(null);
    },
  };
}

// ---------------------------------------------------------------------------
// /plugins reload
// ---------------------------------------------------------------------------

async function reloadAction(
  context: CommandContext,
): Promise<void | SlashCommandActionReturn> {
  const config = context.services.agentContext?.config;
  if (!config) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: 'Could not retrieve configuration.',
    });
    return;
  }

  try {
    context.ui.addItem({
      type: MessageType.INFO,
      text: 'Reloading plugins...',
    });

    const { enabled, errors } = await refreshActivePlugins({
      config,
      reason: 'reload-command',
      emitToFeed: true,
    });

    context.ui.reloadCommands();

    const skills = config.getSkillManager?.()?.getSkills() ?? [];
    const parts = [`${enabled.length} plugin(s) active`];
    if (skills.length > 0) {
      parts.push(`${skills.length} skill(s) loaded`);
    }
    if (errors.length > 0) {
      parts.push(`${errors.length} error(s)`);
    }

    const hasErrors = errors.length > 0;
    context.ui.addItem({
      type: hasErrors ? 'warning' : 'info',
      text: `Plugins reloaded. ${parts.join(', ')}.`,
      icon: hasErrors ? '\u26A0 ' : '\u2713 ',
      color: hasErrors ? 'yellow' : 'green',
    } as HistoryItemInfo);

    for (const err of errors) {
      context.ui.addItem({
        type: MessageType.ERROR,
        text: getPluginErrorMessage(err),
      });
    }
  } catch (error) {
    context.ui.addItem({
      type: MessageType.ERROR,
      text: `Reload failed: ${getErrorMessage(error)}`,
    });
  }
}

async function installAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const scoped = parseScopeFlag(parsePluginArgs(args));
    const plugin = requiredArg(scoped.rest, 'plugin');
    const operation = await installPluginForCommand({
      plugin,
      scope: scoped.scope ?? 'user',
      settings: context.services.settings,
        config: context.services.agentContext?.config,
    });
    return result(formatPluginMutationMessage(operation));
  } catch (error) {
    return errorResult(error);
  }
}

async function uninstallAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const keepData = parseBooleanFlag(parsePluginArgs(args), ['--keep-data']);
    const scoped = parseScopeFlag(keepData.rest);
    const plugin = requiredArg(scoped.rest, 'plugin');
    const operation = await uninstallPluginForCommand({
      plugin,
      scope: scoped.scope ?? 'user',
      settings: context.services.settings,
        config: context.services.agentContext?.config,
      keepData: keepData.enabled,
    });
    return result(formatPluginMutationMessage(operation));
  } catch (error) {
    return errorResult(error);
  }
}

async function updateAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const scoped = parseScopeFlag(parsePluginArgs(args));
    const plugin = requiredArg(scoped.rest, 'plugin');
    return result(
      await updatePluginForCommand({
        plugin,
        scope: scoped.scope ?? 'user',
        settings: context.services.settings,
        config: context.services.agentContext?.config,
      }),
    );
  } catch (error) {
    return errorResult(error);
  }
}

async function validateAction(
  _context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const pluginPath = requiredArg(parsePluginArgs(args), 'plugin path');
    return result(await validatePluginForCommand(pluginPath));
  } catch (error) {
    return errorResult(error);
  }
}

async function enableAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const scoped = parseScopeFlag(parsePluginArgs(args));
    const plugin = requiredArg(scoped.rest, 'plugin');
    return result(
      await setPluginEnabledForCommand({
        plugin,
        enabled: true,
        settings: context.services.settings,
        config: context.services.agentContext?.config,
        scope: scoped.scope,
      }),
    );
  } catch (error) {
    return errorResult(error);
  }
}

async function disableAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const all = parseBooleanFlag(parsePluginArgs(args), ['--all', '-a']);
    const scoped = parseScopeFlag(all.rest);
    if (all.enabled) {
      return result(
        await disableAllPluginsForCommand(context.services.settings, { config: context.services.agentContext?.config }),
      );
    }
    const plugin = requiredArg(scoped.rest, 'plugin');
    return result(
      await setPluginEnabledForCommand({
        plugin,
        enabled: false,
        settings: context.services.settings,
        config: context.services.agentContext?.config,
        scope: scoped.scope,
      }),
    );
  } catch (error) {
    return errorResult(error);
  }
}

async function marketplaceAddAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const sparse = parseSparseFlag(parsePluginArgs(args));
    const scoped = parseScopeFlag(sparse.rest);
    const sourceInput = requiredArg(scoped.rest, 'marketplace source');
    const progress = startMarketplacePending(context, 'Adding', sourceInput);
    try {
      return result(
        await addMarketplaceForCommand({
          settings: context.services.settings,
          sourceInput,
          scope: scoped.scope ?? normalizePluginScope(undefined),
          sparsePaths: sparse.sparsePaths,
          onProgress: progress.onProgress,
        }),
      );
    } finally {
      progress.stop();
    }
  } catch (error) {
    return errorResult(error);
  }
}

async function marketplaceListAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const json = parseBooleanFlag(parsePluginArgs(args), ['--json']).enabled;
    return result(
      listMarketplacesForCommand(context.services.settings.merged, json),
    );
  } catch (error) {
    return errorResult(error);
  }
}

async function marketplaceRemoveAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const scoped = parseScopeFlag(parsePluginArgs(args));
    const name = requiredArg(scoped.rest, 'marketplace name');
    return result(
      await removeMarketplaceForCommand({
        settings: context.services.settings,
        config: context.services.agentContext?.config,
        name,
        scope: scoped.scope,
      }),
    );
  } catch (error) {
    return errorResult(error);
  }
}

async function marketplaceUpdateAction(
  context: CommandContext,
  args: string,
): Promise<SlashCommandActionReturn> {
  try {
    const [name] = parsePluginArgs(args);
    const progress = startMarketplacePending(context, 'Updating', name);
    try {
      return result(
        await updateMarketplaceForCommand(name, progress.onProgress),
      );
    } finally {
      progress.stop();
    }
  } catch (error) {
    return errorResult(error);
  }
}

const marketplaceSubCommands: SlashCommand[] = [
  {
    name: 'add',
    description: 'Add a marketplace',
    argumentHint: '<source>',
    kind: CommandKind.BUILT_IN,
    isSafeConcurrent: true,
    action: marketplaceAddAction,
  },
  {
    name: 'list',
    description: 'List marketplaces',
    kind: CommandKind.BUILT_IN,
    isSafeConcurrent: true,
    action: marketplaceListAction,
  },
  {
    name: 'remove',
    altNames: ['rm'],
    description: 'Remove a marketplace',
    argumentHint: '<name>',
    kind: CommandKind.BUILT_IN,
    isSafeConcurrent: true,
    action: marketplaceRemoveAction,
  },
  {
    name: 'update',
    description: 'Update marketplace(s)',
    argumentHint: '[name]',
    kind: CommandKind.BUILT_IN,
    isSafeConcurrent: true,
    action: marketplaceUpdateAction,
  },
];

// ---------------------------------------------------------------------------
// /plugins (main command — opens the plugin browser dialog)
// ---------------------------------------------------------------------------

function openPluginBrowserAction(
  _context: CommandContext,
  args: string,
): SlashCommandActionReturn {
  return {
    type: 'dialog',
    dialog: 'pluginBrowser',
    props: args?.trim() ? { args: args.trim() } : undefined,
  };
}

function openMarketplaceBrowserAction(
  _context: CommandContext,
  args: string,
): SlashCommandActionReturn {
  const normalizedArgs = `marketplace${args?.trim() ? ` ${args.trim()}` : ''}`;
  return {
    type: 'dialog',
    dialog: 'pluginBrowser',
    props: { args: normalizedArgs },
  };
}

export const pluginsCommand: SlashCommand = {
  name: 'plugins',
  altNames: ['plugin'],
  description: 'Manage plugins',
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  subCommands: [
    {
      name: 'install',
      altNames: ['i'],
      description: 'Install a plugin',
      argumentHint: '<plugin>',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: installAction,
    },
    {
      name: 'uninstall',
      altNames: ['remove', 'rm'],
      description: 'Uninstall a plugin',
      argumentHint: '<plugin>',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: uninstallAction,
    },
    {
      name: 'enable',
      description: 'Enable a plugin',
      argumentHint: '<plugin>',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: enableAction,
    },
    {
      name: 'disable',
      description: 'Disable a plugin',
      argumentHint: '<plugin>',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: disableAction,
    },
    {
      name: 'update',
      description: 'Update a plugin',
      argumentHint: '<plugin>',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: updateAction,
    },
    {
      name: 'validate',
      description: 'Validate a plugin',
      argumentHint: '<path>',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: validateAction,
    },
    {
      name: 'marketplace',
      altNames: ['market'],
      description: 'Manage plugin marketplaces',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      subCommands: marketplaceSubCommands,
      action: openMarketplaceBrowserAction,
    },
    {
      name: 'reload',
      description: 'Reload all plugins. Usage: /plugins reload',
      kind: CommandKind.BUILT_IN,
      isSafeConcurrent: true,
      action: reloadAction,
    },
  ],
  action: openPluginBrowserAction,
};

export const marketplaceCommand: SlashCommand = {
  name: 'marketplace',
  altNames: ['market'],
  description: 'Manage plugin marketplaces',
  hidden: true,
  kind: CommandKind.BUILT_IN,
  isSafeConcurrent: true,
  subCommands: marketplaceSubCommands,
  action: openMarketplaceBrowserAction,
};
