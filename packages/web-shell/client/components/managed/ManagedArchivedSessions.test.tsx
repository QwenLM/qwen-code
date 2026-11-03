// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedArchivedSessions } from './ManagedArchivedSessions';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
} from './managed-agent-provider';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function summary(id: string): ManagedAgentSessionSummary {
  return {
    sessionId: id,
    title: `Archive ${id}`,
    createdAt: 1,
    updatedAt: 2,
    phase: 'completed',
    runtimeReady: true,
    runtimeState: 'ready',
    lifecycleStatus: 'archived',
    workspace: { workspaceId: 'ws-archive', cwdRelative: '.' },
    capabilities: { canSend: false, canCancel: false, sessionUnarchive: true },
  };
}

let container: HTMLDivElement;
let root: Root;
const listSessions = vi.fn<ManagedAgentProvider['listSessions']>();
const onSelectSession = vi.fn();
const onSessionsChange = vi.fn();
const onStatusChange = vi.fn();
let provider: ManagedAgentProvider;

beforeEach(() => {
  vi.resetAllMocks();
  provider = { listSessions } as unknown as ManagedAgentProvider;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(
      <I18nProvider language="en">
        <ManagedArchivedSessions
          provider={provider}
          clientId="client-archive"
          active={false}
          onSelectSession={onSelectSession}
          renderSessionActions={(session) => (
            <span>Actions {session.sessionId}</span>
          )}
          onSessionsChange={onSessionsChange}
          onStatusChange={onStatusChange}
        />
      </I18nProvider>,
    );
  });
}

it('appends archive pages without duplicates and preserves the selected workspace', async () => {
  listSessions
    .mockResolvedValueOnce({ sessions: [summary('a')], nextCursor: 'page-2' })
    .mockResolvedValueOnce({ sessions: [summary('a'), summary('b')] });
  await render();
  expect(container.textContent).toContain('Archive a');
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[aria-label="Load more Archived"]')!
      .click(),
  );
  expect(listSessions).toHaveBeenLastCalledWith(
    expect.objectContaining({
      clientId: 'client-archive',
      archiveState: 'archived',
      cursor: 'page-2',
    }),
  );
  const buttons = [...container.querySelectorAll('button')];
  expect(
    buttons.filter((button) => button.textContent === 'Archive a'),
  ).toHaveLength(1);
  await act(async () =>
    buttons.find((button) => button.textContent === 'Archive b')!.click(),
  );
  expect(onSelectSession).toHaveBeenCalledWith('b', 'ws-archive');
  expect(onStatusChange).toHaveBeenLastCalledWith({
    count: 2,
    loading: false,
    error: false,
  });
});

it('reports a failed archive query and retries it', async () => {
  listSessions
    .mockRejectedValueOnce(new Error('Archive unavailable'))
    .mockResolvedValueOnce({ sessions: [summary('a')] });
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'Archive unavailable',
  );
  expect(onStatusChange).toHaveBeenLastCalledWith({
    count: 0,
    loading: false,
    error: true,
  });
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button')!.click(),
  );
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('Archive a');
  expect(onStatusChange).toHaveBeenLastCalledWith({
    count: 1,
    loading: false,
    error: false,
  });
});

it('cancels archive reads on unmount and ignores a late response', async () => {
  let finish!: (value: { sessions: ManagedAgentSessionSummary[] }) => void;
  listSessions.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  const signal = listSessions.mock.calls[0][0].signal;
  const updates = onSessionsChange.mock.calls.length;
  await act(async () => root.render(null));
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ sessions: [summary('late')] }));
  expect(onSessionsChange).toHaveBeenCalledTimes(updates);
  expect(container.textContent).toBe('');
});

it('settles when the host re-renders with a fresh inline status callback', async () => {
  listSessions.mockResolvedValue({ sessions: [summary('a')] });
  const seen: Array<{ count: number; loading: boolean; error: boolean }> = [];
  function Host() {
    const [status, setStatus] = useState<{
      count: number;
      loading: boolean;
      error: boolean;
    }>({ count: -1, loading: true, error: false });
    return (
      <I18nProvider language="en">
        <span data-managed-archived-count>{status.count}</span>
        <ManagedArchivedSessions
          provider={provider}
          clientId="client-archive"
          active={false}
          onSelectSession={onSelectSession}
          renderSessionActions={(session) => <span>{session.sessionId}</span>}
          onSessionsChange={onSessionsChange}
          onStatusChange={(next) => {
            seen.push(next);
            // A host keeps the whole status object, so every emit is a fresh
            // state value and therefore a re-render with a new callback. Cap
            // the state writes so a regression fails on the count instead of
            // looping until the test times out.
            if (seen.length <= 6) setStatus({ ...next });
          }}
        />
      </I18nProvider>
    );
  }

  await act(async () => {
    root.render(<Host />);
  });

  // Re-emitting on callback identity alone would loop without bound: the host
  // stores the status in state and therefore re-renders with a new closure.
  expect(seen.length).toBeLessThan(5);
  expect(
    container.querySelector('[data-managed-archived-count]')?.textContent,
  ).toBe('1');
  expect(seen.at(-1)).toEqual({ count: 1, loading: false, error: false });
});

it('delivers the settled status to a callback supplied after the list settled', async () => {
  listSessions.mockResolvedValue({ sessions: [summary('a')] });
  const late = vi.fn();
  const tree = (onStatusChange?: (status: {
    count: number;
    loading: boolean;
    error: boolean;
  }) => void) => (
    <I18nProvider language="en">
      <ManagedArchivedSessions
        provider={provider}
        clientId="client-archive"
        active={false}
        onSelectSession={onSelectSession}
        renderSessionActions={(session) => <span>{session.sessionId}</span>}
        onSessionsChange={onSessionsChange}
        onStatusChange={onStatusChange}
      />
    </I18nProvider>
  );

  await act(async () => root.render(tree(undefined)));
  expect(container.textContent).toContain('Archive a');
  expect(late).not.toHaveBeenCalled();

  // A host that only learns the count after mounting supplies the callback
  // later; the settled list will not change again, so this transition is the
  // only chance to deliver it.
  await act(async () => root.render(tree(late)));
  expect(late).toHaveBeenCalledTimes(1);
  expect(late).toHaveBeenCalledWith({ count: 1, loading: false, error: false });
});
