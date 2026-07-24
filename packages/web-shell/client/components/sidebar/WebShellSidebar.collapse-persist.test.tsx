// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
    const makeSessions = () => {
      const state = {
        sessions: [] as DaemonSessionSummary[],
        loading: false,
        error: null as Error | null,
        // Mirror useDaemonSessions: data is undefined until the first list
        // settles. Unit tests treat the mock as already settled.
        data: [] as DaemonSessionSummary[] | undefined,
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
const { COLLAPSED_SESSION_SECTIONS_STORAGE_KEY } = await import(
  './collapsedSessionSections'
);

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
          onOpenGoals={() => {}}
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
  active.data = active.sessions;
  pinned.sessions = [];
  pinned.data = pinned.sessions;
  archived.sessions = [];
  archived.data = archived.sessions;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('WebShellSidebar collapsed session group persistence', () => {
  it('shows the complete session name in a native tooltip', async () => {
    renderSidebar();
    await flushSidebar();

    const sessionName = container.querySelector<HTMLElement>(
      '[title="API review"]',
    );
    expect(sessionName?.textContent).toContain('API review');
  });

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

  it('tolerates corrupt localStorage data', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      'not valid json',
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('API review');
  });

  it('ignores non-array localStorage payloads', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify({ group: 'group-1' }),
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
  });

  it('does not crash when localStorage.setItem throws', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });

    renderSidebar();
    await flushSidebar();
    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
  });

  it('auto-collapses a brand-new section that appears mid-session', async () => {
    renderSidebar();
    await flushSidebar();
    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('section[aria-label="Red"]')).toBeNull();

    // Keep the same React root so the first-catalog latch stays flipped.
    // Color sections are derived from the session list, so tagging a session
    // mid-session invents a new `color:red` section id.
    active.sessions = [
      makeSession('session-a', {
        displayName: 'API review',
        groupId: 'group-1',
      }),
      makeSession('session-b', {
        displayName: 'Release notes',
        groupId: null,
        color: 'red',
      }),
    ];
    active.data = active.sessions;
    renderSidebar();
    await flushSidebar();

    const redHeader = groupHeader('Red');
    expect(redHeader.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('section[aria-label="Red"]')?.textContent,
    ).not.toContain('Release notes');
    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
  });

  it('restores multiple section kinds and keeps sibling ids when one is removed', async () => {
    active.sessions = [
      makeSession('session-a', {
        displayName: 'API review',
        groupId: 'group-1',
      }),
      makeSession('session-b', {
        displayName: 'Release notes',
        groupId: null,
      }),
      makeSession('session-c', {
        displayName: 'Hotfix',
        groupId: null,
        color: 'red',
      }),
    ];
    active.data = active.sessions;
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify(['color:red', 'group:group-1', 'recent']),
    );

    renderSidebar();
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('false');
    expect(groupHeader('Ungrouped').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(groupHeader('Red').getAttribute('aria-expanded')).toBe('false');

    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(groupHeader('Backend').getAttribute('aria-expanded')).toBe('true');
    expect(groupHeader('Ungrouped').getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(groupHeader('Red').getAttribute('aria-expanded')).toBe('false');
    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY) ??
          '[]',
      ),
    ).toEqual(['color:red', 'recent']);
  });

  it('does not clobber workspace-scoped collapse ids when primary toggles', async () => {
    window.localStorage.setItem(
      COLLAPSED_SESSION_SECTIONS_STORAGE_KEY,
      JSON.stringify([
        'group:group-1',
        'ws:other|group:g2',
        'ws:other|ungrouped',
      ]),
    );

    renderSidebar();
    await flushSidebar();
    act(() => click(groupHeader('Backend')));
    await flushSidebar();

    expect(
      JSON.parse(
        window.localStorage.getItem(COLLAPSED_SESSION_SECTIONS_STORAGE_KEY) ??
          '[]',
      ),
    ).toEqual(['ws:other|group:g2', 'ws:other|ungrouped']);
  });
});
