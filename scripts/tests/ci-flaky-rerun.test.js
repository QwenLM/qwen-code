import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  // Windows cannot express this fixture: chmodSync sets no executable bit and
  // execFile cannot run an extensionless #!/bin/sh script (no PATHEXT match),
  // and the PATH join below is the POSIX spelling. Gate the case rather than
  // the file, so the rest of the driver suite still runs on the Windows lane —
  // which downgrades a test:scripts failure to a warning and would otherwise
  // deposit a permanent silent failure in its log.
  it.skipIf(process.platform === 'win32')(
    'spawns the pinned gh, never a bare name from PATH',
    async () => {
      // Every other GhClient test stubs api.gh, so none of them exercise the
      // spawn. On the shared pool a bare `gh` resolves through a PATH whose
      // directories the job uid can write, and this client runs with the bot PAT
      // in its environment — a co-tenant's gh would receive it.
      const dir = mkdtempSync(join(tmpdir(), 'patrol-gh-'));
      const planted = join(dir, 'planted');
      const trusted = join(dir, 'trusted');
      mkdirSync(planted);
      mkdirSync(trusted);
      const leaked = join(dir, 'LEAKED');
      writeFileSync(
        join(planted, 'gh'),
        `#!/bin/sh\nprintf '%s' "\${GH_TOKEN:-}" > '${leaked}'\necho planted\n`,
      );
      writeFileSync(join(trusted, 'gh'), '#!/bin/sh\necho trusted\n');
      for (const d of [planted, trusted]) chmodSync(join(d, 'gh'), 0o755);
      const prevPath = process.env.PATH;
      const prevGh = process.env.PATROL_GH;
      const prevToken = process.env.GH_TOKEN;
      try {
        process.env.PATH = `${planted}:${prevPath}`;
        process.env.GH_TOKEN = 'SENTINEL-PAT-VALUE';
        process.env.PATROL_GH = join(trusted, 'gh');
        const api = new GhClient('QwenLM/qwen-code');
        await expect(api.gh(['api', 'user'])).resolves.toBe('trusted\n');
        expect(existsSync(leaked)).toBe(false);
      } finally {
        if (prevGh === undefined) delete process.env.PATROL_GH;
        else process.env.PATROL_GH = prevGh;
        if (prevToken === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = prevToken;
        process.env.PATH = prevPath;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('ignores empty lines in paginated comment output', async () => {
    const api = new GhClient('QwenLM/qwen-code');
    api.gh = async () => '{"body":"first"}\n\n{"body":"second"}\n';
    await expect(api.comments(42)).resolves.toEqual([
      { body: 'first' },
      { body: 'second' },
    ]);
  });

  it('keeps the status rollup out of the PR search query', async () => {
    // With statusCheckRollup in the list query, the search is one GraphQL
    // call costing matched PRs times their check runs. It began returning
    // HTTP 504 above ~30 matches and failed 100 consecutive scheduled scans;
    // the same search without the rollup answers in a second. Reading the
    // rollup per PR keeps every call small.
    const api = new GhClient('QwenLM/qwen-code');
    const calls = [];
    api.gh = async (args) => {
      calls.push(args);
      if (args[1] === 'list') {
        return JSON.stringify([{ number: 7 }, { number: 8 }]);
      }
      if (args[2] === '8') {
        throw new Error('HTTP 502');
      }
      return JSON.stringify({ statusCheckRollup: [run()] });
    };
    await expect(api.prList('status:failure')).resolves.toEqual([
      { number: 7, statusCheckRollup: [run()] },
    ]);
    const listArgs = calls[0];
    expect(listArgs[listArgs.indexOf('--json') + 1].split(',')).not.toContain(
      'statusCheckRollup',
    );
    expect(calls).toHaveLength(3);
  });

  it('bounds how many PR detail reads run at once', async () => {
    // The patrol job has a ten-minute budget and this cost grows with the
    // open-PR count, so the fan-out is capped rather than unbounded.
    const api = new GhClient('QwenLM/qwen-code');
    let inFlight = 0;
    let peak = 0;
    api.gh = async (args) => {
      if (args[1] === 'list') {
        return JSON.stringify(
          Array.from({ length: 12 }, (_, i) => ({ number: i + 1 })),
        );
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return JSON.stringify({ statusCheckRollup: [run()] });
    };
    const result = await api.prList('status:failure');
    expect(result).toHaveLength(12);
    // Order survives the fan-out: the caller pairs rollups with PR numbers.
    expect(result.map((pr) => pr.number)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
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

  it('passes --allow-escape-sequences so gh serves the colourised job log', async () => {
    // A current gh refuses the logs endpoint without the flag (exit 1, empty
    // stdout); without this the patrol's distillation is log-blind. Witness:
    // the bare call throws the refusal, the flagged call serves the log.
    const api = new GhClient('QwenLM/qwen-code');
    const calls = [];
    api.gh = async (args) => {
      calls.push(args);
      if (!args.includes('--allow-escape-sequences')) {
        throw Object.assign(new Error('gh refused'), {
          stderr:
            'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway',
        });
      }
      return '##[error]boom\n\x1b[31mcolored\x1b[0m\n';
    };
    const log = await api.jobLog(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'api',
      '--allow-escape-sequences',
      'repos/QwenLM/qwen-code/actions/jobs/7/logs',
    ]);
    expect(log).toContain('##[error]boom');
    expect(log).toContain('colored');
    expect(log).not.toContain('\x1b');
  });

  it('falls back to the bare call for a gh without the flag', async () => {
    const api = new GhClient('QwenLM/qwen-code');
    const calls = [];
    api.gh = async (args) => {
      calls.push(args);
      if (args.includes('--allow-escape-sequences')) {
        throw Object.assign(new Error('gh failed'), {
          stderr: 'unknown flag: --allow-escape-sequences',
        });
      }
      return 'boom';
    };
    await expect(api.jobLog(7)).resolves.toBe('boom');
    expect(calls.at(-1)).toEqual([
      'api',
      'repos/QwenLM/qwen-code/actions/jobs/7/logs',
    ]);
  });

  it('propagates a log error that is not the unknown-flag refusal', async () => {
    const api = new GhClient('QwenLM/qwen-code');
    api.gh = async () => {
      throw Object.assign(new Error('HTTP 404'), { stderr: 'Not Found' });
    };
    await expect(api.jobLog(7)).rejects.toThrow('HTTP 404');
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

  it('reruns before posting the visible rerun notice', async () => {
    const c = client();
    await actOnDecision(c, target(), decision());
    expect(c.calls.map((call) => call[0])).toEqual([
      'rerunFailedJobs',
      'comment',
    ]);
    const body = c.calls[1][2];
    expect(body).toContain('runner timeout');
    expect(body).toContain('re-run on the same commit');
    expect(body).toContain('No Update Branch');
    expect(body).toContain('<summary>中文说明</summary>');
    expect(body).toContain('runner 超时');
    expect(body.split('</details>').length - 1).toBe(1);
    expect(body).toMatch(/<!-- .*action=rerun.* -->$/);
  });

  it('keeps markers parseable inside the visible notices', async () => {
    // The visible text must not break dedup or the per-head action count:
    // both read the marker back out of the posted comment body.
    const c = client();
    await actOnDecision(c, target(), decision());
    const posted = {
      body: c.calls.find((call) => call[0] === 'comment')[2],
      createdAt: '2026-07-12T07:25:00.000Z',
      author: { login: 'patrol-bot' },
    };
    expect(alreadyHandled([posted], target(), 'patrol-bot')).toBe(true);
    expect(currentActionCount(pr(), [posted], 'patrol-bot')).toBe(1);
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
    const body = c.calls[0][2];
    expect(body).toContain('TypeScript cannot resolve');
    expect(body).toContain('<details>');
    expect(body).toContain('TypeScript 无法解析');
    expect(body).toContain('action=comment');
    // Pin the bilingual placement, not just the presence of both strings:
    // English before the fold, Chinese inside it.
    const enIndex = body.indexOf('TypeScript cannot resolve');
    const foldIndex = body.indexOf('<summary>中文说明</summary>');
    const zhIndex = body.indexOf('TypeScript 无法解析');
    expect(enIndex).toBeLessThan(foldIndex);
    expect(foldIndex).toBeLessThan(zhIndex);
    expect(body.split('</details>').length - 1).toBe(1);
  });

  it('records no_action with a visible manual-review notice', async () => {
    const c = client();
    await actOnDecision(
      c,
      target(),
      decision({ action: 'no_action', confidence: 'low' }),
    );
    expect(c.calls).toHaveLength(1);
    const body = c.calls[0][2];
    expect(body).toContain('could not be confidently classified');
    expect(body).toContain('runner timeout');
    expect(body).toContain('<summary>中文说明</summary>');
    expect(body).toContain('未采取自动动作');
    expect(body.split('</details>').length - 1).toBe(1);
    expect(body).toMatch(/<!-- .*action=no_action.* -->$/);
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
    // All three actions now surface the reason in a visible comment, so the
    // escaping must hold for every action, not just `comment`.
    for (const action of ['rerun', 'comment', 'no_action']) {
      const c = client();
      await actOnDecision(
        c,
        target(),
        decision({
          action,
          confidence: action === 'no_action' ? 'low' : 'high',
          reason_en: '@qwen-maintainers <script>alert(1)</script>',
          reason_zh: '@全体成员 </details>',
        }),
      );
      const body = c.calls.find((call) => call[0] === 'comment')[2];
      expect(body).toContain('@\u200bqwen-maintainers');
      expect(body).toContain('&lt;script&gt;');
      expect(body).toContain('@\u200b全体成员 &lt;/details&gt;');
    }
  });

  it('strips bidi overrides that could visually rewrite a notice', async () => {
    // The reason is classifier output derived from untrusted logs; a bidi
    // override could make "no Update Branch needed" read as its opposite.
    // Every member of the Unicode Bidi_Control set is also fed individually
    // so narrowing the strip class cannot survive this pin.
    const bidiControls = [
      '\u061C',
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];
    for (const action of ['rerun', 'comment', 'no_action']) {
      const confidence = action === 'no_action' ? 'low' : 'high';
      const c = client();
      await actOnDecision(
        c,
        target(),
        decision({
          action,
          confidence,
          reason_en: 'safe \u202Ereversed\u202C text',
          reason_zh: '安全 \u2066隔离\u2069 \u061C文本',
        }),
      );
      const body = c.calls.find((call) => call[0] === 'comment')[2];
      expect(body).not.toMatch(
        /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/,
      );
      expect(body).toContain('safe reversed text');
      expect(body).toContain('安全 隔离 文本');
      for (const ch of bidiControls) {
        const cc = client();
        await actOnDecision(
          cc,
          target(),
          decision({
            action,
            confidence,
            reason_en: `a${ch}b`,
            reason_zh: `a${ch}b`,
          }),
        );
        const single = cc.calls.find((call) => call[0] === 'comment')[2];
        expect(single).not.toContain(ch);
        expect(single).toContain('ab');
      }
    }
  });

  it('collapses newlines so a reason cannot open a block-level fence', async () => {
    // A line-start fence in a reason swallows the folded Chinese block and
    // renders the tracking marker as visible code; keep reasons single-line.
    for (const action of ['rerun', 'comment', 'no_action']) {
      const c = client();
      await actOnDecision(
        c,
        target(),
        decision({
          action,
          confidence: action === 'no_action' ? 'low' : 'high',
          reason_en: 'npm error:\n```\nnpm error code ETIMEDOUT',
          reason_zh: 'npm 错误：\n```\nnpm error code ETIMEDOUT',
        }),
      );
      const body = c.calls.find((call) => call[0] === 'comment')[2];
      expect(body).not.toMatch(/^```/m);
      expect(body).toContain('npm error: ``` npm error code ETIMEDOUT');
      expect(body.split('</details>').length - 1).toBe(1);
      const posted = {
        body,
        createdAt: '2026-07-12T07:25:00.000Z',
        author: { login: 'patrol-bot' },
      };
      expect(alreadyHandled([posted], target(), 'patrol-bot')).toBe(true);
    }
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

  it('fails the round when a non-empty decision list matches no candidate', async () => {
    // The hollow-green shape the workflow's verdict step cannot catch: validate
    // sees a non-empty array and sets has_decisions=true, so the verdict step is
    // skipped, act prints "no candidate" per entry and exits 0. The consumer has
    // to close the loop. `{"pr":123,"action":"rerun"}` is exactly the shape a
    // model emits when it ignores the five-field key.
    const c = client();
    await expect(
      actOnDecisions(c, [target()], [{ pr: 123, action: 'rerun' }]),
    ).rejects.toThrow(/addressed no actionable candidate/);
    expect(c.calls).toEqual([]);

    // A mistyped headSha is the same failure, not a per-decision skip.
    const c2 = client();
    await expect(
      actOnDecisions(c2, [target()], [decision({ headSha: 'f'.repeat(40) })]),
    ).rejects.toThrow(/addressed no actionable candidate/);
    expect(c2.calls).toEqual([]);

    // Keys can all match while the schema rejects every entry. actOnDecision
    // returns silently on that check, so counting key resolution would report
    // success on a round that acted on nothing.
    for (const invalid of [
      decision({ action: 'rerun', confidence: 'low' }),
      decision({ reason_en: 'x'.repeat(240) }),
      decision({ runId: String(target().runId) }),
    ]) {
      const cx = client();
      await expect(actOnDecisions(cx, [target()], [invalid])).rejects.toThrow(
        /addressed no actionable candidate/,
      );
      expect(cx.calls).toEqual([]);
    }

    // no_action IS an act: it posts the "could not be confidently classified"
    // marker, so it must not be counted as nothing done.
    const cNoAction = client();
    await expect(
      actOnDecisions(
        cNoAction,
        [target()],
        [decision({ action: 'no_action', confidence: 'low' })],
      ),
    ).resolves.toBeUndefined();
    expect(cNoAction.calls.some((call) => call[0] === 'comment')).toBe(true);

    // An empty list is still a legitimate no-op: the workflow's verdict step
    // owns that case, and the consumer must not throw on it.
    const c3 = client();
    await expect(actOnDecisions(c3, [target()], [])).resolves.toBeUndefined();
    expect(c3.calls).toEqual([]);
  });

  it('keeps a matched decision that failed per-target from failing the round', async () => {
    // A candidate superseded between scan and act must not fail the round. It
    // still counts as matched, because the decision addressed a real target.
    const c = client({
      async rerunFailedJobs() {
        throw new Error('temporary API failure');
      },
    });
    await expect(
      actOnDecisions(c, [target()], [decision()]),
    ).resolves.toBeUndefined();
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

  it('strips terminal controls after redaction, not before', () => {
    // A bare \r supplies the word boundary \bnpm_ needs: stripping controls
    // before redactLog would concatenate `x` onto the token and leak it. The
    // strip must also cover backspace and friends, not just CR.
    const evidence = skillLog(
      '##[error]Downloading pkg 42% x\rnpm_ABCDEFGHIJKLMNOPQRSTUV0123 installed\b\bSPOOFED\x0b\u202E\n',
    );
    expect(evidence).toContain('[redacted]');
    expect(evidence).not.toContain('npm_ABCDEFGHIJKLMNOPQRSTUV0123');
    expect(evidence).toContain('installedSPOOFED');
    expect(evidence).not.toContain('\r');
    expect(evidence).not.toContain('\b');
    expect(evidence).not.toContain('\x0b');
    expect(evidence).not.toContain('\u202E');
  });

  it('redacts a credential split by a control byte once the strip rejoins it', () => {
    // A control INSIDE the token defeats \bnpm_… on the first pass (only the
    // short prefix precedes it); deleting the control welds the fragments into
    // a contiguous token, so a second redaction pass must still scrub it.
    const evidence = skillLog(
      '##[error]npm_\rABCDEFGHIJKLMNOPQRSTUV0123 done\n',
    );
    expect(evidence).toContain('[redacted]');
    expect(evidence).not.toContain('npm_ABCDEFGHIJKLMNOPQRSTUV0123');
  });

  it('redacts a welded credential whose leading boundary the strip also removed', () => {
    // The strip deletes the CR in front of the token as well as the one inside
    // it, so the second pass sees `xnpm_…`: the first pass had a boundary but
    // no token, and \b has nothing to match once the fragments are welded.
    const evidence = skillLog(
      '##[error]Downloading x\rnpm_\rABCDEFGHIJKLMNOPQRSTUV0123 installed\n',
    );
    expect(evidence).toContain('[redacted]');
    expect(evidence).not.toContain('npm_ABCDEFGHIJKLMNOPQRSTUV0123');
  });

  it('keeps the failure line that follows a CR-terminated header', () => {
    // The header rules are bounded by \r as well as \n, which is what keeps
    // them off the next line. Re-running them after the strip deleted every
    // \r would swallow everything up to the next newline — including the
    // ##[error] line the excerpt exists to show, leaving only noise.
    const noise = Array.from({ length: 30 }, (_, i) => `noise line ${i}`).join(
      '\n',
    );
    const evidence = skillLog(
      `${noise}\nCookie: sid=abc\r##[error]AssertionError: real failure\n${noise}`,
    );
    expect(evidence).toContain('##[error]AssertionError: real failure');
    expect(evidence).toContain('Cookie: [redacted]');
    expect(evidence).not.toContain('sid=abc');
  });

  it('keeps the failure line after a CR-terminated value of a whitespace-bounded rule', () => {
    // Bearer's \S+ and the env rule's [^"',\s}]+ also stop at \r, so the strip
    // welds their value onto the next logical line just like the header rules.
    // The post-strip value is a tempered token that stops before the ##[error]
    // marker, so the weld cannot carry the value over the marker and the
    // excerpt keeps the failure it was fetched for.
    const noise = Array.from({ length: 30 }, (_, i) => `noise line ${i}`).join(
      '\n',
    );
    for (const prefix of [
      'SSH_AUTH_SOCK=/tmp/agent',
      'NPM_TOKEN=abc',
      'API_KEY=abc',
      'GITHUB_TOKEN=abc',
      'Bearer abc123',
    ]) {
      for (const control of ['\r', '\x0b', '\x0c']) {
        const evidence = skillLog(
          `${noise}\n${prefix}${control}##[error]AssertionError: real failure\n${noise}`,
        );
        expect(evidence).toContain('##[error]AssertionError: real failure');
        expect(evidence).toContain('[redacted]');
      }
    }
  });

  it('keeps the failure payload of a control-free quoted JSON object', () => {
    // Regression: the repair pass re-matched the already-redacted value and ran
    // its whitespace-bounded token to the end of the line, eating the rest of
    // the JSON object — the failure identifier the excerpt exists to show. A
    // quoted value must stop at its closing quote; an already-[redacted] value
    // followed by a structural delimiter must not be re-redacted greedily.
    for (const [line, payload] of [
      [
        '{"authToken":"s3cr3t","err":"TestFailed:suiteA"}',
        '"err":"TestFailed:suiteA"',
      ],
      [
        '{"apiKey":"s3cr3t","msg":"AssertionError: expected 1 to be 2"}',
        '"msg":"AssertionError: expected 1 to be 2"',
      ],
      [
        '{"db_password":"x","msg":"AssertionError: boom"}',
        '"msg":"AssertionError: boom"',
      ],
    ]) {
      const evidence = skillLog(`${line}\n`);
      expect(evidence, line).toContain(payload);
      expect(evidence, line).not.toContain('s3cr3t');
    }
  });

  it('keeps the failure line a welded URL userinfo would otherwise reach', () => {
    // The scheme rule's userinfo is a tempered token per @-segment: it runs to
    // the next whitespace or @ but never across the ##[error] marker. Two
    // shapes: one where the first pass already redacted the userinfo, and one
    // where the only @ sits past the CR so the first pass never reached it — in
    // both, the temper keeps the rule off the ##[error] marker.
    for (const line of [
      'https://u@h\r##[error]AssertionError:real@failure',
      'https://host\r##[error]AssertionError:real@failure',
    ]) {
      const evidence = skillLog(line);
      expect(evidence, line).toContain('##[error]AssertionError:real@failure');
    }
    expect(
      skillLog('https://u@h\r##[error]AssertionError:real@failure'),
    ).toContain('https://[redacted]@');
  });

  it('keeps the marker when a control splits the credential keyword itself', () => {
    // A split keyword is exactly the case the first pass cannot see. Selection
    // runs before the strip so the line is still chosen. For the env / Bearer
    // fixtures the repair pass redacts the welded value (a tempered token that
    // stops before the ##[error] marker); for the private-key fixture the
    // tempered body stops at the marker, so the marker survives rather than the
    // span being redacted. Either way the weld cannot carry a value over the
    // marker.
    const noise = Array.from({ length: 30 }, (_, i) => `noise line ${i}`).join(
      '\n',
    );
    const tail = Array.from({ length: 40 }, (_, i) => `tail line ${i}`).join(
      '\n',
    );
    for (const [line, marker] of [
      [
        'SSH_AU\rTH_SOCK=abc\r##[error]AssertionError: real failure',
        '##[error]AssertionError: real failure',
      ],
      ['Bea\rrer abc123\r##[error]Build failed', '##[error]Build failed'],
      [
        '-----BEGIN RSA\rKEY-----\r##[error]AssertionError: boom\r-----END RSA\rKEY-----',
        '##[error]AssertionError: boom',
      ],
    ]) {
      const evidence = skillLog(`${noise}\n${line}\n${tail}`);
      expect(evidence, line).toContain(marker);
    }
    expect(
      skillLog('SSH_AU\rTH_SOCK=abc\r##[error]AssertionError: real failure'),
    ).toContain('SSH_AUTH_SOCK=[redacted]');
    expect(skillLog('Bea\rrer abc123\r##[error]Build failed')).toContain(
      'Bearer [redacted]',
    );
  });

  it('selects a FAIL line whose leading whitespace is a control', () => {
    // \sFAIL\s needs the whitespace a leading \r supplies. Stripping before
    // selection deleted it, so the line was never chosen and the excerpt fell
    // back to noise.
    const noise = Array.from({ length: 30 }, (_, i) => `noise line ${i}`).join(
      '\n',
    );
    const evidence = skillLog(`${noise}\n\rFAIL src/a.test.ts\n${noise}`);
    expect(evidence).toContain('FAIL src/a.test.ts');
  });

  it('redacts a credential the log hid behind a literal [redacted] prefix', () => {
    // The value is a tempered token, not a class that excludes [ or ]: a value
    // the log itself wrote as [redacted]… is still a value and gets redacted.
    // With the keyword split, the first pass saw nothing and this pass is the
    // only chance to scrub it.
    for (const [line, secret] of [
      ['##[error]API_KE\rY=[redacted]realsecretvalue123', 'realsecretvalue123'],
      ['##[error]NPM_TO\rKEN=[redacted]abcdefghijklmno', 'abcdefghijklmno'],
      ['##[error]Bea\rrer [redacted]realsecretvalue123', 'realsecretvalue123'],
      ["##[error]API_KE\rY='[redacted]abcdefghijklmno'", 'abcdefghijklmno'],
    ]) {
      const evidence = skillLog(line);
      expect(evidence, line).toContain('[redacted]');
      expect(evidence, line).not.toContain(secret);
    }
  });

  it('repairs every credential family a control byte split', () => {
    // The post-strip rule list is a hand-copy of redactLog's; pin each rule
    // individually so deleting one cannot leave both suites green.
    const cases = [
      [
        '-----BEGIN RSA\rKEY-----\nbody\n-----END RSA\rKEY-----',
        '[redacted private key]',
      ],
      ['eyJ\rhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij', '[redacted jwt]'],
      ['Bea\rrer abcdefghij', 'Bearer [redacted]'],
      ['ghp_\rABCDEFGHIJKLMNOPQRSTUV0123', '[redacted]'],
      ['sk-\rabcdefghijklmnopqrstuvwx', 'sk-[redacted]'],
      ['AKIA\rABCDEFGHIJKLMNOP', '[redacted]'],
      ['npm_\rABCDEFGHIJKLMNOPQRSTUV0123', '[redacted]'],
      ['https://u\rser:pass@host', 'https://[redacted]@host'],
      ['NPM_TO\rKEN=abcdefghij', 'NPM_TOKEN=[redacted]'],
      // Round-6 entrances: a value carrying a terminator character, a welded
      // scheme prefix, a multi-@ userinfo, and a deleted Bearer separator.
      ['https:/\r/[redacted]realsecretvalue@host', 'https://[redacted]@'],
      ['42\rhttps://us\rer:pw@host', '42https://[redacted]@'],
      ['NPM_TO\rKEN=abc#realsecret99', 'NPM_TOKEN=[redacted]'],
      ['https://u\rser:p@ss@host', 'https://[redacted]@host'],
      ['Bea\rrer\rrealsecretvalue123', 'Bearer[redacted]'],
      // Adversarial audit: a value carrying a structural terminator (} or a
      // quote) or a URL password carrying # must not ship its tail either.
      ['NPM_TO\rKEN=abc}realsecret99', 'NPM_TOKEN=[redacted]'],
      ['NPM_TO\rKEN=abc"realsecret99', 'NPM_TOKEN=[redacted]'],
      ['https://us\rer:p#ss@host', 'https://[redacted]@host'],
    ];
    for (const [input, expected] of cases) {
      const evidence = skillLog(`##[error]${input} done`);
      expect(evidence, input).toContain(expected);
    }
    // The secret tail must be gone, not just the placeholder present.
    for (const [input, secret] of [
      ['https:/\r/[redacted]realsecretvalue@host', 'realsecretvalue'],
      ['42\rhttps://us\rer:pw@host', 'user:pw'],
      ['NPM_TO\rKEN=abc#realsecret99', 'realsecret99'],
      ['https://u\rser:p@ss@host', 'p@ss'],
      ['Bea\rrer\rrealsecretvalue123', 'realsecretvalue123'],
      ['NPM_TO\rKEN=abc}realsecret99', 'realsecret99'],
      ['NPM_TO\rKEN=abc"realsecret99', 'realsecret99'],
      ['https://us\rer:p#ss@host', 'p#ss'],
    ]) {
      expect(skillLog(`##[error]${input} done`), input).not.toContain(secret);
    }
  });

  it('keeps a marker inside a BEGIN…END span instead of redacting the span', () => {
    // For a SPLIT-label block (the case the repair pass handles) the tempered
    // private-key body stops before ##[error], so the marker survives instead
    // of the span being redacted. (An intact-label block is redacted whole by
    // the first pass, as in base — that path has no marker temper.) A real PEM
    // (no marker) and a body with a non-marker # are still fully redacted.
    const withMarker = skillLog(
      '-----BEGIN RSA\rKEY-----\nMIIEow\n##[error]x\n-----END RSA\rKEY-----',
    );
    expect(withMarker).toContain('##[error]x');
    expect(
      skillLog('-----BEGIN RSA\rKEY-----\nMIIEow\n-----END RSA\rKEY-----'),
    ).toContain('[redacted private key]');
    expect(
      skillLog('-----BEGIN RSA\rKEY-----\nMIIE#ow\n-----END RSA\rKEY-----'),
    ).toContain('[redacted private key]');
  });

  it('does not pair a key BEGIN and END across non-adjacent selected windows', () => {
    // The selected windows are joined per contiguous run, so a control-split
    // BEGIN in the primary window cannot pair with a control-split END in the
    // always-selected tail and delete the failure line between them.
    const log = [
      'a line 1',
      'a line 2',
      '-----BEGIN RSA\rKEY-----',
      'TypeError: boom',
      ...Array.from({ length: 30 }, (_, i) => `b line ${i}`),
      '-----END RSA\rKEY-----',
      'tail one',
      'tail two',
    ].join('\n');
    const evidence = skillLog(log);
    expect(evidence).toContain('TypeError: boom');
    expect(evidence).not.toContain('[redacted private key]');
  });

  it('strips every control and Bidi_Control code point, keeping tab and newline', () => {
    // Pin the extent of the class, not the points a fixture happens to sample:
    // every member is fed, and the assertion asks Unicode itself, so narrowing
    // the class to a sample cannot stay green. \n and \t must survive.
    const controls = [
      ...Array.from({ length: 0x20 }, (_, i) => i).filter(
        (i) => i !== 0x09 && i !== 0x0a,
      ),
      ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
    ].map((i) => String.fromCharCode(i));
    const bidi = [
      '\u061C',
      '\u200E',
      '\u200F',
      '\u202A',
      '\u202B',
      '\u202C',
      '\u202D',
      '\u202E',
      '\u2066',
      '\u2067',
      '\u2068',
      '\u2069',
    ];
    const evidence = skillLog(
      `##[error]AssertionError: real failure${[...controls, ...bidi].join('')}\ttail\nsecond line`,
    );
    expect(evidence).toContain('real failure');
    expect(evidence).toContain('\ttail');
    expect(evidence).toContain('second line');
    expect(evidence).not.toMatch(/\p{Bidi_Control}/u);
    // eslint-disable-next-line no-control-regex -- the class under test is the control set
    expect(evidence).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u);
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
