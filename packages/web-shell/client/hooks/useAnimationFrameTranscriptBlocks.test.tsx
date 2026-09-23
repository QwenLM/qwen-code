// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DaemonTranscriptBlock,
  DaemonTranscriptBlockChangeSummary,
} from '@qwen-code/sdk/daemon';
import { useAnimationFrameTranscriptSnapshot } from './useAnimationFrameTranscriptBlocks';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const testStore = vi.hoisted(() => {
  let blocks: readonly DaemonTranscriptBlock[] = [];
  let blockIndexById: Readonly<Record<string, number>> = {};
  const blockChangeSource = {};
  let blockChangeSummary = {
    source: blockChangeSource,
    revision: 0,
    tailAppendBarrierRevision: 0,
  };
  let blockChangeSummaryEnabled = true;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ blocks, blockIndexById }),
    getBlockChangeSummary: () =>
      blockChangeSummaryEnabled ? blockChangeSummary : undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(nextBlocks: readonly DaemonTranscriptBlock[]) {
      blocks = nextBlocks;
      blockChangeSummary = {
        source: blockChangeSource,
        revision: blockChangeSummary.revision + 1,
        tailAppendBarrierRevision: blockChangeSummary.revision + 1,
      };
      listeners.forEach((listener) => listener());
    },
    appendTail(
      nextBlocks: readonly DaemonTranscriptBlock[],
      tailBlockId: string,
    ) {
      blocks = nextBlocks;
      blockChangeSummary = {
        source: blockChangeSource,
        revision: blockChangeSummary.revision + 1,
        tailAppendBarrierRevision: blockChangeSummary.tailAppendBarrierRevision,
        tailBlockId,
      };
      listeners.forEach((listener) => listener());
    },
    resetBlocks(nextBlocks: readonly DaemonTranscriptBlock[] = []) {
      blocks = nextBlocks;
      blockIndexById = {};
      blockChangeSummary = {
        source: blockChangeSource,
        revision: blockChangeSummary.revision + 1,
        tailAppendBarrierRevision: blockChangeSummary.revision + 1,
      };
      listeners.forEach((listener) => listener());
    },
    disableBlockChangeSummary() {
      blockChangeSummaryEnabled = false;
    },
    reset() {
      blocks = [];
      blockIndexById = {};
      blockChangeSummary = {
        source: blockChangeSource,
        revision: 0,
        tailAppendBarrierRevision: 0,
      };
      blockChangeSummaryEnabled = true;
      listeners.clear();
    },
  };
});

const testConnection = vi.hoisted(() => ({
  sessionId: 'session-a' as string | undefined,
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useTranscriptStore: () => testStore,
  useConnection: () => testConnection,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let renderCount = 0;
let latestBlocks: readonly DaemonTranscriptBlock[] = [];
let latestSummary: DaemonTranscriptBlockChangeSummary | undefined;
let renderLog: Array<{
  ids: string[];
  texts: Array<string | undefined>;
  revision?: number;
}> = [];

function Harness({ structuralOnly = false }: { structuralOnly?: boolean }) {
  const snapshot = useAnimationFrameTranscriptSnapshot({ structuralOnly });
  latestBlocks = snapshot.blocks;
  latestSummary = snapshot.blockChangeSummary;
  renderCount += 1;
  renderLog.push({
    ids: latestBlocks.map((block) => block.id),
    texts: latestBlocks.map((block) =>
      'text' in block ? block.text : undefined,
    ),
    revision: latestSummary?.revision,
  });
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  renderCount = 0;
  latestBlocks = [];
  latestSummary = undefined;
  renderLog = [];
  testStore.reset();
  testConnection.sessionId = 'session-a';
  vi.restoreAllMocks();
});

describe('useAnimationFrameTranscriptSnapshot', () => {
  it('caches structural snapshots when the store has no change summary', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    testStore.disableBlockChangeSummary();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    act(() => root!.render(<Harness structuralOnly />));

    expect(renderCount).toBe(1);
    expect(latestBlocks).toEqual([]);

    // Without a change summary every notification may be structural, so the
    // consumer must keep the pre-change update behavior and wake.
    act(() => testStore.update([{ id: 'a' } as DaemonTranscriptBlock]));
    act(() => pendingFrame?.(1_000));

    expect(renderCount).toBeGreaterThan(1);
    expect(latestBlocks).toHaveLength(1);
  });

  it('keeps structural consumers asleep for pure tail appends', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const first = { id: 'thought', text: 'a' } as DaemonTranscriptBlock;
    testStore.update([first]);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness structuralOnly />));
    const initialRenderCount = renderCount;

    act(() => testStore.appendTail([{ ...first, text: 'ab' }], 'thought'));

    expect(pendingFrame).toBeNull();
    expect(renderCount).toBe(initialRenderCount);
    expect(latestBlocks).toEqual([first]);

    const tool = { id: 'tool', kind: 'tool' } as DaemonTranscriptBlock;
    act(() => testStore.update([{ ...first, text: 'ab' }, tool]));
    act(() => pendingFrame?.(1_000));

    expect(renderCount).toBeGreaterThan(initialRenderCount);
    expect(latestBlocks).toEqual([{ ...first, text: 'ab' }, tool]);
  });

  it('keeps coalesced tail blocks paired with their change summary', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const first = { id: 'thought', text: 'a' } as DaemonTranscriptBlock;
    testStore.update([first]);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    const barrier = latestSummary?.tailAppendBarrierRevision;

    const second = { ...first, text: 'ab' };
    const third = { ...second, text: 'abc' };
    act(() => {
      testStore.appendTail([second], 'thought');
      testStore.appendTail([third], 'thought');
    });
    act(() => pendingFrame?.(1_000));

    expect(latestBlocks).toEqual([third]);
    expect(latestSummary).toMatchObject({
      revision: 3,
      tailAppendBarrierRevision: barrier,
      tailBlockId: 'thought',
    });
    const revisionByText = new Map([
      ['a', 1],
      ['ab', 2],
      ['abc', 3],
    ]);
    for (const entry of renderLog) {
      expect(entry.revision).toBe(revisionByText.get(entry.texts[0] ?? ''));
    }
  });

  it('coalesces transcript notifications into one render per frame', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(10);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    const initialRenderCount = renderCount;

    act(() => {
      for (let index = 1; index <= 100; index++) {
        testStore.update(
          Array.from({ length: index }, () => ({}) as DaemonTranscriptBlock),
        );
      }
    });

    expect(renderCount).toBe(initialRenderCount);
    expect(pendingFrame).not.toBeNull();

    act(() => {
      pendingFrame?.(16);
    });

    // The deferred value renders once (stale) then once more to catch up to
    // the latest snapshot — exactly two renders, never one per store update.
    // The upper bound keeps the rAF-coalescing guard: a regression that
    // renders once per update (100 renders) still fails.
    expect(renderCount).toBeLessThanOrEqual(initialRenderCount + 2);
    expect(latestBlocks).toHaveLength(100);
  });

  it('throttles renders to one per throttle window', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    renderCount = 0;

    // First notification is due immediately (lastNotifyTs starts at 0).
    act(() => testStore.update([{ id: 'a' } as DaemonTranscriptBlock]));
    act(() => pendingFrame?.(now));
    const afterFirst = renderCount;
    expect(latestBlocks.map((block) => block.id)).toEqual(['a']);
    expect(afterFirst).toBeGreaterThan(0);

    // A second notification inside the 50ms window must not render.
    now = 1_020;
    act(() => testStore.update([{ id: 'b' } as DaemonTranscriptBlock]));
    act(() => pendingFrame?.(now));
    expect(renderCount).toBe(afterFirst);
    expect(latestBlocks.map((block) => block.id)).toEqual(['a']);

    // Once the window elapses, the pending frame renders the latest blocks.
    now = 1_060;
    act(() => pendingFrame?.(now));
    expect(renderCount).toBeGreaterThan(afterFirst);
    expect(latestBlocks.map((block) => block.id)).toEqual(['b']);
  });

  it('waits for a quiet window after composer input', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    renderCount = 0;

    act(() => testStore.update([{ id: 'a' } as DaemonTranscriptBlock]));
    document.dispatchEvent(new Event('beforeinput'));
    now = 1_060;
    act(() => pendingFrame?.(now));
    expect(renderCount).toBe(0);

    now = 1_101;
    act(() => pendingFrame?.(now));
    expect(renderCount).toBeGreaterThan(0);
    expect(latestBlocks.map((block) => block.id)).toEqual(['a']);
  });

  it('does not starve transcript updates during continuous input', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    renderCount = 0;

    act(() => testStore.update([{ id: 'a' } as DaemonTranscriptBlock]));
    for (now = 1_050; now < 1_250; now += 50) {
      document.dispatchEvent(new Event('beforeinput'));
      act(() => pendingFrame?.(now));
      expect(renderCount).toBe(0);
    }

    document.dispatchEvent(new Event('beforeinput'));
    act(() => pendingFrame?.(1_250));
    expect(renderCount).toBeGreaterThan(0);
    expect(latestBlocks.map((block) => block.id)).toEqual(['a']);
  });

  it('cancels a pending frame on unmount', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    act(() => testStore.update([{} as DaemonTranscriptBlock]));

    act(() => root!.unmount());
    root = null;

    expect(cancelFrame).toHaveBeenCalledWith(7);
  });

  it('returns the new session blocks on the first render after a session switch', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    renderLog = [];

    // Session switch: the provider updates the connection sessionId and
    // store.reset() together in one batch, so the first render must already
    // see the new session's blocks instead of the deferred previous-session
    // snapshot. The mocked useConnection is a plain object (no context
    // re-render), so re-render manually to simulate the provider batch.
    const blockB = { id: 'b1' } as DaemonTranscriptBlock;
    act(() => {
      testConnection.sessionId = 'session-b';
      testStore.update([blockB]);
      root!.render(<Harness />);
    });

    // Every render of the switched session must carry the new blocks — the
    // manual render (bypass) and the deferred catch-up — never the previous
    // session's snapshot.
    expect(renderLog.length).toBeGreaterThan(0);
    for (const entry of renderLog) {
      expect(entry.ids).toEqual(['b1']);
    }
    expect(latestBlocks).toEqual([blockB]);
  });

  it('does not return deferred blocks after a same-session reset', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const oldBlock = { id: 'old' } as DaemonTranscriptBlock;
    testStore.update([oldBlock]);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<Harness />));
    renderLog = [];

    act(() => testStore.resetBlocks());
    act(() => pendingFrame?.(1_000));

    expect(renderLog.some((entry) => entry.ids.includes('old'))).toBe(false);
    expect(latestBlocks).toEqual([]);
  });
});
