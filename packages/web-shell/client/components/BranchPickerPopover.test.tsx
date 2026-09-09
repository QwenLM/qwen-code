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
  DaemonGitRemotesResult,
  DaemonWorkspaceGitStatus,
} from '@qwen-code/sdk/daemon';

// The real popover shell is Radix, whose focus/scroll-lock effects never
// settle under `act` in jsdom. Render the trigger and content inline instead
// so the action wiring can be exercised directly.
vi.mock('./ui/popover', async () => {
  const {
    createElement,
    createContext,
    forwardRef,
    useContext,
    useEffect,
    useRef,
  } = await import('react');
  interface PopoverOpenState {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
  }
  const OpenContext = createContext<PopoverOpenState>({ open: true });
  const PopoverContent = forwardRef<
    HTMLDivElement,
    {
      children?: unknown;
      onEscapeKeyDown?: (e: KeyboardEvent) => void;
    }
  >(({ children, onEscapeKeyDown }, ref) => {
    // Like Radix, the content unmounts when the popover closes.
    const { open: popoverOpen, onOpenChange } = useContext(OpenContext);
    const escapeHandlerRef = useRef(onEscapeKeyDown);
    escapeHandlerRef.current = onEscapeKeyDown;
    // Like Radix's DismissableLayer (react-use-escape-keydown): Escape is
    // handled on the owner document in the CAPTURE phase — ahead of any
    // handler on the focused input — and only `event.key` is checked (no
    // IME guard), so the component's preserveImeEscape mask is exercised
    // exactly the way the real layer sees it. An un-prevented Escape
    // dismisses the popover.
    useEffect(() => {
      if (!popoverOpen) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        escapeHandlerRef.current?.(e);
        if (!e.defaultPrevented) onOpenChange?.(false);
      };
      document.addEventListener('keydown', handler, { capture: true });
      return () =>
        document.removeEventListener('keydown', handler, { capture: true });
    }, [popoverOpen, onOpenChange]);
    if (!popoverOpen) return null;
    return createElement(
      'div',
      {
        'data-test-popover-content': '',
        ref,
      },
      children,
    );
  });
  PopoverContent.displayName = 'PopoverContent';
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: unknown;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) =>
      createElement(
        OpenContext.Provider,
        { value: { open: open ?? true, onOpenChange } },
        children,
      ),
    PopoverTrigger: ({ children }: { children?: unknown }) =>
      createElement('div', null, children),
    // Forward onEscapeKeyDown the way Radix's DismissableLayer does, so the
    // component's Escape handling is exercised without the real dependency.
    PopoverContent,
  };
});

const {
  workspaceGitBranches,
  workspaceGitCreateBranch,
  workspaceGitPull,
  workspaceGitCheckout,
  workspaceGitPush,
  workspaceGit,
  workspaceGitRemotes,
  workspaceGitRemoteAdd,
  workspaceGitRemoteRemove,
  workspaceClient,
} = vi.hoisted(() => {
  const workspaceGitBranches = vi.fn();
  const workspaceGitCreateBranch = vi.fn();
  const workspaceGitPull = vi.fn();
  const workspaceGitCheckout = vi.fn();
  const workspaceGitPush = vi.fn();
  const workspaceGit = vi.fn();
  const workspaceGitRemotes = vi.fn();
  const workspaceGitRemoteAdd = vi.fn();
  const workspaceGitRemoteRemove = vi.fn();
  // A stable client so the popover's memoized workspace handle (and thus its
  // fetch effect) stays referentially stable across renders.
  const workspaceClient = {
    workspaceByCwd: () => ({
      workspaceGitBranches,
      workspaceGit,
      workspaceGitCheckout,
      workspaceGitCreateBranch,
      workspaceGitPush,
      workspaceGitPull,
      workspaceGitRemotes,
      workspaceGitRemoteAdd,
      workspaceGitRemoteRemove,
    }),
  };
  return {
    workspaceGitBranches,
    workspaceGitCreateBranch,
    workspaceGitPull,
    workspaceGitCheckout,
    workspaceGitPush,
    workspaceGit,
    workspaceGitRemotes,
    workspaceGitRemoteAdd,
    workspaceGitRemoteRemove,
    workspaceClient,
  };
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/web-shell/daemon-react-sdk')
    >();
  return {
    ...actual,
    useWorkspace: () => ({
      client: workspaceClient,
      capabilities: { features: [] },
    }),
  };
});

const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
const { I18nProvider } = await import('../i18n');
const {
  BranchPickerPopover,
  deriveActionHints,
  listingContradictsStatus,
  GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
} = await import('./BranchPickerPopover');

// A branch with an upstream it is behind on, so the Update Project row is
// enabled (the action hints disable it without an upstream). Annotated with
// the wire type so overrides (e.g. push-side fields) typecheck.
const BRANCHES: DaemonGitBranchesResult = {
  v: 1,
  workspaceCwd: '/repo',
  available: true,
  local: [
    {
      name: 'main',
      isHead: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 1,
      pushTarget: 'origin/main',
      pushAhead: 0,
      pushBehind: 1,
      commitDate: 0,
      commitSubject: '',
    },
  ],
  remote: [],
  tags: [],
  recent: [],
  head: 'main',
  detached: false,
};

function dirtyTreeError(): Error {
  return new DaemonHttpError(
    409,
    { error: 'dirty_working_tree', message: 'would be overwritten by merge' },
    'POST /workspaces/:workspace/git/pull: dirty_working_tree',
  );
}

function footerText(): string {
  return (
    document.body.querySelector('[data-test-popover-content]')?.textContent ??
    ''
  );
}

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
    onBranchChanged: () => void;
    open: boolean;
    onStatusRefreshed: (status: DaemonWorkspaceGitStatus) => void;
    status: DaemonWorkspaceGitStatus;
    gitCwd: string;
    language: 'en' | 'zh-CN';
  }> = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language={overrides.language ?? 'en'}>
        <BranchPickerPopover
          open={overrides.open ?? true}
          onOpenChange={overrides.onOpenChange ?? vi.fn()}
          workspaceCwd="/repo"
          gitCwd={overrides.gitCwd}
          status={overrides.status}
          onStatusRefreshed={overrides.onStatusRefreshed}
          onBranchChanged={overrides.onBranchChanged}
          onOpenDiff={overrides.onOpenDiff}
          onOpenCommit={overrides.onOpenCommit}
        >
          <button type="button">trigger</button>
        </BranchPickerPopover>
      </I18nProvider>,
    );
  });
}

function defaultRemotesResult(): DaemonGitRemotesResult {
  return {
    v: 1,
    workspaceCwd: '/repo',
    available: true,
    remotes: [
      {
        name: 'origin',
        fetchUrl: 'https://example.com/o/r.git',
        pushUrl: 'https://example.com/o/r.git',
        extraFetchUrls: 0,
        extraPushUrls: 0,
        promisor: false,
        customRefspec: false,
        otherSettings: 0,
      },
    ],
  };
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
  workspaceGitPull.mockReset();
  workspaceGitCheckout.mockReset();
  workspaceGitCheckout.mockResolvedValue(undefined);
  workspaceGitPush.mockReset();
  workspaceGitPush.mockResolvedValue({ success: true, output: '' });
  workspaceGitRemotes.mockReset();
  workspaceGitRemotes.mockResolvedValue(defaultRemotesResult());
  workspaceGitRemoteAdd.mockReset();
  workspaceGitRemoteRemove.mockReset();
  // Default: the popover's own status fetch yields nothing, so hints derive
  // from the caller's `status` prop alone unless a test resolves it.
  workspaceGit.mockRejectedValue(new Error('no status'));
});
workspaceGit.mockRejectedValue(new Error('no status'));
// Seeded at module scope too: `afterEach` only runs after a test, so the
// first test in the file (or any `-t` filtered run starting inside the
// remotes block) would otherwise face a bare `vi.fn()` resolving undefined.
workspaceGitRemotes.mockResolvedValue(defaultRemotesResult());

function mountWithBranches(
  branchesResult: DaemonGitBranchesResult = BRANCHES,
  overrides: Parameters<typeof mount>[0] = {},
): void {
  workspaceGitBranches.mockResolvedValue(branchesResult);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mount(overrides);
}

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

  it('offers stash and discard when the pull hits a dirty tree', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({ success: true, output: 'ok' });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();

    expect(footerText()).toContain('Update blocked by uncommitted changes');
    clickButton('Stash Changes and Update');
    await flush();

    expect(workspaceGitPull).toHaveBeenLastCalledWith(
      { stash: true },
      undefined,
      600_000,
    );
    expect(footerText()).not.toContain('Stash Changes and Update');
    expect(footerText()).toContain('ok');
  });

  it('requires confirmation before discarding changes for a pull', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({ success: true, output: 'ok' });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Discard Changes and Update');
    await flush();

    // The first click only reveals the confirmation; no destructive call yet.
    expect(workspaceGitPull).toHaveBeenCalledTimes(1);
    expect(footerText()).toContain('This cannot be undone');

    clickButton('Discard and Update');
    await flush();

    expect(workspaceGitPull).toHaveBeenLastCalledWith(
      { force: true },
      undefined,
      600_000,
    );
  });

  it('keeps the panel mounted while its stash pull is in flight', async () => {
    let settle:
      | ((value: { success: boolean; output: string }) => void)
      | undefined;
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();

    const stashButton = Array.from(
      document.body.querySelectorAll('button'),
    ).find((b) => b.textContent?.includes('Stash Changes and Update'));
    expect(stashButton).toBeTruthy();
    expect(stashButton?.disabled).toBe(true);

    await act(async () => {
      settle?.({ success: true, output: 'done' });
    });
    await flush();

    expect(footerText()).not.toContain('Stash Changes and Update');
    expect(footerText()).toContain('done');
  });

  it('shows a warning instead of success when the stash restore conflicts', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 1..2',
      stashRestoreConflict: true,
    });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();

    expect(footerText()).toContain('restoring your stashed changes failed');
    expect(footerText()).not.toContain('Updating 1..2');
  });

  it('shows the daemon message for a refused pull instead of the panel', async () => {
    workspaceGitPull.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          error: 'operation_in_progress',
          message: 'cannot update: a merge is in progress',
        },
        'POST /workspaces/:workspace/git/pull: operation_in_progress',
      ),
    );
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();

    expect(footerText()).toContain('cannot update: a merge is in progress');
    expect(footerText()).not.toContain('Stash Changes and Update');
  });

  it('dismisses the panel via Cancel without another pull', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Cancel');
    await flush();

    expect(workspaceGitPull).toHaveBeenCalledTimes(1);
    expect(footerText()).not.toContain('Stash Changes and Update');
    expect(footerText()).not.toContain('Update blocked by uncommitted changes');
  });

  it('resets the panel when the popover is reopened', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    expect(footerText()).toContain('Stash Changes and Update');

    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();

    expect(footerText()).not.toContain('Stash Changes and Update');
    // The non-sticky blocked line is reset too, not just the panel.
    expect(footerText()).not.toContain('Update blocked by uncommitted changes');
  });

  it('backs out of the discard confirmation via Cancel without pulling', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Discard Changes and Update');
    await flush();
    expect(footerText()).toContain('This cannot be undone');

    clickButton('Cancel');
    await flush();

    expect(workspaceGitPull).toHaveBeenCalledTimes(1);
    expect(footerText()).not.toContain('This cannot be undone');
    expect(footerText()).toContain('Stash Changes and Update');
  });

  it('clears the panel when a competing push runs, showing its outcome', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPush.mockResolvedValueOnce({
      success: true,
      output: 'pushed to origin',
    });
    // Triangular fixture: behind the tracking upstream (so a real pull can
    // fail with the 409 that raises the panel) while ahead of a *different*
    // push remote — real git counts both atoms against one ref when they
    // name the same destination, so only distinct refs can disagree.
    mountWithBranches({
      ...BRANCHES,
      local: [
        {
          ...BRANCHES.local[0],
          upstream: 'upstream/main',
          pushTarget: 'origin/main',
          pushAhead: 1,
          pushBehind: 0,
        },
      ],
    });
    await flush();

    clickButton('Update Project');
    await flush();
    expect(footerText()).toContain('Stash Changes and Update');

    clickButton('Push');
    await flush();

    expect(workspaceGitPush).toHaveBeenCalledTimes(1);
    expect(footerText()).not.toContain('Stash Changes and Update');
    expect(footerText()).toContain('pushed to origin');
  });

  it('clears the panel when a valid new branch is created', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitCreateBranch.mockResolvedValueOnce(undefined);
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('New Branch');
    await flush();

    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Branch name"]',
    );
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'feature/ok');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();

    expect(workspaceGitCreateBranch).toHaveBeenCalledWith(
      'feature/ok',
      undefined,
      undefined,
    );
    expect(footerText()).not.toContain('Stash Changes and Update');
  });

  it('clears the panel when a competing checkout runs, showing its outcome', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitCheckout.mockRejectedValueOnce(
      new Error('checkout refused: local changes'),
    );
    workspaceGitBranches.mockResolvedValue({
      ...BRANCHES,
      local: [...BRANCHES.local, { name: 'dev', isHead: false }],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount({});
    await flush();

    clickButton('Update Project');
    await flush();
    expect(footerText()).toContain('Stash Changes and Update');

    clickButton('dev');
    await flush();

    expect(workspaceGitCheckout).toHaveBeenCalledWith('dev', undefined);
    expect(footerText()).not.toContain('Stash Changes and Update');
    expect(footerText()).toContain('checkout refused: local changes');
  });

  it('keeps the panel when a new-branch submit is rejected as invalid', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('New Branch');
    await flush();

    const input = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Branch name"]',
    );
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      nativeSetter?.call(input, 'bad name');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();

    expect(workspaceGitCreateBranch).not.toHaveBeenCalled();
    expect(footerText()).toContain('Stash Changes and Update');
  });

  it('keeps the restore warning, with the stash id, across a reopen', async () => {
    let settle:
      | ((value: {
          success: boolean;
          output: string;
          stashRestoreConflict?: boolean;
          stashSha?: string;
        }) => void)
      | undefined;
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();

    // The popover closes while the stash pull is still running.
    mount({ open: false });
    await flush();
    await act(async () => {
      settle?.({
        success: true,
        output: 'Updating 1..2',
        stashRestoreConflict: true,
        stashSha: 'dcda4a53ed6526ecc6c4cda837d665140a2baff1',
      });
    });
    await flush();
    mount({ open: true });
    await flush();

    expect(footerText()).toContain('restoring your stashed changes failed');
    expect(footerText()).toContain('dcda4a53ed65');
  });

  it('keeps a kept-entry notice, as a warning, across a reopen', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output:
        'Updating 1..2\nrestored; stash entry aaaa was kept because the stash changed while dropping it, and the displaced entry bbbb could not be stored back — recover it with: git stash store bbbb',
      stashKept: true,
      stashSha: 'aaaa',
    });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();

    expect(footerText()).toContain('recover it with: git stash store bbbb');

    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();

    // The notice is the only record of where the entries went; it must
    // survive the reopen reset like the conflict warning does.
    expect(footerText()).toContain('recover it with: git stash store bbbb');
  });

  it('keeps the panel with the daemon explanation when discarding is unsupported', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          error: 'force_unsupported',
          message: 'cannot discard changes: the workspace is a subdirectory',
        },
        'POST /workspaces/:workspace/git/pull: force_unsupported',
      ),
    );
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Discard Changes and Update');
    await flush();
    clickButton('Discard and Update');
    await flush();

    expect(workspaceGitPull).toHaveBeenLastCalledWith(
      { force: true },
      undefined,
      600_000,
    );
    expect(footerText()).toContain(
      'cannot discard changes: the workspace is a subdirectory',
    );
    expect(footerText()).toContain('Stash Changes and Update');
    // The daemon declared discarding impossible for this workspace; the
    // action is gone rather than looping the same refusal.
    expect(footerText()).not.toContain('Discard Changes and Update');
    expect(footerText()).not.toContain('Discard and Update');
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
      branches({ upstream: 'origin/main', pushTarget: 'origin/main' }),
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

  it('warns on push, without disabling, when behind the destination', () => {
    // The counts are a last-fetch snapshot and remote acceptance is not
    // locally decidable (refspecs, forcing refspecs, staleness), so the row
    // warns and stays clickable — git answers authoritatively on click.
    const h = deriveActionHints(
      tKey,
      branches({
        upstream: 'origin/main',
        behind: 3,
        pushTarget: 'origin/main',
        pushBehind: 3,
      }),
      status(),
    );
    expect(h.pull).toEqual({ text: '↓3 · origin/main', tone: 'info' });
    expect(h.pullDisabled).toBe(false);
    expect(h.push).toEqual({ text: '↓3', tone: 'warning' });
    expect(h.pushDisabled).toBe(false);
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

  it('reasons about the push target, not the upstream, when they differ', () => {
    // Triangular (fork) workflow: behind the tracking upstream, ahead of the
    // push remote — `git push` fast-forwards origin and succeeds.
    const triangular = branches({
      upstream: 'upstream/main',
      behind: 3,
      pushTarget: 'origin/main',
      pushAhead: 2,
      pushBehind: 0,
    });
    const h = deriveActionHints(tKey, triangular, status());
    expect(h.pull).toEqual({ text: '↓3 · upstream/main', tone: 'info' });
    expect(h.push).toEqual({ text: '↑2', tone: 'info' });
    expect(h.pushDisabled).toBe(false);

    // Diverged from the push target itself: warning with push-side counts,
    // still clickable.
    const diverged = deriveActionHints(
      tKey,
      branches({
        upstream: 'upstream/main',
        behind: 0,
        pushTarget: 'origin/main',
        pushAhead: 1,
        pushBehind: 1,
      }),
      status(),
    );
    expect(diverged.push).toEqual({
      text: 'branchPicker.hint.aheadBehind:{"ahead":1,"behind":1}',
      tone: 'warning',
    });
    expect(diverged.pushDisabled).toBe(false);

    // Push side known and behind while the upstream is gone: the push-side
    // warning shows even though `hasUpstream` is false.
    const goneUpstream = deriveActionHints(
      tKey,
      branches({
        upstream: 'upstream/main',
        upstreamGone: true,
        pushTarget: 'origin/main',
        pushAhead: 0,
        pushBehind: 1,
      }),
      status(),
    );
    expect(goneUpstream.push).toEqual({ text: '↓1', tone: 'warning' });
    expect(goneUpstream.pushDisabled).toBe(false);

    // Gone upstream with a resolved, in-sync destination: the destination
    // rules on its own, so this is "Nothing to push" and not the no-upstream
    // branch's "Sets upstream on push".
    const goneInSync = deriveActionHints(
      tKey,
      branches({
        upstream: 'upstream/main',
        upstreamGone: true,
        pushTarget: 'origin/main',
        pushAhead: 0,
        pushBehind: 0,
      }),
      status(),
    );
    expect(goneInSync.push).toEqual({
      text: 'branchPicker.hint.nothingToPush',
      tone: 'muted',
    });
  });

  it('says nothing on push when git names no destination for a live upstream', () => {
    // The shapes core reports as `upstream` set with no `pushTarget`:
    // `push.default=simple` in a triangular repo, a `remote.<name>.push`
    // refspec (Gerrit), an upstream whose name the branch does not match,
    // and `push.default=nothing`. Git refuses some of those pushes outright
    // and routes others where the listing cannot follow, so the row carries
    // no hint and stays enabled rather than dress a pull-side count as a
    // push-side one.
    const triangular = deriveActionHints(
      tKey,
      branches({ upstream: 'upstream/main', behind: 3 }),
      status(),
    );
    expect(triangular.push).toBeUndefined();
    expect(triangular.pushDisabled).toBe(false);

    const nameMismatch = deriveActionHints(
      tKey,
      branches({ upstream: 'origin/bar', ahead: 1 }),
      status(),
    );
    expect(nameMismatch.push).toBeUndefined();
    expect(nameMismatch.pushDisabled).toBe(false);
  });

  it('labels a missing push ref as branch creation, never "Nothing to push"', () => {
    const h = deriveActionHints(
      tKey,
      branches({
        upstream: 'upstream/main',
        behind: 2,
        pushTarget: 'origin/feat',
        pushGone: true,
      }),
      status(),
    );
    expect(h.push).toEqual({
      text: 'branchPicker.hint.createsPushBranch:{"target":"origin/feat"}',
      tone: 'info',
    });
    expect(h.pushDisabled).toBe(false);
  });

  it('shows ahead count on push and warns when also behind', () => {
    const ahead = deriveActionHints(
      tKey,
      branches({
        upstream: 'origin/main',
        ahead: 2,
        pushTarget: 'origin/main',
        pushAhead: 2,
        pushBehind: 0,
      }),
      status(),
    );
    expect(ahead.push).toEqual({ text: '↑2', tone: 'info' });
    // Only a detached HEAD is locally provable, so this stays clickable.
    expect(ahead.pushDisabled).toBe(false);

    const diverged = deriveActionHints(
      tKey,
      branches({
        upstream: 'origin/main',
        ahead: 2,
        behind: 1,
        pushTarget: 'origin/main',
        pushAhead: 2,
        pushBehind: 1,
      }),
      status(),
    );
    expect(diverged.push).toEqual({
      text: 'branchPicker.hint.aheadBehind:{"ahead":2,"behind":1}',
      tone: 'warning',
    });
    expect(diverged.pushDisabled).toBe(false);
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
    // behind > 0, but mid-operation the behind count is in flux (the merge
    // being concluded is what resolves it), so the row only warns.
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
    // No listing entry means no push-side atoms either, so the status
    // counters are all there is: the row must not go silent here.
    expect(h.push).toEqual({ text: '↓4', tone: 'warning' });
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
      branches({ upstream: 'origin/main', pushTarget: 'origin/main' }),
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

  it('warns on a behind or diverged push row but keeps it clickable', async () => {
    workspaceGitBranches.mockResolvedValue(
      branches({
        upstream: 'origin/main',
        ahead: 1,
        behind: 2,
        pushTarget: 'origin/main',
        pushAhead: 1,
        pushBehind: 2,
      }),
    );
    setup();
    mount({ status: status() });
    await flush();

    const push = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-push"]',
    );
    expect(push?.disabled).toBe(false);
    expect(
      push
        ?.querySelector('[data-testid="branch-picker-action-hint"]')
        ?.getAttribute('data-tone'),
    ).toBe('warning');
    expect(push?.textContent).toContain('diverged');
  });

  it("breaks a computedAt tie in favor of the popover's own fetch", async () => {
    // The caller's snapshot and the on-open fetch can carry the same stamp
    // (the daemon dedupes concurrent computations); the fresher fetch wins.
    workspaceGitBranches.mockResolvedValue(
      branches({ upstream: 'origin/main' }),
    );
    workspaceGit.mockResolvedValue(status({ unstaged: 3, computedAt: 100 }));
    setup();
    mount({ onOpenCommit: vi.fn(), status: status({ computedAt: 100 }) });
    await flush();

    const commit = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="branch-picker-commit"]',
    );
    expect(commit?.textContent).toContain('3 changes');
    expect(commit?.textContent).not.toContain('No changes');
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

describe('BranchPickerPopover post-failure refresh', () => {
  function mountFresh(overrides: Parameters<typeof mount>[0] = {}): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mount({ status: status(), ...overrides });
  }

  function row(id: 'pull' | 'commit' | 'push'): HTMLButtonElement | null {
    return document.body.querySelector<HTMLButtonElement>(
      `[data-testid="branch-picker-${id}"]`,
    );
  }

  it('re-fetches the listing when a pull fails, so the rows leave the pre-pull snapshot', async () => {
    workspaceGitBranches
      .mockResolvedValueOnce(
        branches({
          upstream: 'origin/main',
          behind: 2,
          pushTarget: 'origin/main',
          pushBehind: 2,
        }),
      )
      .mockResolvedValue(
        branches({ upstream: 'origin/main', pushTarget: 'origin/main' }),
      );
    workspaceGitPull.mockRejectedValueOnce(new Error('fetch refused'));
    mountFresh();
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);

    clickButton('Update Project');
    await flush();

    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('fetch refused');
    // The refreshed listing must actually drive the rows: the pre-pull
    // snapshot said behind 2 (pull ↓2, push warning ↓2); the re-fetched
    // listing is in sync.
    expect(row('pull')?.textContent).toContain('Up to date');
    expect(row('pull')?.textContent).not.toContain('↓2');
    expect(row('push')?.textContent).toContain('Nothing to push');
  });

  it('re-fetches the listing when a push is rejected, so the rows leave the pre-push snapshot', async () => {
    workspaceGitBranches
      .mockResolvedValueOnce(
        branches({
          upstream: 'origin/main',
          pushTarget: 'origin/main',
          pushAhead: 2,
        }),
      )
      .mockResolvedValue(
        branches({ upstream: 'origin/main', pushTarget: 'origin/main' }),
      );
    // The refresh re-reads the working tree too, so give the on-open status
    // fetch nothing and the post-push one a dirty tree.
    workspaceGit
      .mockRejectedValueOnce(new Error('no status'))
      .mockResolvedValue(status({ unstaged: 4, computedAt: 500 }));
    workspaceGitPush.mockRejectedValueOnce(new Error('non-fast-forward'));
    mountFresh({ onOpenCommit: vi.fn() });
    await flush();
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);
    expect(row('push')?.textContent).toContain('↑2');

    clickButton('Push');
    await flush();

    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('non-fast-forward');
    expect(row('push')?.textContent).toContain('Nothing to push');
    expect(row('push')?.textContent).not.toContain('↑2');
    expect(row('commit')?.textContent).toContain('4 changes');
  });

  it('keeps the stale rows when the post-failure re-read itself fails', async () => {
    // A rejected push and a closing daemon generation fail both calls with
    // one correlated cause; the listing on screen is stale but usable, so
    // the refresh must not replace it with its own error.
    workspaceGitBranches
      .mockResolvedValueOnce(
        branches({ upstream: 'origin/main', pushTarget: 'origin/main' }),
      )
      .mockRejectedValueOnce(new Error('daemon generation closed'));
    workspaceGitPush.mockRejectedValueOnce(new Error('non-fast-forward'));
    mountFresh();
    await flush();

    clickButton('Push');
    await flush();

    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('non-fast-forward');
    expect(document.body.textContent).not.toContain('daemon generation closed');
    expect(row('push')).toBeTruthy();
    expect(row('pull')).toBeTruthy();
  });

  it('leaves the resolution panel usable while the post-failure refresh is in flight', async () => {
    let settleListing: ((value: DaemonGitBranchesResult) => void) | undefined;
    workspaceGitBranches.mockResolvedValueOnce(BRANCHES).mockImplementationOnce(
      () =>
        new Promise<DaemonGitBranchesResult>((resolve) => {
          settleListing = resolve;
        }),
    );
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    mountFresh();
    await flush();

    clickButton('Update Project');
    await flush();

    // The 409 raised the panel; its buttons must not wait on a listing
    // round-trip the panel never needed.
    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    for (const label of [
      'Stash Changes and Update',
      'Discard Changes and Update',
      'Cancel',
    ]) {
      const button = Array.from(document.body.querySelectorAll('button')).find(
        (b) => b.textContent?.includes(label),
      );
      expect(button).toBeTruthy();
      expect(button?.disabled).toBe(false);
    }

    await act(async () => {
      settleListing?.(BRANCHES);
    });
    await flush();
  });

  it('keeps the stale rows mounted and the push row busy while the post-rejection refresh is in flight', async () => {
    let settleListing: ((value: DaemonGitBranchesResult) => void) | undefined;
    workspaceGitBranches
      .mockResolvedValueOnce(
        branches({
          upstream: 'origin/main',
          pushTarget: 'origin/main',
          pushAhead: 2,
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DaemonGitBranchesResult>((resolve) => {
            settleListing = resolve;
          }),
      );
    workspaceGitPush.mockRejectedValueOnce(new Error('non-fast-forward'));
    mountFresh();
    await flush();
    expect(row('push')?.textContent).toContain('↑2');

    clickButton('Push');
    await flush();

    // The silent re-read must not trade the stale-but-usable rows for the
    // loading placeholder — the spinner the push-side `await` holds up is only
    // visible while its row stays mounted.
    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain('non-fast-forward');
    expect(document.body.textContent).not.toContain('Loading branches');
    expect(row('push')).toBeTruthy();
    expect(row('pull')).toBeTruthy();
    expect(row('push')?.textContent).toContain('↑2');
    // Awaiting the refresh (rather than firing it) is what keeps busyAction set
    // until the re-read lands, so the row cannot re-enable on pre-push counts.
    expect(row('push')?.disabled).toBe(true);

    await act(async () => {
      settleListing?.(
        branches({ upstream: 'origin/main', pushTarget: 'origin/main' }),
      );
    });
    await flush();

    expect(row('push')?.disabled).toBe(false);
    expect(row('push')?.textContent).toContain('Nothing to push');
    expect(row('push')?.textContent).not.toContain('↑2');
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

describe('BranchPickerPopover remotes view', () => {
  function setInput(testId: string, value: string): void {
    const input = document.body.querySelector<HTMLInputElement>(
      `input[data-testid="${testId}"]`,
    );
    expect(input).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      nativeSetter?.call(input, value);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function clickTestId(testId: string): void {
    const el = document.body.querySelector(`[data-testid="${testId}"]`);
    expect(el).toBeTruthy();
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  async function openRemotesView(
    overrides: Parameters<typeof mount>[0] = {},
  ): Promise<void> {
    mountWithBranches(BRANCHES, overrides);
    await flush();
    // The popover's open-time autofocus fires on an unawaited 50ms timer:
    // let it land before a test moves focus, or under load the timer
    // steals the asserted target back to the search box (and blesses the
    // search-box fallback for the wrong reason).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    clickTestId('branch-picker-manage-remotes');
    await flush();
  }

  it('opens the remotes panel and lists remotes with URLs', async () => {
    await openRemotesView();

    expect(workspaceGitRemotes).toHaveBeenCalledTimes(1);
    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('origin');
    expect(content?.textContent).toContain('https://example.com/o/r.git');
    // The branches listing is swapped out while the panel is up.
    expect(content?.textContent).not.toContain('Update Project');
  });

  it('adds a remote and renders the list the daemon returned', async () => {
    workspaceGitRemoteAdd.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
        },
        {
          name: 'fork',
          fetchUrl: 'https://example.com/f/r.git',
          pushUrl: 'https://example.com/f/r.git',
        },
      ],
    });
    await openRemotesView();

    setInput('remote-add-name', ' fork ');
    setInput('remote-add-url', ' https://example.com/f/r.git ');
    clickTestId('remote-add-submit');
    await flush();

    expect(workspaceGitRemoteAdd).toHaveBeenCalledWith(
      'fork',
      'https://example.com/f/r.git',
      undefined,
      GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
    );
    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('fork');
    expect(footerText()).toContain('Added remote fork');
    // The add form cleared for the next entry.
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[data-testid="remote-add-name"]',
      )?.value,
    ).toBe('');
  });

  it('surfaces a daemon add failure in the footer and keeps the list', async () => {
    workspaceGitRemoteAdd.mockRejectedValue(
      new DaemonHttpError(
        409,
        {
          error: 'remote_already_exists',
          message: 'error: remote origin already exists.',
        },
        'POST /workspaces/:workspace/git/remote: remote_already_exists',
      ),
    );
    await openRemotesView();

    setInput('remote-add-name', 'origin');
    setInput('remote-add-url', 'https://example.com/other.git');
    clickTestId('remote-add-submit');
    await flush();

    expect(footerText()).toContain('remote origin already exists');
    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('origin');
    expect(content?.textContent).not.toContain('other.git');
  });

  it('rejects dash-prefixed input locally without calling the daemon', async () => {
    await openRemotesView();

    setInput('remote-add-name', '-x');
    setInput('remote-add-url', 'https://example.com/o/r.git');
    // The submit button stays enabled for non-empty input; the guard fires
    // on click.
    clickTestId('remote-add-submit');
    await flush();

    expect(workspaceGitRemoteAdd).not.toHaveBeenCalled();
    expect(footerText()).toContain('Enter a remote name and URL');
  });

  it('removes a remote only after the two-click confirm', async () => {
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    const onBranchChanged = vi.fn();
    await openRemotesView({ onBranchChanged });
    const branchesCallsBefore = workspaceGitBranches.mock.calls.length;
    const statusCallsBefore = workspaceGit.mock.calls.length;

    clickTestId('remote-remove-origin');
    // First click only arms the confirm; nothing is sent yet.
    expect(workspaceGitRemoteRemove).not.toHaveBeenCalled();
    expect(onBranchChanged).not.toHaveBeenCalled();

    clickTestId('remote-remove-origin');
    await flush();

    expect(workspaceGitRemoteRemove).toHaveBeenCalledWith(
      'origin',
      undefined,
      GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
    );
    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('No remotes configured');
    expect(footerText()).toContain('Removed remote origin');
    // Removal invalidates the branch listing's remote groups and the chip's
    // tracking state, so both refresh. Counted before/after: the on-open
    // fetches already recorded a call each, so a bare toHaveBeenCalled()
    // would pass even with the post-remove refresh deleted.
    expect(workspaceGitBranches.mock.calls.length).toBeGreaterThan(
      branchesCallsBefore,
    );
    expect(workspaceGit.mock.calls.length).toBeGreaterThan(statusCallsBefore);
    expect(onBranchChanged).toHaveBeenCalledTimes(1);
  });

  it('surfaces a remove failure in the footer', async () => {
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        404,
        { error: 'no_such_remote', message: "error: No such remote: 'gone'" },
        'POST /workspaces/:workspace/git/remote/remove: no_such_remote',
      ),
    );
    await openRemotesView();
    const remotesCallsBefore = workspaceGitRemotes.mock.calls.length;

    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();

    expect(footerText()).toContain('No such remote');
    // A refused remove means the displayed list is stale (git says the
    // remote is gone); the panel must re-read instead of keeping the row.
    expect(workspaceGitRemotes.mock.calls.length).toBeGreaterThan(
      remotesCallsBefore,
    );
  });

  it('returns to the branches view via the back button', async () => {
    await openRemotesView();

    clickTestId('remotes-back');
    await flush();

    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('Update Project');
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeNull();
  });

  it('filters remotes by the search box', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
        },
        {
          name: 'upstream',
          fetchUrl: 'git@example.com:u/r.git',
          pushUrl: 'git@example.com:u/r.git',
        },
      ],
    });
    await openRemotesView();

    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search remotes"]',
    );
    expect(search).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      nativeSetter?.call(search, 'upstream');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('upstream');
    expect(content?.textContent).not.toContain('origin');
  });

  it('renders the load failure and hides the add form', async () => {
    workspaceGitRemotes.mockRejectedValue(
      new DaemonHttpError(
        404,
        {
          error: 'not_a_git_repository',
          message: 'fatal: not a git repository',
        },
        'GET /workspaces/:workspace/git/remotes: not_a_git_repository',
      ),
    );
    await openRemotesView();

    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('not a git repository');
    // A failed read must not masquerade as an empty configuration.
    expect(content?.textContent).not.toContain('No remotes configured');
    expect(
      document.body.querySelector('input[data-testid="remote-add-name"]'),
    ).toBeNull();
  });

  it('distinguishes a filtered-to-empty list from no remotes at all', async () => {
    await openRemotesView();

    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search remotes"]',
    );
    expect(search).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      nativeSetter?.call(search, 'zzz-no-match');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('No remotes match the search');
    expect(content?.textContent).not.toContain('No remotes configured');
  });

  it('keeps a sticky stash warning across a remotes round trip', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 1..2',
      stashRestoreConflict: true,
      stashSha: 'dcda4a53ed6526ecc6c4cda837d665140a2baff1',
    });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');

    // Navigating into the remotes view and back must not destroy the only
    // record that the user's changes sit in a stash entry.
    clickTestId('branch-picker-manage-remotes');
    await flush();
    clickTestId('remotes-back');
    await flush();

    expect(footerText()).toContain('restoring your stashed changes failed');
    expect(footerText()).toContain('dcda4a53ed65');
  });

  it('restores the sticky stash warning a remotes mutation overwrote', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 1..2',
      stashRestoreConflict: true,
      stashSha: 'dcda4a53ed6526ecc6c4cda837d665140a2baff1',
    });
    workspaceGitRemoteAdd.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');

    clickTestId('branch-picker-manage-remotes');
    await flush();
    // A remotes mutation writes its own footer: the stash warning must
    // come back — message AND sticky flag — when leaving the view, or
    // the only record of the stash entry is lost.
    setInput('remote-add-name', 'fork');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    clickTestId('remote-add-submit');
    await flush();
    expect(footerText()).toContain('Added remote');
    clickTestId('remotes-back');
    await flush();

    expect(footerText()).toContain('restoring your stashed changes failed');
    expect(footerText()).toContain('dcda4a53ed65');
    expect(footerText()).not.toContain('Added remote');

    // The sticky flag is restored too: the reopen reset must keep the
    // warning, not clear it.
    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');
  });

  it('restores the sticky warning after a dismiss with the remotes view up', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 1..2',
      stashRestoreConflict: true,
      stashSha: 'dcda4a53ed6526ecc6c4cda837d665140a2baff1',
    });
    workspaceGitRemoteAdd.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');

    clickTestId('branch-picker-manage-remotes');
    await flush();
    setInput('remote-add-name', 'fork');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    clickTestId('remote-add-submit');
    await flush();
    expect(footerText()).toContain('Added remote');

    // Dismissal (outside click, trigger toggle) never runs the back
    // button's restore path — the snapshot must still come back, message
    // AND flag, on the next open.
    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');
    expect(footerText()).toContain('dcda4a53ed65');
    expect(footerText()).not.toContain('Added remote');
  });

  it('keeps the sticky warning when a mutation settles after the view exit', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 1..2',
      stashRestoreConflict: true,
      stashSha: 'dcda4a53ed6526ecc6c4cda837d665140a2baff1',
    });
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');

    clickTestId('branch-picker-manage-remotes');
    await flush();
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // Leave the view while the removal is still in flight: the settle's
    // footer must win the exit, not clobber the restored warning.
    clickTestId('remotes-back');
    await flush();
    // A dismiss+reopen WHILE BUSY must not consume the held snapshot
    // either — the open effect's busy gate keeps it for a post-settle
    // open.
    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
    });
    await flush();
    expect(footerText()).toContain('Removed remote');

    // Re-entering the view before any restore point must not null the
    // held snapshot (the settle disarmed the flag, so the re-snapshot
    // reads null and the held copy is the only surviving one). The back
    // click below is unblocked, so closeRemores restores and consumes
    // the held snapshot there.
    clickTestId('branch-picker-manage-remotes');
    await flush();
    clickTestId('remotes-back');
    await flush();

    // The dismiss/reopen pins the re-armed warning surviving the open
    // reset.
    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();
    expect(footerText()).toContain('restoring your stashed changes failed');
    expect(footerText()).toContain('dcda4a53ed65');
    expect(footerText()).not.toContain('Removed remote');
  });

  it('a newer sticky warning outranks a snapshot held from an older one', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 1..2',
      stashRestoreConflict: true,
      stashSha: 'dcda4a53ed6526ecc6c4cda837d665140a2baff1',
    });
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    mountWithBranches();
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();
    expect(footerText()).toContain('dcda4a53ed65');

    clickTestId('branch-picker-manage-remotes');
    await flush();
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    clickTestId('remotes-back');
    await flush();
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
    });
    await flush();

    // A second pull arms a NEWER warning while the older one is still
    // held: the standing warning wins and the stale snapshot is dropped.
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    workspaceGitPull.mockResolvedValueOnce({
      success: true,
      output: 'Updating 3..4',
      stashRestoreConflict: true,
      stashSha: 'aaaa1111bbbb6526ecc6c4cda837d665140a2baff1',
    });
    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();
    expect(footerText()).toContain('aaaa1111bbbb');

    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();
    expect(footerText()).toContain('aaaa1111bbbb');
    expect(footerText()).not.toContain('dcda4a53ed65');
    expect(footerText()).not.toContain('Removed remote');
  });

  it('disarms a pending remove confirm when the popover reopens', async () => {
    await openRemotesView();
    clickTestId('remote-remove-origin');
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).toContain('Confirm');

    mount({ open: false });
    await flush();
    mount({ open: true });
    await flush();
    // The reopen lands on the branches view (this click only exists there),
    // and re-entering the panel must not carry the armed confirm over.
    clickTestId('branch-picker-manage-remotes');
    await flush();

    const removeBtn = document.body.querySelector(
      '[data-testid="remote-remove-origin"]',
    );
    expect(removeBtn).toBeTruthy();
    expect(removeBtn?.textContent).not.toContain('Confirm');
  });

  it('strips bidi/zero-width characters from the display but removes by the raw name', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'or\u202eigin',
          fetchUrl: 'https://example.com/\u202eevil\u2029x',
          pushUrl: 'https://example.com/\u202eevil\u2029x',
        },
        {
          // RLM (U+200F): a bidi mark outside the \u202a-\u202e range —
          // the Default_Ignorable extension of the sanitizer's class.
          name: 'upstre\u200fam',
          fetchUrl: 'https://example.com/u/r.git',
          pushUrl: 'https://example.com/u/r.git',
        },
      ],
    });
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();

    const row = document.body.querySelector(
      '[data-testid="remote-remove-or\u202eigin"]',
    )?.parentElement;
    // The rendered text carries the stripped form, not the raw override or
    // the paragraph separator (a CSS segment break).
    expect(row?.textContent).toContain('origin');
    expect(row?.textContent).not.toContain('\u202e');
    expect(row?.textContent).not.toContain('\u2029');
    expect(row?.textContent).toContain('https://example.com/evilx');

    // The RLM-bearing name renders stripped too.
    const rlmRow = document.body.querySelector(
      '[data-testid="remote-remove-upstre\u200fam"]',
    )?.parentElement;
    expect(rlmRow?.textContent).toContain('upstream');
    expect(rlmRow?.textContent).not.toContain('\u200f');

    // The search filter matches what the row renders, so typing the
    // displayed name still finds it — for both character classes.
    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search remotes"]',
    );
    expect(search).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      nativeSetter?.call(search, 'upstream');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(
      document.body.querySelector(
        '[data-testid="remote-remove-upstre\u200fam"]',
      ),
    ).toBeTruthy();
    act(() => {
      nativeSetter?.call(search, 'origin');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-or\u202eigin"]'),
    ).toBeTruthy();
    act(() => {
      nativeSetter?.call(search, '');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    // Removal still targets the raw configured name.
    clickTestId('remote-remove-or\u202eigin');
    clickTestId('remote-remove-or\u202eigin');
    await flush();
    expect(workspaceGitRemoteRemove).toHaveBeenCalledWith(
      'or\u202eigin',
      undefined,
      GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
    );
    // The footer renders the success message verbatim too, so it carries
    // the stripped name, not the raw override.
    expect(footerText()).toContain('Removed remote origin');
    expect(footerText()).not.toContain('\u202e');
  });

  it('does not carry the action-finding query into the remotes filter', async () => {
    mountWithBranches();
    await flush();

    // Typing "remotes" is the natural way to find the action row; entering
    // the panel must not keep it as the list filter.
    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search for branches and actions"]',
    );
    expect(search).toBeTruthy();
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      nativeSetter?.call(search, 'remotes');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    clickTestId('branch-picker-manage-remotes');
    await flush();

    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
    expect(search?.value).toBe('');
  });

  it('re-reads only when the refusal says the list is stale', async () => {
    // 404 no_such_remote means a row on screen no longer exists: re-read.
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        404,
        { error: 'no_such_remote', message: "error: No such remote: 'gone'" },
        'POST /workspaces/:workspace/git/remote/remove: no_such_remote',
      ),
    );
    await openRemotesView();
    let calls = workspaceGitRemotes.mock.calls.length;
    const branchCalls = workspaceGitBranches.mock.calls.length;
    const statusCalls = workspaceGit.mock.calls.length;
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    expect(workspaceGitRemotes.mock.calls.length).toBeGreaterThan(calls);
    // no_such_remote proves the refs and upstream config are gone too:
    // refresh the branch list and the sidebar chip.
    expect(workspaceGitBranches.mock.calls.length).toBeGreaterThan(branchCalls);
    expect(workspaceGit.mock.calls.length).toBeGreaterThan(statusCalls);
    // A refused removal disarms the two-click confirm on the surviving
    // row: the next single click must re-arm, not execute.
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).not.toContain('Confirm');
    const removeCalls = workspaceGitRemoteRemove.mock.calls.length;
    clickTestId('remote-remove-origin');
    expect(workspaceGitRemoteRemove.mock.calls.length).toBe(removeCalls);
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).toContain('Confirm');

    // A 400 validation refusal leaves the usable list and the typed draft
    // on screen: no re-read, no teardown.
    workspaceGitRemoteAdd.mockRejectedValue(
      new DaemonHttpError(
        400,
        { error: 'invalid_remote_name', message: 'Invalid remote name' },
        'POST /workspaces/:workspace/git/remote: invalid_remote_name',
      ),
    );
    calls = workspaceGitRemotes.mock.calls.length;
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-name"]',
    );
    expect(nameInput).toBeTruthy();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      setter?.call(nameInput, 'origin/main');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const urlInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-url"]',
    );
    act(() => {
      setter?.call(urlInput, 'https://example.com/o/r.git');
      urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickTestId('remote-add-submit');
    await flush();
    expect(workspaceGitRemotes.mock.calls.length).toBe(calls);
    expect(
      document.body.querySelector('input[data-testid="remote-add-name"]'),
    ).toBeTruthy();
    // The typed draft and the usable list survive the refusal.
    expect(nameInput?.value).toBe('origin/main');
    expect(urlInput?.value).toBe('https://example.com/o/r.git');
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
    expect(footerText()).toContain('Invalid remote name');

    // 409 remote_already_exists on ADD means a remote the panel does not
    // show already exists: silent re-read, rows retained.
    workspaceGitRemoteAdd.mockRejectedValue(
      new DaemonHttpError(
        409,
        {
          error: 'remote_already_exists',
          message: 'error: remote fork already exists.',
        },
        'POST /workspaces/:workspace/git/remote: remote_already_exists',
      ),
    );
    calls = workspaceGitRemotes.mock.calls.length;
    act(() => {
      setter?.call(nameInput, 'fork');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(urlInput, 'https://example.com/f/r.git');
      urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickTestId('remote-add-submit');
    await flush();
    expect(workspaceGitRemotes.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps rows on screen while a stale-list re-read is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        404,
        { error: 'no_such_remote', message: "error: No such remote: 'gone'" },
        'POST /workspaces/:workspace/git/remote/remove: no_such_remote',
      ),
    );
    await openRemotesView();
    workspaceGitRemotes.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // The silent re-read must not swap the rows for the loading placeholder.
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('Loading remotes');
    // The refusal catch AWAITS the re-read, so the settle-time effects
    // (focus restore, busy release) only run after the list converges.
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeNull();

    // The add path keeps the fire-and-forget re-read: a mutation that
    // completes while that read is in flight still wins when it lands.
    let releaseAdd: ((value: unknown) => void) | undefined;
    workspaceGitRemoteAdd
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          {
            error: 'remote_already_exists',
            message: 'error: remote fork already exists.',
          },
          'POST /workspaces/:workspace/git/remote: remote_already_exists',
        ),
      )
      .mockResolvedValue({
        v: 1,
        workspaceCwd: '/repo',
        remotes: [
          {
            name: 'fork',
            fetchUrl: 'https://example.com/f/r.git',
            pushUrl: 'https://example.com/f/r.git',
            extraFetchUrls: 0,
            extraPushUrls: 0,
            promisor: false,
            customRefspec: false,
            otherSettings: 0,
          },
        ],
      });
    workspaceGitRemotes.mockImplementation(
      () => new Promise((resolve) => (releaseAdd = resolve)),
    );
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-name"]',
    );
    const urlInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-url"]',
    );
    act(() => {
      setter?.call(nameInput, 'fork');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(urlInput, 'https://example.com/f/r.git');
      urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // First submit is refused (stale re-read held); the retry succeeds.
    clickTestId('remote-add-submit');
    await flush();
    clickTestId('remote-add-submit');
    await flush();
    await act(async () => {
      releaseAdd?.(defaultRemotesResult());
    });
    await flush();
    // The older read must not repaint its stale snapshot over the row the
    // successful add just put on screen.
    expect(
      document.body.querySelector('[data-testid="remote-remove-fork"]'),
    ).toBeTruthy();
  });

  it('Escape leaves the remotes view instead of dismissing the popover', async () => {
    await openRemotesView();
    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content).toBeTruthy();
    // Radix dismisses on Escape unless the handler prevents default, and
    // the cancelable event is the only carrier of that witness here (the
    // mock renders content unconditionally).
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      content?.dispatchEvent(escape);
    });
    expect(escape.defaultPrevented).toBe(true);
    await flush();
    // Back on the branches view: the manage-remotes row is visible again and
    // the panel header is gone.
    expect(
      document.body.querySelector(
        '[data-testid="branch-picker-manage-remotes"]',
      ),
    ).toBeTruthy();
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeNull();
  });

  it('renders a visible label for a name that strips to empty', async () => {
    const result: DaemonGitRemotesResult = {
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: '\u200b\u200c',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    };
    workspaceGitRemotes.mockResolvedValue(result);
    await openRemotesView();
    const row = document.body.querySelector(
      '[data-testid="remote-remove-\u200b\u200c"]',
    )?.parentElement;
    expect(row?.textContent).toContain('(invisible name)');
    // The armed confirm names the object it destroys.
    clickTestId('remote-remove-\u200b\u200c');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-\u200b\u200c"]')
        ?.textContent,
    ).toContain('Confirm');
    // ...through the escaped raw name, so two lookalike rows cannot
    // announce the same destructive step.
    expect(
      document.body
        .querySelector('[data-testid="remote-remove-\u200b\u200c"]')
        ?.getAttribute('aria-label'),
    ).toBe('Confirm removing (invisible name) \\u{200b}\\u{200c}');
  });

  it('renders the removal-consequence badge and sanitizes the filter value', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
          extraFetchUrls: 1,
          extraPushUrls: 0,
          promisor: true,
          partialCloneFilter: 'blob:none\u202eevil',
          customRefspec: true,
          otherSettings: 2,
        },
        {
          // The filter is destroyed by removal even with the promisor
          // flag unset, so the badge must fire on the filter alone; the
          // single other setting pins the singular badge copy.
          name: 'mirror',
          fetchUrl: 'https://example.com/m/r.git',
          pushUrl: 'https://example.com/m/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          partialCloneFilter: 'blob:none',
          customRefspec: false,
          otherSettings: 1,
        },
      ],
    });
    await openRemotesView();
    const badge = document.body.querySelector('[class*="remoteBadge"]');
    expect(badge).toBeTruthy();
    const text = badge?.textContent ?? '';
    expect(text).toContain('partial clone');
    expect(text).toContain('blob:none');
    expect(text).not.toContain('\u202e');
    expect(badge?.getAttribute('title')).not.toContain('\u202e');
    expect(text).toContain('custom refspec');
    expect(text).toContain('+1 URL');
    expect(text).toContain('2 other settings');
    const badges = document.body.querySelectorAll('[class*="remoteBadge"]');
    expect(badges).toHaveLength(2);
    expect(badges[1]?.textContent).toContain('partial clone (blob:none)');
    expect(badges[1]?.textContent).toContain('1 other setting');
  });

  it('restores focus to the manage-remotes row when leaving the view', async () => {
    await openRemotesView();
    clickTestId('remotes-back');
    await flush();
    expect(document.activeElement).toBe(
      document.body.querySelector(
        '[data-testid="branch-picker-manage-remotes"]',
      ),
    );
  });

  it('re-reads when the removal verification reports the section survived', async () => {
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        409,
        {
          error: 'remote_still_configured',
          message: 'remote still configured after removal',
        },
        'POST /workspaces/:workspace/git/remote/remove: remote_still_configured',
      ),
    );
    await openRemotesView();
    const calls = workspaceGitRemotes.mock.calls.length;
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    expect(workspaceGitRemotes.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps the sentence boundary of a multi-line git error in the footer', async () => {
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        409,
        {
          error: 'git_config_write_failed',
          message:
            "error: could not lock config file .git/config: File exists\nfatal: could not remove config section 'remote.origin'",
        },
        'POST /workspaces/:workspace/git/remote/remove: git_config_write_failed',
      ),
    );
    await openRemotesView();
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    const footer = document.body.querySelector('[class*="statusBar"]');
    // The two git sentences stay separated — a stripped \n would fuse
    // them into 'File existsfatal:'.
    expect(footer?.textContent).toContain('File exists fatal:');
    expect(footer?.textContent).not.toContain('File existsfatal');
  });

  it('marks canonical-equivalence and script-mixing lookalikes', async () => {
    const remote = (name: string) => ({
      name,
      fetchUrl: `https://example.com/${encodeURIComponent(name)}/r.git`,
      pushUrl: `https://example.com/${encodeURIComponent(name)}/r.git`,
      extraFetchUrls: 0,
      extraPushUrls: 0,
      promisor: false,
      customRefspec: false,
      otherSettings: 0,
    });
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        remote('origin'),
        // A Cyrillic \u043e in a Latin name: inks identically to the
        // row above, no invisible character involved.
        remote('оrigin'),
        // Canonical twins: composed vs decomposed é.
        remote('café'),
        remote('cafe\u0301'),
        // A legitimate non-ASCII name must NOT be marked.
        remote('上游'),
      ],
    });
    await openRemotesView();

    const rowOf = (name: string) =>
      document.body.querySelector(`[data-testid="remote-remove-${name}"]`)
        ?.parentElement;
    // The plain Latin row stays unmarked; its Cyrillic twin is marked
    // and its tooltip spells the confusable out as a codepoint.
    expect(rowOf('origin')?.textContent).not.toContain('(hidden characters)');
    expect(rowOf('оrigin')?.textContent).toContain('(hidden characters)');
    expect(
      rowOf('оrigin')
        ?.querySelector('[data-testid="remote-name"]')
        ?.getAttribute('title'),
    ).toContain('\\u{43e}');
    // Canonical twins: the decomposed (NFD) row is marked — the unusual
    // spelling carries the marker, like the ZWSP precedent — while the
    // NFC row stays plain.
    expect(rowOf('café')?.textContent).not.toContain('(hidden characters)');
    expect(rowOf('cafe\u0301')?.textContent).toContain('(hidden characters)');
    expect(
      rowOf('cafe\u0301')
        ?.querySelector('[data-testid="remote-name"]')
        ?.getAttribute('title'),
    ).toContain('\\u{301}');
    // The legitimate non-ASCII name renders as itself, unmarked.
    expect(rowOf('上游')?.textContent).not.toContain('(hidden characters)');
    expect(
      rowOf('上游')
        ?.querySelector('[data-testid="remote-name"]')
        ?.getAttribute('title'),
    ).toBe('上游');
  });

  it('tells apart rows whose sanitized names collide', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          // A ZWSP lookalike of the row above: both sanitize to "origin",
          // so the marker, the tooltip and the aria-label must carry what
          // distinguishes the two identities.
          name: 'ori\u200bgin',
          fetchUrl: 'https://example.com/evil/r.git',
          pushUrl: 'https://example.com/evil/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          name: 'mirror',
          fetchUrl: 'https://example.com/m/r.git',
          pushUrl: 'https://example.com/m/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          // Same URL as mirror modulo a ZWSP: the name marker cannot fire,
          // so the URL tooltip must carry the distinction.
          name: 'mirror2',
          fetchUrl: 'https://example.com/m/\u200br.git',
          pushUrl: 'https://example.com/m/\u200br.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();

    const plain = document.body.querySelector(
      '[data-testid="remote-remove-origin"]',
    )?.parentElement;
    const lookalike = document.body.querySelector(
      '[data-testid="remote-remove-ori\u200bgin"]',
    )?.parentElement;
    expect(plain?.textContent).toContain('origin');
    expect(plain?.textContent).not.toContain('(hidden characters)');
    expect(lookalike?.textContent).toContain('origin (hidden characters)');
    // The tooltip names the raw name with its invisible character as a
    // visible codepoint escape; an ordinary name tooltips as itself so a
    // truncated name stays readable.
    expect(
      lookalike?.querySelector('[class*="remoteName"]')?.getAttribute('title'),
    ).toBe('ori\\u{200b}gin');
    expect(
      plain?.querySelector('[class*="remoteName"]')?.getAttribute('title'),
    ).toBe('origin');
    // URLs that differ only by invisible characters tooltip differently.
    const mirrorUrl = document.body
      .querySelector('[data-testid="remote-remove-mirror"]')
      ?.parentElement?.querySelector('[class*="remoteUrl"]');
    const mirror2Url = document.body
      .querySelector('[data-testid="remote-remove-mirror2"]')
      ?.parentElement?.querySelector('[class*="remoteUrl"]');
    expect(mirrorUrl?.getAttribute('title')).toBe(
      'https://example.com/m/r.git',
    );
    expect(mirror2Url?.getAttribute('title')).toContain('\\u{200b}');
    expect(mirror2Url?.getAttribute('title')).not.toBe(
      mirrorUrl?.getAttribute('title'),
    );

    expect(
      document.body
        .querySelector('[data-testid="remote-remove-origin"]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove origin');
    expect(
      document.body
        .querySelector('[data-testid="remote-remove-ori\u200bgin"]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove origin (hidden characters) ori\\u{200b}gin');

    // Removal still targets the raw configured name.
    clickTestId('remote-remove-ori\u200bgin');
    clickTestId('remote-remove-ori\u200bgin');
    await flush();
    expect(workspaceGitRemoteRemove).toHaveBeenCalledWith(
      'ori\u200bgin',
      undefined,
      GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
    );
  });

  it('tells apart rows whose names differ only by whitespace', async () => {
    // CSS collapses edge whitespace out of the inked text, so `origin`
    // and `origin ` present one row and one aria-label — the exact
    // hand-edited-config threat the hidden-characters marker exists for.
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          name: 'origin ',
          fetchUrl: 'https://example.com/evil/r.git',
          pushUrl: 'https://example.com/evil/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          // URLs differing only by whitespace must not tooltip identically.
          name: 'mirror',
          fetchUrl: 'https://example.com/m/r.git',
          pushUrl: 'https://example.com/m/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          name: 'mirror2',
          fetchUrl: 'https://example.com/m/r.git ',
          pushUrl: 'https://example.com/m/r.git ',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
        {
          // An internal whitespace run renders collapsed, and the search
          // must still find the row by its displayed (collapsed) text.
          name: 'upstream  x',
          fetchUrl: 'https://example.com/u/r.git',
          pushUrl: 'https://example.com/u/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();

    const plain = document.body.querySelector(
      '[data-testid="remote-remove-origin"]',
    )?.parentElement;
    const padded = document.body.querySelector(
      '[data-testid="remote-remove-origin "]',
    )?.parentElement;
    expect(plain?.textContent).not.toContain('(hidden characters)');
    expect(padded?.textContent).toContain('(hidden characters)');
    // The tooltip and the aria-label spell the whitespace out as a
    // codepoint escape, so the two identities stay tellable apart.
    expect(
      padded?.querySelector('[class*="remoteName"]')?.getAttribute('title'),
    ).toBe('origin\\u{20}');
    expect(
      plain?.querySelector('[class*="remoteName"]')?.getAttribute('title'),
    ).toBe('origin');
    expect(
      document.body
        .querySelector('[data-testid="remote-remove-origin"]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove origin');
    expect(
      document.body
        .querySelector('[data-testid="remote-remove-origin "]')
        ?.getAttribute('aria-label'),
    ).toBe('Remove origin (hidden characters) origin\\u{20}');

    // URLs differing only by whitespace tooltip differently, with the
    // whitespace spelled out as a codepoint escape.
    const mirrorUrl = document.body
      .querySelector('[data-testid="remote-remove-mirror"]')
      ?.parentElement?.querySelector('[class*="remoteUrl"]');
    const mirror2Url = document.body
      .querySelector('[data-testid="remote-remove-mirror2"]')
      ?.parentElement?.querySelector('[class*="remoteUrl"]');
    expect(mirrorUrl?.getAttribute('title')).toBe(
      'https://example.com/m/r.git',
    );
    expect(mirror2Url?.getAttribute('title')).toBe(
      'https://example.com/m/r.git\\u{20}',
    );

    // The search finds a whitespace-collapsed name by its displayed text.
    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search remotes"]',
    );
    expect(search).toBeTruthy();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, 'upstream x');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    const internalRow = document.body.querySelector(
      '[data-testid="remote-remove-upstream  x"]',
    );
    expect(internalRow).toBeTruthy();
    // The internal run gets the same marker treatment: the row flags, and
    // the tooltip and aria-label spell the run out as codepoint escapes.
    expect(internalRow?.parentElement?.textContent).toContain(
      '(hidden characters)',
    );
    expect(
      internalRow?.parentElement
        ?.querySelector('[class*="remoteName"]')
        ?.getAttribute('title'),
    ).toBe('upstream\\u{20}\\u{20}x');
    expect(internalRow?.getAttribute('aria-label')).toBe(
      'Remove upstream x (hidden characters) upstream\\u{20}\\u{20}x',
    );
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, '');
      search?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();

    // Removal still targets the raw configured name, padding included.
    clickTestId('remote-remove-origin ');
    clickTestId('remote-remove-origin ');
    await flush();
    expect(workspaceGitRemoteRemove).toHaveBeenCalledWith(
      'origin ',
      undefined,
      GIT_REMOTE_MUTATION_FETCH_TIMEOUT_MS,
    );
  });

  it('refreshes the branch list when a remove fails on the config write', async () => {
    // git deletes refs/remotes/<name>/* before removing the config
    // section, so a lock-failed section write leaves the branch list
    // stale even though the remote row itself survives.
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockImplementation(
      () => new Promise((_, reject) => (release = reject)),
    );
    await openRemotesView();
    const branchCalls = workspaceGitBranches.mock.calls.length;
    const remoteCalls = workspaceGitRemotes.mock.calls.length;
    const statusCalls = workspaceGit.mock.calls.length;
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="remote-remove-origin"]',
    );
    act(() => {
      button?.focus();
    });
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // jsdom never blurs a control when it becomes disabled, unlike real
    // browsers: simulate the in-flight blur so the settle restore is
    // what puts focus back.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await act(async () => {
      release?.(
        new DaemonHttpError(
          409,
          {
            error: 'git_config_write_failed',
            message: "error: Could not remove config section 'remote.origin'",
          },
          'POST /workspaces/:workspace/git/remote/remove: git_config_write_failed',
        ),
      );
    });
    await flush();
    expect(workspaceGitBranches.mock.calls.length).toBeGreaterThan(branchCalls);
    expect(workspaceGit.mock.calls.length).toBeGreaterThan(statusCalls);
    // The remote list is not stale here (the section survived): no re-read.
    expect(workspaceGitRemotes.mock.calls.length).toBe(remoteCalls);
    // ...and the surviving row's button takes the focus back.
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    );
  });

  it('leaves search focus alone when the remove button never held focus', async () => {
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();
    const search = document.body.querySelector<HTMLInputElement>(
      'input[placeholder="Search remotes"]',
    );
    act(() => {
      search?.focus();
    });
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // Programmatic/Safari-style activation never moved focus onto the row
    // button, so the settle effect must not move it anywhere either.
    expect(document.activeElement).toBe(search);
  });

  it('resets the remotes view and restores no focus after a workspace switch', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    const onBranchChanged = vi.fn();
    mountWithBranches(undefined, { gitCwd: '/repo', onBranchChanged });
    await flush();
    clickTestId('branch-picker-manage-remotes');
    await flush();
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="remote-remove-origin"]',
    );
    act(() => {
      button?.focus();
    });
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // The workspace switches while the mutation is in flight: the view
    // resets to branches, so focus lent to workspace A's control can
    // never be restored onto workspace B's panel — carried by the view
    // reset plus the settle effect's view-exit clearing.
    mount({ gitCwd: '/repo2' });
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo2', remotes: [] });
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeNull();
    const active = document.activeElement as HTMLElement | null;
    expect(active?.dataset.testid).not.toBe('remote-remove-origin');
    // The cross-workspace staleness guard is what drops the late
    // response: workspace A's success must never reach workspace B's
    // footer, branches, or callback.
    expect(footerText()).not.toContain('Removed remote origin');
    expect(onBranchChanged).not.toHaveBeenCalled();
  });

  it('refreshes the branch list when the removal verification survives', async () => {
    // git exits 0 over a split section after deleting the tracking refs:
    // the row survives (silent re-read) AND the branch list is stale.
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        409,
        {
          error: 'remote_still_configured',
          message: 'remote still configured after removal',
        },
        'POST /workspaces/:workspace/git/remote/remove: remote_still_configured',
      ),
    );
    await openRemotesView();
    const branchCalls = workspaceGitBranches.mock.calls.length;
    const remoteCalls = workspaceGitRemotes.mock.calls.length;
    const statusCalls = workspaceGit.mock.calls.length;
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    expect(workspaceGitBranches.mock.calls.length).toBeGreaterThan(branchCalls);
    expect(workspaceGit.mock.calls.length).toBeGreaterThan(statusCalls);
    expect(workspaceGitRemotes.mock.calls.length).toBeGreaterThan(remoteCalls);
  });

  it('keeps rows and draft when the silent re-read itself fails', async () => {
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        404,
        { error: 'no_such_remote', message: "error: No such remote: 'gone'" },
        'POST /workspaces/:workspace/git/remote/remove: no_such_remote',
      ),
    );
    await openRemotesView();
    // The background re-read the refusal triggers fails (draining daemon):
    // a silent read must neither raise the placeholder nor replace the
    // usable rows and the typed draft with its own error.
    workspaceGitRemotes.mockRejectedValue(
      new DaemonHttpError(
        503,
        {
          error: 'workspace_runtime_unavailable',
          message: 'runtime unavailable',
        },
        'GET /workspaces/:workspace/git/remotes: workspace_runtime_unavailable',
      ),
    );
    setInput('remote-add-name', 'fork');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
    // The typed draft survives the failed silent re-read (not just the
    // form's existence).
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[data-testid="remote-add-name"]',
      )?.value,
    ).toBe('fork');
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[data-testid="remote-add-url"]',
      )?.value,
    ).toBe('https://example.com/f/r.git');
    expect(document.body.textContent).not.toContain('runtime unavailable');
  });

  it('disables the add inputs while a mutation is in flight', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteAdd.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    await openRemotesView();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-name"]',
    );
    const urlInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-url"]',
    );
    expect(nameInput).toBeTruthy();
    expect(urlInput).toBeTruthy();
    act(() => {
      setter?.call(nameInput, 'fork');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(urlInput, 'https://example.com/f/r.git');
      urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    clickTestId('remote-add-submit');
    await flush();
    expect(nameInput?.disabled).toBe(true);
    expect(urlInput?.disabled).toBe(true);
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
    });
    await flush();
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[data-testid="remote-add-name"]',
      )?.disabled,
    ).toBe(false);
  });

  it('restores focus to the back button after a successful removal', async () => {
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="remote-remove-origin"]',
    );
    act(() => {
      button?.focus();
    });
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeNull();
    // The row is gone with its focused button: land on the panel's back
    // button rather than document.body.
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="remotes-back"]'),
    );
  });

  it('restores focus to the back button when a refused removal unmounts the row', async () => {
    // no_such_remote: the silent re-read drops the ghost row, so the
    // settle-time focus restore must land on the back button, not on a
    // remove button that is about to unmount.
    workspaceGitRemoteRemove.mockRejectedValue(
      new DaemonHttpError(
        404,
        { error: 'no_such_remote', message: "error: No such remote: 'gone'" },
        'POST /workspaces/:workspace/git/remote/remove: no_such_remote',
      ),
    );
    await openRemotesView();
    // The silent re-read after the refusal converges on the terminal's
    // truth: origin is gone.
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    const button = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="remote-remove-origin"]',
    );
    act(() => {
      button?.focus();
    });
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="remotes-back"]'),
    );
  });

  it('restores add-form focus after a mutation settles', async () => {
    workspaceGitRemoteAdd.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-name"]',
    );
    const urlInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-url"]',
    );
    expect(nameInput).toBeTruthy();
    expect(urlInput).toBeTruthy();
    act(() => {
      setter?.call(nameInput, 'fork');
      nameInput?.dispatchEvent(new Event('input', { bubbles: true }));
      setter?.call(urlInput, 'https://example.com/f/r.git');
      urlInput?.dispatchEvent(new Event('input', { bubbles: true }));
      urlInput?.focus();
    });
    act(() => {
      urlInput?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();
    // The success path clears the draft and puts focus on the name input
    // for the next remote, instead of leaving it on document.body.
    expect(document.activeElement).toBe(nameInput);
  });

  it('does not submit the add form on an IME-owned Enter', async () => {
    workspaceGitRemoteAdd.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();
    setInput('remote-add-name', 'shangyou');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-name"]',
    );
    // An IME-owned Enter commits the composition, not the form — in both
    // shapes the house documents (isComposing, and WebKit's keyCode 229
    // with isComposing already false).
    act(() => {
      nameInput?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    await flush();
    expect(workspaceGitRemoteAdd).not.toHaveBeenCalled();
    act(() => {
      nameInput?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          bubbles: true,
        }),
      );
    });
    await flush();
    expect(workspaceGitRemoteAdd).not.toHaveBeenCalled();
    // The URL input carries the identical guard.
    const urlInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-url"]',
    );
    act(() => {
      urlInput?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    await flush();
    expect(workspaceGitRemoteAdd).not.toHaveBeenCalled();
    act(() => {
      urlInput?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          bubbles: true,
        }),
      );
    });
    await flush();
    expect(workspaceGitRemoteAdd).not.toHaveBeenCalled();
    // A plain Enter still submits — the guard does not swallow the real
    // key.
    act(() => {
      nameInput?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    await flush();
    expect(workspaceGitRemoteAdd).toHaveBeenCalledTimes(1);
  });

  it('restores focus inside a shadow-portal root', async () => {
    // In the shadowDom/{portals:true} embedding the popover content lives
    // in a shadow root: document.activeElement retargets to the host and
    // document.body lookups cannot cross the boundary, so the focus
    // capture and restore must resolve from the content's own root.
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    workspaceGitBranches.mockResolvedValue(BRANCHES);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    container = document.createElement('div');
    shadow.appendChild(container);
    root = createRoot(container);
    mount();
    try {
      await flush();
      // The open-time autofocus timer must land before focus moves.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 60));
      });
      const manage = shadow.querySelector(
        '[data-testid="branch-picker-manage-remotes"]',
      );
      act(() => {
        manage?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();
      const button = shadow.querySelector<HTMLButtonElement>(
        '[data-testid="remote-remove-origin"]',
      );
      expect(button).toBeTruthy();
      act(() => {
        button?.focus();
      });
      expect(shadow.activeElement).toBe(button);
      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();
      act(() => {
        shadow
          .querySelector('[data-testid="remote-remove-origin"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await flush();
      expect(
        shadow.querySelector('[data-testid="remote-remove-origin"]'),
      ).toBeNull();
      // The row is gone with its focused button: the restore lands on the
      // panel's back button INSIDE the shadow root — not the host, and
      // not document.body.
      expect(shadow.activeElement).toBe(
        shadow.querySelector('[data-testid="remotes-back"]'),
      );
    } finally {
      host.remove();
    }
  });

  it('does not restore focus into another mounted popover after a mid-mutation dismissal', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteAdd.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    await openRemotesView();
    setInput('remote-add-name', 'fork');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    // Focus the URL input so the mutation remembers it as the restore
    // target.
    act(() => {
      document.body
        .querySelector<HTMLInputElement>('input[data-testid="remote-add-url"]')
        ?.focus();
    });
    clickTestId('remote-add-submit');
    await flush();
    // Dismiss mid-flight: the content unmounts, and the settle must not
    // fall back to a document-wide lookup that can land on ANOTHER
    // popover instance's control.
    mount({ open: false });
    await flush();
    const foreign = document.createElement('input');
    foreign.setAttribute('data-testid', 'remote-add-name');
    document.body.appendChild(foreign);
    try {
      await act(async () => {
        release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
      });
      await flush();
      expect(document.activeElement).not.toBe(foreign);
    } finally {
      foreign.remove();
    }
  });

  it('falls back to the search box when the manage row is busy', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    await openRemotesView();
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // The mutation is still in flight, so the manage row is disabled and
    // cannot take focus: the search box must.
    clickTestId('remotes-back');
    await flush();
    expect(document.activeElement).toBe(
      document.body.querySelector(
        'input[placeholder="Search for branches and actions"]',
      ),
    );
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
    });
    await flush();
  });

  it('disarms the armed confirm when its row leaves the filtered list', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        defaultRemotesResult().remotes[0]!,
        {
          name: 'upstream',
          fetchUrl: 'https://example.com/u/r.git',
          pushUrl: 'https://example.com/u/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    await openRemotesView();
    clickTestId('remote-remove-upstream');
    expect(
      document.body.querySelector('[data-testid="remote-remove-upstream"]')
        ?.textContent,
    ).toContain('Confirm');
    // Filter the armed row out: the arm must not survive as a pre-armed
    // trap for the next single click.
    setInput('remotes-search', 'origin');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-upstream"]'),
    ).toBeNull();
    setInput('remotes-search', '');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-upstream"]')
        ?.textContent,
    ).not.toContain('Confirm');
  });

  it('shows the loading state on the first non-silent remotes read', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemotes.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    mountWithBranches();
    await flush();
    clickTestId('branch-picker-manage-remotes');
    await flush();
    const content = document.body.querySelector('[data-test-popover-content]');
    expect(content?.textContent).toContain('Loading remotes');
    expect(content?.textContent).not.toContain('No remotes configured');
    expect(
      document.body.querySelector('input[data-testid="remote-add-name"]'),
    ).toBeNull();
    await act(async () => {
      release?.(defaultRemotesResult());
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
  });

  it('scopes the remotes read to the workspace cwd', async () => {
    await openRemotesView({ gitCwd: '/repo/wt' });
    expect(workspaceGitRemotes).toHaveBeenCalledWith('/repo/wt');
  });

  it('clears a standing pull-resolution panel when entering the view', async () => {
    workspaceGitPull.mockRejectedValueOnce(dirtyTreeError());
    mountWithBranches();
    await flush();
    clickButton('Update Project');
    await flush();
    expect(document.body.textContent).toContain('Stash Changes and Update');

    clickTestId('branch-picker-manage-remotes');
    await flush();
    expect(document.body.textContent).not.toContain('Stash Changes and Update');
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeTruthy();
  });

  it('disarms a pending remove confirm when an add is submitted', async () => {
    workspaceGitRemoteAdd.mockResolvedValue(defaultRemotesResult());
    await openRemotesView();
    clickTestId('remote-remove-origin');
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).toContain('Confirm');
    setInput('remote-add-name', 'fork');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    clickTestId('remote-add-submit');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).not.toContain('Confirm');
  });

  it('sanitizes config-sourced git error text before the footer', async () => {
    workspaceGitRemoteAdd.mockRejectedValue(
      new DaemonHttpError(
        409,
        {
          error: 'remote_already_exists',
          message: 'error: remote ori\u200bgin already exists.',
        },
        'POST /workspaces/:workspace/git/remote: remote_already_exists',
      ),
    );
    await openRemotesView();
    setInput('remote-add-name', 'ori\u200bgin');
    setInput('remote-add-url', 'https://example.com/o/r.git');
    clickTestId('remote-add-submit');
    await flush();
    expect(footerText()).toContain('already exists');
    expect(footerText()).not.toContain('ori\u200bgin');
  });

  it('releases the remove buttons without awaiting the branch refresh', async () => {
    workspaceGitRemoteRemove.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [],
    });
    await openRemotesView();
    // Installed AFTER the mount's seeding: mountWithBranches re-seeds
    // workspaceGitBranches via mockResolvedValue (which REPLACES the
    // implementation), so the never-resolving listing must be the LAST
    // word before the removal's background refresh picks it up.
    workspaceGitBranches.mockImplementation(() => new Promise(() => {}));
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    // The branch-listing round trip must not hold the remotes view
    // hostage: busy clears as soon as the removal lands.
    expect(
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="remotes-back"]',
      )?.disabled,
    ).toBe(false);
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[data-testid="remote-add-name"]',
      )?.disabled,
    ).toBe(false);
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="remotes-back"]'),
    );
  });

  it('clears the search filter after a successful add', async () => {
    workspaceGitRemoteAdd.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      remotes: [
        {
          name: 'fork',
          fetchUrl: 'https://example.com/f/r.git',
          pushUrl: 'https://example.com/f/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    await openRemotesView();
    setInput('remotes-search', 'upstream');
    await flush();
    setInput('remote-add-name', 'fork');
    setInput('remote-add-url', 'https://example.com/f/r.git');
    clickTestId('remote-add-submit');
    await flush();
    expect(
      document.body.querySelector<HTMLInputElement>(
        'input[placeholder="Search remotes"]',
      )?.value,
    ).toBe('');
    expect(
      document.body.querySelector('[data-testid="remote-remove-fork"]'),
    ).toBeTruthy();
  });

  it('sanitizes the search needle the way the rows are sanitized', async () => {
    await openRemotesView();
    setInput('remotes-search', 'ori\u200bgin');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
  });

  it('matches the search against the extras badge text', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
          partialCloneFilter: 'blob:none',
        },
      ],
    });
    await openRemotesView();
    setInput('remotes-search', 'blob:none');
    await flush();
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]'),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('No remotes match');
  });

  it('disarms the confirm with Escape before leaving the view', async () => {
    const onOpenChange = vi.fn();
    await openRemotesView({ onOpenChange });
    clickTestId('remote-remove-origin');
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).toContain('Confirm');
    const content = document.body.querySelector('[data-test-popover-content]');
    act(() => {
      content?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    // The armed tier consumed the cancelable Escape: no dismissal fired.
    expect(onOpenChange).not.toHaveBeenCalled();
    // The universal cancel disarms the destructive confirm instead of
    // throwing the user out of the view.
    expect(
      document.body.querySelector('[data-testid="remote-remove-origin"]')
        ?.textContent,
    ).not.toContain('Confirm');
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeTruthy();
    // The next Escape takes the view tier.
    act(() => {
      content?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeNull();
    // The view tier prevented it too: still no popover dismissal.
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('lets an IME-owned Escape cancel the composition without tearing down the view', async () => {
    const onOpenChange = vi.fn();
    await openRemotesView({ onOpenChange });
    setInput('remote-add-name', 'shangyou');
    const nameInput = document.body.querySelector<HTMLInputElement>(
      'input[data-testid="remote-add-name"]',
    );
    // A composition-cancelling Escape (isComposing) must be masked from
    // the capture-phase dismiss layer: no view teardown, no dismissal,
    // and the native composition cancel is not suppressed. The mask
    // restores the key before the event reaches the focused input.
    const composing = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      nameInput?.dispatchEvent(composing);
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(composing.defaultPrevented).toBe(false);
    expect(composing.key).toBe('Escape');
    expect(nameInput?.value).toBe('shangyou');
    // The WebKit shape: keyCode 229 with isComposing already false.
    const webkit = new KeyboardEvent('keydown', {
      key: 'Escape',
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      nameInput?.dispatchEvent(webkit);
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(webkit.defaultPrevented).toBe(false);
    // A plain Escape still takes the view tier — the mask only covers
    // IME-owned keydowns.
    const plain = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      nameInput?.dispatchEvent(plain);
    });
    await flush();
    expect(
      document.body.querySelector('[data-testid="remotes-back"]'),
    ).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(true);
  });

  it('dismisses the popover on an un-prevented Escape from the branches view', async () => {
    const onOpenChange = vi.fn();
    mountWithBranches(BRANCHES, { onOpenChange });
    await flush();
    const content = document.body.querySelector('[data-test-popover-content]');
    act(() => {
      content?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await flush();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('focuses the back button on view entry', async () => {
    await openRemotesView();
    expect(document.activeElement).toBe(
      document.body.querySelector('[data-testid="remotes-back"]'),
    );
  });

  it('tooltips both URLs when the push URL differs', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/push/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    await openRemotesView();
    const url = document.body
      .querySelector('[data-testid="remote-remove-origin"]')
      ?.parentElement?.querySelector('[class*="remoteUrl"]');
    expect(url?.getAttribute('title')).toBe(
      'fetch: https://example.com/o/r.git\npush: https://example.com/push/r.git',
    );
  });

  it('localizes the push/fetch tooltip labels', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/push/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: false,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    await openRemotesView({ language: 'zh-CN' });
    const url = document.body
      .querySelector('[data-testid="remote-remove-origin"]')
      ?.parentElement?.querySelector('[class*="remoteUrl"]');
    expect(url?.getAttribute('title')).toBe(
      '拉取: https://example.com/o/r.git\n推送: https://example.com/push/r.git',
    );
  });

  it('names the removal consequence in the armed confirm aria-label', async () => {
    workspaceGitRemotes.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      remotes: [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/o/r.git',
          pushUrl: 'https://example.com/o/r.git',
          extraFetchUrls: 0,
          extraPushUrls: 0,
          promisor: true,
          customRefspec: false,
          otherSettings: 0,
        },
      ],
    });
    await openRemotesView();
    clickTestId('remote-remove-origin');
    expect(
      document.body
        .querySelector('[data-testid="remote-remove-origin"]')
        ?.getAttribute('aria-label'),
    ).toBe('Confirm removing origin (partial clone)');
  });

  it('shows an in-flight spinner on the removing row', async () => {
    let release: ((value: unknown) => void) | undefined;
    workspaceGitRemoteRemove.mockImplementation(
      () => new Promise((resolve) => (release = resolve)),
    );
    await openRemotesView();
    clickTestId('remote-remove-origin');
    clickTestId('remote-remove-origin');
    await flush();
    const button = document.body.querySelector(
      '[data-testid="remote-remove-origin"]',
    );
    expect(button?.querySelector('svg')?.getAttribute('class')).toContain(
      'spin',
    );
    await act(async () => {
      release?.({ v: 1, workspaceCwd: '/repo', remotes: [] });
    });
    await flush();
  });
});
