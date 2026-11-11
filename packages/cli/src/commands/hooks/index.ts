/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { createMigrateCommand } from './migrate.js';

export function createHooksCommand(): Command {
  const cmd = new Command('hooks')
    .alias('hook')
    .description('Manage hooks');

  cmd.hook('preAction', async () => {
    const { initializeOutputListenersAndFlush } = await import(
      '../../utils/outputListeners.js'
    );
    initializeOutputListenersAndFlush();
  });

  // migrate is NOT deferred in the original
  cmd.addCommand(createMigrateCommand());

  cmd.action(async () => {
    const { exitCli } = await import('../../utils/exitCli.js');
    cmd.outputHelp();
    await exitCli(0);
  });

  return cmd;
}
