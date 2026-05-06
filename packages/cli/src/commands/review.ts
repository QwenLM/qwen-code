/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Parent command for 'qwen review'. Hosts the deterministic helpers used by
// the /review skill (presubmit checks, post-review cleanup) so the prompt
// can stay short and the logic stays testable.

import type { Argv, CommandModule } from 'yargs';
import { fetchPrCommand } from './review/fetch-pr.js';
import { prContextCommand } from './review/pr-context.js';
import { loadRulesCommand } from './review/load-rules.js';
import { deterministicCommand } from './review/deterministic.js';
import { presubmitCommand } from './review/presubmit.js';
import { cleanupCommand } from './review/cleanup.js';

export const reviewCommand: CommandModule = {
  command: 'review',
  describe:
    'Internal helpers used by the /review skill (PR worktree setup, context fetch, rules loading, deterministic analysis, presubmit checks, cleanup)',
  builder: (yargs: Argv) =>
    yargs
      .command(fetchPrCommand)
      .command(prContextCommand)
      .command(loadRulesCommand)
      .command(deterministicCommand)
      .command(presubmitCommand)
      .command(cleanupCommand)
      .demandCommand(
        1,
        'Specify a subcommand: fetch-pr, pr-context, load-rules, deterministic, presubmit, or cleanup.',
      )
      .version(false),
  handler: () => {
    // yargs handles this via demandCommand(1) above.
  },
};
