/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  actOnDecision,
  actOnDecisions,
  resetSuccessfulFailures,
  selectCandidateTargets,
  selectTarget,
  writeSkillInput,
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
    async currentHeadSha() {
      return 'abc123';
    },
    async isCurrentFailure() {
      return true;
    },
    async behindBy() {
      return 1;
    },
    async mainRunSucceeded() {
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
    expect(script).toContain("'pr',\n        'view'");
    expect(script).toContain("'--search',");
    expect(script).toContain("'--limit',\n        '1000'");
  });

  it('asks GitHub to prefilter PRs with failed checks', () => {
    expect(script).toContain('`updated:>=${activeSince} status:failure`');
  });

  it('bounds each skill batch after scanning all eligible failed PRs', () => {
    expect(script).toContain('DEFAULT_MAX_CANDIDATES_PER_RUN');
    expect(script).toContain('maxCandidates = Infinity');
    expect(script).toContain('if (candidates.length >= maxCandidates) break;');
    expect(script).toContain('async function skillCandidate');
    expect(script).toContain('const inputs = [];');
    expect(script).toContain('await skillCandidate(');
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
} else if (args[0] === 'pr' && args[1] === 'view') {
  process.stdout.write('[]');
} else if (args[0] === 'run' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ databaseId: 456, headSha: 'main-head', conclusion: 'success' }]));
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
          '30',
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

  it('can rank candidates before fetching comments', () => {
    expect(selectCandidateTargets([pr()], { now: NOW })).toMatchObject([
      {
        prNumber: 42,
        runId: 123,
      },
    ]);
  });

  it('keeps one newest failed run per PR while retaining every failed PR', () => {
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
      ['rerunFailedJobs', 123],
      [
        'comment',
        42,
        expect.stringContaining(
          'qwen-ci-flaky-rerun v=2 pr=42 head=abc123 run=123',
        ),
      ],
    ]);
    expect(client.calls[1][2]).toContain('action=rerun key=unknown');
    expect(client.calls[1][2]).toContain('count=1');
  });

  it('counts matching failures across PR head changes', async () => {
    const client = runner();
    client.failureActionCount = async () => 2;
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

    expect(client.calls[1][2]).toContain('key=runner-network-timeout');
    expect(client.calls[1][2]).toContain('count=3');
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

  it('derives the trusted marker identity from the active gh token', () => {
    expect(script).toContain('async viewerLogin()');
    expect(script).toContain("['api', 'user', '--jq', '.login']");
    expect(script).toContain("args.get('trusted-marker-login')");
    expect(script).not.toContain('qwen-code-ci-bot');
    expect(script).not.toContain('github-actions[bot]');
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

  it('keeps gh diagnostics bounded and visible', () => {
    expect(script).toContain('timeout: 60_000');
    expect(script).toContain('error.stderr || error.message');
    expect(script).toContain('throw new Error(`missing value for ${argv[i]}`)');
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
    client.currentHeadSha = async (prNumber) =>
      prNumber === 42 ? 'abc123' : 'def456';

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
    expect(client.calls[0]).toEqual(['rerunFailedJobs', 123]);
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

  it('records a marker only after rerunning failed jobs', async () => {
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

    expect(client.calls).toEqual([['rerunFailedJobs', 123]]);
  });

  it('updates a still-behind branch only for a high-confidence skill decision', async () => {
    const client = runner();
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      mainHeadSha: 'main-head',
      mainRunId: 456,
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
    client.currentHeadSha = async (prNumber) =>
      prNumber === 42 ? 'abc123' : 'def456';

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
      ['rerunFailedJobs', 123],
      ['rerunFailedJobs', 124],
      ['comment', 43, expect.stringContaining('action=rerun')],
    ]);
  });

  it('does not update a branch when main advanced after classification', async () => {
    const client = runner();
    client.mainHeadSha = async () => 'new-main-head';
    const target = {
      ...selectTarget([pr()], { now: NOW }),
      mainHeadSha: 'main-head',
      mainRunId: 456,
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

  it('allows a bounded large job log before extracting the failure excerpt', () => {
    expect(script).toContain('maxBuffer: 16 * 1024 * 1024');
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

  it('does not rerun low-confidence decisions and records no-action state', async () => {
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

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].slice(0, 2)).toEqual(['comment', 42]);
    expect(client.calls[0][2]).toContain(
      'action=no_action key=unknown check=E2E%20Tests count=0',
    );
    expect(client.calls[0][2]).toMatch(/^<!-- qwen-ci-flaky-rerun v=2 .* -->$/);
  });
});
