// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STANDALONE_SESSIONS_CAPABILITY } from '@qwen-code/sdk/daemon';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  rename: vi.fn(),
  exportSession: vi.fn(),
  t: vi.fn((key: string) => key),
  workspace: {} as Record<string, unknown>,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useStreamingState: () => 'idle',
  useWorkspace: () => mocks.workspace,
}));

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: mocks.t }),
}));

vi.mock('../dialogs/DialogShell', () => ({
  DialogShell: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => children,
  DropdownMenuGroup: ({ children }: { children: ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: () => void;
  }) => <button onClick={onSelect}>{children}</button>,
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
    mocks.list.mockReset();
    mocks.archive.mockReset();
    mocks.unarchive.mockReset();
    mocks.rename.mockReset();
    mocks.exportSession.mockReset();
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
      collapsed?: boolean;
      currentSessionId?: string;
      currentSessionReady?: boolean;
      onError?: (error: unknown, message: string) => void;
      onRenameSession?: (sessionId: string, displayName: string) => void;
      onLoadSession?: (sessionId: string) => Promise<void> | void;
    } = {},
  ) {
    const onError = options.onError ?? vi.fn();
    const onRenameSession = options.onRenameSession ?? vi.fn();
    await act(async () => {
      root.render(
        <StandaloneRecents
          collapsed={options.collapsed ?? false}
          currentSessionId={options.currentSessionId}
          currentSessionReady={options.currentSessionReady}
          onExpand={vi.fn()}
          onLoadSession={options.onLoadSession ?? vi.fn()}
          onError={onError}
          onRenameSession={onRenameSession}
          onNotice={vi.fn()}
        />,
      );
    });
    return { onError, onRenameSession };
  }

  it.each(['session_writer_conflict', 'session_writer_unavailable'])(
    'leaves %s open feedback to the active conversation',
    async (code) => {
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
    },
  );

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

  it('lists only top-level active chats without exposing the internal cwd', async () => {
    await render();

    expect(container.textContent).toContain('Active chat');
    expect(container.textContent).not.toContain('Child chat');
    expect(container.textContent).not.toContain('/private/standalone');
    expect(mocks.list).toHaveBeenCalledWith({
      archiveState: 'active',
      pageSize: 50,
    });
    expect(mocks.list).not.toHaveBeenCalledWith(
      expect.objectContaining({ archiveState: 'archived' }),
    );
  });

  it('loads archived chats only after the archived lane is expanded', async () => {
    await render();
    const archivedToggle = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('sidebar.archivedTitle'));

    await act(async () => archivedToggle?.click());

    expect(container.textContent).toContain('Archived chat');
    expect(mocks.list).toHaveBeenCalledWith({
      archiveState: 'archived',
      pageSize: 50,
    });
  });

  it('preserves appended active pages across export and archived expansion', async () => {
    mocks.list.mockImplementation(
      async ({
        archiveState,
        cursor,
      }: {
        archiveState: string;
        cursor?: string;
      }) => {
        if (archiveState === 'archived') {
          return {
            sessions: [
              summary('archived', 'Archived chat', { isArchived: true }),
            ],
          };
        }
        return cursor === 'page-2'
          ? { sessions: [summary('page-2', 'Page two chat')] }
          : {
              sessions: [summary('page-1', 'Page one chat')],
              nextCursor: 'page-2',
            };
      },
    );
    await render();
    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'sidebar.showAllSessions',
    );
    await act(async () => showAll?.click());
    expect(container.textContent).toContain('Page two chat');

    const exportButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((button) => button.textContent === 'sidebar.export');
    await act(async () => exportButtons.at(-1)?.click());
    await vi.waitFor(() => expect(mocks.exportSession).toHaveBeenCalledOnce());
    expect(container.textContent).toContain('Page two chat');
    expect(
      mocks.list.mock.calls.filter(
        ([options]) =>
          options.archiveState === 'active' && options.cursor === undefined,
      ),
    ).toHaveLength(1);

    const archivedToggle = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('sidebar.archivedTitle'));
    await act(async () => archivedToggle?.click());

    expect(container.textContent).toContain('Page two chat');
    expect(container.textContent).toContain('Archived chat');
    expect(
      mocks.list.mock.calls.filter(
        ([options]) =>
          options.archiveState === 'active' && options.cursor === undefined,
      ),
    ).toHaveLength(1);
  });

  it('preserves appended archived pages across collapse and reopen', async () => {
    mocks.list.mockImplementation(
      async ({
        archiveState,
        cursor,
      }: {
        archiveState: string;
        cursor?: string;
      }) => {
        if (archiveState === 'active') {
          return { sessions: [summary('active', 'Active chat')] };
        }
        return cursor === 'archived-page-2'
          ? {
              sessions: [
                summary('archived-2', 'Archived page two', {
                  isArchived: true,
                }),
              ],
            }
          : {
              sessions: [
                summary('archived-1', 'Archived page one', {
                  isArchived: true,
                }),
              ],
              nextCursor: 'archived-page-2',
            };
      },
    );
    await render();
    const archivedToggle = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('sidebar.archivedTitle'));

    await act(async () => archivedToggle?.click());
    const showAll = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'sidebar.showAllSessions',
    );
    await act(async () => showAll?.click());
    expect(container.textContent).toContain('Archived page two');

    await act(async () => archivedToggle?.click());
    await act(async () => archivedToggle?.click());

    expect(container.textContent).toContain('Archived page two');
    expect(container.textContent).not.toContain('sidebar.showAllSessions');
    expect(
      mocks.list.mock.calls.filter(
        ([options]) =>
          options.archiveState === 'archived' &&
          options.cursor === 'archived-page-2',
      ),
    ).toHaveLength(1);
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
    expect(container.textContent).not.toContain('sidebar.noRecents');
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
      if (archiveState === 'archived')
        mocks.list.mockResolvedValueOnce({ sessions: [] });
      mocks.list
        .mockResolvedValueOnce({
          sessions: [summary('first', 'First chat')],
          nextCursor: 'page-two',
        })
        .mockRejectedValueOnce(new Error('page failed'))
        .mockResolvedValueOnce({
          sessions: [summary('second', 'Second chat')],
        });
      const { onError } = await render();
      if (archiveState === 'archived') {
        await act(async () =>
          Array.from(container.querySelectorAll('button'))
            .find((button) => button.textContent === 'sidebar.archivedTitle')
            ?.click(),
        );
      }
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
    await act(async () =>
      rejectOld(
        Object.assign(new Error('old writer'), {
          body: { code: 'session_writer_conflict' },
        }),
      ),
    );
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

  it('preserves writer classification inside a successful batch envelope', async () => {
    mocks.archive.mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      errors: [
        {
          sessionId: 'active',
          code: 'session_writer_conflict',
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
  });

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

  it('refreshes the currently expanded archive lane after a delayed retry', async () => {
    let archived = false;
    mocks.archive
      .mockRejectedValueOnce(
        Object.assign(new Error('writer'), {
          body: { code: 'session_writer_conflict' },
        }),
      )
      .mockImplementation(async () => {
        archived = true;
        return { archived: ['active'], alreadyArchived: [], errors: [] };
      });
    mocks.list.mockImplementation(
      async ({ archiveState }: { archiveState: string }) => ({
        sessions:
          (archiveState === 'archived') === archived
            ? [summary('active', 'Active chat')]
            : [],
      }),
    );
    await render();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'sidebar.archive')
        ?.click(),
    );
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'sidebar.archivedTitle')
        ?.click(),
    );
    mocks.list.mockClear();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'common.retry')
        ?.click(),
    );
    expect(mocks.list).toHaveBeenCalledWith({
      archiveState: 'archived',
      pageSize: 50,
    });
    expect(container.textContent).toContain('Active chat');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('exposes a collapsed list failure through the Recents control', async () => {
    mocks.list.mockRejectedValueOnce(new Error('list failed'));
    const { onError } = await render({ collapsed: true });
    const button = container.querySelector('button');
    expect(button?.getAttribute('aria-label')).toContain(
      'sidebar.standaloneLoadFailed',
    );
    expect(button?.getAttribute('title')).toContain(
      'sidebar.standaloneLoadFailed',
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries an archived list failure without showing an empty archive', async () => {
    mocks.list
      .mockResolvedValueOnce({ sessions: [] })
      .mockRejectedValueOnce(new Error('archive list failed'))
      .mockResolvedValueOnce({
        sessions: [summary('archived', 'Archived chat')],
      });
    const { onError } = await render();
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'sidebar.archivedTitle')
        ?.click(),
    );
    expect(container.textContent).toContain('sidebar.standaloneLoadFailed');
    expect(container.textContent).not.toContain('sidebar.archivedEmpty');
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'common.retry')
        ?.click(),
    );
    expect(mocks.list).toHaveBeenLastCalledWith({
      archiveState: 'archived',
      pageSize: 50,
    });
    expect(container.textContent).toContain('Archived chat');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('waits for the other lane to finish paging before retrying the failed page', async () => {
    let finishArchivePage!: (value: {
      sessions: ReturnType<typeof summary>[];
    }) => void;
    mocks.list
      .mockResolvedValueOnce({
        sessions: [summary('active', 'Active chat')],
        nextCursor: 'active-two',
      })
      .mockRejectedValueOnce(new Error('active page failed'))
      .mockResolvedValueOnce({
        sessions: [summary('archived', 'Archived chat')],
        nextCursor: 'archived-two',
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishArchivePage = resolve;
        }),
      )
      .mockResolvedValueOnce({ sessions: [summary('next', 'Next chat')] });
    await render();
    const click = async (label: string, index = 0) =>
      act(async () =>
        Array.from(container.querySelectorAll('button'))
          .filter((button) => button.textContent === label)
          [index]?.click(),
      );
    await click('sidebar.showAllSessions');
    await click('sidebar.archivedTitle');
    await click('sidebar.showAllSessions', 1);
    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'common.retry',
    );
    expect(retry?.disabled).toBe(true);
    await act(async () => retry?.click());
    expect(mocks.list).toHaveBeenCalledTimes(4);
    await act(async () => finishArchivePage({ sessions: [] }));
    expect(retry?.disabled).toBe(false);
    await act(async () => retry?.click());
    expect(mocks.list).toHaveBeenLastCalledWith({
      archiveState: 'active',
      cursor: 'active-two',
      pageSize: 50,
    });
    expect(container.textContent).toContain('Active chat');
    expect(container.textContent).toContain('Next chat');
  });

  it('keeps a row visible when a batch archive reports an item error', async () => {
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

  it('treats an already-missing archive target as terminal success', async () => {
    mocks.archive.mockResolvedValue({
      archived: [],
      alreadyArchived: [],
      notFound: ['active'],
      errors: [],
    });
    const { onError } = await render();
    const archiveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.archive'),
    );

    await act(async () => archiveButton?.click());

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it('treats an already-missing unarchive target as terminal success', async () => {
    mocks.unarchive.mockResolvedValue({
      unarchived: [],
      alreadyActive: [],
      notFound: ['archived'],
      errors: [],
    });
    const { onError } = await render();
    const archivedToggle = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('sidebar.archivedTitle'));
    await act(async () => archivedToggle?.click());
    const unarchiveButton = Array.from(
      container.querySelectorAll('button'),
    ).find((button) => button.textContent?.includes('sidebar.unarchive'));

    await act(async () => unarchiveButton?.click());

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledWith({
      archiveState: 'archived',
      pageSize: 50,
    });
    expect(mocks.list.mock.calls.length).toBeGreaterThan(2);
  });

  it('dispatches a lifecycle action only once before React commits busy state', async () => {
    let resolveArchive:
      | ((value: {
          archived: string[];
          alreadyArchived: string[];
          errors: unknown[];
        }) => void)
      | undefined;
    mocks.archive.mockReturnValue(
      new Promise((resolve) => {
        resolveArchive = resolve;
      }),
    );
    await render();
    const archiveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.archive'),
    );

    act(() => {
      archiveButton?.click();
      archiveButton?.click();
    });

    expect(mocks.archive).toHaveBeenCalledOnce();
    await act(async () => {
      resolveArchive?.({
        archived: ['active'],
        alreadyArchived: [],
        errors: [],
      });
      await Promise.resolve();
    });
  });

  it('reports a confirmed rename after the exact standalone route succeeds', async () => {
    const { onRenameSession } = await render();
    const renameButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('sidebar.rename'),
    );

    await act(async () => renameButton?.click());
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'Renamed chat');
      input.dispatchEvent(new Event('input', { bubbles: true }));
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
});
