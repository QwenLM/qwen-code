import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  actOnDecision,
  actOnDecisions,
  alreadyHandled,
  fileSha256,
  fingerprint,
  GhClient,
  recoverPendingActions,
  resetSuccessfulFailures,
  selectCandidateTargets,
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
        mainRunId: 1001,
        mainWorkflowId: 2001,
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

function pendingMarkerComment(action = 'rerun', mainHeadSha = '-') {
  return {
    body: `<!-- qwen-ci-flaky-rerun v=3 pr=42 head=abc123 run=123 attempt=1 action=${action} state=pending key=test-key check=E2E%20Tests count=1 main=${mainHeadSha} -->`,
    createdAt: '2026-07-12T07:20:00.000Z',
    author: { login: 'trusted-patrol-bot' },
  };
}

const target = () => {
  const t = selectCandidateTargets([pr()], { now: NOW })[0];
  return t ? { ...t, failureKey: 'test-key' } : null;
};

describe('ci flaky rerun patrol', () => {
  it('selects stale failed PR runs targeting main', () => {
    expect(
      selectCandidateTargets([pr()], { now: NOW, staleMinutes: 30 })[0],
    ).toMatchObject({
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
      selectCandidateTargets(
        [
          pr({
            statusCheckRollup: [
              run({ completedAt: '2026-07-12T07:45:00.000Z' }),
            ],
          }),
        ],
        { now: NOW, staleMinutes: 30 },
      ),
    ).toEqual([]);
    expect(
      selectCandidateTargets([pr({ isDraft: true })], { now: NOW }),
    ).toEqual([]);
    expect(
      selectCandidateTargets([pr({ baseRefName: 'release' })], { now: NOW }),
    ).toEqual([]);
    const handledPr = pr({
      comments: [
        {
          body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=123 attempt=1 action=rerun key=x check=E2E%20Tests count=1 -->',
          author: { login: 'trusted-patrol-bot' },
        },
      ],
    });
    expect(
      alreadyHandled(
        handledPr,
        selectCandidateTargets([handledPr], { now: NOW })[0],
        { trustedMarkerLogins: ['trusted-patrol-bot'] },
      ),
    ).toBe(true);
  });

  it('prioritizes the oldest PR while keeping its newest failure', () => {
    expect(
      selectCandidateTargets(
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
      )[0],
    ).toMatchObject({ prNumber: 41, runId: 122 });
  });

  it('does not select an older failure while a newer check is queued', () => {
    expect(
      selectCandidateTargets(
        [
          pr({
            statusCheckRollup: [
              run({ databaseId: undefined }),
              run({
                databaseId: undefined,
                status: 'QUEUED',
                conclusion: null,
                startedAt: null,
                completedAt: null,
                detailsUrl:
                  'https://github.com/QwenLM/qwen-code/actions/runs/124/jobs/2',
              }),
            ],
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it('does not trust markers from unrecognized accounts', () => {
    expect(
      alreadyHandled(
        pr({
          comments: [
            {
              body: '<!-- qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123 -->',
              author: { login: 'untrusted-user' },
            },
          ],
        }),
        target(),
        { trustedMarkerLogins: ['trusted-patrol-bot'] },
      ),
    ).toBe(false);
  });

  it('reruns failed jobs and posts a marker for valid decisions', async () => {
    const c = client();
    await actOnDecision(c, target(), decision());
    expect(c.calls).toHaveLength(3);
    expect(c.calls[0][0]).toBe('comment');
    expect(c.calls[0][2]).toContain('state=pending');
    expect(c.calls[1]).toEqual(['rerunFailedJobs', 123]);
    expect(c.calls[2][0]).toBe('comment');
    expect(c.calls[2][2]).toContain('state=completed');
    expect(c.calls[2][2]).toContain('runner timeout');
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

  it('records unsafe decisions as no_action after freshness checks', async () => {
    for (const unsafe of [
      decision({ action: 'delete_branch' }),
      decision({ confidence: 'low' }),
      decision({ reason_en: 'x'.repeat(201) }),
    ]) {
      const c = client();
      await actOnDecision(c, target(), unsafe);
      expect(c.calls).toHaveLength(1);
      expect(c.calls[0][0]).toBe('comment');
      expect(c.calls[0][2]).toContain('state=no_action');
    }
  });

  it('updates a behind branch only while the scanned main head is current', async () => {
    const updateTarget = {
      ...target(),
      behindBy: 2,
      mainHeadSha: 'main123',
      mainRunId: 1001,
      mainWorkflowId: 2001,
    };
    const c = client();
    await actOnDecision(
      c,
      updateTarget,
      decision({ action: 'update_branch', mainHeadSha: 'main123' }),
    );
    expect(c.calls[0][2]).toContain('state=pending');
    expect(c.calls[1]).toEqual(['updateBranch', 42, 'abc123']);
    expect(c.calls[2][2]).toContain('state=completed');

    const changedMain = client({
      mainContext: async () => ({
        behindBy: 2,
        mainHeadSha: 'new-main',
        mainRunId: 1002,
        mainWorkflowId: 2001,
      }),
    });
    await actOnDecision(
      changedMain,
      updateTarget,
      decision({ action: 'update_branch', mainHeadSha: 'main123' }),
    );
    expect(changedMain.calls).toHaveLength(1);
    expect(changedMain.calls[0][2]).toContain('state=no_action');
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

  it('reads verified-green main evidence from the production API shape', async () => {
    const c = new GhClient('QwenLM/qwen-code');
    c.gh = async (args) => {
      const path = args[1];
      if (path.includes('/compare/')) {
        return JSON.stringify({
          ahead_by: 2,
          commits: [{ sha: 'fix1', commit: { message: 'fix test\nbody' } }],
        });
      }
      if (path.includes('/commits/main')) return 'main123\n';
      return JSON.stringify({
        workflow_runs: [
          {
            id: 1001,
            workflow_id: 2001,
            name: 'Qwen Code CI',
            head_sha: 'main123',
            conclusion: 'success',
          },
        ],
      });
    };
    await expect(c.mainContext('abc123')).resolves.toMatchObject({
      behindBy: 2,
      mainHeadSha: 'main123',
      mainRunId: 1001,
      mainWorkflowId: 2001,
      mainCommits: [{ sha: 'fix1', message: 'fix test' }],
    });
  });

  it('recovers a rerun only after the live attempt advances', async () => {
    const c = client({
      comments: async () => [pendingMarkerComment()],
      run: async () => ({ run_attempt: 2 }),
    });
    await recoverPendingActions(c, [pr()]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('action=rerun state=completed');

    const ambiguous = client({
      comments: async () => [pendingMarkerComment()],
      run: async () => ({ run_attempt: 1 }),
    });
    await recoverPendingActions(ambiguous, [pr()]);
    expect(ambiguous.calls).toEqual([]);
  });

  it('recovers update_branch only from a verified merge commit', async () => {
    const c = client({
      comments: async () => [pendingMarkerComment('update_branch', 'main123')],
      wasBranchUpdated: async (...args) => {
        expect(args).toEqual([42, 'abc123', 'main123']);
        return true;
      },
    });
    await recoverPendingActions(c, [pr()]);
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('action=update_branch state=completed');
  });

  it('allows the last action before stopping at the head limit', async () => {
    const allowed = client({ failureActionCount: async () => 2 });
    await actOnDecision(allowed, target(), decision());
    expect(allowed.calls.some((call) => call[0] === 'rerunFailedJobs')).toBe(
      true,
    );

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
    expect(c.calls).toEqual([
      expect.arrayContaining(['comment', 42]),
      ['rerunFailedJobs', 123],
      expect.arrayContaining(['comment', 42]),
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
    expect(c.calls.filter((call) => call[0] === 'comment')).toHaveLength(3);
  });

  it('continues after a malformed decision entry', async () => {
    const c = client();
    await actOnDecisions(c, [target()], [null, scannedDecision()]);
    expect(c.calls.some((call) => call[0] === 'rerunFailedJobs')).toBe(true);
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
    expect(c.calls[0][0]).toBe('comment');
    expect(c.calls[0][1]).toBe(42);
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

  it('does not reset current-head state from an old-head marker', async () => {
    const c = client();
    c.comments = async () => [
      {
        ...markerComment(),
        body: markerComment().body.replace('head=abc123', 'head=old-head'),
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
      fingerprint({ ...t, checkName: 'Lint' }, 'Error: timeout'),
    );
    const sharedPrefix = 'context '.repeat(200);
    expect(fingerprint(t, `${sharedPrefix}first failure`)).not.toBe(
      fingerprint(t, `${sharedPrefix}second failure`),
    );
  });

  it('rejects invalid numeric controls before GitHub access', () => {
    const script = join(process.cwd(), '.github/scripts/ci-flaky-rerun.mjs');
    for (const [flag, value] of [
      ['--active-days', '-1'],
      ['--stale-minutes', '1.5'],
      ['--max-candidates', 'Infinity'],
    ]) {
      const result = spawnSync(
        process.execPath,
        [
          script,
          'scan',
          '--repo',
          'QwenLM/qwen-code',
          '--workdir',
          tmpdir(),
          flag,
          value,
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must be a positive integer');
    }
  });

  it('rejects modified classifier input before GitHub access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-act-'));
    try {
      writeFileSync(join(dir, 'ci-flaky-input.json'), '{"candidates":[]}\n');
      writeFileSync(join(dir, 'ci-flaky-decisions.json'), '{"decisions":[]}\n');
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), '.github/scripts/ci-flaky-rerun.mjs'),
          'act',
          '--repo',
          'QwenLM/qwen-code',
          '--workdir',
          dir,
          '--input-sha',
          'modified',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('integrity check failed');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
