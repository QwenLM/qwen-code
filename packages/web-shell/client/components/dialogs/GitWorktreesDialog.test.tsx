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
} = vi.hoisted(() => {
  const workspaceGitWorktrees = vi.fn();
  const workspaceGitWorktreeStatus = vi.fn();
  const workspaceGitRemoveWorktree = vi.fn();
  const listWorkspaceSessions = vi.fn();
  const workspaceClient = {
    workspaceByCwd: () => ({
      workspaceGitWorktrees,
      workspaceGitWorktreeStatus,
      workspaceGitRemoveWorktree,
      listWorkspaceSessions,
    }),
  };
  return {
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
  path: '/tmp/stale',
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
    expect(text).toContain('directory missing');
    expect(text).toContain('detached HEAD');
    // Status is fetched for live directories only, never for the stale one.
    expect(workspaceGitWorktreeStatus).toHaveBeenCalledTimes(2);
    expect(workspaceGitWorktreeStatus).not.toHaveBeenCalledWith(STALE.path);
    expect(rows[0].textContent).toContain('clean');
    expect(rows[1].textContent).toContain('3 change(s)');
    // Sessions attach to their worktree and open on click.
    expect(rows[1].textContent).toContain('Refactor parser');
    expect(text).not.toContain('Plain session');
    await act(async () => {
      button('Refactor parser').click();
    });
    expect(onOpenSession).toHaveBeenCalledWith('s1');
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
      'Remove worktree stale',
    ]);
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

  it('explains a live-session refusal and shows other failures verbatim', async () => {
    workspaceGitWorktrees.mockResolvedValue(listPayload([MAIN, FEATURE]));
    listWorkspaceSessions.mockResolvedValue([]);
    workspaceGitWorktreeStatus.mockResolvedValue(status('/x'));
    workspaceGitRemoveWorktree
      .mockRejectedValueOnce(
        rejection({ code: 'worktree_in_use', error: 'busy', sessions: 2 }),
      )
      .mockRejectedValueOnce(
        rejection({ code: 'git_failed', error: 'fatal: locked worktree' }),
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
    expect(document.body.textContent).not.toContain('Remove anyway');
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
      setter.call(input, 'stale');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      document.body.querySelectorAll('[data-testid="git-worktree-row"]'),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain('/tmp/stale');

    await act(async () => {
      button('New worktree session…').click();
    });
    expect(onNewWorktreeSession).toHaveBeenCalledTimes(1);
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
