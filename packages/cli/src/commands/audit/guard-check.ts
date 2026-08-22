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
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { isGitIgnored } from '@qwen-code/qwen-code-core';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';
import { safeTarget } from '../../utils/paths.js';
import {
  AUDIT_TMP_DIR,
  auditTimestamp,
  checkLocalOnlyGuard,
  gitGeometry,
  guardProbeShapes,
  nextCalendarDate,
  REPORT_SLUG_MAX_CHARS,
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

function planRelocated(
  planPath: string,
  fallbackRoot: string,
  planTs: string,
): boolean {
  if (fallbackRoot === '') return false;
  // The handed plan must BE the relocated file: a symlink leaves its
  // target where it was committable, so only a regular file counts, and
  // both sides resolve before the containment test (a lexical compare
  // credited plans reached through a link).
  let realPlan: string;
  let realRoot: string;
  try {
    const planStat = lstatSync(planPath);
    // A hardlink twin is a committable copy the containment checks below
    // can never see: nlink > 1 proves a twin exists somewhere by
    // definition, so the relocation stays uncredited and exit 5 re-fires.
    if (!planStat.isFile() || planStat.nlink > 1) return false;
    realPlan = realpathSync(planPath);
    realRoot = realpathSync(fallbackRoot);
  } catch {
    return false;
  }
  const rel = relative(realRoot, realPlan);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return false;
  // A copy credits while the original stays stageable under .qwen/tmp (a
  // killed mid-relocation leaves exactly that): the original must be gone
  // from its pre-relocation home for the suppression to stand.
  //
  // Keyed on the WRITER-PINNED name, never on the basename of the path the
  // agent handed us: `--plan <fallback>/anything.json` makes the in-repo
  // lookup ask about `.qwen/tmp/anything.json`, which of course does not
  // exist, and the real `audit-plan-<ts>.json` keeps sitting there
  // committable while the guard reports the relocation complete.
  return !existsSync(
    join(process.cwd(), AUDIT_TMP_DIR, `audit-plan-${planTs}.json`),
  );
}

/** Credit the relocation only once the fallback landing itself is
 *  verified: QWEN_HOME is user-settable and can place the fallback root
 *  inside a worktree that has no ignore rule for it. Outside every
 *  worktree git can never commit the landing; inside one EVERY artifact
 *  shape the relocation lands there must be ignored — the dated report,
 *  the sidecar, and the whole tmp class (the relocation moves them all),
 *  and one exposed shape is an exposed directory. A probe without an
 *  answer keeps relocated=false so exit 5 re-fires. */
function fallbackLandingSafe(
  fallbackRoot: string,
  reportFileName: string,
  planTs?: string,
): boolean {
  const geometry = gitGeometry(fallbackRoot);
  if (geometry.probeFailed) return false;
  if (!geometry.inWorktree || geometry.root === undefined) return true;
  // Both sides symlink-resolved before differencing: geometry.root is
  // git's resolved toplevel while the fallback root arrives un-resolved,
  // and an unresolved pair under a symlinked checkout emits a ../../
  // prefix that probes paths outside the worktree (exit 5 at every
  // checkpoint forever). Resolution failure fails closed like probeFailed.
  let prefix: string;
  try {
    prefix = relative(realpathSync(geometry.root), realpathSync(fallbackRoot))
      .split(sep)
      .join('/');
  } catch {
    return false;
  }
  if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) {
    // Outside this worktree the repo can never commit the landing.
    return true;
  }
  // Probes carry the check-time timestamp AND, when known, the plan-time
  // one: the relocated files keep the plan ts, and a post-midnight
  // checkpoint's fresh-ts probes would ask about names never written.
  const shapes = guardProbeShapes(reportFileName, auditTimestamp(new Date()));
  // Mirror checkLocalOnlyGuard's next-date probe: the relocated report is
  // written at write time, so its date can roll past the checkpoint
  // instant — a post-midnight landing must be asked about too.
  const nextDate = nextCalendarDate(new Date());
  shapes.audits.push(`${nextDate}-000000-${reportFileName}`);
  if (planTs) {
    const relocated = guardProbeShapes(reportFileName, planTs);
    shapes.audits.push(...relocated.audits);
    shapes.tmp.push(...relocated.tmp);
  }
  const root = geometry.root;
  return [...shapes.audits, ...shapes.tmp].every((shape) =>
    isGitIgnored(root, prefix === '' ? shape : `${prefix}/${shape}`),
  );
}

/** The writer's own output space, read back: one filename component, no
 *  traversal, bounded by the same constant auditReportSlug caps at. The two
 *  must stay one rule — a validator narrower than the writer denies
 *  relocation credit to names the writer itself produced. */
function isSafeReportSlug(slug: string): boolean {
  return (
    slug.length > 0 &&
    slug.length <= REPORT_SLUG_MAX_CHARS &&
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

/** The plan filename SKILL.md pins: audit-plan-<ts>.json. The captured
 *  group is the auditTimestamp shape, digits and dashes only — safe to
 *  interpolate into probe paths. */
const PLAN_TS_RE = /^audit-plan-(\d{4}-\d{2}-\d{2}-\d{6})\.json$/;

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
    // The artifacts keep the plan-time timestamp; recover it from the
    // SKILL-pinned plan filename so BOTH the primary probes and the
    // landing probes ask about the names actually on disk.
    const planTs =
      plan === undefined ? undefined : PLAN_TS_RE.exec(basename(plan))?.[1];
    const guard = checkLocalOnlyGuard(process.cwd(), reportFileName, planTs);
    writeStdoutLine(JSON.stringify(guard, null, 2));
    // No plan-ts, no credit: the timestamp is what names the artifacts on
    // disk, so without it neither the "the original is gone" proof nor the
    // landing probes can ask about the files this run actually wrote. A
    // plan handed under any other name is not the plan SKILL.md wrote.
    const relocated =
      plan !== undefined &&
      planTs !== undefined &&
      slugSafe &&
      planRelocated(plan, guard.fallbackRoot, planTs) &&
      fallbackLandingSafe(guard.fallbackRoot, reportFileName, planTs);
    if (guardTripped(guard, planTime, relocated)) {
      process.exitCode = 5;
    }
  },
};
