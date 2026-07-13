/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Parent command for 'qwen review'. Hosts the internal helpers used by
// the /review skill (presubmit checks, post-review cleanup) so the prompt
// can stay short and the logic stays testable.

import type { Argv, CommandModule } from 'yargs';
import { parseArgsCommand } from './review/parse-args.js';
import { composeReviewCommand } from './review/compose-review.js';
import { fetchPrCommand } from './review/fetch-pr.js';
import { captureLocalCommand } from './review/capture-local.js';
import { planDiffCommand } from './review/plan-diff.js';
import { prContextCommand } from './review/pr-context.js';
import { loadRulesCommand } from './review/load-rules.js';
import { presubmitCommand } from './review/presubmit.js';
import { resolveAnchorsCommand } from './review/resolve-anchors.js';
import { checkCoverageCommand } from './review/check-coverage.js';
import { submitCommand } from './review/submit.js';
import { cleanupCommand } from './review/cleanup.js';

export const reviewCommand: CommandModule = {
  command: 'review',
  describe:
    'Internal helpers used by the /review skill (PR worktree setup, context fetch, rules loading, presubmit checks, cleanup)',
  builder: (yargs: Argv) =>
    yargs
      .command(parseArgsCommand)
      .command(fetchPrCommand)
      .command(captureLocalCommand)
      .command(planDiffCommand)
      .command(prContextCommand)
      .command(loadRulesCommand)
      .command(resolveAnchorsCommand)
      .command(checkCoverageCommand)
      .command(presubmitCommand)
      .command(composeReviewCommand)
      .command(submitCommand)
      .command(cleanupCommand)
      .demandCommand(
        1,
        'Specify a subcommand: parse-args, fetch-pr, capture-local, plan-diff, pr-context, load-rules, resolve-anchors, check-coverage, presubmit, compose-review, submit, or cleanup.',
      )
      .version(false),
  handler: () => {
    // yargs handles this via demandCommand(1) above.
  },
};
