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
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isGitIgnored } from '@qwen-code/qwen-code-core';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { safeTarget } from '../../utils/paths.js';
import {
  auditTimestamp,
  checkLocalOnlyGuard,
  gitGeometry,
  type GuardReport,
} from './lib/files-plan.js';
import { readJsonFile } from './lib/read-json.js';

/** Exit 5 drives SKILL.md's emergency relocation. A directory already
 *  exposed at plan time is credited to the Step 1 relocation ONLY when that
 *  relocation is verified — the plan itself landed under a fallback root
 *  that is itself safe. Nothing else records or enforces the relocation
 *  (the plan is written at exit 0 with the raw exposed status, warnings
 *  are stderr-only), so an unverified suppression would let a scripted run
 *  that skipped the warning land committable artifacts with exit 0 at
 *  every checkpoint. */
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

/** Credit the relocation only once the fallback landing itself is
 *  verified: QWEN_HOME is user-settable and can place the fallback root
 *  inside a worktree that has no ignore rule for it. Outside every
 *  worktree git can never commit the landing; inside one every durable
 *  artifact shape written there must be ignored — the dated report and
 *  the sidecar (the undated bare slug is never written), and one exposed
 *  shape is an exposed directory. A probe without an answer keeps
 *  relocated=false so exit 5 re-fires. */
function fallbackLandingSafe(
  fallbackRoot: string,
  reportFileName: string,
): boolean {
  const geometry = gitGeometry(fallbackRoot);
  if (geometry.probeFailed) return false;
  if (!geometry.inWorktree || geometry.root === undefined) return true;
  const prefix = relative(geometry.root, fallbackRoot).split(sep).join('/');
  const ts = auditTimestamp(new Date());
  const root = geometry.root;
  return [`${ts}-${reportFileName}`, `audit-${ts}.sidecar`].every((shape) =>
    isGitIgnored(root, prefix === '' ? shape : `${prefix}/${shape}`),
  );
}

/** The safeTarget output space: one filename component, no traversal. */
function isSafeReportSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) &&
    !slug.includes('..')
  );
}

function isGuardReport(value: unknown): value is GuardReport {
  if (typeof value !== 'object' || value === null) return false;
  const g = value as Record<string, unknown>;
  if (typeof g['fallbackRoot'] !== 'string') return false;
  return (
    Array.isArray(g['dirs']) &&
    g['dirs'].every(
      (d) =>
        typeof d === 'object' &&
        d !== null &&
        typeof (d as Record<string, unknown>)['dir'] === 'string' &&
        typeof (d as Record<string, unknown>)['status'] === 'string',
    )
  );
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
    let planTime: GuardReport | undefined;
    let planReportSlug: string | undefined;
    // Fail closed: a missing/corrupt plan drops the plan-time baseline
    // (re-firing every currently exposed directory) instead of dying
    // with a raw stack — the relocation trigger must not vanish on
    // exactly the fallback landings that move the plan file.
    if (plan) {
      try {
        const parsed = readJsonFile<{
          guard?: unknown;
          artifacts?: { reportSlug?: unknown };
        }>(plan, 'guard-check');
        // Shape-validate before use: a valid-JSON wrong-shape guard
        // section must degrade to a missing baseline (which fails
        // closed), not crash guardTripped with a raw TypeError — exit 1
        // would bypass the exit-5 relocation path.
        if (isGuardReport(parsed.guard)) {
          planTime = parsed.guard;
        }
        if (
          typeof parsed.artifacts?.reportSlug === 'string' &&
          parsed.artifacts.reportSlug !== ''
        ) {
          planReportSlug = parsed.artifacts.reportSlug;
        }
      } catch (err) {
        writeStderrLine(err instanceof Error ? err.message : String(err));
      }
    }
    // The plan's own artifacts.reportSlug is the authoritative probed
    // name: the argv slug is agent-transcribed, and a name-selective
    // re-include keyed on the real slug would stay invisible to a
    // misnamed probe.
    const effectiveSlug = planReportSlug ?? reportSlug;
    // The slug is interpolated into probe paths: only the safeTarget
    // output space may build one (a traversal shape would re-home the
    // probe to a path with foreign ignore rules). A violation probes the
    // flattened shape and drops the relocation credit so exit 5 re-fires.
    const slugSafe = isSafeReportSlug(effectiveSlug);
    const reportFileName = `${
      slugSafe ? effectiveSlug : safeTarget(effectiveSlug)
    }.md`;
    const guard = checkLocalOnlyGuard(process.cwd(), reportFileName);
    writeStdoutLine(JSON.stringify(guard, null, 2));
    const relocated =
      plan !== undefined &&
      slugSafe &&
      planRelocated(plan, guard.fallbackRoot) &&
      fallbackLandingSafe(guard.fallbackRoot, reportFileName);
    if (guardTripped(guard, planTime, relocated)) {
      process.exitCode = 5;
    }
  },
};
