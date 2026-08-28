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

const { workspaceGitBranches, workspaceGitCreateBranch, workspaceClient } =
  vi.hoisted(() => {
    const workspaceGitBranches = vi.fn();
    const workspaceGitCreateBranch = vi.fn();
    // A stable client so the popover's memoized workspace handle (and thus its
    // fetch effect) stays referentially stable across renders.
    const workspaceClient = {
      workspaceByCwd: () => ({
        workspaceGitBranches,
        workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
        workspaceGitCreateBranch,
        workspaceGitPush: vi
          .fn()
          .mockResolvedValue({ success: true, output: '' }),
        workspaceGitPull: vi
          .fn()
          .mockResolvedValue({ success: true, output: '' }),
      }),
    };
    return { workspaceGitBranches, workspaceGitCreateBranch, workspaceClient };
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
const { BranchPickerPopover, deriveActionHints } = await import(
  './BranchPickerPopover'
);

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
    onRefreshStatus: () => void;
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
          status={overrides.status}
          onRefreshStatus={overrides.onRefreshStatus}
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
});

describe('BranchPickerPopover actions', () => {
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

  it('disables pull and announces upstream creation on push without upstream', () => {
    const h = deriveActionHints(tKey, branches({ ahead: 1 }), status());
    expect(h.pull).toEqual({
      text: 'branchPicker.hint.noUpstream',
      tone: 'muted',
    });
    expect(h.pullDisabled).toBe(true);
    expect(h.push).toEqual({
      text: 'branchPicker.hint.willCreateUpstream',
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

  it('counts all changed files for commit and calls out untracked ones', () => {
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main' }),
        status({ staged: 1, unstaged: 2 }),
      ).commit,
    ).toEqual({
      text: 'branchPicker.hint.changedFiles:{"count":3}',
      tone: 'info',
    });
    expect(
      deriveActionHints(
        tKey,
        branches({ upstream: 'origin/main' }),
        status({ staged: 1, unstaged: 2, untracked: 2 }),
      ).commit,
    ).toEqual({
      text: 'branchPicker.hint.changedFilesUntracked:{"count":5,"untracked":2}',
      tone: 'info',
    });
  });

  it('blocks pull and push during an in-progress operation, conflicts, or detached HEAD', () => {
    const op = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/main', behind: 1 }),
      status({ operation: 'rebase' }),
    );
    expect(op.pull).toEqual({ text: 'git.operation.rebase', tone: 'warning' });
    expect(op.pullDisabled).toBe(true);
    expect(op.pushDisabled).toBe(true);

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
    expect(conflict.pushDisabled).toBe(true);
    // Conflicted entries still count as uncommitted work for the commit hint.
    expect(conflict.commit?.text).toBe(
      'branchPicker.hint.changedFiles:{"count":2}',
    );

    const detached = deriveActionHints(tKey, branches({}, true), status());
    expect(detached.pull).toEqual({ text: 'git.detached', tone: 'warning' });
    expect(detached.pullDisabled).toBe(true);
    expect(detached.pushDisabled).toBe(true);
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

    const commit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-commit"]',
    );
    expect(commit?.disabled).toBe(false);
    expect(commit?.textContent).toContain('2 files');

    const push = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-push"]',
    );
    expect(push?.disabled).toBe(false);
    expect(push?.textContent).toContain('Creates remote branch');
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

  it('disables pull and push while a rebase is in progress', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main', behind: 1 }),
    );
    setup();
    mount({ status: status({ operation: 'rebase', conflicted: 1 }) });
    await flush();

    for (const id of ['branch-picker-pull', 'branch-picker-push']) {
      const btn = document.body.querySelector<HTMLButtonElement>(
        `[data-testid="${id}"]`,
      );
      expect(btn?.disabled).toBe(true);
      expect(btn?.textContent).toContain('Rebasing');
    }
  });

  it('asks the caller to refresh status once when opened, even with an inline callback', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main' }),
    );
    setup();
    const onRefreshStatus = vi.fn();
    mount({ onRefreshStatus, status: status() });
    await flush();
    // Re-render with a new callback identity and new status, as a parent
    // whose refresh handler calls setState would.
    mount({
      onRefreshStatus: () => onRefreshStatus(),
      status: status({ unstaged: 1 }),
    });
    await flush();

    expect(onRefreshStatus).toHaveBeenCalledTimes(1);
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);
  });
});
