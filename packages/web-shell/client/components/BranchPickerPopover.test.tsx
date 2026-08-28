// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

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
  workspaceGitCreateBranch,
  workspaceGitPull,
  workspaceClient,
} = vi.hoisted(() => {
  const workspaceGitBranches = vi.fn();
  const workspaceGitCreateBranch = vi.fn();
  const workspaceGitPull = vi.fn();
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
      workspaceGitPull,
    }),
  };
  return {
    workspaceGitBranches,
    workspaceGitCreateBranch,
    workspaceGitPull,
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

const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
const { I18nProvider } = await import('../i18n');
const { BranchPickerPopover } = await import('./BranchPickerPopover');

const BRANCHES = {
  v: 1,
  workspaceCwd: '/repo',
  available: true,
  local: [{ name: 'main', isHead: true }],
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
    open: boolean;
  }> = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BranchPickerPopover
          open={overrides.open ?? true}
          onOpenChange={overrides.onOpenChange ?? vi.fn()}
          workspaceCwd="/repo"
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
  workspaceGitPull.mockReset();
});

function mountWithBranches(): void {
  workspaceGitBranches.mockResolvedValue(BRANCHES);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mount({});
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
      300_000,
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
      300_000,
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
