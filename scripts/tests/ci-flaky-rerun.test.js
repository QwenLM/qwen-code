/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  actOnDecision,
  selectTarget,
  writeSkillInput,
} from '../../.github/scripts/ci-flaky-rerun.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  };
}

describe('ci flaky rerun patrol', () => {
  it('selects the oldest stale failed PR run', () => {
    expect(selectTarget([pr()], { now: NOW, staleMinutes: 30 })).toMatchObject({
      prNumber: 42,
      headSha: 'abc123',
      runId: 123,
      workflowName: 'E2E Tests',
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

  it('reruns once only for high-confidence flaky decisions', async () => {
    const client = runner();
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      flaky: true,
      confidence: 'high',
      reason: 'The log shows a runner network timeout.',
    });

    expect(client.calls).toEqual([
      ['rerunFailedJobs', 123],
      [
        'comment',
        42,
        expect.stringContaining(
          'qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123',
        ),
      ],
    ]);
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

  it('does not rerun low-confidence or non-flaky decisions', async () => {
    const target = selectTarget([pr()], { now: NOW });
    const client = runner();

    await actOnDecision(client, target, {
      flaky: true,
      confidence: 'low',
      reason: 'unclear',
    });
    await actOnDecision(client, target, {
      flaky: false,
      confidence: 'high',
      reason: 'test assertion failed',
    });

    expect(client.calls).toEqual([]);
  });
});
