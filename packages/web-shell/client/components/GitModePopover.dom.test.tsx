// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import type { SessionGitIntent } from './GitModePopover';

const popoverHarness = vi.hoisted(() => ({
  open: false,
  onOpenChange: undefined as ((open: boolean) => void) | undefined,
}));

vi.mock('./ui/popover', async () => {
  const { createElement } = await import('react');
  return {
    Popover: ({
      children,
      open,
      onOpenChange,
    }: {
      children?: unknown;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      popoverHarness.open = open ?? false;
      popoverHarness.onOpenChange = onOpenChange;
      return createElement('div', null, children);
    },
    PopoverTrigger: ({ children }: { children?: unknown }) =>
      createElement(
        'div',
        { onClick: () => popoverHarness.onOpenChange?.(true) },
        children,
      ),
    // Render content only while `open`, like Radix, so keep-open-on-failure /
    // close-on-success are asserted against the real open state.
    PopoverContent: ({ children }: { children?: unknown }) =>
      popoverHarness.open ? createElement('div', null, children) : null,
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

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/web-shell/daemon-react-sdk')>();
  return {
    ...actual,
    useWorkspace: () => ({ client: workspaceClient }),
  };
});

const { I18nProvider } = await import('../i18n');
const { GitModePopover } = await import('./GitModePopover');

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

function openChip(): void {
  act(() => {
    (
      document.body.querySelector(
        '[data-testid="git-mode-chip"]',
      ) as HTMLButtonElement
    ).click();
  });
}

function renderPopover(
  props: {
    workspaceCwd?: string;
    intent?: SessionGitIntent;
    onIntentChange?: (intent: SessionGitIntent) => void;
  } = {},
): void {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <GitModePopover
          branch="main"
          workspaceCwd={props.workspaceCwd ?? '/repo'}
          intent={props.intent ?? { mode: 'current' }}
          onIntentChange={props.onIntentChange ?? vi.fn()}
        />
      </I18nProvider>,
    );
  });
}

function optionButtons(): HTMLButtonElement[] {
  return Array.from(
    document.body.querySelectorAll('[role="option"]'),
  ) as HTMLButtonElement[];
}

function setSearchValue(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
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

    expect(workspaceGitCheckout).toHaveBeenCalledWith(
      'refs/remotes/origin/develop',
    );
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

  it('shows the sanitized daemon detail, not the machine code, on checkout failure', async () => {
    workspaceGitCheckout.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          error: 'dirty_working_tree',
          message: 'Your local changes \u202ewould be overwritten',
        },
        'POST /workspaces/:workspace/git/checkout: dirty_working_tree',
      ),
    );
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();
    clickButton('topic');
    await flush();

    // The daemon's human-facing detail wins over the SDK-composed machine
    // message, and the bidi override inside it is neutralized.
    expect(document.body.textContent).toContain('Your local changes');
    expect(document.body.textContent).not.toContain('dirty_working_tree');
    expect(document.body.textContent).not.toContain('\u202e');
    expect(document.body.textContent).toContain('\\u202e');
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

  it('blocks a second checkout until the first settles, then closes on success', async () => {
    let resolveCheckout!: (value: {
      branch: string;
      detached: boolean;
    }) => void;
    workspaceGitCheckout.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCheckout = resolve;
        }),
    );
    const onIntentChange = vi.fn();
    // A non-current queued intent: the final `onIntentChange({mode:'current'})`
    // assertion then discriminates the component's hardcoded collapse from a
    // mere pass-through of the existing intent.
    renderPopover({
      onIntentChange,
      intent: { mode: 'branch', name: 'queued' },
    });
    openChip();
    clickButton('Existing branch');
    await flush();

    clickButton('topic');
    const inFlight = optionButtons();
    expect(inFlight).toHaveLength(3);
    expect(inFlight.every((option) => option.disabled)).toBe(true);
    act(() => inFlight[1]?.click());
    expect(workspaceGitCheckout).toHaveBeenCalledTimes(1);
    expect(workspaceGitCheckout).toHaveBeenCalledWith('refs/heads/topic');
    // The mode radios stay disabled while the checkout is in flight too: a
    // slow checkout must not be able to overwrite an intent the user
    // confirms in another mode while it runs.
    const radios = Array.from(
      document.body.querySelectorAll('[role="radio"]'),
    ) as HTMLButtonElement[];
    expect(radios).toHaveLength(4);
    expect(radios.every((radio) => radio.disabled)).toBe(true);

    await act(async () => {
      resolveCheckout({ branch: 'topic', detached: false });
    });
    await flush();
    expect(onIntentChange).toHaveBeenCalledWith({ mode: 'current' });
    expect(popoverHarness.open).toBe(false);
    expect(optionButtons()).toHaveLength(0);
  });

  it('offers a retry when the existing-branch list fails to load', async () => {
    workspaceGitBranches
      .mockRejectedValueOnce(new Error('bridge closed'))
      .mockResolvedValueOnce({
        v: 1,
        workspaceCwd: '/repo',
        available: true,
        local: [
          { name: 'main', isHead: true },
          { name: 'topic', isHead: false },
        ],
        remote: [],
        tags: [],
        recent: [],
        head: 'main',
        detached: false,
      });
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();
    expect(document.body.textContent).toContain('bridge closed');
    expect(optionButtons()).toHaveLength(0);

    clickButton('Retry');
    await flush();

    expect(workspaceGitBranches).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('bridge closed');
    expect(optionButtons().map((option) => option.textContent?.trim())).toEqual(
      ['topic'],
    );
  });

  it('surfaces an unavailable branch list as an error with retry', async () => {
    // `available: false` must not render as a loaded-but-empty list ("No
    // matching branches") with no recovery path.
    workspaceGitBranches.mockResolvedValueOnce({
      v: 1,
      workspaceCwd: '/repo',
      available: false,
      local: [],
      remote: [],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    });
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    expect(document.body.textContent).toContain(
      'Branch list is not available for this workspace.',
    );
    expect(document.body.textContent).not.toContain('No matching branches');
    expect(optionButtons()).toHaveLength(0);
    const retry = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    expect(retry).toBeTruthy();
  });

  it('re-enables the choices after a failed checkout so a retry can proceed', async () => {
    workspaceGitCheckout
      .mockRejectedValueOnce(new Error('index locked'))
      .mockResolvedValueOnce({ branch: 'topic', detached: false });
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    clickButton('topic');
    await flush();
    expect(document.body.textContent).toContain('index locked');
    expect(optionButtons().every((option) => !option.disabled)).toBe(true);

    clickButton('topic');
    await flush();
    expect(workspaceGitCheckout).toHaveBeenCalledTimes(2);
    expect(popoverHarness.open).toBe(false);
    expect(optionButtons()).toHaveLength(0);
  });

  it('drops a stale branch list that lands after switching workspaces', async () => {
    let resolveStale!: (value: unknown) => void;
    workspaceGitBranches.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStale = resolve;
        }),
    );
    renderPopover({ workspaceCwd: '/repo' });
    openChip();
    clickButton('Existing branch');

    // Switch workspaces while the first fetch is still in flight.
    renderPopover({ workspaceCwd: '/other' });
    await flush();
    expect(workspaceByCwd).toHaveBeenLastCalledWith('/other');
    expect(optionButtons()).toHaveLength(3);

    await act(async () => {
      resolveStale({
        v: 1,
        workspaceCwd: '/repo',
        available: true,
        local: [{ name: 'stale-branch', isHead: false }],
        remote: [],
        tags: [],
        recent: [],
        head: 'main',
        detached: false,
      });
    });
    await flush();

    expect(document.body.textContent).not.toContain('stale-branch');
    expect(optionButtons()).toHaveLength(3);
  });

  it('clears a stale error when another workspace loads its branches', async () => {
    workspaceGitBranches.mockRejectedValueOnce(new Error('repo failed'));
    renderPopover({ workspaceCwd: '/repo' });
    openChip();
    clickButton('Existing branch');
    await flush();
    expect(document.body.textContent).toContain('repo failed');

    renderPopover({ workspaceCwd: '/other' });
    await flush();

    expect(document.body.textContent).not.toContain('repo failed');
    expect(optionButtons()).toHaveLength(3);
  });

  it('resets the search query on reopen and filters case-insensitively', async () => {
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    const search = document.body.querySelector(
      'input[aria-label="Search branches\u2026"]',
    ) as HTMLInputElement;
    setSearchValue(search, ' TOPIC ');
    expect(optionButtons().map((option) => option.textContent?.trim())).toEqual(
      ['topic'],
    );

    setSearchValue(search, 'no-such-branch');
    expect(document.body.textContent).toContain('No matching branches');
    expect(optionButtons()).toHaveLength(0);

    act(() => popoverHarness.onOpenChange?.(false));
    expect(optionButtons()).toHaveLength(0);

    openChip();
    clickButton('Existing branch');
    await flush();
    const reopened = document.body.querySelector(
      'input[aria-label="Search branches\u2026"]',
    ) as HTMLInputElement;
    expect(reopened.value).toBe('');
    expect(optionButtons()).toHaveLength(3);
  });

  it('clears a fetch error when the popover reopens', async () => {
    workspaceGitBranches.mockRejectedValueOnce(new Error('boom'));
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();
    expect(document.body.textContent).toContain('boom');

    act(() => popoverHarness.onOpenChange?.(false));
    openChip();
    clickButton('Existing branch');
    await flush();

    expect(document.body.textContent).not.toContain('boom');
    expect(optionButtons()).toHaveLength(3);
  });

  it('surfaces a checkout failure that lands while the popover is closed', async () => {
    // Closing the popover does not cancel the checkout; its failure must be
    // visible on reopen instead of being cleared before the first render.
    let rejectCheckout!: (error: Error) => void;
    workspaceGitCheckout.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCheckout = reject;
        }),
    );
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    clickButton('topic'); // checkout starts and stays in flight across closing
    act(() => popoverHarness.onOpenChange?.(false));
    await act(async () => {
      rejectCheckout(new Error('Commit or stash first'));
    });
    await flush();

    openChip();
    // Flush the branch refetch the reopen triggers: the error must survive
    // the refetch landing, and no state update may escape act().
    await flush();
    expect(document.body.textContent).toContain('Commit or stash first');
  });

  it('keeps the in-flight checkout visible when the popover reopens mid-flight', async () => {
    let rejectCheckout!: (error: Error) => void;
    workspaceGitCheckout.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCheckout = reject;
        }),
    );
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    clickButton('topic'); // checkout stays in flight across closing
    act(() => popoverHarness.onOpenChange?.(false));
    openChip();
    await flush();

    // The reopen must land on the existing-branch box — the only surface
    // that renders the in-flight state — instead of the intent's mode view,
    // where every control is disabled and nothing explains why.
    expect(
      document.body.querySelector('input[aria-label="Search branches\u2026"]'),
    ).toBeTruthy();

    // A failure landing after the reopen must be visible without a manual
    // mode switch.
    await act(async () => {
      rejectCheckout(new Error('hook failed'));
    });
    await flush();
    expect(document.body.textContent).toContain('hook failed');
  });

  it('qualifies ambiguous short names instead of double-prefixing them', async () => {
    // git lengthens refname:short for ambiguous names (branch `release` +
    // tag `release` → `heads/release`); the picker values must absorb the
    // disambiguation prefix instead of synthesizing refs/heads/heads/release.
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      local: [
        { name: 'main', isHead: true },
        { name: 'heads/release', isHead: false },
      ],
      remote: [{ name: 'remotes/origin/main', isHead: false }],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    });
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    expect(optionButtons().map((option) => option.textContent?.trim())).toEqual(
      ['release', 'origin/main'],
    );

    clickButton('release');
    await flush();
    expect(workspaceGitCheckout).toHaveBeenCalledWith('refs/heads/release');
  });

  it('renders branch labels with bidi overrides escaped', async () => {
    // git refnames legally carry U+202E (for-each-ref lists them, which is
    // how the picker is populated); a hostile remote could plant one to
    // visually reorder a label — the trojan-source class.
    workspaceGitBranches.mockResolvedValue({
      v: 1,
      workspaceCwd: '/repo',
      available: true,
      local: [
        { name: 'main', isHead: true },
        { name: 'release\u202egpj', isHead: false },
      ],
      remote: [],
      tags: [],
      recent: [],
      head: 'main',
      detached: false,
    });
    renderPopover();
    openChip();
    clickButton('Existing branch');
    await flush();

    expect(document.body.textContent).not.toContain('\u202e');
    expect(document.body.textContent).toContain('release\\u202egpj');
    expect(optionButtons()).toHaveLength(1);
  });
});
