// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient, DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { RecentSessions } from './RecentSessions';

vi.mock('../../i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const session = (
  sessionId: string,
  updatedAt: string,
  extra: Partial<DaemonSessionSummary> = {},
): DaemonSessionSummary => ({
  sessionId,
  workspaceCwd: '/project',
  displayName: sessionId,
  updatedAt,
  ...extra,
});

let root: Root;
let container: HTMLDivElement;
let listWorkspaceSessionsPage: ReturnType<typeof vi.fn>;
let listStandaloneSessionsPage: ReturnType<typeof vi.fn>;
let stableClient: DaemonClient | undefined;
let onOpen: ReturnType<typeof vi.fn>;

async function render(currentSessionId = 'standalone', refreshPaused = false) {
  const client = (stableClient ??= {
    listWorkspaceSessionsPage,
    listStandaloneSessionsPage,
  } as unknown as DaemonClient);
  await act(async () =>
    root.render(
      <RecentSessions
        client={client}
        onNewSession={() => {}}
        newSessionDisabled={false}
        workspaces={[
          { id: 'p', cwd: '/project', primary: true, trusted: true },
          { id: 'other', cwd: '/other', primary: false, trusted: true },
          {
            id: 'untrusted',
            cwd: '/untrusted',
            primary: false,
            trusted: false,
          },
        ]}
        includeStandalone
        sourceMetadataEnabled
        organizationEnabled
        currentSessionId={currentSessionId}
        refreshKey={0}
        refreshPaused={refreshPaused}
        renderSession={(entry) => (
          <button
            title={`${entry.session.displayName} · ${entry.workspaceCwd?.slice(1) ?? 'sidebar.noWorkspace'}`}
            onClick={() => onOpen(entry)}
          >
            {entry.session.displayName}
          </button>
        )}
      />,
    ),
  );
}
function buttons() {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      'button[title]:not([aria-label])',
    ),
  ];
}
async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

beforeEach(() => {
  stableClient = undefined;
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listWorkspaceSessionsPage = vi.fn().mockResolvedValue({ sessions: [] });
  listStandaloneSessionsPage = vi.fn().mockResolvedValue({ sessions: [] });
  onOpen = vi.fn();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('recent sessions', () => {
  it('merges independent workspace and standalone catalogs by activity and opens each scope', async () => {
    listWorkspaceSessionsPage.mockImplementation(async (cwd: string) => ({
      sessions: [
        session(
          'same-id',
          cwd === '/other' ? '2026-10-20T12:00:00Z' : '2026-10-20T10:00:00Z',
          { isPinned: false },
        ),
      ],
    }));
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [
        session('standalone', '2026-10-20T11:00:00Z', {
          sourceType: 'standalone',
        }),
      ],
    });
    await render();
    expect(buttons().map((button) => button.title)).toEqual([
      'same-id · other',
      'standalone · sidebar.noWorkspace',
      'same-id · project',
    ]);
    expect(listWorkspaceSessionsPage.mock.calls.map((call) => call[0])).toEqual(
      ['/project', '/other'],
    );
    expect(listWorkspaceSessionsPage.mock.calls[0][1]).toMatchObject({
      sourceType: 'default',
      archiveState: 'active',
    });
    expect(listWorkspaceSessionsPage.mock.calls[0][1]).toMatchObject({
      view: 'organized',
      group: 'all',
    });
    await click(buttons()[0]);
    expect(onOpen.mock.lastCall?.[0].workspaceCwd).toBe('/other');
    await click(buttons()[1]);
    expect(onOpen.mock.lastCall?.[0].workspaceCwd).toBeUndefined();
  });

  it('continues past pages containing only excluded sessions and deduplicates', async () => {
    listWorkspaceSessionsPage.mockImplementation(
      async (cwd: string, options: { cursor?: string }) => {
        if (cwd !== '/project') return { sessions: [] };
        if (options.cursor)
          return {
            sessions: [
              session('valid', '2026-10-20'),
              session('valid', '2026-10-20'),
            ],
          };
        return {
          nextCursor: 'next',
          sessions: [
            session('child', '2026-10-21', { parentSessionId: 'parent' }),
            session('pinned', '2026-10-21', { isPinned: true }),
            session('archived', '2026-10-21', { isArchived: true }),
            session('channel', '2026-10-21', { sourceType: 'channel' }),
            session('live', '2026-10-21', { sourceId: 'realtime_voice:call' }),
          ],
        };
      },
    );
    await render();
    expect(buttons().map((button) => button.title)).toEqual([
      'valid · project',
    ]);
    expect(listWorkspaceSessionsPage).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ cursor: 'next' }),
    );
  });

  it('keeps existing row nodes visible while a session switch refresh is pending', async () => {
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [session('chat', '2026-10-20')],
    });
    await render();
    const row = buttons()[0];
    listStandaloneSessionsPage.mockReturnValue(new Promise(() => {}));
    await render('another-chat');
    expect(buttons()[0]).toBe(row);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('keeps rows while switching and discards an obsolete in-flight catalog response', async () => {
    vi.useFakeTimers();
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [session('chat', '2026-10-20')],
    });
    await render();
    const row = buttons()[0];
    let resolvePage!: (page: { sessions: DaemonSessionSummary[] }) => void;
    listStandaloneSessionsPage.mockReturnValue(
      new Promise((resolve) => {
        resolvePage = resolve;
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    const calls = listStandaloneSessionsPage.mock.calls.length;
    await render('next-chat', true);
    await act(async () => {
      resolvePage({ sessions: [] });
    });
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    expect(buttons()[0]).toBe(row);
    expect(listStandaloneSessionsPage).toHaveBeenCalledTimes(calls);
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [session('next-chat', '2026-10-21')],
    });
    await render('next-chat', false);
    expect(buttons()[0].textContent).toBe('next-chat');
  });

  it('persists an expanded-to-collapsed-to-expanded round trip across remounts', async () => {
    const key = 'qwen.web-shell.sidebar.workspace-expanded:recent-sessions';
    window.localStorage.setItem(key, 'true');
    await render();
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(listStandaloneSessionsPage).toHaveBeenCalledTimes(1);

    await click(container.querySelector<HTMLButtonElement>('button')!);
    expect(window.localStorage.getItem(key)).toBe('false');
    await act(async () => root.unmount());
    root = createRoot(container);
    listWorkspaceSessionsPage.mockClear();
    listStandaloneSessionsPage.mockClear();
    await render();
    expect(
      container.querySelector('button')?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(listWorkspaceSessionsPage).not.toHaveBeenCalled();
    expect(listStandaloneSessionsPage).not.toHaveBeenCalled();

    await click(container.querySelector<HTMLButtonElement>('button')!);
    expect(window.localStorage.getItem(key)).toBe('true');
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(listStandaloneSessionsPage).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    listWorkspaceSessionsPage.mockClear();
    listStandaloneSessionsPage.mockClear();
    await render();
    expect(
      container.querySelector('button')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(listStandaloneSessionsPage).toHaveBeenCalledTimes(1);
  });

  it('stops polling while collapsed and reads again when expanded', async () => {
    vi.useFakeTimers();
    await render();
    await click(container.querySelector<HTMLButtonElement>('button')!);
    listWorkspaceSessionsPage.mockClear();
    listStandaloneSessionsPage.mockClear();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(listWorkspaceSessionsPage).not.toHaveBeenCalled();
    expect(listStandaloneSessionsPage).not.toHaveBeenCalled();
    await click(container.querySelector<HTMLButtonElement>('button')!);
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(listStandaloneSessionsPage).toHaveBeenCalledTimes(1);
  });

  it('keeps successful sources visible when another fails and supports retry', async () => {
    listWorkspaceSessionsPage.mockRejectedValue(
      new Error('workspace unavailable'),
    );
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [
        session('standalone', '2026-10-20', { sourceType: 'standalone' }),
      ],
    });
    await render();
    expect(buttons()).toHaveLength(1);
    const retry = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'sidebar.loadFailed')!;
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [session('recovered', '2026-10-21')],
    });
    await click(retry);
    expect(
      buttons().some((button) => button.title.startsWith('recovered')),
    ).toBe(true);
    expect(container.textContent).not.toContain('sidebar.loadFailed');
  });

  it('shows five previews, expands to twenty, and refreshes activity order', async () => {
    vi.useFakeTimers();
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: Array.from({ length: 25 }, (_, i) =>
        session(`chat-${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`, {
          sourceType: 'standalone',
        }),
      ),
    });
    await render();
    expect(buttons()).toHaveLength(5);
    await click(
      [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'sidebar.showAllSessions',
      )!,
    );
    expect(buttons()).toHaveLength(20);
    listStandaloneSessionsPage.mockResolvedValue({
      sessions: [session('newest', '2026-10-26', { sourceType: 'standalone' })],
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(buttons()[0].title).toBe('newest · sidebar.noWorkspace');
  });
});
