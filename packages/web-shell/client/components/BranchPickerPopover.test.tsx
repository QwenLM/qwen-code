// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonGitBranchesResult,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';

// The real popover shell is Radix, whose focus/scroll-lock effects never
// settle under `act` in jsdom. Render the trigger and content inline instead
// so the action wiring can be exercised directly.
vi.mock('./ui/popover', async () => {
  const { createElement } = await import('react');
  return {
    Popover: ({ children }: { children?: unknown }) =>
      createElement('div', null, children),
    PopoverTrigger: ({ children }: { children?: unknown }) =>
      createElement('div', null, children),
    PopoverContent: ({ children }: { children?: unknown }) =>
      createElement('div', { 'data-test-popover-content': '' }, children),
  };
});

const {
  workspaceGitBranches,
  workspaceGitCheckout,
  workspaceGitCreateBranch,
  workspaceGit,
  workspaceClient,
} = vi.hoisted(() => {
  const workspaceGitBranches = vi.fn();
  const workspaceGitCheckout = vi.fn().mockResolvedValue(undefined);
  const workspaceGitCreateBranch = vi.fn();
  const workspaceGit = vi.fn();
  // A stable client so the popover's memoized workspace handle (and thus its
  // fetch effect) stays referentially stable across renders.
  const workspaceClient = {
    workspaceByCwd: () => ({
      workspaceGitBranches,
      workspaceGit,
      workspaceGitCheckout,
      workspaceGitCreateBranch,
      workspaceGitPush: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
      workspaceGitPull: vi
        .fn()
        .mockResolvedValue({ success: true, output: '' }),
    }),
  };
  return {
    workspaceGitBranches,
    workspaceGitCheckout,
    workspaceGitCreateBranch,
    workspaceGit,
    workspaceClient,
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({
      client: workspaceClient,
      capabilities: { features: [] },
    }),
  };
});

const { I18nProvider } = await import('../i18n');
const { BranchPickerPopover, deriveActionHints, listingContradictsStatus } =
  await import('./BranchPickerPopover');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mount(
  overrides: Partial<{
    onOpenDiff: () => void;
    onOpenCommit: () => void;
    onOpenChange: (open: boolean) => void;
    gitCwd: string;
    gitSessionId: string;
    onStatusRefreshed: (status: DaemonWorkspaceGitStatus) => void;
    status: DaemonWorkspaceGitStatus;
  }> = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BranchPickerPopover
          open
          onOpenChange={overrides.onOpenChange ?? vi.fn()}
          workspaceCwd="/repo"
          gitCwd={overrides.gitCwd}
          gitSessionId={overrides.gitSessionId}
          status={overrides.status}
          onStatusRefreshed={overrides.onStatusRefreshed}
          onOpenDiff={overrides.onOpenDiff}
          onOpenCommit={overrides.onOpenCommit}
        >
          <button type="button">trigger</button>
        </BranchPickerPopover>
      </I18nProvider>,
    );
  });
}

function clickButton(label: string): void {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (b) => b.textContent?.includes(label),
  );
  expect(button).toBeTruthy();
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
  // Default: the popover's own status fetch yields nothing, so hints derive
  // from the caller's `status` prop alone unless a test resolves it.
  workspaceGit.mockRejectedValue(new Error('no status'));
});
workspaceGit.mockRejectedValue(new Error('no status'));

describe('BranchPickerPopover actions', () => {
  it('binds worktree branch queries to the owning session', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo/.qwen/worktrees/test',
      available: true,
      current: null,
      local: [],
      remote: [],
      tags: [],
      recent: [],
    });
    mount({
      gitCwd: '/repo/.qwen/worktrees/test',
      gitSessionId: 'session-1',
    });
    await flush();

    expect(workspaceGitBranches).toHaveBeenCalledWith(
      '/repo/.qwen/worktrees/test',
      'session-1',
    );
  });

  it('binds worktree checkout mutations to the owning session', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo/.qwen/worktrees/test',
      available: true,
      local: [{ name: 'main', isHead: false }],
      remote: [],
      tags: [],
      recent: [],
      head: 'worktree-test',
      detached: false,
    });
    mount({
      gitCwd: '/repo/.qwen/worktrees/test',
      gitSessionId: 'session-1',
    });
    await flush();

    clickButton('main');
    await flush();

    expect(workspaceGitCheckout).toHaveBeenCalledWith(
      'main',
      '/repo/.qwen/worktrees/test',
      'session-1',
    );
  });

  it('wires "View Changes" to onOpenDiff and closes', async () => {
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      local: [{ name: 'main', isHead: true }],
      remote: [],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    });
    const onOpenDiff = vi.fn();
    const onOpenChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({ onOpenDiff, onOpenChange });
    await flush();

    clickButton('View Changes');

    expect(onOpenDiff).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('wires "Commit" to onOpenCommit and closes', async () => {
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      local: [{ name: 'main', isHead: true }],
      remote: [],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    });
    const onOpenCommit = vi.fn();
    const onOpenChange = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({ onOpenCommit, onOpenChange });
    await flush();

    clickButton('Commit');

    expect(onOpenCommit).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('explains an invalid branch name instead of silently returning', async () => {
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      local: [{ name: 'main', isHead: true }],
      remote: [],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('New Branch');
    await flush();

    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Branch name"]',
    );
    expect(input).toBeTruthy();

    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'bad name');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();

    expect(document.body.textContent).toContain('Invalid branch name');
    expect(workspaceGitCreateBranch).not.toHaveBeenCalled();
  });
});

// Identity translator: hints assert on keys / interpolated vars, not copy.
const tKey = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

function branches(
  head: Partial<DaemonGitBranchesResult['local'][number]> = {},
  detached = false,
): DaemonGitBranchesResult {
  return {
    v: 1,
    workspaceCwd: '/repo',
    available: true,
    local: [
      {
        name: 'main',
        isHead: true,
        ahead: 0,
        behind: 0,
        commitDate: 0,
        commitSubject: '',
        ...head,
      },
    ],
    remote: [],
    tags: [],
    recent: [],
    head: 'main',
    detached,
  };
}

function status(
  over: Partial<DaemonWorkspaceGitStatus> = {},
): DaemonWorkspaceGitStatus {
  return {
    v: 2,
    workspaceCwd: '/repo',
    branch: 'main',
    computedAt: 1,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    ...over,
  };
}

describe('deriveActionHints', () => {
  it('dims pull/push/commit when tracking upstream, in sync, and clean', () => {
    const h = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main' }),
      status(),
    );
    expect(h.pull).toEqual({
      text: 'branchPicker.hint.upToDate',
      tone: 'muted',
    });
    expect(h.pullDisabled).toBe(false);
    expect(h.push).toEqual({
      text: 'branchPicker.hint.nothingToPush',
      tone: 'muted',
    });
    expect(h.pushDisabled).toBe(false);
    expect(h.commit).toEqual({
      text: 'branchPicker.hint.noChanges',
      tone: 'muted',
    });
  });

  it('shows behind count with upstream for a clean tree', () => {
    const h = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main', behind: 3 }),
      status(),
    );
    expect(h.pull).toEqual({ text: '↓3 · origin/main', tone: 'info' });
    expect(h.pullDisabled).toBe(false);
  });

  it('warns on pull when behind with uncommitted changes', () => {
    const h = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main', behind: 2 }),
      status({ unstaged: 1 }),
    );
    expect(h.pull).toEqual({
      text: 'branchPicker.hint.behindDirty:{"count":2}',
      tone: 'warning',
    });
    expect(h.pullDisabled).toBe(false);
  });

  it('disables pull without upstream and says push will set one', () => {
    const h = deriveActionHints(tKey, branches({ ahead: 1 }), status());
    expect(h.pull).toEqual({
      text: 'branchPicker.hint.noUpstream',
      tone: 'muted',
    });
    expect(h.pullDisabled).toBe(true);
    expect(h.push).toEqual({
      text: 'branchPicker.hint.setsUpstream',
      tone: 'info',
    });
    expect(h.pushDisabled).toBe(false);
  });

  it('treats a gone upstream like no upstream, with its own copy on pull', () => {
    const h = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/feat', upstreamGone: true, ahead: 0 }),
      status({ hasUpstream: true }),
    );
    expect(h.pull).toEqual({
      text: 'branchPicker.hint.upstreamGone',
      tone: 'muted',
    });
    expect(h.pullDisabled).toBe(true);
    expect(h.push).toEqual({
      text: 'branchPicker.hint.setsUpstream',
      tone: 'info',
    });
    expect(h.pushDisabled).toBe(false);
  });

  it('shows ahead count on push and warns when also behind', () => {
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main', ahead: 2 }),
        status(),
      ).push,
    ).toEqual({ text: '↑2', tone: 'info' });
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main', ahead: 2, behind: 1 }),
        status(),
      ).push,
    ).toEqual({
      text: 'branchPicker.hint.aheadBehind:{"ahead":2,"behind":1}',
      tone: 'warning',
    });
  });

  it('counts changes (entries, not files) for commit and calls out untracked ones', () => {
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main' }),
        status({ staged: 1, unstaged: 2 }),
      ).commit,
    ).toEqual({
      text: 'branchPicker.hint.changes:{"count":3}',
      tone: 'info',
    });
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main' }),
        status({ staged: 1, unstaged: 2, untracked: 2 }),
      ).commit,
    ).toEqual({
      text: 'branchPicker.hint.changesUntracked:{"count":5,"untracked":2}',
      tone: 'info',
    });
    // A partially staged file (porcelain `MM`) is one file but two entries;
    // the copy must not call it "2 files".
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main' }),
        status({ staged: 1, unstaged: 1 }),
      ).commit?.text,
    ).toBe('branchPicker.hint.changes:{"count":2}');
  });

  it('blocks pull during an in-progress operation or conflicts but only warns on push', () => {
    // `git pull` refuses both states; `git push` does not consult the index,
    // so the push row stays clickable with the same warning.
    const op = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main', behind: 1 }),
      status({ operation: 'merge' }),
    );
    expect(op.pull).toEqual({ text: 'git.operation.merge', tone: 'warning' });
    expect(op.pullDisabled).toBe(true);
    expect(op.push).toEqual({ text: 'git.operation.merge', tone: 'warning' });
    expect(op.pushDisabled).toBe(false);

    const conflict = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main' }),
      status({ conflicted: 2 }),
    );
    expect(conflict.pull).toEqual({
      text: 'git.conflicted:{"count":2}',
      tone: 'warning',
    });
    expect(conflict.pullDisabled).toBe(true);
    expect(conflict.pushDisabled).toBe(false);
    // Conflicted entries still count as uncommitted work for the commit hint.
    expect(conflict.commit?.text).toBe('branchPicker.hint.changes:{"count":2}');
  });

  it('blocks both pull and push on a detached HEAD, naming the operation when there is one', () => {
    const detached = deriveActionHints(tKey, branches({}, true), status());
    expect(detached.pull).toEqual({ text: 'git.detached', tone: 'warning' });
    expect(detached.pullDisabled).toBe(true);
    expect(detached.push).toEqual({ text: 'git.detached', tone: 'warning' });
    expect(detached.pushDisabled).toBe(true);

    // A rebase detaches HEAD: push is blocked for that reason, but the row
    // says "Rebasing" since that is what the user is in the middle of.
    const rebase = deriveActionHints(
      tKey,
      branches({}, true),
      status({ operation: 'rebase', detached: true }),
    );
    expect(rebase.push).toEqual({
      text: 'git.operation.rebase',
      tone: 'warning',
    });
    expect(rebase.pushDisabled).toBe(true);
    expect(rebase.pullDisabled).toBe(true);
  });

  it('prefers the freshly fetched branch listing over the polled status for ahead/behind', () => {
    const h = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main', behind: 0 }),
      status({ hasUpstream: true, behind: 4 }),
    );
    expect(h.pull?.text).toBe('branchPicker.hint.upToDate');
  });

  it('falls back to status for ahead/behind when the listing has no head entry', () => {
    const noHead: DaemonGitBranchesResult = { ...branches(), local: [] };
    const h = deriveActionHints(
      tKey,
      noHead,
      status({ hasUpstream: true, behind: 4 }),
    );
    expect(h.pull?.text).toBe('↓4');
  });

  it('shows no hints at all when neither source is known', () => {
    const noHead: DaemonGitBranchesResult = { ...branches(), local: [] };
    const h = deriveActionHints(tKey, noHead, undefined);
    expect(h).toEqual({ pullDisabled: false, pushDisabled: false });
  });

  it('omits the commit hint on a v1 status without a computed tree summary', () => {
    const h = deriveActionHints(tKey, branches({ upstream: 'origin/main' }), {
      v: 1,
      workspaceCwd: '/repo',
      branch: 'main',
    });
    expect(h.commit).toBeUndefined();
    expect(h.pull?.text).toBe('branchPicker.hint.upToDate');
  });
});

describe('BranchPickerPopover action hints', () => {
  function setup(): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }

  it('renders hints beside the actions and disables pull without upstream', async () => {
    workspaceGitBranches.mockResolvedValue(branches({ ahead: 1 }));
    setup();
    mount({ onOpenCommit: vi.fn(), status: status({ unstaged: 2 }) });
    await flush();

    const pull = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-pull"]',
    );
    expect(pull?.disabled).toBe(true);
    expect(pull?.textContent).toContain('No upstream');

    // The pull row is dimmed, not just disabled: both the class hook the
    // stylesheet keys on and the tone attribute must be present.
    expect(pull?.className).toMatch(/actionItemMuted/);
    expect(
      pull
        ?.querySelector('[data-testid="branch-picker-action-hint"]')
        ?.getAttribute('data-tone'),
    ).toBe('muted');

    const commit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-commit"]',
    );
    expect(commit?.disabled).toBe(false);
    expect(commit?.textContent).toContain('2 changes');
    expect(commit?.className).not.toMatch(/actionItemMuted/);

    const push = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-push"]',
    );
    expect(push?.disabled).toBe(false);
    expect(push?.textContent).toContain('Sets upstream on push');
    expect(push?.className).not.toMatch(/actionItemMuted/);
  });

  it('dims every row on an in-sync clean tree', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main' }),
    );
    setup();
    mount({ onOpenCommit: vi.fn(), status: status() });
    await flush();

    for (const id of [
      'branch-picker-pull',
      'branch-picker-commit',
      'branch-picker-push',
    ]) {
      const btn = document.body.querySelector<HTMLButtonElement>(
        `[data-testid="${id}"]`,
      );
      expect(btn?.disabled).toBe(false);
      expect(btn?.className).toMatch(/actionItemMuted/);
    }
  });

  it('words a partially staged file as changes, not files', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main' }),
    );
    setup();
    mount({
      onOpenCommit: vi.fn(),
      status: status({ staged: 1, unstaged: 1 }),
    });
    await flush();

    const commit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-commit"]',
    );
    expect(commit?.textContent).toContain('2 changes');
    expect(commit?.textContent).not.toContain('files');
  });

  it('warns on pull when behind with uncommitted changes and keeps it enabled', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main', behind: 3 }),
    );
    setup();
    mount({ status: status({ untracked: 1 }) });
    await flush();

    const pull = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-pull"]',
    );
    expect(pull?.disabled).toBe(false);
    const hint = pull?.querySelector(
      '[data-testid="branch-picker-action-hint"]',
    );
    expect(hint?.getAttribute('data-tone')).toBe('warning');
    expect(hint?.textContent).toBe('↓3 · uncommitted changes');
  });

  it('disables pull and push while a rebase (detached HEAD) is in progress', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main', behind: 1 }, true),
    );
    setup();
    mount({
      status: status({ operation: 'rebase', detached: true, conflicted: 1 }),
    });
    await flush();

    for (const id of ['branch-picker-pull', 'branch-picker-push']) {
      const btn = document.body.querySelector<HTMLButtonElement>(
        `[data-testid="${id}"]`,
      );
      expect(btn?.disabled).toBe(true);
      expect(btn?.textContent).toContain('Rebasing');
    }
  });

  it('keeps push clickable during a conflicted merge on a branch', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main', ahead: 1 }),
    );
    setup();
    mount({ status: status({ operation: 'merge', conflicted: 1 }) });
    await flush();

    const pull = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-pull"]',
    );
    const push = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-push"]',
    );
    expect(pull?.disabled).toBe(true);
    expect(push?.disabled).toBe(false);
    expect(
      push
        ?.querySelector('[data-testid="branch-picker-action-hint"]')
        ?.getAttribute('data-tone'),
    ).toBe('warning');
    expect(push?.textContent).toContain('Merging');
  });

  it('fetches its own status once on open, reports it, and prefers it over an older prop', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main' }),
    );
    // The caller's snapshot says clean; the daemon now says otherwise.
    workspaceGit.mockResolvedValue(status({ unstaged: 3, computedAt: 200 }));
    setup();
    const onStatusRefreshed = vi.fn();
    const onOpenCommit = vi.fn();
    mount({
      onOpenCommit,
      onStatusRefreshed,
      status: status({ computedAt: 100 }),
    });
    await flush();
    // Re-render with a new callback identity, as a parent whose handler
    // calls setState would; the open effect must not re-arm.
    mount({
      onOpenCommit,
      onStatusRefreshed: (s) => onStatusRefreshed(s),
      status: status({ computedAt: 100 }),
    });
    await flush();

    expect(workspaceGit).toHaveBeenCalledTimes(1);
    expect(workspaceGit).toHaveBeenCalledWith({ wait: true });
    expect(onStatusRefreshed).toHaveBeenCalledTimes(1);
    expect(onStatusRefreshed.mock.calls[0]?.[0]).toMatchObject({
      unstaged: 3,
    });
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);
    const commit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-commit"]',
    );
    expect(commit?.textContent).toContain('3 changes');
  });

  it('reads status through the worktree cwd when one is given', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main' }),
    );
    workspaceGit.mockResolvedValue(status());
    setup();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <BranchPickerPopover
            open
            onOpenChange={vi.fn()}
            workspaceCwd="/repo"
            gitCwd="/repo/.qwen/worktrees/wt"
          >
            <button type="button">trigger</button>
          </BranchPickerPopover>
        </I18nProvider>,
      );
    });
    await flush();
    expect(workspaceGit).toHaveBeenCalledWith({
      cwd: '/repo/.qwen/worktrees/wt',
    });
  });

  it('re-fetches the listing when a newer status contradicts it, once per status', async () => {
    // Listing on open: tracking origin/main. Then the terminal runs
    // `git branch --unset-upstream` and a newer status arrives while the
    // popover is still open; the second listing fetch reflects that.
    workspaceGitBranches
      .mockResolvedValueOnce(branches({ upstream: 'origin/main' }))
      .mockResolvedValue(branches({}));
    setup();
    mount({ status: status({ hasUpstream: true, computedAt: 1 }) });
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="branch-picker-pull"]',
      )?.disabled,
    ).toBe(false);

    mount({
      status: status({ hasUpstream: false, computedAt: Date.now() + 60_000 }),
    });
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    const pull = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-pull"]',
    );
    expect(pull?.disabled).toBe(true);
    expect(pull?.textContent).toContain('No upstream');

    // The same status arriving again must not fetch again.
    mount({
      status: status({ hasUpstream: false, computedAt: Date.now() + 60_000 }),
    });
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
  });

  it('leaves the listing alone when the newer status agrees with it', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main', ahead: 2 }),
    );
    setup();
    mount({ status: status({ computedAt: 1 }) });
    await flush();
    mount({
      status: status({
        hasUpstream: true,
        ahead: 2,
        behind: 0,
        computedAt: Date.now() + 60_000,
      }),
    });
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);
  });
});

describe('listingContradictsStatus', () => {
  it('flags upstream, detached, and ahead/behind disagreements only', () => {
    const listing = branches({ upstream: 'origin/main', ahead: 1 });
    expect(listingContradictsStatus(listing, status())).toBe(false);
    expect(
      listingContradictsStatus(listing, status({ hasUpstream: false })),
    ).toBe(true);
    expect(listingContradictsStatus(listing, status({ detached: true }))).toBe(
      true,
    );
    expect(listingContradictsStatus(listing, status({ ahead: 2 }))).toBe(true);
    expect(listingContradictsStatus(listing, status({ behind: 1 }))).toBe(true);
    // Tree counters are not the listing's business.
    expect(
      listingContradictsStatus(listing, status({ unstaged: 5, staged: 2 })),
    ).toBe(false);
    // The status cannot express a gone upstream (it still reports tracking),
    // so a gone listing entry never disagrees on the upstream axis.
    const gone = branches({ upstream: 'origin/feat', upstreamGone: true });
    expect(listingContradictsStatus(gone, status({ hasUpstream: true }))).toBe(
      false,
    );
    expect(listingContradictsStatus(gone, status({ hasUpstream: false }))).toBe(
      false,
    );
  });
});
