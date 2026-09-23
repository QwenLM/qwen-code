// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonEvent,
  DaemonSessionTranscriptPage,
} from '@qwen-code/sdk/daemon';
import {
  createDaemonTurnNavigationStore,
  type DaemonHistoryNavigationStore,
  type DaemonTurnNavigationClient,
} from '../daemon/session/turn-navigation-store';
import { HistoricalTranscriptPageTable } from '../daemon/session/transcript-page-table';
import type { MessageListHandle, MessageListProps } from './MessageList';

const observed = vi.hoisted(() => ({
  store: undefined as DaemonHistoryNavigationStore | undefined,
  props: undefined as MessageListProps | undefined,
  collapseRows: false,
  hideRows: false,
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
          {(observed.hideRows ? [] : props.messages).flatMap((message) => [
            <div
              key={message.id}
              data-message-row-key={`msg:${message.id}`}
              data-source-block-ids={message.sourceBlockIds?.join(',')}
              data-row-height={observed.collapseRows ? 60 : 80}
            >
              {message.id}
            </div>,
            ...(observed.collapseRows
              ? [
                  <div
                    key={`tc:${message.id}`}
                    data-message-row-key={`tc:${message.id}`}
                    data-source-block-ids={message.sourceBlockIds?.join(',')}
                    data-row-height={32}
                  >
                    collapse
                  </div>,
                ]
              : []),
          ])}
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
  observed.collapseRows = false;
  observed.hideRows = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function page(ids: string[], hasMore = false): DaemonSessionTranscriptPage {
  return {
    v: 1,
    sessionId: 'session',
    events: ids.map(
      (recordId) =>
        ({ type: 'user_message_chunk', data: { recordId } }) as DaemonEvent,
    ),
    hasMore,
    targetRecordId: 'u1',
    hasOlder: hasMore,
    ...(hasMore ? { nextCursor: `older-${ids[0]}` } : {}),
  };
}
const materialize: DaemonTurnNavigationClient['materializeTranscriptEvents'] = (
  events,
  ordinal,
  excluded,
) => {
  const ids = events.map(
    (event) => (event.data as { recordId: string }).recordId,
  );
  const retained = ids.filter((id) => !excluded.has(id));
  return {
    blocks: retained.map((id) => ({
      id,
      kind: 'user' as const,
      text: id,
      sourceRecordIds: [id],
      createdAt: 1,
      updatedAt: 1,
      clientReceivedAt: 1,
    })),
    nextBlockOrdinal: ordinal + retained.length,
    encounteredRecordIds: ids,
  };
};

function installGeometry() {
  const tops = new WeakMap<HTMLElement, number>();
  const rowElements = (list: HTMLElement) => [
    ...list.querySelectorAll<HTMLElement>('[data-row-height]'),
  ];
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute('data-web-shell-message-list')
        ? 100
        : Number(this.dataset.rowHeight ?? 0);
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
    function (this: HTMLElement) {
      return rowElements(this).reduce(
        (sum, row) => sum + Number(row.dataset.rowHeight),
        0,
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get').mockImplementation(
    function (this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollTop', 'set').mockImplementation(
    function (this: HTMLElement, value: number) {
      tops.set(
        this,
        Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)),
      );
    },
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const list = this.closest<HTMLElement>('[data-web-shell-message-list]');
      const rows = list ? rowElements(list) : [];
      const index = rows.indexOf(this);
      const top =
        index < 0
          ? 0
          : rows
              .slice(0, index)
              .reduce((sum, row) => sum + Number(row.dataset.rowHeight), 0) -
            list!.scrollTop;
      const height = this.clientHeight;
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({}),
      };
    },
  );
}

async function setup(
  options: { degraded?: boolean; collapseRows?: boolean } = {},
) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const settleFrames = () =>
    act(() => {
      for (let round = 0; frames.size > 0 && round < 20; round++) {
        const current = [...frames.entries()];
        frames.clear();
        current.forEach(([, callback]) => callback(round));
      }
    });
  installGeometry();
  observed.collapseRows = options.collapseRows ?? false;
  const getTranscriptPage = vi
    .fn<DaemonTurnNavigationClient['getTranscriptPage']>()
    .mockResolvedValue(page(['u1', 'u2', 'u3', 'u4', 'u5'], true));
  const getTurnIndexPage = vi
    .fn<DaemonTurnNavigationClient['getTurnIndexPage']>()
    .mockImplementation(async () => {
      if (options.degraded) throw new Error('turn index unavailable');
      return {
        v: 1,
        sessionId: 'session',
        snapshot: 's',
        totalTurns: 4,
        start: 0,
        turns: Array.from({ length: 4 }, (_, ordinal) => ({
          ordinal,
          turnId: ordinal === 0 ? 'u1' : `turn-${ordinal}`,
          kind: 'prompt' as const,
          label: 'u1',
        })),
      };
    });
  const client: DaemonTurnNavigationClient = {
    owner: {},
    getTurnIndexPage,
    getTranscriptPage,
    materializeTranscriptEvents: materialize,
  };
  const store = createDaemonTurnNavigationStore({
    captureLiveBoundary: () => ({
      beforeRecordId: 'live',
      reachable: true,
      isCurrent: () => true,
    }),
  });
  store.configure({ sessionId: 'session', supported: true, client });
  await vi.waitFor(() => expect(store.getSnapshot().mode).not.toBe('loading'));
  observed.store = store;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const legacyLoad = vi.fn();
  const render = () =>
    act(() =>
      root!.render(
        <TranscriptViewport
          messages={[
            { id: 'live', role: 'user', content: 'live', timestamp: 1 },
          ]}
          pendingApproval={null}
          isResponding={false}
          hasOlderHistory
          onLoadOlderHistory={legacyLoad}
        />,
      ),
    );
  render();
  const click = async (label: string) => {
    await act(async () => {
      if (label === 'history.openEarlier')
        container!
          .querySelector<HTMLButtonElement>('[data-turn-ordinal]')!
          .click();
      else
        list().dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            deltaY: label === 'history.loadEarlier' ? -1 : 1,
          }),
        );
    });
  };
  const list = () =>
    container!.querySelector<HTMLElement>('[data-web-shell-message-list]')!;
  const row = (key: string) =>
    container!.querySelector<HTMLElement>(`[data-message-row-key="${key}"]`)!;
  return {
    store,
    getTranscriptPage,
    getTurnIndexPage,
    legacyLoad,
    click,
    list,
    row,
    settleFrames,
    render,
  };
}

describe('TranscriptViewport scroll restoration and fallback', () => {
  it('waits for virtualized rows before loading and preserving the reading position', async () => {
    const { click, list, row, getTranscriptPage, settleFrames, render } =
      await setup();
    await click('history.openEarlier');
    settleFrames();
    list().scrollTop = 170;
    const targetKey = `msg:${observed.props!.messages[2]!.id}`;
    const before = row(targetKey).getBoundingClientRect().top;
    let resolve!: (value: DaemonSessionTranscriptPage) => void;
    getTranscriptPage.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    observed.hideRows = true;
    render();
    await click('history.loadEarlier');
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    observed.hideRows = false;
    render();
    settleFrames();
    expect(getTranscriptPage).toHaveBeenCalledTimes(2);
    await act(async () => resolve(page(['old1', 'old2'])));
    settleFrames();
    expect(row(targetKey).getBoundingClientRect().top).toBe(before);
  });

  it('cancels a deferred boundary load when the user interacts again', async () => {
    const { click, list, getTranscriptPage, settleFrames, render } =
      await setup();
    await click('history.openEarlier');
    settleFrames();
    observed.hideRows = true;
    render();
    await click('history.loadEarlier');
    act(() =>
      list().dispatchEvent(new Event('pointerdown', { bubbles: true })),
    );
    observed.hideRows = false;
    render();
    settleFrames();
    expect(getTranscriptPage).toHaveBeenCalledTimes(1);
    await click('history.loadEarlier');
    expect(getTranscriptPage).toHaveBeenCalledTimes(2);
  });

  it.each(['none', 'wheel', 'pointerdown', 'keydown', 'scroll'] as const)(
    'preserves the reading row through a deferred prepend after %s input',
    async (input) => {
      const { click, list, row, getTranscriptPage, settleFrames } =
        await setup();
      await click('history.openEarlier');
      settleFrames();
      list().scrollTop = 170;
      const targetKey = `msg:${observed.props!.messages[2]!.id}`;
      const before = row(targetKey).getBoundingClientRect().top;
      let resolve!: (value: DaemonSessionTranscriptPage) => void;
      getTranscriptPage.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await click('history.loadEarlier');
      expect(getTranscriptPage).toHaveBeenCalledTimes(2);
      act(() => {
        if (input === 'wheel' || input === 'scroll')
          list().dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        if (input === 'pointerdown')
          list().dispatchEvent(new Event('pointerdown', { bubbles: true }));
        if (input === 'keydown')
          list().dispatchEvent(
            new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowUp' }),
          );
        if (input === 'scroll') {
          list().scrollTop += 20;
          list().dispatchEvent(new Event('scroll', { bubbles: true }));
        }
      });
      const expected = before - (input === 'scroll' ? 20 : 0);
      settleFrames();
      await act(async () => resolve(page(['old1', 'old2'])));
      settleFrames();
      expect(
        row(targetKey).getBoundingClientRect().top,
        `${input}: saved ${expected}, restored ${row(targetKey).getBoundingClientRect().top}`,
      ).toBe(expected);
    },
  );

  it.each([false, true])(
    'waits for visible virtual rows before loading an edge (leave edge: %s)',
    async (leaveEdge) => {
      const { click, list, row, getTranscriptPage, settleFrames } =
        await setup();
      await click('history.openEarlier');
      settleFrames();
      list().scrollTop = 0;
      const targetKey = `msg:${observed.props!.messages[0]!.id}`;
      const before = row(targetKey).getBoundingClientRect().top;
      const getRect = HTMLElement.prototype.getBoundingClientRect;
      let rowsMounted = false;
      vi.spyOn(
        HTMLElement.prototype,
        'getBoundingClientRect',
      ).mockImplementation(function (this: HTMLElement) {
        const rect = getRect.call(this);
        return !rowsMounted && this.hasAttribute('data-source-block-ids')
          ? { ...rect, top: 1000, bottom: 1000 + rect.height }
          : rect;
      });
      let resolve!: (value: DaemonSessionTranscriptPage) => void;
      getTranscriptPage.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await click('history.loadEarlier');
      expect(getTranscriptPage).toHaveBeenCalledTimes(1);
      if (leaveEdge) list().scrollTop = 250;
      rowsMounted = true;
      await act(async () => settleFrames());
      expect(getTranscriptPage).toHaveBeenCalledTimes(leaveEdge ? 1 : 2);
      if (!leaveEdge) {
        await act(async () => resolve(page(['old1', 'old2'])));
        settleFrames();
        expect(row(targetKey).getBoundingClientRect().top).toBe(before);
      }
    },
  );

  it('captures rows materialized after a boundary request starts before admitting the page', async () => {
    const { click, list, row, getTranscriptPage, settleFrames, render } =
      await setup();
    await click('history.openEarlier');
    settleFrames();
    const targetKey = `msg:${observed.props!.messages[0]!.id}`;
    let resolve!: (value: DaemonSessionTranscriptPage) => void;
    getTranscriptPage.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await click('history.loadEarlier');
    expect(getTranscriptPage).toHaveBeenCalledTimes(2);
    observed.hideRows = true;
    render();
    observed.hideRows = false;
    render();
    list().scrollTop += 20;
    const before = row(targetKey).getBoundingClientRect().top;
    await act(async () => resolve(page(['old1', 'old2'])));
    settleFrames();
    expect(row(targetKey).getBoundingClientRect().top).toBe(before);
  });

  it('restores a collapse row independently of its sibling prompt sharing its source', async () => {
    const { click, list, row, getTranscriptPage, settleFrames } = await setup({
      collapseRows: true,
    });
    await click('history.openEarlier');
    settleFrames();
    const id = observed.props!.messages[1]!.id;
    const key = `tc:${id}`;
    expect(row(key).dataset.sourceBlockIds).toBe(
      row(`msg:${id}`).dataset.sourceBlockIds,
    );
    list().scrollTop = 168;
    const before = row(key).getBoundingClientRect().top;
    expect(before).toBe(-16);
    getTranscriptPage.mockResolvedValue(page(['old1']));
    await click('history.loadEarlier');
    settleFrames();
    expect(row(key).getBoundingClientRect().top).toBe(before);
  });

  it('preserves the legacy loader when the turn index is degraded', async () => {
    const { store, legacyLoad } = await setup({
      degraded: true,
    });
    expect(store.getSnapshot()).toMatchObject({
      mode: 'degraded',
      fallbackReason: 'initial_error',
    });
    expect(observed.props?.onLoadOlderHistory).toBe(legacyLoad);
    expect(observed.props?.hasOlderHistory).toBe(true);
    expect(
      [...container!.querySelectorAll('button')].some(
        (button) => button.textContent === 'history.openEarlier',
      ),
    ).toBe(false);
  });

  it('enters the oldest edge of a newer cached neighbor', async () => {
    const { store, click, list, settleFrames, render } = await setup();
    const table = new HistoricalTranscriptPageTable({
      maxPages: 10,
      maxRetainedBytes: 1024 * 1024,
      materialize,
    });
    const newer = table.admitBefore(
      'live-b',
      's',
      page(['b3', 'b4', 'b5'], true),
    )!;
    table.beginBoundaryLoad(newer.rangeId, 'older');
    table.admitBoundary(newer.rangeId, 'older', 's', page(['b1', 'b2']));
    const older = table.admitBefore('live-a', 's', page(['a1', 'a2', 'a3']))!;
    table.reopenLiveBoundary(older.rangeId, 'live-c', 's');
    table.beginBoundaryLoad(older.rangeId, 'newer');
    table.admitBoundary(older.rangeId, 'newer', 's', page(['b1', 'b2'], true));
    expect(
      table.getSnapshot().ranges.find((range) => range.id === older.rangeId)
        ?.newer,
    ).toEqual({ kind: 'cached', rangeId: newer.rangeId });
    const snapshot = { ...store.getViewportSnapshot(), ...table.getSnapshot() };
    vi.spyOn(store, 'getViewportSnapshot').mockReturnValue(snapshot);
    vi.spyOn(store, 'locateViewportOrdinal').mockResolvedValue({
      view: 'historical',
      blockId: table.getSnapshot().pages.get(older.pageId)!.blocks.at(-1)!.id,
      turnId: 'a3',
      rangeId: older.rangeId,
      pageId: older.pageId,
    });
    render();
    await click('history.openEarlier');
    settleFrames();
    list().scrollTop = list().scrollHeight - list().clientHeight;
    await click('history.loadNewer');
    settleFrames();
    const firstPage = table
      .getSnapshot()
      .ranges.find((range) => range.id === newer.rangeId)!.pageIds[0]!;
    expect(observed.props!.messages[0]!.sourceBlockIds).toContain(
      table.getSnapshot().pages.get(firstPage)!.blocks[0]!.id,
    );
    expect(list().scrollTop).toBe(0);
  });
});
