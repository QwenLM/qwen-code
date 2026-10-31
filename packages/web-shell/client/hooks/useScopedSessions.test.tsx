// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';
import { McpAppGeneratedUiOwnerContext } from '../mcpAppHostContext';

const primarySessions = [
  { sessionId: 'primary', workspaceCwd: '/primary' },
] as DaemonSessionSummary[];
const primaryDeleteSessions = vi.fn();
const primaryReload = vi.fn();
const primaryDeleteSession = vi.fn();
const primaryReleaseSession = vi.fn();
const listWorkspaceSessionsPage = vi.fn();
const deleteSessionsData = vi.fn();
const workspaceByCwd = vi.fn(() => ({
  listWorkspaceSessionsPage,
  deleteSessionsData,
}));
const workspaceClient = {
  workspaceByCwd,
  listWorkspaceSessionsPage: vi.fn(),
};

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useSessions: () => ({
    sessions: primarySessions,
    loading: false,
    error: undefined,
    reload: primaryReload,
    deleteSession: primaryDeleteSession,
    deleteSessions: primaryDeleteSessions,
    releaseSession: primaryReleaseSession,
  }),
  useWorkspace: () => ({ client: workspaceClient, workspaceCwd: '/primary' }),
}));

const { useScopedSessions } = await import('./useScopedSessions');

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let scopedResult: ReturnType<typeof useScopedSessions> | undefined;

function Probe({ cwd }: { cwd?: string }) {
  const result = useScopedSessions(cwd, { autoLoad: true });
  scopedResult = result;
  const { sessions, deleteSessions, releaseSession } = result;
  return (
    <div>
      <span data-testid="sessions">
        {sessions.map((session) => session.sessionId).join(',')}
      </span>
      <button
        data-action="delete"
        onClick={() => void deleteSessions(['secondary'])}
      >
        delete
      </button>
      <button
        data-action="release"
        onClick={() => void releaseSession?.('secondary')}
      >
        release
      </button>
    </div>
  );
}

function render(cwd?: string) {
  act(() => root!.render(<Probe cwd={cwd} />));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  scopedResult = undefined;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  listWorkspaceSessionsPage.mockReset();
  deleteSessionsData.mockReset();
  workspaceByCwd.mockClear();
  primaryDeleteSessions.mockReset();
  primaryReleaseSession.mockReset();
  workspaceClient.listWorkspaceSessionsPage.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('useScopedSessions', () => {
  it.each(['/retained-deletion', '/another-workspace'])(
    'captures confirmed deletions in the requested workspace from owner %s',
    async (ownerWorkspace) => {
      listWorkspaceSessionsPage.mockResolvedValue({ sessions: [] });
      deleteSessionsData.mockResolvedValue({
        removed: ['secondary'],
        notFound: ['missing'],
        errors: [{ sessionId: 'failed', error: 'busy' }],
      });
      const invalidateDeleted = vi.fn();
      const captureSessionDeletion = vi.fn(() => invalidateDeleted);
      let sessions: ReturnType<typeof useScopedSessions> | undefined;
      function Harness() {
        sessions = useScopedSessions('/retained-deletion');
        return null;
      }
      act(() => {
        root!.render(
          <McpAppGeneratedUiOwnerContext.Provider
            value={{
              scopeId: 'retained-scope',
              workspaceCwd: ownerWorkspace,
              invalidate: vi.fn(),
              captureSessionDeletion,
              subscribeInvalidation: () => () => undefined,
            }}
          >
            <Harness />
          </McpAppGeneratedUiOwnerContext.Provider>,
        );
      });
      expect(invalidateDeleted).not.toHaveBeenCalled();
      await act(async () => {
        await sessions!.deleteSessions(['secondary', 'missing', 'failed']);
      });
      expect(captureSessionDeletion).toHaveBeenCalledWith('/retained-deletion');
      expect(captureSessionDeletion.mock.invocationCallOrder[0]).toBeLessThan(
        deleteSessionsData.mock.invocationCallOrder[0]!,
      );
      expect(invalidateDeleted).toHaveBeenCalledExactlyOnceWith([
        'secondary',
        'missing',
      ]);
    },
  );

  it('loads and mutates sessions through the requested workspace', async () => {
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [
        { sessionId: 'secondary', workspaceCwd: '/secondary' },
      ] satisfies DaemonSessionSummary[],
    });
    deleteSessionsData.mockResolvedValue({
      removed: ['secondary'],
      notFound: [],
      errors: [],
    });

    render('/secondary');
    await act(async () => {
      await listWorkspaceSessionsPage.mock.results[0]?.value;
    });

    expect(
      container!.querySelector('[data-testid="sessions"]')?.textContent,
    ).toBe('secondary');
    expect(workspaceByCwd).toHaveBeenCalledWith('/secondary');
    expect(listWorkspaceSessionsPage).toHaveBeenCalledWith({
      sourceType: 'default',
    });

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-action="delete"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deleteSessionsData).toHaveBeenCalledWith(['secondary']);
    expect(primaryDeleteSessions).not.toHaveBeenCalled();
  });

  it('releases a scoped session without invalidating the primary catalog', async () => {
    listWorkspaceSessionsPage.mockResolvedValue({ sessions: [] });
    primaryReleaseSession.mockResolvedValue(undefined);

    render('/release-workspace');
    await act(async () => {
      await listWorkspaceSessionsPage.mock.results[0]?.value;
    });

    await act(async () => {
      container!
        .querySelector<HTMLButtonElement>('[data-action="release"]')!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(primaryReleaseSession).toHaveBeenCalledWith('secondary');
    expect(listWorkspaceSessionsPage).toHaveBeenCalledTimes(2);
    expect(workspaceClient.listWorkspaceSessionsPage).not.toHaveBeenCalled();
  });

  it('ignores an older workspace response after the cwd changes', async () => {
    let resolveA!: (page: { sessions: DaemonSessionSummary[] }) => void;
    let resolveB!: (page: { sessions: DaemonSessionSummary[] }) => void;
    listWorkspaceSessionsPage
      .mockImplementationOnce(
        () =>
          new Promise<{ sessions: DaemonSessionSummary[] }>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ sessions: DaemonSessionSummary[] }>((resolve) => {
            resolveB = resolve;
          }),
      );

    render('/a');
    render('/b');
    await act(async () => {
      resolveA({ sessions: [{ sessionId: 'a', workspaceCwd: '/a' }] });
      await Promise.resolve();
    });
    expect(
      container!.querySelector('[data-testid="sessions"]')?.textContent,
    ).toBe('');

    await act(async () => {
      resolveB({ sessions: [{ sessionId: 'b', workspaceCwd: '/b' }] });
      await Promise.resolve();
    });
    expect(
      container!.querySelector('[data-testid="sessions"]')?.textContent,
    ).toBe('b');
  });

  it('forwards the page-completeness markers from the scoped page', async () => {
    // A fresh cwd: the catalog store is shared across this file's tests, and
    // reusing /secondary would serve its cached page (no markers) instead of
    // fetching.
    listWorkspaceSessionsPage.mockResolvedValue({
      sessions: [
        { sessionId: 'secondary', workspaceCwd: '/markers' },
      ] satisfies DaemonSessionSummary[],
      nextCursor: 'cursor-2',
      truncated: true,
      liveMergeFailed: true,
    });
    render('/markers');
    await act(async () => {
      await listWorkspaceSessionsPage.mock.results[0]?.value;
    });
    // The workspace-locked split call site reads the markers off the union:
    // a bounded scoped page is not proof of absence, so the prune guard must
    // see them.
    expect(scopedResult?.nextCursor).toBe('cursor-2');
    expect(scopedResult?.truncated).toBe(true);
    expect(scopedResult?.liveMergeFailed).toBe(true);
    expect(scopedResult?.stale).toBe(false);
    expect(scopedResult?.error).toBeUndefined();
  });

  it('forwards a stale-retained scoped page after a failed refresh', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    listWorkspaceSessionsPage.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        return {
          sessions: [
            { sessionId: 'secondary', workspaceCwd: '/stale-refresh' },
          ] satisfies DaemonSessionSummary[],
        };
      }
      throw new Error('refresh failed');
    });
    // A fresh cwd: reusing a cached entry would skip the initial fetch (the
    // reload would then be call #1, i.e. the successful one).
    render('/stale-refresh');
    await act(async () => {
      await listWorkspaceSessionsPage.mock.results[0]?.value;
    });
    expect(scopedResult?.stale).toBe(false);
    expect(scopedResult?.error).toBeUndefined();
    // A failed refresh rejects the reload promise; the store keeps serving
    // the retained page, marked stale.
    await act(async () => {
      try {
        await scopedResult?.reload();
      } catch {
        // The store keeps serving the retained page.
      }
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(scopedResult?.stale).toBe(true);
    expect(scopedResult?.error).toBeInstanceOf(Error);
    warn.mockRestore();
  });
});
