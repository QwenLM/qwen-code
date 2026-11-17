// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { useReportedArtifactRegistration } from './useReportedArtifactRegistration';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const testStore = vi.hoisted(() => {
  let blocks: readonly DaemonTranscriptBlock[] = [];
  const blockIndexById: Readonly<Record<string, number>> = {};
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({ blocks, blockIndexById }),
    getBlockChangeSummary: () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify(next: readonly DaemonTranscriptBlock[]) {
      blocks = next;
      listeners.forEach((listener) => listener());
    },
    reset() {
      blocks = [];
      listeners.clear();
    },
  };
});

const sdk = vi.hoisted(() => ({
  owner: 0,
  addArtifact: vi.fn(),
  refresh: vi.fn(),
  guard: { capture: vi.fn() },
  connection: {
    status: 'connected',
    catchingUp: false,
    sessionId: 'session-a',
    capabilities: { features: ['session_artifacts'] },
  },
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', async () => {
  const React = await import('react');
  return {
    useActions: () => ({ addArtifact: sdk.addArtifact }),
    useConnection: () => sdk.connection,
    useDaemonSessionOwnerGuard: () => sdk.guard,
    useTranscriptStore: () => testStore,
    // Kept subscribed so this suite turns red if the hook regresses to the
    // raw, unthrottled `useTranscriptBlocks` subscription.
    useTranscriptBlocks: () =>
      React.useSyncExternalStore(
        (notify) => testStore.subscribe(notify),
        () => testStore.getSnapshot().blocks,
      ),
  };
});

vi.mock('../components/ToastHost', () => ({ requestToast: vi.fn() }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let renderCount = 0;

function Host() {
  renderCount += 1;
  useReportedArtifactRegistration([], true, sdk.refresh);
  return null;
}

function assistantBlock(
  id: string,
  text: string,
  reported?: unknown,
): DaemonTranscriptBlock {
  return {
    id,
    kind: 'assistant',
    text,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(reported === undefined
      ? {}
      : { meta: { source: 'slash_command', sessionArtifacts: reported } }),
  } as unknown as DaemonTranscriptBlock;
}

beforeEach(() => {
  sdk.owner = 0;
  sdk.addArtifact.mockReset().mockImplementation(async () => ({}));
  sdk.refresh.mockReset().mockResolvedValue(undefined);
  sdk.guard.capture.mockImplementation(() => {
    const owner = sdk.owner;
    return { isCurrent: () => owner === sdk.owner };
  });
  testStore.reset();
  renderCount = 0;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.restoreAllMocks();
});

describe('useReportedArtifactRegistration transcript subscription', () => {
  it('does not re-render its host once per streamed text delta', () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    act(() => root!.render(<Host />));
    const initial = renderCount;

    act(() => {
      for (let index = 1; index <= 40; index += 1) {
        testStore.notify([assistantBlock('a', 'x'.repeat(index))]);
      }
    });

    expect(renderCount).toBe(initial);
    expect(pendingFrame).not.toBeNull();
  });

  it('still registers a descriptor delivered through a throttled frame', async () => {
    let pendingFrame: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      pendingFrame = callback;
      return 1;
    });
    vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const descriptor = {
      kind: 'file',
      storage: 'workspace',
      title: 'qwen-code-export-2026-01-01T00-00-00-000Z.md',
      workspacePath: 'qwen-code-export-2026-01-01T00-00-00-000Z.md',
    };
    act(() => root!.render(<Host />));
    expect(sdk.addArtifact).not.toHaveBeenCalled();

    // A descriptor riding a late-merged, text-less assistant block must reach
    // the registrar once the coalesced frame lands.
    act(() => {
      testStore.notify([assistantBlock('a', '', [descriptor])]);
    });
    await act(async () => {
      pendingFrame?.(1_000);
      await Promise.resolve();
    });

    expect(sdk.addArtifact).toHaveBeenCalledTimes(1);
    expect(sdk.addArtifact).toHaveBeenCalledWith(descriptor);
  });
});
