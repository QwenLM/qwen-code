/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  toNamespacedPath,
} from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { CommandModule } from 'yargs';
import type { ComposeReviewResult, ReviewEvent } from './compose-review.js';
import {
  buildReport,
  type FindingsReport,
  validateFindings,
} from './findings.js';
import { EFFORT_LEVELS, type ReviewEffort } from './parse-args.js';
import { REVIEWS_DIR } from './lib/paths.js';
import { isSameFile } from './lib/same-file.js';
import { volumeOf } from './lib/ledger.js';
import {
  LAND_WITH_RESIDUAL_RISK,
  RECOMMENDATION_CODES,
  type ConvergenceAssessment,
  type Recommendation,
} from './lib/convergence.js';
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

interface PersistedVerdict
  extends Omit<
    ComposeReviewResult,
    'postedInline' | 'postedFresh' | 'prevPostedInline'
  > {
  verdictLine: string;
  /**
   * Optional HERE, required on the composed result it is otherwise a copy
   * of: a live compose always knows how many comments the round posts, but
   * an artifact read back from disk may have been written before the field
   * existed. Absence is preserved rather than defaulted — see the validator.
   *
   * `prevPostedInline` is omitted from this type entirely rather than
   * inherited: the validator neither reads nor writes it, so carrying it
   * here would advertise a field no artifact contains and license a
   * consumer into an always-undefined branch. The two-round window stays
   * recoverable from the marker chain inside `body`.
   *
   * `residualRisk` is NOT omitted, and for the reason its sibling
   * `convergence` is not: the artifact is where a trimmed round's record
   * lives. Not the same rank, though — `convergence` is rank 0 and sheds
   * before everything, while this one is rank 2 and yields after the fold
   * and the deferral display. What they share is that both CAN go, and the
   * body is then not a copy of either. "The advisory rides the persisted body" is true of every round
   * except the ones that most need the durable copy — a maintainer reading
   * `.qwen/reviews` to make the `land-with-residual-risk` call would find a
   * "did not fit" breadcrumb and no facts. The validator carries and
   * shape-checks it below, so the type advertises nothing the artifact does
   * not hold.
   */
  postedInline?: number;
  /**
   * Optional for the same reason as its sibling, and for one more: an
   * artifact written before the convergence trend measured NEW findings
   * carries only the total. Absence is preserved rather than defaulted —
   * a round that recorded no fresh count is not a round that produced none.
   */
  postedFresh?: number;
}

export interface ReviewArtifactV1 {
  schemaVersion: 1;
  target: string;
  effort: ReviewEffort;
  verdict: PersistedVerdict;
  findings: FindingsReport['findings'];
  counts: FindingsReport['counts'];
  outcomesRecorded: boolean;
  markdownReportPath: string;
}

export interface SavedReviewArtifact {
  /** Absolute path of the written document. */
  path: string;
  /**
   * The same path relative to the workspace root. `record_artifact` now
   * accepts the absolute `path` and stores this canonical form itself;
   * keep emitting it so older runtimes and display surfaces can still
   * use the root-relative locator.
   */
  workspacePath: string;
}

interface SaveArtifactArgs {
  findings: string;
  composed: string;
  report: string;
  target: string;
  effort: ReviewEffort;
  out: string;
  workspaceRoot?: string;
}

// Every path resolves against the main checkout, because the durable output
// and `markdownReportPath` must stay relative to the main project for Web
// Shell's `readWorkspaceFile` to find them. That root arrives as
// `--workspace-root`: the skill passes the main project directory explicitly
// on every run (SKILL.md Step 8), because the root anchors the containment
// checks — `isWithin` and the symlink walk below — and an ambient cwd is only
// as trustworthy as wherever the command happened to run. Cwd is the fallback
// when the flag is absent, right whenever the caller runs from the main
// checkout — in PR worktree mode the worktree-resident inputs arrive as
// absolute paths that still sit under the main project's `.qwen/tmp/`.
//
// This used to prefer `QWEN_CODE_PROJECT_DIR`, believing it named that
// checkout. It never does: the harness exports it as the session-storage
// directory under the runtime base (`Storage.getProjectDir()` — where the
// harness's transcripts live), in every environment. Every measured CI review
// resolved its containment root there, refused its own inputs, and burned
// minutes working around it (DESIGN.md — The artifact root that pointed at
// qwen-home). An ambient variable that is wrong 100% of the time it is
// consulted is not a fallback; it is a trap, so it is not consulted at all.
function workspaceRoot(explicit?: string): string {
  return resolve(explicit ?? process.cwd());
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
  );
}

function workspacePath(root: string, value: string, label: string): string {
  const absolute = resolve(root, value);
  if (!isWithin(root, absolute)) {
    throw new Error(
      `${label} must be inside the workspace: ${JSON.stringify(value)}.`,
    );
  }
  return absolute;
}

function rejectSymlinkPath(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} must not traverse a symbolic link.`);
    }
  }
}

function readText(path: string, label: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read the ${label} file at ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readJson(path: string, label: string): unknown {
  const text = readText(path, label);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `The ${label} file at ${JSON.stringify(path)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const text = string(value, label);
  if (text.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return text;
}

function stringArray(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(`${label} must be an array of strings.`);
  }
  return value as string[];
}

function event(value: unknown, label: string): ReviewEvent {
  if (
    value !== 'APPROVE' &&
    value !== 'COMMENT' &&
    value !== 'REQUEST_CHANGES'
  ) {
    throw new Error(`${label} has an unsupported value.`);
  }
  return value;
}

/**
 * A recommendation code, checked against the closed set rather than cast
 * into it. The set is a contract a caller wires actions to, and a cast
 * writes whatever string it was handed into the durable record under a type
 * that says otherwise — the shape every sibling closed vocabulary in this
 * validator refuses.
 */
function recommendationCode(
  value: unknown,
  label: string,
): Recommendation['code'] {
  const code = string(value, label);
  if (!(RECOMMENDATION_CODES as readonly string[]).includes(code)) {
    throw new Error(`${label} must be one of the known recommendation codes.`);
  }
  return code as Recommendation['code'];
}

function validateVerdict(value: unknown): PersistedVerdict {
  const verdict = object(value, 'Composed verdict');
  const downgradedFrom = verdict['downgradedFrom'];
  if (
    downgradedFrom !== null &&
    downgradedFrom !== 'Approve' &&
    downgradedFrom !== 'Request changes'
  ) {
    throw new Error(
      'Composed verdict.downgradedFrom has an unsupported value.',
    );
  }
  if (typeof verdict['downgraded'] !== 'boolean') {
    throw new Error('Composed verdict.downgraded must be a boolean.');
  }
  const lowSignal = verdict['lowSignal'];
  if (lowSignal !== null) {
    const signal = object(lowSignal, 'Composed verdict.lowSignal');
    for (const key of ['agents', 'srcDiffLines'] as const) {
      if (
        typeof signal[key] !== 'number' ||
        !Number.isInteger(signal[key]) ||
        signal[key] < 0
      ) {
        throw new Error(
          `Composed verdict.lowSignal.${key} must be a non-negative integer.`,
        );
      }
    }
  }
  // Absent or null means zero, not malformed — the same absence semantics
  // compose-review's own `toCount` boundary applies to this field's siblings:
  // a composed JSON written by a build predating the convergence posture
  // carries no deferredCount, and a mid-upgrade save must not fail over a
  // count that only affects display. A PRESENT value of any other wrong
  // shape is refused like every other field here.
  // Same absence semantics as `deferredCount` below: a composed JSON written
  // by a build predating the approach signal carries no field at all, and a
  // mid-upgrade load must not fail over one that only affects display. A
  // PRESENT value of the wrong shape is refused like every other field here.
  const approachRaw = verdict['approachSignal'] ?? null;
  if (approachRaw !== null) {
    const signal = object(approachRaw, 'Composed verdict.approachSignal');
    for (const key of ['round', 'src0', 'srcDiffLines'] as const) {
      if (
        typeof signal[key] !== 'number' ||
        !Number.isInteger(signal[key]) ||
        (signal[key] as number) <= 0
      ) {
        throw new Error(
          `Composed verdict.approachSignal.${key} must be a positive integer.`,
        );
      }
    }
    if (typeof signal['growth'] !== 'number' || !(signal['growth'] >= 0)) {
      throw new Error(
        'Composed verdict.approachSignal.growth must be a non-negative number.',
      );
    }
    if (typeof signal['nonConverged'] !== 'boolean') {
      throw new Error(
        'Composed verdict.approachSignal.nonConverged must be a boolean.',
      );
    }
  }
  const deferredCount = verdict['deferredCount'] ?? 0;
  if (
    typeof deferredCount !== 'number' ||
    !Number.isInteger(deferredCount) ||
    deferredCount < 0
  ) {
    throw new Error(
      'Composed verdict.deferredCount must be a non-negative integer.',
    );
  }
  // Same absence semantics as deferredCount, and for the same reason: a
  // composed JSON persisted before floor enforcement existed carries no
  // `floorEnforced`, and it names indices this artifact only re-displays.
  const floorEnforced = verdict['floorEnforced'] ?? [];
  if (
    !Array.isArray(floorEnforced) ||
    floorEnforced.some(
      (i) => typeof i !== 'number' || !Number.isInteger(i) || i < 0,
    )
  ) {
    throw new Error(
      'Composed verdict.floorEnforced must be an array of non-negative integers.',
    );
  }
  // Absence is PRESERVED here, not defaulted — the one place this field
  // parts company with its siblings. `deferredCount: 0`, `floorEnforced: []`
  // and an untrimmed `bodyTrim` are all TRUE statements about a round that
  // predates those features: it deferred nothing, enforced nothing, trimmed
  // nothing. But a pre-telemetry round DID post comments, so writing zero
  // would assert a count nobody observed — and a converged round that really
  // posted none becomes indistinguishable from it. That is the same
  // zero-versus-absent conflation this field refuses at every other boundary
  // (the parser, the side-file recovery, the carried `prevPosted`), and
  // `lowSignal` in this very function already persists `null` rather than
  // inventing a default. A PRESENT value of the wrong shape is still refused
  // like every other field.
  const rawPosted = verdict['postedInline'];
  const postedAbsent = rawPosted === undefined || rawPosted === null;
  const postedInline = postedAbsent ? undefined : volumeOf(rawPosted);
  if (!postedAbsent && postedInline === undefined) {
    throw new Error(
      'Composed verdict.postedInline must be a non-negative integer.',
    );
  }
  // The convergence paragraph is a clause the overflow ladder can shed —
  // its last rank, so a body that shed it shed every other rank too — and
  // the artifact is where a trimmed round's record lives. Dropped by this
  // allow-list, the durable record of a round whose body shed it held
  // neither copy.
  const rawConvergence = verdict['convergence'];
  let convergence: { en: string; zh: string } | undefined;
  if (rawConvergence !== undefined && rawConvergence !== null) {
    const c = object(rawConvergence, 'Composed verdict.convergence');
    convergence = {
      en: string(c['en'], 'Composed verdict.convergence.en'),
      zh: string(c['zh'], 'Composed verdict.convergence.zh'),
    };
  }
  // The machine-readable half of the observation. Dropped by this
  // allow-list, a caller reading the durable record sees the prose and not
  // the codes it would key on.
  const rawRecs = verdict['recommendations'];
  let recommendations: Recommendation[] | undefined;
  if (rawRecs !== undefined && rawRecs !== null) {
    if (!Array.isArray(rawRecs)) {
      throw new Error('Composed verdict.recommendations must be an array.');
    }
    recommendations = rawRecs.map((entry, i) => {
      const r = object(entry, `Composed verdict.recommendations[${i}]`);
      return {
        code: recommendationCode(
          r['code'],
          `Composed verdict.recommendations[${i}].code`,
        ),
        basis: string(
          r['basis'],
          `Composed verdict.recommendations[${i}].basis`,
        ),
      };
    });
  }
  // Same reasoning as the paragraph above, and more so: this block is the
  // FIRST thing the ladder sheds.
  const rawHealth = verdict['health'];
  let health: { en: string; zh: string } | undefined;
  if (rawHealth !== undefined && rawHealth !== null) {
    const h = object(rawHealth, 'Composed verdict.health');
    health = {
      en: string(h['en'], 'Composed verdict.health.en'),
      zh: string(h['zh'], 'Composed verdict.health.zh'),
    };
  }
  // The residual-risk advisory, carried for the same reason its sibling
  // paragraph above is: rank 2 sheds before the not-reviewed disclosures, so
  // the rounds that fire it are exactly the long, deep-work-list rounds whose
  // body is most likely to drop it — and the durable record is then the only
  // place the facts survive. Shape-checked rather than passed through: the
  // composed JSON is a file on disk between two processes, and a consumer
  // reading `criticals` off a hand-edited artifact must not read a string.
  // The recommendation is pinned to the ONE code this module issues; a
  // future second recommendation widens this check deliberately rather than
  // arriving unannounced in a durable record.
  const rawResidualRisk = verdict['residualRisk'];
  let residualRisk: ConvergenceAssessment | undefined;
  if (rawResidualRisk !== undefined && rawResidualRisk !== null) {
    const r = object(rawResidualRisk, 'Composed verdict.residualRisk');
    const shape = string(r['shape'], 'Composed verdict.residualRisk.shape');
    if (shape !== 'persistently-critical') {
      throw new Error(
        "Composed verdict.residualRisk.shape must be 'persistently-critical'.",
      );
    }
    const recommendation = string(
      r['recommendation'],
      'Composed verdict.residualRisk.recommendation',
    );
    if (recommendation !== LAND_WITH_RESIDUAL_RISK) {
      throw new Error(
        `Composed verdict.residualRisk.recommendation must be '${LAND_WITH_RESIDUAL_RISK}'.`,
      );
    }
    // Through the ledger's own volume reader, like every other count that
    // crosses this boundary: the caps are what keep a hand-edited artifact
    // from re-displaying a number no round could have posted.
    const counts: Record<'criticals' | 'fresh' | 'prevFresh', number> = {
      criticals: 0,
      fresh: 0,
      prevFresh: 0,
    };
    for (const key of ['criticals', 'fresh', 'prevFresh'] as const) {
      const n = volumeOf(r[key]);
      if (n === undefined) {
        throw new Error(
          `Composed verdict.residualRisk.${key} must be a non-negative integer.`,
        );
      }
      counts[key] = n;
    }
    // The caveat is a boolean the paragraph turns on, so absence reads as
    // "not disclosed" rather than refusing an artifact written before the
    // field existed — the same absence semantics its numeric siblings get
    // one boundary up.
    residualRisk = {
      shape: 'persistently-critical',
      recommendation: LAND_WITH_RESIDUAL_RISK,
      ...counts,
      prevTruncated: r['prevTruncated'] === true,
    };
  }
  // The fresh count reads by the same rules as the total it is part of.
  const rawFresh = verdict['postedFresh'];
  const freshAbsent = rawFresh === undefined || rawFresh === null;
  const postedFresh = freshAbsent ? undefined : volumeOf(rawFresh);
  if (!freshAbsent && postedFresh === undefined) {
    throw new Error(
      'Composed verdict.postedFresh must be a non-negative integer.',
    );
  }
  // Absent reads as "no trim", the same absence semantics the sibling count
  // gets: a composed file written before the body budget shipped carries no
  // `bodyTrim`, and a mid-upgrade save must not fail over a record of
  // something that did not happen. A PRESENT value of the wrong shape is
  // refused like every other field here.
  const rawTrim = verdict['bodyTrim'] ?? {
    sections: 0,
    deferralList: false,
    fold: false,
    truncated: false,
  };
  const trim = object(rawTrim, 'Composed verdict.bodyTrim');
  // No per-field tolerance for `fold`: every build that writes a `bodyTrim`
  // at all writes all four fields (`git log -S bodyTrim` is this branch and
  // nothing else), so a present record missing one is malformed, not old.
  // The tolerance that IS owed lives above, on the object: a composed file
  // from a CLI predating the budget carries no `bodyTrim`, and that absence
  // is the truth rather than an error.
  if (
    typeof trim['sections'] !== 'number' ||
    !Number.isInteger(trim['sections']) ||
    trim['sections'] < 0 ||
    typeof trim['deferralList'] !== 'boolean' ||
    typeof trim['fold'] !== 'boolean' ||
    typeof trim['truncated'] !== 'boolean'
  ) {
    throw new Error(
      'Composed verdict.bodyTrim must carry a non-negative integer `sections` and boolean `deferralList` / `fold` / `truncated`.',
    );
  }
  return {
    bodyTrim: {
      sections: trim['sections'],
      deferralList: trim['deferralList'],
      fold: trim['fold'],
      truncated: trim['truncated'],
    },
    event: event(verdict['event'], 'Composed verdict.event'),
    body: string(verdict['body'], 'Composed verdict.body'),
    baseEvent: event(verdict['baseEvent'], 'Composed verdict.baseEvent'),
    cappedBy: stringArray(verdict['cappedBy'], 'Composed verdict.cappedBy'),
    downgraded: verdict['downgraded'],
    downgradedFrom,
    remediation: stringArray(
      verdict['remediation'],
      'Composed verdict.remediation',
    ),
    deferredCount,
    floorEnforced: floorEnforced as number[],
    ...(postedInline === undefined ? {} : { postedInline }),
    ...(postedFresh === undefined ? {} : { postedFresh }),
    ...(convergence === undefined ? {} : { convergence }),
    ...(recommendations === undefined ? {} : { recommendations }),
    ...(health === undefined ? {} : { health }),
    ...(residualRisk === undefined ? {} : { residualRisk }),
    lowSignal:
      lowSignal === null
        ? null
        : {
            agents: (lowSignal as Record<string, number>)['agents']!,
            srcDiffLines: (lowSignal as Record<string, number>)[
              'srcDiffLines'
            ]!,
          },
    approachSignal:
      approachRaw === null
        ? null
        : {
            round: (approachRaw as Record<string, number>)['round']!,
            src0: (approachRaw as Record<string, number>)['src0']!,
            srcDiffLines: (approachRaw as Record<string, number>)[
              'srcDiffLines'
            ]!,
            growth: (approachRaw as Record<string, number>)['growth']!,
            nonConverged: (approachRaw as Record<string, unknown>)[
              'nonConverged'
            ] as boolean,
          },
    verdictLine: nonEmptyString(
      verdict['verdictLine'],
      'Composed verdict.verdictLine',
    ),
  };
}

function validateFindingsReport(value: unknown): FindingsReport {
  const report = object(value, 'Canonical findings report');
  if (typeof report['outcomesRecorded'] !== 'boolean') {
    throw new Error(
      'Canonical findings report.outcomesRecorded must be a boolean.',
    );
  }
  const canonical = buildReport(validateFindings(report['findings']));
  const supplied: FindingsReport = {
    findings: report['findings'] as FindingsReport['findings'],
    counts: report['counts'] as FindingsReport['counts'],
    outcomesRecorded: report['outcomesRecorded'],
  };
  if (!isDeepStrictEqual(supplied, canonical)) {
    throw new Error(
      'Canonical findings report is malformed or inconsistent with its findings.',
    );
  }
  return supplied;
}

export function saveReviewArtifact(
  args: SaveArtifactArgs,
): SavedReviewArtifact {
  const root = workspaceRoot(args.workspaceRoot);
  const findingsPath = workspacePath(root, args.findings, 'Findings input');
  const composedPath = workspacePath(root, args.composed, 'Composed input');
  const reportPath = workspacePath(root, args.report, 'Markdown report');
  const outputPath = workspacePath(root, args.out, 'Output');
  const reviewsRoot = resolve(root, REVIEWS_DIR);

  if (!isWithin(reviewsRoot, reportPath) || reportPath === reviewsRoot) {
    throw new Error(
      `Markdown report must be a file under ${JSON.stringify(REVIEWS_DIR)}: ${JSON.stringify(args.report)}.`,
    );
  }
  if (!isWithin(reviewsRoot, outputPath) || outputPath === reviewsRoot) {
    throw new Error(
      `Output must be a file under ${JSON.stringify(REVIEWS_DIR)}: ${JSON.stringify(args.out)}.`,
    );
  }
  for (const [label, inputPath] of [
    ['findings input', findingsPath],
    ['composed input', composedPath],
    ['Markdown report', reportPath],
  ] as const) {
    if (isSameFile(outputPath, inputPath)) {
      throw new Error(`Output must not overwrite the ${label}.`);
    }
  }
  rejectSymlinkPath(root, findingsPath, 'Findings input');
  rejectSymlinkPath(root, composedPath, 'Composed input');
  rejectSymlinkPath(root, reportPath, 'Markdown report');
  rejectSymlinkPath(root, outputPath, 'Output');
  if (!EFFORT_LEVELS.has(args.effort)) {
    throw new Error(
      `Unsupported review effort: ${JSON.stringify(args.effort)}.`,
    );
  }
  if (args.effort === 'low') {
    throw new Error(
      'save-artifact does not support low-effort reviews: low has no canonical composed verdict to persist.',
    );
  }
  nonEmptyString(args.target, 'Target');

  const findings = validateFindingsReport(
    readJson(findingsPath, 'canonical findings'),
  );
  const verdict = validateVerdict(readJson(composedPath, 'composed verdict'));
  let reportIsFile: boolean | undefined;
  try {
    reportIsFile = statSync(reportPath).isFile();
  } catch {
    // Missing or unreadable: readText below reports it with context.
  }
  if (reportIsFile === false) {
    throw new Error(
      `Markdown report is not a file: ${JSON.stringify(args.report)}.`,
    );
  }
  readText(reportPath, 'Markdown report');

  const markdownReportPath = relative(root, reportPath).split(sep).join('/');
  const document: ReviewArtifactV1 = {
    schemaVersion: 1,
    target: args.target,
    effort: args.effort,
    verdict,
    findings: findings.findings,
    counts: findings.counts,
    outcomesRecorded: findings.outcomesRecorded,
    markdownReportPath,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  atomicWriteFileSync(
    toNamespacedPath(outputPath),
    `${JSON.stringify(document, null, 2)}\n`,
    { encoding: 'utf8', noFollow: true },
  );
  return {
    path: outputPath,
    workspacePath: relative(root, outputPath).split(sep).join('/'),
  };
}

export const saveArtifactCommand: CommandModule = {
  command: 'save-artifact',
  describe:
    'Create a durable versioned code-review JSON document from canonical review artifacts',
  builder: (yargs) =>
    yargs
      .option('findings', {
        type: 'string',
        demandOption: true,
        describe: 'Canonical findings JSON',
      })
      .option('composed', {
        type: 'string',
        demandOption: true,
        describe: 'Composed verdict JSON',
      })
      .option('report', {
        type: 'string',
        demandOption: true,
        describe: 'Existing durable Markdown report',
      })
      .option('target', {
        type: 'string',
        demandOption: true,
        describe: 'Review target label',
      })
      .option('effort', {
        type: 'string',
        choices: [...EFFORT_LEVELS].filter((effort) => effort !== 'low'),
        demandOption: true,
        describe: 'Resolved review effort',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output path under .qwen/reviews/',
      })
      .option('workspace-root', {
        type: 'string',
        describe:
          'Root that containment and relative paths resolve against ' +
          '(default: the working directory — run from the main checkout)',
      }),
  handler: (argv) => {
    const saved = saveReviewArtifact(argv as unknown as SaveArtifactArgs);
    writeStdoutLine(JSON.stringify(saved));
    writeStderrLine(`save-artifact: wrote ${saved.path}`);
  },
};
