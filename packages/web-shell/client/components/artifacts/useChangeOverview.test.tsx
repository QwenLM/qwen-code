// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangeOverview } from './useChangeOverview';

const mock = vi.hoisted(() => ({
  workspaceByCwd: vi.fn(),
  sessionStatus: vi.fn(),
  features: ['workspace_github_pr_files'] as string[],
}));
const client = {
  workspaceByCwd: mock.workspaceByCwd,
  sessionStatus: mock.sessionStatus,
};
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client, capabilities: { features: mock.features } }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let output: ReturnType<typeof useChangeOverview>;

function Host({ cwd = '/work', session }: { cwd?: string; session?: string }) {
  output = useChangeOverview(cwd, session);
  return null;
}

const gitDiff = {
  v: 1,
  workspaceCwd: '/work',
  available: true,
  files: [{ path: 'pending.ts', added: 2, removed: 0 }],
  filesCount: 1,
  linesAdded: 2,
  linesRemoved: 0,
  hiddenCount: 0,
};

function prFiles(number: number) {
  return {
    v: 1,
    workspaceCwd: '/work',
    available: true,
    files: [{ path: `pr${number}.ts`, additions: 5, deletions: 1 }],
    hiddenCount: 0,
    additions: 5,
    deletions: 1,
    headSha: `head${number}`,
    headIsAncestor: true,
  };
}

beforeEach(() => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mock.features = ['workspace_github_pr_files'];
  mock.sessionStatus.mockReset().mockResolvedValue({
    prs: [
      { number: 1, url: 'https://github.com/o/r/pull/1' },
      { number: 2, url: 'https://github.com/o/r/pull/2' },
    ],
    branch: { name: 'feat', baseBranch: 'origin/main' },
    worktree: { path: '/work/wt' },
  });
  mock.workspaceByCwd.mockReturnValue({
    workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
    workspaceGitHubPullRequestFiles: vi
      .fn()
      .mockImplementation((number: number) => Promise.resolve(prFiles(number))),
    workspaceGitLog: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/work',
      available: true,
      entries: [
        { sha: 'c9', shortSha: 'c9', subject: 'loose', parents: ['head2'] },
      ],
      hasMore: false,
    }),
    workspaceGitCommitDetail: vi.fn().mockResolvedValue({
      v: 1,
      workspaceCwd: '/work',
      available: true,
      files: [{ path: 'loose.ts', added: 1, removed: 0, isBinary: false }],
      filesCount: 1,
      linesAdded: 1,
      linesRemoved: 0,
    }),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.clearAllMocks();
});

async function renderAndSettle() {
  await act(async () => root.render(<Host session="s1" />));
  await vi.waitFor(() => expect(output.loading).toBe(false));
}

describe('useChangeOverview', () => {
  it('assembles uncommitted, PR, and commit-fallback units', async () => {
    await renderAndSettle();
    expect(output.gitAvailable).toBe(true);
    expect(output.units.map((unit) => unit.id)).toEqual([
      'uncommitted',
      'pr:1',
      'pr:2',
      'commit:c9',
    ]);
    const pr2 = output.units.find((unit) => unit.id === 'pr:2');
    expect(pr2).toMatchObject({ kind: 'pr', state: 'ready', additions: 5 });
    expect(output.commitsTruncated).toBe(false);
  });

  it('uses the session worktree cwd for git queries', async () => {
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitDiff).toHaveBeenCalledWith('/work/wt', 's1');
  });

  it('scopes the commit fallback to the latest bound PR head', async () => {
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'head2..HEAD',
      { sessionId: 's1' },
    );
  });

  it('marks a PR unit unavailable when its file fetch fails', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          number === 2
            ? Promise.reject(new Error('404'))
            : Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValue({ entries: [], hasMore: false }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    const pr2 = output.units.find((unit) => unit.id === 'pr:2');
    expect(pr2).toMatchObject({ kind: 'pr', state: 'unavailable' });
    // PR 2 resolved no head, so its commits could sit inside any window the
    // older PR's head defines; suppress the fallback rather than re-list that
    // already-delivered work as loose commits.
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).not.toContain('commit');
  });

  it('reports gitAvailable:false for a non-git workspace', async () => {
    const ws = {
      workspaceGitDiff: vi
        .fn()
        .mockResolvedValue({ ...gitDiff, available: false, files: [] }),
      workspaceGitHubPullRequestFiles: vi.fn(),
      workspaceGitLog: vi.fn(),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(output.gitAvailable).toBe(false);
    expect(output.units).toEqual([]);
    expect(ws.workspaceGitHubPullRequestFiles).not.toHaveBeenCalled();
  });

  it('skips PR fetching when the capability is absent', async () => {
    mock.features = [];
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitHubPullRequestFiles).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).not.toContain('pr');
  });

  it('counts hidden PR files toward the PR scope file count', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve({ ...prFiles(number), hiddenCount: 65 }),
        ),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValue({ entries: [], hasMore: false }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    const pr1 = output.units.find((unit) => unit.id === 'pr:1');
    expect(pr1).toMatchObject({ filesCount: 66, hiddenCount: 65 });
  });

  it('resolves each bound PR in its own repository', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [
        { number: 1, url: 'https://github.com/o/r/pull/1' },
        { number: 2, url: 'https://github.com/o/other/pull/2' },
      ],
      branch: { name: 'feat', baseBranch: 'origin/main' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitHubPullRequestFiles).toHaveBeenCalledWith(
      1,
      '/work/wt',
      's1',
      'github.com/o/r',
    );
    expect(ws.workspaceGitHubPullRequestFiles).toHaveBeenCalledWith(
      2,
      '/work/wt',
      's1',
      'github.com/o/other',
    );
  });

  it('reports a retryable loadFailed when the git diff fetch throws', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockRejectedValue(new Error('timeout')),
      workspaceGitHubPullRequestFiles: vi.fn(),
      workspaceGitLog: vi.fn(),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(output.loadFailed).toBe(true);
    expect(output.gitAvailable).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('suppresses the commit fallback when bound PRs resolve no head', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockRejectedValue(new Error('gh missing')),
      workspaceGitLog: vi.fn(),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).not.toContain('commit');
  });

  it('refetches when refresh is called', async () => {
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitDiff).toHaveBeenCalledTimes(1);
    await act(async () => {
      output.refresh();
    });
    await vi.waitFor(() =>
      expect(ws.workspaceGitDiff).toHaveBeenCalledTimes(2),
    );
  });

  it('reports loadFailed when the session summary fetch rejects', async () => {
    mock.sessionStatus.mockRejectedValue(new Error('daemon busy'));
    await renderAndSettle();
    expect(output.loadFailed).toBe(true);
    expect(output.gitAvailable).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('carries the daemon failure cause into an unavailable PR unit', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi.fn().mockRejectedValue({
        status: 502,
        body: { code: 'github_cli_unavailable' },
      }),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValue({ entries: [], hasMore: false }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    const pr1 = output.units.find((unit) => unit.id === 'pr:1');
    expect(pr1).toMatchObject({
      kind: 'pr',
      state: 'unavailable',
      unavailableCause: 'cli',
    });
  });

  it('marks binary uncommitted rows so the panel can render a marker', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue({
        ...gitDiff,
        files: [{ path: 'logo.png', added: 0, removed: 0, isBinary: true }],
      }),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockRejectedValue(new Error('n/a')),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValue({ entries: [], hasMore: false }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    const uncommitted = output.units.find(
      (unit) => unit.kind === 'uncommitted',
    );
    expect(uncommitted!.files[0]).toMatchObject({
      path: 'logo.png',
      isBinary: true,
    });
  });

  it('excludes review-provenance bindings but keeps create/legacy ones', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [
        { number: 1, url: 'https://github.com/o/r/pull/1', source: 'create' },
        { number: 2, url: 'https://github.com/o/r/pull/2', source: 'review' },
        { number: 3, url: 'https://github.com/o/r/pull/3' },
      ],
      branch: { name: 'feat', baseBranch: 'origin/main' },
    });
    await renderAndSettle();
    const prIds = output.units
      .filter((unit) => unit.kind === 'pr')
      .map((unit) => unit.id);
    expect(prIds).toEqual(['pr:1', 'pr:3']);
  });

  it('still shows the commit fallback when the files capability is absent', async () => {
    // Bound PRs come from the session sidecar, which is not gated by the files
    // capability; with no PR unit produced there is no head to duplicate, so
    // the loose commits must not be suppressed. With a base branch known the
    // back-compat degradation still issues the base-branch window.
    mock.features = [];
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitHubPullRequestFiles).not.toHaveBeenCalled();
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
    expect(output.units.map((unit) => unit.kind)).toContain('commit');
  });

  it('suppresses the unscoped walk when bound PRs exist without the files capability', async () => {
    // prResults stays empty without the capability even though the session
    // has bindings; keying the suppression on prResults would walk HEAD
    // unscoped and re-list the bindings' commits as this session's loose
    // work. The discriminator must be the bindings themselves.
    mock.features = [];
    mock.sessionStatus.mockResolvedValue({
      prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
      branch: { name: 'feat' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitHubPullRequestFiles).not.toHaveBeenCalled();
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).toEqual(['uncommitted']);
    expect(output.loadFailed).toBe(false);
  });

  it('surfaces commit-window truncation from log.hasMore', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      sha: `c${i}`,
      shortSha: `c${i}`,
      subject: `loose ${i}`,
      parents: ['head2'],
    }));
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        workspaceCwd: '/work',
        available: true,
        entries,
        hasMore: true,
      }),
      workspaceGitCommitDetail: vi.fn().mockResolvedValue({
        v: 1,
        workspaceCwd: '/work',
        available: true,
        files: [{ path: 'loose.ts', added: 1, removed: 0, isBinary: false }],
        filesCount: 1,
        linesAdded: 1,
        linesRemoved: 0,
      }),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(output.commitsTruncated).toBe(true);
  });

  it('maps the uncommitted unit as a whole, including a capped hiddenCount', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue({
        ...gitDiff,
        files: [{ path: 'a.ts', added: 7, removed: 3, isBinary: false }],
        filesCount: 60,
        linesAdded: 70,
        linesRemoved: 30,
        hiddenCount: 59,
      }),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockRejectedValue(new Error('n/a')),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValue({ entries: [], hasMore: false }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    const uncommitted = output.units.find(
      (unit) => unit.kind === 'uncommitted',
    );
    expect(uncommitted).toEqual({
      kind: 'uncommitted',
      id: 'uncommitted',
      files: [{ path: 'a.ts', additions: 7, deletions: 3, isBinary: false }],
      additions: 70,
      deletions: 30,
      filesCount: 60,
      hiddenCount: 59,
    });
  });

  it('skips the commit fallback for a base branch outside the range whitelist', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      branch: { name: 'feat', baseBranch: 'feat@2026' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    // The null sentinel must skip the fetch: an omitted range would run an
    // unscoped git log and re-list pre-session history as this session's work.
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).toEqual(['uncommitted']);
    expect(output.loadFailed).toBe(false);
  });

  it('still walks HEAD recent history when no baseline is known', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      branch: { name: 'feat' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      undefined,
      { sessionId: 's1' },
    );
  });

  it('surfaces a retryable failure when the commit log is unavailable', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        available: false,
        entries: [],
        hasMore: false,
      }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(output.loadFailed).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('surfaces a retryable failure when a commit detail fetch fails', async () => {
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        available: true,
        entries: [
          { sha: 'c9', shortSha: 'c9', subject: 'loose', parents: ['head2'] },
        ],
        hasMore: false,
      }),
      workspaceGitCommitDetail: vi
        .fn()
        .mockRejectedValue(new Error('detail down')),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(output.loadFailed).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('skips the session summary and uses the workspace cwd when session-less', async () => {
    await act(async () => root.render(<Host />));
    await vi.waitFor(() => expect(output.loading).toBe(false));
    expect(mock.sessionStatus).not.toHaveBeenCalled();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitDiff).toHaveBeenCalledWith('/work', undefined);
  });

  it('retries with the base-branch window when a PR head range is unavailable', async () => {
    // A cross-repo (or never-fetched) PR head makes <head>..HEAD unavailable;
    // the loose commits must still surface via the base-branch window.
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValueOnce({
          v: 1,
          available: false,
          entries: [],
          hasMore: false,
        })
        .mockResolvedValueOnce({
          v: 1,
          available: true,
          entries: [
            { sha: 'c9', shortSha: 'c9', subject: 'loose', parents: ['head2'] },
          ],
          hasMore: false,
        }),
      workspaceGitCommitDetail: vi.fn().mockResolvedValue({
        v: 1,
        available: true,
        files: [{ path: 'loose.ts', added: 1, removed: 0, isBinary: false }],
        filesCount: 1,
        linesAdded: 1,
        linesRemoved: 0,
      }),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(2);
    expect(ws.workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
    expect(output.units.map((unit) => unit.id)).toContain('commit:c9');
    expect(output.loadFailed).toBe(false);
  });

  it('does not scope the fallback to a head that is not an ancestor of HEAD', async () => {
    // A merged or rewritten PR's head still resolves locally but is not an
    // ancestor; <head>..HEAD would re-list the base branch's history as this
    // session's loose work. The base-branch window must be used instead.
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve({ ...prFiles(number), headIsAncestor: false }),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        available: true,
        entries: [],
        hasMore: false,
      }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(1);
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
    expect(output.loadFailed).toBe(false);
  });

  it('uses the base window when the latest bound PR head is not an ancestor', async () => {
    // The newest PR was squash-merged (its head is not an ancestor) while an
    // older bound PR's head is. Skipping to the older ancestor head would
    // compose <older>..HEAD, straddling the main history that absorbed the
    // merged PR — re-listing main-only commits and the squash commit as loose
    // work. The base-branch window is the trustworthy boundary instead.
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve({
            ...prFiles(number),
            headIsAncestor: number === 1,
          }),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        available: true,
        entries: [],
        hasMore: false,
      }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(1);
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
  });

  it('uses the base window when an older bound PR head is not an ancestor', async () => {
    // Mirror: even with the latest head an ancestor, a merged older PR means
    // the base history absorbed work the latest head's window could straddle
    // once main is merged into the session branch; refuse the head boundary.
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve({
            ...prFiles(number),
            headIsAncestor: number === 2,
          }),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        available: true,
        entries: [],
        hasMore: false,
      }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(1);
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
  });

  it('suppresses the fallback when a merged PR leaves no baseline', async () => {
    // Same merged-PR shape with no base branch: no trustworthy boundary, so
    // skip the fetch rather than walk HEAD unscoped.
    mock.sessionStatus.mockResolvedValue({
      prs: [
        { number: 1, url: 'https://github.com/o/r/pull/1' },
        { number: 2, url: 'https://github.com/o/r/pull/2' },
      ],
      branch: { name: 'feat' },
      worktree: { path: '/work/wt' },
    });
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve({
            ...prFiles(number),
            headIsAncestor: number === 1,
          }),
        ),
      workspaceGitLog: vi.fn(),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).not.toContain('commit');
    expect(output.loadFailed).toBe(false);
  });

  it('suppresses the fallback when no head is an ancestor and no baseline is known', async () => {
    // With bound PRs but neither an ancestor head nor a base branch, an
    // omitted range would walk HEAD unscoped and re-list PR-covered commits;
    // there is no trustworthy boundary, so skip the fetch entirely.
    mock.sessionStatus.mockResolvedValue({
      prs: [
        { number: 1, url: 'https://github.com/o/r/pull/1' },
        { number: 2, url: 'https://github.com/o/r/pull/2' },
      ],
      branch: { name: 'feat' },
      worktree: { path: '/work/wt' },
    });
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve({ ...prFiles(number), headIsAncestor: false }),
        ),
      workspaceGitLog: vi.fn(),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).not.toContain('commit');
    expect(output.loadFailed).toBe(false);
  });

  it('does not retry range-less when no base branch is known', async () => {
    // The undefined "no baseline" sentinel must not pass the retry guard: a
    // range-less retry would walk HEAD unscoped and render PR-covered commits
    // as loose work. The unavailable verdict stands as a retryable failure.
    mock.sessionStatus.mockResolvedValue({
      prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
      branch: { name: 'feat' },
      worktree: { path: '/work/wt' },
    });
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi.fn().mockResolvedValue({
        v: 1,
        available: false,
        entries: [],
        hasMore: false,
      }),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(1);
    expect(output.loadFailed).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('surfaces a retryable failure when the commit log fetch throws', async () => {
    // A thrown fetch is not "no loose commits": a session that made 20
    // commits must not report none just because /git/log returned a 504.
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi.fn().mockRejectedValue(new Error('504')),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(output.loadFailed).toBe(true);
    expect(output.gitAvailable).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('keeps the unavailable verdict when the retry fetch throws', async () => {
    // A rejected retry must not erase the first response's available:false
    // into a silent "no loose commits".
    const ws = {
      workspaceGitDiff: vi.fn().mockResolvedValue(gitDiff),
      workspaceGitHubPullRequestFiles: vi
        .fn()
        .mockImplementation((number: number) =>
          Promise.resolve(prFiles(number)),
        ),
      workspaceGitLog: vi
        .fn()
        .mockResolvedValueOnce({
          v: 1,
          available: false,
          entries: [],
          hasMore: false,
        })
        .mockRejectedValueOnce(new Error('504')),
      workspaceGitCommitDetail: vi.fn(),
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(2);
    expect(output.loadFailed).toBe(true);
    expect(output.units).toEqual([]);
  });
});
