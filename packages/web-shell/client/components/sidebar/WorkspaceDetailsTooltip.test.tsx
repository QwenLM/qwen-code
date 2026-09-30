// @vitest-environment jsdom

import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WorkspaceDetailsTooltip } from './WorkspaceDetailsTooltip';
import type { WorkspaceOverviewSnapshot } from './workspaceOverviewModel';

// The real picker reads the daemon workspace context and portals its own
// layer; the branch row only needs to prove it wires the trigger and the
// pin/close handshake, so the picker stands in for itself here.
vi.mock('../BranchPickerPopover', async () => {
  const { cloneElement, createElement } = await import('react');
  return {
    BranchPickerPopover: ({
      children,
      open,
      onOpenChange,
      onBranchChanged,
    }: {
      children: ReactNode;
      open: boolean;
      onOpenChange: (open: boolean) => void;
      onBranchChanged?: () => void;
    }) =>
      createElement(
        'div',
        {
          'data-testid': 'branch-picker',
          'data-open': String(open),
          'data-has-branch-changed': String(Boolean(onBranchChanged)),
        },
        cloneElement(children as ReactElement, {
          onClick: () => onOpenChange(true),
        }),
        createElement('button', {
          type: 'button',
          'data-testid': 'branch-picker-close',
          onClick: () => onOpenChange(false),
        }),
      ),
  };
});

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    root.unmount();
  });
  container.remove();
  document.body.replaceChildren();
});

const snapshot: WorkspaceOverviewSnapshot = {
  mcp: {
    initialized: true,
    discoveryState: 'completed',
    configured: 3,
    connected: 1,
    failed: 1,
    disabled: 1,
  },
  skills: { initialized: true, total: 2, enabled: 1 },
  extensions: { total: 0, active: 0 },
  channels: { configured: 0, connected: 0, failed: 0 },
  context: { initialized: true, fileCount: 0, ruleCount: 0 },
  fetchedAt: 1,
};

async function openDetails(node: ReactNode): Promise<HTMLElement> {
  vi.useFakeTimers();
  await act(async () => {
    root.render(<I18nProvider language="en">{node}</I18nProvider>);
  });
  const trigger = container.querySelector('button');
  if (!trigger) throw new Error('trigger was not rendered');
  await act(async () => {
    trigger.dispatchEvent(new Event('pointerover', { bubbles: true }));
    vi.advanceTimersByTime(300);
    await Promise.resolve();
  });
  const details = document.querySelector<HTMLElement>('[role="dialog"]');
  expect(details).not.toBeNull();
  return details!;
}

function facetRow(details: HTMLElement, item: string): HTMLElement | null {
  return details.querySelector<HTMLElement>(
    `[data-web-shell-workspace-overview="${item}"]`,
  );
}

describe('WorkspaceDetailsTooltip', () => {
  it('reports opening, closing, and unmounting to its consumer', async () => {
    const onOpenChange = vi.fn();
    await openDetails(
      <WorkspaceDetailsTooltip
        label="workspace"
        cwd="/workspace"
        overview={undefined}
        items={[]}
        onOpenChange={onOpenChange}
      >
        <button>Workspace</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      container
        .querySelector('button')!
        .dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await act(async () => {
      container
        .querySelector('button')!
        .dispatchEvent(new Event('pointerover', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    act(() => root.render(null));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the path, branch and non-zero facets on hover', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        overview={snapshot}
        items={['mcp', 'skills', 'extensions', 'channels', 'context']}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );

    expect(details.textContent).toContain('qwen-code');
    expect(
      details.querySelector('[data-web-shell-workspace-path]')?.textContent,
    ).toBe('/work/qwen-code');
    expect(details.textContent).toContain('main');
    expect(facetRow(details, 'mcp')?.textContent).toBe('MCP1/2');
    expect(facetRow(details, 'mcp')?.getAttribute('title')).toBe(
      'MCP: 1 of 3 connected, 1 failed, 1 disabled',
    );
    expect(facetRow(details, 'mcp')?.getAttribute('aria-label')).toBe(
      'MCP: 1 of 3 connected, 1 failed, 1 disabled',
    );
    expect(facetRow(details, 'skills')?.textContent).toBe('Skills1');
    // The popover takes no persistent space, so known zeros show too.
    expect(facetRow(details, 'extensions')?.textContent).toBe('Extensions0');
    expect(facetRow(details, 'channels')?.textContent).toBe('Channels0');
    expect(facetRow(details, 'context')?.textContent).toBe('Context0');
  });

  it('marks a facet with an issue in the warning tone', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={snapshot}
        items={['mcp', 'skills']}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(facetRow(details, 'mcp')?.className).toMatch(
      /sessionDetailsRowIssue/,
    );
    expect(facetRow(details, 'skills')?.className).not.toMatch(
      /sessionDetailsRowIssue/,
    );
  });

  it('omits the path row and every facet when there is nothing to show', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="My Project"
        overview={undefined}
        items={['mcp']}
      >
        <button type="button">My Project</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(details.textContent).toContain('My Project');
    expect(details.querySelector('[data-web-shell-workspace-path]')).toBeNull();
    expect(facetRow(details, 'mcp')).toBeNull();
  });

  it('skips unknown facets instead of rendering placeholders', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={{
          skills: { initialized: false, total: 0, enabled: 0 },
          fetchedAt: 1,
        }}
        items={['skills', 'extensions']}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(facetRow(details, 'skills')).toBeNull();
    expect(facetRow(details, 'extensions')).toBeNull();
  });

  it('hides the open-folder button unless the handler is wired', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(
      details.querySelector('[data-web-shell-open-workspace-folder]'),
    ).toBeNull();
  });

  it('dispatches the open-folder handler and confirms with a check', async () => {
    const onOpenPathLocally = vi.fn().mockResolvedValue(undefined);
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
        onOpenPathLocally={onOpenPathLocally}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const openButton = details.querySelector<HTMLButtonElement>(
      '[data-web-shell-open-workspace-folder]',
    );
    expect(openButton).not.toBeNull();
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenPathLocally).toHaveBeenCalledTimes(1);
    // Success swaps the folder icon for the check.
    expect(openButton!.querySelector('svg.lucide-check')).not.toBeNull();
    expect(openButton!.querySelector('svg.lucide-folder-open')).toBeNull();
  });

  it('keeps the idle icon when opening fails', async () => {
    const onOpenPathLocally = vi
      .fn()
      .mockRejectedValue(new Error('no display'));
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
        onOpenPathLocally={onOpenPathLocally}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const openButton = details.querySelector<HTMLButtonElement>(
      '[data-web-shell-open-workspace-folder]',
    );
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenPathLocally).toHaveBeenCalledTimes(1);
    // A rejection is swallowed (the sidebar toasts): no false check appears
    // and the folder icon stays.
    expect(openButton!.querySelector('svg.lucide-check')).toBeNull();
    expect(openButton!.querySelector('svg.lucide-folder-open')).not.toBeNull();
  });

  it('shows session counts with a breakdown tooltip', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        sessions={{ total: 4, running: 1, attention: 2, truncated: true }}
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const row = details.querySelector<HTMLElement>(
      '[data-web-shell-workspace-sessions]',
    );
    expect(row?.textContent).toBe('Sessions214+');
    expect(row?.getAttribute('aria-label')).toBe(
      '2 sessions waiting for you · 1 running session · 4+ sessions',
    );
    expect(row?.querySelector('[class*="CountRunning"]')?.className).toMatch(
      /CountRunning/,
    );
    expect(row?.querySelector('[class*="CountAttention"]')?.className).toMatch(
      /CountAttention/,
    );
  });

  it('omits the sessions row when there is nothing to count', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        sessions={{ total: 0, running: 0, attention: 0, truncated: false }}
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(
      details.querySelector('[data-web-shell-workspace-sessions]'),
    ).toBeNull();
  });

  it('dispatches the open-terminal handler from the path row', async () => {
    const onOpenTerminalLocally = vi.fn().mockResolvedValue(undefined);
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
        onOpenTerminalLocally={onOpenTerminalLocally}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const openButton = details.querySelector<HTMLButtonElement>(
      '[data-web-shell-open-workspace-terminal]',
    );
    expect(openButton).not.toBeNull();
    // The folder button stays hidden without its own handler.
    expect(
      details.querySelector('[data-web-shell-open-workspace-folder]'),
    ).toBeNull();
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenTerminalLocally).toHaveBeenCalledTimes(1);
  });

  it('opens on keyboard focus with the same delay as hover', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceDetailsTooltip
            label="qwen-code"
            cwd="/work/qwen-code"
            overview={undefined}
            items={[]}
          >
            <button type="button">qwen-code</button>
          </WorkspaceDetailsTooltip>
        </I18nProvider>,
      );
    });
    const trigger = container.querySelector('button');
    await act(async () => {
      trigger!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    const details = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain('/work/qwen-code');
  });

  it('announces a successful open through a live region', async () => {
    const onOpenPathLocally = vi.fn().mockResolvedValue(undefined);
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
        onOpenPathLocally={onOpenPathLocally}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const openButton = details.querySelector<HTMLButtonElement>(
      '[data-web-shell-open-workspace-folder]',
    );
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(details.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'Opened the workspace folder',
    );
  });

  it('ignores clicks while an open request is in flight', async () => {
    let resolveOpen: () => void = () => {};
    const onOpenPathLocally = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveOpen = resolve;
        }),
    );
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
        onOpenPathLocally={onOpenPathLocally}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const openButton = details.querySelector<HTMLButtonElement>(
      '[data-web-shell-open-workspace-folder]',
    );
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenPathLocally).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveOpen();
      await Promise.resolve();
    });
    // Released after the request settles: a follow-up click fires again.
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onOpenPathLocally).toHaveBeenCalledTimes(2);
  });

  it('does not open when the pointer leaves before the open delay elapses', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceDetailsTooltip
            label="qwen-code"
            cwd="/work/qwen-code"
            overview={undefined}
            items={[]}
          >
            <button type="button">qwen-code</button>
          </WorkspaceDetailsTooltip>
        </I18nProvider>,
      );
    });
    const trigger = container.querySelector('button');
    await act(async () => {
      trigger!.dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    await act(async () => {
      trigger!.dispatchEvent(new Event('pointerout', { bubbles: true }));
      vi.advanceTimersByTime(200);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('does not open before the 300ms hover delay', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <I18nProvider language="en">
          <WorkspaceDetailsTooltip
            label="qwen-code"
            cwd="/work/qwen-code"
            overview={undefined}
            items={[]}
          >
            <button type="button">qwen-code</button>
          </WorkspaceDetailsTooltip>
        </I18nProvider>,
      );
    });
    const trigger = container.querySelector('button');
    await act(async () => {
      trigger!.dispatchEvent(new Event('pointerover', { bubbles: true }));
      vi.advanceTimersByTime(299);
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps focus on the anchor when the popover opens', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(details).not.toBeNull();
    // onOpenAutoFocus is prevented: opening must not steal focus.
    expect(document.activeElement).not.toBe(details);
  });

  it('resets the check icon two seconds after a successful open', async () => {
    const onOpenPathLocally = vi.fn().mockResolvedValue(undefined);
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        overview={undefined}
        items={[]}
        onOpenPathLocally={onOpenPathLocally}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    const openButton = details.querySelector<HTMLButtonElement>(
      '[data-web-shell-open-workspace-folder]',
    );
    await act(async () => {
      openButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(openButton!.querySelector('svg.lucide-check')).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(openButton!.querySelector('svg.lucide-check')).toBeNull();
    expect(openButton!.querySelector('svg.lucide-folder-open')).not.toBeNull();
    expect(details.querySelector('[aria-live="polite"]')?.textContent).toBe('');
  });
});

function gitStatus(
  over: Partial<DaemonWorkspaceGitStatus> = {},
): DaemonWorkspaceGitStatus {
  return {
    v: 2,
    workspaceCwd: '/work/qwen-code',
    branch: 'main',
    computedAt: 1,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicted: 0,
    ...over,
  };
}

const gitActions = {
  workspaceCwd: '/work/qwen-code',
  onOpenDiff: () => {},
  onOpenCommit: () => {},
  onStatusRefreshed: () => {},
  onBranchChanged: () => {},
};

function gitRow(details: HTMLElement): HTMLElement | null {
  return details.querySelector<HTMLElement>('[data-web-shell-workspace-git]');
}

function gitDot(details: HTMLElement): HTMLElement | null {
  return details.querySelector<HTMLElement>('[class*="sessionDetailsGitDot"]');
}

function picker(details: HTMLElement): HTMLElement | null {
  return details.querySelector<HTMLElement>('[data-testid="branch-picker"]');
}

describe('WorkspaceDetailsTooltip git branch row', () => {
  it('stays a plain summary when no git actions are wired', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        gitStatus={gitStatus({ unstaged: 2 })}
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );

    expect(gitRow(details)).toBeNull();
    expect(details.querySelector('svg.lucide-chevron-right')).toBeNull();
    expect(picker(details)).toBeNull();
    // The summary and its severity dot do not depend on the picker.
    expect(details.textContent).toContain('2 modified');
    expect(gitDot(details)).not.toBeNull();
  });

  it('opens the workspace git picker from the whole branch row', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        gitStatus={gitStatus()}
        overview={undefined}
        items={[]}
        gitActions={gitActions}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );

    const row = gitRow(details);
    expect(row).not.toBeNull();
    expect(row?.tagName).toBe('BUTTON');
    expect(row?.getAttribute('aria-label')).toBe(
      'Current Git branch: main — Working tree clean',
    );
    expect(row?.querySelector('svg.lucide-chevron-right')).not.toBeNull();
    expect(picker(details)?.getAttribute('data-open')).toBe('false');
    // A checkout emits no SSE event, so the row depends on this callback.
    expect(picker(details)?.getAttribute('data-has-branch-changed')).toBe(
      'true',
    );

    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(picker(details)?.getAttribute('data-open')).toBe('true');
  });

  it('stays pinned while the picker is open and closes after it', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        gitStatus={gitStatus()}
        overview={undefined}
        items={[]}
        gitActions={gitActions}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );

    const row = gitRow(details)!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent('pointerover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // The faithful crossing: the browser names the picker node as the
    // relatedTarget when the pointer leaves the row for the picker layer.
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent('pointerout', {
          bubbles: true,
          relatedTarget: picker(details)!,
        }),
      );
      await Promise.resolve();
    });

    // The details must survive the crossing, and the pointer leaving them
    // must not tear them down while the picker lives.
    await act(async () => {
      details.dispatchEvent(new Event('pointerout', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // Closing the picker collapses them, synchronously: Radix returns focus
    // to the row as the picker unmounts, and a deferred close would be
    // cancelled by that focus event.
    await act(async () => {
      picker(details)!
        .querySelector<HTMLButtonElement>(
          '[data-testid="branch-picker-close"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps the details when the picker closes with the pointer on the row', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        gitStatus={gitStatus()}
        overview={undefined}
        items={[]}
        gitActions={gitActions}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );

    const row = gitRow(details)!;
    await act(async () => {
      row.dispatchEvent(
        new MouseEvent('pointerover', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    // The pointer never left the row, so the details stay behind the picker.
    await act(async () => {
      picker(details)!
        .querySelector<HTMLButtonElement>(
          '[data-testid="branch-picker-close"]',
        )!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('releases the pin when the picker unmounts while open', async () => {
    const render = (branch: string | undefined) => (
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch={branch}
        gitStatus={gitStatus()}
        overview={undefined}
        items={[]}
        gitActions={gitActions}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>
    );
    const details = await openDetails(render('main'));
    await act(async () => {
      gitRow(details)!.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(picker(details)?.getAttribute('data-open')).toBe('true');

    // The workspace stops reporting a branch (trust revoked, repo gone): the
    // controlled picker unmounts without ever reporting a close.
    await act(async () => {
      root.render(
        <I18nProvider language="en">{render(undefined)}</I18nProvider>,
      );
      await Promise.resolve();
    });
    expect(picker(details)).toBeNull();
    expect(details.isConnected).toBe(true);

    // The stale pin would skip every pointer close and prevent every outside
    // interaction, stranding the details on screen.
    await act(async () => {
      details.dispatchEvent(new Event('pointerout', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows the accent dot when the tree is dirty', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        gitStatus={gitStatus({ unstaged: 2, stashCount: 11 })}
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(gitDot(details)?.getAttribute('data-tone')).toBe('accent');
    expect(details.textContent).toContain('2 modified · 11 stashed');
  });

  it('omits the dot on a clean tree', async () => {
    const details = await openDetails(
      <WorkspaceDetailsTooltip
        label="qwen-code"
        cwd="/work/qwen-code"
        branch="main"
        gitStatus={gitStatus()}
        overview={undefined}
        items={[]}
      >
        <button type="button">qwen-code</button>
      </WorkspaceDetailsTooltip>,
    );
    expect(gitDot(details)).toBeNull();
    expect(details.textContent).toContain('Working tree clean');
  });
});
