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
import { fixEndCommand, fixStartCommand } from './autofix-pr/fix.js';
import { pushCommand } from './autofix-pr/push.js';
import { replyCommand } from './autofix-pr/reply.js';
import { rerunCommand } from './autofix-pr/rerun.js';
import { scheduleCommand } from './autofix-pr/schedule.js';
import { statusCommand } from './autofix-pr/status.js';
import { syncCommand } from './autofix-pr/sync.js';
import { withRefusals } from './autofix-pr/refusal.js';

export const autofixPrCommand: CommandModule = {
  command: 'autofix-pr',
  describe:
    'Internal helpers used by the /autofix-pr skill (PR worktree setup, change snapshot and its gate probe, CI logs, guarded push, replies, re-runs, the scheduled task, background fixes, status, cleanup)',
  builder: (yargs: Argv) =>
    yargs
      .command(withRefusals(prepareCommand))
      .command(withRefusals(snapshotCommand))
      .command(withRefusals(ciLogCommand))
      .command(withRefusals(pushCommand))
      .command(withRefusals(syncCommand))
      .command(withRefusals(replyCommand))
      .command(withRefusals(rerunCommand))
      .command(withRefusals(scheduleCommand))
      .command(withRefusals(fixStartCommand))
      .command(withRefusals(fixEndCommand))
      .command(withRefusals(statusCommand))
      .command(withRefusals(cleanupCommand))
      .demandCommand(
        1,
        'Specify a subcommand: prepare, snapshot, ci-log, push, sync, reply, rerun, schedule, fix-start, fix-end, status, or cleanup.',
      )
      .version(false),
  handler: () => {
    // yargs handles this via demandCommand(1) above.
  },
};
