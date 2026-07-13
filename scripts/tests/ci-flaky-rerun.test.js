import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  actOnDecision,
  actOnDecisions,
  fileSha256,
  fingerprint,
  GhClient,
  resetSuccessfulFailures,
  selectCandidateTargets,
  selectTarget,
  skillLog,
} from '../../.github/scripts/ci-flaky-rerun.mjs';

const NOW = new Date('2026-07-12T08:00:00.000Z');

function run(overrides = {}) {
  return {
    databaseId: 11,
    name: 'E2E Tests',
    workflowName: 'Qwen Code CI',
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
    async mainContext() {
      return {
        behindBy: 2,
        mainHeadSha: 'main123',
        mainCommits: [],
      };
    },
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    action: 'rerun',
    confidence: 'high',
    failureKey: 'test-key',
    reason_en: 'runner timeout',
    reason_zh: 'runner 超时',
    ...overrides,
  };
}

function scannedDecision(overrides = {}) {
  return {
    prNumber: 42,
    headSha: 'abc123',
    runId: 123,
    ...decision({ reason_en: 'x', reason_zh: 'x' }),
    ...overrides,
  };
}

function markerComment(login = 'trusted-patrol-bot') {
  return {
    body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
    createdAt: '2026-07-12T07:20:00.000Z',
    author: { login },
  };
}

const target = () => {
  const t = selectTarget([pr()], { now: NOW });
  return t ? { ...t, failureKey: 'test-key' } : null;
};

describe('ci flaky rerun patrol', () => {
  it('selects stale failed PR runs targeting main', () => {
    expect(selectTarget([pr()], { now: NOW, staleMinutes: 30 })).toMatchObject({
      prNumber: 42,
      runId: 123,
      workflowName: 'Qwen Code CI',
      checkName: 'E2E Tests',
    });
  });

  it('only selects recent current Qwen Code CI failures', () => {
    expect(
      selectCandidateTargets(
        [
          pr({
            statusCheckRollup: [
              run({
                completedAt: '2026-07-01T07:20:00.000Z',
              }),
            ],
          }),
          pr({
            number: 43,
            statusCheckRollup: [run({ workflowName: 'review-pr' })],
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);

    expect(
      selectCandidateTargets(
        [
          pr({
            statusCheckRollup: [
              run(),
              run({
                conclusion: 'SUCCESS',
                completedAt: '2026-07-12T07:30:00.000Z',
              }),
            ],
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);

    expect(
      selectCandidateTargets(
        [
          pr({
            statusCheckRollup: [
              run(),
              run({
                status: 'IN_PROGRESS',
                conclusion: null,
                completedAt: null,
                startedAt: '2026-07-12T07:40:00.000Z',
              }),
            ],
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);
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
    await actOnDecision(c, target(), decision());
    expect(c.calls).toHaveLength(2);
    expect(c.calls[0]).toEqual(['rerunFailedJobs', 123]);
    expect(c.calls[1][0]).toBe('comment');
    expect(c.calls[1][2]).toContain('action=rerun');
    expect(c.calls[1][2]).toContain('runner timeout');
  });

  it('posts a bilingual comment for deterministic failures', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({
        action: 'comment',
        reason_en: 'syntax error in test file',
        reason_zh: '测试文件语法错误',
      }),
    );
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('syntax error in test file');
    expect(c.calls[0][2]).toContain('测试文件语法错误');
    expect(c.calls[0][2]).toContain('<details>');
    expect(c.calls[0][2]).toContain('action=comment');
  });

  it('posts a hidden marker for no_action decisions', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({
        action: 'no_action',
        confidence: 'low',
      }),
    );
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('action=no_action');
    expect(c.calls[0][2]).toMatch(/^<!-- .* -->$/);
  });

  it('rejects unsafe decisions before any GitHub write', async () => {
    for (const unsafe of [
      decision({ action: 'delete_branch' }),
      decision({ confidence: 'low' }),
      decision({ reason_en: 'x'.repeat(201) }),
    ]) {
      const c = client();
      await actOnDecision(c, target(), unsafe);
      expect(c.calls).toEqual([]);
    }
  });

  it('updates a behind branch only while the scanned main head is current', async () => {
    const updateTarget = {
      ...target(),
      behindBy: 2,
      mainHeadSha: 'main123',
    };
    const c = client();
    await actOnDecision(
      c,
      updateTarget,
      decision({ action: 'update_branch', mainHeadSha: 'main123' }),
    );
    expect(c.calls[0]).toEqual(['updateBranch', 42, 'abc123']);
    expect(c.calls[1][0]).toBe('comment');
    expect(c.calls[1][2]).toContain('action=update_branch');

    const changedMain = client({
      mainContext: async () => ({ behindBy: 2, mainHeadSha: 'new-main' }),
    });
    await actOnDecision(
      changedMain,
      updateTarget,
      decision({ action: 'update_branch', mainHeadSha: 'main123' }),
    );
    expect(changedMain.calls).toEqual([]);
  });

  it('hashes the exact classifier input bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const path = join(dir, 'input.json');
    try {
      writeFileSync(path, '{"candidates":[]}\n');
      expect(fileSha256(path)).toMatch(/^[a-f0-9]{64}$/);
      const before = fileSha256(path);
      writeFileSync(path, '{"candidates":[1]}\n');
      expect(fileSha256(path)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('redacts known token prefixes from classifier evidence', () => {
    const log = [
      'ghp_abcdef1234567890',
      'github_pat_abcdef1234567890',
      'glpat-abcdef1234567890',
      'xoxb-abcdef1234567890',
      'npm error request failed',
    ].join('\n');
    const evidence = skillLog(log);
    expect(evidence).toContain('[redacted]');
    expect(evidence).not.toMatch(/abcdef1234567890/);
  });

  it('requires the same live run attempt before acting', async () => {
    const c = new GhClient('QwenLM/qwen-code');
    c.gh = async () =>
      JSON.stringify({
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'abc123',
        run_attempt: 2,
      });
    expect(
      await c.isCurrentFailure({
        ...target(),
        runAttempt: 2,
      }),
    ).toBe(true);
    expect(
      await c.isCurrentFailure({
        ...target(),
        runAttempt: 1,
      }),
    ).toBe(false);
  });

  it('stops after three actions for the same head SHA', async () => {
    const c = client({
      failureActionCount: async (...args) => {
        expect(args).toEqual([42, 'abc123']);
        return 3;
      },
    });
    await actOnDecision(
      c,
      target(),
      decision({
        reason_en: 'timeout',
        reason_zh: '超时',
      }),
    );
    expect(c.calls).toEqual([]);
  });

  it('skips decisions with mismatched failureKey', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({
        failureKey: 'wrong-key',
        reason_en: 'timeout',
        reason_zh: '超时',
      }),
    );
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
      await actOnDecision(
        c,
        target(),
        decision({
          reason_en: 'timeout',
          reason_zh: '超时',
        }),
      );
      expect(c.calls).toEqual([]);
    }
  });

  it('skips when the failure is no longer current', async () => {
    const c = client({ isCurrentFailure: async () => false });
    await actOnDecision(
      c,
      target(),
      decision({
        reason_en: 'timeout',
        reason_zh: '超时',
      }),
    );
    expect(c.calls).toEqual([]);
  });

  it('applies only decisions matching scanned targets', async () => {
    const c = client();
    const targets = [target()];
    await actOnDecisions(c, targets, [
      scannedDecision(),
      scannedDecision({
        prNumber: 99,
        headSha: 'zzz',
        runId: 999,
        failureKey: 'y',
        reason_en: 'must not run',
        reason_zh: '不得执行',
      }),
    ]);
    expect(c.calls.filter((call) => call[0] === 'rerunFailedJobs')).toEqual([
      ['rerunFailedJobs', 123],
    ]);
  });

  it('deduplicates decisions for the same target', async () => {
    const c = client();
    await actOnDecisions(c, [target()], [scannedDecision(), scannedDecision()]);
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
        scannedDecision(),
        scannedDecision({
          prNumber: 43,
          headSha: 'def456',
          runId: 124,
          reason_en: 'y',
          reason_zh: 'y',
        }),
      ],
    );
    expect(c.calls.filter((call) => call[0] === 'rerunFailedJobs')).toEqual([
      ['rerunFailedJobs', 123],
      ['rerunFailedJobs', 124],
    ]);
    expect(c.calls.filter((call) => call[0] === 'comment')).toHaveLength(1);
  });

  it('resets failure counts after a matching check succeeds', async () => {
    const c = client();
    c.trustedMarkerLogin = 'trusted-patrol-bot';
    c.comments = async () => [markerComment()];
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
    c.comments = async () => [markerComment('random-user')];
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

  it('does not reset from a successful check in another workflow', async () => {
    const c = client();
    c.trustedMarkerLogin = 'trusted-patrol-bot';
    c.comments = async () => [markerComment()];
    await resetSuccessfulFailures(c, [
      pr({
        statusCheckRollup: [
          run({
            workflowName: 'review-pr',
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
      return [markerComment()];
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
    const sharedPrefix = 'context '.repeat(200);
    expect(fingerprint(t, `${sharedPrefix}first failure`)).not.toBe(
      fingerprint(t, `${sharedPrefix}second failure`),
    );
  });
});
