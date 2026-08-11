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
import { isAbsolute, relative, resolve } from 'node:path';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { checkLocalOnlyGuard, type GuardReport } from './lib/files-plan.js';
import { readJsonFile } from './lib/read-json.js';

/** Exit 5 drives SKILL.md's emergency relocation. A directory already
 *  exposed at plan time is credited to the Step 1 relocation ONLY when that
 *  relocation is verified — the plan itself landed under the fallback root.
 *  Nothing else records or enforces the relocation (the plan is written at
 *  exit 0 with the raw exposed status, warnings are stderr-only), so an
 *  unverified suppression would let a scripted run that skipped the warning
 *  land committable artifacts with exit 0 at every checkpoint. */
export function guardTripped(
  current: GuardReport,
  planTime?: GuardReport,
  relocationVerified = false,
): boolean {
  return current.dirs.some((d) => {
    if (d.status === 'ok' || d.status === 'no-worktree') return false;
    const atPlan = planTime?.dirs.find((p) => p.dir === d.dir);
    const exposedAtPlan =
      atPlan !== undefined &&
      atPlan.status !== 'ok' &&
      atPlan.status !== 'no-worktree';
    if (!exposedAtPlan) return true;
    return !relocationVerified;
  });
}

function planRelocated(planPath: string, fallbackRoot: string): boolean {
  if (fallbackRoot === '') return false;
  const rel = relative(resolve(fallbackRoot), resolve(planPath));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export const guardCheckCommand: CommandModule = {
  command: 'guard-check',
  describe:
    'Re-probe whether .qwen/audits and .qwen/tmp are safe from version control; exits 5 when a directory became exposed since plan time',
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
          'Plan JSON written by `qwen audit plan-files`; directories already exposed at plan time do not re-fire once the relocation is verified',
      }),
  handler: (argv) => {
    const { reportSlug, plan } = argv as unknown as {
      reportSlug: string;
      plan?: string;
    };
    const guard = checkLocalOnlyGuard(process.cwd(), `${reportSlug}.md`);
    writeStdoutLine(JSON.stringify(guard, null, 2));
    let planTime: GuardReport | undefined;
    let relocated = false;
    if (plan) {
      // Fail closed: a missing/corrupt plan drops the plan-time baseline
      // (re-firing every currently exposed directory) instead of dying
      // with a raw stack — the relocation trigger must not vanish on
      // exactly the fallback landings that move the plan file.
      try {
        const parsed = readJsonFile<{ guard?: GuardReport }>(
          plan,
          'guard-check',
        );
        planTime = parsed.guard;
        relocated = planRelocated(plan, guard.fallbackRoot);
      } catch (err) {
        writeStderrLine(err instanceof Error ? err.message : String(err));
      }
    }
    if (guardTripped(guard, planTime, relocated)) {
      process.exitCode = 5;
    }
  },
};
