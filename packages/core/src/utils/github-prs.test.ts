/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Root enters any directory, so a test that needs one it cannot enter sets
// the error accessSync throws, and the path it throws for, instead of
// relying on chmod. The path is compared as given: the view passes `cwd`
// to accessSync unchanged.
const fsControl = vi.hoisted(() => ({
  accessError: undefined as NodeJS.ErrnoException | undefined,
  accessPath: undefined as string | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    // Refuses only the search (X_OK) check of the one path the test names,
    // so a check for another mode or of another directory passes and the
    // test notices.
    accessSync: (...args: Parameters<typeof actual.accessSync>) => {
      const mode = args[1] ?? actual.constants.F_OK;
      if (
        fsControl.accessError &&
        args[0] === fsControl.accessPath &&
        mode & actual.constants.X_OK
      ) {
        throw fsControl.accessError;
      }
      return actual.accessSync(...args);
    },
  };
});

import { execFile } from 'node:child_process';
import {
  aggregateChecks,
  createGitHubPullRequest,
  fetchAttributionRepoKeys,
  fetchCurrentBranchName,
  fetchCurrentBranchPullRequest,
  fetchGitHubPullRequests,
  fetchGitHubPullRequestView,
  fetchPullRequestByReference,
  fetchRemoteWebUrl,
  normalizeRemoteToWebUrl,
  parseGhPrList,
  parseGhPrView,
  pullRequestViewUrl,
  repoKeyFromWebUrl,
  resolveGhBinary,
  GITHUB_PR_LIST_LIMIT,
  GITHUB_PR_VIEW_FAILING_CHECKS_MAX,
} from './github-prs.js';

const mockExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

/** Answers every execFile call via `respond` (callback, args, options). */
function mockExec(
  respond: (cb: ExecCallback, args: unknown, opts: unknown) => void,
) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, args: unknown, opts: unknown, cb: unknown) => {
      respond(cb as ExecCallback, args, opts);
      return {} as ReturnType<typeof execFile>;
    },
  );
}

/** Succeeds with `stdout`; with `expectArgs`, each call asserts its args. */
function mockStdout(stdout: string, expectArgs?: string[]) {
  mockExec((cb, args) => {
    if (expectArgs) expect(args).toEqual(expectArgs);
    cb(null, stdout, '');
  });
}

function mockGhSuccess(payload: unknown, expectArgs?: string[]) {
  mockStdout(JSON.stringify(payload), expectArgs);
}

/**
 * Fails the way execFile's callback does: an Error(`message`) carrying
 * `code`, `signal` and `killed` — by default those of a plain `exit 1` — and
 * the stderr only as the callback's third argument, since execFile's error
 * has no `stderr` property of its own.
 */
function mockExecError(
  message: string,
  {
    stderr = '',
    ...fields
  }: {
    code?: string | number | null;
    signal?: string | null;
    stderr?: string;
    killed?: boolean;
  } = {},
) {
  const error = Object.assign(
    new Error(message),
    { code: 1, signal: null, killed: false },
    fields,
  );
  mockExec((cb) => cb(error, '', stderr));
}

/** Gives each test a fresh temp dir (and, by default, reset mocks). */
function useTmpDir(prefix: string, { resetMocks = true } = {}) {
  const tmp = {
    dir: '',
    /** Makes the temp dir a git repository root and returns it. */
    repo: () => {
      fs.mkdirSync(path.join(tmp.dir, '.git'));
      return tmp.dir;
    },
  };
  beforeEach(() => {
    if (resetMocks) vi.resetAllMocks();
    tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  });
  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });
  return tmp;
}

function ghPrEntry(overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    title: 'Fix the thing',
    url: 'https://github.com/o/r/pull/1',
    author: { login: 'octocat' },
    headRefName: 'fix/thing',
    isDraft: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
    updatedAt: '2026-07-24T10:00:00Z',
    ...overrides,
  };
}

describe('parseGhPrList', () => {
  const parse = (...entries: unknown[]) =>
    parseGhPrList(JSON.stringify(entries));

  it('maps gh entries to the daemon shape and sorts by updatedAt desc', () => {
    const result = parse(
      ghPrEntry({ number: 1, updatedAt: '2026-07-20T10:00:00Z' }),
      ghPrEntry({
        number: 2,
        isDraft: true,
        reviewDecision: null,
        updatedAt: '2026-07-24T10:00:00Z',
      }),
    );

    expect(result.map((pr) => pr.number)).toEqual([2, 1]);
    expect(result[0]).toMatchObject({
      state: 'draft',
      reviewDecision: null,
      checks: 'passing',
      updatedAt: Math.floor(Date.parse('2026-07-24T10:00:00Z') / 1000),
    });
    expect(result[1]).toMatchObject({
      state: 'open',
      reviewDecision: 'approved',
    });
  });

  it('maps every review decision variant', () => {
    const result = parse(
      ghPrEntry({ number: 1, reviewDecision: 'APPROVED' }),
      ghPrEntry({ number: 2, reviewDecision: 'CHANGES_REQUESTED' }),
      ghPrEntry({ number: 3, reviewDecision: 'REVIEW_REQUIRED' }),
      ghPrEntry({ number: 4, reviewDecision: '' }),
    );
    expect(result.map((pr) => pr.reviewDecision)).toEqual([
      'approved',
      'changes_requested',
      'review_required',
      null,
    ]);
  });

  it.each([
    ['failing', [{ __typename: 'CheckRun', conclusion: 'FAILURE' }]],
    ['failing', [{ __typename: 'CheckRun', conclusion: 'CANCELLED' }]],
    ['failing', [{ __typename: 'StatusContext', state: 'ERROR' }]],
    ['pending', [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }]],
    ['pending', [{ __typename: 'StatusContext', state: 'PENDING' }]],
    [
      'pending',
      [
        { __typename: 'CheckRun', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'EXPECTED' },
      ],
    ],
    [
      'passing',
      [
        { __typename: 'CheckRun', conclusion: 'SUCCESS' },
        { __typename: 'CheckRun', conclusion: 'SKIPPED' },
        { __typename: 'StatusContext', state: 'SUCCESS' },
      ],
    ],
    ['passing', [{ __typename: 'CheckRun', conclusion: 'NEUTRAL' }]],
    ['none', []],
  ])('aggregates checks to %s', (expected, rollup) => {
    const result = parse(ghPrEntry({ statusCheckRollup: rollup }));
    expect(result[0]?.checks).toBe(expected);
  });

  it('failing wins over pending and passing', () => {
    const result = parse(
      ghPrEntry({
        statusCheckRollup: [
          { __typename: 'CheckRun', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', status: 'QUEUED' },
          { __typename: 'StatusContext', state: 'FAILURE' },
        ],
      }),
    );
    expect(result[0]?.checks).toBe('failing');
  });

  it('drops entries without a numeric PR number and tolerates missing fields', () => {
    const result = parse(
      { title: 'no number' },
      ghPrEntry({ author: null, reviewDecision: null, updatedAt: 'bad' }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      author: '',
      reviewDecision: null,
      updatedAt: 0,
    });
  });

  it('throws on non-array output', () => {
    expect(() => parseGhPrList('{"oops":true}')).toThrow(
      'unexpected gh output',
    );
  });

  it('maps the gh state field to merged/closed, falling back to isDraft', () => {
    const result = parse(
      ghPrEntry({ number: 1, state: 'MERGED' }),
      ghPrEntry({ number: 2, state: 'CLOSED' }),
      ghPrEntry({ number: 3, state: 'OPEN' }),
      ghPrEntry({ number: 4, state: 'OPEN', isDraft: true }),
    );
    expect(result.map((pr) => pr.state)).toEqual([
      'merged',
      'closed',
      'open',
      'draft',
    ]);
  });
});

describe('fetchGitHubPullRequests', () => {
  const tmp = useTmpDir('github-prs-test-');

  it('returns not_a_repo outside a git repository and never spawns gh', async () => {
    const result = await fetchGitHubPullRequests(tmp.dir);

    expect(result).toEqual({ kind: 'not_a_repo' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('runs gh pr list at the git root with the expected arguments', async () => {
    const dir = tmp.repo();
    const nested = path.join(dir, 'sub', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    mockGhSuccess([ghPrEntry()]);

    const result = await fetchGitHubPullRequests(nested);

    expect(result).toEqual({
      kind: 'ok',
      pullRequests: [expect.objectContaining({ number: 1, state: 'open' })],
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|[/\\])gh$/),
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        String(GITHUB_PR_LIST_LIMIT),
        '--json',
        // The full field set must request `state` too: a non-slim
        // `--state all` query without it maps every merged/closed PR as
        // open/draft.
        expect.stringMatching(/reviewDecision.*state/),
      ],
      expect.objectContaining({ cwd: dir, timeout: 10_000 }),
      expect.any(Function),
    );
  });

  it('spawns the fallback gh when PATH cannot resolve it', async () => {
    const dir = tmp.repo();
    const home = path.join(tmp.dir, 'home');
    const binary = fakeGh(path.join(home, '.local', 'bin'));
    mockGhSuccess([ghPrEntry()]);

    await fetchGitHubPullRequests(dir, { PATH: '/nonexistent', HOME: home });

    expect(mockExecFile.mock.calls[0]?.[0]).toBe(binary);
  });

  it('forwards the spawn directory when resolving gh', async () => {
    const dir = tmp.repo();
    fakeGh(path.join(dir, 'bin'));
    const home = path.join(tmp.dir, 'home');
    fakeGh(path.join(home, '.local', 'bin'));
    mockGhSuccess([ghPrEntry()]);

    await fetchGitHubPullRequests(dir, { PATH: 'bin', HOME: home });

    // Literal, not the widened matcher: the fallback would satisfy that too,
    // and this case exists to tell "child PATH resolved" from "fallback won".
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('gh');
  });

  it('reports the fallback binary on a spawn failure', async () => {
    const dir = tmp.repo();
    const home = path.join(tmp.dir, 'home');
    const binary = fakeGh(path.join(home, '.local', 'bin'));
    mockExecError('spawn EACCES', { code: 'EACCES' });

    const result = await fetchGitHubPullRequests(dir, {
      PATH: '/nonexistent',
      HOME: home,
    });

    // The route redacts this exact value: it names the host's HOME and may
    // contain spaces, which a token sweep cannot own.
    expect(result).toMatchObject({ kind: 'failed', binary });
  });

  it('uses slim fields and the requested state/limit when asked', async () => {
    const dir = tmp.repo();
    mockGhSuccess([ghPrEntry({ state: 'MERGED' })]);

    const result = await fetchGitHubPullRequests(dir, undefined, {
      state: 'all',
      limit: 500,
      slim: true,
    });

    expect(result).toEqual({
      kind: 'ok',
      pullRequests: [expect.objectContaining({ number: 1, state: 'merged' })],
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|[/\\])gh$/),
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '500',
        '--json',
        'number,url,headRefName,state',
      ],
      expect.objectContaining({ cwd: dir }),
      expect.any(Function),
    );
  });

  it('returns cli_unavailable when gh is not installed', async () => {
    mockExecError('spawn gh ENOENT', { code: 'ENOENT' });
    const result = await fetchGitHubPullRequests(tmp.repo());
    expect(result).toEqual({ kind: 'cli_unavailable' });
  });

  it('names the timeout when gh is killed after the deadline', async () => {
    mockExecError('Command failed: gh pr list --state open', {
      killed: true,
      code: null,
      signal: 'SIGTERM',
    });
    const result = await fetchGitHubPullRequests(tmp.repo());
    expect(result).toMatchObject({
      kind: 'failed',
      message: 'gh pr list timed out after 10s',
      gitRoot: tmp.dir,
    });
  });

  it('returns failed with a single-line stderr message when gh exits non-zero', async () => {
    mockExecError('exit 1', { stderr: 'gh: not logged in\nRun gh auth login' });
    const result = await fetchGitHubPullRequests(tmp.repo());
    expect(result).toMatchObject({
      kind: 'failed',
      message: 'gh: not logged in Run gh auth login',
      gitRoot: tmp.dir,
    });
  });

  it('names the exit, not the argv, when gh fails with nothing on stderr', async () => {
    const dir = tmp.repo();
    mockExecError('Command failed: gh pr list --state open --limit 100', {
      code: 1,
    });
    expect(await fetchGitHubPullRequests(dir)).toMatchObject({
      kind: 'failed',
      message: 'gh pr list exited with code 1',
    });

    mockExecError('Command failed: gh pr list --state open --limit 100', {
      code: null,
      signal: 'SIGKILL',
    });
    expect(await fetchGitHubPullRequests(dir)).toMatchObject({
      kind: 'failed',
      message: 'gh pr list was killed by SIGKILL',
    });
  });

  it("keeps Node's message for its own failures even when gh wrote stderr", async () => {
    mockExecError('stdout maxBuffer length exceeded', {
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr: 'some progress output\n',
    });
    expect(await fetchGitHubPullRequests(tmp.repo())).toMatchObject({
      kind: 'failed',
      message: 'stdout maxBuffer length exceeded',
    });
  });

  it('keeps stderr past the display cap so the route can sanitize paths', async () => {
    const dir = tmp.repo();
    // Push the absolute path beyond the 512-char display cap; core must not
    // cut it off before the route redacts it.
    mockExecError('exit 1', { stderr: `${'x'.repeat(600)} ${dir} denied` });

    const result = await fetchGitHubPullRequests(dir);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.message).toContain(`${dir} denied`);
      expect(result.message.length).toBeGreaterThan(512);
    }
  });

  it('returns failed when gh emits invalid JSON', async () => {
    mockStdout('not json');
    const result = await fetchGitHubPullRequests(tmp.repo());
    expect(result.kind).toBe('failed');
  });
});

describe('aggregateChecks', () => {
  it.each([
    [undefined, 'none'],
    [[], 'none'],
    [[{ __typename: 'CheckRun', conclusion: 'SUCCESS' }], 'passing'],
    [[{ __typename: 'CheckRun', conclusion: 'skipped' }], 'passing'],
    [[{ __typename: 'CheckRun', conclusion: null }], 'pending'],
    // gh prints an unset conclusion as an empty string.
    [
      [{ __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }],
      'pending',
    ],
    [[{ conclusion: 'FAILURE' }], 'failing'],
    [[{ __typename: 'StatusContext', state: 'failure' }], 'failing'],
    [[{ __typename: 'StatusContext', state: 'PENDING' }], 'pending'],
    [[{ __typename: 'StatusContext', state: 'SUCCESS' }], 'passing'],
    [[{ __typename: 'StatusContext', state: 'ERROR' }], 'failing'],
    [[{ __typename: 'CheckRun', conclusion: 'cancelled' }], 'failing'],
    [[{ __typename: 'CheckRun', conclusion: 'STALE' }], 'failing'],
    [[{ __typename: 'CheckRun', conclusion: 'ACTION_REQUIRED' }], 'failing'],
    [[{ __typename: 'CheckRun', conclusion: 'STARTUP_FAILURE' }], 'failing'],
    [
      [
        { __typename: 'CheckRun', conclusion: null },
        { __typename: 'CheckRun', conclusion: 'TIMED_OUT' },
      ],
      'failing',
    ],
    [
      [
        { __typename: 'CheckRun', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', state: 'EXPECTED' },
      ],
      'pending',
    ],
  ])('reduces %j to %s', (rollup, expected) => {
    expect(aggregateChecks(rollup)).toBe(expected);
  });

  it('counts every run, including a failed attempt a rerun superseded', () => {
    // Attempts of one check are not told from runs of other triggers (gh
    // exports no trigger, app or workflow id): every run counts.
    const run = (conclusion: string, extra = {}) => ({
      __typename: 'CheckRun',
      name: 'build',
      workflowName: 'CI',
      conclusion,
      ...extra,
    });
    expect(
      aggregateChecks([
        run('FAILURE', { startedAt: '2026-11-07T10:00:00Z' }),
        run('SUCCESS', { startedAt: '2026-11-07T11:00:00Z' }),
      ]),
    ).toBe('failing');
    // A later run its `if:` skipped does not hide the failure either.
    expect(aggregateChecks([run('FAILURE'), run('SKIPPED')])).toBe('failing');
  });
});

function ghPrView(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://github.com/o/r/pull/7',
    title: 'Fix the build',
    headRefOid: 'abc123',
    mergeable: 'MERGEABLE',
    state: 'OPEN',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
    ],
    ...overrides,
  };
}

describe('parseGhPrView', () => {
  const parse = (overrides: Record<string, unknown> = {}) =>
    parseGhPrView(JSON.stringify(ghPrView(overrides)));

  it('maps the view to the watch shape', () => {
    expect(parse()).toEqual({
      url: 'https://github.com/o/r/pull/7',
      title: 'Fix the build',
      headSha: 'abc123',
      state: 'open',
      mergeable: 'mergeable',
      checks: 'passing',
      failingChecks: [],
    });
  });

  it.each([
    ['OPEN', 'open'],
    ['MERGED', 'merged'],
    ['CLOSED', 'closed'],
    ['closed', 'closed'],
  ])('maps state %s to %s', (state, expected) => {
    expect(parse({ state }).state).toBe(expected);
  });

  it('maps CONFLICTING and leaves UNKNOWN or anything else absent', () => {
    expect(parse({ mergeable: 'CONFLICTING' }).mergeable).toBe('conflicting');
    expect(parse({ mergeable: 'mergeable' }).mergeable).toBe('mergeable');
    for (const mergeable of ['UNKNOWN', undefined, null, 'clean', 3]) {
      const view = parse({ mergeable });
      expect(view).not.toHaveProperty('mergeable');
    }
  });

  it('names the failing checks as GitHub labels them, in rollup order, once each, capped', () => {
    const view = parse({
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'zeta', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
        { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
        {
          __typename: 'CheckRun',
          name: 'zeta',
          workflowName: 'Nightly',
          conclusion: 'CANCELLED',
        },
        { __typename: 'CheckRun', name: 'e2e', conclusion: null },
        { __typename: 'CheckRun', conclusion: 'FAILURE' },
        // Failing but nameless: they count towards `checks`, unnamed.
        { __typename: 'CheckRun', name: '', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', context: '', state: 'FAILURE' },
        {
          __typename: 'CheckRun',
          name: 'alpha',
          workflowName: '',
          conclusion: 'TIMED_OUT',
        },
        { __typename: 'CheckRun', name: 'zeta', conclusion: 'FAILURE' },
        null,
        'junk',
      ],
    });
    expect(view.checks).toBe('failing');
    expect(view.failingChecks).toEqual([
      'zeta',
      'ci/legacy',
      'Nightly / zeta',
      'alpha',
    ]);

    // Nameless failures alone still fail the head, with nothing to name.
    for (const entry of [
      { __typename: 'CheckRun', name: '', conclusion: 'FAILURE' },
      { __typename: 'StatusContext', context: '', state: 'FAILURE' },
    ]) {
      const nameless = parse({
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
          entry,
        ],
      });
      expect(nameless.checks).toBe('failing');
      expect(nameless.failingChecks).toEqual([]);
    }

    // The cap is pinned, not derived from the constant it is checked by.
    expect(GITHUB_PR_VIEW_FAILING_CHECKS_MAX).toBe(20);
    const many = parse({
      statusCheckRollup: Array.from(
        { length: GITHUB_PR_VIEW_FAILING_CHECKS_MAX + 1 },
        (_, i) => ({
          __typename: 'CheckRun',
          name: `job-${i}`,
          conclusion: 'FAILURE',
        }),
      ),
    });
    expect(many.failingChecks).toEqual(
      Array.from({ length: 20 }, (_, i) => `job-${i}`),
    );
  });

  it('keeps a failed attempt a rerun superseded, and names it', () => {
    const view = parse({
      statusCheckRollup: [
        {
          __typename: 'CheckRun',
          name: 'build',
          workflowName: 'CI',
          conclusion: 'FAILURE',
        },
        {
          __typename: 'CheckRun',
          name: 'build',
          workflowName: 'CI',
          conclusion: 'SUCCESS',
        },
      ],
    });
    expect(view.checks).toBe('failing');
    expect(view.failingChecks).toEqual(['CI / build']);
  });

  it('drops entries gh would never print instead of failing the view', () => {
    const view = parse({
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'odd', conclusion: 7 },
        { __typename: 'StatusContext', context: 'odd', state: false },
        { __typename: 'CheckRun', name: 'lint', conclusion: 'SUCCESS' },
      ],
    });
    expect(view.checks).toBe('passing');
  });

  it('reports no checks and an empty title as such', () => {
    const view = parse({ statusCheckRollup: undefined, title: undefined });
    expect(view.checks).toBe('none');
    expect(view.title).toBe('');
  });

  it.each([
    ['[]', 'expected a JSON object'],
    ['null', 'expected a JSON object'],
    [JSON.stringify(ghPrView({ url: '' })), 'missing url'],
    [JSON.stringify(ghPrView({ headRefOid: undefined })), 'missing headRefOid'],
    [JSON.stringify(ghPrView({ state: 'DRAFT' })), 'unknown state'],
  ])('rejects %s', (stdout, message) => {
    expect(() => parseGhPrView(stdout)).toThrow(message);
  });
});

describe('fetchGitHubPullRequestView', () => {
  const tmp = useTmpDir('github-pr-view-test-');
  const url = 'https://github.com/o/r/pull/7';
  /** An env whose PATH resolves gh, so no fallback binary is reported. */
  const ghOnPath = () => ({
    PATH: path.dirname(fakeGh(path.join(tmp.dir, 'bin'))),
  });

  it('views the PR by URL from the given directory', async () => {
    mockGhSuccess(ghPrView());

    const result = await fetchGitHubPullRequestView(url, tmp.dir, {
      GH_TOKEN: 'workspace-token',
      GH_REPO: 'other/repo',
    });

    expect(result).toEqual({
      kind: 'ok',
      view: expect.objectContaining({ headSha: 'abc123', state: 'open' }),
    });
    expect(mockExecFile).toHaveBeenCalledWith(
      expect.stringMatching(/(?:^|[/\\])gh$/),
      [
        'pr',
        'view',
        url,
        '--json',
        'url,title,headRefOid,mergeable,state,statusCheckRollup',
      ],
      expect.objectContaining({
        cwd: tmp.dir,
        timeout: 10_000,
        env: expect.objectContaining({ GH_TOKEN: 'workspace-token' }),
      }),
      expect.any(Function),
    );
    // ghEnv strips repository selectors: only the URL names the PR.
    const options = mockExecFile.mock.calls[0]?.[2] as {
      env: Record<string, string | undefined>;
    };
    expect(options.env).not.toHaveProperty('GH_REPO');
  });

  it.each([
    [
      'https://user:pw@github.com:8443/o/r/pull/7/files?x=1#y',
      'https://github.com:8443/o/r/pull/7',
    ],
    [
      'https://github.com/O.rg/R_e-po/pull/7.diff',
      'https://github.com/O.rg/R_e-po/pull/7',
    ],
    [
      'HTTP://GHE.example.com/o/r/pull/12.patch',
      'http://ghe.example.com/o/r/pull/12',
    ],
    ['https://www.github.com/o/r/pull/7/', 'https://www.github.com/o/r/pull/7'],
    ['https://github.com/o/r/pull/007', 'https://github.com/o/r/pull/7'],
  ])('hands gh the rebuilt URL for %s', async (input, expected) => {
    mockGhSuccess(ghPrView());
    await fetchGitHubPullRequestView(input, tmp.dir);
    expect(mockExecFile.mock.calls[0]?.[1]).toEqual([
      'pr',
      'view',
      expected,
      '--json',
      'url,title,headRefOid,mergeable,state,statusCheckRollup',
    ]);
  });

  it.each([
    '-R',
    '--repo=o/r',
    '7',
    'github.com/o/r/pull/7',
    'ftp://h/o/r/pull/7',
    'https://github.com/o/r/issues/7',
    'https://github.com/o/r',
    'https://github.com/o/r/PULL/7',
    'https://github.com/o/r/pull/0',
    'https://github.com/o/r/pull/000',
    'https://github.com/o/r/pull/abc',
    'https://github.com/o/r/pull/7x',
    'https://github.com/o%2Fx/r/pull/7',
    'https://github.com/o/r/pull/99999999999999999999',
  ])('refuses %s without spawning gh', async (bad) => {
    // A spawn would succeed, so a missing guard fails fast instead of hanging.
    mockGhSuccess(ghPrView());
    expect(pullRequestViewUrl(bad)).toBeUndefined();
    const result = await fetchGitHubPullRequestView(bad, tmp.dir);
    expect(result).toEqual({
      kind: 'failed',
      reason: 'not_a_pr_url',
      message: 'not a pull request URL',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('refuses a working directory that is a file without spawning gh', async () => {
    const file = path.join(tmp.dir, 'file');
    fs.writeFileSync(file, '');
    mockGhSuccess(ghPrView());
    expect(await fetchGitHubPullRequestView(url, file)).toEqual({
      kind: 'failed',
      reason: 'cwd_missing',
      message: 'gh pr view working directory is not a directory',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('refuses a working directory that does not exist without spawning gh', async () => {
    mockGhSuccess(ghPrView());
    const result = await fetchGitHubPullRequestView(
      url,
      path.join(tmp.dir, 'gone'),
    );
    expect(result).toEqual({
      kind: 'failed',
      reason: 'cwd_missing',
      message: 'gh pr view working directory does not exist',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('refuses a working directory below a file as missing', async () => {
    const file = path.join(tmp.dir, 'file');
    fs.writeFileSync(file, '');
    mockGhSuccess(ghPrView());
    expect(
      await fetchGitHubPullRequestView(url, path.join(file, 'sub')),
    ).toEqual({
      kind: 'failed',
      reason: 'cwd_missing',
      message: 'gh pr view working directory does not exist',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // Creating a symlink needs a privilege Windows runners may lack.
  it.skipIf(process.platform === 'win32')(
    'names a working directory that cannot be inspected, without spawning gh',
    async () => {
      const loop = path.join(tmp.dir, 'loop');
      fs.symlinkSync(loop, loop);
      mockGhSuccess(ghPrView());
      expect(await fetchGitHubPullRequestView(url, loop)).toEqual({
        kind: 'failed',
        reason: 'cwd_unusable',
        message: 'gh pr view working directory cannot be inspected (ELOOP)',
      });
      expect(mockExecFile).not.toHaveBeenCalled();
    },
  );

  it('names a working directory that cannot be entered, without spawning gh', async () => {
    mockGhSuccess(ghPrView());
    fsControl.accessError = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    fsControl.accessPath = tmp.dir;
    try {
      expect(await fetchGitHubPullRequestView(url, tmp.dir)).toEqual({
        kind: 'failed',
        reason: 'cwd_unusable',
        message: 'gh pr view working directory cannot be entered (EACCES)',
      });
    } finally {
      fsControl.accessError = undefined;
      fsControl.accessPath = undefined;
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('resolves a relative PATH entry against the given directory', async () => {
    fakeGh(path.join(tmp.dir, 'bin'));
    const home = path.join(tmp.dir, 'home');
    fakeGh(path.join(home, '.local', 'bin'));
    mockGhSuccess(ghPrView());

    await fetchGitHubPullRequestView(url, tmp.dir, { PATH: 'bin', HOME: home });

    // Literal: the fallback would also match a looser matcher.
    expect(mockExecFile.mock.calls[0]?.[0]).toBe('gh');
  });

  it('maps a missing gh to cli_unavailable', async () => {
    mockExecError('spawn gh ENOENT', { code: 'ENOENT' });
    expect(await fetchGitHubPullRequestView(url, tmp.dir)).toEqual({
      kind: 'cli_unavailable',
    });
  });

  it("passes gh's stderr through and names the view command on a timeout", async () => {
    const env = ghOnPath();
    mockExecError('Command failed', {
      stderr: 'GraphQL: Could not resolve to a PullRequest\n',
    });
    expect(await fetchGitHubPullRequestView(url, tmp.dir, env)).toEqual({
      kind: 'failed',
      reason: 'gh_failed',
      message: 'GraphQL: Could not resolve to a PullRequest',
    });

    mockExecError('Command failed: gh pr view', {
      killed: true,
      code: null,
      signal: 'SIGTERM',
    });
    expect(await fetchGitHubPullRequestView(url, tmp.dir, env)).toEqual({
      kind: 'failed',
      reason: 'timed_out',
      message: 'gh pr view timed out after 10s',
    });
  });

  it('reports the fallback binary on a spawn failure', async () => {
    const home = path.join(tmp.dir, 'home');
    const binary = fakeGh(path.join(home, '.local', 'bin'));
    mockExecError('spawn EACCES', { code: 'EACCES' });

    const result = await fetchGitHubPullRequestView(url, tmp.dir, {
      PATH: '/nonexistent',
      HOME: home,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      reason: 'gh_failed',
      binary,
    });
  });

  it('fails on output it cannot parse without naming the binary', async () => {
    // A fallback binary is in play, so only the parse path can omit it.
    const home = path.join(tmp.dir, 'home');
    fakeGh(path.join(home, '.local', 'bin'));
    mockStdout('not json');
    const result = await fetchGitHubPullRequestView(url, tmp.dir, {
      PATH: '/nonexistent',
      HOME: home,
    });
    expect(result).toMatchObject({ kind: 'failed', reason: 'unparsable' });
    expect(result).not.toHaveProperty('binary');
  });
});

describe('createGitHubPullRequest', () => {
  const tmp = useTmpDir('github-prs-create-', { resetMocks: false });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Answers gh pr create with the PR `url`; `seen.env` is the env gh got. */
  const answerWithUrl = (url: string) => {
    const seen: { env?: Record<string, string | undefined> } = {};
    mockExec((cb, _args, opts) => {
      seen.env = (opts as { env?: Record<string, string | undefined> }).env;
      cb(null, `${url}\n`, '');
    });
    return seen;
  };

  it('clears repository-shifting git env vars when spawning gh pr create', async () => {
    const dir = tmp.repo();
    vi.stubEnv('GIT_DIR', '/somewhere/else/.git');
    vi.stubEnv('GIT_WORK_TREE', '/somewhere/else');
    const seen = answerWithUrl('https://github.com/o/r/pull/42');

    const result = await createGitHubPullRequest(dir, { title: 'My PR' });

    expect(result).toEqual({
      kind: 'ok',
      url: 'https://github.com/o/r/pull/42',
      number: 42,
    });
    expect(seen.env).toBeDefined();
    expect(seen.env).not.toHaveProperty('GIT_DIR');
    expect(seen.env).not.toHaveProperty('GIT_WORK_TREE');
  });

  it('gives gh pr create its longer 30 s timeout', async () => {
    mockExecFile.mockClear();
    const dir = tmp.repo();
    answerWithUrl('https://github.com/o/r/pull/7');

    await createGitHubPullRequest(dir, { title: 'My PR' });

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0]?.[2]).toMatchObject({
      timeout: 30_000,
    });
  });

  it('spawns the fallback gh when PATH cannot resolve it', async () => {
    const dir = tmp.repo();
    const home = path.join(tmp.dir, 'home');
    const binary = fakeGh(path.join(home, '.local', 'bin'));
    answerWithUrl('https://github.com/o/r/pull/7');

    await createGitHubPullRequest(
      dir,
      { title: 'My PR' },
      { PATH: '/nonexistent', HOME: home },
    );

    expect(mockExecFile).toHaveBeenCalledWith(
      binary,
      expect.any(Array),
      expect.anything(),
      expect.any(Function),
    );
  });

  it('forwards a workspace env while still stripping repository selectors', async () => {
    const dir = tmp.repo();
    const seen = answerWithUrl('https://github.com/o/r/pull/7');

    const result = await createGitHubPullRequest(
      dir,
      { title: 'My PR' },
      { GH_TOKEN: 'ws-token', GH_REPO: 'evil/repo', PATH: '/usr/bin' },
    );

    expect(result).toEqual({
      kind: 'ok',
      url: 'https://github.com/o/r/pull/7',
      number: 7,
    });
    expect(seen.env).toBeDefined();
    expect(seen.env?.['GH_TOKEN']).toBe('ws-token');
    expect(seen.env).not.toHaveProperty('GH_REPO');
  });

  it("reports gh's stderr, not Node's argv, when gh pr create fails", async () => {
    const dir = tmp.repo();
    mockExecError('Command failed: gh pr create --title My PR --body draft', {
      stderr: 'pull request create failed: No commits between main and x\n',
    });

    const result = await createGitHubPullRequest(dir, {
      title: 'My PR',
      body: 'draft',
    });

    expect(result).toMatchObject({
      kind: 'failed',
      message: 'pull request create failed: No commits between main and x',
    });
  });

  it('does not report the PR title and body when gh pr create fails silently', async () => {
    const dir = tmp.repo();
    mockExecError('Command failed: gh pr create --title My PR --body secret', {
      code: 1,
    });

    const result = await createGitHubPullRequest(dir, {
      title: 'My PR',
      body: 'secret',
    });

    expect(result).toMatchObject({
      kind: 'failed',
      message: 'gh pr create exited with code 1',
    });
  });

  it('uses XDG gh credentials without exposing XDG git config to subprocesses', async () => {
    const dir = tmp.repo();
    let seenEnv: Record<string, string | undefined> | undefined;
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, opts: unknown, cb: unknown) => {
        seenEnv = (opts as { env?: Record<string, string | undefined> }).env;
        (cb as ExecCallback)(null, 'https://github.com/o/r/pull/7\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    await createGitHubPullRequest(
      dir,
      { title: 'My PR' },
      {
        XDG_CONFIG_HOME: '/tmp/gh-user-config',
        GIT_SSL_CAINFO: '/tmp/ca.pem',
        GIT_DIR: '/tmp/decoy/.git',
      },
    );

    expect(seenEnv?.['GH_CONFIG_DIR']).toBe(
      path.join('/tmp/gh-user-config', 'gh'),
    );
    expect(seenEnv?.['GIT_SSL_CAINFO']).toBe('/tmp/ca.pem');
    expect(seenEnv).not.toHaveProperty('XDG_CONFIG_HOME');
    expect(seenEnv).not.toHaveProperty('GIT_DIR');
  });

  it("preserves the caller SSH transport for gh pr create's internal git push", async () => {
    // gh shells out to `git push` for the head branch; the scrubbed env
    // must re-apply the remote-transport keys the way gitRemoteEnv does for
    // a direct push, or the push authenticates with the wrong key/proxy.
    const dir = tmp.repo();
    let seenEnv: Record<string, string | undefined> | undefined;
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, opts: unknown, cb: unknown) => {
        seenEnv = (opts as { env?: Record<string, string | undefined> }).env;
        (cb as ExecCallback)(null, 'https://github.com/o/r/pull/7\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    const result = await createGitHubPullRequest(
      dir,
      { title: 'My PR' },
      {
        GIT_SSH_COMMAND: 'ssh -i ~/.ssh/work_ed25519 -J bastion',
        GIT_SSH: '/tmp/git-ssh',
        GIT_ASKPASS: '/tmp/askpass',
        SSH_ASKPASS: '/tmp/ssh-askpass',
        GIT_DIR: '/tmp/decoy/.git',
      },
    );

    expect(result.kind).toBe('ok');
    expect(seenEnv?.['GIT_SSH_COMMAND']).toBe(
      'ssh -i ~/.ssh/work_ed25519 -J bastion',
    );
    expect(seenEnv?.['GIT_SSH']).toBe('/tmp/git-ssh');
    expect(seenEnv?.['GIT_ASKPASS']).toBe('/tmp/askpass');
    expect(seenEnv?.['SSH_ASKPASS']).toBe('/tmp/ssh-askpass');
    expect(seenEnv).not.toHaveProperty('GIT_DIR');
  });
});

describe('normalizeRemoteToWebUrl', () => {
  it('normalizes https remotes, stripping .git', () => {
    expect(normalizeRemoteToWebUrl('https://github.com/o/r.git')).toBe(
      'https://github.com/o/r',
    );
  });

  it('normalizes scp-style ssh remotes', () => {
    expect(normalizeRemoteToWebUrl('git@github.com:o/r.git')).toBe(
      'https://github.com/o/r',
    );
  });

  it('normalizes ssh:// remotes', () => {
    expect(normalizeRemoteToWebUrl('ssh://git@github.com/o/r')).toBe(
      'https://github.com/o/r',
    );
  });

  it('keeps enterprise hosts', () => {
    expect(normalizeRemoteToWebUrl('git@code.example.com:team/repo.git')).toBe(
      'https://code.example.com/team/repo',
    );
  });

  it('drops the port an ssh:// remote carries', () => {
    expect(
      normalizeRemoteToWebUrl('ssh://git@host.example.com:2222/team/repo.git'),
    ).toBe('https://host.example.com/team/repo');
  });

  it('keeps an explicit http(s) port', () => {
    // An https remote's port IS the web port: a self-hosted
    // `https://ghe.corp:8443/team/repo.git` must link on 8443, not 443.
    expect(normalizeRemoteToWebUrl('https://ghe.corp:8443/team/repo.git')).toBe(
      'https://ghe.corp:8443/team/repo',
    );
    expect(normalizeRemoteToWebUrl('http://code.local:3000/o/r')).toBe(
      'http://code.local:3000/o/r',
    );
  });

  it('accepts any scp-style user, not only git@', () => {
    expect(normalizeRemoteToWebUrl('jdoe@gitlab.corp:team/repo.git')).toBe(
      'https://gitlab.corp/team/repo',
    );
  });

  it('rejects garbage and non-http protocols', () => {
    expect(normalizeRemoteToWebUrl('not a url')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('git://github.com/o/r')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('')).toBeUndefined();
  });

  it('rejects Windows drive-letter local-path origins', () => {
    // `git clone C:\\src\\origin.git` leaves a drive path as the remote;
    // it matches the scp shape with the drive letter as "host" and would
    // otherwise fabricate https://c//src/origin. Real hostnames are never
    // a single character; drive letters always are.
    expect(normalizeRemoteToWebUrl('C:\\src\\origin.git')).toBeUndefined();
    expect(normalizeRemoteToWebUrl('D:/repos/origin.git')).toBeUndefined();
  });
});

describe('repoKeyFromWebUrl', () => {
  it('extracts host/owner/repo from web and PR URLs', () => {
    expect(repoKeyFromWebUrl('https://github.com/o/r')).toBe('github.com/o/r');
    expect(repoKeyFromWebUrl('https://github.com/o/r/pull/42')).toBe(
      'github.com/o/r',
    );
  });

  it('lowercases host, owner, and repo', () => {
    expect(repoKeyFromWebUrl('https://GitHub.com/Owner/Repo/pull/1')).toBe(
      'github.com/owner/repo',
    );
  });

  it('canonicalizes a www. host prefix', () => {
    // An origin remote spelled with www. must key identically to gh's own
    // page URLs or the repo gate never matches them.
    expect(repoKeyFromWebUrl('https://www.github.com/o/r')).toBe(
      'github.com/o/r',
    );
  });

  it('returns undefined for non-http URLs and missing path segments', () => {
    expect(repoKeyFromWebUrl('javascript:alert(1)')).toBeUndefined();
    expect(repoKeyFromWebUrl('https://github.com/o')).toBeUndefined();
    expect(repoKeyFromWebUrl('not a url')).toBeUndefined();
  });
});

describe('fetchRemoteWebUrl', () => {
  const tmp = useTmpDir('github-prs-remote-');

  it('resolves and normalizes the origin remote', async () => {
    mockStdout('git@github.com:o/r.git\n', ['remote', 'get-url', 'origin']);
    expect(await fetchRemoteWebUrl(tmp.repo())).toBe('https://github.com/o/r');
  });

  it('returns undefined outside a git repository without spawning git', async () => {
    expect(await fetchRemoteWebUrl(tmp.dir)).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns undefined when git fails (no origin)', async () => {
    mockExecError('fatal: no remote named origin');
    expect(await fetchRemoteWebUrl(tmp.repo())).toBeUndefined();
  });
});

/** Creates `<dir>/gh` and returns its path. */
function fakeGh(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const binary = path.join(dir, 'gh');
  fs.writeFileSync(binary, '');
  return binary;
}

describe('resolveGhBinary', () => {
  const tmp = useTmpDir('github-prs-gh-binary-');

  it('executes the gh that PATH resolves even when a fallback is installed', () => {
    const binDir = path.join(tmp.dir, 'bin');
    fakeGh(binDir);
    // A fallback that exists on the host must not outrank PATH. Creating one
    // makes "PATH wins" observable regardless of this machine's installs.
    fakeGh(path.join(tmp.dir, 'home', '.local', 'bin'));
    expect(
      resolveGhBinary(
        {
          PATH: binDir,
          HOME: path.join(tmp.dir, 'home'),
        },
        tmp.dir,
      ),
    ).toBe('gh');
  });

  it('resolves a relative PATH entry against the child directory', () => {
    const cwd = path.join(tmp.dir, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    fakeGh(path.join(cwd, 'bin'));
    // The fallback is the discriminator: reaching it means the relative entry
    // was probed under this process's cwd instead of the spawn directory.
    fakeGh(path.join(tmp.dir, 'home', '.local', 'bin'));
    expect(
      resolveGhBinary({ PATH: 'bin', HOME: path.join(tmp.dir, 'home') }, cwd),
    ).toBe('gh');
  });

  it('resolves an empty PATH component against the child directory', () => {
    const cwd = path.join(tmp.dir, 'repo2');
    fs.mkdirSync(cwd, { recursive: true });
    fakeGh(cwd);
    fakeGh(path.join(tmp.dir, 'home', '.local', 'bin'));
    expect(
      resolveGhBinary(
        {
          PATH: `${path.delimiter}${path.join(tmp.dir, 'missing')}`,
          HOME: path.join(tmp.dir, 'home'),
        },
        cwd,
      ),
    ).toBe('gh');
  });

  it('falls back to the per-user install when PATH cannot resolve gh', () => {
    // A daemon launched by launchd inherits `/usr/bin:/bin:…` — no
    // package-manager bin dir — so a bare name would fail with ENOENT and
    // every gh consumer would silently degrade.
    const binary = fakeGh(path.join(tmp.dir, 'home', '.local', 'bin'));
    expect(
      resolveGhBinary(
        {
          PATH: '/nonexistent',
          HOME: path.join(tmp.dir, 'home'),
        },
        tmp.dir,
      ),
    ).toBe(binary);
  });
});

describe('fetchCurrentBranchPullRequest', () => {
  const tmp = useTmpDir('github-prs-branch-pr-');

  it('spawns the fallback gh when PATH cannot resolve it', async () => {
    const dir = tmp.repo();
    const home = path.join(tmp.dir, 'home');
    const binary = fakeGh(path.join(home, '.local', 'bin'));
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'OPEN',
      headRefName: 'feat/x',
    });

    await fetchCurrentBranchPullRequest(dir, {
      PATH: '/nonexistent',
      HOME: home,
    });

    expect(mockExecFile.mock.calls[0]?.[0]).toBe(binary);
  });

  it('resolves number, url, state, and head branch from gh', async () => {
    mockGhSuccess(
      {
        number: 77,
        url: 'https://github.com/o/r/pull/77',
        state: 'OPEN',
        headRefName: 'feat/x',
      },
      ['pr', 'view', '--json', 'number,url,state,headRefName'],
    );

    expect(await fetchCurrentBranchPullRequest(tmp.repo())).toEqual({
      status: 'pr',
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'open',
      headRefName: 'feat/x',
    });
  });

  it('fails closed when gh reports no recognizable state', async () => {
    // A retry that resolves the branch's existing PR must never bind on a
    // shape the caller cannot gate on — an unparseable pre-state is an
    // error, not a proved absence.
    const dir = tmp.repo();
    mockGhSuccess({ number: 77, url: 'https://github.com/o/r/pull/77' });
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'SOMETHING_NEW',
    });
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
  });

  it('reports none when gh proves the branch has no PR', async () => {
    // gh exits non-zero with a characteristic message when the branch
    // simply has no PR — a proved absence, distinct from a fetch failure.
    mockExecError('exit code 1', {
      stderr: 'no pull requests found for branch "feat/x"',
    });
    expect(await fetchCurrentBranchPullRequest(tmp.repo())).toEqual({
      status: 'none',
    });
  });

  it('reports error when the gh fetch fails', async () => {
    // Timeouts, rate limits, and auth failures prove nothing about the
    // branch's PRs; the attribution gate must decline on them instead of
    // reading them as "no prior PR".
    mockExecError('network timeout', {
      killed: true,
      code: null,
      signal: 'SIGTERM',
    });
    expect(await fetchCurrentBranchPullRequest(tmp.repo())).toEqual({
      status: 'error',
    });
  });

  it('reports error outside a git repository without spawning gh', async () => {
    // No repo proves nothing about a branch's PR — a gate-passing command
    // may clone the repo into the working dir and resolve its existing PR
    // post-run — so the pre-state fails closed instead of reading as
    // "no prior PR".
    expect(await fetchCurrentBranchPullRequest(tmp.dir)).toEqual({
      status: 'error',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('fetchPullRequestByReference', () => {
  const tmp = useTmpDir('github-prs-by-ref-');

  it('resolves a bare number through gh pr view', async () => {
    mockGhSuccess(
      {
        number: 77,
        url: 'https://github.com/o/r/pull/77',
        state: 'OPEN',
      },
      ['pr', 'view', '77', '--json', 'number,url,state'],
    );

    expect(await fetchPullRequestByReference(tmp.repo(), '77')).toEqual({
      status: 'pr',
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'open',
    });
  });

  it('walks up to the repository root when cwd is a subdirectory', async () => {
    const repo = tmp.repo();
    const subdir = path.join(repo, 'packages', 'sub');
    fs.mkdirSync(subdir, { recursive: true });
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'OPEN',
    });
    await fetchPullRequestByReference(subdir, '77');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    // findGitRoot must walk the subdirectory up to the repo root, not spawn
    // gh in the subdirectory itself.
    const opts = mockExecFile.mock.calls[0][2] as { cwd: string };
    expect(opts.cwd).toBe(repo);
  });

  it('passes a URL reference through unchanged', async () => {
    const url = 'https://github.example.com/o/r/pull/5';
    mockGhSuccess({ number: 5, url, state: 'MERGED' }, [
      'pr',
      'view',
      url,
      '--json',
      'number,url,state',
    ]);

    expect(await fetchPullRequestByReference(tmp.repo(), url)).toEqual({
      status: 'pr',
      number: 5,
      url,
      state: 'merged',
    });
  });

  it('classifies a gh lookup failure as failed', async () => {
    mockExecError('could not resolve to a PullRequest');
    expect(await fetchPullRequestByReference(tmp.repo(), '999999999')).toEqual({
      status: 'error',
      reason: 'failed',
    });
  });

  it('classifies a missing gh binary as unavailable', async () => {
    mockExecError('spawn gh ENOENT', { code: 'ENOENT' });
    expect(await fetchPullRequestByReference(tmp.repo(), '77')).toEqual({
      status: 'error',
      reason: 'unavailable',
    });
  });

  it('classifies a killed gh child as timeout', async () => {
    mockExecError('timed out', { killed: true });
    expect(await fetchPullRequestByReference(tmp.repo(), '77')).toEqual({
      status: 'error',
      reason: 'timeout',
    });
  });

  it('classifies a missing working directory as failed without spawning gh', async () => {
    // A missing cwd spawns the same ENOENT as a missing binary; the
    // pre-check keeps 'unavailable' meaning "gh is not installed".
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'OPEN',
    });
    // Outside any repository so findGitRoot cannot resolve the missing cwd
    // up to an existing parent repo.
    const missing = path.join(os.tmpdir(), 'github-prs-by-ref-missing-cwd');
    expect(await fetchPullRequestByReference(missing, '77')).toEqual({
      status: 'error',
      reason: 'failed',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('refuses a deleted cwd inside a surviving repository instead of binding the ancestor repo', async () => {
    // findGitRoot only inspects ancestors' .git, so a deleted cwd under a
    // surviving repo resolves up to that repo. The pre-check must run on the
    // caller-named cwd BEFORE that resolution, or a bare number binds the
    // ancestor repo's PR (a checkout the session never referenced) and
    // returns success. Reordering the check back after findGitRoot reds this.
    const repo = tmp.repo();
    const gone = path.join(repo, 'vendor', 'libfoo');
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/ancestor/repo/pull/77',
      state: 'OPEN',
    });
    expect(await fetchPullRequestByReference(gone, '77')).toEqual({
      status: 'error',
      reason: 'failed',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('fails closed on an unrecognizable state', async () => {
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'SOMETHING_NEW',
    });
    expect(await fetchPullRequestByReference(tmp.repo(), '77')).toEqual({
      status: 'error',
      reason: 'failed',
    });
  });

  it('fails closed on unparseable output', async () => {
    mockStdout('not json');
    expect(await fetchPullRequestByReference(tmp.repo(), '77')).toEqual({
      status: 'error',
      reason: 'failed',
    });
  });

  it('still spawns gh outside a git repository (a URL names its own repo)', async () => {
    mockGhSuccess({
      number: 5,
      url: 'https://github.com/o/r/pull/5',
      state: 'CLOSED',
    });
    expect(
      await fetchPullRequestByReference(
        tmp.dir,
        'https://github.com/o/r/pull/5',
      ),
    ).toEqual({
      status: 'pr',
      number: 5,
      url: 'https://github.com/o/r/pull/5',
      state: 'closed',
    });
    expect(mockExecFile.mock.calls[0]?.[2]).toMatchObject({ cwd: tmp.dir });
  });
});

describe('fetchCurrentBranchName', () => {
  const tmp = useTmpDir('github-prs-branch-name-');

  it('resolves the checked-out branch', async () => {
    mockStdout('feat/x\n', ['branch', '--show-current']);
    expect(await fetchCurrentBranchName(tmp.repo())).toBe('feat/x');
  });

  it('returns undefined outside a git repository without spawning git', async () => {
    expect(await fetchCurrentBranchName(tmp.dir)).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns undefined on a detached HEAD or git failure', async () => {
    const dir = tmp.repo();
    mockStdout('');
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();

    mockExecError('not a git repository');
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();
  });
});

describe('fetchAttributionRepoKeys', () => {
  const tmp = useTmpDir('github-prs-repo-keys-');

  it('resolves the repo key and the fork-parent key', async () => {
    mockGhSuccess(
      {
        url: 'https://github.com/fork/r',
        parent: { url: 'https://github.com/parent/r' },
      },
      ['repo', 'view', '--json', 'url,parent'],
    );

    expect(await fetchAttributionRepoKeys(tmp.repo())).toEqual({
      resolved: 'github.com/fork/r',
      parent: 'github.com/parent/r',
    });
  });

  it('spawns the fallback gh when PATH cannot resolve it', async () => {
    const dir = tmp.repo();
    const home = path.join(tmp.dir, 'home');
    const binary = fakeGh(path.join(home, '.local', 'bin'));
    mockGhSuccess({ url: 'https://github.com/o/r' });

    await fetchAttributionRepoKeys(dir, { PATH: '/nonexistent', HOME: home });

    expect(mockExecFile.mock.calls[0]?.[0]).toBe(binary);
  });

  it('omits the parent key for a non-fork repo', async () => {
    mockGhSuccess({ url: 'https://github.com/o/r', parent: {} });
    expect(await fetchAttributionRepoKeys(tmp.repo())).toEqual({
      resolved: 'github.com/o/r',
    });
  });

  it('returns no keys outside a git repository without spawning gh', async () => {
    expect(await fetchAttributionRepoKeys(tmp.dir)).toEqual({});
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('fails closed when gh cannot answer', async () => {
    // An unresolvable pre-run identity must decline attribution, not read
    // as "any repo may bind".
    const dir = tmp.repo();
    mockExecError('network timeout', {
      killed: true,
      code: null,
      signal: 'SIGTERM',
    });
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});

    mockStdout('not json');
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});
  });
});
