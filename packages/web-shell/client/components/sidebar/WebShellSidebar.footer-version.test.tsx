// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type Root } from 'react';
import { createRoot } from 'react-dom/client';
import {
  DAEMON_APPROVAL_MODES,
  createSidebarMocks,
  installSidebarDomShims,
  sidebarSessionPage,
  staticSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

const mocks = createSidebarMocks({
  connectionCapabilities: { qwenCodeVersion: '1.2.3', features: [] },
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES,
  useConnection: () => mocks.connection,
  useActions: () => mocks.actions,
  useWorkspace: () => mocks.workspace,
  useWorkspaceActions: () => mocks.workspaceActions,
  useChannels: () => mocks.channels,
  useSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
  useSessionCatalogController: () => ({
    refreshQueries: mocks.refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => staticSidebarSessionCatalogQuery(),
  useSessionCatalogQueries: mocks.useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

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
