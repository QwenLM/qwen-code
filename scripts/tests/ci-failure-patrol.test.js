/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  decideAttempt,
  extractActionsRunId,
  fetchFailedRunEvidence,
  findMainHandoffIssue,
  formatMainIssueMarker,
  formatPatrolMarker,
  GhClient,
  isStaleFailure,
  isPrTargetCurrent,
  nextAttempt,
  planPrAction,
  parsePatrolMarker,
  renderPrComment,
  handoffMainFailure,
  sanitizeLog,
  shouldDispatchAutofixIssue,
  validateClassifierDecision,
  selectMainTarget,
  selectPrTarget,
  verifyBotIdentity,
} from '../../.github/scripts/ci-failure-patrol.mjs';

const NOW = new Date('2026-07-12T08:00:00.000Z');

function prRun(overrides = {}) {
  return {
    id: 999001,
    workflowName: 'E2E Tests',
    status: 'completed',
    conclusion: 'failure',
    completedAt: '2026-07-12T07:29:00.000Z',
    htmlUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/1001',
    detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/1001/job/1',
    headSha: 'abc123',
    event: 'pull_request',
    ...overrides,
  };
}

function pr(overrides = {}) {
  return {
    number: 42,
    state: 'OPEN',
    isDraft: false,
    baseRefName: 'main',
    headRefOid: 'abc123',
    isCrossRepository: false,
    maintainerCanModify: true,
    mergeStateStatus: 'CLEAN',
    mainRelevantSuccess: false,
    statusCheckRollup: [prRun()],
    ...overrides,
  };
}

function mainRun(overrides = {}) {
  return {
    id: 2001,
    workflowId: 77,
    workflowName: 'E2E Tests',
    status: 'completed',
    conclusion: 'failure',
    completedAt: '2026-07-12T07:29:00.000Z',
    htmlUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/2001',
    headSha: 'main123',
    headBranch: 'main',
    ref: 'refs/heads/main',
    event: 'push',
    ...overrides,
  };
}

describe('ci failure patrol target selection', () => {
  it('uses the workflow run id from Actions URLs instead of check database ids', () => {
    expect(
      extractActionsRunId({
        id: 999001,
        detailsUrl:
          'https://github.com/QwenLM/qwen-code/actions/runs/123456789/job/11',
      }),
    ).toBe(123456789);

    expect(
      selectPrTarget(
        [
          pr({
            statusCheckRollup: [
              prRun({
                id: 999001,
                detailsUrl:
                  'https://github.com/QwenLM/qwen-code/actions/runs/123456789/job/11',
              }),
            ],
          }),
        ],
        { now: NOW },
      ),
    ).toMatchObject({ runId: 123456789 });
  });

  it('ignores PR failures that cannot be mapped to an Actions workflow run', () => {
    expect(
      selectPrTarget(
        [
          pr({
            statusCheckRollup: [
              prRun({
                id: 999001,
                detailsUrl: 'https://example.test/check-runs/999001',
                htmlUrl: '',
              }),
            ],
          }),
        ],
        { now: NOW },
      ),
    ).toBeNull();
  });

  it('requires a terminal failed run to be stale for at least 30 minutes', () => {
    expect(
      isStaleFailure(prRun({ completedAt: '2026-07-12T07:31:00.000Z' }), NOW),
    ).toBe(false);
    expect(isStaleFailure(prRun(), NOW)).toBe(true);
  });

  it('selects a PR failure after the grace period when no newer run exists', () => {
    expect(selectPrTarget([pr()], { now: NOW })).toMatchObject({
      scope: 'pr',
      prNumber: 42,
      runId: 1001,
      headSha: 'abc123',
      workflowName: 'E2E Tests',
    });
  });

  it('ignores failures that have a newer queued, running, or successful replacement', () => {
    for (const newerRun of [
      prRun({ id: 1002, status: 'queued', conclusion: null }),
      prRun({ id: 1002, status: 'in_progress', conclusion: null }),
      prRun({ id: 1002, conclusion: 'success' }),
    ]) {
      expect(
        selectPrTarget(
          [
            pr({
              statusCheckRollup: [
                prRun({ completedAt: '2026-07-12T07:00:00.000Z' }),
                newerRun,
              ],
            }),
          ],
          { now: NOW },
        ),
      ).toBeNull();
    }
  });

  it('ignores PRs and runs that are not eligible for patrol', () => {
    const cases = [
      pr({ isDraft: true }),
      pr({ state: 'CLOSED' }),
      pr({ statusCheckRollup: [prRun({ conclusion: 'skipped' })] }),
      pr({ statusCheckRollup: [prRun({ conclusion: 'neutral' })] }),
      pr({
        statusCheckRollup: [
          prRun({ conclusion: 'cancelled', superseded: true }),
        ],
      }),
      pr({ statusCheckRollup: [prRun({ workflowName: 'Qwen Autofix' })] }),
    ];

    for (const candidate of cases) {
      expect(selectPrTarget([candidate], { now: NOW })).toBeNull();
    }
  });

  it('chooses the oldest eligible PR failure deterministically', () => {
    const target = selectPrTarget(
      [
        pr({
          number: 2,
          statusCheckRollup: [
            prRun({
              id: 2,
              detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/2',
              headSha: 'two',
              completedAt: '2026-07-12T07:20:00.000Z',
            }),
          ],
        }),
        pr({
          number: 1,
          statusCheckRollup: [
            prRun({
              id: 1,
              detailsUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/1',
              headSha: 'one',
              completedAt: '2026-07-12T07:10:00.000Z',
            }),
          ],
        }),
      ],
      { now: NOW },
    );

    expect(target).toMatchObject({ prNumber: 1, runId: 1 });
  });

  it('selects only allowlisted main workflow failures on refs/heads/main', () => {
    expect(
      selectMainTarget(
        [
          mainRun({ workflowName: 'Release' }),
          mainRun({ workflowName: 'SDK Python', id: 2002 }),
        ],
        { now: NOW, allowlistedWorkflows: ['E2E Tests', 'SDK Python'] },
      ),
    ).toMatchObject({ scope: 'main', runId: 2002 });

    expect(
      selectMainTarget(
        [
          mainRun({ ref: 'refs/heads/release/v1', headBranch: 'release/v1' }),
          mainRun({ workflowName: 'Release' }),
        ],
        { now: NOW, allowlistedWorkflows: ['E2E Tests', 'SDK Python'] },
      ),
    ).toBeNull();
  });
});

describe('ci failure patrol attempt markers', () => {
  it('parses only valid v1 hidden markers', () => {
    expect(
      parsePatrolMarker(
        '<!-- qwen-ci-patrol v=1 scope=pr target=123 head=abc run=456 attempts=2 action=rerun handled=2026-07-12T00:00:00Z -->',
      ),
    ).toEqual({
      version: 1,
      scope: 'pr',
      target: '123',
      headSha: 'abc',
      runId: '456',
      attempts: 2,
      action: 'rerun',
      handledAt: '2026-07-12T00:00:00Z',
    });

    expect(parsePatrolMarker('<!-- qwen-ci-patrol v=2 attempts=1 -->')).toBe(
      null,
    );
    expect(
      parsePatrolMarker(
        '<!-- qwen-ci-patrol v=1 scope=pr target=123 head=abc run=456 attempts=NaN action=rerun handled=2026-07-12T00:00:00Z -->',
      ),
    ).toBe(null);
  });

  it('formats a marker without discarding visible comment text', () => {
    const body = [
      'The E2E check looks flaky.',
      '',
      '<details><summary>中文</summary>',
      '这个 E2E 检查看起来不稳定。',
      '</details>',
      '',
      formatPatrolMarker({
        scope: 'pr',
        target: '123',
        headSha: 'abc',
        runId: '456',
        attempts: 1,
        action: 'rerun',
        handledAt: '2026-07-12T00:00:00Z',
      }),
    ].join('\n');

    expect(body).toContain('The E2E check looks flaky.');
    expect(body).toContain('<details><summary>中文</summary>');
    expect(parsePatrolMarker(body)).toMatchObject({
      scope: 'pr',
      target: '123',
      attempts: 1,
    });
  });

  it('increments attempts for the same SHA and resets after a push', () => {
    const comments = [
      {
        author: { login: 'qwen-code-dev-bot' },
        body: formatPatrolMarker({
          scope: 'pr',
          target: '123',
          headSha: 'abc',
          runId: '456',
          attempts: 2,
          action: 'rerun',
          handledAt: '2026-07-12T00:00:00Z',
        }),
      },
      {
        author: { login: 'someone-else' },
        body: formatPatrolMarker({
          scope: 'pr',
          target: '123',
          headSha: 'abc',
          runId: '456',
          attempts: 3,
          action: 'rerun',
          handledAt: '2026-07-12T00:00:00Z',
        }),
      },
    ];

    expect(
      nextAttempt(comments, {
        botLogin: 'qwen-code-dev-bot',
        scope: 'pr',
        target: '123',
        headSha: 'abc',
      }),
    ).toBe(3);

    expect(
      nextAttempt(comments, {
        botLogin: 'qwen-code-dev-bot',
        scope: 'pr',
        target: '123',
        headSha: 'def',
      }),
    ).toBe(1);
  });

  it('returns one human handoff decision after three actions on a SHA', () => {
    const comments = [
      {
        author: { login: 'qwen-code-dev-bot' },
        body: formatPatrolMarker({
          scope: 'pr',
          target: '123',
          headSha: 'abc',
          runId: '456',
          attempts: 3,
          action: 'rerun',
          handledAt: '2026-07-12T00:00:00Z',
        }),
      },
    ];

    expect(
      decideAttempt(comments, {
        botLogin: 'qwen-code-dev-bot',
        scope: 'pr',
        target: '123',
        headSha: 'abc',
        maxAttempts: 3,
      }),
    ).toEqual({ action: 'human_handoff', attempts: 3 });
  });
});

describe('ci failure patrol classifier decisions', () => {
  it('accepts high-confidence mutating PR decisions with bilingual reasons', () => {
    expect(
      validateClassifierDecision(
        {
          classification: 'base_refresh',
          confidence: 'high',
          reason_en: 'The branch is behind main and current main is green.',
          reason_zh: '分支落后于 main，当前 main 已通过相关检查。',
          evidence: ['main E2E run passed on current main'],
        },
        { scope: 'pr' },
      ),
    ).toMatchObject({ classification: 'base_refresh', confidence: 'high' });
  });

  it('degrades unsafe or incomplete decisions to other', () => {
    const cases = [
      { classification: 'rerun', confidence: 'high' },
      { classification: 'flaky', confidence: 'high', reason_en: 'x' },
      {
        classification: 'flaky',
        confidence: 'low',
        reason_en: 'x',
        reason_zh: 'y',
        evidence: ['z'],
      },
      {
        classification: 'base_refresh',
        confidence: 'high',
        reason_en: 'x',
        reason_zh: 'y',
        evidence: ['z'],
        context: { command: 'gh pr merge' },
      },
    ];

    for (const decision of cases) {
      expect(validateClassifierDecision(decision, { scope: 'pr' })).toEqual({
        classification: 'other',
        confidence: 'low',
        reason_en:
          'The CI failure needs human review because the classifier decision was incomplete or unsafe.',
        reason_zh: '分类结果不完整或不安全，需要人工复核这个 CI 失败。',
        evidence: [],
      });
    }
  });

  it('degrades base refresh decisions on main failures', () => {
    expect(
      validateClassifierDecision(
        {
          classification: 'base_refresh',
          confidence: 'high',
          reason_en: 'main cannot be updated from itself',
          reason_zh: 'main 不能从自身更新',
          evidence: ['main run'],
        },
        { scope: 'main' },
      ),
    ).toMatchObject({ classification: 'other' });
  });
});

function createRunner(responses = []) {
  const calls = [];
  return {
    calls,
    runner: async (command, args, options = {}) => {
      calls.push({ command, args, options });
      const response = responses.shift() ?? '';
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

describe('ci failure patrol GitHub adapter', () => {
  it('lists open main PRs with status rollup metadata', async () => {
    const fake = createRunner(['[]']);
    const client = new GhClient({
      repo: 'QwenLM/qwen-code',
      runner: fake.runner,
    });

    await client.listOpenPrs();

    expect(fake.calls[0]).toMatchObject({
      command: 'gh',
      args: [
        'pr',
        'list',
        '--repo',
        'QwenLM/qwen-code',
        '--state',
        'open',
        '--base',
        'main',
        '--limit',
        '100',
        '--json',
        'number,state,isDraft,baseRefName,headRefOid,headRefName,headRepositoryOwner,isCrossRepository,maintainerCanModify,mergeStateStatus,statusCheckRollup,url',
      ],
    });
  });

  it('fetches failed job logs with caps and redaction', async () => {
    const fake = createRunner([
      JSON.stringify({
        jobs: [
          {
            id: 11,
            name: 'test',
            conclusion: 'failure',
            html_url: 'https://example.test/job/11',
          },
          { id: 12, name: 'build', conclusion: 'success' },
        ],
      }),
      'Authorization: Bearer secret-token\nfailed test output\n',
    ]);
    const client = new GhClient({
      repo: 'QwenLM/qwen-code',
      runner: fake.runner,
    });

    const evidence = await fetchFailedRunEvidence(client, 123, {
      maxJobs: 5,
      maxLogBytes: 200,
    });

    expect(fake.calls.map((call) => call.args.join(' '))).toEqual([
      'api repos/QwenLM/qwen-code/actions/runs/123/jobs --paginate',
      'api repos/QwenLM/qwen-code/actions/jobs/11/logs',
    ]);
    expect(evidence).toEqual([
      {
        jobId: 11,
        jobName: 'test',
        jobUrl: 'https://example.test/job/11',
        log: 'Authorization: Bearer [REDACTED]\nfailed test output',
      },
    ]);
  });

  it('keeps log excerpts bounded and strips control characters', () => {
    expect(
      sanitizeLog('ok\u001b[31m token=abc12345678901234567890 end', 24),
    ).toBe('ok[31m token=[REDACTED]');
  });

  it('calls fixed rerun and update-branch endpoints', async () => {
    const fake = createRunner(['{}', '{}']);
    const client = new GhClient({
      repo: 'QwenLM/qwen-code',
      runner: fake.runner,
    });

    await client.rerunFailedJobs(123);
    await client.updateBranch(42, 'abc123');

    expect(fake.calls.map((call) => call.args)).toEqual([
      [
        'api',
        '-X',
        'POST',
        'repos/QwenLM/qwen-code/actions/runs/123/rerun-failed-jobs',
      ],
      [
        'api',
        '-X',
        'PUT',
        'repos/QwenLM/qwen-code/pulls/42/update-branch',
        '-f',
        'expected_head_sha=abc123',
      ],
    ]);
  });

  it('renders one bilingual PR comment with evidence and state marker', () => {
    const body = renderPrComment({
      target: {
        scope: 'pr',
        prNumber: 42,
        runId: 123,
        headSha: 'abc123',
        htmlUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/123',
      },
      decision: {
        classification: 'other',
        confidence: 'medium',
        reason_en: 'The unit test failed with an assertion error.',
        reason_zh: '单元测试因为断言错误失败。',
        evidence: ['packages/core/foo.test.ts failed'],
      },
      attempts: 1,
      action: 'comment',
      handledAt: '2026-07-12T08:00:00.000Z',
    });

    expect(body).toContain('The unit test failed with an assertion error.');
    expect(body).toContain('<details><summary>中文</summary>');
    expect(body).toContain('单元测试因为断言错误失败。');
    expect(body).toContain('packages/core/foo.test.ts failed');
    expect(body).toContain('qwen-ci-patrol v=1 scope=pr target=42');
  });

  it('plans bounded PR actions from validated classifier decisions', () => {
    const target = {
      scope: 'pr',
      prNumber: 42,
      headSha: 'abc123',
      sameRepository: true,
      updateable: true,
      behindBase: true,
      mainRelevantSuccess: true,
    };

    expect(
      planPrAction({
        target,
        decision: validateClassifierDecision(
          {
            classification: 'flaky',
            confidence: 'high',
            reason_en: 'runner timeout',
            reason_zh: 'runner 超时',
            evidence: ['timeout'],
          },
          target,
        ),
        comments: [],
        botLogin: 'qwen-code-dev-bot',
      }),
    ).toMatchObject({ action: 'rerun_failed_jobs', attempts: 1 });

    expect(
      planPrAction({
        target,
        decision: validateClassifierDecision(
          {
            classification: 'flaky',
            confidence: 'low',
            reason_en: 'maybe',
            reason_zh: '可能',
            evidence: ['unclear'],
          },
          target,
        ),
        comments: [],
        botLogin: 'qwen-code-dev-bot',
      }),
    ).toMatchObject({ action: 'comment' });

    expect(
      planPrAction({
        target,
        decision: validateClassifierDecision(
          {
            classification: 'base_refresh',
            confidence: 'high',
            reason_en: 'behind main',
            reason_zh: '落后 main',
            evidence: ['main passed'],
          },
          target,
        ),
        comments: [],
        botLogin: 'qwen-code-dev-bot',
      }),
    ).toMatchObject({ action: 'update_branch' });
  });

  it('does not update branches unless deterministic base-refresh signals are present', () => {
    const decision = validateClassifierDecision(
      {
        classification: 'base_refresh',
        confidence: 'high',
        reason_en: 'behind main',
        reason_zh: '落后 main',
        evidence: ['main passed'],
      },
      { scope: 'pr' },
    );

    for (const target of [
      {
        scope: 'pr',
        prNumber: 42,
        headSha: 'abc123',
        sameRepository: true,
        updateable: true,
        behindBase: false,
        mainRelevantSuccess: true,
      },
      {
        scope: 'pr',
        prNumber: 42,
        headSha: 'abc123',
        sameRepository: true,
        updateable: true,
        behindBase: true,
        mainRelevantSuccess: false,
      },
    ]) {
      expect(
        planPrAction({
          target,
          decision,
          comments: [],
          botLogin: 'qwen-code-dev-bot',
        }),
      ).toMatchObject({ action: 'comment' });
    }
  });

  it('does not repeat comments or human handoff for the same SHA', () => {
    for (const action of ['comment', 'human_handoff']) {
      expect(
        planPrAction({
          target: { scope: 'pr', prNumber: 42, headSha: 'abc123' },
          decision: {
            classification: 'other',
            confidence: 'medium',
            reason_en: 'failed',
            reason_zh: '失败',
            evidence: ['failed'],
          },
          comments: [
            {
              author: { login: 'qwen-code-dev-bot' },
              body: formatPatrolMarker({
                scope: 'pr',
                target: '42',
                headSha: 'abc123',
                runId: '123',
                attempts: 3,
                action,
                handledAt: '2026-07-12T00:00:00.000Z',
              }),
            },
          ],
          botLogin: 'qwen-code-dev-bot',
        }),
      ).toEqual({ action: 'no_op', attempts: 3 });
    }
  });

  it('revalidates that the PR target is still current before acting', () => {
    const target = {
      scope: 'pr',
      prNumber: 42,
      runId: 1001,
      headSha: 'abc123',
    };

    expect(isPrTargetCurrent(pr(), target, { now: NOW })).toBe(true);
    expect(
      isPrTargetCurrent(pr({ headRefOid: 'new-sha' }), target, { now: NOW }),
    ).toBe(false);
    expect(
      isPrTargetCurrent(
        pr({
          statusCheckRollup: [
            prRun({
              id: 1002,
              detailsUrl:
                'https://github.com/QwenLM/qwen-code/actions/runs/1002',
            }),
          ],
        }),
        target,
        { now: NOW },
      ),
    ).toBe(false);
  });

  it('fails closed after three attempts or when bot identity mismatches', async () => {
    const marker = formatPatrolMarker({
      scope: 'pr',
      target: '42',
      headSha: 'abc123',
      runId: '123',
      attempts: 3,
      action: 'rerun',
      handledAt: '2026-07-12T00:00:00.000Z',
    });

    expect(
      planPrAction({
        target: { scope: 'pr', prNumber: 42, headSha: 'abc123' },
        decision: {
          classification: 'flaky',
          confidence: 'high',
          reason_en: 'flaky',
          reason_zh: '不稳定',
          evidence: ['timeout'],
        },
        comments: [{ author: { login: 'qwen-code-dev-bot' }, body: marker }],
        botLogin: 'qwen-code-dev-bot',
      }),
    ).toEqual({ action: 'human_handoff', attempts: 3 });

    const fake = createRunner(['someone-else']);
    await expect(
      verifyBotIdentity(
        new GhClient({ repo: 'QwenLM/qwen-code', runner: fake.runner }),
        'qwen-code-dev-bot',
      ),
    ).rejects.toThrow('CI_DEV_BOT_PAT authenticates as someone-else');
  });
});

describe('ci failure patrol main handoff', () => {
  it('finds only bot-owned issues with the exact workflow/head marker', () => {
    const marker = formatMainIssueMarker({ workflowId: 77, headSha: 'abc123' });
    const issues = [
      { number: 1, author: { login: 'someone-else' }, body: marker },
      { number: 2, author: { login: 'qwen-code-dev-bot' }, body: marker },
      {
        number: 3,
        author: { login: 'qwen-code-dev-bot' },
        body: formatMainIssueMarker({ workflowId: 77, headSha: 'def456' }),
      },
    ];

    expect(
      findMainHandoffIssue(issues, {
        botLogin: 'qwen-code-dev-bot',
        workflowId: 77,
        headSha: 'abc123',
      }),
    ).toMatchObject({ number: 2 });
  });

  it('does not dispatch Autofix for issues already owned by a human or blocked', () => {
    const blockedIssues = [
      { labels: [{ name: 'autofix/skip' }], assignees: [] },
      { labels: [{ name: 'autofix/in-progress' }], assignees: [] },
      { labels: [{ name: 'status/need-information' }], assignees: [] },
      { labels: [{ name: 'status/need-retesting' }], assignees: [] },
      { labels: [], assignees: [{ login: 'maintainer' }] },
      { labels: [], assignees: [], linkedPullRequests: [{ number: 9 }] },
    ];

    for (const issue of blockedIssues) {
      expect(shouldDispatchAutofixIssue(issue)).toBe(false);
    }
    expect(shouldDispatchAutofixIssue({ labels: [], assignees: [] })).toBe(
      true,
    );
  });

  it('creates a labeled issue and dispatches the issue phase once', async () => {
    const fake = createRunner(['[]', JSON.stringify({ number: 123 }), '']);
    const client = new GhClient({
      repo: 'QwenLM/qwen-code',
      runner: fake.runner,
    });
    const issue = await handoffMainFailure(client, {
      botLogin: 'qwen-code-dev-bot',
      target: {
        workflowId: 77,
        workflowName: 'E2E Tests',
        headSha: 'abc1234567890',
        runId: 999,
        htmlUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/999',
      },
      decision: {
        classification: 'other',
        confidence: 'medium',
        reason_en: 'The post-merge E2E run failed in the CLI test.',
        reason_zh: '合入后的 E2E 在 CLI 测试中失败。',
        evidence: ['cli test failed'],
      },
      dispatch: true,
    });

    expect(issue).toEqual({ number: 123, created: true, dispatched: true });
    expect(fake.calls.map((call) => call.args)).toEqual([
      [
        'search',
        'issues',
        '--repo',
        'QwenLM/qwen-code',
        '--state',
        'open',
        '--match',
        'body',
        'qwen-ci-patrol-main v=1 workflow=77 head=abc1234567890',
        '--json',
        'number,author,body,labels,assignees,linkedPullRequests,url',
        '--limit',
        '10',
      ],
      [
        'issue',
        'create',
        '--repo',
        'QwenLM/qwen-code',
        '--title',
        'Post-merge E2E Tests failed on abc1234',
        '--body',
        expect.stringContaining('qwen-ci-patrol-main v=1 workflow=77'),
        '--label',
        'type/bug,status/ready-for-agent,autofix/approved',
      ],
      [
        'workflow',
        'run',
        'qwen-autofix.yml',
        '--repo',
        'QwenLM/qwen-code',
        '-f',
        'phase=issue',
        '-f',
        'issue_number=123',
        '-f',
        'dry_run=false',
      ],
    ]);
  });

  it('reuses a workflow-owned issue and skips duplicate dispatch when blocked', async () => {
    const existing = {
      number: 321,
      author: { login: 'qwen-code-dev-bot' },
      body: formatMainIssueMarker({ workflowId: 77, headSha: 'abc123' }),
      labels: [{ name: 'autofix/in-progress' }],
      assignees: [],
    };
    const fake = createRunner([JSON.stringify([existing]), '']);
    const client = new GhClient({
      repo: 'QwenLM/qwen-code',
      runner: fake.runner,
    });
    const issue = await handoffMainFailure(client, {
      botLogin: 'qwen-code-dev-bot',
      target: {
        workflowId: 77,
        workflowName: 'E2E Tests',
        headSha: 'abc123',
        runId: 999,
        htmlUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/999',
      },
      decision: {
        classification: 'other',
        confidence: 'medium',
        reason_en: 'failure',
        reason_zh: '失败',
        evidence: ['failed'],
      },
      dispatch: true,
    });

    expect(issue).toEqual({ number: 321, created: false, dispatched: false });
    expect(fake.calls.map((call) => call.args[0])).toEqual(['search', 'issue']);
  });

  it('hands main flaky failures to Autofix issues instead of rerunning jobs', async () => {
    const fake = createRunner(['[]', JSON.stringify({ number: 123 }), '']);
    const client = new GhClient({
      repo: 'QwenLM/qwen-code',
      runner: fake.runner,
    });

    await handoffMainFailure(client, {
      botLogin: 'qwen-code-dev-bot',
      target: {
        workflowId: 77,
        workflowName: 'E2E Tests',
        headSha: 'abc1234567890',
        runId: 999,
        htmlUrl: 'https://github.com/QwenLM/qwen-code/actions/runs/999',
      },
      decision: {
        classification: 'flaky',
        confidence: 'high',
        reason_en: 'runner timeout',
        reason_zh: 'runner 超时',
        evidence: ['timeout'],
      },
      dispatch: true,
    });

    expect(
      fake.calls.some((call) =>
        call.args.join(' ').includes('rerun-failed-jobs'),
      ),
    ).toBe(false);
    expect(fake.calls.map((call) => call.args[0])).toEqual([
      'search',
      'issue',
      'workflow',
    ]);
  });
});
