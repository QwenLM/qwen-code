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
  };
}

beforeEach(() => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mock.features = [
    'workspace_github_pr_files',
    'workspace_git_log_exclude_refs',
  ];
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

  it('scopes the commit fallback to the base branch when no start commit is recorded', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      branch: { name: 'feat', baseBranch: 'origin/main' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1', excludeRefs: ['origin/main'] },
    );
  });

  it('prefers the session start commit as the fallback boundary', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      branch: { name: 'feat', baseBranch: 'origin/main', baseCommit: 'base0' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'base0..HEAD',
      { sessionId: 's1', excludeRefs: ['origin/main'] },
    );
  });

  it('uses the worktree base commit as the fallback boundary', async () => {
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      worktree: { path: '/work/wt', baseCommit: 'wtbase' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'wtbase..HEAD',
      { sessionId: 's1' },
    );
  });

  it('uses a plain session top-level base commit as the fallback boundary', async () => {
    // A plain session has no branch/worktree meta; its start commit is the
    // HEAD captured at creation, projected top-level on the summary.
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      baseCommit: 'plainbase',
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work',
      'plainbase..HEAD',
      { sessionId: 's1' },
    );
  });

  it('prefers the session creation start over a later worktree creation tip (R6-1)', async () => {
    // A plain session recorded start S, then committed A,B (HEAD moved to T)
    // and handed off into a worktree whose creation tip is T. The session's
    // own start S must win over worktree.baseCommit T, or the pre-handoff
    // S..T commits vanish from the panel for as long as it lives in the
    // worktree. Two distinct values pin the precedence, not just presence.
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      baseCommit: 'sessionstartS',
      worktree: { path: '/work/wt', baseCommit: 'handofftipT' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'sessionstartS..HEAD',
      { sessionId: 's1' },
    );
  });

  it('excludes the worktree base branch so upstream integration is not re-listed', async () => {
    // A worktree session has no branch meta; its base branch is carried on
    // worktree.baseBranch. Integrating upstream advances HEAD past the start
    // commit, so the base branch must join the exclusion set or those upstream
    // commits re-list as loose work.
    mock.sessionStatus.mockResolvedValue({
      prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
      worktree: {
        path: '/work/wt',
        baseCommit: 'wtbase',
        baseBranch: 'origin/main',
      },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'wtbase..HEAD',
      { sessionId: 's1', excludeRefs: ['head1', 'origin/main'] },
    );
  });

  it('excludes the remote-tracking ref of a local base branch (integration advances origin/main, not main)', async () => {
    // The recorded baseBranch is the LOCAL name (main); integrating upstream
    // only advances a remote-tracking ref. The remote-tracking refs under both
    // documented remotes (origin for a standard clone, upstream for a fork)
    // join the exclusion set — but NOT the local name itself, which would
    // subtract the session's own commits once local main absorbs them (R4-1).
    mock.sessionStatus.mockResolvedValue({
      prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
      branch: { name: 'feat/x', baseBranch: 'main', baseCommit: 'base0' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work',
      'base0..HEAD',
      {
        sessionId: 's1',
        excludeRefs: ['head1', 'origin/main', 'upstream/main'],
      },
    );
  });

  it('excludes upstream/<base> so a fork integrating from upstream is narrowed', async () => {
    // Fork layout (CONTRIBUTING): origin is the personal fork, integration
    // comes from upstream/main. Excluding only origin/main would subtract the
    // fork's stale main, not the integrated upstream commits; upstream/main
    // must be in the exclusion set. The log route drops whichever remote ref
    // is absent locally, so the present one still narrows the window.
    mock.sessionStatus.mockResolvedValue({
      prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
      worktree: {
        slug: 'wt',
        path: '/work/wt',
        branch: 'feat',
        baseBranch: 'main',
        baseCommit: 'base0',
      },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'base0..HEAD',
      {
        sessionId: 's1',
        excludeRefs: ['head1', 'origin/main', 'upstream/main'],
      },
    );
  });

  it('never excludes the local base name, which absorbs the session commits (R4-1)', async () => {
    // Once local main absorbs the session's work (a local merge of the session
    // branch), `--not main` covers the session's own commits and empties the
    // window — the panel would report no committed work. Only the remote-
    // tracking refs (which lag the unpushed session commits) may be excluded.
    mock.sessionStatus.mockResolvedValue({
      prs: [{ number: 1, url: 'https://github.com/o/r/pull/1' }],
      branch: { name: 'feat/x', baseBranch: 'main', baseCommit: 'base0' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    const call = ws.workspaceGitLog.mock.calls.find(
      (c: unknown[]) => c[3] === 'base0..HEAD',
    );
    expect(call).toBeDefined();
    const excludeRefs = (call![4] as { excludeRefs?: string[] }).excludeRefs;
    expect(excludeRefs).not.toContain('main');
    expect(excludeRefs).toContain('origin/main');
  });

  it('excludes commits reachable from every bound PR head when supported', async () => {
    // Reachability exclusion (not a single-head boundary) drops each PR's own
    // commits, including for merged or incomparable heads.
    mock.features = [
      'workspace_github_pr_files',
      'workspace_git_log_exclude_refs',
    ];
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1', excludeRefs: ['head1', 'head2', 'origin/main'] },
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
    // Without the files capability the bindings render no PR units (the files
    // fetch is gated off, prResults stays empty). This mock also records no
    // boundary, so the fallback suppresses via the no-boundary rule — no
    // unscoped walk is issued. The bound-PR discriminator itself (files
    // present, exclude absent, a boundary recorded) is pinned separately by
    // the capability-skew test below; here we pin that the files fetch stays
    // gated and no range-less walk leaks when bindings exist without it.
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

  it('suppresses the fallback when no boundary is known (no unscoped walk)', async () => {
    // R7-1: a session with no start commit and no base branch must NOT walk
    // HEAD unscoped — that re-lists the repository's pre-session history as
    // this session's loose work. With no trustworthy boundary, suppress.
    mock.sessionStatus.mockResolvedValue({
      prs: [],
      branch: { name: 'feat' },
      worktree: { path: '/work/wt' },
    });
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).toEqual(['uncommitted']);
    expect(output.loadFailed).toBe(false);
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

  it('suppresses the fallback when a merged PR leaves no baseline', async () => {
    // Bound PRs but no start commit and no base branch: no trustworthy
    // boundary, so skip the fetch rather than walk HEAD unscoped and re-list
    // PR-covered or pre-session commits as loose work.
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
          Promise.resolve(prFiles(number)),
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

  it('surfaces a retryable failure when the boundary log stays unavailable after the no-exclusion retry', async () => {
    // An unavailable log (e.g. the start commit itself is not in the object
    // database) is a retryable failure, not an empty session. The hook retries
    // once without excludeRefs; when that is unavailable too it surfaces the
    // failure rather than walking HEAD unscoped.
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
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(2);
    expect(ws.workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
    expect(output.loadFailed).toBe(true);
    expect(output.units).toEqual([]);
  });

  it('degrades to the no-exclusion window when the excluded log is unavailable', async () => {
    // The hook's degraded path: when the excluded log comes back unavailable
    // (an unsafe excluded ref fails closed, or the start commit itself is
    // absent from the object database), retry the same boundary window without
    // excludeRefs so the loose commits render instead of blanking every unit.
    // A merely missing bound PR head no longer reaches here as unavailable —
    // the log route's presence probe drops absent refs and keeps the present
    // exclusions (pinned in the core gitDiff suite). This PR's commits may
    // duplicate in the degraded window — the accepted residual.
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
    };
    mock.workspaceByCwd.mockReturnValue(ws);
    await renderAndSettle();
    expect(ws.workspaceGitLog).toHaveBeenCalledTimes(2);
    expect(ws.workspaceGitLog).toHaveBeenNthCalledWith(
      1,
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1', excludeRefs: ['head1', 'head2', 'origin/main'] },
    );
    expect(ws.workspaceGitLog).toHaveBeenNthCalledWith(
      2,
      20,
      0,
      '/work/wt',
      'origin/main..HEAD',
      { sessionId: 's1' },
    );
    expect(output.loadFailed).toBe(false);
    expect(output.units.map((unit) => unit.id)).toContain('commit:c9');
    expect(output.units.map((unit) => unit.id)).toContain('uncommitted');
  });

  it('suppresses the fallback when bound PR heads cannot be excluded (capability skew)', async () => {
    // A new client against an older daemon: the files capability is present
    // (PR units render with resolved heads) but the exclude capability is
    // absent. An unfiltered window would re-list those PRs' own commits as
    // loose work, so suppress the fallback rather than duplicate them.
    mock.features = ['workspace_github_pr_files'];
    await renderAndSettle();
    const ws = mock.workspaceByCwd.mock.results[0]!.value;
    expect(ws.workspaceGitHubPullRequestFiles).toHaveBeenCalled();
    expect(ws.workspaceGitLog).not.toHaveBeenCalled();
    expect(output.units.map((unit) => unit.kind)).toEqual([
      'uncommitted',
      'pr',
      'pr',
    ]);
    expect(output.loadFailed).toBe(false);
  });
});
