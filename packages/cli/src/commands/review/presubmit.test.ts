/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  presubmitCommand,
  classifyCi,
  classifyHeadDrift,
  parseFindingsFile,
  type CompareSummary,
} from './presubmit.js';

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
    // The pulls fetch returns author + live head in one jq projection; a live
    // head equal to baseArgs' commit_sha means "no drift" for tests that are
    // not about drift.
    ghMock.mockReturnValue('{"author":"contributor","headSha":"abc123"}');
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

  it('downgrades the Approve and reports headDrift when the PR advanced mid-review', async () => {
    // Two gh('api', …) calls now: the pulls fetch (author + live head) and,
    // once drift is seen, the compare fetch for detail.
    ghMock.mockImplementation((...args: string[]) => {
      const path = args[1] ?? '';
      if (path.includes('/compare/')) {
        return '{"status":"ahead","aheadBy":2,"files":["src/x.ts"]}';
      }
      return '{"author":"contributor","headSha":"def456"}';
    });
    ghApiMock.mockReturnValue(null);

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.headDrift).toEqual({
      reviewedSha: 'abc123',
      liveHeadSha: 'def456',
      drifted: true,
      compare: {
        status: 'ahead',
        aheadBy: 2,
        filesTouched: ['src/x.ts'],
        filesTotal: 1,
      },
      // No --new-findings in baseArgs: the anchor set is unknown, so risk
      // fails safe.
      anchorsAtRisk: true,
    });
    expect(result.downgradeApprove).toBe(true);
    expect(result.downgradeReasons.join(' ')).toContain(
      'PR head advanced during review',
    );
  });

  it('makes exactly one gh() call on the no-drift happy path', async () => {
    // The PR's efficiency claim: live head rides the author fetch, and no
    // compare call happens when nothing moved.
    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(baseArgs as Parameters<typeof handler>[0]);

    expect(ghMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the drift verdict when the compare call itself throws', async () => {
    ghMock.mockImplementation((...args: string[]) => {
      const path = args[1] ?? '';
      if (path.includes('/compare/')) {
        throw new Error('HTTP 404: no common ancestor');
      }
      return '{"author":"contributor","headSha":"def456"}';
    });

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.headDrift.drifted).toBe(true);
    expect(result.headDrift.compare).toBeNull();
    expect(result.headDrift.anchorsAtRisk).toBe(true);
    expect(result.downgradeApprove).toBe(true);
  });

  it('survives a deleted PR author (author: null) instead of dying pre-submission', async () => {
    ghMock.mockReturnValue('{"author":null,"headSha":"abc123"}');

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.isSelfPr).toBe(false);
    expect(result.headDrift.drifted).toBe(false);
  });

  it('fails closed and caps the Approve when PR metadata cannot be read', async () => {
    // A thrown pulls fetch (transport/auth/404 on this endpoint) is different
    // from author:null — the head is unknown, so drift and self-PR cannot be
    // checked and the run must not proceed as if they passed.
    ghMock.mockImplementation((...args: string[]) => {
      if (args[0] === 'api' && String(args[1]).includes('/pulls/')) {
        throw new Error('HTTP 502: Bad Gateway');
      }
      return 'contributor';
    });
    ghApiMock.mockReturnValue(null);

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(baseArgs as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.downgradeApprove).toBe(true);
    expect(result.downgradeReasons.join(' ')).toContain(
      'PR metadata unavailable',
    );
  });

  it('counts a renamed file by BOTH its new and previous path in the drift file set', async () => {
    // An unreviewed commit that renamed a finding's anchor file (old path)
    // must still intersect — the projection keeps previous_filename.
    ghMock.mockImplementation((...args: string[]) => {
      const path = String(args[1] ?? '');
      if (path.includes('/compare/')) {
        return JSON.stringify({
          status: 'ahead',
          aheadBy: 1,
          files: ['src/new-name.ts', 'src/old-name.ts'],
        });
      }
      return '{"author":"contributor","headSha":"def456"}';
    });
    ghApiMock.mockReturnValue(null);
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes('findings')
        ? JSON.stringify([{ path: 'src/old-name.ts', line: 5 }])
        : '[]',
    );

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler({
      ...baseArgs,
      'new-findings': '/tmp/findings.json',
    } as unknown as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.headDrift.compare.filesTouched).toContain('src/old-name.ts');
    expect(result.headDrift.anchorsAtRisk).toBe(true);
  });

  it('fails safe (anchorsAtRisk) when the findings file is malformed, even on disjoint files', async () => {
    // The drift touches a file the (garbage) findings do not name. A trusted
    // empty/valid list would rule disjoint → submit; a malformed one must not
    // prove that all-clear.
    ghMock.mockImplementation((...args: string[]) => {
      const path = String(args[1] ?? '');
      if (path.includes('/compare/')) {
        return JSON.stringify({
          status: 'ahead',
          aheadBy: 1,
          files: ['src/unrelated.ts'],
        });
      }
      return '{"author":"contributor","headSha":"def456"}';
    });
    ghApiMock.mockReturnValue(null);
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes('findings')
        ? '[{"line":5}]' // entry without a string path → whole file rejected
        : '[]',
    );

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler({
      ...baseArgs,
      'new-findings': '/tmp/findings.json',
    } as unknown as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.headDrift.anchorsAtRisk).toBe(true);
  });

  it('surfaces a malformed findings file (flag + downgrade) even with no drift', async () => {
    // No drift this time (heads match), so anchorsAtRisk is not the signal;
    // the malformed file still silently emptied the overlap set, which must
    // not pass unreported.
    ghMock.mockReturnValue('{"author":"contributor","headSha":"abc123"}');
    ghApiMock.mockReturnValue(null);
    readFileSyncMock.mockImplementation((path: string) =>
      String(path).includes('findings') ? 'not json at all {' : '[]',
    );

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler({
      ...baseArgs,
      'new-findings': '/tmp/findings.json',
    } as unknown as Parameters<typeof handler>[0]);

    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    const result = JSON.parse(String(content));

    expect(result.findingsFileInvalid).toBe(true);
    expect(result.downgradeApprove).toBe(true);
    expect(result.downgradeReasons.join(' ')).toContain(
      'the --new-findings file was malformed',
    );
  });

  it('does not flag findingsFileInvalid when the file is valid or absent', async () => {
    ghMock.mockReturnValue('{"author":"contributor","headSha":"abc123"}');
    ghApiMock.mockReturnValue(null);
    readFileSyncMock.mockReturnValue('[]');

    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    // Absent findings file.
    await handler(baseArgs as Parameters<typeof handler>[0]);
    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    expect(JSON.parse(String(content)).findingsFileInvalid).toBe(false);
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
    ghMock.mockReturnValue('{"author":"someone","headSha":"abc123"}');

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

// The PR advancing mid-review means commits exist that no agent read. An
// Approve issued past them certifies unreviewed code — dogfooded on a live PR
// whose head moved four times in one day, where the only run that noticed did
// so by accident. Drift is a fact about two SHAs; the classifier is pure.
describe('classifyHeadDrift', () => {
  const ahead: CompareSummary = {
    status: 'ahead',
    aheadBy: 3,
    filesTouched: ['src/a.ts', 'src/b.ts'],
    filesTotal: 2,
  };

  it('reports no drift when the head has not moved', () => {
    const got = classifyHeadDrift('sha-aaa', 'sha-aaa', null, []);
    expect(got.headDrift.drifted).toBe(false);
    expect(got.headDrift.anchorsAtRisk).toBe(false);
    expect(got.downgradeReason).toBeUndefined();
  });

  it('does not claim drift when the live head could not be read', () => {
    const got = classifyHeadDrift('sha-aaa', '', null, []);
    expect(got.headDrift.drifted).toBe(false);
  });

  it('trusts an identical/zero-ahead compare over a SHA-string mismatch', () => {
    // An abbreviated commit_sha differs as a string from the full head, but
    // the compare's own evidence says nothing is unreviewed.
    const identical: CompareSummary = {
      status: 'identical',
      aheadBy: 0,
      filesTouched: [],
      filesTotal: 0,
    };
    const got = classifyHeadDrift('abc123', 'abc123def456', identical, []);
    expect(got.headDrift.drifted).toBe(false);
    expect(got.downgradeReason).toBeUndefined();
  });

  it('names both SHAs even when the compare detail is unavailable, and fails anchors safe', () => {
    const got = classifyHeadDrift(
      '57a9273ade45a43b9f16ae1f84cc3ba448a87429',
      '08ede5645612adca7d4193c1503d9c9e0f4387fb',
      null,
      [],
    );
    expect(got.headDrift.drifted).toBe(true);
    expect(got.headDrift.compare).toBeNull();
    expect(got.headDrift.anchorsAtRisk).toBe(true);
    expect(got.downgradeReason).toBe(
      'PR head advanced during review: reviewed 57a9273a, PR is now at 08ede564',
    );
  });

  it('carries the unreviewed-commit count and the PRE-cap file count', () => {
    const got = classifyHeadDrift('sha-old', 'sha-new', ahead, []);
    expect(got.downgradeReason).toContain('+3 unreviewed commit(s)');
    expect(got.downgradeReason).toContain('2 file(s)');
    expect(got.headDrift.compare).toEqual(ahead);
  });

  it('calls out a force-push as rewritten history and puts anchors at risk', () => {
    const got = classifyHeadDrift(
      'sha-old',
      'sha-new',
      {
        status: 'diverged',
        aheadBy: 1,
        filesTouched: [],
        filesTotal: 0,
      },
      [],
    );
    expect(got.downgradeReason).toContain('history rewritten');
    expect(got.headDrift.anchorsAtRisk).toBe(true);
  });

  it('treats a `behind` force-push-to-earlier as drift with anchors at risk, not "+0 unreviewed"', () => {
    // The head moved BACK to an earlier commit: aheadBy 0, but the reviewed
    // SHA is off the PR's line now. Must not read as proved-same or emit the
    // self-contradictory "+0 unreviewed commit(s)".
    const got = classifyHeadDrift(
      'sha-ahead',
      'sha-earlier',
      { status: 'behind', aheadBy: 0, filesTouched: [], filesTotal: 0 },
      ['src/z.ts'],
    );
    expect(got.headDrift.drifted).toBe(true);
    expect(got.headDrift.anchorsAtRisk).toBe(true);
    expect(got.downgradeReason).toContain('earlier commit');
    expect(got.downgradeReason).not.toContain('unreviewed commit(s)');
  });

  it('renders an API-capped file total as a lower bound in the public reason', () => {
    const got = classifyHeadDrift(
      'sha-old',
      'sha-new',
      {
        status: 'ahead',
        aheadBy: 5,
        filesTouched: Array.from({ length: 300 }, (_, i) => `f${i}.ts`),
        filesTotal: 300,
      },
      null,
    );
    expect(got.downgradeReason).toContain('300+ file(s)');
  });

  it('rules anchors safe only when a complete file list provably misses every finding', () => {
    const got = classifyHeadDrift('sha-old', 'sha-new', ahead, ['src/z.ts']);
    expect(got.headDrift.anchorsAtRisk).toBe(false);
  });

  it('rules anchors at risk when a finding path intersects the touched files', () => {
    const got = classifyHeadDrift('sha-old', 'sha-new', ahead, ['src/b.ts']);
    expect(got.headDrift.anchorsAtRisk).toBe(true);
  });

  it('fails safe when the touched-file list was truncated — a dropped path cannot intersect', () => {
    const truncated: CompareSummary = {
      status: 'ahead',
      aheadBy: 41,
      filesTouched: ['docs/a.md'],
      filesTotal: 283,
    };
    const got = classifyHeadDrift('sha-old', 'sha-new', truncated, [
      'src/z.ts',
    ]);
    expect(got.headDrift.anchorsAtRisk).toBe(true);
    // The reason reports the REAL count, not the cap.
    expect(got.downgradeReason).toContain('283 file(s)');
  });

  it("fails safe at the compare API's own 300-file cap even when nothing was cut locally", () => {
    const apiCapped: CompareSummary = {
      status: 'ahead',
      aheadBy: 5,
      filesTouched: Array.from({ length: 300 }, (_, i) => `f${i}.ts`),
      filesTotal: 300,
    };
    const got = classifyHeadDrift('sha-old', 'sha-new', apiCapped, ['zz.ts']);
    expect(got.headDrift.anchorsAtRisk).toBe(true);
  });

  it('fails safe when no findings list was supplied to intersect against', () => {
    const got = classifyHeadDrift('sha-old', 'sha-new', ahead, null);
    expect(got.headDrift.anchorsAtRisk).toBe(true);
  });
});

// The --new-findings list is a SAFETY PROOF (a disjoint intersection lets a
// review submit past head drift), so a malformed file must fail safe to
// `null` (unknown → at-risk), never to a silently-shorter set.
describe('parseFindingsFile (via mocked fs)', () => {
  // A tiny fs shim scoped to this block; the handler tests above mock the
  // module already, so reuse it by importing the mocked readFileSync.
  const cases: Array<[string, unknown]> = [
    ['not json {', null],
    ['{"path":"a.ts"}', null], // object, not array
    ['[{"line":5}]', null], // entry without a string path → reject WHOLE file
    ['[{"path":"a.ts","line":5}]', [{ path: 'a.ts', line: 5 }]],
    ['[{"path":"a.ts"}]', [{ path: 'a.ts', line: 0 }]], // missing line → 0
    ['[]', []],
  ];
  it.each(cases)('rejects/normalizes %s', (raw, expected) => {
    readFileSyncMock.mockReturnValue(raw as string);
    expect(parseFindingsFile('/tmp/findings.json')).toEqual(expected);
  });

  it('returns null when the file cannot be read at all', () => {
    readFileSyncMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(parseFindingsFile('/tmp/missing.json')).toBeNull();
  });
});
