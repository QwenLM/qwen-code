/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { redactUrlCredentials } from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

export async function handleSourcesAdd(args: { source: string }) {
  try {
    const extensionManager = await getExtensionManager();
    const entry = await extensionManager.addSource(args.source);
    writeStdoutLine(t('Added marketplace "{{name}}".', { name: entry.name }));
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export async function handleSourcesRemove(args: { name: string }) {
  try {
    const extensionManager = await getExtensionManager();
    if (!extensionManager.removeSource(args.name)) {
      writeStderrLine(
        t('Marketplace "{{name}}" not found.', { name: args.name }),
      );
      process.exit(1);
      return;
    }
    writeStdoutLine(t('Removed marketplace "{{name}}".', { name: args.name }));
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export async function handleSourcesList() {
  try {
    const extensionManager = await getExtensionManager();
    const sources = extensionManager.getSources();
    if (sources.length === 0) {
      writeStdoutLine(t('No marketplace sources added yet.'));
      return;
    }
    writeStdoutLine(
      sources
        .map((entry) => {
          let output = `${entry.name}`;
          output += `\n ${t('Source:')} ${redactUrlCredentials(entry.source)} (${t('Type:')} ${entry.type}${entry.format ? `, ${t('Format:')} ${entry.format}` : ''})`;
          const updated = entry.lastUpdatedAt ?? entry.addedAt;
          if (updated) {
            output += `\n ${t('Last updated: {{date}}', { date: updated })}`;
          }
          return output;
        })
        .join('\n\n'),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export async function handleSourcesUpdate(args: { name: string }) {
  try {
    const extensionManager = await getExtensionManager();
    const entry = extensionManager
      .getSources()
      .find((source) => source.name === args.name);
    if (!entry) {
      writeStderrLine(
        t('Marketplace "{{name}}" not found.', { name: args.name }),
      );
      process.exit(1);
      return;
    }
    const config = await extensionManager.loadSource(entry.source);
    if (!config) {
      writeStderrLine(t('Could not load this marketplace.'));
      process.exit(1);
      return;
    }
    extensionManager.markSourceUpdated(entry.name);
    writeStdoutLine(t('Updated marketplace "{{name}}".', { name: entry.name }));
    writeStdoutLine(
      t('{{count}} available extensions', {
        count: String(config.entries.length),
      }),
    );
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

const addCommand: CommandModule = {
  command: 'add <source>',
  describe: t('Adds a marketplace source (Qwen or Claude format).'),
  builder: (yargs) =>
    yargs.positional('source', {
      describe: t(
        'The marketplace source to add: owner/repo (GitHub), a git or https URL, or a local path.',
      ),
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    await handleSourcesAdd({ source: argv['source'] as string });
  },
};

const removeCommand: CommandModule = {
  command: 'remove <name>',
  describe: t('Removes a marketplace source.'),
  builder: (yargs) =>
    yargs.positional('name', {
      describe: t('The name of the marketplace to remove.'),
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    await handleSourcesRemove({ name: argv['name'] as string });
  },
};

const listCommand: CommandModule = {
  command: 'list',
  describe: t('Lists configured marketplace sources.'),
  builder: (yargs) => yargs,
  handler: async () => {
    await handleSourcesList();
  },
};

const updateCommand: CommandModule = {
  command: 'update <name>',
  describe: t('Re-fetches a marketplace source and its plugin listing.'),
  builder: (yargs) =>
    yargs.positional('name', {
      describe: t('The name of the marketplace to update.'),
      type: 'string',
      demandOption: true,
    }),
  handler: async (argv) => {
    await handleSourcesUpdate({ name: argv['name'] as string });
  },
};

export const sourcesCommand: CommandModule = {
  command: 'sources <command>',
  describe: t('Manage marketplace sources for discovering extensions.'),
  builder: (yargs) =>
    yargs
      .command(addCommand)
      .command(removeCommand)
      .command(listCommand)
      .command(updateCommand)
      .demandCommand(1, t('You need at least one command before continuing.'))
      .version(false),
  handler: () => {
    // Yargs shows the help menu when no subcommand is provided.
  },
};
