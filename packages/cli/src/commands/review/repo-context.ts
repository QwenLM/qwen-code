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
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { gitOpt } from './lib/git.js';
import {
  isSafeRepositoryRelativePath,
  type RepositoryContext,
  type RepositoryContextProvider,
  validateRepositoryContext,
} from './lib/repository-context.js';
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

export const REPOSITORY_CONTEXT_PROVIDERS: readonly RepositoryContextProvider[] =
  [];

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

function trustedMergeBase(plan: MutablePlan, worktree: string): string | null {
  if (plan.mergeBaseSha === undefined) return null;
  if (plan.baseFetchFailed === true) {
    throw new Error(
      'repo-context: base fetch failed, so plan.mergeBaseSha may be stale',
    );
  }
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
  return plan.mergeBaseSha;
}

function identityReader(
  worktree: string,
  mergeBase: string | null,
): (relativePath: string) => string | null {
  return (relativePath) => {
    if (!isSafeRepositoryRelativePath(relativePath)) {
      throw new Error(
        `repo-context: identity path is unsafe: ${JSON.stringify(relativePath)}`,
      );
    }
    if (mergeBase !== null) {
      return gitOpt('-C', worktree, 'show', `${mergeBase}:${relativePath}`);
    }
    const candidate = resolve(worktree, relativePath);
    try {
      const resolved = realpathSync(candidate);
      const contained = relative(worktree, resolved);
      if (
        contained === '' ||
        isAbsolute(contained) ||
        contained === '..' ||
        contained.startsWith(`..${sep}`)
      ) {
        throw new Error(
          `repo-context: identity path escapes the worktree: ${JSON.stringify(relativePath)}`,
        );
      }
      if (!statSync(resolved).isFile()) return null;
      return readFileSync(resolved, 'utf8');
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('repo-context: identity path escapes')
      ) {
        throw error;
      }
      return null;
    }
  };
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
  const paths = plan.files.map((file, index) => {
    const path =
      typeof file === 'object' && file !== null
        ? (file as PlanFile).path
        : undefined;
    if (typeof path !== 'string' || !isSafeRepositoryRelativePath(path)) {
      throw new Error(`repo-context: plan.files[${index}].path is invalid`);
    }
    return path;
  });
  return [...new Set(paths)].sort();
}

function contextFromProviders(
  providers: readonly RepositoryContextProvider[],
  worktree: string,
  paths: string[],
  readIdentityFile: (relativePath: string) => string | null,
): RepositoryContext | null {
  for (const provider of providers) {
    const context = provider.provide({
      worktree,
      changedPaths: paths,
      readIdentityFile,
    });
    if (context !== null) return validateRepositoryContext(context);
  }
  return null;
}

export function runRepoContext(
  args: RepoContextArgs,
  providers: readonly RepositoryContextProvider[] = REPOSITORY_CONTEXT_PROVIDERS,
): void {
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

  const mergeBase = trustedMergeBase(plan, worktree);
  const context = contextFromProviders(
    providers,
    worktree,
    changedPaths(plan),
    identityReader(worktree, mergeBase),
  );
  if (context === null) delete plan.repositoryContext;
  else plan.repositoryContext = context;

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
