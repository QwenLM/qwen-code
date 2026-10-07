// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonSessionArchiveState,
  type DaemonStandaloneSessionSummary,
} from '@qwen-code/sdk/daemon';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  deleteSession: vi.fn(),
  rename: vi.fn(),
  exportSession: vi.fn(),
  t: vi.fn((key: string) => key),
  streamingState: 'idle',
  connection: { sessionContext: { kind: 'standalone' } } as {
    sessionContext?: { kind: string; cwd?: string };
  },
  workspace: {} as Record<string, unknown>,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => mocks.connection,
  useStreamingState: () => mocks.streamingState,
  useWorkspace: () => mocks.workspace,
}));

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: mocks.t }),
}));

vi.mock('../dialogs/DialogShell', () => ({
  DialogShell: ({ children }: { children: ReactNode }) => children,
}));

import { StandaloneRecents } from './StandaloneRecents';

const summary = (
  sessionId: string,
  displayName: string,
  extra: Record<string, unknown> = {},
) => ({
  sessionId,
  displayName,
  workspaceCwd: `/private/standalone/${sessionId}`,
  sourceType: 'standalone',
  context: { kind: 'standalone' },
  ...extra,
});

describe('StandaloneRecents', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.t.mockImplementation((key: string) => key);
    mocks.list.mockReset();
    mocks.archive.mockReset();
    mocks.unarchive.mockReset();
    mocks.deleteSession.mockReset();
    mocks.rename.mockReset();
    mocks.exportSession.mockReset();
    mocks.streamingState = 'idle';
    mocks.connection = { sessionContext: { kind: 'standalone' } };
    mocks.rename.mockResolvedValue(undefined);
    mocks.exportSession.mockResolvedValue({
      content: '<p>chat</p>',
      filename: 'chat.html',
      mimeType: 'text/html',
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:standalone-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mocks.list.mockImplementation(
      async ({ archiveState }: { archiveState: string }) => ({
        sessions:
          archiveState === 'archived'
            ? [summary('archived', 'Archived chat', { isArchived: true })]
            : [
                summary('active', 'Active chat'),
                summary('child', 'Child chat', { parentSessionId: 'active' }),
              ],
      }),
    );
    mocks.workspace = {
      capabilities: { features: [STANDALONE_SESSIONS_CAPABILITY] },
      client: {
        listStandaloneSessionsPage: mocks.list,
        archiveStandaloneSessions: mocks.archive,
        unarchiveStandaloneSessions: mocks.unarchive,
        deleteStandaloneSessions: mocks.deleteSession,
        renameStandaloneSession: mocks.rename,
        exportStandaloneSession: mocks.exportSession,
      },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(
    options: {
      archiveState?: DaemonSessionArchiveState;
      currentSessionId?: string;
      currentSessionReady?: boolean;
      refreshKey?: number;
      searchQuery?: string;
      onError?: (error: unknown, message: string) => void;
      onRenameSession?: (sessionId: string, displayName: string) => void;
      onLoadSession?: (sessionId: string) => Promise<void> | void;
      onNewSession?: () => void;
      onMutated?: () => void;
    } = {},
  ) {
    const onError = options.onError ?? vi.fn();
    const onRenameSession = options.onRenameSession ?? vi.fn();
    const onMutated = options.onMutated ?? vi.fn();
    const renderSession = vi.fn(
      (
        session: DaemonStandaloneSessionSummary,
        actions: {
          onOpen: () => void;
          onRename: () => void;
          onExport: () => void;
          onArchive?: () => void;
          onUnarchive?: () => void;
          onDelete: () => void;
        },
      ) => (
        <div key={session.sessionId}>
          <button onClick={actions.onOpen}>{session.displayName}</button>
          <button onClick={actions.onRename}>sidebar.rename</button>
          <button onClick={actions.onExport}>sidebar.export</button>
          {actions.onArchive && (
            <button onClick={actions.onArchive}>sidebar.archive</button>
          )}
          {actions.onUnarchive && (
            <button onClick={actions.onUnarchive}>sidebar.unarchive</button>
          )}
          <button onClick={actions.onDelete}>sidebar.delete</button>
        </div>
      ),
    );
    await act(async () => {
      root.render(
        <StandaloneRecents
          archiveState={options.archiveState ?? 'active'}
          currentSessionId={options.currentSessionId}
          currentSessionReady={options.currentSessionReady}
          refreshKey={options.refreshKey}
          searchQuery={options.searchQuery}
          onNewSession={options.onNewSession}
          renderSession={renderSession}
          onLoadSession={options.onLoadSession ?? vi.fn()}
          onError={onError}
          onRenameSession={onRenameSession}
          onMutated={onMutated}
          onNotice={vi.fn()}
        />,
      );
    });
    return { onError, onRenameSession, onMutated, renderSession };
  }

  it('lists only top-level active chats under No workspace', async () => {
    const onNewSession = vi.fn();
    await render({ onNewSession });

    expect(container.textContent).toContain('sidebar.noWorkspaceSessions');
    expect(
      container
        .querySelector('[data-testid="standalone-active-group"] > div > button')
        ?.querySelectorAll('svg'),
    ).toHaveLength(1);
    const newSession = container.querySelector<HTMLButtonElement>(
      '[data-testid="standalone-active-group"] button[aria-label="sidebar.newTask"]',
    );
    expect(newSession?.parentElement?.className).toContain('invisible');
    const sessions = container.querySelector(
      '[data-testid="standalone-active-group"] > div:nth-child(2)',
    );
    expect(sessions?.className).not.toContain('pl-5');
    const header = container.querySelector<HTMLButtonElement>(
      '[data-testid="standalone-active-group"] > div > button',
    )!;
    header.focus();
    await act(async () =>
      header.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      ),
    );
    expect(document.activeElement).not.toBe(header);
    await act(async () =>
      header.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      ),
    );
    await act(async () => newSession?.click());
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Active chat');
    expect(container.textContent).not.toContain('Child chat');
    expect(container.textContent).not.toContain('/private/standalone');
    expect(mocks.list).toHaveBeenCalledWith({
      archiveState: 'active',
      pageSize: 50,
    });
  });

  it('loads only the requested archived group', async () => {
    const { renderSession } = await render({ archiveState: 'archived' });

    expect(container.textContent).toContain('Archived chat');
    expect(container.textContent).not.toContain('Active chat');
    expect(renderSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'archived' }),
      expect.objectContaining({
        active: false,
        busy: false,
        isArchived: true,
        onUnarchive: expect.any(Function),
      }),
    );
    expect(mocks.list).toHaveBeenCalledWith({
      archiveState: 'archived',
      pageSize: 50,
    });
  });

  it('keeps archived pagination reachable after an empty page', async () => {
    mocks.list
      .mockResolvedValueOnce({ sessions: [], nextCursor: 'next' })
      .mockResolvedValueOnce({
        sessions: [
          summary('later', 'Later archived chat', { isArchived: true }),
        ],
      });
    await render({ archiveState: 'archived' });

    const loadMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'sidebar.showAllSessions',
    );
    expect(loadMore).toBeDefined();
    await act(async () => loadMore!.click());

    expect(mocks.list).toHaveBeenLastCalledWith({
      archiveState: 'archived',
      cursor: 'next',
      pageSize: 50,
    });
    expect(container.textContent).toContain('Later archived chat');
  });

  it('aligns the empty state with the workspace label', async () => {
    mocks.list.mockResolvedValue({ sessions: [] });
    await render();

    expect(container.querySelector('div[class*="empty"]')?.textContent).toBe(
      'sidebar.noSessions',
    );
  });

  it('does not reload when the selected session changes', async () => {
    const onError = vi.fn();
    await render({ onError });
    expect(mocks.list).toHaveBeenCalledTimes(1);

    await render({ currentSessionId: 'active', onError });

    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('refreshes on standalone completion but not workspace completion', async () => {
    mocks.streamingState = 'responding';
    mocks.connection = {
      sessionContext: { kind: 'workspace', cwd: '/workspace' },
    };
    await render();

    mocks.streamingState = 'idle';
    await render();
    expect(mocks.list).toHaveBeenCalledTimes(1);

    mocks.connection = { sessionContext: { kind: 'standalone' } };
    mocks.streamingState = 'responding';
    await render();
    mocks.streamingState = 'idle';
    await render();

    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('filters sessions by label or id', async () => {
    await render({ searchQuery: 'missing' });
    expect(container.textContent).not.toContain('Active chat');
    expect(container.textContent).toContain('sidebar.noSessions');

    await render({ searchQuery: 'ACTIVE' });
    expect(container.textContent).toContain('Active chat');
  });

  it('shows five sessions until expanded', async () => {
    mocks.list.mockResolvedValue({
      sessions: Array.from({ length: 6 }, (_, index) =>
        summary(`session-${index + 1}`, `Chat ${index + 1}`),
      ),
    });
    await render();

    expect(container.textContent).toContain('Chat 5');
    expect(container.textContent).not.toContain('Chat 6');
    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'sidebar.showAllSessions',
    );

    await act(async () => showAll?.click());

    expect(container.textContent).toContain('Chat 6');
    expect(showAll?.isConnected).toBe(false);
  });

  it('unlocks pagination when a refresh replaces an in-flight page', async () => {
    let resolveMore!: (value: {
      sessions: DaemonStandaloneSessionSummary[];
    }) => void;
    mocks.list
      .mockResolvedValueOnce({
        sessions: [summary('active', 'Active chat')],
        nextCursor: 'next',
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveMore = resolve;
          }),
      )
      .mockResolvedValueOnce({
        sessions: [summary('active', 'Active chat')],
        nextCursor: 'next',
      });
    await render({ refreshKey: 0 });
    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'sidebar.showAllSessions',
    )!;

    await act(async () => {
      showAll.click();
      await Promise.resolve();
    });
    expect(showAll.disabled).toBe(true);

    await render({ refreshKey: 1 });
    expect(showAll.disabled).toBe(false);

    await act(async () => {
      resolveMore({ sessions: [summary('late', 'Late page')] });
      await Promise.resolve();
    });
    expect(showAll.disabled).toBe(false);
    expect(container.textContent).not.toContain('Late page');
  });

  it('reloads the loaded depth and drops sessions removed elsewhere', async () => {
    mocks.list
      .mockResolvedValueOnce({
        sessions: [
          summary('kept', 'Kept chat'),
          summary('removed', 'Removed chat'),
        ],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        sessions: [summary('later', 'Later chat')],
      })
      .mockResolvedValueOnce({
        sessions: [summary('kept', 'Kept chat')],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        sessions: [summary('later', 'Later chat')],
      });
    await render({ refreshKey: 0 });
    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'sidebar.showAllSessions',
    );
    await act(async () => showAll?.click());
    expect(container.textContent).toContain('Removed chat');
    expect(container.textContent).toContain('Later chat');

    await render({ refreshKey: 1 });

    expect(container.textContent).not.toContain('Removed chat');
    expect(container.textContent).toContain('Later chat');
    expect(mocks.list).toHaveBeenLastCalledWith({
      archiveState: 'active',
      cursor: 'next',
      pageSize: 50,
    });
  });

  it('keeps a row visible when archive reports an item error', async () => {
    mocks.archive.mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      errors: [{ sessionId: 'active', code: 'busy', message: 'still running' }],
    });
    const { onError } = await render();
    const archiveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.archive'),
    );

    await act(async () => archiveButton?.click());

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'still running' }),
      'sidebar.standaloneActionFailed',
    );
    expect(container.textContent).toContain('Active chat');
  });

  it('removes a successfully archived row and notifies its parent', async () => {
    mocks.archive.mockResolvedValue({
      archived: ['active'],
      alreadyArchived: [],
      errors: [],
    });
    const { onMutated } = await render();
    const archiveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.archive'),
    );

    await act(async () => archiveButton?.click());

    expect(container.textContent).not.toContain('Active chat');
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it('treats an already archived row as a completed archive', async () => {
    mocks.archive.mockResolvedValue({
      archived: [],
      alreadyArchived: ['active'],
      errors: [],
    });
    const { onError, onMutated } = await render();
    const archiveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.archive'),
    );

    await act(async () => archiveButton?.click());

    expect(container.textContent).not.toContain('Active chat');
    expect(onMutated).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats an already active row as a completed restore', async () => {
    mocks.unarchive.mockResolvedValue({
      unarchived: [],
      alreadyActive: ['archived'],
      errors: [],
    });
    const { onError, onMutated } = await render({ archiveState: 'archived' });
    const restoreButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.unarchive'),
    );

    await act(async () => restoreButton?.click());

    expect(container.textContent).not.toContain('Archived chat');
    expect(onMutated).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('ignores a second mutation while one is in flight', async () => {
    let finishArchive!: (value: {
      archived: string[];
      alreadyArchived: string[];
      errors: never[];
    }) => void;
    mocks.archive.mockReturnValue(
      new Promise((resolve) => {
        finishArchive = resolve;
      }),
    );
    await render();
    const archiveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.archive'),
    )!;

    await act(async () => {
      archiveButton.click();
      archiveButton.click();
      await Promise.resolve();
    });
    expect(mocks.archive).toHaveBeenCalledOnce();

    await act(async () => {
      finishArchive({
        archived: ['active'],
        alreadyArchived: [],
        errors: [],
      });
      await Promise.resolve();
    });
  });

  it('downloads an exported standalone conversation', async () => {
    await render();
    const exportButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.export'),
    );

    await act(async () => {
      exportButton?.click();
      await Promise.resolve();
    });

    expect(mocks.exportSession).toHaveBeenCalledWith('active', {
      format: 'html',
    });
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:standalone-export');
  });

  it('reports a confirmed rename', async () => {
    const { onRenameSession } = await render();
    const renameButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.rename'),
    );
    await act(async () => renameButton?.click());
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'Renamed chat');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input
        ?.closest('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(mocks.rename).toHaveBeenCalledWith('active', 'Renamed chat');
    expect(onRenameSession).toHaveBeenCalledWith('active', 'Renamed chat');
  });
  it.each([
    'session_writer_conflict',
    'session_writer_unavailable',
    'session_writer_lost',
    'session_transcript_changed',
  ])('leaves %s open feedback to the active conversation', async (code) => {
    const onLoadSession = vi.fn().mockRejectedValue(
      Object.assign(new Error('writer'), {
        body: { code },
      }),
    );
    const { onError } = await render({
      onLoadSession,
      currentSessionId: 'active',
    });
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Active chat')
        ?.click(),
    );
    expect(onLoadSession).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('clears an open error when the same session recovers outside Recents', async () => {
    const onLoadSession = vi
      .fn()
      .mockRejectedValue(new Error('network failed'));
    const { onError } = await render({
      onLoadSession,
      currentSessionId: 'active',
    });
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Active chat')
        ?.click(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'session.loadFailed',
    );
    await render({
      onLoadSession,
      onError,
      currentSessionId: 'active',
      currentSessionReady: true,
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onLoadSession).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it('shows a failed standalone open locally with an explicit retry', async () => {
    const error = new Error('load failed');
    const onLoadSession = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const { onError } = await render({
      onLoadSession,
    });
    const sessionButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Active chat',
    );

    await act(async () => sessionButton?.click());

    expect(onError).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'session.loadFailed',
    );
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'common.retry')
        ?.click(),
    );
    expect(onLoadSession).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a list failure without a false empty state or host toast', async () => {
    const failure = new Error('legacy owner in use');
    mocks.list.mockRejectedValueOnce(failure);
    const { onError } = await render();
    expect(container.textContent).toContain('sidebar.standaloneLoadFailed');
    expect(container.textContent).not.toContain('sidebar.noSessions');
    expect(console.warn).toHaveBeenCalledWith(
      '[web-shell] standalone session list failed:',
      failure,
    );
    expect(onError).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'common.retry')
        ?.click(),
    );
    expect(container.textContent).toContain('Active chat');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['active', 'archived'] as const)(
    'retries the failed %s page without discarding already loaded rows',
    async (archiveState) => {
      mocks.list
        .mockResolvedValueOnce({
          sessions: [summary('first', 'First chat')],
          nextCursor: 'page-two',
        })
        .mockRejectedValueOnce(new Error('page failed'))
        .mockResolvedValueOnce({
          sessions: [summary('second', 'Second chat')],
        });
      const { onError } = await render({ archiveState });
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'sidebar.showAllSessions')
          ?.click(),
      );
      expect(container.textContent).toContain('First chat');
      expect(container.textContent).toContain('sidebar.standaloneLoadFailed');
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'common.retry')
          ?.click(),
      );
      expect(mocks.list).toHaveBeenLastCalledWith({
        archiveState,
        cursor: 'page-two',
        pageSize: 50,
      });
      expect(container.textContent).toContain('First chat');
      expect(container.textContent).toContain('Second chat');
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it('ignores an old open failure after a newer session was selected', async () => {
    let rejectOld!: (error: Error) => void;
    mocks.list.mockResolvedValue({
      sessions: [summary('old', 'Old chat'), summary('new', 'New chat')],
    });
    const onLoadSession = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValue(undefined);
    const { onError } = await render({ onLoadSession });
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Old chat')
        ?.click(),
    );
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'New chat')
        ?.click(),
    );
    await act(async () => rejectOld(new Error('old request failed')));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('closes a blocked rename dialog so its local retry is reachable', async () => {
    mocks.rename.mockRejectedValueOnce(
      Object.assign(new Error('writer conflict'), {
        body: { code: 'session_writer_conflict' },
      }),
    );
    const { onError } = await render();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'sidebar.rename')
        ?.click(),
    );
    expect(container.querySelector('form')).not.toBeNull();
    await act(async () =>
      container
        .querySelector('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        ),
    );
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('session.writerBlocked');
    expect(onError).not.toHaveBeenCalled();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'common.retry')
        ?.click(),
    );
    expect(mocks.rename).toHaveBeenCalledTimes(2);
    expect(mocks.rename).toHaveBeenLastCalledWith('active', 'Active chat');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    'session_writer_conflict',
    'session_writer_unavailable',
    'session_writer_lost',
    'session_transcript_changed',
  ])(
    'preserves %s in batch diagnostics and translated local feedback',
    async (code) => {
      mocks.archive.mockResolvedValue({
        archived: [],
        alreadyArchived: [],
        errors: [
          {
            sessionId: 'active',
            code,
            message: 'writer conflict',
          },
        ],
      });
      const { onError } = await render();
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'sidebar.archive')
          ?.click(),
      );
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'session.writerBlocked',
      );
      expect(container.textContent).toContain('Active chat');
      expect(onError).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledWith(
        '[web-shell] standalone session action blocked by writer fence:',
        expect.objectContaining({ body: expect.objectContaining({ code }) }),
      );
      mocks.t.mockImplementation((key: string) => `ZH:${key}`);
      await render({ onError });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'ZH:session.writerBlocked',
      );
    },
  );

  it('keeps a mutation failure visible after navigating to another session', async () => {
    let rejectArchive!: (error: Error) => void;
    mocks.archive.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectArchive = reject;
      }),
    );
    mocks.list.mockResolvedValue({
      sessions: [
        summary('active', 'Active chat'),
        summary('other', 'Other chat'),
      ],
    });
    const { onError } = await render();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'sidebar.archive')
        ?.click(),
    );
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Other chat')
        ?.click(),
    );
    await act(async () =>
      rejectArchive(
        Object.assign(new Error('writer'), {
          body: { code: 'session_writer_conflict' },
        }),
      ),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'active: session.writerBlocked',
    );
    await render({
      onError,
      currentSessionId: 'other',
      currentSessionReady: true,
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'active: session.writerBlocked',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps an initially failing archived group visible for retry', async () => {
    mocks.list.mockRejectedValueOnce(new Error('list failed'));
    const { onError } = await render({ archiveState: 'archived' });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'sidebar.standaloneLoadFailed',
    );
    expect(container.textContent).not.toContain('sidebar.archivedEmpty');
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'common.retry')
        ?.click(),
    );
    expect(container.textContent).toContain('Archived chat');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(['archive', 'unarchive', 'delete'] as const)(
    'updates the group and parent after retrying a blocked %s',
    async (operation) => {
      const archiveState = operation === 'unarchive' ? 'archived' : 'active';
      const sessionId = archiveState;
      const action =
        operation === 'archive'
          ? mocks.archive
          : operation === 'unarchive'
            ? mocks.unarchive
            : mocks.deleteSession;
      const success =
        operation === 'archive'
          ? { archived: [sessionId], alreadyArchived: [], notFound: [] }
          : operation === 'unarchive'
            ? { unarchived: [sessionId], alreadyActive: [], notFound: [] }
            : { removed: [sessionId], notFound: [], fileCleanupPending: [] };
      action
        .mockRejectedValueOnce(
          Object.assign(new Error('writer blocked'), {
            body: { code: 'session_writer_conflict' },
          }),
        )
        .mockResolvedValueOnce({ ...success, errors: [] });
      const { onError, onMutated } = await render({ archiveState });
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === `sidebar.${operation}`)
          ?.click(),
      );
      if (operation === 'delete') {
        await act(async () =>
          Array.from(container.querySelectorAll('button'))
            .findLast((button) => button.textContent === 'sidebar.delete')
            ?.click(),
        );
      }
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'session.writerBlocked',
      );
      expect(onMutated).not.toHaveBeenCalled();
      await act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'common.retry')
          ?.click(),
      );
      expect(action).toHaveBeenCalledTimes(2);
      expect(action).toHaveBeenLastCalledWith([sessionId]);
      expect(onMutated).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain(
        archiveState === 'active' ? 'Active chat' : 'Archived chat',
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    },
  );
});
