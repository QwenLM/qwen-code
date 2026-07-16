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
const listWorkspaceSessions = vi.fn();
const deleteSessionsData = vi.fn();
const workspaceByCwd = vi.fn(() => ({
  listWorkspaceSessions,
  deleteSessionsData,
}));
const workspaceClient = { workspaceByCwd };

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
  useWorkspace: () => ({ client: workspaceClient }),
}));

const { useScopedSessions } = await import('./useScopedSessions');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Probe({ cwd }: { cwd?: string }) {
  const { sessions, deleteSessions } = useScopedSessions(cwd, {
    autoLoad: true,
  });
  return (
    <div>
      <span data-testid="sessions">
        {sessions.map((session) => session.sessionId).join(',')}
      </span>
      <button onClick={() => void deleteSessions(['secondary'])}>delete</button>
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
  listWorkspaceSessions.mockReset();
  deleteSessionsData.mockReset();
  workspaceByCwd.mockClear();
  primaryDeleteSessions.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('useScopedSessions', () => {
  it('loads and mutates sessions through the requested workspace', async () => {
    listWorkspaceSessions.mockResolvedValue([
      { sessionId: 'secondary', workspaceCwd: '/wrong' },
    ] satisfies DaemonSessionSummary[]);
    deleteSessionsData.mockResolvedValue({
      removed: ['secondary'],
      notFound: [],
      errors: [],
    });

    render('/secondary');
    await act(async () => {
      await listWorkspaceSessions.mock.results[0]?.value;
    });

    expect(
      container!.querySelector('[data-testid="sessions"]')?.textContent,
    ).toBe('secondary');
    expect(workspaceByCwd).toHaveBeenCalledWith('/secondary');
    expect(listWorkspaceSessions).toHaveBeenCalledWith({
      pageSize: undefined,
      archiveState: undefined,
      view: undefined,
      group: undefined,
      sourceType: 'default',
    });

    await act(async () => {
      container!.querySelector('button')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(deleteSessionsData).toHaveBeenCalledWith(['secondary']);
    expect(primaryDeleteSessions).not.toHaveBeenCalled();
  });

  it('ignores an older workspace response after the cwd changes', async () => {
    let resolveA!: (sessions: DaemonSessionSummary[]) => void;
    let resolveB!: (sessions: DaemonSessionSummary[]) => void;
    listWorkspaceSessions
      .mockImplementationOnce(
        () =>
          new Promise<DaemonSessionSummary[]>((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<DaemonSessionSummary[]>((resolve) => {
            resolveB = resolve;
          }),
      );

    render('/a');
    render('/b');
    await act(async () => {
      resolveA([{ sessionId: 'a', workspaceCwd: '/a' }]);
      await Promise.resolve();
    });
    expect(
      container!.querySelector('[data-testid="sessions"]')?.textContent,
    ).toBe('');

    await act(async () => {
      resolveB([{ sessionId: 'b', workspaceCwd: '/b' }]);
      await Promise.resolve();
    });
    expect(
      container!.querySelector('[data-testid="sessions"]')?.textContent,
    ).toBe('b');
  });
});
