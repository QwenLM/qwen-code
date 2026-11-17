// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionSources } from './useSessionSources';
import type { SessionSource } from '@qwen-code/sdk/daemon';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const sdk = vi.hoisted(() => ({
  owner: 0,
  version: 0,
  guard: { capture: vi.fn() },
  actions: {
    listSources: vi.fn(),
    upsertSource: vi.fn(),
    removeSource: vi.fn(),
  },
  connection: {
    status: 'connected',
    sessionId: 'session-a',
    capabilities: { features: ['session_sources'] },
  },
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useActions: () => sdk.actions,
  useConnection: () => sdk.connection,
  useDaemonSessionOwnerGuard: () => sdk.guard,
  useWorkspaceEventSignals: () => ({ sourcesVersion: sdk.version }),
}));
let root: Root;
let container: HTMLDivElement;
let state: ReturnType<typeof useSessionSources>;
function Host() {
  state = useSessionSources();
  return null;
}
const source: SessionSource = {
  id: 'source-a',
  title: 'Guide',
  kind: 'link',
  locator: { type: 'url', url: 'https://example.com' },
  createdAt: '2026-09-07T00:00:00Z',
  updatedAt: '2026-09-07T00:00:00Z',
};
async function render() {
  await act(async () => {
    root.render(<Host />);
  });
}
beforeEach(() => {
  sdk.owner = 0;
  sdk.version = 0;
  sdk.connection.capabilities.features = ['session_sources'];
  sdk.guard.capture.mockImplementation(() => {
    const owner = sdk.owner;
    return { isCurrent: () => owner === sdk.owner };
  });
  Object.values(sdk.actions).forEach((fn) => fn.mockReset());
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('useSessionSources', () => {
  it('distinguishes initial failure from empty and preserves the same-owner list on refresh failure', async () => {
    sdk.actions.listSources.mockRejectedValueOnce(new Error('unavailable'));
    await render();
    expect(state.hydrated).toBe(false);
    expect(state.error).toBe('unavailable');
    sdk.actions.listSources.mockResolvedValueOnce({
      revision: 1,
      sources: [source],
    });
    await act(async () => {
      await state.refresh();
    });
    sdk.actions.listSources.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await state.refresh();
    });
    expect(state.sources).toEqual([source]);
    expect(state.error).toBe('offline');
    expect(state.hydrated).toBe(true);
  });
  it('ignores an older revision and refreshes after an invalidation', async () => {
    sdk.actions.listSources.mockResolvedValueOnce({
      revision: 2,
      sources: [source],
    });
    await render();
    sdk.actions.listSources.mockResolvedValueOnce({ revision: 1, sources: [] });
    sdk.version += 1;
    await render();
    expect(state.sources).toEqual([source]);
    expect(state.revision).toBe(2);
  });
  it('discards a stale response after owner replacement', async () => {
    let resolve!: (result: {
      revision: number;
      sources: SessionSource[];
    }) => void;
    sdk.actions.listSources.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await render();
    sdk.owner += 1;
    sdk.actions.listSources.mockResolvedValueOnce({ revision: 0, sources: [] });
    await render();
    await act(async () => {
      resolve({ revision: 10, sources: [source] });
    });
    expect(state.sources).toEqual([]);
    expect(state.revision).toBe(0);
  });
  it('applies an acknowledged removal even when the refresh fails', async () => {
    sdk.actions.listSources.mockResolvedValueOnce({
      revision: 1,
      sources: [source],
    });
    await render();
    sdk.actions.removeSource.mockResolvedValueOnce({
      revision: 2,
      removed: true,
    });
    sdk.actions.listSources.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await state.remove(source.id);
    });
    expect(state.sources).toEqual([]);
    expect(state.revision).toBe(2);
    expect(state.error).toBe('offline');
  });
  it('hides the capability without sending a request', async () => {
    sdk.connection.capabilities.features = [];
    await render();
    expect(state.supported).toBe(false);
    expect(sdk.actions.listSources).not.toHaveBeenCalled();
  });
});
