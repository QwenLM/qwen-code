/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from '../../utils/errors.js';
import { ExtensionUpdateState } from '../state/extensions.js';
import { MessageType } from '../types.js';
import {
  type CommandContext,
  type SlashCommand,
  CommandKind,
} from './types.js';
import { t } from '../../i18n/index.js';
import {
  ExtensionManager,
  parseInstallSource,
  type ExtensionUpdateInfo,
} from '@qwen-code/qwen-code-core';
import { SettingScope } from '../../config/settings.js';
import open from 'open';
import { extensionToOutputString } from '../../commands/extensions/utils.js';

const EXTENSION_EXPLORE_URL = {
  Gemini: 'https://geminicli.com/extensions/',
  ClaudeCode: 'https://claudemarketplaces.com/',
} as const;

type ExtensionExploreSource = keyof typeof EXTENSION_EXPLORE_URL;

function showMessageIfNoExtensions(
  context: CommandContext,
  extensions: unknown[],
): boolean {
  if (extensions.length === 0) {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('No extensions installed.'),
      },
      Date.now(),
    );
    return true;
  }
  return false;
}

async function exploreAction(context: CommandContext, args: string) {
  const source = args.trim();
  const extensionsUrl = source
    ? EXTENSION_EXPLORE_URL[source as ExtensionExploreSource]
    : '';
  if (!extensionsUrl) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Unknown extensions source: {{source}}.', { source }),
      },
      Date.now(),
    );
    return;
  }
  // Only check for NODE_ENV for explicit test mode, not for unit test framework
  if (process.env['NODE_ENV'] === 'test') {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t(
          'Would open extensions page in your browser: {{url}} (skipped in test environment)',
          { url: extensionsUrl },
        ),
      },
      Date.now(),
    );
  } else if (
    process.env['SANDBOX'] &&
    process.env['SANDBOX'] !== 'sandbox-exec'
  ) {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('View available extensions at {{url}}', { url: extensionsUrl }),
      },
      Date.now(),
    );
  } else {
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Opening extensions page in your browser: {{url}}', {
          url: extensionsUrl,
        }),
      },
      Date.now(),
    );
    try {
      await open(extensionsUrl);
    } catch (_error) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Failed to open browser. Check out the extensions gallery at {{url}}',
            { url: extensionsUrl },
          ),
        },
        Date.now(),
      );
    }
  }
}

async function listAction(context: CommandContext) {
  const extensions = context.services.config
    ? context.services.config.getExtensions()
    : [];

  if (showMessageIfNoExtensions(context, extensions)) {
    return;
  }

  context.ui.addItem(
    {
      type: MessageType.EXTENSIONS_LIST,
    },
    Date.now(),
  );
}

async function updateAction(context: CommandContext, args: string) {
  const updateArgs = args.split(' ').filter((value) => value.length > 0);
  const all = updateArgs.length === 1 && updateArgs[0] === '--all';
  const names = all ? undefined : updateArgs;

  if (!all && names?.length === 0) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Usage: /extensions update <extension-names>|--all'),
      },
      Date.now(),
    );
    return;
  }

  let updateInfos: ExtensionUpdateInfo[] = [];

  const extensionManager = context.services.config!.getExtensionManager();
  const extensions = context.services.config
    ? context.services.config.getExtensions()
    : [];

  if (showMessageIfNoExtensions(context, extensions)) {
    return Promise.resolve();
  }

  try {
    context.ui.dispatchExtensionStateUpdate({ type: 'BATCH_CHECK_START' });
    await extensionManager.checkForAllExtensionUpdates((extensionName, state) =>
      context.ui.dispatchExtensionStateUpdate({
        type: 'SET_STATE',
        payload: { name: extensionName, state },
      }),
    );
    context.ui.dispatchExtensionStateUpdate({ type: 'BATCH_CHECK_END' });

    context.ui.setPendingItem({
      type: MessageType.EXTENSIONS_LIST,
    });
    if (all) {
      updateInfos = await extensionManager.updateAllUpdatableExtensions(
        context.ui.extensionsUpdateState,
        (extensionName, state) =>
          context.ui.dispatchExtensionStateUpdate({
            type: 'SET_STATE',
            payload: { name: extensionName, state },
          }),
      );
    } else if (names?.length) {
      const extensions = context.services.config!.getExtensions();
      for (const name of names) {
        const extension = extensions.find(
          (extension) => extension.name === name,
        );
        if (!extension) {
          context.ui.addItem(
            {
              type: MessageType.ERROR,
              text: t('Extension "{{name}}" not found.', { name }),
            },
            Date.now(),
          );
          continue;
        }
        const updateInfo = await extensionManager.updateExtension(
          extension,
          context.ui.extensionsUpdateState.get(extension.name)?.status ??
            ExtensionUpdateState.UNKNOWN,
          (extensionName, state) =>
            context.ui.dispatchExtensionStateUpdate({
              type: 'SET_STATE',
              payload: { name: extensionName, state },
            }),
        );
        if (updateInfo) updateInfos.push(updateInfo);
      }
    }

    if (updateInfos.length === 0) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('No extensions to update.'),
        },
        Date.now(),
      );
      return;
    }
  } catch (error) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: getErrorMessage(error),
      },
      Date.now(),
    );
  } finally {
    context.ui.addItem(
      {
        type: MessageType.EXTENSIONS_LIST,
      },
      Date.now(),
    );
    context.ui.reloadCommands();
    context.ui.setPendingItem(null);
  }
}

async function installAction(context: CommandContext, args: string) {
  const extensionManager = context.services.config?.getExtensionManager();
  if (!(extensionManager instanceof ExtensionManager)) {
    console.error(
      `Cannot ${context.invocation?.name} extensions in this environment`,
    );
    return;
  }

  const source = args.trim();
  if (!source) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Usage: /extensions install <source>'),
      },
      Date.now(),
    );
    return;
  }

  try {
    const installMetadata = await parseInstallSource(source);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Installing extension from "{{source}}"...', { source }),
      },
      Date.now(),
    );
    const extension = await extensionManager.installExtension(installMetadata);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Extension "{{name}}" installed successfully.', {
          name: extension.name,
        }),
      },
      Date.now(),
    );
    // FIXME: refresh command controlled by ui for now, cannot be auto refreshed by extensionManager
    context.ui.reloadCommands();
  } catch (error) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Failed to install extension from "{{source}}": {{error}}', {
          source,
          error: getErrorMessage(error),
        }),
      },
      Date.now(),
    );
    return;
  }
}

async function uninstallAction(context: CommandContext, args: string) {
  const extensionManager = context.services.config?.getExtensionManager();
  if (!(extensionManager instanceof ExtensionManager)) {
    console.error(
      `Cannot ${context.invocation?.name} extensions in this environment`,
    );
    return;
  }

  const name = args.trim();
  if (!name) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Usage: /extensions uninstall <extension-name>'),
      },
      Date.now(),
    );
    return;
  }

  context.ui.addItem(
    {
      type: MessageType.INFO,
      text: t('Uninstalling extension "{{name}}"...', { name }),
    },
    Date.now(),
  );

  try {
    await extensionManager.uninstallExtension(name, false);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Extension "{{name}}" uninstalled successfully.', { name }),
      },
      Date.now(),
    );
    context.ui.reloadCommands();
  } catch (error) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Failed to uninstall extension "{{name}}": {{error}}', {
          name,
          error: getErrorMessage(error),
        }),
      },
      Date.now(),
    );
  }
}

function getEnableDisableContext(
  context: CommandContext,
  argumentsString: string,
): {
  extensionManager: ExtensionManager;
  names: string[];
  scope: SettingScope;
} | null {
  const extensionManager = context.services.config?.getExtensionManager();
  if (!(extensionManager instanceof ExtensionManager)) {
    console.error(
      `Cannot ${context.invocation?.name} extensions in this environment`,
    );
    return null;
  }
  const parts = argumentsString.split(' ');
  const name = parts[0];
  if (
    name === '' ||
    !(
      (parts.length === 2 && parts[1].startsWith('--scope=')) || // --scope=<scope>
      (parts.length === 3 && parts[1] === '--scope') // --scope <scope>
    )
  ) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t(
          'Usage: /extensions {{command}} <extension> [--scope=<user|workspace>]',
          {
            command: context.invocation?.name ?? '',
          },
        ),
      },
      Date.now(),
    );
    return null;
  }
  let scope: SettingScope;
  // Transform `--scope=<scope>` to `--scope <scope>`.
  if (parts.length === 2) {
    parts.push(...parts[1].split('='));
    parts.splice(1, 1);
  }
  switch (parts[2].toLowerCase()) {
    case 'workspace':
      scope = SettingScope.Workspace;
      break;
    case 'user':
      scope = SettingScope.User;
      break;
    default:
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t(
            'Unsupported scope "{{scope}}", should be one of "user" or "workspace"',
            {
              scope: parts[2],
            },
          ),
        },
        Date.now(),
      );
      return null;
  }
  let names: string[] = [];
  if (name === '--all') {
    let extensions = extensionManager.getLoadedExtensions();
    if (context.invocation?.name === 'enable') {
      extensions = extensions.filter((ext) => !ext.isActive);
    }
    if (context.invocation?.name === 'disable') {
      extensions = extensions.filter((ext) => ext.isActive);
    }
    names = extensions.map((ext) => ext.name);
  } else {
    names = [name];
  }

  return {
    extensionManager,
    names,
    scope,
  };
}

async function disableAction(context: CommandContext, args: string) {
  const enableContext = getEnableDisableContext(context, args);
  if (!enableContext) return;

  const { names, scope, extensionManager } = enableContext;
  for (const name of names) {
    await extensionManager.disableExtension(name, scope);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Extension "{{name}}" disabled for scope "{{scope}}"', {
          name,
          scope,
        }),
      },
      Date.now(),
    );
    context.ui.reloadCommands();
  }
}

async function enableAction(context: CommandContext, args: string) {
  const enableContext = getEnableDisableContext(context, args);
  if (!enableContext) return;

  const { names, scope, extensionManager } = enableContext;
  for (const name of names) {
    await extensionManager.enableExtension(name, scope);
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: t('Extension "{{name}}" enabled for scope "{{scope}}"', {
          name,
          scope,
        }),
      },
      Date.now(),
    );
    context.ui.reloadCommands();
  }
}

async function detailAction(context: CommandContext, args: string) {
  const extensionManager = context.services.config?.getExtensionManager();
  if (!(extensionManager instanceof ExtensionManager)) {
    console.error(
      `Cannot ${context.invocation?.name} extensions in this environment`,
    );
    return;
  }

  const name = args.trim();
  if (!name) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Usage: /extensions detail <extension-name>'),
      },
      Date.now(),
    );
    return;
  }

  const extensions = context.services.config!.getExtensions();
  const extension = extensions.find((extension) => extension.name === name);
  if (!extension) {
    context.ui.addItem(
      {
        type: MessageType.ERROR,
        text: t('Extension "{{name}}" not found.', { name }),
      },
      Date.now(),
    );
    return;
  }
  context.ui.addItem(
    {
      type: MessageType.INFO,
      text: extensionToOutputString(
        extension,
        extensionManager,
        process.cwd(),
        true,
      ),
    },
    Date.now(),
  );
}

export async function completeExtensions(
  context: CommandContext,
  partialArg: string,
) {
  let extensions = context.services.config?.getExtensions() ?? [];

  if (context.invocation?.name === 'enable') {
    extensions = extensions.filter((ext) => !ext.isActive);
  }
  if (
    context.invocation?.name === 'disable' ||
    context.invocation?.name === 'restart'
  ) {
    extensions = extensions.filter((ext) => ext.isActive);
  }
  const extensionNames = extensions.map((ext) => ext.name);
  const suggestions = extensionNames.filter((name) =>
    name.startsWith(partialArg),
  );

  if (
    context.invocation?.name !== 'uninstall' &&
    context.invocation?.name !== 'detail'
  ) {
    if ('--all'.startsWith(partialArg) || 'all'.startsWith(partialArg)) {
      suggestions.unshift('--all');
    }
  }

  return suggestions;
}

export async function completeExtensionsAndScopes(
  context: CommandContext,
  partialArg: string,
) {
  const completions = await completeExtensions(context, partialArg);
  return completions.flatMap((s) => [
    `${s} --scope user`,
    `${s} --scope workspace`,
  ]);
}

export async function completeExtensionsExplore(
  context: CommandContext,
  partialArg: string,
) {
  const suggestions = Object.keys(EXTENSION_EXPLORE_URL).filter((name) =>
    name.startsWith(partialArg),
  );

  return suggestions;
}

const exploreExtensionsCommand: SlashCommand = {
  name: 'explore',
  get description() {
    return t('Open extensions page in your browser');
  },
  kind: CommandKind.BUILT_IN,
  action: exploreAction,
  completion: completeExtensionsExplore,
};

const listExtensionsCommand: SlashCommand = {
  name: 'list',
  get description() {
    return t('List active extensions');
  },
  kind: CommandKind.BUILT_IN,
  action: listAction,
};

const updateExtensionsCommand: SlashCommand = {
  name: 'update',
  get description() {
    return t('Update extensions. Usage: update <extension-names>|--all');
  },
  kind: CommandKind.BUILT_IN,
  action: updateAction,
  completion: completeExtensions,
};

const disableCommand: SlashCommand = {
  name: 'disable',
  get description() {
    return t('Disable an extension');
  },
  kind: CommandKind.BUILT_IN,
  action: disableAction,
  completion: completeExtensionsAndScopes,
};

const enableCommand: SlashCommand = {
  name: 'enable',
  get description() {
    return t('Enable an extension');
  },
  kind: CommandKind.BUILT_IN,
  action: enableAction,
  completion: completeExtensionsAndScopes,
};

const installCommand: SlashCommand = {
  name: 'install',
  get description() {
    return t('Install an extension from a git repo or local path');
  },
  kind: CommandKind.BUILT_IN,
  action: installAction,
};

const uninstallCommand: SlashCommand = {
  name: 'uninstall',
  get description() {
    return t('Uninstall an extension');
  },
  kind: CommandKind.BUILT_IN,
  action: uninstallAction,
  completion: completeExtensions,
};

const detailCommand: SlashCommand = {
  name: 'detail',
  get description() {
    return t('Get detail of an extension');
  },
  kind: CommandKind.BUILT_IN,
  action: detailAction,
  completion: completeExtensions,
};

export const extensionsCommand: SlashCommand = {
  name: 'extensions',
  get description() {
    return t('Manage extensions');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    listExtensionsCommand,
    updateExtensionsCommand,
    disableCommand,
    enableCommand,
    installCommand,
    uninstallCommand,
    exploreExtensionsCommand,
    detailCommand,
  ],
  action: (context, args) =>
    // Default to list if no subcommand is provided
    listExtensionsCommand.action!(context, args),
};
