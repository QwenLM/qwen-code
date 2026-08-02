/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { gitOpt } from './lib/git.js';
import { buildRepositoryContext } from './lib/repository-context.js';
import { stringifyPlanReport } from './lib/report.js';

interface RepoContextArgs {
  plan: string;
  worktree: string;
  out: string;
}

interface PlanFile {
  path: unknown;
}

interface MutablePlan {
  files?: unknown;
  worktreePath?: unknown;
  mergeBaseSha?: unknown;
  baseFetchFailed?: unknown;
  repositoryContext?: unknown;
  [key: string]: unknown;
}

function sameFile(left: string, right: string): boolean {
  if (left === right) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  const leftStat = statSync(left);
  const rightStat = statSync(right);
  return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
}

function recordedWorktreeMatches(
  recordedPath: string,
  worktree: string,
): boolean {
  const candidates = [resolve(recordedPath)];
  if (!isAbsolute(recordedPath)) {
    const commonDir = gitOpt('-C', worktree, 'rev-parse', '--git-common-dir');
    if (commonDir !== null) {
      candidates.push(
        resolve(dirname(resolve(worktree, commonDir)), recordedPath),
      );
    }
  }
  return candidates.some(
    (candidate) =>
      existsSync(candidate) && realpathSync(candidate) === worktree,
  );
}

function trustedJcheckConf(
  plan: MutablePlan,
  worktree: string,
): string | undefined {
  if (plan.mergeBaseSha === undefined) return undefined;
  if (plan.baseFetchFailed === true) {
    throw new Error(
      'repo-context: base fetch failed, so plan.mergeBaseSha may be stale',
    );
  }
  if (plan.mergeBaseSha === null) return '';
  if (
    typeof plan.mergeBaseSha !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(plan.mergeBaseSha)
  ) {
    throw new Error('repo-context: plan.mergeBaseSha is invalid');
  }
  if (
    gitOpt(
      '-C',
      worktree,
      'cat-file',
      '-e',
      `${plan.mergeBaseSha}^{commit}`,
    ) === null
  ) {
    throw new Error('repo-context: plan.mergeBaseSha cannot be resolved');
  }
  return (
    gitOpt('-C', worktree, 'show', `${plan.mergeBaseSha}:.jcheck/conf`) ?? ''
  );
}

function readPlan(path: string): MutablePlan {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read plan ${path}: ${(error as Error).message}`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('repo-context: plan must be a JSON object');
  }
  return value as MutablePlan;
}

function changedPaths(plan: MutablePlan): string[] {
  if (!Array.isArray(plan.files)) {
    throw new Error('repo-context: plan.files must be an array');
  }
  return plan.files.map((file, index) => {
    const path =
      typeof file === 'object' && file !== null
        ? (file as PlanFile).path
        : undefined;
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`repo-context: plan.files[${index}].path is invalid`);
    }
    return path;
  });
}

export function runRepoContext(args: RepoContextArgs): void {
  const planPath = resolve(args.plan);
  const outPath = resolve(args.out);
  if (sameFile(planPath, outPath)) {
    throw new Error('repo-context: --out must differ from --plan');
  }
  const worktree = realpathSync(resolve(args.worktree));
  if (!statSync(worktree).isDirectory()) {
    throw new Error(`repo-context: worktree is not a directory: ${worktree}`);
  }

  const plan = readPlan(planPath);
  if (plan.worktreePath !== undefined) {
    if (
      typeof plan.worktreePath !== 'string' ||
      plan.worktreePath.length === 0
    ) {
      throw new Error('repo-context: plan.worktreePath is invalid');
    }
    if (!recordedWorktreeMatches(plan.worktreePath, worktree)) {
      throw new Error(
        `repo-context: --worktree does not match plan.worktreePath (${worktree} != ${plan.worktreePath})`,
      );
    }
  }

  const context = buildRepositoryContext(
    worktree,
    changedPaths(plan),
    trustedJcheckConf(plan, worktree),
  );
  if (context === null) {
    delete plan.repositoryContext;
  } else {
    plan.repositoryContext = context;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  mkdirSync(dirname(planPath), { recursive: true });
  atomicWriteFileSync(outPath, `${JSON.stringify(context, null, 2)}\n`);
  atomicWriteFileSync(planPath, stringifyPlanReport(plan));
  writeStdoutLine(`Wrote repository context to ${outPath}`);
}

export const repoContextCommand: CommandModule = {
  command: 'repo-context',
  describe: 'Attach bounded repository-specific context to a review plan',
  builder: (yargs) =>
    yargs
      .option('plan', {
        type: 'string',
        demandOption: true,
        describe: 'Existing review plan JSON to update',
      })
      .option('worktree', {
        type: 'string',
        demandOption: true,
        describe: 'Repository worktree used to resolve context',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Independent repository-context artifact path',
      }),
  handler: (argv) => {
    runRepoContext(argv as unknown as RepoContextArgs);
  },
};
