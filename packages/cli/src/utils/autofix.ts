/*
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Config,
  CronJob,
  GitHubPullRequest,
  SkillConfig,
} from '@qwen-code/qwen-code-core';
import {
  applySkillAllowedTools,
  buildSkillLlmContent,
  fetchGitHubPullRequests,
  resolveBranchName,
} from '@qwen-code/qwen-code-core';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 1024 * 1024;

export const AUTOFIX_CRON = '*/10 * * * *';
export const AUTOFIX_USAGE =
  'Usage: /autofix status | on [propose-only|auto-commit|auto-push] | off';

export type AutofixMode = 'propose-only' | 'auto-commit' | 'auto-push';

export interface AutofixWatcher {
  job: CronJob;
  repo: string;
  pr: number;
  mode: AutofixMode;
  rounds: number;
  infraReruns: number;
}

export interface CurrentAutofixPullRequest {
  pullRequest: GitHubPullRequest;
  repo: string;
}

export type CurrentAutofixPullRequestResult =
  | { kind: 'ok'; value: CurrentAutofixPullRequest }
  | { kind: 'error'; message: string };

const AUTOFIX_PROMPT_PATTERN =
  /^autofix tick repo=([^\s]+) pr=([1-9]\d*) mode=(propose-only|auto-commit|auto-push) rounds=(\d+) infra-reruns=(\d+)$/;
const OWNER_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseAutofixWatcher(job: CronJob): AutofixWatcher | null {
  if (!job.recurring || job.cronExpr !== AUTOFIX_CRON) return null;
  const match = AUTOFIX_PROMPT_PATTERN.exec(job.prompt);
  if (!match || !OWNER_REPO_PATTERN.test(match[1])) return null;
  return {
    job,
    repo: match[1],
    pr: Number(match[2]),
    mode: match[3] as AutofixMode,
    rounds: Number(match[4]),
    infraReruns: Number(match[5]),
  };
}

export function formatAutofixTick(
  repo: string,
  pr: number,
  mode: AutofixMode,
  rounds: number,
  infraReruns: number,
): string {
  if (!OWNER_REPO_PATTERN.test(repo)) {
    throw new Error(`Invalid Autofix repository identity: ${repo}`);
  }
  return `autofix tick repo=${repo} pr=${pr} mode=${mode} rounds=${rounds} infra-reruns=${infraReruns}`;
}

export function matchingAutofixWatchers(
  jobs: readonly CronJob[],
  repo: string,
  pr: number,
): AutofixWatcher[] {
  return jobs
    .map(parseAutofixWatcher)
    .filter(
      (watcher): watcher is AutofixWatcher =>
        watcher !== null &&
        watcher.repo.toLowerCase() === repo.toLowerCase() &&
        watcher.pr === pr,
    );
}

async function resolveRepository(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'],
    {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  const repo = stdout.trim();
  if (!OWNER_REPO_PATTERN.test(repo)) {
    throw new Error('GitHub CLI returned an invalid repository identity.');
  }
  return repo;
}

export async function resolveCurrentAutofixPullRequest(
  config: Config,
): Promise<CurrentAutofixPullRequestResult> {
  const cwd = config.getProjectRoot();
  const branch = await resolveBranchName(cwd);
  if (!branch) {
    return { kind: 'error', message: 'Autofix requires a checked-out branch.' };
  }

  const result = await fetchGitHubPullRequests(cwd);
  if (result.kind !== 'ok') {
    switch (result.kind) {
      case 'not_a_repo':
        return {
          kind: 'error',
          message: 'Autofix requires a Git repository.',
        };
      case 'cli_unavailable':
        return {
          kind: 'error',
          message: 'Autofix requires the GitHub CLI (`gh`).',
        };
      case 'failed':
        return {
          kind: 'error',
          message: `Unable to read pull requests: ${result.message}`,
        };
      default:
        return {
          kind: 'error',
          message: 'Unable to read pull requests.',
        };
    }
  }

  const matches = result.pullRequests.filter(
    (pullRequest) => pullRequest.headRefName === branch,
  );
  if (matches.length !== 1) {
    return {
      kind: 'error',
      message:
        matches.length === 0
          ? `No open pull request is associated with branch ${branch}.`
          : `More than one open pull request uses branch ${branch}; Autofix will not guess.`,
    };
  }

  try {
    return {
      kind: 'ok',
      value: {
        pullRequest: matches[0],
        repo: await resolveRepository(cwd),
      },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: 'error',
      message:
        code === 'ENOENT'
          ? 'Autofix requires the GitHub CLI (`gh`).'
          : `Unable to resolve the GitHub repository: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function watcherSummary(watcher: AutofixWatcher | undefined): string {
  if (!watcher) return 'Watcher: off';
  return `Watcher: on (${watcher.mode}, rounds ${watcher.rounds}/10, infra reruns ${watcher.infraReruns}/1, job ${watcher.job.id})`;
}

export interface ResolvedAutofixCronPrompt {
  displayText: string;
  modelText: string;
}

export async function resolveAutofixCronPrompt(
  config: Config,
  job: Pick<CronJob, 'id' | 'prompt' | 'recurring' | 'cronExpr'>,
): Promise<ResolvedAutofixCronPrompt | null> {
  const watcher = parseAutofixWatcher(job as CronJob);
  if (!watcher || !job.id) return null;
  const live = config
    .getCronScheduler()
    .list()
    .some(
      (candidate) => candidate.id === job.id && candidate.prompt === job.prompt,
    );
  if (!live) return null;

  const skill = await config
    .getSkillManager()
    ?.loadSkillForRuntime('autofix', 'bundled');
  if (!skill) {
    return {
      displayText: `Autofix disabled: ${watcher.repo}#${watcher.pr}`,
      modelText: `The live Autofix watcher ${job.id} for ${watcher.repo}#${watcher.pr} cannot run because the bundled Autofix skill is unavailable or disabled. Delete this watcher with cron_delete and report that no maintenance action was attempted.`,
    };
  }
  applySkillAllowedTools(config.getPermissionManager(), skill.allowedTools);
  const content = buildSkillLlmContent(dirname(skill.filePath), skill.body);
  return {
    displayText: `Autofix: ${watcher.repo}#${watcher.pr}`,
    modelText: `${content}\n${job.prompt}\n<autofix-authority source="cron" repo="${watcher.repo}" pr="${watcher.pr}" mode="${watcher.mode}" rounds="${watcher.rounds}" infra-reruns="${watcher.infraReruns}" job="${job.id}" />`,
  };
}

export function buildAutofixImmediatePrompt(
  skill: SkillConfig,
  watcher: AutofixWatcher,
): string {
  const content = buildSkillLlmContent(dirname(skill.filePath), skill.body);
  return `${content}\n/autofix on ${watcher.mode}\n<autofix-authority source="user" repo="${watcher.repo}" pr="${watcher.pr}" mode="${watcher.mode}" rounds="${watcher.rounds}" infra-reruns="${watcher.infraReruns}" job="${watcher.job.id}" />`;
}
