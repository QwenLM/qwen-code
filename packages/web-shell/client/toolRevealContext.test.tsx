// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createToolRevealStore,
  ToolRevealProvider,
  useToolRevealRequest,
  type ToolRevealStore,
} from './toolRevealContext';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Row({ callId }: { callId: string }) {
  const [open, setOpen] = useState(false);
  useToolRevealRequest(
    (requested) => requested === callId,
    () => setOpen(true),
  );
  return <div data-call={callId}>{open ? 'open' : 'closed'}</div>;
}

describe('tool reveal requests', () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ToolRevealStore;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    store = createToolRevealStore();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (callIds: string[]) =>
    act(() => {
      root.render(
        <ToolRevealProvider store={store}>
          {callIds.map((callId) => (
            <Row key={callId} callId={callId} />
          ))}
        </ToolRevealProvider>,
      );
    });
  const state = (callId: string) =>
    container.querySelector(`[data-call="${callId}"]`)?.textContent;

  it('opens only the mounted row the request names', () => {
    render(['a', 'b']);

    act(() => store.request('b'));

    expect(state('a')).toBe('closed');
    expect(state('b')).toBe('open');
  });

  it('waits for a row that mounts after the request (virtualized lists)', () => {
    render(['a']);
    act(() => store.request('later'));

    render(['a', 'later']);

    expect(state('later')).toBe('open');
  });

  it('opens a row that remounts right after it was revealed', () => {
    // Scrolling to the row can make the virtualized list remount it at once.
    let now = 1_000;
    store = createToolRevealStore(() => now);
    render(['a']);
    act(() => store.request('a'));
    expect(state('a')).toBe('open');

    now += 50;
    render([]);
    render(['a']);

    expect(state('a')).toBe('open');
  });

  it('leaves a row the user scrolls back to later in its own state', () => {
    let now = 1_000;
    store = createToolRevealStore(() => now);
    render(['a']);
    act(() => store.request('a'));
    expect(state('a')).toBe('open');

    now += 3_000;
    render([]);
    render(['a']);

    expect(state('a')).toBe('closed');
  });

  it('drops a request whose group never mounted in time', () => {
    let now = 1_000;
    store = createToolRevealStore(() => now);
    act(() => store.request('a'));
    now += 60_000;

    render(['a']);

    expect(state('a')).toBe('closed');
  });

  it('drops a cancelled request', () => {
    act(() => store.request('a'));
    act(() => store.cancel('a'));

    render(['a']);

    expect(state('a')).toBe('closed');
  });
});
