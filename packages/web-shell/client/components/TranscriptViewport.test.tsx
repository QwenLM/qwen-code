// @vitest-environment jsdom
import { act, createRef, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSessionTranscriptPage } from '@qwen-code/sdk/daemon';
import {
  createDaemonTurnNavigationStore,
  type DaemonHistoryNavigationStore,
  type DaemonTurnNavigationClient,
} from '../daemon/session/turn-navigation-store';
import type { MessageListHandle, MessageListProps } from './MessageList';
import type { Message } from '../adapters/types';

const observed = vi.hoisted(() => ({
  store: undefined as DaemonHistoryNavigationStore | undefined,
  props: undefined as MessageListProps | undefined,
}));
vi.mock('../daemon/session/DaemonSessionProvider', () => ({
  useDaemonHistoryNavigationStore: () => observed.store,
}));
vi.mock('../i18n', () => {
  const t = (key: string) => key;
  return { useI18n: () => ({ t }) };
});
vi.mock('./MessageList', () => ({
  MessageList: forwardRef<MessageListHandle, MessageListProps>(
    function List(props, ref) {
      observed.props = props;
      useImperativeHandle(
        ref,
        () => ({ scrollToBottom: vi.fn(), scrollToMessage: () => true }),
        [],
      );
      return (
        <div data-web-shell-message-list>
          {props.messages.map((message) => (
            <div
              key={message.id}
              data-source-block-ids={message.sourceBlockIds?.join(',')}
            >
              {message.id}
              {message.role === 'tool_group' &&
                message.tools.map((tool) => (
                  <div
                    key={tool.callId}
                    data-transcript-tool-call-id={tool.callId}
                  >
                    {tool.callId}
                  </div>
                ))}
            </div>
          ))}
        </div>
      );
    },
  ),
}));

const { TranscriptViewport } = await import('./TranscriptViewport');
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const live: Message[] = [
  { id: 'live', role: 'user', content: 'live', timestamp: 1 },
];
async function setup(supported = true, cursorOnly = false, turnCount = 4) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  const getTranscriptPage = vi
    .fn<DaemonTurnNavigationClient['getTranscriptPage']>()
    .mockResolvedValue({
      v: 1,
      sessionId: 'session',
      events: [],
      targetRecordId: 'old',
      hasOlder: true,
      hasMore: false,
    });
  const store = createDaemonTurnNavigationStore({
    captureLiveBoundary: () => ({
      beforeRecordId: cursorOnly ? undefined : 'live',
      reachable: true,
      isCurrent: () => true,
    }),
  });
  const client: DaemonTurnNavigationClient = {
    owner: {},
    getTurnIndexPage: async () => ({
      v: 1,
      sessionId: 'session',
      snapshot: 'snapshot',
      totalTurns: turnCount,
      start: 0,
      turns: Array.from({ length: turnCount }, (_, ordinal) => ({
        ordinal,
        turnId: ordinal === 0 ? 'old' : `turn-${ordinal}`,
        kind: 'prompt' as const,
        label: 'old',
      })),
    }),
    getTranscriptPage,
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
  store.configure({ sessionId: 'session', supported, client });
  await vi.waitFor(() => expect(store.getSnapshot().mode).not.toBe('loading'));
  observed.store = store;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const ref = createRef<MessageListHandle>();
  const legacyLoad = vi.fn();
  const props: MessageListProps = {
    messages: live,
    pendingApproval: null,
    isResponding: true,
    onEditUserMessage: vi.fn(),
    onBranchSession: vi.fn(),
    onRetryClick: vi.fn(),
    onReloadTranscript: vi.fn(),
    onLoadOlderHistory: legacyLoad,
    hasOlderHistory: true,
  };
  act(() => root!.render(<TranscriptViewport {...props} ref={ref} />));
  const click = async (key: string) => {
    await act(async () => {
      if (key === 'history.openEarlier')
        container!
          .querySelector<HTMLButtonElement>('[data-turn-ordinal]')!
          .click();
      else
        container!
          .querySelector('[data-web-shell-message-list]')!
          .dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              deltaY: key === 'history.loadEarlier' ? -1 : 1,
            }),
          );
    });
  };
  return { store, client, ref, props, getTranscriptPage, click, legacyLoad };
}

describe('TranscriptViewport', () => {
  it.each([0, 3, 4])(
    'requires at least four indexed turns (count=%i)',
    async (count) => {
      await setup(true, false, count);
      expect(
        container!.querySelector('[data-global-turn-navigation]') !== null,
      ).toBe(count >= 4);
    },
  );
  it('pins the visible child of an expanded cross-page tool group', async () => {
    const { store, client, click, getTranscriptPage } = await setup();
    let toolId = 'newer-tool';
    client.materializeTranscriptEvents = () => ({
      blocks: [
        {
          id: toolId,
          kind: 'tool',
          toolCallId: toolId,
          toolName: 'read_file',
          status: 'completed',
          sourceRecordIds: [toolId],
          createdAt: 1,
          updatedAt: 1,
          clientReceivedAt: 1,
        },
        ...(toolId === 'newer-tool'
          ? [
              {
                id: 'old',
                kind: 'user' as const,
                text: 'old',
                sourceRecordIds: ['old'],
                createdAt: 1,
                updatedAt: 1,
                clientReceivedAt: 1,
              },
            ]
          : []),
      ],
      nextBlockOrdinal: 2,
      encounteredRecordIds: ['old', toolId],
    });
    getTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: 'session',
      events: [],
      targetRecordId: 'old',
      hasOlder: true,
      hasMore: true,
      nextCursor: 'older',
    });
    await click('history.openEarlier');
    const newerPage = [...store.getViewportSnapshot().pages.keys()][0];
    toolId = 'older-tool';
    getTranscriptPage.mockResolvedValue({
      v: 1,
      sessionId: 'session',
      events: [],
      targetRecordId: 'old',
      hasOlder: true,
      hasMore: false,
    });
    const list = container!.querySelector<HTMLElement>(
      '[data-web-shell-message-list]',
    )!;
    Object.defineProperty(list, 'clientHeight', { value: 100 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        const callId = this.dataset.transcriptToolCallId;
        const top =
          this.dataset.sourceBlockIds === 'old'
            ? -500
            : this.hasAttribute('data-source-block-ids')
              ? -200
              : callId === 'older-tool'
                ? -200
                : callId === 'newer-tool'
                  ? -10
                  : 0;
        const height = callId ? 100 : 300;
        return {
          top,
          bottom: top + height,
          height,
          width: 100,
          left: 0,
          right: 100,
          x: 0,
          y: top,
          toJSON: () => ({}),
        };
      },
    );
    await click('history.loadEarlier');
    expect(store.getViewportSnapshot().ranges[0]?.pageIds).toHaveLength(2);
    const pin = vi.spyOn(store, 'setViewportAnchor');
    act(() => {
      list.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      list.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(pin).toHaveBeenLastCalledWith(expect.any(String), newerPage);
  });
  it('switches only visible rows, disables historical mutations and returns live through the forwarded handle', async () => {
    const { props, ref, click } = await setup();
    expect(observed.props?.messages).toBe(live);
    await click('history.openEarlier');
    expect(
      container
        ?.querySelector('[data-history-viewport]')
        ?.getAttribute('data-history-viewport'),
    ).toBe('historical');
    expect(observed.props).toMatchObject({
      frozenViewport: true,
      pendingApproval: null,
      isResponding: false,
      transcriptReloadPaused: true,
    });
    expect(observed.props?.onEditUserMessage).toBeUndefined();
    expect(observed.props?.onBranchSession).toBeUndefined();
    expect(observed.props?.onRetryClick).toBeUndefined();
    expect(observed.props?.onReloadTranscript).toBeUndefined();
    const historical = observed.props?.messages;
    const nextLive: Message[] = [
      ...live,
      { id: 'new-live', role: 'assistant', content: 'new', timestamp: 2 },
    ];
    act(() =>
      root!.render(
        <TranscriptViewport {...props} messages={nextLive} ref={ref} />,
      ),
    );
    expect(observed.props?.messages).toBe(historical);
    act(() => ref.current?.scrollToBottom());
    expect(observed.props?.messages).toBe(nextLive);
    expect(observed.props?.onEditUserMessage).toBe(props.onEditUserMessage);
  });

  it('preserves the original loader with turn navigation enabled', async () => {
    const { legacyLoad } = await setup();
    expect(observed.props?.onLoadOlderHistory).toBe(legacyLoad);
    expect(observed.props?.hasOlderHistory).toBe(true);
    expect(container!.textContent).not.toContain('history.snapshotView');
  });

  it('preserves the unsupported-daemon loader', async () => {
    const { legacyLoad } = await setup(false);
    expect(observed.props?.onLoadOlderHistory).toBe(legacyLoad);
    expect(observed.props?.hasOlderHistory).toBe(true);
  });

  it('preserves cursor-only pagination even with the navigation capability', async () => {
    const { legacyLoad } = await setup(true, true);
    expect(observed.props?.onLoadOlderHistory).toBe(legacyLoad);
    expect(observed.props?.hasOlderHistory).toBe(true);
  });

  it('invalidates a pending entry when a local send returns to live', async () => {
    const { store, ref, getTranscriptPage, click } = await setup();
    let resolve!: (page: DaemonSessionTranscriptPage) => void;
    getTranscriptPage.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await click('history.openEarlier');
    act(() => ref.current?.scrollToBottom());
    await act(async () => {
      resolve({ v: 1, sessionId: 'session', events: [], hasMore: false });
    });
    expect(store.getViewportSnapshot().pages.size).toBe(0);
    expect(observed.props?.messages).toBe(live);
  });
});
