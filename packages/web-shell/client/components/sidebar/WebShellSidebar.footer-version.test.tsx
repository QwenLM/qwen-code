// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type Root } from 'react';
import { createRoot } from 'react-dom/client';

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
    const makeSessions = () => {
      const state = {
        sessions: [] as never[],
        loading: false,
        error: null as Error | null,
        data: [] as never[] | undefined,
        reload: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(true),
        archiveSession: vi.fn().mockResolvedValue(true),
        unarchiveSession: vi.fn().mockResolvedValue(true),
        exportSession: vi.fn(),
      };
      state.data = state.sessions;
      return state;
    };
    return {
      connection: {
        status: 'connected',
        sessionId: null as string | null,
        workspaceCwd: '/tmp/project',
        capabilities: { qwenCodeVersion: '1.2.3', features: [] } as
          | { qwenCodeVersion: string; features: string[] }
          | undefined,
      },
      workspace: {
        capabilities: undefined,
        client: {
          workspaceByCwd: vi.fn(() => ({
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            listSessionGroups: vi.fn().mockResolvedValue({
              groups: [],
              colorOptions: [],
            }),
          })),
        },
        refreshCapabilities: vi.fn(),
      },
      workspaceActions: {
        addWorkspace: vi.fn(),
        removeWorkspace: vi.fn(),
        listSessionGroups: vi.fn().mockResolvedValue({
          groups: [],
          colorOptions: [],
        }),
        createSessionGroup: vi.fn(),
        updateSessionGroup: vi.fn(),
        deleteSessionGroup: vi.fn(),
        updateSessionOrganization: vi.fn(),
      },
      active: makeSessions(),
      pinned: makeSessions(),
      archived: makeSessions(),
    };
  });

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useChannels: () => ({ data: undefined, catalog: [], channels: {} }),
  useSessions: (options?: { archiveState?: string; group?: string }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    archiveState?: string;
    group?: string;
  }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
  useSessionCatalogController: () => ({
    refreshQueries: vi.fn(),
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => ({
    sessions: [],
    loading: false,
    error: undefined,
    reload: vi.fn(),
  }),
  useSessionCatalogQueries: vi.fn(() => []),
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';
const VERSION_BADGE_TITLE = 'Qwen Code v1.2.3';
const SETTINGS_LABEL = 'Settings';
const COLLAPSE_LABEL = 'Collapse';
const DAEMON_STATUS_LABEL = 'Daemon Status';

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

/**
 * The sidebar reads its persisted width on mount, so each width under test
 * needs its own mount.
 */
function mountAtWidth(width: number): HTMLElement {
  window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          collapsed={false}
          onCollapsedChange={() => {}}
          onOpenSettings={() => {}}
          onOpenDaemonStatus={() => {}}
          onOpenScheduledTasks={() => {}}
          onOpenWorkflows={() => {}}
          onOpenGoals={() => {}}
          onOpenSessions={() => {}}
          onOpenSplitView={() => {}}
          onNewSession={() => false}
          onLoadSession={vi.fn()}
          onError={() => {}}
        />
      </I18nProvider>,
    );
  });
  mounted.push({ root, container });
  return container;
}

function versionBadge(container: HTMLElement): Element | null {
  return container.querySelector(`[title="${VERSION_BADGE_TITLE}"]`);
}

function settingsButton(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `button[aria-label="${SETTINGS_LABEL}"]`,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  delete (window as unknown as { __TAURI__?: unknown }).__TAURI__;
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => {
      entry.root.unmount();
    });
    entry.container.remove();
  }
});

describe('WebShellSidebar footer version row', () => {
  it.each([220, 250, 260, 280, 300, 330, 343])(
    'keeps the version separate from compact action buttons at %spx',
    (width) => {
      const container = mountAtWidth(width);
      const settings = settingsButton(container);
      const badge = versionBadge(container);
      expect(settings?.querySelector('svg')).not.toBeNull();
      expect(settings?.textContent).not.toContain(SETTINGS_LABEL);
      expect(badge?.textContent).toBe('v1.2.3');
      expect(badge?.parentElement).not.toBe(settings?.parentElement);
      expect(
        container.querySelector(`button[aria-label="${DAEMON_STATUS_LABEL}"]`),
      ).not.toBeNull();
      expect(
        container.querySelector(`button[aria-label="${COLLAPSE_LABEL}"]`),
      ).not.toBeNull();
    },
  );

  it('shows the settings label on a wide sidebar', () => {
    const container = mountAtWidth(360);
    expect(settingsButton(container)?.textContent).toContain(SETTINGS_LABEL);
    expect(versionBadge(container)?.textContent).toBe('v1.2.3');
  });
});
