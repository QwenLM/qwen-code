// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ui/popover', async () => {
  const { createElement } = await import('react');
  let onOpenChange: ((open: boolean) => void) | undefined;
  return {
    Popover: ({
      children,
      onOpenChange: nextOnOpenChange,
    }: {
      children?: unknown;
      onOpenChange?: (open: boolean) => void;
    }) => {
      onOpenChange = nextOnOpenChange;
      return createElement('div', null, children);
    },
    PopoverTrigger: ({ children }: { children?: unknown }) =>
      createElement('div', { onClick: () => onOpenChange?.(true) }, children),
    PopoverContent: ({ children }: { children?: unknown }) =>
      createElement('div', null, children),
  };
});

const {
  workspaceByCwd,
  workspaceClient,
  workspaceGitBranches,
  workspaceGitCheckout,
} = vi.hoisted(() => {
  const workspaceGitBranches = vi.fn();
  const workspaceGitCheckout = vi.fn();
  const workspaceByCwd = vi.fn(() => ({
    workspaceGitBranches,
    workspaceGitCheckout,
  }));
  const workspaceClient = { workspaceByCwd };
  return {
    workspaceByCwd,
    workspaceClient,
    workspaceGitBranches,
    workspaceGitCheckout,
  };
});

vi.mock('@qwen-code/webui/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/webui/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({ client: workspaceClient }),
  };
});

const { I18nProvider } = await import('../i18n');
const { GitModePopover } = await import('./GitModePopover');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickButton(name: string): void {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent?.trim().startsWith(name),
  );
  expect(button).toBeTruthy();
  act(() => button?.click());
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  workspaceGitBranches.mockResolvedValue({
    v: 1,
    workspaceCwd: '/repo',
    available: true,
    local: [
      { name: 'main', isHead: true },
      { name: 'topic', isHead: false },
    ],
    remote: [
      { name: 'origin/develop', isHead: false },
      { name: 'upstream/release', isHead: false },
    ],
    tags: [],
    recent: [],
    head: 'main',
    detached: false,
  });
  workspaceGitCheckout.mockResolvedValue({
    branch: 'develop',
    detached: false,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('GitModePopover existing branches', () => {
  it('loads, searches, scrolls, and checks out an existing branch', async () => {
    const onIntentChange = vi.fn();
    const onBranchChanged = vi.fn();
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitModePopover
            branch="main"
            workspaceCwd="/repo"
            intent={{ mode: 'current' }}
            onIntentChange={onIntentChange}
            onBranchChanged={onBranchChanged}
          />
        </I18nProvider>,
      );
    });

    act(() => {
      (
        document.body.querySelector(
          '[data-testid="git-mode-chip"]',
        ) as HTMLButtonElement
      ).click();
    });
    clickButton('Existing branch');
    await flush();

    expect(workspaceByCwd).toHaveBeenCalledWith('/repo');
    expect(workspaceGitBranches).toHaveBeenCalledTimes(1);
    const options = Array.from(
      document.body.querySelectorAll('[role="option"]'),
    );
    expect(options.map((item) => item.textContent?.trim())).toEqual([
      'topic',
      'origin/develop',
      'upstream/release',
    ]);
    clickButton('Existing branch');
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(3);

    const list = document.body.querySelector(
      '[role="listbox"][aria-label="Existing branch"]',
    ) as HTMLDivElement;
    const bubbledWheel = vi.fn();
    document.body.addEventListener('wheel', bubbledWheel);
    act(() => {
      list.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: 80 }),
      );
    });
    document.body.removeEventListener('wheel', bubbledWheel);
    expect(bubbledWheel).not.toHaveBeenCalled();

    const search = document.body.querySelector(
      'input[aria-label="Search branches…"]',
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, 'origin');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(1);

    clickButton('origin/develop');
    await flush();

    expect(workspaceGitCheckout).toHaveBeenCalledWith('origin/develop');
    expect(onIntentChange).toHaveBeenCalledWith({ mode: 'current' });
    expect(onBranchChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps the choices open when checkout fails', async () => {
    workspaceGitCheckout.mockRejectedValueOnce(
      new Error('Commit or stash first'),
    );
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitModePopover
            branch="main"
            workspaceCwd="/repo"
            intent={{ mode: 'current' }}
            onIntentChange={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    act(() => {
      (
        document.body.querySelector(
          '[data-testid="git-mode-chip"]',
        ) as HTMLButtonElement
      ).click();
    });
    clickButton('Existing branch');
    await flush();
    clickButton('topic');
    await flush();

    expect(document.body.textContent).toContain('Commit or stash first');
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(3);
  });

  it('collapses groups and reveals matches while searching', async () => {
    act(() => {
      root.render(
        <I18nProvider language="en">
          <GitModePopover
            branch="main"
            workspaceCwd="/repo"
            intent={{ mode: 'current' }}
            onIntentChange={vi.fn()}
          />
        </I18nProvider>,
      );
    });

    act(() => {
      (
        document.body.querySelector(
          '[data-testid="git-mode-chip"]',
        ) as HTMLButtonElement
      ).click();
    });
    clickButton('Existing branch');
    await flush();

    const localGroup = Array.from(
      document.body.querySelectorAll('button'),
    ).find((item) => item.textContent?.trim() === 'Local') as HTMLButtonElement;
    expect(localGroup).toBeTruthy();
    expect(localGroup.getAttribute('aria-expanded')).toBe('true');

    act(() => localGroup.click());
    expect(localGroup.getAttribute('aria-expanded')).toBe('false');
    expect(
      Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (item) => item.textContent?.trim(),
      ),
    ).toEqual(['origin/develop', 'upstream/release']);

    const originGroup = Array.from(
      document.body.querySelectorAll('button'),
    ).find(
      (item) => item.textContent?.trim() === 'Remote · origin',
    ) as HTMLButtonElement;
    act(() => originGroup.click());
    expect(originGroup.getAttribute('aria-expanded')).toBe('false');
    expect(
      Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (item) => item.textContent?.trim(),
      ),
    ).toEqual(['upstream/release']);

    const search = document.body.querySelector(
      'input[aria-label="Search branches…"]',
    ) as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, 'topic');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(localGroup.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.querySelector('[role="option"]')?.textContent).toBe(
      'topic',
    );

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(search, '');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(localGroup.getAttribute('aria-expanded')).toBe('false');
    expect(
      Array.from(document.body.querySelectorAll('[role="option"]')).map(
        (item) => item.textContent?.trim(),
      ),
    ).toEqual(['upstream/release']);
  });

  it('clears cached choices before loading another workspace', async () => {
    const render = (workspaceCwd: string) => {
      act(() => {
        root.render(
          <I18nProvider language="en">
            <GitModePopover
              branch="main"
              workspaceCwd={workspaceCwd}
              intent={{ mode: 'current' }}
              onIntentChange={vi.fn()}
            />
          </I18nProvider>,
        );
      });
    };

    render('/repo');
    act(() => {
      (
        document.body.querySelector(
          '[data-testid="git-mode-chip"]',
        ) as HTMLButtonElement
      ).click();
    });
    clickButton('Existing branch');
    await flush();
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(3);

    workspaceGitBranches.mockRejectedValueOnce(new Error('Other repo failed'));
    render('/other');
    await flush();

    expect(workspaceByCwd).toHaveBeenLastCalledWith('/other');
    expect(document.body.textContent).toContain('Other repo failed');
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
  });
});
