import { describe, expect, it } from 'vitest';

import {
  actOnDecision,
  alreadyHandled,
  selectCandidateTargets,
  skillLog,
} from '../../.github/scripts/ci-flaky-rerun.mjs';

const NOW = new Date('2026-07-12T08:00:00.000Z');

function run(overrides = {}) {
  return {
    name: 'E2E Tests',
    workflowName: 'Qwen Code CI',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
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
    ...overrides,
  };
}

function client(overrides = {}) {
  const calls = [];
  return {
    calls,
    async currentPr() {
      return { ...pr(), state: 'OPEN' };
    },
    async run() {
      return {
        status: 'completed',
        conclusion: 'failure',
        head_sha: 'abc123',
        run_attempt: 2,
      };
    },
    async comment(...args) {
      calls.push(['comment', ...args]);
    },
    async rerunFailedJobs(...args) {
      calls.push(['rerunFailedJobs', ...args]);
    },
    ...overrides,
  };
}

describe('ci flaky rerun patrol', () => {
  it('selects only the latest stale Qwen Code CI failure', () => {
    const selected = selectCandidateTargets(
      [
        pr({
          statusCheckRollup: [
            run({
              conclusion: 'TIMED_OUT',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/122/job/1',
            }),
            run({
              status: 'QUEUED',
              conclusion: null,
              completedAt: null,
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
              conclusion: 'TIMED_OUT',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/125/job/3',
            }),
          ],
        }),
      ],
      { now: NOW },
    );

    expect(selected).toEqual([
      expect.objectContaining({ prNumber: 43, runId: 125, jobId: 3 }),
    ]);
  });

  it('skips fresh, draft, non-main, and unrelated workflow checks', () => {
    expect(
      selectCandidateTargets(
        [
          pr({ isDraft: true }),
          pr({ baseRefName: 'release' }),
          pr({
            statusCheckRollup: [
              run({ completedAt: '2026-07-12T07:45:00.000Z' }),
            ],
          }),
          pr({
            statusCheckRollup: [run({ workflowName: 'Review PR' })],
          }),
        ],
        { now: NOW },
      ),
    ).toEqual([]);
  });

  it('trusts handled markers by head and exact workflow/check', () => {
    const t = target();
    const marker =
      '<!-- qwen-ci-flaky-rerun v=4 pr=42 head=abc123 workflow=Qwen%20Code%20CI check=E2E%20Tests -->';
    const comments = [{ body: marker, author: { login: 'patrol-bot' } }];

    expect(alreadyHandled(comments, t, 'patrol-bot')).toBe(true);
    expect(alreadyHandled(comments, t, 'other-bot')).toBe(false);
    expect(
      alreadyHandled(comments, { ...t, checkName: 'Lint' }, 'patrol-bot'),
    ).toBe(false);
  });

  it('marks the check before rerunning a high-confidence flaky failure', async () => {
    const c = client();
    await actOnDecision(c, target(), {
      flaky: true,
      confidence: 'high',
    });

    expect(c.calls).toEqual([
      [
        'comment',
        42,
        expect.stringContaining('high-confidence flaky classification'),
      ],
      ['rerunFailedJobs', 123],
    ]);
    expect(c.calls[0][2]).toContain('workflow=Qwen%20Code%20CI');
    expect(c.calls[0][2]).toContain('check=E2E%20Tests');
  });

  it('records ambiguous or malformed decisions without rerunning', async () => {
    for (const decision of [
      { flaky: false, confidence: 'high' },
      { flaky: true, confidence: 'low' },
    ]) {
      const c = client();
      await actOnDecision(c, target(), decision);
      expect(c.calls).toEqual([
        ['comment', 42, expect.stringMatching(/^<!-- .* -->$/)],
      ]);
    }
  });

  it('does nothing when the PR, check, or run is no longer current', async () => {
    const cases = [
      client({
        currentPr: async () => ({ ...pr(), state: 'CLOSED' }),
      }),
      client({
        currentPr: async () => ({
          ...pr(),
          state: 'OPEN',
          statusCheckRollup: [
            run({
              status: 'IN_PROGRESS',
              conclusion: null,
              completedAt: null,
              startedAt: '2026-07-12T07:40:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/124/job/2',
            }),
          ],
        }),
      }),
      client({
        run: async () => ({
          status: 'completed',
          conclusion: 'success',
          head_sha: 'abc123',
          run_attempt: 2,
        }),
      }),
    ];

    for (const c of cases) {
      await actOnDecision(c, target(), {
        flaky: true,
        confidence: 'high',
      });
      expect(c.calls).toEqual([]);
    }
  });

  it('bounds and redacts the classifier log', () => {
    const evidence = skillLog(
      [
        'Error: Set-Cookie: session=cookie-secret',
        'Authorization: Bearer bearer-secret',
        'ghp_abcdef1234567890',
        'sk-proj-abcdefghijklmnopqrstuvwx',
        'AKIAABCDEFGHIJKLMNOP',
        'npm_abcdefghijklmnopqrstuvwx',
        'https://user:password@example.com/path',
        'SERVICE_CREDENTIAL=credential-secret',
      ].join('\n'),
    );
    expect(evidence).toContain('Set-Cookie: [redacted]');
    expect(evidence).toContain('Authorization: [redacted]');
    for (const secret of [
      'cookie-secret',
      'bearer-secret',
      'abcdef1234567890',
      'abcdefghijklmnopqrstuvwx',
      'AKIAABCDEFGHIJKLMNOP',
      'user:password',
      'credential-secret',
    ]) {
      expect(evidence).not.toContain(secret);
    }
  });
});
