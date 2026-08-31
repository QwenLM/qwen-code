// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { WorkspaceDetailsTooltip } from './WorkspaceDetailsTooltip';
import type { WorkspaceOverviewSnapshot } from './workspaceOverviewModel';

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
});
