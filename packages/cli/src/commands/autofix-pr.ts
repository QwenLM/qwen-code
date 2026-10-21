/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Parent command for 'qwen autofix-pr': the deterministic helpers behind the
// /autofix-pr skill, which watches a PR and fixes it in its own worktree.

import type { Argv, CommandModule } from 'yargs';
import { prepareCommand } from './autofix-pr/prepare.js';
import { snapshotCommand } from './autofix-pr/snapshot.js';
import { ciLogCommand } from './autofix-pr/ci-log.js';
import { cleanupCommand } from './autofix-pr/cleanup.js';

export const autofixPrCommand: CommandModule = {
  command: 'autofix-pr',
  describe:
    'Internal helpers used by the /autofix-pr skill (PR worktree setup, change snapshot, CI logs, cleanup)',
  builder: (yargs: Argv) =>
    yargs
      .command(prepareCommand)
      .command(snapshotCommand)
      .command(ciLogCommand)
      .command(cleanupCommand)
      .demandCommand(
        1,
        'Specify a subcommand: prepare, snapshot, ci-log, or cleanup.',
      )
      .version(false),
  handler: () => {
    // yargs handles this via demandCommand(1) above.
  },
};
