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
  detectPlatformKindMock,
  getMrAuthorAndHeadMock,
  ensureAoneAuthMock,
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
  detectPlatformKindMock: vi.fn(),
  getMrAuthorAndHeadMock: vi.fn(),
  ensureAoneAuthMock: vi.fn(),
}));

vi.mock('./lib/gh.js', async (importOriginal) => {
  // Keep the REAL pure validators (isOwnerRepo — the Aone branch's usage
  // check); mock only the transport seams.
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    gh: ghMock,
    ghApi: ghApiMock,
    ghApiAll: ghApiAllMock,
    ghApiAllNested: ghApiAllNestedMock,
    currentUser: currentUserMock,
    ensureAuthenticated: ensureAuthenticatedMock,
    setGhHost: setGhHostMock,
  };
});

// Platform routing + the Aone seam. Detection's own logic (host hint →
// kind) is pinned in registry.test.ts; here the kind is dictated so the
// Aone branch is tested without a git probe.
vi.mock('./lib/platform/registry.js', () => ({
  detectPlatformKind: detectPlatformKindMock,
}));
vi.mock('./lib/platform/aone.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getMrAuthorAndHead: getMrAuthorAndHeadMock,
    // An EMPTY MR is this suite's baseline for the backed slices: a
    // found-but-empty gate list reads no_checks with zero totals (never a
    // downgrade), and zero comments leave every dedup bucket empty.
    listMrComments: vi.fn((): unknown[] => []),
    getMrStatusChecks: vi.fn(() => []),
  };
});
vi.mock('./lib/platform/aone-client.js', () => ({
  ensureAoneAuthenticated: ensureAoneAuthMock,
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
    // Every existing test is a GitHub-path test; the Aone suite below
    // overrides this per test.
    detectPlatformKindMock.mockReturnValue('github');
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

  // Shared by both existing-comment classification describes; the wider
  // `id?` entry type covers the carried-id (#9208) tests unchanged.
  async function presubmitWithComments(
    comments: Array<Record<string, unknown>>,
    newFindings: Array<{
      path: string;
      line: number;
      start_line?: number;
      id?: string;
    }>,
  ) {
    ghApiAllMock.mockReturnValue(comments);
    ghApiMock.mockReturnValue(null);
    readFileSyncMock.mockReturnValue(JSON.stringify(newFindings));
    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler({
      ...baseArgs,
      'new-findings': '/tmp/findings.json',
    } as unknown as Parameters<typeof handler>[0]);
    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit.json',
    ) ?? [null, null];
    return JSON.parse(String(content));
  }

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

  describe('existing-comment classification — self-comment detection', () => {
    // The dedup set used to key on the attribution footer ALONE: with
    // `review.attribution` off, every earlier post is footer-less, and the
    // overlap/stale classification (and the blockOnExistingComments gate)
    // went blind to them — a probe watched an identical finding re-post as a
    // visual duplicate while a live comment sat on the same (path, line).
    // Authorship of the reviewing account's own top-level comments is the
    // footer-independent fallback.

    const FINDINGS = [{ path: 'a.ts', line: 12 }];

    it('admits a footer-bearing comment regardless of account — the footer is qwen provenance', async () => {
      // The footer is generated only by qwen's submit, so any comment
      // carrying it is a qwen post to dedup against, even one posted from a
      // different bot account (an earlier CI run) — gating it on the account
      // would miss those and duplicate-post. #9212 pins this ungated footer
      // match; the plantability tradeoff is accepted there. The SHORT marker
      // and bare finding shape stay authorship-gated (covered below).
      const result = await presubmitWithComments(
        [
          {
            id: 1,
            body: '**[Critical]** x _— model via Qwen Code /review (v0.21.2)_',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'someone-else' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(1);
    });

    it('classifies a footer-bearing prose comment by the reviewing account', async () => {
      // Prose, not finding-shaped: only the footer disjunct recognizes this
      // attributed post for dedup — deleting it reddens here.
      const result = await presubmitWithComments(
        [
          {
            id: 1,
            body: 'looks good overall _— model via Qwen Code /review (v0.21.2)_',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(1);
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.blockOnExistingComments).toBe(true);
    });

    it('classifies a footer-less comment by the reviewing account (attribution-off dedup)', async () => {
      // Case-insensitive login match, as with self-PR detection. The
      // severityOf branch remains for posts made before the comment marker
      // existed.
      const result = await presubmitWithComments(
        [
          {
            id: 2,
            body: '**[Critical]** x',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'QWEN-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(1);
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.blockOnExistingComments).toBe(true);
    });

    it('classifies a comment inside a new finding range as overlap', async () => {
      const result = await presubmitWithComments(
        [
          {
            id: 3,
            body: '**[Critical]** existing finding',
            path: 'a.ts',
            line: 15,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        [{ path: 'a.ts', start_line: 12, line: 18 }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.noConflict).toBe(0);
    });

    it('classifies intersecting existing and new finding ranges as overlap', async () => {
      const result = await presubmitWithComments(
        [
          {
            id: 4,
            body: '**[Critical]** existing finding',
            path: 'a.ts',
            start_line: 8,
            line: 14,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        [{ path: 'a.ts', start_line: 12, line: 18 }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.noConflict).toBe(0);
    });

    it('keeps disjoint ranges in noConflict', async () => {
      const result = await presubmitWithComments(
        [
          {
            id: 5,
            body: '**[Critical]** existing finding',
            path: 'a.ts',
            start_line: 4,
            line: 8,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        [{ path: 'a.ts', start_line: 12, line: 18 }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(0);
      expect(result.existingComments.byBucket.noConflict).toBe(1);
    });

    it('classifies the shape attribution-off actually posts — markerless body, trailing marker, reviewing account', async () => {
      // `submit` strips the severity prefix and appends the comment marker;
      // GitHub stores exactly this. The marker only counts together with
      // authorship — the string is public and renders invisibly.
      const result = await presubmitWithComments(
        [
          {
            id: 2,
            body: 'x\n\n<!-- qwen-review critical -->',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(1);
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.blockOnExistingComments).toBe(true);
    });

    it('does not admit a marker-carrying comment from another account — the marker is plantable', async () => {
      // The adversarial shape: a PR author who read the setting description
      // plants the invisible marker on the line they expect a blocker on.
      // Authorship is the gate that keeps this out of the dedup set.
      const result = await presubmitWithComments(
        [
          {
            id: 2,
            body: 'x\n\n<!-- qwen-review critical -->',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'someone-else' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(0);
      expect(result.blockOnExistingComments).toBe(false);
    });

    it('does not admit a marker-carrying reply either — quote-reply copies the marker', async () => {
      // GitHub's quote-reply copies raw markdown, so a reply to an
      // attribution-off finding carries the marker and inherits the
      // finding's path:line anchor. The reply guard keeps it out.
      const result = await presubmitWithComments(
        [
          {
            id: 4,
            body: 'x\n\n<!-- qwen-review critical -->',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            in_reply_to_id: 1,
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(0);
      expect(result.blockOnExistingComments).toBe(false);
    });

    it('does not admit a FOOTER-carrying reply — the fixed-ruling reply is a reply, not a finding (#9940 review, round 16)', async () => {
      // The thread lifecycle's own fixed-ruling reply carries the visible
      // footer and inherits its thread's commit_id, so on a same-SHA
      // re-run it is not stale. Ungated, the footer disjunct bucketed it
      // into overlap and the deterministic drop discarded a genuinely
      // NEW finding at the location, citing the fixed note. Replies stay
      // excluded on the footer disjunct too.
      const result = await presubmitWithComments(
        [
          {
            id: 5,
            body: 'R3-2 fixed by the guard rewrite\n\n_— qwen3-max via Qwen Code /review (v0.21.3)_',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            in_reply_to_id: 1,
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(0);
      expect(result.blockOnExistingComments).toBe(false);
    });

    it('ignores a footer-less, marker-less comment from another account', async () => {
      // No footer, no comment marker, and not the reviewing account's:
      // nothing presubmit can attribute — it stays outside the dedup set.
      const result = await presubmitWithComments(
        [
          {
            id: 3,
            body: '**[Critical]** x',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'someone-else' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(0);
      expect(result.blockOnExistingComments).toBe(false);
    });

    it('does not author-match replies — even a finding-shaped reply is not a posted finding', async () => {
      // Finding-shaped on purpose: the body PASSES the severityOf shape
      // gate, so deleting the !c.in_reply_to_id reply guard makes this test
      // red (mutation-verified) — only that term keeps the reply out of the
      // dedup set.
      const result = await presubmitWithComments(
        [
          {
            id: 4,
            body: '**[Critical]** confirmed, thanks',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            in_reply_to_id: 1,
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(0);
      expect(result.blockOnExistingComments).toBe(false);
    });

    it('does not author-match hand-written top-level comments — only finding-shaped bodies', async () => {
      // Every posted finding opens with a severity prefix (submit refuses
      // unmarked comments), so the authorship fallback gates on it. Without
      // the gate, a hand comment at the same path:line lands in overlap and
      // the blockOnExistingComments rule silently withholds a genuinely new
      // finding — probe-verified before the gate existed.
      const result = await presubmitWithComments(
        [
          {
            id: 5,
            body: 'nit: hand-written note on the same line',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(0);
      expect(result.blockOnExistingComments).toBe(false);
    });

    it('classifies a footer-less finding whose body opens with whitespace', async () => {
      // submit posts through the trimming severityOf, so a drafted body with
      // a leading newline goes out verbatim; the authorship fallback must
      // classify through the same predicate and see that post back, or the
      // dedup gate re-posts an identical finding as a visual duplicate.
      const result = await presubmitWithComments(
        [
          {
            id: 6,
            body: '\n**[Critical]** x',
            path: 'a.ts',
            line: 12,
            commit_id: 'abc123',
            user: { login: 'qwen-code-ci-bot' },
          },
        ],
        FINDINGS,
      );
      expect(result.existingComments.total).toBe(1);
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.blockOnExistingComments).toBe(true);
    });
  });

  describe('existing-comment classification — carried-id re-posts (#9208)', () => {
    // The overlap gate used to be purely location-based: a Step 6 ledger
    // re-post lands on the original thread's line by construction, collided
    // with the very comment it re-posts, and was dropped — so the carried id
    // never rode the round's ledger marker. A re-post is recognized by its
    // `R<round>-<n>` id appearing in the existing comment at the same
    // location; those comments are additionally bucketed as `repost` with the
    // matched ids so the drop rule can exempt them.

    const CARRIED_COMMENT = {
      id: 7,
      body: '**[Critical]** R3-2: eq-form rescue asymmetry _— model via Qwen Code /review (v0.21.3)_',
      path: 'src/parse-args.ts',
      line: 44,
      commit_id: 'abc123',
      user: { login: 'qwen-code-ci-bot' },
    };

    it('reads the carried id past axis tags placed before it (#10291)', async () => {
      // The claim head slot admits the tags in any order; a re-post whose
      // line leads with them must still land in the repost bucket, or it is
      // dedup-dropped as a plain overlap every round.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Critical]** [fails-closed] [new-surface] R3-2: eq-form rescue asymmetry _— model via Qwen Code /review (v0.21.3)_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('marks an id-matched overlap comment as a re-post target', async () => {
      const result = await presubmitWithComments(
        [CARRIED_COMMENT],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].id).toBe(7);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
      // Still an overlap as far as the block gate goes: other findings at
      // the same location without the carried id are still dropped.
      expect(result.blockOnExistingComments).toBe(true);
    });

    it('reports only the matched ids when several findings share the location', async () => {
      const result = await presubmitWithComments(
        [CARRIED_COMMENT],
        [
          { path: 'src/parse-args.ts', line: 44, id: 'R3-2' },
          { path: 'src/parse-args.ts', line: 44, id: 'R4-1' },
        ],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it("does not treat a different account's colliding id as a re-post", async () => {
      // Ledger ids are per-account: another reviewer's `R3-2` at the same
      // line is a plain location overlap, not a re-post target — exempting
      // it would post the duplicate the gate exists to prevent.
      const result = await presubmitWithComments(
        [{ ...CARRIED_COMMENT, user: { login: 'maintainer-dev' } }],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
      // The report names the author: an authorship-refused exemption must be
      // self-explanatory next to a drop line whose visible id matches.
      expect(result.existingComments.overlap[0].user).toBe('maintainer-dev');
    });

    it('extracts the carried id from a carried body longer than the 80-char report excerpt', async () => {
      // The report's `CommentSummary.body` is an 80-char excerpt, but
      // extraction reads the FULL body. A carried id leads the claim line
      // right after the severity marker by construction, so it extracts
      // however long the claim runs after it.
      const longClaim = 'x'.repeat(90);
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: `**[Critical]** R3-2: ${longClaim} _— model via Qwen Code /review_`,
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('keeps the id-less fallback off when the only id token sits past the 80-char summary slice (#9212)', async () => {
      // The no-token check reads the FULL body, not the 80-char
      // `CommentSummary.body` excerpt: a long id-less claim whose one
      // id-shaped cross-reference lands past char 80 is still not a truly
      // id-less original, and the fallback must stay off.
      const longClaim = 'x'.repeat(90);
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: `**[Critical]** ${longClaim} (see R3-2 for context) _— model via Qwen Code /review_`,
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('extracts the carried id from a Suggestion-severity re-post (#9212)', async () => {
      // Both severity markers must strip: every other carried body in the
      // suite leads with **[Critical]**, which left the Suggestion half of
      // the marker strip invisible.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Suggestion]** R3-2: eq-form rescue asymmetry _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('extracts the carried id when a colon follows the marker directly (#9212)', async () => {
      // The strip tolerates a colon right after the severity marker — the
      // shape the compose side's own fixtures use ('**[Critical]**: ...').
      // The strip is now one shared statement (carriedClaimLine), and this
      // pins its colon branch on the presubmit side, which no fixture here
      // exercised before (#9212 review).
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Critical]**: R3-2: eq-form rescue asymmetry _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('extracts the carried id from the attribution-off posted shape', async () => {
      // An attribution-off re-post carries NO severity prefix — submit
      // strips it before posting — and its severity rides the trailing
      // invisible marker. The carried id still leads the first line;
      // without reading it back off the marker-less body, the re-post
      // lands as a plain overlap and is dedup-dropped from round 3
      // onward, while the surviving id token bars the id-less fallback —
      // a still-standing carried Critical the verdict then flips past.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: 'R3-2: eq-form rescue asymmetry\n\n<!-- qwen-review critical -->',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('extracts the carried id past a MULTI-line leading comment on the attribution-off shape', async () => {
      // An attribution-off post of a draft whose residue sat between the
      // marker and the id leads with that residue; the marker-less
      // readback strips it BEFORE the line split, so a multi-line
      // comment cannot cut the id off the first line (#9940 review).
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '<!--\nrender-note\n-->R3-2: eq-form rescue asymmetry\n\n<!-- qwen-review critical -->',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('keeps a marker-carrying id-less comment out of the repost bucket when the location is ambiguous', async () => {
      // The attribution-off shape without a carried id: the id-less
      // fallback stays off while two ids share the location, so the
      // comment is a plain overlap — exactly the strictness the marked
      // bodies get.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: 'eq-form rescue asymmetry\n\n<!-- qwen-review critical -->',
          },
        ],
        [
          { path: 'src/parse-args.ts', line: 44, id: 'R3-2' },
          { path: 'src/parse-args.ts', line: 44, id: 'R3-3' },
        ],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('reads no carried id out of an unmarked body (#9212)', async () => {
      // A re-post always leads with its severity marker — `submit` refuses
      // to post an unmarked finding — so an unmarked body is not a re-post
      // even when its first line opens with an id-shaped token: exempting
      // it would vouch a comment that was never the finding's thread.
      // buildLedger skips unmarked bodies when WRITING the ledger; the
      // shared strip refuses them when READING it back, so the two ends can
      // no longer disagree about what "marked" means (#9212 review).
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: 'R3-2: discussed offline, keeping this thread _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('does not exempt a lone comment that only cross-references the id mid-body (#9212)', async () => {
      // "see R3-2 for context" mentions the id without being its thread. The
      // strict prefix match must not fire on it, and the id-less fallback
      // must not swallow it either: the body still carries an id-shaped
      // token, so the comment is not a truly id-less original. Single
      // comment on purpose — at the unambiguous count the fallback WOULD
      // fire if it keyed on the prefix extractor's [] alone.
      const referenced = {
        ...CARRIED_COMMENT,
        body: '**[Critical]** unrelated claim (see R3-2 for context) _— model via Qwen Code /review_',
      };
      const result = await presubmitWithComments(
        [referenced],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('does not match an id embedded in a longer hyphen run (#9212)', async () => {
      // `R3-2-1` leads the claim line, but it is not the ledger id `R3-2`:
      // the prefix readback requires the id to end the token, and the
      // hyphen-run token keeps the id-less fallback off too.
      const extended = {
        ...CARRIED_COMMENT,
        body: '**[Critical]** R3-2-1: extended claim _— model via Qwen Code /review_',
      };
      const result = await presubmitWithComments(
        [extended],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('sees an id wrapped in Markdown emphasis as an id token (#9212)', async () => {
      // `_R3-2_` defeats `\b` anchors (`_` is a word character), but the
      // id-less fallback's no-token check is unbounded on purpose: the
      // mention still marks the comment as belonging to a specific finding.
      const emphasised = {
        ...CARRIED_COMMENT,
        body: '**[Critical]** unrelated claim (see _R3-2_ for context) _— model via Qwen Code /review_',
      };
      const result = await presubmitWithComments(
        [emphasised],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('exempts an id-less first-round original when the target is unambiguous (#9208)', async () => {
      // First-round originals carry no id token in the body (buildLedger
      // assigns first-round ids positionally). With exactly one own-account
      // comment at the location and one carried finding, the re-post must
      // still be exempted instead of dropped.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Critical]** some claim without an id',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('keeps the strict match when the id-less target is ambiguous (#9208)', async () => {
      // Two id-less own-account comments at the same location: the re-post
      // target is ambiguous, so no exemption — the drop stays visible in the
      // drop log rather than silently picking one thread.
      const first = {
        ...CARRIED_COMMENT,
        id: 10,
        body: '**[Critical]** claim A without an id',
      };
      const second = {
        ...CARRIED_COMMENT,
        id: 11,
        body: '**[Critical]** claim B without an id',
      };
      const result = await presubmitWithComments(
        [first, second],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(2);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('keeps the id-less exemption off when several findings share the location (#9212)', async () => {
      // Two CARRIED findings at one id-less location: `wantedIds.size === 1`
      // is the unambiguity precondition, and exempting here would re-post
      // BOTH findings under one thread that belongs to only one of them.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Critical]** some claim without an id',
          },
        ],
        [
          { path: 'src/parse-args.ts', line: 44, id: 'R3-2' },
          { path: 'src/parse-args.ts', line: 44, id: 'R4-1' },
        ],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('keeps the id-less exemption off when the current user login is unknown (#9212)', async () => {
      // With no authenticated login the authorship gate cannot vouch for ANY
      // comment, so the exemption must stay off even at an unambiguous
      // location — the drop still applies and stays visible. The bodies keep
      // their footer so the comments ARE recognized; only the gate can
      // block. The second comment covers the author-less shape (`user`
      // absent, e.g. a deleted account): with the login unknown it must not
      // be counted as own-account and ride the fallback either.
      currentUserMock.mockReturnValue('');
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Critical]** some claim without an id _— model via Qwen Code /review_',
          },
          {
            ...CARRIED_COMMENT,
            id: 8,
            user: undefined,
            body: '**[Critical]** author-less claim without an id _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(2);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('keeps an author-less carried id out of the repost gate when the login is unknown (#9212)', async () => {
      // The unknown-login test above covers id-LESS bodies; this one pins
      // the gate itself: with no authenticated login, a comment whose
      // author is absent (`user` undefined, e.g. a deleted account) must
      // not ride its carried id into the repost bucket. If the
      // `currentUserLogin !== ''` guard were forced true, the author-less
      // comparison degenerates to `'' === ''` and WOULD match — nothing
      // may be vouched as own-account while the login is unknown, id
      // match or not (R2-7, #9212 review).
      currentUserMock.mockReturnValue('');
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            user: undefined,
            body: '**[Critical]** R3-2: eq-form rescue asymmetry _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('counts no comment as own while the login is unknown (#9212)', async () => {
      // The ambiguity pre-count is wrapped in the same unknown-login guard
      // as the gate: with no authenticated login, nothing may be vouched
      // own-account. An author-less comment must not ride the degenerate
      // `'' === ''` comparison into the count and fire the id-less fallback
      // on a comment nobody proved belongs to this account (#9212 review).
      currentUserMock.mockReturnValue('');
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            user: undefined,
            body: '**[Critical]** author-less claim without an id _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('counts only current-SHA own comments for the id-less fallback (#9212)', async () => {
      // The ambiguity count must ignore this account's comments at OTHER
      // SHAs: a stale same-location comment of the same account inflates
      // the count to 2 and disables the fallback if the commit filter in
      // the counting loop is dropped (#9212 review).
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            id: 10,
            body: '**[Critical]** current claim without an id',
          },
          {
            ...CARRIED_COMMENT,
            id: 11,
            commit_id: 'stale-sha',
            body: '**[Critical]** stale claim without an id',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].id).toBe(10);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('counts only own-account comments for the id-less fallback (#9212)', async () => {
      // Another Qwen account's comment at the same location must not
      // inflate the ambiguity count: dropping the login filter in the
      // counting loop reaches 2 and disables the fallback for a genuinely
      // unambiguous own-account original (#9212 review).
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            id: 10,
            body: '**[Critical]** own claim without an id',
          },
          {
            ...CARRIED_COMMENT,
            id: 11,
            user: { login: 'qwen-other-bot' },
            body: '**[Critical]** other-account claim without an id _— model via Qwen Code /review_',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(2);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].id).toBe(10);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('matches authorship case-insensitively through gate and count (#9212)', async () => {
      // The login comparison lowercases both sides at BOTH sites — the
      // repost gate and the ambiguity-count loop. This fixture rides the
      // id-less FALLBACK, which passes through both comparisons, so
      // dropping `.toLowerCase()` at either site breaks it: the case
      // variant of the same account must still count as own-account
      // (#9212 review).
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            user: { login: 'Qwen-Code-CI-Bot' },
            body: '**[Critical]** case-variant claim without an id',
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('extracts the carried id when the claim line starts past the 80-char summary slice (#9212)', async () => {
      // Extraction reads the FULL body, not the 80-char `CommentSummary.body`
      // excerpt: padding after the marker can push the id-led claim line
      // past char 80, where reading the excerpt would find no id, drop the
      // strict match, and — the body still carries an id token — the id-less
      // fallback cannot rescue it either (#9212 review).
      const padding = ' '.repeat(70);
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: `**[Critical]**${padding}R3-2: eq-form rescue asymmetry _— model via Qwen Code /review_`,
          },
        ],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R3-2']);
    });

    it('exempts the carried finding when a fresh id-less finding shares the location (#9212)', async () => {
      // The findings file carries ids on carried-forward findings only; the
      // fresh finding of this round omits it. The exemption must still fire
      // on the single CARRIED id, not be crowded out by the fresh entry.
      const result = await presubmitWithComments(
        [
          {
            ...CARRIED_COMMENT,
            body: '**[Critical]** some claim without an id',
          },
        ],
        [
          { path: 'src/parse-args.ts', line: 44, id: 'R1-2' },
          { path: 'src/parse-args.ts', line: 44 },
        ],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R1-2']);
    });

    it('matches a prior re-post as the target when it carries the id (#9212)', async () => {
      // A same-SHA re-run sees the original AND the re-post already made for
      // it; only the comment leading with the id is a strict match. The
      // duplication this can produce on further re-runs is disclosed in the
      // Known-limitation paragraph — detecting "already re-posted" needs a
      // carry-forward channel and is a follow-up.
      const original = {
        ...CARRIED_COMMENT,
        id: 10,
        body: '**[Critical]** some claim without an id',
      };
      const priorRepost = {
        ...CARRIED_COMMENT,
        id: 11,
        body: '**[Critical]** R1-2: the same claim, re-reported _— model via Qwen Code /review_',
      };
      const result = await presubmitWithComments(
        [original, priorRepost],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R1-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(2);
      expect(result.existingComments.byBucket.repost).toBe(1);
      expect(result.existingComments.repost[0].id).toBe(11);
      expect(result.existingComments.repost[0].matchedIds).toEqual(['R1-2']);
    });

    it('counts a replied-to original toward the id-less ambiguity decision (#9212)', async () => {
      // A replied-to original is bucketed `resolved`, but it is still an
      // original at the location: leaving it out of the count handed the
      // exemption to a sibling comment belonging to a DIFFERENT finding.
      const repliedOriginal = {
        ...CARRIED_COMMENT,
        id: 10,
        body: '**[Critical]** claim A without an id',
      };
      const maintainerReply = {
        id: 12,
        body: 'fixing this, thanks',
        path: 'src/parse-args.ts',
        line: 44,
        commit_id: 'abc123',
        in_reply_to_id: 10,
        user: { login: 'maintainer-dev' },
      };
      const siblingOriginal = {
        ...CARRIED_COMMENT,
        id: 11,
        body: '**[Critical]** claim B without an id',
      };
      const result = await presubmitWithComments(
        [repliedOriginal, maintainerReply, siblingOriginal],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R2-1' }],
      );
      expect(result.existingComments.byBucket.resolved).toBe(1);
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('does not match a different carried id', async () => {
      const result = await presubmitWithComments(
        [CARRIED_COMMENT],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-9' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(1);
      expect(result.existingComments.byBucket.repost).toBe(0);
    });

    it('does not match an id carried at a different location', async () => {
      const result = await presubmitWithComments(
        [{ ...CARRIED_COMMENT, line: 45 }],
        [{ path: 'src/parse-args.ts', line: 44, id: 'R3-2' }],
      );
      expect(result.existingComments.byBucket.overlap).toBe(0);
      expect(result.existingComments.byBucket.repost).toBe(0);
      expect(result.existingComments.byBucket.noConflict).toBe(1);
    });
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
    [
      '[{"path":"a.ts","start_line":3,"line":5}]',
      [{ path: 'a.ts', startLine: 3, line: 5 }],
    ],
    ['[{"path":"a.ts"}]', [{ path: 'a.ts', line: 0 }]], // missing line → 0
    // Carried ledger id for the re-post exemption (#9208); a present-but-
    // non-string id rejects the WHOLE file, same fail-safe as `path`.
    [
      '[{"path":"a.ts","line":5,"id":"R3-2"}]',
      [{ path: 'a.ts', line: 5, id: 'R3-2' }],
    ],
    ['[{"path":"a.ts","line":5,"id":42}]', null],
    // `null` means "no id" (JSON has no undefined) — a missing optional
    // field, not a malformed file; the entry survives without an id.
    ['[{"path":"a.ts","line":5,"id":null}]', [{ path: 'a.ts', line: 5 }]],
    // Present-but-misshapen ids are rejected too: a typo'd id can never
    // match the extractor, and accepting it would silently disable the
    // re-post exemption (#9212 review).
    ['[{"path":"a.ts","line":5,"id":"r3-2"}]', null],
    ['[{"path":"a.ts","line":5,"id":"R3-2 "}]', null],
    ['[{"path":"a.ts","line":5,"id":""}]', null],
    // The SHAPE check is fully anchored: a padded or prefixed id contains a
    // valid `R\d+-\d+` substring, so dropping either anchor would accept it
    // — and an accepted `' R3-2'` can never round-trip against the
    // extractor's `'R3-2'`, silently disabling the exemption (#9212 review).
    ['[{"path":"a.ts","line":5,"id":" R3-2"}]', null],
    ['[{"path":"a.ts","line":5,"id":"XR3-2"}]', null],
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

// The Aone branch (#9616 self-PR, then the full backing): the SAME report
// shape, computed by the SAME shared writer as the GitHub path — self-PR
// detection (the gate's whoami account vs the MR author), head drift
// (`sourceBranch` is the live head), merge-gate classification, and the
// existing-comment dedup. The empty-input cells of those slices are pinned
// here; their classification semantics ride presubmit.aone.test.ts.
describe('presubmitCommand — Aone targets', () => {
  const aoneArgs = {
    _: [],
    $0: 'qwen',
    pr_number: '29295886',
    commit_sha: 'abc123',
    owner_repo: 'maxcompute/odps_src',
    out_path: '/tmp/presubmit-aone.json',
    host: 'gitlab.alibaba-inc.com',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    detectPlatformKindMock.mockReturnValue('aone');
    // The gate doubles as the account read (#9629 review).
    ensureAoneAuthMock.mockReturnValue('wenshao');
    // The mr-view fetch returns author + live head in one call; a live head
    // equal to aoneArgs' commit_sha means "no drift" unless a test says so.
    getMrAuthorAndHeadMock.mockReturnValue({
      author: 'someone-else',
      headSha: 'abc123',
    });
  });

  async function runAonePresubmit() {
    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await handler(aoneArgs as unknown as Parameters<typeof handler>[0]);
    const [, content] = writeFileSyncMock.mock.calls.find(
      ([path]) => path === '/tmp/presubmit-aone.json',
    ) ?? [null, null];
    // Untyped JSON read-back — the same house shape the GitHub-path tests
    // above use for their report assertions.
    return JSON.parse(String(content));
  }

  it('routes at a1, not gh — no gh call, no GH_HOST routing', async () => {
    await runAonePresubmit();
    // Pin the WIRING, not just the outcome: a mutant that drops the host
    // hint (`detectPlatformKind({})`) survives a constant mock and, from a
    // non-Aone cwd, falls through to the origin probe — routing the MR at
    // gh. Step 7's canonical invocation always passes `--host`.
    expect(detectPlatformKindMock).toHaveBeenCalledWith({
      host: 'gitlab.alibaba-inc.com',
    });
    expect(ensureAoneAuthMock).toHaveBeenCalled();
    expect(ghMock).not.toHaveBeenCalled();
    expect(ghApiAllMock).not.toHaveBeenCalled();
    expect(ghApiAllNestedMock).not.toHaveBeenCalled();
    expect(setGhHostMock).not.toHaveBeenCalled();
    expect(ensureAuthenticatedMock).not.toHaveBeenCalled();
  });

  it('flags a self-MR (case-insensitively) and downgrades BOTH events', async () => {
    // The downgrade the issue names: reviewing your own MR must carry the
    // same verdict semantics as on GitHub — and on Aone the load-bearing
    // half is downgradeRequestChanges, which keeps a self-review from
    // posting the blocking REQUEST_CHANGES header.
    getMrAuthorAndHeadMock.mockReturnValue({
      author: 'WenShao',
      headSha: 'abc123',
    });
    const result = await runAonePresubmit();
    expect(result.isSelfPr).toBe(true);
    expect(result.downgradeApprove).toBe(true);
    expect(result.downgradeRequestChanges).toBe(true);
    expect(result.downgradeReasons).toEqual(['self-PR']);
  });

  it('an empty MR reads all-clear through the full backing — no phantom downgrades', async () => {
    // Both slices are BACKED now (CI classification and comment dedup); an
    // MR with a found-but-empty gate list and zero comments must still be
    // the all-clear shape — the backing itself manufactures nothing.
    getMrAuthorAndHeadMock.mockReturnValue({
      author: 'someone-else',
      headSha: 'abc123',
    });
    const result = await runAonePresubmit();
    expect(result.isSelfPr).toBe(false);
    expect(result.ciStatus).toEqual({
      class: 'no_checks',
      failedCheckNames: [],
      skippedCheckNames: [],
      totalChecks: 0,
    });
    expect(result.existingComments).toEqual({
      total: 0,
      byBucket: { stale: 0, resolved: 0, overlap: 0, repost: 0, noConflict: 0 },
      overlap: [],
      repost: [],
      stale: [],
      resolved: [],
      noConflict: [],
    });
    expect(result.blockOnExistingComments).toBe(false);
    expect(result.findingsFileInvalid).toBe(false);
    // Nothing to downgrade: no reasons, neither flag.
    expect(result.downgradeApprove).toBe(false);
    expect(result.downgradeRequestChanges).toBe(false);
    expect(result.downgradeReasons).toEqual([]);
  });

  it('fails soft when the MR author is absent (deleted account)', async () => {
    // Parity with the GitHub `author: null` test: isSelfPr false, the run
    // completes, and no metadata-unavailable reason fires.
    getMrAuthorAndHeadMock.mockReturnValue({ author: '', headSha: 'abc123' });
    const result = await runAonePresubmit();
    expect(result.isSelfPr).toBe(false);
    expect(result.headDrift).toMatchObject({ drifted: false });
    expect(result.downgradeReasons).toEqual([]);
  });

  it('keeps an empty whoami from matching an empty author ("" === "")', async () => {
    // The degenerate self-PR: an account-less whoami AND a deleted author
    // are BOTH reachable (each is pinned fail-soft in its own suite). Without
    // the `author !== ''` guard the comparison computes '' === '' → true and
    // downgrades someone else's MR as a self-review. House-pinned for the
    // GitHub path's identical guard (#9212's currentUserLogin tests).
    ensureAoneAuthMock.mockReturnValue('');
    getMrAuthorAndHeadMock.mockReturnValue({ author: '', headSha: 'abc123' });
    const result = await runAonePresubmit();
    expect(result.isSelfPr).toBe(false);
    expect(result.downgradeApprove).toBe(false);
    expect(result.downgradeRequestChanges).toBe(false);
    expect(result.downgradeReasons).toEqual([]);
  });

  it('fails CLOSED when mr view throws — caps the Approve and names it', async () => {
    // A thrown fetch means neither self-PR nor drift could be checked; the
    // run must not proceed as if they passed (GitHub metaUnavailable parity).
    getMrAuthorAndHeadMock.mockImplementation(() => {
      throw new Error('HTTP 502: Bad Gateway');
    });
    const result = await runAonePresubmit();
    expect(result.isSelfPr).toBe(false);
    expect(result.downgradeApprove).toBe(true);
    expect((result.downgradeReasons as string[]).join(' ')).toContain(
      'metadata unavailable',
    );
    // The gate is the ONLY whoami: the fail-closed path pays no account
    // fetch after the thrown mr view — the pre-merge second spawn delayed
    // exactly this report by its own retry budget (#9629 review).
    expect(ensureAoneAuthMock).toHaveBeenCalledTimes(1);
  });

  it("fails with the gate's actionable error when whoami throws — no report", async () => {
    // The gate runs BEFORE the fetch try/catch on purpose: an a1 install or
    // login failure must fail the run with the gate's actionable error, not
    // degrade into a plausible "MR metadata unavailable" report that sends
    // the user to investigate MR access. Moving the gate inside the try/catch
    // keeps every other Aone test green, so this ordering needs its own pin.
    ensureAoneAuthMock.mockImplementation(() => {
      throw new Error('a1 CLI not found on PATH — install the `a1` CLI first.');
    });
    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    await expect(
      handler(aoneArgs as unknown as Parameters<typeof handler>[0]),
    ).rejects.toThrow(/a1 CLI not found/);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(getMrAuthorAndHeadMock).not.toHaveBeenCalled();
  });

  it('reports head drift with null compare and fail-safe anchor risk', async () => {
    // Under AGit-Flow sourceBranch IS the head; Aone has no compare API, so
    // a drifted head is always anchors-at-risk (findingPaths cannot prove
    // otherwise without a touched-file list).
    getMrAuthorAndHeadMock.mockReturnValue({
      author: 'someone-else',
      headSha: 'def456',
    });
    const result = await runAonePresubmit();
    expect(result.headDrift).toEqual({
      reviewedSha: 'abc123',
      liveHeadSha: 'def456',
      drifted: true,
      compare: null,
      anchorsAtRisk: true,
    });
    expect(result.downgradeApprove).toBe(true);
    expect((result.downgradeReasons as string[]).join(' ')).toContain(
      'PR head advanced during review',
    );
  });

  it('refuses a malformed owner_repo as a usage error, not a metadata blip', async () => {
    // A deterministic invocation problem must fail the call — catching it
    // in the platform-fetch try/catch would emit a "metadata unavailable"
    // downgrade report for an owner/repo that was never well-formed.
    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    for (const bad of ['bogus', 'a/b/c', '../repo']) {
      await expect(
        handler({
          ...aoneArgs,
          owner_repo: bad,
        } as unknown as Parameters<typeof handler>[0]),
      ).rejects.toThrow(/expected owner\/repo/);
    }
    expect(writeFileSyncMock).not.toHaveBeenCalled();
    expect(getMrAuthorAndHeadMock).not.toHaveBeenCalled();
  });

  it('refuses a non-positive-integer pr_number before any auth or a1 call', async () => {
    // The id reaches `a1 repo mr view` as a positional — `-1` would parse
    // as a flag — and a NaN id would otherwise ride the fetch try/catch
    // into a "metadata unavailable" report for a deterministic invocation
    // problem. Sibling subcommands validate the same way (usage error).
    const handler = presubmitCommand.handler;
    if (!handler) throw new Error('presubmit handler missing');
    for (const bad of ['-1', '0', '1.5', 'abc', '1e3', '']) {
      await expect(
        handler({
          ...aoneArgs,
          pr_number: bad,
        } as unknown as Parameters<typeof handler>[0]),
      ).rejects.toThrow(/pr_number must be a positive integer/);
    }
    expect(ensureAoneAuthMock).not.toHaveBeenCalled();
    expect(getMrAuthorAndHeadMock).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
