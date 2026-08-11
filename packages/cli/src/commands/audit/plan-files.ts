/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen audit plan-files`: enumerate a directory of existing code and write
// the audit plan as JSON. This is the audit pipeline's counterpart of
// `qwen review plan-diff` — the deterministic step that fixes WHAT will be
// audited (and what refuses) before any agent is launched, so the roster,
// gates, and budget are computed by code and cannot be shrunk by the
// orchestrator.

import type { CommandModule } from 'yargs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  applyExcludeRemedy,
  AuditRefusal,
  buildFilesPlan,
  checkLocalOnlyGuard,
  collectAuditFiles,
  resolveAuditRoot,
  type AuditEffort,
} from './lib/files-plan.js';
import type { ParsedAuditArgs } from './parse-args.js';

interface PlanFilesArgs {
  path?: string;
  argsReport?: string;
  out: string;
  effort?: AuditEffort;
  applyExcludeRemedy?: boolean;
}

/** The args-report is any file on disk — stale, partial, or hand-authored —
 *  so validate the shape before the cast instead of trusting it. */
function readArgsReport(path: string): ParsedAuditArgs {
  let parsed: Partial<ParsedAuditArgs>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ParsedAuditArgs>;
  } catch (err) {
    // A truncated/partial report is the same hand-authored input class as
    // a wrong-shape one — surface the designed diagnostic, not a raw
    // SyntaxError/ENOENT stack.
    throw new Error(
      `plan-files: --args-report is not a parse-args verdict — regenerate it. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }
  if (
    typeof parsed.targetPath !== 'string' ||
    typeof parsed.targetPathAbsolute !== 'string' ||
    (parsed.effort !== 'low' &&
      parsed.effort !== 'medium' &&
      parsed.effort !== 'high')
  ) {
    throw new Error(
      'plan-files: --args-report is not a parse-args verdict — regenerate it.',
    );
  }
  return {
    targetPath: parsed.targetPath,
    targetPathAbsolute: parsed.targetPathAbsolute,
    effort: parsed.effort,
  };
}

function runPlanFiles(args: PlanFilesArgs): void {
  // Truthiness, not === undefined, so an empty-string value is refused by
  // the either-or guard instead of crashing the reader below.
  if (!args.path === !args.argsReport) {
    throw new Error(
      'plan-files: pass exactly one of <path> or --args-report <path>.',
    );
  }
  const parsed = args.argsReport ? readArgsReport(args.argsReport) : undefined;
  const targetPath = parsed ? parsed.targetPath : (args.path as string);
  // The recorded targetPathAbsolute is re-validated, not trusted: the
  // report is any file on disk, and a deleted/moved target must surface
  // the clean 'Path does not exist' diagnostic, not a misattributed
  // all-uncoverable refusal.
  const rootAbs = parsed
    ? resolveAuditRoot(parsed.targetPathAbsolute)
    : resolveAuditRoot(targetPath);
  // An explicit --effort flag overrides the recorded verdict: the low-gate
  // refusal's remedy re-runs this command with --effort medium.
  const effort = args.effort ?? parsed?.effort ?? 'medium';
  const projectRoot = process.cwd();

  const collection = collectAuditFiles(rootAbs);
  let plan;
  try {
    plan = buildFilesPlan(rootAbs, targetPath, effort, collection);
  } catch (err) {
    if (err instanceof AuditRefusal) {
      const refusal = {
        targetPath,
        targetPathAbsolute: rootAbs,
        effort,
        ...err.refusal,
      };
      mkdirSync(dirname(resolve(args.out)), { recursive: true });
      writeFileSync(args.out, JSON.stringify(refusal, null, 2), 'utf8');
      writeStderrLine(err.refusal.message);
      writeStderrLine(`Wrote refusal to ${args.out}`);
      process.exitCode = 3;
      return;
    }
    throw err;
  }

  // The remedy mutates the repository's shared exclude file, so it runs
  // only once the plan has succeeded: a refusing run must not leave the
  // mutation behind with no record of it.
  if (args.applyExcludeRemedy) {
    try {
      const excludeFile = applyExcludeRemedy(projectRoot);
      writeStderrLine(
        `Added ignore rules for /.qwen/audits/ and /.qwen/tmp/ to ${excludeFile} ` +
          `(applies to every worktree of this repository).`,
      );
    } catch (err) {
      // The guard re-probe stays 'unprotected', so the fallback landing
      // still engages — relay why the remedy did not apply.
      writeStderrLine(err instanceof Error ? err.message : String(err));
    }
  }

  const guard = checkLocalOnlyGuard(
    projectRoot,
    `${plan.artifacts.reportSlug}.md`,
  );
  plan.artifacts.fallbackRoot = guard.fallbackRoot;

  const result = { targetPath, ...plan, guard };
  mkdirSync(dirname(resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(result, null, 2), 'utf8');
  writeStdoutLine(`Wrote audit plan to ${args.out}`);

  const exposed = guard.dirs.filter(
    (d) => d.status !== 'ok' && d.status !== 'no-worktree',
  );
  const remediable = exposed.filter((d) => d.status === 'unprotected');
  const tracked = exposed.filter((d) => d.status === 'tracked');
  const probeFailed = exposed.filter((d) => d.status === 'git-failed');
  if (probeFailed.length > 0) {
    writeStderrLine(
      `WARNING: the git worktree probe failed for ${probeFailed.map((d) => d.dir).join(', ')} — ` +
        `the guard cannot certify them. Land artifacts outside the repo (${guard.fallbackRoot}).`,
    );
  }
  if (remediable.length > 0) {
    writeStderrLine(
      `WARNING: ${remediable.map((d) => d.dir).join(', ')} can land in version control. ` +
        `Add the exclude remedy (--apply-exclude-remedy) or land artifacts ` +
        `outside the repo (${guard.fallbackRoot}).`,
    );
  }
  if (tracked.length > 0) {
    writeStderrLine(
      `WARNING: ${tracked.map((d) => d.dir).join(', ')} contain tracked files — ignore rules ` +
        `cannot untrack committed artifacts. Land artifacts outside the repo ` +
        `(${guard.fallbackRoot}) or \`git rm --cached\` the tracked files.`,
    );
  }
  const walkedSubjectLines = plan.subjectFiles.reduce((n, f) => n + f.lines, 0);
  const walkedTestLines = plan.testCorpus.reduce((n, f) => n + f.lines, 0);
  writeStderrLine(
    `Audit: ${walkedSubjectLines} subject lines across ${plan.subjectFiles.length} files ` +
      `(${plan.testCorpus.length} test files / ${walkedTestLines} lines, ` +
      `${plan.uncoverable.length} uncoverable, ${plan.excludedDirs.length} excluded dirs) — ` +
      (effort === 'low'
        ? `low tier: single reader sub-agent, cap ${plan.lowTier?.findingCap} findings`
        : `roster: ${plan.roster.join(',')}; estimate ${plan.estimate?.floorTokens}–${plan.estimate?.topTokens} tokens`) +
      (plan.eventModule.detected ? '; event/lifecycle module detected' : ''),
  );
}

export const planFilesCommand: CommandModule = {
  command: 'plan-files [path]',
  describe:
    'Enumerate a directory of existing code into an audit plan (subjects, gates, budget estimate, roster) and write it as JSON; exits 3 with a refusal JSON when a plan-time gate refuses',
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
      .option('effort', {
        choices: ['low', 'medium', 'high'] as const,
        describe:
          'Audit effort. `low` is one reader sub-agent (unverified triage); `medium` (default) runs the replicated roster plus verification; `high` adds the remaining personas and reverse-audit rounds.',
      })
      .option('apply-exclude-remedy', {
        type: 'boolean',
        describe:
          "Append ignore rules for /.qwen/audits/ and /.qwen/tmp/ to the repository's common-dir exclude file (.git/info/exclude), then re-probe",
      }),
  handler: (argv) => {
    runPlanFiles(argv as unknown as PlanFilesArgs);
  },
};
