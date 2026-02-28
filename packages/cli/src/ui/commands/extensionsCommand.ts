/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from '../../utils/errors.js';
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
  createDebugLogger,
} from '@qwen-code/qwen-code-core';
import open from 'open';

const debugLogger = createDebugLogger('EXTENSIONS_COMMAND');
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

async function listAction(context: CommandContext, _args: string) {
  const extensions = context.services.config
    ? context.services.config.getExtensions()
    : [];

  if (showMessageIfNoExtensions(context, extensions)) {
    return;
  }

  return {
    type: 'dialog' as const,
    dialog: 'extensions_manage' as const,
  };
}

async function installAction(context: CommandContext, args: string) {
  const extensionManager = context.services.config?.getExtensionManager();
  if (!(extensionManager instanceof ExtensionManager)) {
    debugLogger.error(
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

const manageExtensionsCommand: SlashCommand = {
  name: 'manage',
  get description() {
    return t('Manage installed extensions');
  },
  kind: CommandKind.BUILT_IN,
  action: listAction,
};

const installCommand: SlashCommand = {
  name: 'install',
  get description() {
    return t('Install an extension from a git repo or local path');
  },
  kind: CommandKind.BUILT_IN,
  action: installAction,
};

export const extensionsCommand: SlashCommand = {
  name: 'extensions',
  get description() {
    return t('Manage extensions');
  },
  kind: CommandKind.BUILT_IN,
  subCommands: [
    manageExtensionsCommand,
    installCommand,
    exploreExtensionsCommand,
  ],
  action: async (context, args) =>
    // Default to list if no subcommand is provided
    manageExtensionsCommand.action!(context, args),
};
