// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionSummary } from '@qwen-code/sdk/daemon';

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

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
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

function Probe({ cwd }: { cwd?: string }) {
  const { sessions, deleteSessions, releaseSession } = useScopedSessions(cwd, {
    autoLoad: true,
  });
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
});
