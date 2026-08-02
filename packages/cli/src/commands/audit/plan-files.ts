/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit plan-files`: enumerate a directory of existing code and write
// the audit plan as JSON. This is the audit pipeline's counterpart of
// `qwen review plan-diff` — the deterministic step that fixes WHAT will be
// audited before any agent is launched, so the roster is computed by code
// and cannot be shrunk by the orchestrator.

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  buildFilesPlan,
  collectAuditFiles,
  resolveAuditRoot,
  DEFAULT_MAX_CHUNK_LINES,
  type AuditEffort,
} from './lib/files-plan.js';
import type { ParsedAuditArgs } from './parse-args.js';

interface PlanFilesArgs {
  path?: string;
  argsReport?: string;
  out: string;
  maxChunkLines: number;
  effort?: AuditEffort;
}

function runPlanFiles(args: PlanFilesArgs): void {
  if ((args.path === undefined) === (args.argsReport === undefined)) {
    throw new Error(
      'plan-files: pass exactly one of <path> or --args-report <path>.',
    );
  }
  if (!Number.isSafeInteger(args.maxChunkLines) || args.maxChunkLines <= 0) {
    throw new Error(
      'plan-files: --max-chunk-lines must be a positive integer.',
    );
  }
  const parsed = args.argsReport
    ? (JSON.parse(readFileSync(args.argsReport, 'utf8')) as ParsedAuditArgs)
    : undefined;
  const targetPath = parsed?.targetPath ?? args.path!;
  const rootAbs = parsed?.targetPathAbsolute ?? resolveAuditRoot(targetPath);
  const effort = parsed?.effort ?? args.effort ?? 'medium';
  const files = collectAuditFiles(rootAbs);
  const plan = buildFilesPlan(files, effort, args.maxChunkLines);

  if (plan.totalFiles === 0) {
    writeStderrLine(
      `WARNING: no production files found under ${targetPath} — the plan is ` +
        `empty. Check the path (tests, docs and generated files are not ` +
        `audit subjects).`,
    );
  }

  const result = {
    targetPath,
    targetPathAbsolute: rootAbs,
    effort,
    ...plan,
  };
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
  writeStdoutLine(`Wrote audit plan to ${args.out}`);
  writeStderrLine(
    `Audit: ${plan.srcLines} source lines across ${plan.totalFiles} files ` +
      `(${plan.evidenceFiles.length} test, ${plan.docsFiles.length} docs, ` +
      `${plan.generatedFiles.length} generated excluded) -> ` +
      `${plan.topology === 'whole' ? 'whole-read topology' : `${plan.chunks.length} chunk(s)`}, ` +
      `${plan.heavyFiles.length} heavy file(s), roster: ` +
      `${plan.roster.length > 0 ? plan.roster.join(',') : 'inline (low effort)'}`,
  );
}

export const planFilesCommand: CommandModule = {
  command: 'plan-files [path]',
  describe:
    'Enumerate a directory of existing code into an audit plan (files, topology, chunks, roster) and write it as JSON',
  builder: (yargs) =>
    yargs
      .positional('path', {
        type: 'string',
        describe:
          'Directory to audit (single files are covered by /review <file-path>)',
      })
      .option('args-report', {
        type: 'string',
        describe:
          'Resolved JSON written by audit parse-args; avoids putting the user path back into shell syntax',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('max-chunk-lines', {
        type: 'number',
        default: DEFAULT_MAX_CHUNK_LINES,
        describe:
          'Target size, in file lines, of each audit chunk; only used above the whole-read threshold',
      })
      .option('effort', {
        choices: ['low', 'medium', 'high'] as const,
        describe:
          'Audit effort. `low` is an inline read (no agents); `medium` (default) runs the replicated roster; `high` adds the remaining personas and a reverse-audit round.',
      }),
  handler: (argv) => {
    runPlanFiles(argv as unknown as PlanFilesArgs);
  },
};
