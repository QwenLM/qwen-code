// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STANDALONE_SESSIONS_CAPABILITY,
  type DaemonSessionArchiveState,
  type DaemonStandaloneSessionSummary,
} from '@qwen-code/sdk/daemon';
import { createSidebarMocks } from '../../test/sidebarHarness';

const mocks = createSidebarMocks({
  workspaceCapabilities: {
    qwenCodeVersion: '1.2.3',
    features: [STANDALONE_SESSIONS_CAPABILITY],
  },
});
const { connection, workspace } = mocks;
const list = vi.fn();
const archive = vi.fn();
const unarchive = vi.fn();
const deleteSession = vi.fn();
const rename = vi.fn();
const exportSession = vi.fn();
const t = vi.fn((key: string) => key);
let streamingState = 'idle';

// Standalone client methods are suite-specific; they ride on the stable
// workspace client the harness creates (the component never re-fetches it).
Object.assign(workspace.client, {
  listStandaloneSessionsPage: list,
  archiveStandaloneSessions: archive,
  unarchiveStandaloneSessions: unarchive,
  deleteStandaloneSessions: deleteSession,
  renameStandaloneSession: rename,
  exportStandaloneSession: exportSession,
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useStreamingState: () => streamingState,
  useWorkspace: () => workspace,
}));

vi.mock('../../i18n', () => ({
  useI18n: () => ({ t }),
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
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    t.mockImplementation((key: string) => key);
    list.mockReset();
    archive.mockReset();
    unarchive.mockReset();
    deleteSession.mockReset();
    rename.mockReset();
    exportSession.mockReset();
    streamingState = 'idle';
    connection.sessionContext = { kind: 'standalone' };
    rename.mockResolvedValue(undefined);
    exportSession.mockResolvedValue({
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
    list.mockImplementation(
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
    expect(newSession?.parentElement?.className).toContain(
      'projectsHeaderActions',
    );
    const sessions = container.querySelector(
      '[data-testid="standalone-active-group"] > div:nth-child(2)',
    );
    expect(sessions?.className).not.toContain('pl-5');
    const header = container.querySelector<HTMLButtonElement>(
      '[data-testid="standalone-active-group"] > div > button',
    )!;
    expect(header.parentElement?.className).toContain('projectsHeader');
    expect(header.className).toContain('projectsHeaderToggle');
    expect(header.querySelector('span + svg')?.classList).toContain(
      'lucide-chevron-down',
    );
    header.focus();
    await act(async () =>
      header.dispatchEvent(
        new MouseEvent('click', { bubbles: true, detail: 1 }),
      ),
    );
    expect(document.activeElement).not.toBe(header);
    expect(header.querySelector('span + svg')?.classList).toContain(
      'lucide-chevron-right',
    );
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
    expect(list).toHaveBeenCalledWith({
      archiveState: 'active',
      pageSize: 50,
    });
  });

  it.each(['active', 'archived'] as const)(
    'persists %s collapse across remounts without collapsing the other group',
    async (archiveState) => {
      const collapsedTitle =
        archiveState === 'active' ? 'Active chat' : 'Archived chat';
      const otherState = archiveState === 'active' ? 'archived' : 'active';
      const otherTitle =
        archiveState === 'active' ? 'Archived chat' : 'Active chat';
      await render({ archiveState, currentSessionId: archiveState });
      const toggle = () =>
        container.querySelector<HTMLButtonElement>(
          `[data-testid="standalone-${archiveState}-group"] > div > button`,
        )!;
      await act(async () => toggle().click());
      expect(container.textContent).not.toContain(collapsedTitle);
      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ archiveState, currentSessionId: archiveState });
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain(collapsedTitle);

      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ archiveState: otherState });
      expect(container.textContent).toContain(otherTitle);
      expect(
        container
          .querySelector('[aria-expanded]')
          ?.getAttribute('aria-expanded'),
      ).toBe('true');

      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ archiveState, currentSessionId: archiveState });
      await act(async () => toggle().click());
      expect(
        window.localStorage.getItem(
          `qwen.web-shell.sidebar.workspace-expanded:standalone:${archiveState}`,
        ),
      ).toBe('true');
      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ archiveState, currentSessionId: archiveState });
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain(collapsedTitle);
    },
  );

  it.each([
    ['active', false],
    ['active', true],
    ['archived', false],
    ['archived', true],
  ] as const)(
    'preserves the %s expanded preference %s when clicking its header during search',
    async (archiveState, expanded) => {
      const title = archiveState === 'active' ? 'Active chat' : 'Archived chat';
      const key = `qwen.web-shell.sidebar.workspace-expanded:standalone:${archiveState}`;
      const toggle = () =>
        container.querySelector<HTMLButtonElement>(
          `[data-testid="standalone-${archiveState}-group"] > div > button`,
        )!;
      await render({ archiveState });
      await act(async () => toggle().click());
      if (expanded) await act(async () => toggle().click());
      expect(window.localStorage.getItem(key)).toBe(String(expanded));

      await render({ archiveState, searchQuery: archiveState.toUpperCase() });
      expect(container.textContent).toContain(title);
      await act(async () => toggle().click());
      expect(window.localStorage.getItem(key)).toBe(String(expanded));
      expect(toggle().getAttribute('aria-expanded')).toBe(String(expanded));
      expect(container.textContent).toContain(title);

      await render({ archiveState, searchQuery: '   ' });
      expect(toggle().disabled).toBe(false);
      expect(container.textContent?.includes(title)).toBe(expanded);
      await act(async () => root.unmount());
      root = createRoot(container);
      await render({ archiveState });
      expect(toggle().getAttribute('aria-expanded')).toBe(String(expanded));
      expect(container.textContent?.includes(title)).toBe(expanded);
    },
  );

  it('loads only the requested archived group', async () => {
    const { renderSession } = await render({ archiveState: 'archived' });

    const group = container.querySelector(
      '[data-testid="standalone-archived-group"]',
    )!;
    expect(group.classList).toContain('mb-3');
    const header = group.querySelector('button[aria-expanded]')!;
    expect(header.parentElement?.className).toContain('headerRow');
    expect(header.querySelector('svg')?.classList).toContain(
      'lucide-circle-dashed',
    );
    expect(header.querySelector('span + svg')).toBeNull();
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
    expect(list).toHaveBeenCalledWith({
      archiveState: 'archived',
      pageSize: 50,
    });
  });

  it.each(['active', 'archived'] as const)(
    'keeps %s pagination reachable after an empty page',
    async (archiveState) => {
      list
        .mockResolvedValueOnce({ sessions: [], nextCursor: 'next' })
        .mockResolvedValueOnce({
          sessions: [
            summary('later', 'Later chat', {
              isArchived: archiveState === 'archived',
            }),
          ],
        });
      await render({ archiveState });

      const loadMore = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'sidebar.showAllSessions',
      );
      expect(loadMore).toBeDefined();
      await act(async () => loadMore!.click());

      expect(list).toHaveBeenLastCalledWith({
        archiveState,
        cursor: 'next',
        pageSize: 50,
      });
      expect(container.textContent).toContain('Later chat');
    },
  );

  it.each(['active', 'archived'] as const)(
    'hides the empty %s group regardless of its expanded preference',
    async (archiveState) => {
      list.mockResolvedValue({ sessions: [] });
      for (const expanded of [false, true]) {
        window.localStorage.setItem(
          `qwen.web-shell.sidebar.workspace-expanded:standalone:${archiveState}`,
          String(expanded),
        );
        await render({ archiveState });
        expect(container.querySelector('section')).toBeNull();
        await act(async () => root.unmount());
        root = createRoot(container);
      }
    },
  );

  it('keeps the group visible before the initial list request starts', () => {
    const html = renderToString(
      <StandaloneRecents
        archiveState="active"
        renderSession={() => null}
        onLoadSession={vi.fn()}
        onError={vi.fn()}
        onNotice={vi.fn()}
      />,
    );
    expect(html).toContain('standalone-active-group');
    expect(list).not.toHaveBeenCalled();
  });

  it('keeps a loading group visible until the list is confirmed empty', async () => {
    let resolveList!: (value: { sessions: never[] }) => void;
    list.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    );
    await render();
    expect(container.querySelector('section')).not.toBeNull();
    await act(async () => resolveList({ sessions: [] }));
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows the first session and hides the group after the last session leaves on refresh', async () => {
    list
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({ sessions: [summary('first', 'First chat')] })
      .mockResolvedValueOnce({ sessions: [] });
    await render({ refreshKey: 0 });
    expect(container.querySelector('section')).toBeNull();

    await render({ refreshKey: 1 });
    expect(container.textContent).toContain('First chat');

    await render({ refreshKey: 2 });
    expect(container.querySelector('section')).toBeNull();
  });

  it('does not reload when the selected session changes', async () => {
    const onError = vi.fn();
    await render({ onError });
    expect(list).toHaveBeenCalledTimes(1);

    await render({ currentSessionId: 'active', onError });

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('refreshes on standalone completion but not workspace completion', async () => {
    streamingState = 'responding';
    connection.sessionContext = { kind: 'workspace', cwd: '/workspace' };
    await render();

    streamingState = 'idle';
    await render();
    expect(list).toHaveBeenCalledTimes(1);

    connection.sessionContext = { kind: 'standalone' };
    streamingState = 'responding';
    await render();
    streamingState = 'idle';
    await render();

    expect(list).toHaveBeenCalledTimes(2);
  });

  it('filters sessions by label or id', async () => {
    await render({ searchQuery: 'missing' });
    expect(container.textContent).not.toContain('Active chat');
    expect(container.textContent).toContain('sidebar.noSessions');

    await render({ searchQuery: 'ACTIVE' });
    expect(container.textContent).toContain('Active chat');
  });

  it('shows five sessions until expanded', async () => {
    list.mockResolvedValue({
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
    list
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
    list
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
    expect(list).toHaveBeenLastCalledWith({
      archiveState: 'active',
      cursor: 'next',
      pageSize: 50,
    });
  });

  it('keeps a row visible when archive reports an item error', async () => {
    archive.mockResolvedValue({
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
    archive.mockResolvedValue({
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
    expect(container.querySelector('section')).toBeNull();
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it('treats an already archived row as a completed archive', async () => {
    archive.mockResolvedValue({
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
    unarchive.mockResolvedValue({
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
    archive.mockReturnValue(
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
    expect(archive).toHaveBeenCalledOnce();

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

    expect(exportSession).toHaveBeenCalledWith('active', {
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

    expect(rename).toHaveBeenCalledWith('active', 'Renamed chat');
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
    list.mockRejectedValueOnce(failure);
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
      list
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
      expect(list).toHaveBeenLastCalledWith({
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
    list.mockResolvedValue({
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
    rename.mockRejectedValueOnce(
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
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename).toHaveBeenLastCalledWith('active', 'Active chat');
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
      archive.mockResolvedValue({
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
      t.mockImplementation((key: string) => `ZH:${key}`);
      await render({ onError });
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'ZH:session.writerBlocked',
      );
    },
  );

  it('keeps a mutation failure visible after navigating to another session', async () => {
    let rejectArchive!: (error: Error) => void;
    archive.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectArchive = reject;
      }),
    );
    list.mockResolvedValue({
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
    list.mockRejectedValueOnce(new Error('list failed'));
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
          ? archive
          : operation === 'unarchive'
            ? unarchive
            : deleteSession;
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
