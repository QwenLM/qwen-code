/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { getExtensionManager } from './utils.js';
import { t } from '../../i18n/index.js';

interface PruneArgs {
  dryRun?: boolean;
  keepMissingWorkspaces?: boolean;
}

export async function handlePrune(args: PruneArgs = {}) {
  try {
    const extensionManager = await getExtensionManager();
    const result = await extensionManager.pruneUnusedVersions({
      dryRun: args.dryRun === true,
      removeMissingWorkspaces: args.keepMissingWorkspaces !== true,
    });
    if (result.pruned.length === 0 && result.removedWorkspaceRefs === 0) {
      writeStdoutLine(t('No unused extension versions to prune.'));
      return;
    }
    const verb = args.dryRun ? 'Would prune' : 'Pruned';
    if (result.removedWorkspaceRefs > 0) {
      writeStdoutLine(
        `${verb} ${result.removedWorkspaceRefs} stale workspace reference(s).`,
      );
    }
    for (const item of result.pruned) {
      writeStdoutLine(
        `${verb} ${item.name} (${item.versionSlot}) at ${item.directory}`,
      );
    }
  } catch (error) {
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const pruneCommand: CommandModule = {
  command: 'prune',
  describe: t(
    'Removes unreferenced versioned extensions and stale workspace references.',
  ),
  builder: (yargs) =>
    yargs
      .option('dry-run', {
        describe: t(
          'Show what would be pruned without modifying disk or store state.',
        ),
        type: 'boolean',
        default: false,
      })
      .option('keep-missing-workspaces', {
        describe: t(
          'Keep workspace overrides whose directories no longer exist on disk.',
        ),
        type: 'boolean',
        default: false,
      }),
  handler: async (argv) => {
    await handlePrune({
      dryRun: argv['dryRun'] as boolean | undefined,
      keepMissingWorkspaces: argv['keepMissingWorkspaces'] as
        | boolean
        | undefined,
    });
  },
};
