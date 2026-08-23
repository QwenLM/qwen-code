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
  workspaceGitPush,
  workspaceClient,
} = vi.hoisted(() => {
  const workspaceGitBranches = vi.fn();
  const workspaceGitCreateBranch = vi.fn();
  const workspaceGitPull = vi
    .fn()
    .mockResolvedValue({ success: true, output: '' });
  const workspaceGitPush = vi
    .fn()
    .mockResolvedValue({ success: true, output: '' });
  // A stable client so the popover's memoized workspace handle (and thus its
  // fetch effect) stays referentially stable across renders.
  const workspaceClient = {
    workspaceByCwd: () => ({
      workspaceGitBranches,
      workspaceGitCheckout: vi.fn().mockResolvedValue(undefined),
      workspaceGitCreateBranch,
      workspaceGitPush,
      workspaceGitPull,
    }),
  };
  return {
    workspaceGitBranches,
    workspaceGitCreateBranch,
    workspaceGitPull,
    workspaceGitPush,
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
const { BranchPickerPopover } = await import('./BranchPickerPopover');

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
  }> = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BranchPickerPopover
          open
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

  it('offers stash and discard options when the pull hits a dirty tree', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    workspaceGitPull
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          { error: 'dirty_working_tree', message: 'would be overwritten' },
          'POST /workspaces/:workspace/git/pull: dirty_working_tree',
        ),
      )
      .mockResolvedValueOnce({ success: true, output: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();

    expect(document.body.textContent).toContain(
      'Update blocked by uncommitted changes',
    );
    expect(document.body.textContent).toContain('Stash Changes and Update');
    expect(document.body.textContent).toContain('Discard Changes and Update');

    clickButton('Stash Changes and Update');
    await flush();

    expect(workspaceGitPull).toHaveBeenLastCalledWith(
      { stash: true },
      undefined,
      300_000,
    );
    expect(document.body.textContent).not.toContain(
      'Update blocked by uncommitted changes',
    );
    expect(document.body.textContent).toContain('Updated successfully');
  });

  it('requires confirmation before discarding changes for a pull', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    workspaceGitPull
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          { error: 'dirty_working_tree', message: 'would be overwritten' },
          'POST /workspaces/:workspace/git/pull: dirty_working_tree',
        ),
      )
      .mockResolvedValueOnce({ success: true, output: '' });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();

    clickButton('Discard Changes and Update');
    await flush();

    expect(document.body.textContent).toContain('cannot be undone');
    expect(workspaceGitPull).toHaveBeenCalledTimes(1);

    clickButton('Discard and Update');
    await flush();

    expect(workspaceGitPull).toHaveBeenLastCalledWith(
      { force: true },
      undefined,
      300_000,
    );
  });

  it('keeps the resolution panel mounted while a stash pull is in flight', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    let resolvePull: ((value: unknown) => void) | undefined;
    workspaceGitPull
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          { error: 'dirty_working_tree', message: 'would be overwritten' },
          'POST /workspaces/:workspace/git/pull: dirty_working_tree',
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePull = resolve;
          }),
      );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();

    // While the stash pull runs, the panel stays mounted with its action
    // buttons instead of unmounting into the stale blocked status line.
    expect(document.body.textContent).toContain('Stash Changes and Update');

    resolvePull?.({ success: true, output: '' });
    await flush();

    expect(document.body.textContent).not.toContain(
      'Update blocked by uncommitted changes',
    );
    expect(document.body.textContent).toContain('Updated successfully');
  });

  it('shows a warning instead of success when the stash restore conflicts', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    workspaceGitPull
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          { error: 'dirty_working_tree', message: 'would be overwritten' },
          'POST /workspaces/:workspace/git/pull: dirty_working_tree',
        ),
      )
      .mockResolvedValueOnce({
        success: true,
        output: '',
        stashRestoreConflict: true,
      });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();
    clickButton('Stash Changes and Update');
    await flush();

    expect(document.body.textContent).toContain(
      'restoring your stashed changes conflicted',
    );
    expect(document.body.textContent).not.toContain('Updated successfully');
  });

  it('hides the stash option when the tree has unresolved merge conflicts', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    workspaceGitPull.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          error: 'dirty_working_tree',
          message: 'Pulling is not possible because you have unmerged files.',
        },
        'POST /workspaces/:workspace/git/pull: dirty_working_tree',
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();

    expect(document.body.textContent).toContain(
      'Update blocked by unresolved merge conflicts',
    );
    // Stash cannot recover unmerged entries, so the option is replaced by
    // an explanation; discard remains available.
    expect(document.body.textContent).not.toContain('Stash Changes and Update');
    expect(document.body.textContent).toContain('Discard Changes and Update');
  });

  it('does not offer the resolution panel for non-dirty pull errors', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    workspaceGitPull.mockRejectedValueOnce(
      new DaemonHttpError(
        400,
        { error: 'no_upstream', message: 'no tracking information' },
        'POST /workspaces/:workspace/git/pull: no_upstream',
      ),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();

    expect(document.body.textContent).not.toContain(
      'Update blocked by uncommitted changes',
    );
    expect(document.body.textContent).not.toContain('Stash Changes and Update');
    expect(document.body.textContent).toContain('no_upstream');
  });

  it('shows a competing action status instead of the stale pull panel', async () => {
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
    const { DaemonHttpError } = await import('@qwen-code/sdk/daemon');
    workspaceGitPull.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        { error: 'dirty_working_tree', message: 'would be overwritten' },
        'POST /workspaces/:workspace/git/pull: dirty_working_tree',
      ),
    );
    workspaceGitPush.mockRejectedValueOnce(new Error('push rejected'));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    mount({});
    await flush();

    clickButton('Update Project');
    await flush();
    expect(document.body.textContent).toContain('Stash Changes and Update');

    // A push failing while the panel is up must surface its own status.
    clickButton('Push');
    await flush();

    expect(workspaceGitPush).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('push rejected');
    expect(document.body.textContent).not.toContain(
      'Update blocked by uncommitted changes',
    );
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
