// @vitest-environment jsdom
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonSessionTranscriptPage,
  DaemonSessionTurnIndexPage,
} from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types';
import { I18nProvider } from '../i18n';
import {
  createDaemonTurnNavigationStore,
  type DaemonHistoryNavigationStore,
  type DaemonTurnNavigationClient,
} from '../daemon/session/turn-navigation-store';
import type { MessageListHandle } from './MessageList';

const observed = vi.hoisted(() => ({
  store: undefined as DaemonHistoryNavigationStore | undefined,
}));
vi.mock('../daemon/session/DaemonSessionProvider', () => ({
  useDaemonHistoryNavigationStore: () => observed.store,
}));
vi.mock('../WebShellContexts', async () => {
  const { createContext } = await import('react');
  return { CompactModeContext: createContext(false) };
});
vi.mock('./MessageItem', () => ({
  MessageItem: ({ message }: { message: Message }) => <div>{message.id}</div>,
}));
vi.mock('./messages/ToolApproval', () => ({ ToolApproval: () => null }));
vi.mock('./messages/AskUserQuestion', () => ({ AskUserQuestion: () => null }));
const { TranscriptViewport } = await import('./TranscriptViewport');

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const head: DaemonSessionTurnIndexPage = {
  v: 1,
  sessionId: 'session',
  snapshot: 'snapshot',
  totalTurns: 4,
  start: 0,
  turns: Array.from({ length: 4 }, (_, ordinal) => ({
    ordinal,
    turnId: ordinal === 0 ? 'old' : `turn-${ordinal}`,
    kind: 'prompt' as const,
    label: 'old',
  })),
};
const page: DaemonSessionTranscriptPage = {
  v: 1,
  sessionId: 'session',
  events: [],
  targetRecordId: 'old',
  hasMore: false,
};

async function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const settle = () =>
    act(() => {
      for (let round = 0; frames.size && round < 20; round++) {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(round));
      }
    });
  const positions = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(
    function (this: HTMLElement) {
      return positions.get(this) ?? 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(
    function (this: HTMLElement, value: number) {
      positions.set(this, Math.max(0, Math.min(value, 400)));
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const list = this.closest<HTMLElement>('[data-web-shell-message-list]');
      const rows = list
        ? [...list.querySelectorAll('[data-message-row-key]')]
        : [];
      const index = rows.indexOf(this);
      const top = index < 0 ? 0 : index * 100 - list!.scrollTop;
      return {
        top,
        bottom: top + 100,
        height: 100,
        left: 0,
        right: 800,
        width: 800,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  );
  const getTranscriptPage = vi
    .fn<DaemonTurnNavigationClient['getTranscriptPage']>()
    .mockResolvedValue(page);
  const getTurnIndexPage = vi
    .fn<DaemonTurnNavigationClient['getTurnIndexPage']>()
    .mockResolvedValue(head);
  const client: DaemonTurnNavigationClient = {
    owner: {},
    getTranscriptPage,
    getTurnIndexPage,
    materializeTranscriptEvents: () => ({
      blocks: [
        {
          id: 'old',
          kind: 'user',
          text: 'old',
          sourceRecordIds: ['old'],
          createdAt: 1,
          updatedAt: 1,
          clientReceivedAt: 1,
        },
      ],
      nextBlockOrdinal: 2,
      encounteredRecordIds: ['old'],
    }),
  };
  let boundaryGeneration = 0;
  const store = createDaemonTurnNavigationStore({
    captureLiveBoundary: () => {
      const captured = boundaryGeneration;
      return {
        beforeRecordId: `live-${captured}`,
        reachable: true,
        isCurrent: () => captured === boundaryGeneration,
      };
    },
  });
  store.configure({ sessionId: 'session', supported: true, client });
  await vi.waitFor(() => expect(store.getSnapshot().mode).toBe('ready'));
  observed.store = store;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<MessageListHandle>();
  const live: Message[] = Array.from({ length: 5 }, (_, index) => ({
    id: `live-${index}`,
    role: 'assistant' as const,
    content: `live ${index}`,
    timestamp: index,
    sourceBlockIds: [`live-${index}`],
  }));
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <TranscriptViewport
          messages={live}
          pendingApproval={null}
          isResponding={false}
          ref={ref}
        />
      </I18nProvider>,
    ),
  );
  settle();
  const list = () =>
    container!.querySelector<HTMLElement>('[data-web-shell-message-list]')!;
  const mode = () =>
    container!.querySelector<HTMLElement>('[data-history-viewport]')!.dataset
      .historyViewport;
  const openButton = () =>
    [...container!.querySelectorAll('button')].find((button) =>
      button.hasAttribute('data-turn-ordinal'),
    )!;
  const open = async () => {
    await act(async () => {
      openButton().click();
    });
  };
  const pauseReading = () => {
    act(() => {
      list().scrollTop = 100;
      list().dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -20 }),
      );
      list().dispatchEvent(new Event('scroll'));
    });
    settle();
    expect(list().scrollTop).toBe(100);
  };
  return {
    store,
    client,
    ref,
    list,
    mode,
    open,
    openButton,
    settle,
    pauseReading,
    getTranscriptPage,
    getTurnIndexPage,
    invalidateBoundary: () => {
      boundaryGeneration++;
    },
  };
}

describe('TranscriptViewport pending first entry', () => {
  it.each(['owner', 'session'] as const)(
    'silently retires a pending entry when the %s changes',
    async (change) => {
      const { store, client, mode, open, getTranscriptPage, settle } =
        await setup();
      const request = deferred<DaemonSessionTranscriptPage>();
      getTranscriptPage.mockReturnValue(request.promise);
      await open();
      const revision = store.getViewportSnapshot().revision;
      const sessionId = change === 'session' ? 'next-session' : 'session';
      await act(async () => {
        store.configure({
          sessionId,
          supported: true,
          client: {
            ...client,
            owner: {},
            getTurnIndexPage: async () => ({ ...head, sessionId }),
          },
        });
        request.resolve(page);
      });
      settle();
      expect(store.getViewportSnapshot().revision).toBeGreaterThan(revision);
      expect(mode()).toBe('live');
      expect(store.getViewportSnapshot().pages.size).toBe(0);
      expect(container!.querySelector('[role="alert"]')).toBeNull();
      expect(container!.querySelector('[role="status"]')).toBeNull();
    },
  );

  it('scrolls the real live MessageList when no history entry is pending', async () => {
    const { ref, list, pauseReading, settle } = await setup();
    pauseReading();
    act(() => ref.current!.scrollToBottom('auto'));
    settle();
    expect(list().scrollTop).toBe(400);
  });

  it('cancels a pending entry and still scrolls the real live MessageList', async () => {
    const {
      ref,
      store,
      list,
      mode,
      open,
      pauseReading,
      getTranscriptPage,
      settle,
    } = await setup();
    pauseReading();
    const request = deferred<DaemonSessionTranscriptPage>();
    getTranscriptPage.mockReturnValue(request.promise);
    await open();
    expect(mode()).toBe('live');
    expect(container!.querySelector('[role="status"]')?.textContent).toBe(
      'Loading earlier messages…',
    );
    expect(list().scrollTop).toBe(100);
    act(() => ref.current!.scrollToBottom('auto'));
    settle();
    const afterHandle = list().scrollTop;
    await act(async () => request.resolve(page));
    settle();
    expect(mode()).toBe('live');
    expect(store.getViewportSnapshot().pages.size).toBe(0);
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(container!.querySelector('[role="status"]')).toBeNull();
    expect(afterHandle).toBe(400);
    expect(list().scrollTop).toBe(400);
  });

  it('cancels a distant selection when the user scrolls before it resolves', async () => {
    const { store, mode, open, list, getTranscriptPage, settle } =
      await setup();
    const request = deferred<DaemonSessionTranscriptPage>();
    getTranscriptPage.mockReturnValue(request.promise);
    await open();
    act(() =>
      list().dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -10 }),
      ),
    );
    await act(async () => request.resolve(page));
    settle();
    expect(mode()).toBe('live');
    expect(store.getViewportSnapshot().pages.size).toBe(0);
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it('retains live content after a failed selection and retries from the rail', async () => {
    const { mode, open, getTranscriptPage, settle } = await setup();
    getTranscriptPage.mockRejectedValueOnce(new Error('offline'));
    await open();
    settle();
    expect(mode()).toBe('live');
    expect(container!.querySelector('[role="alert"]')).not.toBeNull();
    await open();
    settle();
    expect(mode()).toBe('historical');
    expect(container!.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(['cancel', 'admit'] as const)(
    'keeps a valid pending entry %s outcome distinct from stale boundary failure',
    async (outcome) => {
      const { ref, store, mode, open, getTranscriptPage, settle } =
        await setup();
      const request = deferred<DaemonSessionTranscriptPage>();
      getTranscriptPage.mockReturnValue(request.promise);
      await open();
      expect(container!.querySelector('[role="status"]')).not.toBeNull();
      if (outcome === 'cancel') act(() => ref.current!.scrollToBottom('auto'));
      await act(async () => request.resolve(page));
      settle();
      expect(mode()).toBe(outcome === 'cancel' ? 'live' : 'historical');
      expect(store.getViewportSnapshot().pages.size).toBe(
        outcome === 'cancel' ? 0 : 1,
      );
      expect(container!.querySelector('[role="alert"]')).toBeNull();
      expect(container!.querySelector('[role="status"]')).toBeNull();
    },
  );
});
