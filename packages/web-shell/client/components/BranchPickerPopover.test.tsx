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
