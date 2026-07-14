// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

const COLLAPSED_SESSION_SECTIONS_STORAGE_KEY =
  'qwen-code-web-shell-collapsed-session-groups';

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
    const makeSessions = () => ({
      sessions: [] as DaemonSessionSummary[],
      loading: false,
      error: null,
      reload: vi.fn().mockResolvedValue(undefined),
      deleteSession: vi.fn().mockResolvedValue(true),
      archiveSession: vi.fn().mockResolvedValue(true),
      unarchiveSession: vi.fn().mockResolvedValue(true),
      exportSession: vi.fn(),
    });
    return {
      connection: {
        status: 'connected',
        sessionId: null as string | null,
        workspaceCwd: '/tmp/project',
        capabilities: undefined as
          | {
              qwenCodeVersion: string;
              features: string[];
            }
          | undefined,
      },
      workspace: {
        capabilities: undefined as
          | {
              qwenCodeVersion: string;
              features: string[];
            }
          | undefined,
        client: {
          workspaceByCwd: vi.fn(() => ({
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            listSessionGroups: vi.fn().mockResolvedValue({
              groups: [],
              colorOptions: [
                'red',
                'orange',
                'yellow',
                'green',
                'blue',
                'purple',
              ],
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
          colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useSessions: (options?: { archiveState?: string; group?: string }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
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

function makeSession(
  sessionId: string,
  over: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary {
  return {
    sessionId,
    workspaceCwd: '/tmp/project',
    displayName: `Session ${sessionId}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    clientCount: 0,
    hasActivePrompt: false,
    isArchived: false,
    isPinned: false,
    groupId: null,
    color: null,
    ...over,
  } as DaemonSessionSummary;
}

const organizationCapabilities = {
  qwenCodeVersion: '1.2.3',
  features: ['session_organization'],
};

const namedGroup = {
  id: 'group-1',
  name: 'Backend',
  color: 'green' as const,
  order: 0,
  createdAt: '2026-07-04T00:00:00.000Z',
  updatedAt: '2026-07-04T00:00:00.000Z',
};

let root: Root;
let container: HTMLDivElement;

function renderSidebar() {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <WebShellSidebar
          collapsed={false}
          onCollapsedChange={() => {}}
          onOpenSettings={() => {}}
          onOpenDaemonStatus={() => {}}
          onOpenScheduledTasks={() => {}}
          onOpenSessions={() => {}}
          onOpenSplitView={() => {}}
          onNewSession={() => false}
          onLoadSession={() => {}}
          onError={() => {}}
        />
      </I18nProvider>,
    );
  });
}

async function flushSidebar() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function groupHeader(label: string): HTMLButtonElement {
  const section = container.querySelector<HTMLElement>(
    `section[aria-label="${label}"]`,
  );
  expect(section).not.toBeNull();
  const header = section!.querySelector<HTMLButtonElement>(
    'button[aria-expanded]',
  );
  expect(header).not.toBeNull();
  return header!;
}

function click(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  connection.sessionId = null;
  connection.workspaceCwd = '/tmp/project';
  connection.capabilities = organizationCapabilities;
  workspace.capabilities = organizationCapabilities;
  workspaceActions.listSessionGroups.mockReset();
  workspaceActions.listSessionGroups.mockResolvedValue({
    groups: [namedGroup],
    colorOptions: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'],
  });
  active.sessions = [
    makeSession('session-a', {
      displayName: 'API review',
      groupId: 'group-1',
    }),
    makeSession('session-b', {
      displayName: 'Release notes',
      groupId: null,
    }),
  ];
  pinned.sessions = [];
  archived.sessions = [];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('WebShellSidebar collapsed session group persistence', () => {
  it('writes collapsed section ids with the qwen-code-web-shell-* key', async () => {
    renderSidebar();
    await flushSidebar();

    const backend = container.querySelector<HTMLElement>(
      'section[aria-label="Backend"]',
    );
    expect(backend?.textContent).toContain('API review');
    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
    expect(backend?.textContent).not.toContain('API review');
    expect(
      window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY),
    ).toBe(JSON.stringify(['group:group-1']));
  });

  it('keeps a collapsed named group collapsed across remount', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(['group:group-1']),
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
    const backend = container.querySelector<HTMLElement>(
      'section[aria-label="Backend"]',
    );
    expect(backend?.textContent).not.toContain('API review');
    expect(container.textContent).toContain('Release notes');
  });

  it('keeps an expanded group expanded across remount after clearing collapse', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(['group:group-1']),
    );

    renderSidebar();
    await flushSidebar();
    act(() => click(groupHeader('Backend')));
    await flushSidebar();
    expect(container.textContent).toContain('API review');
    expect(
      window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY),
    ).toBe(JSON.stringify([]));

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('API review');
  });
});
