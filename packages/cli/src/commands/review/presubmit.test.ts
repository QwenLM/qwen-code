/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { presubmitCommand, classifyCi } from './presubmit.js';

// A `skipped` check run arrives as `status: completed` with `conclusion:
// "skipped"`. It used to fall through both branches of the classifier and land
// the run in `all_pass`: a job that never ran, scored as a job that passed.
//
// `/review` treats green CI as its licence to approve, and the design
// explicitly delegates runtime truth to CI ("the LLM pipeline reads code
// statically… CI does not"). On PR #6486 the delegation returned nothing and
// returned it looking like a pass — `Integration Tests (CLI, No Sandbox)` was
// skipped, along with the macOS and Windows `Test` legs.
//
// The shapes below are the real check runs on 6486's head commit `240c08545`.
describe('classifyCi — a skipped check is not a passing check', () => {
  const run = (name: string, conclusion: string, status = 'completed') => ({
    name,
    status,
    conclusion,
  });

  it('names the checks that never executed at this commit', () => {
    const got = classifyCi(
      [
        run('Test (ubuntu-latest, Node 22.x)', 'success'),
        run('Test (macos-latest, Node 22.x)', 'skipped'),
        run('Test (windows-latest, Node 22.x)', 'skipped'),
        run('Integration Tests (CLI, No Sandbox)', 'skipped'),
      ],
      [],
    );
    expect(got.skippedCheckNames).toEqual([
      'Integration Tests (CLI, No Sandbox)',
      'Test (macos-latest, Node 22.x)',
      'Test (windows-latest, Node 22.x)',
    ]);
    // Something real did pass, so the class is still all_pass — the skipped
    // names are a DISCLOSURE, not a downgrade. Whether a skipped check would
    // have exercised this particular diff is a question about the diff, which
    // presubmit cannot see; Step 7 rules on it.
    expect(got.class).toBe('all_pass');
  });

  it('does not report a name that also ran under another check run', () => {
    // This repo's routing workflows emit both a skipped and a successful run
    // of the same name (`authorize`, `review-pr`, `precheck-pr`). Reporting
    // those as unrun would bury the one skipped check that matters under a
    // dozen that do not.
    const got = classifyCi(
      [
        run('authorize', 'skipped'),
        run('authorize', 'success'),
        run('review-pr', 'skipped'),
        run('review-pr', 'success'),
        run('Integration Tests (CLI, No Sandbox)', 'skipped'),
      ],
      [],
    );
    expect(got.skippedCheckNames).toEqual([
      'Integration Tests (CLI, No Sandbox)',
    ]);
  });

  it('calls it no_checks when checks exist and NOT ONE of them ran', () => {
    // The unambiguous case: there is no green here to approve on.
    const got = classifyCi(
      [run('Test (ubuntu-latest)', 'skipped'), run('Lint', 'skipped')],
      [],
    );
    expect(got.class).toBe('no_checks');
    expect(got.totalChecks).toBe(2);
  });

  it('still fails on a real failure and waits on a real pending', () => {
    expect(
      classifyCi([run('Test', 'failure'), run('Lint', 'skipped')], []).class,
    ).toBe('any_failure');
    expect(
      classifyCi([run('Test', '', 'in_progress'), run('Lint', 'skipped')], [])
        .class,
    ).toBe('all_pending');
  });

  it('treats `neutral` and `stale` as not-run, like `skipped`', () => {
    // GitHub's other "completed but nothing happened" conclusions. They arrive
    // on the same code path and mean the same thing for a review: no evidence.
    // `stale` in particular is a check GitHub superseded — it produced no
    // verdict about this commit, and scoring it as executed is the same mistake
    // as scoring `skipped` as a pass.
    const got = classifyCi(
      [
        run('Test', 'success'),
        run('Coverage Gate', 'neutral'),
        run('Lint', 'stale'),
      ],
      [],
    );
    expect(got.skippedCheckNames).toEqual(['Coverage Gate', 'Lint']);
    expect(got.class).toBe('all_pass');
  });

  it('names a completed check that produced NO conclusion, instead of "skipped ()"', () => {
    // A completed run with a null conclusion was invisible to both tallies, so
    // the class fell through to `no_checks` while `skippedCheckNames` stayed
    // empty — the downgrade then read "every check was skipped ()", naming
    // nothing. A run that produced no verdict did not run.
    const got = classifyCi([run('Ghost Check', '' as unknown as string)], []);
    expect(got.skippedCheckNames).toEqual(['Ghost Check']);
    expect(got.class).toBe('no_checks');
  });

  it('treats startup_failure as a failure, not a silent pass', () => {
    // A workflow that could not start is `completed` with `startup_failure`. It
    // used to count as an execution that added no failed name — an all_pass on
    // a commit whose CI never ran.
    const got = classifyCi(
      [run('Test', 'success'), run('E2E', 'startup_failure')],
      [],
    );
    expect(got.class).toBe('any_failure');
    expect(got.failedCheckNames).toContain('E2E');
  });

  it('treats waiting and requested as pending, not skipped', () => {
    // Real active check-run statuses. Omitting them mislabeled a commit whose
    // only check is waiting as no_checks with a spurious "skipped" reason.
    expect(
      classifyCi([run('E2E', null as unknown as string, 'waiting')], []).class,
    ).toBe('all_pending');
    expect(
      classifyCi([run('Lint', null as unknown as string, 'requested')], [])
        .class,
    ).toBe('all_pending');
  });

  it('dedupes a matrix job that fails on several platforms', () => {
    // Three legs of one failing matrix job pushed the name three times, so the
    // downgrade message read "Test, Test, Test".
    const got = classifyCi(
      [run('Test', 'failure'), run('Test', 'failure'), run('Test', 'failure')],
      [],
    );
    expect(got.failedCheckNames).toEqual(['Test']);
    expect(got.class).toBe('any_failure');
  });

  it('a repo with no CI at all is still no_checks, with nothing to disclose', () => {
    const got = classifyCi([], []);
    expect(got.class).toBe('no_checks');
    expect(got.totalChecks).toBe(0);
    expect(got.skippedCheckNames).toEqual([]);
  });
});

// A name's runs supersede each other: the routing workflows re-dispatch a name
// several times per commit and cancel the displaced runs, and a flaky job
// re-run to green leaves its failed attempt behind. Failure used to be judged
// per RUN, so any one leftover pushed its name into `failedCheckNames` — two
// real reviews were downgraded from Approve over exactly that (`route` at
// #7150; route, review-pr, review-config and four more at #7171), each on a
// commit whose every live check was green on the PR page.
describe('classifyCi — a superseded run does not outvote the latest verdict', () => {
  const at = (
    name: string,
    conclusion: string | null,
    completed_at: string | null,
    status = 'completed',
  ) => ({ name, status, conclusion, completed_at });

  it('a cancelled run displaced by a later success is not a failure — the #7150/#7171 false alarm', () => {
    const got = classifyCi(
      [
        at('route', 'success', '2026-07-18T15:30:00Z'),
        at('route', 'cancelled', '2026-07-18T15:10:00Z'),
        at('route', 'success', '2026-07-18T15:20:00Z'),
      ],
      [],
    );
    expect(got.failedCheckNames).toEqual([]);
    expect(got.class).toBe('all_pass');
  });

  it('a flaky job re-run to green is green — the failed attempt is history', () => {
    const got = classifyCi(
      [
        at(
          'Test (ubuntu-latest, Node 22.x)',
          'failure',
          '2026-07-18T10:00:00Z',
        ),
        at(
          'Test (ubuntu-latest, Node 22.x)',
          'success',
          '2026-07-18T11:00:00Z',
        ),
      ],
      [],
    );
    expect(got.class).toBe('all_pass');
  });

  it('a re-run that FAILS after a success is a failure — latest wins both ways', () => {
    const got = classifyCi(
      [
        at('Test', 'success', '2026-07-18T10:00:00Z'),
        at('Test', 'failure', '2026-07-18T11:00:00Z'),
      ],
      [],
    );
    expect(got.class).toBe('any_failure');
    expect(got.failedCheckNames).toEqual(['Test']);
  });

  it('a name whose ONLY run was cancelled still fails — nothing superseded it', () => {
    const got = classifyCi(
      [at('E2E', 'cancelled', '2026-07-18T10:00:00Z')],
      [],
    );
    expect(got.class).toBe('any_failure');
    expect(got.failedCheckNames).toEqual(['E2E']);
  });

  it('a later skipped re-dispatch does not erase a real failure — skips are not verdicts', () => {
    const got = classifyCi(
      [
        at('Test', 'failure', '2026-07-18T10:00:00Z'),
        at('Test', 'skipped', '2026-07-18T11:00:00Z'),
      ],
      [],
    );
    expect(got.class).toBe('any_failure');
    expect(got.failedCheckNames).toEqual(['Test']);
  });

  it('with no timestamps at all, the first-listed run keeps the name — the API lists newest first', () => {
    const got = classifyCi(
      [at('route', 'success', null), at('route', 'cancelled', null)],
      [],
    );
    expect(got.class).toBe('all_pass');
  });

  it('falls back to started_at when completed_at is absent', () => {
    // The winning run is listed SECOND on purpose: with the fallback dropped
    // (`completed_at ?? ''`) both stamps collapse to '' and first-seen keeps
    // the name — so a fixture that lists the success first passes with or
    // without the fallback and pins nothing. Listed second, the success can
    // win only through its `started_at`.
    const got = classifyCi(
      [
        {
          name: 'route',
          status: 'completed',
          conclusion: 'cancelled',
          completed_at: null,
          started_at: '2026-07-18T15:10:00Z',
        },
        {
          name: 'route',
          status: 'completed',
          conclusion: 'success',
          completed_at: null,
          started_at: '2026-07-18T15:30:00Z',
        },
      ],
      [],
    );
    expect(got.class).toBe('all_pass');
    expect(got.failedCheckNames).toEqual([]);
  });
});

const {
  ghMock,
  ghApiMock,
  ghApiAllMock,
  ghApiAllNestedMock,
  currentUserMock,
  ensureAuthenticatedMock,
  setGhHostMock,
  readFileSyncMock,
  writeFileSyncMock,
  writeStdoutLineMock,
} = vi.hoisted(() => ({
  ghMock: vi.fn(),
  ghApiMock: vi.fn(),
  ghApiAllMock: vi.fn(),
  ghApiAllNestedMock: vi.fn(),
  currentUserMock: vi.fn(),
  ensureAuthenticatedMock: vi.fn(),
  setGhHostMock: vi.fn(),
  readFileSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  writeStdoutLineMock: vi.fn(),
}));

vi.mock('./lib/gh.js', () => ({
  gh: ghMock,
  ghApi: ghApiMock,
  ghApiAll: ghApiAllMock,
  ghApiAllNested: ghApiAllNestedMock,
  currentUser: currentUserMock,
  ensureAuthenticated: ensureAuthenticatedMock,
  setGhHost: setGhHostMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const mock = {
    ...actual,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
  };
  return { ...mock, default: mock };
});

vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: writeStdoutLineMock,
}));

describe('presubmitCommand', () => {
  const baseArgs = {
    _: [],
    $0: 'qwen',
    pr_number: '6387',
    commit_sha: 'abc123',
    owner_repo: 'QwenLM/qwen-code',
    out_path: '/tmp/presubmit.json',
  };

  const originalGithubRunId = process.env['GITHUB_RUN_ID'];

  beforeEach(() => {
    vi.clearAllMocks();
    ensureAuthenticatedMock.mockReturnValue(undefined);
    currentUserMock.mockReturnValue('qwen-code-ci-bot');
    ghMock.mockReturnValue('contributor');
    ghApiAllMock.mockReturnValue([]);
    ghApiAllNestedMock.mockReturnValue([]);
    readFileSyncMock.mockReturnValue('[]');
    process.env['GITHUB_RUN_ID'] = '28788268483';
  });

  afterEach(() => {
    if (originalGithubRunId === undefined) {
      delete process.env['GITHUB_RUN_ID'];
    } else {
      process.env['GITHUB_RUN_ID'] = originalGithubRunId;
    }
  });

  it('sets downgradeApprove — not just a reason — when every check was skipped', async () => {
    // The bug this guards was found by dogfooding /review on this very change:
    // `downgradeReasons` gained a "CI did not run" entry while `downgradeApprove`
    // — the boolean compose-review actually acts on — did not. The disclosure was
    // written and the downgrade never fired. A reason nobody reads is not a gate,
    // so the assertion is on the boolean, through the real command.
    ghApiAllNestedMock.mockImplementation((path: string) =>
      path.endsWith('/check-runs')
        ? [
            { name: 'Test', status: 'completed', conclusion: 'skipped' },
            { name: 'Lint', status: 'completed', conclusion: 'skipped' },
          ]
        : [],
    );
    ghApiMock.mockReturnValue(null);

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.ciStatus.class).toBe('no_checks');
    expect(result.downgradeApprove).toBe(true);
    expect(result.downgradeReasons.join(' ')).toContain('CI did not run');
  });

  it('ignores the running Qwen PR review check when deciding whether CI is still pending', async () => {
    ghApiAllNestedMock.mockImplementation((path: string) =>
      path.endsWith('/check-runs')
        ? [
            {
              name: 'Test (ubuntu-latest, Node 22.x)',
              status: 'completed',
              conclusion: 'success',
            },
            {
              name: 'review-pr',
              status: 'in_progress',
              conclusion: null,
              details_url:
                'https://github.com/QwenLM/qwen-code/actions/runs/28788268483/job/85362025778',
            },
          ]
        : [],
    );
    ghApiMock.mockReturnValue(null);

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');

    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.ciStatus.class).toBe('all_pass');
    expect(result.downgradeApprove).toBe(false);
    expect(result.downgradeReasons).not.toContain('CI still running');
  });

  it('threads --host to the gh layer before any call (GitHub Enterprise routing is code, not prose)', async () => {
    ghApiMock.mockReturnValue(null);
    ghApiAllMock.mockReturnValue([]);
    ghApiAllNestedMock.mockReturnValue([]);
    currentUserMock.mockReturnValue('someone');
    ghMock.mockReturnValue('{}');

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    try {
      await handler({
        ...baseArgs,
        host: 'github.example.com',
      } as unknown as Parameters<typeof handler>[0]);
    } catch {
      // gh is mocked; a downstream failure is irrelevant to this wiring test
    }

    expect(setGhHostMock).toHaveBeenCalledWith('github.example.com');
    // And the default path resets rather than leaking a prior host.
    setGhHostMock.mockClear();
    try {
      await handler(baseArgs as unknown as Parameters<typeof handler>[0]);
    } catch {
      // same
    }
    expect(setGhHostMock).toHaveBeenCalledWith(undefined);
  });
});
