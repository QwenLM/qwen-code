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
  getGitWorkingTreeStatus,
  parseGhPrList,
} from '@qwen-code/qwen-code-core';
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 1024 * 1024;
const GH_CURRENT_PR_FIELDS =
  'number,title,url,author,headRefName,headRepositoryOwner,isDraft,isCrossRepository,reviewDecision,statusCheckRollup,updatedAt,state';

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
const AUTOFIX_NAMESPACE_PATTERN = /^autofix tick(?:\s|$)/;

export function isAutofixCronJob(job: Pick<CronJob, 'prompt'>): boolean {
  return AUTOFIX_NAMESPACE_PATTERN.test(job.prompt);
}

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

export function autofixWatchers(jobs: readonly CronJob[]): AutofixWatcher[] {
  return jobs
    .map(parseAutofixWatcher)
    .filter((watcher): watcher is AutofixWatcher => watcher !== null);
}

export function matchingAutofixWatchers(
  jobs: readonly CronJob[],
  repo: string,
  pr: number,
): AutofixWatcher[] {
  return autofixWatchers(jobs).filter(
    (watcher) =>
      watcher.repo.toLowerCase() === repo.toLowerCase() && watcher.pr === pr,
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

async function resolveCurrentPullRequest(
  cwd: string,
  branch: string,
): Promise<{
  pullRequest: GitHubPullRequest;
  headRepositoryOwner: string;
}> {
  const { stdout } = await execFileAsync(
    'gh',
    ['pr', 'view', '--json', GH_CURRENT_PR_FIELDS],
    {
      cwd,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: GH_MAX_BUFFER,
      windowsHide: true,
      encoding: 'utf8',
    },
  );
  const parsed = JSON.parse(stdout) as {
    state?: unknown;
    headRefName?: unknown;
    headRepositoryOwner?: { login?: unknown } | null;
    isCrossRepository?: unknown;
  };
  if (parsed.state !== 'OPEN' || parsed.headRefName !== branch) {
    throw new Error(
      `No open pull request is associated with branch ${branch}.`,
    );
  }
  if (
    parsed.isCrossRepository ||
    typeof parsed.headRepositoryOwner?.login !== 'string'
  ) {
    throw new Error(
      'Autofix requires the current branch to belong to the canonical repository.',
    );
  }
  const [pullRequest] = parseGhPrList(JSON.stringify([parsed]));
  if (!pullRequest) {
    throw new Error('GitHub CLI returned invalid pull request metadata.');
  }
  return {
    pullRequest,
    headRepositoryOwner: parsed.headRepositoryOwner.login,
  };
}

export async function resolveCurrentAutofixPullRequest(
  config: Config,
): Promise<CurrentAutofixPullRequestResult> {
  const cwd = config.getProjectRoot();
  const status = await getGitWorkingTreeStatus(cwd);
  if (!status || status.detached || !status.branch) {
    return { kind: 'error', message: 'Autofix requires a checked-out branch.' };
  }
  const branch = status.branch;

  try {
    const repo = await resolveRepository(cwd);
    const currentPullRequest = await resolveCurrentPullRequest(cwd, branch);
    const owner = repo.slice(0, repo.indexOf('/'));
    if (
      owner.toLowerCase() !==
      currentPullRequest.headRepositoryOwner.toLowerCase()
    ) {
      throw new Error(
        'The current pull request does not belong to the canonical repository.',
      );
    }
    return {
      kind: 'ok',
      value: { pullRequest: currentPullRequest.pullRequest, repo },
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      kind: 'error',
      message:
        code === 'ENOENT'
          ? 'Autofix requires the GitHub CLI (`gh`).'
          : `Unable to resolve the current pull request: ${error instanceof Error ? error.message : String(error)}`,
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

async function rejectedAutofixCronPrompt(
  config: Config,
  job: Pick<CronJob, 'id' | 'prompt'>,
  reason: string,
): Promise<ResolvedAutofixCronPrompt> {
  const id = job.id || 'unknown';
  let stopped = false;
  if (job.id) {
    try {
      stopped = await config.getCronScheduler().delete(job.id);
    } catch {
      stopped = false;
    }
  }
  return {
    displayText: `Autofix rejected: ${id}`,
    modelText: `Autofix watcher ${id} was rejected by the CLI: ${reason}. No maintenance action was authorized.${stopped ? ' The watcher was disabled.' : ' The watcher could not be confirmed disabled; use /autofix off.'}`,
  };
}

export async function resolveAutofixCronPrompt(
  config: Config,
  job: Pick<CronJob, 'id' | 'prompt' | 'recurring' | 'cronExpr'>,
): Promise<ResolvedAutofixCronPrompt | null> {
  if (!isAutofixCronJob(job)) return null;
  try {
    const watcher = parseAutofixWatcher(job as CronJob);
    if (!watcher || !job.id) {
      return rejectedAutofixCronPrompt(config, job, 'invalid watcher metadata');
    }
    const live = config
      .getCronScheduler()
      .list()
      .some(
        (candidate) =>
          candidate.id === job.id && candidate.prompt === job.prompt,
      );
    if (!live) {
      return rejectedAutofixCronPrompt(
        config,
        job,
        'the watcher is no longer live',
      );
    }

    if (config.getDisabledSkillNames().has('autofix')) {
      return rejectedAutofixCronPrompt(
        config,
        job,
        'the Autofix skill is disabled',
      );
    }
    const skill = await config
      .getSkillManager()
      ?.loadSkillForRuntime('autofix', 'bundled');
    if (!skill) {
      return rejectedAutofixCronPrompt(
        config,
        job,
        'the bundled Autofix skill is unavailable',
      );
    }
    applySkillAllowedTools(config.getPermissionManager(), skill.allowedTools);
    const content = buildSkillLlmContent(dirname(skill.filePath), skill.body);
    return {
      displayText: `Autofix: ${watcher.repo}#${watcher.pr}`,
      modelText: `${content}\n${job.prompt}\n<autofix-authority source="cron" repo="${watcher.repo}" pr="${watcher.pr}" mode="${watcher.mode}" rounds="${watcher.rounds}" infra-reruns="${watcher.infraReruns}" job="${job.id}" />`,
    };
  } catch (error) {
    return rejectedAutofixCronPrompt(
      config,
      job,
      `watcher expansion failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function buildAutofixImmediatePrompt(
  skill: SkillConfig,
  watcher: AutofixWatcher,
): string {
  const content = buildSkillLlmContent(dirname(skill.filePath), skill.body);
  return `${content}\n/autofix on ${watcher.mode}\n<autofix-authority source="user" repo="${watcher.repo}" pr="${watcher.pr}" mode="${watcher.mode}" rounds="${watcher.rounds}" infra-reruns="${watcher.infraReruns}" job="${watcher.job.id}" />`;
}
