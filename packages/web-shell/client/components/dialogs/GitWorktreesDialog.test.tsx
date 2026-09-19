// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const {
  workspaceGitWorktrees,
  workspaceGitWorktreeStatus,
  workspaceGitRemoveWorktree,
  listWorkspaceSessions,
  workspaceClient,
  workspaceByCwdCalls,
} = vi.hoisted(() => {
  const workspaceGitWorktrees = vi.fn();
  const workspaceGitWorktreeStatus = vi.fn();
  const workspaceGitRemoveWorktree = vi.fn();
  const listWorkspaceSessions = vi.fn();
  const workspaceByCwdCalls: string[] = [];
  const workspaceClient = {
    workspaceByCwd: (cwd: string) => (
      workspaceByCwdCalls.push(cwd),
      {
        workspaceGitWorktrees,
        workspaceGitWorktreeStatus,
        workspaceGitRemoveWorktree,
        listWorkspaceSessions,
      }
    ),
  };
  return {
    workspaceByCwdCalls,
    workspaceGitWorktrees,
    workspaceGitWorktreeStatus,
    workspaceGitRemoveWorktree,
    listWorkspaceSessions,
    workspaceClient,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { GitWorktreesContent } = await import('./GitWorktreesDialog');

let container: HTMLDivElement;
let root: Root;

function mount(
  props: {
    onOpenSession?: (sessionId: string) => void;
    onNewWorktreeSession?: () => void;
  } = {},
) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <GitWorktreesContent workspaceCwd="/repo" {...props} />
      </I18nProvider>,
    );
  });
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
  if (!match) throw new Error(`no button "${label}"`);
  return match;
}

function rejection(body: Record<string, unknown>): Error {
  return Object.assign(new Error('request failed'), { body });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  workspaceByCwdCalls.length = 0;
  vi.resetAllMocks();
});

const MAIN = {
  path: '/repo',
  head: 'a'.repeat(40),
  branch: 'main',
  detached: false,
  bare: false,
  isMain: true,
  isWorkspace: true,
};
const FEATURE = {
  path: '/repo/.qwen/worktrees/swift-fox',
  head: 'b'.repeat(40),
  branch: 'qwen/swift-fox',
  detached: false,
  bare: false,
  isMain: false,
  isWorkspace: false,
  slug: 'swift-fox',
};
const STALE = {
  path: '/tmp/vanished',
  head: 'c'.repeat(40),
  branch: null,
  detached: true,
  bare: false,
  prunable: 'gitdir file points to non-existent location',
  isMain: false,
  isWorkspace: false,
};

function listPayload(worktrees: unknown[], available = true) {
  return { v: 1 as const, workspaceCwd: '/repo', available, worktrees };
}

function status(path: string, overrides: Record<string, unknown> = {}) {
  return {
    v: 1 as const,
    path,
    available: true,
    branch: 'x',
    detached: false,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

describe('GitWorktreesContent', () => {
  it('lists worktrees with badges, lazy status, and their sessions', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, FEATURE, STALE]),
    );
    listWorkspaceSessions.mockResolvedValue([
      {
        sessionId: 's1',
        workspaceCwd: '/repo',
        displayName: 'Refactor parser',
        clientCount: 1,
        hasActivePrompt: false,
        worktree: { slug: 'swift-fox', path: FEATURE.path, branch: 'x' },
      },
      {
        sessionId: 's2',
        workspaceCwd: '/repo',
        displayName: 'Plain session',
        clientCount: 0,
        hasActivePrompt: false,
      },
    ]);
    workspaceGitWorktreeStatus.mockImplementation((path: string) =>
      Promise.resolve(
        status(
          path,
          path === FEATURE.path ? { unstaged: 2, untracked: 1 } : {},
        ),
      ),
    );
    const onOpenSession = vi.fn();
    mount({ onOpenSession });
    await flush();
    await flush();

    const rows = document.body.querySelectorAll(
      '[data-testid="git-worktree-row"]',
    );
    expect(rows).toHaveLength(3);
    const text = document.body.textContent ?? '';
    expect(text).toContain('main');
    expect(text).toContain('this workspace');
    expect(text).toContain('swift-fox');
    expect(text).toContain('qwen/swift-fox');
    expect(text).toContain('stale');
    expect(text).toContain('detached HEAD');
    // Status is fetched for live directories only, never for the stale one.
    expect(workspaceGitWorktreeStatus).toHaveBeenCalledTimes(2);
    expect(workspaceGitWorktreeStatus).not.toHaveBeenCalledWith(STALE.path);
    expect(rows[0].textContent).toContain('clean');
    expect(rows[1].textContent).toContain('3 change(s)');
    // A stale row has no state of its own, so it shows none — not a spinner
    // that never resolves, since nothing will ever fetch it.
    expect(
      rows[0].querySelector('[data-testid="worktree-status"]'),
    ).not.toBeNull();
    expect(rows[2].querySelector('[data-testid="worktree-status"]')).toBeNull();
    // Sessions attach to their worktree and open on click.
    expect(rows[1].textContent).toContain('Refactor parser');
    expect(text).not.toContain('Plain session');
    await act(async () => {
      button('Refactor parser').click();
    });
    expect(onOpenSession).toHaveBeenCalledWith('s1');
  });

  it('asks the daemon about the workspace it was given', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: FEATURE.path,
    });
    mount();
    await flush();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // List, status and remove all have to be scoped to the prop; a component
    // that reached a default workspace would look identical here otherwise.
    expect(workspaceByCwdCalls.length).toBeGreaterThan(2);
    expect(new Set(workspaceByCwdCalls)).toEqual(new Set(['/repo']));
  });

  it('offers removal for a linked worktree that is not the current one', async () => {
    // `isMain` is the sole protection here: an entry that is neither the
    // workspace nor bare must still be removable, or the guard could be
    // widened to anything and stay green.
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([
        { ...MAIN, isWorkspace: false },
        { ...FEATURE, isWorkspace: false },
      ]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();

    const labels = Array.from(
      document.body.querySelectorAll('button[aria-label^="Remove worktree"]'),
    ).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Remove worktree swift-fox']);
  });

  it('shows a status error when the lazy probe rejects', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockRejectedValue(new Error('git exploded'));
    mount();
    await flush();
    await flush();

    // The probe is per row and allowed to fail on its own; the row says so
    // rather than spinning for ever.
    const rows = document.body.querySelectorAll(
      '[data-testid="git-worktree-row"]',
    );
    expect(rows[1].textContent).toContain('status unavailable');
  });

  it('never offers removal for the main worktree or the current workspace', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, { ...FEATURE, isWorkspace: true }, STALE]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();
    const removeButtons = Array.from(
      document.body.querySelectorAll('button[aria-label^="Remove worktree"]'),
    );
    expect(removeButtons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Remove worktree vanished',
    ]);
  });

  it('tells the truth about a stale entry: no files are deleted', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, STALE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree vanished').click();
    });

    expect(document.body.textContent).toContain(
      'Git stops tracking worktrees it can no longer find; no files are deleted.',
    );
    expect(document.body.textContent).not.toContain(
      'Its directory is deleted from disk',
    );
  });

  it('confirms before removing, then refreshes the list', async () => {
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]))
      .mockResolvedValueOnce(listPayload([MAIN]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: FEATURE.path,
    });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    expect(workspaceGitRemoveWorktree).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Remove this worktree?');

    await act(async () => {
      button('Cancel').click();
    });
    expect(document.body.textContent).not.toContain('Remove this worktree?');

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    expect(workspaceGitRemoveWorktree).toHaveBeenCalledWith(FEATURE.path, {
      force: false,
    });
    expect(workspaceGitWorktrees).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('swift-fox');
    // git deleted the directory, so there is nothing left to warn about.
    expect(
      document.body.querySelector('[data-testid="worktree-notice"]'),
    ).toBeNull();
  });

  it('says so when the directory outlives the removal', async () => {
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]))
      .mockResolvedValueOnce(listPayload([MAIN]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: FEATURE.path,
      directoryRemains: true,
    });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // The confirmation promised the directory would go and git kept it, so
    // the row vanishing on its own would be the misleading part. The message
    // outlives that row, which is why it is not rendered inside it.
    const notice = document.body.querySelector(
      '[data-testid="worktree-notice"]',
    );
    expect(notice?.textContent).toBe(
      'Git no longer tracks swift-fox, but its directory is still on disk.',
    );
    // The row disappearing is silent; this message is what a screen reader
    // has to announce in its place.
    expect(notice?.getAttribute('role')).toBe('status');
    expect(
      document.body.querySelectorAll('[data-testid="git-worktree-row"]'),
    ).toHaveLength(1);
  });

  it('drops the kept-directory notice when the next removal is clean', async () => {
    const other = {
      ...FEATURE,
      path: '/repo/.qwen/worktrees/bold-owl',
      slug: 'bold-owl',
    };
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE, other]))
      .mockResolvedValueOnce(listPayload([MAIN, other]))
      .mockResolvedValueOnce(listPayload([MAIN]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockResolvedValueOnce({
        removed: true,
        path: FEATURE.path,
        directoryRemains: true,
      })
      .mockResolvedValueOnce({ removed: true, path: other.path });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();
    expect(document.body.textContent).toContain('still on disk');

    await act(async () => {
      button('Remove worktree bold-owl').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // git deleted this one, so the standing message is about neither the
    // worktree on screen nor the one just removed.
    expect(
      document.body.querySelector('[data-testid="worktree-notice"]'),
    ).toBeNull();
  });

  it('never overwrites a fresh status with a slow probe from before', async () => {
    const other = {
      ...FEATURE,
      path: '/repo/.qwen/worktrees/bold-owl',
      slug: 'bold-owl',
    };
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([FEATURE, other]))
      .mockResolvedValueOnce(listPayload([FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    let releaseStale: (() => void) | undefined;
    let featureProbes = 0;
    workspaceGitWorktreeStatus.mockImplementation((probed: string) => {
      if (probed !== FEATURE.path) return Promise.resolve(status(probed));
      featureProbes += 1;
      // The tab's first read of this worktree never lands until the test
      // lets it, and by then the refresh has already answered.
      if (featureProbes === 1) {
        return new Promise((resolve) => {
          releaseStale = () => resolve(status(probed));
        });
      }
      return Promise.resolve(status(probed, { unstaged: 5 }));
    });
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: other.path,
    });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree bold-owl').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();
    await flush();
    expect(document.body.textContent).toContain('5 change(s)');

    await act(async () => {
      releaseStale?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The reply to a question this tab stopped asking says "clean" about a
    // worktree that is not, and it arrives last. It is dropped, not applied.
    expect(featureProbes).toBe(2);
    expect(document.body.textContent).toContain('5 change(s)');
    expect(document.body.textContent).not.toContain('clean');
  });

  it('asks for no state, and shows none, for a bare repository', async () => {
    const bare = { ...MAIN, bare: true, branch: null, head: '' };
    workspaceGitWorktrees.mockResolvedValue(listPayload([bare, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status(FEATURE.path));
    mount();
    await flush();
    await flush();

    const rows = document.body.querySelectorAll(
      '[data-testid="git-worktree-row"]',
    );
    // A bare repository has no working tree at all, so a status cell there
    // could only ever be a spinner nothing will resolve.
    expect(rows[0].textContent).toContain('bare');
    expect(rows[0].querySelector('[data-testid="worktree-status"]')).toBeNull();
    expect(workspaceGitWorktreeStatus).not.toHaveBeenCalledWith(bare.path);
    expect(
      rows[1].querySelector('[data-testid="worktree-status"]'),
    ).not.toBeNull();
  });

  it('shows a lock git recorded without a reason', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, { ...FEATURE, locked: '' }]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();

    // git writes a bare `locked` line when no reason was given, so the
    // reason is the empty string and presence is the whole signal.
    const rows = document.body.querySelectorAll(
      '[data-testid="git-worktree-row"]',
    );
    expect(rows[1].textContent).toContain('locked');
  });

  it('reports a listing that never arrived', async () => {
    workspaceGitWorktrees.mockRejectedValue(new Error('daemon unreachable'));
    listWorkspaceSessions.mockResolvedValue([]);
    mount();
    await flush();

    expect(document.body.textContent).toContain('Failed to load worktrees');
  });

  it('re-reads working-tree state on a refresh instead of reusing it', async () => {
    const other = {
      ...FEATURE,
      path: '/repo/.qwen/worktrees/bold-owl',
      slug: 'bold-owl',
    };
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE, other]))
      .mockResolvedValueOnce(listPayload([MAIN, other]));
    listWorkspaceSessions.mockResolvedValue([]);
    // `bold-owl` is clean when the tab opens and dirty by the time the
    // removal of its sibling refreshes the list.
    workspaceGitWorktreeStatus.mockImplementation((path: string) =>
      Promise.resolve(status(path)),
    );
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: FEATURE.path,
    });
    mount();
    await flush();
    await flush();
    expect(document.body.textContent).toContain('clean');
    const firstPass = workspaceGitWorktreeStatus.mock.calls.length;

    workspaceGitWorktreeStatus.mockImplementation((path: string) =>
      Promise.resolve(status(path, { unstaged: 2 })),
    );
    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();
    await flush();

    // The surviving worktree is asked again rather than kept from the first
    // pass, so its badge shows what it became.
    expect(workspaceGitWorktreeStatus.mock.calls.length).toBeGreaterThan(
      firstPass,
    );
    expect(workspaceGitWorktreeStatus).toHaveBeenLastCalledWith(other.path);
    expect(document.body.textContent).toContain('2 change(s)');
  });

  it('surfaces a dirty refusal and only forces after a second confirmation', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockRejectedValueOnce(
        rejection({ code: 'worktree_dirty', error: 'dirty', changes: 4 }),
      )
      .mockResolvedValueOnce({ removed: true, path: FEATURE.path });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    expect(document.body.textContent).toContain(
      '4 uncommitted change(s) would be discarded.',
    );
    await act(async () => {
      button('Remove anyway').click();
    });
    await flush();

    expect(workspaceGitRemoveWorktree).toHaveBeenNthCalledWith(
      1,
      FEATURE.path,
      { force: false },
    );
    expect(workspaceGitRemoveWorktree).toHaveBeenNthCalledWith(
      2,
      FEATURE.path,
      { force: true },
    );
  });

  it('names a lock and offers to remove past it', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, { ...FEATURE, locked: 'held by a build' }]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockRejectedValueOnce(
        rejection({
          code: 'worktree_locked',
          error: 'The worktree is locked',
          reason: 'held by a build',
        }),
      )
      .mockResolvedValueOnce({ removed: true, path: FEATURE.path });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    expect(document.body.textContent).toContain(
      'This worktree is locked: held by a build',
    );
    await act(async () => {
      button('Remove anyway').click();
    });
    await flush();

    expect(workspaceGitRemoveWorktree).toHaveBeenNthCalledWith(
      2,
      FEATURE.path,
      { force: true },
    );
  });

  it("repeats git's own refusal and still offers to force past it", async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockRejectedValueOnce(
        rejection({
          code: 'worktree_remove_refused',
          error: 'git refused to remove this worktree',
          detail:
            'fatal: working trees containing submodules cannot be moved or removed',
        }),
      )
      .mockResolvedValueOnce({ removed: true, path: FEATURE.path });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // git's sentence says more than any wording here could, and the button
    // beside it is the override git's own message names.
    expect(document.body.textContent).toContain(
      'working trees containing submodules cannot be moved or removed',
    );
    await act(async () => {
      button('Remove anyway').click();
    });
    await flush();

    expect(workspaceGitRemoveWorktree).toHaveBeenNthCalledWith(
      2,
      FEATURE.path,
      { force: true },
    );
  });

  it('names the uncommitted work a lock would otherwise hide', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, { ...FEATURE, locked: 'in review' }]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({
        code: 'worktree_locked',
        error: 'The worktree is locked',
        reason: 'in review',
        changes: 2,
      }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // The lock is what the daemon refused on, but the same click discards
    // the uncommitted work, and that is the part that does not come back.
    const text = document.body.textContent ?? '';
    expect(text).toContain('This worktree is locked: in review');
    expect(text).toContain('2 uncommitted change(s) would be discarded.');
  });

  it('still says something when a refusal arrives with no words', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    // git can die with nothing on either stream, which leaves the daemon no
    // sentence to forward.
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({
        code: 'worktree_remove_refused',
        error: 'git refused to remove this worktree',
      }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // Empty text beside a live "Remove anyway" button is the failure here.
    expect(document.body.textContent).toContain(
      'Git refused to remove this worktree.',
    );
    expect(button('Remove anyway')).toBeTruthy();
  });

  it('reports sessions, not changes, when a refusal carries both', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({
        code: 'worktree_in_use',
        error: 'Sessions are still running in this worktree',
        sessions: 2,
        changes: 5,
      }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // Both counts ride on this refusal, so picking one by field order puts
    // the change count where the session count belongs.
    const text = document.body.textContent ?? '';
    expect(text).toContain('2 running session(s) would lose their checkout.');
    expect(text).toContain('5 uncommitted change(s) would be discarded.');
  });

  it('says the uncommitted work could not be counted, beside the refusal', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({
        code: 'worktree_in_use',
        error: 'Sessions are still running in this worktree',
        sessions: 1,
        statusUnknown: true,
      }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // Not knowing what would be discarded is its own warning, and the same
    // click discards it either way.
    const text = document.body.textContent ?? '';
    expect(text).toContain('1 running session(s) would lose their checkout.');
    expect(text).toContain(
      'The working tree could not be checked for uncommitted changes, and any there would be discarded.',
    );
  });

  it('names each kind of loss the one confirmation would cause', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({
        code: 'worktree_in_use',
        error: 'Sessions are still running in this worktree',
        sessions: 1,
        changes: 2,
        operation: 'rebase',
        unmergedHead: 'abcdef1234567890',
      }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('1 running session(s) would lose their checkout.');
    expect(text).toContain('2 uncommitted change(s) would be discarded.');
    expect(text).toContain('An unfinished rebase would be lost.');
    expect(text).toContain('abcdef1');
  });

  it('describes a nested repository that a force would take too', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({
        code: 'worktree_in_use',
        error: 'Sessions are still running in this worktree',
        sessions: 3,
        submodules: true,
      }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('3 running session(s) would lose their checkout.');
    expect(text).toContain('keeps its own repository');
  });

  it('never repeats a refusal\u2019s own sentence in the list beside it', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();
    for (const [code, extra, sentence] of [
      [
        'worktree_operation_in_progress',
        { operation: 'rebase' },
        'An unfinished rebase would be lost.',
      ],
      [
        'worktree_unmerged_commits',
        { unmergedHead: 'abcdef1234567890' },
        'abcdef1',
      ],
    ] as const) {
      workspaceGitRemoveWorktree.mockRejectedValue(
        rejection({ code, error: 'refused', ...extra }),
      );
      await act(async () => {
        button('Remove worktree swift-fox').click();
      });
      await act(async () => {
        button('Remove').click();
      });
      await flush();

      const text = document.body.textContent ?? '';
      expect([code, text.split(sentence).length - 1]).toEqual([code, 1]);
      await act(async () => {
        button('Cancel').click();
      });
    }
  });

  it('moves the keyboard into the confirmation it replaced the button with', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });

    // The trash button is unmounted by the panel that replaces it, so
    // without this the keyboard lands back on the dialog container.
    const confirm = document.body.querySelector('[role="alert"]');
    expect(confirm?.contains(document.activeElement)).toBe(true);
  });

  it('offers no new worktree session where git is unavailable', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([], false));
    listWorkspaceSessions.mockResolvedValue([]);
    mount({ onNewWorktreeSession: vi.fn() });
    await flush();

    // The toolbar sits outside the placeholder, so the entry would otherwise
    // be offered beside "Git is not available for this workspace".
    expect(document.body.textContent).toContain('Git is not available');
    expect(() => button('New worktree session…')).toThrow();
  });

  it('never says the same thing twice about a dirty refusal', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({ code: 'worktree_dirty', error: 'dirty', changes: 4 }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    const sentence = '4 uncommitted change(s) would be discarded.';
    const text = document.body.textContent ?? '';
    expect(text.split(sentence).length - 1).toBe(1);
  });

  it('promises no branch for a worktree that has none', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([
        MAIN,
        { ...FEATURE, branch: null, detached: true, slug: undefined },
      ]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });

    const text = document.body.textContent ?? '';
    // What it must not do is promise a branch. Whether commits would be
    // lost is the daemon's answer, and it gives it on the click.
    expect(text).toContain('there is no branch to keep');
    expect(text).not.toContain('the branch is kept');
  });

  it('never lands one row\u2019s refusal on another row\u2019s confirmation', async () => {
    const other = {
      ...FEATURE,
      path: '/repo/.qwen/worktrees/bold-owl',
      slug: 'bold-owl',
    };
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, FEATURE, other]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    let failFeature: (() => void) | undefined;
    workspaceGitRemoveWorktree.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failFeature = () =>
            reject(
              rejection({ code: 'worktree_dirty', error: 'dirty', changes: 9 }),
            );
        }),
    );
    mount();
    await flush();

    // Start removing swift-fox, then open bold-owl's confirmation.
    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await act(async () => {
      button('Remove worktree bold-owl').click();
    });
    expect(document.body.textContent).toContain('Remove this worktree?');

    // swift-fox's own row must not re-arm while its request is outstanding,
    // or the same worktree can be removed twice over.
    expect(() => button('Remove worktree swift-fox')).toThrow();

    await act(async () => {
      failFeature?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The refusal belongs to swift-fox. bold-owl's confirmation is what the
    // user is looking at, and a "Remove anyway" here would force the wrong
    // worktree.
    const text = document.body.textContent ?? '';
    expect(text).toContain('Remove this worktree?');
    expect(text).not.toContain('9 uncommitted change(s) would be discarded.');
    // But it is still a destructive action that was declined, so it is said
    // somewhere rather than dropped.
    expect(text).toContain('was refused while you were looking elsewhere');
  });

  it('offers a way forward when the daemon could not read the state', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockRejectedValueOnce(
        rejection({ code: 'worktree_status_unknown', error: 'unreadable' }),
      )
      .mockResolvedValueOnce({ removed: true, path: FEATURE.path });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    expect(document.body.textContent).toContain(
      'The working tree could not be checked for uncommitted changes, and any there would be discarded.',
    );
    await act(async () => {
      button('Remove anyway').click();
    });
    await flush();
    expect(workspaceGitRemoveWorktree).toHaveBeenLastCalledWith(FEATURE.path, {
      force: true,
    });
  });

  it('explains a live-session refusal and shows other failures verbatim', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockRejectedValueOnce(
        rejection({ code: 'worktree_in_use', error: 'busy', sessions: 2 }),
      )
      // A classified git failure: the token lands in `error`, git's sentence
      // in `message`. The token is not something to show a person.
      .mockRejectedValueOnce(
        rejection({
          error: 'dirty_working_tree',
          message: 'fatal: locked worktree',
        }),
      );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();
    expect(document.body.textContent).toContain(
      '2 running session(s) would lose their checkout.',
    );

    await act(async () => {
      button('Remove anyway').click();
    });
    await flush();
    expect(document.body.textContent).toContain('fatal: locked worktree');
    expect(document.body.textContent).not.toContain('dirty_working_tree');
    expect(document.body.textContent).not.toContain('Remove anyway');
    // A refusal can still leave the repository changed, so both failures
    // re-read the list rather than leaving rows on screen that may be gone.
    expect(workspaceGitWorktrees).toHaveBeenCalledTimes(3);
  });

  it('filters by path, branch, or slug and offers a new worktree session', async () => {
    workspaceGitWorktrees.mockResolvedValue(
      listPayload([MAIN, FEATURE, STALE]),
    );
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    const onNewWorktreeSession = vi.fn();
    mount({ onNewWorktreeSession });
    await flush();

    const input = document.body.querySelector(
      'input[type="search"]',
    ) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'vanished');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      document.body.querySelectorAll('[data-testid="git-worktree-row"]'),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain('/tmp/vanished');

    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    // Branches are searchable too, not just paths and slugs.
    await type('qwen/swift');
    expect(
      document.body.querySelectorAll('[data-testid="git-worktree-row"]'),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain('swift-fox');

    await act(async () => {
      button('New worktree session…').click();
    });
    expect(onNewWorktreeSession).toHaveBeenCalledTimes(1);
  });

  it('never leaves a removed worktree on screen when its refresh fails', async () => {
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]))
      .mockRejectedValueOnce(new Error('daemon unreachable'));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: FEATURE.path,
    });
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // The removal succeeded, so there is no explanation left to protect —
    // and the rows would otherwise still offer a worktree git no longer has,
    // with nothing on screen saying the list is stale.
    expect(document.body.textContent).toContain('Failed to load worktrees');
    expect(document.body.textContent).not.toContain('swift-fox');
  });

  it('keeps the refusal on screen when the refresh that follows it fails', async () => {
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]))
      .mockRejectedValueOnce(new Error('listing unavailable'));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockRejectedValue(
      rejection({ error: 'fatal: cannot remove a locked working tree' }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();

    // The refresh a failed removal triggers can itself fail; the reason the
    // removal was refused is what the person is still reading.
    expect(document.body.textContent).toContain(
      'fatal: cannot remove a locked working tree',
    );
    expect(document.body.textContent).not.toContain('Failed to load worktrees');
  });

  it('drops the previous repository’s rows and notice on a workspace change', async () => {
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]))
      .mockResolvedValueOnce(listPayload([MAIN]))
      // The second workspace's listing never lands, which is the window the
      // reset is about.
      .mockReturnValueOnce(new Promise(() => {}));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree.mockResolvedValue({
      removed: true,
      path: FEATURE.path,
      directoryRemains: true,
    });
    mount();
    await flush();
    expect(document.body.textContent).toContain('swift-fox');

    // Leave a notice standing, so the reset below has something to clear.
    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="worktree-notice"]'),
    ).not.toBeNull();

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GitWorktreesContent workspaceCwd="/other" />
        </I18nProvider>,
      );
    });

    // Another workspace is another repository; its rows are not these, so
    // these go rather than linger under the new workspace.
    expect(document.body.textContent).not.toContain('swift-fox');
    expect(document.body.textContent).toContain('Loading worktrees');
    // The notice names a bare directory name, which means nothing in another
    // repository, and it outlives rows by design, so it needs its own reset.
    expect(
      document.body.querySelector('[data-testid="worktree-notice"]'),
    ).toBeNull();
  });

  it('never carries a removal in flight into another repository', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    let failIt: (() => void) | undefined;
    workspaceGitRemoveWorktree.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failIt = () =>
            reject(
              rejection({ code: 'worktree_dirty', error: 'dirty', changes: 7 }),
            );
        }),
    );
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    await act(async () => {
      button('Remove').click();
    });

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GitWorktreesContent workspaceCwd="/other" />
        </I18nProvider>,
      );
    });
    await flush();

    // Still in flight, and this is the new repository's row: holding its
    // trash button down for a request about the old one would leave it with
    // no button and nothing said.
    expect(button('Remove worktree swift-fox')).toBeTruthy();

    await act(async () => {
      failIt?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Another repository's row can sit at the same path, and the answer to a
    // removal in the previous one says nothing about it.
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('7 uncommitted change(s) would be discarded.');
    expect(text).not.toContain('was refused while you were looking elsewhere');
    // And its trash button is not held down by a request from before.
    expect(button('Remove worktree swift-fox')).toBeTruthy();
  });

  it('leaves a confirmation behind with the repository it was about', async () => {
    workspaceGitWorktrees
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]))
      // Another repository with a worktree checked out at the same path:
      // rows are matched to a pending removal by path, and two repositories
      // can spell one.
      .mockResolvedValueOnce(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    mount();
    await flush();

    await act(async () => {
      button('Remove worktree swift-fox').click();
    });
    expect(document.body.textContent).toContain('Remove this worktree?');

    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <GitWorktreesContent workspaceCwd="/other" />
        </I18nProvider>,
      );
    });
    await flush();

    // The user never answered this question about *this* repository.
    expect(document.body.textContent).not.toContain('Remove this worktree?');
  });

  it('shows the unavailable placeholder outside a git repository', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([], false));
    listWorkspaceSessions.mockResolvedValue([]);
    mount();
    await flush();
    expect(document.body.textContent).toContain('Git is not available');
    expect(workspaceGitWorktreeStatus).not.toHaveBeenCalled();
  });
});
