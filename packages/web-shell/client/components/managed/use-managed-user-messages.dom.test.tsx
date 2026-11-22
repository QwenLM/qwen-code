// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAgentProvider } from './managed-agent-provider';
import {
  useManagedUserMessages,
  type ManagedUserMessageSnapshot,
} from './use-managed-user-messages';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let latest: ReturnType<typeof useManagedUserMessages>;
let root: Root;
let container: HTMLDivElement;
function Harness({ provider }: { provider: ManagedAgentProvider }) {
  latest = useManagedUserMessages(provider, 'session');
  return null;
}
function provider(query: () => Promise<ManagedUserMessageSnapshot>) {
  return {
    storageKey: 'scope',
    userMessages: { query, command: vi.fn() },
  } as unknown as ManagedAgentProvider;
}
function deferred() {
  let resolve!: (value: ManagedUserMessageSnapshot) => void;
  const promise = new Promise<ManagedUserMessageSnapshot>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const empty: ManagedUserMessageSnapshot = { paused: false, messages: [] };
const paused: ManagedUserMessageSnapshot = { paused: true, messages: [] };
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
describe('useManagedUserMessages', () => {
  it('does not overlap slow polling requests', async () => {
    const pending = deferred();
    const query = vi.fn(() => pending.promise);
    act(() => root.render(<Harness provider={provider(query)} />));
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(query).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(empty));
    expect(latest.supported).toBe(true);
  });
  it('ignores an older snapshot after a newer explicit refresh', async () => {
    const first = deferred();
    const second = deferred();
    const query = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    act(() => root.render(<Harness provider={provider(query)} />));
    let refresh!: Promise<void>;
    act(() => {
      refresh = latest.refresh();
    });
    await act(async () => {
      second.resolve(paused);
      await refresh;
    });
    await act(async () => first.resolve(empty));
    expect(latest.snapshot?.paused).toBe(true);
  });
  it('does not apply an old provider response to the same Session in another scope', async () => {
    const old = deferred();
    act(() => root.render(<Harness provider={provider(() => old.promise)} />));
    await act(async () =>
      root.render(<Harness provider={provider(async () => paused)} />),
    );
    await act(async () => old.resolve(empty));
    expect(latest.snapshot?.paused).toBe(true);
  });
});
