/*
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getGitWorkingTreeStatus,
  type Config,
  type CronJob,
  type SkillConfig,
} from '@qwen-code/qwen-code-core';
import {
  AUTOFIX_CRON,
  buildAutofixImmediatePrompt,
  formatAutofixTick,
  matchingAutofixWatchers,
  parseAutofixWatcher,
  resolveCurrentAutofixPullRequest,
  resolveAutofixCronPrompt,
} from './autofix.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return { ...actual, getGitWorkingTreeStatus: vi.fn() };
});

const getGitWorkingTreeStatusMock = vi.mocked(getGitWorkingTreeStatus);

beforeEach(() => {
  getGitWorkingTreeStatusMock.mockResolvedValue({
    branch: 'main',
    detached: false,
    hasUpstream: true,
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    stashCount: 0,
  });
});

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    cronExpr: AUTOFIX_CRON,
    prompt:
      'autofix tick repo=QwenLM/qwen-code pr=4362 mode=propose-only rounds=0 infra-reruns=0',
    recurring: true,
    createdAt: 1,
    expiresAt: 2,
    jitterMs: 0,
    ...overrides,
  };
}

function skill(): SkillConfig {
  return {
    name: 'autofix',
    description: 'Maintain the current PR',
    level: 'bundled',
    filePath: '/bundled/autofix/SKILL.md',
    body: 'Autofix contract',
    allowedTools: ['cron_list'],
  };
}

describe('Autofix watcher prompt', () => {
  it('round-trips canonical watcher state', () => {
    const prompt = formatAutofixTick(
      'QwenLM/qwen-code',
      4362,
      'auto-push',
      4,
      1,
    );

    expect(parseAutofixWatcher(job({ prompt }))).toMatchObject({
      repo: 'QwenLM/qwen-code',
      pr: 4362,
      mode: 'auto-push',
      rounds: 4,
      infraReruns: 1,
    });
  });

  it('rejects prompts without repository identity or exact cadence', () => {
    expect(
      parseAutofixWatcher(
        job({
          prompt:
            'autofix tick pr=4362 mode=propose-only rounds=0 infra-reruns=0',
        }),
      ),
    ).toBeNull();
    expect(parseAutofixWatcher(job({ cronExpr: '*/5 * * * *' }))).toBeNull();
    expect(() =>
      formatAutofixTick('not-a-repository', 1, 'propose-only', 0, 0),
    ).toThrow('Invalid Autofix repository identity');
  });

  it('matches repository names case-insensitively and keeps PRs separate', () => {
    const jobs = [
      job(),
      job({
        id: 'job-2',
        prompt:
          'autofix tick repo=other/repo pr=4362 mode=propose-only rounds=0 infra-reruns=0',
      }),
      job({
        id: 'job-3',
        prompt:
          'autofix tick repo=QwenLM/qwen-code pr=4363 mode=propose-only rounds=0 infra-reruns=0',
      }),
    ];

    expect(
      matchingAutofixWatchers(jobs, 'qwenlm/QWEN-CODE', 4362).map(
        (watcher) => watcher.job.id,
      ),
    ).toEqual(['job-1']);
  });
});

describe('Current Autofix pull request', () => {
  it('rejects detached HEAD before invoking GitHub CLI', async () => {
    getGitWorkingTreeStatusMock.mockResolvedValue({
      branch: null,
      detached: true,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicted: 0,
      stashCount: 0,
    });
    const config = {
      getProjectRoot: () => '/detached/repo',
    } as unknown as Config;

    await expect(resolveCurrentAutofixPullRequest(config)).resolves.toEqual({
      kind: 'error',
      message: 'Autofix requires a checked-out branch.',
    });
  });
});

describe('Autofix prompt authority', () => {
  function promptConfig(
    watcherJob: CronJob,
    overrides: {
      jobs?: CronJob[];
      disabled?: ReadonlySet<string>;
      loadSkillForRuntime?: ReturnType<typeof vi.fn>;
      deleteJob?: ReturnType<typeof vi.fn>;
      addSessionAllowRule?: ReturnType<typeof vi.fn>;
    } = {},
  ): { config: Config; deleteJob: ReturnType<typeof vi.fn> } {
    const deleteJob = overrides.deleteJob ?? vi.fn().mockResolvedValue(true);
    const config = {
      getCronScheduler: () => ({
        list: () => overrides.jobs ?? [watcherJob],
        delete: deleteJob,
      }),
      getDisabledSkillNames: () => overrides.disabled ?? new Set<string>(),
      getSkillManager: () => ({
        loadSkillForRuntime:
          overrides.loadSkillForRuntime ?? vi.fn().mockResolvedValue(skill()),
      }),
      getPermissionManager: () => ({
        addSessionAllowRule: overrides.addSessionAllowRule ?? vi.fn(),
      }),
    } as unknown as Config;
    return { config, deleteJob };
  }

  it('expands a live scheduled tick through the bundled skill contract', async () => {
    const watcherJob = job();
    const addSessionAllowRule = vi.fn();
    const { config } = promptConfig(watcherJob, { addSessionAllowRule });

    const result = await resolveAutofixCronPrompt(config, watcherJob);

    expect(result?.displayText).toBe('Autofix: QwenLM/qwen-code#4362');
    expect(result?.modelText).toContain('Autofix contract');
    expect(result?.modelText).toContain(watcherJob.prompt);
    expect(result?.modelText).toContain(
      '<autofix-authority source="cron" repo="QwenLM/qwen-code" pr="4362" mode="propose-only" rounds="0" infra-reruns="0" job="job-1" />',
    );
    expect(addSessionAllowRule).toHaveBeenCalledWith('cron_list');
  });

  it.each([
    ['malformed', job({ prompt: 'autofix tick mode=auto-push' })],
    ['stale', job()],
  ])('rejects and disables a %s Autofix tick', async (_label, watcherJob) => {
    const { config, deleteJob } = promptConfig(watcherJob, {
      jobs: _label === 'stale' ? [] : [watcherJob],
    });

    const result = await resolveAutofixCronPrompt(config, watcherJob);

    expect(result?.displayText).toBe('Autofix rejected: job-1');
    expect(result?.modelText).toContain('No maintenance action was authorized');
    expect(result?.modelText).toContain('The watcher was disabled');
    expect(deleteJob).toHaveBeenCalledWith('job-1');
  });

  it('disables a live watcher when Autofix is disabled at runtime', async () => {
    const watcherJob = job();
    const loadSkillForRuntime = vi.fn();
    const { config, deleteJob } = promptConfig(watcherJob, {
      disabled: new Set(['autofix']),
      loadSkillForRuntime,
    });

    const result = await resolveAutofixCronPrompt(config, watcherJob);

    expect(result?.displayText).toBe('Autofix rejected: job-1');
    expect(result?.modelText).toContain('the Autofix skill is disabled');
    expect(deleteJob).toHaveBeenCalledWith('job-1');
    expect(loadSkillForRuntime).not.toHaveBeenCalled();
  });

  it('fails closed when bundled skill loading rejects', async () => {
    const watcherJob = job();
    const { config, deleteJob } = promptConfig(watcherJob, {
      loadSkillForRuntime: vi
        .fn()
        .mockRejectedValue(new Error('skill storage unavailable')),
    });

    const result = await resolveAutofixCronPrompt(config, watcherJob);

    expect(result?.displayText).toBe('Autofix rejected: job-1');
    expect(result?.modelText).toContain(
      'watcher expansion failed: skill storage unavailable',
    );
    expect(deleteJob).toHaveBeenCalledWith('job-1');
  });

  it('pins repository identity in the immediate user-authorized prompt', () => {
    const watcher = parseAutofixWatcher(job());
    expect(watcher).not.toBeNull();

    const prompt = buildAutofixImmediatePrompt(skill(), watcher!);

    expect(prompt).toContain('/autofix on propose-only');
    expect(prompt).toContain(
      '<autofix-authority source="user" repo="QwenLM/qwen-code" pr="4362" mode="propose-only" rounds="0" infra-reruns="0" job="job-1" />',
    );
  });
});
