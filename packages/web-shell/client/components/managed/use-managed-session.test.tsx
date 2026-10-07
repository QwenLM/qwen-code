// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJavaManagedAgentProvider } from './java-managed-agent-provider';
import {
  corruptFrame as corrupt,
  javaDeltaEvent as javaDelta,
  javaSessionPayload,
  sseFrame,
} from './managed-agent-sse.test-fixtures';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionEvent,
  ManagedAgentSessionTranscript,
} from './managed-agent-provider';
import { useManagedSession } from './use-managed-session';

function event(
  id: number,
  type: ManagedAgentSessionEvent['type'] = 'assistant_delta',
): ManagedAgentSessionEvent {
  return {
    id,
    at: id,
    type,
    sessionId: 'session-1',
    turnId: 'turn-1',
    data: { text: String(id) },
  };
}

function transcript(lastEventId: number): ManagedAgentSessionTranscript {
  return {
    events: Array.from({ length: lastEventId }, (_, index) => event(index + 1)),
    lastEventId,
  };
}

describe('useManagedSession', () => {
  let root: Root | undefined;

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it('reloads the transcript after a stream gap and resumes after it', async () => {
    const cursors: Array<number | undefined> = [];
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce(transcript(2))
      .mockResolvedValue(transcript(9));
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        cursors.push(request.lastEventId);
        if (cursors.length === 1) {
          // What the Java provider yields for a resync frame.
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        yield event(10);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }

    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() => expect(cursors).toEqual([2, 9]));
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]),
    );
    expect(getTranscript).toHaveBeenCalledTimes(2);
  });

  it('lets a gap snapshot supersede the streamed events it has assembled', async () => {
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({ events: [event(1)], lastEventId: 1 })
      .mockResolvedValue({
        // The server has assembled the streamed deltas 2-4 into one item,
        // projected as a single event carrying the full text at id 2.
        events: [event(1), { ...event(2), data: { text: 'hello' } }],
        lastEventId: 4,
      });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 1) {
          yield { ...event(2), data: { text: 'he' } };
          yield { ...event(3), data: { text: 'll' } };
          yield { ...event(4), data: { text: 'o' } };
          yield { ...event(4), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    // The snapshot is authoritative for its covered range: the raw streamed
    // deltas it assembled away must not survive the merge as duplicates.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]),
    );
    expect(latest?.events[1]?.data).toEqual({ text: 'hello' });
  });

  it('preserves loaded older pages and their paging cursor across a stream gap', async () => {
    let deliverGap!: () => void;
    let deliverGap2!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const gapGate2 = new Promise<void>((resolve) => {
      deliverGap2 = resolve;
    });
    const cursors: Array<number | undefined> = [];
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-3') {
          return Promise.resolve({
            events: [event(1), event(2)],
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(5), event(6), event(7)],
            olderCursor: 'cursor-5',
            lastEventId: 9,
          });
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 6,
          });
        }
        if (snapshotCalls === 2) {
          return Promise.resolve({
            events: [event(5), event(6), event(7)],
            olderCursor: 'cursor-5',
            lastEventId: 7,
          });
        }
        // The second gap's window slid forward.
        return Promise.resolve({
          events: [event(8), event(9)],
          olderCursor: 'cursor-8',
          lastEventId: 9,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        cursors.push(request.lastEventId);
        if (cursors.length === 1) {
          await gapGate;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        if (cursors.length === 2) {
          await gapGate2;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );
    expect(latest?.olderCursor).toBe('cursor-3');

    deliverGap();

    // The gap resync merges the durable snapshot over the live array: the
    // page the user had paged into survives...
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]),
    );
    await vi.waitFor(() => expect(cursors).toEqual([6, 7]));

    // ...and paging keeps going from where the user left off.
    expect(latest?.olderCursor).toBe('cursor-3');
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    // A second gap whose window slid past the paged region: the paged pages
    // are dropped rather than fused across the hole, the window's cursor is
    // adopted, and the hole pages back.
    deliverGap2();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([8, 9]),
    );
    expect(latest?.olderCursor).toBe('cursor-8');
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7, 8, 9]),
    );
  });

  it('drops the paging cursor when a gap snapshot carries the full history', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // A snapshotted transcript: the full history, nothing older
              // to page.
              {
                events: [
                  event(1),
                  event(2),
                  event(3),
                  event(4),
                  event(5),
                  event(6),
                  event(7),
                ],
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-3'));

    deliverGap();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]),
    );
    // The full-history snapshot leaves nothing older to page: the cursor is
    // cleared and loadOlder is inert instead of re-fetching raw events the
    // snapshot has assembled into items.
    expect(latest?.olderCursor).toBeUndefined();
    const callsBefore = getTranscript.mock.calls.length;
    await act(async () => {
      await latest!.loadOlder();
    });
    expect(getTranscript.mock.calls.length).toBe(callsBefore);
  });

  it('discards an in-flight older page when a gap lands the full history', async () => {
    let deliverGap!: () => void;
    let releasePage!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          // The older page stays in flight until the test releases it.
          return pageGate.then(() => ({
            events: [
              { ...event(3), data: { text: 'he' } },
              { ...event(4), data: { text: 'll' } },
            ],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          }));
        }
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // Full-history snapshot: deltas 3-4 are assembled into the item
              // projected at id 3, and nothing is left to page.
              {
                events: [
                  { ...event(3), data: { text: 'hello' } },
                  event(5),
                  event(6),
                  event(7),
                ],
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    // The older-page fetch starts and stays in flight...
    act(() => {
      void latest!.loadOlder();
    });
    // ...while the gap resync lands the full-history snapshot.
    deliverGap();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 5, 6, 7]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    // The stale page arrives late: it must be discarded, not merged — the
    // snapshot already carries events 3-4 in assembled form.
    await act(async () => {
      releasePage();
      await pageGate;
    });
    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(latest?.events.map((item) => item.id)).toEqual([3, 5, 6, 7]);
    expect(latest?.events[0]?.data).toEqual({ text: 'hello' });
    expect(latest?.olderCursor).toBeUndefined();
  });

  it('keeps the current view and the paging cursor when a gap snapshot is empty', async () => {
    const cursors: Array<number | undefined> = [];
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({
        events: [event(1), event(2)],
        olderCursor: 'cursor-1',
        lastEventId: 2,
      })
      // An empty snapshot asserts nothing about content.
      .mockResolvedValue({ events: [], lastEventId: 4 });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        cursors.push(request.lastEventId);
        if ((request.lastEventId ?? 0) === 2) {
          yield event(3);
          yield { ...event(3), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    // The empty snapshot wiped nothing — neither the events nor the paging
    // cursor — and the stream resumed from its head.
    await vi.waitFor(() => expect(cursors).toEqual([2, 4]));
    expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(latest?.olderCursor).toBe('cursor-1');
    expect(latest?.loading).toBe(false);
  });

  it('drops kept item projections when a gap snapshot is unassembled', async () => {
    let deliverGap1!: () => void;
    let deliverGap2!: () => void;
    const gate1 = new Promise<void>((resolve) => {
      deliverGap1 = resolve;
    });
    const gate2 = new Promise<void>((resolve) => {
      deliverGap2 = resolve;
    });
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          // Legacy raw window; the server has no snapshot yet.
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 6,
          });
        }
        if (snapshotCalls === 2) {
          // The durable snapshot now exists: deltas 3-4 are assembled into
          // the item projected at id 3, and the snapshot carries the full
          // history (no older cursor).
          return Promise.resolve({
            events: [
              {
                ...event(3),
                data: { text: 'hello' },
                assembledFromItem: true,
              },
              event(5),
              event(6),
              event(7),
            ],
            lastEventId: 7,
          });
        }
        // Reconciliation deleted the snapshot: a raw page again.
        return Promise.resolve({
          events: [event(5), event(6), event(7)],
          olderCursor: 'cursor-5',
          lastEventId: 7,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await gate1;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        if (subscribeCalls === 2) {
          await gate2;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );

    // Gap 1 lands the assembled full history: the raw page is superseded.
    deliverGap1();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 5, 6, 7]),
    );

    // Gap 2 lands in the reconciliation window: the snapshot is gone, the
    // page is raw, and the kept item projection must not survive to
    // duplicate or un-retract the raw events.
    deliverGap2();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );
    // The cursor was cleared by the full-history gap, so the raw page's
    // cursor is adopted.
    expect(latest?.olderCursor).toBe('cursor-5');
  });

  it('adopts the snapshot cursor when the user never paged', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            lastEventId: 6,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? // The session fits in one page at open: no cursor.
              { events: [event(1), event(2)], lastEventId: 2 }
            : // The session has since outgrown the page: older events exist.
              {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 2) {
          await gapGate;
          yield { ...event(2), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    deliverGap();

    // The unpaged prefix is dropped, and the snapshot's cursor is adopted so
    // the range below the window stays pageable.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-5'));
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6]),
    );
  });

  it('drops the unpaged prefix on a gap when the user never paged back', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({
        events: [event(3), event(4)],
        olderCursor: 'cursor-3',
        lastEventId: 4,
      })
      .mockResolvedValue({
        events: [event(5), event(6), event(7)],
        olderCursor: 'cursor-5',
        lastEventId: 7,
      });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 4) {
          await gapGate;
          yield { ...event(4), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4]),
    );
    deliverGap();
    // The user never paged: the aged-out prefix is trimmed back to the
    // snapshot window instead of growing for the life of the panel, and the
    // window's cursor replaces the one whose page was dropped.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );
    expect(latest?.olderCursor).toBe('cursor-5');
  });

  it('keeps a live event newer than a lagging gap snapshot head', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi
      .fn<ManagedAgentProvider['getTranscript']>()
      .mockResolvedValueOnce({
        events: [event(5), event(6)],
        olderCursor: 'cursor-5',
        lastEventId: 6,
      })
      // The snapshot was planned before event 7 landed: it lags the stream,
      // and re-states event 5 with different content so the resync is
      // observable in the merged state.
      .mockResolvedValue({
        events: [{ ...event(5), data: { text: 'five' } }, event(6)],
        olderCursor: 'cursor-5',
        lastEventId: 6,
      });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          yield event(7);
          await gapGate;
          yield { ...event(7), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]),
    );
    deliverGap();
    // Gate on the resync having actually run, then: event 7 is newer than
    // the snapshot head, so it survives the merge.
    await vi.waitFor(() => expect(getTranscript).toHaveBeenCalledTimes(2));
    expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7]);
    expect(latest?.events[0]?.data).toEqual({ text: 'five' });
  });

  it('adopts the window cursor when a hole opens between the pages and the window', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-7') {
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 8,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // The gap window sits far above the paged pages.
              {
                events: [event(7), event(8)],
                olderCursor: 'cursor-7',
                lastEventId: 8,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-3'));

    deliverGap();

    // The paged [3,4] are dropped rather than fused across the hole, and the
    // window's cursor is adopted so the hole pages back.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-7'));
    expect(latest?.events.map((item) => item.id)).toEqual([7, 8]);
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7, 8]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7, 8]),
    );
    expect(befores).toEqual(['cursor-5', 'cursor-7', 'cursor-5']);
  });

  it('refreshes a stale retained event from the server copy', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [{ ...event(3), data: { text: 'RETRACTED-ME' } }, event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-9') {
          // The re-paged range carries the server's retraction of event 3.
          return Promise.resolve({
            events: [
              { ...event(3), data: { text: '' } },
              event(5),
              event(6),
              event(7),
              event(8),
            ],
            olderCursor: 'cursor-3',
            lastEventId: 10,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(9), event(10)],
                olderCursor: 'cursor-9',
                lastEventId: 10,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events[0]?.data).toEqual({ text: 'RETRACTED-ME' }),
    );

    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-9'));

    await act(async () => {
      await latest!.loadOlder();
    });
    // The fresh page wins on a shared id: the retraction lands.
    await vi.waitFor(() =>
      expect(latest?.events[0]?.data).toEqual({ text: '' }),
    );
  });

  it('stays exhausted after a gap once the user paged to the beginning', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-3') {
          // The beginning: no older cursor.
          return Promise.resolve({
            events: [event(1), event(2)],
            lastEventId: 6,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(5), event(6), event(7)],
                olderCursor: 'cursor-5',
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3, 4, 5, 6]),
    );
    expect(latest?.olderCursor).toBeUndefined();

    deliverGap();

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]),
    );
    // Everything is already loaded: the gap must not re-arm the affordance.
    expect(latest?.olderCursor).toBeUndefined();
    const calls = getTranscript.mock.calls.length;
    await act(async () => {
      await latest!.loadOlder();
    });
    expect(getTranscript.mock.calls.length).toBe(calls);
  });

  it('re-arms paging when a hole opens after the user paged to the beginning', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-3') {
          return Promise.resolve({
            events: [event(1), event(2)],
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(5), event(6), event(7)],
            olderCursor: 'cursor-5',
            lastEventId: 9,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // The window slid far past the paged region: a hole opened.
              {
                events: [event(8), event(9)],
                olderCursor: 'cursor-8',
                lastEventId: 9,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await act(async () => {
      await latest!.loadOlder();
    });
    // Paged to the beginning: the affordance is gone.
    await vi.waitFor(() => expect(latest?.olderCursor).toBeUndefined());

    deliverGap();

    // A hole opened between the paged region and the window: the paged
    // pages are dropped rather than fused, the window's cursor is adopted,
    // and the hole pages back.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));
    expect(latest?.events.map((item) => item.id)).toEqual([8, 9]);
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6, 7, 8, 9]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        3, 4, 5, 6, 7, 8, 9,
      ]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]),
    );
    expect(befores).toEqual([
      'cursor-5',
      'cursor-3',
      'cursor-8',
      'cursor-5',
      'cursor-3',
    ]);
  });

  it('adopts the window cursor when the hole is exactly one id wide', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          return Promise.resolve({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          });
        }
        if (request.before === 'cursor-6') {
          return Promise.resolve({
            events: [event(5)],
            olderCursor: 'cursor-5',
            lastEventId: 7,
          });
        }
        return Promise.resolve(
          getTranscript.mock.calls.length === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // Exactly one id (5) between the paged pages and the window.
              {
                events: [event(6), event(7)],
                olderCursor: 'cursor-6',
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });

    deliverGap();

    // The hole is exactly one id wide — still a hole.
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-6'));
    expect(latest?.events.map((item) => item.id)).toEqual([6, 7]);
    await act(async () => {
      await latest!.loadOlder();
    });
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]),
    );
  });

  it('discards the retried page when a second gap moves the cursor again', async () => {
    let deliverGap!: () => void;
    let deliverGap2!: () => void;
    let releasePage!: () => void;
    let releasePage2!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const gapGate2 = new Promise<void>((resolve) => {
      deliverGap2 = resolve;
    });
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const pageGate2 = new Promise<void>((resolve) => {
      releasePage2 = resolve;
    });
    const befores: Array<string | undefined> = [];
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return pageGate.then(() => ({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          }));
        }
        if (request.before === 'cursor-8') {
          return pageGate2.then(() => ({
            events: [event(6), event(7)],
            olderCursor: 'cursor-6',
            lastEventId: 9,
          }));
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return Promise.resolve({
            events: [event(5), event(6)],
            olderCursor: 'cursor-5',
            lastEventId: 6,
          });
        }
        if (snapshotCalls === 2) {
          return Promise.resolve({
            events: [event(8), event(9)],
            olderCursor: 'cursor-8',
            lastEventId: 9,
          });
        }
        return Promise.resolve({
          events: [event(11), event(12)],
          olderCursor: 'cursor-11',
          lastEventId: 12,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        if (subscribeCalls === 2) {
          await gapGate2;
          yield { ...event(9), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));

    // Release the first page: the retry against the moved cursor starts.
    await act(async () => {
      releasePage();
      await pageGate;
    });
    // A second gap moves the cursor again while the retry is in flight.
    deliverGap2();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-11'));
    await act(async () => {
      releasePage2();
      await pageGate2;
    });

    // The retry bound holds: no third fetch, and the twice-stale page is
    // discarded.
    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(befores).toEqual(['cursor-5', 'cursor-8']);
    expect(latest?.events.map((item) => item.id)).toEqual([11, 12]);
  });

  it('resets the paging state when the panel reloads', async () => {
    let deliverGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-50') {
          // The first generation's page tops out at event 49.
          return Promise.resolve({
            events: [event(48), event(49)],
            olderCursor: 'cursor-48',
            lastEventId: 51,
          });
        }
        snapshotCalls += 1;
        if (snapshotCalls === 1) {
          return Promise.resolve({
            events: [event(50), event(51)],
            olderCursor: 'cursor-50',
            lastEventId: 51,
          });
        }
        if (snapshotCalls === 2) {
          // The reload re-reads the transcript: its window covers event 49.
          return Promise.resolve({
            events: [event(49), event(50)],
            olderCursor: 'cursor-49',
            lastEventId: 50,
          });
        }
        return Promise.resolve({
          events: [event(50), event(51)],
          olderCursor: 'cursor-50',
          lastEventId: 51,
        });
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 2) {
          await gapGate;
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([50, 51]),
    );
    await act(async () => {
      await latest!.loadOlder();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([48, 49, 50, 51]),
    );

    // Reload: the effect re-enters and the paging state must reset.
    await act(async () => {
      latest!.reload();
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([49, 50]),
    );

    deliverGap();

    // The stale pagedHead (49) is adjacent to the new window (50): without
    // the reset, the reload's window edge event 49 would be retained.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([50, 51]),
    );
    expect(latest?.olderCursor).toBe('cursor-50');
  });

  it('retries a failed page fetch once when a gap moved the cursor', async () => {
    let deliverGap!: () => void;
    let failPage!: (error: Error) => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<never>((_resolve, reject) => {
      failPage = (error) => reject(error);
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          return pageGate;
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(6), event(7)],
            olderCursor: 'cursor-6',
            lastEventId: 9,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(8), event(9)],
                olderCursor: 'cursor-8',
                lastEventId: 9,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));

    // The first fetch rejects after the cursor moved: the click is retried
    // once against the new cursor instead of vanishing silently.
    await act(async () => {
      failPage(new Error('older page fetch failed (502)'));
      await pageGate.catch(() => undefined);
    });
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([6, 7, 8, 9]),
    );
    expect(befores).toEqual(['cursor-5', 'cursor-8']);
    expect(latest?.error).toBeUndefined();
  });

  it('does not count stalls separated by delivered events', async () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    let streamed = 2;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() =>
      Promise.resolve({ events: [event(1)], lastEventId: streamed }),
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 5) {
          if (subscribeCalls >= 3) {
            // A real event between stalls: the counter resets.
            streamed += 1;
            yield event(streamed);
          }
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // stall, stall, then every connection delivers an event before its
      // gap — never three stalls in a row.
      for (let round = 0; round < 8; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
      expect(subscribeCalls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not count stalls separated by an advancing resync', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    let subscribeCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() => {
      snapshotCalls += 1;
      return Promise.resolve(
        snapshotCalls === 4
          ? // The third gap's resync advances the head: counter resets.
            { events: [event(1), event(2), event(3)], lastEventId: 3 }
          : { events: [event(1), event(2)], lastEventId: 2 },
      );
    });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 5) {
          yield { ...event(request.lastEventId ?? 0), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // stall, stall, [advance resets], stall, stall — never three in a row.
      for (let round = 0; round < 8; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
      expect(subscribeCalls).toBe(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a page fetch once when a gap moved the cursor', async () => {
    let deliverGap!: () => void;
    let releasePage!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const befores: Array<string | undefined> = [];
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before) befores.push(request.before);
        if (request.before === 'cursor-5') {
          // The page stays in flight across the gap.
          return pageGate.then(() => ({
            events: [event(3), event(4)],
            olderCursor: 'cursor-3',
            lastEventId: 6,
          }));
        }
        if (request.before === 'cursor-8') {
          return Promise.resolve({
            events: [event(6), event(7)],
            olderCursor: 'cursor-6',
            lastEventId: 9,
          });
        }
        return Promise.resolve(
          befores.length === 0
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : // The gap window moved the paging cursor forward.
              {
                events: [event(8), event(9)],
                olderCursor: 'cursor-8',
                lastEventId: 9,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-8'));

    await act(async () => {
      releasePage();
      await pageGate;
    });
    // The stale page is discarded and re-issued once against the new cursor.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([6, 7, 8, 9]),
    );
    expect(befores).toEqual(['cursor-5', 'cursor-8']);
    expect(latest?.olderCursor).toBe('cursor-6');
  });

  it('suppresses a stale loadOlder failure after a gap lands the full history', async () => {
    let deliverGap!: () => void;
    let failPage!: (error: Error) => void;
    const gapGate = new Promise<void>((resolve) => {
      deliverGap = resolve;
    });
    const pageGate = new Promise<never>((_resolve, reject) => {
      failPage = (error) => reject(error);
    });
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(
      (_sessionId, request) => {
        if (request.before === 'cursor-5') {
          // The page fetch fails after the gap has landed.
          return pageGate;
        }
        snapshotCalls += 1;
        return Promise.resolve(
          snapshotCalls === 1
            ? {
                events: [event(5), event(6)],
                olderCursor: 'cursor-5',
                lastEventId: 6,
              }
            : {
                events: [event(3), event(4), event(5), event(6), event(7)],
                lastEventId: 7,
              },
        );
      },
    );
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 6) {
          await gapGate;
          yield { ...event(6), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([5, 6]),
    );
    act(() => {
      void latest!.loadOlder();
    });
    deliverGap();
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]),
    );

    await act(async () => {
      failPage(new Error('older page fetch failed (500)'));
      await pageGate.catch(() => undefined);
    });

    await vi.waitFor(() => expect(latest?.loadingOlder).toBe(false));
    expect(latest?.error).toBeUndefined();
    expect(latest?.events.map((item) => item.id)).toEqual([3, 4, 5, 6, 7]);
    expect(latest?.olderCursor).toBeUndefined();
  });

  it('recovers past a run of corrupt frames through the resync path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const transcriptPayload = (lastSequence: number) =>
      JSON.stringify({
        items: [],
        events:
          lastSequence === 2
            ? [JSON.parse(javaDelta(1, 'one')), JSON.parse(javaDelta(2, 'two'))]
            : [
                // The corrupt run 3-6 is absent; the transcript head is 7.
                JSON.parse(javaDelta(1, 'one')),
                JSON.parse(javaDelta(2, 'two')),
                JSON.parse(javaDelta(7, 'after')),
              ],
        coveredSequence: 0,
        hasMore: false,
        lastSequence,
      });
    let transcriptCalls = 0;
    const streamCursors: Array<unknown> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        transcriptCalls += 1;
        return new Response(transcriptPayload(transcriptCalls === 1 ? 2 : 7), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/events/stream')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        streamCursors.push(body['afterSequence']);
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (body['afterSequence'] === 2) {
              controller.enqueue(
                encoder.encode(
                  corrupt(3) + corrupt(4) + corrupt(5) + corrupt(6),
                ),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    // The budget trip resyncs: the transcript is re-read, the cursor moves
    // past the whole corrupt run, and the event behind it renders.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 7]),
    );
    expect(latest?.error).toBeUndefined();
    expect(transcriptCalls).toBe(2);
    expect(streamCursors).toEqual([2, 7]);
  });

  it('surfaces an error when repeated resyncs cannot advance the cursor', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        // The transcript head never advances past the corrupt run.
        return new Response(
          JSON.stringify({
            items: [],
            events: [
              JSON.parse(javaDelta(1, 'one')),
              JSON.parse(javaDelta(2, 'two')),
            ],
            coveredSequence: 0,
            hasMore: false,
            lastSequence: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(corrupt(3) + corrupt(4) + corrupt(5) + corrupt(6)),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // The first stall resubscribes after one 3s pause; each further stall
      // takes another. The third consecutive stall surfaces the error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // The error must not fire on the first two stalls...
      expect(latest?.error).toBeUndefined();
      // ...and fires on exactly the third: one more 3s cadence, no slack.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);
      // The error is the only user-visible signal of the stall: it must
      // persist while the condition persists, not flash for one cadence.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the stall alert when the summary poll succeeds mid-stall', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let streamHangs = false;
    let blipNextSummary = false;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        if (blipNextSummary) {
          blipNextSummary = false;
          return new Response(
            JSON.stringify({ error: { code: 'boom', message: 'boom-blip' } }),
            { status: 500, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        return new Response(
          JSON.stringify({
            items: [],
            events: [
              JSON.parse(javaDelta(1, 'one')),
              JSON.parse(javaDelta(2, 'two')),
            ],
            coveredSequence: 0,
            hasMore: false,
            lastSequence: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        if (streamHangs) {
          // A resubscribe that never yields again: no further gap can
          // re-assert the alert from the stream side.
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          });
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(corrupt(3) + corrupt(4) + corrupt(5) + corrupt(6)),
            );
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // Three stalls assert the alert.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);
      // Freeze the stream mid-stall while the 3s summary poll keeps
      // succeeding: the poll may only clear errors it raised itself, so
      // the alert must survive several poll cadences untouched.
      streamHangs = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);
      // The stream is parked for good now, so every summary fetch is the
      // poll's. A blip occupies the field for one cadence; the next success
      // may only clear that — the still-current stall alert comes back.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a transient recovery error once a resync succeeds', async () => {
    vi.useFakeTimers();
    let snapshotCalls = 0;
    const getTranscript = vi.fn<ManagedAgentProvider['getTranscript']>(() => {
      snapshotCalls += 1;
      if (snapshotCalls === 2) {
        // The first gap's recovery fetch fails transiently.
        return Promise.reject(
          new TypeError('Recovery temporarily unavailable'),
        );
      }
      return Promise.resolve({
        events: [event(1), event(2)],
        lastEventId: 2,
      });
    });
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript,
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if ((request.lastEventId ?? 0) === 2) {
          yield { ...event(2), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // The first gap's recovery fetch rejects during the initial microtask
      // chain — before any timer fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toMatch(/Recovery temporarily unavailable/);
      // The next gap's resync succeeds (same head — no progress): the
      // transient error must clear even though the stall guard did not fire.
      for (let round = 0; round < 6 && latest?.error !== undefined; round++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(3000);
        });
      }
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores a pending action whose streamed frame was corrupt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let transcriptCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        transcriptCalls += 1;
        return new Response(
          JSON.stringify(
            transcriptCalls === 1
              ? {
                  items: [],
                  events: [
                    JSON.parse(javaDelta(1, 'one')),
                    JSON.parse(javaDelta(2, 'two')),
                  ],
                  coveredSequence: 0,
                  hasMore: false,
                  lastSequence: 2,
                }
              : {
                  items: [],
                  events: [
                    JSON.parse(javaDelta(1, 'one')),
                    JSON.parse(javaDelta(2, 'two')),
                    {
                      sequence: 3,
                      eventId: 'evt_3',
                      sessionId: 'session-1',
                      turnId: 'turn-1',
                      type: 'action.updated',
                      createdAt: 3,
                      data: { actionId: 'act-1', state: 'requested' },
                      terminal: false,
                    },
                    JSON.parse(javaDelta(4, 'four')),
                  ],
                  coveredSequence: 0,
                  hasMore: false,
                  lastSequence: 4,
                },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (body['afterSequence'] === 2) {
              // The persisted action.updated frame at sequence 3 is corrupt.
              controller.enqueue(
                encoder.encode(
                  'id: 3\r\nevent: action.updated\r\ndata: {"sequence":3,"eventId":"evt_3"\r\n\r\n',
                ),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    // The corrupt action frame triggers a resync instead of a silent skip:
    // the transcript is re-read and the action event is restored.
    await vi.waitFor(() => expect(transcriptCalls).toBe(2));
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 3, 4]),
    );
    expect(latest?.events[2]?.type).toBe('action_updated');
    expect(latest?.error).toBeUndefined();
  });

  it('skips a corrupt streamed frame and keeps rendering later events', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const streamBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(2), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        return new Response(
          JSON.stringify({
            items: [],
            events: [
              JSON.parse(javaDelta(1, 'one')),
              JSON.parse(javaDelta(2, 'two')),
            ],
            coveredSequence: 2,
            hasMore: false,
            lastSequence: 2,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        streamBodies.push(body);
        // The persisted frame at sequence 3 is corrupt; a valid frame sits
        // behind it at sequence 4. Later resubscribes get an empty stream.
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            if (body['afterSequence'] === 2) {
              controller.enqueue(
                encoder.encode(
                  'id: 3\r\nevent: item.output_text.delta\r\ndata: {"sequence":3,"eventId":"evt_3"\r\n\r\n' +
                    sseFrame(4, 'after-corrupt'),
                ),
              );
            }
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
    });
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    // The corrupt frame is skipped: the valid event behind it renders, and
    // the panel is not wedged on an error.
    await vi.waitFor(() =>
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2, 4]),
    );
    expect(latest?.error).toBeUndefined();
    // The single stream request started from the snapshot cursor.
    expect(streamBodies).toHaveLength(1);
    expect(streamBodies[0]?.['afterSequence']).toBe(2);
  });

  it('clears the stream error on its clean pass even when the poll raised the identical message', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let subscribeCalls = 0;
    let getSessionCalls = 0;
    const provider = {
      // #1 the initial snapshot, #2 the poll's failure, #3 parks the poll
      // for good, #4 the stream's clean pass.
      getSession: vi.fn(async () => {
        getSessionCalls += 1;
        if (getSessionCalls === 2) throw new TypeError('Failed to fetch');
        if (getSessionCalls === 3) await new Promise(() => {});
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi
        .fn<ManagedAgentProvider['getTranscript']>()
        .mockResolvedValue({ events: [event(1)], lastEventId: 1 }),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await firstGate;
          throw new TypeError('Failed to fetch');
        }
        if (subscribeCalls === 2) {
          await secondGate;
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();
      // The poll fails first; the stream loop fails with the same message.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');
      await act(async () => {
        releaseFirst();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('Failed to fetch');
      // The next cadence parks the poll inside getSession (#3) and starts
      // the stream's clean pass, held on its gate: ownership, not the
      // identical message text, decides what the pass may clear.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await act(async () => {
        releaseSecond();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();
      expect(latest?.summary).toEqual({ sessionId: 'session-1' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the stream failure beside healthy polls until the stream itself recovers', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let subscribeCalls = 0;
    let getSessionCalls = 0;
    const provider = {
      // #2 is the poll's failure; every other summary fetch succeeds.
      getSession: vi.fn(async () => {
        getSessionCalls += 1;
        if (getSessionCalls === 2) throw new TypeError('Failed to fetch');
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi
        .fn<ManagedAgentProvider['getTranscript']>()
        .mockResolvedValue({ events: [event(1)], lastEventId: 1 }),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await firstGate;
          throw new TypeError('Failed to fetch');
        }
        if (subscribeCalls === 2) {
          await secondGate;
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The poll raises the message first; the stream raises it after, and
      // the stream owns the banner from that write on.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');
      await act(async () => {
        releaseFirst();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('Failed to fetch');
      // Repeated poll successes prove only the poll healthy: the stream's
      // banner stays while the stream is down.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');
      // The stream's own clean pass ends its condition and clears it.
      await act(async () => {
        releaseSecond();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a paging failure when a clean stream pass follows', async () => {
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let subscribeCalls = 0;
    let cursorGone = true;
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) => {
          if (request.before === 'cursor-1')
            return cursorGone
              ? Promise.reject(new Error('Managed Agent request failed (410)'))
              : // The retried page is empty and carries no older cursor.
                Promise.resolve({ events: [], lastEventId: 1 });
          return Promise.resolve({
            events: [event(1)],
            olderCursor: 'cursor-1',
            lastEventId: 1,
          });
        },
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await streamGate;
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    await vi.waitFor(() => expect(latest?.olderCursor).toBe('cursor-1'));
    await act(async () => {
      await latest!.loadOlder();
    });
    expect(latest?.error).toBe('Managed Agent request failed (410)');

    // A clean stream pass follows: the paging error is not the stream's to
    // clear, so the dead cursor's banner survives beside healthy data.
    const getSessionCalls = provider.getSession.mock.calls.length;
    await act(async () => {
      releaseStream();
    });
    await vi.waitFor(() =>
      expect(provider.getSession.mock.calls.length).toBe(getSessionCalls + 1),
    );
    expect(latest?.error).toBe('Managed Agent request failed (410)');
    expect(latest?.olderCursor).toBe('cursor-1');

    // A successful retry on the same cursor owns the release: the banner it
    // raised clears and the exhausted cursor retires the affordance.
    cursorGone = false;
    await act(async () => {
      await latest!.loadOlder();
    });
    expect(latest?.error).toBeUndefined();
    expect(latest?.olderCursor).toBeUndefined();
  });

  it('reveals a still-live paging failure again once a poll blip clears', async () => {
    vi.useFakeTimers();
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          request.before === 'cursor-1'
            ? Promise.reject(new Error('Managed Agent request failed (410)'))
            : Promise.resolve({
                events: [event(1)],
                olderCursor: 'cursor-1',
                lastEventId: 1,
              }),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // The poll's one-cadence blip occupies the field but must not displace
      // the paging condition: the dead cursor is still dead.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');
      expect(latest?.olderCursor).toBe('cursor-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends a dropped stream’s failure once the reconnect establishes and idles', async () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    let cursorGone = true;
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) => {
          if (request.before === 'cursor-1')
            return cursorGone
              ? Promise.reject(new Error('Managed Agent request failed (410)'))
              : Promise.resolve({ events: [], lastEventId: 1 });
          return Promise.resolve({
            events: [event(1)],
            olderCursor: 'cursor-1',
            lastEventId: 1,
          });
        },
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: {
          lastEventId?: number;
          signal?: AbortSignal;
          onEstablished?: () => void;
        },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          // The first connection drops before any event.
          throw new TypeError('Failed to fetch');
        }
        // The reconnect establishes, then idles: heartbeats never yield,
        // so neither an advancing event nor a completed pass can release
        // the booking.
        request.onEstablished?.();
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('Failed to fetch');

      // The reconnect establishes on the retry cadence: its failure's
      // condition ends there, even though the stream then stays silent.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(subscribeCalls).toBe(2);
      expect(latest?.error).toBeUndefined();

      // A later paging failure and its successful retry must not reveal
      // the dead stream condition.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');
      cursorGone = false;
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBeUndefined();
      expect(latest?.olderCursor).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals the stall alert ahead of booked stream and paging conditions', async () => {
    vi.useFakeTimers();
    let gapsLeft = 0;
    let throwNextSubscribe = false;
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          request.before === 'cursor-1'
            ? Promise.reject(new Error('Managed Agent request failed (410)'))
            : Promise.resolve({
                events: [event(1)],
                olderCursor: 'cursor-1',
                // The resync head never advances: three stalls arm the alert.
                lastEventId: 1,
              }),
      ),
      async *subscribeEvents(_sessionId: string) {
        if (throwNextSubscribe) {
          throwNextSubscribe = false;
          throw new TypeError('Failed to fetch');
        }
        if (gapsLeft > 0) {
          gapsLeft -= 1;
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        // A completed pass: the stream loop runs its clean pass next.
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      gapsLeft = 3;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      // The stream drops: its failure is booked over the armed stall.
      throwNextSubscribe = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');

      // A paging failure is booked as well.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // The stream's clean pass releases its own booking; the still-armed
      // stall outranks the paging condition that survives alongside it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reveals a still-live stream failure ahead of a paging condition', async () => {
    vi.useFakeTimers();
    let throwNextSubscribe = true;
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          request.before === 'cursor-1'
            ? Promise.reject(new Error('Managed Agent request failed (410)'))
            : Promise.resolve({
                events: [event(1)],
                olderCursor: 'cursor-1',
                lastEventId: 1,
              }),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if (throwNextSubscribe) {
          throwNextSubscribe = false;
          throw new TypeError('Failed to fetch');
        }
        // The reconnect never establishes: the stream stays down.
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('Failed to fetch');

      // A paging failure occupies the field beside the downed stream.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // A poll blip and its recovery release the poll's own booking: the
      // stream's still-live condition is revealed ahead of the paging one.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a booked paging condition when a live event advances the stream', async () => {
    vi.useFakeTimers();
    let releaseEvent!: () => void;
    const eventGate = new Promise<void>((resolve) => {
      releaseEvent = resolve;
    });
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          request.before === 'cursor-1'
            ? Promise.reject(new Error('Managed Agent request failed (410)'))
            : Promise.resolve({
                events: [event(1)],
                olderCursor: 'cursor-1',
                lastEventId: 1,
              }),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        await eventGate;
        yield event(2);
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // A live event advances the stream: every booked condition ends.
      await act(async () => {
        releaseEvent();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.events.map((item) => item.id)).toEqual([1, 2]);
      expect(latest?.error).toBeUndefined();

      // A later poll blip and its recovery must not resurrect the dead
      // cursor's message.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a booked paging condition when a gap resync runs', async () => {
    vi.useFakeTimers();
    let releaseGap!: () => void;
    const gapGate = new Promise<void>((resolve) => {
      releaseGap = resolve;
    });
    let subscribeCalls = 0;
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          request.before === 'cursor-1'
            ? Promise.reject(new Error('Managed Agent request failed (410)'))
            : // The resync snapshot never advances the head.
              Promise.resolve({
                events: [event(1)],
                olderCursor: 'cursor-1',
                lastEventId: 1,
              }),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          await gapGate;
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // A non-advancing gap resync replaces the whole window state: every
      // booked condition ends with it.
      await act(async () => {
        releaseGap();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();
      expect(latest?.olderCursor).toBe('cursor-1');

      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the failed snapshot’s booking when the retry lands', async () => {
    vi.useFakeTimers();
    let firstFailed = false;
    let cursorGone = true;
    const provider = {
      getSession: vi.fn(async () => {
        if (!firstFailed) {
          firstFailed = true;
          throw new TypeError('Failed to fetch');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) => {
          if (request.before === 'cursor-1')
            return cursorGone
              ? Promise.reject(new Error('Managed Agent request failed (410)'))
              : Promise.resolve({ events: [], lastEventId: 1 });
          return Promise.resolve({
            events: [event(1)],
            olderCursor: 'cursor-1',
            lastEventId: 1,
          });
        },
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('Failed to fetch');

      // The retried snapshot replaces the whole state, including the failed
      // attempt's booking.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
      expect(latest?.olderCursor).toBe('cursor-1');

      // A paging failure and its successful retry must not reveal the
      // failed attempt's message.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');
      cursorGone = false;
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a booked stream failure when the run reloads', async () => {
    vi.useFakeTimers();
    let failNextSubscribe = true;
    let getSessionCalls = 0;
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    const provider = {
      getSession: vi.fn(async () => {
        getSessionCalls += 1;
        // The reloaded run's initial snapshot parks in flight: a completed
        // snapshot would wipe the carried ledger on its own, so the reset
        // is only observable while it has not landed.
        if (getSessionCalls === 2) await snapshotGate;
        // The fresh run's first poll blips while its snapshot is parked.
        if (getSessionCalls === 3) throw new Error('boom-blip');
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() =>
        Promise.resolve(transcript(1)),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if (failNextSubscribe) {
          failNextSubscribe = false;
          throw new TypeError('Failed to fetch');
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('Failed to fetch');

      await act(async () => {
        latest!.reload();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // A blip in the fresh run, then its recovery: the old run's stream
      // booking must not be revealed alongside either.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();

      await act(async () => {
        releaseSnapshot();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the poll’s banner when an unbooked older-page load succeeds', async () => {
    vi.useFakeTimers();
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          Promise.resolve(
            request.before === 'cursor-1'
              ? { events: [], lastEventId: 1 }
              : {
                  events: [event(1)],
                  olderCursor: 'cursor-1',
                  lastEventId: 1,
                },
          ),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');

      // The first poll blips: its banner is booked.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');

      // A successful older-page load owns no booking: it must not clear the
      // poll's.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('boom-blip');

      // The poll's own recovery clears it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the stall alert across a successful older-page load and a poll blip', async () => {
    vi.useFakeTimers();
    let subscribeCalls = 0;
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) =>
          Promise.resolve(
            request.before === 'cursor-0'
              ? { events: [], lastEventId: 1 }
              : {
                  events: [event(1)],
                  olderCursor: 'cursor-0',
                  // The resync head never advances: three stalls assert the
                  // alert.
                  lastEventId: 1,
                },
          ),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls <= 3) {
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        // The stream then hangs: no pass can re-assert the alert.
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      // Paging history is not the stall's owner: a successful older-page
      // load must not dismiss the still-current alert.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toMatch(/not advancing/);

      // A poll blip occupies the field for one cadence; releasing it
      // reveals the still-armed alert rather than an empty field.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disarms the stall alert once the stream advances again', async () => {
    vi.useFakeTimers();
    let head = 1;
    let gapsLeft = 0;
    let throwNextSubscribe = false;
    let emitEventId: number | undefined;
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() =>
        Promise.resolve(transcript(head)),
      ),
      async *subscribeEvents(_sessionId: string) {
        if (throwNextSubscribe) {
          throwNextSubscribe = false;
          throw new TypeError('Failed to fetch');
        }
        if (emitEventId !== undefined) {
          const id = emitEventId;
          emitEventId = undefined;
          yield event(id);
          return;
        }
        if (gapsLeft > 0) {
          gapsLeft -= 1;
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        // A completed pass: the stream loop runs its clean pass next.
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // Three non-advancing resyncs arm the alert.
      gapsLeft = 3;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      // A stream failure while the stall is armed shows the failure; the
      // stream's own clean pass must reveal the still-armed alert again.
      throwNextSubscribe = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Failed to fetch');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      // An advancing resync ends the stall; a later poll blip must not
      // resurrect it once the blip clears.
      head = 2;
      gapsLeft = 1;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();

      // Re-arm, then advance via a live event: same disarm, same protection.
      gapsLeft = 3;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);
      emitEventId = 3;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  function createStallHarness() {
    let blipNextSummary = false;
    let gapsLeft = 0;
    const stallProvider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      // The head never advances, so every resync counts toward a stall.
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() =>
        Promise.resolve(transcript(1)),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if (gapsLeft > 0) {
          gapsLeft -= 1;
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    return {
      provider: stallProvider,
      armStall: () => {
        gapsLeft = 3;
      },
      blip: () => {
        blipNextSummary = true;
      },
    };
  }

  it('drops an armed stall when the run reloads', async () => {
    vi.useFakeTimers();
    const harness = createStallHarness();
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(harness.provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      harness.armStall();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      await act(async () => {
        latest!.reload();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();

      // A blip in the fresh run must not resurrect the old run's stall.
      harness.blip();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops an armed stall when the session changes', async () => {
    vi.useFakeTimers();
    const harness = createStallHarness();
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(harness.provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      harness.armStall();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();

      harness.blip();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a superseded run releasing an error it no longer owns', async () => {
    vi.useFakeTimers();
    let parkNextSummary = false;
    let releaseParkedSummary!: () => void;
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (parkNextSummary) {
          parkNextSummary = false;
          await new Promise<void>((resolve) => {
            releaseParkedSummary = resolve;
          });
        }
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() =>
        Promise.resolve(transcript(1)),
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The live run's poll parks inside the provider...
      parkNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // ...and the session switch supersedes the whole run.
      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The successor's own poll fails: the field and the ledger entry are
      // its poll's to release.
      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      // The superseded run's parked poll now resolves late: its release must
      // not delete the successor's entry.
      await act(async () => {
        releaseParkedSummary();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('boom-blip');
      // The successor's next poll succeeds and clears its own error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a superseded run releasing a stream error it no longer owns', async () => {
    vi.useFakeTimers();
    let releaseParkedSummary!: () => void;
    let getSessionCalls = 0;
    let subscribeCalls = 0;
    const provider = {
      getSession: vi.fn(async () => {
        getSessionCalls += 1;
        if (getSessionCalls === 2) {
          // The first run's stream clean pass parks mid-refresh (its
          // initial snapshot was call #1)...
          await new Promise<void>((resolve) => {
            releaseParkedSummary = resolve;
          });
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() =>
        Promise.resolve(transcript(1)),
      ),
      async *subscribeEvents(_sessionId: string) {
        subscribeCalls += 1;
        if (subscribeCalls === 2) {
          // ...while the successor's stream fails for real.
          throw new Error('live-stream-boom');
        }
        // Every other subscribe completes immediately: a clean pass.
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('live-stream-boom');

      // The superseded run's clean pass now resolves late: its release must
      // not delete the successor's stream entry.
      await act(async () => {
        releaseParkedSummary();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBe('live-stream-boom');

      // The successor's stream recovers and clears its own error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a superseded run booking a late stream failure', async () => {
    vi.useFakeTimers();
    let releaseStream!: () => void;
    const streamGate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let subscribeCalls = 0;
    let cursorGone = true;
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) => {
          if (request.before === 'cursor-1')
            return cursorGone
              ? Promise.reject(new Error('Managed Agent request failed (410)'))
              : Promise.resolve({ events: [], lastEventId: 1 });
          return Promise.resolve({
            events: [event(1)],
            olderCursor: 'cursor-1',
            lastEventId: 1,
          });
        },
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          // The first run's stream fails only after the gate releases.
          await streamGate;
          throw new Error('stale-stream-boom');
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');
      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');

      // The superseded run's stream rejects late: its failure must not be
      // booked into the successor's ledger.
      await act(async () => {
        releaseStream();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toBeUndefined();

      // A phantom entry would surface the next time any writer releases:
      // the paging failure then its successful retry is that release.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');
      cursorGone = false;
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a superseded run merging a late stream event', async () => {
    vi.useFakeTimers();
    let releaseStale!: () => void;
    const staleGate = new Promise<void>((resolve) => {
      releaseStale = resolve;
    });
    let subscribeCalls = 0;
    let cursorGone = true;
    const provider = {
      getSession: vi.fn().mockResolvedValue({ sessionId: 'session-1' }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(
        (_sessionId, request) => {
          if (request.before === 'cursor-1')
            return cursorGone
              ? Promise.reject(new Error('Managed Agent request failed (410)'))
              : Promise.resolve({ events: [], lastEventId: 1 });
          return Promise.resolve({
            events: [event(1)],
            olderCursor: 'cursor-1',
            lastEventId: 1,
          });
        },
      ),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        subscribeCalls += 1;
        if (subscribeCalls === 1) {
          // The first run's stream parks, then delivers one late event.
          await staleGate;
          yield event(2);
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');

      // The session switch supersedes the whole first run mid-stream.
      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');

      // The successor books its own paging failure.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // The superseded run's late event must not merge into the
      // successor's transcript or touch its ledger.
      await act(async () => {
        releaseStale();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.events.map((item) => item.id)).toEqual([1]);
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // The successor's paging retry still owns its release.
      cursorGone = false;
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a superseded run disarming the live run’s stall', async () => {
    vi.useFakeTimers();
    let releaseParkedTranscript!: () => void;
    let transcriptCalls = 0;
    let gapsLeft = 1;
    let blipNextSummary = false;
    const provider = {
      getSession: vi.fn(async () => {
        if (blipNextSummary) {
          blipNextSummary = false;
          throw new Error('boom-blip');
        }
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi.fn<ManagedAgentProvider['getTranscript']>(() => {
        transcriptCalls += 1;
        if (transcriptCalls === 2) {
          // The first run's gap resync parks mid-snapshot (its initial
          // snapshot was call #1)...
          return new Promise<ManagedAgentSessionTranscript>((resolve) => {
            releaseParkedTranscript = () =>
              resolve({ events: [event(1), event(2)], lastEventId: 2 });
          });
        }
        // ...while the live run's head never advances, arming the stall.
        return Promise.resolve(transcript(1));
      }),
      async *subscribeEvents(
        _sessionId: string,
        request: { lastEventId?: number; signal?: AbortSignal },
      ) {
        if (gapsLeft > 0) {
          gapsLeft -= 1;
          yield { ...event(1), type: 'stream_gap' };
          return;
        }
        await new Promise((resolve) =>
          request.signal?.addEventListener('abort', resolve),
        );
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      // Run 1's first resync parks inside its snapshot.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The successor arms its own stall (armed before the rerender: the
      // first subscribe fires inside the rerender's own flush).
      gapsLeft = 3;
      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12000);
      });
      expect(latest?.error).toMatch(/not advancing/);

      // ...and its late completion advances: the disarm must not touch the
      // successor's armed stall.
      await act(async () => {
        releaseParkedTranscript();
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.error).toMatch(/not advancing/);

      blipNextSummary = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toMatch(/not advancing/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the live run’s paging banner when a superseded run’s token refresh resolves late', async () => {
    vi.useFakeTimers();
    let releaseParked!: () => void;
    const parkedGate = new Promise<void>((resolve) => {
      releaseParked = resolve;
    });
    // The host's short-lived-token hook: the first run's stream request
    // parks mid-refresh (the snapshot's two requests are calls #1 and #2).
    // The park targets the stream on purpose: a phantom 'stream' booking is
    // reveal-eligible, so the abort gate below is observable; a phantom
    // 'poll' booking never is.
    let getHeadersCalls = 0;
    const getHeaders = vi.fn(async () => {
      getHeadersCalls += 1;
      if (getHeadersCalls === 3) await parkedGate;
      return {};
    });
    let cursorGone = true;
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = String(url);
      if (init?.signal?.aborted) {
        throw new DOMException('This operation was aborted', 'AbortError');
      }
      if (path.endsWith('/sessions/get')) {
        return new Response(javaSessionPayload(1), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (path.endsWith('/transcript/query')) {
        const body = JSON.parse(String(init?.body)) as { cursor?: string };
        if (body.cursor === 'cursor-1') {
          if (cursorGone) return new Response('gone', { status: 410 });
          return new Response(
            JSON.stringify({
              items: [],
              events: [],
              coveredSequence: 1,
              hasMore: false,
              lastSequence: 1,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            items: [],
            events: [JSON.parse(javaDelta(1, 'one'))],
            coveredSequence: 1,
            hasMore: true,
            lastSequence: 1,
            olderCursor: 'cursor-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (path.endsWith('/events/stream')) {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
        });
      }
      throw new Error('Unexpected request: ' + String(url));
    });
    const provider = createJavaManagedAgentProvider({
      baseUrl: 'https://product.example',
      fetch: fetchImpl,
      getHeaders,
    });
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe({ sessionId }: { sessionId: string }) {
      latest = useManagedSession(provider, 'client-1', sessionId);
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe sessionId="session-1" />));

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');

      // The first run's stream request is still parked inside the token
      // refresh when the session switch supersedes the whole run.
      await act(async () => {
        root!.render(<Probe sessionId="session-2" />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(latest?.olderCursor).toBe('cursor-1');

      // The successor raises a paging error of its own.
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // The superseded run's request now rejects on its aborted signal: its
      // failure must not be booked into the successor's ledger.
      await act(async () => {
        releaseParked();
        await vi.advanceTimersByTimeAsync(0);
      });
      // The successor's next poll succeeds — the paging banner survives.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('Managed Agent request failed (410)');

      // The successor's paging retry owns its release: nothing reveals a
      // phantom stream entry from the superseded run.
      cursorGone = false;
      await act(async () => {
        await latest!.loadOlder();
      });
      expect(latest?.error).toBeUndefined();
      expect(latest?.olderCursor).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears a transient error on the next successful poll', async () => {
    vi.useFakeTimers();
    let summaryCalls = 0;
    const provider = {
      getSession: vi.fn(async () => {
        summaryCalls += 1;
        if (summaryCalls === 2) throw new Error('boom-blip');
        return { sessionId: 'session-1' };
      }),
      getTranscript: vi
        .fn<ManagedAgentProvider['getTranscript']>()
        .mockResolvedValue({ events: [event(1)], lastEventId: 1 }),
      async *subscribeEvents() {
        await new Promise(() => {});
        yield* [];
      },
    } as unknown as ManagedAgentProvider;
    let latest: ReturnType<typeof useManagedSession> | undefined;
    function Probe() {
      latest = useManagedSession(provider, 'client-1', 'session-1');
      return null;
    }
    const container = document.createElement('div');
    root = createRoot(container);
    act(() => root!.render(<Probe />));

    try {
      // Settle the initial snapshot (call 1) so the blip lands on the first
      // poll, then step the hard-coded 3s poll cadence.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Snapshot summary (call 1) is fine, the first poll (call 2) blips.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBe('boom-blip');
      // The next poll (call 3) succeeds: the fresh summary must not carry a
      // stale alert beside it.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(latest?.error).toBeUndefined();
      expect(latest?.summary).toEqual({ sessionId: 'session-1' });
    } finally {
      vi.useRealTimers();
    }
  });
});
