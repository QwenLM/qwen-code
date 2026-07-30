/*
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config, CronJob, SkillConfig } from '@qwen-code/qwen-code-core';
import {
  AUTOFIX_CRON,
  buildAutofixImmediatePrompt,
  formatAutofixTick,
  matchingAutofixWatchers,
  parseAutofixWatcher,
  resolveAutofixCronPrompt,
} from './autofix.js';

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

describe('Autofix prompt authority', () => {
  it('expands a live scheduled tick through the bundled skill contract', async () => {
    const watcherJob = job();
    const addSessionAllowRule = vi.fn();
    const config = {
      getCronScheduler: () => ({ list: () => [watcherJob] }),
      getSkillManager: () => ({
        loadSkillForRuntime: vi.fn().mockResolvedValue(skill()),
      }),
      getPermissionManager: () => ({ addSessionAllowRule }),
    } as unknown as Config;

    const result = await resolveAutofixCronPrompt(config, watcherJob);

    expect(result?.displayText).toBe('Autofix: QwenLM/qwen-code#4362');
    expect(result?.modelText).toContain('Autofix contract');
    expect(result?.modelText).toContain(watcherJob.prompt);
    expect(result?.modelText).toContain(
      '<autofix-authority source="cron" repo="QwenLM/qwen-code" pr="4362" mode="propose-only" rounds="0" infra-reruns="0" job="job-1" />',
    );
    expect(addSessionAllowRule).toHaveBeenCalledWith('cron_list');
  });

  it('does not authorize stale or user-entered prompt text', async () => {
    const watcherJob = job();
    const loadSkillForRuntime = vi.fn();
    const config = {
      getCronScheduler: () => ({ list: () => [] }),
      getSkillManager: () => ({ loadSkillForRuntime }),
    } as unknown as Config;

    await expect(
      resolveAutofixCronPrompt(config, watcherJob),
    ).resolves.toBeNull();
    expect(loadSkillForRuntime).not.toHaveBeenCalled();
  });

  it('turns a live watcher into a safe stop prompt when the skill is unavailable', async () => {
    const watcherJob = job();
    const config = {
      getCronScheduler: () => ({ list: () => [watcherJob] }),
      getSkillManager: () => ({
        loadSkillForRuntime: vi.fn().mockResolvedValue(null),
      }),
    } as unknown as Config;

    const result = await resolveAutofixCronPrompt(config, watcherJob);

    expect(result?.displayText).toBe('Autofix disabled: QwenLM/qwen-code#4362');
    expect(result?.modelText).toContain('Delete this watcher with cron_delete');
    expect(result?.modelText).toContain('no maintenance action was attempted');
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
