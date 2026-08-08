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
import { readFileSync } from 'node:fs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { checkLocalOnlyGuard, type GuardReport } from './lib/files-plan.js';

/** Exit 5 drives SKILL.md's emergency relocation. A directory already
 *  exposed at plan time already relocated to the fallback root (Step 1) —
 *  its status is permanent, and re-firing the relocation at every
 *  checkpoint is noise. Only a freshly exposed directory trips. */
export function guardTripped(
  current: GuardReport,
  planTime?: GuardReport,
): boolean {
  return current.dirs.some((d) => {
    if (d.status === 'ok' || d.status === 'no-worktree') return false;
    const atPlan = planTime?.dirs.find((p) => p.dir === d.dir);
    return !atPlan || atPlan.status === 'ok' || atPlan.status === 'no-worktree';
  });
}

export const guardCheckCommand: CommandModule = {
  command: 'guard-check',
  describe:
    'Re-probe whether .qwen/audits/ and .qwen/tmp/ are safe from version control; exits 5 when a directory became exposed since plan time',
  builder: (yargs) =>
    yargs
      .option('report-slug', {
        type: 'string',
        demandOption: true,
        describe:
          'The plan artifacts.reportSlug (the representative report file probed)',
      })
      .option('plan', {
        type: 'string',
        describe:
          'Plan JSON written by `qwen audit plan-files`; directories already exposed at plan time (already relocated by Step 1) do not re-fire',
      }),
  handler: (argv) => {
    const { reportSlug, plan } = argv as unknown as {
      reportSlug: string;
      plan?: string;
    };
    const guard = checkLocalOnlyGuard(process.cwd(), `${reportSlug}.md`);
    writeStdoutLine(JSON.stringify(guard, null, 2));
    const planTime = plan
      ? (JSON.parse(readFileSync(plan, 'utf8')) as { guard?: GuardReport })
          .guard
      : undefined;
    if (guardTripped(guard, planTime)) {
      process.exitCode = 5;
    }
  },
};
