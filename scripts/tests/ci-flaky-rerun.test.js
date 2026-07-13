/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  actOnDecision,
  actOnDecisions,
  fingerprint,
  resetSuccessfulFailures,
  selectCandidateTargets,
  selectTarget,
  writeSkillInputs,
} from '../../.github/scripts/ci-flaky-rerun.mjs';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
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
    async behindBy() {
      return 1;
    },
    async mainRunSucceeded(_runId, workflow) {
      if (workflow !== 'ci.yml') return false;
      return true;
    },
    async mainHeadSha() {
      return 'main-head';
    },
    async failureActionCount() {
      return 0;
    },
    async updateBranch(prNumber, headSha) {
      calls.push(['updateBranch', prNumber, headSha]);
    },
  };
}

describe('ci flaky rerun patrol', () => {
  it('runs when invoked through the workflow relative script path', () => {
    expect(() =>
      execFileSync('node', ['.github/scripts/ci-flaky-rerun.mjs', 'invalid'], {
        encoding: 'utf8',
      }),
    ).toThrow(/command must be scan, act, or reset/);
  });

  it('reports clear required argument errors before invoking gh', () => {
    expect(() =>
      execFileSync(
        'node',
        [
          '.github/scripts/ci-flaky-rerun.mjs',
          'scan',
          '--workdir',
          tmpdir(),
          '--trusted-marker-login',
          'qwen-code-ci-bot',
        ],
        { encoding: 'utf8' },
      ),
    ).toThrow(/--repo is required/);

    expect(() =>
      execFileSync(
        'node',
        [
          '.github/scripts/ci-flaky-rerun.mjs',
          'act',
          '--repo',
          'QwenLM/qwen-code',
          '--trusted-marker-login',
          'qwen-code-ci-bot',
        ],
        { encoding: 'utf8' },
      ),
    ).toThrow(/--workdir is required/);
  });

  it('selects the newest stale failed PR run', () => {
    expect(selectTarget([pr()], { now: NOW, staleMinutes: 30 })).toMatchObject({
      prNumber: 42,
      headSha: 'abc123',
      runId: 123,
      workflowName: 'E2E Tests',
    });
  });

  it('prioritizes the oldest stale failure so new failures cannot starve it', () => {
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
      prNumber: 41,
      runId: 122,
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

  it('accepts either a regular or non-breaking space after handled markers', () => {
    expect(script).toContain('(?:\\\\x20|\\\\u00a0)');
    expect(script).not.toContain('(?: | )');
  });

  it('does not trust a hidden marker posted by an unrecognized account', () => {
    const marker =
      '<!-- qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=123 action=comment count=1 -->';

    expect(
      selectTarget(
        [
          pr({
            comments: [{ body: marker, author: { login: 'untrusted-user' } }],
          }),
        ],
        { now: NOW, trustedMarkerLogins: ['trusted-patrol-bot'] },
      ),
    ).toMatchObject({ prNumber: 42, runId: 123 });
  });

  it('skips PRs that were not active during the patrol window', () => {
    expect(
      selectTarget([pr({ updatedAt: '2026-07-05T07:59:00.000Z' })], {
        now: NOW,
        activeDays: 7,
      }),
    ).toBeNull();
  });

  it('leaves PR-level failure limits to the action phase', () => {
    const priorActions = [120, 121, 122].map((runId) => ({
      body: `<!-- qwen-ci-flaky-rerun v=1 pr=42 head=abc123 run=${runId} -->`,
    }));

    expect(
      selectTarget([pr({ comments: priorActions })], { now: NOW }),
    ).toMatchObject({ headSha: 'abc123' });
    expect(
      selectTarget([pr({ headRefOid: 'new-head', comments: priorActions })], {
        now: NOW,
      }),
    ).toMatchObject({ headSha: 'new-head' });
  });

  it('allows the next rerun attempt of the same workflow run', () => {
    const prior = {
      body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=123 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=1 -->',
    };
    expect(
      selectTarget(
        [
          pr({
            comments: [prior],
            statusCheckRollup: [run({ runAttempt: 2 })],
          }),
        ],
        { now: NOW },
      ),
    ).toMatchObject({ runId: 123 });
  });

  it('keeps bulk PR scanning light and checks comments after selection', () => {
    expect(script).toContain(
      "'number,isDraft,baseRefName,headRefOid,updatedAt,statusCheckRollup'",
    );
    expect(script).not.toContain(
      "'number,isDraft,baseRefName,headRefOid,updatedAt,statusCheckRollup,comments'",
    );
    expect(script).toContain('issues/${prNumber}/comments');
    expect(script).toContain("'--search',");
    expect(script).toContain("'--limit',\n        '1000'");
  });

  it('asks GitHub to prefilter PRs with failed checks', () => {
    expect(script).toContain('`updated:>=${activeSince} status:failure`');
  });

  it('reads marker comments through the paginated issue comments endpoint', () => {
    expect(script).toContain("'--paginate'");
    expect(script).toContain(
      '`repos/${this.repo}/issues/${prNumber}/comments`',
    );
    expect(script).toContain(
      "'.[] | {body, createdAt: .created_at, author: {login: .user.login}}'",
    );
    expect(script).not.toContain(
      "'comments',\n        '--jq',\n        '.comments'",
    );
  });

  it('bounds each skill batch after scanning all eligible failed PRs', () => {
    expect(script).toContain('DEFAULT_MAX_CANDIDATES_PER_RUN');
    expect(script).toContain('maxCandidates = Infinity');
    expect(script).toContain('if (candidates.length >= maxCandidates) break;');
    expect(script).toContain('async function skillCandidate');
    expect(script).toContain('const inputs = [];');
    expect(script).toContain('await skillCandidate(');
  });

  it('does not keep the superseded single-target skill input writer', () => {
    expect(script).not.toContain('export async function writeSkillInput(');
    expect(script).toContain('writeSkillInputs');
  });

  it('continues scanning when an early candidate has an expired job log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-scan-'));
    try {
      const fakeGh = join(dir, 'gh');
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
function pr(number, head, run, job) {
  return {
    number,
    isDraft: false,
    baseRefName: 'main',
    headRefOid: head,
    updatedAt: '2026-07-12T07:30:00.000Z',
    statusCheckRollup: [{
      databaseId: job,
      name: 'E2E Tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-07-12T07:20:00.000Z',
      detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/' + run + '/jobs/' + job,
    }],
  };
}
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([pr(42, 'old-head', 123, 1), pr(43, 'new-head', 124, 2)]));
} else if (args[0] === 'api' && args[1] === '--paginate' && args[2].includes('/issues/')) {
  process.stdout.write('');
} else if (args[0] === 'api' && args[1].includes('/actions/workflows/ci.yml/runs')) {
  process.stdout.write(JSON.stringify({ workflow_runs: [{ id: 456, head_sha: 'main-head', event: 'push', conclusion: 'success' }] }));
} else if (args[0] === 'api' && args[1].includes('/commits/main')) {
  process.stdout.write('main-head\\n');
} else if (args[0] === 'api' && args[1].includes('/compare/')) {
  process.stdout.write('1\\n');
} else if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
  process.stdout.write('1\\n');
} else if (args[0] === 'api' && args[1].includes('/actions/jobs/1/logs')) {
  process.exit(1);
} else if (args[0] === 'api' && args[1].includes('/actions/jobs/2/logs')) {
  process.stdout.write('Error: runner network timeout\\n');
} else {
  process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
  process.exit(1);
}
`,
      );
      chmodSync(fakeGh, 0o755);

      const output = execFileSync(
        'node',
        [
          '.github/scripts/ci-flaky-rerun.mjs',
          'scan',
          '--repo',
          'QwenLM/qwen-code',
          '--workdir',
          dir,
          '--stale-minutes',
          'not-a-number',
          '--active-days',
          '7',
          '--max-candidates',
          '1',
          '--trusted-marker-login',
          'trusted-patrol-bot',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        },
      );

      expect(output).toContain('target_found=true');
      const input = JSON.parse(readFileSync(join(dir, 'ci-flaky-input.json')));
      expect(input.candidates).toHaveLength(1);
      expect(input.candidates[0]).toMatchObject({
        prNumber: 43,
        runId: 124,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('continues to an older unhandled run when the newest run was handled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-scan-'));
    try {
      const fakeGh = join(dir, 'gh');
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    number: 42,
    isDraft: false,
    baseRefName: 'main',
    headRefOid: 'abc123',
    updatedAt: '2026-07-12T07:30:00.000Z',
    statusCheckRollup: [
      {
        databaseId: 1,
        name: 'E2E Tests',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        completedAt: '2026-07-12T07:10:00.000Z',
        detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/123/jobs/1',
      },
      {
        databaseId: 2,
        name: 'E2E Tests',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        completedAt: '2026-07-12T07:20:00.000Z',
        detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/124/jobs/2',
      },
    ],
  }]));
} else if (args[0] === 'api' && args[1] === '--paginate' && args[2].includes('/issues/')) {
  process.stdout.write(JSON.stringify({
    body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=124 attempt=1 action=rerun key=old check=E2E%20Tests count=1 -->',
    createdAt: '2026-07-12T07:25:00Z',
    author: { login: 'trusted-patrol-bot' },
  }) + '\\n');
} else if (args[0] === 'api' && args[1].includes('/actions/workflows/ci.yml/runs')) {
  process.stdout.write(JSON.stringify({ workflow_runs: [{ id: 456, head_sha: 'main-head', event: 'push', conclusion: 'success' }] }));
} else if (args[0] === 'api' && args[1].includes('/commits/main')) {
  process.stdout.write('main-head\\n');
} else if (args[0] === 'api' && args[1].includes('/compare/')) {
  process.stdout.write('1\\n');
} else if (args[0] === 'api' && args[1].includes('/actions/runs/')) {
  process.stdout.write('1\\n');
} else if (args[0] === 'api' && args[1].includes('/actions/jobs/1/logs')) {
  process.stdout.write('Error: runner network timeout\\n');
} else {
  process.stderr.write('unexpected gh call: ' + args.join(' ') + '\\n');
  process.exit(1);
}
`,
      );
      chmodSync(fakeGh, 0o755);

      const output = execFileSync(
        'node',
        [
          '.github/scripts/ci-flaky-rerun.mjs',
          'scan',
          '--repo',
          'QwenLM/qwen-code',
          '--workdir',
          dir,
          '--max-candidates',
          '1',
          '--trusted-marker-login',
          'trusted-patrol-bot',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        },
      );

      expect(output).toContain('target_found=true');
      const input = JSON.parse(readFileSync(join(dir, 'ci-flaky-input.json')));
      expect(input.candidates).toMatchObject([{ prNumber: 42, runId: 123 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('skips a candidate when the workflow run attempt changed after scanning', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-scan-'));
    try {
      const fakeGh = join(dir, 'gh');
      writeFileSync(
        fakeGh,
        `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{
    number: 42,
    isDraft: false,
    baseRefName: 'main',
    headRefOid: 'abc123',
    updatedAt: '2026-07-12T07:30:00.000Z',
    statusCheckRollup: [{
      databaseId: 1,
      name: 'E2E Tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      completedAt: '2026-07-12T07:20:00.000Z',
      detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/123/jobs/1',
      runAttempt: 1,
    }],
  }]));
} else if (args[0] === 'api' && args[1].includes('/actions/runs/123')) {
  process.stdout.write('2\\n');
} else {
  process.stdout.write(args[0] === 'api' && args[1] === '--paginate' ? '' : '[]');
}
`,
      );
      chmodSync(fakeGh, 0o755);

      const output = execFileSync(
        'node',
        [
          '.github/scripts/ci-flaky-rerun.mjs',
          'scan',
          '--repo',
          'QwenLM/qwen-code',
          '--workdir',
          dir,
          '--max-candidates',
          '1',
          '--trusted-marker-login',
          'trusted-patrol-bot',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        },
      );

      expect(output).toContain('target_found=false');
      const input = JSON.parse(readFileSync(join(dir, 'ci-flaky-input.json')));
      expect(input.candidates).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('can rank candidates before fetching comments', () => {
    expect(selectCandidateTargets([pr()], { now: NOW })).toMatchObject([
      {
        prNumber: 42,
        runId: 123,
      },
    ]);
  });

  it('orders each PR by newest failure without letting newer PRs starve older PRs', () => {
    expect(
      selectCandidateTargets([
        pr({
          number: 41,
          headRefOid: 'first',
          statusCheckRollup: [
            run({
              completedAt: '2026-07-12T07:00:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/121/jobs/1',
            }),
            run({
              completedAt: '2026-07-12T07:10:00.000Z',
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/122/jobs/1',
            }),
          ],
        }),
        pr(),
      ]).map((target) => [target.prNumber, target.runId]),
    ).toEqual([
      [41, 122],
      [41, 121],
      [42, 123],
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
          'qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=123',
        ),
      ],
      ['rerunFailedJobs', 123],
    ]);
    expect(client.calls[0][2]).toContain('action=rerun key=unknown');
    expect(client.calls[0][2]).toContain('count=1');
  });

  it('counts matching failures across PR head changes', async () => {
    const client = runner();
    const countCalls = [];
    client.failureActionCount = async (...args) => {
      countCalls.push(args);
      return 2;
    };
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      failureKey: 'runner-network-timeout',
    };

    await actOnDecision(client, target, {
      action: 'rerun',
      confidence: 'high',
      failureKey: 'runner-network-timeout',
      reason_en: 'The log shows a runner network timeout.',
      reason_zh: '日志显示 runner 网络超时。',
    });

    expect(client.calls[0][2]).toContain('key=runner-network-timeout');
    expect(client.calls[0][2]).toContain('count=3');
    expect(countCalls).toEqual([[42, 'abc123', 'runner-network-timeout']]);
  });

  it('uses the PR head when reading prior action counts', () => {
    expect(script).toContain(
      'async failureActionCount(prNumber, headSha, key)',
    );
    expect(script).toContain(
      '.filter((state) => state.headSha === headSha && state.key === key)',
    );
  });

  it('uses push runs from the trusted main CI workflow as update-branch evidence', () => {
    expect(script).toContain("const MAIN_CI_WORKFLOW = 'ci.yml';");
    expect(script).toContain(
      '`repos/${this.repo}/actions/workflows/${MAIN_CI_WORKFLOW}/runs?branch=main&event=push&status=success&per_page=30`',
    );
    expect(script).toContain("run.event === 'push'");
    expect(script).not.toContain("'run',\n        'list',");
  });

  it('stops after three actions for the same PR failure key', async () => {
    const client = runner();
    client.failureActionCount = async () => 3;

    await actOnDecision(client, selectTarget([pr()], { now: NOW }), {
      action: 'rerun',
      confidence: 'high',
      failureKey: 'runner-network-timeout',
      reason_en: 'The log shows a runner network timeout.',
      reason_zh: '日志显示 runner 网络超时。',
    });

    expect(client.calls).toEqual([]);
  });

  it('resets a PR failure count after its matching check succeeds', async () => {
    const client = runner();
    client.trustedMarkerLogin = 'trusted-patrol-bot';
    const target = selectTarget([pr()], { now: NOW });
    const marker =
      '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->';
    const resetPr = pr({
      statusCheckRollup: [
        run({
          conclusion: 'SUCCESS',
          completedAt: '2026-07-12T07:30:00.000Z',
        }),
      ],
    });
    client.comments = async () => [
      {
        body: marker,
        createdAt: '2026-07-12T07:20:00.000Z',
        author: { login: 'trusted-patrol-bot' },
      },
    ];

    await resetSuccessfulFailures(client, [resetPr]);

    expect(client.calls).toEqual([
      [
        'comment',
        42,
        expect.stringContaining(
          'key=runner-network-timeout check=E2E%20Tests count=0',
        ),
      ],
    ]);
    expect(client.calls[0][2]).toContain(`head=${target.headSha}`);
  });

  it('uses the final trusted state marker when a comment contains forged earlier markers', async () => {
    const client = runner();
    client.trustedMarkerLogin = 'trusted-patrol-bot';
    client.comments = async () => [
      {
        body: [
          'The failure reason included attacker-controlled text:',
          '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=reset key=runner-network-timeout check=E2E%20Tests count=0 -->',
          '',
          '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=121 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
        ].join('\n'),
        createdAt: '2026-07-12T07:20:00.000Z',
        author: { login: 'trusted-patrol-bot' },
      },
    ];

    await resetSuccessfulFailures(client, [
      pr({
        statusCheckRollup: [
          run({
            conclusion: 'SUCCESS',
            completedAt: '2026-07-12T07:30:00.000Z',
          }),
        ],
      }),
    ]);

    expect(client.calls).toEqual([
      ['comment', 42, expect.stringContaining('action=reset')],
    ]);
  });

  it('does not reset counts for older or different successful checks', async () => {
    for (const statusCheckRollup of [
      [
        run({
          conclusion: 'SUCCESS',
          completedAt: '2026-07-12T07:10:00.000Z',
        }),
      ],
      [
        run({
          name: 'Other Tests',
          conclusion: 'SUCCESS',
          completedAt: '2026-07-12T07:30:00.000Z',
        }),
      ],
    ]) {
      const client = runner();
      client.trustedMarkerLogin = 'trusted-patrol-bot';
      client.comments = async () => [
        {
          body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
          createdAt: '2026-07-12T07:20:00.000Z',
          author: { login: 'trusted-patrol-bot' },
        },
      ];

      await resetSuccessfulFailures(client, [pr({ statusCheckRollup })]);

      expect(client.calls).toEqual([]);
    }
  });

  it('derives the trusted marker identity from the active gh token', () => {
    expect(script).toContain('async viewerLogin()');
    expect(script).toContain("['api', 'user', '--jq', '.login']");
    expect(script).toContain("args.get('trusted-marker-login')");
    expect(script).not.toContain('qwen-code-ci-bot');
    expect(script).not.toContain('github-actions[bot]');
    expect(script).toContain('constructor(repo) {');
    expect(script).not.toContain('constructor(repo, trustedMarkerLogin)');
  });

  it('ignores reset markers from untrusted accounts', async () => {
    const client = runner();
    client.trustedMarkerLogin = 'trusted-patrol-bot';
    client.comments = async () => [
      {
        body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
        createdAt: '2026-07-12T07:20:00.000Z',
        author: { login: 'random-user' },
      },
    ];

    await resetSuccessfulFailures(client, [
      pr({
        statusCheckRollup: [
          run({
            conclusion: 'SUCCESS',
            completedAt: '2026-07-12T07:30:00.000Z',
          }),
        ],
      }),
    ]);

    expect(client.calls).toEqual([]);
  });

  it('keeps resetting later PRs after one reset lookup fails', async () => {
    const client = runner();
    client.trustedMarkerLogin = 'trusted-patrol-bot';
    client.comments = async (prNumber) => {
      if (prNumber === 41) throw new Error('temporary comments failure');
      return [
        {
          body: '<!-- qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=120 attempt=1 action=rerun key=runner-network-timeout check=E2E%20Tests count=2 -->',
          createdAt: '2026-07-12T07:20:00.000Z',
          author: { login: 'trusted-patrol-bot' },
        },
      ];
    };

    await resetSuccessfulFailures(client, [
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

    expect(client.calls).toEqual([
      ['comment', 42, expect.stringContaining('action=reset')],
    ]);
  });

  it('keeps gh diagnostics bounded and visible', () => {
    expect(script).toContain('timeout: 60_000');
    expect(script).toContain('error.stderr || error.message');
    expect(script).toContain('throw new Error(`missing value for ${argv[i]}`)');
    expect(script).toMatch(
      /maxBuffer: 16 \* 1024 \* 1024,[\s\S]*\.\.\.options,[\s\S]*timeout: 60_000/,
    );
    expect(script.indexOf(".replace(/[a-f0-9]{8,}/g, '#')")).toBeLessThan(
      script.indexOf(".replace(/\\d+/g, '#')"),
    );
  });

  it('applies only decisions that match an input target', async () => {
    const client = runner();
    const targets = [
      selectTarget([pr()], { now: NOW }),
      selectTarget(
        [
          pr({
            number: 43,
            headRefOid: 'def456',
            statusCheckRollup: [
              run({
                detailsUrl:
                  'https://github.com/QwenLM/qwen-code/actions/runs/124/jobs/2',
              }),
            ],
          }),
        ],
        { now: NOW },
      ),
    ];
    await actOnDecisions(client, targets, [
      {
        prNumber: 42,
        headSha: 'abc123',
        runId: 123,
        action: 'rerun',
        confidence: 'high',
        reason_en: 'runner timeout',
        reason_zh: 'runner 超时。',
      },
      {
        prNumber: 99,
        headSha: 'unknown',
        runId: 999,
        action: 'rerun',
        confidence: 'high',
        reason_en: 'must not run',
        reason_zh: '不得执行。',
      },
    ]);

    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]).toEqual([
      'comment',
      42,
      expect.stringContaining('action=rerun'),
    ]);
    expect(client.calls[1]).toEqual(['rerunFailedJobs', 123]);
  });

  it('ignores duplicate decisions for the same scanned target', async () => {
    const client = runner();
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecisions(
      client,
      [target],
      [
        {
          prNumber: 42,
          headSha: 'abc123',
          runId: 123,
          action: 'rerun',
          confidence: 'high',
          reason_en: 'runner timeout',
          reason_zh: 'runner 超时。',
        },
        {
          prNumber: 42,
          headSha: 'abc123',
          runId: 123,
          action: 'rerun',
          confidence: 'high',
          reason_en: 'runner timeout',
          reason_zh: 'runner 超时。',
        },
      ],
    );

    expect(
      client.calls.filter((call) => call[0] === 'rerunFailedJobs'),
    ).toEqual([['rerunFailedJobs', 123]]);
  });

  it('does not trust a decision with a mismatched failure key', async () => {
    const client = runner();
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      failureKey: 'check-real-failure',
    };

    await actOnDecision(client, target, {
      action: 'rerun',
      confidence: 'high',
      failureKey: 'check-other-failure',
      reason_en: 'runner timeout',
      reason_zh: 'runner 超时。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not act when the failed run is no longer current', async () => {
    const client = runner();
    client.isCurrentFailure = async () => false;

    await actOnDecision(client, selectTarget([pr()], { now: NOW }), {
      action: 'rerun',
      confidence: 'high',
      reason_en: 'The log shows a runner network timeout.',
      reason_zh: '日志显示 runner 网络超时。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not rerun without a failure explanation', async () => {
    const client = runner();

    await actOnDecision(client, selectTarget([pr()], { now: NOW }), {
      action: 'rerun',
      confidence: 'high',
      reason_zh: '日志显示 runner 网络超时。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not rerun when recording the marker fails', async () => {
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
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      mainHeadSha: 'main-head',
      mainRunId: 456,
      mainWorkflow: 'ci.yml',
    };

    await actOnDecision(client, target, {
      action: 'update_branch',
      confidence: 'high',
      mainRunId: 456,
      reason_en: 'This branch needs current main CI configuration.',
      reason_zh: '该分支需要同步 main 的 CI 配置。',
    });

    expect(client.calls).toEqual([
      ['updateBranch', 42, 'abc123'],
      [
        'comment',
        42,
        expect.stringContaining(
          'qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=123',
        ),
      ],
    ]);
  });

  it('does not update a branch without a matching main workflow identity', async () => {
    const client = runner();
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      mainHeadSha: 'main-head',
      mainRunId: 456,
      mainWorkflow: 'other.yml',
    };

    await actOnDecision(client, target, {
      action: 'update_branch',
      confidence: 'high',
      mainRunId: 456,
      reason_en: 'main contains the needed CI fix',
      reason_zh: 'main 包含所需的 CI 修复。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not update a branch when a branch-writing guard fails', async () => {
    const completeTarget = {
      ...selectTarget([pr()], { now: NOW }),
      mainHeadSha: 'main-head',
      mainRunId: 456,
      mainWorkflow: 'ci.yml',
    };
    const cases = [
      { mutate: (client) => (client.behindBy = async () => 0) },
      {
        decision: { mainRunId: 999 },
      },
      { mutate: (client) => (client.mainRunSucceeded = async () => false) },
      {
        target: (({ mainHeadSha: _mainHeadSha, ...target }) => target)(
          completeTarget,
        ),
      },
    ];

    for (const testCase of cases) {
      const client = runner();
      testCase.mutate?.(client);

      await actOnDecision(client, testCase.target ?? completeTarget, {
        action: 'update_branch',
        confidence: 'high',
        mainRunId: 456,
        reason_en: 'main contains the needed CI fix',
        reason_zh: 'main 包含所需的 CI 修复。',
        ...testCase.decision,
      });

      expect(client.calls).toEqual([]);
    }
  });

  it('does not update a branch without a verified successful main run', async () => {
    const client = runner();

    await actOnDecision(client, selectTarget([pr()], { now: NOW }), {
      action: 'update_branch',
      confidence: 'high',
      reason_en: 'This branch needs current main CI configuration.',
      reason_zh: '该分支需要同步 main 的 CI 配置。',
    });

    expect(client.calls).toEqual([]);
  });

  it('keeps applying later decisions after one action fails', async () => {
    const client = runner();
    client.rerunFailedJobs = async (runId) => {
      client.calls.push(['rerunFailedJobs', runId]);
      if (runId === 123) throw new Error('temporary gh failure');
    };
    await actOnDecisions(
      client,
      [
        selectTarget([pr()], { now: NOW }),
        {
          ...selectTarget([pr()], { now: NOW }),
          prNumber: 43,
          headSha: 'def456',
          runId: 124,
        },
      ],
      [
        {
          prNumber: 42,
          headSha: 'abc123',
          runId: 123,
          action: 'rerun',
          confidence: 'high',
          reason_en: 'runner timeout',
          reason_zh: 'runner 超时。',
        },
        {
          prNumber: 43,
          headSha: 'def456',
          runId: 124,
          action: 'rerun',
          confidence: 'high',
          reason_en: 'runner timeout',
          reason_zh: 'runner 超时。',
        },
      ],
    );

    expect(client.calls).toEqual([
      ['comment', 42, expect.stringContaining('action=rerun')],
      ['rerunFailedJobs', 123],
      ['comment', 43, expect.stringContaining('action=rerun')],
      ['rerunFailedJobs', 124],
    ]);
  });

  it('does not update a branch when main advanced after classification', async () => {
    const client = runner();
    client.mainHeadSha = async () => 'new-main-head';
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      mainHeadSha: 'main-head',
      mainRunId: 456,
      mainWorkflow: 'ci.yml',
    };

    await actOnDecision(client, target, {
      action: 'update_branch',
      confidence: 'high',
      mainRunId: 456,
      reason_en: 'main contains the needed CI fix',
      reason_zh: 'main 包含所需的 CI 修复。',
    });

    expect(client.calls).toEqual([]);
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

  it('does not post blank failure explanations', async () => {
    const client = runner();
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'comment',
      confidence: 'high',
      reason_en: 'The i18n check found an extra locale key.',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not update a branch after a new push changes its head', async () => {
    const client = runner();
    client.currentPr = async () => ({
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefOid: 'new-head',
    });
    const target = selectTarget([pr()], { now: NOW });

    await actOnDecision(client, target, {
      action: 'update_branch',
      confidence: 'high',
      reason_en: 'This branch needs current main CI configuration.',
      reason_zh: '该分支需要同步 main 的 CI 配置。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not act when the PR is closed, draft, or retargeted away from main', async () => {
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
    ]) {
      const client = runner();
      client.currentPr = async () => currentPr;

      await actOnDecision(client, selectTarget([pr()], { now: NOW }), {
        action: 'rerun',
        confidence: 'high',
        reason_en: 'The log shows a runner network timeout.',
        reason_zh: '日志显示 runner 网络超时。',
      });

      expect(client.calls).toEqual([]);
    }
  });

  it('does not rerun or comment after a new push changes the head', async () => {
    const client = runner();
    client.currentPr = async () => ({
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      headRefOid: 'new-head',
    });
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

  it('writes a single batch input with each target and its sanitized log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const targets = [
      selectTarget([pr()], { now: NOW }),
      {
        ...selectTarget([pr()], { now: NOW }),
        prNumber: 43,
        headSha: 'def456',
        runId: 124,
        jobId: 2,
      },
    ];
    try {
      await writeSkillInputs(
        {
          async jobLog(jobId) {
            return jobId === 1
              ? 'network timeout while downloading package'
              : 'AssertionError: expected generated schema';
          },
        },
        targets,
        dir,
      );

      const input = JSON.parse(
        readFileSync(join(dir, 'ci-flaky-input.json'), 'utf8'),
      );
      expect(input.candidates).toMatchObject([
        {
          prNumber: 42,
          runId: 123,
          log: 'network timeout while downloading package',
        },
        {
          prNumber: 43,
          runId: 124,
          log: 'AssertionError: expected generated schema',
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips an expired job log without abandoning the remaining batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const targets = [
      selectTarget([pr()], { now: NOW }),
      {
        ...selectTarget([pr()], { now: NOW }),
        prNumber: 43,
        headSha: 'def456',
        runId: 124,
        jobId: 2,
      },
    ];
    try {
      await writeSkillInputs(
        {
          async jobLog(jobId) {
            if (jobId === 1) throw new Error('HTTP 410');
            return 'network timeout while downloading package';
          },
        },
        targets,
        dir,
        1,
      );

      const input = JSON.parse(
        readFileSync(join(dir, 'ci-flaky-input.json'), 'utf8'),
      );
      expect(input.candidates).toMatchObject([{ prNumber: 43, runId: 124 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs skipped skill input targets with the GitHub error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const originalWrite = process.stderr.write;
    const stderr = [];
    process.stderr.write = (chunk) => {
      stderr.push(String(chunk));
      return true;
    };
    try {
      await writeSkillInputs(
        {
          async jobLog() {
            throw new Error('HTTP 410');
          },
        },
        [selectTarget([pr()], { now: NOW })],
        dir,
      );

      expect(stderr.join('')).toContain(
        'writeSkillInputs: skipping job 1 (PR 42): HTTP 410',
      );
    } finally {
      process.stderr.write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the end of long job logs so the failure is visible', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = selectTarget([pr()], { now: NOW });
    try {
      await writeSkillInputs(
        {
          async jobLog() {
            return `${'setup log\n'.repeat(3000)}AssertionError: expected true to be false`;
          },
        },
        [target],
        dir,
      );

      const log = JSON.parse(
        readFileSync(join(dir, 'ci-flaky-input.json'), 'utf8'),
      ).candidates[0].log;
      expect(log.length).toBeLessThanOrEqual(20_000);
      expect(log).toContain('AssertionError');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps failure summaries that appear before post-job cleanup output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = selectTarget([pr()], { now: NOW });
    try {
      await writeSkillInputs(
        {
          async jobLog() {
            return [
              'setup output',
              ' ❯ src/core/coreToolScheduler.test.ts (65 tests | 3 failed)',
              '   × CoreToolScheduler validation retry loop detection > should inject RETRY LOOP DETECTED directive',
              '     → this.toolRegistry.ensureTool is not a function',
              ' Failed Tests 3 ',
              ' FAIL  src/core/coreToolScheduler.test.ts > CoreToolScheduler validation retry loop detection > should inject RETRY LOOP DETECTED directive',
              'TypeError: this.toolRegistry.ensureTool is not a function',
              ...Array.from(
                { length: 3000 },
                (_, index) => `post-job artifact upload output ${index}`,
              ),
            ].join('\n');
          },
        },
        [target],
        dir,
      );

      const log = JSON.parse(
        readFileSync(join(dir, 'ci-flaky-input.json'), 'utf8'),
      ).candidates[0].log;
      expect(log).toContain('coreToolScheduler.test.ts');
      expect(log).toContain('ensureTool is not a function');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('allows a bounded large job log before extracting the failure excerpt', () => {
    expect(script).toContain('maxBuffer: 16 * 1024 * 1024');
  });

  it('sends only redacted failure lines to the skill', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = selectTarget([pr()], { now: NOW });
    try {
      await writeSkillInputs(
        {
          async jobLog() {
            return [
              'normal setup output',
              'API_TOKEN=secret-value',
              'Errors:',
              'Cookie: session=another-session-secret',
              'Error: Set-Cookie: session=prefixed-session-secret',
              'Extra key in zh.js (not in en.js): "toolDisplayName.DeferredToolCall"',
              'Error: NODE_AUTH_TOKEN: another-secret',
              'Error: Authorization: Basic c2VjcmV0LWNyZWRlbnRpYWw=',
              'Failure: AWS key AKIAIOSFODNN7EXAMPLE',
              `Failure: xoxb-${'a'.repeat(24)}`,
              `Failure: ghr_${'c'.repeat(24)}`,
              `Failure: sk-proj-${'b'.repeat(32)}`,
              `Failure: npm_${'d'.repeat(36)}`,
              'Error: https://user:password@example.com/path',
              'Error: download timed out with Bearer abcdefghijklmnopqrstuvwxyz',
            ].join('\n');
          },
        },
        [target],
        dir,
      );

      const log = JSON.parse(
        readFileSync(join(dir, 'ci-flaky-input.json'), 'utf8'),
      ).candidates[0].log;
      expect(log).not.toContain('normal setup output');
      expect(log).toContain('Extra key in zh.js');
      expect(log).not.toContain('secret-value');
      expect(log).not.toContain('another-session-secret');
      expect(log).not.toContain('prefixed-session-secret');
      expect(log).not.toContain('another-secret');
      expect(log).not.toContain('c2VjcmV0LWNyZWRlbnRpYWw=');
      expect(log).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(log).not.toContain(`xoxb-${'a'.repeat(24)}`);
      expect(log).not.toContain(`ghr_${'c'.repeat(24)}`);
      expect(log).not.toContain(`sk-proj-${'b'.repeat(32)}`);
      expect(log).not.toContain(`npm_${'d'.repeat(36)}`);
      expect(log).not.toContain('user:password@');
      expect(log).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(log).toContain('download timed out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizes failure fingerprints deterministically', () => {
    const target = selectTarget([pr()], { now: NOW });

    expect(fingerprint(target, 'Error: 0x1a2b3c4d at line 123')).toBe(
      fingerprint(target, 'error: 0xdeadbeef at line 456'),
    );
    expect(fingerprint(target, 'Error: timeout')).toBe(
      fingerprint(target, 'Error: timeout'),
    );
    expect(fingerprint(target, 'Error: timeout')).not.toBe(
      fingerprint({ ...target, workflowName: 'Lint' }, 'Error: timeout'),
    );
  });

  it('writes an empty skill log when a failed check has no job URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-flaky-rerun-'));
    const target = { ...selectTarget([pr()], { now: NOW }), jobId: null };
    try {
      await writeSkillInputs(
        {
          async jobLog() {
            throw new Error('must not fetch a missing job log');
          },
        },
        [target],
        dir,
      );

      const input = JSON.parse(
        readFileSync(join(dir, 'ci-flaky-input.json'), 'utf8'),
      );
      expect(input.candidates).toMatchObject([
        { prNumber: 42, runId: 123, log: '' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not rerun low-confidence decisions and records no-action state', async () => {
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      failureKey: 'deterministic-test-failure',
    };
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
      failureKey: 'deterministic-test-failure',
      reason_en: 'test assertion failed',
      reason_zh: '测试断言失败。',
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].slice(0, 2)).toEqual(['comment', 42]);
    expect(client.calls[0][2]).toContain(
      'action=no_action key=deterministic-test-failure check=E2E%20Tests count=1',
    );
    expect(client.calls[0][2]).toMatch(/^<!-- qwen-ci-flaky-rerun v=2 .* -->$/);
  });

  it('stops no-action markers after three actions for the same PR failure key', async () => {
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      failureKey: 'deterministic-test-failure',
    };
    const client = runner();
    client.failureActionCount = async () => 3;

    await actOnDecision(client, target, {
      action: 'no_action',
      confidence: 'high',
      failureKey: 'deterministic-test-failure',
      reason_en: 'test assertion failed',
      reason_zh: '测试断言失败。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not record no-action state when the failed run is no longer current', async () => {
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      failureKey: 'deterministic-test-failure',
    };
    const client = runner();
    client.isCurrentFailure = async () => false;

    await actOnDecision(client, target, {
      action: 'no_action',
      confidence: 'high',
      failureKey: 'deterministic-test-failure',
      reason_en: 'test assertion failed',
      reason_zh: '测试断言失败。',
    });

    expect(client.calls).toEqual([]);
  });

  it('does not record no-action state when the PR is closed, draft, or retargeted', async () => {
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
    ]) {
      const client = runner();
      client.currentPr = async () => currentPr;

      await actOnDecision(
        client,
        {
          ...selectTarget([pr()], { now: NOW }),
          failureKey: 'deterministic-test-failure',
        },
        {
          action: 'no_action',
          failureKey: 'deterministic-test-failure',
        },
      );

      expect(client.calls).toEqual([]);
    }
  });
});
