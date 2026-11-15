// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangeOverview } from './useChangeOverview';

const mock = vi.hoisted(() => ({
  workspaceByCwd: vi.fn(),
  sessionStatus: vi.fn(),
  features: ['workspace_github_prs'] as string[],
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

function Host({
  cwd = '/work',
  session = 's1',
}: {
  cwd?: string;
  session?: string;
}) {
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
    baseRefName: 'main',
  };
}

beforeEach(() => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mock.features = ['workspace_github_prs'];
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
  await act(async () => root.render(<Host />));
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
    // The latest resolvable head (PR 1) still scopes the fallback.
    expect(ws.workspaceGitLog).toHaveBeenCalledWith(
      20,
      0,
      '/work/wt',
      'head1..HEAD',
      { sessionId: 's1' },
    );
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
});
