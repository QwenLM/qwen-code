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
import { DaemonHttpError } from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import {
  SESSION_LIST_PAGE_SIZE,
  WEB_SHELL_SESSION_SOURCE_TYPE,
} from '../../constants/sessions';
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
  | {
      sessions: DaemonSessionSummary[];
      truncated?: boolean;
      nextCursor?: string;
    }
  | undefined
>;
let sessionQueryOptions: Array<{
  cwd: string;
  enabled: boolean;
  query: unknown;
}>;
let overviews: Record<string, { mcp?: Record<string, unknown> } | undefined>;
let overviewCalls: Array<{
  cwd: string;
  enabled: boolean;
  items: unknown;
}>;
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
      query,
    });
    const page =
      options.enabled === false ? undefined : sessionPages[query.workspaceCwd];
    return {
      page: page
        ? { sessions: page.sessions, truncated: page.truncated === true }
        : undefined,
      sessions: page?.sessions ?? [],
      truncated: page?.truncated === true,
      nextCursor: page?.nextCursor,
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
    options: { enabled: boolean; items?: unknown },
  ) => {
    overviewCalls.push({ cwd, enabled: options.enabled, items: options.items });
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
    // Column order: name, path, sessions, mcp, git, lastActivity, actions.
    const mcpCell = other.querySelectorAll('td')[3];
    expect(mcpCell?.textContent).toBe('—');
    expect(other.textContent).not.toContain('0/0');
  });

  it('excludes disabled servers from the MCP denominator', async () => {
    overviews['/w'] = {
      mcp: {
        initialized: true,
        configured: 4,
        connected: 1,
        failed: 0,
        disabled: 2,
      },
    };
    await render();
    const mcpCell = rowByLabel('/w').querySelectorAll('td')[3];
    expect(mcpCell?.textContent).toContain('1/2');
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

  it('starts a new task in the row workspace', async () => {
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
    expect(onNewSession).toHaveBeenCalledWith('/w');
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

  it('treats a capabilities-refresh failure after removal as success', async () => {
    const onError = vi.fn();
    refreshCapabilities.mockRejectedValueOnce(new Error('refresh blip'));
    await render({ onError });
    const removeButton = Array.from(
      rowByLabel('API').querySelectorAll('button'),
    ).find(
      (button) => button.getAttribute('aria-label') === 'Remove workspace',
    )!;
    await act(async () => {
      removeButton.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove workspace',
    )!;
    await act(async () => {
      confirm.click();
    });
    // The daemon confirmed the removal; the refresh failure must not be
    // reported as a removal failure, and the dialog must close.
    expect(removeWorkspace).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(
      Array.from(document.body.querySelectorAll('button')).some(
        (button) => button.textContent === 'Remove workspace',
      ),
    ).toBe(false);
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

  it('pins the per-row catalog query and overview facet shape', async () => {
    await render();
    const call = sessionQueryOptions.find((entry) => entry.cwd === '/other');
    expect(call?.query).toEqual({
      routeKind: 'legacy',
      workspaceCwd: '/other',
      options: {
        pageSize: SESSION_LIST_PAGE_SIZE,
        archiveState: 'active',
        sourceType: WEB_SHELL_SESSION_SOURCE_TYPE,
      },
    });
    for (const entry of overviewCalls) {
      expect(entry.items).toEqual(['mcp']);
    }
    // The branch cell keeps the sidebar chip's enriched-status contract.
    expect(workspaceGit).toHaveBeenCalledWith('/other', { wait: true });
  });

  it('falls back to createdAt for sessions without an updatedAt', async () => {
    sessionPages['/other'] = {
      sessions: [session({ createdAt: new Date().toISOString() })],
    };
    await render();
    const cell = rowByLabel('API').querySelectorAll('td')[5];
    expect(cell?.textContent).toBe('just now');
  });

  it('treats a nextCursor page as a lower bound', async () => {
    sessionPages['/other'] = {
      sessions: [session({})],
      nextCursor: 'page-2',
    };
    await render();
    const cell = rowByLabel('API').querySelectorAll('td')[2];
    expect(cell?.textContent).toContain('1+');
  });

  it('treats a capped scan without a cursor as a lower bound too', async () => {
    sessionPages['/other'] = {
      sessions: [session({})],
      truncated: true,
    };
    await render();
    const cell = rowByLabel('API').querySelectorAll('td')[2];
    expect(cell?.textContent).toContain('1+');
  });

  it('ignores a second New task click while one is creating', async () => {
    let resolveCreate: (value: boolean) => void = () => {};
    const onNewSession = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    await render({ onNewSession });
    // The columns rebuild on state changes and remount the cell, so the
    // button node must be re-queried after every click.
    const newTaskButton = () =>
      Array.from(rowByLabel('API').querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.includes('New task'),
      )!;
    await act(async () => {
      newTaskButton().click();
    });
    expect(newTaskButton().disabled).toBe(true);
    await act(async () => {
      newTaskButton().click();
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);
    // The guard is global, not per-row: a second draft must not start from
    // another workspace while this one is still creating.
    const otherRowButton = Array.from(
      rowByLabel('/w').querySelectorAll('button'),
    ).find((candidate) => candidate.textContent?.includes('New task'))!;
    expect(otherRowButton.disabled).toBe(true);
    await act(async () => {
      otherRowButton.click();
    });
    expect(onNewSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCreate(true);
      await Promise.resolve();
    });
    expect(newTaskButton().disabled).toBe(false);
  });

  it('blocks the forced removal of the active session workspace', async () => {
    connectionState.sessionId = 's-live';
    connectionState.workspaceCwd = '/other';
    removeWorkspace.mockRejectedValueOnce(
      new DaemonHttpError(
        409,
        {
          code: 'workspace_busy',
          activity: {
            sessions: 1,
            activePrompts: 1,
            pendingSessionStarts: 0,
            acpConnections: 1,
            memoryTasks: 0,
            channelWorkers: 0,
          },
        },
        'busy',
      ),
    );
    await render();
    const removeButton = Array.from(
      rowByLabel('API').querySelectorAll('button'),
    ).find(
      (button) => button.getAttribute('aria-label') === 'Remove workspace',
    )!;
    await act(async () => {
      removeButton.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove workspace',
    )!;
    await act(async () => {
      confirm.click();
    });
    expect(removeWorkspace).toHaveBeenCalledTimes(1);
    // The dialog stays open in the busy state with the force action
    // disabled for the workspace the active session lives in.
    expect(confirm.disabled).toBe(true);
    // A stale or programmatic invocation must be refused by the hook's
    // blockForce wiring too, not only by the disabled attribute: invoke
    // the button's handler directly, as a stale reference would.
    const propsKey = Object.keys(confirm).find((key) =>
      key.startsWith('__reactProps'),
    )!;
    const props = (confirm as unknown as Record<string, unknown>)[propsKey] as {
      onClick: () => void;
    };
    await act(async () => {
      props.onClick();
      await Promise.resolve();
    });
    expect(removeWorkspace).toHaveBeenCalledTimes(1);
  });

  it('allows the forced removal when the active session lives elsewhere', async () => {
    connectionState.sessionId = 's-live';
    connectionState.workspaceCwd = '/w';
    removeWorkspace
      .mockRejectedValueOnce(
        new DaemonHttpError(
          409,
          {
            code: 'workspace_busy',
            activity: {
              sessions: 1,
              activePrompts: 0,
              pendingSessionStarts: 0,
              acpConnections: 1,
              memoryTasks: 0,
              channelWorkers: 0,
            },
          },
          'busy',
        ),
      )
      .mockResolvedValueOnce({ removed: true });
    await render();
    const removeButton = Array.from(
      rowByLabel('API').querySelectorAll('button'),
    ).find(
      (button) => button.getAttribute('aria-label') === 'Remove workspace',
    )!;
    await act(async () => {
      removeButton.click();
    });
    const confirm = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Remove workspace',
    )!;
    await act(async () => {
      confirm.click();
    });
    // Busy, but the active session is in another workspace: force stays
    // available and goes out with force: true.
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
    });
    expect(removeWorkspace).toHaveBeenLastCalledWith('other', { force: true });
  });

  it('keeps row cells mounted across re-renders', async () => {
    const onNewSession = vi.fn().mockResolvedValue(true);
    const onError = vi.fn();
    await render({ onNewSession, onError });
    workspaceGit.mockClear();
    // Same prop identities: only internal hook objects change. A columns
    // rebuild would remount every cell and re-fire the git fetches.
    await render({ onNewSession, onError });
    expect(workspaceGit).not.toHaveBeenCalled();
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
