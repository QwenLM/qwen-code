/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Command } from '@commander-js/extra-typings';
import { createListCommand } from './list.js';

export function createAgentsCommand(): Command {
  const cmd = new Command('agents')
    .alias('agent')
    .description('Manage agents')
    .option(
      '--setting-sources <sources...>',
      'Comma-separated list of setting sources to filter (user, project, local)',
    );

  cmd.hook('preAction', async () => {
    const { initializeOutputListenersAndFlush } = await import(
      '../../utils/outputListeners.js'
    );
    initializeOutputListenersAndFlush();
  });

  cmd.addCommand(createListCommand());

  // Default handler (no subcommand) calls handleList()
  cmd.action(async (options) => {
    const { handleList } = await import('./list.js');
    const { coerceCommaSeparated } = await import('../../utils/coerce.js');
    const { exitCli } = await import('../../utils/exitCli.js');
    const settingSources = options.settingSources
      ? coerceCommaSeparated(options.settingSources)
      : undefined;
    await handleList({ settingSources });
    await exitCli();
  });

  return cmd;
}
