/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit guard-check`: re-run the local-only guard probes (.qwen/audits
// and .qwen/tmp must never land in version control). Runs at plan time via
// plan-files, and re-runs at the drift checkpoints and at write time — the
// ignore state can move during a hours-long run. Fresh answers by
// construction: the shared helper carries no memo.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { checkLocalOnlyGuard } from './lib/files-plan.js';

export const guardCheckCommand: CommandModule = {
  command: 'guard-check',
  describe:
    'Re-probe whether .qwen/audits/ and .qwen/tmp/ are safe from version control; exits 5 when either is exposed',
  builder: (yargs) =>
    yargs.option('report-slug', {
      type: 'string',
      demandOption: true,
      describe:
        'The plan artifacts.reportSlug (the representative report file probed)',
    }),
  handler: (argv) => {
    const { reportSlug } = argv as unknown as { reportSlug: string };
    const guard = checkLocalOnlyGuard(process.cwd(), `${reportSlug}.md`);
    writeStdoutLine(JSON.stringify(guard, null, 2));
    if (
      guard.dirs.some((d) => d.status !== 'ok' && d.status !== 'no-worktree')
    ) {
      process.exitCode = 5;
    }
  },
};
