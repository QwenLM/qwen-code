import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import {
  actOnDecision,
  actOnDecisions,
  fingerprint,
  resetSuccessfulFailures,
  selectTarget,
} from '../../.github/scripts/ci-flaky-rerun.mjs';

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

function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    trustedMarkerLogin: 'trusted-patrol-bot',
    async rerunFailedJobs(runId) {
      calls.push(['rerunFailedJobs', runId]);
    },
    async comment(prNumber, body) {
      calls.push(['comment', prNumber, body]);
    },
    async updateBranch(prNumber, headSha) {
      calls.push(['updateBranch', prNumber, headSha]);
    },
    async currentPr(prNumber) {
      return {
        state: 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        headRefOid: prNumber === 43 ? 'def456' : 'abc123',
      };
    },
    async isCurrentFailure() {
      return true;
    },
    async failureActionCount() {
      return 0;
    },
    ...overrides,
  };
}

const target = () => {
  const t = selectTarget([pr()], { now: NOW });
  return t ? { ...t, failureKey: 'test-key' } : null;
};

describe('ci flaky rerun patrol', () => {
  it('rejects invalid commands', () => {
    expect(() =>
      execFileSync('node', ['.github/scripts/ci-flaky-rerun.mjs', 'invalid'], {
        encoding: 'utf8',
      }),
    ).toThrow(/command must be scan, act, or reset/);
  });

  it('requires --repo and --workdir', () => {
    expect(() =>
      execFileSync(
        'node',
        ['.github/scripts/ci-flaky-rerun.mjs', 'scan', '--workdir', '/tmp'],
        { encoding: 'utf8' },
      ),
    ).toThrow(/--repo is required/);
    expect(() =>
      execFileSync(
        'node',
        ['.github/scripts/ci-flaky-rerun.mjs', 'act', '--repo', 'x'],
        { encoding: 'utf8' },
      ),
    ).toThrow(/--workdir is required/);
  });

  it('selects stale failed PR runs targeting main', () => {
    expect(selectTarget([pr()], { now: NOW, staleMinutes: 30 })).toMatchObject({
      prNumber: 42,
      runId: 123,
      workflowName: 'E2E Tests',
    });
  });

  it('skips fresh, draft, non-main, and already handled PRs', () => {
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
      selectTarget(
        [
          pr({
            comments: [
              {
                body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=123 attempt=1 action=rerun key=x check=E2E%20Tests count=1 -->',
                author: { login: 'trusted-patrol-bot' },
              },
            ],
          }),
        ],
        { now: NOW, trustedMarkerLogins: ['trusted-patrol-bot'] },
      ),
    ).toBeNull();
  });

  it('prioritizes the newest stale failure', () => {
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
    ).toMatchObject({ prNumber: 42, runId: 123 });
  });

  it('does not trust markers from unrecognized accounts', () => {
    expect(
      selectTarget(
        [
          pr({
            comments: [
              {
                body: '<!-- qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123 -->',
                author: { login: 'untrusted-user' },
              },
            ],
          }),
        ],
        { now: NOW, trustedMarkerLogins: ['trusted-patrol-bot'] },
      ),
    ).toMatchObject({ prNumber: 42, runId: 123 });
  });

  it('reruns failed jobs and posts a marker for valid decisions', async () => {
    const c = client();
    await actOnDecision(c, target(), {
      action: 'rerun',
      failureKey: 'test-key',
      reason_en: 'runner timeout',
      reason_zh: 'runner 超时',
    });
    expect(c.calls).toHaveLength(2);
    expect(c.calls[0][0]).toBe('comment');
    expect(c.calls[0][2]).toContain('action=rerun');
    expect(c.calls[0][2]).toContain('runner timeout');
    expect(c.calls[1]).toEqual(['rerunFailedJobs', 123]);
  });

  it('posts a bilingual comment for deterministic failures', async () => {
    const c = client();
    await actOnDecision(c, target(), {
      action: 'comment',
      failureKey: 'test-key',
      reason_en: 'syntax error in test file',
      reason_zh: '测试文件语法错误',
    });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('syntax error in test file');
    expect(c.calls[0][2]).toContain('测试文件语法错误');
    expect(c.calls[0][2]).toContain('<details>');
    expect(c.calls[0][2]).toContain('action=comment');
  });

  it('posts a hidden marker for no_action decisions', async () => {
    const c = client();
    await actOnDecision(c, target(), {
      action: 'no_action',
      failureKey: 'test-key',
    });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('action=no_action');
    expect(c.calls[0][2]).toMatch(/^<!-- .* -->$/);
  });

  it('stops after three actions for the same failure key', async () => {
    const c = client({ failureActionCount: async () => 3 });
    await actOnDecision(c, target(), {
      action: 'rerun',
      failureKey: 'test-key',
      reason_en: 'timeout',
      reason_zh: '超时',
    });
    expect(c.calls).toEqual([]);
  });

  it('skips decisions with mismatched failureKey', async () => {
    const c = client();
    await actOnDecision(c, target(), {
      action: 'rerun',
      failureKey: 'wrong-key',
      reason_en: 'timeout',
      reason_zh: '超时',
    });
    expect(c.calls).toEqual([]);
  });

  it('skips when the PR is closed, draft, or retargeted', async () => {
    for (const currentPr of [
      {
        state: 'CLOSED',
        isDraft: false,
        baseRefName: 'main',
        headRefOid: 'abc123',
      },
      {
        state: 'OPEN',
        isDraft: true,
        baseRefName: 'main',
        headRefOid: 'abc123',
      },
      {
        state: 'OPEN',
        isDraft: false,
        baseRefName: 'release',
        headRefOid: 'abc123',
      },
      {
        state: 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        headRefOid: 'new-head',
      },
    ]) {
      const c = client({ currentPr: async () => currentPr });
      await actOnDecision(c, target(), {
        action: 'rerun',
        failureKey: 'test-key',
        reason_en: 'timeout',
        reason_zh: '超时',
      });
      expect(c.calls).toEqual([]);
    }
  });

  it('skips when the failure is no longer current', async () => {
    const c = client({ isCurrentFailure: async () => false });
    await actOnDecision(c, target(), {
      action: 'rerun',
      failureKey: 'test-key',
      reason_en: 'timeout',
      reason_zh: '超时',
    });
    expect(c.calls).toEqual([]);
  });

  it('applies only decisions matching scanned targets', async () => {
    const c = client();
    const targets = [target()];
    await actOnDecisions(c, targets, [
      {
        prNumber: 42,
        headSha: 'abc123',
        runId: 123,
        action: 'rerun',
        failureKey: 'test-key',
        reason_en: 'x',
        reason_zh: 'x',
      },
      {
        prNumber: 99,
        headSha: 'zzz',
        runId: 999,
        action: 'rerun',
        failureKey: 'y',
        reason_en: 'must not run',
        reason_zh: '不得执行',
      },
    ]);
    expect(c.calls.filter((call) => call[0] === 'rerunFailedJobs')).toEqual([
      ['rerunFailedJobs', 123],
    ]);
  });

  it('deduplicates decisions for the same target', async () => {
    const c = client();
    await actOnDecisions(
      c,
      [target()],
      [
        {
          prNumber: 42,
          headSha: 'abc123',
          runId: 123,
          action: 'rerun',
          failureKey: 'test-key',
          reason_en: 'x',
          reason_zh: 'x',
        },
        {
          prNumber: 42,
          headSha: 'abc123',
          runId: 123,
          action: 'rerun',
          failureKey: 'test-key',
          reason_en: 'x',
          reason_zh: 'x',
        },
      ],
    );
    expect(c.calls.filter((call) => call[0] === 'rerunFailedJobs')).toEqual([
      ['rerunFailedJobs', 123],
    ]);
  });

  it('continues applying later decisions after one fails', async () => {
    const c = client();
    c.rerunFailedJobs = async (runId) => {
      c.calls.push(['rerunFailedJobs', runId]);
      if (runId === 123) throw new Error('temporary gh failure');
    };
    const t2 = { ...target(), prNumber: 43, headSha: 'def456', runId: 124 };
    await actOnDecisions(
      c,
      [target(), t2],
      [
        {
          prNumber: 42,
          headSha: 'abc123',
          runId: 123,
          action: 'rerun',
          failureKey: 'test-key',
          reason_en: 'x',
          reason_zh: 'x',
        },
        {
          prNumber: 43,
          headSha: 'def456',
          runId: 124,
          action: 'rerun',
          failureKey: 'test-key',
          reason_en: 'y',
          reason_zh: 'y',
        },
      ],
    );
    expect(c.calls.filter((call) => call[0] === 'rerunFailedJobs')).toEqual([
      ['rerunFailedJobs', 123],
      ['rerunFailedJobs', 124],
    ]);
  });

  it('resets failure counts after a matching check succeeds', async () => {
    const c = client();
    c.trustedMarkerLogin = 'trusted-patrol-bot';
    c.comments = async () => [
      {
        body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
        createdAt: '2026-07-12T07:20:00.000Z',
        author: { login: 'trusted-patrol-bot' },
      },
    ];
    await resetSuccessfulFailures(c, [
      pr({
        statusCheckRollup: [
          run({
            conclusion: 'SUCCESS',
            completedAt: '2026-07-12T07:30:00.000Z',
          }),
        ],
      }),
    ]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('action=reset');
    expect(c.calls[0][2]).toContain('count=0');
  });

  it('ignores reset markers from untrusted accounts', async () => {
    const c = client();
    c.trustedMarkerLogin = 'trusted-patrol-bot';
    c.comments = async () => [
      {
        body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
        createdAt: '2026-07-12T07:20:00.000Z',
        author: { login: 'random-user' },
      },
    ];
    await resetSuccessfulFailures(c, [
      pr({
        statusCheckRollup: [
          run({
            conclusion: 'SUCCESS',
            completedAt: '2026-07-12T07:30:00.000Z',
          }),
        ],
      }),
    ]);
    expect(c.calls).toEqual([]);
  });

  it('continues resetting after one PR fails', async () => {
    const c = client();
    c.trustedMarkerLogin = 'trusted-patrol-bot';
    c.comments = async (prNumber) => {
      if (prNumber === 41) throw new Error('temporary failure');
      return [
        {
          body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
          createdAt: '2026-07-12T07:20:00.000Z',
          author: { login: 'trusted-patrol-bot' },
        },
      ];
    };
    await resetSuccessfulFailures(c, [
      pr({ number: 41 }),
      pr({
        statusCheckRollup: [
          run({
            conclusion: 'SUCCESS',
            completedAt: '2026-07-12T07:30:00.000Z',
          }),
        ],
      }),
    ]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('action=reset');
  });

  it('normalizes failure fingerprints deterministically', () => {
    const t = target();
    if (!t) throw new Error('target is null');
    expect(fingerprint(t, 'Error: 0x1a2b3c4d at line 123')).toBe(
      fingerprint(t, 'error: 0xdeadbeef at line 456'),
    );
    expect(fingerprint(t, 'Error: timeout')).toBe(
      fingerprint(t, 'Error: timeout'),
    );
    expect(fingerprint(t, 'Error: timeout')).not.toBe(
      fingerprint({ ...t, workflowName: 'Lint' }, 'Error: timeout'),
    );
  });
});
