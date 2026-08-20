import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  actOnDecision,
  actOnDecisions,
  alreadyHandled,
  deflakeIssueBody,
  deflakeKey,
  deflakeMarker,
  argsMap,
  currentActionCount,
  eligibleAttemptJob,
  fileSha256,
  fingerprint,
  GhClient,
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
    async rerunFailedJobs(...args) {
      calls.push(['rerunFailedJobs', ...args]);
    },
    async comment(...args) {
      calls.push(['comment', ...args]);
    },
    async hasOpenIssueWithMarker(...args) {
      calls.push(['hasOpenIssueWithMarker', ...args]);
      return false;
    },
    async createIssue(...args) {
      calls.push(['createIssue', ...args]);
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

  it('binds job evidence to the exact live run attempt', () => {
    const t = target();
    const job = {
      id: t.jobId,
      run_id: t.runId,
      run_attempt: t.runAttempt,
      head_sha: t.headSha,
      name: t.checkName,
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-07-12T07:20:00.000Z',
    };

    expect(eligibleAttemptJob(job, t, 2, { now: NOW })).toBe(true);
    expect(
      eligibleAttemptJob({ ...job, run_attempt: 1 }, t, 2, { now: NOW }),
    ).toBe(false);
    expect(
      eligibleAttemptJob(
        { ...job, completed_at: '2026-07-12T07:45:00.000Z' },
        t,
        2,
        { now: NOW },
      ),
    ).toBe(false);
  });

  it('rejects a command-line flag without a value', () => {
    expect(() => argsMap(['--repo'])).toThrow('missing value for --repo');
  });

  it('runs from an entry path containing spaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci flaky rerun-'));
    const script = join(dir, 'ci flaky rerun.mjs');
    try {
      copyFileSync(
        join(process.cwd(), '.github/scripts/ci-flaky-rerun.mjs'),
        script,
      );
      const result = spawnSync(process.execPath, [script, 'invalid'], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('command must be scan, act, or reset');
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('ignores empty lines in paginated comment output', async () => {
    const api = new GhClient('QwenLM/qwen-code');
    api.gh = async () => '{"body":"first"}\n\n{"body":"second"}\n';
    await expect(api.comments(42)).resolves.toEqual([
      { body: 'first' },
      { body: 'second' },
    ]);
  });

  it('requests the PR number when refreshing current PR state', async () => {
    const api = new GhClient('QwenLM/qwen-code');
    let args = [];
    api.gh = async (nextArgs) => {
      args = nextArgs;
      return JSON.stringify({ ...pr(), state: 'OPEN' });
    };
    await api.currentPr(42);
    expect(args[args.indexOf('--json') + 1].split(',')).toContain('number');
  });

  it('handles an exact run attempt once and allows a new attempt', () => {
    const comments = [markerComment()];
    expect(alreadyHandled(comments, target(), 'patrol-bot')).toBe(true);
    expect(
      alreadyHandled(comments, target({ runAttempt: 3 }), 'patrol-bot'),
    ).toBe(false);
    expect(alreadyHandled(comments, target(), 'someone-else')).toBe(false);
    const malformed = markerComment({
      body: markerComment().body.replace(' count=2', ' malformed count=2'),
    });
    expect(alreadyHandled([malformed], target(), 'patrol-bot')).toBe(false);
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
        pr({
          statusCheckRollup: [
            run({
              conclusion: 'SUCCESS',
              completedAt: '2026-07-12T07:30:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/124/job/2',
            }),
          ],
        }),
        comments,
        'patrol-bot',
      ),
    ).toBe(2);
    expect(
      currentActionCount(
        pr({ headRefOid: 'new-head' }),
        comments,
        'patrol-bot',
      ),
    ).toBe(0);
  });

  const flaky = () => ({
    file: 'packages/core/src/utils/shell-ast-parser-lazy.test.ts',
    name: 'shellAstParser lazy runtime › loads web-tree-sitter on first use',
  });

  it('keys deflake dedup on (file, name), stable and collision-free', () => {
    expect(deflakeKey(flaky())).toBe(deflakeKey(flaky()));
    expect(deflakeKey({ ...flaky(), name: 'other test' })).not.toBe(
      deflakeKey(flaky()),
    );
    expect(deflakeKey({ ...flaky(), file: 'other.test.ts' })).not.toBe(
      deflakeKey(flaky()),
    );
    expect(deflakeMarker(flaky())).toBe(
      `<!-- qwen-deflake key=${deflakeKey(flaky())} -->`,
    );
    // The issue body carries the marker, the SKILL pointer, and the collapsed
    // Chinese — everything the autofix issue flow needs to produce the fix.
    const body = deflakeIssueBody(
      flaky(),
      { reason_en: 'timed out', reason_zh: '超时' },
      { prNumber: 42, runId: 99, repo: 'QwenLM/qwen-code' },
    );
    expect(body).toContain(deflakeMarker(flaky()));
    expect(body).toContain('.qwen/skills/deflake/SKILL.md');
    expect(body).toContain(flaky().file);
    expect(body).toContain('<summary>中文说明</summary>');
    expect(body).toContain('/actions/runs/99');
  });

  it('opens ONE deflake issue for a confirmed flaky test, deduped', async () => {
    const c = client();
    await actOnDecision(c, target(), decision({ flakyTest: flaky() }));
    // Reran, marked, checked for an existing issue, then created one.
    expect(c.calls.map((call) => call[0])).toEqual([
      'rerunFailedJobs',
      'comment',
      'hasOpenIssueWithMarker',
      'createIssue',
    ]);
    const created = c.calls.find((call) => call[0] === 'createIssue')[1];
    expect(created.title).toBe(
      'deflake: packages/core/src/utils/shell-ast-parser-lazy.test.ts › shellAstParser lazy runtime › loads web-tree-sitter on first use',
    );
    expect(created.labels).toEqual([
      'status/ready-for-agent',
      'autofix/approved',
    ]);
    expect(created.body).toContain(deflakeMarker(flaky()));
    expect(created.body).toContain('.qwen/skills/deflake/SKILL.md');
    expect(created.body).toContain('<details>');
    expect(created.body).toContain('中文说明');
    // Idempotent: an already-open deflake issue for this test → no second issue.
    const seen = client({
      async hasOpenIssueWithMarker() {
        return true;
      },
    });
    await actOnDecision(seen, target(), decision({ flakyTest: flaky() }));
    // Existing open issue → deduped: it reran, but created NO second issue.
    expect(seen.calls.map((call) => call[0])).toEqual([
      'rerunFailedJobs',
      'comment',
    ]);
    expect(seen.calls.map((call) => call[0])).not.toContain('createIssue');
  });

  it('never opens a deflake issue for an infra rerun (no flakyTest)', async () => {
    const c = client();
    await actOnDecision(c, target(), decision());
    expect(c.calls.map((call) => call[0])).not.toContain('createIssue');
    expect(c.calls.map((call) => call[0])).not.toContain(
      'hasOpenIssueWithMarker',
    );
  });

  it('never lets a malformed flakyTest drop the valid rerun', async () => {
    // The rerun is valid independently of flakyTest, so a malformed one only
    // skips the deflake issue — it must NEVER gate the primary action.
    for (const bad of [
      null,
      { file: '', name: 'x' },
      { file: 'a.test.ts' }, // missing name
      { file: 'a.test.ts', name: 42 },
      { file: 'a'.repeat(201), name: 'x' }, // over-length file
      { file: 'a.test.ts', name: 'y'.repeat(201) }, // over-length name
    ]) {
      const c = client();
      await actOnDecision(c, target(), decision({ flakyTest: bad }));
      const kinds = c.calls.map((call) => call[0]);
      expect(kinds).toContain('rerunFailedJobs');
      expect(kinds).toContain('comment');
      expect(kinds).not.toContain('createIssue');
    }
  });

  it('truncates a very long deflake title to GitHub-safe length', async () => {
    const c = client();
    const longFlaky = { file: 'x'.repeat(150), name: 'y'.repeat(150) };
    await actOnDecision(c, target(), decision({ flakyTest: longFlaky }));
    const created = c.calls.find((call) => call[0] === 'createIssue')?.[1];
    expect(created).toBeTruthy();
    expect(created.title.length).toBeLessThanOrEqual(240);
  });

  it('neutralizes backticks in the test path/name so the issue body cannot inject markup', async () => {
    // A backtick in a file path (valid on Linux) or name would break out of
    // the inline code span and turn `@user` into a live mention. The body must
    // strip them so file/name stay inert.
    const evil = { file: 'x`@ghost`y.test.ts', name: 'boom `@owner` case' };
    const body = deflakeIssueBody(
      evil,
      { reason_en: 'x', reason_zh: 'x' },
      {
        prNumber: 1,
        runId: 2,
      },
    );
    expect(body).not.toContain('`@ghost`');
    expect(body).not.toContain('`@owner`');
    // The whole marker + SKILL pointer survive intact.
    expect(body).toContain(deflakeMarker(evil));
    expect(body).toContain('.qwen/skills/deflake/SKILL.md');
  });

  it('points the run link at the patrol repo, not a hardcoded upstream', async () => {
    const body = deflakeIssueBody(
      flaky(),
      { reason_en: 'x', reason_zh: 'x' },
      { prNumber: 7, runId: 42 },
      'my-fork/qwen-code',
    );
    expect(body).toContain(
      'https://github.com/my-fork/qwen-code/actions/runs/42',
    );
    expect(body).not.toContain('QwenLM/qwen-code/actions/runs/42');
  });

  it('keeps the rerun when deflake issue creation fails (best-effort)', async () => {
    const c = client({
      async createIssue() {
        throw new Error('502 from GitHub');
      },
    });
    // Must not throw: the rerun + marker already succeeded.
    await actOnDecision(c, target(), decision({ flakyTest: flaky() }));
    const kinds = c.calls.map((call) => call[0]);
    expect(kinds).toContain('rerunFailedJobs');
    expect(kinds).toContain('comment');
  });

  it('reruns before recording the hidden action marker', async () => {
    const c = client();
    await actOnDecision(c, target(), decision());
    expect(c.calls).toEqual([
      ['rerunFailedJobs', 123],
      ['comment', 42, expect.stringMatching(/^<!-- .*action=rerun.* -->$/)],
    ]);
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
      decision({ action: 'update_branch' }),
      decision({ reason_en: 'x'.repeat(201) }),
      decision({ reason_en: '' }),
      decision({ reason_zh: ' ' }),
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
            body: markerComment()
              .body.replace('attempt=2', 'attempt=1')
              .replace('count=2', 'count=3'),
          }),
        ];
      },
    });
    await actOnDecision(c, target(), decision());
    expect(c.calls).toEqual([]);
  });

  it('does nothing when the PR or failure is no longer current', async () => {
    const changedPr = (overrides) =>
      client({
        async currentPr() {
          return { ...pr(), state: 'OPEN', ...overrides };
        },
      });
    const cases = [
      client({
        async currentPr() {
          return { ...pr(), state: 'CLOSED' };
        },
      }),
      changedPr({ headRefOid: 'new-head' }),
      changedPr({ isDraft: true }),
      changedPr({ baseRefName: 'release' }),
      changedPr({
        statusCheckRollup: [
          run({
            detailsUrl:
              'https://github.com/QwenLM/qwen-code/actions/runs/123/job/2',
          }),
        ],
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
    expect(fingerprint(target(), 'Error 12345678')).toBe(
      fingerprint(target(), 'Error 456'),
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
        'AKIAABCDEFGHIJKLMNOP',
        'npm_abcdefghijklmnopqrst',
        'sk-abcdefghijklmnopqrst',
        'Cookie: session=cookie-secret',
        'https://user:url-secret@example.com/path',
        'API_SECRET=env-secret',
        '"db_password": "quoted-secret"',
      ].join('\n'),
    );
    const lines = evidence.split('\n');
    expect(lines.length).toBeLessThanOrEqual(120);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      300,
    );
    expect(evidence).not.toContain('private-material');
    expect(evidence).not.toContain('bearer-secret');
    expect(evidence).not.toContain('eyJhbGci');
    expect(evidence).not.toContain('abcdef1234567890');
    for (const secret of [
      'ABCDEFGHIJKLMNOP',
      'abcdefghijklmnopqrst',
      'cookie-secret',
      'url-secret',
      'env-secret',
      'quoted-secret',
    ]) {
      expect(evidence).not.toContain(secret);
    }
    expect(evidence).toContain('TypeError: ensureTool is not a function');
  });

  it('keeps fallback errors', () => {
    expect(skillLog('Error: connect ECONNREFUSED')).toContain(
      'Error: connect ECONNREFUSED',
    );
  });

  it('rejects tampered classifier input before GitHub access', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-act-'));
    try {
      writeFileSync(join(dir, 'ci-flaky-input.json'), '{"candidates":[]}\n');
      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), '.github/scripts/ci-flaky-rerun.mjs'),
          'act',
          '--workdir',
          dir,
          '--input-sha',
          'tampered',
        ],
        { encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('integrity check failed');
    } finally {
      rmSync(dir, { recursive: true });
    }
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

  it('keeps the primary failure when later summary lines fill the limit', () => {
    const evidence = skillLog(
      [
        'Failed Tests 1',
        'FAIL toolFormatting.test.ts > translates every tool',
        "AssertionError: expected ['deferred_tool_call'] to deeply equal []",
        ...Array.from(
          { length: 200 },
          (_, index) => `npm error cleanup noise ${index}`,
        ),
      ].join('\n'),
    );
    expect(evidence.split('\n')).toHaveLength(120);
    expect(evidence).toContain("expected ['deferred_tool_call']");
  });
});
