import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  actOnDecision,
  actOnDecisions,
  alreadyHandled,
  argsMap,
  currentActionCount,
  fileSha256,
  fingerprint,
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
    startedAt: '2026-07-12T07:10:00.000Z',
    completedAt: '2026-07-12T07:20:00.000Z',
    detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/123/job/1',
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
    ...overrides,
  };
}

function target(overrides = {}) {
  return {
    ...selectCandidateTargets([pr()], { now: NOW })[0],
    runAttempt: 2,
    failureKey: 'check-0123456789abcdef',
    actionCount: 0,
    behindBy: 2,
    mainHeadSha: 'main123',
    mainCommits: [],
    ...overrides,
  };
}

function decision(overrides = {}) {
  const t = target();
  return {
    prNumber: t.prNumber,
    headSha: t.headSha,
    runId: t.runId,
    runAttempt: t.runAttempt,
    failureKey: t.failureKey,
    action: 'rerun',
    confidence: 'high',
    reason_en: 'runner timeout',
    reason_zh: 'runner 超时',
    ...overrides,
  };
}

function markerComment(overrides = {}) {
  return {
    body: '<!-- qwen-ci-flaky-rerun v=5 pr=42 head=abc123 run=123 attempt=2 workflow=Qwen%20Code%20CI check=E2E%20Tests action=rerun key=check-0123456789abcdef count=2 -->',
    createdAt: '2026-07-12T07:25:00.000Z',
    author: { login: 'patrol-bot' },
    ...overrides,
  };
}

function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    trustedMarkerLogin: 'patrol-bot',
    async currentPr() {
      return { ...pr(), state: 'OPEN' };
    },
    async comments() {
      return [];
    },
    async run() {
      return {
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'abc123',
        run_attempt: 2,
      };
    },
    async mainContext() {
      calls.push(['mainContext', 'abc123']);
      return { behindBy: 2, mainHeadSha: 'main123', mainCommits: [] };
    },
    async rerunFailedJobs(...args) {
      calls.push(['rerunFailedJobs', ...args]);
    },
    async updateBranch(...args) {
      calls.push(['updateBranch', ...args]);
    },
    async comment(...args) {
      calls.push(['comment', ...args]);
    },
    ...overrides,
  };
}

describe('ci flaky rerun patrol', () => {
  it('selects only recent stale current Qwen Code CI failures', () => {
    const selected = selectCandidateTargets(
      [
        pr({
          statusCheckRollup: [
            run(),
            run({
              databaseId: 12,
              status: 'IN_PROGRESS',
              conclusion: null,
              completedAt: null,
              startedAt: '2026-07-12T07:40:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/124/job/2',
            }),
          ],
        }),
        pr({
          number: 43,
          headRefOid: 'def456',
          statusCheckRollup: [
            run({
              databaseId: 13,
              conclusion: 'TIMED_OUT',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/125/job/3',
            }),
          ],
        }),
        pr({
          number: 44,
          statusCheckRollup: [run({ completedAt: '2026-07-01T07:20:00.000Z' })],
        }),
        pr({ number: 45, isDraft: true }),
        pr({ number: 46, baseRefName: 'release' }),
        pr({
          number: 47,
          statusCheckRollup: [run({ workflowName: 'Review PR' })],
        }),
      ],
      { now: NOW, staleMinutes: 30, activeDays: 7 },
    );

    expect(selected).toEqual([
      expect.objectContaining({ prNumber: 43, runId: 125, jobId: 3 }),
    ]);
  });

  it('orders the newest eligible failures first', () => {
    const selected = selectCandidateTargets(
      [
        pr({
          number: 41,
          statusCheckRollup: [
            run({
              completedAt: '2026-07-12T06:00:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/121/job/1',
            }),
          ],
        }),
        pr(),
      ],
      { now: NOW },
    );
    expect(selected.map((item) => item.prNumber)).toEqual([42, 41]);
  });

  it('keeps distinct failures from the same PR available for scanning', () => {
    const selected = selectCandidateTargets(
      [
        pr({
          statusCheckRollup: [
            run(),
            run({
              databaseId: 12,
              name: 'Unit Tests',
              completedAt: '2026-07-12T07:25:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/124/job/2',
            }),
          ],
        }),
      ],
      { now: NOW },
    );

    expect(selected.map((item) => item.checkName)).toEqual([
      'Unit Tests',
      'E2E Tests',
    ]);
  });

  it('rejects a command-line flag without a value', () => {
    expect(() => argsMap(['--repo'])).toThrow('unexpected argument: --repo');
  });

  it('handles an exact run attempt once and allows a new attempt', () => {
    const comments = [markerComment()];
    expect(alreadyHandled(comments, target(), 'patrol-bot')).toBe(true);
    expect(
      alreadyHandled(comments, target({ runAttempt: 3 }), 'patrol-bot'),
    ).toBe(false);
    expect(alreadyHandled(comments, target(), 'someone-else')).toBe(false);
  });

  it('counts actions per head and resets after the handled check succeeds', () => {
    const comments = [markerComment()];
    expect(currentActionCount(pr(), comments, 'patrol-bot')).toBe(2);
    expect(
      currentActionCount(
        pr({
          statusCheckRollup: [
            run({
              conclusion: 'SUCCESS',
              completedAt: '2026-07-12T07:30:00.000Z',
            }),
          ],
        }),
        comments,
        'patrol-bot',
      ),
    ).toBe(0);
    expect(
      currentActionCount(
        pr({ headRefOid: 'new-head' }),
        comments,
        'patrol-bot',
      ),
    ).toBe(0);
  });

  it('reruns before recording the hidden action marker', async () => {
    const c = client();
    await actOnDecision(c, target(), decision());
    expect(c.calls).toEqual([
      ['rerunFailedJobs', 123],
      ['comment', 42, expect.stringMatching(/^<!-- .*action=rerun.* -->$/)],
    ]);
  });

  it('updates a behind branch only while the scanned main head is current', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({ action: 'update_branch', mainHeadSha: 'main123' }),
    );
    expect(c.calls).toEqual([
      ['mainContext', 'abc123'],
      ['updateBranch', 42, 'abc123'],
      [
        'comment',
        42,
        expect.stringMatching(/^<!-- .*action=update_branch.* -->$/),
      ],
    ]);

    const changedMain = client({
      async mainContext() {
        return { behindBy: 2, mainHeadSha: 'new-main', mainCommits: [] };
      },
    });
    await actOnDecision(
      changedMain,
      target(),
      decision({ action: 'update_branch', mainHeadSha: 'main123' }),
    );
    expect(changedMain.calls).toEqual([]);
  });

  it('posts deterministic failures in English with folded Chinese', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({
        action: 'comment',
        reason_en: 'TypeScript cannot resolve the imported module.',
        reason_zh: 'TypeScript 无法解析导入模块。',
      }),
    );
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0][2]).toContain('TypeScript cannot resolve');
    expect(c.calls[0][2]).toContain('<details>');
    expect(c.calls[0][2]).toContain('TypeScript 无法解析');
    expect(c.calls[0][2]).toContain('action=comment');
  });

  it('records no_action without a visible comment', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({ action: 'no_action', confidence: 'low' }),
    );
    expect(c.calls).toEqual([
      ['comment', 42, expect.stringMatching(/^<!-- .*action=no_action.* -->$/)],
    ]);
  });

  it('rejects malformed, unsafe, or mismatched decisions', async () => {
    for (const invalid of [
      null,
      {},
      decision({ action: 'delete_branch' }),
      decision({ confidence: 'low' }),
      decision({ failureKey: 'wrong-key' }),
      decision({ runAttempt: 3 }),
      decision({ reason_en: 'x'.repeat(201) }),
    ]) {
      const c = client();
      await actOnDecision(c, target(), invalid);
      expect(c.calls).toEqual([]);
    }
  });

  it('neutralizes mentions and markup copied into visible reasons', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({
        action: 'comment',
        reason_en: '@qwen-maintainers <script>alert(1)</script>',
        reason_zh: '@全体成员 </details>',
      }),
    );
    expect(c.calls[0][2]).toContain('@\u200bqwen-maintainers');
    expect(c.calls[0][2]).toContain('&lt;script&gt;');
    expect(c.calls[0][2]).toContain('@\u200b全体成员 &lt;/details&gt;');
  });

  it('stops after three actions on the same head', async () => {
    const c = client({
      async comments() {
        return [
          markerComment({
            body: markerComment().body.replace('count=2', 'count=3'),
          }),
        ];
      },
    });
    await actOnDecision(c, target(), decision());
    expect(c.calls).toEqual([]);
  });

  it('does nothing when the PR or failure is no longer current', async () => {
    const cases = [
      client({
        async currentPr() {
          return { ...pr(), state: 'CLOSED' };
        },
      }),
      client({
        async currentPr() {
          return { ...pr(), state: 'OPEN', headRefOid: 'new-head' };
        },
      }),
      client({
        async run() {
          return {
            status: 'completed',
            conclusion: 'success',
            head_sha: 'abc123',
            run_attempt: 2,
          };
        },
      }),
    ];
    for (const c of cases) {
      await actOnDecision(c, target(), decision());
      expect(c.calls).toEqual([]);
    }
  });

  it('applies a bounded batch independently and deduplicates decisions', async () => {
    const c = client({
      async rerunFailedJobs(runId) {
        c.calls.push(['rerunFailedJobs', runId]);
        if (runId === 123) throw new Error('temporary API failure');
      },
      async currentPr(prNumber) {
        return {
          ...pr({
            number: prNumber,
            headRefOid: prNumber === 42 ? 'abc123' : 'def456',
            statusCheckRollup: [
              run({
                detailsUrl: `https://github.com/QwenLM/qwen-code/actions/runs/${prNumber === 42 ? 123 : 124}/job/1`,
              }),
            ],
          }),
          state: 'OPEN',
        };
      },
      async run(runId) {
        return {
          status: 'completed',
          conclusion: 'failure',
          head_sha: runId === 123 ? 'abc123' : 'def456',
          run_attempt: 2,
        };
      },
    });
    const second = target({ prNumber: 43, headSha: 'def456', runId: 124 });
    const secondDecision = decision({
      prNumber: 43,
      headSha: 'def456',
      runId: 124,
    });
    await actOnDecisions(
      c,
      [target(), second],
      [decision(), decision(), secondDecision],
    );
    expect(c.calls.filter((call) => call[0] === 'rerunFailedJobs')).toEqual([
      ['rerunFailedJobs', 123],
      ['rerunFailedJobs', 124],
    ]);
    expect(c.calls.filter((call) => call[0] === 'comment')).toHaveLength(1);
  });

  it('persists a zero-count reset marker after success', async () => {
    const c = client({
      async comments() {
        return [markerComment()];
      },
    });
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
    expect(c.calls).toEqual([
      [
        'comment',
        42,
        expect.stringMatching(/^<!-- .*action=reset.*count=0.* -->$/),
      ],
    ]);
  });

  it('hashes classifier inputs and fingerprints failures deterministically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const path = join(dir, 'input.json');
    try {
      writeFileSync(path, '{"candidates":[]}\n');
      const before = fileSha256(path);
      writeFileSync(path, '{"candidates":[1]}\n');
      expect(fileSha256(path)).not.toBe(before);
    } finally {
      rmSync(dir, { recursive: true });
    }
    expect(fingerprint(target(), 'Error 123 at deadbeef')).toBe(
      fingerprint(target(), 'error 456 at cafebabe'),
    );
    expect(fingerprint(target(), 'timeout')).not.toBe(
      fingerprint(target({ checkName: 'Lint' }), 'timeout'),
    );
  });

  it('bounds and redacts untrusted classifier evidence', () => {
    const evidence = skillLog(
      [
        '-----BEGIN PRIVATE KEY-----',
        'private-material',
        '-----END PRIVATE KEY-----',
        'Authorization: Bearer bearer-secret',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signaturevalue',
        'ghp_abcdef1234567890',
        'TypeError: ensureTool is not a function',
        ...Array.from({ length: 220 }, (_, index) => `line-${index}`),
        'x'.repeat(600),
      ].join('\n'),
    );
    const lines = evidence.split('\n');
    expect(lines.length).toBeLessThanOrEqual(200);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      500,
    );
    expect(evidence).not.toContain('private-material');
    expect(evidence).not.toContain('bearer-secret');
    expect(evidence).not.toContain('eyJhbGci');
    expect(evidence).not.toContain('abcdef1234567890');
    expect(evidence).toContain('TypeError: ensureTool is not a function');
  });

  it('keeps the failure summary when later tests log expected errors', () => {
    const evidence = skillLog(
      [
        'Failed Tests 1',
        'FAIL toolFormatting.test.ts > translates every tool',
        "AssertionError: expected ['deferred_tool_call'] to deeply equal []",
        ...Array.from(
          { length: 200 },
          () => 'TypeError: fetch failed (expected by this passing test)',
        ),
        'Cleaning up orphan processes',
      ].join('\n'),
    );
    expect(evidence).toContain("expected ['deferred_tool_call']");
  });
});
