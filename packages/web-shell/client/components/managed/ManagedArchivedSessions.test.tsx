// @vitest-environment jsdom
import { act } from 'react';
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
