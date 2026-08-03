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
import { writeStderrLine, writeStdoutLine } from '../../utils/stdioHelpers.js';

interface PersistedVerdict extends ComposeReviewResult {
  verdictLine: string;
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
   * The same path relative to the workspace root — the exact value
   * `record_artifact` wants as `workspacePath`, so the skill copies it
   * verbatim instead of re-deriving it from the absolute path.
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
}

// Every path resolves against the daemon workspace root, not cwd: in PR
// worktree mode cwd is the disposable review worktree, while the durable
// output and `markdownReportPath` must stay relative to the main project for
// Web Shell's `readWorkspaceFile` to find them. The skill threads that root
// through its subprocesses as QWEN_CODE_PROJECT_DIR.
function workspaceRoot(): string {
  return resolve(process.env['QWEN_CODE_PROJECT_DIR'] ?? process.cwd());
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

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
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
  return {
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
    lowSignal:
      lowSignal === null
        ? null
        : {
            agents: (lowSignal as Record<string, number>)['agents']!,
            srcDiffLines: (lowSignal as Record<string, number>)[
              'srcDiffLines'
            ]!,
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
  const root = workspaceRoot();
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
    if (sameFile(outputPath, inputPath)) {
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
      }),
  handler: (argv) => {
    const saved = saveReviewArtifact(argv as unknown as SaveArtifactArgs);
    writeStdoutLine(JSON.stringify(saved));
    writeStderrLine(`save-artifact: wrote ${saved.path}`);
  },
};
