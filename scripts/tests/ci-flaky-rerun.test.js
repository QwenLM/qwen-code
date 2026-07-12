/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  actOnDecision,
  selectCandidateTargets,
  selectTarget,
  writeSkillInput,
} from '../../.github/scripts/ci-flaky-rerun.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = readFileSync('.github/scripts/ci-flaky-rerun.mjs', 'utf8');

const NOW = new Date('2026-07-12T08:00:00.000Z');

function run(overrides = {}) {
  return {
    databaseId: 11,
    name: 'E2E Tests',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    completedAt: '2026-07-12T07:20:00.000Z',
    detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/123/jobs/1',
    ...overrides,
  };
}

function pr(overrides = {}) {
  return {
    number: 42,
    isDraft: false,
    baseRefName: 'main',
    headRefOid: 'abc123',
    updatedAt: '2026-07-12T07:30:00.000Z',
    statusCheckRollup: [run()],
    comments: [],
    ...overrides,
  };
}

function runner() {
  const calls = [];
  return {
    calls,
    async rerunFailedJobs(runId) {
      calls.push(['rerunFailedJobs', runId]);
    },
    async comment(prNumber, body) {
      calls.push(['comment', prNumber, body]);
    },
    async currentHeadSha() {
      return 'abc123';
    },
    async behindBy() {
      return 1;
    },
    async updateBranch(prNumber, headSha) {
      calls.push(['updateBranch', prNumber, headSha]);
    },
  };
}

describe('ci flaky rerun patrol', () => {
  it('selects the newest stale failed PR run', () => {
    expect(selectTarget([pr()], { now: NOW, staleMinutes: 30 })).toMatchObject({
      prNumber: 42,
      headSha: 'abc123',
      runId: 123,
      workflowName: 'E2E Tests',
    });
  });

  it('prefers recent stale failures over ancient failures', () => {
    expect(
      selectTarget(
        [
          pr({
            number: 41,
            headRefOid: 'old',
            statusCheckRollup: [
              run({
                completedAt: '2026-07-10T07:20:00.000Z',
                detailsUrl:
                  'https://github.com/QwenLM/qwen-code/actions/runs/122/jobs/1',
              }),
            ],
          }),
          pr(),
        ],
        { now: NOW, staleMinutes: 30 },
      ),
    ).toMatchObject({
      prNumber: 42,
      runId: 123,
    });
  });

  it('skips fresh, draft, non-main, and already handled PRs', () => {
    const marker = '<!-- qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123 -->';

    expect(
      selectTarget(
        [
          pr({
            statusCheckRollup: [
              run({ completedAt: '2026-07-12T07:45:00.000Z' }),
            ],
          }),
        ],
        { now: NOW, staleMinutes: 30 },
      ),
    ).toBeNull();
    expect(selectTarget([pr({ isDraft: true })], { now: NOW })).toBeNull();
    expect(
      selectTarget([pr({ baseRefName: 'release' })], { now: NOW }),
    ).toBeNull();
    expect(
      selectTarget([pr({ comments: [{ body: marker }] })], { now: NOW }),
    ).toBeNull();
  });

  it('skips PRs that were not active during the patrol window', () => {
    expect(
      selectTarget([pr({ updatedAt: '2026-07-05T07:59:00.000Z' })], {
        now: NOW,
        activeDays: 7,
      }),
    ).toBeNull();
  });

  it('stops after three actions for the same PR head and resets on push', () => {
    const priorActions = [120, 121, 122].map((runId) => ({
      body: `<!-- qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=${runId} -->`,
    }));

    expect(
      selectTarget([pr({ comments: priorActions })], { now: NOW }),
    ).toBeNull();
    expect(
      selectTarget([pr({ headRefOid: 'new-head', comments: priorActions })], {
        now: NOW,
      }),
    ).toMatchObject({ headSha: 'new-head' });
  });

  it('keeps bulk PR scanning light and checks comments after selection', () => {
    expect(script).toContain(
      "'number,isDraft,baseRefName,headRefOid,updatedAt,statusCheckRollup'",
    );
    expect(script).not.toContain(
      "'number,isDraft,baseRefName,headRefOid,updatedAt,statusCheckRollup,comments'",
    );
    expect(script).toContain("'pr',\n        'view'");
    expect(script).toContain("'--search',");
    expect(script).toContain("'--limit',\n        '1000'");
  });

  it('can rank candidates before fetching comments', () => {
    expect(selectCandidateTargets([pr()], { now: NOW })).toMatchObject([
      {
        prNumber: 42,
        runId: 123,
      },
    ]);
  });

  it('reruns once only for high-confidence flaky decisions', async () => {
    const client = runner();
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'rerun',
      confidence: 'high',
      reason_en: 'The log shows a runner network timeout.',
      reason_zh: '日志显示 runner 网络超时。',
    });

    expect(client.calls).toEqual([
      [
        'comment',
        42,
        expect.stringContaining(
          'qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123',
        ),
      ],
      ['rerunFailedJobs', 123],
    ]);
  });

  it('does not rerun when recording the handled marker fails', async () => {
    const client = runner();
    client.comment = async () => {
      throw new Error('comment failed');
    };
    const target = selectTarget([pr()], { now: NOW });

    await expect(
      actOnDecision(client, target, {
        action: 'rerun',
        confidence: 'high',
        reason_en: 'The log shows a runner network timeout.',
        reason_zh: '日志显示 runner 网络超时。',
      }),
    ).rejects.toThrow('comment failed');

    expect(client.calls).toEqual([]);
  });

  it('updates a still-behind branch only for a high-confidence skill decision', async () => {
    const client = runner();
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'update_branch',
      confidence: 'high',
      reason_en: 'This branch needs current main CI configuration.',
      reason_zh: '该分支需要同步 main 的 CI 配置。',
    });

    expect(client.calls).toEqual([
      [
        'comment',
        42,
        expect.stringContaining(
          'qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123',
        ),
      ],
      ['updateBranch', 42, 'abc123'],
    ]);
  });

  it('leaves a bilingual failure explanation when the skill requests a comment', async () => {
    const client = runner();
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'comment',
      confidence: 'high',
      reason_en: 'The i18n check found an extra locale key.',
      reason_zh: 'i18n 检查发现了多余的语言键。',
    });

    expect(client.calls).toEqual([
      [
        'comment',
        42,
        expect.stringContaining('The i18n check found an extra locale key.'),
      ],
    ]);
    expect(client.calls[0][2]).toContain('<details>');
    expect(client.calls[0][2]).toContain('i18n 检查发现了多余的语言键。');
  });

  it('does not update a branch after a new push changes its head', async () => {
    const client = runner();
    client.currentHeadSha = async () => 'new-head';
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'update_branch',
      confidence: 'high',
      reason_en: 'This branch needs current main CI configuration.',
      reason_zh: '该分支需要同步 main 的 CI 配置。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not rerun or comment after a new push changes the head', async () => {
    const client = runner();
    client.currentHeadSha = async () => 'new-head';
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'rerun',
      confidence: 'high',
      reason_en: 'The log shows a runner network timeout.',
      reason_zh: '日志显示 runner 网络超时。',
    });
    await actOnDecision(client, target, {
      action: 'comment',
      confidence: 'high',
      reason_en: 'The i18n check found an extra locale key.',
      reason_zh: 'i18n 检查发现了多余的语言键。',
    });

    expect(client.calls).toEqual([]);
  });

  it('writes target metadata and failed job log for the skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = selectTarget([pr()], { now: NOW });
    try {
      await writeSkillInput(
        {
          async jobLog() {
            return 'network timeout while downloading package';
          },
        },
        target,
        dir,
      );

      expect(
        JSON.parse(readFileSync(join(dir, 'ci-target.json'), 'utf8')),
      ).toMatchObject({
        prNumber: 42,
        runId: 123,
      });
      expect(readFileSync(join(dir, 'ci-log.txt'), 'utf8')).toContain(
        'network timeout',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the end of long job logs so the failure is visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = selectTarget([pr()], { now: NOW });
    try {
      await writeSkillInput(
        {
          async jobLog() {
            return `${'setup log\n'.repeat(3000)}AssertionError: expected true to be false`;
          },
        },
        target,
        dir,
      );

      const log = readFileSync(join(dir, 'ci-log.txt'), 'utf8');
      expect(log.length).toBeLessThanOrEqual(20_000);
      expect(log).toContain('AssertionError');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends only redacted failure lines to the skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = selectTarget([pr()], { now: NOW });
    try {
      await writeSkillInput(
        {
          async jobLog() {
            return [
              'normal setup output',
              'API_TOKEN=secret-value',
              'Errors:',
              'Cookie: session=another-session-secret',
              'Extra key in zh.js (not in en.js): "toolDisplayName.DeferredToolCall"',
              'Error: NODE_AUTH_TOKEN: another-secret',
              'Error: Authorization: Basic c2VjcmV0LWNyZWRlbnRpYWw=',
              'Failure: AWS key AKIAIOSFODNN7EXAMPLE',
              `Failure: xoxb-${'a'.repeat(24)}`,
              `Failure: ghr_${'c'.repeat(24)}`,
              `Failure: sk-proj-${'b'.repeat(32)}`,
              'Error: https://user:password@example.com/path',
              'Error: download timed out with Bearer abcdefghijklmnopqrstuvwxyz',
            ].join('\n');
          },
        },
        target,
        dir,
      );

      const log = readFileSync(join(dir, 'ci-log.txt'), 'utf8');
      expect(log).not.toContain('normal setup output');
      expect(log).toContain('Extra key in zh.js');
      expect(log).not.toContain('secret-value');
      expect(log).not.toContain('another-session-secret');
      expect(log).not.toContain('another-secret');
      expect(log).not.toContain('c2VjcmV0LWNyZWRlbnRpYWw=');
      expect(log).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(log).not.toContain(`xoxb-${'a'.repeat(24)}`);
      expect(log).not.toContain(`ghr_${'c'.repeat(24)}`);
      expect(log).not.toContain(`sk-proj-${'b'.repeat(32)}`);
      expect(log).not.toContain('user:password@');
      expect(log).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(log).toContain('download timed out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rerun low-confidence or non-flaky decisions', async () => {
    const target = selectTarget([pr()], { now: NOW });
    const client = runner();

    await actOnDecision(client, target, {
      action: 'rerun',
      confidence: 'low',
      reason_en: 'unclear',
      reason_zh: '不明确。',
    });
    await actOnDecision(client, target, {
      action: 'no_action',
      confidence: 'high',
      reason_en: 'test assertion failed',
      reason_zh: '测试断言失败。',
    });

    expect(client.calls).toEqual([]);
  });
});
