/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit`: the non-interactive helpers used by the bundled /audit skill
// for auditing existing code (no diff, no PR). The skill orchestrates via
// shell calls to these subcommands; see
// packages/core/src/skills/bundled/audit/SKILL.md.

import type { CommandModule } from 'yargs';
import { parseArgsCommand } from './audit/parse-args.js';
import { planFilesCommand } from './audit/plan-files.js';
import { agentPromptCommand } from './audit/agent-prompt.js';
import { checkAnchorsCommand } from './audit/check-anchors.js';
import { guardCheckCommand } from './audit/guard-check.js';
import { driftCheckCommand, snapshotCommand } from './audit/snapshot.js';

export const auditCommand: CommandModule = {
  command: 'audit',
  describe:
    'Helpers used by the /audit skill (argument parsing, audit planning, brief printing, run-state captures)',
  builder: (yargs) =>
    yargs
      .command(parseArgsCommand)
      .command(planFilesCommand)
      .command(agentPromptCommand)
      .command(snapshotCommand)
      .command(driftCheckCommand)
      .command(guardCheckCommand)
      .command(checkAnchorsCommand)
      .demandCommand(
        1,
        'audit needs a subcommand: parse-args, plan-files, agent-prompt, snapshot, drift-check, guard-check, check-anchors',
      )
      .version(false),
  handler: () => {
    // Dispatch is per-subcommand.
  },
};
