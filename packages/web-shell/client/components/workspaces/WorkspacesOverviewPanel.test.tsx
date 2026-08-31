// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  DaemonCapabilities,
  DaemonSessionSummary,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { WorkspacesOverviewPanel } from './WorkspacesOverviewPanel';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// DataTable measures its viewport; jsdom has no ResizeObserver.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

let connectionState: {
  sessionId?: string;
  workspaceCwd?: string;
  capabilities?: DaemonCapabilities;
};
let workspaceCapabilities: DaemonCapabilities | undefined;
let sessionPages: Record<
  string,
  { sessions: DaemonSessionSummary[]; truncated?: boolean } | undefined
>;
let sessionQueryOptions: Array<{ cwd: string; enabled: boolean }>;
let overviews: Record<string, { mcp?: Record<string, unknown> } | undefined>;
let overviewCalls: Array<{ cwd: string; enabled: boolean }>;
const refreshCapabilities = vi.fn();
const invalidateWorkspace = vi.fn();
const workspaceGit = vi.fn();
const workspaceByCwd = vi.fn((cwd: string) => ({
  workspaceGit: (options?: unknown) => workspaceGit(cwd, options),
}));
const removeWorkspace = vi.fn();
const workspaceClient = { workspaceByCwd };

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connectionState,
  useWorkspace: () => ({
    client: workspaceClient,
    capabilities: workspaceCapabilities,
    refreshCapabilities,
  }),
  useWorkspaceActions: () => ({ removeWorkspace }),
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogController: () => ({ invalidateWorkspace }),
  useSessionCatalogQuery: (
    _client: unknown,
    query: { workspaceCwd: string },
    options: { enabled?: boolean },
  ) => {
    sessionQueryOptions.push({
      cwd: query.workspaceCwd,
      enabled: options.enabled !== false,
    });
    const page =
      options.enabled === false ? undefined : sessionPages[query.workspaceCwd];
    return {
      page: page
        ? { sessions: page.sessions, truncated: page.truncated === true }
        : undefined,
      sessions: page?.sessions ?? [],
      truncated: page?.truncated === true,
      loading: false,
      stale: false,
      reload: vi.fn(),
    };
  },
}));

vi.mock('../sidebar/useWorkspaceOverview', () => ({
  useWorkspaceOverview: (
    _client: unknown,
    cwd: string,
    options: { enabled: boolean },
  ) => {
    overviewCalls.push({ cwd, enabled: options.enabled });
    return { overview: options.enabled ? overviews[cwd] : undefined };
  },
}));

let root: Root;
let container: HTMLDivElement;

async function render(
  props: Partial<Parameters<typeof WorkspacesOverviewPanel>[0]> = {},
): Promise<HTMLDivElement> {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <WorkspacesOverviewPanel
          onClose={vi.fn()}
          onNewSession={vi.fn().mockResolvedValue(true)}
          {...props}
        />
      </I18nProvider>,
    );
  });
  return container;
}

function session(
  overrides: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  } as DaemonSessionSummary;
}

function rowByLabel(label: string): HTMLTableRowElement {
  const row = Array.from(container.querySelectorAll('tbody tr')).find((tr) =>
    tr.textContent?.includes(label),
  );
  expect(row, `row ${label}`).toBeDefined();
  return row as HTMLTableRowElement;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sessionQueryOptions = [];
  overviewCalls = [];
  refreshCapabilities.mockReset();
  invalidateWorkspace.mockReset();
  removeWorkspace.mockReset().mockResolvedValue({ removed: true });
  workspaceGit.mockReset().mockImplementation((cwd: string) =>
    Promise.resolve({
      v: 2,
      workspaceCwd: cwd,
      branch: 'main',
      staged: 0,
      unstaged: 2,
      untracked: 0,
      conflicted: 0,
    }),
  );
  workspaceByCwd.mockClear();
  connectionState = {
    capabilities: {
      qwenCodeVersion: '1.2.3',
      features: ['workspace_runtime_removal'],
    } as DaemonCapabilities,
  };
  workspaceCapabilities = {
    qwenCodeVersion: '1.2.3',
    features: ['workspace_runtime_removal'],
    workspaces: [
      { id: 'primary', cwd: '/w', primary: true, trusted: true },
      {
        id: 'other',
        cwd: '/other',
        displayName: 'API',
        primary: false,
        trusted: true,
        removable: true,
      },
      {
        id: 'locked',
        cwd: '/locked',
        primary: false,
        trusted: false,
      },
      {
        id: 'live',
        cwd: 'live:demo',
        primary: false,
        trusted: true,
        kind: 'live',
      },
    ],
  } as DaemonCapabilities;
  sessionPages = {
    '/w': {
      sessions: [
        session({
          hasActivePrompt: true,
          updatedAt: new Date().toISOString(),
        }),
        session({ isWaitingForPermission: true }),
      ],
    },
    '/other': { sessions: [] },
  };
  overviews = {
    '/w': {
      mcp: {
        initialized: true,
        configured: 4,
        connected: 3,
        failed: 1,
        disabled: 0,
      },
    },
  };
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('WorkspacesOverviewPanel', () => {
  it('renders one row per registered workspace, skipping live runtimes', async () => {
    await render();
    const rows = container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(container.textContent).toContain('3 workspaces');
    const primary = rowByLabel('/w');
    expect(primary.textContent).toContain('primary');
    expect(rowByLabel('API').textContent).toContain('/other');
    expect(rowByLabel('/locked').textContent).toContain('untrusted');
    expect(container.textContent).not.toContain('live:demo');
  });

  it('shows session counts, MCP health, branch and last activity', async () => {
    await render();
    const primary = rowByLabel('/w');
    expect(primary.textContent).toContain('1 running');
    expect(primary.textContent).toContain('1 need attention');
    expect(primary.textContent).toContain('3/4');
    expect(primary.textContent).toContain('1 failed');
    expect(primary.textContent).toContain('main');
    expect(primary.textContent).toContain('2 changed');
    expect(primary.textContent).toContain('just now');
  });

  it('keeps an uninitialized runtime as unknown, never zero', async () => {
    overviews['/other'] = {
      mcp: {
        initialized: false,
        configured: 0,
        connected: 0,
        failed: 0,
        disabled: 0,
      },
    };
    await render();
    const other = rowByLabel('API');
    expect(other.textContent).not.toContain('0/0');
    expect(other.textContent).toContain('—');
  });

  it('never fetches for an untrusted workspace and renders placeholders', async () => {
    await render();
    for (const call of sessionQueryOptions.filter(
      (entry) => entry.cwd === '/locked',
    )) {
      expect(call.enabled).toBe(false);
    }
    for (const call of overviewCalls.filter(
      (entry) => entry.cwd === '/locked',
    )) {
      expect(call.enabled).toBe(false);
    }
    expect(workspaceByCwd).not.toHaveBeenCalledWith('/locked');
    const locked = rowByLabel('/locked');
    const newTask = Array.from(locked.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('New task'),
    );
    expect(newTask?.disabled).toBe(true);
  });

  it('starts a new task in the row workspace (primary maps to undefined)', async () => {
    const onNewSession = vi.fn().mockResolvedValue(true);
    await render({ onNewSession });
    const clickNewTask = async (row: HTMLTableRowElement) => {
      const button = Array.from(row.querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('New task'),
      )!;
      await act(async () => {
        button.click();
      });
    };
    await clickNewTask(rowByLabel('/w'));
    expect(onNewSession).toHaveBeenCalledWith(undefined);
    await clickNewTask(rowByLabel('API'));
    expect(onNewSession).toHaveBeenCalledWith('/other');
  });

  it('offers Remove only where the sidebar row would, and runs the shared flow', async () => {
    await render();
    const removeIn = (row: HTMLTableRowElement) =>
      Array.from(row.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'Remove workspace',
      );
    expect(removeIn(rowByLabel('/w'))).toBeUndefined();
    expect(removeIn(rowByLabel('/locked'))).toBeUndefined();
    const removeButton = removeIn(rowByLabel('API'));
    expect(removeButton).toBeDefined();
    await act(async () => {
      removeButton!.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove workspace',
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.click();
    });
    expect(removeWorkspace).toHaveBeenCalledWith('other', { force: false });
    expect(invalidateWorkspace).toHaveBeenCalledWith('/other');
    expect(refreshCapabilities).toHaveBeenCalled();
  });

  it('hides Remove entirely without the daemon feature', async () => {
    connectionState.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: [],
    } as DaemonCapabilities;
    await render();
    expect(
      Array.from(container.querySelectorAll('button')).filter(
        (button) => button.getAttribute('aria-label') === 'Remove workspace',
      ),
    ).toHaveLength(0);
  });

  it('shows the Add workspace action only when wired', async () => {
    const onAddWorkspace = vi.fn();
    await render({ onAddWorkspace });
    const add = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Add workspace'),
    );
    expect(add).toBeDefined();
    await act(async () => {
      add!.click();
    });
    expect(onAddWorkspace).toHaveBeenCalled();
    await render({ onAddWorkspace: undefined });
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('Add workspace'),
      ),
    ).toBe(false);
  });
});
