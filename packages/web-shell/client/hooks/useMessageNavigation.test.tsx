// @vitest-environment jsdom
import { act, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  useMessageNavigation,
  type WebShellMessageNavigationRequest,
} from './useMessageNavigation';
import type { MessageListHandle } from '../components/MessageList';

const mocks = vi.hoisted(() => ({
  state: { sessionId: 'session', mode: 'ready' },
  viewport: { revision: 0, connected: true },
  resolve: vi.fn(),
}));
const store = {
  getSnapshot: () => mocks.state,
  getViewportSnapshot: () => mocks.viewport,
  resolveMessageRecord: mocks.resolve,
};
let historyStore = store;
vi.mock('../daemon/session/DaemonSessionProvider', () => ({
  useDaemonHistoryNavigationStore: () => historyStore,
}));
let root: Root | undefined;
let container: HTMLDivElement;
let navigate: ReturnType<typeof useMessageNavigation>;
const scroll = vi.fn();
let list: RefObject<MessageListHandle | null>;
const hit = {
  recordId: 'record',
  sessionId: 'session',
  snapshot: 's',
  revision: 0,
  turnId: 'turn',
  turnOrdinal: 0,
  role: 'user' as const,
  snippet: '',
  matchStart: 0,
  matchEnd: 0,
};
const request = { sessionId: 'session', recordId: 'record' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function Probe() {
  navigate = useMessageNavigation(list);
  return null;
}
beforeEach(async () => {
  historyStore = store;
  mocks.state = { sessionId: 'session', mode: 'ready' };
  mocks.viewport = { revision: 0, connected: true };
  mocks.resolve.mockReset().mockResolvedValue(hit);
  scroll.mockReset().mockResolvedValue(true);
  list = {
    current: { scrollToSearchHit: scroll } as unknown as MessageListHandle,
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Probe />));
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
});
it('resolves persistent identity and reports successful viewport navigation', async () => {
  expect(await navigate(request)).toEqual({ status: 'located' });
  expect(mocks.resolve).toHaveBeenCalledWith('record', {
    isCurrent: expect.any(Function),
  });
  expect(scroll).toHaveBeenCalledWith(hit, expect.any(Function));
});
it.each(['disconnected', 'loading', 'no session', 'no handle'])(
  'reports not_ready for %s',
  async (reason) => {
    if (reason === 'disconnected') mocks.viewport.connected = false;
    if (reason === 'loading') mocks.state.mode = 'loading';
    if (reason === 'no session') mocks.state.sessionId = '';
    if (reason === 'no handle') list.current = null;
    expect(await navigate(request)).toEqual({ status: 'not_ready' });
    expect(mocks.resolve).not.toHaveBeenCalled();
  },
);
it('rejects a different session without fetching records', async () => {
  expect(await navigate({ ...request, sessionId: 'other' })).toEqual({
    status: 'session_mismatch',
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it('reports unsupported for legacy navigation', async () => {
  mocks.state.mode = 'legacy';
  mocks.viewport.connected = false;
  expect(await navigate(request)).toEqual({ status: 'unsupported' });
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it('reports missing records and empty IDs without navigating', async () => {
  mocks.resolve.mockResolvedValue(undefined);
  expect(await navigate(request)).toEqual({ status: 'not_found' });
  mocks.resolve.mockClear();
  expect(await navigate({ ...request, recordId: '  ' })).toEqual({
    status: 'not_found',
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(scroll).not.toHaveBeenCalled();
});
it.each(['resolve', 'scroll', 'false'])(
  'reports errors from %s',
  async (stage) => {
    if (stage === 'resolve')
      mocks.resolve.mockRejectedValue(new Error('offline'));
    if (stage === 'scroll') scroll.mockRejectedValue(new Error('unavailable'));
    if (stage === 'false') scroll.mockResolvedValue(false);
    expect(await navigate(request)).toEqual({ status: 'error' });
  },
);
it('rejects an already aborted signal without fetching', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await navigate({ ...request, signal: controller.signal })).toEqual({
    status: 'cancelled',
  });
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it.each(['abort', 'session', 'revision', 'unmount'])(
  'invalidates an in-flight lookup after %s',
  async (change) => {
    const pending = deferred<typeof hit>();
    mocks.resolve.mockReturnValue(pending.promise);
    const controller = new AbortController();
    const promise = navigate({ ...request, signal: controller.signal });
    const options = mocks.resolve.mock.calls[0][1];
    if (change === 'abort') controller.abort();
    if (change === 'session') mocks.state.sessionId = 'other';
    if (change === 'revision')
      mocks.viewport = { ...mocks.viewport, revision: 1 };
    if (change === 'unmount') {
      await act(async () => root!.unmount());
      root = undefined;
    }
    expect(options.isCurrent()).toBe(false);
    pending.resolve(hit);
    expect(await promise).toEqual({ status: 'cancelled' });
    expect(scroll).not.toHaveBeenCalled();
  },
);
it('a newer navigation cancels the earlier request', async () => {
  const pending = deferred<typeof hit>();
  mocks.resolve.mockReturnValueOnce(pending.promise);
  const first = navigate(request);
  const options = mocks.resolve.mock.calls[0][1];
  expect(await navigate({ ...request, recordId: 'newer' })).toEqual({
    status: 'located',
  });
  expect(options.isCurrent()).toBe(false);
  pending.resolve(hit);
  expect(await first).toEqual({ status: 'cancelled' });
  expect(scroll).toHaveBeenCalledTimes(1);
});
it('propagates cancellation to an in-flight viewport request', async () => {
  const pending = deferred<boolean>();
  scroll.mockReturnValue(pending.promise);
  const controller = new AbortController();
  const promise = navigate({
    ...request,
    signal: controller.signal,
  } satisfies WebShellMessageNavigationRequest);
  await Promise.resolve();
  const isCurrent = scroll.mock.calls[0][1];
  controller.abort();
  expect(isCurrent()).toBe(false);
  pending.resolve(true);
  expect(await promise).toEqual({ status: 'cancelled' });
});

it('rejects a retained callback after the history provider is replaced', async () => {
  const oldNavigate = navigate;
  historyStore = { ...store };
  await act(async () => root!.render(<Probe />));
  expect(await oldNavigate(request)).toEqual({ status: 'cancelled' });
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(await navigate(request)).toEqual({ status: 'located' });
});
